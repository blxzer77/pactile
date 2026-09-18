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
];

const MUTUAL_EXCLUSION_PATTERNS = [
  /choose one environment/i,
  /只能选一种环境/,
  /must pick either Native or BYOK/i,
];

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

describe("Cursor env docs after Cursor++ retirement (P23)", () => {
  it("cursor docs mark Cursor++ retired and keep Native product path", () => {
    const en = readUtf8(path.join(repoRoot, "docs/cursor.md"));
    const zh = readUtf8(path.join(repoRoot, "docs/cursor.zh-CN.md"));

    expect(en).toMatch(/alternate client is retired/i);
    expect(zh).toContain("替代客户端已废弃");
    expect(en).toContain("history/cursor-plus-plus.md");
    expect(zh).toContain("history/cursor-plus-plus.zh-CN.md");
    expect(en).toContain("Native Cursor");
    expect(en).toContain("hosts/cursor.md");
    expect(zh).toContain("hosts/cursor.zh-CN.md");
    expect(en).not.toMatch(/cstl init --cursor --cursor2plus/);
    expect(zh).not.toMatch(/cstl init --cursor --cursor2plus/);
  });

  it("README files do not offer live Cursor++ install steps", () => {
    for (const readmePath of README_FILES) {
      const content = readUtf8(readmePath);
      expect(content, readmePath).toMatch(/retired|已废弃|Native/);
      expect(content, readmePath).not.toMatch(
        /cstl init --cursor --cursor2plus/,
      );
      expect(content, readmePath).not.toMatch(/patch_wpelc8\.py --apply/);
      for (const pattern of MUTUAL_EXCLUSION_PATTERNS) {
        expect(content, readmePath).not.toMatch(pattern);
      }
    }
  });

  it("local Cursor++ template directory is gone from SSOT", () => {
    expect(
      fs.existsSync(path.join(cliRoot, "src/templates/pactile/local")),
    ).toBe(false);
  });
});
