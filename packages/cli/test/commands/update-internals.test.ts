/**
 * Tests for internal helper functions exported from update.ts
 *
 * These test cleanupEmptyDirs and sortMigrationsForExecution
 * to cover command-level behavior that was previously untested.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cleanupEmptyDirs,
  collectMissingTemplateHashes,
  collectStaleUpdateSkipPaths,
  collectTemplateFiles,
  loadUpdateSkipPaths,
  removeUpdateSkipPathsFromConfig,
  shouldExcludeFromBackup,
  sortMigrationsForExecution,
} from "../../src/commands/update.js";
import { FILE_NAMES, PATHS } from "../../src/constants/paths.js";

// =============================================================================
// cleanupEmptyDirs
// =============================================================================

describe("cleanupEmptyDirs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-cleanup-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes empty subdirectory under managed path", () => {
    fs.mkdirSync(path.join(tmpDir, ".codex", "generated"), { recursive: true });
    cleanupEmptyDirs(tmpDir, ".codex/generated");
    expect(fs.existsSync(path.join(tmpDir, ".codex", "generated"))).toBe(false);
  });

  it("does not remove non-empty directory", () => {
    fs.mkdirSync(path.join(tmpDir, ".cursor", "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".cursor", "commands", "file.md"),
      "content",
    );
    cleanupEmptyDirs(tmpDir, ".cursor/commands");
    expect(fs.existsSync(path.join(tmpDir, ".cursor", "commands"))).toBe(true);
  });

  it("does not remove directories outside managed paths", () => {
    fs.mkdirSync(path.join(tmpDir, "src", "utils"), { recursive: true });
    cleanupEmptyDirs(tmpDir, "src/utils");
    // Should still exist because src/utils is not a managed path
    expect(fs.existsSync(path.join(tmpDir, "src", "utils"))).toBe(true);
  });

  it("[CR#1] does not delete managed root directories even if empty", () => {
    fs.mkdirSync(path.join(tmpDir, ".codex"), { recursive: true });
    cleanupEmptyDirs(tmpDir, ".codex");
    expect(fs.existsSync(path.join(tmpDir, ".codex"))).toBe(true);
  });

  it("[CR#1] does not delete .pactile root even if empty", () => {
    fs.mkdirSync(path.join(tmpDir, ".pactile"), { recursive: true });
    cleanupEmptyDirs(tmpDir, ".pactile");
    expect(fs.existsSync(path.join(tmpDir, ".pactile"))).toBe(true);
  });

  it("recursively cleans parent directories but stops at root", () => {
    // Create .pactile/scripts/multi_agent/ (all empty)
    fs.mkdirSync(path.join(tmpDir, ".pactile", "scripts", "multi_agent"), {
      recursive: true,
    });
    cleanupEmptyDirs(tmpDir, ".pactile/scripts/multi_agent");

    // multi_agent and scripts should be removed (both empty)
    expect(
      fs.existsSync(
        path.join(tmpDir, ".pactile", "scripts", "multi_agent"),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(tmpDir, ".pactile", "scripts")),
    ).toBe(false);
    // .pactile root must survive
    expect(fs.existsSync(path.join(tmpDir, ".pactile"))).toBe(true);
  });

  it("handles non-existent directory gracefully", () => {
    // Should not throw
    expect(() => cleanupEmptyDirs(tmpDir, ".cursor/nonexistent")).not.toThrow();
  });
});

// =============================================================================
// loadUpdateSkipPaths — YAML quote handling
// =============================================================================

describe("loadUpdateSkipPaths", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-skip-"));
    fs.mkdirSync(path.join(tmpDir, ".cstl"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("strips double quotes from skip paths", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".cstl", "config.yaml"),
      'update:\n  skip:\n    - ".cursor/commands/"\n',
    );
    const paths = loadUpdateSkipPaths(tmpDir);
    expect(paths).toEqual([".cursor/commands/"]);
  });

  it("strips single quotes from skip paths", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".cstl", "config.yaml"),
      "update:\n  skip:\n    - '.cursor/commands/'\n",
    );
    const paths = loadUpdateSkipPaths(tmpDir);
    expect(paths).toEqual([".cursor/commands/"]);
  });

  it("handles unquoted skip paths", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".cstl", "config.yaml"),
      "update:\n  skip:\n    - .cursor/commands/\n",
    );
    const paths = loadUpdateSkipPaths(tmpDir);
    expect(paths).toEqual([".cursor/commands/"]);
  });

  it("returns empty array when no config exists", () => {
    const paths = loadUpdateSkipPaths(tmpDir);
    expect(paths).toEqual([]);
  });
});

describe("stale update.skip prune", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-stale-skip-"));
    fs.mkdirSync(path.join(tmpDir, ".cstl", "scripts", "common"), {
      recursive: true,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("treats a file skip as stale only when disk matches official template", () => {
    const rel = ".cstl/scripts/common/adapter_middleware.py";
    const official = "id: seven-providers\n";
    fs.writeFileSync(path.join(tmpDir, rel), official);
    const templates = new Map([[rel, official]]);
    expect(
      collectStaleUpdateSkipPaths(tmpDir, [rel, ".cursor/commands/"], templates),
    ).toEqual([rel]);

    fs.writeFileSync(path.join(tmpDir, rel), "id: local-fork\n");
    expect(collectStaleUpdateSkipPaths(tmpDir, [rel], templates)).toEqual([]);
  });

  it("removes the skip item and an empty update: section from config.yaml", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".cstl", "config.yaml"),
      [
        "# keep this comment",
        "max_journal_lines: 2000",
        "",
        "update:",
        "  skip:",
        "    - .cstl/scripts/common/adapter_middleware.py",
        "    - .cursor/commands/",
        "",
      ].join("\n"),
    );
    const removed = removeUpdateSkipPathsFromConfig(tmpDir, [
      ".cstl/scripts/common/adapter_middleware.py",
    ]);
    expect(removed).toEqual([".cstl/scripts/common/adapter_middleware.py"]);
    const next = fs.readFileSync(
      path.join(tmpDir, ".cstl", "config.yaml"),
      "utf-8",
    );
    expect(next).toContain("# keep this comment");
    expect(next).toContain("- .cursor/commands/");
    expect(next).not.toContain("adapter_middleware.py");
    expect(loadUpdateSkipPaths(tmpDir)).toEqual([".cursor/commands/"]);
  });

  it("drops update: when the last skip item is removed", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".cstl", "config.yaml"),
      "update:\n  skip:\n    - .cstl/scripts/common/adapter_middleware.py\n",
    );
    removeUpdateSkipPathsFromConfig(tmpDir, [
      ".cstl/scripts/common/adapter_middleware.py",
    ]);
    const next = fs.readFileSync(
      path.join(tmpDir, ".cstl", "config.yaml"),
      "utf-8",
    );
    expect(next).not.toMatch(/^update:/m);
    expect(next).not.toMatch(/skip:/);
    expect(loadUpdateSkipPaths(tmpDir)).toEqual([]);
  });
});

// =============================================================================
// sortMigrationsForExecution
// =============================================================================

describe("sortMigrationsForExecution", () => {
  it("returns empty array for empty input", () => {
    expect(sortMigrationsForExecution([])).toEqual([]);
  });

  it("puts rename-dir before rename and delete", () => {
    const items = [
      { type: "rename" as const, from: ".cursor/a.md", to: ".cursor/b.md" },
      { type: "rename-dir" as const, from: ".cstl/old", to: ".cstl/new" },
      { type: "delete" as const, from: ".cursor/c.md" },
    ];
    const sorted = sortMigrationsForExecution(items);
    expect(sorted[0].type).toBe("rename-dir");
  });

  it("sorts rename-dir by path depth (deeper first)", () => {
    const items = [
      { type: "rename-dir" as const, from: ".cstl/a", to: ".cstl/x" },
      {
        type: "rename-dir" as const,
        from: ".cstl/a/b/c",
        to: ".cstl/x/y/z",
      },
      { type: "rename-dir" as const, from: ".cstl/a/b", to: ".cstl/x/y" },
    ];
    const sorted = sortMigrationsForExecution(items);
    expect(sorted[0].from).toBe(".cstl/a/b/c"); // depth 4
    expect(sorted[1].from).toBe(".cstl/a/b"); // depth 3
    expect(sorted[2].from).toBe(".cstl/a"); // depth 2
  });

  it("preserves relative order of rename and delete items", () => {
    const items = [
      { type: "rename" as const, from: ".cursor/a.md", to: ".cursor/b.md" },
      { type: "delete" as const, from: ".cursor/c.md" },
      { type: "rename" as const, from: ".cursor/d.md", to: ".cursor/e.md" },
    ];
    const sorted = sortMigrationsForExecution(items);
    // No rename-dir items, so original order is preserved
    expect(sorted[0].from).toBe(".cursor/a.md");
    expect(sorted[1].from).toBe(".cursor/c.md");
    expect(sorted[2].from).toBe(".cursor/d.md");
  });

  it("does not mutate original array", () => {
    const items = [
      { type: "rename" as const, from: "a", to: "b" },
      { type: "rename-dir" as const, from: "c", to: "d" },
    ];
    const original = [...items];
    sortMigrationsForExecution(items);
    expect(items).toEqual(original);
  });
});

// =============================================================================
// shouldExcludeFromBackup — worktrees + user data must not end up in backups
// =============================================================================

describe("shouldExcludeFromBackup", () => {
  // Platform-native worktree dirs host nested sub-repos spawned by the CLI.
  // Snapshotting them on every update would duplicate gigabytes; they must
  // be excluded regardless of which platform put them there.
  it.each([
    ".cursor/worktrees/feature-x/src/main.ts",
    ".cursor/worktrees/bugfix-1/README.md",
    ".gemini/worktrees/exp/file.txt",
    ".factory/worktrees/any/file.md",
  ])("excludes %s (worktrees convention)", (p) => {
    expect(shouldExcludeFromBackup(p)).toBe(true);
  });

  it("excludes singular /worktree/ variant", () => {
    expect(shouldExcludeFromBackup(".opencode/worktree/branch/file.ts")).toBe(
      true,
    );
  });

  it.each([
    ".opencode/node_modules/@opencode-ai/sdk/package.json",
    ".cstl/.backup-2026-04-22T10-24-27/.opencode/node_modules/zod/index.js",
  ])("excludes dependency tree %s", (p) => {
    expect(shouldExcludeFromBackup(p)).toBe(true);
  });

  it.each([
    ".cstl/workspace/developer/journal-1.md",
    ".cstl/tasks/04-17-foo/prd.md",
    ".cstl/spec/cli/backend/index.md",
    ".cstl/middleware/smart-search.yaml",
    ".cstl/backlog/idea.md",
    ".cstl/agent-traces/trace.jsonl",
  ])("excludes user data %s", (p) => {
    expect(shouldExcludeFromBackup(p)).toBe(true);
  });

  it("excludes previous backups", () => {
    expect(
      shouldExcludeFromBackup(".cstl/.backup-2026-04-20T01-00-00/x"),
    ).toBe(true);
  });

  it.each([
    ".cursor/commands/trellis/continue.md",
    ".cursor/skills/cstl-check/SKILL.md",
    ".cstl/workflow.md",
    ".cstl/scripts/get_context.py",
    ".agents/skills/cstl-check/SKILL.md",
  ])("includes managed file %s", (p) => {
    expect(shouldExcludeFromBackup(p)).toBe(false);
  });

  it("does not treat 'worktrees' as a substring match outside path segments", () => {
    // Files that happen to have "worktree" in their name but aren't inside a
    // worktree dir should still be backed up.
    expect(shouldExcludeFromBackup(".cursor/worktree-notes.md")).toBe(false);
  });

  // Windows `path.relative` returns backslash paths. The slash-prefixed
  // exclude patterns (/worktrees/, /tasks/, /spec/, ...) must still match
  // after normalization, otherwise Trellis's native worktree protection
  // silently fails on Windows and `collectAllFiles` descends into nested
  // full project copies (observed in the field: stack-overflow crash on
  // `cstl update --migrate`, late April 2026).
  it.each([
    ".cursor\\worktrees\\feat-x\\src\\main.ts",
    ".trellis\\tasks\\04-17-foo\\prd.md",
    ".trellis\\workspace\\dev\\journal-1.md",
    ".opencode\\node_modules\\zod\\index.js",
  ])("excludes Windows-style backslash path %s", (p) => {
    expect(shouldExcludeFromBackup(p)).toBe(true);
  });
});

describe("collectTemplateFiles — modules vs middleware", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-collect-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes .cstl/modules index and contracts, never middleware or catalog.ts", () => {
    const files = collectTemplateFiles(tmpDir);
    const keys = [...files.keys()];

    expect(files.has(`${PATHS.MODULES}/index.json`)).toBe(true);
    expect(files.has(`${PATHS.MODULES}/intake-basic/contract.md`)).toBe(true);
    expect(files.has(`${PATHS.MODULES}/catalog.ts`)).toBe(false);
    expect(keys.some((key) => key.endsWith("catalog.ts"))).toBe(false);
    expect(keys.some((key) => key.endsWith(".ts") && key.includes("/modules/"))).toBe(
      false,
    );
    expect(
      keys.some(
        (key) =>
          key === PATHS.MIDDLEWARE || key.startsWith(`${PATHS.MIDDLEWARE}/`),
      ),
    ).toBe(false);
  });
});

describe("collectMissingTemplateHashes", () => {
  const modulePath = `${PATHS.MODULES}/intake-basic/contract.md`;

  it("records unchanged canary-copied modules that have no stored hash", () => {
    const missing = collectMissingTemplateHashes(
      {
        unchangedFiles: [
          {
            path: `/tmp/${modulePath}`,
            relativePath: modulePath,
            newContent: "# intake-basic\n",
            status: "unchanged",
          },
        ],
      },
      {},
    );
    expect(missing.get(modulePath)).toBe("# intake-basic\n");
  });

  it("still records AGENTS.md when the file matches and the hash is missing", () => {
    const missing = collectMissingTemplateHashes(
      {
        unchangedFiles: [
          {
            path: `/tmp/${FILE_NAMES.AGENTS}`,
            relativePath: FILE_NAMES.AGENTS,
            newContent: "block\n",
            status: "unchanged",
          },
        ],
      },
      {},
    );
    expect(missing.get(FILE_NAMES.AGENTS)).toBe("block\n");
  });

  it("skips unchanged files that already have a hash", () => {
    const missing = collectMissingTemplateHashes(
      {
        unchangedFiles: [
          {
            path: `/tmp/${modulePath}`,
            relativePath: modulePath,
            newContent: "# intake-basic\n",
            status: "unchanged",
          },
        ],
      },
      { [modulePath]: "already-tracked" },
    );
    expect(missing.size).toBe(0);
  });
});
