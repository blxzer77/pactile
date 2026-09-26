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

  it("keeps brainstorm readiness consistent with conditional Grill routing", () => {
    const brainstorm = readUtf8(
      path.join(templates, "common/skills/brainstorm.md"),
    );
    const defineExtended = readUtf8(
      path.join(templates, "pactile/modules/define-extended/contract.md"),
    );
    const sharedConfigurator = readUtf8(
      path.join(cliRoot, "src/configurators/shared.ts"),
    );

    expect(defineExtended).toContain(
      "触发：Phase=Define 且（Rigor=Full 或硬 Risk 或用户明确要深挖/研究/设计）。",
    );
    expect(defineExtended).toContain(
      "Lite 成功路径可以全程不见 Grill、不见 Design。",
    );
    expect(defineExtended).toContain(
      "Lite 写完 PRD+AC 就可以去请 Execute，不必经过本块。",
    );
    expect(defineExtended).toContain(
      "Design 角色仅当 Risk/Policy 或 `verification_profile: architecture` 要求时才成为必产出",
    );
    expect(brainstorm).toContain("PRD Grill is an optional planning aid");
    expect(brainstorm).toContain(
      "a Lite task with a clear, testable PRD and acceptance criteria may skip it",
    );
    expect(sharedConfigurator).toContain(
      "with optional PRD Grill when useful",
    );
    expect(sharedConfigurator).toContain(
      "Resolve blocking business questions with `pactile-micro-grill` whether or not the Grill pass runs.",
    );
    expect(brainstorm).toContain(
      "Ask only about unresolved **blocking** product decisions",
    );
    expect(brainstorm).toContain(
      "identified during repository evidence, PRD drafting, or an optional PRD Grill pass.",
    );
    expect(brainstorm).toContain(
      "This applies whether or not PRD Grill runs:",
    );
    expect(brainstorm).toContain("If PRD Grill ran, also require:");
    expect(brainstorm).toContain(
      "- **No blocking** open questions in `prd.md`",
    );
    expect(brainstorm).toContain(
      "- Acceptance criteria are testable; out of scope is explicit",
    );
    expect(brainstorm).toContain(
      "- User reviewed artifacts or explicitly approved proceeding",
    );
    expect(brainstorm).toContain(
      "Do not start implementation until the user approves or asks for implementation.",
    );
    expect(brainstorm).toContain(
      "A Lite path that skips Grill follows the baseline criteria without a Grill-specific checklist requirement.",
    );
    expect(brainstorm).not.toContain(
      "Complete **PRD Grill** (below) and **`pactile-micro-grill`**",
    );
  });

  it("makes design.md conditional for complex planning artifacts", () => {
    const brainstorm = readUtf8(
      path.join(templates, "common/skills/brainstorm.md"),
    );

    expect(brainstorm).toContain(
      "Complex tasks must have `prd.md` and `implement.md`",
    );
    expect(brainstorm).toContain(
      "include `design.md` only when Risk/Policy or `verification_profile: architecture` requires it.",
    );
    expect(brainstorm).toContain(
      "Complex tasks: `implement.md` present; `design.md` only when Risk/Policy or `verification_profile: architecture` requires it",
    );
    expect(brainstorm).not.toContain(
      "Complex tasks: `design.md` and `implement.md` present",
    );
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
