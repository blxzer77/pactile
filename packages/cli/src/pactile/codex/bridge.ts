import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  fingerprintTaskValue,
  readTaskKernel,
  type TaskKernelEventV2,
  type TaskReviewV2,
  type TaskRunV2,
} from "../../core/task/index.js";
import { resolveTaskDir } from "../task/session.js";
import { approvedExecuteTask } from "../task/authorization.js";
import { readStrategyContract } from "../task/strategy.js";
import {
  parallelChild,
  releaseParallelChild,
  reserveParallelChild,
} from "../parallel/policy.js";
import {
  CoordinationStore,
  type CoordinationEvidenceLevel,
  type CoordinationTaskBlocked,
  type CoordinationTaskUnblocked,
} from "../coordination/index.js";

export {
  readCodexHostStopReceipts,
  type CodexHostStopReceipt,
} from "./host-stop.js";

export type CodexBridgeTool =
  | "create_thread"
  | "send_message_to_thread"
  | "wait_threads"
  | "read_thread";
export type CodexBridgeRole = "plan" | "review" | "execute";

export interface CodexBridgeRequest {
  schema_version: 1;
  request_id: string;
  task: string;
  task_id?: string;
  task_kernel_kind?: "task-kernel-v2" | "legacy-task-kernel-v1";
  kernel_revision: number;
  contract_fingerprint?: string | null;
  run_id?: string | null;
  dispatch_task_id?: string | null;
  dispatch_run_id?: string | null;
  dispatch_lease_id?: string | null;
  schedule_receipt_fingerprint?: string | null;
  dispatch_admission_receipt_fingerprint?: string | null;
  request_fingerprint?: string;
  candidate_snapshot_id?: string | null;
  candidate_fingerprint?: string | null;
  to_task?: string | null;
  to_task_id?: string | null;
  to_kernel_revision?: number | null;
  to_task_kernel_kind?: "task-kernel-v2" | "legacy-task-kernel-v1" | null;
  to_contract_fingerprint?: string | null;
  to_run_id?: string | null;
  to_candidate_snapshot_id?: string | null;
  to_candidate_fingerprint?: string | null;
  coordination_message_id?: string | null;
  escalation_id?: string;
  reply_to_escalation_id?: string;
  created_at: string;
  tool: CodexBridgeTool;
  role: CodexBridgeRole;
  thread_id: string | null;
  host_id: string | null;
  arguments: Record<string, unknown>;
  prompt_sha256: string | null;
}

export interface CodexBridgeReceipt {
  schema_version: 1;
  request_id: string;
  task_id?: string;
  run_id?: string | null;
  candidate_snapshot_id?: string | null;
  candidate_fingerprint?: string | null;
  to_task_id?: string | null;
  to_run_id?: string | null;
  to_candidate_snapshot_id?: string | null;
  to_candidate_fingerprint?: string | null;
  escalation_id?: string;
  reply_to_escalation_id?: string;
  reply_evidence?: {
    reply_to_escalation_id: string;
    response_turn_id: string;
    body: string;
    body_sha256: string;
  };
  destination_kernel_revision_at_receipt?: number | null;
  request_fingerprint?: string;
  evidence_level?: "simulated" | "desktop-native";
  thread_creation_state?: "created" | "not_created" | "unknown";
  tool: CodexBridgeTool;
  outcome: "ok" | "failed" | "queued";
  thread_id: string | null;
  client_thread_id: string | null;
  host_id: string | null;
  status: string | null;
  cursor: string | null;
  reason: string | null;
  kernel_revision_at_receipt: number;
  contract_stale: boolean;
  recorded_at: string;
  assurance: "host-reported";
}

export interface PendingCodexRequest {
  request_id: string;
  tool: CodexBridgeTool;
  role: CodexBridgeRole;
  thread_id: string | null;
  kernel_revision: number;
  created_at: string;
  prompt_sha256: string | null;
}

interface BoundThread {
  threadId: string;
  hostId: string;
  role: CodexBridgeRole;
  runId: string | null;
  dispatchLeaseId: string | null;
}

type CodexTaskKernelKind = "task-kernel-v2" | "legacy-task-kernel-v1";

interface BridgeTaskContext {
  dir: string;
  task: string;
  taskId: string;
  phase: string;
  revision: number;
  kernelKind: CodexTaskKernelKind;
  contractFingerprint: string | null;
  events: TaskKernelEventV2[];
  runs: TaskRunV2[];
  reviews: TaskReviewV2[];
  archived: boolean;
}

interface SelectedRun {
  runId: string | null;
  candidateSnapshotId: string | null;
  candidateFingerprint: string | null;
  run: TaskRunV2 | null;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escalationIdPattern =
  /^pi-escalation:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const transportIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const escalationSecretPattern =
  /\b(?:bearer\s+[a-z0-9._~+/-]{12,}|(?:sk[-_]|gh[pousr]_|glpat-|plane_api_)[a-z0-9_-]{12,}|(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+)/iu;

function taskContextFromDirectory(
  root: string,
  dir: string,
  archived: boolean,
): BridgeTaskContext {
  const read = readTaskKernel({ root, taskDir: dir, cwd: root });
  if (read.kind === "task-kernel-v2") {
    const kernel = read.kernel;
    return {
      dir,
      task: path.relative(root, dir).replaceAll("\\", "/"),
      taskId: kernel.identity.taskId,
      phase: kernel.phase,
      revision: kernel.revision,
      kernelKind: read.kind,
      contractFingerprint: fingerprintTaskValue(kernel.definition),
      events: kernel.events,
      runs: kernel.runs,
      reviews: kernel.reviews,
      archived,
    };
  }
  const kernel = read.kernel.kernel;
  return {
    dir,
    task: path.relative(root, dir).replaceAll("\\", "/"),
    taskId: kernel.identity.taskId,
    phase: kernel.phase,
    revision: kernel.revision,
    kernelKind: read.kind,
    contractFingerprint: null,
    events: [],
    runs: [],
    reviews: [],
    archived,
  };
}

function taskContext(root: string, reference: string): BridgeTaskContext {
  const dir = resolveTaskDir(root, reference);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`Task not found: ${reference}`);
  return taskContextFromDirectory(root, dir, false);
}

function archivedTaskContext(
  root: string,
  reference: string,
): BridgeTaskContext {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(reference))
    throw new Error("Archived task reference must be a task name or id");
  const archive = path.join(root, ".pactile", "tasks", "archive");
  if (!fs.statSync(archive, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`Task not found: ${reference}`);
  const matches = fs
    .readdirSync(archive, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name))
    .flatMap((entry) =>
      fs
        .readdirSync(path.join(archive, entry.name), { withFileTypes: true })
        .filter(
          (task) =>
            task.isDirectory() &&
            (task.name === reference || task.name.endsWith(`-${reference}`)),
        )
        .map((task) => path.join(archive, entry.name, task.name)),
    );
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? `Archived task reference is ambiguous: ${reference}`
        : `Task not found: ${reference}`,
    );
  const dir = matches[0];
  const realArchive = fs.realpathSync(archive);
  const relative = path.relative(realArchive, fs.realpathSync(dir));
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Archived task resolves outside the task archive");
  return taskContextFromDirectory(root, dir, true);
}

function taskContextIncludingArchive(
  root: string,
  reference: string,
): BridgeTaskContext {
  try {
    return taskContext(root, reference);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith("Task not found:")
    ) {
      throw error;
    }
    return archivedTaskContext(root, reference);
  }
}

function selectRun(
  context: BridgeTaskContext,
  role: CodexBridgeRole,
  requestedRunId?: string,
  requireRunning = false,
): SelectedRun {
  if (context.kernelKind !== "task-kernel-v2") {
    if (requestedRunId)
      throw new Error("--run-id requires a Task Kernel v2 task");
    return {
      runId: null,
      candidateSnapshotId: null,
      candidateFingerprint: null,
      run: null,
    };
  }
  const run = requestedRunId
    ? context.runs.find((candidate) => candidate.id === requestedRunId)
    : role === "review"
      ? [...context.runs]
          .reverse()
          .find((candidate) => candidate.candidateSnapshot)
      : [...context.runs]
          .reverse()
          .find(
            (candidate) =>
              candidate.state === "running" || candidate.state === "waiting",
          );
  if (requestedRunId && !run)
    throw new Error(
      `Run not found on Task ${context.taskId}: ${requestedRunId}`,
    );
  if (
    role === "execute" &&
    requireRunning &&
    run?.state !== "running" &&
    run?.state !== "waiting"
  ) {
    throw new Error(
      "Codex Execute dispatch requires a running or waiting Task Kernel v2 Run",
    );
  }
  if (
    role === "review" &&
    context.phase === "verify" &&
    !run?.candidateSnapshot
  ) {
    throw new Error("Codex Review requires the latest Run candidate snapshot");
  }
  return {
    runId: run?.id ?? null,
    candidateSnapshotId: run?.candidateSnapshot?.id ?? null,
    candidateFingerprint: run?.candidateSnapshot?.fingerprint ?? null,
    run: run ?? null,
  };
}

function bridgeDir(dir: string): string {
  return path.join(dir, "codex-bridge");
}
function requestFile(dir: string, id: string): string {
  return path.join(bridgeDir(dir), "requests", `${id}.json`);
}
function receiptFile(dir: string, id: string): string {
  return path.join(bridgeDir(dir), "receipts", `${id}.json`);
}
function queuedFile(dir: string, id: string): string {
  return path.join(bridgeDir(dir), "queued", `${id}.json`);
}

function writeNew(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function codexRequestFingerprint(request: CodexBridgeRequest): string {
  const { request_fingerprint: _stored, ...payload } = request;
  return fingerprintTaskValue(payload);
}

type CoordinationMessageEntry = ReturnType<
  CoordinationStore["snapshot"]
>["messages"][number];

function verifyFreshCoordinationMessage(
  root: string,
  entry: CoordinationMessageEntry,
  destinationContext: BridgeTaskContext,
  requireNative: boolean,
): {
  evidenceLevel: CoordinationEvidenceLevel;
  sourceContext: BridgeTaskContext;
} {
  const message = entry.message;
  const requestId = message.request_id;
  if (
    !requestId ||
    !uuidPattern.test(requestId) ||
    !new Set(["sent", "delivered", "acknowledged"]).has(entry.status)
  ) {
    throw new Error("Coordination message has no successful bound request");
  }
  const sourceContext = taskContext(root, message.from_task_id);
  const request = readJson(
    requestFile(sourceContext.dir, requestId),
  ) as unknown as CodexBridgeRequest;
  const receipt = readJson(
    receiptFile(sourceContext.dir, requestId),
  ) as unknown as CodexBridgeReceipt;
  const sendReceipt = entry.receipts.find(
    (candidate) => candidate.receipt_id === requestId,
  );
  const evidenceLevel = receipt.evidence_level;
  const requestFingerprint = codexRequestFingerprint(request);
  const sourceBound =
    !sourceContext.archived &&
    request.request_id === requestId &&
    request.request_fingerprint === requestFingerprint &&
    request.task === sourceContext.task &&
    request.task_id === sourceContext.taskId &&
    request.task_kernel_kind === sourceContext.kernelKind &&
    request.kernel_revision === sourceContext.revision &&
    (request.contract_fingerprint ?? null) ===
      sourceContext.contractFingerprint &&
    (request.run_id ?? null) === message.from_run_id &&
    isRunBoundToContext(
      sourceContext,
      request.run_id,
      request.candidate_snapshot_id,
      request.candidate_fingerprint,
    );
  const destinationBound =
    !destinationContext.archived &&
    request.to_task === path.basename(destinationContext.dir) &&
    request.to_task_id === destinationContext.taskId &&
    request.to_task_kernel_kind === destinationContext.kernelKind &&
    request.to_kernel_revision === destinationContext.revision &&
    (request.to_contract_fingerprint ?? null) ===
      destinationContext.contractFingerprint &&
    (request.to_run_id ?? null) === message.to_run_id &&
    isRunBoundToContext(
      destinationContext,
      request.to_run_id,
      request.to_candidate_snapshot_id,
      request.to_candidate_fingerprint,
    );
  if (
    !sourceBound ||
    !destinationBound ||
    message.message_id !== request.coordination_message_id ||
    message.message_id !== requestId ||
    message.host_ref !== request.thread_id ||
    request.tool !== "send_message_to_thread" ||
    !request.thread_id ||
    !request.host_id ||
    receipt.schema_version !== 1 ||
    receipt.request_id !== requestId ||
    receipt.request_fingerprint !== requestFingerprint ||
    receipt.task_id !== sourceContext.taskId ||
    (receipt.run_id ?? null) !== (request.run_id ?? null) ||
    (receipt.candidate_snapshot_id ?? null) !==
      (request.candidate_snapshot_id ?? null) ||
    (receipt.candidate_fingerprint ?? null) !==
      (request.candidate_fingerprint ?? null) ||
    (receipt.to_task_id ?? null) !== destinationContext.taskId ||
    (receipt.to_run_id ?? null) !== (request.to_run_id ?? null) ||
    (receipt.to_candidate_snapshot_id ?? null) !==
      (request.to_candidate_snapshot_id ?? null) ||
    (receipt.to_candidate_fingerprint ?? null) !==
      (request.to_candidate_fingerprint ?? null) ||
    receipt.destination_kernel_revision_at_receipt !==
      request.to_kernel_revision ||
    receipt.kernel_revision_at_receipt !== request.kernel_revision ||
    receipt.thread_id !== request.thread_id ||
    receipt.host_id !== request.host_id ||
    receipt.tool !== request.tool ||
    receipt.outcome !== "ok" ||
    receipt.contract_stale !== false ||
    !sendReceipt ||
    !new Set(["sent", "delivered", "acknowledged"]).has(sendReceipt.status) ||
    sendReceipt.evidence_level !== evidenceLevel ||
    (evidenceLevel !== "simulated" && evidenceLevel !== "desktop-native") ||
    (requireNative && evidenceLevel !== "desktop-native")
  ) {
    throw new Error(
      "Coordination message request or receipt is stale, misbound, or not authoritative",
    );
  }
  return { evidenceLevel, sourceContext };
}

function coordinationKernelBarrier(context: BridgeTaskContext): {
  runId: string | null;
  kernelRevision: number | null;
  kernelEventId: string | null;
} {
  if (context.kernelKind !== "task-kernel-v2") {
    return { runId: null, kernelRevision: null, kernelEventId: null };
  }
  const lastEvent = context.events.at(-1);
  if (lastEvent?.revision !== context.revision) {
    throw new Error(
      "Cannot bind coordination unblock to the current Kernel event",
    );
  }
  const activeRun = [...context.runs]
    .reverse()
    .find((run) => run.state === "running" || run.state === "waiting");
  return {
    runId: activeRun?.id ?? null,
    kernelRevision: context.revision,
    kernelEventId: lastEvent.id,
  };
}

function readJson(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid JSON object: ${file}`);
  return value as Record<string, unknown>;
}

function requests(dir: string): CodexBridgeRequest[] {
  const folder = path.join(bridgeDir(dir), "requests");
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .filter(
      (file) =>
        uuidPattern.test(file.replace(/\.json$/, "")) && file.endsWith(".json"),
    )
    .map(
      (file) =>
        readJson(path.join(folder, file)) as unknown as CodexBridgeRequest,
    )
    .sort(
      (left, right) =>
        left.created_at.localeCompare(right.created_at) ||
        left.request_id.localeCompare(right.request_id),
    );
}

function boundThreads(dir: string): Map<string, BoundThread> {
  const bound = new Map<string, BoundThread>();
  for (const request of requests(dir)) {
    if (request.tool !== "create_thread") continue;
    const file = receiptFile(dir, request.request_id);
    if (!fs.existsSync(file)) continue;
    const receipt = readJson(file);
    if (
      receipt.outcome === "ok" &&
      receipt.contract_stale !== true &&
      typeof receipt.thread_id === "string" &&
      typeof receipt.host_id === "string"
    ) {
      bound.set(receipt.thread_id, {
        threadId: receipt.thread_id,
        hostId: receipt.host_id,
        role: request.role,
        runId: request.run_id ?? null,
        dispatchLeaseId: request.dispatch_lease_id ?? null,
      });
    }
  }
  return bound;
}

/**
 * A Plan thread can outlive the Kernel revision that created it. Reuse that
 * thread only for a coordination message, and only when its original request
 * still matches this V2 Task's identity and contract. The outgoing message is
 * separately bound to the current Kernel revision and active Run.
 */
function coordinationBoundThread(
  context: BridgeTaskContext,
  threadId: string,
): BoundThread | undefined {
  if (context.archived || context.kernelKind !== "task-kernel-v2")
    return undefined;

  for (const request of requests(context.dir).reverse()) {
    if (
      request.tool !== "create_thread" ||
      request.role !== "plan" ||
      request.task !== context.task ||
      request.task_id !== context.taskId ||
      request.task_kernel_kind !== "task-kernel-v2" ||
      (request.contract_fingerprint ?? null) !== context.contractFingerprint ||
      !Number.isInteger(request.kernel_revision) ||
      request.kernel_revision > context.revision
    ) {
      continue;
    }
    const receiptPath = receiptFile(context.dir, request.request_id);
    if (!fs.existsSync(receiptPath)) continue;
    const receipt = readJson(receiptPath) as unknown as CodexBridgeReceipt;
    const requestFingerprint = codexRequestFingerprint(request);
    if (
      request.request_fingerprint !== requestFingerprint ||
      receipt.schema_version !== 1 ||
      receipt.request_id !== request.request_id ||
      receipt.request_fingerprint !== requestFingerprint ||
      receipt.task_id !== context.taskId ||
      receipt.run_id !== (request.run_id ?? null) ||
      receipt.tool !== "create_thread" ||
      receipt.outcome !== "ok" ||
      (request.kernel_revision === context.revision &&
        receipt.contract_stale === true) ||
      receipt.kernel_revision_at_receipt !== request.kernel_revision ||
      receipt.thread_id !== threadId ||
      !receipt.host_id ||
      !idPattern.test(receipt.host_id)
    ) {
      continue;
    }
    return {
      threadId,
      hostId: receipt.host_id,
      role: "plan",
      runId: request.run_id ?? null,
      dispatchLeaseId: request.dispatch_lease_id ?? null,
    };
  }
  return undefined;
}

function latestWaitCursor(dir: string, threadId: string): string | null {
  const waits = requests(dir).filter(
    (request) =>
      request.tool === "wait_threads" && request.thread_id === threadId,
  );
  for (const request of waits.reverse()) {
    const file = receiptFile(dir, request.request_id);
    if (!fs.existsSync(file)) continue;
    const receipt = readJson(file);
    if (
      receipt.outcome === "ok" &&
      receipt.contract_stale !== true &&
      typeof receipt.cursor === "string"
    )
      return receipt.cursor;
  }
  return null;
}

function checkPhase(role: CodexBridgeRole, phase: string): void {
  if (role === "plan" && !["open", "define", "approve"].includes(phase))
    throw new Error(
      `Codex planning requires an open/define/approve task; got ${phase}`,
    );
  if (role === "review" && !["verify", "integrate"].includes(phase))
    throw new Error(
      `Codex review requires a verify/integrate task; got ${phase}`,
    );
  if (role === "execute" && phase !== "execute")
    throw new Error(
      `Codex execution requires an approved Execute task; got ${phase}`,
    );
}

function textFile(file: string): string {
  const content = fs.readFileSync(file, "utf8").trim();
  if (!content || content.length > 64 * 1024)
    throw new Error("Prompt file must contain 1 to 65536 characters");
  return content;
}

function roleBoundary(role: CodexBridgeRole): string {
  if (role === "plan")
    return "Planning may update Pactile planning artifacts, but must not edit product code or approve Execute.";
  if (role === "review")
    return "Review is read-only: inspect the change set and evidence, report findings, and do not alter code or declare acceptance.";
  return "Implement only the approved Execute contract and write set. Do not commit, integrate, archive, change Kernel approval, or declare acceptance.";
}

function recordRunBinding(
  store: CoordinationStore,
  context: BridgeTaskContext,
  selected: SelectedRun,
): void {
  if (context.kernelKind !== "task-kernel-v2" || !selected.runId) return;
  store.startRun({
    taskId: context.taskId,
    runId: selected.runId,
    role: null,
    workspaceId: null,
    providerRunId: null,
    actor: { platform: "pactile", id: "codex-bridge" },
    evidenceLevel: "local",
  });
}

function runContextLine(
  context: BridgeTaskContext,
  selected: SelectedRun,
  includeAuthorization = true,
): string {
  const parts = [
    `Task ID: ${context.taskId}`,
    `Task Kernel: ${context.kernelKind}`,
    `Kernel revision: ${context.revision}`,
  ];
  if (selected.runId) parts.push(`Run ID: ${selected.runId}`);
  if (selected.candidateSnapshotId && selected.candidateFingerprint) {
    parts.push(
      `Candidate snapshot: ${selected.candidateSnapshotId} (${selected.candidateFingerprint})`,
    );
  }
  if (
    includeAuthorization &&
    selected.run &&
    context.kernelKind === "task-kernel-v2"
  ) {
    parts.push(`Run authorization: ${selected.run.authorization.scope}`);
    if (selected.run.writeSetSnapshot.length) {
      parts.push(`Run write set: ${selected.run.writeSetSnapshot.join(", ")}`);
    }
  }
  return parts.join("\n");
}

function isRunBoundToContext(
  context: BridgeTaskContext,
  runId: string | null | undefined,
  candidateSnapshotId: string | null | undefined,
  candidateFingerprint: string | null | undefined,
): boolean {
  if (!runId) {
    return candidateSnapshotId == null && candidateFingerprint == null;
  }
  if (context.kernelKind !== "task-kernel-v2") return false;
  const run = context.runs.find((candidate) => candidate.id === runId);
  return Boolean(
    run &&
    (run.candidateSnapshot?.id ?? null) === (candidateSnapshotId ?? null) &&
    (run.candidateSnapshot?.fingerprint ?? null) ===
      (candidateFingerprint ?? null),
  );
}

function coordinationReceiptEvidence(
  value: string | undefined,
): "simulated" | "desktop-native" {
  if (value === undefined || value === "simulated") return "simulated";
  if (value === "desktop-native") return value;
  throw new Error("--evidence-level must be simulated or desktop-native");
}

function normalizeReplyEvidence(
  value: unknown,
  escalationId: string,
): NonNullable<CodexBridgeReceipt["reply_evidence"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Native read reply requires structured reply_evidence");
  }
  const evidence = value as Record<string, unknown>;
  const body = evidence.body;
  const responseTurnId = evidence.response_turn_id;
  const bodySha256 = evidence.body_sha256;
  if (
    evidence.reply_to_escalation_id !== escalationId ||
    typeof responseTurnId !== "string" ||
    !transportIdentifierPattern.test(responseTurnId) ||
    typeof body !== "string" ||
    body.trim() !== body ||
    Buffer.byteLength(body, "utf8") < 1 ||
    Buffer.byteLength(body, "utf8") > 4_096 ||
    escalationSecretPattern.test(body) ||
    typeof bodySha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(bodySha256) ||
    createHash("sha256").update(body, "utf8").digest("hex") !== bodySha256
  ) {
    throw new Error(
      "Native read reply evidence must match the escalation and bounded body hash",
    );
  }
  return {
    reply_to_escalation_id: escalationId,
    response_turn_id: responseTurnId,
    body,
    body_sha256: bodySha256,
  };
}

export function prepareCodexRequest(input: {
  root: string;
  task: string;
  tool: CodexBridgeTool;
  role?: CodexBridgeRole;
  threadId?: string;
  promptFile?: string;
  projectId?: string;
  targetType?: "project" | "projectless";
  environment?: "local" | "worktree";
  title?: string;
  timeoutMs?: number;
  runId?: string;
  toTask?: string;
  toRunId?: string;
  resumeExecute?: boolean;
  escalationId?: string;
  replyToEscalationId?: string;
}): CodexBridgeRequest {
  const context = taskContext(input.root, input.task);
  if (
    input.escalationId !== undefined &&
    !escalationIdPattern.test(input.escalationId)
  ) {
    throw new Error("--escalation-id must be pi-escalation:<Pi Run UUID>");
  }
  if (
    input.replyToEscalationId !== undefined &&
    !escalationIdPattern.test(input.replyToEscalationId)
  ) {
    throw new Error(
      "--reply-to-escalation-id must be pi-escalation:<Pi Run UUID>",
    );
  }
  if (input.escalationId && input.replyToEscalationId) {
    throw new Error("A Codex request cannot send and reply to an escalation");
  }
  if (input.escalationId && input.tool !== "send_message_to_thread") {
    throw new Error("--escalation-id is only valid for a Codex message");
  }
  if (input.replyToEscalationId && input.tool !== "read_thread") {
    throw new Error("--reply-to-escalation-id is only valid for a Codex read");
  }
  if (input.toTask && input.tool === "create_thread") {
    throw new Error("--to-task is only valid for cross-task message");
  }
  if (input.toRunId && !input.toTask) {
    throw new Error("--to-run-id requires --to-task");
  }
  if (input.toTask && !input.threadId) {
    throw new Error("cross-task requests require --thread-id");
  }
  const targetContext = input.toTask
    ? taskContext(input.root, input.toTask)
    : context;
  const crossTask = targetContext.taskId !== context.taskId;
  if (input.toTask && !crossTask) {
    throw new Error("--to-task must identify a different Pactile Task");
  }
  if (crossTask && input.tool !== "send_message_to_thread") {
    throw new Error(
      "--to-task is currently supported only for cross-task messages",
    );
  }
  if (
    input.resumeExecute &&
    (!crossTask || input.tool !== "send_message_to_thread")
  ) {
    throw new Error("--resume-execute is only valid for a cross-task message");
  }
  if (input.resumeExecute && targetContext.kernelKind !== "task-kernel-v2") {
    throw new Error(
      "--resume-execute requires a Task Kernel v2 destination Run",
    );
  }
  if (input.resumeExecute && targetContext.kernelKind === "task-kernel-v2") {
    throw new Error(
      "Task Kernel v2 --resume-execute dispatch is disabled until P37 admission, lease and Resume/block validation are connected",
    );
  }
  const coordinationToExecutingV2Task =
    crossTask &&
    input.tool === "send_message_to_thread" &&
    targetContext.kernelKind === "task-kernel-v2" &&
    targetContext.phase === "execute";
  const bound = input.threadId
    ? coordinationToExecutingV2Task
      ? coordinationBoundThread(targetContext, input.threadId)
      : boundThreads(targetContext.dir).get(input.threadId)
    : undefined;
  const role = input.tool === "create_thread" ? input.role : bound?.role;
  if (!role)
    throw new Error(
      input.tool === "create_thread"
        ? "--role plan|review|execute is required"
        : "Thread is not bound to this Pactile task",
    );
  if (role !== "plan" && role !== "review" && role !== "execute")
    throw new Error("Codex role must be plan, review or execute");
  if (
    input.tool === "send_message_to_thread" &&
    input.role &&
    input.role !== bound?.role
  ) {
    throw new Error("--role must match the bound Codex thread role");
  }
  if (
    !coordinationToExecutingV2Task &&
    (input.tool === "create_thread" || input.tool === "send_message_to_thread")
  ) {
    checkPhase(role, crossTask ? targetContext.phase : context.phase);
  }
  if (
    (input.tool === "wait_threads" || input.tool === "read_thread") &&
    input.promptFile
  ) {
    throw new Error("wait/read do not accept --prompt-file");
  }
  const prompt = input.promptFile ? textFile(input.promptFile) : null;
  if (crossTask && prompt && Buffer.byteLength(prompt, "utf8") > 4_096) {
    throw new Error(
      "cross-task message body must be at most 4096 bytes for the coordination journal",
    );
  }
  const executionDispatch =
    role === "execute" &&
    (input.tool === "create_thread" ||
      (input.tool === "send_message_to_thread" &&
        (!crossTask || input.resumeExecute === true)));
  const executionContext = crossTask ? targetContext : context;
  if (
    executionDispatch &&
    role === "execute" &&
    executionContext.kernelKind === "task-kernel-v2"
  ) {
    throw new Error(
      "Task Kernel v2 Execute dispatch is disabled until P37 admission, lease and Resume/block validation are connected",
    );
  }
  const selectedRun = selectRun(
    context,
    role,
    input.runId,
    executionDispatch && !crossTask,
  );
  const targetRun = crossTask
    ? selectRun(targetContext, role, input.toRunId, executionDispatch)
    : selectedRun;
  if (
    coordinationToExecutingV2Task &&
    (!targetRun.runId ||
      (targetRun.run?.state !== "running" &&
        targetRun.run?.state !== "waiting") ||
      (bound?.runId && bound.runId !== targetRun.runId))
  ) {
    throw new Error(
      "Coordination to an executing Task requires its current active Run and a Plan thread bound to that Task",
    );
  }
  if (input.escalationId) {
    const sourceRun = context.runs.at(-1);
    const review = context.reviews.at(-1);
    if (
      !crossTask ||
      context.kernelKind !== "task-kernel-v2" ||
      context.phase !== "verify" ||
      !input.runId ||
      sourceRun?.id !== input.runId ||
      sourceRun.state !== "completed" ||
      !sourceRun.candidateSnapshot ||
      selectedRun.runId !== sourceRun.id ||
      selectedRun.candidateSnapshotId !== sourceRun.candidateSnapshot.id ||
      selectedRun.candidateFingerprint !==
        sourceRun.candidateSnapshot.fingerprint ||
      !review ||
      review.decision === "pass" ||
      review.runId !== sourceRun.id ||
      review.candidateSnapshotId !== sourceRun.candidateSnapshot.id ||
      review.candidateFingerprint !== sourceRun.candidateSnapshot.fingerprint
    ) {
      throw new Error(
        "Codex escalation send requires the current V2 non-passing Review and candidate Run",
      );
    }
  }
  if (
    executionDispatch &&
    role === "execute" &&
    input.tool !== "wait_threads" &&
    (crossTask ? targetContext.kernelKind : context.kernelKind) ===
      "task-kernel-v2" &&
    !(crossTask ? input.toRunId : input.runId)
  ) {
    throw new Error(
      crossTask
        ? "Task Kernel v2 cross-task Execute dispatch requires an explicit --to-run-id"
        : "Task Kernel v2 Execute dispatch requires an explicit --run-id",
    );
  }
  if (
    executionDispatch &&
    role === "execute" &&
    (input.tool === "create_thread" || input.tool === "send_message_to_thread")
  ) {
    const dispatchContext = crossTask ? targetContext : context;
    const dispatchRun = crossTask ? targetRun.run : selectedRun.run;
    if (dispatchContext.kernelKind === "legacy-task-kernel-v1") {
      const dir = approvedExecuteTask(input.root, dispatchContext.task);
      if (fs.existsSync(path.join(dir, "implement.md"))) {
        const parsed = readStrategyContract(dir);
        if (parsed.errors.length)
          throw new Error(
            `Invalid execution contract: ${parsed.errors.join("; ")}`,
          );
      }
    } else if (
      !dispatchRun?.authorization.scope.trim() ||
      !dispatchRun.writeSetSnapshot.length
    ) {
      throw new Error(
        "Codex Execute dispatch requires a Task Kernel v2 Run with a scope and non-empty write set",
      );
    }
  }
  const executeScope =
    executionDispatch &&
    role === "execute" &&
    context.kernelKind === "legacy-task-kernel-v1" &&
    (input.tool === "create_thread" || input.tool === "send_message_to_thread")
      ? parallelChild(input.root, context.dir)
      : null;
  const runScope =
    executionDispatch &&
    role === "execute" &&
    (crossTask ? targetContext.kernelKind : context.kernelKind) ===
      "task-kernel-v2"
      ? crossTask
        ? targetRun.run
        : selectedRun.run
      : null;
  const scopeLine = executeScope
    ? `Parent-approved write set: ${executeScope.touches.join(", ")}. Integration owner: Parent.`
    : runScope
      ? `Task Run authorized scope: ${runScope.authorization.scope}. Approved write set: ${runScope.writeSetSnapshot.join(", ")}.`
      : "";
  let baseBranch: unknown = null;
  if (
    input.tool === "create_thread" &&
    context.kernelKind === "legacy-task-kernel-v1"
  ) {
    const record: unknown = JSON.parse(
      fs.readFileSync(path.join(context.dir, "task.json"), "utf8"),
    );
    baseBranch =
      record && typeof record === "object" && "base_branch" in record
        ? (record as { base_branch?: unknown }).base_branch
        : null;
  }
  if (
    executionDispatch &&
    role === "execute" &&
    baseBranch &&
    (typeof baseBranch !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(baseBranch) ||
      baseBranch.includes(".."))
  ) {
    throw new Error("Invalid approved base_branch for Codex Execute");
  }
  let args: Record<string, unknown>;
  if (input.tool === "create_thread") {
    if (!prompt) throw new Error("create requires --prompt-file");
    const targetType = input.targetType ?? "project";
    if (targetType !== "project" && targetType !== "projectless")
      throw new Error("--target must be project or projectless");
    if (
      targetType === "project" &&
      (!input.projectId ||
        !idPattern.test(input.projectId) ||
        !["local", "worktree"].includes(input.environment ?? ""))
    ) {
      throw new Error(
        "project create requires --project-id and --environment local|worktree",
      );
    }
    if (
      role === "execute" &&
      (targetType !== "project" || input.environment !== "worktree")
    )
      throw new Error("Codex Execute requires a project worktree");
    const target =
      targetType === "projectless"
        ? { type: "projectless" }
        : {
            type: "project",
            projectId: input.projectId,
            environment: {
              type: input.environment,
              ...(role === "execute" &&
              typeof baseBranch === "string" &&
              baseBranch
                ? { startingState: { type: "branch", branchName: baseBranch } }
                : {}),
            },
          };
    args = {
      prompt: `Pactile task: ${context.task}\nCanonical Pactile task directory: ${context.dir}\nCodex role: ${role}\n${runContextLine(context, selectedRun)}\nUse Pactile as the task lifecycle and evidence source. ${roleBoundary(role)} ${scopeLine} Do not change Kernel approval or claim acceptance from a message alone. Do not dispatch Codex subagents.\n\n${prompt}`,
      target,
      ...(input.title ? { title: input.title } : {}),
    };
  } else {
    if (!bound) throw new Error("Thread is not bound to this Pactile task");
    if (input.tool === "send_message_to_thread") {
      if (!prompt) throw new Error("message requires --prompt-file");
      if (
        executionDispatch &&
        role === "execute" &&
        bound.runId &&
        bound.runId !== (crossTask ? targetRun.runId : selectedRun.runId)
      ) {
        throw new Error(
          "Codex Execute thread is bound to a different Task Run",
        );
      }
      args = {
        threadId: bound.threadId,
        hostId: bound.hostId,
        prompt: crossTask
          ? input.resumeExecute
            ? `Pactile cross-task Execute dispatch from ${context.taskId} to ${targetContext.taskId}.\n${runContextLine(context, selectedRun, false)}\nRecipient ${runContextLine(targetContext, targetRun)}\n${roleBoundary(role)} ${scopeLine}\nDo not change Kernel approval or claim acceptance from this message. Do not dispatch Codex subagents.\n\n${prompt}`
            : `Pactile coordination-only message from ${context.taskId} to ${targetContext.taskId}. This message and any send receipt do not resume a Run, change Task state, grant Execute permission, or authorize file writes. Preserve any blocked or waiting state. Do not edit files, change approval, or dispatch Codex subagents; wait for an explicit Kernel Resume and P37 dispatch admission before executing.\n${runContextLine(context, selectedRun, false)}\nRecipient ${runContextLine(targetContext, targetRun, false)}\n\n${prompt}`
          : `Pactile task: ${context.task}\nCanonical Pactile task directory: ${context.dir}\n${runContextLine(context, selectedRun)}\n${roleBoundary(role)} ${scopeLine}\n\n${prompt}`,
      };
    } else if (input.tool === "wait_threads") {
      const timeoutMs = input.timeoutMs ?? 120_000;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000)
        throw new Error("wait timeout must be 0 to 120000 ms");
      const afterCursor = latestWaitCursor(context.dir, bound.threadId);
      args = {
        targets: [
          {
            threadId: bound.threadId,
            hostId: bound.hostId,
            ...(afterCursor ? { afterCursor } : {}),
          },
        ],
        timeoutMs,
      };
    } else {
      args = { threadId: bound.threadId, hostId: bound.hostId, turnLimit: 1 };
    }
  }
  const requestId = randomUUID();
  const request: CodexBridgeRequest = {
    schema_version: 1,
    request_id: requestId,
    task: context.task,
    task_id: context.taskId,
    task_kernel_kind: context.kernelKind,
    kernel_revision: context.revision,
    contract_fingerprint: context.contractFingerprint,
    run_id: selectedRun.runId,
    candidate_snapshot_id: selectedRun.candidateSnapshotId,
    candidate_fingerprint: selectedRun.candidateFingerprint,
    to_task: crossTask ? path.basename(targetContext.dir) : null,
    to_task_id: crossTask ? targetContext.taskId : null,
    to_kernel_revision: crossTask ? targetContext.revision : null,
    to_task_kernel_kind: crossTask ? targetContext.kernelKind : null,
    to_contract_fingerprint: crossTask
      ? targetContext.contractFingerprint
      : null,
    to_run_id: crossTask ? targetRun.runId : null,
    to_candidate_snapshot_id: crossTask ? targetRun.candidateSnapshotId : null,
    to_candidate_fingerprint: crossTask ? targetRun.candidateFingerprint : null,
    coordination_message_id:
      crossTask && input.tool === "send_message_to_thread" ? requestId : null,
    ...(input.escalationId ? { escalation_id: input.escalationId } : {}),
    ...(input.replyToEscalationId
      ? { reply_to_escalation_id: input.replyToEscalationId }
      : {}),
    created_at: new Date().toISOString(),
    tool: input.tool,
    role,
    thread_id: bound?.threadId ?? null,
    host_id: bound?.hostId ?? null,
    arguments: args,
    prompt_sha256: prompt
      ? createHash("sha256").update(prompt).digest("hex")
      : null,
  };
  request.request_fingerprint = codexRequestFingerprint(request);
  const release =
    context.kernelKind === "legacy-task-kernel-v1" &&
    role === "execute" &&
    input.tool === "create_thread"
      ? reserveParallelChild(input.root, context.dir, {
          id: request.request_id,
          durable: true,
        })
      : null;
  const coordination = new CoordinationStore(input.root);
  recordRunBinding(coordination, context, selectedRun);
  if (crossTask) recordRunBinding(coordination, targetContext, targetRun);
  try {
    writeNew(requestFile(context.dir, request.request_id), request);
  } catch (error) {
    release?.();
    throw error;
  }
  if (request.coordination_message_id && prompt) {
    coordination.createMessage({
      messageId: request.request_id,
      fromTaskId: context.taskId,
      toTaskId: targetContext.taskId,
      fromRunId: selectedRun.runId,
      toRunId: targetRun.runId,
      sender: { platform: "codex", id: "node-bridge" },
      evidenceLevel: "local",
      body: prompt,
      requestId: request.request_id,
      hostRef: bound?.threadId ?? null,
    });
  }
  return request;
}

export function recordCodexReceipt(
  root: string,
  task: string,
  requestId: string,
  resultFile: string,
  evidenceLevelInput?: "simulated" | "desktop-native",
): CodexBridgeReceipt {
  if (!uuidPattern.test(requestId)) throw new Error("Invalid request id");
  const context = taskContextIncludingArchive(root, task);
  if (context.archived) {
    throw new Error("Cannot record a new Codex receipt for an archived Task");
  }
  const request = readJson(
    requestFile(context.dir, requestId),
  ) as unknown as CodexBridgeRequest;
  if (
    request.request_id !== requestId ||
    (request.task_id && request.task_id !== context.taskId) ||
    request.task !== context.task
  ) {
    throw new Error("Request belongs to another task");
  }
  const requestFingerprint = codexRequestFingerprint(request);
  if (
    request.request_fingerprint !== undefined &&
    request.request_fingerprint !== requestFingerprint
  ) {
    throw new Error("Request fingerprint does not match its persisted content");
  }
  const result = readJson(resultFile);
  if (result.request_id !== requestId || result.tool !== request.tool)
    throw new Error("Receipt does not match the request");
  const evidenceLevel = coordinationReceiptEvidence(evidenceLevelInput);
  if (
    !["ok", "failed", "queued"].includes(String(result.outcome)) ||
    (result.outcome === "queued" && request.tool !== "create_thread")
  ) {
    throw new Error("Receipt outcome must be ok, failed or queued for create");
  }
  const successful = result.outcome === "ok";
  const threadId =
    typeof result.thread_id === "string" && idPattern.test(result.thread_id)
      ? result.thread_id
      : request.thread_id;
  const hostId =
    typeof result.host_id === "string" && idPattern.test(result.host_id)
      ? result.host_id
      : request.host_id;
  const clientThreadId =
    typeof result.client_thread_id === "string" &&
    idPattern.test(result.client_thread_id)
      ? result.client_thread_id
      : null;
  let threadCreationState: CodexBridgeReceipt["thread_creation_state"];
  if (request.tool === "create_thread") {
    const suppliedState = result.thread_creation_state;
    if (
      suppliedState !== undefined &&
      suppliedState !== "created" &&
      suppliedState !== "not_created" &&
      suppliedState !== "unknown"
    ) {
      throw new Error(
        "thread_creation_state must be created, not_created or unknown",
      );
    }
    if (successful) {
      if (suppliedState === "not_created" || suppliedState === "unknown") {
        throw new Error(
          "Successful create receipt cannot report thread_creation_state as not created or unknown",
        );
      }
      threadCreationState = "created";
    } else if (result.outcome === "queued") {
      if (suppliedState === "created" || suppliedState === "not_created") {
        throw new Error(
          "Queued create cannot establish whether a thread was created",
        );
      }
      threadCreationState = "unknown";
    } else {
      if (suppliedState === "created") {
        throw new Error(
          "Failed create receipt cannot report thread_creation_state as created",
        );
      }
      threadCreationState = suppliedState ?? "unknown";
      if (
        threadCreationState === "not_created" &&
        (threadId !== null ||
          clientThreadId !== null ||
          result.thread_id != null ||
          result.client_thread_id != null)
      ) {
        throw new Error(
          "not_created requires no thread_id or client_thread_id",
        );
      }
    }
  }
  if (successful && (!threadId || !hostId))
    throw new Error("Successful receipt requires thread_id and host_id");
  if (
    evidenceLevel === "desktop-native" &&
    successful &&
    (request.tool === "create_thread" || request.tool === "wait_threads") &&
    (result.thread_id !== threadId || result.host_id !== hostId)
  ) {
    throw new Error(
      "Desktop-native create/wait receipt must echo the native thread_id and host_id",
    );
  }
  if (
    evidenceLevel === "desktop-native" &&
    request.task_kernel_kind === "task-kernel-v2" &&
    request.role === "execute" &&
    request.tool === "wait_threads" &&
    !request.run_id
  ) {
    throw new Error(
      "Desktop-native Execute wait receipts require an explicit --run-id",
    );
  }
  if (result.outcome === "queued" && (!clientThreadId || threadId))
    throw new Error(
      "Queued create requires client_thread_id without thread_id",
    );
  if (
    request.thread_id &&
    (threadId !== request.thread_id || hostId !== request.host_id)
  )
    throw new Error("Receipt thread identity changed");
  const queuedPath = queuedFile(context.dir, requestId);
  if (
    fs.existsSync(queuedPath) &&
    result.outcome !== "queued" &&
    readJson(queuedPath).client_thread_id !== clientThreadId
  ) {
    throw new Error("Ready receipt must match the queued client_thread_id");
  }
  const status =
    typeof result.status === "string" && result.status.length <= 80
      ? result.status
      : null;
  if (request.escalation_id) {
    if (
      request.tool !== "send_message_to_thread" ||
      request.reply_to_escalation_id ||
      evidenceLevel !== "desktop-native" ||
      !request.to_task_id ||
      !request.thread_id ||
      !request.host_id ||
      (successful &&
        (result.thread_id !== request.thread_id ||
          result.host_id !== request.host_id))
    ) {
      throw new Error(
        "Pi escalation send requires a desktop-native cross-task message receipt bound to its Task and thread",
      );
    }
  }
  let replyEvidence: CodexBridgeReceipt["reply_evidence"];
  if (request.reply_to_escalation_id) {
    if (
      request.tool !== "read_thread" ||
      request.escalation_id ||
      evidenceLevel !== "desktop-native" ||
      !request.thread_id ||
      !request.host_id
    ) {
      throw new Error(
        "Escalation reply requires a desktop-native read_thread request bound to its Task and thread",
      );
    }
    if (successful) {
      if (
        status !== "completed" ||
        result.reply_to_escalation_id !== request.reply_to_escalation_id ||
        result.thread_id !== request.thread_id ||
        result.host_id !== request.host_id
      ) {
        throw new Error(
          "Native escalation reply read must complete on the bound thread with exact escalation correlation",
        );
      }
      replyEvidence = normalizeReplyEvidence(
        result.reply_evidence,
        request.reply_to_escalation_id,
      );
    }
  }
  if (
    successful &&
    request.tool === "wait_threads" &&
    !["completed", "needs_attention", "timeout"].includes(status ?? "")
  ) {
    throw new Error(
      "Wait receipt requires completed, needs_attention or timeout status",
    );
  }
  const reason =
    typeof result.reason === "string" && result.reason.length <= 500
      ? result.reason
      : null;
  if (result.outcome === "failed" && !reason)
    throw new Error("Failed receipt requires a short reason");
  const cursor =
    typeof result.cursor === "string" && result.cursor.length <= 2048
      ? result.cursor
      : null;
  let destinationContext: BridgeTaskContext | null = null;
  if (request.to_task) {
    try {
      destinationContext = taskContextIncludingArchive(root, request.to_task);
    } catch {
      destinationContext = null;
    }
  }
  const sourceStale =
    context.archived ||
    context.revision !== request.kernel_revision ||
    (request.task_id !== undefined && request.task_id !== context.taskId) ||
    (request.task_kernel_kind !== undefined &&
      request.task_kernel_kind !== context.kernelKind) ||
    (request.contract_fingerprint !== undefined &&
      request.contract_fingerprint !== context.contractFingerprint) ||
    !isRunBoundToContext(
      context,
      request.run_id,
      request.candidate_snapshot_id,
      request.candidate_fingerprint,
    );
  const destinationStale =
    Boolean(request.to_task) &&
    (!destinationContext ||
      destinationContext.archived ||
      destinationContext.taskId !== request.to_task_id ||
      destinationContext.revision !== request.to_kernel_revision ||
      destinationContext.kernelKind !== request.to_task_kernel_kind ||
      destinationContext.contractFingerprint !==
        request.to_contract_fingerprint ||
      !isRunBoundToContext(
        destinationContext,
        request.to_run_id,
        request.to_candidate_snapshot_id,
        request.to_candidate_fingerprint,
      ));
  const contractStale = sourceStale || destinationStale;
  const receipt: CodexBridgeReceipt = {
    schema_version: 1,
    request_id: requestId,
    task_id: context.taskId,
    run_id: request.run_id ?? null,
    candidate_snapshot_id: request.candidate_snapshot_id ?? null,
    candidate_fingerprint: request.candidate_fingerprint ?? null,
    to_task_id: request.to_task_id ?? null,
    to_run_id: request.to_run_id ?? null,
    to_candidate_snapshot_id: request.to_candidate_snapshot_id ?? null,
    to_candidate_fingerprint: request.to_candidate_fingerprint ?? null,
    destination_kernel_revision_at_receipt:
      destinationContext?.revision ?? null,
    request_fingerprint: requestFingerprint,
    evidence_level: evidenceLevel,
    ...(request.escalation_id ? { escalation_id: request.escalation_id } : {}),
    ...(request.reply_to_escalation_id
      ? { reply_to_escalation_id: request.reply_to_escalation_id }
      : {}),
    ...(replyEvidence ? { reply_evidence: replyEvidence } : {}),
    ...(threadCreationState
      ? { thread_creation_state: threadCreationState }
      : {}),
    tool: request.tool,
    outcome: result.outcome as "ok" | "failed" | "queued",
    thread_id: threadId,
    client_thread_id: clientThreadId,
    host_id: hostId,
    status,
    cursor,
    reason,
    kernel_revision_at_receipt: context.revision,
    contract_stale: contractStale,
    recorded_at: new Date().toISOString(),
    assurance: "host-reported",
  };
  writeNew(
    result.outcome === "queued"
      ? queuedPath
      : receiptFile(context.dir, requestId),
    receipt,
  );
  if (
    request.task_kernel_kind !== "task-kernel-v2" &&
    request.role === "execute" &&
    request.tool === "create_thread" &&
    result.outcome === "failed"
  ) {
    releaseParallelChild(root, context.dir, requestId);
  }
  if (
    request.task_kernel_kind !== "task-kernel-v2" &&
    request.role === "execute" &&
    request.tool === "wait_threads" &&
    result.outcome === "ok" &&
    status === "completed"
  ) {
    const create = requests(context.dir).find(
      (candidate) =>
        candidate.tool === "create_thread" &&
        candidate.role === "execute" &&
        fs.existsSync(receiptFile(context.dir, candidate.request_id)) &&
        readJson(receiptFile(context.dir, candidate.request_id)).thread_id ===
          threadId,
    );
    if (create) releaseParallelChild(root, context.dir, create.request_id);
  }
  if (!contractStale) {
    const coordination = new CoordinationStore(root);
    if (
      request.coordination_message_id &&
      request.tool === "send_message_to_thread"
    ) {
      coordination.recordMessageReceipt({
        messageId: request.coordination_message_id,
        receiptId: requestId,
        status: result.outcome === "ok" ? "sent" : "failed",
        actor: { platform: "codex", id: hostId ?? "desktop" },
        evidenceLevel,
        externalRef: threadId,
        note:
          result.outcome === "failed"
            ? reason
            : "Host reported send accepted; recipient delivery is not confirmed.",
      });
    }
    if (request.task_kernel_kind === "task-kernel-v2" && request.run_id) {
      const coordinatedRun = coordination
        .snapshot()
        .runs.find(
          (run) =>
            run.started.task_id === context.taskId &&
            run.started.run_id === request.run_id,
        );
      if (coordinatedRun && !coordinatedRun.result) {
        const requestRef = path
          .relative(root, requestFile(context.dir, requestId))
          .replaceAll("\\", "/");
        const receiptRef = path
          .relative(root, receiptFile(context.dir, requestId))
          .replaceAll("\\", "/");
        const sequence = (coordinatedRun.progress.at(-1)?.sequence ?? -1) + 1;
        coordination.recordRunProgress({
          taskId: context.taskId,
          runId: request.run_id,
          sequence,
          name: `codex.${request.tool.replaceAll("_", ".")}.${receipt.outcome}`,
          summary: `Codex bridge host-reported ${request.tool} receipt: ${receipt.outcome}${status ? ` (${status})` : ""}${reason ? `: ${reason}` : ""}`,
          evidenceRefs: [requestRef, receiptRef],
          actor: { platform: "codex", id: hostId ?? "desktop" },
          evidenceLevel,
        });
      }
    }
  }
  return receipt;
}

export function codexBridgeStatus(
  root: string,
  task: string,
): {
  task: string;
  task_id: string;
  task_kernel_kind: CodexTaskKernelKind;
  archived: boolean;
  phase: string;
  kernel_revision: number;
  threads: BoundThread[];
  pending: PendingCodexRequest[];
  queued: CodexBridgeReceipt[];
  receipts: CodexBridgeReceipt[];
  coordination: {
    messages: {
      message_id: string;
      from_task_id: string;
      to_task_id: string;
      from_run_id: string | null;
      to_run_id: string | null;
      status: string;
      request_id: string | null;
      host_ref: string | null;
      evidence_level: CoordinationEvidenceLevel;
      recorded_at: string;
    }[];
    blocked_tasks: CoordinationTaskBlocked[];
    task_events: (CoordinationTaskBlocked | CoordinationTaskUnblocked)[];
    runs: ReturnType<CoordinationStore["snapshot"]>["runs"];
  };
} {
  const context = taskContextIncludingArchive(root, task);
  const all = requests(context.dir);
  const receipts = all.flatMap((request) => {
    const file = receiptFile(context.dir, request.request_id);
    return fs.existsSync(file)
      ? [readJson(file) as unknown as CodexBridgeReceipt]
      : [];
  });
  const completed = new Set(receipts.map((receipt) => receipt.request_id));
  const queued = all.flatMap((request) => {
    const file = queuedFile(context.dir, request.request_id);
    return fs.existsSync(file) && !completed.has(request.request_id)
      ? [readJson(file) as unknown as CodexBridgeReceipt]
      : [];
  });
  const coordinated = new CoordinationStore(root).snapshot();
  const taskEvents = coordinated.events.filter(
    (event): event is CoordinationTaskBlocked | CoordinationTaskUnblocked =>
      (event.type === "task.blocked" || event.type === "task.unblocked") &&
      event.task_id === context.taskId,
  );
  return {
    task: context.task,
    task_id: context.taskId,
    task_kernel_kind: context.kernelKind,
    archived: context.archived,
    phase: context.phase,
    kernel_revision: context.revision,
    threads: [...boundThreads(context.dir).values()],
    pending: all
      .filter((request) => !completed.has(request.request_id))
      .map(
        ({
          request_id,
          tool,
          role,
          thread_id,
          kernel_revision,
          created_at,
          prompt_sha256,
        }) => ({
          request_id,
          tool,
          role,
          thread_id,
          kernel_revision,
          created_at,
          prompt_sha256,
        }),
      ),
    queued,
    receipts,
    coordination: {
      messages: coordinated.messages
        .filter(
          ({ message }) =>
            message.from_task_id === context.taskId ||
            message.to_task_id === context.taskId,
        )
        .map(({ message, status, receipts: messageReceipts }) => ({
          message_id: message.message_id,
          from_task_id: message.from_task_id,
          to_task_id: message.to_task_id,
          from_run_id: message.from_run_id,
          to_run_id: message.to_run_id,
          status,
          request_id: message.request_id,
          host_ref: message.host_ref,
          evidence_level:
            messageReceipts.at(-1)?.evidence_level ?? message.evidence_level,
          recorded_at: message.recorded_at,
        })),
      blocked_tasks: coordinated.blocked_tasks.filter(
        (event) => event.task_id === context.taskId,
      ),
      task_events: taskEvents,
      runs: coordinated.runs.filter(
        ({ started }) => started.task_id === context.taskId,
      ),
    },
  };
}

export function blockCodexTask(
  root: string,
  task: string,
  input: {
    messageId?: string;
    blockedByTaskId?: string | null;
    reason: string;
    actorId?: string | null;
  },
): CoordinationTaskBlocked {
  const context = taskContext(root, task);
  const coordination = new CoordinationStore(root);
  let blockedByTaskId = input.blockedByTaskId ?? null;
  let evidenceLevel: CoordinationEvidenceLevel = "local";
  if (input.messageId) {
    const messageEntry = coordination
      .snapshot()
      .messages.find(
        (candidate) => candidate.message.message_id === input.messageId,
      );
    if (messageEntry?.message.to_task_id !== context.taskId) {
      throw new Error("block message must be addressed to this Task");
    }
    const sendReceipt = messageEntry.receipts.at(-1);
    if (
      !sendReceipt ||
      !new Set(["sent", "delivered", "acknowledged"]).has(sendReceipt.status)
    ) {
      throw new Error(
        "block message requires a non-stale successful send receipt",
      );
    }
    const verified = verifyFreshCoordinationMessage(
      root,
      messageEntry,
      context,
      false,
    );
    evidenceLevel = verified.evidenceLevel;
    if (
      messageEntry.message.to_run_id &&
      context.kernelKind === "task-kernel-v2"
    ) {
      const run = context.runs.find(
        (candidate) => candidate.id === messageEntry.message.to_run_id,
      );
      if (!run || (run.state !== "running" && run.state !== "waiting")) {
        throw new Error("block message Run is no longer active on this Task");
      }
    }
    blockedByTaskId ??= messageEntry.message.from_task_id;
  }
  return coordination.blockTaskWithPrecondition(
    {
      taskId: context.taskId,
      blockedByTaskId,
      messageId: input.messageId ?? null,
      reason: input.reason,
      actor: { platform: "user", id: input.actorId ?? null },
      evidenceLevel,
    },
    (_event, snapshot) => {
      const currentContext = taskContext(root, task);
      if (
        currentContext.taskId !== context.taskId ||
        currentContext.revision !== context.revision
      ) {
        throw new Error("Task changed while the coordination block was added");
      }
      if (!input.messageId) return;
      const messageEntry = snapshot.messages.find(
        (candidate) => candidate.message.message_id === input.messageId,
      );
      if (messageEntry?.message.to_task_id !== context.taskId) {
        throw new Error("block message must be addressed to this Task");
      }
      const verified = verifyFreshCoordinationMessage(
        root,
        messageEntry,
        currentContext,
        false,
      );
      if (verified.evidenceLevel !== evidenceLevel) {
        throw new Error("block message receipt changed while adding the block");
      }
      if (
        messageEntry.message.from_task_id !== blockedByTaskId ||
        (messageEntry.message.to_run_id &&
          currentContext.kernelKind === "task-kernel-v2" &&
          !currentContext.runs.some(
            (run) =>
              run.id === messageEntry.message.to_run_id &&
              (run.state === "running" || run.state === "waiting"),
          ))
      ) {
        throw new Error("block message Run is no longer active on this Task");
      }
    },
  );
}

export function unblockCodexTask(
  root: string,
  task: string,
  input: {
    blockId: string;
    unblockedByTaskId?: string | null;
    resolutionMessageId?: string | null;
    reason: string;
    actorId?: string | null;
  },
): CoordinationTaskUnblocked {
  const context = taskContext(root, task);
  const coordination = new CoordinationStore(root);
  let unblockedByTaskId = input.unblockedByTaskId ?? null;
  let evidenceLevel: CoordinationEvidenceLevel = "local";
  let resolutionEntry: CoordinationMessageEntry | undefined;
  let resolutionSourceTaskId: string | null = null;
  if (input.resolutionMessageId) {
    resolutionEntry = coordination
      .snapshot()
      .messages.find(
        (candidate) =>
          candidate.message.message_id === input.resolutionMessageId,
      );
    if (resolutionEntry?.message.to_task_id !== context.taskId) {
      throw new Error("resolution message must be addressed to this Task");
    }
    if (!resolutionEntry) throw new Error("Resolution message disappeared");
    const sendReceipt = resolutionEntry.receipts.at(-1);
    if (
      !sendReceipt ||
      !new Set(["sent", "delivered", "acknowledged"]).has(sendReceipt.status)
    ) {
      throw new Error(
        "unblock requires a non-stale successful resolution receipt",
      );
    }
    if (sendReceipt.evidence_level !== "desktop-native") {
      throw new Error(
        "unblock requires a successful desktop-native resolution receipt",
      );
    }
    const verified = verifyFreshCoordinationMessage(
      root,
      resolutionEntry,
      context,
      true,
    );
    evidenceLevel = verified.evidenceLevel;
    resolutionSourceTaskId = resolutionEntry.message.from_task_id;
    unblockedByTaskId ??= resolutionSourceTaskId;
  }

  const barrier = coordinationKernelBarrier(context);
  return coordination.unblockTaskWithPostcondition(
    {
      taskId: context.taskId,
      blockId: input.blockId,
      unblockedByTaskId,
      resolutionMessageId: input.resolutionMessageId ?? null,
      runId: barrier.runId,
      kernelRevisionAtUnblock: barrier.kernelRevision,
      kernelEventIdAtUnblock: barrier.kernelEventId,
      reason: input.reason,
      actor: { platform: "user", id: input.actorId ?? null },
      evidenceLevel,
    },
    () => {
      const afterContext = taskContext(root, task);
      if (
        afterContext.taskId !== context.taskId ||
        afterContext.revision !== context.revision
      ) {
        throw new Error(
          "Task Kernel changed while the coordination block was cleared",
        );
      }
      if (input.resolutionMessageId) {
        const afterEntry = coordination
          .snapshot()
          .messages.find(
            (candidate) =>
              candidate.message.message_id === input.resolutionMessageId,
          );
        if (!afterEntry) throw new Error("Resolution message disappeared");
        const beforeEntry = resolutionEntry;
        if (!beforeEntry) throw new Error("Resolution message disappeared");
        const afterVerified = verifyFreshCoordinationMessage(
          root,
          afterEntry,
          afterContext,
          true,
        );
        const beforeVerified = verifyFreshCoordinationMessage(
          root,
          beforeEntry,
          context,
          true,
        );
        if (
          afterVerified.sourceContext.revision !==
            beforeVerified.sourceContext.revision ||
          afterVerified.sourceContext.taskId !==
            beforeVerified.sourceContext.taskId
        ) {
          throw new Error(
            "Resolution source Task changed while the block was cleared",
          );
        }
      }
    },
    {
      taskId: context.taskId,
      blockId: randomUUID(),
      blockedByTaskId: resolutionSourceTaskId,
      messageId: null,
      reason:
        "Task or Run state changed while clearing the coordination block; obtain a fresh resolution.",
      actor: { platform: "user", id: input.actorId ?? null },
      evidenceLevel: "local",
    },
  );
}
