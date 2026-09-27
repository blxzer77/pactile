import { describe, expect, it } from "vitest";
import { getBundledSkillTemplates } from "../../src/templates/common/index.js";

describe("bundled-skills template pipeline", () => {
  it("discovers every bundled skill directory", () => {
    const skillNames = getBundledSkillTemplates().map((skill) => skill.name);
    expect(skillNames.length).toBeGreaterThan(0);
    expect(skillNames).toContain("pactile-meta");
    // The scanner reads `bundled-skills/` only — sibling containers (the
    // retired `optional-skills/`) must never leak into the installed set.
    expect(skillNames).not.toContain("optional-skills");
  });

  it("ships a SKILL.md for every bundled skill", () => {
    for (const skill of getBundledSkillTemplates()) {
      expect(skill.files.map((file) => file.relativePath)).toContain("SKILL.md");
    }
  });
});
