import { randomUUID } from "node:crypto";

import {
  KernelError,
  requireNonEmptyString,
  type KernelCondition,
} from "./kernel-contract.js";
import { appendDomainEvent, mutateTaskKernel } from "./task-kernel-store-v2.js";
import {
  fingerprintTaskValue,
  parseAcceptanceEvidence,
  parseMeasurementRefs,
  parseStringArray,
  REVIEW_DECISIONS,
} from "./task-kernel-schema.js";
import { canonicalProjectRoot } from "./task-kernel-paths.js";
import type {
  RecordTaskReviewRequest,
  TaskKernelMutationResult,
  TaskReviewV2,
} from "./task-kernel-types.js";
import { resolveTaskReviewEvidenceV1 } from "./task-review-evidence.js";

export function recordTaskReview(
  request: RecordTaskReviewRequest,
): TaskKernelMutationResult {
  const root = canonicalProjectRoot(request.root, request.cwd);
  const actor = requireNonEmptyString(request.actor, "actor");
  const fingerprint = fingerprintTaskValue({
    runId: request.runId,
    candidateSnapshotId: request.candidateSnapshotId,
    candidateFingerprint: request.candidateFingerprint,
    reviewer: request.reviewer,
    reviewId: request.reviewId ?? null,
    decision: request.decision,
    evidenceRefs: request.evidenceRefs,
    acceptanceEvidence: request.acceptanceEvidence ?? {},
    unresolvedBlockers: request.unresolvedBlockers ?? [],
    measurementRef: request.measurementRef ?? null,
  });
  return mutateTaskKernel(
    root,
    request.taskDir,
    request.expectedRevision,
    actor,
    request.idempotencyKey,
    fingerprint,
    request.cwd,
    (current) => {
      if (current.phase !== "verify")
        throw new KernelError(
          "INVALID_TRANSITION",
          `Review requires Verify phase, got ${current.phase}`,
        );
      const runIndex = current.runs.findIndex(
        (candidate) => candidate.id === request.runId,
      );
      const run = current.runs[runIndex];
      if (
        run?.state !== "completed" ||
        !run.candidateSnapshot ||
        current.runs.at(-1)?.id !== run.id
      )
        throw new KernelError(
          "INVALID_TRANSITION",
          "Review requires the latest completed Run with a candidate snapshot",
        );
      if (
        request.candidateSnapshotId !== run.candidateSnapshot.id ||
        request.candidateFingerprint !== run.candidateSnapshot.fingerprint
      )
        throw new KernelError(
          "CANDIDATE_MISMATCH",
          "Review candidate snapshot ID and fingerprint must match the Run snapshot",
        );
      const reviewer = requireNonEmptyString(request.reviewer, "reviewer");
      const reviewId = request.reviewId === undefined
        ? randomUUID()
        : requireNonEmptyString(request.reviewId, "reviewId");
      if (reviewId.length > 128) {
        throw new KernelError("INVALID_REQUEST", "reviewId cannot exceed 128 characters");
      }
      if (current.reviews.some((item) => item.id === reviewId)) {
        throw new KernelError("INVALID_REQUEST", `Review ID already exists: ${reviewId}`);
      }
      if (reviewer !== actor)
        throw new KernelError(
          "REVIEW_NOT_INDEPENDENT",
          "the Review actor must match the recorded reviewer",
        );
      if (
        reviewer === run.startedBy ||
        reviewer === run.authorization.approvedBy
      )
        throw new KernelError(
          "REVIEW_NOT_INDEPENDENT",
          "Review must be performed by someone other than the Run executor and approver",
        );
      if (!(REVIEW_DECISIONS as readonly string[]).includes(request.decision))
        throw new KernelError(
          "INVALID_REQUEST",
          "Review decision must be pass, fail, or needs-changes",
        );
      const evidenceRefs = parseStringArray(
        request.evidenceRefs,
        "evidenceRefs",
      );
      const acceptanceEvidence = parseAcceptanceEvidence(
        request.acceptanceEvidence ?? {},
        current.definition.acceptanceCriteria,
        request.decision === "pass",
      );
      const unresolvedBlockers = parseStringArray(
        request.unresolvedBlockers ?? [],
        "unresolvedBlockers",
        true,
      );
      if (request.decision === "pass" && unresolvedBlockers.length)
        throw new KernelError(
          "TASK_GATE_UNSATISFIED",
          "a passing Review cannot have unresolved blockers",
        );
      const reviewEvidenceRefs = [
        ...new Set([
          ...evidenceRefs,
          ...Object.values(acceptanceEvidence).flat(),
        ]),
      ];
      const evidenceVerification = resolveTaskReviewEvidenceV1({
        root,
        taskDir: request.taskDir,
        cwd: request.cwd,
        run,
        candidateSnapshotId: run.candidateSnapshot.id,
        candidateFingerprint: run.candidateSnapshot.fingerprint,
        evidenceRefs: reviewEvidenceRefs,
      });
      const review: TaskReviewV2 = {
        id: reviewId,
        taskId: current.identity.taskId,
        runId: run.id,
        candidateSnapshotId: run.candidateSnapshot.id,
        candidateFingerprint: run.candidateSnapshot.fingerprint,
        reviewer,
        independent: true,
        decision: request.decision,
        evidenceRefs,
        acceptanceEvidence,
        evidenceVerification,
        unresolvedBlockers,
        reviewedAt: new Date().toISOString(),
      };
      const condition: KernelCondition =
        request.decision === "pass" ? "ready" : "blocked";
      const measurementRefs = parseMeasurementRefs(
        {
          ...run.measurementRefs,
          ...(request.measurementRef ? { review: request.measurementRef } : {}),
        },
        "measurementRefs",
      );
      const kernel = {
        ...current,
        condition,
        runs: current.runs.map((item, index) =>
          index === runIndex ? { ...run, measurementRefs } : item,
        ),
        reviews: [...current.reviews, review],
      };
      return appendDomainEvent(
        kernel,
        actor,
        request.idempotencyKey,
        "review.recorded",
        review.id,
        fingerprint,
      );
    },
  );
}
