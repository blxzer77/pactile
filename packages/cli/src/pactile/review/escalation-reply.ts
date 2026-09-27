import { safeParseCodexEscalationReviewContentV1, type ValidatedCodexEscalationReviewContentV1 } from "./contract.js";
import { exactKeys, objectValue, piReviewConcerns, sameStrings, PI_REVIEW_ESCALATION_REPLY_CONTRACT, type PreparedPiReviewEscalationV1 } from "./escalation-contract.js";

export function validateCodexReplyEnvelope(
  body: string,
  prepared: PreparedPiReviewEscalationV1,
  reviewArtifact: Record<string, unknown>,
  reviewer: { hostId: string; threadId: string },
  criterionIds: readonly string[],
): {
  content: ValidatedCodexEscalationReviewContentV1;
  rawReview: Record<string, unknown>;
} {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    throw new Error("Codex escalation reply is not one structured JSON object");
  }
  const envelope = objectValue(decoded, "Codex escalation reply");
  exactKeys(envelope, ["contractVersion", "source", "binding", "reviewer", "review"], "Codex escalation reply");
  if (
    envelope["contractVersion"] !== 1 ||
    envelope["source"] !== "pactile-codex-escalation-review-v1"
  ) {
    throw new Error("Codex escalation reply contract version or source is invalid");
  }
  const binding = objectValue(envelope["binding"], "Codex escalation reply binding");
  exactKeys(
    binding,
    PI_REVIEW_ESCALATION_REPLY_CONTRACT.binding,
    "Codex escalation reply binding",
  );
  const expectedBinding = {
    taskId: prepared.taskId,
    runId: prepared.runId,
    candidateSnapshotId: prepared.candidateSnapshotId,
    candidateFingerprint: prepared.candidateFingerprint,
    escalationId: prepared.escalationId,
    piRunId: prepared.piRunId,
    reviewId: prepared.reviewId,
    reviewArtifactRef: prepared.reviewArtifactRef,
    reviewArtifactSha256: prepared.reviewArtifactSha256,
    reviewContentFingerprint: prepared.reviewContentFingerprint,
  };
  if (Object.entries(expectedBinding).some(([key, value]) => binding[key] !== value)) {
    throw new Error("Codex escalation reply is bound to a different Pi Review or candidate");
  }
  const identity = objectValue(envelope["reviewer"], "Codex escalation reply reviewer");
  exactKeys(
    identity,
    PI_REVIEW_ESCALATION_REPLY_CONTRACT.reviewer,
    "Codex escalation reply reviewer",
  );
  if (
    identity["hostId"] !== reviewer.hostId ||
    identity["threadId"] !== reviewer.threadId ||
    identity["role"] !== "review" ||
    identity["independent"] !== true
  ) {
    throw new Error("Codex escalation reply reviewer identity does not match its native thread receipt");
  }
  const rawReview = objectValue(envelope["review"], "Codex escalation review body");
  exactKeys(
    rawReview,
    PI_REVIEW_ESCALATION_REPLY_CONTRACT.review,
    "Codex escalation Review body",
  );
  const parsed = safeParseCodexEscalationReviewContentV1(rawReview, criterionIds);
  if (!parsed.ok) {
    throw new Error(`Codex escalation Review contract rejected the reply: ${parsed.errors.join("; ")}`);
  }
  if (
    parsed.value.runId !== prepared.runId ||
    parsed.value.candidateSnapshotId !== prepared.candidateSnapshotId ||
    parsed.value.candidateFingerprint !== prepared.candidateFingerprint
  ) {
    throw new Error("Codex escalation Review body targets a different Run candidate");
  }
  const piReview = objectValue(reviewArtifact["review"], "Pi Review result");
  const expectedConcernIds = piReviewConcerns(piReview).map((concern) => concern.concernId);
  const reportedConcernIds = parsed.value.concernResolutions.map(
    (resolution) => resolution.concernId,
  );
  if (!sameStrings(expectedConcernIds, reportedConcernIds)) {
    throw new Error("Codex escalation Review must disposition every Pi concern exactly once");
  }
  return { content: parsed.value, rawReview };
}
