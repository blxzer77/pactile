import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyKernelCreate,
  closeTaskKernel,
  createTaskKernel,
  emptyTaskRecord,
  recordTaskReview,
  recordTaskRunResult,
  readTaskKernel,
  resumeTaskRun,
  startTaskRun,
} from "../../../src/core/task/index.js";
import {
  createTaskCandidateEntry,
  observeTaskRunCandidate,
} from "../../../src/core/task/task-candidate-observer.js";
import { init } from "../../../src/commands/init.js";
import { applyLegacyTaskUpdate } from "../../../src/pactile/migration/legacy-task-update.js";
import {
  dispatchTaskKernelWaveV1,
  type TaskKernelWaveRunRequestV1,
  type TaskKernelWaveRunResultV1,
} from "../../../src/pactile/scheduler/task-kernel-wave-dispatch.js";
import {
  compareTaskKernelWaveDispatchV1,
  planParentTaskScheduleV1,
  scheduleTaskKernelGraph,
  type TaskKernelWaveComparisonConditionsV1,
  type TaskKernelWaveScenarioMeasurementV1,
} from "../../../src/pactile/scheduler/index.js";
import {
  readTaskMap,
  writeTaskMap,
  type ChildEntry,
  type TaskMap,
} from "../../../src/pactile/task/task-map.js";
import { createTaskRunWorktree } from "../../../src/pactile/worktree/index.js";
import { createPiTaskKernelWaveRunnerV1 } from "../../../src/commands/task-schedule.js";
import { PiRpcClient } from "../../../src/pactile/pi/rpc.js";

const roots: string[] = [];
const FAKE_PI_WAVE_PROVIDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.tmp/p31-script-build/fixtures/fake-pi-wave-provider.js",
);
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../",
);
const RECORD_P37_MEASUREMENT = "PACTILE_RECORD_P37_V2_MEASUREMENT";
const MEASUREMENT_OUTPUT_ENV = "PACTILE_P37_MEASUREMENT_OUTPUT";
const FIXTURE_GIT_DATE = "2026-09-26T00:00:00+00:00";

function measurementReportFile(): string {
  const requestedOutput = process.env[MEASUREMENT_OUTPUT_ENV];
  return requestedOutput
    ? path.resolve(requestedOutput)
    : path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../evidence/p37-v2-paired-fake-pi.json",
      );
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

interface TaskFixture {
  taskId: string;
  taskDir: string;
  runId: string | null;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: FIXTURE_GIT_DATE,
      GIT_COMMITTER_DATE: FIXTURE_GIT_DATE,
    },
  }).trim();
}

function makeGitRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-p37-wave-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], {
    cwd: root,
    stdio: "ignore",
  });
  git(root, "config", "user.name", "Pactile Test");
  git(root, "config", "user.email", "pactile@example.invalid");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "P37 wave fixture\n");
  fs.writeFileSync(path.join(root, "src", "base.ts"), "export {};\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".pactile/\n");
  git(root, "add", "README.md", ".gitignore", "src/base.ts");
  git(root, "commit", "-q", "-m", "fixture base");
  return root;
}

function addLegacyV1NeedsDefinitionTask(root: string, taskId: string): string {
  const taskDir = path.join(root, ".pactile", "tasks", taskId);
  applyKernelCreate({
    taskDir,
    cwd: root,
    actor: "legacy-test-author",
    idempotencyKey: `legacy-v1-create:${taskId}`,
    record: emptyTaskRecord({
      id: taskId,
      name: taskId,
      title: `Legacy ${taskId}`,
      description: "A P36 legacy V1 source record with an incomplete definition.",
      status: "in_progress",
      creator: "legacy-test-author",
      assignee: "legacy-test-owner",
      createdAt: "2026-09-26",
    }),
    evidence: "P36 needs-definition migration fixture",
  });
  fs.writeFileSync(
    path.join(taskDir, "prd.md"),
    "# Legacy task\n\nThe original task has no completed acceptance criteria section.\n",
    "utf8",
  );
  return taskDir;
}

function makeTask(
  root: string,
  taskId: string,
  options: {
    dependencies?: string[];
    writeSet?: string[];
    start?: boolean;
  } = {},
): TaskFixture {
  const taskDir = path.join(root, ".pactile", "tasks", taskId);
  const created = createTaskKernel({
    root,
    taskDir,
    actor: "test-author",
    idempotencyKey: `create:${taskId}`,
    definition: {
      taskId,
      title: `P37 ${taskId}`,
      description: "Wave-dispatch fixture",
      deliverable: "One bounded implementation result",
      deliveryLevel: "local-result",
      acceptanceCriteria: [{ id: "AC-1", description: "Result is reviewable" }],
      dependencies: options.dependencies ?? [],
    },
  });
  if (options.start === false) return { taskId, taskDir, runId: null };
  const started = startTaskRun({
    root,
    taskDir,
    expectedRevision: created.kernel.revision,
    actor: "test-approver",
    idempotencyKey: `start:${taskId}`,
    input: { summary: "Implement the declared result", references: [] },
    authorization: {
      approvedBy: "test-approver",
      approvedAt: "2026-09-26T00:00:00.000Z",
      scope: "declared Task write set",
      evidenceRef: `approval:${taskId}`,
    },
    initialState: "waiting",
    writeSetSnapshot: options.writeSet ?? [`src/${taskId}.ts`],
  });
  return { taskId, taskDir, runId: started.kernel.runs.at(-1)?.id ?? null };
}

function attachManagedWorktree(root: string, task: TaskFixture): string {
  if (!task.runId) throw new Error(`Task Run is missing: ${task.taskId}`);
  return createTaskRunWorktree({
    repoRoot: root,
    taskDir: task.taskDir,
    runId: task.runId,
    branch: `feat/${task.taskId}`,
    baseRef: git(root, "rev-parse", "HEAD"),
    actor: "test-worktree-manager",
    idempotencyKey: `worktree:${task.taskId}`,
  }).binding.canonicalPath;
}

function closePrerequisite(root: string, taskId: string): TaskFixture {
  const task = makeTask(root, taskId, { start: false });
  const started = startTaskRun({
    root,
    taskDir: task.taskDir,
    expectedRevision: 1,
    actor: "test-worker",
    idempotencyKey: `start:${taskId}`,
    input: { summary: "Complete the prerequisite", references: [] },
    authorization: {
      approvedBy: "test-approver",
      approvedAt: "2026-09-26T00:00:00.000Z",
      scope: "declared prerequisite",
      evidenceRef: `approval:${taskId}`,
    },
    writeSetSnapshot: [`src/${taskId}.ts`],
  });
  const runId = started.kernel.runs.at(-1)?.id;
  if (!runId) throw new Error("Prerequisite Run is missing");
  fs.writeFileSync(
    path.join(root, "src", `${taskId}.ts`),
    "export const prerequisite = true;\n",
  );
  fs.writeFileSync(path.join(task.taskDir, "result.txt"), "closed prerequisite\n");
  const completed = recordTaskRunResult({
    root,
    taskDir: task.taskDir,
    expectedRevision: started.kernel.revision,
    runId,
    outcome: "completed",
    summary: "Prerequisite result is complete",
    evidenceRefs: ["result.txt"],
    actor: "test-worker",
    idempotencyKey: `result:${taskId}`,
  });
  const candidate = completed.kernel.runs.at(-1)?.candidateSnapshot;
  if (!candidate) throw new Error("Prerequisite candidate is missing");
  fs.writeFileSync(path.join(task.taskDir, "review.json"), "{}\n");
  const reviewed = recordTaskReview({
    root,
    taskDir: task.taskDir,
    expectedRevision: completed.kernel.revision,
    runId,
    candidateSnapshotId: candidate.id,
    candidateFingerprint: candidate.fingerprint,
    reviewer: "test-reviewer",
    decision: "pass",
    evidenceRefs: ["review.json"],
    acceptanceEvidence: { "AC-1": [`src/${taskId}.ts`] },
    actor: "test-reviewer",
    idempotencyKey: `review:${taskId}`,
  });
  const review = reviewed.kernel.reviews.at(-1);
  if (!review) throw new Error("Prerequisite passing review is missing");
  closeTaskKernel({
    root,
    taskDir: task.taskDir,
    expectedRevision: reviewed.kernel.revision,
    runId,
    reviewId: review.id,
    candidateObservation: {
      snapshotId: candidate.id,
      fingerprint: candidate.fingerprint,
      observedBy: "test-closer",
      observedAt: "2026-09-26T00:05:00.000Z",
      source: "caller-attested",
      evidenceRef: `candidate:${taskId}`,
    },
    deliveryEvidence: {
      level: "local-result",
      reference: `src/${taskId}.ts`,
      summary: "The accepted prerequisite result is present",
    },
    actor: "test-closer",
    idempotencyKey: `close:${taskId}`,
  });
  return { ...task, runId };
}

function archiveTask(root: string, task: TaskFixture): void {
  const archiveDir = path.join(root, ".pactile", "tasks", "archive", "2026-09");
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.renameSync(task.taskDir, path.join(archiveDir, task.taskId));
}

function estimatedCosts(taskIds: readonly string[]) {
  return Object.fromEntries(
    taskIds.map((taskId) => [
      taskId,
      {
        latencyMs: 10,
        waitingMs: 10,
        executionMs: 1_000,
        integrationMs: 5,
        reworkMs: 5,
        reviewMs: 5,
      },
    ]),
  );
}

function testProviderResult(
  request: TaskKernelWaveRunRequestV1,
  overrides: Partial<TaskKernelWaveRunResultV1> = {},
): TaskKernelWaveRunResultV1 {
  return {
    outcome: "settled",
    scheduleReceiptFingerprint: request.scheduleReceiptFingerprint,
    admissionReceiptFingerprint: "a".repeat(64),
    hostStopVerified: true,
    leaseReleased: true,
    evidenceRef: `fake-pi-provider-test-only:${request.taskId}`,
    reason: null,
    ...overrides,
  };
}

function fakePiScript(
  root: string,
  options: {
    barrierSize?: number;
    failTaskIds?: string[];
    hangTaskIds?: string[];
    startedDirectory?: string;
  } = {},
): string[] {
  const args = [
    FAKE_PI_WAVE_PROVIDER,
    "--started-directory",
    options.startedDirectory ?? path.join(root, "provider-starts"),
    "--barrier-size",
    String(options.barrierSize ?? 0),
  ];
  for (const taskId of options.failTaskIds ?? [])
    args.push("--fail-task-id", taskId);
  for (const taskId of options.hangTaskIds ?? [])
    args.push("--hang-task-id", taskId);
  return args;
}

function fakePiLaunch(args: string[]) {
  return { command: process.execPath, args };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Json(value: unknown): string {
  return sha256(`${JSON.stringify(value, null, 2)}\n`);
}

function sanitizedEvidenceValue(value: unknown, root: string): unknown {
  if (typeof value === "string") {
    return [
      [root, "<scenario-root>"],
      [root.replaceAll("\\", "/"), "<scenario-root>"],
      [REPOSITORY_ROOT, "<repository-root>"],
      [REPOSITORY_ROOT.replaceAll("\\", "/"), "<repository-root>"],
    ].reduce((sanitized, [source, replacement]) =>
      sanitized.replaceAll(source, replacement), value);
  }
  if (Array.isArray(value))
    return value.map((item) => sanitizedEvidenceValue(item, root));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sanitizedEvidenceValue(item, root),
    ]),
  );
}

function checkedProjectPath(root: string, ref: string): string {
  const absolutePath = path.resolve(root, ref);
  const relativePath = path.relative(root, absolutePath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  )
    throw new Error(`Measurement evidence path escapes its scenario root: ${ref}`);
  return absolutePath;
}

function readJsonEvidence(
  root: string,
  ref: string,
): {
  path: string;
  rawSha256: string;
  contentSha256: string;
  content: unknown;
} {
  const absolutePath = checkedProjectPath(root, ref);
  const raw = fs.readFileSync(absolutePath, "utf8");
  const content = sanitizedEvidenceValue(JSON.parse(raw) as unknown, root);
  return {
    path: path.relative(root, absolutePath).replaceAll("\\", "/"),
    rawSha256: sha256(raw),
    contentSha256: sha256Json(content),
    content,
  };
}

function readTextEvidence(
  root: string,
  ref: string,
): {
  path: string;
  rawSha256: string;
  contentSha256: string;
  content: string;
} {
  const absolutePath = checkedProjectPath(root, ref);
  const raw = fs.readFileSync(absolutePath, "utf8");
  const content = sanitizedEvidenceValue(raw, root);
  if (typeof content !== "string")
    throw new Error(`Text evidence could not be normalized: ${ref}`);
  return {
    path: path.relative(root, absolutePath).replaceAll("\\", "/"),
    rawSha256: sha256(raw),
    contentSha256: sha256(content),
    content,
  };
}

function writePairedMeasurementReport(
  serialControl: PairedScenarioEvidenceV1,
  scheduledWaves: PairedScenarioEvidenceV1,
  comparison: ReturnType<typeof compareTaskKernelWaveDispatchV1>,
): { path: string; sha256: string } {
  const reportFile = measurementReportFile();
  if (fs.existsSync(reportFile))
    throw new Error(
      `Refusing to overwrite frozen P37 measurement evidence: ${reportFile}`,
    );
  const sourceStatus = git(
    REPOSITORY_ROOT,
    "status",
    "--porcelain",
    "--untracked-files=all",
  );
  if (sourceStatus)
    throw new Error(
      "P37 measurement can be recorded only from a clean source worktree",
    );
  const reportBody = {
    schemaVersion: 1,
    evidenceClass: "controlled-fake-pi-simulation",
    providerAcceptance: "not-claimed",
    generatedAt: new Date().toISOString(),
    sourceCode: {
      commitSha: git(REPOSITORY_ROOT, "rev-parse", "HEAD"),
      treeSha: git(REPOSITORY_ROOT, "rev-parse", "HEAD^{tree}"),
      branch: git(REPOSITORY_ROOT, "branch", "--show-current"),
      worktreeCleanBeforeReport: true,
      command:
        'pnpm --filter @blxzer/pactile exec vitest run test/pactile/scheduler/task-kernel-wave-dispatch.test.ts -t "compares measured serial control"',
    },
    pairing: {
      conditions: comparison.conditions,
      bothScenarioConditionsMatch:
        JSON.stringify(serialControl.conditions) ===
        JSON.stringify(scheduledWaves.conditions),
      worktreeBaseCommitSha: serialControl.baseCommitSha,
      runInputsSha256: serialControl.conditions.runInputsSha256,
      promptsSha256: serialControl.conditions.promptsSha256,
      providerConfigSha256: serialControl.conditions.providerConfigSha256,
    },
    scenarios: { serialControl, scheduledWaves },
    comparison,
    comparisonSha256: sha256Json(comparison),
  };
  if (
    !reportBody.pairing.bothScenarioConditionsMatch ||
    serialControl.baseCommitSha !== scheduledWaves.baseCommitSha
  )
    throw new Error("P37 paired evidence has mismatched control conditions");
  const reportSha256 = sha256Json(reportBody);
  const serializedReport = `${JSON.stringify(
    { ...reportBody, reportSha256 },
    null,
    2,
  )}\n`;
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, serializedReport, {
    encoding: "utf8",
    flag: "wx",
  });
  const readBack = JSON.parse(
    fs.readFileSync(reportFile, "utf8"),
  ) as typeof reportBody & { reportSha256: string };
  const { reportSha256: readBackSha256, ...readBackBody } = readBack;
  if (
    readBackSha256 !== reportSha256 ||
    sha256Json(readBackBody) !== reportSha256 ||
    readBack.comparisonSha256 !== sha256Json(readBack.comparison)
  )
    throw new Error("Persisted P37 measurement report failed SHA-256 read-back");
  process.stdout.write(
    `[P37 paired fake-Pi evidence] ${reportFile} sha256=${sha256(serializedReport)} comparisonSha256=${readBack.comparisonSha256}\n`,
  );
  return { path: reportFile, sha256: sha256(serializedReport) };
}

const MEASURED_TASK_IDS = ["p37-bench-a", "p37-bench-b"] as const;
const MEASURED_PARENT_ID = "p37-bench-parent";

function makeMeasurementParent(root: string): string {
  const parentDir = path.join(root, ".pactile", "tasks", MEASURED_PARENT_ID);
  fs.mkdirSync(parentDir, { recursive: true });
  const children: ChildEntry[] = MEASURED_TASK_IDS.map((id) => ({
    id,
    state: "open",
    depends_on: [],
    touches: [`src/${id}.ts`],
    isolation: "git-worktree",
    ref: null,
  }));
  const map: TaskMap = {
    parent_id: MEASURED_PARENT_ID,
    contract_epoch: 1,
    execution_topology: "parallel",
    merge_limit: 1,
    children,
    stages: [],
    integration_queue: [],
  };
  writeTaskMap(parentDir, map, "# P37 paired measurement\n\n## Event Log\n");
  return parentDir;
}

function recordParentChildState(
  parentDir: string,
  taskId: string,
  state: ChildEntry["state"],
  event: string,
): void {
  const read = readTaskMap(parentDir);
  if (!read.data) throw new Error("Parent task map could not be read");
  const child = read.data.children.find((candidate) => candidate.id === taskId);
  if (!child) throw new Error(`Parent Child is missing: ${taskId}`);
  child.state = state;
  writeTaskMap(parentDir, read.data, read.body, event);
}

async function finishMeasuredTask(
  root: string,
  parentDir: string,
  task: TaskFixture,
): Promise<void> {
  const beforeResult = readTaskKernel({
    root,
    taskDir: task.taskDir,
    cwd: root,
  });
  if (beforeResult.kind !== "task-kernel-v2")
    throw new Error("Expected Task Kernel V2");
  let kernel = beforeResult.kernel;
  let run = kernel.runs.find(({ id }) => id === task.runId);
  if (run?.state === "waiting") {
    const resumed = resumeTaskRun({
      root,
      taskDir: task.taskDir,
      expectedRevision: kernel.revision,
      runId: run.id,
      actor: "measurement-fixture-worker",
      idempotencyKey: `resume:${task.taskId}`,
    });
    kernel = resumed.kernel;
    run = kernel.runs.find(({ id }) => id === task.runId);
  }
  if (!run?.workspace?.canonicalPath)
    throw new Error(`Managed workspace is missing for ${task.taskId}`);
  const outputRef = `src/${task.taskId}.ts`;
  const outputPath = path.join(run.workspace.canonicalPath, outputRef);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    `export const ${task.taskId.replaceAll("-", "_")} = true;\n`,
  );
  const observation = observeTaskRunCandidate({ run });
  const outputFile = observation.currentFiles.find(
    (file) => file.path === outputRef,
  );
  if (!outputFile?.sha256)
    throw new Error(`Candidate output was not observed for ${task.taskId}`);
  const completed = recordTaskRunResult({
    root,
    taskDir: task.taskDir,
    expectedRevision: kernel.revision,
    runId: run.id,
    outcome: "completed",
    summary: "Fake Pi measurement run produced a real scoped candidate file.",
    candidateEntries: [
      { ref: outputFile.path, fingerprint: outputFile.sha256 },
      createTaskCandidateEntry(observation),
    ],
    actor: "measurement-fixture-worker",
    idempotencyKey: `result:${task.taskId}`,
  });
  const candidate = completed.kernel.runs.at(-1)?.candidateSnapshot;
  if (!candidate)
    throw new Error(`Candidate snapshot is missing for ${task.taskId}`);

  const firstReviewRef = "review-needs-changes.md";
  fs.writeFileSync(
    path.join(task.taskDir, firstReviewRef),
    "Simulation fixture: first review requested a bounded follow-up.\n",
  );
  await new Promise((resolve) => setTimeout(resolve, 15));
  const firstReview = recordTaskReview({
    root,
    taskDir: task.taskDir,
    expectedRevision: completed.kernel.revision,
    runId: run.id,
    candidateSnapshotId: candidate.id,
    candidateFingerprint: candidate.fingerprint,
    reviewer: "fake-independent-reviewer-simulation-only",
    decision: "needs-changes",
    evidenceRefs: [firstReviewRef],
    unresolvedBlockers: ["Add the measured comparison receipt to the fixture."],
    actor: "fake-independent-reviewer-simulation-only",
    idempotencyKey: `review-needs-changes:${task.taskId}`,
  });
  recordParentChildState(
    parentDir,
    task.taskId,
    "changes",
    `Child reported ${task.taskId} as changes.`,
  );

  const secondReviewRef = "review-pass.md";
  fs.writeFileSync(
    path.join(task.taskDir, secondReviewRef),
    "Simulation fixture: scoped output and measured receipt are present.\n",
  );
  await new Promise((resolve) => setTimeout(resolve, 15));
  const passingReview = recordTaskReview({
    root,
    taskDir: task.taskDir,
    expectedRevision: firstReview.kernel.revision,
    runId: run.id,
    candidateSnapshotId: candidate.id,
    candidateFingerprint: candidate.fingerprint,
    reviewer: "fake-independent-reviewer-simulation-only",
    decision: "pass",
    evidenceRefs: [secondReviewRef],
    acceptanceEvidence: { "AC-1": [outputRef] },
    actor: "fake-independent-reviewer-simulation-only",
    idempotencyKey: `review-pass:${task.taskId}`,
  });
  void passingReview;
  recordParentChildState(
    parentDir,
    task.taskId,
    "accepted",
    `Child reported ${task.taskId} as accepted.`,
  );
  await new Promise((resolve) => setTimeout(resolve, 15));
  recordParentChildState(
    parentDir,
    task.taskId,
    "integrating",
    `Child reported ${task.taskId} as integrating.`,
  );
  await new Promise((resolve) => setTimeout(resolve, 15));
  recordParentChildState(
    parentDir,
    task.taskId,
    "integrated",
    `Parent integrated ${task.taskId} as integrated.`,
  );
}

interface PairedScenarioEvidenceV1 {
  mode: "serial-control" | "scheduled-waves";
  scenarioRoot: "ephemeral-system-temp";
  baseCommitSha: string;
  conditions: TaskKernelWaveComparisonConditionsV1;
  startedAt: string;
  completedAt: string;
  endToEndElapsedMs: number;
  providerConfig: Record<string, unknown>;
  runInputs: {
    taskId: string;
    runId: string;
    input: unknown;
    inputSha256: string;
    writeSetSnapshot: string[];
    authorization: unknown;
  }[];
  prompts: {
    taskId: string;
    runId: string;
    prompt: string;
    promptSha256: string;
    timeoutMs: number;
  }[];
  worktrees: {
    taskId: string;
    branch: string;
    projectRelativePath: string;
    recordedBaseSha: string;
    actualHeadSha: string;
    statusAfterCandidateCreation: string;
    candidateOutputSha256: string;
    candidateOutputText: string;
  }[];
  scheduleReceipt: ReturnType<typeof readJsonEvidence>;
  dispatchResult: { sha256: string; content: unknown };
  taskArtifacts: {
    taskId: string;
    runId: string;
    kernel: ReturnType<typeof readJsonEvidence>;
    admissionReceipt: ReturnType<typeof readJsonEvidence>;
    piLatest: ReturnType<typeof readJsonEvidence>;
    hostStopProof: ReturnType<typeof readJsonEvidence>;
    fakeProviderStartMarker: ReturnType<typeof readTextEvidence>;
  }[];
  parentTaskMap: ReturnType<typeof readTextEvidence>;
  observedLifecycleCosts: TaskKernelWaveScenarioMeasurementV1["lifecycleCosts"];
}

interface PairedScenarioRunV1 {
  measurement: TaskKernelWaveScenarioMeasurementV1;
  evidence: PairedScenarioEvidenceV1;
}

async function runPairedMeasurementScenario(
  serialControl: boolean,
): Promise<PairedScenarioRunV1> {
  const root = makeGitRoot();
  const tasks = MEASURED_TASK_IDS.map((taskId) =>
    makeTask(root, taskId, {
      writeSet: [`src/${taskId}.ts`],
    }),
  );
  const parentDir = makeMeasurementParent(root);
  const worktreePaths = new Map(
    tasks.map((task) => [task.taskId, attachManagedWorktree(root, task)]),
  );
  const baseCommitSha = git(root, "rev-parse", "HEAD");

  const costs = Object.fromEntries(
    tasks.map(({ taskId }) => [
      taskId,
      {
        latencyMs: 10,
        waitingMs: 30,
        executionMs: 120,
        integrationMs: 20,
        reworkMs: 30,
        reviewMs: 25,
      },
    ]),
  );
  const startedAt = new Date().toISOString();
  const endToEndStartedAt = performance.now();
  const schedule = scheduleTaskKernelGraph(
    root,
    tasks.map(({ taskId }) => taskId),
    { estimatedCosts: costs },
  );
  const providerSourceRef = "packages/cli/scripts/fixtures/fake-pi-wave-provider.ts";
  const actualProviderArguments = fakePiScript(root);
  const providerRuntimeRef = path
    .relative(REPOSITORY_ROOT, FAKE_PI_WAVE_PROVIDER)
    .replaceAll("\\", "/");
  const providerConfig = {
    provider: "fake-pi-wave-provider-simulation-only",
    command: path.basename(process.execPath),
    commandResolution: "Node process.execPath",
    runtimeVersion: process.version,
    runnerLabel: "fake-pi-wave-provider-simulation-only",
    timeoutMs: 10_000,
    sourceFixture: providerSourceRef,
    sourceFixtureSha256: sha256(
      fs.readFileSync(path.resolve(REPOSITORY_ROOT, providerSourceRef)),
    ),
    runtimeArtifact: providerRuntimeRef,
    runtimeArtifactSha256: sha256(fs.readFileSync(FAKE_PI_WAVE_PROVIDER)),
    arguments: actualProviderArguments.map((argument) =>
      argument
        .replaceAll(root, "<scenario-root>")
        .replaceAll(root.replaceAll("\\", "/"), "<scenario-root>")
        .replaceAll(REPOSITORY_ROOT, "<repository-root>")
        .replaceAll(
          REPOSITORY_ROOT.replaceAll("\\", "/"),
          "<repository-root>",
        ),
    ),
    providerResponseDelayMs: 30,
    wrapperDelaysMs: { beforeTaskLookup: 40, beforeProviderRpc: 120 },
  };
  const providerConfigSha256 = sha256Json(providerConfig);
  const piRunner = createPiTaskKernelWaveRunnerV1(
    root,
    fakePiLaunch(actualProviderArguments),
  );
  const observedRequests: TaskKernelWaveRunRequestV1[] = [];
  const runner = async (request: TaskKernelWaveRunRequestV1) => {
    observedRequests.push(request);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const task = tasks.find(({ taskId }) => taskId === request.taskId);
    if (!task)
      throw new Error(`Measurement Task is missing: ${request.taskId}`);
    await new Promise((resolve) => setTimeout(resolve, 120));
    return piRunner(request);
  };
  const dispatch = await dispatchTaskKernelWaveV1(
    root,
    schedule.receipt.receiptFingerprint,
    {
      timeoutMs: 10_000,
      runnerLabel: "fake-pi-wave-provider-simulation-only",
      runner,
      ...(serialControl ? { serialControl: true } : {}),
    },
  );
  if (dispatch.status !== "provider-runs-complete")
    throw new Error(
      `Paired simulation did not complete: ${dispatch.status}; ${JSON.stringify(dispatch.tasks)}`,
    );
  for (const task of tasks) await finishMeasuredTask(root, parentDir, task);
  const observed = planParentTaskScheduleV1(root, MEASURED_PARENT_ID);
  const lifecycleCosts = {
    source: "task-kernel-dispatch-and-parent-task-map" as const,
    tasks: tasks.map(({ taskId }) => {
      const lifecycle = observed.lifecycle.find(
        (candidate) => candidate.taskId === taskId,
      );
      if (!lifecycle)
        throw new Error(`Observed lifecycle is missing for ${taskId}`);
      return {
        taskId,
        observedCosts: lifecycle.observedCosts,
        evidenceRefs: lifecycle.observedCostEvidenceRefs,
      };
    }),
  };
  const completedAt = new Date().toISOString();
  const endToEndElapsedMs = Math.round(
    performance.now() - endToEndStartedAt,
  );
  const inputWorktreeRecords = tasks.map((task) => {
    const kernelRef = `.pactile/tasks/${task.taskId}/kernel.json`;
    const kernelPath = path.join(task.taskDir, "kernel.json");
    const kernelRaw = fs.readFileSync(kernelPath, "utf8");
    const kernelRead = readTaskKernel({ root, taskDir: task.taskDir, cwd: root });
    if (kernelRead.kind !== "task-kernel-v2")
      throw new Error(`Task Kernel is missing for ${task.taskId}`);
    const run = kernelRead.kernel.runs.find(({ id }) => id === task.runId);
    if (!run || !run.workspace)
      throw new Error(`Run workspace is missing for ${task.taskId}`);
    const worktreePath = worktreePaths.get(task.taskId);
    if (!worktreePath)
      throw new Error(`Worktree path is missing for ${task.taskId}`);
    const actualHeadSha = git(worktreePath, "rev-parse", "HEAD");
    if (run.workspace.baseSha !== baseCommitSha || actualHeadSha !== baseCommitSha)
      throw new Error(`Task ${task.taskId} did not use the paired base commit`);
    const outputPath = path.join(worktreePath, `src/${task.taskId}.ts`);
    const rawStatus = git(worktreePath, "status", "--short");
    const statusAfterCandidateCreation = rawStatus
      .replaceAll(worktreePath, "<task-worktree>")
      .replaceAll(worktreePath.replaceAll("\\", "/"), "<task-worktree>");
    return {
      runInput: {
        taskId: task.taskId,
        input: run.input,
        writeSetSnapshot: run.writeSetSnapshot,
        authorization: run.authorization,
      },
      runInputEvidence: {
        taskId: task.taskId,
        runId: run.id,
        input: sanitizedEvidenceValue(run.input, root),
        inputSha256: sha256Json(run.input),
        writeSetSnapshot: run.writeSetSnapshot,
        authorization: run.authorization,
      },
      worktreeEvidence: {
        taskId: task.taskId,
        branch: run.workspace.branch,
        projectRelativePath: path
          .relative(root, worktreePath)
          .replaceAll("\\", "/"),
        recordedBaseSha: run.workspace.baseSha,
        actualHeadSha,
      statusAfterCandidateCreation,
      candidateOutputSha256: sha256(fs.readFileSync(outputPath)),
      candidateOutputText: fs.readFileSync(outputPath, "utf8"),
      },
      kernelEvidence: {
        path: kernelRef,
        rawSha256: sha256(kernelRaw),
        contentSha256: sha256Json(
          sanitizedEvidenceValue(JSON.parse(kernelRaw) as unknown, root),
        ),
        content: sanitizedEvidenceValue(
          JSON.parse(kernelRaw) as unknown,
          root,
        ),
      },
    };
  });
  const orderedInputs = inputWorktreeRecords
    .map(({ runInput }) => runInput)
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  const prompts = observedRequests
    .map(({ taskId, runId, prompt, timeoutMs }) => ({
      taskId,
      runId,
      prompt,
      promptSha256: sha256(prompt),
      timeoutMs,
    }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  if (prompts.length !== tasks.length)
    throw new Error("The fake Pi runner did not observe every scheduled prompt");
  const conditions: TaskKernelWaveComparisonConditionsV1 = {
    worktreeBaseCommitSha: baseCommitSha,
    runInputsSha256: sha256Json(
      orderedInputs,
    ),
    promptsSha256: sha256Json(
      prompts.map(({ taskId, prompt, timeoutMs }) => ({
        taskId,
        prompt,
        timeoutMs,
      })),
    ),
    providerConfigSha256,
  };
  const scheduleReceiptRef = `.pactile/.runtime/scheduler/receipts/${schedule.receipt.receiptFingerprint}.json`;
  const taskArtifacts = dispatch.tasks.map((dispatchTask) => {
    const task = tasks.find(({ taskId }) => taskId === dispatchTask.taskId);
    if (!task || !dispatchTask.runId || !dispatchTask.admissionReceiptFingerprint)
      throw new Error(`Dispatch evidence is incomplete for ${dispatchTask.taskId}`);
    if (!dispatchTask.evidenceRef)
      throw new Error(`Host stop evidence is missing for ${dispatchTask.taskId}`);
    const stopProofRef = path
      .relative(root, path.resolve(task.taskDir, dispatchTask.evidenceRef))
      .replaceAll("\\", "/");
    return {
      taskId: task.taskId,
      runId: dispatchTask.runId,
      kernel: readJsonEvidence(root, `.pactile/tasks/${task.taskId}/kernel.json`),
      admissionReceipt: readJsonEvidence(
        root,
        `.pactile/.runtime/scheduler/admissions/${dispatchTask.admissionReceiptFingerprint}.json`,
      ),
      piLatest: readJsonEvidence(
        root,
        `.pactile/tasks/${task.taskId}/pi-bridge/latest.json`,
      ),
      hostStopProof: readJsonEvidence(root, stopProofRef),
      fakeProviderStartMarker: readTextEvidence(
        root,
        `provider-starts/${task.taskId}.started`,
      ),
    };
  });
  const measurement: TaskKernelWaveScenarioMeasurementV1 = {
    dispatch,
    endToEndElapsedMs,
    conditions,
    lifecycleCosts,
  };
  return {
    measurement,
    evidence: {
      mode: serialControl ? "serial-control" : "scheduled-waves",
      scenarioRoot: "ephemeral-system-temp",
      baseCommitSha,
      conditions,
      startedAt,
      completedAt,
      endToEndElapsedMs,
      providerConfig,
      runInputs: inputWorktreeRecords.map(
        ({ runInputEvidence }) => runInputEvidence,
      ),
      prompts,
      worktrees: inputWorktreeRecords.map(
        ({ worktreeEvidence }) => worktreeEvidence,
      ),
      scheduleReceipt: readJsonEvidence(root, scheduleReceiptRef),
      dispatchResult: {
        sourceObjectSha256: sha256Json(dispatch),
        content: sanitizedEvidenceValue(dispatch, root),
        contentSha256: sha256Json(sanitizedEvidenceValue(dispatch, root)),
      },
      taskArtifacts,
      parentTaskMap: readTextEvidence(
        root,
        `.pactile/tasks/${MEASURED_PARENT_ID}/task-map.md`,
      ),
      observedLifecycleCosts: lifecycleCosts,
    },
  };
}

describe("Task Kernel V2 writer-wave dispatch", () => {
  it("dispatches a normalized directory write set through the wave provider gate", async () => {
    const root = makeGitRoot();
    const task = makeTask(root, "wave-directory-write-set", {
      writeSet: ["src/"],
    });
    attachManagedWorktree(root, task);
    const schedule = scheduleTaskKernelGraph(root, [task.taskId]);
    const script = fakePiScript(root);

    const result = await dispatchTaskKernelWaveV1(
      root,
      schedule.receipt.receiptFingerprint,
      {
        timeoutMs: 10_000,
        runnerLabel: "fake-pi-rpc-provider-test-only",
        runner: createPiTaskKernelWaveRunnerV1(root, fakePiLaunch(script)),
      },
    );

    expect(result.status).toBe("provider-runs-complete");
    expect(result.tasks).toContainEqual(
      expect.objectContaining({
        taskId: task.taskId,
        status: "provider-runs-settled",
      }),
    );
  }, 30_000);

  it("runs two independent isolated Tasks concurrently against the same persisted receipt using a fake Pi provider", async () => {
    const root = makeGitRoot();
    const first = makeTask(root, "wave-independent-a", {
      writeSet: ["src/a.ts"],
    });
    const second = makeTask(root, "wave-independent-b", {
      writeSet: ["src/b.ts"],
    });
    attachManagedWorktree(root, first);
    attachManagedWorktree(root, second);
    const schedule = scheduleTaskKernelGraph(
      root,
      [first.taskId, second.taskId],
      { estimatedCosts: estimatedCosts([first.taskId, second.taskId]) },
    );
    expect(schedule.receipt.plan.waves[0]?.decision).toBe(
      "parallel-time-saved",
    );
    expect(schedule.receipt.plan.waves[0]?.taskIds).toHaveLength(2);
    const script = fakePiScript(root, { barrierSize: 2 });

    const result = await dispatchTaskKernelWaveV1(
      root,
      schedule.receipt.receiptFingerprint,
      {
        timeoutMs: 10_000,
        runnerLabel: "fake-pi-rpc-provider-test-only",
        runner: createPiTaskKernelWaveRunnerV1(root, fakePiLaunch(script)),
      },
    );

    expect(result).toMatchObject({
      status: "provider-runs-complete",
      scheduleReceiptFingerprint: schedule.receipt.receiptFingerprint,
      kernelRunSettlement: "not-performed",
      integrationPlan: {
        waves: [
          {
            decision: "parallel-time-saved",
            integration: { mode: "parallel-review" },
            costEstimate: {
              source: "schedule-receipt-estimates",
              candidateEstimatedSavingsMs: expect.any(Number),
            },
          },
        ],
      },
      measurements: {
        source: "dispatch-wall-clock",
        mode: "scheduled-waves",
        elapsedMs: expect.any(Number),
        waves: [{ elapsedMs: expect.any(Number) }],
      },
    });
    expect(result.tasks).toHaveLength(2);
    expect(
      result.tasks.every((task) => task.status === "provider-runs-settled"),
    ).toBe(true);
    expect(result.tasks.every((task) => task.admissionReceiptFingerprint)).toBe(
      true,
    );
    expect(result.tasks.every((task) => Number.isFinite(task.elapsedMs))).toBe(
      true,
    );
    expect(
      result.tasks.every((task) => task.hostStopVerified && task.leaseReleased),
    ).toBe(true);
    expect(
      result.integrationPlan.tasks.find(({ taskId }) => taskId === first.taskId)
        ?.costs,
    ).toMatchObject({
      estimateBasis: { executionMs: "caller-estimate" },
      observed: { executionMs: null },
    });
    expect(
      result.integrationPlan.tasks[0]?.costs?.observedEvidenceRefs.length,
    ).toBeGreaterThan(0);
    const latestRecords = [first, second].map(
      ({ taskDir }) =>
        JSON.parse(
          fs.readFileSync(
            path.join(taskDir, "pi-bridge", "latest.json"),
            "utf8",
          ),
        ) as {
          schedule_receipt_fingerprint?: string;
          dispatch_lease_released?: boolean;
          process_stop_receipt?: {
            processExit?: { terminationVerified?: boolean };
          };
        },
    );
    expect(
      latestRecords.every(
        (record) =>
          record.schedule_receipt_fingerprint ===
            schedule.receipt.receiptFingerprint &&
          record.dispatch_lease_released === true &&
          record.process_stop_receipt?.processExit?.terminationVerified ===
            true,
      ),
    ).toBe(true);
    expect(
      fs
        .readdirSync(path.join(root, "provider-starts"))
        .filter((name) => name.endsWith(".started")),
    ).toHaveLength(2);
    for (const task of [first, second]) {
      const read = readTaskKernel({ root, taskDir: task.taskDir, cwd: root });
      if (read.kind !== "task-kernel-v2")
        throw new Error("Expected Task Kernel V2");
      expect(read.kernel.runs.at(-1)?.candidateSnapshot).toBeNull();
      expect(read.kernel.runs.at(-1)?.result).toBeNull();
    }
  }, 30_000);

  it("compares measured serial control with same-workload V2 waves and observed lifecycle costs", async () => {
    const serialControl = await runPairedMeasurementScenario(true);
    const scheduledWaves = await runPairedMeasurementScenario(false);

    const comparison = compareTaskKernelWaveDispatchV1(
      serialControl.measurement,
      scheduledWaves.measurement,
    );

    expect(comparison).toMatchObject({
      schemaVersion: 1,
      source: "paired-controlled-dispatch-wall-clock",
      taskIds: [...MEASURED_TASK_IDS].sort(),
      estimates: {
        taskCostTotals: {
          latencyMs: 20,
          waitingMs: 60,
          executionMs: 240,
          integrationMs: 40,
          reworkMs: 60,
          reviewMs: 50,
        },
      },
      observedLifecycleCosts: {
        source: "task-kernel-dispatch-and-parent-task-map",
      },
    });
    expect(comparison.measured.serialControlDispatchMs).toBeGreaterThan(
      0,
    );
    expect(Number.isFinite(comparison.measured.dispatchSavingsMs)).toBe(true);
    expect(Number.isFinite(comparison.measured.endToEndSavingsMs)).toBe(true);
    expect(Number.isFinite(comparison.measured.endToEndSavingsRatio)).toBe(
      true,
    );
    for (const field of [
      "waitingMs",
      "executionMs",
      "integrationMs",
      "reworkMs",
      "reviewMs",
    ] as const) {
      for (const scenario of [
        comparison.observedLifecycleCosts.serialControl,
        comparison.observedLifecycleCosts.scheduledWaves,
      ]) {
        expect(scenario[field].totalMs).not.toBeNull();
        expect(scenario[field].totalMs).toBeGreaterThan(0);
        expect(scenario[field].observedTaskCount).toBe(2);
        expect(scenario[field].evidenceRefs.length).toBeGreaterThan(0);
      }
    }
    expect(comparison.conditions.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(comparison.conditions).toMatchObject(
      serialControl.evidence.conditions,
    );
    expect(() =>
      compareTaskKernelWaveDispatchV1(
        serialControl.measurement,
        {
          ...scheduledWaves.measurement,
          conditions: {
            ...scheduledWaves.measurement.conditions,
            providerConfigSha256: "f".repeat(64),
          },
        },
      ),
    ).toThrow(/Paired scenarios differ in worktree base, Run inputs, prompts, or provider configuration/u);

    if (process.env[RECORD_P37_MEASUREMENT] === "1")
      writePairedMeasurementReport(
        serialControl.evidence,
        scheduledWaves.evidence,
        comparison,
      );
  }, 120_000);

  it("rechecks the complete receipt before any provider starts when a Task revision goes stale", async () => {
    const root = makeGitRoot();
    const task = makeTask(root, "wave-stale-receipt");
    attachManagedWorktree(root, task);
    const schedule = scheduleTaskKernelGraph(root, [task.taskId]);
    const read = readTaskKernel({ root, taskDir: task.taskDir, cwd: root });
    if (read.kind !== "task-kernel-v2")
      throw new Error("Expected Task Kernel V2");
    resumeTaskRun({
      root,
      taskDir: task.taskDir,
      expectedRevision: read.kernel.revision,
      runId: task.runId as string,
      actor: "test-worker",
      idempotencyKey: "resume-after-schedule",
    });
    const runner = vi.fn(async (request: TaskKernelWaveRunRequestV1) =>
      testProviderResult(request),
    );

    await expect(
      dispatchTaskKernelWaveV1(root, schedule.receipt.receiptFingerprint, {
        timeoutMs: 5_000,
        runnerLabel: "fake-pi-provider-test-only",
        runner,
      }),
    ).rejects.toThrow(/schedule receipt is stale/u);
    expect(runner).not.toHaveBeenCalled();
  });

  it("blocks a candidate with an unresolved hard dependency before invoking the provider", async () => {
    const root = makeGitRoot();
    makeTask(root, "wave-open-prerequisite", { start: false });
    const dependent = makeTask(root, "wave-hard-dependent", {
      dependencies: ["wave-open-prerequisite"],
      writeSet: ["src/dependent.ts"],
      start: false,
    });
    const schedule = scheduleTaskKernelGraph(root, [dependent.taskId]);
    const runner = vi.fn(async (request: TaskKernelWaveRunRequestV1) =>
      testProviderResult(request),
    );

    const result = await dispatchTaskKernelWaveV1(
      root,
      schedule.receipt.receiptFingerprint,
      { timeoutMs: 5_000, runnerLabel: "fake-pi-provider-test-only", runner },
    );

    expect(
      schedule.receipt.plan.decisions.find(
        ({ taskId }) => taskId === dependent.taskId,
      )?.action,
    ).toBe("blocked");
    expect(result.status).toBe("blocked");
    expect(result.tasks).toContainEqual(
      expect.objectContaining({
        taskId: dependent.taskId,
        status: "blocked",
      }),
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it("dispatches after resolving a successfully closed dependency from the Task archive", async () => {
    const root = makeGitRoot();
    const prerequisite = closePrerequisite(root, "wave-archived-prerequisite");
    archiveTask(root, prerequisite);
    const dependent = makeTask(root, "wave-archived-dependent", {
      dependencies: [prerequisite.taskId],
      writeSet: ["src/dependent.ts"],
    });
    attachManagedWorktree(root, dependent);
    const schedule = scheduleTaskKernelGraph(root, [dependent.taskId]);
    const runner = vi.fn(
      createPiTaskKernelWaveRunnerV1(root, fakePiLaunch(fakePiScript(root))),
    );

    const result = await dispatchTaskKernelWaveV1(
      root,
      schedule.receipt.receiptFingerprint,
      { timeoutMs: 10_000, runnerLabel: "fake-pi-rpc-provider-test-only", runner },
    );

    expect(schedule.receipt.plan.decisions).toContainEqual(
      expect.objectContaining({ taskId: dependent.taskId, action: "scheduled" }),
    );
    expect(result.status).toBe("provider-runs-complete");
    expect(result.tasks).toContainEqual(
      expect.objectContaining({ taskId: dependent.taskId, status: "provider-runs-settled" }),
    );
    expect(runner).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("rejects an archived dependency that is not closed successfully before dispatch", () => {
    const root = makeGitRoot();
    const prerequisite = makeTask(root, "wave-archived-open-prerequisite", {
      start: false,
    });
    const dependent = makeTask(root, "wave-archived-open-dependent", {
      dependencies: [prerequisite.taskId],
      start: false,
    });
    archiveTask(root, prerequisite);

    expect(() => scheduleTaskKernelGraph(root, [dependent.taskId])).toThrow(
      /Archived hard Task dependency is not closed with completed outcome/u,
    );
  });

  it("keeps predicted overlapping write sets in separate serial waves by default", async () => {
    const root = makeGitRoot();
    const first = makeTask(root, "wave-overlap-a", {
      writeSet: ["src/shared"],
    });
    const second = makeTask(root, "wave-overlap-b", {
      writeSet: ["src/shared/file.ts"],
    });
    attachManagedWorktree(root, first);
    attachManagedWorktree(root, second);
    const schedule = scheduleTaskKernelGraph(
      root,
      [first.taskId, second.taskId],
      { estimatedCosts: estimatedCosts([first.taskId, second.taskId]) },
    );
    expect(schedule.receipt.plan.waves).toHaveLength(2);
    const activeCounts: number[] = [];
    let active = 0;
    const piRunner = createPiTaskKernelWaveRunnerV1(
      root,
      fakePiLaunch(fakePiScript(root)),
    );
    const runner = vi.fn(async (request: TaskKernelWaveRunRequestV1) => {
      active += 1;
      activeCounts.push(active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return await piRunner(request);
      } finally {
        active -= 1;
      }
    });

    const result = await dispatchTaskKernelWaveV1(
      root,
      schedule.receipt.receiptFingerprint,
      { timeoutMs: 5_000, runnerLabel: "fake-pi-provider-test-only", runner },
    );

    expect(result.status).toBe("provider-runs-complete");
    expect(result.integrationPlan.waves.map(({ taskIds }) => taskIds)).toEqual([
      [first.taskId],
      [second.taskId],
    ]);
    expect(Math.max(...activeCounts)).toBe(1);
    expect(
      runner.mock.calls.map(([request]) => request.scheduleReceiptFingerprint),
    ).toEqual([
      schedule.receipt.receiptFingerprint,
      schedule.receipt.receiptFingerprint,
    ]);
  });

  it("records the authorization and ordered integration plan when overlapping writers are explicitly parallelized", async () => {
    const root = makeGitRoot();
    const first = makeTask(root, "wave-authorized-overlap-a", {
      writeSet: ["src/shared"],
    });
    const second = makeTask(root, "wave-authorized-overlap-b", {
      writeSet: ["src/shared/file.ts"],
    });
    attachManagedWorktree(root, first);
    attachManagedWorktree(root, second);
    const integrationPlan =
      "Review both isolated results, integrate A before B, then verify the shared module.";
    const schedule = scheduleTaskKernelGraph(
      root,
      [first.taskId, second.taskId],
      {
        estimatedCosts: estimatedCosts([first.taskId, second.taskId]),
        conflictParallelizations: [
          {
            taskIds: [first.taskId, second.taskId],
            approvedBy: "test-approver",
            authorizationRef: "approval:authorized-overlap",
            integrationOwner: "parent-integrator",
            integrationPlan,
          },
        ],
      },
    );
    expect(schedule.receipt.plan.waves[0]?.decision).toBe(
      "parallel-time-saved",
    );
    let active = 0;
    let peak = 0;
    const piRunner = createPiTaskKernelWaveRunnerV1(
      root,
      fakePiLaunch(fakePiScript(root)),
    );
    const runner = vi.fn(async (request: TaskKernelWaveRunRequestV1) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return await piRunner(request);
      } finally {
        active -= 1;
      }
    });

    const result = await dispatchTaskKernelWaveV1(
      root,
      schedule.receipt.receiptFingerprint,
      { timeoutMs: 5_000, runnerLabel: "fake-pi-provider-test-only", runner },
    );

    expect(result.status).toBe("provider-runs-complete");
    expect(peak).toBe(2);
    expect(result.integrationPlan.waves[0]?.integration.mode).toBe(
      "parallel-review",
    );
    expect(result.integrationPlan.waves[0]?.conflictAuthorizations).toEqual([
      expect.objectContaining({
        approvedBy: "test-approver",
        authorizationRef: "approval:authorized-overlap",
        integrationOwner: "parent-integrator",
        integrationPlan,
      }),
    ]);
  });

  it("reports a partial fake-Pi result while requiring a verified Host stop and lease release for each run", async () => {
    const root = makeGitRoot();
    const completed = makeTask(root, "wave-partial-a", {
      writeSet: ["src/a.ts"],
    });
    const needsReview = makeTask(root, "wave-partial-b", {
      writeSet: ["src/b.ts"],
    });
    attachManagedWorktree(root, completed);
    attachManagedWorktree(root, needsReview);
    const schedule = scheduleTaskKernelGraph(
      root,
      [completed.taskId, needsReview.taskId],
      {
        estimatedCosts: estimatedCosts([completed.taskId, needsReview.taskId]),
      },
    );
    const script = fakePiScript(root, { failTaskIds: [needsReview.taskId] });

    const result = await dispatchTaskKernelWaveV1(
      root,
      schedule.receipt.receiptFingerprint,
      {
        timeoutMs: 10_000,
        runnerLabel: "fake-pi-rpc-provider-test-only",
        runner: createPiTaskKernelWaveRunnerV1(root, fakePiLaunch(script)),
      },
    );

    expect(result.status).toBe("partial");
    expect(result.kernelRunSettlement).toBe("not-performed");
    expect(
      result.tasks.find(({ taskId }) => taskId === completed.taskId),
    ).toMatchObject({
      status: "provider-runs-settled",
      hostStopVerified: true,
      leaseReleased: true,
    });
    expect(
      result.tasks.find(({ taskId }) => taskId === needsReview.taskId),
    ).toMatchObject({
      status: "provider-run-failed",
      outcome: "needs_review",
      hostStopVerified: true,
      leaseReleased: true,
    });
  }, 30_000);

  it("marks later conflicting work blocked when the real fake-Pi child stop is unverified", async () => {
    const root = makeGitRoot();
    const first = makeTask(root, "wave-unverified-stop-a", {
      writeSet: ["src/shared"],
    });
    const second = makeTask(root, "wave-unverified-stop-b", {
      writeSet: ["src/shared"],
    });
    attachManagedWorktree(root, first);
    attachManagedWorktree(root, second);
    const schedule = scheduleTaskKernelGraph(root, [
      first.taskId,
      second.taskId,
    ]);
    const script = fakePiScript(root);
    vi.spyOn(PiRpcClient.prototype, "closeAndObserve").mockResolvedValueOnce({
      processId: 42424,
      stopRequestedAt: new Date().toISOString(),
      killRequestedAt: null,
      exitObservedAt: null,
      exitCode: null,
      signalCode: null,
      terminationVerified: false,
    });
    const runner = vi.fn(
      createPiTaskKernelWaveRunnerV1(root, fakePiLaunch(script)),
    );

    const result = await dispatchTaskKernelWaveV1(
      root,
      schedule.receipt.receiptFingerprint,
      {
        timeoutMs: 10_000,
        runnerLabel: "fake-pi-rpc-provider-test-only",
        runner,
      },
    );

    expect(runner).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("partial");
    expect(result.tasks).toContainEqual(
      expect.objectContaining({
        taskId: first.taskId,
        status: "host-stop-unverified",
        hostStopVerified: false,
        leaseReleased: false,
      }),
    );
    expect(result.tasks).toContainEqual(
      expect.objectContaining({
        taskId: second.taskId,
        status: "blocked",
        reasonCode: "prior-wave-did-not-prove-writer-stop",
      }),
    );
  }, 30_000);

  it("rejects a runner's forged settled booleans without persisted admission, Host stop, and lease evidence", async () => {
    const root = makeGitRoot();
    const task = makeTask(root, "wave-untrusted-runner");
    attachManagedWorktree(root, task);
    const schedule = scheduleTaskKernelGraph(root, [task.taskId]);
    const runner = vi.fn(async (request: TaskKernelWaveRunRequestV1) => ({
      outcome: "settled" as const,
      scheduleReceiptFingerprint: request.scheduleReceiptFingerprint,
      admissionReceiptFingerprint: "a".repeat(64),
      hostStopVerified: true,
      leaseReleased: true,
      evidenceRef: null,
      reason: null,
    }));

    const result = await dispatchTaskKernelWaveV1(
      root,
      schedule.receipt.receiptFingerprint,
      { timeoutMs: 5_000, runnerLabel: "untrusted-runner-test-only", runner },
    );

    expect(result.status).toBe("partial");
    expect(result.tasks).toContainEqual(
      expect.objectContaining({
        taskId: task.taskId,
        status: "host-stop-unverified",
        outcome: "failed",
        admissionReceiptFingerprint: null,
        hostStopVerified: false,
        leaseReleased: false,
        evidenceRef: null,
      }),
    );
    expect(runner).toHaveBeenCalledTimes(1);
    const read = readTaskKernel({ root, taskDir: task.taskDir, cwd: root });
    if (read.kind !== "task-kernel-v2")
      throw new Error("Expected Task Kernel V2");
    expect(read.kernel.runs.at(-1)?.host).toBeNull();
  });

  it("cancels fake-Pi dispatch only after observing and recording the child process exit", async () => {
    const root = makeGitRoot();
    const first = makeTask(root, "wave-cancel-a", { writeSet: ["src/shared"] });
    const second = makeTask(root, "wave-cancel-b", {
      writeSet: ["src/shared"],
    });
    attachManagedWorktree(root, first);
    attachManagedWorktree(root, second);
    const schedule = scheduleTaskKernelGraph(root, [
      first.taskId,
      second.taskId,
    ]);
    const startedDirectory = path.join(root, "cancel-provider-starts");
    const script = fakePiScript(root, {
      hangTaskIds: [first.taskId],
      startedDirectory,
    });
    const controller = new AbortController();
    const dispatch = dispatchTaskKernelWaveV1(
      root,
      schedule.receipt.receiptFingerprint,
      {
        timeoutMs: 10_000,
        runnerLabel: "fake-pi-rpc-provider-test-only",
        runner: createPiTaskKernelWaveRunnerV1(root, fakePiLaunch(script)),
        signal: controller.signal,
      },
    );
    const marker = path.join(startedDirectory, `${first.taskId}.started`);
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(marker) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fs.existsSync(marker)).toBe(true);
    controller.abort();

    const result = await dispatch;

    expect(result.status).toBe("cancelled");
    expect(result.kernelRunSettlement).toBe("not-performed");
    expect(result.tasks).toContainEqual(
      expect.objectContaining({
        taskId: first.taskId,
        status: "cancelled",
        hostStopVerified: true,
        leaseReleased: true,
      }),
    );
    expect(result.tasks).toContainEqual(
      expect.objectContaining({
        taskId: second.taskId,
        status: "cancelled",
        reasonCode: "dispatch-cancelled-before-wave",
      }),
    );
    const latest = JSON.parse(
      fs.readFileSync(
        path.join(first.taskDir, "pi-bridge", "latest.json"),
        "utf8",
      ),
    ) as {
      outcome?: string;
      process_stop_receipt?: {
        terminal?: string;
        processExit?: { terminationVerified?: boolean };
      };
      dispatch_lease_released?: boolean;
    };
    expect(latest).toMatchObject({
      outcome: "cancelled",
      process_stop_receipt: {
        terminal: "cancelled",
        processExit: { terminationVerified: true },
      },
      dispatch_lease_released: true,
    });
  }, 30_000);

  it("blocks dispatch when no P38 manager-owned Git worktree exists", async () => {
    const root = makeGitRoot();
    const task = makeTask(root, "wave-no-worktree");
    const schedule = scheduleTaskKernelGraph(root, [task.taskId]);
    const runner = vi.fn(async (request: TaskKernelWaveRunRequestV1) =>
      testProviderResult(request),
    );

    const result = await dispatchTaskKernelWaveV1(
      root,
      schedule.receipt.receiptFingerprint,
      { timeoutMs: 5_000, runnerLabel: "fake-pi-provider-test-only", runner },
    );

    expect(result.status).toBe("blocked");
    expect(result.tasks).toContainEqual(
      expect.objectContaining({
        taskId: task.taskId,
        status: "blocked",
        reasonCode: "p38-managed-run-worktree-required",
      }),
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it("keeps P36 needs-definition legacy V1 records outside V2 writer dispatch", async () => {
    const root = makeGitRoot();
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await init({ yes: true, user: "p37-wave-fixture", skipReadiness: true });
    const legacyTaskId = "p37-wave-legacy-needs-definition";
    const legacyTaskDir = addLegacyV1NeedsDefinitionTask(root, legacyTaskId);
    expect(
      readTaskKernel({ root, taskDir: legacyTaskDir, cwd: root }).kind,
    ).toBe("legacy-task-kernel-v1");
    const updated = await applyLegacyTaskUpdate(root);
    expect(updated.status).toBe("completed");
    expect(updated.import.needsDefinition).toBe(1);

    expect(() => scheduleTaskKernelGraph(root, [legacyTaskId])).toThrow(
      /needs-definition.*missing definition fields/u,
    );
  }, 120_000);
});
