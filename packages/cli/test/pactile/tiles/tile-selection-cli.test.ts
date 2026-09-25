import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyKernelCreate,
  emptyTaskRecord,
  neutralKernelExtrasBoundary,
} from "../../../src/core/task/index.js";
import { runTileSelectionCli } from "../../../src/commands/tile-selection.js";
import { selectTask } from "../../../src/pactile/task/session.js";
import { BASELINE_TILE_IDS } from "../../../src/pactile/tiles/content/baseline/index.js";
import { ONDEMAND_TILE_IDS } from "../../../src/pactile/tiles/content/ondemand/index.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function selectedTaskRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-tile-selection-cli-"));
  roots.push(root);
  const taskDir = path.join(root, ".pactile", "tasks", "selection-cli");
  fs.mkdirSync(path.dirname(taskDir), { recursive: true });
  applyKernelCreate({
    taskDir,
    cwd: root,
    actor: "test",
    idempotencyKey: "create-selection-cli",
    record: emptyTaskRecord({ id: "selection-cli", name: "selection-cli", title: "Tile selection CLI" }),
    extras: {
      baseline_modules: { active: [...BASELINE_TILE_IDS] },
      ondemand_modules: { registered: [...ONDEMAND_TILE_IDS], active: [], degraded: [] },
    },
    extrasBoundary: neutralKernelExtrasBoundary,
  });
  const env = { PACTILE_CONTEXT_ID: "codex_tile_selection_cli" } as NodeJS.ProcessEnv;
  selectTask(root, ".pactile/tasks/selection-cli", env);
  vi.stubEnv("PACTILE_CONTEXT_ID", env.PACTILE_CONTEXT_ID as string);
  return root;
}

function lastJson(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  return JSON.parse(String(spy.mock.lastCall?.[0])) as Record<string, unknown>;
}

describe("current Task tile-selection CLI", () => {
  it("offers checked candidates and persists a decision that can be replayed later", () => {
    const root = selectedTaskRoot();
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runTileSelectionCli(["prepare", "--intent", "structural", "--output", "task.design"], root)).toBe(0);
    const prepared = lastJson(spy);
    const offer = prepared.offer as { fingerprint: string; candidates: { ref: string }[] };
    expect(prepared).not.toHaveProperty("audit");
    expect(offer.candidates.some((candidate) => candidate.ref === "define-extended@1.0.0")).toBe(true);

    expect(runTileSelectionCli([
      "decide",
      "--offer-fingerprint", offer.fingerprint,
      "--kind", "adopt",
      "--intent", "structural",
      "--output", "task.design",
    ], root)).toBe(0);
    const decided = lastJson(spy);
    expect(decided).toMatchObject({ success: true, executionAuthorization: "not-granted" });
    const receipt = decided.receipt as Record<string, unknown>;
    const snapshot = decided.snapshot as { fingerprint: string; fileName: string };
    expect(receipt).toMatchObject({ outcome: "selected", compilerPassed: true });
    expect(snapshot.fileName).toBe(`tile-selection-${snapshot.fingerprint.slice(7)}.json`);

    const snapshotPath = path.join(root, ".pactile", "runtime", "receipts", snapshot.fileName);
    const persisted = fs.readFileSync(snapshotPath, "utf8");
    expect(persisted).not.toContain(root);
    expect(persisted).not.toContain("audit");
    expect(runTileSelectionCli(["replay", "--snapshot-fingerprint", snapshot.fingerprint], root)).toBe(0);
    const replayed = lastJson(spy);
    expect(replayed).toMatchObject({ success: true, data: { offerFingerprint: offer.fingerprint, receipt } });
    const replayOffer = (replayed.data as { offer: { fingerprint: string; candidates: { ref: string }[] } }).offer;
    expect(replayOffer.fingerprint).toBe(offer.fingerprint);
    expect(replayOffer.candidates.some((candidate) => candidate.ref === "define-extended@1.0.0")).toBe(true);

    expect(runTileSelectionCli([
      "decide",
      "--offer-fingerprint", offer.fingerprint,
      "--kind", "override",
      "--intent", "structural",
      "--output", "task.design",
      "--tile", "define-extended@1.0.0",
    ], root)).toBe(0);
    expect(lastJson(spy)).toMatchObject({ success: true, receipt: { outcome: "overridden", compilerPassed: true } });
    expect(runTileSelectionCli([
      "decide",
      "--offer-fingerprint", offer.fingerprint,
      "--kind", "no-match",
      "--intent", "structural",
      "--output", "task.design",
    ], root)).toBe(0);
    expect(lastJson(spy)).toMatchObject({ success: true, receipt: { outcome: "no-match", compilerPassed: false } });
  });

  it("records invalid decisions while redacting caller-controlled path-like refs", () => {
    const root = selectedTaskRoot();
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runTileSelectionCli(["prepare", "--intent", "structural", "--output", "task.design"], root)).toBe(0);
    const offer = lastJson(spy).offer as { fingerprint: string };
    const secretLikeRef = "C:\\private\\provider-token-ghp_p33_secret";
    expect(runTileSelectionCli([
      "decide",
      "--offer-fingerprint", offer.fingerprint,
      "--kind", "override",
      "--intent", "structural",
      "--output", "task.design",
      "--tile", secretLikeRef,
    ], root)).toBe(0);
    const result = lastJson(spy);
    expect(result).toMatchObject({ success: true, receipt: { outcome: "invalid-selection", invalidReferenceCount: 1 } });
    const snapshot = result.snapshot as { fingerprint: string; fileName: string };
    const persisted = fs.readFileSync(path.join(root, ".pactile", "runtime", "receipts", snapshot.fileName), "utf8");
    expect(persisted).not.toContain(secretLikeRef);
    expect(persisted).not.toContain(root);
    expect(runTileSelectionCli([
      "decide",
      "--offer-fingerprint", offer.fingerprint,
      "--kind", "unsupported",
      "--intent", "structural",
      "--output", "task.design",
    ], root)).toBe(0);
    expect(lastJson(spy)).toMatchObject({ success: true, receipt: { decision: "invalid", outcome: "invalid-selection" } });
  });
});
