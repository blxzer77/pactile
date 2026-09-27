/** Command-level coverage for Pactile's non-destructive uninstall contract. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import inquirer from "inquirer";

vi.mock("figlet", () => ({
  default: { textSync: vi.fn(() => "PACTILE") },
}));

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn() },
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockImplementation((cmd: string) => {
    const py = process.platform === "win32" ? "python" : "python3";
    return cmd === `${py} --version` ? "Python 3.11.12" : "";
  }),
}));

import { init } from "../../src/commands/init.js";
import { uninstall } from "../../src/commands/uninstall.js";
import { ProjectionStore } from "../../src/pactile/projection/store.js";
import { InstallStateStore } from "../../src/pactile/runtime/stores.js";
import { hasPactileBlock } from "../../src/utils/agents-md.js";

const noop = (): void => undefined;

function treeSnapshot(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else {
        const relative = path.relative(root, absolute).replace(/\\/g, "/");
        snapshot[relative] = fs.readFileSync(absolute).toString("base64");
      }
    }
  };
  walk(root);
  return snapshot;
}

describe("uninstall() integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-uninstall-int-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.spyOn(console, "log").mockImplementation(noop);
    vi.spyOn(console, "error").mockImplementation(noop);
    vi.mocked(inquirer.prompt).mockResolvedValue({ proceed: true });
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns cleanly without canonical install state and never mutates legacy input", async () => {
    const legacy = path.join(tmpDir, ".cstl", "user.txt");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, "legacy user state\n");
    const before = treeSnapshot(tmpDir);

    await expect(uninstall({ yes: true })).resolves.toBeNull();

    expect(treeSnapshot(tmpDir)).toEqual(before);
  });

  it("treats a bare canonical directory without install state as not installed", async () => {
    const userState = path.join(tmpDir, ".pactile", "tasks", "user.md");
    fs.mkdirSync(path.dirname(userState), { recursive: true });
    fs.writeFileSync(userState, "user task\n");

    await expect(uninstall({ yes: true })).resolves.toBeNull();

    expect(fs.readFileSync(userState, "utf8")).toBe("user task\n");
  });

  it("detaches hosts, marks the install inactive, and preserves canonical user state", async () => {
    await init({ yes: true, codex: true, force: true });
    const task = path.join(tmpDir, ".pactile", "tasks", "user", "notes.md");
    const workspace = path.join(tmpDir, ".pactile", "workspace", "user.txt");
    const userHost = path.join(tmpDir, ".cursor", "user-data", "notes.txt");
    for (const [target, body] of [
      [task, "task\n"],
      [workspace, "workspace\n"],
      [userHost, "host user data\n"],
    ]) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    }

    const result = await uninstall({ yes: true });

    expect(result && "status" in result ? result.status : null).toBe("applied");
    const state = new InstallStateStore(tmpDir).read()?.state;
    expect(state?.status).toBe("inactive");
    expect(
      state?.installedAdapters.every(({ status }) => status === "detached"),
    ).toBe(true);
    expect(fs.readFileSync(task, "utf8")).toBe("task\n");
    expect(fs.readFileSync(workspace, "utf8")).toBe("workspace\n");
    expect(fs.readFileSync(userHost, "utf8")).toBe("host user data\n");
    expect(fs.existsSync(path.join(tmpDir, ".pactile"))).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, ".cursor", "commands", "pactile.md")),
    ).toBe(false);
  });

  it("returns a deterministic dry-run without prompting or changing bytes", async () => {
    await init({ yes: true, codex: true, force: true });
    const before = treeSnapshot(tmpDir);

    const result = await uninstall({ dryRun: true });

    expect(result?.status).toBe("dry-run");
    if (result?.status === "dry-run") {
      expect(result.adapterIds).toEqual([...result.adapterIds].sort());
      expect(result.previews).toHaveLength(result.adapterIds.length);
      expect(
        result.previews.every(({ previewFingerprint }) =>
          /^sha256:[0-9a-f]{64}$/.test(previewFingerprint),
        ),
      ).toBe(true);
    }
    expect(treeSnapshot(tmpDir)).toEqual(before);
    expect(inquirer.prompt).not.toHaveBeenCalled();
  });

  it("honors an interactive cancellation without changing state", async () => {
    await init({ yes: true, codex: true, force: true });
    const before = treeSnapshot(tmpDir);
    vi.mocked(inquirer.prompt).mockResolvedValueOnce({ proceed: false });

    await expect(uninstall({})).resolves.toBeNull();

    expect(treeSnapshot(tmpDir)).toEqual(before);
  });

  it("releases claims but preserves a user-modified projected file", async () => {
    await init({ yes: true, codex: true, force: true });
    const target = path.join(tmpDir, ".agents", "skills", "intake-basic", "SKILL.md");
    fs.appendFileSync(target, "\nUSER MODIFICATION\n");

    await uninstall({ yes: true });

    expect(fs.readFileSync(target, "utf8")).toContain("USER MODIFICATION");
    expect(new InstallStateStore(tmpDir).read()?.state.status).toBe("inactive");
    expect(
      new ProjectionStore(tmpDir)
        .readLedger()
        ?.ledger.entries.find(({ targetPath }) => targetPath === ".agents/skills/intake-basic/SKILL.md")
        ?.claimants,
    ).toEqual([]);
  });

  it("preserves an adopted AGENTS.md asset and only releases its claim", async () => {
    const agents = path.join(tmpDir, "AGENTS.md");
    fs.writeFileSync(agents, "# User policy\n");
    await init({ yes: true, codex: true, skipExisting: true });
    expect(hasPactileBlock(fs.readFileSync(agents, "utf8"))).toBe(true);

    await uninstall({ yes: true });

    const after = fs.readFileSync(agents, "utf8");
    expect(after).toContain("# User policy");
    expect(hasPactileBlock(after)).toBe(true);
    expect(
      new ProjectionStore(tmpDir)
        .readLedger()
        ?.ledger.entries.find(({ targetPath }) => targetPath === "AGENTS.md")
        ?.claimants,
    ).toEqual([]);
  });

  it("deletes an unchanged AGENTS.md created wholly by Pactile", async () => {
    await init({ yes: true, codex: true, force: true });
    const agents = path.join(tmpDir, "AGENTS.md");
    expect(hasPactileBlock(fs.readFileSync(agents, "utf8"))).toBe(true);

    await uninstall({ yes: true });

    expect(fs.existsSync(agents)).toBe(false);
  });
});
