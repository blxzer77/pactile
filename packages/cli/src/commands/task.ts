import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  addTaskDependency,
  applyKernelArchive,
  applyKernelPatch,
  applyKernelRecordGate,
  applyKernelStart,
  assertFullQualityForPhase,
  buildAcEvidenceLedger,
  checkTaskClose,
  closeTaskKernel,
  createTaskKernel,
  emptyTaskRecord,
  fingerprintTaskValue,
  isTaskDeliveryLevel,
  listTaskKernelSnapshots,
  parseAcceptanceItems,
  qualityFingerprint,
  readDependencyGraph,
  readKernel,
  readTaskKernel,
  readTopology,
  recordTaskReview,
  recordTaskRunResult,
  resolveRequiredControls,
  startTaskRun,
  taskRecordSchema,
  unmetRequires,
  type PactileTaskRecord,
  type TaskCandidateObservation,
  type TaskDeliveryEvidence,
  type TaskKernelSnapshotV2,
  type TaskSnapshotEntry,
} from "../core/task/index.js";
import {
  createTaskCandidateEntry,
  isRunCandidateObservationEntry,
  observeTaskRunCandidate,
} from "../core/task/task-candidate-observer.js";
import {
  addContextEntry,
  CONTEXT_FILES,
  readContextEntries,
  validateContextFile,
} from "../pactile/task/context.js";
import * as piBridge from "../pactile/pi/bridge.js";
import { approvedExecuteTask } from "../pactile/task/authorization.js";
import { createTaskWithArtifacts } from "../pactile/task/creation.js";
import { readPactileConfig } from "../pactile/task/config.js";
import { resumeTaskRunWithCoordinationBarrier } from "../pactile/coordination/index.js";
import {
  runTaskScheduleCli,
  runTaskScheduleCliAsync,
  runTaskScheduleDispatchCli,
  type TaskScheduleDispatchCliOptionsV1,
} from "./task-schedule.js";
import {
  checkArchive,
  checkStartExecution,
  dependencyStatus,
} from "../pactile/task/guards.js";
import {
  exitTask,
  resolveSelectedTask,
  resolveTaskDir,
  selectTask,
} from "../pactile/task/session.js";
import {
  artifactFingerprint,
  contractFingerprint,
  currentGateErrors,
  readStrategyContract,
  requiredGates,
} from "../pactile/task/strategy.js";
import {
  CHILD_STATES,
  childStateErrors,
  ensureTaskMap,
  readTaskMap,
  writeTaskMap,
  type ChildState,
} from "../pactile/task/task-map.js";
import { readDeveloper } from "../utils/developer.js";
import { sameGitRoot } from "../utils/git-root.js";
import { localDate } from "../utils/local-date.js";
import { getAllTaskTemplates } from "../templates/pactile/index.js";
import {
  learningScaffold,
  prepareArchiveEvidence,
} from "../pactile/task/scaffold.js";
import {
  listLegacyTaskImportRecords,
  readLegacyTaskImportRecord,
} from "../core/task/legacy-task-migration-reader.js";
import {
  TASK_ARTIFACT_STAGES_V1,
  projectTaskArtifactsForAgentV1,
  projectTaskArtifactsForHumanV1,
  projectTaskKernelArtifactsV1,
  readSelectedTaskArtifactDocumentSectionsV1,
  readSelectedTaskArtifactDocumentsV1,
  readSelectedTaskArtifactSourcesV1,
  readTaskArtifactDocumentIndexV1,
  renderTaskPrdScaffoldV1,
  type TaskArtifactStageV1,
} from "../pactile/artifacts/index.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function options(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`${name} requires a value`);
    values.push(value);
    index++;
  }
  return values;
}

function requireArgument(value: string | undefined, label: string): string {
  if (!value || value.startsWith("--")) throw new Error(`${label} is required`);
  return value;
}

function requireLast<T>(values: readonly T[], label: string): T {
  const value = values.at(-1);
  if (value === undefined) throw new Error(`${label} was not recorded`);
  return value;
}

function taskDir(root: string, reference: string): string {
  const dir = resolveTaskDir(root, reference);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`Task not found: ${reference}`);
  return dir;
}

function taskRecord(dir: string): PactileTaskRecord | null {
  try {
    const value: unknown = JSON.parse(
      fs.readFileSync(path.join(dir, "task.json"), "utf8"),
    );
    const parsed = taskRecordSchema.safeParse(value);
    // Keep the validated source object intact. Legacy task.json files may carry
    // fields outside the current schema; stripping them here changes V1
    // dependency/quality behavior when subsequent commands patch the record.
    return parsed.success ? (value as PactileTaskRecord) : null;
  } catch {
    return null;
  }
}

function runTaskHooks(
  root: string,
  event: "after_create" | "after_start" | "after_archive",
  taskJson: string,
): void {
  const hooks = readPactileConfig(root).hooks;
  const entries =
    hooks && typeof hooks === "object" && !Array.isArray(hooks)
      ? hooks[event]
      : undefined;
  if (!Array.isArray(entries)) return;
  for (const command of entries) {
    if (typeof command !== "string" || !command.trim()) continue;
    try {
      execSync(command, {
        cwd: root,
        env: { ...process.env, TASK_JSON_PATH: taskJson },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      });
    } catch (error) {
      console.warn(
        `[WARN] Hook failed (${event}): ${command} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function patchTask(
  root: string,
  reference: string,
  change: Record<string, unknown>,
  operation: string,
  extras?: Record<string, unknown>,
): void {
  const dir = taskDir(root, reference);
  if (!taskRecord(dir)) throw new Error(`task.json not found at ${dir}`);
  const revision = readKernel({ taskDir: dir, cwd: root }).kernel.revision;
  applyKernelPatch({
    taskDir: dir,
    cwd: root,
    expectedRevision: revision,
    actor: `pactile task ${operation}`,
    idempotencyKey: `patch:${operation}:${path.basename(dir)}:r${revision}`,
    evidence: Object.keys(change).join(",") || operation,
    record: change,
    extras,
  });
}

function activeTasks(
  root: string,
): { dir: string; record: PactileTaskRecord }[] {
  const tasks = path.join(root, ".pactile", "tasks");
  if (!fs.existsSync(tasks)) return [];
  return fs
    .readdirSync(tasks, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== "archive" &&
        entry.name !== "locale" &&
        entry.name !== "templates",
    )
    .map((entry) => ({
      dir: entry.name,
      record: taskRecord(path.join(tasks, entry.name)),
    }))
    .filter(
      (item): item is { dir: string; record: PactileTaskRecord } =>
        item.record !== null,
    )
    .sort((left, right) => left.dir.localeCompare(right.dir));
}

function locale(root: string): "zh" | "en" {
  try {
    const config = fs.readFileSync(
      path.join(root, ".pactile", "config.yaml"),
      "utf8",
    );
    return /^artifact_locale:\s*en\s*$/m.test(config) ? "en" : "zh";
  } catch {
    return "zh";
  }
}

function verifySeed(taskLocale: "zh" | "en"): string {
  return taskLocale === "zh"
    ? "# 验证证据\n\n## Planning check\n\n_可选（Full 任务）— 记录规划阶段审查结果。_\n\n## Execution evidence\n\n### Validation commands\n\n<!-- 示例：Validation commands: <命令> — <结果> -->\n\n### Acceptance\n\n<!-- 示例：Final acceptance evidence: <验收标准达成说明> -->\n\n### Durable learning\n\n<!-- 示例：Durable learning decision: no durable learning -->\n"
    : "# Verification Evidence\n\n## Planning check\n\n_Optional for Full tasks — record planning review outcomes._\n\n## Execution evidence\n\n### Validation commands\n\n<!-- Example: Validation commands: <command> — <outcome> -->\n\n### Acceptance\n\n<!-- Example: Final acceptance evidence: <criteria met> -->\n\n### Durable learning\n\n<!-- Example: Durable learning decision: no durable learning -->\n";
}

function parseAcceptanceCriteria(
  args: string[],
): { id: string; description: string }[] {
  const raw = options(args, "--accept");
  if (!raw.length)
    throw new Error("at least one --accept <criterion> is required");
  const parsed = raw.map((value, index) => {
    const separator = value.indexOf("=");
    if (separator > 0)
      return {
        id: value.slice(0, separator).trim(),
        description: value.slice(separator + 1).trim(),
      };
    return { id: `AC-${index + 1}`, description: value.trim() };
  });
  if (parsed.some((item) => !item.id || !item.description))
    throw new Error("--accept must be <criterion> or <id>=<criterion>");
  return parsed;
}

function taskV2(
  root: string,
  reference: string,
): { dir: string; kernel: TaskKernelSnapshotV2 } {
  const dir = taskDir(root, reference);
  const result = readTaskKernel({ root, taskDir: dir, cwd: root });
  if (result.kind !== "task-kernel-v2")
    throw new Error(
      `Task ${reference} uses legacy Kernel v1. It remains readable; automatic migration is reserved for P36.`,
    );
  return { dir, kernel: result.kernel };
}

function parseTaskArtifactDocumentSelection(value: string): {
  id: string;
  expectedFingerprint: string;
} {
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(
      "--document must be <document-id>@<sha256-fingerprint|absent> copied from a current artifact index",
    );
  }
  const id = value.slice(0, separator);
  const expectedFingerprint = value.slice(separator + 1);
  if (
    expectedFingerprint !== "absent" &&
    !/^sha256:[a-f0-9]{64}$/u.test(expectedFingerprint)
  ) {
    throw new Error(
      "--document fingerprint must be a lowercase sha256 digest or absent",
    );
  }
  return { id, expectedFingerprint };
}

function parseTaskArtifactSectionSelection(value: string): {
  id: string;
  expectedFingerprint: string;
} {
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(
      "--section must be <section-id>@<sha256-fingerprint> copied from a current artifact index",
    );
  }
  const id = value.slice(0, separator);
  const expectedFingerprint = value.slice(separator + 1);
  if (
    !id.startsWith("section:") ||
    !/^sha256:[a-f0-9]{64}$/u.test(expectedFingerprint)
  ) {
    throw new Error(
      "--section requires a stable section ID and lowercase sha256 fingerprint",
    );
  }
  return { id, expectedFingerprint };
}

function taskArtifacts(root: string, args: string[]): number {
  const reference = requireArgument(args[0], "task");
  const { dir, kernel } = taskV2(root, reference);
  const requestedStages = [...new Set(options(args, "--stage"))].map(
    (value) => {
      if (!(TASK_ARTIFACT_STAGES_V1 as readonly string[]).includes(value)) {
        throw new Error(
          `--stage must be one of: ${TASK_ARTIFACT_STAGES_V1.join(", ")}`,
        );
      }
      return value as TaskArtifactStageV1;
    },
  );
  const envelope = projectTaskKernelArtifactsV1(kernel);
  const documents = readTaskArtifactDocumentIndexV1(
    dir,
    kernel.identity.taskId,
  );
  const projectionOptions = {
    ...(requestedStages.length ? { stages: requestedStages } : {}),
    documents,
  };
  const requestedFactRefs = options(args, "--fact");
  const selectedFactIds = requestedFactRefs.map((reference) => {
    const fact = envelope.facts.find(
      (candidate) =>
        candidate.id === reference ||
        `${candidate.ref.uri}#${candidate.ref.selector}` === reference,
    );
    if (!fact) {
      throw new Error(`Unknown task artifact fact ID or locator: ${reference}`);
    }
    return fact.id;
  });
  const selectedDocuments = options(args, "--document").map(
    parseTaskArtifactDocumentSelection,
  );
  const selectedSections = options(args, "--section").map(
    parseTaskArtifactSectionSelection,
  );
  const agent = args.includes("--agent");

  if (selectedDocuments.length) {
    const visibleDocumentIds = new Set<string>(
      requestedStages.length
        ? documents
            .filter((document) => requestedStages.includes(document.stage))
            .map(({ id }) => id)
        : documents.map(({ id }) => id),
    );
    const outsideStage = selectedDocuments.find(
      ({ id }) => !visibleDocumentIds.has(id),
    );
    if (outsideStage) {
      throw new Error(
        `Task artifact document '${outsideStage.id}' is not present in the requested stage view`,
      );
    }
  }
  const selectedDocumentContents = selectedDocuments.length
    ? readSelectedTaskArtifactDocumentsV1(
        dir,
        kernel.identity.taskId,
        selectedDocuments,
      )
    : undefined;
  if (selectedSections.length) {
    const visibleSectionIds = new Set(
      documents
        .filter(
          (document) =>
            !requestedStages.length || requestedStages.includes(document.stage),
        )
        .flatMap((document) => (document.sections ?? []).map(({ id }) => id)),
    );
    const outsideStage = selectedSections.find(
      ({ id }) => !visibleSectionIds.has(id),
    );
    if (outsideStage) {
      throw new Error(
        `Task artifact document section '${outsideStage.id}' is not present in the requested stage view`,
      );
    }
  }
  const selectedSectionContents = selectedSections.length
    ? readSelectedTaskArtifactDocumentSectionsV1(
        dir,
        kernel.identity.taskId,
        selectedSections,
      )
    : undefined;

  if (selectedFactIds.length) {
    const visibleFactIds = new Set(
      requestedStages.length
        ? requestedStages.flatMap((stage) => envelope.stageRefs[stage] ?? [])
        : envelope.facts.map((fact) => fact.id),
    );
    const outsideStage = selectedFactIds.find((id) => !visibleFactIds.has(id));
    if (outsideStage) {
      throw new Error(
        `Task artifact fact '${outsideStage}' is not present in the requested stage view`,
      );
    }
    const selectedSources = readSelectedTaskArtifactSourcesV1(
      kernel,
      envelope,
      selectedFactIds,
    );
    if (agent) {
      console.log(
        JSON.stringify(
          {
            index: projectTaskArtifactsForAgentV1(envelope, projectionOptions),
            selectedSources,
            ...(selectedDocumentContents
              ? { selectedDocuments: selectedDocumentContents }
              : {}),
            ...(selectedSectionContents
              ? { selectedSections: selectedSectionContents }
              : {}),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        JSON.stringify(
          {
            taskId: kernel.identity.taskId,
            selectedSources,
            ...(selectedDocumentContents
              ? { selectedDocuments: selectedDocumentContents }
              : {}),
            ...(selectedSectionContents
              ? { selectedSections: selectedSectionContents }
              : {}),
          },
          null,
          2,
        ),
      );
    }
    return 0;
  }

  if (selectedDocumentContents || selectedSectionContents) {
    console.log(
      JSON.stringify(
        {
          ...(agent
            ? {
                index: projectTaskArtifactsForAgentV1(
                  envelope,
                  projectionOptions,
                ),
              }
            : { taskId: kernel.identity.taskId }),
          ...(selectedDocumentContents
            ? { selectedDocuments: selectedDocumentContents }
            : {}),
          ...(selectedSectionContents
            ? { selectedSections: selectedSectionContents }
            : {}),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (agent) {
    console.log(
      JSON.stringify(
        projectTaskArtifactsForAgentV1(envelope, projectionOptions),
        null,
        2,
      ),
    );
  } else {
    console.log(projectTaskArtifactsForHumanV1(envelope, projectionOptions));
  }
  return 0;
}

function actor(root: string, args: string[]): string {
  return option(args, "--actor") ?? readDeveloper(root) ?? "user";
}

function createTask(args: string[], root: string): void {
  if (args.includes("--legacy")) {
    createLegacyTask(
      args.filter((value) => value !== "--legacy"),
      root,
    );
    return;
  }
  if (args.includes("--rigor") || args.includes("--parent")) {
    throw new Error(
      "--rigor and --parent are legacy task presets. Use `pactile task legacy-create --legacy` for existing 0.5.x workflows, or create a Task with --deliverable, --delivery-level, and --accept.",
    );
  }
  const title = requireArgument(args[0], "title");
  const slug =
    option(args, "--slug") ??
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    throw new Error("slug must contain lowercase letters, digits and hyphens");
  const deliverable = requireArgument(
    option(args, "--deliverable"),
    "--deliverable",
  );
  const deliveryLevel = option(args, "--delivery-level");
  if (!isTaskDeliveryLevel(deliveryLevel))
    throw new Error(
      "--delivery-level must be local-result, pull-request, merged-result, or documentation",
    );
  const dependencies = [...new Set(options(args, "--depends-on"))];
  const directoryName = `${localDate(new Date()).slice(5)}-${slug}`;
  const dir = path.resolve(root, ".pactile", "tasks", directoryName);
  const result = createTaskKernel({
    root,
    taskDir: dir,
    actor: actor(root, args),
    idempotencyKey: option(args, "--idempotency-key") ?? `task-create:${slug}`,
    definition: {
      taskId: slug,
      title,
      description: option(args, "--description") ?? "",
      deliverable,
      deliveryLevel,
      acceptanceCriteria: parseAcceptanceCriteria(args),
      dependencies,
    },
  });
  if (!result.idempotent) {
    const prdPath = path.join(dir, "prd.md");
    if (!fs.existsSync(prdPath)) {
      try {
        fs.writeFileSync(prdPath, renderTaskPrdScaffoldV1(result.kernel), {
          encoding: "utf8",
          flag: "wx",
        });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "EEXIST"
        )
          throw error;
      }
    }
  }
  console.log(
    `${path.relative(root, dir).replaceAll("\\", "/")}\nTask Kernel schema: ${result.kernel.schemaVersion}\nTask ID: ${result.kernel.identity.taskId}\nPRD: ${path.relative(root, path.join(dir, "prd.md")).replaceAll("\\", "/")}\nLive fact view: pactile task artifacts ${result.kernel.identity.taskId}`,
  );
}

function runStartTask(root: string, args: string[]): number {
  const reference = requireArgument(args[0], "task");
  const { dir, kernel } = taskV2(root, reference);
  const authorization = {
    approvedBy: requireArgument(option(args, "--approved-by"), "--approved-by"),
    approvedAt: option(args, "--approved-at") ?? new Date().toISOString(),
    scope: requireArgument(
      option(args, "--authorization-scope"),
      "--authorization-scope",
    ),
    evidenceRef: requireArgument(
      option(args, "--authorization-evidence"),
      "--authorization-evidence",
    ),
  };
  const workspaceInputs = ["--workspace-path", "--branch", "--base-sha"].some(
    (flag) => args.includes(flag),
  );
  const taskActor = actor(root, args);
  let workspace: Parameters<typeof startTaskRun>[0]["workspace"];
  if (workspaceInputs) {
    workspace = {
      canonicalPath: requireArgument(
        option(args, "--workspace-path"),
        "--workspace-path",
      ),
      branch: requireArgument(option(args, "--branch"), "--branch"),
      baseSha: requireArgument(option(args, "--base-sha"), "--base-sha"),
      writeSet: options(args, "--write-set"),
      integrationState: "not-integrated",
      reclamationState: "not-requested",
    };
  }
  const hostInputs = [
    "--host",
    "--role",
    "--session-id",
    "--thread-id",
    "--request-ref",
    "--event-ref",
    "--result-ref",
    "--assurance-source",
  ].some((flag) => args.includes(flag));
  let host: Parameters<typeof startTaskRun>[0]["host"];
  if (hostInputs) {
    host = {
      host: requireArgument(option(args, "--host"), "--host"),
      role: requireArgument(option(args, "--role"), "--role"),
      sessionId: option(args, "--session-id") ?? null,
      threadId: option(args, "--thread-id") ?? null,
      requestRefs: options(args, "--request-ref"),
      eventRefs: options(args, "--event-ref"),
      resultRefs: options(args, "--result-ref"),
      assuranceSource: option(args, "--assurance-source") ?? null,
    };
  }
  const durationOption = (name: string): number | null => {
    const value = option(args, name);
    if (value === undefined) return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0)
      throw new Error(`${name} must be a non-negative integer`);
    return parsed;
  };
  const input = {
    summary: requireArgument(
      option(args, "--input-summary"),
      "--input-summary",
    ),
    references: options(args, "--input-ref"),
  };
  const initialState = args.includes("--wait")
    ? ("waiting" as const)
    : ("running" as const);
  const writeSetSnapshot = args.includes("--write-set-snapshot")
    ? options(args, "--write-set-snapshot")
    : options(args, "--write-set");
  const estimatedDurations = {
    executionMs: durationOption("--estimate-execution-ms"),
    waitingMs: durationOption("--estimate-waiting-ms"),
    reviewMs: durationOption("--estimate-review-ms"),
  };
  const requestFingerprint = fingerprintTaskValue({
    actor: taskActor,
    input,
    authorization: {
      approvedBy: authorization.approvedBy,
      scope: authorization.scope,
      evidenceRef: authorization.evidenceRef,
    },
    initialState,
    writeSetSnapshot,
    estimatedDurations,
    workspace: workspace ?? null,
    host: host ?? null,
  });
  const activeRun = kernel.runs.find(
    (run) => run.state === "running" || run.state === "waiting",
  );
  const attempt = activeRun?.attempt ?? kernel.runs.length + 1;
  const idempotencyKey =
    option(args, "--idempotency-key") ??
    `run-start:${kernel.identity.taskId}:${attempt}:${requestFingerprint}`;
  const priorStart = kernel.events.find(
    (event) =>
      event.idempotencyKey === idempotencyKey &&
      (event.type === "run.started" || event.type === "run.queued"),
  );
  const priorRun = priorStart
    ? kernel.runs.find((run) => run.id === priorStart.entityId)
    : undefined;
  if (!option(args, "--approved-at") && priorRun)
    authorization.approvedAt = priorRun.authorization.approvedAt;
  const result = startTaskRun({
    root,
    taskDir: dir,
    expectedRevision: kernel.revision,
    actor: taskActor,
    idempotencyKey,
    input,
    initialState,
    writeSetSnapshot,
    estimatedDurations,
    authorization,
    ...(workspace ? { workspace } : {}),
    ...(host ? { host } : {}),
  });
  const run = requireLast(result.kernel.runs, "Run");
  console.log(
    `Run ${run.state === "waiting" ? "queued" : "started"}: ${run.id}\nTask: ${run.taskId}\nAttempt: ${run.attempt}\nKernel revision: ${result.kernel.revision}`,
  );
  return 0;
}

function resumeTask(root: string, args: string[]): number {
  const reference = requireArgument(args[0], "task");
  const runId = requireArgument(args[1], "run ID");
  const { dir, kernel } = taskV2(root, reference);
  const result = resumeTaskRunWithCoordinationBarrier({
    root,
    taskDir: dir,
    expectedRevision: kernel.revision,
    runId,
    actor: actor(root, args),
    idempotencyKey: option(args, "--idempotency-key") ?? `run-resume:${runId}`,
  });
  console.log(
    `Run resumed: ${runId}\nKernel revision: ${result.kernel.revision}`,
  );
  return 0;
}

function parseCandidateEntries(args: string[]): TaskSnapshotEntry[] {
  return options(args, "--candidate").map((value) => {
    const separator = value.lastIndexOf("=");
    if (separator <= 0)
      throw new Error("--candidate must be <reference>=<sha256-fingerprint>");
    return {
      ref: value.slice(0, separator),
      fingerprint: value.slice(separator + 1),
    };
  });
}

function runResultTask(root: string, args: string[]): number {
  const reference = requireArgument(args[0], "task");
  const runId = requireArgument(args[1], "run ID");
  const { dir, kernel } = taskV2(root, reference);
  const outcome = requireArgument(option(args, "--outcome"), "--outcome");
  if (outcome !== "completed" && outcome !== "failed" && outcome !== "blocked")
    throw new Error("--outcome must be completed, failed, or blocked");
  const failure =
    outcome === "completed"
      ? undefined
      : {
          category: requireArgument(
            option(args, "--failure-category"),
            "--failure-category",
          ),
          message: requireArgument(
            option(args, "--failure-message"),
            "--failure-message",
          ),
          ...(option(args, "--failure-evidence")
            ? { evidenceRef: option(args, "--failure-evidence") }
            : {}),
        };
  let candidateEntries: TaskSnapshotEntry[] = [];
  let evidenceRefs = options(args, "--evidence");
  let executionMeasurementRef = option(args, "--execution-measurement-ref");
  if (outcome === "completed") {
    const run = kernel.runs.find((item) => item.id === runId);
    if (!run)
      throw new Error(
        `Run ${runId} does not exist on Task ${kernel.identity.taskId}`,
      );
    const candidateInputs = parseCandidateEntries(args);
    if (
      candidateInputs.some((entry) => isRunCandidateObservationEntry(entry.ref))
    ) {
      throw new Error(
        "--candidate cannot set a reserved P41 machine-observation reference",
      );
    }
    const piBound = run.host?.host === "pi";
    const hostEvidenceRefs = run.host
      ? [
          ...run.host.requestRefs,
          ...run.host.eventRefs,
          ...run.host.resultRefs,
        ]
      : [];
    if (
      !piBound &&
      hostEvidenceRefs.some((reference) =>
        reference.replaceAll("\\", "/").startsWith("pi-bridge/"),
      )
    ) {
      throw new Error(
        "Pi evidence references cannot complete a Run bound to another host",
      );
    }
    let piEvidence: ReturnType<typeof piBridge.readPiTaskRunEvidence> = null;
    if (piBound) {
      if (
        run.host?.role !== "implement" ||
        run.host.assuranceSource !== "manager-owned-child-exit"
      ) {
        throw new Error(
          "Pi Run completion requires implement role and manager-owned-child-exit assurance",
        );
      }
      piEvidence = piBridge.readPiTaskRunEvidence(root, dir, runId);
      if (!piEvidence) {
        throw new Error(
          "Pi Run has no valid settled host-stop and persisted result receipt; it cannot be recorded completed",
        );
      }
      if (
        piEvidence.taskRunId !== run.id ||
        piEvidence.taskId !== run.taskId ||
        piEvidence.outcome !== "settled" ||
        piEvidence.assurance !== "manager-owned-child-exit"
      ) {
        throw new Error(
          "Pi success evidence does not match the selected Task Run binding",
        );
      }
      const suppliedMeasurement = executionMeasurementRef;
      if (
        suppliedMeasurement &&
        suppliedMeasurement !== piEvidence.executionMeasurementRef
      ) {
        throw new Error(
          "--execution-measurement-ref conflicts with the verified Pi Run receipt",
        );
      }
      executionMeasurementRef = piEvidence.executionMeasurementRef;
      evidenceRefs = [
        ...new Set([...evidenceRefs, ...piEvidence.evidenceRefs]),
      ];
    }
    const runObservation = observeTaskRunCandidate({
      run,
      ...(run.workspace === null ? { repositoryRoot: root } : {}),
    });
    candidateEntries = [
      ...candidateInputs,
      createTaskCandidateEntry(runObservation),
    ];
  }
  const result = recordTaskRunResult({
    root,
    taskDir: dir,
    expectedRevision: kernel.revision,
    runId,
    outcome,
    ...(option(args, "--summary")
      ? { summary: option(args, "--summary") }
      : {}),
    evidenceRefs,
    candidateEntries,
    failure,
    measurementRefs: {
      ...(executionMeasurementRef
        ? { execution: executionMeasurementRef }
        : {}),
      ...(option(args, "--waiting-measurement-ref")
        ? { waiting: option(args, "--waiting-measurement-ref") }
        : {}),
    },
    actor: actor(root, args),
    idempotencyKey: option(args, "--idempotency-key") ?? `run-result:${runId}`,
  });
  console.log(
    `Run ${runId}: ${outcome}\nTask phase: ${result.kernel.phase}\nKernel revision: ${result.kernel.revision}`,
  );
  return 0;
}

function parseAcceptanceEvidenceArgs(args: string[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const item of options(args, "--criterion")) {
    const separator = item.indexOf("=");
    if (separator <= 0 || separator === item.length - 1)
      throw new Error(
        "--criterion must be <criterion-id>=<evidence-reference>",
      );
    const id = item.slice(0, separator);
    if (Object.prototype.hasOwnProperty.call(result, id))
      result[id]?.push(item.slice(separator + 1));
    else
      Object.defineProperty(result, id, {
        value: [item.slice(separator + 1)],
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  return result;
}

function reviewTask(root: string, args: string[]): number {
  const reference = requireArgument(args[0], "task");
  const { dir, kernel } = taskV2(root, reference);
  const runId = requireArgument(option(args, "--run"), "--run");
  const decision = requireArgument(option(args, "--decision"), "--decision");
  if (
    decision !== "pass" &&
    decision !== "fail" &&
    decision !== "needs-changes"
  )
    throw new Error("--decision must be pass, fail, or needs-changes");
  const candidateSnapshotId = requireArgument(
    option(args, "--candidate-id"),
    "--candidate-id",
  );
  const candidateFingerprint = requireArgument(
    option(args, "--candidate-fingerprint"),
    "--candidate-fingerprint",
  );
  const reviewer = requireArgument(option(args, "--reviewer"), "--reviewer");
  const evidenceRefs = options(args, "--evidence");
  const acceptanceEvidence = parseAcceptanceEvidenceArgs(args);
  const unresolvedBlockers = options(args, "--blocker");
  const measurementRef = option(args, "--review-measurement-ref");
  const taskActor = actor(root, args);
  const idempotencyKey =
    option(args, "--idempotency-key") ??
    `review:${runId}:${fingerprintTaskValue({
      actor: taskActor,
      runId,
      candidateSnapshotId,
      candidateFingerprint,
      reviewer,
      decision,
      evidenceRefs,
      acceptanceEvidence,
      unresolvedBlockers,
      measurementRef: measurementRef ?? null,
    })}`;
  const result = recordTaskReview({
    root,
    taskDir: dir,
    expectedRevision: kernel.revision,
    runId,
    candidateSnapshotId,
    candidateFingerprint,
    reviewer,
    decision,
    evidenceRefs,
    acceptanceEvidence,
    unresolvedBlockers,
    measurementRef,
    actor: taskActor,
    idempotencyKey,
  });
  const review = requireLast(result.kernel.reviews, "Review");
  console.log(
    `Review recorded: ${review.id}\nDecision: ${review.decision}\nCandidate: ${review.candidateFingerprint}`,
  );
  return 0;
}

function closeTask(root: string, args: string[]): number {
  const reference = requireArgument(args[0], "task");
  const { dir, kernel } = taskV2(root, reference);
  const runId = requireArgument(option(args, "--run"), "--run");
  const reviewId = requireArgument(option(args, "--review"), "--review");
  const deliveryEvidence: TaskDeliveryEvidence = {
    level: option(args, "--delivery-level") as TaskDeliveryEvidence["level"],
    reference: requireArgument(
      option(args, "--delivery-ref"),
      "--delivery-ref",
    ),
    summary: requireArgument(
      option(args, "--delivery-summary"),
      "--delivery-summary",
    ),
    ...(option(args, "--delivery-path")
      ? { path: option(args, "--delivery-path") }
      : {}),
    ...(option(args, "--target-branch")
      ? { targetBranch: option(args, "--target-branch") }
      : {}),
  };
  if (!isTaskDeliveryLevel(deliveryEvidence.level))
    throw new Error(
      "--delivery-level must be local-result, pull-request, merged-result, or documentation",
    );
  const candidateObservation: TaskCandidateObservation = {
    snapshotId: requireArgument(
      option(args, "--candidate-id"),
      "--candidate-id",
    ),
    fingerprint: requireArgument(
      option(args, "--candidate-fingerprint"),
      "--candidate-fingerprint",
    ),
    observedBy: requireArgument(
      option(args, "--candidate-observed-by"),
      "--candidate-observed-by",
    ),
    observedAt:
      option(args, "--candidate-observed-at") ?? new Date().toISOString(),
    source: requireArgument(
      option(args, "--candidate-observation-source"),
      "--candidate-observation-source",
    ),
    evidenceRef: requireArgument(
      option(args, "--candidate-observation-ref"),
      "--candidate-observation-ref",
    ),
  };
  if (args.includes("--check")) {
    const errors = checkTaskClose({
      root,
      taskDir: dir,
      expectedRevision: kernel.revision,
      runId,
      reviewId,
      candidateObservation,
      deliveryEvidence,
    });
    console.log(
      `Task Close check: ${errors.length ? "FAIL" : "PASS"}${errors.length ? `\n${errors.map((error) => `  - ${error}`).join("\n")}` : ""}`,
    );
    console.log(
      "Candidate freshness: Close re-observes current project state against the frozen Run candidate.",
    );
    return errors.length ? 1 : 0;
  }
  const result = closeTaskKernel({
    root,
    taskDir: dir,
    expectedRevision: kernel.revision,
    runId,
    reviewId,
    candidateObservation,
    deliveryEvidence,
    actor: actor(root, args),
    idempotencyKey:
      option(args, "--idempotency-key") ??
      `task-close:${kernel.identity.taskId}`,
  });
  console.log(
    `Task closed: ${result.kernel.identity.taskId}\nDelivery level: ${deliveryEvidence.level}\nCandidate freshness: current project state re-observed\nDelivery evidence: machine-observed\nKernel revision: ${result.kernel.revision}`,
  );
  return 0;
}

function createLegacyTask(args: string[], root: string): void {
  const title = requireArgument(args[0], "title");
  const slug =
    option(args, "--slug") ??
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    throw new Error("slug must contain lowercase letters, digits and hyphens");
  const parentRef = option(args, "--parent");
  if (parentRef) {
    const parent = taskRecord(taskDir(root, parentRef));
    if (parent?.status !== "planning")
      throw new Error("create --parent requires a planning Parent task");
  }
  const developer = readDeveloper(root);
  const assignee = option(args, "--assignee") ?? developer;
  if (!assignee)
    throw new Error(
      "No developer set. Run pactile init --user <name> or pass --assignee",
    );
  const now = new Date();
  const today = localDate(now);
  const prefix = today.slice(5);
  const dirName = `${prefix}-${slug}`;
  const tasks = path.join(root, ".pactile", "tasks");
  const dir = path.join(tasks, dirName);
  if (fs.existsSync(path.join(dir, "task.json")))
    throw new Error(`Task already exists: ${dirName}`);
  const archive = path.join(tasks, "archive");
  if (
    fs.existsSync(archive) &&
    fs
      .readdirSync(archive, { withFileTypes: true })
      .some(
        (month) =>
          month.isDirectory() &&
          fs.existsSync(path.join(archive, month.name, dirName)),
      )
  ) {
    throw new Error(`Task already archived: ${dirName}`);
  }
  const taskLocale = locale(root);
  const templatePath = path.join(tasks, "locale", taskLocale, "default-prd.md");
  const prdTemplate = fs.existsSync(templatePath)
    ? fs.readFileSync(templatePath, "utf8")
    : getAllTaskTemplates().get(`tasks/locale/${taskLocale}/default-prd.md`);
  if (!prdTemplate)
    throw new Error(`Task PRD template not found for locale ${taskLocale}`);
  const contextSeeds = fs.existsSync(path.join(root, ".codex"))
    ? [
        ".pactile/spec/guides/index.md",
        ".pactile/framework/verification-strength-guide.md",
        ".pactile/framework/injection-budget-guide.md",
      ].filter((entry) => fs.existsSync(path.join(root, entry)))
    : [];
  if (fs.existsSync(path.join(root, ".codex")) && contextSeeds.length < 2) {
    throw new Error(
      "task create requires at least two existing spec guide paths for JSONL seed",
    );
  }
  let baseBranch = "main";
  try {
    baseBranch =
      execFileSync("git", ["branch", "--show-current"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim() || "main";
  } catch {
    /* A non-Git project still has a valid default base branch. */
  }
  const description = option(args, "--description") ?? "";
  const record = emptyTaskRecord({
    id: slug,
    name: slug,
    title,
    description,
    priority: option(args, "--priority") ?? "P2",
    package: option(args, "--package") ?? null,
    creator: developer ?? assignee,
    assignee,
    createdAt: today,
    base_branch: baseBranch,
  });
  const rigor = option(args, "--rigor") ?? "lite";
  if (rigor !== "lite" && rigor !== "full")
    throw new Error("--rigor must be lite or full");
  const artifacts = new Map<string, string>([
    [
      "prd.md",
      prdTemplate
        .replaceAll("{title}", title)
        .replaceAll(
          "{goal}",
          description || (taskLocale === "zh" ? "待补充。" : "TBD."),
        ),
    ],
    ["verify.md", verifySeed(taskLocale)],
  ]);
  if (fs.existsSync(path.join(root, ".codex"))) {
    for (const name of CONTEXT_FILES) {
      artifacts.set(
        name,
        `${contextSeeds.map((entry) => JSON.stringify({ file: entry, reason: "default spec seed — curate entries for this task" })).join("\n")}\n`,
      );
    }
  }
  createTaskWithArtifacts({
    root,
    dirName,
    record,
    artifacts,
    actor: "pactile task create",
    idempotencyKey: `create:${slug}`,
    evidence: "pactile task create",
    ifExists: "error",
    extras: { required_controls: resolveRequiredControls({ rigor }) },
  });
  if (parentRef) linkChild(root, parentRef, dirName);
  runTaskHooks(root, "after_create", path.join(dir, "task.json"));
  console.log(path.relative(root, dir).replaceAll("\\", "/"));
}

function linkChild(root: string, parentRef: string, childRef: string): void {
  const parentDir = taskDir(root, parentRef);
  const childDir = taskDir(root, childRef);
  if (parentDir === childDir)
    throw new Error("a task cannot be its own parent");
  const parent = taskRecord(parentDir);
  const child = taskRecord(childDir);
  if (!parent || !child) throw new Error("parent and child need task.json");
  if (child.parent && child.parent !== path.basename(parentDir))
    throw new Error(
      `single-parent tree: child already belongs to ${child.parent}`,
    );
  if (
    parent.parent === path.basename(childDir) ||
    child.children.includes(path.basename(parentDir))
  )
    throw new Error("parent-child cycle rejected");
  if (parent.status !== "planning" || child.status !== "planning")
    throw new Error("link children while both tasks are planning");
  if (
    parent.children.includes(path.basename(childDir)) &&
    child.parent === path.basename(parentDir)
  )
    return;
  const nextChildren = [
    ...new Set([...parent.children, path.basename(childDir)]),
  ];
  patchTask(
    root,
    path.basename(parentDir),
    { children: nextChildren },
    "add-subtask",
  );
  try {
    patchTask(
      root,
      path.basename(childDir),
      { parent: path.basename(parentDir) },
      "add-subtask",
    );
  } catch (error) {
    patchTask(
      root,
      path.basename(parentDir),
      { children: parent.children },
      "add-subtask-rollback",
      {
        topology: {
          ...readTopology(
            readKernel({ taskDir: parentDir, cwd: root }).kernel.projection
              ?.extras ?? {},
          ),
          children: parent.children,
        },
      },
    );
    throw error;
  }
  const nextParent = taskRecord(parentDir);
  if (!nextParent) throw new Error("parent projection vanished after link");
  ensureTaskMap(
    parentDir,
    nextParent,
    `Linked Child ${path.basename(childDir)}.`,
  );
}

function unlinkChild(root: string, parentRef: string, childRef: string): void {
  const parentDir = taskDir(root, parentRef);
  const childDir = taskDir(root, childRef);
  const parent = taskRecord(parentDir);
  const child = taskRecord(childDir);
  if (!parent || !child) throw new Error("parent and child need task.json");
  if (
    !parent.children.includes(path.basename(childDir)) ||
    child.parent !== path.basename(parentDir)
  )
    throw new Error("parent-child link not found");
  const map = readTaskMap(parentDir).data;
  const entry = map?.children.find(
    (item) => item.id === path.basename(childDir),
  );
  if (
    parent.status !== "planning" ||
    child.status !== "planning" ||
    (entry && entry.state !== "open")
  )
    throw new Error("unlink only an open Child while both tasks are planning");
  const nextChildren = parent.children.filter(
    (id) => id !== path.basename(childDir),
  );
  const parentTopology = readTopology(
    readKernel({ taskDir: parentDir, cwd: root }).kernel.projection?.extras ??
      {},
  );
  const childTopology = readTopology(
    readKernel({ taskDir: childDir, cwd: root }).kernel.projection?.extras ??
      {},
  );
  patchTask(root, path.basename(childDir), { parent: null }, "remove-subtask", {
    topology: { ...childTopology, parent_id: null },
  });
  patchTask(
    root,
    path.basename(parentDir),
    { children: nextChildren },
    "remove-subtask",
    { topology: { ...parentTopology, children: nextChildren } },
  );
  const nextParent = taskRecord(parentDir);
  if (nextParent)
    ensureTaskMap(
      parentDir,
      nextParent,
      `Unlinked Child ${path.basename(childDir)}.`,
    );
}

function prepareChildWorktree(root: string, args: string[]): number {
  const parentDir = taskDir(root, requireArgument(args[0], "parent task"));
  const childDir = taskDir(root, requireArgument(args[1], "child task"));
  const branch = requireArgument(option(args, "--branch"), "--branch");
  const parent = taskRecord(parentDir);
  const child = taskRecord(childDir);
  if (!parent || !child) throw new Error("Parent and Child need task.json");
  if (
    child.parent !== path.basename(parentDir) ||
    !parent.children.includes(path.basename(childDir))
  )
    throw new Error("Child must be linked to the Parent");
  const map = readTaskMap(parentDir);
  if (!map.data?.children.some((entry) => entry.id === path.basename(childDir)))
    throw new Error("Child missing from Parent task-map.md");
  const base =
    option(args, "--base") ?? child.base_branch ?? parent.base_branch ?? "HEAD";
  const worktreeRoot = path.resolve(root, ".pactile", "worktrees");
  const destination = path.resolve(
    root,
    option(args, "--path") ?? path.join(worktreeRoot, path.basename(childDir)),
  );
  const relative = path.relative(worktreeRoot, destination);
  const errors: string[] = [];
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    errors.push("worktree path must stay under .pactile/worktrees");
  if (
    fs
      .lstatSync(path.join(root, ".pactile"), { throwIfNoEntry: false })
      ?.isSymbolicLink()
  )
    errors.push(".pactile must not be a symlink");
  if (fs.lstatSync(worktreeRoot, { throwIfNoEntry: false })?.isSymbolicLink())
    errors.push(".pactile/worktrees must not be a symlink");
  let ancestor = worktreeRoot;
  for (const segment of relative.split(path.sep).slice(0, -1)) {
    ancestor = path.join(ancestor, segment);
    if (fs.lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink())
      errors.push(`worktree path crosses a symlink: ${ancestor}`);
  }
  if (fs.existsSync(destination))
    errors.push(`worktree path already exists: ${destination}`);
  if (branch.startsWith("-") || /[\r\n]/.test(branch))
    errors.push("invalid branch name");
  if (typeof base !== "string" || base.startsWith("-") || /[\r\n]/.test(base))
    errors.push("invalid base ref");
  const git = (...gitArgs: string[]): string =>
    execFileSync("git", gitArgs, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    if (!sameGitRoot(git("rev-parse", "--show-toplevel"), root))
      errors.push("prepare-child-worktree requires the project Git root");
    git("check-ref-format", "--branch", branch);
    if (typeof base === "string" && !base.startsWith("-"))
      git("rev-parse", "--verify", `${base}^{commit}`);
  } catch {
    errors.push("Git repository, branch, or base ref validation failed");
  }
  if (errors.length) {
    console.error(errors.map((error) => `  - ${error}`).join("\n"));
    return 1;
  }
  const worktreePath = path.relative(root, destination).replaceAll("\\", "/");
  if (args.includes("--check")) {
    console.log(
      `Prepare-child-worktree check: PASS\nBranch: ${branch}\nBase: ${base}\nPath: ${worktreePath}\nNo files changed.`,
    );
    return 0;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  let branchExists = false;
  try {
    git("rev-parse", "--verify", `refs/heads/${branch}`);
    branchExists = true;
  } catch {
    /* New local branch. */
  }
  try {
    git(
      "worktree",
      "add",
      ...(branchExists ? [] : ["-b", branch]),
      destination,
      ...(branchExists ? [branch] : [base as string]),
    );
  } catch (error) {
    console.error(
      `git worktree add failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  patchTask(
    root,
    path.basename(childDir),
    { branch, worktree_path: worktreePath },
    "prepare-child-worktree",
  );
  const entry = map.data?.children.find(
    (item) => item.id === path.basename(childDir),
  );
  if (!map.data || !entry)
    throw new Error(
      "Child vanished from Parent task-map.md after worktree creation",
    );
  Object.assign(entry, {
    isolation: "git-worktree",
    branch,
    worktree_path: worktreePath,
    base_ref: base,
    ref: `refs/heads/${branch}`,
  });
  writeTaskMap(
    parentDir,
    map.data,
    map.body,
    `Prepared Child ${entry.id} git worktree at ${worktreePath} from ${base}.`,
  );
  console.log(
    `Child worktree prepared: ${entry.id}\nBranch: ${branch}\nPath: ${worktreePath}`,
  );
  return 0;
}

function updateChildState(
  root: string,
  args: string[],
  integrated: boolean,
): number {
  const parentDir = taskDir(root, requireArgument(args[0], "parent task"));
  const childDir = taskDir(root, requireArgument(args[1], "child task"));
  const state = requireArgument(args[2], "state") as ChildState;
  if (!(CHILD_STATES as readonly string[]).includes(state))
    throw new Error(`unknown child state: ${state}`);
  if (
    integrated !==
    ["changes", "accepted", "integrating", "integrated", "cancelled"].includes(
      state,
    )
  )
    throw new Error(
      integrated
        ? "use a Parent-controlled integration state"
        : "use integrate-child for Parent-controlled states",
    );
  const parent = taskRecord(parentDir);
  const child = taskRecord(childDir);
  if (!parent || !child) throw new Error("parent and child need task.json");
  if (child.parent !== path.basename(parentDir))
    throw new Error("child is not linked to parent");
  const evidence = requireArgument(option(args, "--evidence"), "--evidence");
  const ref = option(args, "--ref");
  const reason = option(args, "--reason");
  const errors = childStateErrors(
    parentDir,
    parent,
    childDir,
    state,
    evidence,
    { ref, reason },
  );
  if (integrated && ["accepted", "integrating", "integrated"].includes(state)) {
    const extras =
      readKernel({ taskDir: childDir, cwd: root }).kernel.projection?.extras ??
      {};
    if (
      (extras.required_controls as Record<string, unknown> | undefined)
        ?.rigor === "full"
    ) {
      const parsed = readStrategyContract(childDir);
      errors.push(...parsed.errors);
      if (parsed.contract)
        errors.push(
          ...currentGateErrors(
            childDir,
            child,
            "child-review",
            requiredGates("child-review", parsed.contract),
            parsed.contract,
            readKernel({ taskDir: childDir, cwd: root }).kernel
              .gates as unknown as Record<string, unknown>,
          ),
        );
      try {
        assertFullQualityForPhase(childDir, extras, "archive");
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  const executeMerge = args.includes("--execute-merge");
  if (executeMerge) {
    if (!integrated || state !== "integrated")
      errors.push(
        "--execute-merge is only valid with integrate-child ... integrated",
      );
    if (!ref || ref.startsWith("-") || /[\r\n]/.test(ref))
      errors.push("--execute-merge requires a valid --ref");
    const git = (...gitArgs: string[]): string =>
      execFileSync("git", gitArgs, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    try {
      if (!sameGitRoot(git("rev-parse", "--show-toplevel"), root))
        errors.push("merge execution requires the project Git root");
      if (ref) git("rev-parse", "--verify", `${ref}^{commit}`);
    } catch {
      errors.push(
        `merge ref does not resolve to a commit: ${ref ?? "(missing)"}`,
      );
    }
    try {
      const dirty = git("status", "--porcelain", "--untracked-files=all")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) =>
          line.slice(3).trim().replaceAll("\\", "/").replace(/^"|"$/g, ""),
        )
        .filter((file) => file !== ".pactile" && !file.startsWith(".pactile/"));
      if (dirty.length)
        errors.push(
          `non-Pactile working tree changes block merge execution: ${dirty.slice(0, 8).join(", ")}`,
        );
    } catch {
      errors.push("git status failed during merge preflight");
    }
  }
  if (errors.length) {
    console.error(errors.map((error) => `  - ${error}`).join("\n"));
    return 1;
  }
  if (args.includes("--check")) {
    console.log(`Child state check: PASS (${state})`);
    return 0;
  }
  if (executeMerge) {
    try {
      execFileSync("git", ["merge", "--no-ff", "--no-commit", ref as string], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      console.error(
        `git merge failed; Parent task-map was not advanced to integrated: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  const { data, body } = readTaskMap(parentDir);
  if (!data) throw new Error("task-map.md missing");
  const entry = data.children.find(
    (item) => item.id === path.basename(childDir),
  );
  if (!entry) throw new Error("child missing from task-map.md");
  entry.state = state;
  entry.evidence = evidence;
  if (ref) entry.ref = ref;
  if (reason) entry.reason = reason;
  if (state === "integrating" && !data.integration_queue.includes(entry.id))
    data.integration_queue.push(entry.id);
  else if (state !== "integrating")
    data.integration_queue = data.integration_queue.filter(
      (id) => id !== entry.id,
    );
  const previous =
    readKernel({ taskDir: parentDir, cwd: root }).kernel.projection?.extras ??
    {};
  const states =
    previous.task_map_states && typeof previous.task_map_states === "object"
      ? (previous.task_map_states as Record<string, unknown>)
      : {};
  patchTask(
    root,
    path.basename(parentDir),
    {},
    integrated ? "integrate-child" : "set-child-state",
    {
      task_map_states: { ...states, [entry.id]: state },
      ...(integrated
        ? { integration_action: "integrate-child", integration_actor: "parent" }
        : {}),
    },
  );
  writeTaskMap(
    parentDir,
    data,
    body,
    `${integrated ? "Parent integrated" : "Child reported"} ${entry.id} as ${state}. Evidence: ${evidence}.`,
  );
  console.log(`${entry.id}: ${state}`);
  return 0;
}

function reviewChild(root: string, args: string[]): number {
  const parentDir = taskDir(root, requireArgument(args[0], "parent task"));
  const childDir = taskDir(root, requireArgument(args[1], "child task"));
  const parent = taskRecord(parentDir);
  const child = taskRecord(childDir);
  if (
    child?.parent !== path.basename(parentDir) ||
    !parent?.children.includes(path.basename(childDir))
  )
    throw new Error("linked Parent and Child task.json are required");
  const map = readTaskMap(parentDir).data;
  const entry = map?.children.find(
    (item) => item.id === path.basename(childDir),
  );
  if (!entry) throw new Error("Child missing from Parent task-map.md");
  const decision = option(args, "--decision");
  if (
    decision &&
    !["accept", "changes", "cancel", "integrate-through"].includes(decision)
  )
    throw new Error(
      "--decision must be accept, changes, cancel, or integrate-through",
    );
  const check = args.includes("--check") || !decision;
  const ref = option(args, "--ref");
  const reason = option(args, "--reason");
  const notes = option(args, "--notes");
  const verifyFile = path.join(childDir, "verify.md");
  const handoffFile = path.join(childDir, "handoff.md");
  const verify = fs.existsSync(verifyFile)
    ? fs.readFileSync(verifyFile, "utf8")
    : "";
  const handoff = fs.existsSync(handoffFile)
    ? fs.readFileSync(handoffFile, "utf8")
    : "";
  const excerpt = (content: string): string =>
    content
      .slice(0, 800)
      .trim()
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n") || "> (empty)";
  const report = [
    `# Parent review — \`${path.basename(childDir)}\``,
    "",
    `- Timestamp: ${new Date().toISOString()}`,
    `- Current integration state: \`${entry.state}\``,
    `- Decision: \`${check ? "check-only" : decision}\``,
    "",
    "## Handoff artifacts",
    "",
    `- verify.md: ${verify.trim() ? "present" : "missing"}`,
    `- handoff.md: ${handoff.trim() ? "present" : "missing"}`,
    `- validation signal: ${/^\s*(?:[-*]\s*)?validation(?:\s+(?:commands?|results?|evidence))?\s*:\s*\S.{2,}$/im.test(verify)}`,
    `- acceptance signal: ${/^\s*(?:[-*]\s*)?(?:(?:final|user)\s+)?acceptance(?:\s+evidence)?\s*:\s*\S.{2,}$/im.test(verify)}`,
    `- durable learning decision signal: ${/durable learning decision\s*:/i.test(verify)}`,
    "",
    ...(notes ? ["## Parent notes", "", excerpt(notes), ""] : []),
    "## verify.md excerpt",
    "",
    excerpt(verify),
    "",
    "## handoff.md excerpt",
    "",
    excerpt(handoff),
    "",
  ].join("\n");
  if (check) {
    const errors = [
      ...(entry.state !== "review"
        ? [`Child must be in review state, got ${entry.state}`]
        : []),
      ...(!verify.trim() ? ["verify.md missing"] : []),
      ...(!handoff.trim() ? ["handoff.md missing"] : []),
    ];
    console.log(
      `Review-child check: ${errors.length ? "FAIL" : "PASS"}\n${errors.map((error) => `  - ${error}`).join("\n")}\n\n${report}`,
    );
    return errors.length ? 1 : 0;
  }
  const state =
    decision === "accept" || decision === "integrate-through"
      ? "accepted"
      : decision === "changes"
        ? "changes"
        : "cancelled";
  const transition = (target: string, evidence: string): number =>
    updateChildState(
      root,
      [
        path.basename(parentDir),
        path.basename(childDir),
        target,
        "--evidence",
        evidence,
        ...(ref ? ["--ref", ref] : []),
        ...(reason ? ["--reason", reason] : []),
      ],
      true,
    );
  // Validate the first transition before writing any review artifact or Parent evidence.
  const firstCheck = updateChildState(
    root,
    [
      path.basename(parentDir),
      path.basename(childDir),
      state,
      "--evidence",
      "handoff.md",
      ...(ref ? ["--ref", ref] : []),
      ...(reason ? ["--reason", reason] : []),
      "--check",
    ],
    true,
  );
  if (firstCheck !== 0) return firstCheck;
  if (transition(state, "handoff.md") !== 0) return 1;
  if (decision === "integrate-through") {
    if (
      transition("integrating", "task-map.md") !== 0 ||
      transition("integrated", "task-map.md") !== 0
    )
      return 1;
  }
  const reviewFile = path.join(
    parentDir,
    `review-${path.basename(childDir)}.md`,
  );
  if (args.includes("--write-artifact"))
    fs.writeFileSync(reviewFile, `${report}\n`, "utf8");
  if (!args.includes("--no-append-parent-verify")) {
    const parentVerify = path.join(parentDir, "verify.md");
    const current = fs.existsSync(parentVerify)
      ? fs.readFileSync(parentVerify, "utf8")
      : "# Verification Evidence\n";
    const note = `## Parent review — \`${path.basename(childDir)}\`\n\n- Decision: ${decision}\n- Child handoff: ${path.basename(childDir)}/handoff.md\n- Child verification: ${path.basename(childDir)}/verify.md\n- Review artifact: ${args.includes("--write-artifact") ? path.basename(reviewFile) : "not written"}\n`;
    fs.writeFileSync(parentVerify, `${current.trimEnd()}\n\n${note}`, "utf8");
  }
  console.log(report);
  return 0;
}

function showTask(root: string, args: string[]): number {
  const reference = requireArgument(args[0], "task");
  const dir = taskDir(root, reference);
  const migration = readLegacyTaskImportRecord(root, dir);
  if (migration && migration.status !== "imported") {
    const status = migration.status;
    const details = {
      status,
      taskId: migration.legacyTaskId,
      missingDefinitionFields: migration.missingDefinitionFields,
      coordinationReasons: migration.coordinationReasons,
      hardDependencies: migration.dependencyFacts.hardDependencies,
      sourceFingerprint: migration.sourceFingerprint,
    };
    if (args.includes("--json")) console.log(JSON.stringify(details, null, 2));
    else
      console.log(
        [
          `${migration.legacyTaskId} (legacy migration: ${status})`,
          migration.missingDefinitionFields.length
            ? `Definition fields to supply: ${migration.missingDefinitionFields.join(", ")}`
            : null,
          migration.coordinationReasons.length
            ? `Dependency coordination: ${migration.coordinationReasons.join(", ")}`
            : null,
          "No runnable V2 Task Kernel was created; original Task, Kernel, and documents remain preserved.",
        ]
          .filter((line): line is string => line !== null)
          .join("\n"),
      );
    return 0;
  }
  if (!fs.existsSync(path.join(dir, "kernel.json")) && !migration) {
    const record = taskRecord(dir);
    if (!record)
      throw new Error(`No readable legacy task record exists at ${dir}`);
    console.log(
      args.includes("--json")
        ? JSON.stringify({ schemaVersion: 0, task: record }, null, 2)
        : `${record.title || record.name} (${record.id})\nLegacy task.json record without Kernel\nStatus: ${record.status}\nAutomatic migration: reserved for P36.`,
    );
    return 0;
  }
  const read = readTaskKernel({ root, taskDir: dir, cwd: root });
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        read.kind === "task-kernel-v2"
          ? read.kernel
          : { ...read.kernel, task: taskRecord(dir) },
        null,
        2,
      ),
    );
    return 0;
  }
  if (read.kind === "task-kernel-v2") {
    const { definition, runs, reviews, phase, condition, revision } =
      read.kernel;
    console.log(
      [
        `${definition.title} (${definition.taskId})`,
        `Kernel: v2 @ revision ${revision}`,
        `Phase: ${phase} | condition: ${condition}`,
        `Deliverable: ${definition.deliverable}`,
        `Delivery level: ${definition.deliveryLevel}`,
        `Dependencies: ${definition.dependencies.length ? definition.dependencies.join(", ") : "none"}`,
        "Acceptance criteria:",
        ...definition.acceptanceCriteria.map(
          (criterion) => `  - ${criterion.id}: ${criterion.description}`,
        ),
        `Runs: ${runs.length} | Reviews: ${reviews.length}`,
      ].join("\n"),
    );
    return 0;
  }
  const record = taskRecord(dir);
  console.log(
    `${record?.title ?? record?.id ?? path.basename(dir)} (legacy Kernel v1)\nPhase: ${read.kernel.kernel.phase}\nStatus: ${record?.status ?? "unknown"}\nAutomatic migration: reserved for P36.`,
  );
  return 0;
}

function activeV2Tasks(
  root: string,
): { dir: string; kernel: TaskKernelSnapshotV2 }[] {
  const archivePrefix =
    `${path.resolve(root, ".pactile", "tasks", "archive")}${path.sep}`.toLowerCase();
  return listTaskKernelSnapshots(root)
    .filter(
      ({ taskDir: dir }) =>
        !path.resolve(dir).toLowerCase().startsWith(archivePrefix),
    )
    .map(({ taskDir: dir, kernel }) => ({ dir: path.basename(dir), kernel }));
}

function v2DisplayStatus(kernel: TaskKernelSnapshotV2): string {
  return kernel.phase === "close" ? "closed" : kernel.phase;
}

function listTasks(args: string[], root: string): void {
  const developer = readDeveloper(root);
  const mine = args.includes("--mine") || args.includes("-m");
  if (mine && !developer)
    throw new Error("No developer set. Run pactile init --user <name>");
  const assignee = option(args, "--assignee") ?? (mine ? developer : undefined);
  const status = option(args, "--status") ?? option(args, "-s");
  const selected = resolveSelectedTask(root).taskPath;
  const phaseForStatus: Record<string, string> = {
    planning: "define",
    in_progress: "execute",
    review: "verify",
    completed: "close",
    closed: "close",
  };
  const requiredPhase = status ? (phaseForStatus[status] ?? status) : undefined;
  const migrationRecords = listLegacyTaskImportRecords(root);
  const restoredSourcePaths = new Set(
    migrationRecords.flatMap(({ record }) => {
      if (record.status !== "imported") return [];
      const taskJsonPath =
        record.legacySourceMetadata?.fileReferences.taskJson?.path;
      if (
        !taskJsonPath?.startsWith(".pactile/tasks/") ||
        !taskJsonPath.endsWith("/task.json")
      )
        return [];
      const sourceTaskPath = taskJsonPath.slice(0, -"/task.json".length);
      return sourceTaskPath === record.taskPath
        ? []
        : [sourceTaskPath.slice(".pactile/tasks/".length)];
    }),
  );
  const migrationByDirectory = new Map(
    migrationRecords.map((item) => [path.resolve(item.taskDir), item.record]),
  );
  const tasks = activeTasks(root).filter(
    ({ dir, record }) =>
      !migrationByDirectory.has(path.resolve(root, ".pactile", "tasks", dir)) &&
      (!assignee || record.assignee === assignee) &&
      (!status || record.status === status),
  );
  const pendingImports = migrationRecords.filter(({ taskDir, record }) => {
    if (
      record.status === "imported" ||
      record.status === "archived-historical-only" ||
      restoredSourcePaths.has(
        path
          .relative(path.join(root, ".pactile", "tasks"), taskDir)
          .replaceAll("\\", "/"),
      )
    )
      return false;
    const raw = taskRecord(taskDir);
    return (
      (!assignee || raw?.assignee === assignee) &&
      (!status || raw?.status === status)
    );
  });
  const v2Tasks = activeV2Tasks(root).filter(
    ({ kernel }) =>
      (!assignee || kernel.definition.createdBy === assignee) &&
      (!requiredPhase || kernel.phase === requiredPhase),
  );
  console.log(
    assignee ? `Tasks (assignee: ${assignee}):` : "All active tasks:",
  );
  console.log();
  for (const { dir, record } of tasks) {
    const marker = `.pactile/tasks/${dir}` === selected ? " <- selected" : "";
    console.log(
      `  - ${dir}/ (${record.status})${record.package ? ` @${record.package}` : ""} [${record.assignee || "-"}]${marker}`,
    );
  }
  for (const { dir, kernel } of v2Tasks) {
    const marker = `.pactile/tasks/${dir}` === selected ? " <- selected" : "";
    console.log(
      `  - ${dir}/ (${v2DisplayStatus(kernel)}; Kernel v2) [${kernel.definition.createdBy}]${marker}`,
    );
  }
  for (const { taskDir: importedDir, record } of pendingImports) {
    const dir = path
      .relative(path.join(root, ".pactile", "tasks"), importedDir)
      .replaceAll("\\", "/");
    const marker = `.pactile/tasks/${dir}` === selected ? " <- selected" : "";
    const detail =
      record.status === "needs-definition"
        ? `needs definition: ${record.missingDefinitionFields.join(", ")}`
        : `needs dependency coordination: ${record.coordinationReasons.join(", ")}`;
    console.log(`  - ${dir}/ (${detail}; not runnable)${marker}`);
  }
  if (!tasks.length && !v2Tasks.length && !pendingImports.length)
    console.log("  (no active tasks)");
  console.log(
    `\nTotal: ${tasks.length + v2Tasks.length + pendingImports.length} task(s)`,
  );
}

function listArchive(root: string, month?: string): void {
  if (month && !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month))
    throw new Error("archive month must be YYYY-MM");
  const archive = path.join(root, ".pactile", "tasks", "archive");
  console.log("Archived tasks:\n");
  if (!fs.existsSync(archive)) return;
  const months = month
    ? [month]
    : fs
        .readdirSync(archive, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
  for (const name of months) {
    const monthDir = path.join(archive, name);
    if (!fs.statSync(monthDir, { throwIfNoEntry: false })?.isDirectory()) {
      console.log(`  No archives for ${name}`);
      continue;
    }
    const tasks = fs
      .readdirSync(monthDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    console.log(`[${name}]${month ? "" : ` - ${tasks.length} task(s)`}`);
    if (month) for (const task of tasks) console.log(`  - ${task}/`);
  }
}

function dashboard(root: string): void {
  const selected = resolveSelectedTask(root);
  console.log("Task Dashboard\nPactile framework: active");
  console.log(
    `Selected task: ${selected.taskPath ?? "none"}${selected.taskPath ? ` (${selected.source})` : ""}\n`,
  );
  const tasks = activeTasks(root);
  const v2Tasks = activeV2Tasks(root);
  if (!tasks.length) console.log("Tasks: none");
  for (const [status, heading] of [
    ["planning", "Define"],
    ["in_progress", "Execute"],
    ["review", "Verify"],
  ] as const) {
    const matching = tasks.filter(({ record }) => record.status === status);
    if (!matching.length) continue;
    console.log(`${heading}:`);
    for (const { dir, record } of matching)
      console.log(
        `  - .pactile/tasks/${dir} (${heading}) [${record.assignee || "-"}]`,
      );
    console.log();
  }
  if (v2Tasks.length) {
    console.log("Task Kernel v2:");
    for (const { dir, kernel } of v2Tasks)
      console.log(
        `  - .pactile/tasks/${dir} (${v2DisplayStatus(kernel)}) [${kernel.definition.deliveryLevel}]`,
      );
    console.log();
  }
  console.log(
    'Suggested actions:\n  - Select a task: pactile task select <task>\n  - Create a deliverable Task: pactile task create "<title>" --slug <slug> --deliverable <text> --delivery-level <level> --accept <criterion>\n  - Inspect tasks: pactile task list | pactile task show <task>',
  );
}

function startExecution(root: string, args: string[]): number {
  const dir = taskDir(root, requireArgument(args[0], "task"));
  const migration = readLegacyTaskImportRecord(root, dir);
  if (migration) {
    throw new Error(
      `Task ${migration.legacyTaskId} has an active V2 migration record (${migration.status}); use the Task Kernel Run command. Legacy --ignore-deps and execution approvals do not carry over.`,
    );
  }
  const record = taskRecord(dir);
  if (!record) throw new Error(`task.json not found at ${dir}`);
  const check = args.includes("--check");
  const approved = args.includes("--approved");
  if (check === approved) throw new Error("choose --check or --approved");
  const existing = readKernel({ taskDir: dir, cwd: root }).kernel;
  if (
    approved &&
    existing.phase === "execute" &&
    existing.projection?.status === "in_progress"
  ) {
    approvedExecuteTask(root, path.basename(dir));
    console.log(
      `Execution already approved for: ${path.relative(root, dir).replaceAll("\\", "/")}\nStatus: in_progress`,
    );
    return 0;
  }
  const guard = checkStartExecution(
    root,
    dir,
    record,
    approved,
    args.includes("--ignore-deps"),
  );
  for (const warning of guard.warnings)
    console.error(`[dependencies] WARN: ${warning}`);
  if (!guard.ok) {
    console.error(
      `Start-execution check: FAIL\n${guard.errors.map((error) => `  - ${error}`).join("\n")}`,
    );
    return 1;
  }
  if (check) {
    console.log(
      `Start-execution check: PASS\nContract fingerprint: ${guard.contractFingerprint}\nArtifact fingerprint: ${guard.artifactFingerprint}`,
    );
    console.log(
      "Artifact gates are ready. Ask the user for explicit execution approval before running --approved.",
    );
    return 0;
  }
  const prior = record as unknown as Record<string, unknown>;
  const checkedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const baseline = {
    schema_version: 1,
    transition: "start-execution",
    gate: "baseline-check",
    result: "PASS",
    reviewer: "pactile-cli",
    evidence: "task.json",
    checked_at: checkedAt,
    contract_fingerprint: guard.contractFingerprint,
    artifact_fingerprint: guard.artifactFingerprint,
    issue_fingerprint: null,
    consecutive_failures: 0,
    approved_skip: null,
  };
  const existingQgr =
    prior.quality_gate_results && typeof prior.quality_gate_results === "object"
      ? (prior.quality_gate_results as Record<string, unknown>)
      : {};
  const transitions =
    existingQgr.transitions && typeof existingQgr.transitions === "object"
      ? (existingQgr.transitions as Record<string, unknown>)
      : {};
  const qualityGateResults = {
    ...existingQgr,
    schema_version: 1,
    contract_fingerprint: guard.contractFingerprint,
    artifact_fingerprint: guard.artifactFingerprint,
    transitions: {
      ...transitions,
      "start-execution": {
        ...((transitions["start-execution"] as Record<string, unknown>) ?? {}),
        "baseline-check": baseline,
      },
    },
  };
  const approval = {
    schema_version: 1,
    transition: "start-execution",
    approved_at: checkedAt,
    approved_by: "user",
    task_id: record.id,
    assurance: "caller-asserted",
    approval_source: "pactile task start-execution --approved",
    contract_fingerprint: guard.contractFingerprint,
    artifact_fingerprint: guard.artifactFingerprint,
  };
  const extras: Record<string, unknown> = {
    quality_gate_results: qualityGateResults,
    execution_approval: approval,
  };
  const dependencyFacts = dependencyStatus(root, dir, record);
  const priorExtras =
    readKernel({ taskDir: dir, cwd: root }).kernel.projection?.extras ?? {};
  extras.dependency_satisfied = dependencyFacts.satisfied;
  if (args.includes("--ignore-deps")) {
    extras.dependency_override = {
      schema_version: 1,
      approved_by: "user",
      transition: "start-execution",
      dependencies: unmetRequires(
        readDependencyGraph(priorExtras),
        extras.dependency_satisfied as string[],
        record.id,
      ),
      source: "pactile task start-execution --approved --ignore-deps",
      at: checkedAt,
    };
  }
  const revision = readKernel({ taskDir: dir, cwd: root }).kernel.revision;
  applyKernelStart({
    taskDir: dir,
    cwd: root,
    expectedRevision: revision,
    actor: "pactile task start-execution --approved",
    idempotencyKey: `start:${record.id || path.basename(dir)}:${checkedAt}`,
    evidence: "pactile task start-execution --approved",
    record: { ...record, status: "in_progress" },
    extras,
  });
  runTaskHooks(root, "after_start", path.join(dir, "task.json"));
  console.log(
    `Execution approved for: ${path.relative(root, dir).replaceAll("\\", "/")}\nStatus: in_progress`,
  );
  return 0;
}

function recordGate(root: string, args: string[]): number {
  const dir = taskDir(root, requireArgument(args[0], "task"));
  const task = taskRecord(dir);
  if (!task) throw new Error(`task.json not found at ${dir}`);
  const transition = requireArgument(
    option(args, "--transition"),
    "--transition",
  );
  const gate = requireArgument(option(args, "--gate"), "--gate");
  const result = requireArgument(
    option(args, "--result"),
    "--result",
  ).toUpperCase();
  const reviewer = requireArgument(option(args, "--reviewer"), "--reviewer");
  const evidence = requireArgument(option(args, "--evidence"), "--evidence");
  if (!["PASS", "FAIL", "SKIPPED"].includes(result))
    throw new Error("--result must be PASS, FAIL, or SKIPPED");
  const allowed: Record<string, string[]> = {
    "start-execution": ["requirements-review", "architecture-review"],
    "full-task-complete": [
      "code-review",
      "architecture-review",
      "architecture-deep-review",
    ],
    "child-review": [
      "code-review",
      "architecture-review",
      "architecture-deep-review",
    ],
    "parent-integrated": ["integration-review"],
  };
  if (!allowed[transition]?.includes(gate))
    throw new Error(`unsupported transition/gate pair: ${transition}/${gate}`);
  if (!/^[A-Za-z0-9_.:@/-]+$/.test(reviewer))
    throw new Error("--reviewer must be a short identifier");
  if (!evidence.trim() || evidence.length > 240 || /[\r\n]/.test(evidence))
    throw new Error("--evidence must be a short single-line reference");
  if (
    result === "FAIL" &&
    (!option(args, "--issue-fingerprint") || !option(args, "--root-cause"))
  )
    throw new Error("FAIL requires --issue-fingerprint and --root-cause");
  if (
    result === "FAIL" &&
    ![
      "implementation-defect",
      "contract-changing-defect",
      "validation-environment-blocker",
    ].includes(option(args, "--root-cause") ?? "")
  )
    throw new Error("--root-cause is not a known failure route");
  if (
    result === "SKIPPED" &&
    (option(args, "--skip-approved-by") !== "user" ||
      !option(args, "--skip-reason"))
  )
    throw new Error(
      "SKIPPED requires --skip-approved-by user and --skip-reason",
    );
  const parsed = fs.existsSync(path.join(dir, "implement.md"))
    ? readStrategyContract(dir)
    : { contract: null, errors: [] };
  if (parsed.errors.length && transition !== "parent-integrated")
    throw new Error(parsed.errors.join("; "));
  const currentContract = contractFingerprint(dir, task, parsed.contract);
  const currentArtifact = artifactFingerprint(dir, task, transition, gate);
  if (
    option(args, "--contract-fingerprint") &&
    option(args, "--contract-fingerprint") !== currentContract
  )
    throw new Error("contract fingerprint assertion is stale");
  if (
    option(args, "--artifact-fingerprint") &&
    option(args, "--artifact-fingerprint") !== currentArtifact
  )
    throw new Error("artifact fingerprint assertion is stale");
  const record: Record<string, unknown> = {
    schema_version: 1,
    transition,
    gate,
    result,
    reviewer,
    evidence,
    checked_at: new Date().toISOString(),
    contract_fingerprint: currentContract,
    artifact_fingerprint: currentArtifact,
    issue_fingerprint:
      result === "FAIL" ? option(args, "--issue-fingerprint") : null,
    root_cause: result === "FAIL" ? option(args, "--root-cause") : null,
    issue_summary:
      result === "FAIL" ? (option(args, "--issue-summary") ?? null) : null,
    consecutive_failures: result === "FAIL" ? 1 : 0,
    approved_skip:
      result === "SKIPPED"
        ? { approved_by: "user", reason: option(args, "--skip-reason") }
        : null,
  };
  const revision = readKernel({ taskDir: dir, cwd: root }).kernel.revision;
  applyKernelRecordGate({
    taskDir: dir,
    cwd: root,
    expectedRevision: revision,
    actor: `pactile task record-gate ${reviewer}`,
    idempotencyKey: `record-gate:${task.id}:${transition}:${gate}:r${revision}`,
    transition,
    gateName: gate,
    record,
    evidence,
  });
  console.log(`${transition}/${gate}: ${result}`);
  return 0;
}

function recordAcEvidence(root: string, args: string[]): number {
  const reference = requireArgument(args[0], "task");
  const dir = taskDir(root, reference);
  const prd = fs.readFileSync(path.join(dir, "prd.md"), "utf8");
  const verify = fs.readFileSync(path.join(dir, "verify.md"), "utf8");
  const mappings: { ac_id: string; evidence_ref: string }[] = [];
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] !== "--map") continue;
    const assignment = requireArgument(args[index + 1], "--map AC-N=reference");
    const equal = assignment.indexOf("=");
    if (equal < 0) throw new Error("--map must be AC-N=reference");
    mappings.push({
      ac_id: assignment.slice(0, equal),
      evidence_ref: assignment.slice(equal + 1),
    });
    index += 1;
  }
  if (!mappings.length)
    throw new Error("at least one --map AC-N=reference is required");
  const codeRef = requireArgument(option(args, "--code-ref"), "--code-ref");
  const ledger = buildAcEvidenceLedger({
    acceptanceItems: parseAcceptanceItems(prd),
    mappings,
    sourceFingerprint: qualityFingerprint(prd),
    evidenceFingerprint: qualityFingerprint(verify),
    testedCodeFingerprint: codeRef,
  });
  patchTask(root, reference, {}, "record-ac-evidence", {
    ac_evidence_ledger: ledger,
  });
  console.log(
    `AC evidence ledger recorded: ${ledger.items.length} mapped criteria`,
  );
  return 0;
}

function recordIndependentCheck(root: string, args: string[]): number {
  const reference = requireArgument(args[0], "task");
  const mode = requireArgument(option(args, "--mode"), "--mode");
  const result = requireArgument(
    option(args, "--result"),
    "--result",
  ).toUpperCase();
  const evidence = requireArgument(option(args, "--evidence"), "--evidence");
  const codeRef = requireArgument(option(args, "--code-ref"), "--code-ref");
  if (mode !== "self-review" && mode !== "true-independent")
    throw new Error("--mode must be self-review or true-independent");
  if (!["PASS", "FAIL", "BLOCKED"].includes(result))
    throw new Error("--result must be PASS, FAIL, or BLOCKED");
  const independentWorker = args.includes("--independent-worker");
  if (mode === "true-independent" && result === "PASS" && !independentWorker)
    throw new Error("true-independent PASS requires --independent-worker");
  const reviewer = option(args, "--reviewer");
  if (mode === "true-independent" && result === "PASS" && !reviewer)
    throw new Error("true-independent PASS requires --reviewer");
  const verdict = {
    schema_version: 1,
    mode,
    readonly: true,
    result,
    evidence,
    independent_worker: independentWorker,
    reviewer: reviewer ?? null,
    code_fingerprint: codeRef,
    checked_at: new Date().toISOString(),
  };
  patchTask(root, reference, {}, "record-independent-check", {
    independent_check: verdict,
  });
  console.log(`Independent check: ${result} (${mode})`);
  return 0;
}

function archiveTask(root: string, args: string[]): number {
  const dir = taskDir(root, requireArgument(args[0], "task"));
  const record = taskRecord(dir);
  if (!record) throw new Error(`task.json not found at ${dir}`);
  const guard = checkArchive(dir, record);
  const activeChildren = record.children
    .map((id) => path.join(root, ".pactile", "tasks", id))
    .filter((candidate) => fs.existsSync(candidate));
  if (activeChildren.length && !args.includes("--archive-integrated-children"))
    guard.errors.push(
      `active children remain: ${activeChildren.map((candidate) => path.basename(candidate)).join(", ")}; use --archive-integrated-children after preflight`,
    );
  if (activeChildren.length && args.includes("--archive-integrated-children")) {
    for (const childDir of activeChildren) {
      const child = taskRecord(childDir);
      if (!child) {
        guard.errors.push(
          `child task.json missing: ${path.basename(childDir)}`,
        );
        continue;
      }
      guard.errors.push(
        ...checkArchive(childDir, child).errors.map(
          (message) => `${path.basename(childDir)}: ${message}`,
        ),
      );
    }
  }
  guard.ok = guard.errors.length === 0;
  if (!guard.ok) {
    console.error(
      `Archive check: FAIL\n${guard.errors.map((error) => `  - ${error}`).join("\n")}`,
    );
    return 1;
  }
  if (args.includes("--check")) {
    console.log("Archive check: PASS");
    return 0;
  }
  if (activeChildren.length) {
    for (const childDir of activeChildren) {
      const childArgs = [path.basename(childDir), "--no-commit"];
      if (archiveTask(root, childArgs) !== 0)
        throw new Error(`child archive failed: ${path.basename(childDir)}`);
    }
  }
  const now = new Date();
  const completedAt = localDate(now);
  const month = completedAt.slice(0, 7);
  const destination = path.join(
    root,
    ".pactile",
    "tasks",
    "archive",
    month,
    path.basename(dir),
  );
  if (fs.existsSync(destination))
    throw new Error(`Archive destination already exists: ${destination}`);
  const revision = readKernel({ taskDir: dir, cwd: root }).kernel.revision;
  const archivedRelative = path
    .relative(root, destination)
    .replaceAll("\\", "/");
  const verifyText = fs.readFileSync(path.join(dir, "verify.md"), "utf8");
  const acceptance = verifyText
    .match(
      /^\s*(?:[-*]\s*)?(?:(?:final|user)\s+)?acceptance(?:\s+evidence)?\s*:\s*(\S[^\r\n]*)$/im,
    )?.[1]
    ?.trim();
  const points = acceptance
    ? [{ text: acceptance, source: "verify.md", confidence: "low" }]
    : [];
  const notesProjection = {
    schema_version: 1,
    summary: points
      .map((point) => point.text)
      .join("; ")
      .split(/\s+/)
      .slice(0, 150)
      .join(" "),
    pointers: [archivedRelative, `${archivedRelative}/verify.md`],
    source: "cmd_archive",
    points,
  };
  applyKernelArchive({
    taskDir: dir,
    cwd: root,
    expectedRevision: revision,
    actor: "pactile task archive",
    idempotencyKey: `archive:${path.basename(dir)}:${completedAt}`,
    evidence: "pactile task archive",
    record: { ...record, status: "completed", completedAt },
    extras: { notes_projection: notesProjection },
  });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(dir, destination);
  runTaskHooks(root, "after_archive", path.join(destination, "task.json"));
  const selected = resolveSelectedTask(root);
  if (selected.taskPath === `.pactile/tasks/${path.basename(dir)}`)
    exitTask(root);
  if (
    !args.includes("--no-commit") &&
    readPactileConfig(root).session_auto_commit !== "false"
  ) {
    const relativeSource = path.relative(root, dir).replaceAll("\\", "/");
    const relativeDestination = path
      .relative(root, destination)
      .replaceAll("\\", "/");
    let isRepo = false;
    try {
      isRepo =
        execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim() === "true";
    } catch {
      /* Archive remains valid in a non-Git project. */
    }
    try {
      if (isRepo) {
        let ignored = false;
        try {
          execFileSync(
            "git",
            ["check-ignore", "-q", "--", relativeDestination],
            { cwd: root, stdio: ["ignore", "pipe", "ignore"] },
          );
          ignored = true;
        } catch {
          /* The archive path is not ignored. */
        }
        if (!ignored) {
          execFileSync(
            "git",
            ["add", "-A", "--", relativeSource, relativeDestination],
            { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
          );
          const message = `chore(task): archive ${path.basename(dir)}`;
          execFileSync(
            "git",
            [
              "commit",
              "--only",
              "-m",
              message,
              "--",
              relativeSource,
              relativeDestination,
            ],
            { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
          );
        }
      }
    } catch (error) {
      console.warn(
        `Archive state is complete, but scoped git auto-commit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  console.log(path.relative(root, destination).replaceAll("\\", "/"));
  return 0;
}

/** Node entry for the existing task command vocabulary. */
export function runTaskCli(argv: string[], root = process.cwd()): number {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "schedule":
        return runTaskScheduleCli(args, root);
      case "create":
        createTask(args, root);
        return 0;
      case "legacy-create":
        createLegacyTask(args, root);
        return 0;
      case "show":
        return showTask(root, args);
      case "artifacts":
        return taskArtifacts(root, args);
      case "add-dependency": {
        const reference = requireArgument(args[0], "task");
        const dependencyId = requireArgument(args[1], "dependency task ID");
        const { dir, kernel } = taskV2(root, reference);
        const result = addTaskDependency({
          root,
          taskDir: dir,
          expectedRevision: kernel.revision,
          dependencyId,
          actor: actor(root, args),
          idempotencyKey:
            option(args, "--idempotency-key") ??
            `dependency:${kernel.identity.taskId}:${dependencyId}`,
        });
        console.log(
          `Hard dependency added: ${result.kernel.identity.taskId} -> ${dependencyId}\nKernel revision: ${result.kernel.revision}`,
        );
        return 0;
      }
      case "run-start":
        return runStartTask(root, args);
      case "run-resume":
        return resumeTask(root, args);
      case "run-result":
        return runResultTask(root, args);
      case "review":
        return reviewTask(root, args);
      case "close":
        return closeTask(root, args);
      case "start-execution":
        return startExecution(root, args);
      case "record-gate":
        return recordGate(root, args);
      case "record-ac-evidence":
        return recordAcEvidence(root, args);
      case "record-independent-check":
        return recordIndependentCheck(root, args);
      case "add-subtask":
        linkChild(
          root,
          requireArgument(args[0], "parent task"),
          requireArgument(args[1], "child task"),
        );
        return 0;
      case "remove-subtask":
        unlinkChild(
          root,
          requireArgument(args[0], "parent task"),
          requireArgument(args[1], "child task"),
        );
        return 0;
      case "prepare-child-worktree":
        return prepareChildWorktree(root, args);
      case "set-child-state":
        return updateChildState(root, args, false);
      case "integrate-child":
        return updateChildState(root, args, true);
      case "review-child":
        return reviewChild(root, args);
      case "parent-status": {
        const dir = taskDir(root, requireArgument(args[0], "parent task"));
        const snapshot = readTaskMap(dir).data;
        if (!snapshot) throw new Error("task-map.md missing");
        console.log(
          args.includes("--json")
            ? JSON.stringify(snapshot, null, 2)
            : snapshot.children
                .map((child) => `${child.id}: ${child.state}`)
                .join("\n"),
        );
        return 0;
      }
      case "archive":
        return archiveTask(root, args);
      case "prepare-archive-evidence": {
        const dir = taskDir(root, requireArgument(args[0], "task"));
        const record = taskRecord(dir);
        if (!record) throw new Error(`task.json not found at ${dir}`);
        for (const line of prepareArchiveEvidence(
          dir,
          record,
          args.includes("--dry-run"),
        ))
          console.log(line);
        return 0;
      }
      case "prepare-learning-scaffold": {
        const dir = taskDir(root, requireArgument(args[0], "task"));
        const record = taskRecord(dir);
        if (!record) throw new Error(`task.json not found at ${dir}`);
        console.log(
          learningScaffold(root, dir, record, option(args, "--trigger")),
        );
        return 0;
      }
      case "dashboard":
        dashboard(root);
        return 0;
      case "list":
        listTasks(args, root);
        return 0;
      case "list-archive":
        listArchive(root, args[0]);
        return 0;
      case "select": {
        const chosen = selectTask(root, requireArgument(args[0], "task"));
        console.log(
          `Selected task: ${chosen.taskPath}\nSource: ${chosen.source}\nTask status unchanged.`,
        );
        return 0;
      }
      case "selected": {
        const chosen = resolveSelectedTask(root);
        if (args.includes("--json")) {
          if (!chosen.taskPath || chosen.stale) {
            console.log(
              JSON.stringify(
                {
                  selectedTask: chosen.taskPath,
                  source: chosen.source,
                  stale: chosen.stale,
                },
                null,
                2,
              ),
            );
            return chosen.taskPath ? 0 : 1;
          }
          const dir = resolveTaskDir(root, chosen.taskPath);
          const imported = readLegacyTaskImportRecord(root, dir);
          if (imported && imported.status !== "imported") {
            console.log(
              JSON.stringify(
                {
                  taskPath: chosen.taskPath,
                  source: chosen.source,
                  taskId: imported.legacyTaskId,
                  migrationStatus: imported.status,
                  runnable: false,
                  missingDefinitionFields: imported.missingDefinitionFields,
                  coordinationReasons: imported.coordinationReasons,
                  kernelVersion: null,
                },
                null,
                2,
              ),
            );
            return 0;
          }
          if (!fs.existsSync(path.join(dir, "kernel.json")) && !imported) {
            const record = taskRecord(dir);
            console.log(
              JSON.stringify(
                {
                  taskPath: chosen.taskPath,
                  source: chosen.source,
                  taskId: record?.id ?? null,
                  title: record?.title ?? record?.name ?? null,
                  status: record?.status ?? null,
                  kernelVersion: 0,
                },
                null,
                2,
              ),
            );
            return 0;
          }
          const read = readTaskKernel({ root, taskDir: dir, cwd: root });
          const summary =
            read.kind === "task-kernel-v2"
              ? {
                  taskId: read.kernel.identity.taskId,
                  title: read.kernel.definition.title,
                  phase: read.kernel.phase,
                  condition: read.kernel.condition,
                  revision: read.kernel.revision,
                  kernelVersion: 2,
                }
              : {
                  taskId: read.kernel.kernel.identity.taskId,
                  phase: read.kernel.kernel.phase,
                  condition: read.kernel.kernel.condition,
                  revision: read.kernel.kernel.revision,
                  kernelVersion: 1,
                };
          console.log(
            JSON.stringify(
              { taskPath: chosen.taskPath, source: chosen.source, ...summary },
              null,
              2,
            ),
          );
          return 0;
        }
        if (args.includes("--source")) {
          console.log(
            `Selected task: ${chosen.taskPath ?? "(none)"}\nSource: ${chosen.source}`,
          );
          if (chosen.stale) console.log("State: stale");
          else if (chosen.taskPath) {
            const dir = resolveTaskDir(root, chosen.taskPath);
            const imported = readLegacyTaskImportRecord(root, dir);
            if (imported && imported.status !== "imported") {
              console.log(`Migration: ${imported.status}; Run unavailable`);
            } else if (
              fs.existsSync(path.join(dir, "kernel.json")) ||
              imported
            ) {
              const read = readTaskKernel({ root, taskDir: dir, cwd: root });
              const kernel =
                read.kind === "task-kernel-v2"
                  ? read.kernel
                  : read.kernel.kernel;
              console.log(
                `Kernel: ${read.kind === "task-kernel-v2" ? "v2" : "v1"}\nPhase: ${kernel.phase}\nKernel revision: ${kernel.revision}`,
              );
            } else console.log("Kernel: unavailable (legacy task.json only)");
          }
        } else if (chosen.taskPath) console.log(chosen.taskPath);
        else console.error("No task selected for this live session.");
        return chosen.taskPath ? 0 : 1;
      }
      case "exit": {
        const previous = exitTask(root);
        console.log(
          previous.taskPath
            ? `Cleared selected task (was: ${previous.taskPath})\nTask status unchanged.`
            : "No selected task set",
        );
        return 0;
      }
      case "add-context": {
        const dir = taskDir(root, requireArgument(args[0], "task"));
        const name = requireArgument(args[1], "manifest");
        const reference = requireArgument(args[2], "path");
        const added = addContextEntry(root, dir, name, reference, args[3]);
        console.log(
          added ? `Added: ${reference}` : `Entry already exists: ${reference}`,
        );
        return 0;
      }
      case "set-branch":
      case "set-base-branch":
      case "set-scope": {
        const reference = requireArgument(args[0], "task");
        const value = requireArgument(
          args[1],
          command === "set-scope" ? "scope" : "branch",
        );
        const key =
          command === "set-branch"
            ? "branch"
            : command === "set-base-branch"
              ? "base_branch"
              : "scope";
        patchTask(root, reference, { [key]: value }, command);
        console.log(`${key} set to: ${value}`);
        return 0;
      }
      case "set-deps": {
        const reference = requireArgument(args[0], "task");
        const dependencies = [
          ...new Set(args.slice(1).filter((item) => item.trim())),
        ];
        const dir = taskDir(root, reference);
        const record = taskRecord(dir);
        if (!record) throw new Error(`task.json not found at ${dir}`);
        const projection =
          readKernel({ taskDir: dir, cwd: root }).kernel.projection?.extras ??
          {};
        const rawDeps = (record as unknown as Record<string, unknown>)
          .depends_on;
        const oldDeps = Array.isArray(rawDeps)
          ? rawDeps.filter((item): item is string => typeof item === "string")
          : [];
        const graph = readDependencyGraph(projection);
        const edges = graph.edges.filter(
          (edge) =>
            !(
              edge.from === record.id &&
              edge.type === "requires" &&
              oldDeps.includes(edge.to)
            ),
        );
        const satisfied = Array.isArray(projection.dependency_satisfied)
          ? projection.dependency_satisfied.filter(
              (item): item is string =>
                typeof item === "string" && !oldDeps.includes(item),
            )
          : [];
        patchTask(root, reference, {}, command, {
          depends_on: dependencies,
          dependency_graph: { ...graph, edges },
          dependency_satisfied: satisfied,
        });
        console.log(
          dependencies.length
            ? `depends_on set: ${dependencies.join(", ")}`
            : "depends_on cleared to []",
        );
        return 0;
      }
      case "set-depends-mode": {
        const reference = requireArgument(args[0], "task");
        const mode = requireArgument(args[1], "mode");
        if (mode !== "block")
          throw new Error(
            "Node Kernel uses hard requires for all depends_on; only block is supported",
          );
        const record = taskRecord(taskDir(root, reference));
        if (!record) throw new Error(`task.json not found for ${reference}`);
        patchTask(
          root,
          reference,
          { meta: { ...record.meta, depends_mode: mode } },
          command,
        );
        console.log(`depends_mode: ${mode}`);
        return 0;
      }
      case "artifact-locale": {
        const operation = requireArgument(args[0], "artifact-locale operation");
        const reference = option(args, "--task");
        if (operation === "get") {
          const task = reference ? taskRecord(taskDir(root, reference)) : null;
          const taskLocale =
            task?.meta && typeof task.meta === "object"
              ? (task.meta as Record<string, unknown>).artifact_locale
              : undefined;
          console.log(
            taskLocale === "en" || taskLocale === "zh"
              ? taskLocale
              : locale(root),
          );
          return 0;
        }
        if (operation !== "set") throw new Error("use artifact-locale get|set");
        const value = requireArgument(args[1], "locale");
        if (value !== "zh" && value !== "en")
          throw new Error("artifact_locale must be zh or en");
        if (reference) {
          const record = taskRecord(taskDir(root, reference));
          if (!record) throw new Error(`task.json not found for ${reference}`);
          patchTask(
            root,
            reference,
            { meta: { ...record.meta, artifact_locale: value } },
            command,
          );
          console.log(
            `artifact_locale set to ${value} (task ${path.basename(taskDir(root, reference))})`,
          );
          return 0;
        }
        const configFile = path.join(root, ".pactile", "config.yaml");
        const content = fs.existsSync(configFile)
          ? fs.readFileSync(configFile, "utf8")
          : "# Pactile Configuration\n";
        const replacement = `artifact_locale: ${value}`;
        fs.mkdirSync(path.dirname(configFile), { recursive: true });
        fs.writeFileSync(
          configFile,
          /^\s*artifact_locale:\s*[^\r\n]*/m.test(content)
            ? content.replace(/^\s*artifact_locale:\s*[^\r\n]*/m, replacement)
            : `${content.trimEnd()}\n\n${replacement}\n`,
          "utf8",
        );
        console.log(`artifact_locale set to ${value} (workspace)`);
        return 0;
      }
      case "validate": {
        const dir = taskDir(root, requireArgument(args[0], "task"));
        const results = CONTEXT_FILES.map((name) =>
          validateContextFile(root, dir, name),
        );
        for (const result of results) {
          console.log(
            `${result.file}: ${result.errors.length ? "FAIL" : "PASS"} (${result.entries} entries)`,
          );
          for (const message of [...result.errors, ...result.warnings])
            console.log(`  - ${message}`);
        }
        return results.some((result) => result.errors.length) ? 1 : 0;
      }
      case "list-context": {
        const dir = taskDir(root, requireArgument(args[0], "task"));
        for (const name of CONTEXT_FILES) {
          console.log(`[${name}]`);
          const entries = readContextEntries(dir, name);
          for (const [index, entry] of entries.entries())
            console.log(
              `  ${index + 1}. ${entry.file} — ${entry.reason ?? "-"}`,
            );
          if (!entries.length) console.log("  (no curated entries)");
        }
        return 0;
      }
      default:
        console.error(
          "Usage: pactile task <create|legacy-create|show|artifacts|schedule|add-dependency|run-start|run-resume|run-result|review|close|start-execution|archive|prepare-archive-evidence|prepare-learning-scaffold|review-child|dashboard|list|select|selected|exit|add-context|validate|list-context|set-branch|set-base-branch|set-scope|set-deps|set-depends-mode> ...",
        );
        return 1;
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** Promise-aware task entry for the existing CLI wrapper's async operations. */
export async function runTaskCliAsync(
  argv: string[],
  root = process.cwd(),
  scheduleDispatchOptions: TaskScheduleDispatchCliOptionsV1 = {},
): Promise<number> {
  const [command, operation, ...args] = argv;
  if (command === "schedule" && operation === "dispatch") {
    try {
      return await runTaskScheduleDispatchCli(
        args,
        root,
        scheduleDispatchOptions,
      );
    } catch (error) {
      console.error(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  if (command === "schedule") {
    try {
      return await runTaskScheduleCliAsync([operation ?? "", ...args], root);
    } catch (error) {
      console.error(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  return runTaskCli(argv, root);
}
