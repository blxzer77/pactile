import { describe, expect, it } from "vitest";
import type { CapabilityBindingV1 } from "@blxzer/pactile-core";
import { planBinding } from "../../../src/pactile/adoption/bindings.js";
import { discoverSnapshot } from "../../../src/pactile/adoption/inventory.js";
import { composeBatch2Plan, loadBatch2TileCatalog } from "../../../src/pactile/registry.js";
import { fingerprintBytes, planProjection } from "../../../src/pactile/projection/planner.js";

function binding(tileId = "intake-basic"): CapabilityBindingV1 {
  const asset = discoverSnapshot({
    context: {
      hostId: "batch2",
      rootId: "project",
      source: "pactile-bundled",
      scope: "project",
      owner: { kind: "pactile", id: "pactile" },
    },
    assets: [
      {
        id: tileId,
        kind: "skill",
        locatorToken: tileId,
        present: true,
        enabled: true,
      },
    ],
  }).assets[0];
  const result = planBinding({
    asset,
    capabilityId: tileId,
    intents: ["exact"],
  });
  if (!result.binding) throw new Error(JSON.stringify(result));
  return result.binding;
}

describe("Batch 2 parent composition seam", () => {
  it("compiles one selection and absorbs the shared projection into each platform transaction", () => {
    const catalog = loadBatch2TileCatalog();
    expect(catalog.success).toBe(true);
    if (!catalog.success) throw new Error(JSON.stringify(catalog.diagnostics));
    const tile = catalog.data.entries.find(
      ({ manifest }) => manifest.identity.id === "intake-basic",
    );
    if (!tile) throw new Error("missing intake-basic");
    const shared = {
      generationId: "generation-b2",
      canonicalFingerprint: fingerprintBytes("canonical"),
      updatedAt: "2026-09-10T00:00:00.000Z",
      action: "attach" as const,
      ledger: null,
      claims: [{ tile: tile.manifest, binding: binding(), skillBody: tile.skillText }],
      surfaces: [{ targetPath: "AGENTS.md", content: null }],
    };
    const selection = {
      requestedSelection: ["intake-basic"],
      capabilities: [],
    };
    const codex = composeBatch2Plan({
      platform: "codex",
      catalog: catalog.data,
      selection,
      shared,
      adapter: { appReadiness: "ready", composition: [] },
    });
    expect(codex.status).toBe("ready");
    if (codex.status !== "ready") throw new Error(JSON.stringify(codex));
    expect(codex.adapterId).toBe("adapter.codex");
    expect(codex.projection.plan).toMatchObject({ adapterId: "adapter.codex" });
    const codexPreview = planProjection(codex.projection);
    expect(codexPreview.status).toBe("ready");
    if (codexPreview.status !== "ready") throw new Error(JSON.stringify(codexPreview));
    expect(codexPreview.mutations.map(({ targetPath }) => targetPath)).toEqual([
      "AGENTS.md",
      ".agents/skills/intake-basic/SKILL.md",
    ]);
  });

  it("rejects claims or owned bodies that do not exactly match the compiled selection", () => {
    const catalog = loadBatch2TileCatalog();
    if (!catalog.success) throw new Error(JSON.stringify(catalog.diagnostics));
    const intake = catalog.data.entries.find(
      ({ manifest }) => manifest.identity.id === "intake-basic",
    );
    const define = catalog.data.entries.find(
      ({ manifest }) => manifest.identity.id === "define-basic",
    );
    if (!intake || !define) throw new Error("missing audit fixtures");
    const common = {
      platform: "codex" as const,
      catalog: catalog.data,
      selection: {
        requestedSelection: ["intake-basic"],
        capabilities: [],
      },
      adapter: { appReadiness: "ready" as const, composition: [] },
    };
    for (const claims of [
      [
        {
          tile: define.manifest,
          binding: binding("define-basic"),
          skillBody: define.skillText,
        },
      ],
      [
        {
          tile: intake.manifest,
          binding: binding("intake-basic"),
          skillBody: "# Tampered owned body\n",
        },
      ],
    ]) {
      expect(
        composeBatch2Plan({
          ...common,
          shared: {
            generationId: "generation-mismatch",
            canonicalFingerprint: fingerprintBytes("canonical"),
            updatedAt: "2026-09-10T00:00:00.000Z",
            action: "attach",
            ledger: null,
            claims,
            surfaces: [{ targetPath: "AGENTS.md", content: null }],
          },
        }),
      ).toMatchObject({
        status: "review",
        projection: null,
        diagnostics: [{ code: "selection-claim-mismatch" }],
      });
    }
  });
});
