import fs from "node:fs";
import path from "node:path";
import { fingerprintTaskValue, readTaskKernel } from "../../core/task/index.js";

type TerminalWaitStatus = "completed" | "needs_attention" | "timeout";

type JsonObject = Record<string, unknown>;

interface HostStopRequest extends JsonObject {
  request_id: string;
  request_fingerprint?: string;
  task_id: string;
  task_kernel_kind: "task-kernel-v2";
  kernel_revision: number;
  contract_fingerprint: string;
  run_id: string;
  candidate_snapshot_id: string | null;
  candidate_fingerprint: string | null;
  tool: string;
  role: string;
  thread_id: string | null;
  host_id: string | null;
}

interface HostStopReceiptFile extends JsonObject {
  schema_version: 1;
  request_id: string;
  request_fingerprint?: string;
  task_id: string;
  run_id: string | null;
  candidate_snapshot_id: string | null;
  candidate_fingerprint: string | null;
  evidence_level: "simulated" | "desktop-native";
  tool: string;
  outcome: "ok" | "failed" | "queued";
  status: TerminalWaitStatus | string | null;
  thread_id: string | null;
  host_id: string | null;
  kernel_revision_at_receipt: number;
  contract_stale: boolean;
  recorded_at: string;
  assurance: "host-reported";
}

/** A Codex host terminal fact linked to the immutable Task Run and its captured candidate. */
export interface CodexHostStopReceipt {
  source: "codex-desktop-bridge";
  assurance: "host-reported";
  evidenceLevel: "simulated" | "desktop-native";
  taskId: string;
  runId: string;
  sessionId: string | null;
  threadId: string;
  startRequestId: string;
  settleReceiptId: string;
  terminalStatus: TerminalWaitStatus;
  requestKernelRevision: number;
  receiptKernelRevision: number;
  contractFingerprint: string;
  contractStale: boolean;
  candidateSnapshotId: string | null;
  candidateFingerprint: string | null;
  receiptRef: string;
  evidenceRef: string;
  recordedAt: string;
  receiptId: string;
  hostId: string;
  createRequestId: string;
  createRequestRef: string;
  createReceiptId: string;
  createReceiptRef: string;
  waitRequestId: string;
  waitRequestRef: string;
  waitReceiptId: string;
  waitReceiptRef: string;
  candidateSource: "captured" | "derived" | null;
  currentKernelRevision: number;
  kernelStopReceiptRecorded: boolean;
  /** Only grants release of the Codex writer lease, never worktree reclamation. */
  dispatchLeaseReleaseEligible: boolean;
}

const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const taskRunIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readObject(file: string): JsonObject | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function asRequest(value: JsonObject | null): HostStopRequest | null {
  if (
    value?.schema_version !== 1 ||
    typeof value.request_id !== "string" ||
    !requestIdPattern.test(value.request_id) ||
    (value.request_fingerprint !== undefined &&
      (typeof value.request_fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.request_fingerprint))) ||
    typeof value.task_id !== "string" ||
    value.task_kernel_kind !== "task-kernel-v2" ||
    !Number.isInteger(value.kernel_revision) ||
    typeof value.contract_fingerprint !== "string" ||
    typeof value.run_id !== "string" ||
    !taskRunIdPattern.test(value.run_id) ||
    !(
      value.candidate_snapshot_id === null ||
      typeof value.candidate_snapshot_id === "string"
    ) ||
    !(
      value.candidate_fingerprint === null ||
      typeof value.candidate_fingerprint === "string"
    ) ||
    typeof value.tool !== "string" ||
    typeof value.role !== "string" ||
    !(value.thread_id === null || typeof value.thread_id === "string") ||
    !(value.host_id === null || typeof value.host_id === "string")
  ) {
    return null;
  }
  return value as HostStopRequest;
}

function asReceipt(value: JsonObject | null): HostStopReceiptFile | null {
  if (
    value?.schema_version !== 1 ||
    typeof value.request_id !== "string" ||
    !requestIdPattern.test(value.request_id) ||
    (value.request_fingerprint !== undefined &&
      (typeof value.request_fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.request_fingerprint))) ||
    typeof value.task_id !== "string" ||
    !(value.run_id === null || typeof value.run_id === "string") ||
    !(
      value.candidate_snapshot_id === null ||
      typeof value.candidate_snapshot_id === "string"
    ) ||
    !(
      value.candidate_fingerprint === null ||
      typeof value.candidate_fingerprint === "string"
    ) ||
    !(
      value.evidence_level === "simulated" ||
      value.evidence_level === "desktop-native"
    ) ||
    typeof value.tool !== "string" ||
    !(
      value.outcome === "ok" ||
      value.outcome === "failed" ||
      value.outcome === "queued"
    ) ||
    !(value.status === null || typeof value.status === "string") ||
    !(value.thread_id === null || typeof value.thread_id === "string") ||
    !(value.host_id === null || typeof value.host_id === "string") ||
    !Number.isInteger(value.kernel_revision_at_receipt) ||
    typeof value.contract_stale !== "boolean" ||
    typeof value.recorded_at !== "string" ||
    value.assurance !== "host-reported"
  ) {
    return null;
  }
  return value as HostStopReceiptFile;
}

function relativeRef(root: string, file: string): string {
  return path.relative(root, file).replaceAll("\\", "/");
}

function safeProjectTaskDir(root: string, taskDir: string): string {
  const projectRoot = fs.realpathSync(root);
  const tasksRoot = fs.realpathSync(
    path.join(projectRoot, ".pactile", "tasks"),
  );
  const requested = path.resolve(
    path.isAbsolute(taskDir) ? taskDir : path.join(projectRoot, taskDir),
  );
  const realTask = fs.realpathSync(requested);
  const relative = path.relative(tasksRoot, realTask);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      "Codex host stop receipt Task must be an active task under .pactile/tasks",
    );
  }
  return realTask;
}

function hasRef(refs: unknown, ref: string): boolean {
  return Array.isArray(refs) && refs.includes(ref);
}

function requestFingerprint(request: HostStopRequest): string {
  const { request_fingerprint: _stored, ...payload } = request;
  return fingerprintTaskValue(payload);
}

/**
 * Reads durable Codex wait receipts and validates them against the native create,
 * current Task Run host binding, captured candidate, and settlement refs. The
 * result is host-stop evidence; eligibility only releases the dispatch lease.
 * Worktree cleanup has additional Run, Review, Close, workspace and cleanliness gates.
 */
export function readCodexHostStopReceipts(
  root: string,
  taskDir: string,
  runId: string,
): CodexHostStopReceipt[] {
  if (!taskRunIdPattern.test(runId)) throw new Error("Invalid Task Run id");
  const resolvedRoot = fs.realpathSync(root);
  const resolvedTask = safeProjectTaskDir(resolvedRoot, taskDir);
  const read = readTaskKernel({
    root: resolvedRoot,
    taskDir: resolvedTask,
    cwd: resolvedRoot,
  });
  if (read.kind !== "task-kernel-v2") return [];
  const kernel = read.kernel;
  const run = kernel.runs.find((candidate) => candidate.id === runId);
  if (!run?.host) return [];
  const host = run.host as unknown as JsonObject;
  if (
    host.host !== "codex-desktop" ||
    typeof host.hostId !== "string" ||
    typeof host.threadId !== "string" ||
    host.assuranceSource !== "codex-desktop-native"
  ) {
    return [];
  }
  const contractFingerprint = fingerprintTaskValue(kernel.definition);
  const bridge = path.join(resolvedTask, "codex-bridge");
  const requestDir = path.join(bridge, "requests");
  const receiptDir = path.join(bridge, "receipts");
  if (!fs.existsSync(requestDir) || !fs.existsSync(receiptDir)) return [];
  const requestFiles = fs
    .readdirSync(requestDir)
    .filter(
      (name) =>
        requestIdPattern.test(name.replace(/\.json$/i, "")) &&
        name.endsWith(".json"),
    );
  const requests = requestFiles.flatMap((name) => {
    const request = asRequest(readObject(path.join(requestDir, name)));
    return request ? [request] : [];
  });
  const createRequests = requests.filter(
    (request) =>
      request.task_id === kernel.identity.taskId &&
      request.run_id === runId &&
      request.request_fingerprint === requestFingerprint(request) &&
      request.tool === "create_thread" &&
      request.role === "execute" &&
      request.thread_id === null &&
      request.host_id === null,
  );
  const result: CodexHostStopReceipt[] = [];

  for (const waitRequest of requests) {
    if (
      waitRequest.task_id !== kernel.identity.taskId ||
      waitRequest.run_id !== runId ||
      !waitRequest.request_fingerprint ||
      waitRequest.request_fingerprint !== requestFingerprint(waitRequest) ||
      waitRequest.tool !== "wait_threads" ||
      waitRequest.role !== "execute" ||
      waitRequest.thread_id !== host.threadId ||
      waitRequest.host_id !== host.hostId
    ) {
      continue;
    }
    const waitReceiptPath = path.join(
      receiptDir,
      `${waitRequest.request_id}.json`,
    );
    const waitReceipt = asReceipt(readObject(waitReceiptPath));
    if (
      waitReceipt?.request_id !== waitRequest.request_id ||
      waitReceipt.request_fingerprint !== waitRequest.request_fingerprint ||
      waitReceipt.task_id !== kernel.identity.taskId ||
      waitReceipt.run_id !== runId ||
      waitReceipt.tool !== "wait_threads" ||
      waitReceipt.outcome !== "ok" ||
      !["completed", "needs_attention", "timeout"].includes(
        waitReceipt.status ?? "",
      ) ||
      waitReceipt.thread_id !== host.threadId ||
      waitReceipt.host_id !== host.hostId ||
      waitReceipt.candidate_snapshot_id !== waitRequest.candidate_snapshot_id ||
      waitReceipt.candidate_fingerprint !== waitRequest.candidate_fingerprint
    ) {
      continue;
    }
    const createRequest = createRequests.find(
      (candidate) =>
        candidate.request_id !== waitRequest.request_id &&
        host.requestRefs instanceof Array &&
        host.requestRefs.includes(candidate.request_id) &&
        (candidate.candidate_snapshot_id === null ||
          candidate.candidate_snapshot_id === run.candidateSnapshot?.id) &&
        (candidate.candidate_fingerprint === null ||
          candidate.candidate_fingerprint ===
            run.candidateSnapshot?.fingerprint),
    );
    if (!createRequest) continue;
    const createReceiptPath = path.join(
      receiptDir,
      `${createRequest.request_id}.json`,
    );
    const createReceipt = asReceipt(readObject(createReceiptPath));
    if (
      createReceipt?.request_id !== createRequest.request_id ||
      createReceipt.request_fingerprint !== createRequest.request_fingerprint ||
      createReceipt.task_id !== kernel.identity.taskId ||
      createReceipt.run_id !== runId ||
      createReceipt.tool !== "create_thread" ||
      createReceipt.outcome !== "ok" ||
      createReceipt.kernel_revision_at_receipt !==
        createRequest.kernel_revision ||
      createReceipt.contract_stale ||
      createReceipt.thread_id !== host.threadId ||
      createReceipt.host_id !== host.hostId ||
      !hasRef(host.resultRefs, relativeRef(resolvedRoot, createReceiptPath))
    ) {
      continue;
    }
    const waitRequestRef = relativeRef(
      resolvedRoot,
      path.join(requestDir, `${waitRequest.request_id}.json`),
    );
    const waitReceiptRef = relativeRef(resolvedRoot, waitReceiptPath);
    const settlementKey = `codex-bridge-wait:${waitRequest.request_id}`;
    const settlementFingerprint = fingerprintTaskValue({
      runId,
      additions: {
        requestRefs: [waitRequest.request_id],
        eventRefs: [waitRequest.request_id],
        resultRefs: [waitReceiptRef],
      },
    });
    const settlementEvent = kernel.events.find(
      (event) =>
        String(event.type) === "run.host-settlement-recorded" &&
        event.entityId === runId &&
        event.idempotencyKey === settlementKey &&
        event.requestFingerprint === settlementFingerprint,
    );
    const hostBoundEvent = kernel.events.find(
      (event) =>
        String(event.type) === "run.host-bound" && event.entityId === runId,
    );
    const storedStopReceipt = isRecord(host.stopReceipt)
      ? host.stopReceipt
      : null;
    const stopEvent = [...kernel.events]
      .reverse()
      .find(
        (event) =>
          String(event.type) === "run.host-settled" && event.entityId === runId,
      );
    const hasCapturedCandidate =
      typeof waitRequest.candidate_snapshot_id === "string" &&
      typeof waitRequest.candidate_fingerprint === "string";
    const candidatePairIsValid =
      (waitRequest.candidate_snapshot_id === null &&
        waitRequest.candidate_fingerprint === null) ||
      hasCapturedCandidate;
    const completionEvent = kernel.events.find(
      (event) =>
        event.type === "run.completed" &&
        event.entityId === runId &&
        settlementEvent !== undefined &&
        event.revision > settlementEvent.revision,
    );
    let candidateSource: CodexHostStopReceipt["candidateSource"] = null;
    let candidateBindingStale = !candidatePairIsValid;
    if (hasCapturedCandidate) {
      candidateSource = "captured";
      candidateBindingStale ||= Boolean(
        waitRequest.candidate_snapshot_id !== run.candidateSnapshot?.id ||
        waitRequest.candidate_fingerprint !== run.candidateSnapshot.fingerprint,
      );
    } else if (run.candidateSnapshot) {
      const derivedAfterWait = Boolean(
        run.state === "completed" && run.completedAt && completionEvent,
      );
      candidateSource = derivedAfterWait ? "derived" : null;
      candidateBindingStale = !derivedAfterWait;
    }
    const candidateSnapshotId =
      candidateSource === "captured"
        ? waitRequest.candidate_snapshot_id
        : candidateSource === "derived"
          ? (run.candidateSnapshot?.id ?? null)
          : null;
    const candidateFingerprint =
      candidateSource === "captured"
        ? waitRequest.candidate_fingerprint
        : candidateSource === "derived"
          ? (run.candidateSnapshot?.fingerprint ?? null)
          : null;
    const stopReceiptFingerprint = storedStopReceipt
      ? fingerprintTaskValue({ runId, receipt: storedStopReceipt })
      : null;
    const stopReceiptWasStored = Boolean(
      storedStopReceipt &&
      stopEvent?.requestFingerprint === stopReceiptFingerprint &&
      storedStopReceipt.source === "codex-desktop-bridge" &&
      storedStopReceipt.assurance === "host-reported" &&
      storedStopReceipt.evidenceLevel === "desktop-native" &&
      storedStopReceipt.taskId === kernel.identity.taskId &&
      storedStopReceipt.runId === runId &&
      storedStopReceipt.sessionId === null &&
      storedStopReceipt.threadId === host.threadId &&
      storedStopReceipt.startRequestId === createRequest.request_id &&
      storedStopReceipt.settleReceiptId === waitRequest.request_id &&
      storedStopReceipt.terminalStatus === "completed" &&
      storedStopReceipt.requestKernelRevision === waitRequest.kernel_revision &&
      storedStopReceipt.receiptKernelRevision ===
        waitReceipt.kernel_revision_at_receipt &&
      storedStopReceipt.receiptRef === waitReceiptRef &&
      storedStopReceipt.evidenceRef === waitReceiptRef &&
      storedStopReceipt.contractFingerprint === contractFingerprint &&
      storedStopReceipt.contractStale === false &&
      storedStopReceipt.candidateSource === candidateSource &&
      storedStopReceipt.candidateSnapshotId === candidateSnapshotId &&
      storedStopReceipt.candidateFingerprint === candidateFingerprint,
    );
    const linkedSettlement = Boolean(
      settlementEvent &&
      hostBoundEvent &&
      settlementEvent.revision === waitReceipt.kernel_revision_at_receipt + 1 &&
      kernel.revision >= settlementEvent.revision &&
      waitRequest.kernel_revision === waitReceipt.kernel_revision_at_receipt &&
      createRequest.contract_fingerprint === contractFingerprint &&
      waitRequest.contract_fingerprint === contractFingerprint &&
      host.contractFingerprint === contractFingerprint &&
      waitRequest.kernel_revision >= (host.kernelRevision as number) &&
      createRequest.kernel_revision + 1 === host.kernelRevision &&
      hostBoundEvent.revision === host.kernelRevision &&
      host.requestRefs instanceof Array &&
      host.requestRefs.includes(waitRequest.request_id) &&
      host.eventRefs instanceof Array &&
      host.eventRefs.includes(waitReceipt.request_id) &&
      hasRef(host.resultRefs, waitReceiptRef),
    );
    const contractStale =
      waitReceipt.contract_stale ||
      createReceipt.contract_stale ||
      waitRequest.request_fingerprint !== requestFingerprint(waitRequest) ||
      createRequest.request_fingerprint !== requestFingerprint(createRequest) ||
      waitReceipt.request_fingerprint !== waitRequest.request_fingerprint ||
      createReceipt.request_fingerprint !== createRequest.request_fingerprint ||
      kernel.runs.at(-1)?.id !== runId ||
      (storedStopReceipt !== null && !stopReceiptWasStored) ||
      candidateBindingStale ||
      !linkedSettlement;
    const dispatchLeaseReleaseEligible =
      waitReceipt.outcome === "ok" &&
      waitReceipt.status === "completed" &&
      waitReceipt.evidence_level === "desktop-native" &&
      createReceipt.evidence_level === "desktop-native" &&
      !contractStale;
    result.push({
      source: "codex-desktop-bridge",
      assurance: "host-reported",
      evidenceLevel: waitReceipt.evidence_level,
      taskId: kernel.identity.taskId,
      runId,
      sessionId: null,
      threadId: host.threadId,
      startRequestId: createRequest.request_id,
      settleReceiptId: waitReceipt.request_id,
      terminalStatus: waitReceipt.status as TerminalWaitStatus,
      requestKernelRevision: waitRequest.kernel_revision,
      receiptKernelRevision: waitReceipt.kernel_revision_at_receipt,
      contractFingerprint,
      contractStale,
      candidateSnapshotId,
      candidateFingerprint,
      receiptRef: waitReceiptRef,
      evidenceRef: waitReceiptRef,
      recordedAt: waitReceipt.recorded_at,
      receiptId: waitReceipt.request_id,
      hostId: host.hostId,
      createRequestId: createRequest.request_id,
      createRequestRef: relativeRef(
        resolvedRoot,
        path.join(requestDir, `${createRequest.request_id}.json`),
      ),
      createReceiptId: createReceipt.request_id,
      createReceiptRef: relativeRef(resolvedRoot, createReceiptPath),
      waitRequestId: waitRequest.request_id,
      waitRequestRef,
      waitReceiptId: waitReceipt.request_id,
      waitReceiptRef,
      candidateSource,
      currentKernelRevision: kernel.revision,
      kernelStopReceiptRecorded: stopReceiptWasStored,
      dispatchLeaseReleaseEligible,
    });
  }
  return result;
}
