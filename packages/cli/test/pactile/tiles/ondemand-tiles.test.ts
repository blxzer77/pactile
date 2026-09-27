import { describe, expect, it } from "vitest";
import { loadBaselineTileContent } from "../../../src/pactile/tiles/content/baseline/index.js";
import {
  ONDEMAND_TILE_IDS,
  loadOndemandTileContent,
} from "../../../src/pactile/tiles/content/ondemand/index.js";
import { buildTileCatalog } from "../../../src/pactile/tiles/catalog.js";
import { compileTileComposition } from "../../../src/pactile/tiles/compiler.js";

describe("on-demand Tile catalog", () => {
  it("loads eleven Tiles and expands only explicit selections and dependencies", () => {
    const baseline = loadBaselineTileContent();
    const ondemand = loadOndemandTileContent();
    if (!baseline.success) throw new Error(JSON.stringify(baseline.diagnostics));
    if (!ondemand.success) throw new Error(JSON.stringify(ondemand.diagnostics));
    expect(ondemand.data).toHaveLength(11);
    expect(ondemand.data.map((entry) => entry.manifest.identity.id).sort()).toEqual(
      [...ONDEMAND_TILE_IDS].sort(),
    );
    const catalog = buildTileCatalog([...baseline.data, ...ondemand.data]);
    expect(catalog.success).toBe(true);
    if (!catalog.success) throw new Error(JSON.stringify(catalog.diagnostics));

    const request = {
      requestedSelection: [
        "parent-child",
        "retention-storage",
        "retrieval-extended",
      ],
      capabilities: [
        { id: "agent.dispatch", assurance: "evidence-backed" as const },
        { id: "memory.store", assurance: "evidence-backed" as const },
        { id: "retrieval.provider", assurance: "evidence-backed" as const },
      ],
    };
    const compiled = compileTileComposition(catalog.data, request);
    expect(compiled.success).toBe(true);
    if (!compiled.success) throw new Error(JSON.stringify(compiled.diagnostics));
    const selected = new Set(compiled.data.expandedSelection);
    for (const expected of [
      "parent-child@1.0.0",
      "worker-orchestration@1.0.0",
      "retention-storage@1.0.0",
      "personal-memory@1.0.0",
      "retrieval-extended@1.0.0",
      "close-basic@1.0.0",
      "context-progressive@1.0.0",
    ])
      expect(selected.has(expected)).toBe(true);
    for (const excluded of [
      "define-extended@1.0.0",
      "independent-check@1.0.0",
      "debug-recovery@1.0.0",
      "session-transfer@1.0.0",
      "spec-learning@1.0.0",
      "vcs-integration@1.0.0",
    ])
      expect(selected.has(excluded)).toBe(false);
    expect(compileTileComposition(catalog.data, request)).toEqual(compiled);
  });
});
