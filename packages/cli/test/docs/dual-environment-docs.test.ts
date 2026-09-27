import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(testDir, "../..");
const repoRoot = path.resolve(cliRoot, "../..");

const README_FILES = [
  path.join(repoRoot, "README.md"),
  path.join(repoRoot, "README.zh-CN.md"),
  path.join(cliRoot, "README.md"),
  path.join(cliRoot, "README.zh-CN.md"),
];

const MUTUAL_EXCLUSION_PATTERNS = [
  /choose one environment/i,
  /只能选一种环境/,
  /must pick either Native or BYOK/i,
];

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

describe("retired host documentation (P24)", () => {
  it("old documentation links route to current support and history", () => {
    const en = readUtf8(path.join(repoRoot, "docs/cursor.md"));
    const zh = readUtf8(path.join(repoRoot, "docs/cursor.zh-CN.md"));

    expect(en).toMatch(/former host adapter has been\s+removed/);
    expect(zh).toContain("原宿主适配器已移除");
    expect(en).toContain("hosts/cursor.md");
    expect(en).toContain("hosts/cursor.zh-CN.md");
    expect(zh).toContain("hosts/cursor.md");
    expect(zh).toContain("hosts/cursor.zh-CN.md");
    expect(en).not.toMatch(/pactile\s+detach\s+cursor/i);
    expect(zh).not.toMatch(/pactile\s+detach\s+cursor/i);
  });

  it("README files offer only Codex installation", () => {
    for (const readmePath of README_FILES) {
      const content = readUtf8(readmePath);
      expect(content, readmePath).toContain("pactile init --codex -y");
      expect(content, readmePath).not.toMatch(/pactile init --cursor/);
      expect(content, readmePath).not.toMatch(/patch_wpelc8\.py --apply/);
      for (const pattern of MUTUAL_EXCLUSION_PATTERNS) {
        expect(content, readmePath).not.toMatch(pattern);
      }
    }
    for (const readmePath of README_FILES) {
      const content = readUtf8(readmePath);
      expect(content, readmePath).not.toMatch(/\bCursor\b/);
      expect(content, readmePath).not.toMatch(/pactile\s+detach\s+cursor/i);
    }
  });

  it("local Cursor++ template directory is gone from SSOT", () => {
    expect(
      fs.existsSync(path.join(cliRoot, "src/templates/pactile/local")),
    ).toBe(false);
  });
});
