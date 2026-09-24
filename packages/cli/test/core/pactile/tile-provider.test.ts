import { describe, expect, it } from "vitest";

import {
  ASSURANCE_LEVELS_V1,
  PACTILE_INTENTS_V1,
  assuranceSatisfiesV1,
  parseProviderManifestV1,
  parseResolvedProviderV1,
  parseTileManifestV1,
} from "../../../src/core/pactile/index.js";

import {
  LOCAL_POLICY,
  validProviderManifest,
  validResolvedProvider,
  validTile,
} from "./samples.js";

describe("TileManifestV1", () => {
  it("parses a thin host-neutral Tile manifest", () => {
    const parsed = parseTileManifestV1(validTile());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.trigger.intents).toEqual(["exact", "semantic"]);
      expect(parsed.data).not.toHaveProperty("steps");
      expect(parsed.data).not.toHaveProperty("planner");
      expect(parsed.data).not.toHaveProperty("cursorPath");
      expect(parseTileManifestV1(parsed.data)).toEqual(parsed);
    }
  });

  it("rejects central-planner, step DSL, and host-path extension fields", () => {
    const invalid = {
      ...validTile(),
      steps: [{ run: "search" }],
      planner: "central",
      cursorPath: ".cursor/rules/tile.mdc",
    };
    const parsed = parseTileManifestV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "unknown-field", path: "$.steps" }),
          expect.objectContaining({ code: "unknown-field", path: "$.planner" }),
          expect.objectContaining({ code: "unknown-field", path: "$.cursorPath" }),
        ]),
      );
    }
  });

  it("rejects duplicate/self-conflicting composition edges", () => {
    const invalid = validTile();
    invalid.dependencies = [
      "context.progressive",
      "context.progressive",
      "retrieval.compose",
    ];
    invalid.conflicts = ["context.progressive"];
    const parsed = parseTileManifestV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(["duplicate", "conflict"]),
      );
    }
  });

  it("rejects fallback below assurance or above policy ceilings", () => {
    const invalid = validTile();
    invalid.fallback = {
      allowed: true,
      minimumAssurance: "best-effort",
      policy: {
        permissions: {
          filesystem: "write",
          process: "execute",
          credentials: "project-authorized",
        },
        egress: {
          network: "project-authorized",
          privacy: "external",
          telemetry: "project-authorized",
          destinations: ["external-search"],
        },
        cost: { ceiling: "high" },
      },
    };
    const parsed = parseTileManifestV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues.filter((issue) => issue.code === "policy-violation"))
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({ message: expect.stringMatching(/ceiling/) }),
            expect.objectContaining({ message: expect.stringMatching(/minimum assurance/) }),
          ]),
        );
    }
  });

  it("treats the authorized egress destination set as a fallback ceiling", () => {
    const invalid = validTile();
    invalid.egress = {
      network: "project-authorized",
      privacy: "external",
      telemetry: "local-only",
      destinations: ["approved.example"],
    };
    invalid.cost = { ceiling: "low" };
    invalid.fallback = {
      allowed: true,
      minimumAssurance: "evidence-backed",
      policy: {
        permissions: invalid.permissions,
        egress: {
          ...invalid.egress,
          destinations: ["unapproved.example"],
        },
        cost: invalid.cost,
      },
    };
    const parsed = parseTileManifestV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toContainEqual(
        expect.objectContaining({
          path: "$.fallback.policy",
          code: "policy-violation",
        }),
      );
    }
  });
});

describe("Provider and Assurance v1", () => {
  it("freezes four intents and an ordered assurance scale", () => {
    expect(PACTILE_INTENTS_V1).toEqual([
      "exact",
      "semantic",
      "structural",
      "external",
    ]);
    expect(ASSURANCE_LEVELS_V1).toEqual([
      "best-effort",
      "evidence-backed",
      "verified",
    ]);
    expect(assuranceSatisfiesV1("verified", "evidence-backed")).toBe(true);
    expect(assuranceSatisfiesV1("best-effort", "evidence-backed")).toBe(false);
  });

  it("parses Provider manifests without tool-name ABI fields", () => {
    const parsed = parseProviderManifestV1(validProviderManifest());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.origin).toBe("provider");
      expect(parsed.data).not.toHaveProperty("toolName");
      expect(parsed.data).not.toHaveProperty("mcpServerName");
    }
  });

  it("rejects unknown origin and a verified claim without probe support", () => {
    const invalid = {
      ...validProviderManifest(),
      origin: "mcp",
      probe: { supported: false, maxAgeSeconds: null },
    };
    const parsed = parseProviderManifestV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "$.origin", code: "invalid-enum" }),
          expect.objectContaining({ path: "$.probe", code: "policy-violation" }),
        ]),
      );
    }
  });

  it("keeps origin orthogonal to assurance", () => {
    const nativeBestEffort = {
      ...validResolvedProvider(),
      origin: "native",
      providerId: "host.search",
      minimumAssurance: "best-effort",
      assurance: "best-effort",
      evidenceRefs: [],
      freshness: "unknown",
      probedAt: null,
      probeResult: "not-run",
    };
    expect(parseResolvedProviderV1(nativeBestEffort).success).toBe(true);

    const dishonestNative = {
      ...nativeBestEffort,
      minimumAssurance: "verified",
      assurance: "verified",
    };
    const parsed = parseResolvedProviderV1(dishonestNative);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: expect.stringMatching(/evidence/) }),
          expect.objectContaining({ message: expect.stringMatching(/passed/) }),
        ]),
      );
    }
  });

  it("requires both minimum assurance and policy compliance for resolution", () => {
    const invalid = validResolvedProvider();
    invalid.minimumAssurance = "verified";
    invalid.assurance = "evidence-backed";
    invalid.effectivePolicy = {
      ...LOCAL_POLICY,
      network: "project-authorized",
      privacy: "external",
      cost: "high",
    };
    const parsed = parseResolvedProviderV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "$.assurance", code: "policy-violation" }),
          expect.objectContaining({ path: "$.effectivePolicy", code: "policy-violation" }),
        ]),
      );
    }
  });

  it("represents unsupported honestly without a fake Provider or assurance", () => {
    const unsupported = {
      ...validResolvedProvider(),
      origin: "unsupported",
      providerId: null,
      providerVersion: null,
      assurance: null,
      readiness: "unavailable",
      effectivePolicy: null,
      evidenceRefs: [],
      freshness: "not-applicable",
      probedAt: null,
      probeResult: "not-run",
      fallbackFromProviderId: null,
    };
    expect(parseResolvedProviderV1(unsupported).success).toBe(true);
  });
});
