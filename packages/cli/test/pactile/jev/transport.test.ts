import { describe, expect, it, vi } from "vitest";
import {
  createJevTransportV1,
  JEV_ENDPOINT_V1,
  type JevDecisionRequestV1,
  type JevEgressAuthorizationV1,
} from "../../../src/pactile/jev/transport.js";

const egress: JevEgressAuthorizationV1 = {
  network: "project-authorized",
  privacy: "project-approved-egress",
  credentials: "project-authorized",
  destination: "https://api.typesafe.ai",
  egressDestinations: ["https://api.typesafe.ai"],
  contentDecision: "task-summary-and-snippets-approved",
};
const request: JevDecisionRequestV1 = {
  taskSummary:
    "Choose the best retrieval route for the bounded planner question.",
  sourceSnippets: [
    {
      ref: "retrieval.planner",
      text: "The planner selects exact or semantic retrieval from the current request.",
    },
  ],
  questions: {
    route: {
      type: "choice",
      instructions:
        "Which retrieval route best fits the supplied summary and source excerpt?",
      criteria: {
        exact: "Literal identifiers or exact phrase.",
        semantic: "Conceptual or paraphrased intent.",
      },
    },
  },
};
const success = {
  model: "jev-1.13.0",
  answers: {
    route: {
      type: "choice",
      choice: "semantic",
      confidence: 0.91,
      probabilities: { exact: 0.09, semantic: 0.91 },
    },
  },
  usage: { input_tokens: 800, output_tokens: 0 },
};
const response = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const fakeFetch = (impl: typeof fetch) =>
  vi.fn(impl) as unknown as typeof fetch;

describe("optional Jev transport input and egress boundary", () => {
  it("sends only to the fixed endpoint after policy approval, then returns bounded usage and cost", async () => {
    const fetchImpl = fakeFetch(async (_input, init) => {
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer test-key-do-not-persist",
      );
      return response(success, 200, { "x-typesafe-request-id": "req_safe_01" });
    });
    const call = createJevTransportV1({
      apiKey: "test-key-do-not-persist",
      fetchImpl,
    });
    const result = await call(request, { egress });

    expect(result.status).toBe("answered");
    expect(result.answers?.route?.type).toBe("choice");
    expect(result.receipt).toMatchObject({
      provider: "typesafe-jev",
      outcome: "answered",
      attempts: 1,
      httpStatus: 200,
      requestId: "req_safe_01",
      inputTokens: 800,
      outputTokens: 0,
      estimatedInputCostMicrousd: 34,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(JEV_ENDPOINT_V1);
    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(body.state).toEqual({
      taskSummary: request.taskSummary,
      sourceSnippets: request.sourceSnippets,
    });
    expect(JSON.stringify(result.receipt)).not.toContain(
      "test-key-do-not-persist",
    );
    expect(JSON.stringify(result.receipt)).not.toContain(request.taskSummary);
  });

  it("never calls fetch without a key or explicit destination authorization", async () => {
    const fetchImpl = fakeFetch(async () => response(success));
    const noKey = await createJevTransportV1({ fetchImpl })(request, {
      egress,
    });
    const noPolicy = await createJevTransportV1({
      apiKey: "test-key",
      fetchImpl,
    })(request);
    const denied = await createJevTransportV1({
      apiKey: "test-key",
      fetchImpl,
    })(request, {
      egress: { ...egress, network: "forbidden" as "project-authorized" },
    });
    const wrongDestination = await createJevTransportV1({
      apiKey: "test-key",
      fetchImpl,
    })(request, {
      egress: { ...egress, egressDestinations: ["https://other.example"] },
    });

    expect(noKey.fallback?.reasonCode).toBe("configuration-missing");
    expect(noPolicy.fallback?.reasonCode).toBe("egress-denied");
    expect(denied.fallback?.reasonCode).toBe("egress-denied");
    expect(wrongDestination.fallback?.reasonCode).toBe("egress-denied");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("denies source snippets until their data category is approved", async () => {
    const fetchImpl = fakeFetch(async () => response(success));
    const result = await createJevTransportV1({
      apiKey: "test-key",
      fetchImpl,
    })(request, {
      egress: { ...egress, contentDecision: "task-summary-approved" },
    });
    expect(result.fallback?.reasonCode).toBe("content-not-approved");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["credential assignment", "TYPESAFE_API_KEY=sk-test-12345678901234567890"],
    ["package registry token", "NPM_TOKEN=p34syntheticvalue"],
    ["private token", "PRIVATE_TOKEN=p34syntheticvalue"],
    ["session cookie", "SESSION_COOKIE=p34syntheticvalue"],
    ["cookie", "COOKIE=p34syntheticvalue"],
    ["registry auth token", "REGISTRY_AUTH_TOKEN=p34syntheticvalue"],
    ["cookie JSON key-value field", '{"cookie":"p34syntheticvalue"}'],
    ["cookie header", "Set-Cookie: sessionid=p34syntheticvalue"],
    ["authorization header", "Authorization: Bearer p34syntheticvalue"],
    [
      "database URL with credentials",
      "DATABASE_URL=postgres://user:pass@host/db",
    ],
    [
      "database URL with query password",
      "DATABASE_URL=postgres://host/db?password=p34syntheticvalue",
    ],
    ["URI user info", "postgres://user:pass@host/db"],
    ["sk_live credential", "sk_live_0123456789abcdef0123456789"],
    ["secret assignment", "SECRET=top-secret-value"],
    ["email address", "contact me at engineer@example.test"],
    [
      "Chinese explicit egress marker",
      "内部机密，不得对外发送：未发布的评审结论",
    ],
    ["standalone sensitive marker", "This snippet is marked SENSITIVE."],
    ["standalone secret marker", "This snippet contains SECRET material."],
    ["standalone Chinese confidential marker", "此内容标记为机密。"],
    ["standalone Chinese sensitive marker", "此内容被标记为敏感。"],
    ["sensitive marker", "CONFIDENTIAL implementation detail"],
    ["sensitive content marker", "This snippet is marked SENSITIVE CONTENT."],
    ["private key marker", "-----BEGIN PRIVATE KEY-----"],
  ])("blocks %s before network egress", async (_label, text) => {
    const fetchImpl = fakeFetch(async () => response(success));
    const unsafe: JevDecisionRequestV1 = {
      ...request,
      sourceSnippets: [{ ref: "snippet.safe", text }],
    };
    const result = await createJevTransportV1({
      apiKey: "test-key",
      fetchImpl,
    })(unsafe, { egress });
    expect(result.fallback?.reasonCode).toBe("sensitive-content");
    expect(result.fallback?.explanation).toContain(
      "structured key/value field",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(result.receipt)).not.toContain(text);
  });

  it("allows ordinary TypeScript private methods through the text boundary", async () => {
    const fetchImpl = fakeFetch(async () => response(success));
    const ordinarySource =
      "private calculateRoute(input: string): boolean { return input.length > 0; }";
    const result = await createJevTransportV1({
      apiKey: "test-key",
      fetchImpl,
    })(
      {
        ...request,
        taskSummary:
          "Task: trace cookie behavior; session handling and authorization remain local.",
        sourceSnippets: [{ ref: "retrieval.planner", text: ordinarySource }],
      },
      { egress },
    );

    expect(result.status).toBe("answered");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects filesystem paths and oversized input before network egress", async () => {
    const fetchImpl = fakeFetch(async () => response(success));
    const pathInput = {
      ...request,
      sourceSnippets: [
        { ref: "src/private.ts", text: "ordinary source excerpt" },
      ],
    };
    const tooLarge = { ...request, taskSummary: "x".repeat(2_001) };
    const pathResult = await createJevTransportV1({
      apiKey: "test-key",
      fetchImpl,
    })(pathInput, { egress });
    const sizeResult = await createJevTransportV1({
      apiKey: "test-key",
      fetchImpl,
    })(tooLarge, { egress });
    expect(pathResult.fallback?.reasonCode).toBe("input-invalid");
    expect(sizeResult.fallback?.reasonCode).toBe("input-too-large");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [401, "authentication"],
    [403, "authentication"],
    [422, "invalid-request"],
    [429, "rate-limited"],
    [503, "service-unavailable"],
  ] as const)(
    "classifies HTTP %i without including server error details",
    async (status, reasonCode) => {
      const apiKey = "test-key-do-not-leak";
      const serverSecret = "SERVER_SECRET=top-secret-value";
      const fetchImpl = fakeFetch(async () =>
        response({ detail: serverSecret, authorization: apiKey }, status),
      );
      const result = await createJevTransportV1({
        apiKey,
        fetchImpl,
        maxRetries: 0,
      })(request, { egress });
      expect(result.fallback?.reasonCode).toBe(reasonCode);
      expect(JSON.stringify(result.receipt)).not.toContain(apiKey);
      expect(JSON.stringify(result.receipt)).not.toContain(serverSecret);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("retries a 429 once at most and records attempts", async () => {
    const fetchImpl = fakeFetch(async () => {
      if (fetchImpl.mock.calls.length === 1)
        return response({ detail: "ignored" }, 429, { "retry-after-ms": "0" });
      return response(success);
    });
    const result = await createJevTransportV1({
      apiKey: "test-key",
      fetchImpl,
      maxRetries: 1,
    })(request, { egress });
    expect(result.status).toBe("answered");
    expect(result.receipt.attempts).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not expose low-confidence answers to the caller", async () => {
    const low = {
      ...success,
      answers: {
        route: {
          type: "choice",
          choice: "semantic",
          confidence: 0.4,
          probabilities: { exact: 0.4, semantic: 0.6 },
        },
      },
    };
    const fetchImpl = fakeFetch(async () => response(low));
    const result = await createJevTransportV1({
      apiKey: "test-key",
      fetchImpl,
    })(request, { egress });
    expect(result.status).toBe("fallback");
    expect(result.answers).toBeNull();
    expect(result.fallback?.reasonCode).toBe("low-confidence");
    expect(result.receipt.inputTokens).toBe(800);
    expect(result.receipt.estimatedInputCostMicrousd).toBe(34);
  });

  it("rejects responses above the body-size limit", async () => {
    const fetchImpl = fakeFetch(
      async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(24 * 1024 + 1),
          },
        }),
    );
    const result = await createJevTransportV1({
      apiKey: "test-key",
      fetchImpl,
    })(request, { egress });
    expect(result.fallback?.reasonCode).toBe("response-too-large");
  });
  it("uses a binary-confidence projection for Noul and falls back on an undecided result", async () => {
    const noulRequest = {
      taskSummary:
        "Determine whether a semantic route fits this bounded request.",
      questions: {
        semantic: {
          type: "noul",
          instructions: "Does semantic retrieval fit this request?",
        },
      },
    };
    let callCount = 0;
    const fetchImpl = fakeFetch(async () => {
      callCount += 1;
      const noul = callCount === 1 ? 0.1 : 0.5;
      return response({
        model: "jev-1.13.0",
        answers: { semantic: { type: "noul", noul } },
        usage: { input_tokens: 40, output_tokens: 0 },
      });
    });
    const call = createJevTransportV1({ apiKey: "test-key", fetchImpl });
    const confidentNo = await call(noulRequest, {
      egress: { ...egress, contentDecision: "task-summary-approved" },
    });
    const undecided = await call(noulRequest, {
      egress: { ...egress, contentDecision: "task-summary-approved" },
    });
    expect(confidentNo.status).toBe("answered");
    expect(undecided.fallback?.reasonCode).toBe("low-confidence");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("projects a Score answer but does not assign assurance authority", async () => {
    const scoreRequest = {
      taskSummary: "Rank the supplied bounded route fit.",
      questions: {
        fit: {
          type: "score",
          instructions: "How strong is the fit?",
          criteria: ["weak", "moderate", "strong"],
        },
      },
    };
    const fetchImpl = fakeFetch(async () =>
      response({
        model: "jev-1.13.0",
        answers: {
          fit: {
            type: "score",
            score: 1.6,
            confidence: 0.88,
            legend: { 0: "weak", 1: "moderate", 2: "strong" },
            probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 },
          },
        },
        usage: { input_tokens: 90, output_tokens: 0 },
      }),
    );
    const result = await createJevTransportV1({
      apiKey: "test-key",
      fetchImpl,
    })(scoreRequest, {
      egress: { ...egress, contentDecision: "task-summary-approved" },
    });
    expect(result.status).toBe("answered");
    expect(result.answers?.fit).toMatchObject({
      type: "score",
      score: 1.6,
      confidence: 0.88,
      legend: { 0: "weak", 1: "moderate", 2: "strong" },
    });
    expect(result).not.toHaveProperty("assurance");
  });

  it("rejects a Score answer inconsistent with its probability-weighted value", async () => {
    const scoreRequest = {
      taskSummary: "Rank the supplied bounded route fit.",
      questions: {
        fit: {
          type: "score" as const,
          instructions: "How strong is the fit?",
          criteria: ["weak", "moderate", "strong"],
        },
      },
    };
    const fetchImpl = fakeFetch(async () =>
      response({
        model: "jev-1.13.0",
        answers: {
          fit: {
            type: "score",
            score: 2,
            confidence: 0.9,
            probabilities: { 0: 0.9, 1: 0.05, 2: 0.05 },
            legend: { 0: "weak", 1: "moderate", 2: "strong" },
          },
        },
        usage: { input_tokens: 90, output_tokens: 0 },
      }),
    );
    const result = await createJevTransportV1({
      apiKey: "test-key",
      fetchImpl,
    })(scoreRequest, {
      egress: { ...egress, contentDecision: "task-summary-approved" },
    });

    expect(result.status).toBe("fallback");
    expect(result.answers).toBeNull();
    expect(result.fallback?.reasonCode).toBe("invalid-response");
  });

  it.each([
    [
      "choice does not match its highest probability",
      {
        ...success,
        answers: {
          route: {
            type: "choice",
            choice: "semantic",
            confidence: 0.9,
            probabilities: { exact: 0.9, semantic: 0.1 },
          },
        },
      },
    ],
    [
      "probabilities do not sum to one",
      {
        ...success,
        answers: {
          route: {
            type: "choice",
            choice: "semantic",
            confidence: 0.9,
            probabilities: { exact: 0.1, semantic: 0.7 },
          },
        },
      },
    ],
    [
      "probabilities sum to zero",
      {
        ...success,
        answers: {
          route: {
            type: "choice",
            choice: "semantic",
            confidence: 0.9,
            probabilities: { exact: 0, semantic: 0 },
          },
        },
      },
    ],
  ])("rejects responses when %s", async (_label, body) => {
    const fetchImpl = fakeFetch(async () => response(body));
    const result = await createJevTransportV1({
      apiKey: "test-key",
      fetchImpl,
    })(request, { egress });

    expect(result.status).toBe("fallback");
    expect(result.answers).toBeNull();
    expect(result.fallback?.reasonCode).toBe("invalid-response");
  });

  it.each([
    ["omits the legend", undefined],
    [
      "does not match the request criteria",
      { 0: "weak", 1: "wrong", 2: "strong" },
    ],
  ])("rejects a Score answer when its legend %s", async (_label, legend) => {
    const scoreRequest = {
      taskSummary: "Rank the supplied bounded route fit.",
      questions: {
        fit: {
          type: "score" as const,
          instructions: "How strong is the fit?",
          criteria: ["weak", "moderate", "strong"],
        },
      },
    };
    const scoreAnswer: Record<string, unknown> = {
      type: "score",
      score: 2,
      confidence: 0.9,
      probabilities: { 0: 0.05, 1: 0.05, 2: 0.9 },
    };
    if (legend !== undefined) scoreAnswer.legend = legend;
    const fetchImpl = fakeFetch(async () =>
      response({
        model: "jev-1.13.0",
        answers: { fit: scoreAnswer },
        usage: { input_tokens: 90, output_tokens: 0 },
      }),
    );
    const result = await createJevTransportV1({
      apiKey: "test-key",
      fetchImpl,
    })(scoreRequest, {
      egress: { ...egress, contentDecision: "task-summary-approved" },
    });

    expect(result.status).toBe("fallback");
    expect(result.fallback?.reasonCode).toBe("invalid-response");
  });
  it("rejects malformed response contracts", async () => {
    const malformed = {
      ...success,
      answers: {
        route: {
          type: "choice",
          choice: "unknown",
          confidence: 0.9,
          probabilities: { exact: 0.1, semantic: 0.9 },
        },
      },
    };
    const fetchImpl = fakeFetch(async () => response(malformed));
    const result = await createJevTransportV1({
      apiKey: "test-key",
      fetchImpl,
    })(request, { egress });
    expect(result.fallback?.reasonCode).toBe("invalid-response");
  });

  it("enforces a total deadline and classifies caller cancellation without leaking errors", async () => {
    const fetchImpl = fakeFetch(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("Bearer test-key raw failure")),
            { once: true },
          );
        }),
    );
    const timed = await createJevTransportV1({
      apiKey: "test-key",
      fetchImpl,
      deadlineMs: 15,
    })(request, { egress });
    expect(timed.fallback?.reasonCode).toBe("deadline-exceeded");
    expect(timed.receipt.attempts).toBe(1);
    expect(JSON.stringify(timed)).not.toContain("test-key");

    const controller = new AbortController();
    const pending = createJevTransportV1({
      apiKey: "test-key",
      fetchImpl,
      deadlineMs: 1_000,
    })(request, { egress, signal: controller.signal });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    controller.abort();
    const cancelled = await pending;
    expect(cancelled.fallback?.reasonCode).toBe("cancelled");
  });

  it("does not retain raw exception text or read API error bodies", async () => {
    const rawError = "API_KEY=test-key SERVER_SECRET=raw-body";
    const fetchImpl = fakeFetch(async () => {
      throw new Error(rawError);
    });
    const result = await createJevTransportV1({
      apiKey: "test-key",
      fetchImpl,
    })(request, { egress });
    expect(result.fallback?.reasonCode).toBe("transport-error");
    expect(JSON.stringify(result)).not.toContain(rawError);
    expect(JSON.stringify(result)).not.toContain("test-key");
  });

  it("drops a request-id header that reflects the configured API key", async () => {
    const apiKey = "test-key-do-not-persist";
    const fetchImpl = fakeFetch(async () =>
      response({ detail: "ignored" }, 401, { "x-typesafe-request-id": apiKey }),
    );
    const result = await createJevTransportV1({
      apiKey,
      fetchImpl,
      maxRetries: 0,
    })(request, { egress });
    expect(result.fallback?.reasonCode).toBe("authentication");
    expect(result.receipt.requestId).toBeNull();
    expect(JSON.stringify(result.receipt)).not.toContain(apiKey);
  });
  it("rejects invalid retry/deadline settings before network egress", async () => {
    const fetchImpl = fakeFetch(async () => response(success));
    const result = await createJevTransportV1({
      apiKey: "test-key",
      fetchImpl,
      maxRetries: 2,
    })(request, { egress });
    expect(result.fallback?.reasonCode).toBe("configuration-invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
