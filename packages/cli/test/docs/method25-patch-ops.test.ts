import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(testDir, "../..");
const repoRoot = path.resolve(cliRoot, "../..");

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

describe("Method 2.5 / Cursor++ docs retired (P23)", () => {
  const DOC_PATHS = [
    path.join(repoRoot, "docs/cursor.md"),
    path.join(repoRoot, "docs/cursor.zh-CN.md"),
  ];

  it("marks Cursor++ / Method 2.5 as retired without live setup steps", () => {
    for (const docPath of DOC_PATHS) {
      const content = readUtf8(docPath);
      expect(content, docPath).toMatch(
        /(?:alternate client|Cursor adapter) is retired|(?:替代客户端|Cursor 适配器)已退役/i,
      );
      expect(content, docPath).toMatch(
        /do not run|勿.*运行|retired|已退役|已废弃|not a current product path|不是当前产品路径/i,
      );
      expect(content, docPath).not.toMatch(/cstl init --cursor --cursor2plus/);
      expect(content, docPath).not.toMatch(
        /python \.cstl\/local\/cursor2plus\/patch_wpelc8\.py --check-compat/,
      );
    }
  });

  it("does not present WPeLc8 as an eternal stable API in user-facing cursor docs", () => {
    const en = readUtf8(path.join(repoRoot, "docs/cursor.md"));
    const zh = readUtf8(path.join(repoRoot, "docs/cursor.zh-CN.md"));
    // Historical mentions may remain; must not instruct apply/patch as current product
    expect(en).not.toMatch(/python patch_wpelc8\.py --apply/);
    expect(zh).not.toMatch(/python patch_wpelc8\.py --apply/);
  });

  it("live product templates no longer ship Cursor++ setup skill/command", () => {
    expect(
      fs.existsSync(
        path.join(
          cliRoot,
          "src/templates/common/bundled-skills/cstl-cursor2plus-setup/SKILL.md",
        ),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          cliRoot,
          "src/templates/cursor/commands/cursor2plus-setup.md",
        ),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(cliRoot, "src/templates/pactile/local")),
    ).toBe(false);
  });
});
