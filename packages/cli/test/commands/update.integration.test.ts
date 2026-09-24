/**
 * Integration tests for the update() command.
 *
 * Tests the full update flow in real temp directories with minimal mocking.
 * Only external dependencies are mocked: figlet, inquirer, child_process, fetch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import inquirer from "inquirer";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// === External dependency mocks (hoisted by vitest) ===

vi.mock("figlet", () => ({
  default: { textSync: vi.fn(() => "PACTILE") },
}));

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn().mockResolvedValue({ proceed: true }) },
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockImplementation((cmd: string) => {
    const py = process.platform === "win32" ? "python" : "python3";
    if (cmd === `${py} --version`) {
      return "Python 3.11.12";
    }
    if (cmd === "smart-search doctor --format json") {
      return JSON.stringify({ ok: true, minimum_profile_ok: true });
    }
    return "";
  }),
}));

// === Imports ===

import {
  isWaveCConfirmed,
  WAVE_C_STATE_REL,
} from "../../src/core/task/index.js";
import { init } from "../../src/commands/init.js";
import { update } from "../../src/commands/update.js";
import { VERSION } from "../../src/constants/version.js";
import { DIR_NAMES, FILE_NAMES, PATHS } from "../../src/constants/paths.js";
import { computeHash } from "../../src/utils/template-hash.js";
import { workflowMdTemplate } from "../../src/templates/pactile/index.js";
import { frameworkDocs } from "../../src/templates/markdown/index.js";
import { compareVersions } from "../../src/utils/compare-versions.js";
import { getConfigSectionsAddedBetween } from "../../src/migrations/index.js";
import * as migrations from "../../src/migrations/index.js";
import { getLegacyAllMigrations } from "../helpers/legacy-migrations.js";

/** Breaking-change gate tests stage this legacy path. Skip unless a real rename exists in range. */
const BREAKING_GATE_FROM = ".claude/commands/trellis/before-dev.md";
const breakingMigrationGateApplies = migrations
  .getMigrationsForVersion("0.0.4.0", VERSION)
  .some((m) => m.from === BREAKING_GATE_FROM);

/** #12b stages from 0.0.5.10; Session Auto-Commit append comes from 0.5.11+ manifests. */
const sessionAutoCommitConfigMigrationApplies =
  getConfigSectionsAddedBetween("0.0.5.10", VERSION).some(
    (entry) => entry.sectionHeading === "Session Auto-Commit",
  );

// A managed Node-era template file that update always handles.
const MANAGED_FILE = ".pactile/modules/intake-basic/contract.md";

function capabilityLookupCommand(command: string): string {
  return process.platform === "win32"
    ? `where "${command}"`
    : `command -v '${command}'`;
}

function npmPackageLookupCommand(packageName: string): string {
  return process.platform === "win32"
    ? `npm view "${packageName}" bin --json`
    : `npm view '${packageName}' bin --json`;
}

/** Remove a key from a hash object (avoids eslint no-dynamic-delete) */
function removeHashEntry(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}

/**
 * Read the v2 hashes file and return the inner `hashes` map.
 * Tests manipulate this map then write it back via `writeHashesV2`.
 */
function readHashesV2(hashFile: string): Record<string, string> {
  const raw = JSON.parse(fs.readFileSync(hashFile, "utf-8")) as {
    __version?: number;
    hashes?: Record<string, string>;
  };
  return raw.hashes ?? {};
}

/** Write a v2-shaped hashes file. */
function writeHashesV2(hashFile: string, hashes: Record<string, string>): void {
  fs.writeFileSync(hashFile, JSON.stringify({ __version: 2, hashes }, null, 2));
}

function removeSubagentsSection(content: string): string {
  return content.replace(
    "\n## Subagents\n\n" +
      "- ALWAYS wait for all subagents to complete before yielding.\n" +
      "- Spawn subagents automatically when:\n" +
      "  - Parallelizable work (e.g., install + verify, npm test + typecheck, multiple tasks from plan)\n" +
      "  - Long-running or blocking tasks where a worker can run independently.\n" +
      "  - Isolation for risky changes or checks\n",
    "",
  );
}

describe("update() integration", () => {
  let tmpDir: string;
  /** Original stdin.isTTY descriptor, restored in afterEach. */
  let origIsTTY: PropertyDescriptor | undefined;

  /** Initialize a fresh project in tmpDir */
  async function setupProject(): Promise<void> {
    await init({ yes: true, force: true });
  }

  function projectFile(relativePath: string): string {
    return path.join(tmpDir, relativePath);
  }

  function hashFilePath(): string {
    return projectFile(`${DIR_NAMES.WORKFLOW}/.template-hashes.json`);
  }

  function versionFilePath(): string {
    return projectFile(`${DIR_NAMES.WORKFLOW}/.version`);
  }

  async function runUpdate(
    opts: Parameters<typeof update>[0] = {},
  ): Promise<void> {
    const versionPath = versionFilePath();
    const projectVersion = fs.existsSync(versionPath)
      ? fs.readFileSync(versionPath, "utf-8").trim()
      : "unknown";
    const upgrading =
      projectVersion !== "unknown" &&
      compareVersions(VERSION, projectVersion) > 0;
    await update({
      skipReadiness: true,
      ...(upgrading && !opts.migrate && !opts.dryRun ? { migrate: true } : {}),
      ...opts,
    });
  }

  function readProjectFile(relativePath: string): string {
    return fs.readFileSync(projectFile(relativePath), "utf-8");
  }

  function writeProjectFile(relativePath: string, content: string): void {
    const fullPath = projectFile(relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
  }

  /**
   * Stage a project as if an older Pactile version installed pristine template
   * files, then the current CLI is about to update it. The hash file records
   * the older pristine content so update() must treat those files as
   * auto-update candidates.
   */
  function stageVersionedUpgradeProject(options: {
    fromVersion: string;
    pristineTemplates?: Record<string, string>;
    userModifiedTemplates?: Record<string, string>;
  }): void {
    fs.writeFileSync(versionFilePath(), options.fromVersion);

    const hashes = readHashesV2(hashFilePath());
    for (const [relativePath, content] of Object.entries(
      options.pristineTemplates ?? {},
    )) {
      writeProjectFile(relativePath, content);
      hashes[relativePath] = computeHash(content);
    }
    writeHashesV2(hashFilePath(), hashes);

    for (const [relativePath, content] of Object.entries(
      options.userModifiedTemplates ?? {},
    )) {
      writeProjectFile(relativePath, content);
    }
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-update-int-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    // Simulate an interactive TTY for stdin: update.ts guards its inquirer
    // prompt behind process.stdin.isTTY and hard-fails when stdin is not a TTY
    // (to avoid hanging forever in CI / backgrounded shells). The inquirer
    // module is mocked above, so these tests model the interactive path and
    // must present themselves as a TTY to reach the (mocked) prompt.
    origIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const noop = () => {};
    vi.spyOn(console, "log").mockImplementation(noop);
    vi.spyOn(console, "warn").mockImplementation(noop);
    vi.spyOn(console, "error").mockImplementation(noop);
    vi.mocked(execSync).mockClear();
    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      const py = process.platform === "win32" ? "python" : "python3";
      if (cmd === `${py} --version`) {
        return "Python 3.11.12";
      }
      if (cmd === "smart-search doctor --format json") {
        return JSON.stringify({ ok: true, minimum_profile_ok: true });
      }
      return "";
    }) as typeof execSync);
    // Mock fetch for npm registry
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: VERSION }),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    // Restore the original stdin.isTTY descriptor (undefined under vitest).
    if (origIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", origIsTTY);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    "#1 same version update is a true no-op (zero file changes, no backup)",
    async () => {
      await setupProject();
      await runUpdate({});

      // Full snapshot before update
      const snapshotBefore = new Map<string, string>();
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else
            snapshotBefore.set(
              path.relative(tmpDir, full),
              fs.readFileSync(full, "utf-8"),
            );
        }
      };
      walk(tmpDir);

      await runUpdate({});

      // Full snapshot after update
      const snapshotAfter = new Map<string, string>();
      const walk2 = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk2(full);
          else
            snapshotAfter.set(
              path.relative(tmpDir, full),
              fs.readFileSync(full, "utf-8"),
            );
        }
      };
      walk2(tmpDir);

      // No files added or removed
      const addedFiles = [...snapshotAfter.keys()].filter(
        (k) => !snapshotBefore.has(k),
      );
      const removedFiles = [...snapshotBefore.keys()].filter(
        (k) => !snapshotAfter.has(k),
      );
      expect(addedFiles).toEqual([]);
      expect(removedFiles).toEqual([]);

      // No file contents changed
      const changedFiles: string[] = [];
      for (const [filePath, content] of snapshotBefore) {
        if (snapshotAfter.get(filePath) !== content) {
          changedFiles.push(filePath);
        }
      }
      expect(changedFiles).toEqual([]);

      // No backup directory created
      const entries = fs.readdirSync(path.join(tmpDir, DIR_NAMES.WORKFLOW));
      expect(entries.filter((e) => e.startsWith(".backup-")).length).toBe(0);
    },
    120_000,
  );

  it("retires hash-matched installed Python scripts and preserves user edits", async () => {
    await setupProject();
    const clean = ".pactile/scripts/task.py";
    const modified = ".pactile/scripts/get_context.py";
    writeProjectFile(clean, "# official task script\n");
    writeProjectFile(modified, "# official context script\n");
    const hashes = readHashesV2(hashFilePath());
    hashes[clean] = computeHash(readProjectFile(clean));
    hashes[modified] = computeHash(readProjectFile(modified));
    writeHashesV2(hashFilePath(), hashes);
    writeProjectFile(modified, "# user edit\n");

    await runUpdate({ skipAll: true });
    expect(fs.existsSync(projectFile(clean))).toBe(false);
    expect(readProjectFile(modified)).toBe("# user edit\n");
  });

  it("#1b verifies Smart Search readiness during update", async () => {
    await setupProject();
    vi.mocked(execSync).mockClear();

    await runUpdate({ skipReadiness: false });

    expect(execSync).toHaveBeenCalledWith(
      "smart-search doctor --format json",
      expect.objectContaining({
        encoding: "utf-8",
        stdio: "pipe",
      }),
    );
  });

  it("#1c continues to Proceed? when Smart Search readiness fails", async () => {
    await setupProject();

    const targetFull = path.join(tmpDir, MANAGED_FILE);
    fs.writeFileSync(targetFull, "user customized content");
    const waveCFlag = path.join(tmpDir, WAVE_C_STATE_REL);
    if (fs.existsSync(waveCFlag)) {
      fs.unlinkSync(waveCFlag);
    }

    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      if (cmd === "smart-search doctor --format json") {
        const error = new Error("Command failed: smart-search doctor");
        Object.assign(error, {
          status: 2,
          stdout: JSON.stringify({
            ok: false,
            minimum_profile_ok: false,
            minimum_profile_missing: ["docs_search"],
            error_type: "config_error",
            error: "standard minimum profile is not configured",
          }),
        });
        throw error;
      }
      return "";
    }) as typeof execSync);

    await update({ skipPostUpdateSmoke: true });
    expect(inquirer.prompt).toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/Smart Search readiness unverified/),
    );
    expect(fs.readFileSync(targetFull, "utf-8")).toBe(
      "user customized content",
    );
    expect(isWaveCConfirmed(tmpDir)).toBe(true);
  });

  it("#1d --skip-readiness bypasses Smart Search doctor and allows update writes", async () => {
    await setupProject();

    const targetFull = path.join(tmpDir, MANAGED_FILE);
    const templateContent = fs.readFileSync(targetFull, "utf-8");
    fs.writeFileSync(targetFull, "user customized content");

    vi.mocked(execSync).mockClear();

    await runUpdate({ force: true, skipReadiness: true });

    const calls = vi.mocked(execSync).mock.calls;
    expect(
      calls.some(([cmd]) => cmd === "smart-search doctor --format json"),
    ).toBe(false);
    expect(fs.readFileSync(targetFull, "utf-8")).toBe(templateContent);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("framework readiness is not verified"),
    );
  });

  it("#1e keeps selected project capability templates stable on same-version update", async () => {
    await init({
      yes: true,
      codex: true,
      capability: ["fast-context-mcp", "fastctx"],
    });

    const trackedFiles = [
      `${DIR_NAMES.WORKFLOW}/capabilities.json`,
      `${DIR_NAMES.WORKFLOW}/capabilities.md`,
    ];
    const before = new Map(
      trackedFiles.map((relativePath) => [
        relativePath,
        readProjectFile(relativePath),
      ]),
    );

    await runUpdate({});

    expect(execSync).toHaveBeenCalledWith(
      capabilityLookupCommand("rg"),
      expect.objectContaining({
        encoding: "utf-8",
        stdio: "pipe",
      }),
    );
    expect(execSync).toHaveBeenCalledWith(
      capabilityLookupCommand("npx"),
      expect.objectContaining({
        encoding: "utf-8",
        stdio: "pipe",
      }),
    );
    expect(execSync).toHaveBeenCalledWith(
      npmPackageLookupCommand("fast-context-mcp"),
      expect.objectContaining({
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 5000,
      }),
    );
    expect(execSync).toHaveBeenCalledWith(
      capabilityLookupCommand("npx"),
      expect.objectContaining({
        encoding: "utf-8",
        stdio: "pipe",
      }),
    );
    expect(execSync).toHaveBeenCalledWith(
      npmPackageLookupCommand("@colbymchenry/codegraph"),
      expect.objectContaining({
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 5000,
      }),
    );
    expect(execSync).toHaveBeenCalledWith(
      capabilityLookupCommand("npx"),
      expect.objectContaining({
        encoding: "utf-8",
        stdio: "pipe",
      }),
    );
    for (const relativePath of trackedFiles) {
      expect(readProjectFile(relativePath)).toBe(before.get(relativePath));
    }
    expect(fs.existsSync(projectFile(".cursor/mcp.json"))).toBe(false);
    const entries = fs.readdirSync(path.join(tmpDir, DIR_NAMES.WORKFLOW));
    expect(entries.filter((e) => e.startsWith(".backup-"))).toEqual([]);
  });

  it("#1f continues when selected capability readiness fails (force is not stop-read)", async () => {
    await init({
      yes: true,
      capability: ["codebase-retrieval"],
      force: true,
    });

    const targetFull = path.join(tmpDir, MANAGED_FILE);
    fs.writeFileSync(targetFull, "user customized content");
    const waveCFlag = path.join(tmpDir, WAVE_C_STATE_REL);
    if (fs.existsSync(waveCFlag)) {
      fs.unlinkSync(waveCFlag);
    }

    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      if (cmd === "smart-search doctor --format json") {
        return JSON.stringify({ ok: true, minimum_profile_ok: true });
      }
      if (cmd === capabilityLookupCommand("rg")) {
        throw new Error("rg not found");
      }
      return "";
    }) as typeof execSync);

    await update({ force: true, skipPostUpdateSmoke: true });
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/codebase-retrieval capability unverified/),
    );
    expect(fs.readFileSync(targetFull, "utf-8")).not.toBe(
      "user customized content",
    );
    expect(isWaveCConfirmed(tmpDir)).toBe(false);
  });

  it("#2b dry run with --json emits structured rollout evidence without mutating", async () => {
    await setupProject();

    const target = path.join(tmpDir, MANAGED_FILE);
    const hashFile = path.join(
      tmpDir,
      DIR_NAMES.WORKFLOW,
      ".template-hashes.json",
    );
    const hashes = removeHashEntry(
      readHashesV2(hashFile),
      MANAGED_FILE,
    ) as Record<string, string>;
    writeHashesV2(hashFile, hashes);
    fs.unlinkSync(target);

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await runUpdate({ dryRun: true, json: true, skipReadiness: true });

    expect(fs.existsSync(target)).toBe(false);
    const jsonLine = stdoutSpy.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.startsWith("{") && line.includes('"outcome"'));
    expect(jsonLine).toBeDefined();
    if (!jsonLine) {
      throw new Error("expected JSON rollout line on stdout");
    }
    const report = JSON.parse(jsonLine) as {
      mode: string;
      outcome: string;
      plan: { files: { added: string[] } };
    };
    expect(report.mode).toBe("dry-run");
    expect(report.outcome).toBe("would_apply");
    expect(report.plan.files.added).toContain(MANAGED_FILE);

    stdoutSpy.mockRestore();
  });

  it("#2 dry run makes no file changes even when changes exist", async () => {
    await setupProject();

    // Delete hash + file to simulate a truly new template file
    const target = path.join(tmpDir, MANAGED_FILE);
    const hashFile = path.join(
      tmpDir,
      DIR_NAMES.WORKFLOW,
      ".template-hashes.json",
    );
    const hashes = removeHashEntry(
      readHashesV2(hashFile),
      MANAGED_FILE,
    ) as Record<string, string>;
    writeHashesV2(hashFile, hashes);
    fs.unlinkSync(target);

    await runUpdate({ dryRun: true });

    // File should still be missing (dry run didn't recreate it)
    expect(fs.existsSync(target)).toBe(false);
    // No backup directory created
    const entries = fs.readdirSync(path.join(tmpDir, DIR_NAMES.WORKFLOW));
    expect(entries.filter((e) => e.startsWith(".backup-")).length).toBe(0);
  });

  it("#3 user-deleted file (with stored hash) is not re-added on update", async () => {
    await setupProject();

    const target = path.join(tmpDir, MANAGED_FILE);
    expect(fs.existsSync(target)).toBe(true);

    // Delete it (simulating user deletion; hash still exists in .template-hashes.json)
    fs.unlinkSync(target);
    expect(fs.existsSync(target)).toBe(false);

    await runUpdate({ force: true });

    // File should NOT be re-created (user deleted it, hash still exists)
    expect(fs.existsSync(target)).toBe(false);
  });

  it("#4 auto-updates file when template changed but user did not modify", async () => {
    await setupProject();

    const targetRelative = MANAGED_FILE;
    const targetFull = path.join(tmpDir, targetRelative);
    const templateContent = fs.readFileSync(targetFull, "utf-8");

    // Simulate "old template version": change file + update hash to match
    const oldContent = "# Old version of script\n";
    fs.writeFileSync(targetFull, oldContent);

    const hashFile = path.join(
      tmpDir,
      DIR_NAMES.WORKFLOW,
      ".template-hashes.json",
    );
    const hashes = readHashesV2(hashFile);
    hashes[targetRelative] = computeHash(oldContent);
    writeHashesV2(hashFile, hashes);

    await runUpdate({ force: true });

    // File should be auto-updated back to current template
    expect(fs.readFileSync(targetFull, "utf-8")).toBe(templateContent);
  });

  it("#4b preserves a locally reframed AGENTS.md outside-content envelope", async () => {
    await setupProject();

    const targetRelative = FILE_NAMES.AGENTS;
    const targetFull = path.join(tmpDir, targetRelative);
    const templateContent = fs.readFileSync(targetFull, "utf-8");
    const oldContent = removeSubagentsSection(templateContent);
    const existingContent = `# Local instructions\n\n${oldContent}\n\n## Project Notes\n\nKeep this.`;

    fs.writeFileSync(targetFull, existingContent);

    const hashFile = path.join(
      tmpDir,
      DIR_NAMES.WORKFLOW,
      ".template-hashes.json",
    );
    const hashes = removeHashEntry(
      readHashesV2(hashFile),
      targetRelative,
    ) as Record<string, string>;
    writeHashesV2(hashFile, hashes);

    await runUpdate({});

    expect(fs.readFileSync(targetFull, "utf-8")).toBe(existingContent);
    expect(readHashesV2(hashFile)[targetRelative]).toBeUndefined();
  });

  it("#4c preserves user-modified untracked AGENTS.md managed block", async () => {
    await setupProject();

    const targetRelative = FILE_NAMES.AGENTS;
    const targetFull = path.join(tmpDir, targetRelative);
    const templateContent = fs.readFileSync(targetFull, "utf-8");
    const modifiedOldContent = removeSubagentsSection(templateContent).replace(
      "# Pactile (pactile)",
      "# Custom Pactile Instructions",
    );
    fs.writeFileSync(targetFull, modifiedOldContent);

    const hashFile = path.join(
      tmpDir,
      DIR_NAMES.WORKFLOW,
      ".template-hashes.json",
    );
    const hashes = removeHashEntry(
      readHashesV2(hashFile),
      targetRelative,
    ) as Record<string, string>;
    writeHashesV2(hashFile, hashes);

    await runUpdate({ skipAll: true });

    expect(fs.readFileSync(targetFull, "utf-8")).toBe(modifiedOldContent);
  });

  it("#4d preserves a user-replaced AGENTS.md even under force", async () => {
    await setupProject();

    const targetRelative = FILE_NAMES.AGENTS;
    const targetFull = path.join(tmpDir, targetRelative);
    // Replacing a projected file destroys generated-byte evidence. Force only
    // resolves template conflicts; it is not authority to overwrite a foreign
    // or modified ProjectionStore target.
    const userContent = "# Project notes\n\nThings the team agreed on.\n";
    fs.writeFileSync(targetFull, userContent);

    await runUpdate({ force: true });

    const result = fs.readFileSync(targetFull, "utf-8");
    expect(result).toBe(userContent);
  });

  it("#5 force overwrites user-modified files", async () => {
    await setupProject();

    const targetFull = path.join(tmpDir, MANAGED_FILE);
    const templateContent = fs.readFileSync(targetFull, "utf-8");

    // User modifies file (hash won't match)
    fs.writeFileSync(targetFull, "user customized content");

    await runUpdate({ force: true });

    expect(fs.readFileSync(targetFull, "utf-8")).toBe(templateContent);
  });

  it("#5b force mode does not prompt for final confirmation", async () => {
    await setupProject();

    const targetFull = path.join(tmpDir, MANAGED_FILE);
    fs.writeFileSync(targetFull, "user customized content");
    vi.mocked(inquirer.prompt).mockClear();

    await runUpdate({ force: true });

    expect(inquirer.prompt).not.toHaveBeenCalled();
  });

  it("#6 skipAll preserves user-modified files", async () => {
    await setupProject();

    const targetFull = path.join(tmpDir, MANAGED_FILE);
    fs.writeFileSync(targetFull, "user customized content");

    await runUpdate({ skipAll: true });

    expect(fs.readFileSync(targetFull, "utf-8")).toBe(
      "user customized content",
    );
  });

  it("#7 createNew creates .new copy without overwriting original", async () => {
    await setupProject();

    const targetFull = path.join(tmpDir, MANAGED_FILE);
    const templateContent = fs.readFileSync(targetFull, "utf-8");
    fs.writeFileSync(targetFull, "user customized content");

    await runUpdate({ createNew: true });

    // Original preserved
    expect(fs.readFileSync(targetFull, "utf-8")).toBe(
      "user customized content",
    );
    // .new file created with template content
    const newFile = targetFull + ".new";
    expect(fs.existsSync(newFile)).toBe(true);
    expect(fs.readFileSync(newFile, "utf-8")).toBe(templateContent);
  });

  it("#8 updates version file after successful update", async () => {
    await setupProject();

    // Simulate older project version
    const versionPath = path.join(tmpDir, DIR_NAMES.WORKFLOW, ".version");
    fs.writeFileSync(versionPath, "0.0.1");

    await runUpdate({ force: true });

    // Version is updated even when no file changes are needed
    expect(fs.readFileSync(versionPath, "utf-8")).toBe(VERSION);
  });

  it("#9 creates backup directory before applying changes", async () => {
    await setupProject();

    // Simulate "old template version": change file + update hash to match
    // This triggers auto-update (template changed, user didn't modify)
    const targetFull = path.join(tmpDir, MANAGED_FILE);
    const oldContent = "# Old version of script\n";
    fs.writeFileSync(targetFull, oldContent);
    const hashFile = path.join(
      tmpDir,
      DIR_NAMES.WORKFLOW,
      ".template-hashes.json",
    );
    const hashes = readHashesV2(hashFile);
    hashes[MANAGED_FILE] = computeHash(oldContent);
    writeHashesV2(hashFile, hashes);

    await runUpdate({ force: true });

    const entries = fs.readdirSync(path.join(tmpDir, DIR_NAMES.WORKFLOW));
    const backupDirs = entries.filter((e) => e.startsWith(".backup-"));
    expect(backupDirs.length).toBeGreaterThanOrEqual(1);
  });

  it("#10 downgrade protection prevents update when CLI is older", async () => {
    await setupProject();

    // Set project version to future
    const versionPath = path.join(tmpDir, DIR_NAMES.WORKFLOW, ".version");
    fs.writeFileSync(versionPath, "99.99.99");

    await runUpdate({});

    // Version should NOT be changed
    expect(fs.readFileSync(versionPath, "utf-8")).toBe("99.99.99");
  });

  it("#11 allowDowngrade permits update when CLI is older", async () => {
    await setupProject();

    const versionPath = path.join(tmpDir, DIR_NAMES.WORKFLOW, ".version");
    fs.writeFileSync(versionPath, "99.99.99");

    // Remove hash entry + file to simulate a truly new template file
    const target = path.join(tmpDir, MANAGED_FILE);
    const hashFile = path.join(
      tmpDir,
      DIR_NAMES.WORKFLOW,
      ".template-hashes.json",
    );
    const hashes = removeHashEntry(
      readHashesV2(hashFile),
      MANAGED_FILE,
    ) as Record<string, string>;
    writeHashesV2(hashFile, hashes);
    fs.unlinkSync(target);

    await runUpdate({ allowDowngrade: true, force: true });

    // File recreated (truly new — no stored hash)
    expect(fs.existsSync(target)).toBe(true);
    // Version updated to current
    expect(fs.readFileSync(versionPath, "utf-8")).toBe(VERSION);
  });

  it("#12 prerelease→stable upgrade with no file changes still updates .version", async () => {
    await setupProject();

    // Simulate a project at rc.6 (identical templates, just different version stamp)
    const versionPath = versionFilePath();
    fs.writeFileSync(versionPath, "0.0.3-rc.6");

    await runUpdate({});

    // .version must be updated to the current CLI version
    expect(fs.readFileSync(versionPath, "utf-8")).toBe(VERSION);
  });

  it("#12b versioned upgrade scenario applies auto-updates, additive config sections, and modified-file skips", async () => {
    await setupProject();

    const expectedWorkflow = workflowMdTemplate;
    const expectedGetContext = readProjectFile(MANAGED_FILE);
    const userModifiedScript = `${PATHS.SCRIPTS}/add_session.py`;
    const userModifiedScriptContent = "# user customized add_session.py\n";
    const oldConfigWithoutSessionAutoCommit =
      "max_journal_lines: 2000\n\n" +
      "# Local 0.5.10 config customization that must survive update.\n";
    const oldWorkflow =
      "# Workflow\n\n" +
      "## Phase Index\n\n" +
      "[workflow-state:in_progress]\nlegacy body\n[/workflow-state:in_progress]\n\n" +
      "#### 2.1 Implement `[required · repeatable]`\n\n" +
      "[Codex]\nSpawn the implement sub-agent:\n[/Codex]\n\n" +
      "[Kilo, Antigravity, Windsurf]\n" +
      "1. Load the `pactile-before-dev` skill to read project guidelines\n" +
      "[/Kilo, Antigravity, Windsurf]\n";

    stageVersionedUpgradeProject({
      fromVersion: "0.0.5.10",
      pristineTemplates: {
        [PATHS.WORKFLOW_GUIDE_FILE]: oldWorkflow,
        [MANAGED_FILE]: "# old get_context.py from installed template\n",
      },
      userModifiedTemplates: {
        [`${DIR_NAMES.WORKFLOW}/config.yaml`]:
          oldConfigWithoutSessionAutoCommit,
        [userModifiedScript]: userModifiedScriptContent,
      },
    });

    await runUpdate({ skipAll: true });

    expect(fs.readFileSync(versionFilePath(), "utf-8")).toBe(VERSION);

    // Hash-tracked pristine templates from the older install are whole-file
    // auto-updated to the current packaged template.
    expect(readProjectFile(PATHS.WORKFLOW_GUIDE_FILE)).toBe(expectedWorkflow);
    expect(readProjectFile(MANAGED_FILE)).toBe(expectedGetContext);
    expect(readProjectFile(PATHS.WORKFLOW_GUIDE_FILE)).toContain(
      "## Interfaces",
    );
    expect(readProjectFile(PATHS.WORKFLOW_GUIDE_FILE)).toContain(
      "[workflow-state:in_progress]",
    );
    expect(readProjectFile(PATHS.WORKFLOW_GUIDE_FILE)).not.toContain(
      "Request Triage",
    );
    expect(readProjectFile(PATHS.WORKFLOW_GUIDE_FILE)).not.toContain(
      "[Codex]",
    );

    // Version-specific additive config sections still apply to a user-modified
    // config.yaml, while preserving the local content around the append.
    const updatedConfig = readProjectFile(`${DIR_NAMES.WORKFLOW}/config.yaml`);
    expect(updatedConfig).toContain(
      "Local 0.5.10 config customization that must survive update.",
    );
    if (sessionAutoCommitConfigMigrationApplies) {
      expect(updatedConfig).toContain("Session Auto-Commit");
      expect(updatedConfig).toContain("session_auto_commit: true");
    }

    // User-modified template files are skipped under skipAll and their hashes
    // are not rewritten to bless the local modification as a template.
    expect(readProjectFile(userModifiedScript)).toBe(
      userModifiedScriptContent,
    );
    const hashes = readHashesV2(hashFilePath());
    expect(hashes[PATHS.WORKFLOW_GUIDE_FILE]).toBe(
      computeHash(expectedWorkflow),
    );
    expect(hashes[MANAGED_FILE]).toBe(computeHash(expectedGetContext));
    expect(hashes[userModifiedScript]).not.toBe(
      computeHash(userModifiedScriptContent),
    );
  });

  it("#13 user-edited spec/guides files are preserved after update with force", async () => {
    await setupProject();

    // User customizes a spec guides file
    const guidesIndex = path.join(tmpDir, PATHS.SPEC, "guides", "index.md");
    expect(fs.existsSync(guidesIndex)).toBe(true);
    const customContent = "# My Custom Guides\n\nEdited by user.\n";
    fs.writeFileSync(guidesIndex, customContent);

    await runUpdate({ force: true });

    // User's customized content must be preserved (update should not touch spec/)
    expect(fs.readFileSync(guidesIndex, "utf-8")).toBe(customContent);
  });

  it("#14 deleted spec directory is NOT recreated by update", async () => {
    await setupProject();

    // User deletes the entire spec directory
    const specDir = path.join(tmpDir, PATHS.SPEC);
    fs.rmSync(specDir, { recursive: true, force: true });
    expect(fs.existsSync(specDir)).toBe(false);

    await runUpdate({ force: true });

    // spec/ directory should NOT be recreated by update
    expect(fs.existsSync(specDir)).toBe(false);
  });

  it("#15 truly new file (no stored hash) is still added", async () => {
    await setupProject();

    // The hash file should exist
    const hashFile = path.join(
      tmpDir,
      DIR_NAMES.WORKFLOW,
      ".template-hashes.json",
    );
    const hashes = removeHashEntry(
      readHashesV2(hashFile),
      MANAGED_FILE,
    ) as Record<string, string>;

    // Remove a hash entry AND the file (simulates a truly new template)
    const targetPath = path.join(tmpDir, MANAGED_FILE);
    writeHashesV2(hashFile, hashes);
    fs.unlinkSync(targetPath);

    // Run update
    await runUpdate({ force: true });

    // File SHOULD be created (no hash = truly new)
    expect(fs.existsSync(targetPath)).toBe(true);
  });

  it("#16 config.yaml update.skip prevents file from being updated", async () => {
    await setupProject();

    // Pick a managed template file
    const targetPath = path.join(tmpDir, MANAGED_FILE);

    // Add skip config
    const configPath = path.join(tmpDir, DIR_NAMES.WORKFLOW, "config.yaml");
    const configContent = fs.readFileSync(configPath, "utf-8");
    fs.writeFileSync(
      configPath,
      configContent + `\nupdate:\n  skip:\n    - ${MANAGED_FILE}\n`,
    );

    // Modify the file so it would normally trigger a change
    fs.writeFileSync(targetPath, "# modified by user\n");

    // Run update
    await runUpdate({ force: true });

    // File should NOT be overwritten (it's in skip list)
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("# modified by user\n");
  });

  it("#17 config.yaml update.skip with directory path skips all files under it", async () => {
    await setupProject();

    // Add skip config for a managed Node module directory.
    const configPath = path.join(tmpDir, DIR_NAMES.WORKFLOW, "config.yaml");
    const configContent = fs.readFileSync(configPath, "utf-8");
    const skipDir = ".pactile/modules/intake-basic/";
    fs.writeFileSync(
      configPath,
      configContent + `\nupdate:\n  skip:\n    - ${skipDir}\n`,
    );

    // Modify a file under the skipped directory
    const targetPath = path.join(tmpDir, MANAGED_FILE);
    expect(fs.existsSync(targetPath)).toBe(true);
    fs.writeFileSync(targetPath, "# user modified module\n");

    // Run update
    await runUpdate({ force: true });

    // File should NOT be overwritten (its directory is in skip list)
    expect(fs.readFileSync(targetPath, "utf-8")).toBe(
      "# user modified module\n",
    );
  });

  it("#18 safe-file-delete preserves user-modified deprecated file", async () => {
    const allMigrationsSpy = vi
      .spyOn(migrations, "getAllMigrations")
      .mockReturnValue(getLegacyAllMigrations());
    try {
      await setupProject();

      // Create a deprecated file that exists in the 0.4.0-beta.1 safe-file-delete manifest
      // but with user-modified content (hash won't match allowed_hashes)
      const deprecatedDir = path.join(tmpDir, ".claude", "commands", "trellis");
      fs.mkdirSync(deprecatedDir, { recursive: true });
      const deprecatedFile = path.join(deprecatedDir, "before-backend-dev.md");
      const userContent =
        "# My customized before-backend-dev command\nUser edited this.\n";
      fs.writeFileSync(deprecatedFile, userContent);

      await runUpdate({ force: true });

      // File should be preserved (hash doesn't match allowed_hashes)
      expect(fs.existsSync(deprecatedFile)).toBe(true);
      expect(fs.readFileSync(deprecatedFile, "utf-8")).toBe(userContent);
    } finally {
      allMigrationsSpy.mockRestore();
    }
  });

  it("#19 safe-file-delete handles missing deprecated files without crash", async () => {
    const allMigrationsSpy = vi
      .spyOn(migrations, "getAllMigrations")
      .mockReturnValue(getLegacyAllMigrations());
    try {
      await setupProject();

      // Simulate upgrading from an old version — deprecated files don't exist
      // The manifest has safe-file-delete entries for .claude/commands/trellis/before-backend-dev.md etc.
      // but init() doesn't create them (templates removed). update() should not crash.
      const versionPath = path.join(tmpDir, DIR_NAMES.WORKFLOW, ".version");
      fs.writeFileSync(versionPath, "0.0.3.7");

      // This should complete without errors even though deprecated files don't exist
      await runUpdate({ force: true });

      // Version updated successfully
      expect(fs.readFileSync(versionPath, "utf-8")).toBe(VERSION);
    } finally {
      allMigrationsSpy.mockRestore();
    }
  });

  // Original template content for check-backend.md (deleted in 0.4.0-beta.1).
  // Hash: 4e81a28d681ea770f780df55a212fd504ce21ee49b44ba16023b74b5c243cef3 (.trellis paths — legacy manifest)
  const ORIGINAL_CHECK_BACKEND_CONTENT = [
    "Check if the code you just wrote follows the backend development guidelines.",
    "",
    "Execute these steps:",
    "1. Run `git status` to see modified files",
    "2. Read `.trellis/spec/backend/index.md` to understand which guidelines apply",
    "3. Based on what you changed, read the relevant guideline files:",
    "   - Database changes → `.trellis/spec/backend/database-guidelines.md`",
    "   - Error handling → `.trellis/spec/backend/error-handling.md`",
    "   - Logging changes → `.trellis/spec/backend/logging-guidelines.md`",
    "   - Type changes → `.trellis/spec/backend/type-safety.md`",
    "   - Any changes → `.trellis/spec/backend/quality-guidelines.md`",
    "4. Review your code against the guidelines",
    "5. Report any violations and fix them if found",
    "",
  ].join("\n");

  it("#20 safe-file-delete respects update.skip for deprecated files", async () => {
    const allMigrationsSpy = vi
      .spyOn(migrations, "getAllMigrations")
      .mockReturnValue(getLegacyAllMigrations());
    try {
      await setupProject();

    // Sanity: content hash must match the manifest's allowed_hashes
    expect(computeHash(ORIGINAL_CHECK_BACKEND_CONTENT)).toBe(
      "4e81a28d681ea770f780df55a212fd504ce21ee49b44ba16023b74b5c243cef3",
    );

    // Create a deprecated file with original content (hash matches allowed_hashes)
    // Without update.skip, collectSafeFileDeletes() would delete this file.
    const deprecatedDir = path.join(tmpDir, ".claude", "commands", "trellis");
    fs.mkdirSync(deprecatedDir, { recursive: true });
    const deprecatedFile = path.join(deprecatedDir, "check-backend.md");
    fs.writeFileSync(deprecatedFile, ORIGINAL_CHECK_BACKEND_CONTENT);

    // Add the deprecated file's directory to update.skip
    const configPath = path.join(tmpDir, DIR_NAMES.WORKFLOW, "config.yaml");
    const configContent = fs.readFileSync(configPath, "utf-8");
    fs.writeFileSync(
      configPath,
      configContent + `\nupdate:\n  skip:\n    - .claude/commands/trellis/\n`,
    );

    await runUpdate({ force: true });

    // File should be preserved (directory is in update.skip, overriding safe-file-delete)
    expect(fs.existsSync(deprecatedFile)).toBe(true);
    expect(fs.readFileSync(deprecatedFile, "utf-8")).toBe(
      ORIGINAL_CHECK_BACKEND_CONTENT,
    );
    } finally {
      allMigrationsSpy.mockRestore();
    }
  });

  it("#21 safe-file-delete deletes file when hash matches allowed_hashes", async () => {
    const allMigrationsSpy = vi
      .spyOn(migrations, "getAllMigrations")
      .mockReturnValue(getLegacyAllMigrations());
    try {
      await setupProject();

    // Sanity: content hash must match the manifest's allowed_hashes
    expect(computeHash(ORIGINAL_CHECK_BACKEND_CONTENT)).toBe(
      "4e81a28d681ea770f780df55a212fd504ce21ee49b44ba16023b74b5c243cef3",
    );

    // Create deprecated file with original content (hash matches allowed_hashes)
    const deprecatedDir = path.join(tmpDir, ".claude", "commands", "trellis");
    fs.mkdirSync(deprecatedDir, { recursive: true });
    const deprecatedFile = path.join(deprecatedDir, "check-backend.md");
    fs.writeFileSync(deprecatedFile, ORIGINAL_CHECK_BACKEND_CONTENT);

    await runUpdate({ force: true });

    // File should be DELETED (hash matched allowed_hashes, no update.skip protection)
    expect(fs.existsSync(deprecatedFile)).toBe(false);
    } finally {
      allMigrationsSpy.mockRestore();
    }
  });

  // Claude statusLine preservation removed in cursor-only fork.

  /** Simulate a 0.4.0 project by writing a legacy command file that the manifest renames */
  function stageLegacy040Project(): void {
    const versionPath = path.join(tmpDir, DIR_NAMES.WORKFLOW, ".version");
    fs.writeFileSync(versionPath, "0.0.4.0");
    // Create one legacy file that matches a `rename` in the upgrade path
    // (currently none on this line — tests skip via breakingMigrationGateApplies).
    // Without a matching rename, classifyMigrations finds no work → early-exit before gate.
    const legacyDir = path.join(tmpDir, ".claude", "commands", "trellis");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "before-dev.md"), "legacy content");
  }

  /** Delete the post-init target so classifyMigrations hits the "new doesn't exist"
   *  branch and respects `isTemplateModified` on the source (→ confirm bucket). */
  function clearMigrationTarget(): void {
    fs.rmSync(path.join(tmpDir, ".claude/skills/trellis-before-dev"), {
      recursive: true,
      force: true,
    });
  }

  it.skipIf(!breakingMigrationGateApplies)(
    "#22 breaking-change gate exits 1 when --migrate is missing",
    async () => {
    await setupProject();
    stageLegacy040Project();

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    await runUpdate({});

    expect(exitSpy).toHaveBeenCalledWith(1);
    },
  );

  it.skipIf(!breakingMigrationGateApplies)(
    "#23 breaking-change gate allows --dry-run without --migrate",
    async () => {
    await setupProject();
    stageLegacy040Project();

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    await runUpdate({ dryRun: true });

    // Gate must not fire for preview mode (users need to inspect before migrating)
    expect(exitSpy).not.toHaveBeenCalled();
    },
  );

  it.skipIf(!breakingMigrationGateApplies)(
    "#24 breaking-change gate allows --migrate to proceed",
    async () => {
    await setupProject();
    stageLegacy040Project();

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    await runUpdate({ migrate: true, force: true });

    // Gate passes when --migrate is present; update proceeds to completion
    expect(exitSpy).not.toHaveBeenCalled();
    // Version must advance to current CLI after the migrate run
    const versionPath = path.join(tmpDir, DIR_NAMES.WORKFLOW, ".version");
    expect(fs.readFileSync(versionPath, "utf-8")).toBe(VERSION);
    },
  );

  // The [b] Backup-rename path in the confirm prompt promises "keeps a .backup
  // copy". Previously it was identical to [r] (both relied on the full project
  // snapshot). We now write an INLINE .backup next to the new path so users can
  // diff/merge their customizations without digging through .cstl/.backup-*/.
  /** Install a mock that returns a specific migration choice for the per-file prompt
   *  and {proceed: true} for the top-level confirm. Resolves the flakiness of
   *  matching on `name` field in the dynamic import path. */
  async function installChoiceMock(
    choice: "rename" | "backup-rename" | "skip",
  ) {
    const inquirer = (await import("inquirer")).default;
    vi.mocked(inquirer.prompt).mockImplementation(((questions: unknown) => {
      const q = Array.isArray(questions) ? questions[0] : questions;
      const name = (q as { name?: string }).name;
      if (name === "choice") return Promise.resolve({ choice });
      return Promise.resolve({ proceed: true });
    }) as never);
  }

  // The [b] Backup-rename path in the confirm prompt promises "keeps a .backup
  // copy". Previously it was identical to [r] (both relied on the full project
  // snapshot). We now write an INLINE .backup next to the new path so users can
  // diff/merge their customizations without digging through .cstl/.backup-*/.
  it.skipIf(!breakingMigrationGateApplies)(
    "#25 backup-rename leaves inline <new-path>.backup with original content",
    async () => {
    await setupProject();
    stageLegacy040Project();
    clearMigrationTarget();

    // User-modified content that differs from the 0.5 template (forces confirm)
    const legacyPath = path.join(
      tmpDir,
      ".claude/commands/trellis/before-dev.md",
    );
    const userContent = "## My custom before-dev notes\nEdited by user.\n";
    fs.writeFileSync(legacyPath, userContent);

    await installChoiceMock("backup-rename");

    await runUpdate({ migrate: true });

    // After migration:
    //   - new-path exists (rename completed)
    //   - new-path.backup exists with the user's content (inline preservation)
    //   - old-path is gone
    const newPath = path.join(
      tmpDir,
      ".claude/skills/trellis-before-dev/SKILL.md",
    );
    expect(fs.existsSync(newPath)).toBe(true);
    expect(fs.existsSync(newPath + ".backup")).toBe(true);
    expect(fs.readFileSync(newPath + ".backup", "utf-8")).toBe(userContent);
    expect(fs.existsSync(legacyPath)).toBe(false);
    },
  );

  it.skipIf(!breakingMigrationGateApplies)(
    "#26 rename-anyway does NOT leave an inline .backup (relies on project snapshot)",
    async () => {
    await setupProject();
    stageLegacy040Project();
    clearMigrationTarget();

    const legacyPath = path.join(
      tmpDir,
      ".claude/commands/trellis/before-dev.md",
    );
    fs.writeFileSync(legacyPath, "## user edits\n");

    await installChoiceMock("rename");

    await runUpdate({ migrate: true });

    const newPath = path.join(
      tmpDir,
      ".claude/skills/trellis-before-dev/SKILL.md",
    );
    expect(fs.existsSync(newPath)).toBe(true);
    // No inline .backup — the full-project snapshot under .cstl/.backup-*
    // is the single source of recovery for this mode.
    expect(fs.existsSync(newPath + ".backup")).toBe(false);
    },
  );

  it("#27 backup skips managed node_modules dependency trees", async () => {
    await setupProject();

    const workflowRoot = path.join(tmpDir, ".pactile");
    fs.mkdirSync(path.join(workflowRoot, "node_modules", "zod"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(workflowRoot, "package.json"), "{}\n");
    fs.writeFileSync(
      path.join(workflowRoot, "node_modules", "zod", "index.js"),
      "module.exports = {};\n",
    );

    const targetFull = path.join(tmpDir, MANAGED_FILE);
    fs.writeFileSync(targetFull, "user customized content");

    await runUpdate({ force: true });

    const entries = fs.readdirSync(path.join(tmpDir, DIR_NAMES.WORKFLOW));
    const backupDirs = entries.filter((e) => e.startsWith(".backup-"));
    expect(backupDirs.length).toBe(1);

    const backupDir = path.join(
      tmpDir,
      DIR_NAMES.WORKFLOW,
      backupDirs[0] as string,
    );
    expect(
      fs.existsSync(path.join(backupDir, ".pactile", "package.json")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(backupDir, ".pactile", "node_modules")),
    ).toBe(false);
  });

  it("#workflow-md-r4 updates workflow.md as one interface-card template when hash-tracked", async () => {
    await setupProject();

    const workflowPath = path.join(tmpDir, PATHS.WORKFLOW_GUIDE_FILE);
    const staleWorkflow =
      "# Workflow\n\n" +
      "## Phase Index\n\n" +
      "[workflow-state:in_progress]\nlegacy body\n[/workflow-state:in_progress]\n\n" +
      "#### 2.1 Implement `[required · repeatable]`\n\n" +
      "[Codex]\nSpawn the implement sub-agent:\n[/Codex]\n\n" +
      "[Kilo, Antigravity, Windsurf]\n" +
      "1. Load the `pactile-before-dev` skill to read project guidelines\n" +
      "[/Kilo, Antigravity, Windsurf]\n";

    fs.writeFileSync(workflowPath, staleWorkflow, "utf-8");

    // Simulate an older installed workflow.md that is still pristine relative
    // to the version that installed it. Update must replace the whole managed
    // file, removing stale long-form workflow teaching and platform markers.
    const hashFile = path.join(
      tmpDir,
      DIR_NAMES.WORKFLOW,
      ".template-hashes.json",
    );
    const hashes = readHashesV2(hashFile);
    hashes[PATHS.WORKFLOW_GUIDE_FILE] = computeHash(staleWorkflow);
    writeHashesV2(hashFile, hashes);

    await runUpdate({ force: true });

    const updated = fs.readFileSync(workflowPath, "utf-8");
    expect(updated).toBe(workflowMdTemplate);
    expect(updated).toMatch(/Human overview[^\n]*not runtime SSOT/i);
    expect(updated).toContain("## Interfaces");
    expect(updated).toContain("[workflow-state:in_progress]");
    expect(updated).not.toContain("Request Triage");
    expect(updated).not.toContain("[Triage:");
    expect(updated).not.toContain("[Codex]");
    expect(updated).not.toContain("legacy body");

    expect(readHashesV2(hashFile)[PATHS.WORKFLOW_GUIDE_FILE]).toBe(
      computeHash(updated),
    );
  });

  // --- Non-interactive (no stdin TTY) hard-fail guard ---
  // update() must not hang on inquirer.prompt when stdin is not a TTY (CI,
  // backgrounded shells, redirected stdin). Without an explicit consent flag
  // (--force/--skip-all/--create-new) or --dry-run, it exits 1 with guidance.

  it("#non-tty without consent flag exits 1 instead of hanging on prompt", async () => {
    await setupProject();
    // Force a real change so update reaches the confirm gate (not the
    // same-version no-op early exit).
    const targetFull = path.join(tmpDir, MANAGED_FILE);
    const pristine = fs.readFileSync(targetFull, "utf-8");
    fs.writeFileSync(targetFull, pristine + "\n# user tweak\n");

    // Simulate non-interactive stdin (what vitest/CI/background shells see).
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });

    await expect(update({})).rejects.toThrow(
      /Non-interactive.*requires an explicit consent flag/,
    );
  });

  it("#non-tty with --force still applies (consent flag bypasses TTY guard)", async () => {
    await setupProject();
    const targetFull = path.join(tmpDir, MANAGED_FILE);
    const pristine = fs.readFileSync(targetFull, "utf-8");
    fs.writeFileSync(targetFull, pristine + "\n# user tweak\n");

    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });

    // --force is explicit consent; must not hit the TTY guard.
    await runUpdate({ force: true, skipReadiness: true });
    expect(fs.readFileSync(targetFull, "utf-8")).toBe(pristine);
  });

  // === Commands-only policy skill residue cleanup (v0.2.10) ===
  // These tests verify safe-file-delete removes stale .cursor/skills/ from
  // projects initialized before the commands-only policy (v0.2.8).

  /** Read the real 0.2.10 manifest's migration entries from disk. */
  function readCursorResidueManifest(): migrations.MigrationItem[] {
    const manifestPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src/migrations/manifests/0.2.10.json",
    );
    return (JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
      migrations: migrations.MigrationItem[];
    }).migrations;
  }

  it("#cursor-skill-residue-1 safe-file-delete removes pristine .cursor/skills/ brainstorm SKILL.md", async () => {
    const manifestEntries = readCursorResidueManifest();
    const allMigrationsSpy = vi
      .spyOn(migrations, "getAllMigrations")
      .mockReturnValue(manifestEntries);
    try {
      await setupProject();

      // Simulate a stale .cursor/skills/ residue from pre-commands-only init.
      const skillDir = path.join(tmpDir, ".cursor", "skills", "trellis-brainstorm");
      fs.mkdirSync(skillDir, { recursive: true });
      const skillFile = path.join(skillDir, "SKILL.md");

      // Write test content and patch the manifest entry's allowed_hashes to
      // accept it (we test the deletion mechanism, not historical content).
      const testContent =
        "---\nname: trellis-brainstorm\ndescription: test\n---\n# test\n";
      fs.writeFileSync(skillFile, testContent);

      const patched = manifestEntries.map((m) =>
        m.from === ".cursor/skills/trellis-brainstorm/SKILL.md"
          ? { ...m, allowed_hashes: [computeHash(testContent)] }
          : m,
      );
      allMigrationsSpy.mockReturnValue(patched);

      expect(fs.existsSync(skillFile)).toBe(true);

      await runUpdate({ force: true });

      // Pristine file deleted by safe-file-delete.
      expect(fs.existsSync(skillFile)).toBe(false);
    } finally {
      allMigrationsSpy.mockRestore();
    }
  });

  it("#cursor-skill-residue-2 safe-file-delete preserves user-modified skill file", async () => {
    const allMigrationsSpy = vi
      .spyOn(migrations, "getAllMigrations")
      .mockReturnValue(readCursorResidueManifest());
    try {
      await setupProject();

      const skillDir = path.join(tmpDir, ".cursor", "skills", "trellis-brainstorm");
      fs.mkdirSync(skillDir, { recursive: true });
      const skillFile = path.join(skillDir, "SKILL.md");
      const userContent =
        "---\nname: trellis-brainstorm\ndescription: MY CUSTOM EDITS\n---\n# customized\n";
      fs.writeFileSync(skillFile, userContent);

      // Manifest's real allowed_hashes won't match user content
      await runUpdate({ force: true });

      // User-modified file preserved (hash mismatch → skip-modified)
      expect(fs.existsSync(skillFile)).toBe(true);
      expect(fs.readFileSync(skillFile, "utf-8")).toBe(userContent);
    } finally {
      allMigrationsSpy.mockRestore();
    }
  });

  it("#cursor-skill-residue-3 .agents/skills/ is never touched by update", async () => {
    const allMigrationsSpy = vi
      .spyOn(migrations, "getAllMigrations")
      .mockReturnValue(readCursorResidueManifest());
    try {
      await setupProject();

      // Simulate shared-layer skills (e.g. from legacy 13-platform line)
      const sharedSkillDir = path.join(
        tmpDir,
        ".agents",
        "skills",
        "trellis-brainstorm",
      );
      fs.mkdirSync(sharedSkillDir, { recursive: true });
      const sharedSkillFile = path.join(sharedSkillDir, "SKILL.md");
      const sharedContent = "---\nname: trellis-brainstorm\n---\nshared\n";
      fs.writeFileSync(sharedSkillFile, sharedContent);

      await runUpdate({ force: true });

      // .agents/skills/ must survive untouched (not in any safe-file-delete entry)
      expect(fs.existsSync(sharedSkillFile)).toBe(true);
      expect(fs.readFileSync(sharedSkillFile, "utf-8")).toBe(sharedContent);
    } finally {
      allMigrationsSpy.mockRestore();
    }
  });

  // === .pactile/framework/ (framework-owned docs) ===

  it("#framework-1 upgrade from a pre-framework project lists .pactile/framework/* as new files and never manages .pactile/spec/", async () => {
    await setupProject();

    // Simulate a pre-framework project: no canonical framework dir or hashes.
    fs.rmSync(projectFile(PATHS.FRAMEWORK), { recursive: true, force: true });
    fs.writeFileSync(versionFilePath(), "0.4.0");
    let hashes = readHashesV2(hashFilePath());
    for (const key of Object.keys(hashes)) {
      if (key.startsWith(`${PATHS.FRAMEWORK}/`)) {
        hashes = removeHashEntry(hashes, key);
      }
    }
    writeHashesV2(hashFilePath(), hashes);

    vi.mocked(console.log).mockClear();
    await runUpdate({ dryRun: true, migrate: true });

    const output = vi
      .mocked(console.log)
      .mock.calls.flat()
      .filter((part): part is string => typeof part === "string")
      .join("\n");

    // Every framework doc is announced as a new file
    expect(output).toContain("New files (will add):");
    expect(output).toContain(`+ ${PATHS.FRAMEWORK}/index.md`);
    for (const doc of frameworkDocs) {
      expect(output).toContain(`+ ${PATHS.FRAMEWORK}/${doc.name}`);
    }

    // Nothing under .pactile/spec/ is ever listed as a managed file (the only
    // matching line allowed is the protected "User data" notice).
    const managedSpecLines = output
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          (line.startsWith("+") ||
            line.startsWith("↑") ||
            line.startsWith("?") ||
            line.startsWith("✕")) &&
          line.includes(".pactile/spec/"),
      );
    expect(managedSpecLines).toEqual([]);
  });

  it("#framework-2 apply update writes .pactile/framework/* and leaves .pactile/spec/ untouched", async () => {
    await setupProject();

    // User-customized spec guide must survive update (protected path).
    const guidesIndex = path.join(tmpDir, PATHS.SPEC, "guides", "index.md");
    const customContent = "# My Custom Guides\n\nEdited by user.\n";
    fs.writeFileSync(guidesIndex, customContent);

    // Simulate a pre-framework project without the canonical framework tree.
    fs.rmSync(projectFile(PATHS.FRAMEWORK), { recursive: true, force: true });
    fs.writeFileSync(versionFilePath(), "0.4.0");
    let hashes = readHashesV2(hashFilePath());
    for (const key of Object.keys(hashes)) {
      if (key.startsWith(`${PATHS.FRAMEWORK}/`)) {
        hashes = removeHashEntry(hashes, key);
      }
    }
    writeHashesV2(hashFilePath(), hashes);

    await runUpdate({ migrate: true });

    // Framework docs are written with the exact template content
    for (const doc of frameworkDocs) {
      expect(
        fs.readFileSync(projectFile(`${PATHS.FRAMEWORK}/${doc.name}`), "utf-8"),
      ).toBe(doc.content);
    }

    // User-edited spec guide untouched; old guide copies remain
    expect(fs.readFileSync(guidesIndex, "utf-8")).toBe(customContent);

    // Hashes never track anything under .pactile/spec/.
    const hashKeys = Object.keys(readHashesV2(hashFilePath()));
    expect(hashKeys.filter((key) => key.startsWith(".pactile/spec/"))).toEqual(
      [],
    );
    // Framework docs are hash-tracked (same-version no-op on next update)
    expect(hashKeys.filter((key) => key.startsWith(`${PATHS.FRAMEWORK}/`)))
      .toHaveLength(frameworkDocs.length);
  });

  it("#middleware-overlay update never writes, deletes, or hashes .pactile/middleware/", async () => {
    await setupProject();

    const overlayRel = `${PATHS.MIDDLEWARE}/smart-search.yaml`;
    const overlayContent =
      "id: smart-search\nprotocol: 1\nsource: user\nsecret: do-not-touch\n";
    writeProjectFile(overlayRel, overlayContent);

    let hashes = readHashesV2(hashFilePath());
    hashes = {
      ...hashes,
      [overlayRel]: computeHash(overlayContent),
    };
    writeHashesV2(hashFilePath(), hashes);
    fs.writeFileSync(versionFilePath(), "0.4.0");

    vi.mocked(console.log).mockClear();
    await runUpdate({ force: true, migrate: true });

    expect(readProjectFile(overlayRel)).toBe(overlayContent);

    const hashKeys = Object.keys(readHashesV2(hashFilePath()));
    expect(hashKeys.filter((key) => key.startsWith(`${PATHS.MIDDLEWARE}/`))).toEqual(
      [],
    );

    const output = vi
      .mocked(console.log)
      .mock.calls.flat()
      .filter((part): part is string => typeof part === "string")
      .join("\n");
    const managedOverlayLines = output
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          (line.startsWith("+") ||
            line.startsWith("↑") ||
            line.startsWith("?") ||
            line.startsWith("✕")) &&
          line.includes(`${PATHS.MIDDLEWARE}/`),
      );
    expect(managedOverlayLines).toEqual([]);
    expect(output).toContain(`${PATHS.MIDDLEWARE}/`);
  });
});
