import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readTaskKernel } from "../core/task/index.js";
import {
  GIT_CANDIDATE_OBSERVER_VERSION,
  observeTaskRunCandidate,
  taskCandidateObservationEntryRef,
  verifyGitCandidateObservation,
} from "../core/task/task-candidate-observer.js";
import {
  PROJECT_FILE_CANDIDATE_OBSERVER_VERSION,
  verifyProjectFileCandidateObservation,
} from "../core/task/project-file-observer.js";
import {
  BEHAVIOR_CHECK_MODES,
  VERIFICATION_RISKS,
  VERIFICATION_SCOPES,
  adviseVerificationPlanWithJevV1,
  finalizeJevVerificationAdviceV1,
  verifyJevVerificationAdviceReceiptV1,
  type CreateVerificationPlanInput,
  type JevEgressAuthorizationV1,
  type VerificationImpact,
  type VerificationPlan,
} from "../pactile/index.js";
import { createJevDecisionFacadeV1 } from "../pactile/jev/index.js";
import { JEV_ORIGIN_V1 } from "../pactile/jev/contracts.js";
import { resolveJevProjectEgressPolicyV1 } from "../pactile/jev/project-policy.js";

const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_CHECKS = 64;
const MAX_SURFACES = 16;
const MAX_LIST_ITEMS = 32;
const MAX_METADATA_CHARS = 160;
const JEV_DEADLINE_MS = 2_500;
const RECEIPT_DIRECTORY = [
  ".pactile",
  ".runtime",
  "task-verification",
  "plans",
] as const;

const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/u,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
  /\bBearer\s+[A-Za-z0-9._~-]{12,}/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\b(?:xox[baprs]|AKIA)[A-Za-z0-9_-]{16,}\b/u,
];

interface TaskPlanBinding {
  readonly taskId: string;
  readonly runId: string;
  readonly candidateSnapshotId: string;
  readonly candidateFingerprint: string;
  readonly observationSource:
    | typeof GIT_CANDIDATE_OBSERVER_VERSION
    | typeof PROJECT_FILE_CANDIDATE_OBSERVER_VERSION;
  readonly observationFingerprint: string;
}

interface CapturedBinding {
  readonly taskDir: string;
  readonly binding: TaskPlanBinding;
}

interface PlanReceiptBody {
  readonly schemaVersion: 1;
  readonly source: "pactile-task-verification-planning-receipt-v1";
  readonly status: "planned-only";
  readonly recordedAt: string;
  readonly binding: TaskPlanBinding;
  readonly jevEgressPolicy: ReturnType<typeof resolveJevProjectEgressPolicyV1>;
  readonly input: {
    readonly authority: "caller-supplied-non-authoritative-inventory";
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly completeRepositoryCiInventory: false;
  };
  readonly deterministicPlan: VerificationPlan;
  readonly jevAdvice: ReturnType<typeof finalizeJevVerificationAdviceV1>;
  readonly decision: {
    readonly choice: "adopt" | "override";
    readonly adoptedOptionalCheckIds: readonly string[];
    readonly overriddenOptionalCheckIds: readonly string[];
  };
  readonly execution: "not-run";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === [...expected].sort()[index])
  );
}

function safeMetadata(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_METADATA_CHARS ||
    value !== value.trim() ||
    value.split("").some((character) => {
      const code = character.charCodeAt(0);
      return (
        code < 0x20 || code === 0x7f || character === "/" || character === "\\"
      );
    }) ||
    /(?:https?:|ftp:|file:|mailto:|www\.)/iu.test(value) ||
    /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/u.test(value) ||
    SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))
  ) {
    throw new Error(
      `${field} must be short plain metadata without paths, links, email addresses, control characters, or secret-like values`,
    );
  }
  return value;
}

function stringList(value: unknown, field: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(
      `${field} must be an array with at most ${maximum} entries`,
    );
  }
  return value.map((entry, index) => safeMetadata(entry, `${field}[${index}]`));
}

function parseManifest(value: unknown): CreateVerificationPlanInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["impact", "checks"]) ||
    !isRecord(value.impact) ||
    !hasExactKeys(value.impact, ["changedSurfaces", "risks", "scope"]) ||
    !Array.isArray(value.checks) ||
    value.checks.length > MAX_CHECKS
  ) {
    throw new Error(
      "manifest must contain only impact and a bounded checks array",
    );
  }

  const rawImpact = value.impact;
  if (
    typeof rawImpact.scope !== "string" ||
    !VERIFICATION_SCOPES.includes(
      rawImpact.scope as VerificationImpact["scope"],
    )
  ) {
    throw new Error("impact.scope is not supported");
  }
  const changedSurfaces = stringList(
    rawImpact.changedSurfaces,
    "impact.changedSurfaces",
    MAX_SURFACES,
  );
  const rawRisks = rawImpact.risks;
  if (
    !Array.isArray(rawRisks) ||
    rawRisks.length > VERIFICATION_RISKS.length ||
    rawRisks.some(
      (risk) =>
        typeof risk !== "string" ||
        !VERIFICATION_RISKS.includes(
          risk as (typeof VERIFICATION_RISKS)[number],
        ),
    )
  ) {
    throw new Error("impact.risks contains an unsupported value");
  }
  const impact: VerificationImpact = {
    changedSurfaces,
    risks: rawRisks as VerificationImpact["risks"],
    scope: rawImpact.scope as VerificationImpact["scope"],
  };

  const checks = value.checks.map((rawCheck, index) => {
    const field = `checks[${index}]`;
    if (!isRecord(rawCheck)) throw new Error(`${field} must be an object`);
    const id = safeMetadata(rawCheck.id, `${field}.id`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u.test(id)) {
      throw new Error(`${field}.id must be a stable identifier`);
    }
    const title = safeMetadata(rawCheck.title, `${field}.title`);
    if (rawCheck.kind === "behavior") {
      if (
        !hasExactKeys(rawCheck, [
          "kind",
          "id",
          "title",
          "mode",
          "evidence",
          "coversRisks",
          "coversSurfaces",
        ]) ||
        typeof rawCheck.mode !== "string" ||
        !BEHAVIOR_CHECK_MODES.includes(
          rawCheck.mode as (typeof BEHAVIOR_CHECK_MODES)[number],
        ) ||
        (rawCheck.evidence !== "independent-public-behavior" &&
          rawCheck.evidence !== "implementation-mirror")
      ) {
        throw new Error(`${field} has an unsupported behavior check shape`);
      }
      const coversRisks = rawCheck.coversRisks;
      if (
        !Array.isArray(coversRisks) ||
        coversRisks.length > VERIFICATION_RISKS.length ||
        coversRisks.some(
          (risk) =>
            typeof risk !== "string" ||
            !VERIFICATION_RISKS.includes(
              risk as (typeof VERIFICATION_RISKS)[number],
            ),
        )
      ) {
        throw new Error(`${field}.coversRisks contains an unsupported value`);
      }
      return {
        kind: "behavior" as const,
        id,
        title,
        mode: rawCheck.mode as (typeof BEHAVIOR_CHECK_MODES)[number],
        evidence: rawCheck.evidence as
          | "independent-public-behavior"
          | "implementation-mirror",
        coversRisks: coversRisks as (typeof VERIFICATION_RISKS)[number][],
        coversSurfaces: stringList(
          rawCheck.coversSurfaces,
          `${field}.coversSurfaces`,
          MAX_SURFACES,
        ),
      };
    }
    if (
      rawCheck.kind === "policy-ci" &&
      hasExactKeys(rawCheck, ["kind", "id", "title", "requiredBy"])
    ) {
      return {
        kind: "policy-ci" as const,
        id,
        title,
        requiredBy: stringList(
          rawCheck.requiredBy,
          `${field}.requiredBy`,
          MAX_LIST_ITEMS,
        ),
      };
    }
    throw new Error(`${field}.kind is not supported`);
  });
  return { impact, checks };
}

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function readManifest(
  root: string,
  relativePath: string,
): {
  readonly input: CreateVerificationPlanInput;
  readonly sha256: string;
  readonly sizeBytes: number;
} {
  if (
    path.isAbsolute(relativePath) ||
    relativePath.includes("\0") ||
    relativePath.includes(":")
  ) {
    throw new Error("--manifest must be a project-relative path");
  }
  const segments = relativePath.replaceAll("\\", "/").split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        [".git", "node_modules", ".runtime"].includes(segment.toLowerCase()) ||
        segment.toLowerCase().startsWith(".env") ||
        /\.(?:pem|key|p12|pfx)$/iu.test(segment),
    )
  ) {
    throw new Error("--manifest path contains a restricted or unsafe segment");
  }
  let current = root;
  let fileStat: fs.Stats | undefined;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    fileStat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!fileStat || fileStat.isSymbolicLink()) {
      throw new Error(
        "--manifest must resolve through existing non-symlink paths",
      );
    }
    if (index < segments.length - 1 && !fileStat.isDirectory()) {
      throw new Error("--manifest parent path must be a directory");
    }
  }
  if (!fileStat?.isFile() || fileStat.size > MAX_MANIFEST_BYTES) {
    throw new Error(
      `--manifest must be a regular file no larger than ${MAX_MANIFEST_BYTES} bytes`,
    );
  }
  const resolvedFile = fs.realpathSync(current);
  if (!inside(root, resolvedFile))
    throw new Error("--manifest resolves outside the project");
  const before = fs.statSync(resolvedFile);
  const bytes = fs.readFileSync(resolvedFile);
  const after = fs.statSync(resolvedFile);
  if (
    bytes.length > MAX_MANIFEST_BYTES ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ino !== after.ino
  ) {
    throw new Error(
      "--manifest changed while it was being read or exceeded its size limit",
    );
  }
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("--manifest must be valid UTF-8 JSON");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new Error("--manifest must contain valid JSON");
  }
  return {
    input: parseManifest(parsed),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
  };
}

function captureBinding(root: string, taskReference: string): CapturedBinding {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(taskReference)) {
    throw new Error("Task must be a project-local task ID");
  }
  const pactileDir = path.join(root, ".pactile");
  const tasksDir = path.join(pactileDir, "tasks");
  const taskDir = path.join(tasksDir, taskReference);
  for (const directory of [pactileDir, tasksDir, taskDir]) {
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        "Task path must stay in the project's non-symlink .pactile/tasks directory",
      );
    }
  }
  const realRoot = fs.realpathSync(root);
  const realTasks = fs.realpathSync(tasksDir);
  const realTaskDir = fs.realpathSync(taskDir);
  if (!inside(realRoot, realTasks) || !inside(realTasks, realTaskDir)) {
    throw new Error("Task path resolves outside the project");
  }
  const read = readTaskKernel({
    root: realRoot,
    taskDir: realTaskDir,
    cwd: realRoot,
  });
  if (read.kind !== "task-kernel-v2") {
    throw new Error("Verification planning requires a Task Kernel v2 Task");
  }
  const run = read.kernel.runs.at(-1);
  if (run?.state !== "completed" || !run?.candidateSnapshot) {
    throw new Error(
      "The latest Task Run must be completed and have a frozen candidate snapshot",
    );
  }
  const observation = observeTaskRunCandidate({
    run,
    ...(run.workspace === null ? { repositoryRoot: realRoot } : {}),
  });
  const intact =
    observation.source === GIT_CANDIDATE_OBSERVER_VERSION
      ? verifyGitCandidateObservation(observation)
      : verifyProjectFileCandidateObservation(observation);
  if (!intact || observation.scopeStatus !== "within-write-set") {
    throw new Error(
      "Current Run candidate is invalid or outside its frozen write set",
    );
  }
  const expectedRef = taskCandidateObservationEntryRef(observation);
  const matchingEntries = run.candidateSnapshot.entries.filter(
    (entry) => entry.ref === expectedRef,
  );
  if (
    matchingEntries.length !== 1 ||
    matchingEntries[0]?.fingerprint !== observation.fingerprint
  ) {
    throw new Error(
      "Current candidate no longer matches the latest Run snapshot",
    );
  }
  return {
    taskDir: realTaskDir,
    binding: {
      taskId: read.kernel.identity.taskId,
      runId: run.id,
      candidateSnapshotId: run.candidateSnapshot.id,
      candidateFingerprint: run.candidateSnapshot.fingerprint,
      observationSource: observation.source,
      observationFingerprint: observation.fingerprint,
    },
  };
}

function sameBinding(left: TaskPlanBinding, right: TaskPlanBinding): boolean {
  return (
    left.taskId === right.taskId &&
    left.runId === right.runId &&
    left.candidateSnapshotId === right.candidateSnapshotId &&
    left.candidateFingerprint === right.candidateFingerprint &&
    left.observationSource === right.observationSource &&
    left.observationFingerprint === right.observationFingerprint
  );
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
      throw new TypeError("Unserializable planning receipt");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function runtimePathIsExcluded(root: string, relativePath: string): boolean {
  try {
    execFileSync(
      "git",
      ["check-ignore", "--quiet", "--no-index", "--", relativePath],
      {
        cwd: root,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              ![
                "GIT_DIR",
                "GIT_WORK_TREE",
                "GIT_INDEX_FILE",
                "GIT_COMMON_DIR",
                "GIT_OBJECT_DIRECTORY",
                "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                "GIT_PREFIX",
                "GIT_CEILING_DIRECTORIES",
                "GIT_DISCOVERY_ACROSS_FILESYSTEM",
              ].includes(key),
          ),
        ),
        stdio: "ignore",
        windowsHide: true,
      },
    );
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException & { status?: number }).status === 0;
  }
}

function ensureRuntimeDirectory(root: string): string {
  let current = root;
  for (const segment of RECEIPT_DIRECTORY) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) fs.mkdirSync(current);
    const createdOrExisting = fs.lstatSync(current);
    if (
      !createdOrExisting.isDirectory() ||
      createdOrExisting.isSymbolicLink()
    ) {
      throw new Error(
        "Planning receipt directory contains a symlink or non-directory component",
      );
    }
    if (!inside(root, fs.realpathSync(current))) {
      throw new Error(
        "Planning receipt directory resolves outside the project",
      );
    }
  }
  return current;
}

function persistPlanningReceipt(
  root: string,
  body: PlanReceiptBody,
): { readonly ref: string; readonly fingerprint: string } | null {
  const bodyFingerprint = sha256(stableJson(body));
  const relativeDirectory = RECEIPT_DIRECTORY.join("/");
  const relativeFile = `${relativeDirectory}/${bodyFingerprint}.json`;
  const excludedByCandidateObserver =
    body.binding.observationSource === PROJECT_FILE_CANDIDATE_OBSERVER_VERSION;
  if (
    !excludedByCandidateObserver &&
    !runtimePathIsExcluded(root, relativeFile)
  ) {
    return null;
  }

  const directory = ensureRuntimeDirectory(root);
  const file = path.join(directory, `${bodyFingerprint}.json`);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const bytes = Buffer.from(
    `${JSON.stringify({ ...body, fingerprint: bodyFingerprint }, null, 2)}\n`,
    "utf8",
  );
  try {
    fs.writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
    try {
      fs.copyFileSync(temp, file, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = JSON.parse(fs.readFileSync(file, "utf8")) as {
        fingerprint?: unknown;
      };
      if (existing.fingerprint !== bodyFingerprint) throw error;
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return { ref: relativeFile, fingerprint: bodyFingerprint };
}

function projectEgressAuthorization(root: string): {
  readonly policy: ReturnType<typeof resolveJevProjectEgressPolicyV1>;
  readonly egress: JevEgressAuthorizationV1;
} {
  const policy = resolveJevProjectEgressPolicyV1(root);
  return {
    policy,
    egress: {
      network: "project-authorized",
      privacy: "project-approved-egress",
      credentials: "project-authorized",
      destination: JEV_ORIGIN_V1,
      egressDestinations: policy.allowed ? [JEV_ORIGIN_V1] : [],
      contentDecision: "task-summary-approved",
    },
  };
}

function parseOptions(args: readonly string[]): {
  readonly taskReference: string;
  readonly manifestPath: string;
  readonly choice: "adopt" | "override";
  readonly noJev: boolean;
} {
  const taskReference = args[0];
  if (!taskReference || taskReference.startsWith("--")) {
    throw new Error(
      "Usage: pactile task verify-plan <task-id> --manifest <project-relative-json> (--adopt|--override) [--no-jev]",
    );
  }
  let manifestPath: string | undefined;
  let choice: "adopt" | "override" | undefined;
  let noJev = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--manifest") {
      if (manifestPath) throw new Error("--manifest may be supplied only once");
      const value = args[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error("--manifest requires a path");
      manifestPath = value;
      index += 1;
    } else if (arg === "--adopt" || arg === "--override") {
      if (choice)
        throw new Error("Choose exactly one of --adopt or --override");
      choice = arg.slice(2) as "adopt" | "override";
    } else if (arg === "--no-jev") {
      noJev = true;
    } else {
      throw new Error(`Unsupported verify-plan argument: ${arg}`);
    }
  }
  if (!manifestPath) throw new Error("--manifest is required");
  if (!choice) throw new Error("Choose exactly one of --adopt or --override");
  return { taskReference, manifestPath, choice, noJev };
}

/** Produce a bound planning proposal only; it never starts a Run or creates a Review. */
export async function runTaskVerifyPlanCli(
  argv: readonly string[],
  rootValue = process.cwd(),
): Promise<number> {
  try {
    const root = fs.realpathSync(path.resolve(rootValue));
    const options = parseOptions(argv);
    const manifest = readManifest(root, options.manifestPath);
    const before = captureBinding(root, options.taskReference);
    const egressBefore = projectEgressAuthorization(root);
    const explicitlyDisabled =
      process.env.PACTILE_JEV_ENABLED?.trim().toLowerCase() === "false";
    const useJev = !options.noJev && !explicitlyDisabled;
    const facade = useJev
      ? createJevDecisionFacadeV1({
          enabled: true,
          maxDecisions: 1,
          maxDeadlineMs: JEV_DEADLINE_MS,
          transport: {
            apiKey: process.env.PACTILE_JEV_API_KEY,
            deadlineMs: JEV_DEADLINE_MS,
            maxRetries: 0,
          },
        })
      : undefined;
    const advised = await adviseVerificationPlanWithJevV1({
      ...manifest.input,
      ...(facade ? { jev: { facade, egress: egressBefore.egress } } : {}),
    });
    if (!verifyJevVerificationAdviceReceiptV1(advised.receipt)) {
      throw new Error("Jev advice receipt integrity check failed");
    }
    const jevAdvice = finalizeJevVerificationAdviceV1(
      advised.receipt,
      advised.plan,
      options.choice === "adopt" ? advised.receipt.suggestedCheckIds : [],
    );

    const after = captureBinding(root, options.taskReference);
    const egressAfter = projectEgressAuthorization(root);
    if (
      !sameBinding(before.binding, after.binding) ||
      stableJson(egressBefore.policy) !== stableJson(egressAfter.policy)
    ) {
      throw new Error(
        "The Task Run candidate or Jev project policy changed during advice; discard this stale plan and retry",
      );
    }

    const body: PlanReceiptBody = {
      schemaVersion: 1,
      source: "pactile-task-verification-planning-receipt-v1",
      status: "planned-only",
      recordedAt: new Date().toISOString(),
      binding: after.binding,
      jevEgressPolicy: egressAfter.policy,
      input: {
        authority: "caller-supplied-non-authoritative-inventory",
        sha256: manifest.sha256,
        sizeBytes: manifest.sizeBytes,
        completeRepositoryCiInventory: false,
      },
      deterministicPlan: advised.plan,
      jevAdvice,
      decision: {
        choice: options.choice,
        adoptedOptionalCheckIds: [...jevAdvice.adoptedCheckIds],
        overriddenOptionalCheckIds: [...jevAdvice.overriddenCheckIds],
      },
      execution: "not-run",
    };
    const persisted = persistPlanningReceipt(root, body);
    console.log(
      JSON.stringify(
        {
          ...body,
          receipt: persisted
            ? { status: "persisted", ...persisted }
            : {
                status: "not-persisted",
                reason:
                  "runtime-receipt-path-is-not-excluded-from-Git-candidate-observation",
              },
          policy: {
            requiredCiAuthority: "repository-policy-and-repository-CI",
            callerInventoryComplete: false,
            execution: "not-run",
            runOrReviewChanged: false,
          },
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
