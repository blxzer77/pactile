import { describe, expect, it, vi } from "vitest";
import {
  createJevDecisionFacadeV1,
  type JevEgressAuthorizationV1,
} from "../../../src/pactile/jev/index.js";
import { planRetrievalWithJevV1 } from "../../../src/pactile/retrieval/index.js";

const egress: JevEgressAuthorizationV1 = {
  network: "project-authorized",
  privacy: "project-approved-egress",
  credentials: "project-authorized",
  destination: "https://api.typesafe.ai",
  egressDestinations: ["https://api.typesafe.ai"],
  contentDecision: "task-summary-approved",
};

const jevPolicy = {
  filesystem: "read",
  process: "none",
  network: "project-authorized",
  credentials: "project-authorized",
  privacy: "project-approved-egress",
  egressDestinations: ["https://api.typesafe.ai"],
  telemetry: "local-only",
  cost: "low",
} as const;

const answer = (choice: "include" | "exclude", confidence = 0.91) => ({
  type: "choice",
  choice,
  confidence,
  probabilities:
    choice === "include"
      ? { include: confidence, exclude: 1 - confidence }
      : { include: 1 - confidence, exclude: confidence },
});

const providerResponse = (answers: Record<string, unknown>): Response =>
  new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers,
      usage: { input_tokens: 500, output_tokens: 0 },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );

const fakeFetch = (impl: typeof fetch) =>
  vi.fn(impl) as unknown as typeof fetch;

describe("optional Jev retrieval planning", () => {
  it("keeps the ordinary deterministic API result when Jev is not configured", async () => {
    const fetchImpl = fakeFetch(async () => providerResponse({}));
    const facade = createJevDecisionFacadeV1({
      transport: { fetchImpl },
    });
    const query = "Describe what happens to a request across the harness.";

    const result = await planRetrievalWithJevV1({
      request: { query, requestedPolicy: jevPolicy },
      jev: { facade, callOptions: { egress } },
    });

    expect(result.plan.intents).toEqual(["exact"]);
    expect(result.source).toBe("deterministic");
    expect(result.decision?.fallback?.reasonCode).toBe("configuration-missing");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("adds only confident semantic or structural routes after deterministic exact planning", async () => {
    const fetchImpl = fakeFetch(async () =>
      providerResponse({
        semantic: answer("include"),
        structural: answer("exclude"),
      }),
    );
    const facade = createJevDecisionFacadeV1({
      transport: {
        apiKey: "test-key-not-persisted",
        fetchImpl,
      },
    });
    const query = "Describe what happens to a request across the harness.";

    const result = await planRetrievalWithJevV1({
      request: { query, requestedPolicy: jevPolicy },
      jev: { facade, callOptions: { egress } },
    });

    expect(result.plan.intents).toEqual(["exact", "semantic"]);
    expect(result.source).toBe("jev-advised");
    expect(result.decision?.status).toBe("answered");
    expect(result.plan.intents).not.toContain("external");
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      state: { taskSummary: string; sourceSnippets: unknown[] };
      questions: Record<string, unknown>;
    };
    expect(body.state).toEqual({ taskSummary: query, sourceSnippets: [] });
    expect(Object.keys(body.questions).sort()).toEqual([
      "semantic",
      "structural",
    ]);
    expect(JSON.stringify(result.decision?.receipt)).not.toContain(query);
  });

  it("does not invoke Jev for caller-specified intents", async () => {
    const fetchImpl = fakeFetch(async () => providerResponse({}));
    const facade = createJevDecisionFacadeV1({
      transport: {
        apiKey: "test-key-not-persisted",
        fetchImpl,
      },
    });

    const result = await planRetrievalWithJevV1({
      request: {
        query: "Describe what happens to a request across the harness.",
        intents: ["exact"],
      },
      jev: { facade, callOptions: { egress } },
    });

    expect(result.plan.intents).toEqual(["exact"]);
    expect(result.decision).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the deterministic plan when the provider returns an unrequested external route", async () => {
    const fetchImpl = fakeFetch(async () =>
      providerResponse({
        semantic: answer("include"),
        structural: answer("exclude"),
        external: answer("include"),
      }),
    );
    const facade = createJevDecisionFacadeV1({
      transport: {
        apiKey: "test-key-not-persisted",
        fetchImpl,
      },
    });

    const result = await planRetrievalWithJevV1({
      request: {
        query: "Describe what happens to a request across the harness.",
        requestedPolicy: jevPolicy,
      },
      jev: { facade, callOptions: { egress } },
    });

    expect(result.plan.intents).toEqual(["exact"]);
    expect(result.source).toBe("deterministic");
    expect(result.decision?.fallback?.reasonCode).toBe("invalid-response");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps deterministic routing after a sensitive query is rejected before egress", async () => {
    const fetchImpl = fakeFetch(async () => providerResponse({}));
    const facade = createJevDecisionFacadeV1({
      transport: {
        apiKey: "test-key-not-persisted",
        fetchImpl,
      },
    });

    const result = await planRetrievalWithJevV1({
      request: {
        query: "Check this API_KEY=secret-value first.",
        requestedPolicy: jevPolicy,
      },
      jev: { facade, callOptions: { egress } },
    });

    expect(result.plan.intents).toEqual(["exact"]);
    expect(result.decision?.fallback?.reasonCode).toBe("sensitive-content");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(result.decision?.receipt)).not.toContain(
      "secret-value",
    );
  });

  it("lets the retrieval policy deny Jev even when the call option allows egress", async () => {
    const fetchImpl = fakeFetch(async () => providerResponse({}));
    const facade = createJevDecisionFacadeV1({
      transport: {
        apiKey: "test-key-not-persisted",
        fetchImpl,
      },
    });

    const result = await planRetrievalWithJevV1({
      request: {
        query: "Describe what happens to a request across the harness.",
      },
      jev: { facade, callOptions: { egress } },
    });

    expect(result.plan.intents).toEqual(["exact"]);
    expect(result.decision?.fallback?.reasonCode).toBe("egress-denied");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
