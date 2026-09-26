import { fingerprintPactileContractV1 } from "../../core/index.js";
import type { JevDecisionResultV1 } from "../jev/index.js";
import type { JevConfidenceReceiptV1 } from "../jev/index.js";
import { projectJevConfidenceReceiptV1 } from "../jev/response.js";
import type { TileSelectionJevAdviceV1 } from "../tiles/jev-selection.js";
import type {
  TileSelectionDecision,
  TileSelectionOffer,
} from "../tiles/selection.js";

const SESSION_JEV_MODEL = "jev-latest";
const SESSION_CHANGED_EXPLANATION =
  "The selected Task, Run, or Tile offer changed while Jev was deciding; the suggestion was discarded and the current deterministic session was kept.";

export interface SessionJevReceiptV1 {
  readonly schemaVersion: 1;
  readonly status: "answered" | "fallback" | "discarded-stale";
  readonly node: "tile-selection";
  readonly model: string | null;
  /** Fingerprint of the bounded offer/candidate input; never includes its text. */
  readonly offerFingerprint: string;
  readonly inputFingerprint: string;
  readonly candidateRefs: readonly string[];
  readonly outboundAttempted: boolean;
  readonly suggestedRefs: readonly string[];
  readonly deterministicRefs: readonly string[];
  readonly recommendedAction: "adopt" | "override" | "no-match" | null;
  /** Recommendations require the existing explicit Tile decision command. */
  readonly application:
    | "pending-explicit-decision"
    | "not-applied"
    | "discarded";
  readonly decisionCommand?: string;
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

function advisedCandidateRefs(offer: TileSelectionOffer): string[] {
  return offer.candidates
    .filter((candidate) => candidate.outputScore > 0)
    .slice(0, 8)
    .map((candidate) => candidate.ref);
}

function equalRefs(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((ref, index) => ref === right[index])
  );
}

function decisionCommand(
  offer: TileSelectionOffer,
  decision: TileSelectionDecision,
): {
  readonly command: string;
  readonly action: "adopt" | "override" | "no-match";
} {
  if (decision.kind === "no-match" || decision.kind === "invalid") {
    return {
      action: "no-match",
      command: `pactile tile-selection decide --session --offer-fingerprint ${offer.fingerprint} --kind no-match`,
    };
  }
  const refs =
    decision.kind === "adopt"
      ? offer.suggestion.selectedRefs
      : (decision.selectedRefs ?? []);
  const action = equalRefs(refs, offer.suggestion.selectedRefs)
    ? "adopt"
    : "override";
  const command = [
    "pactile tile-selection decide --session",
    `--offer-fingerprint ${offer.fingerprint}`,
    `--kind ${action}`,
    ...(action === "override" ? refs.map((ref) => `--tile ${ref}`) : []),
  ].join(" ");
  return { action, command };
}

function inputFingerprint(offer: TileSelectionOffer): string {
  return fingerprintPactileContractV1({
    schemaVersion: 1,
    kind: "pactile.session.jev-input",
    offerFingerprint: offer.fingerprint,
    candidateRefs: advisedCandidateRefs(offer),
    model: SESSION_JEV_MODEL,
  });
}

export function createSessionJevReceiptV1(
  offer: TileSelectionOffer,
  advice: TileSelectionJevAdviceV1,
): SessionJevReceiptV1 {
  const decision = advice.jevDecision;
  const transport = decision?.receipt.transport;
  const candidateRefs = advisedCandidateRefs(offer);
  const suggestedRefs =
    advice.suggestedDecision?.kind === "override"
      ? [...(advice.suggestedDecision.selectedRefs ?? [])].slice(0, 8)
      : advice.suggestedDecision?.kind === "no-match"
        ? []
        : advice.source === "jev-advised"
          ? [...offer.suggestion.selectedRefs].slice(0, 8)
          : [];
  const command =
    advice.source === "jev-advised" && advice.suggestedDecision
      ? decisionCommand(offer, advice.suggestedDecision)
      : null;
  return {
    schemaVersion: 1,
    status: advice.source === "jev-advised" ? "answered" : "fallback",
    node: "tile-selection",
    model: transport?.model ?? SESSION_JEV_MODEL,
    offerFingerprint: offer.fingerprint,
    inputFingerprint: inputFingerprint(offer),
    candidateRefs,
    outboundAttempted: (transport?.attempts ?? 0) > 0,
    suggestedRefs,
    deterministicRefs: [...offer.suggestion.selectedRefs].slice(0, 8),
    recommendedAction: command?.action ?? null,
    application: command ? "pending-explicit-decision" : "not-applied",
    ...(command ? { decisionCommand: command.command } : {}),
    attempts: transport?.attempts ?? 0,
    latencyMs: transport?.latencyMs ?? 0,
    httpStatus: transport?.httpStatus ?? null,
    requestId: transport?.requestId ?? null,
    inputTokens: transport?.inputTokens ?? null,
    outputTokens: transport?.outputTokens ?? null,
    estimatedInputCostMicrousd: transport?.estimatedInputCostMicrousd ?? null,
    confidence: projectJevConfidenceReceiptV1(
      transport?.confidence,
      candidateRefs.map((_ref, index) => `candidate${index}`),
    ),
    fallback: advice.fallback,
  };
}

export function createStaleSessionJevReceiptV1(
  offer: TileSelectionOffer,
  decision: JevDecisionResultV1 | null,
  stalePoint: "before-advice" | "during-advice" = "during-advice",
): SessionJevReceiptV1 {
  const transport = decision?.receipt.transport;
  const candidateRefs = advisedCandidateRefs(offer);
  const beforeAdvice = stalePoint === "before-advice";
  return {
    schemaVersion: 1,
    status: "discarded-stale",
    node: "tile-selection",
    model: transport?.model ?? SESSION_JEV_MODEL,
    offerFingerprint: offer.fingerprint,
    inputFingerprint: inputFingerprint(offer),
    candidateRefs,
    outboundAttempted: (transport?.attempts ?? 0) > 0,
    suggestedRefs: [],
    deterministicRefs: [],
    recommendedAction: null,
    application: "discarded",
    attempts: transport?.attempts ?? 0,
    latencyMs: transport?.latencyMs ?? 0,
    httpStatus: transport?.httpStatus ?? null,
    requestId: transport?.requestId ?? null,
    inputTokens: transport?.inputTokens ?? null,
    outputTokens: transport?.outputTokens ?? null,
    estimatedInputCostMicrousd: transport?.estimatedInputCostMicrousd ?? null,
    confidence: projectJevConfidenceReceiptV1(
      transport?.confidence,
      candidateRefs.map((_ref, index) => `candidate${index}`),
    ),
    fallback: {
      reasonCode: beforeAdvice
        ? "session-changed-before-advice"
        : "session-changed-during-advice",
      explanation: beforeAdvice
        ? "The selected Task, Run, or Tile offer changed before Jev advice started; the current deterministic session was kept."
        : SESSION_CHANGED_EXPLANATION,
    },
  };
}

export function attachSessionJevReceiptV1(
  pack: Record<string, unknown>,
  advice: SessionJevReceiptV1,
): Record<string, unknown> {
  const selection = pack.tileSelection;
  if (!selection || typeof selection !== "object" || Array.isArray(selection))
    return pack;
  return {
    ...pack,
    tileSelection: {
      ...(selection as Record<string, unknown>),
      jevAdvice: advice,
    },
  };
}
