/**
 * Task Kernel public facade.
 *
 * The implementation is split by stable lifecycle responsibilities; all writes
 * still go through the single kernel.json store and mutation authority.
 */

export type {
  TaskDeliveryLevel,
  TaskAcceptanceCriterion,
  TaskDefinitionV2,
  TaskSnapshotEntry,
  TaskCandidateSnapshot,
  TaskCandidateObservation,
  TaskRunInput,
  TaskRunAuthorization,
  TaskRunState,
  TaskRunDurations,
  TaskRunMeasurementRefs,
  TaskRunResult,
  TaskRunEvidenceSource,
  TaskRunEvidenceItemV1,
  TaskRunEvidenceVerificationV1,
  TaskRunFailure,
  TaskRunWorkspaceBinding,
  TaskRunWorkspaceManagerBinding,
  TaskRunWorkspaceIntegrationReceipt,
  TaskRunWorkspaceCleanupLease,
  TaskRunHostBinding,
  TaskRunHostStopReceipt,
  TaskRunV2,
  TaskReviewDecision,
  TaskReviewEvidenceSource,
  TaskReviewEvidenceItemV1,
  TaskReviewEvidenceVerificationV1,
  TaskReviewV2,
  TaskDeliveryEvidence,
  TaskClosureV2,
  TaskKernelEventType,
  TaskKernelEventV2,
  TaskKernelSnapshotV2,
  TaskKernelMutationResult,
  CreateTaskKernelRequest,
  AddTaskDependencyRequest,
  StartTaskRunRequest,
  RecordTaskRunResultRequest,
  RecordTaskReviewRequest,
  CloseTaskKernelRequest,
  CheckTaskCloseRequest,
  ResumeTaskRunRequest,
  BindTaskRunHostReceiptRequest,
  AppendTaskRunHostSettlementRefsRequest,
  RecordTaskRunHostStopReceiptRequest,
  BindTaskRunWorkspaceRequest,
  RecordTaskRunWorkspaceIntegrationRequest,
  AcquireTaskRunWorkspaceCleanupLeaseRequest,
  FinishTaskRunWorkspaceCleanupRequest,
  RecordTaskRunWorkspaceCleanupRefusalRequest,
  RecordTaskRunWorkspaceClaimRefusalRequest,
  TaskRunWorkspaceClaimOperation,
  TaskRunWorkspaceClaimErrorCode,
  TaskKernelReadResult,
  LegacyTaskKernelReadResult,
  AnyTaskKernelReadResult,
  TaskKernelLifecycleProjection,
} from "./task-kernel-types.js";

export {
  TASK_KERNEL_SCHEMA_VERSION,
  TASK_DELIVERY_LEVELS,
  TASK_RUN_WORKSPACE_CLAIM_ERROR_CODES,
} from "./task-kernel-types.js";
export {
  isTaskDeliveryLevel,
  fingerprintTaskValue,
  createTaskCandidateSnapshot,
  projectTaskKernelLifecycle,
  parseTaskKernelSnapshotV2,
} from "./task-kernel-schema.js";
export {
  readTaskKernel,
  createTaskKernel,
  listTaskKernelSnapshots,
  readTaskKernelOverview,
} from "./task-kernel-store-v2.js";
export { addTaskDependency } from "./task-kernel-dependencies.js";
export {
  startTaskRun,
  resumeTaskRun,
  recordTaskRunResult,
} from "./task-kernel-runs.js";
export {
  bindTaskRunHostReceipt,
  appendTaskRunHostSettlementRefs,
  recordTaskRunHostStopReceipt,
} from "./task-kernel-host.js";
export {
  bindTaskRunWorkspace,
  recordTaskRunWorkspaceIntegration,
  acquireTaskRunWorkspaceCleanupLease,
  finishTaskRunWorkspaceCleanup,
  recordTaskRunWorkspaceCleanupRefusal,
  recordTaskRunWorkspaceClaimRefusal,
} from "./task-kernel-workspaces.js";
export { recordTaskReview } from "./task-kernel-reviews.js";
export {
  resolveTaskReviewEvidenceV1,
  verifyTaskReviewEvidenceV1,
} from "./task-review-evidence.js";
export type {
  ResolveTaskReviewEvidenceV1Request,
  VerifyTaskReviewEvidenceV1Request,
} from "./task-review-evidence.js";
export { checkTaskClose, closeTaskKernel } from "./task-kernel-close.js";
