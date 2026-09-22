import { describe, expect, it } from "vitest";
import { getBundledSkillTemplates, getOptionalSkillTemplates } from "../../src/templates/common/index.js";
import { resolveOptionalSkills } from "../../src/configurators/shared.js";
import { AI_TOOLS } from "../../src/types/ai-tools.js";

describe("optional-skills template pipeline", () => {
  it("getBundledSkillTemplates() never scans the optional-skills container", () => {
    const names = getBundledSkillTemplates().map((s) => s.name);
    expect(names).not.toContain("optional-skills");
  });

  it("ships no optional skill", () => {
    // The directory is intentionally empty: nothing is installed by default
    // and nothing outside the declared capability registry is advertised.
    expect(getOptionalSkillTemplates()).toEqual([]);
  });

  it("resolveOptionalSkills([]) resolves nothing", () => {
    expect(resolveOptionalSkills([], AI_TOOLS.cursor.templateContext)).toEqual([]);
  });

  it("resolveOptionalSkills throws on unknown names (loud failure, no silent no-op)", () => {
    expect(() =>
      resolveOptionalSkills(["nope-missing"], AI_TOOLS.cursor.templateContext),
    ).toThrow(/Unknown optional skill\(s\): nope-missing/);
  });
});
