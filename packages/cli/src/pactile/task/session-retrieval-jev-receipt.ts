import { fingerprintPactileContractV1 } from "../../core/index.js";
import type { PactileIntentV1 } from "../../core/index.js";
import type { JevDecisionResultV1 } from "../jev/index.js";
import type { JevConfidenceReceiptV1 } from "../jev/index.js";
import { projectJevConfidenceReceiptV1 } from "../jev/response.js";
import type { RetrievalJevPlanResultV1 } from "../retrieval/index.js";

const RETRIEVAL_JEV_CANDIDATES = ["semantic", "structural"] as const;
type RetrievalJevCandidate = (typeof RETRIEVAL_JEV_CANDIDATES)[number];

export type SessionRetrievalJevStatusV1 =
  | "answered"
  | "fallback"
  | "skipped"
  | "discarded-stale";

export type SessionRetrievalJevApplicationV1 =
  | "adopted"
  | "overridden"
  | "not-applied"
  | "discarded";

export interface SessionRetrievalJevReceiptV1 {
  readonly schemaVersion: 1;
  readonly status: SessionRetrievalJevStatusV1;
  readonly node: "retrieval-planning";
  /** Fingerprint of the bounded summary and route candidates; the summary is never persisted. */
  readonly inputFingerprint: string;
  readonly candidateIntents: readonly RetrievalJevCandidate[];
  readonly suggestedIntents: readonly RetrievalJevCandidate[];
  readonly deterministicIntents: readonly PactileIntentV1[];
  readonly adoptedIntents: readonly RetrievalJevCandidate[];
  readonly overriddenIntents: readonly RetrievalJevCandidate[];
  readonly application: SessionRetrievalJevApplicationV1;
  readonly outboundAttempted: boolean;
  readonly model: string | null;
  readonly attempts: number;
  readonly latencyMs: number;
  readonly httpStatus: number | null;
  readonly requestId: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedInputCostMicrousd: number | null;
  readonly confidence: JevConfidenceReceiptV1;
  readonly fallback: {
    readonly reasonCode: string;
    readonly explanation: string;
  } | null;
}

export interface CreateSessionRetrievalJevReceiptInputV1 {
  readonly summary: string;
  readonly deterministicIntents: readonly PactileIntentV1[];
  readonly result?: RetrievalJevPlanResultV1 | null;
  readonly decision?: JevDecisionResultV1 | null;
  readonly fallbackReasonCode?: string;
  readonly fallbackExplanation?: string;
  readonly stale?: boolean;
}

function candidateIntentsFromDecision(
  decision: JevDecisionResultV1 | null | undefined,
): RetrievalJevCandidate[] {
  if (decision?.status !== "answered") return [];
  return RETRIEVAL_JEV_CANDIDATES.filter((intent) => {
    const answer = decision.answers[intent];
    return answer?.type === "choice" && answer.choice === "include";
  });
}

function inputFingerprint(
  summary: string,
  deterministicIntents: readonly PactileIntentV1[],
): string {
  return fingerprintPactileContractV1({
    schemaVersion: 1,
    kind: "pactile.session.retrieval-jev-input",
    summary,
    candidateIntents: RETRIEVAL_JEV_CANDIDATES,
    deterministicIntents: [...deterministicIntents],
  });
}

function fallbackValue(
  input: CreateSessionRetrievalJevReceiptInputV1,
  decision: JevDecisionResultV1 | null,
): SessionRetrievalJevReceiptV1["fallback"] {
  if (input.fallbackReasonCode) {
    return {
      reasonCode: input.fallbackReasonCode,
      explanation:
        input.fallbackExplanation ??
        "Jev retrieval advice was unavailable; the deterministic retrieval plan was kept.",
    };
  }
  return decision?.status === "fallback" ? decision.fallback : null;
}

/** Build a redacted, auditable receipt for the V2 Session retrieval decision. */
export function createSessionRetrievalJevReceiptV1(
  input: CreateSessionRetrievalJevReceiptInputV1,
): SessionRetrievalJevReceiptV1 {
  const decision = input.decision ?? input.result?.decision ?? null;
  const transport = decision?.receipt.transport;
  const suggestedIntents = candidateIntentsFromDecision(decision);
  const result = input.result;
  const adoptedIntents =
    !input.stale && result?.source === "jev-advised"
      ? suggestedIntents.filter((intent) =>
          result.plan.intents.includes(intent),
        )
      : [];
  const overriddenIntents =
    input.stale ||
    (decision?.status === "answered" && adoptedIntents.length === 0)
      ? [...suggestedIntents]
      : [];
  const fallback = fallbackValue(input, decision);
  const status: SessionRetrievalJevStatusV1 = input.stale
    ? "discarded-stale"
    : fallback
      ? "fallback"
      : decision?.status === "answered"
        ? "answered"
        : "skipped";
  const application: SessionRetrievalJevApplicationV1 = input.stale
    ? "discarded"
    : adoptedIntents.length > 0
      ? "adopted"
      : overriddenIntents.length > 0
        ? "overridden"
        : "not-applied";

  return {
    schemaVersion: 1,
    status,
    node: "retrieval-planning",
    inputFingerprint: inputFingerprint(
      input.summary,
      input.deterministicIntents,
    ),
    candidateIntents: [...RETRIEVAL_JEV_CANDIDATES],
    suggestedIntents,
    deterministicIntents: [...input.deterministicIntents],
    adoptedIntents,
    overriddenIntents,
    application,
    outboundAttempted: (transport?.attempts ?? 0) > 0,
    model: transport?.model ?? null,
    attempts: transport?.attempts ?? 0,
    latencyMs: transport?.latencyMs ?? 0,
    httpStatus: transport?.httpStatus ?? null,
    requestId: transport?.requestId ?? null,
    inputTokens: transport?.inputTokens ?? null,
    outputTokens: transport?.outputTokens ?? null,
    estimatedInputCostMicrousd: transport?.estimatedInputCostMicrousd ?? null,
    confidence: projectJevConfidenceReceiptV1(
      transport?.confidence,
      RETRIEVAL_JEV_CANDIDATES,
    ),
    fallback,
  };
}

export function attachSessionRetrievalJevReceiptV1(
  pack: Record<string, unknown>,
  receipt: SessionRetrievalJevReceiptV1,
): Record<string, unknown> {
  const retrievalPlanning = pack.retrievalPlanning;
  if (
    retrievalPlanning === null ||
    typeof retrievalPlanning !== "object" ||
    Array.isArray(retrievalPlanning)
  )
    return pack;
  return {
    ...pack,
    retrievalPlanning: {
      ...(retrievalPlanning as Record<string, unknown>),
      audit: receipt,
    },
  };
}
