import { describe, expect, it } from "vitest";
import {
  configYamlTemplate,
  executionStrategyRulesJson,
  getAllTaskTemplates,
  workflowMdTemplate,
} from "../../src/templates/pactile/index.js";

describe("Node Pactile templates", () => {
  it("loads the canonical workflow, config, and strategy assets", () => {
    expect(workflowMdTemplate).toContain("#");
    expect(configYamlTemplate).toContain("artifact_locale:");
    expect(JSON.parse(executionStrategyRulesJson)).toBeTruthy();
  });

  it("provides release task seeds and both artifact locales", () => {
    const templates = getAllTaskTemplates();
    expect(templates.size).toBe(10);
    for (const kind of ["release-readiness", "release-execution"]) {
      for (const artifact of ["prd.md", "design.md", "implement.md", "handoff-template.md"]) {
        expect(templates.get(`tasks/templates/${kind}/${artifact}`)?.trim()).toBeTruthy();
      }
    }
    for (const locale of ["zh", "en"]) {
      expect(templates.get(`tasks/locale/${locale}/default-prd.md`)).toContain("{title}");
    }
  });
});
