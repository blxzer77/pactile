import { describe, expect, it } from "vitest";
import {
  INDEPENDENT_REVIEW_AREAS,
  collectIndependentPiReviewEvidenceRefs,
  safeParseIndependentPiReview,
  type IndependentPiReviewContext,
} from "../../../src/pactile/review/contract.js";

const candidate = {
  snapshotId: "candidate-1",
  fingerprint: "a".repeat(64),
};
const reviewEvidenceRefs = [
  ...INDEPENDENT_REVIEW_AREAS.map((area) => `evidence/${area}.md`),
  "evidence/review.md",
  "tests/verify.log",
];

function context(): IndependentPiReviewContext {
  return {
    transportOutcome: "settled",
    reviewerId: "pi-session:session-1",
    reviewerAuthority: "pi-check",
    latestCompletedRunId: "run-1",
    kernelRevision: 42,
    piReceipt: {
      piRunId: "pi-run-1",
      role: "check",
      outcome: "settled",
      taskRunId: "run-1",
      candidateSnapshotId: candidate.snapshotId,
      candidateFingerprint: candidate.fingerprint,
      sessionId: "session-1",
      reviewerId: "pi-session:session-1",
      reviewerIdentityAssurance: "caller-declared",
      kernelRevisionAtDispatch: 42,
      startupMs: 10,
      firstEventMs: 20,
      elapsedMs: 200,
      eventCount: 3,
      toolErrors: 0,
    },
    run: {
      id: "run-1",
      state: "completed",
      startedBy: "implementer",
      authorization: {
        approvedBy: "approver",
        approvedAt: "2026-09-27T00:00:00.000Z",
        scope: "src",
        evidenceRef: "approval.md",
      },
      host: null,
      candidateSnapshot: { id: candidate.snapshotId, fingerprint: candidate.fingerprint, entries: [] },
    },
    boundCandidate: { ...candidate },
    acceptanceCriterionIds: ["AC-1"],
    evidenceVerification: {
      schemaVersion: 1,
      source: "pactile-task-review-evidence-v1",
      observedAt: "2026-09-27T00:01:00.000Z",
      runId: "run-1",
      candidateSnapshotId: candidate.snapshotId,
      candidateFingerprint: candidate.fingerprint,
      items: reviewEvidenceRefs.map((ref) => ({ ref, sha256: "b".repeat(64), sizeBytes: 1, source: "candidate-snapshot" as const })),
    },
  };
}

function report(): Record<string, unknown> {
  return {
    contractVersion: 1,
    runId: "run-1",
    candidateSnapshotId: candidate.snapshotId,
    candidateFingerprint: candidate.fingerprint,
    verdict: "pass",
    coverage: Object.fromEntries(INDEPENDENT_REVIEW_AREAS.map((area) => [
      area,
      { status: "clear", confidence: "high", evidenceRefs: ["evidence/" + area + ".md"], note: null },
    ])),
    findings: [],
    blockers: [],
    unresolvedQuestions: [],
    evidenceRefs: ["evidence/review.md"],
    acceptanceEvidence: { "AC-1": ["tests/verify.log"] },
    escalation: { required: false, target: "none", reasons: [] },
    usage: {
      inputTokens: 1_000,
      outputTokens: 250,
      estimatedCostMicros: 125,
    },
  };
}

describe("independent Pi Review contract", () => {
  it("collects every reference the evidence resolver must verify", () => {
    expect(collectIndependentPiReviewEvidenceRefs(report(), ["AC-1"])).toEqual({
      ok: true,
      references: [...reviewEvidenceRefs].sort(),
    });
  });

  it("binds a structured pass to the latest Run and candidate, with reviewer identity from context", () => {
    const result = safeParseIndependentPiReview(report(), context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.independent).toBe(true);
    expect(result.value.reviewer).toBe("pi-session:session-1");
    expect(result.value.reviewerIdentityAssurance).toBe("caller-declared");
    expect(result.value.piReceipt).toMatchObject({ piRunId: "pi-run-1", sessionId: "session-1" });
    expect(result.value.kernelReview).toMatchObject({
      actor: "pi-session:session-1",
      runId: "run-1",
      candidateSnapshotId: "candidate-1",
      candidateFingerprint: candidate.fingerprint,
      decision: "pass",
      unresolvedBlockers: [],
    });
    expect(result.value.telemetry.elapsedMs).toBe(200);
    expect(result.value.telemetry).toMatchObject({ timingAssurance: "pi-bridge-local", usageAssurance: "caller-declared" });
    expect(result.value.evidenceVerification.items.map((item) => item.ref).sort()).toEqual([...reviewEvidenceRefs].sort());
  });

  it("rejects self-review and Jev/advisor output as an independent Review", () => {
    const selfReview = context();
    selfReview.run.startedBy = "pi-session:session-1";
    expect(safeParseIndependentPiReview(report(), selfReview)).toMatchObject({ ok: false });

    const advisor = context();
    advisor.reviewerAuthority = "jev-advisor";
    expect(safeParseIndependentPiReview(report(), advisor)).toMatchObject({ ok: false });
  });

  it("rejects a Pi reviewer session that matches the implementation Run host session", () => {
    const sameSession = context();
    (sameSession.run as unknown as { host: { sessionId: string } | null }).host = { sessionId: "session-1" };
    expect(safeParseIndependentPiReview(report(), sameSession)).toMatchObject({ ok: false });
  });

  it("rejects a stale observed candidate and a report for an older candidate", () => {
    const staleObservation = context();
    staleObservation.boundCandidate = { snapshotId: "candidate-old", fingerprint: "b".repeat(64) };
    expect(safeParseIndependentPiReview(report(), staleObservation)).toMatchObject({ ok: false });

    const staleReport = report();
    staleReport["candidateFingerprint"] = "b".repeat(64);
    expect(safeParseIndependentPiReview(staleReport, context())).toMatchObject({ ok: false });
  });

  it("does not turn Pi settled into PASS without a structured verdict and complete evidence", () => {
    expect(safeParseIndependentPiReview({ outcome: "settled" }, context())).toMatchObject({ ok: false });

    const missingEvidence = report();
    const coverage = missingEvidence["coverage"] as Record<string, unknown>;
    const security = coverage["security"] as Record<string, unknown>;
    security["evidenceRefs"] = [];
    expect(safeParseIndependentPiReview(missingEvidence, context())).toMatchObject({ ok: false });

    const missingAcceptance = report();
    missingAcceptance["acceptanceEvidence"] = { "AC-1": [] };
    expect(safeParseIndependentPiReview(missingAcceptance, context())).toMatchObject({ ok: false });
  });

  it("rejects a Review citation that has no matching byte-verified evidence receipt", () => {
    const incomplete = context();
    incomplete.evidenceVerification.items = incomplete.evidenceVerification.items.filter((item) => item.ref !== "tests/verify.log");
    expect(safeParseIndependentPiReview(report(), incomplete)).toMatchObject({ ok: false });
  });

  it("rejects passing Reviews with unresolved blockers or questions", () => {
    const unresolved = report();
    unresolved["unresolvedQuestions"] = [{
      id: "question-1",
      question: "Is this behavior intended?",
      evidenceRefs: ["review/question.md"],
    }];
    const coverage = unresolved["coverage"] as Record<string, unknown>;
    const questionsArea = coverage["open-questions"] as Record<string, unknown>;
    questionsArea["status"] = "finding";
    unresolved["escalation"] = { required: true, target: "codex", reasons: ["uncertainty"] };
    expect(safeParseIndependentPiReview(unresolved, context())).toMatchObject({ ok: false });
  });

  it("rejects a blocking finding even when the report says pass", () => {
    const blocked = report();
    blocked["findings"] = [{
      id: "finding-blocker",
      area: "security",
      severity: "blocker",
      confidence: "high",
      impact: "low",
      disputed: false,
      summary: "A required security fix is missing.",
      evidenceRefs: ["src/handler.ts:42"],
    }];
    blocked["blockers"] = [{
      id: "blocker-1",
      findingId: "finding-blocker",
      summary: "Resolve the security finding before closing.",
      evidenceRefs: ["src/handler.ts:42"],
    }];
    const coverage = blocked["coverage"] as Record<string, unknown>;
    const security = coverage["security"] as Record<string, unknown>;
    security["status"] = "finding";
    expect(safeParseIndependentPiReview(blocked, context())).toMatchObject({ ok: false });
  });

  it("marks uncertainty, high impact, and disputes for Codex escalation", () => {
    const needsCodex = report();
    needsCodex["verdict"] = "needs-changes";
    const coverage = needsCodex["coverage"] as Record<string, unknown>;
    const security = coverage["security"] as Record<string, unknown>;
    security["confidence"] = "medium";
    needsCodex["findings"] = [{
      id: "finding-1",
      area: "security",
      severity: "warning",
      confidence: "high",
      impact: "high",
      disputed: true,
      summary: "Security impact needs a second opinion.",
      evidenceRefs: ["src/handler.ts:42"],
    }];
    security["status"] = "finding";
    needsCodex["escalation"] = {
      required: true,
      target: "codex",
      reasons: ["uncertainty", "high-impact", "dispute"],
    };
    const escalationContext = context();
    escalationContext.evidenceVerification.items.push({
      ref: "src/handler.ts:42",
      sha256: "c".repeat(64),
      sizeBytes: 1,
      source: "candidate-snapshot",
    });
    const result = safeParseIndependentPiReview(needsCodex, escalationContext);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.escalation).toEqual({
      required: true,
      target: "codex",
      reasons: ["uncertainty", "high-impact", "dispute"],
    });

    needsCodex["verdict"] = "pass";
    expect(safeParseIndependentPiReview(needsCodex, escalationContext)).toMatchObject({ ok: false });
  });

  it("preserves nullable local timing and unavailable usage without inventing hard cost limits", () => {
    const unavailable = context();
    unavailable.piReceipt.startupMs = null;
    unavailable.piReceipt.firstEventMs = null;
    unavailable.piReceipt.elapsedMs = null;
    const highUsage = report();
    const usage = highUsage["usage"] as Record<string, unknown>;
    usage["inputTokens"] = 100_000_001;
    usage["estimatedCostMicros"] = 100_000_001;
    const result = safeParseIndependentPiReview(highUsage, unavailable);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.telemetry).toMatchObject({ startupMs: null, firstEventMs: null, elapsedMs: null, outputTokens: 250 });
      expect(result.value.telemetry.inputTokens).toBe(100_000_001);
      expect(result.value.telemetry.estimatedCostMicros).toBe(100_000_001);
    }

    const missingUsage = report();
    const missingUsageFields = missingUsage["usage"] as Record<string, unknown>;
    missingUsageFields["inputTokens"] = null;
    missingUsageFields["outputTokens"] = null;
    missingUsageFields["estimatedCostMicros"] = null;
    const missingUsageResult = safeParseIndependentPiReview(missingUsage, context());
    expect(missingUsageResult.ok).toBe(true);

    const secret = report();
    secret["evidenceRefs"] = ["https://ci.example/job?token=supersecretvalue123"];
    expect(safeParseIndependentPiReview(secret, context())).toMatchObject({ ok: false });
  });

  it("rejects a stale Kernel revision, RPC tool failure, and an unbound session receipt", () => {
    const stale = context();
    stale.piReceipt.kernelRevisionAtDispatch += 1;
    expect(safeParseIndependentPiReview(report(), stale)).toMatchObject({ ok: false });

    const failedTool = context();
    failedTool.piReceipt.toolErrors = 1;
    expect(safeParseIndependentPiReview(report(), failedTool)).toMatchObject({ ok: false });

    const missingSession = context();
    missingSession.piReceipt.sessionId = null;
    expect(safeParseIndependentPiReview(report(), missingSession)).toMatchObject({ ok: false });

    const malformedReceipt = context();
    (malformedReceipt.piReceipt as unknown as Record<string, unknown>)["forgedTiming"] = 1;
    expect(safeParseIndependentPiReview(report(), malformedReceipt)).toMatchObject({ ok: false });
  });
});
