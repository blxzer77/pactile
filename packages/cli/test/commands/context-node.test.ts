import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runContextCli } from "../../src/commands/context.js";
import { runTaskCli } from "../../src/commands/task.js";
import { compileSessionPack } from "../../src/pactile/task/session-pack.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("Node context CLI", () => {
  it("reports package indexes and a session-scoped selected task without Python", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-context-node-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, ".pactile", "tasks", "09-24-example"), { recursive: true });
    fs.mkdirSync(path.join(root, ".pactile", "spec", "app", "backend"), { recursive: true });
    fs.writeFileSync(path.join(root, ".pactile", "config.yaml"), "packages:\n  app:\n    path: packages/app\n    git: true\ndefault_package: app\nartifact_locale: en\n");
    fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=alice\n");
    fs.writeFileSync(path.join(root, ".pactile", "tasks", "09-24-example", "task.json"), JSON.stringify({ name: "example", title: "Example", status: "planning", assignee: "alice", priority: "P2" }));
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(runContextCli(["--mode", "packages", "--json"], root)).toBe(0);
      const packages = JSON.parse(String(spy.mock.lastCall?.[0]));
      expect(packages).toMatchObject({ mode: "monorepo", defaultPackage: "app", packages: [{ name: "app", path: "packages/app", isGitRepo: true, specLayers: ["backend"] }] });
      expect(runContextCli(["--mode", "record", "--json"], root)).toBe(0);
      const record = JSON.parse(String(spy.mock.lastCall?.[0]));
      expect(record.myTasks).toHaveLength(1);
      expect(record.selectedTask).toBeNull();
      expect(runContextCli(["--mode", "lite", "--json"], root)).toBe(0);
      const lite = JSON.parse(String(spy.mock.lastCall?.[0]));
      expect(lite).toMatchObject({ phase: "open", modules: { activatedOnDemand: [] } });
      expect(runContextCli([], root)).toBe(0);
      expect(String(spy.mock.lastCall?.[0])).toContain("## TASK DASHBOARD");
    } finally { spy.mockRestore(); }
  });

  it("activates only phase-needed contracts in the five-layer session pack", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-session-node-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, ".pactile", "tasks", "locale", "zh"), { recursive: true });
    fs.mkdirSync(path.join(root, ".pactile", "modules", "define-basic"), { recursive: true });
    fs.writeFileSync(path.join(root, ".pactile", "config.yaml"), "artifact_locale: zh\n");
    fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=alice\n");
    fs.writeFileSync(path.join(root, ".pactile", "tasks", "locale", "zh", "default-prd.md"), "# {title}\n{goal}\n");
    fs.writeFileSync(path.join(root, ".pactile", "modules", "index.json"), JSON.stringify({ modules: [{ id: "define-basic", contract: "define-basic/contract.md" }] }));
    fs.writeFileSync(path.join(root, ".pactile", "modules", "define-basic", "contract.md"), "Define the Acceptance Criteria.");
    fs.writeFileSync(path.join(root, ".pactile", "workflow.md"), "SECRET WORKFLOW DUMP");
    expect(runTaskCli(["create", "Example", "--slug", "example"], root)).toBe(0);
    vi.stubEnv("PACTILE_CONTEXT_ID", "codex_context_test");
    try {
      expect(runTaskCli(["select", "example"], root)).toBe(0);
      const pack = compileSessionPack(root);
      const layers = pack.layers as Record<string, unknown>[];
      expect(pack.kernel).toMatchObject({ phase: "define", selected: true });
      expect(layers[1].moduleIds).toEqual(["define-basic"]);
      expect(layers[2].items).toHaveLength(1);
      expect(JSON.stringify(pack)).not.toContain("SECRET WORKFLOW DUMP");
    } finally { vi.unstubAllEnvs(); }
  });

  it("extracts the human Phase Index and a platform-filtered step without treating it as Kernel state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-phase-node-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, ".pactile"), { recursive: true });
    fs.writeFileSync(path.join(root, ".pactile", "workflow.md"), [
      "# Workflow", "## Phase Index", "Index body", "[workflow-state:planning]", "internal status", "[/workflow-state:planning]",
      "## Phase 1: Plan", "#### 1.1 Define", "Common guidance", "[Codex]", "Codex guidance", "[/Codex]", "[Cursor]", "Legacy guidance", "[/Cursor]", "#### 1.2 Approve", "Approval guidance", "",
    ].join("\n"));
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(runContextCli(["--mode", "phase"], root)).toBe(0);
      expect(String(spy.mock.lastCall?.[0])).toContain("Index body");
      expect(String(spy.mock.lastCall?.[0])).not.toContain("internal status");
      expect(runContextCli(["--mode", "phase", "--step", "1.1", "--platform", "codex"], root)).toBe(0);
      expect(String(spy.mock.lastCall?.[0])).toContain("Codex guidance");
      expect(String(spy.mock.lastCall?.[0])).not.toContain("Legacy guidance");
      expect(runContextCli(["--mode", "phase", "--step", "9.9"], root)).toBe(1);
    } finally { spy.mockRestore(); }
  });
});
