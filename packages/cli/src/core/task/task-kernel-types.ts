import type { KernelAuditEvent, KernelCondition, KernelOutcome, KernelPhase } from "./kernel-contract.js";
import type { readKernel } from "./kernel-store.js";

export const TASK_KERNEL_SCHEMA_VERSION = 2 as const;

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

export type TaskRunState = "waiting" | "running" | "completed" | "failed" | "blocked";

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
  reclamationState: "not-requested" | "pending" | "reclaimed" | "failed";
}

/** Optional host receipt binding; the Task Kernel itself remains host-neutral. */
export interface TaskRunHostBinding {
  host: string;
  role: string;
  sessionId: string | null;
  threadId: string | null;
  kernelRevision: number;
  contractFingerprint: string;
  requestRefs: string[];
  eventRefs: string[];
  resultRefs: string[];
  assuranceSource: string | null;
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
  workspace?: Omit<TaskRunWorkspaceBinding, "ownerRunId">;
  host?: Omit<TaskRunHostBinding, "kernelRevision" | "contractFingerprint"> & {
    kernelRevision?: number;
    contractFingerprint?: string;
  };
  cwd?: string;
}

export interface RecordTaskRunResultRequest {
  root: string;
  taskDir: string;
  expectedRevision: number;
  runId: string;
  outcome: "completed" | "failed" | "blocked";
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
