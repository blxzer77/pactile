import { KernelError, requireNonEmptyString } from "./kernel-contract.js";
import { appendDomainEvent, appendPhase, mutateTaskKernel, readTaskKernel } from "./task-kernel-store-v2.js";
import {
  fingerprintTaskValue,
  getOwnRecordValue,
  parseCandidateObservation,
  parseDeliveryEvidence,
} from "./task-kernel-schema.js";
import {
  assertHardDependenciesSatisfied,
  canonicalProjectRoot,
  resolveInsideTaskRoot,
} from "./task-kernel-paths.js";
import type {
  CheckTaskCloseRequest,
  CloseTaskKernelRequest,
  TaskCandidateObservation,
  TaskClosureV2,
  TaskDeliveryEvidence,
  TaskKernelMutationResult,
  TaskKernelSnapshotV2,
} from "./task-kernel-types.js";

export function checkTaskClose(request: CheckTaskCloseRequest): string[] {
  const root = canonicalProjectRoot(request.root, request.cwd);
  const read = readTaskKernel({ root, taskDir: request.taskDir, cwd: request.cwd });
  if (read.kind !== "task-kernel-v2") throw new KernelError("INVALID_REQUEST", "Close requires a Task Kernel schema v2 task");
  const errors = taskCloseErrors(read.kernel, root, request.runId, request.reviewId, request.candidateObservation, request.deliveryEvidence, resolveInsideTaskRoot(root, request.taskDir, request.cwd));
  if (request.expectedRevision !== read.kernel.revision) errors.unshift(`revision conflict: expected ${request.expectedRevision}, current ${read.kernel.revision}`);
  return errors;
}

export function closeTaskKernel(request: CloseTaskKernelRequest): TaskKernelMutationResult {
  const root = canonicalProjectRoot(request.root, request.cwd);
  const actor = requireNonEmptyString(request.actor, "actor");
  const fingerprint = fingerprintTaskValue({ runId: request.runId, reviewId: request.reviewId, candidateObservation: request.candidateObservation, deliveryEvidence: request.deliveryEvidence });
  return mutateTaskKernel(root, request.taskDir, request.expectedRevision, actor, request.idempotencyKey, fingerprint, request.cwd, (current, dir) => {
    const errors = taskCloseErrors(current, root, request.runId, request.reviewId, request.candidateObservation, request.deliveryEvidence, dir);
    if (errors.length) throw new KernelError("TASK_GATE_UNSATISFIED", errors.join("; "));
    const run = current.runs.find((item) => item.id === request.runId);
    const review = current.reviews.find((item) => item.id === request.reviewId);
    if (!run || !review || !run.candidateSnapshot) throw new KernelError("TASK_GATE_UNSATISFIED", "Close references a missing or incomplete Run or Review");
    const closure: TaskClosureV2 = {
      runId: run.id, reviewId: review.id,
      candidateSnapshotId: run.candidateSnapshot.id,
      candidateFingerprint: run.candidateSnapshot.fingerprint,
      candidateObservation: parseCandidateObservation(request.candidateObservation),
      deliveryEvidence: parseDeliveryEvidence(request.deliveryEvidence, current.definition.deliveryLevel),
      acceptanceEvidence: review.acceptanceEvidence, closedAt: new Date().toISOString(), closedBy: actor,
    };
    let kernel = appendPhase(current, "close", actor, `${request.idempotencyKey}#close`, "Task acceptance and delivery evidence satisfied.");
    kernel = { ...kernel, outcome: "completed", condition: "ready", closure };
    return appendDomainEvent(kernel, actor, request.idempotencyKey, "task.closed", current.identity.taskId, fingerprint);
  });
}

export function taskCloseErrors(
  kernel: TaskKernelSnapshotV2,
  root: string,
  runId: string,
  reviewId: string,
  observationInput: TaskCandidateObservation,
  deliveryInput: TaskDeliveryEvidence,
  currentTaskDir?: string,
): string[] {
  const errors: string[] = [];
  if (kernel.phase !== "verify") errors.push(`Task must reach Verify before Close (current phase: ${kernel.phase})`);
  if (kernel.closure || kernel.phase === "close") errors.push("Task is already closed");
  const run = kernel.runs.find((item) => item.id === runId);
  if (run?.state !== "completed" || !run.candidateSnapshot) errors.push("Close requires a completed Run with a frozen candidate snapshot");
  if (run && kernel.runs.at(-1)?.id !== run.id) errors.push("Close requires the latest recorded Run; older candidates cannot be closed after a retry");
  const review = kernel.reviews.find((item) => item.id === reviewId);
  if (!review) errors.push("Close requires a recorded independent Review");
  if (run && review) {
    if (review.runId !== run.id) errors.push("Review must belong to the selected Run");
    if (review.candidateSnapshotId !== run.candidateSnapshot?.id || review.candidateFingerprint !== run.candidateSnapshot.fingerprint) errors.push("Review must match the selected Run candidate snapshot ID and fingerprint");
    if (review.independent !== true || review.reviewer === run.startedBy || review.reviewer === run.authorization.approvedBy) errors.push("Review must be independent from the Run executor and approver");
    const later = kernel.reviews.filter((candidate) => candidate.runId === run.id && candidate.candidateSnapshotId === review.candidateSnapshotId && candidate.candidateFingerprint === review.candidateFingerprint).at(-1);
    if (later?.id !== review.id) errors.push("the latest Review for the selected candidate must be used");
    if (review.decision !== "pass") errors.push("the latest Review for the selected candidate must pass");
    if (review.unresolvedBlockers.length) errors.push("the latest Review has unresolved blockers");
    if (!review.evidenceRefs.length) errors.push("the latest Review must include structured evidence references");
    for (const criterion of kernel.definition.acceptanceCriteria) {
      const refs = getOwnRecordValue(review.acceptanceEvidence, criterion.id);
      if (!refs?.length) errors.push(`acceptance evidence missing for ${criterion.id}`);
    }
  }
  try {
    const observation = parseCandidateObservation(observationInput);
    if (observation.snapshotId !== run?.candidateSnapshot?.id || observation.fingerprint !== run.candidateSnapshot.fingerprint) {
      errors.push("Close requires a caller-supplied current candidate observation matching the selected Run snapshot ID and fingerprint");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try { assertHardDependenciesSatisfied(root, kernel.definition.dependencies, currentTaskDir); }
  catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  try { parseDeliveryEvidence(deliveryInput, kernel.definition.deliveryLevel); }
  catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  return errors;
}
