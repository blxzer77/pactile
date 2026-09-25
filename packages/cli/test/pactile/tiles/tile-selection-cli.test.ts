import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyKernelCreate,
  emptyTaskRecord,
  neutralKernelExtrasBoundary,
} from "../../../src/core/task/index.js";
import { canonicalizePactileJsonV1 } from "../../../src/core/index.js";
import { readTaskKernel } from "../../../src/core/task/index.js";
import { runContextCli } from "../../../src/commands/context.js";
import { runTaskCli } from "../../../src/commands/task.js";
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

  it("offers Tile candidates through the V2 session path and binds elevated grants to the approved active Run", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-v2-tile-selection-cli-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=alice\n");
    vi.stubEnv("PACTILE_CONTEXT_ID", "codex_v2_tile_selection");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(runTaskCli([
      "create", "V2 Tile grant task", "--slug", "v2-tile-grant", "--description", "Exercise Tile grant binding",
      "--deliverable", "a checked local result", "--delivery-level", "local-result", "--accept", "AC-1=The result is recorded",
    ], root)).toBe(0);
    expect(runTaskCli(["select", "v2-tile-grant"], root)).toBe(0);

    const taskDir = path.join(root, ".pactile", "tasks", mustTaskDir(root));
    const beforeRun = readTaskKernel({ root, taskDir, cwd: root });
    expect(beforeRun.kind).toBe("task-kernel-v2");
    if (beforeRun.kind !== "task-kernel-v2") throw new Error("expected V2 Task Kernel");
    expect(beforeRun.kernel.phase).toBe("define");

    expect(runContextCli(["--mode", "session", "--json"], root)).toBe(0);
    const sessionOffer = JSON.parse(String(log.mock.lastCall?.[0])) as {
      tileSelection: { status: string; offer?: { taskLifecycle: { selectionGrant: { source: string } }; candidates: { ref: string }[] } };
    };
    expect(sessionOffer.tileSelection.status).toBe("offered");
    expect(sessionOffer.tileSelection.offer?.taskLifecycle.selectionGrant.source).toBe("safe-default");
    expect(sessionOffer.tileSelection.offer?.candidates.some((candidate) => candidate.ref === "worker-orchestration@1.0.0")).toBe(false);
    expect(JSON.stringify(sessionOffer)).not.toContain("audit");

    const grant = {
      schemaVersion: 1,
      policyCeiling: {
        filesystem: "write", process: "execute", network: "forbidden", credentials: "forbidden",
        privacy: "local-only", egressDestinations: [], telemetry: "local-only", cost: "medium",
      },
      capabilities: [{ id: "agent.dispatch", assurance: "evidence-backed" }],
      providerFacts: [],
    };
    const grantScope = `pactile-tile-selection/v1:${canonicalizePactileJsonV1(grant)}`;
    expect(runTaskCli([
      "run-start", "v2-tile-grant", "--actor", "alice", "--input-summary", "Implement AC-1",
      "--approved-by", "user", "--approved-at", "2026-09-26T00:00:00.000Z",
      "--authorization-scope", grantScope, "--authorization-evidence", "approval.json",
    ], root)).toBe(0);

    const active = readTaskKernel({ root, taskDir, cwd: root });
    expect(active.kind).toBe("task-kernel-v2");
    if (active.kind !== "task-kernel-v2") throw new Error("expected V2 Task Kernel");
    const activeRun = active.kernel.runs.at(-1);
    expect(activeRun).toBeDefined();
    expect(active.kernel.phase).toBe("execute");
    expect(active.kernel.condition).toBe("active");

    const requestFile = path.join(root, "tile-request.json");
    fs.writeFileSync(requestFile, JSON.stringify({
      intent: "structural", requiredOutputs: ["worker.handoff"],
      policyCeiling: grant.policyCeiling, capabilities: grant.capabilities, providerFacts: [],
    }));
    expect(runTileSelectionCli(["prepare", "--request-file", "tile-request.json"], root)).toBe(0);
    const authorizedOffer = lastJson(log).offer as {
      taskLifecycle: { phase: string; selectionGrant: { source: string; assurance: string } };
      candidates: { ref: string }[];
    };
    expect(authorizedOffer.taskLifecycle).toMatchObject({
      phase: "execute", selectionGrant: { source: "task-kernel-approval-snapshot", assurance: "recorded-user-assertion" },
    });
    expect(authorizedOffer.candidates.some((candidate) => candidate.ref === "worker-orchestration@1.0.0")).toBe(true);
    const authorizedOfferFingerprint = (lastJson(log).offer as { fingerprint: string }).fingerprint;
    expect(runTileSelectionCli([
      "decide", "--request-file", "tile-request.json", "--offer-fingerprint", authorizedOfferFingerprint, "--kind", "adopt",
    ], root)).toBe(0);
    const decided = lastJson(log);
    expect(decided).toMatchObject({ success: true, executionAuthorization: "not-granted", receipt: { outcome: "selected", compilerPassed: true } });
    const snapshot = decided.snapshot as { fingerprint: string; fileName: string };
    const snapshotText = fs.readFileSync(path.join(root, ".pactile", "runtime", "receipts", snapshot.fileName), "utf8");
    expect(snapshotText).not.toContain(root);
    expect(snapshotText).not.toContain("audit");
    expect(runTileSelectionCli(["replay", "--snapshot-fingerprint", snapshot.fingerprint], root)).toBe(0);
    expect(lastJson(log)).toMatchObject({ success: true, data: { offerFingerprint: authorizedOfferFingerprint } });

    const current = readTaskKernel({ root, taskDir, cwd: root });
    if (current.kind !== "task-kernel-v2" || !activeRun) throw new Error("expected the active V2 Run");
    expect(runTaskCli([
      "run-result", "v2-tile-grant", activeRun.id, "--outcome", "completed", "--summary", "Result recorded",
      "--candidate", `result.txt=${"a".repeat(64)}`,
    ], root)).toBe(0);
    expect(runTileSelectionCli(["prepare", "--request-file", "tile-request.json"], root)).toBe(0);
    const completedRunOffer = lastJson(log).offer as {
      taskLifecycle: { phase: string; selectionGrant: { source: string; assurance: string } };
      candidates: { ref: string }[];
    };
    expect(completedRunOffer.taskLifecycle).toMatchObject({
      phase: "verify", selectionGrant: { source: "safe-default", assurance: "no-grant" },
    });
    expect(completedRunOffer.candidates.some((candidate) => candidate.ref === "worker-orchestration@1.0.0")).toBe(false);
  });
});

function mustTaskDir(root: string): string {
  const entry = fs.readdirSync(path.join(root, ".pactile", "tasks"))
    .find((name) => name.endsWith("-v2-tile-grant"));
  if (!entry) throw new Error("created V2 Task directory is missing");
  return entry;
}
