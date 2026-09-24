import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(testDir, "../..");
const repoRoot = path.resolve(cliRoot, "../..");
const templates = path.join(cliRoot, "src/templates");

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

describe("closed-item product-template gaps (P02/P10/P12/P14/P19/P20)", () => {
  it("P02/P10-③ CONTEXT seed has governance + architecture terms", () => {
    const context = readUtf8(path.join(templates, "pactile/CONTEXT.md"));
    expect(context).toMatch(/## Governance domain seed/);
    // The review-pool term was retired with the pool feature; the governance
    // seed still carries its remaining terms.
    expect(context).toMatch(/\*\*不足\*\*/);
    expect(context).toMatch(/\*\*拒绝知识库\*\*/);
    expect(context).toMatch(/## Architecture \(deep-module vocabulary\)/);
    expect(context).toMatch(/\*\*seam\*\*/);
    expect(context).toMatch(/\*\*locality\*\*/);
  });

  it("P10-② authoring-rules ships writing-for-agents four techniques", () => {
    const rules = readUtf8(
      path.join(
        templates,
        "common/bundled-skills/pactile-skill-creator/references/authoring-rules.md",
      ),
    );
    expect(rules).toContain("Leading words");
    expect(rules).toContain("No-op test");
    expect(rules).toContain("Negation anti-pattern");
    expect(rules).toContain("Context pointer wording");
  });

  it("P12/P20 retired goal commands stay absent after AGENTS pointer compaction", () => {
    const agents = readUtf8(path.join(templates, "markdown/agents.md"));
    expect(agents).toContain(".pactile/framework/index.md");
    expect(agents).not.toContain("cstl-goal");
    expect(
      fs.existsSync(path.join(templates, "cursor/commands/cstl-goal.md")),
    ).toBe(false);
    expect(fs.existsSync(path.join(templates, "cursor/commands/goal.md"))).toBe(
      false,
    );
  });

  it("P14 dogfood list does not present Cursor++ as an optional live surface", () => {
    const dogfood = readUtf8(
      path.join(templates, "markdown/framework/dogfood-only-surfaces.md.txt"),
    );
    expect(dogfood).toMatch(/not product templates and are not copied into a consumer project/);
    expect(dogfood).not.toMatch(/(?:is|as) an optional live (?:install|surface)/i);
    expect(dogfood).not.toMatch(/goal-regression runbook/);
  });

  it("P19 README states default Native and does not embed BYOK", () => {
    const en = readUtf8(path.join(repoRoot, "README.md"));
    const zh = readUtf8(path.join(repoRoot, "README.zh-CN.md"));
    expect(en).not.toContain("pactile-byok");
    expect(zh).not.toContain("pactile-byok");
    expect(en).not.toContain("goal-release-regression-runbook");
  });
});

describe("P43 product template mirrors", () => {
  it("ships the optional PRD grill and zero-ambiguity front-anchor contract", () => {
    const frontier = readUtf8(
      path.join(templates, "markdown/framework/prd-grill-frontier.md.txt"),
    );
    expect(frontier).toMatch(/optional brick/);
    expect(frontier).toMatch(/Front-anchor principle/);
    expect(frontier).toMatch(/AC 歧义面 = 0/);
  });

  it("ships test-brick and E2E walkthrough template assets", () => {
    const guidesDir = path.join(templates, "markdown/spec/guides");
    const discipline = readUtf8(
      path.join(guidesDir, "test-discipline-guide.md.txt"),
    );
    const e2e = readUtf8(
      path.join(guidesDir, "e2e-walkthrough-guide.md.txt"),
    );

    expect(discipline).toMatch(/测试积木/);
    expect(discipline).toMatch(/任务验证/);
    expect(discipline).toMatch(/软件测试/);
    expect(e2e).toContain("prd → 实现 → verify → archive");
    expect(e2e).toContain("projection.extras.notes_projection");
    expect(e2e).toMatch(/不是 Close \/ archive 硬门/);
  });
});
