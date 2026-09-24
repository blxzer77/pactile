import { describe, expect, it } from "vitest";

import {
  DEFAULT_CANONICAL_PATHS_V1,
  canonicalizePactileJsonV1,
  fingerprintPactileContractV1,
  parseCanonicalPathsV1,
  parseInstallStateV1,
} from "../../../src/core/index.js";

import { HASH_A } from "./samples.js";

function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`missing test item at index ${index}`);
  return item;
}

describe("Pactile v1 validation and fingerprint ABI", () => {
  it("canonicalizes object keys recursively and keeps array order", () => {
    expect(canonicalizePactileJsonV1({ b: 2, a: { z: 1, y: [2, 1] } })).toBe(
      '{"a":{"y":[2,1],"z":1},"b":2}',
    );
    expect(fingerprintPactileContractV1({ b: 2, a: 1 })).toBe(
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
    expect(fingerprintPactileContractV1({ a: 1, b: 2 })).toBe(
      fingerprintPactileContractV1({ b: 2, a: 1 }),
    );
  });

  it("rejects non-JSON and cyclic fingerprint inputs", () => {
    expect(() => fingerprintPactileContractV1({ value: undefined })).toThrow(
      /only JSON values/,
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => fingerprintPactileContractV1(cyclic)).toThrow(/circular/);
  });
});

describe("CanonicalPathsV1", () => {
  it("accepts the canonical .pactile single-write layout", () => {
    const parsed = parseCanonicalPathsV1(DEFAULT_CANONICAL_PATHS_V1);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.canonicalRoot).toBe(".pactile");
      expect(parsed.data.writePolicy).toBe("canonical-only");
      expect(parsed.data.legacySources).toEqual([
        { kind: "cstl", root: ".cstl", access: "read-only" },
        { kind: "trellis", root: ".trellis", access: "read-only" },
      ]);
      expect(parsed.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("returns located issues for unknown schema and writable legacy sources", () => {
    const invalid = structuredClone(DEFAULT_CANONICAL_PATHS_V1) as unknown as Record<
      string,
      unknown
    >;
    invalid.schemaVersion = 2;
    const sources = invalid.legacySources as Record<string, unknown>[];
    itemAt(sources, 0).access = "read-write";

    const parsed = parseCanonicalPathsV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "$.schemaVersion" }),
          expect.objectContaining({ path: "$.legacySources[0].access" }),
        ]),
      );
    }
  });

  it("rejects writable targets outside canonical root and duplicate legacy roots", () => {
    const invalid = structuredClone(DEFAULT_CANONICAL_PATHS_V1) as unknown as Record<
      string,
      unknown
    >;
    invalid.tasksPath = ".cstl/tasks";
    invalid.legacySources = [
      { kind: "cstl", root: ".cstl", access: "read-only" },
      { kind: "cstl", root: ".cstl", access: "read-only" },
    ];
    const parsed = parseCanonicalPathsV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues.map((issue) => issue.code)).toContain("policy-violation");
      expect(parsed.issues.map((issue) => issue.code)).toContain("duplicate");
    }
  });

  it("requires exactly both v1 read-only legacy sources", () => {
    for (const legacySources of [
      [],
      [{ kind: "cstl", root: ".cstl", access: "read-only" }],
    ]) {
      const invalid = {
        ...structuredClone(DEFAULT_CANONICAL_PATHS_V1),
        legacySources,
      };
      const parsed = parseCanonicalPathsV1(invalid);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.issues).toContainEqual(
          expect.objectContaining({
            path: "$.legacySources",
            code: "required",
            message: expect.stringMatching(/exactly/),
          }),
        );
      }
    }
  });
});

describe("InstallStateV1", () => {
  const installState = {
    schemaVersion: 1,
    product: "pactile",
    canonicalRoot: ".pactile",
    runtimeVersion: "0.5.0-beta.5",
    contractVersion: 1,
    generationId: "generation.beta5",
    status: "degraded",
    installedAdapters: [
      {
        id: "cursor",
        version: "0.5.0-beta.5",
        status: "active",
        lastProjectionFingerprint: HASH_A,
        reconciledAt: "2026-09-09T10:00:00Z",
      },
      {
        id: "codex",
        version: "0.5.0-beta.5",
        status: "degraded",
        lastProjectionFingerprint: null,
        reconciledAt: null,
      },
    ],
    lastMigrationJournalId: "journal.beta5",
    createdAt: "2026-09-09T09:00:00Z",
    updatedAt: "2026-09-09T10:00:00Z",
  };

  it("round-trips a versioned install generation", () => {
    const parsed = parseInstallStateV1(installState);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const roundTrip = parseInstallStateV1(
        JSON.parse(JSON.stringify(parsed.data)) as unknown,
      );
      expect(roundTrip).toEqual(parsed);
    }
  });

  it("rejects duplicate Adapter ids and backwards timestamps", () => {
    const invalid = structuredClone(installState);
    invalid.installedAdapters.push({ ...itemAt(invalid.installedAdapters, 0) });
    invalid.updatedAt = "2026-09-09T08:00:00Z";
    const parsed = parseInstallStateV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(["duplicate", "conflict"]),
      );
    }
  });
});
