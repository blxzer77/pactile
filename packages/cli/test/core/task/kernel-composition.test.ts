import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateComposition, neutralKernelExtrasBoundary, type CompositionValidationInput } from "../../../src/core/task/kernel-contract.js";
import { applyKernelCreate } from "../../../src/core/task/kernel-store.js";
import { emptyTaskRecord } from "../../../src/core/task/schema.js";
import { parseTileManifestV1 } from "../../../src/core/pactile/tile.js";
import { LOCAL_POLICY, validTile, validResolvedProvider, HASH_A } from "../pactile/samples.js";

function selected(id: string, dependencies: string[] = [], conflicts: string[] = []) {
  const sample = validTile();
  const manifest = { ...sample, identity: { id, version: "1.0.0" }, dependencies, conflicts, trigger: { ...sample.trigger, intents: ["semantic"] } };
  const decoded = parseTileManifestV1(manifest);
  if (!decoded.success) throw new Error("invalid test fixture");
  return { manifest: decoded.data, fingerprint: decoded.fingerprint };
}

function request(tiles = [selected("tile-z"), selected("tile-a", ["tile-z"]) ]): CompositionValidationInput {
  return { tiles, policyCeiling: LOCAL_POLICY, providers: tiles.map(({ manifest }) => ({ tileId: manifest.identity.id, authorized: true, resolution: validResolvedProvider() })) };
}

describe("Host-neutral composition validation", () => {
  it("F1 accepts a constructor Tile with omitted or empty attempts and enforces only own attempt entries", () => {
    const input = request([selected("constructor")]);
    expect(validateComposition(input)).toMatchObject({ outcome: "accepted", reasonCodes: [] });
    expect(validateComposition({ ...input, attempts: {} })).toMatchObject({ outcome: "accepted", reasonCodes: [] });
    expect(validateComposition({ ...input, attempts: { constructor: 2 } })).toMatchObject({ outcome: "rejected", reasonCodes: ["attempt-limit"] });
  });
  it("validates supplied dependency order without choosing, sorting, or mutating Tiles", () => {
    const input = request();
    const before = JSON.stringify(input);
    expect(validateComposition(input)).toMatchObject({ outcome: "accepted", reasonCodes: [], selectedTileIds: ["tile-z", "tile-a"] });
    expect(validateComposition(input)).toEqual(validateComposition(input));
    expect(JSON.stringify(input)).toBe(before);
    const reversed = { ...input, tiles: [...input.tiles].reverse() };
    expect(validateComposition(reversed)).toMatchObject({ outcome: "rejected", reasonCodes: ["dependency-order"], selectedTileIds: ["tile-a", "tile-z"] });
  });

  it("reports missing dependencies, conflicts, duplicates, and altered fingerprints", () => {
    expect(validateComposition(request([selected("tile-a", ["missing"])] )).reasonCodes).toEqual(["dependency-missing"]);
    expect(validateComposition(request([selected("tile-a", [], ["tile-b"]), selected("tile-b")])).reasonCodes).toEqual(["tile-conflict"]);
    const input = request([selected("tile-a")]);
    expect(validateComposition({ ...input, tiles: [...input.tiles, ...input.tiles] }).reasonCodes).toContain("duplicate-tile");
    expect(validateComposition({ ...input, tiles: [{ ...input.tiles[0], fingerprint: HASH_A }] }).reasonCodes).toEqual(["fingerprint-mismatch"]);
  });

  it("checks policy, stop budget, authorization, readiness, and minimum assurance", () => {
    const input = request([selected("tile-a")]);
    expect(validateComposition({ ...input, policyCeiling: { ...LOCAL_POLICY, filesystem: "none" } }).reasonCodes).toEqual(["policy-exceeded", "provider-policy"]);
    expect(validateComposition({ ...input, attempts: { "tile-a": 2 } }).reasonCodes).toEqual(["attempt-limit"]);
    expect(validateComposition({ ...input, providers: [] }).reasonCodes).toEqual(["provider-missing"]);
    expect(validateComposition({ ...input, providers: [{ ...input.providers[0], authorized: false }] }).reasonCodes).toEqual(["provider-unauthorized"]);
    expect(validateComposition({ ...input, providers: [{ ...input.providers[0], resolution: { ...validResolvedProvider(), readiness: "degraded" } }] }).reasonCodes).toContain("provider-unavailable");
    expect(validateComposition({ ...input, providers: [{ ...input.providers[0], resolution: { ...validResolvedProvider(), minimumAssurance: "best-effort", assurance: "best-effort" } }] }).reasonCodes).toEqual(["provider-assurance"]);
  });

  it("only accepts required Evidence through logical, fingerprinted observable facts", () => {
    const input = { ...request([selected("tile-a")]), requireEvidence: true, evidenceRefs: ["evidence://fixture/source"] };
    expect(validateComposition(input).reasonCodes).toEqual(["evidence-missing"]);
    expect(validateComposition(input, { lookup: (ref) => ({ ref, exists: true, kind: "source-reference", fingerprint: HASH_A }) }).outcome).toBe("accepted");
    expect(validateComposition(input, { lookup: () => ({ ref: "evidence://wrong", exists: true, kind: "source-reference", fingerprint: HASH_A }) }).reasonCodes).toContain("evidence-invalid");
    expect(validateComposition({ ...input, evidenceRefs: ["evidence://token/value"] }).reasonCodes).toContain("evidence-invalid");
  });

  it("fails closed on malformed external input and binds the receipt to validated facts", () => {
    expect(validateComposition(null as unknown as CompositionValidationInput).reasonCodes).toEqual(["invalid-composition"]);
    expect(validateComposition({ ...request(), providers: [null] } as unknown as CompositionValidationInput).outcome).toBe("rejected");
    const input = request([selected("tile-a")]);
    const changed = { ...input, providers: [{ ...input.providers[0], resolution: { ...validResolvedProvider(), providerId: "different-provider" } }] };
    expect(validateComposition(changed).outcome).toBe("accepted");
    expect(validateComposition(changed).fingerprint).not.toBe(validateComposition(input).fingerprint);
  });

  it("keeps registry knowledge at the legacy projection boundary, not neutral business logic", () => {
    const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../src/core/task");
    for (const name of ["kernel-contract.ts", "kernel-store.ts"]) {
      const text = fs.readFileSync(path.join(sourceDir, name), "utf8");
      expect(text).not.toMatch(/from ["']\.\/ondemand-topology|from ["']\.\/adapter-middleware|stage5-ondemand-topology|stage6-adapter-middleware|smart-search|fast-context|codegraph/i);
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "neutral-kernel-"));
    try {
      const result = applyKernelCreate({ taskDir: root, actor: "test", idempotencyKey: "create", record: emptyTaskRecord({ id: "neutral" }), extrasBoundary: neutralKernelExtrasBoundary });
      expect(result.kernel.projection?.extras).not.toHaveProperty("ondemand_modules");
      expect(result.kernel.projection?.extras).not.toHaveProperty("middleware_providers");
      expect(result.legacy.status).toBe("planning");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
