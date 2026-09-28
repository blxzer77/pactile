import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTaskCli } from "../../src/commands/task.js";
import { PiTaskBridge } from "../../src/pactile/pi/bridge.js";
import { PiRpcClient } from "../../src/pactile/pi/rpc.js";

const roots: string[] = [];
const fakePi = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.tmp/p31-script-build/fixtures/fake-pi-provider.js");
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; task: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-pi-default-launch-"));
  roots.push(root);
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const shim = process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${fakePi}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fakePi)} "$@"\n`;
  fs.writeFileSync(path.join(root, process.platform === "win32" ? "pi.cmd" : "pi"), shim, { mode: 0o755 });
  vi.stubEnv("PATH", `${root}${path.delimiter}${process.env.PATH ?? ""}`);
  fs.mkdirSync(path.join(root, ".pactile", "tasks", "locale", "en"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pactile", "tasks", "locale", "en", "default-prd.md"), "# {title}\n{goal}\n");
  fs.writeFileSync(path.join(root, ".pactile", "config.yaml"), "artifact_locale: en\n");
  fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=tester\n");
  expect(runTaskCli(["legacy-create", "Pi defaults", "--slug", "pi-defaults"], root)).toBe(0);
  const task = fs.readdirSync(path.join(root, ".pactile", "tasks")).find((entry) => entry.endsWith("-pi-defaults"));
  if (!task) throw new Error("Task fixture missing");
  const dir = path.join(root, ".pactile", "tasks", task);
  fs.writeFileSync(path.join(dir, "design.md"), "# Design\nPreserve native Pi capabilities.\n");
  fs.writeFileSync(path.join(dir, "implement.md"), [
    "execution_mode: worker", "isolation: main-worktree", "verification_profile: standard",
    "retrieval_profile: exact-only", "optional_capabilities: []", "quality_gates:", "  mode: profile", "",
  ].join("\n"));
  expect(runTaskCli(["start-execution", task, "--approved"], root)).toBe(0);
  return { root, task };
}

describe("native Pi default launch", () => {
  it("passes only the native RPC mode to the configured Pi executable", async () => {
    const { root } = fixture();
    const client = new PiRpcClient({ cwd: root, sessionDir: path.join(root, "sessions") });
    try {
      await client.start();
      expect((await client.state()).launchArgs).toEqual(["--mode", "rpc"]);
    } finally { await client.close(); }
  });

  it.each(["implement", "research"] as const)("retains default capabilities for the %s role", async (role) => {
    const { root, task } = fixture();
    const bridge = new PiTaskBridge(root);
    const state = vi.spyOn(PiRpcClient.prototype, "state");
    try {
      const result = await bridge.run({ root, task, role, prompt: "Inspect the assignment", timeoutMs: 5000 });
      expect(result.outcome).toBe("settled");
      const initial = await state.mock.results[0]?.value as Record<string, unknown>;
      expect(initial.launchArgs).toEqual(["--mode", "rpc"]);
    } finally { state.mockRestore(); await bridge.close(); }
  });
});
