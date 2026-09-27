import { createHash } from "node:crypto";

import type {
  JevDecisionFacadeV1,
  JevConfidenceReceiptV1,
  JevEgressAuthorizationV1,
  JevFallbackCodeV1,
} from "../jev/index.js";
import {
  projectJevConfidenceReceiptV1,
  unavailableJevConfidenceReceiptV1,
} from "../jev/response.js";
import {
  createVerificationPlan,
  type CreateVerificationPlanInput,
} from "./planner.js";
import type { BehaviorCheckMode, VerificationPlan } from "./types.js";

export const JEV_VERIFICATION_ADVICE_SOURCE_V1 =
  "pactile-jev-verification-advice-v1" as const;

const QUESTION_ID = "additional_check";
const NONE_LABEL = "none";
const MINIMUM_DECISION_CONFIDENCE = 0.75;
const MAX_OPTIONAL_CANDIDATES = 15;

export interface JevVerificationAdviceOptionsV1 {
  readonly facade: JevDecisionFacadeV1;
  /** Must come from the caller's resolved project policy. */
  readonly egress: JevEgressAuthorizationV1;
  readonly signal?: AbortSignal;
  readonly minimumDecisionConfidence?: number;
}

export interface AdviseVerificationPlanWithJevInputV1 extends CreateVerificationPlanInput {
  readonly jev?: JevVerificationAdviceOptionsV1;
}

export interface JevVerificationAdviceCandidateV1 {
  readonly checkId: string;
  readonly mode: BehaviorCheckMode;
}

export interface JevVerificationAdviceRequestSnapshotV1 {
  readonly candidateCheckIds: readonly string[];
  /** SHA-256 of the exact bounded request sent to the decision facade. */
  readonly inputDigest: string;
  readonly inputSummaryChars: number;
}

export interface JevVerificationAdviceTransportV1 {
  readonly latencyMs: number;
  /** Null when the facade failed before returning transport metrics. */
  readonly attempts: number | null;
  readonly httpStatus: number | null;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedInputCostMicrousd: number | null;
  readonly confidence: JevConfidenceReceiptV1;
}

export type JevVerificationAdviceStatusV1 =
  | "skipped"
  | "fallback"
  | "answered"
  | "superseded";

export type JevVerificationAdviceReasonV1 =
  | JevFallbackCodeV1
  | "no-candidates"
  | "candidate-bound-exceeded"
  | "verification-plan-changed";

export type JevVerificationAdviceAdoptionV1 =
  | "not-applicable"
  | "pending"
  | "adopted"
  | "overridden";

export interface JevVerificationAdviceReceiptV1 {
  readonly schemaVersion: 1;
  readonly source: typeof JEV_VERIFICATION_ADVICE_SOURCE_V1;
  readonly status: JevVerificationAdviceStatusV1;
  readonly reasonCode: JevVerificationAdviceReasonV1 | null;
  /** Selection is always kept separate from the deterministic P41 plan. */
  readonly adoption: JevVerificationAdviceAdoptionV1;
  readonly baselinePlanDigest: string;
  /** Bounded, content-free candidate metadata. Titles and request text are omitted. */
  readonly candidates: readonly JevVerificationAdviceCandidateV1[];
  readonly omittedCandidateCount: number;
  readonly preparedRequestSnapshot: JevVerificationAdviceRequestSnapshotV1 | null;
  /** Present only when the facade reports at least one HTTP attempt. */
  readonly sentRequestSnapshot: JevVerificationAdviceRequestSnapshotV1 | null;
  readonly suggestedCheckIds: readonly string[];
  readonly adoptedCheckIds: readonly string[];
  readonly overriddenCheckIds: readonly string[];
  readonly transport: JevVerificationAdviceTransportV1;
  readonly fingerprint: string;
}

export interface JevVerificationAdviceResultV1 {
  /** The deterministic plan is returned unchanged, including every required CI check. */
  readonly plan: VerificationPlan;
  /** Optional extra-check advice; it is not a plan entry or execution evidence. */
  readonly receipt: JevVerificationAdviceReceiptV1;
}

export class JevVerificationAdviceError extends Error {
  public readonly code: "invalid-receipt" | "invalid-adoption";

  public constructor(
    code: JevVerificationAdviceError["code"],
    message: string,
  ) {
    super(message);
    this.name = "JevVerificationAdviceError";
    this.code = code;
  }
}

interface OptionalCandidate extends JevVerificationAdviceCandidateV1 {
  readonly label: string;
  readonly relevantGoalCount: number;
}

interface VerificationAdviceRequest {
  readonly taskSummary: string;
  readonly questions: Readonly<{
    additional_check: {
      readonly type: "choice";
      readonly instructions: string;
      readonly criteria: Readonly<Record<string, string>>;
    };
  }>;
}

type ReceiptBody = Omit<JevVerificationAdviceReceiptV1, "fingerprint">;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("Unserializable value");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Unserializable value");
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function sealReceipt(body: ReceiptBody): JevVerificationAdviceReceiptV1 {
  return { ...body, fingerprint: sha256(body) };
}

function resealReceipt(
  receipt: JevVerificationAdviceReceiptV1,
  changes: Partial<ReceiptBody>,
): JevVerificationAdviceReceiptV1 {
  const { fingerprint: _fingerprint, ...body } = receipt;
  return sealReceipt({ ...body, ...changes });
}

function planDigest(plan: VerificationPlan): string {
  return sha256(plan);
}

function optionalCandidates(
  plan: VerificationPlan,
  checks: CreateVerificationPlanInput["checks"],
): OptionalCandidate[] {
  const selected = new Set(plan.selected.map(({ checkId }) => checkId));
  const skipped = new Map(plan.skipped.map((entry) => [entry.checkId, entry]));
  return checks
    .filter((check) => {
      if (
        check.kind !== "behavior" ||
        check.evidence !== "independent-public-behavior" ||
        selected.has(check.id)
      ) {
        return false;
      }
      const plannedSkip = skipped.get(check.id);
      return (
        plannedSkip?.reason === "already-covered" &&
        plannedSkip.relevantGoalIds.length > 0
      );
    })
    .sort((left, right) => compareText(left.id, right.id))
    .map((check, index) => {
      if (check.kind !== "behavior")
        throw new TypeError("Expected an independent behavior check");
      const plannedSkip = skipped.get(check.id);
      return {
        checkId: check.id,
        mode: check.mode,
        label: `candidate-${String(index + 1).padStart(2, "0")}`,
        relevantGoalCount: plannedSkip?.relevantGoalIds.length ?? 0,
      };
    });
}

function publicCandidates(
  candidates: readonly OptionalCandidate[],
): JevVerificationAdviceCandidateV1[] {
  return candidates.map(({ checkId, mode }) => ({ checkId, mode }));
}

function emptyTransport(): JevVerificationAdviceTransportV1 {
  return {
    latencyMs: 0,
    attempts: 0,
    httpStatus: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    estimatedInputCostMicrousd: null,
    confidence: unavailableJevConfidenceReceiptV1(["additional_check"]),
  };
}

function transportFrom(receipt: {
  readonly latencyMs: number;
  readonly attempts: number;
  readonly httpStatus: number | null;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedInputCostMicrousd: number | null;
  readonly confidence: JevConfidenceReceiptV1;
}): JevVerificationAdviceTransportV1 {
  return {
    latencyMs: receipt.latencyMs,
    attempts: receipt.attempts,
    httpStatus: receipt.httpStatus,
    model: receipt.model,
    inputTokens: receipt.inputTokens,
    outputTokens: receipt.outputTokens,
    estimatedInputCostMicrousd: receipt.estimatedInputCostMicrousd,
    confidence: projectJevConfidenceReceiptV1(receipt.confidence, [
      "additional_check",
    ]),
  };
}

function noMetricsTransport(
  latencyMs: number,
): JevVerificationAdviceTransportV1 {
  return {
    ...emptyTransport(),
    latencyMs,
    attempts: null,
  };
}

function snapshotFor(
  candidates: readonly OptionalCandidate[],
  taskSummary: string,
  request: VerificationAdviceRequest,
): JevVerificationAdviceRequestSnapshotV1 {
  return {
    candidateCheckIds: candidates.map(({ checkId }) => checkId),
    inputDigest: sha256({ node: "verification-planning", request }),
    inputSummaryChars: taskSummary.length,
  };
}

function requestFor(
  plan: VerificationPlan,
  candidates: readonly OptionalCandidate[],
): VerificationAdviceRequest {
  const taskSummary = JSON.stringify({
    purpose:
      "Suggest at most one optional additional independent public-behavior check.",
    impact: {
      scope: plan.impact.scope,
      risks: plan.impact.risks,
      changedSurfaceCount: plan.impact.changedSurfaces.length,
    },
    candidates: candidates.map(({ label, mode, relevantGoalCount }) => ({
      label,
      mode,
      relevantGoalCount,
    })),
    constraints: [
      "The deterministic plan is authoritative and must remain unchanged.",
      "Never remove, replace, or weaken selected checks or required project CI.",
      "This optional suggestion is not execution evidence, approval, Review, or Close authorization.",
      "Choose none when no extra check is useful.",
    ],
  });
  const criteria: Record<string, string> = {};
  for (const candidate of candidates) {
    criteria[candidate.label] =
      `Optional ${candidate.mode} public-behavior check.`;
  }
  criteria[NONE_LABEL] = "Do not suggest an additional optional check.";
  return {
    taskSummary,
    questions: {
      [QUESTION_ID]: {
        type: "choice",
        instructions:
          "Choose at most one optional additional verification check from the eligible candidates, or choose none. The deterministic plan and all required checks remain authoritative.",
        criteria,
      },
    },
  };
}

function receiptBody(input: {
  plan: VerificationPlan;
  status: JevVerificationAdviceStatusV1;
  reasonCode: JevVerificationAdviceReasonV1 | null;
  candidates: readonly JevVerificationAdviceCandidateV1[];
  omittedCandidateCount?: number;
  preparedRequestSnapshot?: JevVerificationAdviceRequestSnapshotV1 | null;
  sentRequestSnapshot?: JevVerificationAdviceRequestSnapshotV1 | null;
  suggestedCheckIds?: readonly string[];
  transport?: JevVerificationAdviceTransportV1;
}): ReceiptBody {
  const suggestedCheckIds = [...(input.suggestedCheckIds ?? [])];
  return {
    schemaVersion: 1,
    source: JEV_VERIFICATION_ADVICE_SOURCE_V1,
    status: input.status,
    reasonCode: input.reasonCode,
    adoption: suggestedCheckIds.length === 0 ? "not-applicable" : "pending",
    baselinePlanDigest: planDigest(input.plan),
    candidates: input.candidates.map((candidate) => ({ ...candidate })),
    omittedCandidateCount: input.omittedCandidateCount ?? 0,
    preparedRequestSnapshot: input.preparedRequestSnapshot ?? null,
    sentRequestSnapshot: input.sentRequestSnapshot ?? null,
    suggestedCheckIds,
    adoptedCheckIds: [],
    overriddenCheckIds: [],
    transport: input.transport ?? emptyTransport(),
  };
}

function attemptedSnapshot(
  prepared: JevVerificationAdviceRequestSnapshotV1,
  transport: JevVerificationAdviceTransportV1,
): JevVerificationAdviceRequestSnapshotV1 | null {
  return transport.attempts !== null && transport.attempts > 0
    ? prepared
    : null;
}

function failedResult(input: {
  plan: VerificationPlan;
  reasonCode: JevVerificationAdviceReasonV1;
  candidates: readonly JevVerificationAdviceCandidateV1[];
  omittedCandidateCount?: number;
  preparedRequestSnapshot?: JevVerificationAdviceRequestSnapshotV1 | null;
  sentRequestSnapshot?: JevVerificationAdviceRequestSnapshotV1 | null;
  transport?: JevVerificationAdviceTransportV1;
}): JevVerificationAdviceResultV1 {
  return {
    plan: input.plan,
    receipt: sealReceipt(
      receiptBody({
        ...input,
        status: "fallback",
      }),
    ),
  };
}

/**
 * Keep P41's local plan authoritative while optionally asking Jev for one extra
 * independent behavior check. The explicit egress decision is rechecked by the
 * Jev facade; this API never sends source snippets or changes the plan.
 */
export async function adviseVerificationPlanWithJevV1(
  input: AdviseVerificationPlanWithJevInputV1,
): Promise<JevVerificationAdviceResultV1> {
  const plan = createVerificationPlan({
    impact: input.impact,
    checks: input.checks,
  });
  const candidates = optionalCandidates(plan, input.checks);
  const reportedCandidates = candidates.slice(0, MAX_OPTIONAL_CANDIDATES + 1);
  const publicCandidateList = publicCandidates(reportedCandidates);

  if (candidates.length === 0) {
    return {
      plan,
      receipt: sealReceipt(
        receiptBody({
          plan,
          status: "skipped",
          reasonCode: "no-candidates",
          candidates: [],
        }),
      ),
    };
  }
  if (!input.jev) {
    return {
      plan,
      receipt: sealReceipt(
        receiptBody({
          plan,
          status: "skipped",
          reasonCode: "disabled",
          candidates: publicCandidateList,
          omittedCandidateCount: candidates.length - reportedCandidates.length,
        }),
      ),
    };
  }
  if (candidates.length > MAX_OPTIONAL_CANDIDATES) {
    return failedResult({
      plan,
      reasonCode: "candidate-bound-exceeded",
      candidates: publicCandidateList,
      omittedCandidateCount: candidates.length - reportedCandidates.length,
    });
  }

  const request = requestFor(plan, candidates);
  const preparedRequestSnapshot = snapshotFor(
    candidates,
    request.taskSummary,
    request,
  );
  const minimumDecisionConfidence = Math.max(
    input.jev.minimumDecisionConfidence ?? MINIMUM_DECISION_CONFIDENCE,
    MINIMUM_DECISION_CONFIDENCE,
  );
  const startedAt = Date.now();
  let result: Awaited<ReturnType<JevDecisionFacadeV1["decide"]>>;
  try {
    result = await input.jev.facade.decide({
      node: "verification-planning",
      request,
      options: {
        egress: input.jev.egress,
        ...(input.jev.signal ? { signal: input.jev.signal } : {}),
        minimumDecisionConfidence,
      },
    });
  } catch {
    return failedResult({
      plan,
      reasonCode: "transport-error",
      candidates: publicCandidateList,
      preparedRequestSnapshot,
      transport: noMetricsTransport(Math.max(0, Date.now() - startedAt)),
    });
  }

  const transport = transportFrom(result.receipt.transport);
  const sentRequestSnapshot = attemptedSnapshot(
    preparedRequestSnapshot,
    transport,
  );
  if (result.status === "fallback") {
    return failedResult({
      plan,
      reasonCode: result.fallback.reasonCode,
      candidates: publicCandidateList,
      preparedRequestSnapshot,
      sentRequestSnapshot,
      transport,
    });
  }

  const answer = result.answers[QUESTION_ID];
  const allowedLabels = new Set([
    NONE_LABEL,
    ...candidates.map(({ label }) => label),
  ]);
  if (
    answer?.type !== "choice" ||
    !allowedLabels.has(answer.choice) ||
    !Number.isFinite(answer.confidence)
  ) {
    return failedResult({
      plan,
      reasonCode: "invalid-response",
      candidates: publicCandidateList,
      preparedRequestSnapshot,
      sentRequestSnapshot,
      transport,
    });
  }
  if (
    !Number.isFinite(minimumDecisionConfidence) ||
    minimumDecisionConfidence < MINIMUM_DECISION_CONFIDENCE ||
    minimumDecisionConfidence > 1
  ) {
    return failedResult({
      plan,
      reasonCode: "configuration-invalid",
      candidates: publicCandidateList,
      preparedRequestSnapshot,
      sentRequestSnapshot,
      transport,
    });
  }
  if (answer.confidence < minimumDecisionConfidence) {
    return failedResult({
      plan,
      reasonCode: "low-confidence",
      candidates: publicCandidateList,
      preparedRequestSnapshot,
      sentRequestSnapshot,
      transport,
    });
  }

  const selected = candidates.find(({ label }) => label === answer.choice);
  const suggestedCheckIds = selected ? [selected.checkId] : [];
  return {
    plan,
    receipt: sealReceipt(
      receiptBody({
        plan,
        status: "answered",
        reasonCode: null,
        candidates: publicCandidateList,
        preparedRequestSnapshot,
        sentRequestSnapshot,
        suggestedCheckIds,
        transport,
      }),
    ),
  };
}

export function verifyJevVerificationAdviceReceiptV1(
  receipt: JevVerificationAdviceReceiptV1,
): boolean {
  try {
    if (
      receipt?.schemaVersion !== 1 ||
      receipt.source !== JEV_VERIFICATION_ADVICE_SOURCE_V1 ||
      !/^[a-f0-9]{64}$/u.test(receipt.fingerprint)
    )
      return false;
    const { fingerprint: storedFingerprint, ...body } = receipt;
    return sha256(body) === storedFingerprint;
  } catch {
    return false;
  }
}

/** Record an explicit caller choice without changing the deterministic plan. */
export function finalizeJevVerificationAdviceV1(
  receipt: JevVerificationAdviceReceiptV1,
  currentPlan: VerificationPlan,
  adoptedCheckIds: readonly string[] = [],
): JevVerificationAdviceReceiptV1 {
  if (!verifyJevVerificationAdviceReceiptV1(receipt)) {
    throw new JevVerificationAdviceError(
      "invalid-receipt",
      "Jev verification advice receipt integrity check failed.",
    );
  }
  if (receipt.status !== "answered") {
    if (adoptedCheckIds.length > 0) {
      throw new JevVerificationAdviceError(
        "invalid-adoption",
        "Advice can only be adopted from an answered Jev response.",
      );
    }
    return receipt;
  }
  if (receipt.adoption === "not-applicable") {
    if (adoptedCheckIds.length > 0) {
      throw new JevVerificationAdviceError(
        "invalid-adoption",
        "There is no Jev suggestion to adopt.",
      );
    }
    return receipt;
  }
  if (planDigest(currentPlan) !== receipt.baselinePlanDigest) {
    return resealReceipt(receipt, {
      status: "superseded",
      reasonCode: "verification-plan-changed",
      adoption: "overridden",
      adoptedCheckIds: [],
      overriddenCheckIds: [...receipt.suggestedCheckIds],
    });
  }
  if (receipt.adoption !== "pending") {
    if (
      adoptedCheckIds.length === receipt.adoptedCheckIds.length &&
      adoptedCheckIds.every(
        (checkId, index) => checkId === receipt.adoptedCheckIds[index],
      )
    ) {
      return receipt;
    }
    throw new JevVerificationAdviceError(
      "invalid-adoption",
      "A finalized Jev verification decision cannot be changed.",
    );
  }

  const accepted = new Set<string>();
  for (const checkId of adoptedCheckIds) {
    if (
      typeof checkId !== "string" ||
      !receipt.suggestedCheckIds.includes(checkId) ||
      accepted.has(checkId)
    ) {
      throw new JevVerificationAdviceError(
        "invalid-adoption",
        "Adopted check IDs must be unique suggestions from this receipt.",
      );
    }
    accepted.add(checkId);
  }
  const adopted = receipt.suggestedCheckIds.filter((checkId) =>
    accepted.has(checkId),
  );
  const overridden = receipt.suggestedCheckIds.filter(
    (checkId) => !accepted.has(checkId),
  );
  return resealReceipt(receipt, {
    adoption:
      adopted.length === 0
        ? "overridden"
        : overridden.length === 0
          ? "adopted"
          : "overridden",
    adoptedCheckIds: adopted,
    overriddenCheckIds: overridden,
  });
}
