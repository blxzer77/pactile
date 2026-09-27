import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PROVIDER_RESOLUTION_REASON_CODES_V1,
  resolveProviderV1,
  type ProviderResolutionInputV1,
  type ProviderResolutionResultV1,
} from "../../../src/core/pactile/middleware/resolver.js";
import {
  defaultCapabilityRouter,
  defaultMiddlewareProviders,
  probeShippedProviderReadiness,
} from "../../../src/core/task/adapter-middleware.js";

const here = path.dirname(fileURLToPath(import.meta.url));

interface GoldenCase {
  name: string;
  fallbackAllowed?: boolean;
  requestedPolicyOverrides?: Record<string, unknown>;
  runtimeOverrides?: Record<string, Record<string, unknown>>;
  expectedStatus: ProviderResolutionResultV1["status"];
  expectedProviderId: string | null;
  expectedReasonCode: string;
}

interface GoldenCorpus {
  base: ProviderResolutionInputV1;
  cases: GoldenCase[];
}

const corpus = JSON.parse(
  fs.readFileSync(path.join(here, "fixtures", "resolver-golden.json"), "utf8"),
) as GoldenCorpus;

function materialize(testCase: GoldenCase): ProviderResolutionInputV1 {
  const input = structuredClone(corpus.base);
  if (testCase.fallbackAllowed !== undefined) {
    input.fallbackAllowed = testCase.fallbackAllowed;
  }
  if (testCase.requestedPolicyOverrides) {
    input.requestedPolicy = {
      ...input.requestedPolicy,
      ...testCase.requestedPolicyOverrides,
    } as ProviderResolutionInputV1["requestedPolicy"];
  }
  if (testCase.runtimeOverrides) {
    input.runtimeFacts = input.runtimeFacts.map((fact) => ({
      ...fact,
      ...(testCase.runtimeOverrides?.[fact.providerId] ?? {}),
    })) as ProviderResolutionInputV1["runtimeFacts"];
  }
  return input;
}


describe("Provider resolver Node golden contracts", () => {
  it("keeps public JSON ABI, reason codes, ordering, and fingerprints stable", () => {
    const inputs = corpus.cases.map(materialize);
    const typescript = inputs.map(resolveProviderV1);
    expect(PROVIDER_RESOLUTION_REASON_CODES_V1).toContain("provider-input-invalid");
    corpus.cases.forEach((testCase, index) => {
      expect(typescript[index]).toMatchObject({
        status: testCase.expectedStatus,
        resolution: { providerId: testCase.expectedProviderId },
        explain: { reasonCode: testCase.expectedReasonCode },
      });
    });

    const permuted = inputs.map((input) => ({
      ...input,
      authorizedProviderIds: [...input.authorizedProviderIds].reverse(),
      manifests: [...input.manifests].reverse(),
      bindings: [...input.bindings].reverse(),
      runtimeFacts: [...input.runtimeFacts].reverse(),
    }));
    expect(permuted.map(resolveProviderV1)).toEqual(typescript);
  });

  it("shares strict RFC3339 calendar, offset, and fractional-second semantics", () => {
    const timestampCases = [
      {
        name: "leap-day",
        probedAt: "2024-02-29T10:00:00Z",
        now: "2024-02-29T10:01:00Z",
        expectedStatus: "supported",
      },
      {
        name: "divisible-by-400-leap-day",
        probedAt: "2000-02-29T10:00:00Z",
        now: "2000-02-29T10:01:00Z",
        expectedStatus: "supported",
      },
      {
        name: "century-non-leap-day",
        probedAt: "2100-02-29T10:00:00Z",
        now: "2100-03-01T10:01:00Z",
        expectedStatus: "invalid",
      },
      {
        name: "non-leap-day",
        probedAt: "2026-02-29T10:00:00Z",
        now: "2026-03-01T10:01:00Z",
        expectedStatus: "invalid",
      },
      {
        name: "february-rollover",
        probedAt: "2026-02-30T10:00:00Z",
        now: "2026-03-02T10:01:00Z",
        expectedStatus: "invalid",
      },
      {
        name: "april-rollover",
        probedAt: "2026-04-31T10:00:00Z",
        now: "2026-05-01T10:01:00Z",
        expectedStatus: "invalid",
      },
      {
        name: "hour-24",
        probedAt: "2026-09-09T24:00:00Z",
        now: "2026-09-10T00:01:00Z",
        expectedStatus: "invalid",
      },
      {
        name: "positive-offset",
        probedAt: "2026-09-09T12:00:00+02:30",
        now: "2026-09-09T12:01:00+02:30",
        expectedStatus: "supported",
      },
      {
        name: "maximum-offset",
        probedAt: "2026-09-09T12:00:00-23:59",
        now: "2026-09-09T12:01:00-23:59",
        expectedStatus: "supported",
      },
      {
        name: "offset-hour-overflow",
        probedAt: "2026-09-09T12:00:00+24:00",
        now: "2026-09-09T12:01:00+24:00",
        expectedStatus: "invalid",
      },
      {
        name: "offset-minute-overflow",
        probedAt: "2026-09-09T12:00:00+00:60",
        now: "2026-09-09T12:01:00+00:60",
        expectedStatus: "invalid",
      },
      {
        name: "one-fractional-digit",
        probedAt: "2026-09-09T10:00:00.1Z",
        now: "2026-09-09T10:01:00.1Z",
        expectedStatus: "supported",
      },
      {
        name: "nine-fractional-digits",
        probedAt: "2026-09-09T10:00:00.123456789Z",
        now: "2026-09-09T10:01:00.123456789Z",
        expectedStatus: "supported",
      },
      {
        name: "fractional-precision-overflow",
        probedAt: "2026-09-09T10:00:00.1234567890Z",
        now: "2026-09-09T10:01:00.1234567890Z",
        expectedStatus: "invalid",
      },
      {
        name: "empty-fraction",
        probedAt: "2026-09-09T10:00:00.Z",
        now: "2026-09-09T10:01:00.Z",
        expectedStatus: "invalid",
      },
      {
        name: "second-59",
        probedAt: "2026-09-09T10:00:59Z",
        now: "2026-09-09T10:01:59Z",
        expectedStatus: "supported",
      },
      {
        name: "leap-second-not-supported",
        probedAt: "2026-09-09T10:00:60Z",
        now: "2026-09-09T10:01:00Z",
        expectedStatus: "invalid",
      },
      {
        name: "invalid-now-calendar-date",
        probedAt: "2026-02-28T10:00:00Z",
        now: "2026-02-30T10:01:00Z",
        expectedStatus: "invalid",
      },
      {
        name: "ascii-digits-only",
        probedAt: "２０２６-０９-０９T１０:００:００Z",
        now: "２０２６-０９-０９T１０:０１:００Z",
        expectedStatus: "invalid",
      },
    ] as const;
    const inputs = timestampCases.map(({ probedAt, now }) => {
      const input = materialize(corpus.cases[0] as GoldenCase);
      input.now = now;
      input.runtimeFacts = input.runtimeFacts.map((fact) =>
        fact.providerId === "provider.alpha" ? { ...fact, probedAt } : fact,
      );
      return input;
    });
    const typescript = inputs.map(resolveProviderV1);

    timestampCases.forEach((testCase, index) => {
      expect(typescript[index]?.status, testCase.name).toBe(
        testCase.expectedStatus,
      );
      if (testCase.expectedStatus === "invalid") {
        expect(typescript[index]).toMatchObject({
          resolution: null,
          fingerprint: null,
          explain: {
            reasonCode: "provider-input-invalid",
            candidates: [],
          },
        });
      }
    });
  });

  it("redacts invalid evidence instead of echoing caller values", () => {
    const canary = `TOKEN=${"do-not-print"}`;
    const input = materialize(corpus.cases[0] as GoldenCase);
    input.runtimeFacts = input.runtimeFacts.map((fact, index) =>
      index === 0 ? { ...fact, evidenceRefs: [canary] } : fact,
    );

    const result = resolveProviderV1(input);
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(result)).not.toMatch(/token|do-not-print/i);

    const policyInput = materialize(corpus.cases[0] as GoldenCase);
    const policyCanary = "api.example.com?token=do-not-print";
    policyInput.requestedPolicy = {
      ...policyInput.requestedPolicy,
      network: "project-authorized",
      privacy: "external",
      egressDestinations: [policyCanary],
    };
    const policyResult = resolveProviderV1(policyInput);
    expect(JSON.stringify(policyResult)).not.toContain(policyCanary);
    expect(JSON.stringify(policyResult)).not.toMatch(/token=|do-not-print/i);

    const unknownEnvironment = {
      ...materialize(corpus.cases[0] as GoldenCase),
      environment: canary,
    } as ProviderResolutionInputV1;
    const unknownResult = resolveProviderV1(unknownEnvironment);
    expect(unknownResult?.status).toBe("invalid");
    expect(JSON.stringify(unknownResult)).not.toContain(canary);
  });

  it("rejects malformed JSON containers and forbidden record keys identically", () => {
    const canary = "TOKEN=malformed-container-canary";
    const ownProto = materialize(
      corpus.cases[0] as GoldenCase,
    ) as unknown as Record<string, unknown>;
    Object.defineProperty(ownProto, "__proto__", {
      configurable: true,
      enumerable: true,
      value: canary,
    });
    const nestedConstructor = materialize(corpus.cases[0] as GoldenCase);
    Object.defineProperty(nestedConstructor.requestedPolicy, "constructor", {
      configurable: true,
      enumerable: true,
      value: canary,
    });
    const base = materialize(corpus.cases[0] as GoldenCase);
    const inputs: readonly unknown[] = [
      [],
      { ...base, requestedPolicy: [] },
      { ...base, manifests: {} },
      { ...base, bindings: {} },
      { ...base, runtimeFacts: {} },
      ownProto,
      nestedConstructor,
    ];
    const typescript = inputs.map(resolveProviderV1);
    for (const result of typescript) {
      expect(result).toEqual({
        schemaVersion: 1,
        status: "invalid",
        resolution: null,
        fingerprint: null,
        explain: {
          schemaVersion: 1,
          decision: "invalid",
          reasonCode: "provider-input-invalid",
          selectedProviderId: null,
          fallbackFromProviderId: null,
          effectivePolicy: null,
          evidenceRefs: [],
          candidates: [],
        },
      });
      expect(JSON.stringify(result)).not.toMatch(
        /malformed-container-canary|TOKEN=/i,
      );
    }
  });

  it("keeps the host-neutral facade JSON-compatible", () => {
    expect({
      providers: defaultMiddlewareProviders(),
      router: defaultCapabilityRouter(),
      fact: probeShippedProviderReadiness("provider.alpha", {
        present: true,
        capability: "search.semantic",
        evidence: "evidence://probe/provider.alpha/1",
      }),
    });
  });

  it("matches on missing/install-hint, composed, and invalid binding boundaries", () => {
    const missing = materialize(corpus.cases[0] as GoldenCase);
    missing.fallbackAllowed = false;
    missing.bindings = missing.bindings.map((binding) =>
      binding.providerId === "provider.alpha"
        ? {
            ...binding,
            asset: {
              ...binding.asset,
              readiness: "missing",
              installHint: {
                schemaVersion: 1,
                mechanism: "manual",
                label: "install.provider",
                reference: "docs://provider/install",
                requiresAuthentication: false,
              },
            },
          }
        : binding,
    );

    const composed = materialize(corpus.cases[0] as GoldenCase);
    composed.bindings = composed.bindings.map((binding) =>
      binding.providerId === "provider.alpha"
        ? {
            ...binding,
            mode: "composed",
            control: "pactile-owned",
            deleteBoundary: "remove-when-unclaimed",
            asset: {
              ...binding.asset,
              source: "pactile-bundled",
              owner: { kind: "pactile", id: "pactile" },
              locator: "pactile-bundled://provider.alpha",
            },
          }
        : binding,
    );

    const invalid = materialize(corpus.cases[0] as GoldenCase);
    invalid.bindings = invalid.bindings.map((binding) =>
      binding.providerId === "provider.alpha"
        ? {
            ...binding,
            asset: {
              ...binding.asset,
              locator: "user-installed://token/private",
            },
          }
        : binding,
    );

    const inputs = [missing, composed, invalid];
    const typescript = inputs.map(resolveProviderV1);
    expect(typescript[0]?.explain.candidates[0]?.reasonCodes).toEqual([
      "provider-binding-unavailable",
    ]);
    expect(typescript[1]?.status).toBe("supported");
    expect(typescript[2]?.status).toBe("invalid");
    expect(JSON.stringify(typescript[2])).not.toMatch(/token|private/i);
  });
});
