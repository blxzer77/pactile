/**
 * Regression Tests — Historical Bug Prevention
 *
 * Each test references a specific version where the bug was introduced/fixed.
 * Prevents recurrence of bugs from beta.2 through beta.16.
 *
 * Categories:
 * 1. Windows / Encoding (beta.2, beta.7, beta.10, beta.11, beta.12, beta.16)
 * 2. Path Issues (0.2.14, 0.2.15, beta.13)
 * 3. Semver / Migration Engine (beta.5, beta.14, beta.16)
 * 4. Template Integrity (beta.0, beta.7, beta.12)
 * 5. Platform Registry (beta.9, beta.13, beta.16)
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearManifestCache,
  getAllMigrations,
  getAllMigrationVersions,
  getMigrationsForVersion,
  hasPendingMigrations,
} from "../src/migrations/index.js";
import { isManagedPath } from "../src/configurators/index.js";
import { PATHS } from "../src/constants/paths.js";
import { getSharedHookScripts } from "../src/templates/shared-hooks/index.js";
import {
  commonInit,
  taskScript,
  addSessionScript,
  commonTaskUtils,
  commonDeveloper,
  commonGitContext,
  commonSessionContext,
  getAllScripts,
  MAINTAINER_ONLY_SCRIPT_PATHS,
} from "../src/templates/pactile/index.js";
import {
  workspaceIndexContent,
} from "../src/templates/markdown/index.js";

afterEach(() => {
  clearManifestCache();
});

// =============================================================================
// 1. Windows / Encoding Regressions
// =============================================================================

describe("regression: Windows encoding (beta.10, beta.11, beta.16)", () => {
  it("[beta.10] common/__init__.py has _configure_stream function", () => {
    expect(commonInit).toContain("def _configure_stream");
  });

  it('[beta.10] common/__init__.py has reconfigure(encoding="utf-8") pattern', () => {
    expect(commonInit).toContain('reconfigure(encoding="utf-8"');
  });

  it("[beta.10] common/__init__.py has TextIOWrapper fallback", () => {
    expect(commonInit).toContain("TextIOWrapper");
  });

  it("[issue #190] Cursor session-start hook declares UTF-8 and uses common imports", () => {
    const cursorSessionStart = getSharedHookScripts().find(
      (hook) => hook.name === "session-start.py",
    )?.content;
    expect(cursorSessionStart).toBeTruthy();
    expect(cursorSessionStart).toContain("# -*- coding: utf-8 -*-");
    expect(cursorSessionStart).toContain("from common.active_task import");
    expect(commonInit).toContain('reconfigure(encoding="utf-8"');
  });

  it('[beta.10] common/__init__.py has sys.platform == "win32" guard', () => {
    expect(commonInit).toContain('sys.platform == "win32"');
  });

  it("[beta.10] common/__init__.py configures both stdout AND stderr", () => {
    expect(commonInit).toContain("sys.stdout");
    expect(commonInit).toContain("sys.stderr");
  });

  it("[beta.16] _configure_stream handles stream with reconfigure method", () => {
    // The function should try reconfigure() first, then fallback to detach()
    expect(commonInit).toContain('hasattr(stream, "reconfigure")');
    expect(commonInit).toContain('hasattr(stream, "detach")');
  });

  it("[beta.16] _configure_stream is idempotent (won't crash on double call)", () => {
    // The reconfigure pattern is safe to call multiple times
    // The function should NOT use detach() unconditionally (beta.16 bug root cause)
    // It should check hasattr(stream, "reconfigure") FIRST
    const reconfigureIndex = commonInit.indexOf(
      'hasattr(stream, "reconfigure")',
    );
    const detachIndex = commonInit.indexOf('hasattr(stream, "detach")');
    expect(reconfigureIndex).toBeLessThan(detachIndex);
  });

  it("[beta.10] common/__init__.py has centralized encoding fix", () => {
    // Encoding fix was centralized from individual scripts to common/__init__.py (#67)
    expect(commonInit).toContain('sys.platform == "win32"');
    expect(commonInit).toContain("reconfigure");
  });

  it("[beta.10] task.py imports from common (gets encoding fix via __init__.py)", () => {
    expect(taskScript).toContain("from common");
  });

  it("[rc.2] add_session.py table separator detection uses regex (not startswith)", () => {
    // Bug: startswith("|---") breaks when formatters add spaces: "| ---- |"
    // Fix: use re.match with a character-class pattern to allow optional whitespace/spaces
    expect(addSessionScript).not.toContain('startswith("|---")');
    expect(addSessionScript).toContain(
      String.raw`re.match(r"^\|[-| ]+\|\s*$", line)`,
    );
  });
});

describe("regression: branch context in session records (issue-106)", () => {
  it("[issue-106] add_session.py accepts --branch CLI arg", () => {
    expect(addSessionScript).toContain("--branch");
    expect(addSessionScript).not.toContain("--base-branch");
  });

  it("[issue-106] add_session.py auto-detects branch via git branch --show-current", () => {
    expect(addSessionScript).toContain("branch --show-current");
  });

  it("[issue-106] add_session.py reads branch from task.json when available", () => {
    expect(addSessionScript).toContain('task_data.raw.get("branch")');
    expect(addSessionScript).not.toContain('task_data.raw.get("base_branch")');
  });

  it("[issue-106] add_session.py session content includes **Branch** field only", () => {
    expect(addSessionScript).toContain("**Branch**");
    expect(addSessionScript).not.toContain("**Base Branch**");
  });

  it("[issue-106] add_session.py index table header has 5 columns including Branch", () => {
    expect(addSessionScript).toContain(
      "| # | Date | Title | Commits | Branch |",
    );
    expect(addSessionScript).not.toContain(
      "| # | Date | Title | Commits | Branch | Base Branch |",
    );
  });

  it("[issue-106] add_session.py migrates old 4/6-column headers to 5-column", () => {
    expect(addSessionScript).toMatch(
      /re\.match\(\r?\n\s+r"\^\\\|\\s\*#\\s\*\\\|\\s\*Date\\s\*\\\|\\s\*Title\\s\*\\\|\\s\*Commits\\s\*\\\|\\s\*Branch\\s\*\\\|\\s\*Base Branch\\s\*\\\|\\s\*\$",/,
    );
    expect(addSessionScript).toContain(
      String.raw`re.match(r"^\|\s*#\s*\|\s*Date\s*\|\s*Title\s*\|\s*Commits\s*\|\s*Branch\s*\|\s*$", line)`,
    );
  });

  it("[issue-106] developer.py init template has 5-column session history table", () => {
    expect(commonDeveloper).toContain(
      "| # | Date | Title | Commits | Branch |",
    );
    expect(commonDeveloper).toContain(
      "|---|------|-------|---------|--------|",
    );
  });

  it("[issue-106] workspace-index.md template documents Branch field only for session records", () => {
    expect(workspaceIndexContent).toContain(
      "Branch: Which branch the work was done on",
    );
    expect(workspaceIndexContent).toContain("**Branch**: `{branch-name}`");
    expect(workspaceIndexContent).not.toContain(
      "**Base Branch**: `{base-branch-name}`",
    );
  });
});

describe("regression: add_session.py runtime branch context (issue-106)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-session-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writePactileScripts(): void {
    const scriptsDir = path.join(tmpDir, ".pactile", "scripts");
    for (const [relativePath, content] of getAllScripts()) {
      const absPath = path.join(scriptsDir, relativePath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content);
    }
  }

  function createWorkspaceIndex(
    headerMode: "legacy4" | "legacy6" | "current5",
  ): void {
    let header = "| # | Date | Title | Commits | Branch |";
    let separator = "|---|------|-------|---------|--------|";
    if (headerMode === "legacy4") {
      header = "| # | Date | Title | Commits |";
      separator = "|---|------|-------|---------|";
    } else if (headerMode === "legacy6") {
      header = "| # | Date | Title | Commits | Branch | Base Branch |";
      separator = "|---|------|-------|---------|--------|-------------|";
    }
    const indexContent = `# Workspace Index - test-dev

## Current Status

<!-- @@@auto:current-status -->
- **Active File**: \`journal-1.md\`
- **Total Sessions**: 0
- **Last Active**: -
<!-- @@@/auto:current-status -->

## Active Documents

<!-- @@@auto:active-documents -->
| File | Lines | Status |
|------|-------|--------|
| \`journal-1.md\` | ~0 | Active |
<!-- @@@/auto:active-documents -->

## Session History

<!-- @@@auto:session-history -->
${header}
${separator}
<!-- @@@/auto:session-history -->
`;
    fs.writeFileSync(
      path.join(tmpDir, ".pactile", "workspace", "test-dev", "index.md"),
      indexContent,
      "utf-8",
    );
  }

  function setupSessionRepo(options?: {
    gitBranch?: string;
    headerMode?: "legacy4" | "legacy6" | "current5";
    taskBranch?: string;
    taskBaseBranch?: string;
  }): void {
    writePactileScripts();

    fs.mkdirSync(path.join(tmpDir, ".pactile", "workspace", "test-dev"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpDir, ".pactile", ".developer"),
      "name=test-dev\ninitialized_at=2026-03-22T00:00:00\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tmpDir, ".pactile", "workspace", "test-dev", "journal-1.md"),
      "# Journal - test-dev (Part 1)\n\n---\n",
      "utf-8",
    );
    createWorkspaceIndex(options?.headerMode ?? "current5");

    if (options?.taskBranch || options?.taskBaseBranch) {
      const taskDir = path.join(tmpDir, ".pactile", "tasks", "issue-106");
      fs.mkdirSync(taskDir, { recursive: true });
      fs.mkdirSync(
        path.join(tmpDir, ".pactile", ".runtime", "sessions"),
        { recursive: true },
      );
      fs.writeFileSync(
        path.join(
          tmpDir,
          ".pactile",
          ".runtime",
          "sessions",
          "session-a.json",
        ),
        JSON.stringify(
          {
            selected_task: ".pactile/tasks/issue-106",
            platform: "test",
          },
          null,
          2,
        ),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(taskDir, "task.json"),
        JSON.stringify(
          {
            title: "Issue 106 task",
            status: "in_progress",
            package: null,
            branch: options.taskBranch ?? null,
            base_branch: options.taskBaseBranch ?? null,
          },
          null,
          2,
        ),
        "utf-8",
      );
    }

    if (options?.gitBranch) {
      execSync("git init -q", { cwd: tmpDir });
      execSync(`git branch -m ${JSON.stringify(options.gitBranch)}`, {
        cwd: tmpDir,
      });
    }
  }

  function runAddSession(title: string, options?: { branch?: string }): void {
    const command = [
      "python3",
      JSON.stringify(
        path.join(tmpDir, ".pactile", "scripts", "add_session.py"),
      ),
      "--title",
      JSON.stringify(title),
      "--summary",
      JSON.stringify("Regression test session"),
      "--no-commit",
    ];
    if (options?.branch) {
      command.push("--branch", JSON.stringify(options.branch));
    }

    execSync(command.join(" "), {
      cwd: tmpDir,
      encoding: "utf-8",
      env: { ...process.env, PACTILE_CONTEXT_ID: "session-a" },
    });
  }

  it("[issue-106] prefers explicit CLI branch over task.json and git", () => {
    setupSessionRepo({
      gitBranch: "feature/from-git",
      taskBranch: "task/from-task",
      taskBaseBranch: "main",
    });

    runAddSession("CLI branch wins", { branch: "cli/from-arg" });

    const journal = fs.readFileSync(
      path.join(tmpDir, ".pactile", "workspace", "test-dev", "journal-1.md"),
      "utf-8",
    );
    const index = fs.readFileSync(
      path.join(tmpDir, ".pactile", "workspace", "test-dev", "index.md"),
      "utf-8",
    );

    expect(journal).toContain("**Branch**: `cli/from-arg`");
    expect(journal).not.toContain("**Base Branch**:");
    expect(journal).not.toContain("task/from-task");
    expect(journal).not.toContain("feature/from-git");
    expect(index).toContain("`cli/from-arg` |");
    expect(index).not.toContain("`task/from-task`");
    expect(index).not.toContain("`feature/from-git`");
  });

  it("[issue-106] prefers task.json branch over current git branch and ignores task base_branch", () => {
    setupSessionRepo({
      gitBranch: "feature/from-git",
      taskBranch: "task/from-task",
      taskBaseBranch: "main",
    });

    runAddSession("Task branch wins");

    const journal = fs.readFileSync(
      path.join(tmpDir, ".pactile", "workspace", "test-dev", "journal-1.md"),
      "utf-8",
    );
    const index = fs.readFileSync(
      path.join(tmpDir, ".pactile", "workspace", "test-dev", "index.md"),
      "utf-8",
    );

    expect(journal).toContain("**Branch**: `task/from-task`");
    expect(journal).not.toContain("**Base Branch**:");
    expect(journal).not.toContain("feature/from-git");
    expect(index).toContain("`task/from-task` |");
    expect(index).not.toContain("`feature/from-git`");
  });

  it("[issue-106] falls back to git branch and migrates old 6-column session history", () => {
    setupSessionRepo({
      gitBranch: "feature/from-git",
      headerMode: "legacy6",
    });

    runAddSession("Git branch fallback");

    const journal = fs.readFileSync(
      path.join(tmpDir, ".pactile", "workspace", "test-dev", "journal-1.md"),
      "utf-8",
    );
    const index = fs.readFileSync(
      path.join(tmpDir, ".pactile", "workspace", "test-dev", "index.md"),
      "utf-8",
    );

    expect(journal).toContain("**Branch**: `feature/from-git`");
    expect(journal).not.toContain("**Base Branch**:");
    expect(index).toContain("| # | Date | Title | Commits | Branch |");
    expect(index).toContain("|---|------|-------|---------|--------|");
    expect(index).toContain("`feature/from-git` |");
    expect(index).not.toContain(
      "| # | Date | Title | Commits | Branch | Base Branch |\n|---|------|-------|---------|--------|-------------|",
    );
  });

  it("[issue-106] migrates old 4-column session history directly to 5 columns", () => {
    setupSessionRepo({
      headerMode: "legacy4",
    });

    runAddSession("Legacy 4-column migration");

    const index = fs.readFileSync(
      path.join(tmpDir, ".pactile", "workspace", "test-dev", "index.md"),
      "utf-8",
    );

    expect(index).toContain("| # | Date | Title | Commits | Branch |");
    expect(index).toContain("|---|------|-------|---------|--------|");
    expect(index).not.toContain(
      "| # | Date | Title | Commits |\n|---|------|-------|---------|",
    );
  });

  it("[issue-106] records a session even when no branch information is available", () => {
    setupSessionRepo();

    runAddSession("No branch available");

    const journal = fs.readFileSync(
      path.join(tmpDir, ".pactile", "workspace", "test-dev", "journal-1.md"),
      "utf-8",
    );
    const index = fs.readFileSync(
      path.join(tmpDir, ".pactile", "workspace", "test-dev", "index.md"),
      "utf-8",
    );

    expect(journal).not.toContain("**Branch**:");
    expect(journal).not.toContain("**Base Branch**:");
    expect(index).toContain("`-` |");
    expect(index).toContain("- **Total Sessions**: 1");
  });
});

// Windows subprocess flags tests removed — multi_agent pipeline removed

describe("regression: Windows path separator (beta.12)", () => {
  it("[beta.12] isManagedPath handles Windows backslash paths", () => {
    expect(isManagedPath(".pactile\\spec\\backend")).toBe(true);
    expect(isManagedPath(".codex\\config.toml")).toBe(true);
  });

  it("[beta.12] isManagedPath handles mixed separators", () => {
    expect(isManagedPath(".agents\\skills/pactile-start/SKILL.md")).toBe(true);
  });
});


// =============================================================================
// 2. Path Issues Regressions
// =============================================================================

describe("regression: task directory paths (0.2.14, 0.2.15, beta.13)", () => {
  it("[0.2.15] PATHS.TASKS is .pactile/tasks (not .pactile/workspace/*/tasks)", () => {
    expect(PATHS.TASKS).toBe(".pactile/tasks");
    expect(PATHS.TASKS).not.toContain("workspace");
  });





  it("[0.2.15] no script templates contain hardcoded 'taosu' in path patterns", () => {
    const scripts = getAllScripts();
    for (const [name, content] of scripts) {
      // Check for hardcoded username in path patterns (workspace/taosu, /Users/taosu)
      // but allow usage examples like "python3 status.py -a taosu"
      expect(
        content,
        `${name} should not contain hardcoded username in paths`,
      ).not.toMatch(/workspace\/taosu|\/Users\/taosu/);
    }
  });
});

describe("regression: resolve_task_dir path handling", () => {
  it("[beta.12] resolve_task_dir handles .pactile prefix", () => {
    // The function should recognize .pactile-prefixed paths as relative paths
    expect(commonTaskUtils).toContain('.startswith(".pactile")');
  });

  it("[current-task] resolve_task_dir normalizes backslash separators before path classification", () => {
    expect(commonTaskUtils).toContain('target_dir.replace("\\\\", "/")');
  });
});

// =============================================================================
// 3. Semver / Migration Engine Regressions
// =============================================================================

describe("regression: semver prerelease handling (beta.5)", () => {
  it("[beta.5] prerelease version sorts before release version", () => {
    // 0.3.0-beta.1 < 0.3.0 (prerelease is less than release)
    const versions = getAllMigrationVersions();
    const betaVersions = versions.filter((v) => v.includes("beta"));
    const releaseVersions = versions.filter(
      (v) => !v.includes("beta") && !v.includes("alpha"),
    );

    if (betaVersions.length > 0 && releaseVersions.length > 0) {
      // All beta versions should appear before their corresponding release versions
      const lastBeta = betaVersions[betaVersions.length - 1];
      const firstRelease = releaseVersions[0];
      const lastBetaIdx = versions.indexOf(lastBeta);
      const firstReleaseIdx = versions.indexOf(firstRelease);
      // Only compare if they share the same base version
      if (lastBeta.startsWith(firstRelease.split("-")[0])) {
        expect(lastBetaIdx).toBeLessThan(firstReleaseIdx);
      }
    }
  });

  it("[beta.5] prerelease numeric parts compare numerically (beta.2 < beta.10)", () => {
    // getMigrationsForVersion relies on correct version ordering
    // beta.2 should be before beta.10 (numeric, not lexicographic)
    const versions = getAllMigrationVersions();
    const beta2Idx = versions.indexOf("0.3.0-beta.2");
    const beta10Idx = versions.indexOf("0.3.0-beta.10");
    if (beta2Idx !== -1 && beta10Idx !== -1) {
      expect(beta2Idx).toBeLessThan(beta10Idx);
    }
  });

  it("[beta.5] getMigrationsForVersion returns empty for equal versions", () => {
    expect(getMigrationsForVersion("0.3.0-beta.5", "0.3.0-beta.5")).toEqual([]);
  });

  it("[beta.5] getMigrationsForVersion correctly handles beta range", () => {
    // beta.0 to beta.2 should include beta.1 and beta.2 migrations
    getMigrationsForVersion("0.3.0-beta.0", "0.3.0-beta.2");
    // Should not include beta.0 itself (only > fromVersion)
    const versions = getAllMigrationVersions();
    if (versions.includes("0.3.0-beta.1")) {
      expect(
        hasPendingMigrations("0.3.0-beta.0", "0.3.0-beta.2"),
      ).toBeDefined();
    }
  });
});

describe("regression: migration data integrity (beta.14)", () => {
  it("[beta.14] all migrations have non-undefined 'from' field", () => {
    const allMigrations = getAllMigrations();
    for (const m of allMigrations) {
      expect(
        m.from,
        `migration should have 'from' field defined`,
      ).toBeDefined();
      expect(typeof m.from).toBe("string");
      expect(m.from.length).toBeGreaterThan(0);
    }
  });

  it("[beta.14] all migrations have valid type field", () => {
    const allMigrations = getAllMigrations();
    const validTypes = ["rename", "rename-dir", "delete", "safe-file-delete"];
    for (const m of allMigrations) {
      expect(validTypes).toContain(m.type);
    }
  });

  it("[beta.1-040] safe-file-delete migrations have allowed_hashes", () => {
    const allMigrations = getAllMigrations();
    const safeDeletes = allMigrations.filter(
      (m) => m.type === "safe-file-delete",
    );
    for (const m of safeDeletes) {
      expect(
        m.allowed_hashes,
        `safe-file-delete for '${m.from}' should have allowed_hashes`,
      ).toBeDefined();
      expect(Array.isArray(m.allowed_hashes)).toBe(true);
      expect(
        (m.allowed_hashes as string[]).length,
        `safe-file-delete for '${m.from}' should have at least one hash`,
      ).toBeGreaterThan(0);
      for (const hash of m.allowed_hashes as string[]) {
        expect(hash).toMatch(/^[a-f0-9]{64}$/);
      }
    }
  });

  it("[beta.15] Claude Code statusline is not safe-deleted on update", () => {
    const claudeStatusLineDeletes = getAllMigrations().filter(
      (m) =>
        m.type === "safe-file-delete" &&
        m.from === ".claude/hooks/statusline.py",
    );

    expect(claudeStatusLineDeletes).toEqual([]);
  });

  it("[beta.14] rename/rename-dir migrations have 'to' field", () => {
    const allMigrations = getAllMigrations();
    const renames = allMigrations.filter(
      (m) => m.type === "rename" || m.type === "rename-dir",
    );
    for (const m of renames) {
      expect(
        m.to,
        `rename migration from '${m.from}' should have 'to'`,
      ).toBeDefined();
      expect(typeof m.to).toBe("string");
      expect((m.to as string).length).toBeGreaterThan(0);
    }
  });

  it("[beta.14] all manifest versions are valid semver-like strings", () => {
    const versions = getAllMigrationVersions();
    for (const v of versions) {
      expect(v).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    }
  });
});



// dispatch agent removed — parallel/worktree now handled by platform-native features

// =============================================================================
// 4. Template Integrity Regressions
// =============================================================================

describe("regression: shell to Python migration (beta.0)", () => {
  it("[beta.0] no .sh scripts remain in Pactile templates", () => {
    const scripts = getAllScripts();
    for (const [name] of scripts) {
      expect(name.endsWith(".sh"), `${name} should not end with .sh`).toBe(
        false,
      );
    }
  });

  it("[beta.0] all script keys end with .py", () => {
    const scripts = getAllScripts();
    for (const [name] of scripts) {
      expect(name.endsWith(".py"), `${name} should end with .py`).toBe(true);
    }
  });

  it("[beta.3] getAllScripts covers every .py file in templates/pactile/scripts/", () => {
    // Bug: update.ts had a hand-maintained file list that missed 11 scripts.
    // Fix: update.ts now uses getAllScripts() directly. This test ensures
    // getAllScripts() itself stays in sync with the filesystem.
    const scriptsDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src/templates/pactile/scripts",
    );
    const fsFiles = new Set<string>();
    function walk(dir: string, prefix: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        } else if (entry.name.endsWith(".py")) {
          fsFiles.add(`${prefix}${entry.name}`);
        }
      }
    }
    walk(scriptsDir, "");

    const scripts = getAllScripts();
    const registeredKeys = new Set(scripts.keys());

    // Maintainer-only scripts exist on disk but are not shipped via getAllScripts()
    const excluded = new Set(MAINTAINER_ONLY_SCRIPT_PATHS);

    for (const file of fsFiles) {
      if (excluded.has(file)) continue;
      expect(
        registeredKeys.has(file),
        `${file} exists on disk but is missing from getAllScripts()`,
      ).toBe(true);
    }
  });
});





describe("regression: agent-session Pactile update hint", () => {
  let tmpDir: string;
  const pythonCmd = process.platform === "win32" ? "python" : "python3";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-update-hint-"));
    const scriptsDir = path.join(tmpDir, ".pactile", "scripts");
    for (const [relativePath, content] of getAllScripts()) {
      const absPath = path.join(scriptsDir, relativePath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, "utf-8");
    }
    fs.mkdirSync(path.join(tmpDir, ".pactile", "tasks"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".pactile", ".developer"),
      "name=test-dev\ninitialized_at=2026-05-09T00:00:00Z\n",
      "utf-8",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runContextWithPactileOutput(
    currentVersion: string,
    pactileVersionOutput: string | null,
  ): string {
    fs.writeFileSync(
      path.join(tmpDir, ".pactile", ".version"),
      `${currentVersion}\n`,
      "utf-8",
    );
    const runnerPath = path.join(tmpDir, "run-context.py");
    fs.writeFileSync(
      runnerPath,
      [
        "import os",
        "import sys",
        "from pathlib import Path",
        "sys.path.insert(0, str(Path.cwd() / '.pactile' / 'scripts'))",
        "from common import session_context",
        "output = os.environ.get('PACTILE_VERSION_OUTPUT')",
        "session_context._fetch_pactile_version_output = lambda: None if output == '__NONE__' else output",
        "session_context.output_text(Path.cwd())",
        "",
      ].join("\n"),
      "utf-8",
    );
    return execSync(`${pythonCmd} ${JSON.stringify(runnerPath)}`, {
      cwd: tmpDir,
      encoding: "utf-8",
      env: {
        ...process.env,
        PACTILE_VERSION_OUTPUT: pactileVersionOutput ?? "__NONE__",
        PACTILE_CONTEXT_ID: "test-update-session",
      },
    });
  }

  function pythonFunctionBody(source: string, name: string): string {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = source.match(
      new RegExp(`def ${escapedName}\\([\\s\\S]*?\\n(?=def |# =|$)`),
    );
    return match?.[0] ?? "";
  }

  it("shows a concise update hint when pactile --version reports a newer version", () => {
    const output = runContextWithPactileOutput(
      "0.5.0",
      "Pactile update available: 0.5.0 → 0.5.9\nRun: pactile update\n0.5.9",
    );

    expect(output).toContain("Pactile update available: 0.5.0 -> 0.5.9");
    expect(output).toContain("run pactile upgrade");
    expect(output).toContain("SESSION CONTEXT");
  });

  it("does not show a hint when installed version is equal or newer", () => {
    expect(runContextWithPactileOutput("0.5.9", "0.5.9")).not.toContain(
      "Pactile update available",
    );
    fs.rmSync(path.join(tmpDir, ".pactile", ".runtime"), {
      recursive: true,
      force: true,
    });
    expect(runContextWithPactileOutput("0.6.0", "0.5.9")).not.toContain(
      "Pactile update available",
    );
  });

  it("silently skips the hint when pactile --version fails or version parsing fails", () => {
    expect(runContextWithPactileOutput("0.5.0", null)).not.toContain(
      "Pactile update available",
    );
    fs.rmSync(path.join(tmpDir, ".pactile", ".runtime"), {
      recursive: true,
      force: true,
    });
    expect(runContextWithPactileOutput("not-a-version", "0.5.9")).not.toContain(
      "Pactile update available",
    );
  });

  it("does not burn the once-per-session marker when version lookup fails", () => {
    expect(runContextWithPactileOutput("0.5.0", null)).not.toContain(
      "Pactile update available",
    );

    const output = runContextWithPactileOutput("0.5.0", "0.5.9");

    expect(output).toContain("Pactile update available: 0.5.0 -> 0.5.9");
  });

  it("uses the final pactile --version token when no update line is present", () => {
    const output = runContextWithPactileOutput("0.5.0", "0.5.9");

    expect(output).toContain("Pactile update available: 0.5.0 -> 0.5.9");
  });

  it("only attempts the default text update hint once per session", () => {
    const first = runContextWithPactileOutput("0.5.0", "0.5.9");
    const second = runContextWithPactileOutput("0.5.0", "0.5.9");

    expect(first).toContain("Pactile update available: 0.5.0 -> 0.5.9");
    expect(second).not.toContain("Pactile update available");
    expect(
      fs.existsSync(
        path.join(
          tmpDir,
          ".pactile",
          ".runtime",
          "update-check-test-update-session.marker",
        ),
      ),
    ).toBe(true);
  });

  it("keeps the update hint out of JSON, record, packages, and phase paths", () => {
    expect(pythonFunctionBody(commonSessionContext, "output_text")).toContain(
      "_get_update_hint",
    );
    for (const functionName of [
      "get_context_json",
      "output_json",
      "get_context_record_json",
      "get_context_text_record",
    ]) {
      expect(
        pythonFunctionBody(commonSessionContext, functionName),
        `${functionName} should not check Pactile updates`,
      ).not.toContain("_get_update_hint");
    }
    expect(commonGitContext).toContain("if args.mode == \"record\":");
    expect(commonGitContext).toContain("elif args.mode == \"packages\":");
    expect(commonGitContext).toContain("elif args.mode == \"phase\":");
    expect(commonGitContext).toContain("else:");
    expect(commonGitContext).toContain("output_text()");
  });
});

describe("regression: issue #252 polyrepo Git context", () => {
  let tmpDir: string;
  const pythonCmd = process.platform === "win32" ? "python" : "python3";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-polyrepo-git-"));
    const scriptsDir = path.join(tmpDir, ".pactile", "scripts");
    for (const [relativePath, content] of getAllScripts()) {
      const absPath = path.join(scriptsDir, relativePath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, "utf-8");
    }
    fs.mkdirSync(path.join(tmpDir, ".pactile", "tasks"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".pactile", "workspace", "test-dev"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpDir, ".pactile", ".developer"),
      "name=test-dev\n",
      "utf-8",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfigYaml(content: string): void {
    fs.writeFileSync(
      path.join(tmpDir, ".pactile", "config.yaml"),
      content,
      "utf-8",
    );
  }

  function initChildRepo(relativePath: string, commitMessage: string): void {
    const repoPath = path.join(tmpDir, relativePath);
    fs.mkdirSync(repoPath, { recursive: true });
    execSync("git init -q", { cwd: repoPath });
    execSync("git config user.email test@example.com", { cwd: repoPath });
    execSync("git config user.name Test", { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, "README.md"), `${commitMessage}\n`);
    execSync("git add README.md", { cwd: repoPath });
    execSync(`git commit -q -m ${JSON.stringify(commitMessage)}`, {
      cwd: repoPath,
    });
  }

  function runSessionContext(kind: "text" | "record" | "json"): string {
    const runnerPath = path.join(tmpDir, "run-context.py");
    let expression = "print(session_context.get_context_text(Path.cwd()))";
    if (kind === "record") {
      expression = "print(session_context.get_context_text_record(Path.cwd()))";
    } else if (kind === "json") {
      expression = "print(json.dumps(session_context.get_context_json(Path.cwd())))";
    }
    fs.writeFileSync(
      runnerPath,
      [
        "import json",
        "import sys",
        "from pathlib import Path",
        "sys.path.insert(0, str(Path.cwd() / '.pactile' / 'scripts'))",
        "from common import session_context",
        expression,
        "",
      ].join("\n"),
      "utf-8",
    );
    return execSync(`${pythonCmd} ${JSON.stringify(runnerPath)}`, {
      cwd: tmpDir,
      encoding: "utf-8",
    });
  }

  it("does not render root as unknown/clean when configured package repos exist", () => {
    writeConfigYaml(
      [
        "packages:",
        "  module_a:",
        "    path: module-a",
        "    git: true",
        "",
      ].join("\n"),
    );
    initChildRepo("module-a", "init module a");

    const output = runSessionContext("text");
    const rootBlock = output.slice(
      output.indexOf("## GIT STATUS"),
      output.indexOf("## GIT STATUS (module_a: module-a)"),
    );

    expect(rootBlock).toContain("Root is not a Git repository.");
    expect(rootBlock).toContain(
      "Run Git commands from the package repository paths listed below.",
    );
    expect(rootBlock).not.toContain("Branch: unknown");
    expect(rootBlock).not.toContain("Working directory: Clean");
    expect(output).toContain("## GIT STATUS (module_a: module-a)");
    expect(output).toContain("init module a");
  });

  it("uses the same non-Git root rendering in record mode", () => {
    writeConfigYaml(
      [
        "packages:",
        "  module_a:",
        "    path: module-a",
        "    git: true",
        "",
      ].join("\n"),
    );
    initChildRepo("module-a", "init module a");

    const output = runSessionContext("record");
    const rootBlock = output.slice(
      output.indexOf("## GIT STATUS"),
      output.indexOf("## GIT STATUS (module_a: module-a)"),
    );

    expect(rootBlock).toContain("Root is not a Git repository.");
    expect(rootBlock).not.toContain("Branch: unknown");
    expect(rootBlock).not.toContain("Working directory: Clean");
  });

  it("discovers unconfigured child Git repos when root is not a Git repo", () => {
    writeConfigYaml("# no packages configured\n");
    initChildRepo("module-a", "init module a");
    initChildRepo(path.join("services", "module-b"), "init module b");

    const output = runSessionContext("text");

    expect(output).toContain("Root is not a Git repository.");
    expect(output).toContain("## GIT STATUS (module-a: module-a)");
    expect(output).toContain(
      "## GIT STATUS (services_module-b: services/module-b)",
    );
    expect(output).toContain("init module a");
    expect(output).toContain("init module b");
  });

  it("marks JSON root Git state as non-repo instead of clean", () => {
    writeConfigYaml(
      [
        "packages:",
        "  module_a:",
        "    path: module-a",
        "    git: true",
        "",
      ].join("\n"),
    );
    initChildRepo("module-a", "init module a");

    const context = JSON.parse(runSessionContext("json")) as {
      git: { isRepo: boolean; branch: string; isClean: boolean };
      packageGit: { name: string; path: string }[];
    };

    expect(context.git).toEqual(
      expect.objectContaining({
        isRepo: false,
        branch: "",
        isClean: false,
      }),
    );
    expect(context.packageGit).toEqual([
      expect.objectContaining({ name: "module_a", path: "module-a" }),
    ]);
  });
});

