import { describe, expect, it, vi } from "vitest";
import {
  createJevDecisionFacadeV1,
  type JevDecisionFacadeV1,
  type JevEgressAuthorizationV1,
} from "../../../src/pactile/jev/index.js";
import {
  adviseVerificationPlanWithJevV1,
  createVerificationPlan,
  finalizeJevVerificationAdviceV1,
  verifyJevVerificationAdviceReceiptV1,
  type VerificationCheck,
  type VerificationImpact,
} from "../../../src/pactile/index.js";

const egress: JevEgressAuthorizationV1 = {
  network: "project-authorized",
  privacy: "project-approved-egress",
  credentials: "project-authorized",
  destination: "https://api.typesafe.ai",
  egressDestinations: ["https://api.typesafe.ai"],
  contentDecision: "task-summary-approved",
};

const impact: VerificationImpact = {
  changedSurfaces: ["task.create"],
  risks: [],
  scope: "single-area",
};

const checks: readonly VerificationCheck[] = [
  {
    kind: "behavior",
    id: "task.create.primary",
    title: "Primary public behavior check",
    mode: "focused",
    evidence: "independent-public-behavior",
    coversSurfaces: ["task.create"],
    coversRisks: [],
  },
  {
    kind: "behavior",
    id: "task.create.secondary",
    title: "Secondary public behavior check",
    mode: "focused",
    evidence: "independent-public-behavior",
    coversSurfaces: ["task.create"],
    coversRisks: [],
  },
  {
    kind: "behavior",
    id: "task.create.mirror",
    title: "Implementation mirror",
    mode: "focused",
    evidence: "implementation-mirror",
    coversSurfaces: ["task.create"],
    coversRisks: [],
  },
  {
    kind: "policy-ci",
    id: "required.typecheck",
    title: "Required typecheck",
    requiredBy: ["project CI: typecheck"],
  },
  {
    kind: "policy-ci",
    id: "optional.coverage",
    title: "Optional coverage report",
    requiredBy: [],
  },
];

function answeredFacade(
  choice: string,
  confidence = 0.98,
): JevDecisionFacadeV1 & { decide: ReturnType<typeof vi.fn> } {
  return {
    decide: vi.fn(async () => ({
      node: "verification-planning" as const,
      status: "answered" as const,
      answers: {
        additional_check: {
          type: "choice" as const,
          choice,
          confidence,
          probabilities: { [choice]: confidence, other: 1 - confidence },
        },
      },
      fallback: null,
      receipt: {
        schemaVersion: 1 as const,
        node: "verification-planning" as const,
        transport: {
          provider: "typesafe-jev" as const,
          outcome: "answered" as const,
          reasonCode: null,
          attempts: 1,
          latencyMs: 7,
          httpStatus: 200,
          requestId: "request-safe",
          model: "jev-test",
          inputTokens: 42,
          outputTokens: 5,
          estimatedInputCostMicrousd: 2,
          confidence: {
            additional_check: { status: "available", value: 0.98 },
          },
        },
        budget: {
          maxDecisions: 1,
          decisionsUsed: 1,
          decisionsRemaining: 0,
          maximumHttpAttempts: 2,
          observedEstimatedInputCostMicrousd: 2,
        },
      },
    })),
  };
}

function providerFetch(): {
  readonly fetchImpl: typeof fetch;
  readonly requests: Record<string, unknown>[];
} {
  const requests: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      readonly questions: Readonly<
        Record<string, { readonly criteria: Readonly<Record<string, string>> }>
      >;
    };
    requests.push(body as Record<string, unknown>);
    const labels = Object.keys(body.questions.additional_check?.criteria ?? {});
    const choice =
      labels.find((label) => label.startsWith("candidate-")) ?? "none";
    const probabilities = Object.fromEntries(
      labels.map((label) => [
        label,
        label === choice ? 0.98 : 0.02 / Math.max(1, labels.length - 1),
      ]),
    );
    return new Response(
      JSON.stringify({
        model: "jev-test",
        answers: {
          additional_check: {
            type: "choice",
            choice,
            confidence: 0.98,
            probabilities,
          },
        },
        usage: { input_tokens: 42, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

describe("P34 Jev verification advice", () => {
  it("keeps the P41 plan and required CI unchanged while recording a bounded optional suggestion", async () => {
    const baseline = createVerificationPlan({ impact, checks });
    const facade = answeredFacade("candidate-01");
    const result = await adviseVerificationPlanWithJevV1({
      impact,
      checks,
      jev: { facade, egress },
    });

    expect(result.plan).toEqual(baseline);
    expect(result.plan.selected.map(({ checkId }) => checkId)).toEqual([
      "required.typecheck",
      "task.create.primary",
    ]);
    expect(result.receipt).toMatchObject({
      status: "answered",
      adoption: "pending",
      candidates: [{ checkId: "task.create.secondary", mode: "focused" }],
      suggestedCheckIds: ["task.create.secondary"],
      adoptedCheckIds: [],
      overriddenCheckIds: [],
      preparedRequestSnapshot: {
        candidateCheckIds: ["task.create.secondary"],
        inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      sentRequestSnapshot: {
        candidateCheckIds: ["task.create.secondary"],
      },
      transport: {
        attempts: 1,
        latencyMs: 7,
        httpStatus: 200,
        model: "jev-test",
        confidence: {
          additional_check: { status: "available", value: 0.98 },
        },
      },
    });
    expect(
      result.receipt.candidates.map(({ checkId }) => checkId),
    ).not.toContain("required.typecheck");
    expect(
      result.receipt.candidates.map(({ checkId }) => checkId),
    ).not.toContain("optional.coverage");
    expect(
      result.receipt.candidates.map(({ checkId }) => checkId),
    ).not.toContain("task.create.mirror");
    expect(verifyJevVerificationAdviceReceiptV1(result.receipt)).toBe(true);

    const invocation = facade.decide.mock.calls[0]?.[0] as {
      request: { taskSummary: string; sourceSnippets?: readonly unknown[] };
    };
    expect(invocation.request.sourceSnippets).toBeUndefined();
    expect(invocation.request.taskSummary).toContain(
      "The deterministic plan is authoritative",
    );
    expect(JSON.stringify(result.receipt)).not.toContain(
      invocation.request.taskSummary,
    );

    const finalized = finalizeJevVerificationAdviceV1(
      result.receipt,
      baseline,
      ["task.create.secondary"],
    );
    expect(finalized).toMatchObject({
      adoption: "adopted",
      adoptedCheckIds: ["task.create.secondary"],
      overriddenCheckIds: [],
    });
    expect(finalized.fingerprint).not.toBe(result.receipt.fingerprint);
    expect(verifyJevVerificationAdviceReceiptV1(finalized)).toBe(true);
    expect(result.plan).toEqual(baseline);
  });

  it("honors explicit project egress denial before HTTP and keeps the deterministic plan", async () => {
    const baseline = createVerificationPlan({ impact, checks });
    const fetchImpl = vi.fn(
      async () => new Response("unused", { status: 200 }),
    );
    const facade = createJevDecisionFacadeV1({
      enabled: true,
      transport: {
        apiKey: "test-key-not-persisted",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    });
    const result = await adviseVerificationPlanWithJevV1({
      impact,
      checks,
      jev: { facade, egress: { ...egress, egressDestinations: [] } },
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.plan).toEqual(baseline);
    expect(result.receipt).toMatchObject({
      status: "fallback",
      reasonCode: "egress-denied",
      adoption: "not-applicable",
      suggestedCheckIds: [],
      sentRequestSnapshot: null,
      transport: {
        attempts: 0,
        latencyMs: 0,
        confidence: {
          additional_check: {
            status: "unavailable",
            reasonCode: "not-returned",
          },
        },
      },
    });
    expect(JSON.stringify(result.receipt)).not.toContain(
      "test-key-not-persisted",
    );
  });

  it("does not place synthetic credentials from semantic surface names in the Jev request", async () => {
    const sensitiveImpact: VerificationImpact = {
      ...impact,
      changedSurfaces: [
        "task.create",
        "NPM_TOKEN=synthetic-npm-credential",
        "PRIVATE_TOKEN=synthetic-private-credential",
        "DATABASE_URL=postgres://synthetic:secret@example.invalid/db",
      ],
    };
    const { fetchImpl, requests } = providerFetch();
    const facade = createJevDecisionFacadeV1({
      enabled: true,
      transport: {
        apiKey: "test-key-not-persisted",
        fetchImpl,
      },
    });
    const result = await adviseVerificationPlanWithJevV1({
      impact: sensitiveImpact,
      checks,
      jev: { facade, egress },
    });

    expect(result.receipt.status).toBe("answered");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const sent = requests[0] as {
      state: { taskSummary: string; sourceSnippets: readonly unknown[] };
    };
    expect(sent.state.sourceSnippets).toEqual([]);
    expect(sent.state.taskSummary).toContain("changedSurfaceCount");
    expect(sent.state.taskSummary).not.toContain("NPM_TOKEN");
    expect(sent.state.taskSummary).not.toContain("PRIVATE_TOKEN");
    expect(sent.state.taskSummary).not.toContain("DATABASE_URL");
    expect(JSON.stringify(requests)).not.toContain("synthetic-npm-credential");
    expect(JSON.stringify(requests)).not.toContain(
      "synthetic-private-credential",
    );
    expect(JSON.stringify(requests)).not.toContain("postgres://synthetic");
    expect(JSON.stringify(result.receipt)).not.toContain(
      "test-key-not-persisted",
    );
  });

  it("rejects an out-of-candidate model choice and cannot weaken required checks", async () => {
    const baseline = createVerificationPlan({ impact, checks });
    const result = await adviseVerificationPlanWithJevV1({
      impact,
      checks,
      jev: { facade: answeredFacade("required.typecheck"), egress },
    });

    expect(result.plan).toEqual(baseline);
    expect(result.receipt).toMatchObject({
      status: "fallback",
      reasonCode: "invalid-response",
      suggestedCheckIds: [],
      adoptedCheckIds: [],
      overriddenCheckIds: [],
    });
    expect(result.plan.selected).toContainEqual(
      expect.objectContaining({
        checkId: "required.typecheck",
        reason: "required-by-policy",
      }),
    );
  });

  it("keeps provider confidence in the durable low-confidence fallback receipt", async () => {
    const baseline = createVerificationPlan({ impact, checks });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "jev-test",
            answers: {
              additional_check: {
                type: "choice",
                choice: "candidate-01",
                confidence: 0.4,
                probabilities: { "candidate-01": 0.6, none: 0.4 },
              },
            },
            usage: { input_tokens: 42, output_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;
    const result = await adviseVerificationPlanWithJevV1({
      impact,
      checks,
      jev: {
        facade: createJevDecisionFacadeV1({
          enabled: true,
          transport: { apiKey: "test-key-not-persisted", fetchImpl },
        }),
        egress,
      },
    });

    expect(result.plan).toEqual(baseline);
    expect(result.receipt).toMatchObject({
      status: "fallback",
      reasonCode: "low-confidence",
      suggestedCheckIds: [],
      sentRequestSnapshot: {
        candidateCheckIds: ["task.create.secondary"],
      },
      transport: {
        attempts: 1,
        httpStatus: 200,
        confidence: {
          additional_check: { status: "available", value: 0.4 },
        },
      },
    });
    expect(verifyJevVerificationAdviceReceiptV1(result.receipt)).toBe(true);
    expect(JSON.stringify(result.receipt)).not.toContain("test-key-not-persisted");
  });

  it("supersedes advice when the local verification plan changes before caller adoption", async () => {
    const baseline = createVerificationPlan({ impact, checks });
    const result = await adviseVerificationPlanWithJevV1({
      impact,
      checks,
      jev: { facade: answeredFacade("candidate-01"), egress },
    });
    const changedPlan = createVerificationPlan({
      impact: { ...impact, changedSurfaces: ["task.update"] },
      checks,
    });

    const finalized = finalizeJevVerificationAdviceV1(
      result.receipt,
      changedPlan,
      ["task.create.secondary"],
    );

    expect(finalized).toMatchObject({
      status: "superseded",
      reasonCode: "verification-plan-changed",
      adoption: "overridden",
      adoptedCheckIds: [],
      overriddenCheckIds: ["task.create.secondary"],
    });
    const adoptedBeforeChange = finalizeJevVerificationAdviceV1(
      result.receipt,
      baseline,
      ["task.create.secondary"],
    );
    const supersededAfterAdoption = finalizeJevVerificationAdviceV1(
      adoptedBeforeChange,
      changedPlan,
      ["task.create.secondary"],
    );
    expect(supersededAfterAdoption).toMatchObject({
      status: "superseded",
      reasonCode: "verification-plan-changed",
      adoption: "overridden",
      adoptedCheckIds: [],
      overriddenCheckIds: ["task.create.secondary"],
    });
    expect(result.plan).toEqual(baseline);
    expect(verifyJevVerificationAdviceReceiptV1(finalized)).toBe(true);
    expect(verifyJevVerificationAdviceReceiptV1(supersededAfterAdoption)).toBe(
      true,
    );
  });

  it("falls back when the caller throws or tries to adopt an unsuggested check", async () => {
    const baseline = createVerificationPlan({ impact, checks });
    const throwingFacade: JevDecisionFacadeV1 = {
      decide: vi.fn(async () => {
        throw new Error("provider details must not leak");
      }),
    };
    const failed = await adviseVerificationPlanWithJevV1({
      impact,
      checks,
      jev: { facade: throwingFacade, egress },
    });

    expect(failed.plan).toEqual(baseline);
    expect(failed.receipt).toMatchObject({
      status: "fallback",
      reasonCode: "transport-error",
      transport: { attempts: null },
    });
    expect(JSON.stringify(failed.receipt)).not.toContain("provider details");

    const answered = await adviseVerificationPlanWithJevV1({
      impact,
      checks,
      jev: { facade: answeredFacade("candidate-01"), egress },
    });
    expect(() =>
      finalizeJevVerificationAdviceV1(answered.receipt, baseline, [
        "required.typecheck",
      ]),
    ).toThrow(/unique suggestions from this receipt/u);
  });
});
