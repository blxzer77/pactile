/** Regression coverage for host-data ownership and the home-directory guard. */

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
import { loadHashes } from "../../src/utils/template-hash.js";

const noop = (): void => undefined;

describe("init + uninstall: ownership and homedir safety", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-overdelete-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.spyOn(console, "log").mockImplementation(noop);
    vi.spyOn(console, "error").mockImplementation(noop);
    vi.mocked(inquirer.prompt).mockResolvedValue({ proceed: true });
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    delete process.env.PACTILE_ALLOW_HOMEDIR;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.PACTILE_ALLOW_HOMEDIR;
  });

  it("keeps host files out of template hashes and inventories only projected host targets", async () => {
    const userFile = path.join(tmpDir, ".cursor", "user-data", "notes.txt");
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, "user-data\n");

    await init({ yes: true, codex: true, force: true });

    const hashes = loadHashes(tmpDir);
    expect(Object.keys(hashes).some((key) => key.startsWith(".cursor/"))).toBe(
      false,
    );
    const ledgerTargets =
      new ProjectionStore(tmpDir)
        .readLedger()
        ?.ledger.entries.map(({ targetPath }) => targetPath) ?? [];
    expect(ledgerTargets).toContain(".agents/skills/intake-basic/SKILL.md");
    expect(ledgerTargets).not.toContain(".cursor/user-data/notes.txt");
    expect(fs.readFileSync(userFile, "utf8")).toBe("user-data\n");
  });

  it("preserves unclaimed host history through init and uninstall", async () => {
    const history = path.join(tmpDir, ".cursor", "projects", "p1", "chat.jsonl");
    fs.mkdirSync(path.dirname(history), { recursive: true });
    fs.writeFileSync(history, '{"role":"user"}\n');

    await init({ yes: true, codex: true, force: true });
    await uninstall({ yes: true });

    expect(fs.readFileSync(history, "utf8")).toBe('{"role":"user"}\n');
  });

  async function withFakeHome<T>(
    fakeHome: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const originalHome = process.env.HOME;
    const originalProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      return await action();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalProfile;
    }
  }

  it("refuses init at the exact home directory without creating canonical state", async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-fake-home-"));
    try {
      vi.spyOn(process, "cwd").mockReturnValue(fakeHome);
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(((code?: number) => {
          throw new Error(`process.exit(${code ?? 0})`);
        }) as never);

      await withFakeHome(fakeHome, async () => {
        await expect(init({ yes: true, force: true })).rejects.toThrow(
          "process.exit(1)",
        );
      });

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(fs.existsSync(path.join(fakeHome, ".pactile"))).toBe(false);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("refuses uninstall at the exact home directory and leaves state unchanged", async () => {
    await init({ yes: true, codex: true, force: true });
    const statePath = path.join(
      tmpDir,
      ".pactile",
      "runtime",
      "install-state.json",
    );
    const before = fs.readFileSync(statePath);

    await withFakeHome(tmpDir, async () => {
      await expect(uninstall({ yes: true })).rejects.toThrow(
        "Refusing to run `pactile uninstall` in your home directory",
      );
    });

    expect(fs.readFileSync(statePath)).toEqual(before);
  });

  it("accepts the canonical explicit home-directory bypass", async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-fake-home-"));
    try {
      vi.spyOn(process, "cwd").mockReturnValue(fakeHome);
      process.env.PACTILE_ALLOW_HOMEDIR = "1";

      await withFakeHome(fakeHome, async () => {
        await init({ yes: true, codex: true, force: true });
      });

      expect(fs.existsSync(path.join(fakeHome, ".pactile"))).toBe(true);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("allows project directories below home without a bypass", async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-fake-home-"));
    const project = path.join(fakeHome, "projects", "example");
    fs.mkdirSync(project, { recursive: true });
    try {
      vi.spyOn(process, "cwd").mockReturnValue(project);

      await withFakeHome(fakeHome, async () => {
        await init({ yes: true, codex: true, force: true });
      });

      expect(fs.existsSync(path.join(project, ".pactile"))).toBe(true);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
