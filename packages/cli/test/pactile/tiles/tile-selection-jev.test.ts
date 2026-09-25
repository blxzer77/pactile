import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createJevDecisionFacadeV1,
  type JevEgressAuthorizationV1,
} from "../../../src/pactile/jev/index.js";
import {
  prepareBatch2TileSelectionWithJevV1,
  prepareSelectedTaskAgentTileSelectionWithJevV1,
  loadBatch2TileCatalog,
} from "../../../src/pactile/registry.js";
import { adviseTileSelectionWithJevV1 } from "../../../src/pactile/tiles/jev-selection.js";
import {
  buildTileCatalog,
  type TileCatalog,
} from "../../../src/pactile/tiles/catalog.js";
import {
  loadTileUnit,
  type TileCatalogEntry,
} from "../../../src/pactile/tiles/loader.js";
import type {
  TileSelectionFact,
  TileSelectionRequest,
} from "../../../src/pactile/tiles/selection.js";
import { BASELINE_TILE_IDS } from "../../../src/pactile/tiles/content/baseline/index.js";

const JEV_ORIGIN = "https://api.typesafe.ai";
const EGRESS: JevEgressAuthorizationV1 = {
  network: "project-authorized",
  privacy: "project-approved-egress",
  credentials: "project-authorized",
  destination: JEV_ORIGIN,
  egressDestinations: [JEV_ORIGIN],
  contentDecision: "task-summary-and-snippets-approved",
};
const APPROVED_POLICY: TileSelectionRequest["policyCeiling"] = {
  filesystem: "read",
  process: "none",
  network: "project-authorized",
  credentials: "project-authorized",
  privacy: "project-approved-egress",
  egressDestinations: [JEV_ORIGIN],
  telemetry: "local-only",
  cost: "low",
};
const LOCAL_POLICY: TileSelectionRequest["policyCeiling"] = {
  ...APPROVED_POLICY,
  network: "forbidden",
  credentials: "forbidden",
  privacy: "local-only",
  egressDestinations: [],
  cost: "free",
};
const request: TileSelectionRequest = {
  intent: "exact",
  requiredOutputs: ["selection.result"],
  policyCeiling: APPROVED_POLICY,
  capabilities: [],
  channel: "agent",
};
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function tile(id: string, output: string, summary = id): TileCatalogEntry {
  const yaml = [
    "schemaVersion: 1",
    "identity:",
    `  id: ${id}`,
    '  version: "1.0.0"',
    `summary: ${JSON.stringify(summary)}`,
    "trigger:",
    "  mode: both",
    "  intents:",
    "    - exact",
    `  description: ${id}`,
    "inputs: []",
    "outputs:",
    `  - ${output}`,
    "dependencies: []",
    "conflicts: []",
    "permissions:",
    "  filesystem: read",
    "  process: none",
    "  credentials: forbidden",
    "egress:",
    "  network: forbidden",
    "  privacy: local-only",
    "  telemetry: local-only",
    "  destinations: []",
    "cost:",
    "  ceiling: free",
    "fallback:",
    "  allowed: false",
    "  minimumAssurance: null",
    "  policy: null",
    "stop:",
    "  conditions:",
    "    - success",
    "  maxAttempts: 1",
    "minimumAssurance: evidence-backed",
    "evidence:",
    "  - kind: artifact",
    "    required: true",
    "    description: Record the result.",
  ].join("\n");
  const loaded = loadTileUnit([
    { name: "tile.yaml", text: yaml },
    { name: "SKILL.md", text: `# ${id}\n` },
  ]);
  if (!loaded.success) throw new Error(JSON.stringify(loaded.diagnostics));
  return loaded.data;
}

function surface(
  entries: readonly TileCatalogEntry[],
  lifecycleById: Readonly<Record<string, TileSelectionFact["lifecycle"]>> = {},
): {
  catalog: TileCatalog;
  facts: TileSelectionFact[];
} {
  const result = buildTileCatalog(entries);
  if (!result.success) throw new Error(JSON.stringify(result.diagnostics));
  return {
    catalog: result.data,
    facts: result.data.entries.map((entry) => ({
      ref: entry.ref,
      tier: "baseline",
      lifecycle: lifecycleById[entry.manifest.identity.id] ?? "active",
    })),
  };
}

const answer = (noul: number) => ({ type: "noul", noul });
const providerResponse = (answers: Record<string, unknown>): Response =>
  new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers,
      usage: { input_tokens: 500, output_tokens: 0 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
const fakeFetch = (impl: typeof fetch) =>
  vi.fn(impl) as unknown as typeof fetch;

describe("optional Jev advice for P33 Tile selection", () => {
  it("sends only hard-filtered candidates and leaves the suggestion subject to Compiler", async () => {
    const fetchedBodies: Record<string, unknown>[] = [];
    const fetchImpl = fakeFetch(async (_input, init) => {
      fetchedBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      return providerResponse({
        candidate0: answer(0),
        candidate1: answer(0.94),
      });
    });
    const { catalog, facts } = surface(
      [
        tile("alpha", "selection.result"),
        tile("beta", "selection.result"),
        tile("irrelevant", "not.requested", "SENSITIVE internal summary"),
        tile("retired", "selection.result", "SECRET retired summary"),
      ],
      { retired: "retired" },
    );
    const facade = createJevDecisionFacadeV1({
      transport: { apiKey: "test-key-not-persisted", fetchImpl },
    });

    const result = await adviseTileSelectionWithJevV1({
      catalog,
      request,
      facts,
      jev: { facade, callOptions: { egress: EGRESS } },
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.data.source, JSON.stringify(result.data)).toBe("jev-advised");
    expect(result.data.suggestedDecision).toMatchObject({
      kind: "override",
      selectedRefs: ["beta@1.0.0"],
    });
    expect(result.data.compilerValidation).toMatchObject({
      outcome: "overridden",
      compilerPassed: true,
      missingOutputs: [],
    });
    expect(result.data.eligibleCandidateCount).toBe(3);
    expect(result.data.consideredCandidateCount).toBe(2);
    expect(result.data.omittedCandidateCount).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const state = fetchedBodies[0]?.state as {
      taskSummary: string;
      sourceSnippets: { ref: string; text: string }[];
    };
    const sentText = state.sourceSnippets
      .map((snippet) => snippet.text)
      .join("\n");
    expect(state.taskSummary).toContain("selection.result");
    expect(sentText).toContain("alpha@1.0.0");
    expect(sentText).toContain("beta@1.0.0");
    expect(sentText).not.toContain("irrelevant@1.0.0");
    expect(sentText).not.toContain("SENSITIVE internal summary");
    expect(sentText).not.toContain("retired@1.0.0");
    expect(sentText).not.toContain("SECRET retired summary");
    expect(JSON.stringify(result.data.jevDecision?.receipt)).not.toContain(
      state.taskSummary,
    );
  });

  it("bounds Jev advice to eight candidates and three source groups", async () => {
    let sentBody: {
      questions: Record<string, unknown>;
      state: { sourceSnippets: { text: string }[] };
    } | null = null;
    const fetchImpl = fakeFetch(async (_input, init) => {
      sentBody = JSON.parse(String(init?.body)) as typeof sentBody & {};
      const answers = Object.fromEntries(
        Object.keys(sentBody?.questions ?? {}).map((name) => [
          name,
          answer(name === "candidate0" ? 0.95 : 0),
        ]),
      );
      return providerResponse(answers);
    });
    const { catalog, facts } = surface(
      Array.from({ length: 9 }, (_value, index) =>
        tile(`candidate.${index}`, "selection.result"),
      ),
    );
    const result = await adviseTileSelectionWithJevV1({
      catalog,
      request,
      facts,
      jev: {
        facade: createJevDecisionFacadeV1({
          transport: { apiKey: "test-key-not-persisted", fetchImpl },
        }),
        callOptions: { egress: EGRESS },
      },
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        source: "jev-advised",
        eligibleCandidateCount: 9,
        consideredCandidateCount: 8,
        omittedCandidateCount: 1,
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sentBody && Object.keys(sentBody.questions)).toHaveLength(8);
    expect(sentBody?.state.sourceSnippets).toHaveLength(3);
    expect(
      sentBody?.state.sourceSnippets.map((snippet) => snippet.text).join("\n"),
    ).toContain("candidate.7@1.0.0");
    expect(
      sentBody?.state.sourceSnippets.map((snippet) => snippet.text).join("\n"),
    ).not.toContain("candidate.8@1.0.0");
  });

  it("uses the deterministic offer when Jev is omitted and the task policy denies egress", async () => {
    const fetchImpl = fakeFetch(async () => providerResponse({}));
    const { catalog, facts } = surface([
      tile("alpha", "selection.result"),
      tile("beta", "selection.result"),
    ]);
    const notConfigured = await adviseTileSelectionWithJevV1({
      catalog,
      request,
      facts,
    });
    const denied = await adviseTileSelectionWithJevV1({
      catalog,
      request: { ...request, policyCeiling: LOCAL_POLICY },
      facts,
      jev: {
        facade: createJevDecisionFacadeV1({
          transport: { apiKey: "test-key-not-persisted", fetchImpl },
        }),
        callOptions: { egress: EGRESS },
      },
    });

    expect(notConfigured).toMatchObject({
      success: true,
      data: {
        source: "deterministic",
        fallback: { reasonCode: "not-configured" },
      },
    });
    expect(denied).toMatchObject({
      success: true,
      data: {
        source: "deterministic",
        fallback: { reasonCode: "egress-denied" },
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(catalog.entries).toHaveLength(2);
  });

  it("exposes the same optional fallback through the bundled registry entry point", async () => {
    const loaded = loadBatch2TileCatalog();
    if (!loaded.success) throw new Error(JSON.stringify(loaded.diagnostics));
    const baseline = new Set<string>(BASELINE_TILE_IDS);
    const lifecycleByRef = Object.fromEntries(
      loaded.data.entries.map((entry) => [
        entry.ref,
        baseline.has(entry.manifest.identity.id) ? "active" : "registered",
      ]),
    );
    const result = await prepareBatch2TileSelectionWithJevV1(
      request,
      lifecycleByRef,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        source: "deterministic",
        fallback: { reasonCode: "not-configured" },
      },
    });
  });

  it("blocks explicitly sensitive candidate metadata before HTTP and explains fallback", async () => {
    const fetchImpl = fakeFetch(async () => providerResponse({}));
    const { catalog, facts } = surface([
      tile("alpha", "selection.result", "内部机密，不得对外发送：roadmap"),
      tile("beta", "selection.result"),
    ]);
    const result = await adviseTileSelectionWithJevV1({
      catalog,
      request,
      facts,
      jev: {
        facade: createJevDecisionFacadeV1({
          transport: { apiKey: "test-key-not-persisted", fetchImpl },
        }),
        callOptions: { egress: EGRESS },
      },
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        source: "deterministic",
        fallback: { reasonCode: "sensitive-content" },
        jevDecision: { status: "fallback" },
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    if (!result.success) throw new Error("expected deterministic fallback");
    expect(JSON.stringify(result.data.jevDecision?.receipt)).not.toContain(
      "roadmap",
    );
  });

  it("does not treat a confident but incomplete proposal as a valid override", async () => {
    const fetchImpl = fakeFetch(async () =>
      providerResponse({ candidate0: answer(0.96), candidate1: answer(0) }),
    );
    const { catalog, facts } = surface([
      tile("alpha", "first.output"),
      tile("beta", "second.output"),
    ]);
    const result = await adviseTileSelectionWithJevV1({
      catalog,
      request: {
        ...request,
        requiredOutputs: ["first.output", "second.output"],
      },
      facts,
      jev: {
        facade: createJevDecisionFacadeV1({
          transport: { apiKey: "test-key-not-persisted", fetchImpl },
        }),
        callOptions: { egress: EGRESS },
      },
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        source: "deterministic",
        suggestedDecision: null,
        fallback: { reasonCode: "compiler-rejected" },
        compilerValidation: {
          outcome: "mis-selection",
          missingOutputs: ["second.output"],
        },
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(catalog.entries).toHaveLength(2);
  });

  it("keeps the selected-Task entry fail-closed when no Task is selected", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-jev-tile-"));
    tempRoots.push(root);
    const fetchImpl = fakeFetch(async () => providerResponse({}));
    const result = await prepareSelectedTaskAgentTileSelectionWithJevV1(
      root,
      {
        facade: createJevDecisionFacadeV1({
          transport: { apiKey: "test-key-not-persisted", fetchImpl },
        }),
        callOptions: { egress: EGRESS },
      },
      undefined,
      {},
    );

    expect(result.success).toBe(false);
    if (result.success)
      throw new Error("expected missing selected Task failure");
    expect("receipt" in result ? result.receipt.reasonCode : "").toBe(
      "tile-selection-no-current-task",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
