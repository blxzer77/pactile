import { createHash } from "node:crypto";

import type { JevDecisionFacadeV1, JevDecisionReceiptV1 } from "./decision.js";
import type {
  JevEgressAuthorizationV1,
  JevFallbackCodeV1,
} from "./transport.js";
import type { JevConfidenceReceiptV1 } from "./transport.js";
import {
  projectJevConfidenceReceiptV1,
  unavailableJevConfidenceReceiptV1,
} from "./response.js";
import type {
  JevSchedulerAdviceV1,
  TaskScheduleReceiptV1,
} from "../scheduler/scheduler.js";

export interface JevScheduleCandidateV1 {
  readonly taskId: string;
  readonly criticalPathMs: number;
  readonly estimatedCostMs: number;
}

export interface JevScheduleCandidateFilterV1 {
  readonly taskId: string;
  readonly reasonCode:
    | "approval-rejected"
    | "worktree-rejected"
    | "active-write-lease-conflict"
    | "lease-state-unavailable"
    | "candidate-identity-unavailable"
    | "task-kernel-revision-changed"
    | "run-not-eligible"
    | "write-set-unavailable";
}

export interface JevScheduleRequestSnapshotV1 {
  /** Task IDs represented by anonymous labels in the synthetic request. */
  readonly candidateTaskIds: readonly string[];
  /** SHA-256 of the exact bounded summary and question supplied to Jev. */
  readonly inputDigest: string;
  readonly inputSummaryChars: number;
}

export interface JevScheduleFinalEligibleCandidatesV1 {
  readonly candidateTaskIds: readonly string[];
  readonly filteredCandidates: readonly JevScheduleCandidateFilterV1[];
  readonly eligibility: {
    readonly approvalPassedTaskIds: readonly string[];
    readonly worktreePassedTaskIds: readonly string[];
    readonly activeLeaseCheckAt: string | null;
  };
}

export interface JevScheduleAdviceOptionsV1 {
  readonly facade: JevDecisionFacadeV1;
  readonly egress: JevEgressAuthorizationV1;
  readonly signal?: AbortSignal;
  readonly minimumDecisionConfidence?: number;
}

export interface JevScheduleAdviceAuditV1 {
  readonly schemaVersion: 1;
  readonly status: "skipped" | "fallback" | "answered" | "superseded";
  readonly reasonCode:
    | JevFallbackCodeV1
    | "disabled"
    | "insufficient-candidates"
    | "candidate-bound-exceeded"
    | "eligibility-changed"
    | null;
  /** Request input built before transport policy and egress checks. */
  readonly preparedRequestSnapshot: JevScheduleRequestSnapshotV1 | null;
  /** Present only when the transport reports at least one HTTP attempt. */
  readonly sentRequestSnapshot: JevScheduleRequestSnapshotV1 | null;
  /** Eligibility re-read after the Jev call and used for the final receipt. */
  readonly finalEligibleCandidates: JevScheduleFinalEligibleCandidatesV1;
  readonly eligibilityChanged: boolean;
  readonly suggestedTaskIds: readonly string[];
  readonly adoptedTaskIds: readonly string[];
  readonly overriddenTaskIds: readonly string[];
  /** Project egress policy snapshots recorded by the standalone V2 scheduler. */
  readonly projectEgressPolicy?: JevScheduleProjectEgressAuditV1;
  readonly transport: {
    readonly latencyMs: number;
    /** Null when the facade failed before returning transport metrics. */
    readonly attempts: number | null;
    readonly httpStatus: number | null;
    readonly model: string | null;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly estimatedInputCostMicrousd: number | null;
    readonly confidence: JevConfidenceReceiptV1;
  };
}

export interface JevScheduleAdviceResultV1 {
  readonly advice: JevSchedulerAdviceV1 | null;
  readonly audit: JevScheduleAdviceAuditV1;
}

export type JevScheduleProjectEgressStatusV1 =
  | "allowed"
  | "egress-denied"
  | "configuration-invalid";

export interface JevScheduleProjectEgressAuditV1 {
  readonly atScheduleStart: JevScheduleProjectEgressStatusV1;
  readonly beforeAdviceRequest: JevScheduleProjectEgressStatusV1;
  readonly afterAdviceResponse: JevScheduleProjectEgressStatusV1;
  readonly changed: boolean;
}

const MAX_CHOICE_CANDIDATES = 16;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function auditTransport(
  receipt: JevDecisionReceiptV1,
): JevScheduleAdviceAuditV1["transport"] {
  return {
    latencyMs: receipt.transport.latencyMs,
    attempts: receipt.transport.attempts,
    httpStatus: receipt.transport.httpStatus,
    model: receipt.transport.model,
    inputTokens: receipt.transport.inputTokens,
    outputTokens: receipt.transport.outputTokens,
    estimatedInputCostMicrousd: receipt.transport.estimatedInputCostMicrousd,
    confidence: projectJevConfidenceReceiptV1(
      receipt.transport.confidence,
      ["first_task"],
    ),
  };
}

function baseAudit(input: {
  status: JevScheduleAdviceAuditV1["status"];
  reasonCode: JevScheduleAdviceAuditV1["reasonCode"];
  candidates: readonly JevScheduleCandidateV1[];
  filteredCandidates: readonly JevScheduleCandidateFilterV1[];
  eligibility: JevScheduleFinalEligibleCandidatesV1["eligibility"];
  preparedRequestSnapshot?: JevScheduleRequestSnapshotV1 | null;
  sentRequestSnapshot?: JevScheduleRequestSnapshotV1 | null;
  eligibilityChanged?: boolean;
  transport?: JevScheduleAdviceAuditV1["transport"];
  suggestedTaskIds?: readonly string[];
  adoptedTaskIds?: readonly string[];
  overriddenTaskIds?: readonly string[];
}): JevScheduleAdviceAuditV1 {
  return {
    schemaVersion: 1,
    status: input.status,
    reasonCode: input.reasonCode,
    preparedRequestSnapshot: input.preparedRequestSnapshot ?? null,
    sentRequestSnapshot: input.sentRequestSnapshot ?? null,
    finalEligibleCandidates: {
      candidateTaskIds: input.candidates.map(({ taskId }) => taskId),
      filteredCandidates: [...input.filteredCandidates],
      eligibility: {
        approvalPassedTaskIds: [...input.eligibility.approvalPassedTaskIds],
        worktreePassedTaskIds: [...input.eligibility.worktreePassedTaskIds],
        activeLeaseCheckAt: input.eligibility.activeLeaseCheckAt,
      },
    },
    eligibilityChanged: input.eligibilityChanged ?? false,
    suggestedTaskIds: [...(input.suggestedTaskIds ?? [])],
    adoptedTaskIds: [...(input.adoptedTaskIds ?? [])],
    overriddenTaskIds: [...(input.overriddenTaskIds ?? [])],
    transport: {
      latencyMs: input.transport?.latencyMs ?? 0,
      attempts: input.transport?.attempts ?? 0,
      httpStatus: input.transport?.httpStatus ?? null,
      model: input.transport?.model ?? null,
      inputTokens: input.transport?.inputTokens ?? null,
      outputTokens: input.transport?.outputTokens ?? null,
      estimatedInputCostMicrousd:
        input.transport?.estimatedInputCostMicrousd ?? null,
      confidence: input.transport
        ? projectJevConfidenceReceiptV1(input.transport.confidence, ["first_task"])
        : unavailableJevConfidenceReceiptV1(["first_task"]),
    },
  };
}

function attemptedRequestSnapshot(
  prepared: JevScheduleRequestSnapshotV1,
  transport: JevScheduleAdviceAuditV1["transport"],
): JevScheduleRequestSnapshotV1 | null {
  return transport.attempts !== null && transport.attempts > 0
    ? prepared
    : null;
}

/**
 * Asks Jev to choose a first task only within a locally filtered, equal
 * critical-path candidate group. The caller owns fresh hard-gate checks.
 */
export async function requestJevTaskScheduleAdviceV1(input: {
  readonly candidates: readonly JevScheduleCandidateV1[];
  readonly filteredCandidates: readonly JevScheduleCandidateFilterV1[];
  readonly eligibility: JevScheduleFinalEligibleCandidatesV1["eligibility"];
  readonly options?: JevScheduleAdviceOptionsV1;
  /** A caller-side policy denial that must short-circuit before any transport. */
  readonly fallbackReasonCode?: JevFallbackCodeV1;
}): Promise<JevScheduleAdviceResultV1> {
  const candidates = [...input.candidates].sort((left, right) =>
    compareText(left.taskId, right.taskId),
  );
  if (input.fallbackReasonCode) {
    return {
      advice: null,
      audit: baseAudit({
        status: "fallback",
        reasonCode: input.fallbackReasonCode,
        candidates,
        filteredCandidates: input.filteredCandidates,
        eligibility: input.eligibility,
      }),
    };
  }
  if (!input.options) {
    return {
      advice: null,
      audit: baseAudit({
        status: "skipped",
        reasonCode: "disabled",
        candidates,
        filteredCandidates: input.filteredCandidates,
        eligibility: input.eligibility,
      }),
    };
  }
  if (candidates.length < 2) {
    return {
      advice: null,
      audit: baseAudit({
        status: "skipped",
        reasonCode: "insufficient-candidates",
        candidates,
        filteredCandidates: input.filteredCandidates,
        eligibility: input.eligibility,
      }),
    };
  }
  if (candidates.length > MAX_CHOICE_CANDIDATES) {
    return {
      advice: null,
      audit: baseAudit({
        status: "fallback",
        reasonCode: "candidate-bound-exceeded",
        candidates,
        filteredCandidates: input.filteredCandidates,
        eligibility: input.eligibility,
      }),
    };
  }

  const labels = candidates.map(
    (_candidate, index) => `candidate-${String(index + 1).padStart(2, "0")}`,
  );
  const taskSummary = JSON.stringify({
    purpose:
      "Choose one first task from already eligible equal critical-path candidates.",
    constraints: [
      "This is scheduling advice only.",
      "Do not infer or grant execution permission.",
      "Do not change dependencies, write-set rules, or concurrency limits.",
    ],
    candidates: candidates.map((candidate, index) => ({
      label: labels[index],
      criticalPathMs: candidate.criticalPathMs,
      estimatedCostMs: candidate.estimatedCostMs,
    })),
  });
  const question = {
    type: "choice" as const,
    instructions:
      "Select the eligible candidate that should be suggested first. This may only break a tie in critical-path cost.",
    criteria: Object.fromEntries(
      candidates.map((candidate, index) => [
        labels[index],
        `Eligible candidate ${index + 1}; critical path ${candidate.criticalPathMs} ms; estimated cost ${candidate.estimatedCostMs} ms.`,
      ]),
    ),
  };
  const requestForDigest = {
    node: "task-scheduling",
    taskSummary,
    questions: { first_task: question },
  };
  const inputDigest = createHash("sha256")
    .update(JSON.stringify(requestForDigest), "utf8")
    .digest("hex");
  const preparedRequestSnapshot: JevScheduleRequestSnapshotV1 = {
    candidateTaskIds: candidates.map(({ taskId }) => taskId),
    inputDigest,
    inputSummaryChars: taskSummary.length,
  };

  const startedAt = Date.now();
  let result: Awaited<ReturnType<JevDecisionFacadeV1["decide"]>>;
  try {
    result = await input.options.facade.decide({
      node: "task-scheduling",
      request: {
        taskSummary,
        questions: { first_task: question },
      },
      options: {
        egress: input.options.egress,
        ...(input.options.signal ? { signal: input.options.signal } : {}),
        ...(input.options.minimumDecisionConfidence !== undefined
          ? {
              minimumDecisionConfidence:
                input.options.minimumDecisionConfidence,
            }
          : {}),
      },
    });
  } catch {
    return {
      advice: null,
      audit: baseAudit({
        status: "fallback",
        reasonCode: "transport-error",
        candidates,
        filteredCandidates: input.filteredCandidates,
        eligibility: input.eligibility,
        preparedRequestSnapshot,
        transport: {
          latencyMs: Math.max(0, Date.now() - startedAt),
          attempts: null,
          httpStatus: null,
          model: null,
          inputTokens: null,
          outputTokens: null,
          estimatedInputCostMicrousd: null,
          confidence: unavailableJevConfidenceReceiptV1(["first_task"]),
        },
      }),
    };
  }

  if (result.status !== "answered") {
    const transport = auditTransport(result.receipt);
    return {
      advice: null,
      audit: baseAudit({
        status: "fallback",
        reasonCode: result.fallback.reasonCode,
        candidates,
        filteredCandidates: input.filteredCandidates,
        eligibility: input.eligibility,
        preparedRequestSnapshot,
        sentRequestSnapshot: attemptedRequestSnapshot(
          preparedRequestSnapshot,
          transport,
        ),
        transport,
      }),
    };
  }

  const answer = result.answers.first_task;
  const selectedLabel = answer?.type === "choice" ? answer.choice : undefined;
  const selectedIndex = labels.indexOf(selectedLabel ?? "");
  if (selectedIndex < 0) {
    const transport = auditTransport(result.receipt);
    return {
      advice: null,
      audit: baseAudit({
        status: "fallback",
        reasonCode: "invalid-response",
        candidates,
        filteredCandidates: input.filteredCandidates,
        eligibility: input.eligibility,
        preparedRequestSnapshot,
        sentRequestSnapshot: attemptedRequestSnapshot(
          preparedRequestSnapshot,
          transport,
        ),
        transport,
      }),
    };
  }

  const selected = candidates[selectedIndex];
  if (!selected) {
    const transport = auditTransport(result.receipt);
    return {
      advice: null,
      audit: baseAudit({
        status: "fallback",
        reasonCode: "invalid-response",
        candidates,
        filteredCandidates: input.filteredCandidates,
        eligibility: input.eligibility,
        preparedRequestSnapshot,
        sentRequestSnapshot: attemptedRequestSnapshot(
          preparedRequestSnapshot,
          transport,
        ),
        transport,
      }),
    };
  }
  const taskOrder = [
    selected.taskId,
    ...candidates
      .filter(({ taskId }) => taskId !== selected.taskId)
      .map(({ taskId }) => taskId),
  ];
  const transport = auditTransport(result.receipt);
  const audit = baseAudit({
    status: "answered",
    reasonCode: null,
    candidates,
    filteredCandidates: input.filteredCandidates,
    eligibility: input.eligibility,
    preparedRequestSnapshot,
    sentRequestSnapshot: attemptedRequestSnapshot(
      preparedRequestSnapshot,
      transport,
    ),
    transport,
    suggestedTaskIds: taskOrder,
  });
  return {
    advice: {
      taskOrder,
      evidenceRef: `jev:schedule-order:${inputDigest}`,
    },
    audit,
  };
}

export function finalizeJevTaskScheduleAdviceV1(
  audit: JevScheduleAdviceAuditV1,
  plan: Pick<TaskScheduleReceiptV1, "decisions" | "waves">,
): JevScheduleAdviceAuditV1 {
  if (audit.status !== "answered") return audit;
  const suggested = new Set(audit.suggestedTaskIds);
  const actualCandidateOrder = (plan.waves[0]?.candidateTaskIds ?? []).filter(
    (taskId) => suggested.has(taskId),
  );
  const adopted =
    actualCandidateOrder.length === audit.suggestedTaskIds.length &&
    actualCandidateOrder.every(
      (taskId, index) => taskId === audit.suggestedTaskIds[index],
    );
  const adoptedTaskIds = adopted ? [...audit.suggestedTaskIds] : [];
  const overriddenTaskIds = adopted ? [] : [...audit.suggestedTaskIds];
  return {
    ...audit,
    adoptedTaskIds,
    overriddenTaskIds,
  };
}

export function finalizeJevTaskScheduleEligibilityV1(
  audit: JevScheduleAdviceAuditV1,
  candidates: readonly JevScheduleCandidateV1[],
  filteredCandidates: readonly JevScheduleCandidateFilterV1[],
  eligibility: JevScheduleFinalEligibleCandidatesV1["eligibility"],
  eligibilityChanged: boolean,
): JevScheduleAdviceAuditV1 {
  return {
    ...audit,
    finalEligibleCandidates: {
      candidateTaskIds: candidates.map(({ taskId }) => taskId),
      filteredCandidates: [...filteredCandidates],
      eligibility: {
        approvalPassedTaskIds: [...eligibility.approvalPassedTaskIds],
        worktreePassedTaskIds: [...eligibility.worktreePassedTaskIds],
        activeLeaseCheckAt: eligibility.activeLeaseCheckAt,
      },
    },
    eligibilityChanged,
  };
}

export function supersedeJevTaskScheduleAdviceV1(
  audit: JevScheduleAdviceAuditV1,
): JevScheduleAdviceAuditV1 {
  if (audit.status !== "answered") return audit;
  return {
    ...audit,
    status: "superseded",
    reasonCode: "eligibility-changed",
    adoptedTaskIds: [],
    overriddenTaskIds: [...audit.suggestedTaskIds],
  };
}

/** Rejects an answer when the project egress policy is no longer permissive. */
export function applyJevTaskScheduleEgressFallbackV1(
  audit: JevScheduleAdviceAuditV1,
  reasonCode: Extract<
    JevFallbackCodeV1,
    "egress-denied" | "configuration-invalid"
  >,
): JevScheduleAdviceAuditV1 {
  return {
    ...audit,
    status:
      audit.status === "answered" || audit.status === "superseded"
        ? "superseded"
        : "fallback",
    reasonCode,
    adoptedTaskIds: [],
    overriddenTaskIds:
      audit.suggestedTaskIds.length > 0
        ? [...audit.suggestedTaskIds]
        : [...audit.overriddenTaskIds],
  };
}
