import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLifecycleCommand, installedPactilePlatforms } from "../../../../src/pactile/lifecycle/command-runner.js";
import { InstallStateStore } from "../../../../src/pactile/runtime/stores.js";
import { getPactilePlatform, listPactilePlatforms } from "../../../../src/pactile/registry.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-codex-adapter-"));
  roots.push(value);
  return value;
}

const generationFiles = [
  { path: "workflow.md", bytes: Buffer.from("# Workflow\n") },
  { path: "framework/index.md", bytes: Buffer.from("# Framework\n") },
];

describe("active adapter conformance", () => {
  it("exposes Codex only and refuses Cursor as a new platform", () => {
    expect(listPactilePlatforms().map((platform) => platform.platform)).toEqual(["codex"]);
    expect(getPactilePlatform("cursor")).toBeNull();
  });

  it("initializes Codex without producing Cursor files", async () => {
    const projectRoot = root();
    const result = await runLifecycleCommand({
      projectRoot,
      operation: "init",
      runtimeVersion: "0.5.0",
      files: generationFiles,
      platforms: ["codex"],
      occurredAt: "2026-09-23T00:00:00.000Z",
    });
    expect(result.status).toBe("completed");
    expect(fs.existsSync(path.join(projectRoot, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, ".agents/skills/intake-basic/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, ".cursor"))).toBe(false);
    expect(result.installState?.state.installedAdapters.map((adapter) => adapter.id)).toEqual(["adapter.codex"]);
  });

  it("does not refresh or remove a legacy Cursor file on reconciliation", async () => {
    const projectRoot = root();
    const first = await runLifecycleCommand({
      projectRoot,
      operation: "init",
      runtimeVersion: "0.5.0",
      files: generationFiles,
      platforms: ["codex"],
      occurredAt: "2026-09-23T00:00:00.000Z",
    });
    expect(first.status).toBe("completed");
    const legacyFile = path.join(projectRoot, ".cursor/mcp.json");
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, '{"mcpServers":{"user-owned":{"command":"node"}}}\n');
    const before = fs.readFileSync(legacyFile);
    const store = new InstallStateStore(projectRoot);
    const installed = store.read();
    if (!installed) throw new Error("missing install state");
    store.compareAndSwap(installed.fingerprint, {
      ...installed.state,
      installedAdapters: [
        { id: "adapter.cursor", version: "0.5.0", status: "active", lastProjectionFingerprint: null, reconciledAt: null },
        ...installed.state.installedAdapters,
      ],
    });
    const selected = installedPactilePlatforms(store.read()?.state ?? null);
    expect(selected).toEqual(["codex"]);
    const updated = await runLifecycleCommand({
      projectRoot,
      operation: "reconcile",
      runtimeVersion: "0.5.0",
      files: generationFiles,
      platforms: selected,
      occurredAt: "2026-09-23T00:01:00.000Z",
    });
    expect(updated.status).toBe("completed");
    expect(fs.readFileSync(legacyFile)).toEqual(before);
    expect(updated.adapters.some((adapter) => adapter.adapterId === "adapter.cursor")).toBe(false);
  });
});
