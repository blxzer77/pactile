import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  KernelError,
  isKernelCondition,
  isKernelOutcome,
  isKernelPhase,
  isNonNegativeInt,
  requireNonEmptyString,
  type KernelAuditEvent,
  type KernelOutcome,
  type KernelState,
} from "./kernel-contract.js";
import { isPlainObject } from "./schema.js";
import { verifyProjectFileBaseline } from "./project-file-observer.js";
import {
  TASK_DELIVERY_LEVELS,
  TASK_KERNEL_SCHEMA_VERSION,
  TASK_RUN_WORKSPACE_CLEANUP_RISK_DISCLOSURE,
  type TaskAcceptanceCriterion,
  type TaskCandidateObservation,
  type TaskCandidateSnapshot,
  type TaskClosureV2,
  type TaskDeliveryVerificationV1,
  type TaskDefinitionV2,
  type TaskDeliveryEvidence,
  type TaskDeliveryLevel,
  type ProjectFileBaselineV1,
  type TaskKernelEventType,
  type TaskKernelEventV2,
  type TaskKernelLifecycleProjection,
  type TaskKernelSnapshotV2,
  type TaskReviewDecision,
  type TaskReviewEvidenceSource,
  type TaskReviewEvidenceVerificationV1,
  type TaskReviewV2,
  type TaskRunAuthorization,
  type TaskRunDurations,
  type TaskRunFailure,
  type TaskRunHostBinding,
  type TaskRunInput,
  type TaskRunMeasurementRefs,
  type TaskRunResult,
  type TaskRunEvidenceItemV1,
  type TaskRunEvidenceSource,
  type TaskRunEvidenceVerificationV1,
  type TaskRunState,
  type TaskRunV2,
  type TaskRunWorkspaceBinding,
  type TaskRunWorkspaceCleanupLease,
  type TaskRunWorkspaceIntegrationReceipt,
  type TaskRunWorkspaceManagerBinding,
  type TaskRunHostStopReceipt,
  type TaskSnapshotEntry,
} from "./task-kernel-types.js";

export function requireArrayEntry<T>(value: T | undefined, field: string): T {
  if (value === undefined)
    throw new KernelError("CORRUPT_STATE", `${field} is missing`);
  return value;
}
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const TASK_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RUN_STATES: readonly TaskRunState[] = [
  "waiting",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled",
];
export const REVIEW_DECISIONS: readonly TaskReviewDecision[] = [
  "pass",
  "fail",
  "needs-changes",
];
const EVENT_TYPES: readonly TaskKernelEventType[] = [
  "task.created", "task.dependency-added", "run.queued", "run.started", "run.resumed", "run.completed",
  "run.failed", "run.blocked", "run.cancelled", "run.host-bound", "run.host-settlement-recorded", "run.host-settled",
  "run.workspace-bound", "run.workspace-integrated", "run.workspace-cleanup-acquired", "run.workspace-reclaimed",
  "run.workspace-cleanup-refused", "run.workspace-retained", "run.workspace-recovery-required", "review.recorded", "task.closed",
];

export function isTaskDeliveryLevel(
  value: unknown,
): value is TaskDeliveryLevel {
  return (
    typeof value === "string" &&
    (TASK_DELIVERY_LEVELS as readonly string[]).includes(value)
  );
}

export function fingerprintTaskValue(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function createTaskCandidateSnapshot(
  entries: readonly TaskSnapshotEntry[],
): TaskCandidateSnapshot {
  const parsed = parseSnapshotEntries(entries, "candidateEntries");
  if (!parsed.length)
    throw new KernelError(
      "INVALID_REQUEST",
      "a completed Run requires at least one candidate snapshot entry",
    );
  return {
    id: randomUUID(),
    entries: parsed,
    fingerprint: fingerprintTaskValue(parsed),
  };
}

/** Pure V2 lifecycle projection for consumers that need replayable gate facts without mutation. */
export function projectTaskKernelLifecycle(
  kernel: TaskKernelSnapshotV2,
): TaskKernelLifecycleProjection {
  const latestRun = kernel.runs.at(-1) ?? null;
  const candidate = latestRun?.candidateSnapshot ?? null;
  const latestReview =
    latestRun && candidate
      ? (kernel.reviews
          .filter(
            (review) =>
              review.runId === latestRun.id &&
              review.candidateSnapshotId === candidate.id &&
              review.candidateFingerprint === candidate.fingerprint,
          )
          .at(-1) ?? null)
      : null;
  const missingAcceptanceCriteria = latestReview
    ? kernel.definition.acceptanceCriteria
        .filter(
          (criterion) =>
            !getOwnRecordValue(latestReview.acceptanceEvidence, criterion.id)
              ?.length,
        )
        .map((criterion) => criterion.id)
    : kernel.definition.acceptanceCriteria.map((criterion) => criterion.id);
  const activeRun =
    kernel.runs.find(
      (run) => run.state === "running" || run.state === "waiting",
    ) ?? null;
  return {
    taskId: kernel.identity.taskId,
    revision: kernel.revision,
    phase: kernel.phase,
    condition: kernel.condition,
    outcome: kernel.outcome,
    deliveryLevel: kernel.definition.deliveryLevel,
    dependencies: [...kernel.definition.dependencies],
    closed: kernel.phase === "close" && kernel.closure !== null,
    approvalSnapshot: latestRun
      ? {
          recorded: true,
          runId: latestRun.id,
          approvedBy: latestRun.authorization.approvedBy,
          approvedAt: latestRun.authorization.approvedAt,
          scope: latestRun.authorization.scope,
          evidenceRef: latestRun.authorization.evidenceRef,
        }
      : {
          recorded: false,
          runId: null,
          approvedBy: null,
          approvedAt: null,
          scope: null,
          evidenceRef: null,
        },
    gateSnapshot: {
      kernelRevision: kernel.revision,
      runStart: {
        phaseAllowsRun: ["define", "approve", "execute", "verify"].includes(
          kernel.phase,
        ),
        activeRunId: activeRun?.id ?? null,
        hardDependencies: [...kernel.definition.dependencies],
        dependencyKernelCheckRequired:
          kernel.definition.dependencies.length > 0,
      },
      review: {
        phaseAllowsReview:
          kernel.phase === "verify" &&
          latestRun?.state === "completed" &&
          candidate !== null,
        runId: latestRun?.id ?? null,
        candidateSnapshotId: candidate?.id ?? null,
        latestReviewId: latestReview?.id ?? null,
        latestDecision: latestReview?.decision ?? null,
        unresolvedBlockers: [...(latestReview?.unresolvedBlockers ?? [])],
      },
      close: {
        phaseAllowsClose:
          kernel.phase === "verify" &&
          latestRun?.state === "completed" &&
          candidate !== null &&
          latestReview?.decision === "pass",
        runId: latestRun?.id ?? null,
        reviewId: latestReview?.id ?? null,
        candidateSnapshotId: candidate?.id ?? null,
        candidateFingerprint: candidate?.fingerprint ?? null,
        missingAcceptanceCriteria,
        unresolvedBlockers: [...(latestReview?.unresolvedBlockers ?? [])],
        currentCandidateObservationRequired: true,
        deliveryEvidenceRequired: true,
      },
    },
  };
}

export function parseTaskKernelSnapshotV2(
  input: unknown,
): TaskKernelSnapshotV2 {
  if (
    !isPlainObject(input) ||
    input.schemaVersion !== TASK_KERNEL_SCHEMA_VERSION
  ) {
    throw new KernelError(
      "CORRUPT_STATE",
      "kernel is not a Task Kernel schema v2 snapshot",
    );
  }
  const identity = parseObject(input.identity, "kernel.identity");
  const taskId = requireTaskId(identity.taskId, "kernel.identity.taskId");
  const definition = parseDefinition(input.definition, "kernel.definition");
  if (definition.taskId !== taskId)
    throw new KernelError(
      "CORRUPT_STATE",
      "kernel identity and Task definition IDs differ",
    );
  if (!isNonNegativeInt(input.revision))
    throw new KernelError(
      "CORRUPT_STATE",
      "kernel.revision must be a non-negative integer",
    );
  if (!isKernelPhase(input.phase))
    throw new KernelError("CORRUPT_STATE", "kernel.phase is invalid");
  if (!isKernelCondition(input.condition))
    throw new KernelError("CORRUPT_STATE", "kernel.condition is invalid");
  if (input.outcome !== null && !isKernelOutcome(input.outcome))
    throw new KernelError("CORRUPT_STATE", "kernel.outcome is invalid");
  if (
    !Array.isArray(input.runs) ||
    !Array.isArray(input.reviews) ||
    !Array.isArray(input.audit) ||
    !Array.isArray(input.events)
  ) {
    throw new KernelError(
      "CORRUPT_STATE",
      "kernel runs, reviews, audit, and events must be arrays",
    );
  }
  const runs = input.runs.map((value, index) =>
    parseRun(value, `kernel.runs[${index}]`),
  );
  const reviews = input.reviews.map((value, index) =>
    parseReview(value, `kernel.reviews[${index}]`),
  );
  const audit = input.audit.map((value, index) =>
    parseKernelAudit(value, index),
  );
  const events = input.events.map((value, index) => parseEvent(value, index));
  const runIds = new Set<string>();
  for (const run of runs) {
    if (run.taskId !== taskId || runIds.has(run.id))
      throw new KernelError(
        "CORRUPT_STATE",
        "Run identity is duplicated or belongs to another Task",
      );
    runIds.add(run.id);
  }
  const reviewIds = new Set<string>();
  for (const review of reviews) {
    if (
      review.taskId !== taskId ||
      !runIds.has(review.runId) ||
      reviewIds.has(review.id)
    ) {
      throw new KernelError(
        "CORRUPT_STATE",
        "Review identity is duplicated or references another Task or missing Run",
      );
    }
    const run = runs.find((candidate) => candidate.id === review.runId);
    if (
      review.candidateSnapshotId !== run?.candidateSnapshot?.id ||
      review.candidateFingerprint !== run.candidateSnapshot.fingerprint
    ) {
      throw new KernelError(
        "CORRUPT_STATE",
        "Review is not bound to its Run candidate snapshot",
      );
    }
    if (review.decision === "pass" && review.unresolvedBlockers.length)
      throw new KernelError(
        "CORRUPT_STATE",
        "passing Review cannot contain unresolved blockers",
      );
    reviewIds.add(review.id);
  }
  const closure =
    input.closure === null
      ? null
      : parseClosure(input.closure, "kernel.closure");
  if (
    closure &&
    (!runIds.has(closure.runId) || !reviewIds.has(closure.reviewId))
  ) {
    throw new KernelError(
      "CORRUPT_STATE",
      "Task closure references a missing Run or Review",
    );
  }
  if (closure) {
    const run = runs.find((candidate) => candidate.id === closure.runId);
    const review = reviews.find(
      (candidate) => candidate.id === closure.reviewId,
    );
    if (!run || !review || !run.candidateSnapshot)
      throw new KernelError(
        "CORRUPT_STATE",
        "Task closure references an incomplete Run or Review",
      );
    if (
      closure.candidateSnapshotId !== run.candidateSnapshot.id ||
      closure.candidateFingerprint !== run.candidateSnapshot.fingerprint ||
      review.runId !== run.id ||
      review.candidateSnapshotId !== closure.candidateSnapshotId ||
      review.candidateFingerprint !== closure.candidateFingerprint
    ) {
      throw new KernelError(
        "CORRUPT_STATE",
        "Task closure is not bound to its Run and Review candidate snapshot",
      );
    }
    if (
      closure.candidateObservation.snapshotId !== closure.candidateSnapshotId ||
      closure.candidateObservation.fingerprint !== closure.candidateFingerprint
    ) {
      throw new KernelError(
        "CORRUPT_STATE",
        "Task closure candidate observation does not match the accepted candidate",
      );
    }
  }
  validateAuditChain(audit, input.revision);
  validateEvents(events, input.revision);
  return {
    schemaVersion: TASK_KERNEL_SCHEMA_VERSION,
    identity: { taskId },
    revision: input.revision,
    phase: input.phase,
    condition: input.condition,
    outcome: input.outcome as KernelOutcome | null,
    definition,
    runs,
    reviews,
    closure,
    audit,
    events,
  };
}

export function parseDefinition(
  value: unknown,
  field: string,
): TaskDefinitionV2 {
  const input = parseObject(value, field);
  const taskId = requireTaskId(input.taskId, `${field}.taskId`);
  if (!isTaskDeliveryLevel(input.deliveryLevel))
    throw new KernelError(
      "INVALID_REQUEST",
      `${field}.deliveryLevel is invalid`,
    );
  if (
    !Array.isArray(input.acceptanceCriteria) ||
    input.acceptanceCriteria.length === 0
  )
    throw new KernelError(
      "INVALID_REQUEST",
      `${field}.acceptanceCriteria must contain at least one criterion`,
    );
  const criteria = input.acceptanceCriteria.map((item, index) => {
    const criterion = parseObject(
      item,
      `${field}.acceptanceCriteria[${index}]`,
    );
    return {
      id: requireNonEmptyString(
        criterion.id,
        `${field}.acceptanceCriteria[${index}].id`,
      ),
      description: requireNonEmptyString(
        criterion.description,
        `${field}.acceptanceCriteria[${index}].description`,
      ),
    };
  });
  if (new Set(criteria.map((item) => item.id)).size !== criteria.length)
    throw new KernelError(
      "INVALID_REQUEST",
      `${field}.acceptanceCriteria IDs must be unique`,
    );
  const dependencies = parseStringArray(
    input.dependencies,
    `${field}.dependencies`,
    true,
  ).map((id, index) => requireTaskId(id, `${field}.dependencies[${index}]`));
  if (
    new Set(dependencies).size !== dependencies.length ||
    dependencies.includes(taskId)
  )
    throw new KernelError(
      "INVALID_REQUEST",
      `${field}.dependencies must be unique and cannot include the Task itself`,
    );
  return {
    taskId,
    title: requireNonEmptyString(input.title, `${field}.title`),
    description:
      input.description === undefined
        ? ""
        : requireString(input.description, `${field}.description`, true),
    deliverable: requireNonEmptyString(
      input.deliverable,
      `${field}.deliverable`,
    ),
    deliveryLevel: input.deliveryLevel,
    acceptanceCriteria: criteria,
    dependencies,
    createdAt: requireNonEmptyString(input.createdAt, `${field}.createdAt`),
    createdBy: requireNonEmptyString(input.createdBy, `${field}.createdBy`),
  };
}

function parseRun(value: unknown, field: string): TaskRunV2 {
  const input = parseObject(value, field);
  const state = input.state;
  if (
    typeof state !== "string" ||
    !(RUN_STATES as readonly string[]).includes(state)
  )
    throw new KernelError("CORRUPT_STATE", `${field}.state is invalid`);
  const snapshot =
    input.candidateSnapshot === null
      ? null
      : parseCandidateSnapshot(
          input.candidateSnapshot,
          `${field}.candidateSnapshot`,
        );
  const result =
    input.result === null
      ? null
      : parseRunResult(input.result, `${field}.result`);
  const runId = requireNonEmptyString(input.id, `${field}.id`);
  const workspace =
    input.workspace === null
      ? null
      : parseWorkspaceBinding(input.workspace, runId, `${field}.workspace`);
  if (
    result?.evidenceVerification &&
    (!snapshot ||
      result.evidenceVerification.runId !== runId ||
      result.evidenceVerification.candidateSnapshotId !== snapshot.id ||
      result.evidenceVerification.candidateFingerprint !== snapshot.fingerprint ||
      JSON.stringify(result.evidenceVerification.items.map((item) => item.ref)) !==
        JSON.stringify(result.evidenceRefs))
  ) {
    throw new KernelError(
      "CORRUPT_STATE",
      `${field}.result.evidenceVerification must bind exactly to the Run result and candidate snapshot`,
    );
  }
  const failure =
    input.failure === null
      ? null
      : parseFailure(input.failure, `${field}.failure`);
  if (
    (state === "running" || state === "waiting") &&
    (snapshot || result || failure || input.completedAt !== null)
  )
    throw new KernelError(
      "CORRUPT_STATE",
      `${field} non-terminal state cannot have terminal data`,
    );
  if (
    state === "completed" &&
    (!snapshot || !result || failure || typeof input.completedAt !== "string")
  )
    throw new KernelError(
      "CORRUPT_STATE",
      `${field} completed state requires candidate, result, and completion time`,
    );
  if (
    (state === "failed" || state === "blocked" || state === "cancelled") &&
    (!failure ||
      typeof input.completedAt !== "string" ||
      (result && !result.summary))
  )
    throw new KernelError(
      "CORRUPT_STATE",
      `${field} failed/blocked/cancelled state requires failure details and completion time`,
    );
  const candidateBaseSha =
    input.candidateBaseSha === undefined || input.candidateBaseSha === null
      ? (workspace?.baseSha ?? null)
      : parseCommitSha(input.candidateBaseSha, `${field}.candidateBaseSha`);
  const candidateBaseBranch =
    input.candidateBaseBranch === undefined ||
    input.candidateBaseBranch === null
      ? (workspace?.branch ?? null)
      : requireNonEmptyString(
          input.candidateBaseBranch,
          `${field}.candidateBaseBranch`,
        );
  if (
    candidateBaseBranch !== null &&
    candidateBaseBranch !== candidateBaseBranch.trim()
  ) {
    throw new KernelError(
      "CORRUPT_STATE",
      `${field}.candidateBaseBranch must be a trimmed branch name`,
    );
  }
  const candidateFileBaseline =
    input.candidateFileBaseline === undefined ||
    input.candidateFileBaseline === null
      ? null
      : parseProjectFileBaseline(
          input.candidateFileBaseline,
          `${field}.candidateFileBaseline`,
        );
  if (
    candidateFileBaseline !== null &&
    (workspace !== null || candidateBaseSha !== null || candidateBaseBranch !== null)
  ) {
    throw new KernelError(
      "CORRUPT_STATE",
      `${field} cannot combine a non-Git file baseline with a Git or managed-worktree baseline`,
    );
  }
  if (
    workspace &&
    (candidateBaseSha?.toLowerCase() !== workspace.baseSha.toLowerCase() ||
      candidateBaseBranch !== workspace.branch)
  ) {
    throw new KernelError(
      "CORRUPT_STATE",
      `${field} candidate Git baseline must match its workspace base and branch`,
    );
  }
  return {
    id: runId,
    taskId: requireTaskId(input.taskId, `${field}.taskId`),
    attempt: requirePositiveInt(input.attempt, `${field}.attempt`),
    sequence: requirePositiveInt(input.sequence, `${field}.sequence`),
    state: state as TaskRunState,
    startedAt: requireNonEmptyString(input.startedAt, `${field}.startedAt`),
    startedBy: requireNonEmptyString(input.startedBy, `${field}.startedBy`),
    input: parseRunInput(input.input, `${field}.input`),
    authorization: parseAuthorization(
      input.authorization,
      `${field}.authorization`,
    ),
    writeSetSnapshot: parseStringArray(
      input.writeSetSnapshot,
      `${field}.writeSetSnapshot`,
      true,
    ),
    estimatedDurations: parseDurations(
      input.estimatedDurations,
      `${field}.estimatedDurations`,
    ),
    measurementRefs: parseMeasurementRefs(
      input.measurementRefs,
      `${field}.measurementRefs`,
    ),
    candidateBaseSha,
    candidateBaseBranch,
    candidateFileBaseline,
    workspace,
    host:
      input.host === null
        ? null
        : parseHostBinding(input.host, `${field}.host`),
    candidateSnapshot: snapshot,
    result,
    failure,
    completedAt:
      input.completedAt === null
        ? null
        : requireNonEmptyString(input.completedAt, `${field}.completedAt`),
  };
}

function parseProjectFileBaseline(
  value: unknown,
  field: string,
): ProjectFileBaselineV1 {
  const input = parseObject(value, field);
  if (
    input.schemaVersion !== 1 ||
    input.source !== "pactile-project-file-baseline-v1" ||
    input.policy !== "project-files-bounded-v1" ||
    !Array.isArray(input.files)
  ) {
    throw new KernelError("CORRUPT_STATE", `${field} has an unsupported policy or shape`);
  }
  const files = input.files.map((value, index) => {
    const entry = parseObject(value, `${field}.files[${index}]`);
    if (!isNonNegativeInt(entry.sizeBytes)) {
      throw new KernelError(
        "CORRUPT_STATE",
        `${field}.files[${index}].sizeBytes must be a non-negative integer`,
      );
    }
    return {
      path: requireNonEmptyString(entry.path, `${field}.files[${index}].path`),
      sizeBytes: entry.sizeBytes,
      sha256: requireFingerprint(entry.sha256, `${field}.files[${index}].sha256`),
    };
  });
  const baseline: ProjectFileBaselineV1 = {
    schemaVersion: 1,
    source: "pactile-project-file-baseline-v1",
    policy: "project-files-bounded-v1",
    rootIdentitySha256: requireFingerprint(
      input.rootIdentitySha256,
      `${field}.rootIdentitySha256`,
    ),
    files,
    fingerprint: requireFingerprint(input.fingerprint, `${field}.fingerprint`),
  };
  if (!verifyProjectFileBaseline(baseline)) {
    throw new KernelError(
      "CORRUPT_STATE",
      `${field} fingerprint, paths, or snapshot budget is invalid`,
    );
  }
  return baseline;
}

function parseReview(value: unknown, field: string): TaskReviewV2 {
  const input = parseObject(value, field);
  if (!(REVIEW_DECISIONS as readonly unknown[]).includes(input.decision))
    throw new KernelError("CORRUPT_STATE", `${field}.decision is invalid`);
  if (input.independent !== true)
    throw new KernelError("CORRUPT_STATE", `${field}.independent must be true`);
  const unresolvedBlockers = parseStringArray(
    input.unresolvedBlockers,
    `${field}.unresolvedBlockers`,
    true,
  );
  if (input.decision === "pass" && unresolvedBlockers.length)
    throw new KernelError(
      "CORRUPT_STATE",
      `${field} passing Review cannot contain unresolved blockers`,
    );
  const id = requireNonEmptyString(input.id, `${field}.id`);
  const taskId = requireTaskId(input.taskId, `${field}.taskId`);
  const runId = requireNonEmptyString(input.runId, `${field}.runId`);
  const candidateSnapshotId = requireNonEmptyString(
    input.candidateSnapshotId,
    `${field}.candidateSnapshotId`,
  );
  const candidateFingerprint = requireFingerprint(
    input.candidateFingerprint,
    `${field}.candidateFingerprint`,
  );
  const reviewer = requireNonEmptyString(input.reviewer, `${field}.reviewer`);
  const evidenceRefs = parseStringArray(
    input.evidenceRefs,
    `${field}.evidenceRefs`,
  );
  const acceptanceEvidence = parseEvidenceMap(
    input.acceptanceEvidence,
    `${field}.acceptanceEvidence`,
  );
  const evidenceVerification =
    input.evidenceVerification === undefined
      ? undefined
      : parseReviewEvidenceVerification(
          input.evidenceVerification,
          `${field}.evidenceVerification`,
          {
            runId,
            candidateSnapshotId,
            candidateFingerprint,
            evidenceRefs,
            acceptanceEvidence,
          },
        );
  return {
    id,
    taskId,
    runId,
    candidateSnapshotId,
    candidateFingerprint,
    reviewer,
    independent: true,
    decision: input.decision as TaskReviewDecision,
    evidenceRefs,
    acceptanceEvidence,
    ...(evidenceVerification === undefined ? {} : { evidenceVerification }),
    unresolvedBlockers,
    reviewedAt: requireNonEmptyString(input.reviewedAt, `${field}.reviewedAt`),
  };
}

function parseReviewEvidenceVerification(
  value: unknown,
  field: string,
  binding: {
    runId: string;
    candidateSnapshotId: string;
    candidateFingerprint: string;
    evidenceRefs: readonly string[];
    acceptanceEvidence: Record<string, string[]>;
  },
): TaskReviewEvidenceVerificationV1 {
  const input = parseObject(value, field);
  if (
    input.schemaVersion !== 1 ||
    input.source !== "pactile-task-review-evidence-v1"
  ) {
    throw new KernelError(
      "CORRUPT_STATE",
      `${field} has an unsupported source or schema version`,
    );
  }
  const observedAt = requireNonEmptyString(
    input.observedAt,
    `${field}.observedAt`,
  );
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new KernelError("CORRUPT_STATE", `${field}.observedAt is invalid`);
  }
  const runId = requireNonEmptyString(input.runId, `${field}.runId`);
  const candidateSnapshotId = requireNonEmptyString(
    input.candidateSnapshotId,
    `${field}.candidateSnapshotId`,
  );
  const candidateFingerprint = requireFingerprint(
    input.candidateFingerprint,
    `${field}.candidateFingerprint`,
  );
  if (
    runId !== binding.runId ||
    candidateSnapshotId !== binding.candidateSnapshotId ||
    candidateFingerprint !== binding.candidateFingerprint
  ) {
    throw new KernelError(
      "CORRUPT_STATE",
      `${field} is not bound to the Review Run and candidate`,
    );
  }
  if (!Array.isArray(input.items)) {
    throw new KernelError("CORRUPT_STATE", `${field}.items must be an array`);
  }
  const items = input.items.map((value, index) => {
    const itemField = `${field}.items[${index}]`;
    const item = parseObject(value, itemField);
    const source = item.source;
    if (
      source !== "candidate-snapshot" &&
      source !== "run-evidence" &&
      source !== "task-evidence" &&
      source !== "pactile-receipt"
    ) {
      throw new KernelError("CORRUPT_STATE", `${itemField}.source is invalid`);
    }
    if (!isNonNegativeInt(item.sizeBytes)) {
      throw new KernelError(
        "CORRUPT_STATE",
        `${itemField}.sizeBytes must be a non-negative integer`,
      );
    }
    return {
      ref: parseRepositoryRelativePath(item.ref, `${itemField}.ref`),
      sha256: requireFingerprint(item.sha256, `${itemField}.sha256`),
      sizeBytes: item.sizeBytes,
      source: source as TaskReviewEvidenceSource,
    };
  });
  const refs = items.map((item) => item.ref);
  if (new Set(refs).size !== refs.length) {
    throw new KernelError(
      "CORRUPT_STATE",
      `${field}.items contains duplicate refs`,
    );
  }
  const expectedRefs = [
    ...new Set([
      ...binding.evidenceRefs,
      ...Object.values(binding.acceptanceEvidence).flat(),
    ]),
  ].sort();
  if (JSON.stringify([...refs].sort()) !== JSON.stringify(expectedRefs)) {
    throw new KernelError(
      "CORRUPT_STATE",
      `${field}.items must match all Review and acceptance evidence references`,
    );
  }
  return {
    schemaVersion: 1,
    source: "pactile-task-review-evidence-v1",
    observedAt,
    runId,
    candidateSnapshotId,
    candidateFingerprint,
    items,
  };
}

function parseClosure(value: unknown, field: string): TaskClosureV2 {
  const input = parseObject(value, field);
  const deliveryEvidence = parseDeliveryEvidence(input.deliveryEvidence);
  const deliveryVerification =
    input.deliveryVerification === undefined
      ? undefined
      : parseDeliveryVerification(
          input.deliveryVerification,
          `${field}.deliveryVerification`,
        );
  if (
    deliveryVerification &&
    (deliveryVerification.level !== deliveryEvidence.level ||
      deliveryVerification.path !== deliveryEvidence.path)
  ) {
    throw new KernelError(
      "CORRUPT_STATE",
      `${field}.deliveryVerification must match the recorded delivery level and path`,
    );
  }
  return {
    runId: requireNonEmptyString(input.runId, `${field}.runId`),
    reviewId: requireNonEmptyString(input.reviewId, `${field}.reviewId`),
    candidateSnapshotId: requireNonEmptyString(
      input.candidateSnapshotId,
      `${field}.candidateSnapshotId`,
    ),
    candidateFingerprint: requireFingerprint(
      input.candidateFingerprint,
      `${field}.candidateFingerprint`,
    ),
    candidateObservation: parseCandidateObservation(input.candidateObservation),
    deliveryEvidence,
    acceptanceEvidence: parseEvidenceMap(
      input.acceptanceEvidence,
      `${field}.acceptanceEvidence`,
    ),
    ...(deliveryVerification === undefined ? {} : { deliveryVerification }),
    closedAt: requireNonEmptyString(input.closedAt, `${field}.closedAt`),
    closedBy: requireNonEmptyString(input.closedBy, `${field}.closedBy`),
  };
}

function parseCommitSha(value: unknown, field: string): string {
  const sha = requireNonEmptyString(value, field).toLowerCase();
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(sha)) {
    throw new KernelError(
      "CORRUPT_STATE",
      `${field} must be a full Git commit SHA`,
    );
  }
  return sha;
}

function parseDeliveryVerification(
  value: unknown,
  field: string,
): TaskDeliveryVerificationV1 {
  const input = parseObject(value, field);
  if (
    input.schemaVersion !== 1 ||
    input.source !== "pactile-task-delivery-observer-v1"
  ) {
    throw new KernelError(
      "CORRUPT_STATE",
      `${field} has an unsupported source or schema version`,
    );
  }
  if (!isTaskDeliveryLevel(input.level))
    throw new KernelError("CORRUPT_STATE", `${field}.level is invalid`);
  const nullableSha = (item: unknown, name: string): string | null =>
    item === null ? null : parseCommitSha(item, `${field}.${name}`);
  const nullableFileHash = (item: unknown, name: string): string | null =>
    item === null ? null : requireFingerprint(item, `${field}.${name}`);
  let pullRequest: TaskDeliveryVerificationV1["pullRequest"] = null;
  if (input.pullRequest !== null) {
    const pr = parseObject(input.pullRequest, `${field}.pullRequest`);
    if (
      pr.source !== "github-rest-pull-request-v1" ||
      (pr.state !== "open" && pr.state !== "closed")
    ) {
      throw new KernelError(
        "CORRUPT_STATE",
        `${field}.pullRequest source or state is invalid`,
      );
    }
    if (
      typeof pr.draft !== "boolean" ||
      typeof pr.merged !== "boolean" ||
      !Number.isSafeInteger(pr.number) ||
      Number(pr.number) < 1
    ) {
      throw new KernelError(
        "CORRUPT_STATE",
        `${field}.pullRequest facts are invalid`,
      );
    }
    let url: URL;
    try {
      url = new URL(requireNonEmptyString(pr.url, `${field}.pullRequest.url`));
    } catch {
      throw new KernelError(
        "CORRUPT_STATE",
        `${field}.pullRequest.url must be an absolute HTTPS URL`,
      );
    }
    if (url.protocol !== "https:")
      throw new KernelError(
        "CORRUPT_STATE",
        `${field}.pullRequest.url must be HTTPS`,
      );
    pullRequest = {
      source: "github-rest-pull-request-v1",
      url: url.toString(),
      repository: requireNonEmptyString(
        pr.repository,
        `${field}.pullRequest.repository`,
      ).toLowerCase(),
      number: Number(pr.number),
      state: pr.state,
      draft: pr.draft,
      headSha: parseCommitSha(pr.headSha, `${field}.pullRequest.headSha`),
      baseBranch: requireNonEmptyString(
        pr.baseBranch,
        `${field}.pullRequest.baseBranch`,
      ),
      merged: pr.merged,
      mergeCommitSha: nullableSha(
        pr.mergeCommitSha,
        `${field}.pullRequest.mergeCommitSha`,
      ),
    };
    if (pullRequest.merged && pullRequest.state !== "closed") {
      throw new KernelError(
        "CORRUPT_STATE",
        `${field}.pullRequest merged state is inconsistent`,
      );
    }
  }
  if (
    input.ancestryVerified !== null &&
    typeof input.ancestryVerified !== "boolean"
  ) {
    throw new KernelError(
      "CORRUPT_STATE",
      `${field}.ancestryVerified must be boolean or null`,
    );
  }
  const candidateFingerprint = requireFingerprint(
    input.candidateFingerprint,
    `${field}.candidateFingerprint`,
  );
  const candidateSource =
    input.candidateSource === undefined
      ? (input.candidateHead === null ? null : "git-working-tree-v1")
      : input.candidateSource;
  if (
    candidateSource !== "git-working-tree-v1" &&
    candidateSource !== "project-files-v1"
  ) {
    throw new KernelError("CORRUPT_STATE", `${field}.candidateSource is invalid`);
  }
  const candidateHead =
    input.candidateHead === null
      ? null
      : parseCommitSha(input.candidateHead, `${field}.candidateHead`);
  if (
    (candidateSource === "git-working-tree-v1" && candidateHead === null) ||
    (candidateSource === "project-files-v1" && candidateHead !== null)
  ) {
    throw new KernelError(
      "CORRUPT_STATE",
      `${field}.candidateSource and candidateHead disagree`,
    );
  }
  const path = parseRepositoryRelativePath(input.path, `${field}.path`);
  const fileSha256 = requireFingerprint(
    input.fileSha256,
    `${field}.fileSha256`,
  );
  const gitBlobSha256 = nullableFileHash(input.gitBlobSha256, "gitBlobSha256");
  const targetBranch =
    input.targetBranch === null
      ? null
      : requireNonEmptyString(input.targetBranch, `${field}.targetBranch`);
  const targetSha = nullableSha(input.targetSha, "targetSha");
  const integrationCommitSha = nullableSha(
    input.integrationCommitSha,
    "integrationCommitSha",
  );
  const ancestryVerified = input.ancestryVerified as boolean | null;
  if (
    candidateSource === "project-files-v1" &&
    (input.level === "pull-request" ||
      input.level === "merged-result" ||
      gitBlobSha256 !== null ||
      pullRequest !== null ||
      targetBranch !== null ||
      targetSha !== null ||
      integrationCommitSha !== null ||
      ancestryVerified !== null)
  ) {
    throw new KernelError(
      "CORRUPT_STATE",
      `${field} non-Git snapshots only support local-result or documentation delivery`,
    );
  }
  if (pullRequest) {
    const url = new URL(pullRequest.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const urlRepository = `${parts[0] ?? ""}/${parts[1] ?? ""}`.toLowerCase();
    if (
      url.origin !== "https://github.com" ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      parts.length !== 4 ||
      parts[2]?.toLowerCase() !== "pull" ||
      !/^\d+$/.test(parts[3] ?? "") ||
      urlRepository !== pullRequest.repository ||
      Number(parts[3]) !== pullRequest.number
    ) {
      throw new KernelError(
        "CORRUPT_STATE",
        `${field}.pullRequest URL must identify its recorded GitHub repository and number`,
      );
    }
  }
  if (input.level === "pull-request") {
    if (
      candidateSource !== "git-working-tree-v1" ||
      pullRequest?.state !== "open" ||
      pullRequest.merged ||
      pullRequest.draft ||
      pullRequest.headSha !== candidateHead ||
      gitBlobSha256 === null ||
      fileSha256 !== gitBlobSha256 ||
      targetBranch !== null ||
      targetSha !== null ||
      integrationCommitSha !== null ||
      ancestryVerified !== null
    ) {
      throw new KernelError(
        "CORRUPT_STATE",
        `${field} has inconsistent pull-request delivery facts`,
      );
    }
  } else if (input.level === "merged-result") {
    if (
      candidateSource !== "git-working-tree-v1" ||
      pullRequest?.state !== "closed" ||
      !pullRequest.merged ||
      pullRequest.draft ||
      pullRequest.headSha !== candidateHead ||
      gitBlobSha256 === null ||
      fileSha256 !== gitBlobSha256 ||
      !pullRequest.mergeCommitSha ||
      !targetBranch ||
      !targetSha ||
      integrationCommitSha !== pullRequest.mergeCommitSha ||
      ancestryVerified !== true
    ) {
      throw new KernelError(
        "CORRUPT_STATE",
        `${field} has inconsistent merged-result delivery facts`,
      );
    }
  } else if (
    pullRequest !== null ||
    targetBranch !== null ||
    targetSha !== null ||
    integrationCommitSha !== null ||
    ancestryVerified !== null
  ) {
    throw new KernelError(
      "CORRUPT_STATE",
      `${field} has integration or Pull Request facts for a local delivery`,
    );
  }
  return {
    schemaVersion: 1,
    source: "pactile-task-delivery-observer-v1",
    observedAt: requireNonEmptyString(input.observedAt, `${field}.observedAt`),
    candidateFingerprint,
    candidateSource,
    candidateHead,
    level: input.level,
    path,
    fileSha256,
    gitBlobSha256,
    targetBranch,
    targetSha,
    integrationCommitSha,
    ancestryVerified,
    pullRequest,
  };
}

function parseRepositoryRelativePath(value: unknown, field: string): string {
  const input = requireNonEmptyString(value, field);
  const normalized = input.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new KernelError(
      "CORRUPT_STATE",
      `${field} must be a safe repository-relative path`,
    );
  }
  return segments.join("/");
}

export function parseDeliveryEvidence(
  value: unknown,
  expectedLevel?: TaskDeliveryLevel,
): TaskDeliveryEvidence {
  const input = parseObject(value, "deliveryEvidence");
  if (!isTaskDeliveryLevel(input.level))
    throw new KernelError(
      "INVALID_DELIVERY_EVIDENCE",
      "delivery evidence level is invalid",
    );
  if (expectedLevel && input.level !== expectedLevel)
    throw new KernelError(
      "INVALID_DELIVERY_EVIDENCE",
      `Task requires delivery level ${expectedLevel}, got ${input.level}`,
    );
  const reference = requireNonEmptyString(
    input.reference,
    "deliveryEvidence.reference",
  );
  const summary = requireNonEmptyString(
    input.summary,
    "deliveryEvidence.summary",
  );
  if (input.level === "pull-request" || input.level === "merged-result") {
    let url: URL;
    try {
      url = new URL(reference);
    } catch {
      throw new KernelError(
        "INVALID_DELIVERY_EVIDENCE",
        `${input.level} requires an absolute HTTPS URL reference`,
      );
    }
    if (url.protocol !== "https:")
      throw new KernelError(
        "INVALID_DELIVERY_EVIDENCE",
        `${input.level} requires an HTTPS reference`,
      );
  }
  const pathValue =
    input.path === undefined
      ? undefined
      : parseRepositoryRelativePath(input.path, "deliveryEvidence.path");
  const targetBranch =
    input.targetBranch === undefined
      ? undefined
      : requireNonEmptyString(
          input.targetBranch,
          "deliveryEvidence.targetBranch",
        );
  return {
    level: input.level,
    reference,
    summary,
    ...(pathValue === undefined ? {} : { path: pathValue }),
    ...(targetBranch === undefined ? {} : { targetBranch }),
  };
}

export function parseRunInput(value: unknown, field: string): TaskRunInput {
  const input = parseObject(value, field);
  const summary = requireNonEmptyString(input.summary, `${field}.summary`);
  const references = parseStringArray(
    input.references,
    `${field}.references`,
    true,
  );
  const expected = fingerprintTaskValue({ summary, references });
  if (input.fingerprint !== undefined && input.fingerprint !== expected)
    throw new KernelError(
      "INVALID_REQUEST",
      `${field}.fingerprint does not match its contents`,
    );
  return { summary, references, fingerprint: expected };
}

export function parseAuthorization(
  value: unknown,
  field: string,
): TaskRunAuthorization {
  const input = parseObject(value, field);
  return {
    approvedBy: requireNonEmptyString(input.approvedBy, `${field}.approvedBy`),
    approvedAt: requireNonEmptyString(input.approvedAt, `${field}.approvedAt`),
    scope: requireNonEmptyString(input.scope, `${field}.scope`),
    evidenceRef: requireNonEmptyString(
      input.evidenceRef,
      `${field}.evidenceRef`,
    ),
  };
}

function parseCandidateSnapshot(
  value: unknown,
  field: string,
): TaskCandidateSnapshot {
  const input = parseObject(value, field);
  const entries = parseSnapshotEntries(input.entries, `${field}.entries`);
  if (!entries.length)
    throw new KernelError("CORRUPT_STATE", `${field}.entries cannot be empty`);
  const fingerprint = fingerprintTaskValue(entries);
  if (input.fingerprint !== fingerprint)
    throw new KernelError(
      "CORRUPT_STATE",
      `${field}.fingerprint does not match its entries`,
    );
  return {
    id: requireNonEmptyString(input.id, `${field}.id`),
    entries,
    fingerprint,
  };
}

export function parseCandidateObservation(
  value: unknown,
): TaskCandidateObservation {
  const input = parseObject(value, "candidateObservation");
  return {
    snapshotId: requireNonEmptyString(
      input.snapshotId,
      "candidateObservation.snapshotId",
    ),
    fingerprint: requireFingerprint(
      input.fingerprint,
      "candidateObservation.fingerprint",
    ),
    observedBy: requireNonEmptyString(
      input.observedBy,
      "candidateObservation.observedBy",
    ),
    observedAt: requireNonEmptyString(
      input.observedAt,
      "candidateObservation.observedAt",
    ),
    source: requireNonEmptyString(input.source, "candidateObservation.source"),
    evidenceRef: requireNonEmptyString(
      input.evidenceRef,
      "candidateObservation.evidenceRef",
    ),
  };
}

export function parseDurations(
  value: unknown,
  field: string,
): TaskRunDurations {
  const input = parseObject(value, field);
  const duration = (name: keyof TaskRunDurations): number | null => {
    const raw = input[name];
    if (raw === undefined || raw === null) return null;
    if (!isNonNegativeInt(raw))
      throw new KernelError(
        "INVALID_REQUEST",
        `${field}.${name} must be a non-negative integer or null`,
      );
    return raw;
  };
  return {
    executionMs: duration("executionMs"),
    waitingMs: duration("waitingMs"),
    reviewMs: duration("reviewMs"),
  };
}

export function parseMeasurementRefs(
  value: unknown,
  field: string,
): TaskRunMeasurementRefs {
  const input = parseObject(value, field);
  const reference = (name: keyof TaskRunMeasurementRefs): string | null =>
    input[name] === undefined || input[name] === null
      ? null
      : requireNonEmptyString(input[name], `${field}.${name}`);
  return {
    execution: reference("execution"),
    waiting: reference("waiting"),
    review: reference("review"),
  };
}

export function parseSnapshotEntries(
  value: unknown,
  field: string,
): TaskSnapshotEntry[] {
  if (!Array.isArray(value))
    throw new KernelError("INVALID_REQUEST", `${field} must be an array`);
  const entries = value
    .map((item, index) => {
      const input = parseObject(item, `${field}[${index}]`);
      return {
        ref: requireNonEmptyString(input.ref, `${field}[${index}].ref`),
        fingerprint: requireFingerprint(
          input.fingerprint,
          `${field}[${index}].fingerprint`,
        ),
      };
    })
    .sort((a, b) => a.ref.localeCompare(b.ref));
  if (new Set(entries.map((entry) => entry.ref)).size !== entries.length)
    throw new KernelError("INVALID_REQUEST", `${field} refs must be unique`);
  return entries;
}

function parseTaskRunEvidenceVerificationV1(
  value: unknown,
  field: string,
): TaskRunEvidenceVerificationV1 {
  const input = parseObject(value, field);
  if (input.schemaVersion !== 1 || input.source !== "pactile-task-run-evidence-v1") {
    throw new KernelError(
      "CORRUPT_STATE",
      `${field} has an unsupported schema or source`,
    );
  }
  if (!Array.isArray(input.items) || input.items.length > 128) {
    throw new KernelError(
      "CORRUPT_STATE",
      `${field}.items must be an array with at most 128 entries`,
    );
  }
  const items: TaskRunEvidenceItemV1[] = input.items.map((value, index) => {
    const item = parseObject(value, `${field}.items[${index}]`);
    if (
      item.source !== "candidate-snapshot" &&
      item.source !== "task-evidence"
    ) {
      throw new KernelError(
        "CORRUPT_STATE",
        `${field}.items[${index}].source is invalid`,
      );
    }
    const sizeBytes = item.sizeBytes;
    if (!isNonNegativeInt(sizeBytes) || sizeBytes > 8 * 1024 * 1024) {
      throw new KernelError(
        "CORRUPT_STATE",
        `${field}.items[${index}].sizeBytes is out of bounds`,
      );
    }
    return {
      ref: requireNonEmptyString(item.ref, `${field}.items[${index}].ref`),
      sha256: requireFingerprint(
        item.sha256,
        `${field}.items[${index}].sha256`,
      ),
      sizeBytes,
      source: item.source as TaskRunEvidenceSource,
    };
  });
  if (new Set(items.map((item) => item.ref)).size !== items.length) {
    throw new KernelError("CORRUPT_STATE", `${field}.items refs must be unique`);
  }
  if (items.reduce((total, item) => total + item.sizeBytes, 0) > 32 * 1024 * 1024) {
    throw new KernelError("CORRUPT_STATE", `${field}.items exceed the total byte limit`);
  }
  return {
    schemaVersion: 1,
    source: "pactile-task-run-evidence-v1",
    observedAt: requireNonEmptyString(input.observedAt, `${field}.observedAt`),
    runId: requireNonEmptyString(input.runId, `${field}.runId`),
    candidateSnapshotId: requireNonEmptyString(
      input.candidateSnapshotId,
      `${field}.candidateSnapshotId`,
    ),
    candidateFingerprint: requireFingerprint(
      input.candidateFingerprint,
      `${field}.candidateFingerprint`,
    ),
    items,
  };
}

function parseRunResult(value: unknown, field: string): TaskRunResult {
  const input = parseObject(value, field);
  const evidenceRefs = parseStringArray(
    input.evidenceRefs,
    `${field}.evidenceRefs`,
    true,
  );
  const evidenceVerification =
    input.evidenceVerification === undefined
      ? undefined
      : parseTaskRunEvidenceVerificationV1(
          input.evidenceVerification,
          `${field}.evidenceVerification`,
        );
  return {
    summary: requireNonEmptyString(input.summary, `${field}.summary`),
    evidenceRefs,
    ...(evidenceVerification ? { evidenceVerification } : {}),
  };
}

export function parseFailure(value: unknown, field: string): TaskRunFailure {
  const input = parseObject(value, field);
  return {
    category: requireNonEmptyString(input.category, `${field}.category`),
    message: requireNonEmptyString(input.message, `${field}.message`),
    evidenceRef:
      input.evidenceRef === null || input.evidenceRef === undefined
        ? null
        : requireNonEmptyString(input.evidenceRef, `${field}.evidenceRef`),
  };
}

export function parseWorkspaceBinding(
  value: unknown,
  runId: string,
  field: string,
): TaskRunWorkspaceBinding {
  const input = parseObject(value, field);
  if (input.ownerRunId !== runId)
    throw new KernelError(
      "CORRUPT_STATE",
      `${field}.ownerRunId must match its Run`,
    );
  const canonicalPath = requireNonEmptyString(
    input.canonicalPath,
    `${field}.canonicalPath`,
  );
  if (!path.isAbsolute(canonicalPath))
    throw new KernelError(
      "INVALID_REQUEST",
      `${field}.canonicalPath must be absolute`,
    );
  if (
    input.integrationState !== "not-integrated" &&
    input.integrationState !== "integrated"
  )
    throw new KernelError(
      "CORRUPT_STATE",
      `${field}.integrationState is invalid`,
    );
  if (
    ![
      "not-requested",
      "pending",
      "reclaimed",
      "failed",
      "recovery-required",
    ].includes(
      String(input.reclamationState),
    )
  )
    throw new KernelError(
      "CORRUPT_STATE",
      `${field}.reclamationState is invalid`,
    );
  return {
    ownerRunId: runId,
    canonicalPath,
    branch: requireNonEmptyString(input.branch, `${field}.branch`),
    baseSha: requireNonEmptyString(input.baseSha, `${field}.baseSha`),
    writeSet: parseStringArray(input.writeSet, `${field}.writeSet`, true),
    integrationState: input.integrationState,
    reclamationState:
      input.reclamationState as TaskRunWorkspaceBinding["reclamationState"],
    manager: input.manager === null || input.manager === undefined ? null : parseWorkspaceManagerBinding(input.manager, `${field}.manager`),
    integrationReceipt: input.integrationReceipt === null || input.integrationReceipt === undefined ? null : parseWorkspaceIntegrationReceipt(input.integrationReceipt, `${field}.integrationReceipt`),
    cleanupLease: input.cleanupLease === null || input.cleanupLease === undefined ? null : parseWorkspaceCleanupLease(input.cleanupLease, `${field}.cleanupLease`),
  };
}

function parseWorkspaceManagerBinding(value: unknown, field: string): TaskRunWorkspaceManagerBinding {
  const input = parseObject(value, field);
  if (input.version !== 1) throw new KernelError("CORRUPT_STATE", `${field}.version is invalid`);
  if (input.source !== "created" && input.source !== "adopted") throw new KernelError("CORRUPT_STATE", `${field}.source is invalid`);
  for (const name of ["projectRoot", "commonDir", "gitDir"] as const) {
    const candidate = requireNonEmptyString(input[name], `${field}.${name}`);
    if (!path.isAbsolute(candidate)) throw new KernelError("CORRUPT_STATE", `${field}.${name} must be absolute`);
  }
  return {
    version: 1,
    credentialId: requireNonEmptyString(input.credentialId, `${field}.credentialId`),
    projectRoot: input.projectRoot as string,
    commonDir: input.commonDir as string,
    gitDir: input.gitDir as string,
    source: input.source,
    recordedAt: requireNonEmptyString(input.recordedAt, `${field}.recordedAt`),
  };
}

export function parseWorkspaceIntegrationReceipt(value: unknown, field: string): TaskRunWorkspaceIntegrationReceipt {
  const input = parseObject(value, field);
  return {
    runId: requireNonEmptyString(input.runId, `${field}.runId`),
    worktreeHeadSha: requireNonEmptyString(input.worktreeHeadSha, `${field}.worktreeHeadSha`),
    targetRef: requireNonEmptyString(input.targetRef, `${field}.targetRef`),
    targetBranch: requireNonEmptyString(input.targetBranch, `${field}.targetBranch`),
    targetHeadSha: requireNonEmptyString(input.targetHeadSha, `${field}.targetHeadSha`),
    verifiedAt: requireNonEmptyString(input.verifiedAt, `${field}.verifiedAt`),
    resultEvidenceRefs: parseStringArray(input.resultEvidenceRefs, `${field}.resultEvidenceRefs`),
    candidateSnapshotId: requireNonEmptyString(input.candidateSnapshotId, `${field}.candidateSnapshotId`),
    candidateFingerprint: requireFingerprint(input.candidateFingerprint, `${field}.candidateFingerprint`),
    ...(input.contentFingerprint === undefined ? {} : { contentFingerprint: requireFingerprint(input.contentFingerprint, `${field}.contentFingerprint`) }),
  };
}

export function parseWorkspaceCleanupLease(value: unknown, field: string): TaskRunWorkspaceCleanupLease {
  const input = parseObject(value, field);
  if (input.riskDisclosure !== undefined && input.riskDisclosure !== TASK_RUN_WORKSPACE_CLEANUP_RISK_DISCLOSURE) {
    throw new KernelError("CORRUPT_STATE", `${field}.riskDisclosure is not recognized`);
  }
  const states: readonly TaskRunWorkspaceCleanupLease["state"][] = ["held", "reclaimed", "retained", "partial-removal", "recovery-required"];
  if (typeof input.state !== "string" || !states.includes(input.state as TaskRunWorkspaceCleanupLease["state"])) {
    throw new KernelError("CORRUPT_STATE", `${field}.state is invalid`);
  }
  if (!isNonNegativeInt(input.processId) || input.processId === 0) throw new KernelError("CORRUPT_STATE", `${field}.processId is invalid`);
  return {
    leaseId: requireNonEmptyString(input.leaseId, `${field}.leaseId`),
    state: input.state as TaskRunWorkspaceCleanupLease["state"],
    processId: input.processId,
    acquiredAt: requireNonEmptyString(input.acquiredAt, `${field}.acquiredAt`),
    expectedHeadSha: requireNonEmptyString(input.expectedHeadSha, `${field}.expectedHeadSha`),
    targetBranch: requireNonEmptyString(input.targetBranch, `${field}.targetBranch`),
    targetHeadSha: requireNonEmptyString(input.targetHeadSha, `${field}.targetHeadSha`),
    receiptRef: requireNonEmptyString(input.receiptRef, `${field}.receiptRef`),
    reason: input.reason === null ? null : requireNonEmptyString(input.reason, `${field}.reason`),
    ...(input.riskDisclosure === undefined ? {} : { riskDisclosure: requireNonEmptyString(input.riskDisclosure, `${field}.riskDisclosure`) }),
  };
}

export function parseHostStopReceipt(value: unknown, field: string): TaskRunHostStopReceipt {
  const input = parseObject(value, field);
  if (typeof input.contractStale !== "boolean") throw new KernelError("CORRUPT_STATE", `${field}.contractStale is invalid`);
  if (!isNonNegativeInt(input.requestKernelRevision) || !isNonNegativeInt(input.receiptKernelRevision)) {
    throw new KernelError("CORRUPT_STATE", `${field} kernel revisions are invalid`);
  }
  if (input.candidateSource !== null && input.candidateSource !== "captured" && input.candidateSource !== "derived") {
    throw new KernelError("CORRUPT_STATE", `${field}.candidateSource is invalid`);
  }
  return {
    source: requireNonEmptyString(input.source, `${field}.source`),
    assurance: requireNonEmptyString(input.assurance, `${field}.assurance`),
    evidenceLevel: requireNonEmptyString(input.evidenceLevel, `${field}.evidenceLevel`),
    taskId: requireTaskId(input.taskId, `${field}.taskId`),
    runId: requireNonEmptyString(input.runId, `${field}.runId`),
    sessionId: input.sessionId === null ? null : requireNonEmptyString(input.sessionId, `${field}.sessionId`),
    threadId: input.threadId === null ? null : requireNonEmptyString(input.threadId, `${field}.threadId`),
    startRequestId: requireNonEmptyString(input.startRequestId, `${field}.startRequestId`),
    settleReceiptId: requireNonEmptyString(input.settleReceiptId, `${field}.settleReceiptId`),
    terminalStatus: requireNonEmptyString(input.terminalStatus, `${field}.terminalStatus`),
    requestKernelRevision: input.requestKernelRevision,
    receiptKernelRevision: input.receiptKernelRevision,
    contractFingerprint: requireFingerprint(input.contractFingerprint, `${field}.contractFingerprint`),
    contractStale: input.contractStale,
    candidateSnapshotId: input.candidateSnapshotId === null ? null : requireNonEmptyString(input.candidateSnapshotId, `${field}.candidateSnapshotId`),
    candidateFingerprint: input.candidateFingerprint === null ? null : requireFingerprint(input.candidateFingerprint, `${field}.candidateFingerprint`),
    candidateSource: input.candidateSource,
    receiptRef: requireNonEmptyString(input.receiptRef, `${field}.receiptRef`),
    evidenceRef: requireNonEmptyString(input.evidenceRef, `${field}.evidenceRef`),
    recordedAt: requireNonEmptyString(input.recordedAt, `${field}.recordedAt`),
  };
}

export function parseHostBinding(
  value: unknown,
  field: string,
): TaskRunHostBinding {
  const input = parseObject(value, field);
  if (!isNonNegativeInt(input.kernelRevision))
    throw new KernelError(
      "CORRUPT_STATE",
      `${field}.kernelRevision is invalid`,
    );
  return {
    host: requireNonEmptyString(input.host, `${field}.host`),
    role: requireNonEmptyString(input.role, `${field}.role`),
    sessionId:
      input.sessionId === null || input.sessionId === undefined
        ? null
        : requireNonEmptyString(input.sessionId, `${field}.sessionId`),
    threadId:
      input.threadId === null || input.threadId === undefined
        ? null
        : requireNonEmptyString(input.threadId, `${field}.threadId`),
    kernelRevision: input.kernelRevision,
    contractFingerprint: requireFingerprint(
      input.contractFingerprint,
      `${field}.contractFingerprint`,
    ),
    requestRefs: parseStringArray(
      input.requestRefs ?? [],
      `${field}.requestRefs`,
      true,
    ),
    eventRefs: parseStringArray(
      input.eventRefs ?? [],
      `${field}.eventRefs`,
      true,
    ),
    resultRefs: parseStringArray(
      input.resultRefs ?? [],
      `${field}.resultRefs`,
      true,
    ),
    assuranceSource:
      input.assuranceSource === null || input.assuranceSource === undefined
        ? null
        : requireNonEmptyString(
            input.assuranceSource,
            `${field}.assuranceSource`,
          ),
    hostId: input.hostId === null || input.hostId === undefined ? null : requireNonEmptyString(input.hostId, `${field}.hostId`),
    stopReceipt: input.stopReceipt === null || input.stopReceipt === undefined ? null : parseHostStopReceipt(input.stopReceipt, `${field}.stopReceipt`),
  };
}

export function parseAcceptanceEvidence(
  value: unknown,
  criteria: readonly TaskAcceptanceCriterion[],
  requireComplete: boolean,
): Record<string, string[]> {
  const evidence = parseEvidenceMap(value, "acceptanceEvidence");
  const allowed = new Set(criteria.map((criterion) => criterion.id));
  for (const key of Object.keys(evidence))
    if (!allowed.has(key))
      throw new KernelError(
        "INVALID_REQUEST",
        `acceptanceEvidence references unknown criterion ${key}`,
      );
  if (requireComplete) {
    const missing = criteria
      .filter((criterion) => !getOwnRecordValue(evidence, criterion.id)?.length)
      .map((criterion) => criterion.id);
    if (missing.length)
      throw new KernelError(
        "ACCEPTANCE_EVIDENCE_MISSING",
        `passing Review requires evidence for every acceptance criterion: ${missing.join(", ")}`,
      );
  }
  return evidence;
}

function parseEvidenceMap(
  value: unknown,
  field: string,
): Record<string, string[]> {
  const input = parseObject(value, field);
  const result: Record<string, string[]> = {};
  for (const [key, refs] of Object.entries(input)) {
    Object.defineProperty(result, requireNonEmptyString(key, `${field} key`), {
      value: parseStringArray(refs, `${field}.${key}`),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function parseEvent(value: unknown, index: number): TaskKernelEventV2 {
  const field = `kernel.events[${index}]`;
  const input = parseObject(value, field);
  if (!(EVENT_TYPES as readonly unknown[]).includes(input.type))
    throw new KernelError("CORRUPT_STATE", `${field}.type is invalid`);
  return {
    id: requireNonEmptyString(input.id, `${field}.id`),
    revision: requirePositiveInt(input.revision, `${field}.revision`),
    at: requireNonEmptyString(input.at, `${field}.at`),
    actor: requireNonEmptyString(input.actor, `${field}.actor`),
    idempotencyKey: requireNonEmptyString(
      input.idempotencyKey,
      `${field}.idempotencyKey`,
    ),
    type: input.type as TaskKernelEventType,
    entityId: requireNonEmptyString(input.entityId, `${field}.entityId`),
    requestFingerprint: requireFingerprint(
      input.requestFingerprint,
      `${field}.requestFingerprint`,
    ),
  };
}

function parseKernelAudit(value: unknown, index: number): KernelAuditEvent {
  const field = `kernel.audit[${index}]`;
  const input = parseObject(value, field);
  const parseState = (
    raw: unknown,
    name: string,
  ): KernelState & { revision: number } => {
    const state = parseObject(raw, name);
    if (
      !isKernelPhase(state.phase) ||
      !isKernelCondition(state.condition) ||
      !isNonNegativeInt(state.revision) ||
      (state.outcome !== null && !isKernelOutcome(state.outcome))
    ) {
      throw new KernelError("CORRUPT_STATE", `${name} state is invalid`);
    }
    return {
      phase: state.phase,
      condition: state.condition,
      outcome: state.outcome as KernelOutcome | null,
      revision: state.revision,
    };
  };
  if (input.evidence !== null && typeof input.evidence !== "string")
    throw new KernelError("CORRUPT_STATE", `${field}.evidence is invalid`);
  return {
    id: requireNonEmptyString(input.id, `${field}.id`),
    at: requireNonEmptyString(input.at, `${field}.at`),
    actor: requireNonEmptyString(input.actor, `${field}.actor`),
    idempotencyKey: requireNonEmptyString(
      input.idempotencyKey,
      `${field}.idempotencyKey`,
    ),
    evidence: input.evidence as string | null,
    from: parseState(input.from, `${field}.from`),
    to: parseState(input.to, `${field}.to`),
  };
}

function validateAuditChain(
  audit: readonly KernelAuditEvent[],
  revision: number,
): void {
  if (!audit.length)
    throw new KernelError(
      "CORRUPT_STATE",
      "Task Kernel v2 requires an audit event",
    );
  for (let index = 0; index < audit.length; index++) {
    const event = requireArrayEntry(audit[index], `kernel.audit[${index}]`);
    const previous =
      index > 0
        ? requireArrayEntry(audit[index - 1], `kernel.audit[${index - 1}]`)
        : null;
    if (
      event.to.revision !== event.from.revision + 1 ||
      (previous && previous.to.revision !== event.from.revision)
    ) {
      throw new KernelError(
        "CORRUPT_STATE",
        "Task Kernel v2 audit revisions are not contiguous",
      );
    }
  }
  if (
    requireArrayEntry(audit.at(-1), "latest kernel audit event").to.revision !==
    revision
  )
    throw new KernelError(
      "CORRUPT_STATE",
      "Task Kernel v2 audit does not end at the current revision",
    );
}

function validateEvents(
  events: readonly TaskKernelEventV2[],
  revision: number,
): void {
  const keys = new Set<string>();
  const ids = new Set<string>();
  for (const event of events) {
    if (event.revision > revision)
      throw new KernelError(
        "CORRUPT_STATE",
        "Task Kernel event revision is in the future",
      );
    if (keys.has(event.idempotencyKey) || ids.has(event.id))
      throw new KernelError(
        "CORRUPT_STATE",
        "Task Kernel events contain a duplicate ID or idempotency key",
      );
    keys.add(event.idempotencyKey);
    ids.add(event.id);
  }
  if (!events.length)
    throw new KernelError(
      "CORRUPT_STATE",
      "Task Kernel v2 requires a domain event",
    );
}

export function getOwnRecordValue<T>(
  record: Record<string, T>,
  key: string,
): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

function parseObject(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value))
    throw new KernelError("CORRUPT_STATE", `${field} must be an object`);
  return value;
}

export function parseStringArray(
  value: unknown,
  field: string,
  allowEmpty = false,
): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  )
    throw new KernelError(
      "INVALID_REQUEST",
      `${field} must be an array of non-empty strings`,
    );
  if (!allowEmpty && value.length === 0)
    throw new KernelError(
      "INVALID_REQUEST",
      `${field} must contain at least one reference`,
    );
  return [...value] as string[];
}

export function requireString(
  value: unknown,
  field: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()))
    throw new KernelError(
      "INVALID_REQUEST",
      `${field} must be ${allowEmpty ? "a string" : "a non-empty string"}`,
    );
  return value;
}

export function requireTaskId(value: unknown, field: string): string {
  const taskId = requireNonEmptyString(value, field);
  if (!TASK_ID_RE.test(taskId))
    throw new KernelError(
      "INVALID_REQUEST",
      `${field} must be a lowercase slug`,
    );
  return taskId;
}

function requireFingerprint(value: unknown, field: string): string {
  if (typeof value !== "string" || !FINGERPRINT_RE.test(value))
    throw new KernelError(
      "INVALID_REQUEST",
      `${field} must be a lowercase SHA-256 fingerprint`,
    );
  return value;
}

function requirePositiveInt(value: unknown, field: string): number {
  if (!isNonNegativeInt(value) || value < 1)
    throw new KernelError(
      "CORRUPT_STATE",
      `${field} must be a positive integer`,
    );
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (isPlainObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
