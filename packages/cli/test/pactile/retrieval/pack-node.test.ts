import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRetrievalPack } from "../../../src/pactile/retrieval/pack.js";
import { runContextCli } from "../../../src/commands/context.js";

const roots: string[] = [];
function project(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-pack-node-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("Node retrieval quality layer", () => {
  it("returns an explicit empty pack that cannot qualify as Close evidence", () => {
    const result = buildRetrievalPack({}, project());
    expect(result).toMatchObject({ source: "retrieval-pack-orchestrator", collectionStatus: "missing", closeEvidenceEligible: false, notAcEvidence: true });
    expect(result.scoredEvidence).toMatchObject({ total: 0, items: [] });
    expect(result.contextPack).toMatchObject({ selected: [], omitted: [] });
    const envelope = result.evidenceEnvelope as { adapterState: { adapter: string; state: string; required: boolean }[]; freshness: unknown[]; fallback: { fromAdapter: string }[]; verification: { adapter: string }[] };
    expect(envelope.adapterState).toContainEqual(expect.objectContaining({ adapter: "rg", state: "available", required: true }));
    expect(envelope.freshness).toHaveLength(envelope.adapterState.length);
    expect(envelope.fallback).toContainEqual(expect.objectContaining({ fromAdapter: "codegraph" }));
    expect(envelope.verification).toContainEqual(expect.objectContaining({ adapter: "source-git-tests" }));
  });

  it("retains the separate Node retrieval intent plan when a query is provided", () => {
    const result = buildRetrievalPack({ query: "Find the exact API symbol" }, project());
    const envelope = result.evidenceEnvelope as { intents: string[]; routes: { intent: string }[] };
    expect(envelope.intents).toContain("exact");
    expect(envelope.routes).toContainEqual(expect.objectContaining({ intent: "exact" }));
    expect(result.collectionStatus).toBe("missing");
  });

  it("scores collected sources, arbitrates overlap, and keeps failed evidence out of the pack", () => {
    const root = project();
    const payload = {
      retrievalGuide: { selectedTaskArtifacts: { taskPath: ".pactile/tasks/task", prd: true } },
      items: [
        { path: ".pactile/spec/api.md", provider: "artifact-search", title: "API contract", score: 90 },
        { path: ".pactile/workspace/journal.md", provider: "session-memory", title: "API contract", score: 90, date: "2020-01-01" },
        { path: "packages/api/src/index.ts", provider: "codebase", title: "API implementation", score: 70 },
        { path: "research/failed/manifest.json", provider: "smart-search", title: "External API", status: "failed", error: "offline" },
      ],
    };
    const result = buildRetrievalPack(payload, root);
    const scored = result.scoredEvidence as { items: { source: string; score: number; status: string }[] };
    const arbitrated = result.arbitratedEvidence as { conflicts: { type: string }[]; items: { source: string; conflictFlags: string[] }[] };
    const pack = result.contextPack as { selected: { source: string; validationState: string }[]; omitted: { source: string; reason: string }[] };
    expect(scored.items[0]?.source).toBe("task-artifacts");
    expect(scored.items.find((item) => item.source === "smart-search")?.score).toBeLessThanOrEqual(8);
    expect(arbitrated.conflicts).toContainEqual(expect.objectContaining({ type: "downgrade" }));
    expect(arbitrated.items.find((item) => item.source === "session-memory")?.conflictFlags).toContain("stale_warning");
    expect(pack.selected.some((item) => item.validationState === "candidate")).toBe(true);
    expect(pack.omitted).toContainEqual(expect.objectContaining({ source: "smart-search", reason: expect.stringContaining("unavailable") }));
    expect(result).toMatchObject({ collectionStatus: "collected", closeEvidenceEligible: false });
    const envelope = result.evidenceEnvelope as { adapterState: { adapter: string; state: string }[]; fallback: { fromAdapter: string; toAdapter: string }[] };
    expect(envelope.adapterState).toContainEqual(expect.objectContaining({ adapter: "smart-search", state: "failed" }));
    expect(envelope.fallback).toContainEqual(expect.objectContaining({ fromAdapter: "smart-search", toAdapter: "rg" }));
  });

  it("discovers task manifests only inside the project and applies the item budget", () => {
    const root = project();
    const file = path.join(root, ".pactile", "tasks", "task", "research", "smart-search", "run", "manifest.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ status: "ok", query: "Release API", createdAt: new Date().toISOString() }));
    const found = buildRetrievalPack({ retrievalGuide: { selectedTaskArtifacts: { taskPath: ".pactile/tasks/task", prd: true } } }, root, { maxItems: 1 });
    expect(found.collection).toMatchObject({ smartSearchManifests: 1 });
    expect(found.contextPack).toMatchObject({ budget: { maxItems: 1, itemsUsed: 1 }, summary: { budgetExceeded: true } });
    const escaped = buildRetrievalPack({ retrievalGuide: { selectedTaskArtifacts: { taskPath: os.tmpdir() } } }, root);
    expect(escaped.collection).toMatchObject({ smartSearchManifests: 0 });
    expect(escaped.warnings).toContainEqual(expect.stringContaining("outside repo_root"));
  });

  it("writes a Node-generated pack from collected evidence through context CLI", () => {
    const root = project();
    const input = path.join(root, "evidence.json");
    const output = path.join(root, ".pactile", "tasks", "task", "research", "retrieval-pack-latest.json");
    fs.writeFileSync(input, JSON.stringify({ collectedEvidence: [{ path: "src/app.ts", provider: "codebase", title: "App", score: 80 }] }));
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(runContextCli(["--mode", "retrieval-pack", "--input", input, "--max-items", "1", "--output", output, "--json"], root)).toBe(0);
      const written = JSON.parse(fs.readFileSync(output, "utf8"));
      expect(written.contextPack.selected).toHaveLength(1);
      expect(written.inputRole).toBe("collected-evidence");
      expect(JSON.parse(String(spy.mock.lastCall?.[0])).contextPack).toEqual(written.contextPack);
    } finally { spy.mockRestore(); }
  });
});
