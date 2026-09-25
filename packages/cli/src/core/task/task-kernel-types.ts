import type { KernelAuditEvent, KernelCondition, KernelOutcome, KernelPhase } from "./kernel-contract.js";
import type { readKernel } from "./kernel-store.js";

export const TASK_KERNEL_SCHEMA_VERSION = 2 as const;
export const TASK_RUN_WORKSPACE_CLEANUP_RISK_DISCLOSURE = "An external writer may create an ignored file after the final check and before Git recursively removes this worktree; non-force git worktree remove may then delete that file.";

export const TASK_DELIVERY_LEVELS = [
  "local-result",
  "pull-request",
  "merged-result",
  "documentation",
] as const;
export type TaskDeliveryLevel = (typeof TASK_DELIVERY_LEVELS)[number];

export interface TaskAcceptanceCriterion {
  id: string;
  description: string;
}

export interface TaskDefinitionV2 {
  taskId: string;
  title: string;
  description: string;
  deliverable: string;
  deliveryLevel: TaskDeliveryLevel;
  acceptanceCriteria: TaskAcceptanceCriterion[];
  /** Every dependency is a hard requirement and must be closed successfully. */
  dependencies: string[];
  createdAt: string;
  createdBy: string;
}

export interface TaskSnapshotEntry {
  ref: string;
  fingerprint: string;
}

export interface TaskCandidateSnapshot {
  id: string;
  entries: TaskSnapshotEntry[];
  fingerprint: string;
}

/** Caller-supplied observation of the candidate at Close time. The Kernel checks
 * identity/fingerprint agreement, but does not inspect Git or filesystem bytes. */
export interface TaskCandidateObservation {
  snapshotId: string;
  fingerprint: string;
  observedBy: string;
  observedAt: string;
  source: string;
  evidenceRef: string;
}

export interface TaskRunInput {
  summary: string;
  references: string[];
  fingerprint: string;
}

export interface TaskRunAuthorization {
  approvedBy: string;
  approvedAt: string;
  scope: string;
  evidenceRef: string;
}

export type TaskRunState = "waiting" | "running" | "completed" | "failed" | "blocked" | "cancelled";

export interface TaskRunDurations {
  executionMs: number | null;
  waitingMs: number | null;
  reviewMs: number | null;
}

export interface TaskRunMeasurementRefs {
  execution: string | null;
  waiting: string | null;
  review: string | null;
}

export interface TaskRunResult {
  summary: string;
  evidenceRefs: string[];
}

export interface TaskRunFailure {
  category: string;
  message: string;
  evidenceRef: string | null;
}

/** Optional workspace facts reserved for a Run-owned checkout lifecycle. */
export interface TaskRunWorkspaceBinding {
  ownerRunId: string;
  canonicalPath: string;
  branch: string;
  baseSha: string;
  writeSet: string[];
  integrationState: "not-integrated" | "integrated";
  reclamationState: "not-requested" | "pending" | "reclaimed" | "failed" | "recovery-required";
  /** Present only when the Pactile worktree manager created or explicitly adopted this checkout. */
  manager: TaskRunWorkspaceManagerBinding | null;
  integrationReceipt: TaskRunWorkspaceIntegrationReceipt | null;
  cleanupLease: TaskRunWorkspaceCleanupLease | null;
}

export interface TaskRunWorkspaceManagerBinding {
  version: 1;
  credentialId: string;
  projectRoot: string;
  commonDir: string;
  gitDir: string;
  source: "created" | "adopted";
  recordedAt: string;
}

export interface TaskRunWorkspaceIntegrationReceipt {
  runId: string;
  worktreeHeadSha: string;
  targetRef: string;
  targetBranch: string;
  targetHeadSha: string;
  verifiedAt: string;
  resultEvidenceRefs: string[];
  candidateSnapshotId: string;
  candidateFingerprint: string;
  /** Digest of Run changed-path tree entries, the integrated target entries, and candidate identity. */
  contentFingerprint?: string;
}

export interface TaskRunWorkspaceCleanupLease {
  leaseId: string;
  state: "held" | "reclaimed" | "retained" | "partial-removal" | "recovery-required";
  processId: number;
  acquiredAt: string;
  expectedHeadSha: string;
  targetBranch: string;
  targetHeadSha: string;
  receiptRef: string;
  reason: string | null;
  riskDisclosure?: string;
}

export interface TaskRunHostStopReceipt {
  source: string;
  assurance: string;
  evidenceLevel: string;
  taskId: string;
  runId: string;
  sessionId: string | null;
  threadId: string | null;
  startRequestId: string;
  settleReceiptId: string;
  terminalStatus: string;
  requestKernelRevision: number;
  receiptKernelRevision: number;
  contractFingerprint: string;
  contractStale: boolean;
  candidateSnapshotId: string | null;
  candidateFingerprint: string | null;
  candidateSource: "captured" | "derived" | null;
  receiptRef: string;
  evidenceRef: string;
  recordedAt: string;
}

/** Optional host receipt binding; the Task Kernel itself remains host-neutral. */
export interface TaskRunHostBinding {
  host: string;
  role: string;
  sessionId: string | null;
  hostId?: string | null;
  threadId: string | null;
  kernelRevision: number;
  contractFingerprint: string;
  requestRefs: string[];
  eventRefs: string[];
  resultRefs: string[];
  assuranceSource: string | null;
  stopReceipt: TaskRunHostStopReceipt | null;
}

export interface TaskRunV2 {
  id: string;
  taskId: string;
  /** One-based retry/attempt count, stable for this Run for its lifetime. */
  attempt: number;
  sequence: number;
  state: TaskRunState;
  startedAt: string;
  startedBy: string;
  input: TaskRunInput;
  authorization: TaskRunAuthorization;
  writeSetSnapshot: string[];
  estimatedDurations: TaskRunDurations;
  measurementRefs: TaskRunMeasurementRefs;
  workspace: TaskRunWorkspaceBinding | null;
  host: TaskRunHostBinding | null;
  candidateSnapshot: TaskCandidateSnapshot | null;
  result: TaskRunResult | null;
  failure: TaskRunFailure | null;
  completedAt: string | null;
}

export type TaskReviewDecision = "pass" | "fail" | "needs-changes";

export interface TaskReviewV2 {
  id: string;
  taskId: string;
  runId: string;
  candidateSnapshotId: string;
  candidateFingerprint: string;
  reviewer: string;
  independent: true;
  decision: TaskReviewDecision;
  evidenceRefs: string[];
  acceptanceEvidence: Record<string, string[]>;
  unresolvedBlockers: string[];
  reviewedAt: string;
}

export interface TaskDeliveryEvidence {
  level: TaskDeliveryLevel;
  reference: string;
  summary: string;
}

export interface TaskClosureV2 {
  runId: string;
  reviewId: string;
  candidateSnapshotId: string;
  candidateFingerprint: string;
  candidateObservation: TaskCandidateObservation;
  deliveryEvidence: TaskDeliveryEvidence;
  acceptanceEvidence: Record<string, string[]>;
  closedAt: string;
  closedBy: string;
}

export type TaskKernelEventType =
  | "task.created"
  | "task.dependency-added"
  | "run.queued"
  | "run.started"
  | "run.resumed"
  | "run.completed"
  | "run.failed"
  | "run.blocked"
  | "run.cancelled"
  | "run.host-bound"
  | "run.host-settlement-recorded"
  | "run.host-settled"
  | "run.workspace-bound"
  | "run.workspace-integrated"
  | "run.workspace-cleanup-acquired"
  | "run.workspace-reclaimed"
  | "run.workspace-retained"
  | "run.workspace-recovery-required"
  | "review.recorded"
  | "task.closed";

export interface TaskKernelEventV2 {
  id: string;
  revision: number;
  at: string;
  actor: string;
  idempotencyKey: string;
  type: TaskKernelEventType;
  entityId: string;
  requestFingerprint: string;
}

export interface TaskKernelSnapshotV2 {
  schemaVersion: typeof TASK_KERNEL_SCHEMA_VERSION;
  identity: { taskId: string };
  revision: number;
  phase: KernelPhase;
  condition: KernelCondition;
  outcome: KernelOutcome | null;
  definition: TaskDefinitionV2;
  runs: TaskRunV2[];
  reviews: TaskReviewV2[];
  closure: TaskClosureV2 | null;
  audit: KernelAuditEvent[];
  events: TaskKernelEventV2[];
}

export interface TaskKernelMutationResult {
  kernel: TaskKernelSnapshotV2;
  idempotent: boolean;
  audit: KernelAuditEvent;
  event: TaskKernelEventV2;
}

export interface CreateTaskKernelRequest {
  root: string;
  taskDir: string;
  definition: Omit<TaskDefinitionV2, "createdAt" | "createdBy">;
  actor: string;
  idempotencyKey: string;
  cwd?: string;
}

export interface AddTaskDependencyRequest {
  root: string;
  taskDir: string;
  expectedRevision: number;
  dependencyId: string;
  actor: string;
  idempotencyKey: string;
  cwd?: string;
}

export interface StartTaskRunRequest {
  root: string;
  taskDir: string;
  expectedRevision: number;
  actor: string;
  idempotencyKey: string;
  input: Omit<TaskRunInput, "fingerprint">;
  authorization: TaskRunAuthorization;
  initialState?: "waiting" | "running";
  writeSetSnapshot?: string[];
  estimatedDurations?: Partial<TaskRunDurations>;
  workspace?: Omit<TaskRunWorkspaceBinding, "ownerRunId" | "manager" | "integrationReceipt" | "cleanupLease">;
  host?: Omit<TaskRunHostBinding, "kernelRevision" | "contractFingerprint" | "stopReceipt"> & {
    kernelRevision?: number;
    contractFingerprint?: string;
  };
  cwd?: string;
}

export interface BindTaskRunHostReceiptRequest {
  root: string;
  taskDir: string;
  expectedRevision: number;
  runId: string;
  host: Omit<TaskRunHostBinding, "kernelRevision" | "contractFingerprint" | "stopReceipt">;
  actor: string;
  idempotencyKey: string;
  cwd?: string;
}

export interface BindTaskRunWorkspaceRequest {
  root: string;
  taskDir: string;
  expectedRevision: number;
  runId: string;
  workspace: TaskRunWorkspaceBinding;
  actor: string;
  idempotencyKey: string;
  cwd?: string;
}

export interface RecordTaskRunWorkspaceIntegrationRequest {
  root: string;
  taskDir: string;
  expectedRevision: number;
  runId: string;
  receipt: TaskRunWorkspaceIntegrationReceipt;
  actor: string;
  idempotencyKey: string;
  cwd?: string;
}

export interface AcquireTaskRunWorkspaceCleanupLeaseRequest {
  root: string;
  taskDir: string;
  expectedRevision: number;
  runId: string;
  lease: Omit<TaskRunWorkspaceCleanupLease, "state" | "reason">;
  actor: string;
  idempotencyKey: string;
  cwd?: string;
}

export interface FinishTaskRunWorkspaceCleanupRequest {
  root: string;
  taskDir: string;
  expectedRevision: number;
  runId: string;
  leaseId: string;
  result: "reclaimed" | "retained" | "partial-removal" | "recovery-required";
  reason?: string | null;
  updatedManagerBinding?: TaskRunWorkspaceManagerBinding;
  actor: string;
  idempotencyKey: string;
  cwd?: string;
}

export interface AppendTaskRunHostSettlementRefsRequest {
  root: string;
  taskDir: string;
  expectedRevision: number;
  runId: string;
  requestRefs?: string[];
  eventRefs?: string[];
  resultRefs?: string[];
  actor: string;
  idempotencyKey: string;
  cwd?: string;
}

export interface RecordTaskRunHostStopReceiptRequest {
  root: string;
  taskDir: string;
  expectedRevision: number;
  runId: string;
  receipt: TaskRunHostStopReceipt;
  actor: string;
  idempotencyKey: string;
  cwd?: string;
}

export interface RecordTaskRunResultRequest {
  root: string;
  taskDir: string;
  expectedRevision: number;
  runId: string;
  outcome: "completed" | "failed" | "blocked" | "cancelled";
  summary?: string;
  evidenceRefs?: string[];
  candidateEntries?: TaskSnapshotEntry[];
  measurementRefs?: Partial<TaskRunMeasurementRefs>;
  failure?: Omit<TaskRunFailure, "evidenceRef"> & { evidenceRef?: string | null };
  actor: string;
  idempotencyKey: string;
  cwd?: string;
}

export interface RecordTaskReviewRequest {
  root: string;
  taskDir: string;
  expectedRevision: number;
  runId: string;
  candidateSnapshotId: string;
  candidateFingerprint: string;
  reviewer: string;
  decision: TaskReviewDecision;
  evidenceRefs: string[];
  acceptanceEvidence?: Record<string, string[]>;
  unresolvedBlockers?: string[];
  measurementRef?: string;
  actor: string;
  idempotencyKey: string;
  cwd?: string;
}

export interface CloseTaskKernelRequest {
  root: string;
  taskDir: string;
  expectedRevision: number;
  runId: string;
  reviewId: string;
  candidateObservation: TaskCandidateObservation;
  deliveryEvidence: TaskDeliveryEvidence;
  actor: string;
  idempotencyKey: string;
  cwd?: string;
}

export type CheckTaskCloseRequest = Omit<CloseTaskKernelRequest, "idempotencyKey" | "actor">;

export interface TaskKernelReadResult {
  kind: "task-kernel-v2";
  kernel: TaskKernelSnapshotV2;
}

export interface LegacyTaskKernelReadResult {
  kind: "legacy-task-kernel-v1";
  kernel: ReturnType<typeof readKernel>;
}

export type AnyTaskKernelReadResult = TaskKernelReadResult | LegacyTaskKernelReadResult;

export interface TaskKernelLifecycleProjection {
  taskId: string;
  revision: number;
  phase: KernelPhase;
  condition: KernelCondition;
  outcome: KernelOutcome | null;
  deliveryLevel: TaskDeliveryLevel;
  dependencies: string[];
  closed: boolean;
  approvalSnapshot: {
    recorded: boolean;
    runId: string | null;
    approvedBy: string | null;
    approvedAt: string | null;
    scope: string | null;
    evidenceRef: string | null;
  };
  /** Read-only facts at `revision`; authorization and dependency outcomes still
   * have to be checked by the Kernel mutation that consumes them. */
  gateSnapshot: {
    kernelRevision: number;
    runStart: {
      phaseAllowsRun: boolean;
      activeRunId: string | null;
      hardDependencies: string[];
      dependencyKernelCheckRequired: boolean;
    };
    review: {
      phaseAllowsReview: boolean;
      runId: string | null;
      candidateSnapshotId: string | null;
      latestReviewId: string | null;
      latestDecision: TaskReviewDecision | null;
      unresolvedBlockers: string[];
    };
    close: {
      phaseAllowsClose: boolean;
      runId: string | null;
      reviewId: string | null;
      candidateSnapshotId: string | null;
      candidateFingerprint: string | null;
      missingAcceptanceCriteria: string[];
      unresolvedBlockers: string[];
      currentCandidateObservationRequired: true;
      deliveryEvidenceRequired: true;
    };
  };
}
export interface ResumeTaskRunRequest {
  root: string;
  taskDir: string;
  expectedRevision: number;
  runId: string;
  actor: string;
  idempotencyKey: string;
  cwd?: string;
}
