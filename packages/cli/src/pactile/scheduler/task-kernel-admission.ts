import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  fingerprintTaskValue,
  projectTaskKernelLifecycle,
  readTaskKernel,
  type TaskKernelSnapshotV2,
  type TaskRunV2,
} from "../../core/task/index.js";
import { resolveTaskDir } from "../task/session.js";
import type { ConflictParallelAuthorizationV1 } from "./scheduler.js";
import {
  readTaskKernelScheduleReceiptV1,
  type TaskKernelScheduleDecisionReceiptV1,
  type TaskScheduleLifecycleSnapshotV1,
} from "./task-map-scheduler.js";
import {
  listProjectWriteLeases,
  normalizeProjectWriteSet,
  projectActiveLeasePath,
  projectLeaseHistoryPath,
  projectWriteSetsConflict,
  withProjectSchedulerMutex,
  type ProjectWriteLeaseRecordV1,
} from "./project-lease-store.js";

export interface TaskKernelRunDispatchRequestV1 {
  scheduleReceiptFingerprint: string;
  taskId: string;
  runId: string;
  /** Pre-dispatch owner identity; required when the Task Run has no host yet. */
  owner?: TaskKernelRunDispatchOwnerV1;
}

export interface TaskKernelRunDispatchOwnerV1 {
  host: string;
  role: string;
  sessionId: string | null;
  threadId: string | null;
  hostId: string | null;
  contractFingerprint?: string | null;
  startRequestId?: string | null;
  processId?: number | null;
}

export interface TaskKernelRunDispatchDecisionReceiptV1 {
  schemaVersion: 1;
  scope: "task-kernel-v2-run-admission";
  receiptFingerprint: string;
  createdAt: string;
  decision: "permitted" | "rejected";
  request: TaskKernelRunDispatchRequestV1;
  owner: TaskKernelRunDispatchOwnerV1 | null;
  reasonCodes: string[];
  taskKernelRevision: number | null;
  dependencyKernelRevisions: Record<string, number | null>;
  writeSet: string[] | null;
  conflictingLeaseIds: string[];
  leaseId: string | null;
}

export interface TaskKernelRunDispatchPermitV1 {
  permitted: true;
  receipt: TaskKernelRunDispatchDecisionReceiptV1;
  receiptFile: string;
  leaseId: string;
  leaseFile: string;
}

export interface TaskKernelRunDispatchRejectionV1 {
  permitted: false;
  receipt: TaskKernelRunDispatchDecisionReceiptV1;
  receiptFile: string;
}

export type TaskKernelRunDispatchResultV1 =
  | TaskKernelRunDispatchPermitV1
  | TaskKernelRunDispatchRejectionV1;

export interface TaskKernelRunDispatchLeaseAssertionV1 {
  asserted: boolean;
  reasonCode: string | null;
  leaseId: string;
  taskId: string;
  runId: string;
  scheduleReceiptFingerprint: string | null;
  writeSet: string[] | null;
}

export interface TaskKernelRunDispatchPreSpawnAssertionRequestV1 {
  leaseId: string;
  taskId: string;
  runId: string;
  scheduleReceiptFingerprint: string;
  owner: TaskKernelRunDispatchOwnerV1;
}

export interface TaskKernelRunDispatchPreSpawnAssertionV1
  extends TaskKernelRunDispatchLeaseAssertionV1 {
  /** False only when every dispatch gate passed and the Run is still unbound. */
  hostBound: false | null;
}

export interface TaskKernelRunDispatchReleaseResultV1 {
  released: boolean;
  reasonCode: string | null;
  leaseId: string;
  receiptFile: string | null;
}

export interface TaskKernelRunDispatchOwnerBindingReceiptV1 {
  schemaVersion: 1;
  scope: "task-kernel-v2-run-owner-binding";
  receiptFingerprint: string;
  createdAt: string;
  leaseId: string;
  taskId: string;
  runId: string;
  scheduleReceiptFingerprint: string;
  admissionReceiptFingerprint: string;
  fromOwner: TaskKernelRunDispatchOwnerV1;
  owner: TaskKernelRunDispatchOwnerV1;
  hostBoundEventId: string;
  taskKernelRevision: number;
}

export interface TaskKernelRunDispatchOwnerBindingResultV1 {
  bound: boolean;
  reasonCode: string | null;
  leaseId: string;
  receipt: TaskKernelRunDispatchOwnerBindingReceiptV1 | null;
  receiptFile: string | null;
}

export type TaskKernelRunDispatchStopProofValidationV1 =
  | { valid: true; reasonCode: null; proof: TaskKernelRunDispatchStopProofV1 }
  | { valid: false; reasonCode: string; proof: null };

export interface TaskKernelRunDispatchStopProofValidationRequestV1 {
  leaseId: string;
  taskId: string;
  runId: string;
  stopReceiptRef: string;
}

interface CheckedTaskRun {
  kernel: TaskKernelSnapshotV2;
  run: TaskRunV2;
  lifecycle: TaskScheduleLifecycleSnapshotV1;
  dependencyKernelRevisions: Record<string, number | null>;
  writeSet: string[];
}

type DispatchLease = ProjectWriteLeaseRecordV1 & {
  owner_kind: "task-kernel-v2-run";
  task_id: string;
  run_id: string;
  schedule_receipt_fingerprint: string;
  admission_receipt_fingerprint: string;
  admission_owner: TaskKernelRunDispatchOwnerV1;
  dispatch_owner: TaskKernelRunDispatchOwnerV1;
  owner_binding_receipt_fingerprint?: string;
  touches: string[];
  created_at: string;
  status: "active" | "released";
};

const ADMISSION_SCHEMA_VERSION = 1;
const STOP_PROOF_SCOPE = "task-kernel-v2-run-dispatch-stop";

export interface TaskKernelRunDispatchStopProofV1 {
  schema_version: 1;
  scope: typeof STOP_PROOF_SCOPE;
  proof_fingerprint: string;
  lease_id: string;
  task_id: string;
  run_id: string;
  schedule_receipt_fingerprint: string;
  admission_receipt_fingerprint: string;
  source: "codex-bridge" | "pi-host";
  disposition: "native-terminal" | "not-created";
  writer_exited: true;
  owner: {
    host: string;
    role: string;
    session_id: string | null;
    thread_id: string | null;
    host_id: string | null;
    start_request_id: string | null;
    process_id: number | null;
  };
  request_ref: string;
  request_fingerprint: string;
  native_receipt_ref: string;
  native_receipt_fingerprint: string;
}

function relative(root: string, file: string): string {
  return path.relative(root, file).replaceAll("\\", "/");
}

function decisionFingerprint(
  base: Omit<
    TaskKernelRunDispatchDecisionReceiptV1,
    "schemaVersion" | "scope" | "receiptFingerprint" | "createdAt"
  >,
): string {
  return fingerprintTaskValue(base);
}

function persistDecisionReceipt(
  root: string,
  base: Omit<
    TaskKernelRunDispatchDecisionReceiptV1,
    "schemaVersion" | "scope" | "receiptFingerprint" | "createdAt"
  >,
): { receipt: TaskKernelRunDispatchDecisionReceiptV1; file: string } {
  const fingerprint = decisionFingerprint(base);
  const folder = path.join(
    root,
    ".pactile",
    ".runtime",
    "scheduler",
    "admissions",
  );
  const file = path.join(folder, `${fingerprint}.json`);
  fs.mkdirSync(folder, { recursive: true });
  if (fs.existsSync(file)) {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid Task Run admission receipt");
    const receipt = value as TaskKernelRunDispatchDecisionReceiptV1;
    const {
      schemaVersion,
      scope,
      receiptFingerprint,
      createdAt: _createdAt,
      ...storedBase
    } = receipt;
    if (
      schemaVersion !== ADMISSION_SCHEMA_VERSION ||
      scope !== "task-kernel-v2-run-admission" ||
      receiptFingerprint !== fingerprint ||
      fingerprintTaskValue(storedBase) !== fingerprint
    ) {
      throw new Error(
        "Task Run admission receipt fingerprint does not match its contents",
      );
    }
    return { receipt, file };
  }
  const receipt: TaskKernelRunDispatchDecisionReceiptV1 = {
    ...base,
    schemaVersion: ADMISSION_SCHEMA_VERSION,
    scope: "task-kernel-v2-run-admission",
    receiptFingerprint: fingerprint,
    createdAt: new Date().toISOString(),
  };
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    try {
      fs.copyFileSync(temporary, file, fs.constants.COPYFILE_EXCL);
      return { receipt, file };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return persistDecisionReceipt(root, base);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readTaskKernelScheduleReceipt(
  root: string,
  fingerprint: string,
): TaskKernelScheduleDecisionReceiptV1 {
  if (!/^[a-f0-9]{64}$/.test(fingerprint))
    throw new Error("invalid-schedule-receipt-fingerprint");
  try {
    return readTaskKernelScheduleReceiptV1(root, fingerprint).receipt;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("fingerprint does not match"))
      throw new Error("schedule-receipt-integrity-failed");
    if (message.includes("not found"))
      throw new Error("schedule-receipt-not-found");
    throw new Error("invalid-schedule-receipt");
  }
}

function lifecycleFor(
  receipt: TaskKernelScheduleDecisionReceiptV1,
  taskId: string,
): TaskScheduleLifecycleSnapshotV1 | undefined {
  return receipt.lifecycle.find((item) => item.taskId === taskId);
}

function nonEmptyAuthorization(run: TaskRunV2): boolean {
  return [
    run.authorization.approvedBy,
    run.authorization.approvedAt,
    run.authorization.scope,
    run.authorization.evidenceRef,
  ].every((value) => typeof value === "string" && !!value.trim());
}

function readRunHost(run: TaskRunV2): TaskKernelRunDispatchOwnerV1 | null {
  if (!run.host) return null;
  const host = run.host as typeof run.host & {
    hostId?: unknown;
    host_id?: unknown;
    startRequestId?: unknown;
    start_request_id?: unknown;
    processId?: unknown;
    process_id?: unknown;
  };
  return {
    host: host.host,
    role: host.role,
    sessionId: host.sessionId,
    threadId: host.threadId,
    hostId:
      typeof host.hostId === "string"
        ? host.hostId
        : typeof host.host_id === "string"
          ? host.host_id
          : null,
    contractFingerprint: host.contractFingerprint,
    startRequestId:
      typeof host.startRequestId === "string"
        ? host.startRequestId
        : typeof host.start_request_id === "string"
          ? host.start_request_id
          : null,
    processId:
      typeof host.processId === "number"
        ? host.processId
        : typeof host.process_id === "number"
          ? host.process_id
          : null,
  };
}

function validOwner(value: unknown): value is TaskKernelRunDispatchOwnerV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return (
    typeof owner.host === "string" &&
    !!owner.host.trim() &&
    typeof owner.role === "string" &&
    !!owner.role.trim() &&
    (owner.sessionId === null || typeof owner.sessionId === "string") &&
    (owner.threadId === null || typeof owner.threadId === "string") &&
    (owner.hostId === null || typeof owner.hostId === "string") &&
    (owner.contractFingerprint === undefined ||
      owner.contractFingerprint === null ||
      typeof owner.contractFingerprint === "string") &&
    (owner.startRequestId === undefined ||
      owner.startRequestId === null ||
      typeof owner.startRequestId === "string") &&
    (owner.processId === undefined ||
      owner.processId === null ||
      (typeof owner.processId === "number" &&
        Number.isSafeInteger(owner.processId) &&
        owner.processId > 0))
  );
}

function normalizeOwner(value: unknown): TaskKernelRunDispatchOwnerV1 | null {
  if (!validOwner(value)) return null;
  return {
    host: value.host,
    role: value.role,
    sessionId: value.sessionId,
    threadId: value.threadId,
    hostId: value.hostId,
    contractFingerprint: value.contractFingerprint ?? null,
    startRequestId: value.startRequestId ?? null,
    processId: value.processId ?? null,
  };
}

function sameOwner(
  left: TaskKernelRunDispatchOwnerV1 | null,
  right: TaskKernelRunDispatchOwnerV1 | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ownersCompatible(
  left: TaskKernelRunDispatchOwnerV1,
  right: TaskKernelRunDispatchOwnerV1,
): boolean {
  return (
    left.host === right.host &&
    left.role === right.role &&
    left.sessionId === right.sessionId &&
    left.threadId === right.threadId &&
    left.hostId === right.hostId &&
    (left.startRequestId === null ||
      right.startRequestId === null ||
      left.startRequestId === right.startRequestId) &&
    (left.processId === null ||
      right.processId === null ||
      left.processId === right.processId) &&
    (left.contractFingerprint === null ||
      right.contractFingerprint === null ||
      left.contractFingerprint === right.contractFingerprint)
  );
}

function ownerCanBind(
  previous: TaskKernelRunDispatchOwnerV1,
  next: TaskKernelRunDispatchOwnerV1,
): boolean {
  const mayFill = <T>(
    oldValue: T | null | undefined,
    newValue: T | null | undefined,
  ): boolean =>
    oldValue === null || oldValue === undefined || oldValue === newValue;
  return (
    previous.host === next.host &&
    previous.role === next.role &&
    mayFill(previous.sessionId, next.sessionId) &&
    mayFill(previous.threadId, next.threadId) &&
    mayFill(previous.hostId, next.hostId) &&
    mayFill(previous.startRequestId, next.startRequestId) &&
    mayFill(previous.processId, next.processId) &&
    (previous.contractFingerprint === null ||
      previous.contractFingerprint === undefined ||
      previous.contractFingerprint === next.contractFingerprint)
  );
}

function runHostMatchesOwner(
  run: TaskRunV2,
  owner: TaskKernelRunDispatchOwnerV1,
): boolean {
  const host = run.host;
  if (!host) return false;
  const observed = readRunHost(run);
  if (!observed) return false;
  if (
    observed.host !== owner.host ||
    observed.role !== owner.role ||
    observed.sessionId !== owner.sessionId ||
    observed.threadId !== owner.threadId ||
    observed.hostId !== owner.hostId ||
    (owner.contractFingerprint !== null &&
      owner.contractFingerprint !== undefined &&
      observed.contractFingerprint !== owner.contractFingerprint)
  )
    return false;
  if (owner.startRequestId && !host.requestRefs.includes(owner.startRequestId))
    return false;
  return (
    owner.processId === null ||
    owner.processId === undefined ||
    owner.processId > 0
  );
}

function taskRunOwnerMatches(
  run: TaskRunV2,
  owner: TaskKernelRunDispatchOwnerV1,
): boolean {
  return runHostMatchesOwner(run, owner);
}

function projectFile(root: string, ref: string): string {
  if (typeof ref !== "string" || !ref.trim() || path.isAbsolute(ref)) {
    throw new Error("project-relative receipt reference required");
  }
  const file = path.resolve(root, ref);
  const relativeFile = path.relative(root, file);
  if (
    !relativeFile ||
    relativeFile.startsWith("..") ||
    path.isAbsolute(relativeFile)
  ) {
    throw new Error("receipt reference must stay inside the project");
  }
  const realFile = fs.realpathSync(file);
  const realRelative = path.relative(fs.realpathSync(root), realFile);
  if (
    !realRelative ||
    realRelative.startsWith("..") ||
    path.isAbsolute(realRelative)
  ) {
    throw new Error("receipt reference must stay inside the project");
  }
  if (!fs.statSync(realFile).isFile())
    throw new Error("receipt reference must be a file");
  return realFile;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function proofOwnerMatches(
  proof: TaskKernelRunDispatchStopProofV1["owner"],
  expected: TaskKernelRunDispatchOwnerV1,
): boolean {
  return (
    proof.host === expected.host &&
    proof.role === expected.role &&
    proof.session_id === expected.sessionId &&
    proof.thread_id === expected.threadId &&
    proof.host_id === expected.hostId &&
    proof.start_request_id === (expected.startRequestId ?? null) &&
    proof.process_id === (expected.processId ?? null)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function taskOrProjectFile(root: string, taskId: string, ref: unknown): string {
  if (!nonEmptyString(ref) || path.isAbsolute(ref))
    throw new Error("task evidence reference must be project-relative");
  try {
    return projectFile(root, ref);
  } catch {
    const taskDir = resolveTaskDir(root, taskId);
    const candidate = path.resolve(taskDir, ref);
    const taskRelative = path.relative(taskDir, candidate);
    if (
      !taskRelative ||
      taskRelative.startsWith("..") ||
      path.isAbsolute(taskRelative)
    )
      throw new Error(
        "task evidence reference must stay inside the Task directory",
      );
    const realFile = fs.realpathSync(candidate);
    const realTaskDir = fs.realpathSync(taskDir);
    const realRelative = path.relative(realTaskDir, realFile);
    if (
      !realRelative ||
      realRelative.startsWith("..") ||
      path.isAbsolute(realRelative)
    )
      throw new Error(
        "task evidence reference must stay inside the Task directory",
      );
    if (!fs.statSync(realFile).isFile())
      throw new Error("task evidence reference must be a file");
    return realFile;
  }
}

function sameTaskOrProjectRef(
  root: string,
  taskId: string,
  left: unknown,
  rightFile: string,
): boolean {
  try {
    return taskOrProjectFile(root, taskId, left) === fs.realpathSync(rightFile);
  } catch {
    return false;
  }
}

function hostResultRefsContainFile(
  root: string,
  taskId: string,
  refs: readonly string[],
  expectedFile: string,
): boolean {
  return refs.some((ref) =>
    sameTaskOrProjectRef(root, taskId, ref, expectedFile),
  );
}

function verifyCodexBridgeStopProof(
  proof: TaskKernelRunDispatchStopProofV1,
  lease: DispatchLease,
  request: Record<string, unknown>,
  nativeReceipt: Record<string, unknown>,
): void {
  const owner = lease.dispatch_owner;
  if (
    proof.source !== "codex-bridge" ||
    owner.host !== "codex-desktop" ||
    (owner.startRequestId !== null && owner.startRequestId !== undefined) ||
    (owner.processId !== null && owner.processId !== undefined) ||
    proof.owner.start_request_id !== null ||
    proof.owner.process_id !== null ||
    request.dispatch_task_id !== lease.task_id ||
    request.dispatch_run_id !== lease.run_id ||
    request.dispatch_lease_id !== lease.id ||
    request.schedule_receipt_fingerprint !==
      lease.schedule_receipt_fingerprint ||
    request.dispatch_admission_receipt_fingerprint !==
      lease.admission_receipt_fingerprint ||
    request.role !== owner.role ||
    request.thread_id !== owner.threadId ||
    request.host_id !== owner.hostId ||
    (owner.contractFingerprint !== null &&
      owner.contractFingerprint !== undefined &&
      request.contract_fingerprint !== owner.contractFingerprint) ||
    nativeReceipt.request_id !== request.request_id ||
    nativeReceipt.request_fingerprint !== proof.request_fingerprint ||
    nativeReceipt.task_id !== lease.task_id ||
    nativeReceipt.run_id !== lease.run_id ||
    nativeReceipt.tool !== request.tool ||
    nativeReceipt.host_id !== owner.hostId ||
    nativeReceipt.thread_id !== owner.threadId ||
    nativeReceipt.evidence_level !== "desktop-native" ||
    request.candidate_snapshot_id !== nativeReceipt.candidate_snapshot_id ||
    request.candidate_fingerprint !== nativeReceipt.candidate_fingerprint ||
    nativeReceipt.contract_stale !== false
  ) {
    throw new Error("dispatch-stop-proof-codex-identity-mismatch");
  }
  if (proof.disposition === "native-terminal") {
    if (
      request.tool !== "wait_threads" ||
      nativeReceipt.tool !== "wait_threads" ||
      nativeReceipt.outcome !== "ok" ||
      nativeReceipt.status !== "completed"
    )
      throw new Error("dispatch-stop-proof-not-native-terminal");
  } else if (proof.disposition === "not-created") {
    if (
      request.tool !== "create_thread" ||
      nativeReceipt.tool !== "create_thread" ||
      nativeReceipt.outcome !== "failed" ||
      nativeReceipt.thread_creation_state !== "not_created" ||
      (nativeReceipt.thread_id !== null &&
        nativeReceipt.thread_id !== undefined) ||
      (nativeReceipt.client_thread_id !== null &&
        nativeReceipt.client_thread_id !== undefined) ||
      nativeReceipt.host_id !== null
    )
      throw new Error("dispatch-stop-proof-not-confirmed-not-created");
    if (
      owner.sessionId !== null ||
      owner.threadId !== null ||
      owner.hostId !== null ||
      proof.owner.session_id !== null ||
      proof.owner.thread_id !== null ||
      proof.owner.host_id !== null
    )
      throw new Error("dispatch-stop-proof-not-created-owner-mismatch");
  } else {
    throw new Error("dispatch-stop-proof-invalid-disposition");
  }
}

function verifyPiHostStopProof(
  root: string,
  proof: TaskKernelRunDispatchStopProofV1,
  lease: DispatchLease,
  startReceipt: Record<string, unknown>,
  runRecord: Record<string, unknown>,
  nativeReceipt: Record<string, unknown>,
  nativeReceiptFile: string,
): void {
  const owner = lease.dispatch_owner;
  const stop = asRecord(
    nativeReceipt.process_stop_receipt,
    "Pi process stop receipt",
  );
  const processExit = asRecord(stop.processExit, "Pi process exit evidence");
  if (
    proof.source !== "pi-host" ||
    proof.disposition !== "native-terminal" ||
    owner.host !== "pi" ||
    owner.role !== "implement" ||
    owner.threadId !== null ||
    owner.hostId !== null ||
    !owner.startRequestId ||
    !owner.processId ||
    proof.owner.start_request_id !== owner.startRequestId ||
    proof.owner.process_id !== owner.processId ||
    startReceipt.schemaVersion !== 1 ||
    startReceipt.source !== "pactile-pi-rpc" ||
    startReceipt.taskId !== lease.task_id ||
    startReceipt.taskRunId !== lease.run_id ||
    !nonEmptyString(startReceipt.piRunId) ||
    startReceipt.role !== "implement" ||
    startReceipt.sessionId !== owner.sessionId ||
    startReceipt.processId !== owner.processId ||
    startReceipt.startRequestId !== owner.startRequestId ||
    !nonEmptyString(startReceipt.progressEvidenceRef) ||
    !nonEmptyString(startReceipt.evidenceRef) ||
    runRecord.run_id !== startReceipt.piRunId ||
    runRecord.task_id !== lease.task_id ||
    runRecord.task_run_id !== lease.run_id ||
    runRecord.role !== "implement" ||
    runRecord.session_id !== owner.sessionId ||
    runRecord.process_id !== owner.processId ||
    runRecord.start_request_id !== owner.startRequestId ||
    runRecord.progress_evidence_ref !== startReceipt.progressEvidenceRef ||
    runRecord.settle_receipt_id !== stop.settleReceiptId ||
    stop.schemaVersion !== 1 ||
    stop.source !== "pactile-pi-rpc" ||
    stop.assurance !== "manager-owned-child-exit" ||
    stop.taskId !== lease.task_id ||
    stop.taskRunId !== lease.run_id ||
    stop.piRunId !== startReceipt.piRunId ||
    stop.role !== "implement" ||
    stop.sessionId !== owner.sessionId ||
    stop.processId !== owner.processId ||
    stop.startRequestId !== owner.startRequestId ||
    !nonEmptyString(stop.settleReceiptId) ||
    !["exited", "cancelled"].includes(String(stop.terminal)) ||
    processExit.processId !== owner.processId ||
    processExit.terminationVerified !== true ||
    !nonEmptyString(processExit.exitObservedAt) ||
    !nonEmptyString(stop.evidenceRef) ||
    stop.evidenceRef !== startReceipt.evidenceRef ||
    !nonEmptyString(stop.progressEvidenceRef) ||
    stop.progressEvidenceRef !== startReceipt.progressEvidenceRef ||
    !sameTaskOrProjectRef(
      root,
      lease.task_id,
      runRecord.host_start_receipt_ref,
      projectFile(root, proof.request_ref),
    ) ||
    !sameTaskOrProjectRef(
      root,
      lease.task_id,
      startReceipt.evidenceRef,
      nativeReceiptFile,
    )
  ) {
    throw new Error("dispatch-stop-proof-pi-identity-mismatch");
  }
}

function verifyStopProof(
  root: string,
  proofRef: string,
  lease: DispatchLease,
): {
  disposition: "native-terminal" | "not-created";
  proof: TaskKernelRunDispatchStopProofV1;
  nativeReceiptFile: string;
  settlementEventRef: string | null;
  progressEvidenceRef: string | null;
  startRequestId: string | null;
  candidateSnapshotId: string | null;
  candidateFingerprint: string | null;
} {
  const proofFile = projectFile(root, proofRef);
  const proof = asRecord(
    JSON.parse(fs.readFileSync(proofFile, "utf8")),
    "dispatch stop proof",
  ) as unknown as TaskKernelRunDispatchStopProofV1;
  const { proof_fingerprint: storedProofFingerprint, ...proofBase } = proof;
  if (
    proof.schema_version !== 1 ||
    proof.scope !== STOP_PROOF_SCOPE ||
    !hasExactKeys(proof as unknown as Record<string, unknown>, [
      "schema_version",
      "scope",
      "proof_fingerprint",
      "lease_id",
      "task_id",
      "run_id",
      "schedule_receipt_fingerprint",
      "admission_receipt_fingerprint",
      "source",
      "disposition",
      "writer_exited",
      "owner",
      "request_ref",
      "request_fingerprint",
      "native_receipt_ref",
      "native_receipt_fingerprint",
    ]) ||
    !hasExactKeys(proof.owner as unknown as Record<string, unknown>, [
      "host",
      "role",
      "session_id",
      "thread_id",
      "host_id",
      "start_request_id",
      "process_id",
    ]) ||
    typeof storedProofFingerprint !== "string" ||
    fingerprintTaskValue(proofBase) !== storedProofFingerprint ||
    path.basename(proofFile) !== `${storedProofFingerprint}.json`
  ) {
    throw new Error("dispatch-stop-proof-integrity-failed");
  }
  if (
    proof.lease_id !== lease.id ||
    proof.task_id !== lease.task_id ||
    proof.run_id !== lease.run_id ||
    proof.schedule_receipt_fingerprint !== lease.schedule_receipt_fingerprint ||
    proof.admission_receipt_fingerprint !==
      lease.admission_receipt_fingerprint ||
    proof.writer_exited !== true ||
    !proofOwnerMatches(proof.owner, lease.dispatch_owner)
  ) {
    throw new Error("dispatch-stop-proof-identity-mismatch");
  }
  const requestFile = projectFile(root, proof.request_ref);
  const request = asRecord(
    JSON.parse(fs.readFileSync(requestFile, "utf8")),
    "dispatch request",
  );
  if (proof.source === "codex-bridge") {
    const { request_fingerprint: storedRequestFingerprint, ...requestBase } =
      request;
    if (
      typeof storedRequestFingerprint !== "string" ||
      fingerprintTaskValue(requestBase) !== storedRequestFingerprint ||
      storedRequestFingerprint !== proof.request_fingerprint ||
      request.task_id !== lease.task_id ||
      request.run_id !== lease.run_id
    )
      throw new Error("dispatch-stop-proof-request-mismatch");
  } else if (proof.source === "pi-host") {
    if (
      proof.disposition !== "native-terminal" ||
      fingerprintTaskValue(request) !== proof.request_fingerprint
    )
      throw new Error("dispatch-stop-proof-request-mismatch");
  } else {
    throw new Error("dispatch-stop-proof-source-invalid");
  }
  const nativeReceiptFile = projectFile(root, proof.native_receipt_ref);
  const nativeReceipt = asRecord(
    JSON.parse(fs.readFileSync(nativeReceiptFile, "utf8")),
    "native dispatch receipt",
  );
  if (proof.source === "codex-bridge") {
    if (
      fingerprintTaskValue(nativeReceipt) !== proof.native_receipt_fingerprint
    )
      throw new Error("dispatch-stop-proof-native-receipt-mismatch");
    verifyCodexBridgeStopProof(proof, lease, request, nativeReceipt);
    return {
      disposition: proof.disposition,
      proof,
      nativeReceiptFile,
      settlementEventRef:
        proof.disposition === "native-terminal" &&
        nonEmptyString(nativeReceipt.request_id)
          ? nativeReceipt.request_id
          : null,
      progressEvidenceRef: null,
      startRequestId: null,
      candidateSnapshotId:
        typeof nativeReceipt.candidate_snapshot_id === "string"
          ? nativeReceipt.candidate_snapshot_id
          : null,
      candidateFingerprint:
        typeof nativeReceipt.candidate_fingerprint === "string"
          ? nativeReceipt.candidate_fingerprint
          : null,
    };
  } else {
    const startReceipt = request;
    const runRecord = nativeReceipt;
    const stop = asRecord(
      runRecord.process_stop_receipt,
      "Pi process stop receipt",
    );
    if (fingerprintTaskValue(stop) !== proof.native_receipt_fingerprint)
      throw new Error("dispatch-stop-proof-native-receipt-mismatch");
    verifyPiHostStopProof(
      root,
      proof,
      lease,
      startReceipt,
      runRecord,
      nativeReceipt,
      nativeReceiptFile,
    );
    return {
      disposition: proof.disposition,
      proof,
      nativeReceiptFile,
      settlementEventRef: nonEmptyString(stop.settleReceiptId)
        ? stop.settleReceiptId
        : null,
      progressEvidenceRef: nonEmptyString(startReceipt.progressEvidenceRef)
        ? startReceipt.progressEvidenceRef
        : null,
      startRequestId: nonEmptyString(startReceipt.startRequestId)
        ? startReceipt.startRequestId
        : null,
      candidateSnapshotId: null,
      candidateFingerprint: null,
    };
  }
}

function validateStopProofForActiveLease(
  root: string,
  request: TaskKernelRunDispatchStopProofValidationRequestV1,
  lease: DispatchLease,
): TaskKernelRunDispatchStopProofValidationV1 {
  const reject = (
    reasonCode: string,
  ): TaskKernelRunDispatchStopProofValidationV1 => ({
    valid: false,
    reasonCode,
    proof: null,
  });
  let admission: TaskKernelRunDispatchDecisionReceiptV1;
  try {
    admission = readAdmissionReceipt(root, lease.admission_receipt_fingerprint);
  } catch {
    return reject("dispatch-lease-receipt-invalid");
  }
  if (
    admission.receiptFingerprint !== lease.admission_receipt_fingerprint ||
    admission.leaseId !== lease.id ||
    admission.request.taskId !== request.taskId ||
    admission.request.runId !== request.runId ||
    admission.request.scheduleReceiptFingerprint !==
      lease.schedule_receipt_fingerprint ||
    !sameOwner(admission.owner, lease.admission_owner) ||
    !Array.isArray(admission.writeSet) ||
    fingerprintTaskValue(normalizeProjectWriteSet(admission.writeSet)) !==
      fingerprintTaskValue(normalizeProjectWriteSet(lease.touches))
  )
    return reject("dispatch-lease-receipt-mismatch");

  try {
    readTaskKernelScheduleReceipt(root, lease.schedule_receipt_fingerprint);
  } catch {
    return reject("schedule-receipt-integrity-failed");
  }

  let kernel: TaskKernelSnapshotV2;
  let run: TaskRunV2;
  try {
    const read = readTaskKernel({
      root,
      taskDir: resolveTaskDir(root, request.taskId),
    });
    if (read.kind !== "task-kernel-v2")
      return reject("task-kernel-snapshot-invalid-or-missing");
    if (read.kernel.identity.taskId !== request.taskId)
      return reject("task-kernel-snapshot-invalid-or-missing");
    const latest = read.kernel.runs.at(-1);
    if (latest?.id !== request.runId || latest.taskId !== request.taskId)
      return reject("task-run-id-mismatch");
    kernel = read.kernel;
    run = latest;
  } catch {
    return reject("task-kernel-snapshot-invalid-or-missing");
  }

  let checkedProof: ReturnType<typeof verifyStopProof>;
  try {
    checkedProof = verifyStopProof(root, request.stopReceiptRef, lease);
  } catch (error) {
    return reject(
      error instanceof Error ? error.message : "dispatch-stop-proof-invalid",
    );
  }

  const currentWriteSet = normalizeProjectWriteSet([
    ...run.writeSetSnapshot,
    ...(run.workspace?.writeSet ?? []),
  ]);
  if (!writeSetCoveredByLease(currentWriteSet, lease.touches))
    return reject("task-run-write-set-expanded");

  if (checkedProof.disposition === "native-terminal") {
    if (!run.host || !taskRunOwnerMatches(run, lease.dispatch_owner))
      return reject("task-run-host-binding-mismatch");
    const ownerBindingReason = verifyOwnerBinding(root, lease, kernel, run);
    if (ownerBindingReason) return reject(ownerBindingReason);
    if (
      (run.candidateSnapshot?.id ?? null) !==
        checkedProof.candidateSnapshotId ||
      (run.candidateSnapshot?.fingerprint ?? null) !==
        checkedProof.candidateFingerprint
    )
      return reject("dispatch-stop-proof-candidate-mismatch");
    if (
      !checkedProof.settlementEventRef ||
      !run.host.eventRefs.includes(checkedProof.settlementEventRef) ||
      !hostResultRefsContainFile(
        root,
        request.taskId,
        run.host.resultRefs,
        checkedProof.nativeReceiptFile,
      )
    )
      return reject("task-run-host-settlement-refs-missing");
    if (
      checkedProof.proof.source === "codex-bridge" &&
      !run.host.requestRefs.length
    )
      return reject("task-run-host-start-request-ref-missing");
    if (
      checkedProof.proof.source === "pi-host" &&
      (!checkedProof.startRequestId ||
        !run.host.requestRefs.includes(checkedProof.startRequestId) ||
        !checkedProof.progressEvidenceRef ||
        !run.host.eventRefs.some((ref) =>
          sameTaskOrProjectRef(
            root,
            request.taskId,
            ref,
            taskOrProjectFile(
              root,
              request.taskId,
              checkedProof.progressEvidenceRef,
            ),
          ),
        ))
    )
      return reject("task-run-host-start-evidence-refs-missing");
  } else if (
    run.host !== null ||
    !["waiting", "running"].includes(run.state) ||
    !sameOwner(lease.admission_owner, lease.dispatch_owner) ||
    lease.owner_binding_receipt_fingerprint
  ) {
    return reject("not-created-run-state-mismatch");
  }
  if (checkedProof.proof.source === "pi-host" && run.candidateSnapshot !== null)
    return reject("pi-stop-proof-candidate-must-follow-process-stop");
  return { valid: true, reasonCode: null, proof: checkedProof.proof };
}

function inspectTaskRun(
  root: string,
  receipt: TaskKernelScheduleDecisionReceiptV1,
  request: TaskKernelRunDispatchRequestV1,
  requirePlannedRevision: boolean,
): { checked: CheckedTaskRun | null; reasonCodes: string[] } {
  const reasons: string[] = [];
  const snapshot = lifecycleFor(receipt, request.taskId);
  const decision = receipt.plan.decisions.find(
    (item) => item.taskId === request.taskId,
  );
  if (
    !receipt.candidateTaskIds.includes(request.taskId) ||
    !snapshot ||
    !decision ||
    !["scheduled", "in-flight"].includes(decision.action)
  ) {
    return { checked: null, reasonCodes: ["task-not-admitted-by-plan"] };
  }
  const taskDir = resolveTaskDir(root, request.taskId);
  const read = readTaskKernel({ root, taskDir });
  if (read.kind !== "task-kernel-v2")
    return { checked: null, reasonCodes: ["task-kernel-v2-required"] };
  const kernel = read.kernel;
  if (kernel.identity.taskId !== request.taskId)
    return { checked: null, reasonCodes: ["task-identity-mismatch"] };
  const expectedRevision = receipt.taskKernelRevisions[request.taskId];
  if (
    expectedRevision !== snapshot.kernelRevision ||
    (requirePlannedRevision && kernel.revision !== expectedRevision)
  )
    reasons.push("task-kernel-revision-changed");
  const dependencyIds = [...kernel.definition.dependencies].sort();
  if (
    JSON.stringify(dependencyIds) !==
    JSON.stringify([...snapshot.dependencyTaskIds].sort())
  )
    reasons.push("hard-dependencies-changed");
  const run = kernel.runs.at(-1) ?? null;
  if (!run)
    return { checked: null, reasonCodes: [...reasons, "task-run-missing"] };
  if (run.id !== request.runId || snapshot.runId !== request.runId)
    reasons.push("task-run-id-mismatch");
  if (run.taskId !== request.taskId) reasons.push("task-run-identity-mismatch");
  if (run.state !== "waiting" && run.state !== "running")
    reasons.push("task-run-not-dispatchable");
  const lifecycle = projectTaskKernelLifecycle(kernel);
  if (
    !lifecycle.gateSnapshot.runStart.phaseAllowsRun ||
    lifecycle.gateSnapshot.runStart.activeRunId !== run.id ||
    kernel.condition === "blocked"
  )
    reasons.push("task-run-lifecycle-gate-closed");
  if (!nonEmptyAuthorization(run))
    reasons.push("task-run-authorization-missing");

  const dependencyKernelRevisions: Record<string, number | null> = {};
  for (const dependencyId of dependencyIds) {
    const dependencyDir = resolveTaskDir(root, dependencyId);
    const dependency = readTaskKernel({ root, taskDir: dependencyDir });
    if (dependency.kind !== "task-kernel-v2") {
      dependencyKernelRevisions[dependencyId] = null;
      reasons.push(`hard-dependency-not-v2-closed:${dependencyId}`);
      continue;
    }
    dependencyKernelRevisions[dependencyId] = dependency.kernel.revision;
    const projection = projectTaskKernelLifecycle(dependency.kernel);
    if (!projection.closed || projection.outcome !== "completed")
      reasons.push(`hard-dependency-not-closed:${dependencyId}`);
  }

  const writeInputs = [
    ...run.writeSetSnapshot,
    ...(run.workspace?.writeSet ?? []),
  ];
  const writeSet = normalizeProjectWriteSet(writeInputs);
  const receiptWriteSet = normalizeProjectWriteSet(snapshot.writeSet);
  if (JSON.stringify(writeSet) !== JSON.stringify(receiptWriteSet))
    reasons.push("task-run-write-set-changed");
  if (reasons.length)
    return { checked: null, reasonCodes: [...new Set(reasons)] };
  return {
    checked: {
      kernel,
      run,
      lifecycle: snapshot,
      dependencyKernelRevisions,
      writeSet,
    },
    reasonCodes: [],
  };
}

function conflictAuthorization(
  receipt: TaskKernelScheduleDecisionReceiptV1,
  taskId: string,
  prior: ProjectWriteLeaseRecordV1,
): ConflictParallelAuthorizationV1 | undefined {
  const priorTaskId = prior.task_id;
  if (
    prior.owner_kind !== "task-kernel-v2-run" ||
    !priorTaskId ||
    prior.schedule_receipt_fingerprint !== receipt.receiptFingerprint
  )
    return undefined;
  return receipt.plan.waves
    .find(
      (wave) =>
        wave.taskIds.includes(taskId) && wave.taskIds.includes(priorTaskId),
    )
    ?.conflictAuthorizations.find(
      (authorization) =>
        authorization.taskIds.includes(taskId) &&
        authorization.taskIds.includes(priorTaskId),
    );
}

function persistRejected(
  root: string,
  request: TaskKernelRunDispatchRequestV1,
  reasonCodes: string[],
  taskKernelRevision: number | null,
  dependencyKernelRevisions: Record<string, number | null> = {},
  writeSet: string[] | null = null,
  conflictingLeaseIds: string[] = [],
): TaskKernelRunDispatchRejectionV1 {
  const stored = persistDecisionReceipt(root, {
    decision: "rejected",
    request,
    owner: normalizeOwner(request.owner),
    reasonCodes,
    taskKernelRevision,
    dependencyKernelRevisions,
    writeSet,
    conflictingLeaseIds,
    leaseId: null,
  });
  return {
    permitted: false,
    receipt: stored.receipt,
    receiptFile: relative(root, stored.file),
  };
}

/** Acquires a project-wide writer lease only for a currently authorized V2 Run. */
export function acquireTaskKernelRunDispatchV1(
  rootValue: string,
  request: TaskKernelRunDispatchRequestV1,
): TaskKernelRunDispatchResultV1 {
  const root = path.resolve(rootValue);
  return withProjectSchedulerMutex(root, () => {
    let schedule: TaskKernelScheduleDecisionReceiptV1;
    try {
      schedule = readTaskKernelScheduleReceipt(
        root,
        request.scheduleReceiptFingerprint,
      );
    } catch (error) {
      const reason =
        error instanceof Error &&
        error.message === "schedule-receipt-integrity-failed"
          ? "schedule-receipt-integrity-failed"
          : "schedule-receipt-invalid-or-missing";
      return persistRejected(root, request, [reason], null);
    }
    let inspected: ReturnType<typeof inspectTaskRun>;
    try {
      inspected = inspectTaskRun(root, schedule, request, true);
    } catch {
      return persistRejected(
        root,
        request,
        ["task-kernel-snapshot-invalid-or-missing"],
        null,
      );
    }
    if (!inspected.checked)
      return persistRejected(root, request, inspected.reasonCodes, null);
    const checked = inspected.checked;
    const kernelOwner = readRunHost(checked.run);
    const suppliedOwner = normalizeOwner(request.owner);
    // Preserve adapter-observed process identity when the Kernel Host schema
    // has not yet projected those fields; a null Kernel slot is not a claim.
    const owner = suppliedOwner ?? kernelOwner;
    if (!owner) {
      return persistRejected(
        root,
        request,
        ["dispatch-owner-missing-or-invalid"],
        checked.kernel.revision,
        checked.dependencyKernelRevisions,
        checked.writeSet,
      );
    }
    if (
      kernelOwner &&
      suppliedOwner &&
      !ownersCompatible(kernelOwner, suppliedOwner)
    ) {
      return persistRejected(
        root,
        request,
        ["dispatch-owner-does-not-match-task-run"],
        checked.kernel.revision,
        checked.dependencyKernelRevisions,
        checked.writeSet,
      );
    }
    if (request.owner && !normalizeOwner(request.owner)) {
      return persistRejected(
        root,
        request,
        ["dispatch-owner-missing-or-invalid"],
        checked.kernel.revision,
        checked.dependencyKernelRevisions,
        checked.writeSet,
      );
    }
    let active: ReturnType<typeof listProjectWriteLeases>;
    try {
      active = listProjectWriteLeases(root);
    } catch {
      return persistRejected(
        root,
        request,
        ["project-active-leases-unreadable"],
        checked.kernel.revision,
        checked.dependencyKernelRevisions,
        checked.writeSet,
      );
    }
    const sameRun = active.find(
      ({ lease }) =>
        lease.owner_kind === "task-kernel-v2-run" &&
        lease.task_id === request.taskId &&
        lease.run_id === request.runId,
    );
    if (sameRun)
      return persistRejected(
        root,
        request,
        ["task-run-already-leased"],
        checked.kernel.revision,
        checked.dependencyKernelRevisions,
        checked.writeSet,
        [sameRun.lease.id],
      );

    const collisions = active.filter(({ lease }) =>
      projectWriteSetsConflict(lease.touches, checked.writeSet),
    );
    const conflictingLeaseIds: string[] = [];
    const authorizedConflicts: NonNullable<
      ProjectWriteLeaseRecordV1["authorized_conflicts"]
    > = [];
    for (const { lease } of collisions) {
      const authorization = conflictAuthorization(
        schedule,
        request.taskId,
        lease,
      );
      if (!authorization) conflictingLeaseIds.push(lease.id);
      else authorizedConflicts.push(authorization);
    }
    if (conflictingLeaseIds.length) {
      return persistRejected(
        root,
        request,
        ["project-write-set-conflict"],
        checked.kernel.revision,
        checked.dependencyKernelRevisions,
        checked.writeSet,
        conflictingLeaseIds.sort(),
      );
    }

    const leaseId = randomUUID();
    const decisionBase = {
      decision: "permitted" as const,
      request,
      owner,
      reasonCodes: [
        "planned-task-run-authorized",
        "hard-dependencies-closed",
        "project-write-set-reserved",
      ],
      taskKernelRevision: checked.kernel.revision,
      dependencyKernelRevisions: checked.dependencyKernelRevisions,
      writeSet: checked.writeSet,
      conflictingLeaseIds: collisions.map(({ lease }) => lease.id).sort(),
      leaseId,
    };
    const admissionFingerprint = decisionFingerprint(decisionBase);
    const leaseFile = projectActiveLeasePath(root, leaseId);
    const lease: DispatchLease = {
      schema_version: 1,
      owner_kind: "task-kernel-v2-run",
      id: leaseId,
      pid: process.pid,
      durable: true,
      task_id: request.taskId,
      run_id: request.runId,
      schedule_receipt_fingerprint: schedule.receiptFingerprint,
      admission_receipt_fingerprint: admissionFingerprint,
      admission_owner: owner,
      dispatch_owner: owner,
      touches: checked.writeSet,
      authorized_conflicts: authorizedConflicts,
      source_kernel_revision: checked.kernel.revision,
      created_at: new Date().toISOString(),
      status: "active",
    };
    fs.mkdirSync(path.dirname(leaseFile), { recursive: true });
    fs.writeFileSync(leaseFile, `${JSON.stringify(lease, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    try {
      const stored = persistDecisionReceipt(root, decisionBase);
      return {
        permitted: true,
        receipt: stored.receipt,
        receiptFile: relative(root, stored.file),
        leaseId,
        leaseFile: relative(root, leaseFile),
      };
    } catch (error) {
      fs.rmSync(leaseFile, { force: true });
      throw error;
    }
  });
}

function readAdmissionReceipt(
  root: string,
  fingerprint: string,
): TaskKernelRunDispatchDecisionReceiptV1 {
  if (!/^[a-f0-9]{64}$/.test(fingerprint))
    throw new Error("invalid-admission-receipt-fingerprint");
  const file = path.join(
    root,
    ".pactile",
    ".runtime",
    "scheduler",
    "admissions",
    `${fingerprint}.json`,
  );
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid-admission-receipt");
  const receipt = value as TaskKernelRunDispatchDecisionReceiptV1;
  const {
    schemaVersion,
    scope,
    receiptFingerprint,
    createdAt: _createdAt,
    ...base
  } = receipt;
  if (
    schemaVersion !== 1 ||
    scope !== "task-kernel-v2-run-admission" ||
    receiptFingerprint !== fingerprint ||
    fingerprintTaskValue(base) !== fingerprint ||
    receipt.decision !== "permitted"
  )
    throw new Error("admission-receipt-integrity-failed");
  return receipt;
}

function ownerBindingReceiptPath(root: string, fingerprint: string): string {
  if (!/^[a-f0-9]{64}$/.test(fingerprint))
    throw new Error("invalid-owner-binding-receipt-fingerprint");
  return path.join(
    root,
    ".pactile",
    ".runtime",
    "scheduler",
    "owner-bindings",
    `${fingerprint}.json`,
  );
}

function readOwnerBindingReceipt(
  root: string,
  fingerprint: string,
): TaskKernelRunDispatchOwnerBindingReceiptV1 {
  const file = ownerBindingReceiptPath(root, fingerprint);
  const receipt = asRecord(
    JSON.parse(fs.readFileSync(file, "utf8")),
    "owner binding receipt",
  ) as unknown as TaskKernelRunDispatchOwnerBindingReceiptV1;
  const {
    schemaVersion,
    scope,
    receiptFingerprint,
    createdAt: _createdAt,
    ...base
  } = receipt;
  if (
    schemaVersion !== 1 ||
    scope !== "task-kernel-v2-run-owner-binding" ||
    receiptFingerprint !== fingerprint ||
    fingerprintTaskValue(base) !== fingerprint
  ) {
    throw new Error("owner-binding-receipt-integrity-failed");
  }
  return receipt;
}

function persistOwnerBindingReceipt(
  root: string,
  base: Omit<
    TaskKernelRunDispatchOwnerBindingReceiptV1,
    "schemaVersion" | "scope" | "receiptFingerprint" | "createdAt"
  >,
): { receipt: TaskKernelRunDispatchOwnerBindingReceiptV1; file: string } {
  const fingerprint = fingerprintTaskValue(base);
  const file = ownerBindingReceiptPath(root, fingerprint);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file))
    return { receipt: readOwnerBindingReceipt(root, fingerprint), file };
  const receipt: TaskKernelRunDispatchOwnerBindingReceiptV1 = {
    ...base,
    schemaVersion: 1,
    scope: "task-kernel-v2-run-owner-binding",
    receiptFingerprint: fingerprint,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return { receipt, file };
}

function verifyOwnerBinding(
  root: string,
  lease: DispatchLease,
  kernel: TaskKernelSnapshotV2,
  run: TaskRunV2,
): string | null {
  if (!lease.owner_binding_receipt_fingerprint) {
    if (!sameOwner(lease.admission_owner, lease.dispatch_owner))
      return "owner-binding-receipt-required";
    return taskRunOwnerMatches(run, lease.dispatch_owner)
      ? null
      : "task-run-host-binding-mismatch";
  }
  let receipt: TaskKernelRunDispatchOwnerBindingReceiptV1;
  try {
    receipt = readOwnerBindingReceipt(
      root,
      lease.owner_binding_receipt_fingerprint,
    );
  } catch {
    return "owner-binding-receipt-invalid";
  }
  const event = kernel.events.find(
    (candidate) =>
      (candidate.type as string) === "run.host-bound" &&
      candidate.entityId === run.id &&
      candidate.id === receipt.hostBoundEventId,
  );
  if (
    receipt.leaseId !== lease.id ||
    receipt.taskId !== lease.task_id ||
    receipt.runId !== lease.run_id ||
    receipt.scheduleReceiptFingerprint !== lease.schedule_receipt_fingerprint ||
    receipt.admissionReceiptFingerprint !==
      lease.admission_receipt_fingerprint ||
    !sameOwner(receipt.fromOwner, lease.admission_owner) ||
    !sameOwner(receipt.owner, lease.dispatch_owner) ||
    event?.revision !== receipt.taskKernelRevision ||
    !taskRunOwnerMatches(run, lease.dispatch_owner)
  ) {
    return "owner-binding-receipt-mismatch";
  }
  return null;
}

/** Binds a previously unknown native writer only after its Run records run.host-bound. */
export function bindTaskKernelRunDispatchOwnerV1(
  rootValue: string,
  request: {
    leaseId: string;
    taskId: string;
    runId: string;
    owner: TaskKernelRunDispatchOwnerV1;
  },
): TaskKernelRunDispatchOwnerBindingResultV1 {
  const root = path.resolve(rootValue);
  return withProjectSchedulerMutex(root, () => {
    const denied = (
      reasonCode: string,
    ): TaskKernelRunDispatchOwnerBindingResultV1 => ({
      bound: false,
      reasonCode,
      leaseId: request.leaseId,
      receipt: null,
      receiptFile: null,
    });
    const leaseFile = projectActiveLeasePath(root, request.leaseId);
    if (!fs.existsSync(leaseFile)) return denied("dispatch-lease-not-active");
    let lease: DispatchLease;
    let admission: TaskKernelRunDispatchDecisionReceiptV1;
    try {
      lease = JSON.parse(fs.readFileSync(leaseFile, "utf8")) as DispatchLease;
      if (
        lease.owner_kind !== "task-kernel-v2-run" ||
        lease.id !== request.leaseId ||
        lease.task_id !== request.taskId ||
        lease.run_id !== request.runId ||
        lease.status !== "active" ||
        !validOwner(lease.dispatch_owner) ||
        !validOwner(lease.admission_owner)
      )
        return denied("dispatch-lease-identity-mismatch");
      admission = readAdmissionReceipt(
        root,
        lease.admission_receipt_fingerprint,
      );
      if (
        admission.leaseId !== lease.id ||
        admission.request.taskId !== lease.task_id ||
        admission.request.runId !== lease.run_id ||
        admission.request.scheduleReceiptFingerprint !==
          lease.schedule_receipt_fingerprint ||
        !sameOwner(admission.owner, lease.admission_owner)
      )
        return denied("dispatch-lease-receipt-mismatch");
    } catch {
      return denied("dispatch-lease-record-invalid");
    }
    const owner = normalizeOwner(request.owner);
    if (!owner) return denied("dispatch-owner-missing-or-invalid");
    if (!ownerCanBind(lease.dispatch_owner, owner))
      return denied("dispatch-owner-binding-not-monotonic");
    let schedule: TaskKernelScheduleDecisionReceiptV1;
    try {
      schedule = readTaskKernelScheduleReceipt(
        root,
        lease.schedule_receipt_fingerprint,
      );
    } catch {
      return denied("schedule-receipt-integrity-failed");
    }
    let inspected: ReturnType<typeof inspectTaskRun>;
    try {
      inspected = inspectTaskRun(
        root,
        schedule,
        {
          scheduleReceiptFingerprint: lease.schedule_receipt_fingerprint,
          taskId: request.taskId,
          runId: request.runId,
        },
        false,
      );
    } catch {
      return denied("task-kernel-snapshot-invalid-or-missing");
    }
    if (!inspected.checked)
      return denied(inspected.reasonCodes[0] ?? "task-run-not-dispatchable");
    if (!runHostMatchesOwner(inspected.checked.run, owner))
      return denied("task-run-host-binding-mismatch");
    const hostBoundEvent = inspected.checked.kernel.events.find(
      (event) =>
        (event.type as string) === "run.host-bound" &&
        event.entityId === request.runId,
    );
    if (!hostBoundEvent) return denied("task-run-host-bound-event-required");
    if (sameOwner(lease.dispatch_owner, owner)) {
      if (lease.owner_binding_receipt_fingerprint) {
        const reason = verifyOwnerBinding(
          root,
          lease,
          inspected.checked.kernel,
          inspected.checked.run,
        );
        if (reason) return denied(reason);
        const receipt = readOwnerBindingReceipt(
          root,
          lease.owner_binding_receipt_fingerprint,
        );
        return {
          bound: true,
          reasonCode: null,
          leaseId: lease.id,
          receipt,
          receiptFile: relative(
            root,
            ownerBindingReceiptPath(root, receipt.receiptFingerprint),
          ),
        };
      }
      return {
        bound: true,
        reasonCode: null,
        leaseId: lease.id,
        receipt: null,
        receiptFile: null,
      };
    }
    if (lease.owner_binding_receipt_fingerprint) {
      return denied("dispatch-owner-already-bound");
    }
    const stored = persistOwnerBindingReceipt(root, {
      leaseId: lease.id,
      taskId: lease.task_id,
      runId: lease.run_id,
      scheduleReceiptFingerprint: lease.schedule_receipt_fingerprint,
      admissionReceiptFingerprint: lease.admission_receipt_fingerprint,
      fromOwner: lease.dispatch_owner,
      owner,
      hostBoundEventId: hostBoundEvent.id,
      taskKernelRevision: hostBoundEvent.revision,
    });
    const updated: DispatchLease = {
      ...lease,
      dispatch_owner: owner,
      owner_binding_receipt_fingerprint: stored.receipt.receiptFingerprint,
    };
    fs.writeFileSync(leaseFile, `${JSON.stringify(updated, null, 2)}\n`, {
      mode: 0o600,
    });
    return {
      bound: true,
      reasonCode: null,
      leaseId: lease.id,
      receipt: stored.receipt,
      receiptFile: relative(root, stored.file),
    };
  });
}

function writeSetCoveredByLease(
  current: readonly string[],
  reserved: readonly string[],
): boolean {
  return current.every((candidate) =>
    reserved.some(
      (held) =>
        held === "*" || candidate === held || candidate.startsWith(`${held}/`),
    ),
  );
}

function sameProjectWriteSet(left: unknown, right: unknown): boolean {
  if (
    !Array.isArray(left) ||
    !Array.isArray(right) ||
    !left.every((value) => typeof value === "string") ||
    !right.every((value) => typeof value === "string")
  )
    return false;
  try {
    return (
      JSON.stringify(normalizeProjectWriteSet(left)) ===
      JSON.stringify(normalizeProjectWriteSet(right))
    );
  } catch {
    return false;
  }
}

/** Revalidates an active lease for a follow-up send or wait operation. */
export function assertTaskKernelRunDispatchLeaseV1(
  rootValue: string,
  request: {
    leaseId: string;
    taskId: string;
    runId: string;
    allowSettled?: boolean;
  },
): TaskKernelRunDispatchLeaseAssertionV1 {
  return assertTaskKernelRunDispatchLeaseInternal(rootValue, request, null);
}

/**
 * Revalidates a writer lease immediately before first spawn, while requiring
 * the Kernel Run to remain unbound until native process identity exists.
 */
export function assertTaskKernelRunDispatchPreSpawnV1(
  rootValue: string,
  request: TaskKernelRunDispatchPreSpawnAssertionRequestV1,
): TaskKernelRunDispatchPreSpawnAssertionV1 {
  const result = assertTaskKernelRunDispatchLeaseInternal(
    rootValue,
    {
      leaseId: request.leaseId,
      taskId: request.taskId,
      runId: request.runId,
    },
    request,
  );
  return { ...result, hostBound: result.asserted ? false : null };
}

function assertTaskKernelRunDispatchLeaseInternal(
  rootValue: string,
  request: {
    leaseId: string;
    taskId: string;
    runId: string;
    allowSettled?: boolean;
  },
  preSpawn: TaskKernelRunDispatchPreSpawnAssertionRequestV1 | null,
): TaskKernelRunDispatchLeaseAssertionV1 {
  const root = path.resolve(rootValue);
  return withProjectSchedulerMutex(root, () => {
    const empty = (
      reasonCode: string,
    ): TaskKernelRunDispatchLeaseAssertionV1 => ({
      asserted: false,
      reasonCode,
      leaseId: request.leaseId,
      taskId: request.taskId,
      runId: request.runId,
      scheduleReceiptFingerprint: null,
      writeSet: null,
    });
    const leaseFile = projectActiveLeasePath(root, request.leaseId);
    if (!fs.existsSync(leaseFile)) return empty("dispatch-lease-not-active");
    let lease: DispatchLease;
    let admission: TaskKernelRunDispatchDecisionReceiptV1;
    try {
      lease = JSON.parse(fs.readFileSync(leaseFile, "utf8")) as DispatchLease;
      if (
        lease.owner_kind !== "task-kernel-v2-run" ||
        lease.id !== request.leaseId ||
        lease.task_id !== request.taskId ||
        lease.run_id !== request.runId ||
        lease.status !== "active" ||
        !validOwner(lease.dispatch_owner) ||
        !validOwner(lease.admission_owner)
      )
        return empty("dispatch-lease-identity-mismatch");
      admission = readAdmissionReceipt(
        root,
        lease.admission_receipt_fingerprint,
      );
      if (
        admission.leaseId !== request.leaseId ||
        admission.request.taskId !== request.taskId ||
        admission.request.runId !== request.runId ||
        admission.request.scheduleReceiptFingerprint !==
          lease.schedule_receipt_fingerprint ||
        !sameOwner(admission.owner, lease.admission_owner)
      )
        return empty("dispatch-lease-receipt-mismatch");
      if (!sameProjectWriteSet(admission.writeSet, lease.touches))
        return empty("dispatch-lease-write-set-mismatch");
    } catch {
      return empty("dispatch-lease-record-invalid");
    }
    if (preSpawn) {
      const expectedOwner = normalizeOwner(preSpawn.owner);
      if (
        preSpawn.scheduleReceiptFingerprint !== lease.schedule_receipt_fingerprint
      )
        return empty("schedule-receipt-fingerprint-mismatch");
      if (
        !expectedOwner ||
        !sameOwner(expectedOwner, lease.admission_owner) ||
        !sameOwner(expectedOwner, lease.dispatch_owner)
      )
        return empty("dispatch-lease-owner-mismatch");
    }
    let schedule: TaskKernelScheduleDecisionReceiptV1;
    try {
      schedule = readTaskKernelScheduleReceipt(
        root,
        lease.schedule_receipt_fingerprint,
      );
    } catch {
      return empty("schedule-receipt-integrity-failed");
    }
    let inspected: ReturnType<typeof inspectTaskRun>;
    try {
      inspected = inspectTaskRun(
        root,
        schedule,
        {
          scheduleReceiptFingerprint: lease.schedule_receipt_fingerprint,
          taskId: request.taskId,
          runId: request.runId,
        },
        false,
      );
    } catch {
      return empty("task-kernel-snapshot-invalid-or-missing");
    }
    if (!inspected.checked) {
      if (!request.allowSettled)
        return empty(inspected.reasonCodes[0] ?? "task-run-not-dispatchable");
      let read: ReturnType<typeof readTaskKernel>;
      try {
        const taskDir = resolveTaskDir(root, request.taskId);
        read = readTaskKernel({ root, taskDir });
      } catch {
        return empty("task-kernel-snapshot-invalid-or-missing");
      }
      if (
        read.kind !== "task-kernel-v2" ||
        read.kernel.runs.at(-1)?.id !== request.runId
      )
        return empty("task-run-id-mismatch");
      const settledRun = read.kernel.runs.at(-1);
      if (
        !settledRun ||
        !["completed", "failed", "blocked"].includes(settledRun.state)
      )
        return empty(inspected.reasonCodes[0] ?? "task-run-not-settled");
      const dependencies = [...read.kernel.definition.dependencies];
      for (const dependencyId of dependencies) {
        let dependency: ReturnType<typeof readTaskKernel>;
        try {
          dependency = readTaskKernel({
            root,
            taskDir: resolveTaskDir(root, dependencyId),
          });
        } catch {
          return empty(`hard-dependency-missing-or-invalid:${dependencyId}`);
        }
        if (dependency.kind !== "task-kernel-v2")
          return empty(`hard-dependency-not-v2-closed:${dependencyId}`);
        const projection = projectTaskKernelLifecycle(dependency.kernel);
        if (!projection.closed || projection.outcome !== "completed")
          return empty(`hard-dependency-not-closed:${dependencyId}`);
      }
      const latestRun = read.kernel.runs.at(-1);
      if (!latestRun) return empty("task-run-missing");
      const ownerBindingReason = verifyOwnerBinding(
        root,
        lease,
        read.kernel,
        latestRun,
      );
      if (ownerBindingReason) return empty(ownerBindingReason);
      const currentWriteSet = normalizeProjectWriteSet([
        ...latestRun.writeSetSnapshot,
        ...(latestRun.workspace?.writeSet ?? []),
      ]);
      if (!writeSetCoveredByLease(currentWriteSet, lease.touches))
        return empty("task-run-write-set-expanded");
      return {
        asserted: true,
        reasonCode: null,
        leaseId: lease.id,
        taskId: lease.task_id,
        runId: lease.run_id,
        scheduleReceiptFingerprint: lease.schedule_receipt_fingerprint,
        writeSet: lease.touches,
      };
    }
    if (!writeSetCoveredByLease(inspected.checked.writeSet, lease.touches))
      return empty("task-run-write-set-expanded");
    if (!sameProjectWriteSet(admission.writeSet, lease.touches))
      return empty("dispatch-lease-write-set-mismatch");
    if (preSpawn) {
      if (inspected.checked.run.host)
        return empty("task-run-host-already-bound");
      if (
        lease.owner_binding_receipt_fingerprint ||
        !sameOwner(lease.admission_owner, lease.dispatch_owner)
      )
        return empty("owner-binding-receipt-required");
      const ownerBindingReason = verifyOwnerBinding(
        root,
        lease,
        inspected.checked.kernel,
        inspected.checked.run,
      );
      if (ownerBindingReason && ownerBindingReason !== "task-run-host-binding-mismatch")
        return empty(ownerBindingReason);
    } else {
      const ownerBindingReason = verifyOwnerBinding(
        root,
        lease,
        inspected.checked.kernel,
        inspected.checked.run,
      );
      if (ownerBindingReason) return empty(ownerBindingReason);
    }
    return {
      asserted: true,
      reasonCode: null,
      leaseId: lease.id,
      taskId: lease.task_id,
      runId: lease.run_id,
      scheduleReceiptFingerprint: lease.schedule_receipt_fingerprint,
      writeSet: lease.touches,
    };
  });
}

/** Read-only proof gate, usable by host adapters before mutating the lease. */
export function validateTaskKernelRunDispatchStopProofV1(
  rootValue: string,
  request: TaskKernelRunDispatchStopProofValidationRequestV1,
): TaskKernelRunDispatchStopProofValidationV1 {
  const root = path.resolve(rootValue);
  return withProjectSchedulerMutex(root, () => {
    const leaseFile = projectActiveLeasePath(root, request.leaseId);
    if (!fs.existsSync(leaseFile))
      return {
        valid: false,
        reasonCode: "dispatch-lease-not-active",
        proof: null,
      };
    let lease: DispatchLease;
    try {
      lease = JSON.parse(fs.readFileSync(leaseFile, "utf8")) as DispatchLease;
    } catch {
      return {
        valid: false,
        reasonCode: "dispatch-lease-record-invalid",
        proof: null,
      };
    }
    if (
      lease.owner_kind !== "task-kernel-v2-run" ||
      lease.id !== request.leaseId ||
      lease.task_id !== request.taskId ||
      lease.run_id !== request.runId ||
      lease.status !== "active" ||
      !validOwner(lease.admission_owner) ||
      !validOwner(lease.dispatch_owner)
    )
      return {
        valid: false,
        reasonCode: "dispatch-lease-identity-mismatch",
        proof: null,
      };
    if (!nonEmptyString(request.stopReceiptRef))
      return {
        valid: false,
        reasonCode: "verified-stop-receipt-required",
        proof: null,
      };
    return validateStopProofForActiveLease(root, request, lease);
  });
}

/** Releases only after a caller has persisted its verified terminal stop receipt. */
export function releaseTaskKernelRunDispatchV1(
  rootValue: string,
  request: TaskKernelRunDispatchStopProofValidationRequestV1,
): TaskKernelRunDispatchReleaseResultV1 {
  const root = path.resolve(rootValue);
  return withProjectSchedulerMutex(root, () => {
    const leaseFile = projectActiveLeasePath(root, request.leaseId);
    const historyFile = projectLeaseHistoryPath(root, request.leaseId);
    if (!fs.existsSync(leaseFile)) {
      const history = fs.existsSync(historyFile)
        ? relative(root, historyFile)
        : null;
      return {
        released: false,
        reasonCode: history
          ? "lease-already-released"
          : "dispatch-lease-not-found",
        leaseId: request.leaseId,
        receiptFile: history,
      };
    }
    let value: DispatchLease;
    try {
      value = JSON.parse(fs.readFileSync(leaseFile, "utf8")) as DispatchLease;
    } catch {
      return {
        released: false,
        reasonCode: "dispatch-lease-record-invalid",
        leaseId: request.leaseId,
        receiptFile: null,
      };
    }
    if (
      value.owner_kind !== "task-kernel-v2-run" ||
      value.id !== request.leaseId ||
      value.task_id !== request.taskId ||
      value.run_id !== request.runId ||
      value.status !== "active" ||
      !validOwner(value.admission_owner) ||
      !validOwner(value.dispatch_owner)
    )
      return {
        released: false,
        reasonCode: "dispatch-lease-identity-mismatch",
        leaseId: request.leaseId,
        receiptFile: null,
      };
    if (!nonEmptyString(request.stopReceiptRef))
      return {
        released: false,
        reasonCode: "verified-stop-receipt-required",
        leaseId: request.leaseId,
        receiptFile: null,
      };
    const validation = validateStopProofForActiveLease(root, request, value);
    if (!validation.valid)
      return {
        released: false,
        reasonCode: validation.reasonCode,
        leaseId: request.leaseId,
        receiptFile: null,
      };
    const proofFile = projectFile(root, request.stopReceiptRef);
    const history = {
      ...value,
      status: "released" as const,
      released_at: new Date().toISOString(),
      stop_receipt_ref: relative(root, proofFile),
      stop_proof_fingerprint: validation.proof.proof_fingerprint,
      release_disposition: validation.proof.disposition,
    };
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    if (fs.existsSync(historyFile))
      return {
        released: false,
        reasonCode: "lease-history-already-exists",
        leaseId: request.leaseId,
        receiptFile: relative(root, historyFile),
      };
    fs.writeFileSync(historyFile, `${JSON.stringify(history, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    fs.rmSync(leaseFile, { force: true });
    return {
      released: true,
      reasonCode: null,
      leaseId: request.leaseId,
      receiptFile: relative(root, historyFile),
    };
  });
}
