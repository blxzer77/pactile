import { describe, expect, it, vi } from "vitest";
import {
  createJevDecisionFacadeV1,
  type JevEgressAuthorizationV1,
} from "../../../src/pactile/jev/index.js";

const egress: JevEgressAuthorizationV1 = {
  network: "project-authorized",
  privacy: "project-approved-egress",
  credentials: "project-authorized",
  destination: "https://api.typesafe.ai",
  egressDestinations: ["https://api.typesafe.ai"],
  contentDecision: "task-summary-approved",
};

const invocation = {
  node: "retrieval-planning" as const,
  request: {
    taskSummary: "Classify the retrieval intent for a bounded request.",
    questions: {
      route: {
        type: "choice" as const,
        instructions: "Choose the best route.",
        criteria: { exact: "Exact.", semantic: "Semantic." },
      },
    },
  },
  options: { egress },
};

const success = {
  model: "jev-1.13.0",
  answers: {
    route: {
      type: "choice",
      choice: "semantic",
      confidence: 0.92,
      probabilities: { exact: 0.08, semantic: 0.92 },
    },
  },
  usage: { input_tokens: 800, output_tokens: 0 },
};

const fakeFetch = (impl: typeof fetch) =>
  vi.fn(impl) as unknown as typeof fetch;

const jsonResponse = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("Jev decision facade", () => {
  it("falls back without a configured key and does not call fetch", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse(success));
    const facade = createJevDecisionFacadeV1({
      transport: { fetchImpl },
    });

    const result = await facade.decide(invocation);

    expect(result).toMatchObject({
      node: "retrieval-planning",
      status: "fallback",
      fallback: { reasonCode: "configuration-missing" },
      receipt: {
        budget: {
          decisionsUsed: 0,
          decisionsRemaining: 1,
          observedEstimatedInputCostMicrousd: 0,
        },
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(result.receipt)).not.toContain("test-key");
  });

  it("keeps the facade disabled unless it is explicitly enabled", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse(success));
    const facade = createJevDecisionFacadeV1({
      enabled: false,
      transport: { apiKey: "test-key-not-persisted", fetchImpl },
    });

    const result = await facade.decide(invocation);

    expect(result.status).toBe("fallback");
    expect(result.fallback?.reasonCode).toBe("disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("records a bounded call budget and reported usage cost without content", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse(success));
    const facade = createJevDecisionFacadeV1({
      maxDecisions: 1,
      transport: {
        apiKey: "test-key-not-persisted",
        fetchImpl,
      },
    });

    const result = await facade.decide(invocation);
    const exhausted = await facade.decide(invocation);

    expect(result.status).toBe("answered");
    expect(result.receipt).toMatchObject({
      node: "retrieval-planning",
      transport: {
        attempts: 1,
        inputTokens: 800,
        outputTokens: 0,
        estimatedInputCostMicrousd: 34,
      },
      budget: {
        maxDecisions: 1,
        decisionsUsed: 1,
        decisionsRemaining: 0,
        maximumHttpAttempts: 2,
        observedEstimatedInputCostMicrousd: 34,
      },
    });
    expect(exhausted.status).toBe("fallback");
    expect(exhausted.fallback?.reasonCode).toBe("budget-exhausted");
    expect(exhausted.receipt.budget.decisionsUsed).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(body.state).toEqual({
      taskSummary: invocation.request.taskSummary,
      sourceSnippets: [],
    });
    expect(JSON.stringify(result.receipt)).not.toContain(
      invocation.request.taskSummary,
    );
  });

  it("fails closed for sensitive text and denied destinations", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse(success));
    const facade = createJevDecisionFacadeV1({
      transport: {
        apiKey: "test-key-not-persisted",
        fetchImpl,
      },
    });
    const sensitive = await facade.decide({
      ...invocation,
      request: {
        ...invocation.request,
        taskSummary: "Review this API_KEY=secret-value before sending.",
      },
    });
    const denied = await facade.decide({
      ...invocation,
      options: {
        egress: { ...egress, egressDestinations: [] },
      },
    });

    expect(sensitive.status).toBe("fallback");
    expect(sensitive.fallback?.reasonCode).toBe("sensitive-content");
    expect(denied.status).toBe("fallback");
    expect(denied.fallback?.reasonCode).toBe("egress-denied");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(sensitive)).not.toContain("secret-value");
    expect(JSON.stringify(denied)).not.toContain("test-key-not-persisted");
  });

  it("caps an individually configured deadline and preserves abort fallback", async () => {
    const fetchImpl = fakeFetch(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("raw secret error")),
            { once: true },
          );
        }),
    );
    const facade = createJevDecisionFacadeV1({
      maxDeadlineMs: 15,
      transport: {
        apiKey: "test-key-not-persisted",
        deadlineMs: 5_000,
        fetchImpl,
      },
    });

    const result = await facade.decide(invocation);

    expect(result.status).toBe("fallback");
    expect(result.fallback?.reasonCode).toBe("deadline-exceeded");
    expect(result.receipt.transport.attempts).toBe(1);
    expect(JSON.stringify(result)).not.toContain("raw secret error");
    expect(JSON.stringify(result)).not.toContain("test-key-not-persisted");
  });
});
