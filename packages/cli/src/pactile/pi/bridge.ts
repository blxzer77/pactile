import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readStrategyContract } from "../task/strategy.js";
import { approvedExecuteTask } from "../task/authorization.js";
import {
  parallelChild,
  reserveParallelChild,
  updateParallelChildPid,
} from "../parallel/policy.js";
import { sameGitRoot } from "../../utils/git-root.js";
import {
  readTaskKernel,
  type TaskKernelSnapshotV2,
  type TaskRunV2,
} from "../../core/task/index.js";
import { resolveTaskDir } from "../task/session.js";
import {
  PiRpcClient,
  type PiRpcLaunch,
  type PiRpcProcessExitReceipt,
} from "./rpc.js";
import {
  buildIndependentPiReviewPrompt,
  type PiReviewPromptBinding,
} from "../review/contract.js";
import { resolvePiReviewEvidenceV1 } from "../review/evidence.js";
import {
  bindPiV2RunHost,
  persistPiV2StopAndRelease,
  preparePiV2RunDispatch,
  recheckPiV2RunDispatchBeforeSpawn,
  recheckPiV2RunDispatchWorkspace,
  type PiHostStopReceipt,
  type PiProcessExitEvidence,
  type PiV2RunDispatch,
} from "./v2-dispatch.js";
export {
  readPiHostStopReceipt,
  readPiTaskRunEvidence,
} from "./v2-dispatch.js";

export type PiRunOutcome =
  | "settled"
  | "needs_review"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export interface PiCheckStartReceiptV1 {
  schemaVersion: 1;
  source: "pactile-pi-review";
  taskId: string;
  taskRunId: string;
  piRunId: string;
  role: "check";
  sessionId: string;
  processId: number;
  startRequestId: string;
  kernelRevision: number;
  candidateSnapshotId: string;
  candidateFingerprint: string;
  progressEvidenceRef: string;
  evidenceRef: string;
  recordedAt: string;
}

export interface PiReviewResponseEvidenceV1 {
  ref: string;
  sha256: string;
  sizeBytes: number;
}

export interface PiCheckStopReceiptV1 {
  schemaVersion: 1;
  source: "pactile-pi-review";
  assurance: "manager-owned-child-exit";
  taskId: string;
  taskRunId: string;
  piRunId: string;
  role: "check";
  sessionId: string;
  processId: number;
  startRequestId: string;
  startReceiptRef: string;
  stopReceiptId: string;
  terminal: "exited" | "cancelled";
  exitCode: number | null;
  signalCode: string | null;
  cancellationRequestId: string | null;
  evidenceRef: string;
  progressEvidenceRef: string;
  progressEvidenceSha256: string;
  resultRef: string | null;
  resultSha256: string | null;
  reviewAttemptsRef: string;
  reviewAttemptsSha256: string;
  reviewResponses: PiReviewResponseEvidenceV1[];
  recordedAt: string;
  processExit: PiRpcProcessExitReceipt;
}

export interface PiReviewAttemptSummaryV1 {
  attempt: 1 | 2;
  kind: "initial" | "format-correction";
  outcome: "settled" | "transport-error";
  format: "structured-json-object" | "non-structured-json" | "unavailable";
  responseRef: string | null;
  responseSha256: string | null;
  responseBytes: number;
  redacted: boolean;
  stopReason: string | null;
  errorMessage: string | null;
  firstEventMs: number | null;
  elapsedMs: number;
  recordedAt: string;
}

export interface PiCheckRunEvidenceV1 {
  start: PiCheckStartReceiptV1;
  stop: PiCheckStopReceiptV1;
  resultBytes: Buffer;
  evidenceRefs: string[];
}

export interface PiRunRecord {
  schema_version: 1 | 2;
  run_id: string;
  task: string;
  role: "implement" | "check" | "research";
  outcome: PiRunOutcome | "running";
  started_at: string;
  ended_at: string | null;
  prompt_sha256: string;
  session_id: string | null;
  session_file: string | null;
  process_mode: "cold" | "warm";
  startup_ms: number;
  first_event_ms: number | null;
  elapsed_ms: number | null;
  event_count: number;
  tool_errors: number;
  reason: string | null;
  result_file: string | null;
  task_id?: string | null;
  task_run_id?: string | null;
  task_host_id?: "pi" | null;
  start_request_id?: string;
  process_id?: number | null;
  host_start_receipt_ref?: string | null;
  progress_evidence_ref?: string | null;
  settle_receipt_id?: string | null;
  process_stop_receipt?: PiHostStopReceipt | null;
  process_stop_error?: string | null;
  process_exit_receipt?: PiProcessExitEvidence | null;
  result_sha256?: string | null;
  result_redacted?: boolean;
  review_attempts_ref?: string | null;
  review_attempts_sha256?: string | null;
  review_format_correction?: {
    attempted: boolean;
    outcome:
      | "not-needed"
      | "accepted"
      | "rejected"
      | "timed-out"
      | "cancelled"
      | "failed"
      | "deadline-exceeded";
  } | null;
  dispatch_lease_id?: string | null;
  schedule_receipt_fingerprint?: string | null;
  admission_receipt_fingerprint?: string | null;
  dispatch_stop_proof_ref?: string | null;
  dispatch_lease_released?: boolean;
  dispatch_lease_release_reason?: string | null;
  candidate_snapshot_id?: string | null;
  candidate_fingerprint?: string | null;
  kernel_revision_at_dispatch?: number | null;
  reviewer_id?: string | null;
  reviewer_identity_assurance?: "caller-declared" | null;
  cancellation_request_id?: string | null;
  review_status?: "pending" | "recorded" | "rejected";
  review_rejection_reason?: string | null;
  review_file?: string | null;
  review_start_receipt_ref?: string | null;
  review_stop_receipt_ref?: string | null;
  kernel_review_id?: string | null;
  codex_escalation?: {
    required: boolean;
    target: "none" | "codex";
    reasons: string[];
  } | null;
  codex_escalation_request_ref?: string | null;
  codex_escalation_request_status?:
    | "pending"
    | "not-required"
    | "prepared"
    | "preparation-failed";
  jev_review_advice_ref?: string | null;
  jev_review_advice_status?:
    | "skipped"
    | "adopted"
    | "overridden"
    | "unavailable"
    | "superseded";
}

export interface PiRunInput {
  root: string;
  task: string;
  role: PiRunRecord["role"];
  prompt: string;
  timeoutMs: number;
  runId?: string;
  scheduleReceiptFingerprint?: string;
  resume?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: Record<string, unknown>) => void;
  reviewBinding?: PiReviewPromptBinding;
}

function safeReviewEvidencePath(taskDir: string, reference: string): string {
  if (!reference || path.isAbsolute(reference) || reference.includes("\0")) {
    throw new Error("Pi Review evidence reference is invalid");
  }
  const resolved = path.resolve(taskDir, reference);
  const relative = path.relative(path.resolve(taskDir), resolved);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Pi Review evidence reference escapes the Task directory");
  }
  const realTaskDir = fs.realpathSync(taskDir);
  const realFile = fs.realpathSync(resolved);
  const realRelative = path.relative(realTaskDir, realFile);
  if (
    !realRelative ||
    realRelative === ".." ||
    realRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(realRelative)
  ) {
    throw new Error("Pi Review evidence resolves outside the Task directory");
  }
  if (!fs.statSync(realFile).isFile())
    throw new Error("Pi Review evidence is not a file");
  return realFile;
}

function requireObjectJson(
  file: string,
  label: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Read the persisted Check receipts and exact structured response bytes before Review parsing. */
export function readPiCheckRunEvidenceV1(
  taskDir: string,
  record: PiRunRecord,
): PiCheckRunEvidenceV1 {
  if (
    record.role !== "check" ||
    record.outcome !== "settled" ||
    record.tool_errors !== 0 ||
    record.result_redacted === true ||
    !record.session_id ||
    !record.reviewer_id ||
    !record.task_id ||
    !record.task_run_id ||
    !record.candidate_snapshot_id ||
    !record.candidate_fingerprint ||
    !record.start_request_id ||
    !Number.isSafeInteger(record.process_id) ||
    !record.process_id ||
    !record.review_start_receipt_ref ||
    !record.review_stop_receipt_ref ||
    !record.result_file ||
    !record.result_sha256 ||
    !record.review_attempts_ref ||
    !record.review_attempts_sha256 ||
    !record.progress_evidence_ref ||
    !record.kernel_revision_at_dispatch
  ) {
    throw new Error("Pi Check run is incomplete or did not settle safely");
  }
  if (
    record.review_start_receipt_ref !==
      `pi-bridge/starts/${record.run_id}.json` ||
    record.review_stop_receipt_ref !==
      `pi-bridge/stops/${record.run_id}.json` ||
    record.progress_evidence_ref !==
      `pi-bridge/events/${record.run_id}.jsonl` ||
    record.result_file !== `pi-bridge/results/${record.run_id}.md`
  ) {
    throw new Error("Pi Check evidence references are not bound to this run");
  }
  const startPath = safeReviewEvidencePath(
    taskDir,
    record.review_start_receipt_ref,
  );
  const stopPath = safeReviewEvidencePath(
    taskDir,
    record.review_stop_receipt_ref,
  );
  const attemptsPath = safeReviewEvidencePath(
    taskDir,
    record.review_attempts_ref ?? "",
  );
  const eventPath = safeReviewEvidencePath(
    taskDir,
    record.progress_evidence_ref,
  );
  const resultPath = safeReviewEvidencePath(taskDir, record.result_file);
  const start = requireObjectJson(
    startPath,
    "Pi Check start receipt",
  ) as unknown as PiCheckStartReceiptV1;
  const stop = requireObjectJson(
    stopPath,
    "Pi Check stop receipt",
  ) as unknown as PiCheckStopReceiptV1;
  const events = fs
    .readFileSync(eventPath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean);
  const resultBytes = fs.readFileSync(resultPath);
  const attemptsBytes = fs.readFileSync(attemptsPath);
  const resultSha256 = createHash("sha256").update(resultBytes).digest("hex");
  const progressSha256 = createHash("sha256")
    .update(fs.readFileSync(eventPath))
    .digest("hex");
  const attemptsSha256 = createHash("sha256").update(attemptsBytes).digest("hex");
  if (attemptsBytes.byteLength > MAX_PI_REVIEW_ATTEMPT_MANIFEST_BYTES) {
    throw new Error("Pi Check Review attempt manifest exceeds its evidence bound");
  }
  let attemptSummaries: PiReviewAttemptSummaryV1[];
  try {
    attemptSummaries = attemptsBytes
      .toString("utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PiReviewAttemptSummaryV1);
  } catch {
    throw new Error("Pi Check Review attempt manifest is not valid JSONL");
  }
  if (attemptSummaries.length < 1 || attemptSummaries.length > 2) {
    throw new Error("Pi Check Review must contain one or two ordered attempts");
  }
  const responseEvidence: PiReviewResponseEvidenceV1[] = [];
  const responseTexts: string[] = [];
  for (const [index, attempt] of attemptSummaries.entries()) {
    const number = index + 1;
    const expectedKind = number === 1 ? "initial" : "format-correction";
    const expectedRef = `pi-bridge/review-responses/${record.run_id}-attempt-${number}.txt`;
    if (
      attempt?.attempt !== number ||
      attempt.kind !== expectedKind ||
      attempt.outcome !== "settled" ||
      attempt.responseRef !== expectedRef ||
      typeof attempt.responseSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(attempt.responseSha256) ||
      !Number.isSafeInteger(attempt.responseBytes) ||
      attempt.responseBytes < 1 ||
      attempt.responseBytes > MAX_PI_REVIEW_RESPONSE_BYTES ||
      typeof attempt.redacted !== "boolean" ||
      attempt.stopReason !== "stop"
    ) {
      throw new Error("Pi Check Review attempt order or response binding is invalid");
    }
    const responsePath = safeReviewEvidencePath(taskDir, expectedRef);
    const responseBytes = fs.readFileSync(responsePath);
    if (
      responseBytes.byteLength !== attempt.responseBytes ||
      createHash("sha256").update(responseBytes).digest("hex") !==
        attempt.responseSha256
    ) {
      throw new Error("Pi Check Review response evidence does not match its attempt");
    }
    let responseText: string;
    try {
      responseText = new TextDecoder("utf-8", { fatal: true }).decode(responseBytes);
    } catch {
      throw new Error("Pi Check Review response evidence is not valid UTF-8");
    }
    if (!Buffer.from(responseText, "utf8").equals(responseBytes)) {
      throw new Error("Pi Check Review response evidence is not canonical UTF-8");
    }
    const format = isStructuredJsonObject(responseText)
      ? "structured-json-object"
      : "non-structured-json";
    if (attempt.format !== format) {
      throw new Error("Pi Check Review response format does not match its evidence");
    }
    responseTexts.push(responseText);
    responseEvidence.push({
      ref: expectedRef,
      sha256: attempt.responseSha256,
      sizeBytes: attempt.responseBytes,
    });
  }
  const correction = record.review_format_correction;
  const firstFormat = attemptSummaries[0]?.format;
  const lastFormat = attemptSummaries.at(-1)?.format;
  if (
    (attemptSummaries.length === 1 &&
      (firstFormat !== "structured-json-object" ||
        correction?.attempted !== false ||
        correction.outcome !== "not-needed")) ||
    (attemptSummaries.length === 2 &&
      (firstFormat !== "non-structured-json" ||
        lastFormat !== "structured-json-object" ||
        correction?.attempted !== true ||
        correction.outcome !== "accepted"))
  ) {
    throw new Error("Pi Check Review correction sequence is inconsistent");
  }
  const finalResponseText = responseTexts.at(-1);
  if (
    finalResponseText === undefined ||
    !Buffer.from(`${finalResponseText || "(Pi returned no assistant text.)"}\n`, "utf8")
      .equals(resultBytes)
  ) {
    throw new Error("Pi Check result bytes do not match the final settled response");
  }
  const receiptResponses = stop.reviewResponses;
  if (
    !Array.isArray(receiptResponses) ||
    receiptResponses.length !== responseEvidence.length ||
    receiptResponses.some((item, index) => {
      const expected = responseEvidence[index];
      return (
        item?.ref !== expected?.ref ||
        item?.sha256 !== expected?.sha256 ||
        item?.sizeBytes !== expected?.sizeBytes
      );
    })
  ) {
    throw new Error("Pi Check stop receipt does not bind every response artifact");
  }
  if (
    start.schemaVersion !== 1 ||
    start.source !== "pactile-pi-review" ||
    start.role !== "check" ||
    stop.schemaVersion !== 1 ||
    stop.source !== "pactile-pi-review" ||
    stop.assurance !== "manager-owned-child-exit" ||
    stop.role !== "check" ||
    start.taskId !== record.task_id ||
    stop.taskId !== record.task_id ||
    start.taskRunId !== record.task_run_id ||
    stop.taskRunId !== record.task_run_id ||
    start.piRunId !== record.run_id ||
    stop.piRunId !== record.run_id ||
    start.sessionId !== record.session_id ||
    stop.sessionId !== record.session_id ||
    start.processId !== record.process_id ||
    stop.processId !== record.process_id ||
    start.startRequestId !== record.start_request_id ||
    stop.startRequestId !== record.start_request_id ||
    start.kernelRevision !== record.kernel_revision_at_dispatch ||
    start.candidateSnapshotId !== record.candidate_snapshot_id ||
    start.candidateFingerprint !== record.candidate_fingerprint ||
    start.evidenceRef !== `pi-bridge/runs/${record.run_id}.json` ||
    stop.evidenceRef !== start.evidenceRef ||
    start.progressEvidenceRef !== record.progress_evidence_ref ||
    stop.progressEvidenceRef !== record.progress_evidence_ref ||
    stop.progressEvidenceSha256 !== progressSha256 ||
    stop.startReceiptRef !== record.review_start_receipt_ref ||
    stop.stopReceiptId !== `review-stop-${record.run_id}` ||
    stop.terminal !== "exited" ||
    stop.exitCode !== 0 ||
    stop.signalCode !== null ||
    stop.cancellationRequestId !== null ||
    stop.resultRef !== record.result_file ||
    stop.resultSha256 !== record.result_sha256 ||
    resultSha256 !== record.result_sha256 ||
    record.review_attempts_ref !==
      `pi-bridge/review-attempts/${record.run_id}.jsonl` ||
    record.review_attempts_sha256 !== attemptsSha256 ||
    stop.reviewAttemptsRef !== record.review_attempts_ref ||
    stop.reviewAttemptsSha256 !== attemptsSha256 ||
    record.event_count < 1 ||
    events.length !== record.event_count ||
    stop.processExit?.terminationVerified !== true ||
    !stop.processExit.exitObservedAt ||
    stop.processExit.processId !== record.process_id ||
    stop.processExit.exitCode !== 0 ||
    stop.processExit.signalCode !== null ||
    record.reviewer_id !== `pi-session:${record.session_id}` ||
    (record.cancellation_request_id !== undefined &&
      record.cancellation_request_id !== null) ||
    record.reviewer_identity_assurance !== "caller-declared"
  ) {
    throw new Error(
      "Pi Check receipts, events, or result bytes do not match the persisted run",
    );
  }
  return {
    start,
    stop,
    resultBytes,
    evidenceRefs: [
      record.review_start_receipt_ref,
      record.review_stop_receipt_ref,
      record.progress_evidence_ref,
      record.result_file,
      record.review_attempts_ref,
      ...responseEvidence.map((item) => item.ref),
    ],
  };
}

const MAX_PI_REVIEW_RESPONSE_BYTES = 64 * 1024;
const MAX_PI_REVIEW_ATTEMPT_MANIFEST_BYTES = 16 * 1024;

export interface PiReviewRouteContext {
  taskDir: string;
  kernel: TaskKernelSnapshotV2;
  run: TaskRunV2;
  workdir: string;
  binding: PiReviewPromptBinding;
}

/** Build the independent Review binding from the current Verify Kernel state. */
export function preparePiReviewRoute(
  root: string,
  taskReference: string,
): PiReviewRouteContext {
  const projectRoot = fs.realpathSync(root);
  const taskDir = resolveTaskDir(projectRoot, taskReference);
  if (!fs.statSync(taskDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Task not found: ${taskReference}`);
  }
  if (!fs.existsSync(path.join(taskDir, "verify.md"))) {
    throw new Error("Pi Review requires verify.md");
  }
  const read = readTaskKernel({ root: projectRoot, taskDir, cwd: projectRoot });
  if (read.kind !== "task-kernel-v2") {
    throw new Error("Pi Review requires a V2 Task Kernel");
  }
  const kernel = read.kernel;
  if (kernel.phase !== "verify") {
    throw new Error("Pi Review requires the Task Kernel Verify phase");
  }
  const run = kernel.runs.at(-1);
  if (run?.state !== "completed" || !run.result || !run.candidateSnapshot) {
    throw new Error("Pi Review requires the latest completed Run candidate");
  }
  const workdir = run.workspace
    ? fs.realpathSync(run.workspace.canonicalPath)
    : projectRoot;
  if (run.workspace) {
    const worktreesRoot = fs.realpathSync(
      path.join(projectRoot, ".pactile", "worktrees"),
    );
    const relative = path.relative(worktreesRoot, workdir);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Pi Review Run worktree is outside .pactile/worktrees");
    }
  }
  const binding: PiReviewPromptBinding = {
    kernelRevision: kernel.revision,
    taskId: kernel.identity.taskId,
    runId: run.id,
    candidateSnapshotId: run.candidateSnapshot.id,
    candidateFingerprint: run.candidateSnapshot.fingerprint,
    taskTitle: kernel.definition.title,
    taskDescription: kernel.definition.description,
    deliverable: kernel.definition.deliverable,
    runSummary: run.result.summary,
    runReferences: [...run.input.references],
    authorizationScope: run.authorization.scope,
    writeSetSnapshot: [...run.writeSetSnapshot],
    candidateEntries: run.candidateSnapshot.entries.map((entry) => ({
      ref: entry.ref,
      fingerprint: entry.fingerprint,
    })),
    acceptanceCriteria: kernel.definition.acceptanceCriteria.map(
      (criterion) => ({
        id: criterion.id,
        description: criterion.description,
      }),
    ),
  };
  return { taskDir, kernel, run, workdir, binding };
}

function assertSameReviewBinding(
  actual: PiReviewPromptBinding,
  expected: PiReviewPromptBinding,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      "Pi Review binding is stale or does not match the current Run candidate",
    );
  }
}

function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

function writeExclusiveJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function parseJson(file: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function alive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function redact(text: string): string {
  return text
    .replace(
      /\b(?:sk[-_]|gh[pousr]_|glpat-|plane_api_)[A-Za-z0-9_-]{12,}/gi,
      "[redacted]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    );
}

function safeProviderMessage(text: string): string {
  return [...redact(text)]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? " " : character;
    })
    .join("")
    .slice(0, 500);
}

function safeErrorSummary(value: string): string {
  const message = value.toLowerCase();
  if (message.includes("cancel")) return "Pi operation cancelled";
  if (message.includes("timed out") || message.includes("timeout"))
    return "Pi operation timed out";
  if (message.includes("session changed")) return "Pi Review session changed";
  if (message.includes("implementation run host session"))
    return "Pi Check session matches the implementation Run host session";
  if (
    message.includes("candidate") ||
    message.includes("review binding") ||
    message.includes("evidence")
  )
    return "Pi Review preflight failed";
  if (message.includes("launch failed")) return "Pi RPC launch failed";
  if (message.includes("exited")) return "Pi RPC process exited";
  if (message.includes("rejected")) return "Pi RPC request rejected";
  if (message.includes("streaming") || message.includes("settled without"))
    return "Pi did not settle a final response";
  return "Pi operation failed";
}

function normalizeEventType(value: unknown): string {
  if (typeof value !== "string") return "other";
  const allowed = new Set([
    "agent_start",
    "agent_end",
    "agent_settled",
    "auto_retry_start",
    "auto_retry_end",
    "auto_compaction_start",
    "auto_compaction_end",
    "extension_error",
    "message_start",
    "message_update",
    "message_end",
    "session_start",
    "session_shutdown",
    "session_before_compact",
    "session_compact",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "turn_start",
    "turn_end",
  ]);
  return allowed.has(value) ? value : "other";
}

function normalizeToolName(value: string): string {
  const allowed = new Set([
    "bash",
    "edit",
    "find",
    "grep",
    "ls",
    "read",
    "write",
  ]);
  return allowed.has(value) ? value : "other";
}

function normalizeMessageRole(value: unknown): string {
  if (typeof value !== "string") return "other";
  const allowed = new Set(["assistant", "system", "tool", "user"]);
  return allowed.has(value) ? value : "other";
}

function normalizeProviderError(value: unknown): string | null {
  return typeof value === "string" && value.length > 0
    ? "provider-reported-error"
    : null;
}

function normalizeStopReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const allowed = new Set([
    "stop",
    "length",
    "error",
    "aborted",
    "cancelled",
    "toolUse",
    "end_turn",
  ]);
  return allowed.has(value) ? value : "other";
}

function assistantText(event: Record<string, unknown>): {
  rawText: string;
  text: string;
  redacted: boolean;
  stopReason: string | null;
  errorMessage: string | null;
} {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  const assistant = [...messages]
    .reverse()
    .find(
      (message) =>
        message &&
        typeof message === "object" &&
        (message as Record<string, unknown>).role === "assistant",
    ) as Record<string, unknown> | undefined;
  if (!assistant)
    return {
      rawText: "",
      text: "",
      redacted: false,
      stopReason: null,
      errorMessage: null,
    };
  const content = Array.isArray(assistant.content) ? assistant.content : [];
  const text = content
    .filter(
      (part) =>
        part &&
        typeof part === "object" &&
        (part as Record<string, unknown>).type === "text",
    )
    .map((part) => String((part as Record<string, unknown>).text ?? ""))
    .join("\n");
  return {
    rawText: text,
    text: redact(text),
    redacted: redact(text) !== text,
    stopReason:
      normalizeStopReason(assistant.stopReason),
    errorMessage: normalizeProviderError(assistant.errorMessage),
  };
}

function isStructuredJsonObject(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text.trim());
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

function reviewAttemptSummary(
  attempt: 1 | 2,
  kind: PiReviewAttemptSummaryV1["kind"],
  startedAt: number,
  response?: ReturnType<typeof assistantText>,
  firstEventMs: number | null = null,
  error?: string,
  responseRef: string | null = null,
): PiReviewAttemptSummaryV1 {
  if (!response) {
    return {
      attempt,
      kind,
      outcome: "transport-error",
      format: "unavailable",
      responseRef: null,
      responseSha256: null,
      responseBytes: 0,
      redacted: false,
      stopReason: null,
      errorMessage: error ? safeErrorSummary(error) : null,
      firstEventMs,
      elapsedMs: Math.round(performance.now() - startedAt),
      recordedAt: new Date().toISOString(),
    };
  }
  return {
    attempt,
    kind,
    outcome: "settled",
    format: isStructuredJsonObject(response.rawText)
      ? "structured-json-object"
      : "non-structured-json",
    responseRef,
    responseSha256: createHash("sha256")
      .update(Buffer.from(response.text, "utf8"))
      .digest("hex"),
    responseBytes: Buffer.byteLength(response.text, "utf8"),
    redacted: response.redacted,
    stopReason: response.stopReason,
    errorMessage: response.errorMessage,
    firstEventMs,
    elapsedMs: Math.round(performance.now() - startedAt),
    recordedAt: new Date().toISOString(),
  };
}

function evidenceEvent(
  event: Record<string, unknown>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {
    at: new Date().toISOString(),
    type: normalizeEventType(event.type),
  };
  if (typeof event.toolName === "string")
    safe.tool = normalizeToolName(event.toolName);
  if (event.type === "tool_execution_end")
    safe.is_error = event.isError === true;
  if (
    event.type === "message_end" &&
    event.message &&
    typeof event.message === "object"
  ) {
    const message = event.message as Record<string, unknown>;
    safe.role = normalizeMessageRole(message.role);
    if (typeof message.stopReason === "string")
      safe.stop_reason = normalizeStopReason(message.stopReason) ?? "other";
  }
  return safe;
}

export function approvedTask(
  root: string,
  reference: string,
  role: PiRunInput["role"],
): string {
  const dir = approvedExecuteTask(root, reference);
  const implementation = path.join(dir, "implement.md");
  if (role === "implement" && !fs.existsSync(implementation))
    throw new Error("Pi implement dispatch requires implement.md");
  if (fs.existsSync(implementation)) {
    const parsed = readStrategyContract(dir);
    if (parsed.errors.length)
      throw new Error(
        `Invalid execution contract: ${parsed.errors.join("; ")}`,
      );
    if (role === "implement" && parsed.contract?.execution_mode !== "worker") {
      throw new Error("Pi implement dispatch requires execution_mode: worker");
    }
  }
  if (role === "check" && !fs.existsSync(path.join(dir, "verify.md")))
    throw new Error("Pi check requires verify.md");
  return dir;
}

/** Resolve the approved execution location; never claim worktree isolation in the project root. */
export function piWorkdir(
  root: string,
  dir: string,
  role: PiRunInput["role"],
): string {
  if (role !== "implement" && !fs.existsSync(path.join(dir, "implement.md")))
    return root;
  const parsed = readStrategyContract(dir);
  if (parsed.errors.length || !parsed.contract)
    throw new Error(`Invalid execution contract: ${parsed.errors.join("; ")}`);
  if (parsed.contract.isolation === "main-worktree") return root;
  const task: unknown = JSON.parse(
    fs.readFileSync(path.join(dir, "task.json"), "utf8"),
  );
  const worktreePath =
    task && typeof task === "object" && "worktree_path" in task
      ? (task as { worktree_path?: unknown }).worktree_path
      : null;
  if (typeof worktreePath !== "string")
    throw new Error(
      "git-worktree isolation requires a prepared Child worktree",
    );
  const worktrees = path.resolve(root, ".pactile", "worktrees");
  const candidate = path.resolve(root, worktreePath);
  const relative = path.relative(worktrees, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Child worktree must stay under .pactile/worktrees");
  if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory())
    throw new Error("Child worktree directory is missing");
  const realRoot = fs.realpathSync(worktrees);
  const realCandidate = fs.realpathSync(candidate);
  const realRelative = path.relative(realRoot, realCandidate);
  if (
    !realRelative ||
    realRelative.startsWith("..") ||
    path.isAbsolute(realRelative)
  )
    throw new Error("Child worktree resolves outside .pactile/worktrees");
  let gitRoot: string;
  try {
    gitRoot = execFileSync(
      "git",
      [
        "-c",
        `safe.directory=${realCandidate.replaceAll("\\", "/")}`,
        "-C",
        realCandidate,
        "rev-parse",
        "--show-toplevel",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    throw new Error("Child worktree is not a usable Git checkout");
  }
  if (!sameGitRoot(gitRoot, realCandidate))
    throw new Error("Child worktree Git root does not match its recorded path");
  return realCandidate;
}

/** A reusable, one-task bridge. One Pi process can serve multiple sequential runs. */
export class PiTaskBridge {
  private client: PiRpcClient | null = null;
  private taskDir: string | null = null;
  private workdir: string | null = null;
  private role: PiRunInput["role"] | null = null;
  private locked = false;

  constructor(
    private readonly root: string,
    private readonly launch?: PiRpcLaunch,
  ) {}

  private async ensureClient(
    dir: string,
    workdir: string,
    role: PiRunInput["role"],
    resumeFile: string | null,
    beforeSpawn?: () => void,
    sessionDirOverride?: string,
    startupTimeoutMs?: number,
  ): Promise<{
    client: PiRpcClient;
    startupMs: number;
    mode: "cold" | "warm";
  }> {
    if (this.client && this.taskDir !== dir)
      throw new Error("Pi bridge is bound to one Pactile task");
    if (this.client && this.workdir !== workdir)
      throw new Error("Pi bridge cannot reuse a process in another worktree");
    if (this.client && this.role !== role)
      throw new Error("Pi bridge cannot reuse a process across worker roles");
    if (this.client?.isStarted)
      return { client: this.client, startupMs: 0, mode: "warm" };
    const client = new PiRpcClient({
      cwd: workdir,
      sessionDir: sessionDirOverride ?? path.join(dir, "pi-bridge", "sessions"),
      launch: this.launch,
      readOnly: role !== "implement",
    });
    this.client = client;
    this.taskDir = dir;
    this.workdir = workdir;
    this.role = role;
    const startupMs = await client.start(beforeSpawn, startupTimeoutMs);
    if (resumeFile) await client.switchSession(resumeFile);
    return { client, startupMs, mode: "cold" };
  }

  private async closeForDispatch(): Promise<PiRpcProcessExitReceipt | null> {
    const client = this.client;
    if (!client) return null;
    const receipt = await client.closeAndObserve();
    if (receipt?.terminationVerified) {
      this.client = null;
      this.taskDir = null;
      this.workdir = null;
      this.role = null;
    }
    return receipt;
  }

  private async closeForReview(): Promise<PiRpcProcessExitReceipt | null> {
    const client = this.client;
    if (!client) return null;
    const receipt = await client.closeAndObserve();
    if (receipt?.terminationVerified) {
      this.client = null;
      this.taskDir = null;
      this.workdir = null;
      this.role = null;
    }
    return receipt;
  }

  async run(input: PiRunInput): Promise<PiRunRecord> {
    if (path.resolve(input.root) !== path.resolve(this.root))
      throw new Error("Pi bridge root mismatch");
    if (!input.prompt.trim()) throw new Error("Pi prompt is empty");
    if (
      !Number.isInteger(input.timeoutMs) ||
      input.timeoutMs < 1_000 ||
      input.timeoutMs > 86_400_000
    )
      throw new Error("Pi timeout must be 1 second to 24 hours");
    if (this.locked) throw new Error("Pi bridge already has an active run");
    if (input.runId !== undefined) {
      if (input.role !== "implement")
        throw new Error(
          "Pi V2 dispatch currently supports only the implement role",
        );
      if (input.resume)
        throw new Error("Pi V2 dispatch cannot resume a prior session");
      if (this.client)
        throw new Error("Pi V2 dispatch requires a fresh Pi bridge process");
      if (!input.runId.trim())
        throw new Error("Pi V2 --run-id must be non-empty");
      const dispatch = preparePiV2RunDispatch(
        this.root,
        input.task,
        input.runId,
        input.scheduleReceiptFingerprint,
      );
      return this.runApproved(
        input,
        dispatch.taskDir,
        dispatch.workdir,
        null,
        null,
        dispatch,
        null,
      );
    }
    if (input.role === "check") {
      if (!input.reviewBinding) {
        throw new Error("Pi Check requires an independent Review binding");
      }
      if (input.runId || input.resume) {
        throw new Error(
          "Pi Review Check cannot resume or reuse an execution Run",
        );
      }
      if (this.client) {
        throw new Error(
          "Pi Review Check requires a fresh independent Pi session",
        );
      }
      const review = preparePiReviewRoute(this.root, input.task);
      assertSameReviewBinding(review.binding, input.reviewBinding);
      return this.runApproved(
        input,
        review.taskDir,
        review.workdir,
        null,
        null,
        null,
        review,
      );
    }
    if (input.reviewBinding) {
      throw new Error("Pi Review binding is only valid for the Check role");
    }
    const dir = approvedTask(this.root, input.task, input.role);
    const workdir = piWorkdir(this.root, dir, input.role);
    const scope = parallelChild(this.root, dir);
    const leaseId = randomUUID();
    const release = reserveParallelChild(this.root, dir, {
      id: leaseId,
      scheduleReceiptFingerprint: input.scheduleReceiptFingerprint,
    });
    try {
      return await this.runApproved(
        input,
        dir,
        workdir,
        scope?.touches ?? null,
        leaseId,
        null,
        null,
      );
    } finally {
      release();
    }
  }

  private async runApproved(
    input: PiRunInput,
    dir: string,
    workdir: string,
    touches: string[] | null,
    parallelLeaseId: string | null,
    dispatch: PiV2RunDispatch | null,
    review: PiReviewRouteContext | null,
  ): Promise<PiRunRecord> {
    const evidence = path.join(dir, "pi-bridge");
    const lockFile = path.join(evidence, "active.json");
    const latestFile = path.join(evidence, "latest.json");
    const cancelFile = path.join(evidence, "cancel-request.json");
    fs.mkdirSync(evidence, { recursive: true });
    if (fs.existsSync(lockFile)) {
      const prior = parseJson(lockFile);
      if (alive(prior?.parent_pid) || alive(prior?.child_pid))
        throw new Error(
          "Pi dispatch already active; stop the existing bridge before retrying",
        );
      const stale = parseJson(latestFile);
      if (stale?.outcome === "running") {
        const recovered = {
          ...stale,
          outcome: "interrupted",
          ended_at: new Date().toISOString(),
          reason: "bridge process exited before recording a terminal event",
        };
        atomicJson(
          path.join(evidence, "runs", `${stale.run_id}.json`),
          recovered,
        );
        atomicJson(latestFile, recovered);
      }
      fs.rmSync(lockFile);
    }
    const orphan = parseJson(latestFile);
    if (orphan?.outcome === "running") {
      const stale = orphan;
      const recovered = {
        ...stale,
        outcome: "interrupted",
        ended_at: new Date().toISOString(),
        reason: "bridge process exited before recording a terminal event",
      };
      atomicJson(
        path.join(evidence, "runs", `${stale.run_id}.json`),
        recovered,
      );
      atomicJson(latestFile, recovered);
    }
    const previous = parseJson(latestFile);
    const sessionRoot = path.resolve(evidence, "sessions");
    const previousSession =
      typeof previous?.session_file === "string"
        ? path.resolve(previous.session_file)
        : null;
    const previousSessionReal =
      previousSession &&
      fs.statSync(previousSession, { throwIfNoEntry: false })?.isFile()
        ? fs.realpathSync(previousSession)
        : null;
    const sessionRootReal = fs.existsSync(sessionRoot)
      ? fs.realpathSync(sessionRoot)
      : null;
    const relativeSession =
      previousSessionReal && sessionRootReal
        ? path.relative(sessionRootReal, previousSessionReal)
        : null;
    const insideSessions =
      relativeSession &&
      relativeSession !== ".." &&
      !relativeSession.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeSession);
    if (
      input.resume &&
      !(
        previous?.role === input.role &&
        insideSessions &&
        previousSession &&
        fs.statSync(previousSession, { throwIfNoEntry: false })?.isFile()
      )
    ) {
      throw new Error("No previous Pi session is available to resume");
    }
    const runId = randomUUID();
    const startRequestId = dispatch || review ? randomUUID() : null;
    const now = new Date();
    const runFile = path.join(evidence, "runs", `${runId}.json`);
    const eventFile = path.join(evidence, "events", `${runId}.jsonl`);
    const runReceiptRef = path.relative(dir, runFile).replaceAll("\\", "/");
    const progressEvidenceRef = path
      .relative(dir, eventFile)
      .replaceAll("\\", "/");
    const startReceiptRef = `pi-bridge/starts/${runId}.json`;
    const reviewStopReceiptRef = `pi-bridge/stops/${runId}.json`;
    const reviewAttemptsRef = `pi-bridge/review-attempts/${runId}.jsonl`;
    const reviewSessionEvidenceId = review
      ? `pirc-${createHash("sha256").update(runId).digest("hex").slice(0, 32)}`
      : null;
    const record: PiRunRecord = {
      schema_version: dispatch ? 2 : 1,
      run_id: runId,
      task: path.relative(this.root, dir).replaceAll("\\", "/"),
      role: input.role,
      outcome: "running",
      started_at: now.toISOString(),
      ended_at: null,
      prompt_sha256: createHash("sha256").update(input.prompt).digest("hex"),
      session_id: null,
      session_file: null,
      process_mode: "cold",
      startup_ms: 0,
      first_event_ms: null,
      elapsed_ms: null,
      event_count: 0,
      tool_errors: 0,
      reason: null,
      result_file: null,
      ...(review
        ? {
            task_id: review.run.taskId,
            task_run_id: review.run.id,
            candidate_snapshot_id: review.run.candidateSnapshot?.id ?? null,
            candidate_fingerprint:
              review.run.candidateSnapshot?.fingerprint ?? null,
            kernel_revision_at_dispatch: review.kernel.revision,
            reviewer_identity_assurance: "caller-declared" as const,
            start_request_id: startRequestId as string,
            process_id: null,
            progress_evidence_ref: progressEvidenceRef,
            result_sha256: null,
            result_redacted: false,
            review_attempts_ref: reviewAttemptsRef,
            review_attempts_sha256: null,
            review_format_correction: null,
            review_status: "pending" as const,
            review_start_receipt_ref: null,
            review_stop_receipt_ref: null,
            review_file: null,
            kernel_review_id: null,
            codex_escalation: null,
            codex_escalation_request_ref: null,
            codex_escalation_request_status: "pending" as const,
          }
        : {}),
      ...(dispatch
        ? {
            task_id: dispatch.taskId,
            task_run_id: dispatch.runId,
            task_host_id: "pi" as const,
            start_request_id: startRequestId as string,
            process_id: null,
            host_start_receipt_ref: null,
            progress_evidence_ref: progressEvidenceRef,
            settle_receipt_id: null,
            process_stop_receipt: null,
            process_stop_error: null,
            process_exit_receipt: null,
            result_sha256: null,
            result_redacted: false,
            dispatch_lease_id: dispatch.leaseId,
            schedule_receipt_fingerprint: dispatch.scheduleReceiptFingerprint,
            admission_receipt_fingerprint: dispatch.admissionReceiptFingerprint,
            dispatch_stop_proof_ref: null,
            dispatch_lease_released: false,
            dispatch_lease_release_reason: null,
          }
        : {}),
    };
    fs.mkdirSync(path.dirname(eventFile), { recursive: true });
    if (dispatch) fs.writeFileSync(eventFile, "", { flag: "wx", mode: 0o600 });
    if (review) {
      const attemptsFile = path.join(dir, reviewAttemptsRef);
      fs.mkdirSync(path.dirname(attemptsFile), { recursive: true });
      fs.writeFileSync(attemptsFile, "", { flag: "wx", mode: 0o600 });
    }
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ parent_pid: process.pid, run_id: runId }),
      { flag: "wx", mode: 0o600 },
    );
    this.locked = true;
    atomicJson(runFile, record);
    atomicJson(latestFile, record);
    const started = performance.now();
    const checkDeadlineAt = started + input.timeoutMs;
    let activeReviewSessionId: string | null = null;
    const remainingCheckMs = (): number =>
      Math.floor(checkDeadlineAt - performance.now());
    const reviewResponseEvidence: PiReviewResponseEvidenceV1[] = [];
    let detach = (): void => undefined;
    let closeFailed = false;
    const controller = new AbortController();
    if (input.signal?.aborted) controller.abort();
    const onAbort = (): void => controller.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const pollCancel = setInterval(() => {
      const cancellation = parseJson(cancelFile);
      if (cancellation?.run_id === runId) {
        if (review && typeof cancellation.request_id === "string") {
          record.cancellation_request_id = cancellation.request_id;
          atomicJson(runFile, record);
          atomicJson(latestFile, record);
        }
        controller.abort();
      }
    }, 200);
    const checkCancellationNow = (message: string): void => {
      const cancellation = parseJson(cancelFile);
      if (cancellation?.run_id === runId) {
        if (review && typeof cancellation.request_id === "string") {
          record.cancellation_request_id = cancellation.request_id;
          atomicJson(runFile, record);
          atomicJson(latestFile, record);
        }
        controller.abort();
      }
      if (controller.signal.aborted) throw new Error(message);
    };
    try {
      const resumeFile = input.resume ? previousSession : null;
      if (dispatch) {
        recheckPiV2RunDispatchWorkspace(dispatch);
      }
      const startupTimeoutMs = review ? remainingCheckMs() : undefined;
      if (review && (startupTimeoutMs ?? 0) <= 0)
        throw new Error("Pi Check timeout exhausted before startup");
      const { client, startupMs, mode } = await this.ensureClient(
        dir,
        workdir,
        input.role,
        resumeFile,
        dispatch
          ? () => {
              const verifiedWorkdir =
                recheckPiV2RunDispatchBeforeSpawn(dispatch);
              if (verifiedWorkdir !== workdir) {
                throw new Error(
                  "Pi V2 Run worktree changed immediately before process start",
                );
              }
            }
          : undefined,
        review ? path.join(evidence, "review-sessions", runId) : undefined,
        startupTimeoutMs,
      );
      if (parallelLeaseId)
        updateParallelChildPid(this.root, dir, parallelLeaseId, client.pid);
      fs.writeFileSync(
        lockFile,
        JSON.stringify({
          parent_pid: process.pid,
          child_pid: client.pid,
          run_id: runId,
        }),
        "utf8",
      );
      record.process_mode = mode;
      record.startup_ms = startupMs;
      const initialStateBudgetMs = review ? remainingCheckMs() : undefined;
      if (review && (initialStateBudgetMs ?? 0) <= 0)
        throw new Error("Pi Check timeout exhausted before session verification");
      const state = await client.state(initialStateBudgetMs);
      if (review && remainingCheckMs() <= 0)
        throw new Error("Pi Check timeout exhausted during session verification");
      activeReviewSessionId =
        typeof state.sessionId === "string" && state.sessionId.length > 0
          ? state.sessionId
          : null;
      record.session_id = review
        ? activeReviewSessionId
          ? reviewSessionEvidenceId
          : null
        : typeof state.sessionId === "string"
          ? state.sessionId
          : null;
      record.session_file = review
        ? null
        : typeof state.sessionFile === "string"
          ? state.sessionFile
          : null;
      atomicJson(runFile, record);
      atomicJson(latestFile, record);
      if (review) {
        if (
          !startRequestId ||
          !record.session_id ||
          !Number.isSafeInteger(client.pid) ||
          !client.pid
        ) {
          throw new Error(
            "Pi Review Check start did not provide process and session identities",
          );
        }
        if (activeReviewSessionId === review.run.host?.sessionId) {
          throw new Error(
            "Pi Check session matches the implementation Run host session",
          );
        }
        const currentReview = preparePiReviewRoute(
          this.root,
          review.run.taskId,
        );
        assertSameReviewBinding(currentReview.binding, review.binding);
        const startReceipt: PiCheckStartReceiptV1 = {
          schemaVersion: 1,
          source: "pactile-pi-review",
          taskId: review.run.taskId,
          taskRunId: review.run.id,
          piRunId: runId,
          role: "check",
          sessionId: record.session_id,
          processId: client.pid,
          startRequestId,
          kernelRevision: review.kernel.revision,
          candidateSnapshotId: review.binding.candidateSnapshotId,
          candidateFingerprint: review.binding.candidateFingerprint,
          progressEvidenceRef,
          evidenceRef: runReceiptRef,
          recordedAt: new Date().toISOString(),
        };
        writeExclusiveJson(path.join(dir, startReceiptRef), startReceipt);
        record.process_id = client.pid;
        record.start_request_id = startRequestId;
        record.reviewer_id = `pi-session:${record.session_id}`;
        record.review_start_receipt_ref = startReceiptRef;
        atomicJson(runFile, record);
        atomicJson(latestFile, record);
      }
      if (dispatch) {
        if (
          !startRequestId ||
          !record.session_id ||
          !Number.isSafeInteger(client.pid) ||
          !client.pid
        ) {
          throw new Error(
            "Pi V2 host start did not provide a process and session identity",
          );
        }
        const startReceipt = {
          schemaVersion: 1,
          source: "pactile-pi-rpc",
          taskId: dispatch.taskId,
          taskRunId: dispatch.runId,
          piRunId: runId,
          role: "implement",
          sessionId: record.session_id,
          processId: client.pid,
          startRequestId,
          progressEvidenceRef,
          evidenceRef: runReceiptRef,
          recordedAt: new Date().toISOString(),
        };
        const startFile = path.join(dir, startReceiptRef);
        fs.mkdirSync(path.dirname(startFile), { recursive: true });
        fs.writeFileSync(
          startFile,
          `${JSON.stringify(startReceipt, null, 2)}\n`,
          {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          },
        );
        record.process_id = client.pid;
        record.host_start_receipt_ref = startReceiptRef;
        atomicJson(runFile, record);
        atomicJson(latestFile, record);
        bindPiV2RunHost(dispatch, {
          piRunId: runId,
          startRequestId,
          sessionId: record.session_id,
          processId: client.pid,
          progressEvidenceRef,
        });
      }
      detach = client.onEvent((event) => {
        if (event.type === "transport_error") return;
        record.event_count += 1;
        if (event.type === "tool_execution_end" && event.isError === true)
          record.tool_errors += 1;
        if (
          event.type === "extension_error" ||
          (event.type === "auto_retry_end" && event.success === false)
        )
          record.tool_errors += 1;
        const summary = evidenceEvent(event);
        fs.appendFileSync(eventFile, `${JSON.stringify(summary)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        try {
          input.onProgress?.(summary);
        } catch {
          /* Observers cannot change the run outcome. */
        }
      });
      const taskPath = dir;
      const contractPath = path.join(dir, "implement.md");
      const contractExcerpt = fs.existsSync(contractPath)
        ? fs.readFileSync(contractPath, "utf8").slice(0, 1_200)
        : "(no implement.md)";
      const effectiveTouches =
        touches ??
        (dispatch
          ? [
              ...new Set([
                ...dispatch.run.writeSetSnapshot,
                ...(dispatch.run.workspace?.writeSet ?? []),
              ]),
            ]
          : null);
      const writeSetLabel = dispatch
        ? "Task Run write set"
        : "Parent-declared write set";
      const instructions = review
        ? [
            "Task-specific Review instructions:",
            fs.readFileSync(path.join(dir, "verify.md"), "utf8"),
            "Additional caller instructions:",
            input.prompt,
            buildIndependentPiReviewPrompt(review.binding),
          ].join("\n\n")
        : [
            `Pactile task: ${taskPath}`,
            `Execution worktree: ${workdir}`,
            `Role: ${input.role}`,
            `Definition: ${taskPath}/prd.md`,
            `Evidence: ${taskPath}/verify.md`,
            "Approved execution contract excerpt:",
            contractExcerpt,
            "Follow the approved task contract and its write set. Do not commit, archive, finalize, or mutate Pactile Kernel state. Report evidence and unresolved issues. Do not include credentials in the final answer.",
            effectiveTouches?.length
              ? `${writeSetLabel}: ${effectiveTouches.join(", ")}. Do not change files outside it.`
              : "",
            input.role === "implement"
              ? "Implementation may change files only inside the approved write set."
              : "This role is read-only; do not change files.",
            "Worker assignment:",
            input.prompt,
          ].join("\n\n");
      const resultFile = path.join(evidence, "results", `${runId}.md`);
      fs.mkdirSync(path.dirname(resultFile), { recursive: true });
      record.result_file = path.relative(dir, resultFile).replaceAll("\\", "/");
      const attemptsFile = review ? path.join(dir, reviewAttemptsRef) : null;
      const appendAttempt = (summary: PiReviewAttemptSummaryV1): void => {
        if (!attemptsFile) return;
        fs.appendFileSync(attemptsFile, `${JSON.stringify(summary)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      };
      const persistReviewResponse = (
        attempt: 1 | 2,
        response: ReturnType<typeof assistantText>,
      ): PiReviewResponseEvidenceV1 | null => {
        if (!review) return null;
        const bytes = Buffer.from(response.text, "utf8");
        if (bytes.byteLength > MAX_PI_REVIEW_RESPONSE_BYTES) return null;
        const ref = `pi-bridge/review-responses/${runId}-attempt-${attempt}.txt`;
        const file = path.join(dir, ref);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
        const stored: PiReviewResponseEvidenceV1 = {
          ref,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          sizeBytes: bytes.byteLength,
        };
        reviewResponseEvidence.push(stored);
        return stored;
      };
      let text = "";
      let redacted = false;
      const persistResult = (): void => {
        const responseTooLarge =
          review !== null &&
          Buffer.byteLength(text, "utf8") > MAX_PI_REVIEW_RESPONSE_BYTES;
        const resultText = responseTooLarge
          ? "(Pi Check response omitted because it exceeded the bounded evidence limit.)"
          : text || "(Pi returned no assistant text.)";
        fs.writeFileSync(
          resultFile,
          `${resultText}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        if (dispatch || review) {
          const resultBytes = fs.readFileSync(resultFile);
          record.result_sha256 = createHash("sha256")
            .update(resultBytes)
            .digest("hex");
          record.result_redacted = redacted || responseTooLarge;
        }
      };
      const firstPromptStarted = performance.now();
      const firstPromptRemainingMs = remainingCheckMs();
      if (review && firstPromptRemainingMs <= 0)
        throw new Error("Pi Check timeout exhausted before first prompt");
      const result = await client.prompt(
        instructions,
        review ? firstPromptRemainingMs : input.timeoutMs,
        controller.signal,
        undefined,
        review ? checkDeadlineAt : undefined,
        review
          ? () =>
              checkCancellationNow("Pi Check cancelled before prompt dispatch")
          : undefined,
      );
      record.first_event_ms = result.firstEventMs;
      let response = assistantText(result.event);
      const firstResponseEvidence = review
        ? persistReviewResponse(1, response)
        : null;
      text = response.text;
      redacted = response.redacted;
      record.outcome =
        response.stopReason === "stop" && text && !record.tool_errors
          ? "settled"
          : "needs_review";
      if (response.stopReason && response.stopReason !== "stop")
        record.reason = `Pi stopReason=${response.stopReason}${response.errorMessage ? `; ${response.errorMessage}` : ""}`;
      if (review) {
        appendAttempt(
          reviewAttemptSummary(
            1,
            "initial",
            firstPromptStarted,
            response,
            result.firstEventMs,
            undefined,
            firstResponseEvidence?.ref ?? null,
          ),
        );
        record.review_format_correction = {
          attempted: false,
          outcome: "not-needed",
        };
      }
      persistResult();
      if (review && !firstResponseEvidence) {
        record.review_format_correction = {
          attempted: false,
          outcome: "failed",
        };
        throw new Error("Pi Check response exceeds the bounded Review evidence limit");
      }

      if (
        review &&
        record.outcome === "settled" &&
        !isStructuredJsonObject(response.rawText)
      ) {
        record.review_format_correction = {
          attempted: false,
          outcome: "failed",
        };
        const currentReview = preparePiReviewRoute(
          this.root,
          review.run.taskId,
        );
        assertSameReviewBinding(currentReview.binding, review.binding);
        resolvePiReviewEvidenceV1({
          root: this.root,
          taskDir: currentReview.taskDir,
          candidateRoot: currentReview.workdir,
          run: currentReview.run,
          references: [],
        });
        checkCancellationNow("Pi run cancelled before format correction");
        const preflightBudgetMs = remainingCheckMs();
        if (preflightBudgetMs <= 0)
          throw new Error("Pi Review format correction exceeded the Check timeout");

        let correctionPromptInvoked = false;
        let correctionStarted = performance.now();
        let correctionResponse: ReturnType<typeof assistantText> | undefined;
        try {
          const beforeCorrection = await client.state(preflightBudgetMs);
          if (remainingCheckMs() <= 0)
            throw new Error("Pi Review format correction exceeded the Check timeout");
          if (beforeCorrection.sessionId !== activeReviewSessionId)
            throw new Error(
              "Pi Review Check session changed before format correction",
            );
          checkCancellationNow("Pi run cancelled before format correction");
          const correctionPrompt = [
            "Follow the complete original Check instructions, including Task-specific Review instructions, caller instructions, and Review/Close contract. Reuse the exact original instructions below.",
            instructions,
            "Format correction for the same independent Pi Check session.",
            "Your previous settled answer was not one structured JSON object.",
            "Return exactly one JSON object matching the Review contract below.",
            "Do not include prose, Markdown fences, prefixes, suffixes, or a JSON substring embedded in text.",
            "Keep the same frozen Task Run, candidate snapshot, reviewer identity, evidence boundary, and Review/Close guards.",
            "Use only the evidence already bound to this Check. Do not call tools or assume tools are available; if the bound evidence is insufficient, return needs-changes.",
          ].join("\n\n");
          const promptBudgetMs = remainingCheckMs();
          if (promptBudgetMs <= 0)
            throw new Error("Pi Review format correction exceeded the Check timeout");
          const correction = await client.prompt(
            correctionPrompt,
            promptBudgetMs,
            controller.signal,
            () => {
              correctionPromptInvoked = true;
            },
            checkDeadlineAt,
            () => {
              checkCancellationNow("Pi run cancelled before format correction");
              correctionStarted = performance.now();
            },
          );
          correctionResponse = assistantText(correction.event);
          const correctionResponseEvidence = persistReviewResponse(
            2,
            correctionResponse,
          );

          const finalStateBudgetMs = remainingCheckMs();
          if (finalStateBudgetMs <= 0)
            throw new Error("Pi Review format correction exceeded the Check timeout");
          const afterCorrection = await client.state(finalStateBudgetMs);
          if (remainingCheckMs() <= 0)
            throw new Error("Pi Review format correction exceeded the Check timeout");
          if (afterCorrection.sessionId !== activeReviewSessionId)
            throw new Error(
              "Pi Review Check session changed after format correction",
            );

          response = correctionResponse;
          text = response.text;
          redacted = response.redacted;
          appendAttempt(
            reviewAttemptSummary(
              2,
              "format-correction",
              correctionStarted,
              response,
              correction.firstEventMs,
              undefined,
              correctionResponseEvidence?.ref ?? null,
            ),
          );
          record.outcome =
            response.stopReason === "stop" && text && !record.tool_errors
              ? "settled"
              : "needs_review";
          if (response.stopReason && response.stopReason !== "stop")
            record.reason = `Pi stopReason=${response.stopReason}${response.errorMessage ? `; ${response.errorMessage}` : ""}`;
          record.review_format_correction = {
            attempted: true,
            outcome: isStructuredJsonObject(response.rawText)
              ? "accepted"
              : "rejected",
          };
          persistResult();
        } catch (error) {
          const correctionError =
            error instanceof Error ? error.message : String(error);
          record.review_format_correction = {
            attempted: correctionPromptInvoked,
            outcome:
              controller.signal.aborted || correctionError.includes("cancelled")
                ? "cancelled"
                : correctionError.includes("timed out")
                  ? correctionPromptInvoked
                    ? "timed-out"
                    : "deadline-exceeded"
                  : "failed",
          };
          if (correctionPromptInvoked) {
            appendAttempt(
              reviewAttemptSummary(
                2,
                "format-correction",
                correctionStarted,
                correctionResponse
                  ? {
                      ...correctionResponse,
                      errorMessage: safeErrorSummary(correctionError),
                    }
                  : undefined,
                null,
                correctionResponse ? undefined : correctionError,
                reviewResponseEvidence.find(
                  (item) =>
                    item.ref ===
                    `pi-bridge/review-responses/${runId}-attempt-2.txt`,
                )?.ref ?? null,
              ),
            );
          }
          throw error;
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      record.outcome =
        controller.signal.aborted || reason.includes("cancelled")
          ? "cancelled"
          : reason.includes("timed out")
            ? "timed_out"
            : reason.includes("exited")
              ? "interrupted"
              : "failed";
      record.reason = review ? safeErrorSummary(reason) : safeProviderMessage(reason);
      if (!dispatch && !review) {
        try {
          await this.close();
        } catch (closeError) {
          closeFailed = true;
          record.reason = `${record.reason}; Pi termination failed: ${safeProviderMessage(closeError instanceof Error ? closeError.message : String(closeError))}`;
        }
      }
    } finally {
      detach();
      clearInterval(pollCancel);
      input.signal?.removeEventListener("abort", onAbort);
      let processExit: PiProcessExitEvidence | null = null;
      let reviewProcessExit: PiRpcProcessExitReceipt | null = null;
      if (review) {
        try {
          reviewProcessExit = (await this.closeForReview()) ?? null;
        } catch (closeError) {
          closeFailed = true;
          const closeReason =
            closeError instanceof Error ? closeError.message : String(closeError);
          record.process_stop_error = review
            ? safeErrorSummary(closeReason)
            : safeProviderMessage(closeReason);
        }
        if (
          reviewProcessExit?.terminationVerified &&
          reviewProcessExit.exitObservedAt &&
          startRequestId &&
          record.session_id &&
          Number.isSafeInteger(record.process_id) &&
          record.process_id
        ) {
          if (
            record.outcome === "settled" &&
            (reviewProcessExit.exitCode !== 0 ||
              reviewProcessExit.signalCode !== null)
          ) {
            record.outcome = "interrupted";
            record.reason =
              "Pi reported a settled Review response but its manager-owned process exited abnormally";
          }
          const reviewAttemptsBytes = fs.readFileSync(
            path.join(dir, reviewAttemptsRef),
          );
          const reviewAttemptsSha256 = createHash("sha256")
            .update(reviewAttemptsBytes)
            .digest("hex");
          record.review_attempts_sha256 = reviewAttemptsSha256;
          const receipt: PiCheckStopReceiptV1 = {
            schemaVersion: 1,
            source: "pactile-pi-review",
            assurance: "manager-owned-child-exit",
            taskId: review.run.taskId,
            taskRunId: review.run.id,
            piRunId: runId,
            role: "check",
            sessionId: record.session_id,
            processId: record.process_id,
            startRequestId,
            startReceiptRef,
            stopReceiptId: `review-stop-${runId}`,
            terminal: record.outcome === "cancelled" ? "cancelled" : "exited",
            exitCode: reviewProcessExit.exitCode,
            signalCode: reviewProcessExit.signalCode,
            cancellationRequestId: record.cancellation_request_id ?? null,
            evidenceRef: runReceiptRef,
            progressEvidenceRef,
            progressEvidenceSha256: createHash("sha256")
              .update(fs.readFileSync(eventFile))
              .digest("hex"),
            resultRef: record.result_file,
            resultSha256: record.result_sha256 ?? null,
            reviewAttemptsRef,
            reviewAttemptsSha256,
            reviewResponses: reviewResponseEvidence,
            recordedAt: new Date().toISOString(),
            processExit: reviewProcessExit,
          };
          writeExclusiveJson(path.join(dir, reviewStopReceiptRef), receipt);
          record.review_stop_receipt_ref = reviewStopReceiptRef;
          record.process_stop_error = null;
        } else {
          closeFailed = true;
          record.process_stop_error ??=
            "Pi Check process termination was not verified; Review is not recordable";
          if (
            record.outcome === "settled" ||
            record.outcome === "needs_review"
          ) {
            record.outcome = "interrupted";
          }
        }
      }
      if (dispatch) {
        try {
          processExit = (await this.closeForDispatch()) ?? null;
        } catch (closeError) {
          record.process_stop_error = safeProviderMessage(
            closeError instanceof Error
              ? closeError.message
              : String(closeError),
          );
        }
        if (processExit) record.process_exit_receipt = processExit;
        if (
          processExit?.terminationVerified &&
          processExit.exitObservedAt &&
          startRequestId &&
          record.session_id &&
          Number.isSafeInteger(record.process_id) &&
          record.process_id
        ) {
          if (
            record.outcome === "settled" &&
            (processExit.exitCode !== 0 || processExit.signalCode !== null)
          ) {
            record.outcome = "interrupted";
            record.reason =
              "Pi reported a settled response but the manager-owned process exited abnormally";
          }
          const settleReceiptId = `settle-${runId}`;
          const receipt: PiHostStopReceipt = {
            schemaVersion: 1,
            source: "pactile-pi-rpc",
            assurance: "manager-owned-child-exit",
            taskId: dispatch.taskId,
            taskRunId: dispatch.runId,
            piRunId: runId,
            role: "implement",
            sessionId: record.session_id,
            processId: record.process_id,
            startRequestId,
            settleReceiptId,
            terminal: record.outcome === "cancelled" ? "cancelled" : "exited",
            exitCode: processExit.exitCode,
            signalCode: processExit.signalCode,
            cancellationRequestId:
              parseJson(cancelFile)?.run_id === runId &&
              typeof parseJson(cancelFile)?.request_id === "string"
                ? String(parseJson(cancelFile)?.request_id)
                : null,
            evidenceRef: runReceiptRef,
            progressEvidenceRef,
            resultRef: record.result_file,
            resultSha256: record.result_sha256 ?? null,
            recordedAt: new Date().toISOString(),
            processExit,
          };
          record.settle_receipt_id = settleReceiptId;
          record.process_stop_receipt = receipt;
          record.process_stop_error = null;
        } else {
          record.process_stop_error ??=
            "Pi child close was not verified; dispatch lease retained";
        }
      }
      if (closeFailed && alive(this.client?.pid)) {
        record.outcome = "interrupted";
        record.reason = `${record.reason ?? "Pi run interrupted"}; Pi process may still be active`;
      }
      record.ended_at = new Date().toISOString();
      record.elapsed_ms = Math.round(performance.now() - started);
      atomicJson(runFile, record);
      atomicJson(latestFile, record);
      const v2ChildClosed = processExit?.terminationVerified === true;
      if (review && reviewProcessExit?.terminationVerified) {
        fs.rmSync(lockFile, { force: true });
      } else if (
        !review &&
        ((!dispatch && !(closeFailed && alive(this.client?.pid))) ||
          (dispatch && v2ChildClosed))
      ) {
        fs.rmSync(lockFile, { force: true });
      }
      if (parseJson(cancelFile)?.run_id === runId)
        fs.rmSync(cancelFile, { force: true });
      if (
        dispatch &&
        record.process_stop_receipt &&
        startRequestId &&
        record.session_id &&
        record.process_id
      ) {
        try {
          const settlement = persistPiV2StopAndRelease(dispatch, {
            runId,
            startRequestId,
            sessionId: record.session_id,
            processId: record.process_id,
            progressEvidenceRef,
            startReceiptRef,
            runReceiptRef,
            resultRef: record.result_file,
            resultSha256: record.result_sha256 ?? null,
            outcome: record.outcome,
            cancellationRequestId:
              record.process_stop_receipt.cancellationRequestId,
            processExit: record.process_stop_receipt.processExit,
            processStopReceipt: record.process_stop_receipt,
          });
          record.dispatch_stop_proof_ref =
            settlement.stopReceiptTaskRef || null;
          record.dispatch_lease_released = settlement.released;
          record.dispatch_lease_release_reason = settlement.reasonCode;
        } catch (settleError) {
          record.dispatch_lease_released = false;
          record.dispatch_lease_release_reason = safeProviderMessage(
            settleError instanceof Error
              ? settleError.message
              : String(settleError),
          );
        }
        atomicJson(runFile, record);
        atomicJson(latestFile, record);
      }
      this.locked = false;
    }
    return record;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.taskDir = null;
    this.workdir = null;
    this.role = null;
  }
}
