/** Canonical Pactile project templates installed by the Node CLI. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const templateRoot = dirname(fileURLToPath(import.meta.url));

function readTemplate(relativePath: string): string {
  return readFileSync(join(templateRoot, relativePath), "utf8");
}

export const workflowMdTemplate = readTemplate("workflow.md");
export const configYamlTemplate = readTemplate("config.yaml");
export const gitignoreTemplate = readTemplate("gitignore.txt");
export const executionStrategyRulesJson = readTemplate("config/execution-strategy-rules.json");
export const contextMdTemplate = readTemplate("CONTEXT.md");
export const adrReadmeTemplate = readTemplate("docs/adr/README.md");

const RELEASE_TASK_TEMPLATE_FILES = ["prd.md", "design.md", "implement.md", "handoff-template.md"] as const;

/** Optional release task artifacts plus locale-specific PRD seeds. */
export function getAllTaskTemplates(): Map<string, string> {
  const templates = new Map<string, string>();
  for (const kind of ["release-readiness", "release-execution"] as const) {
    for (const file of RELEASE_TASK_TEMPLATE_FILES) {
      const relativePath = `tasks/templates/${kind}/${file}`;
      templates.set(relativePath, readTemplate(relativePath));
    }
  }
  for (const locale of ["zh", "en"] as const) {
    const relativePath = `tasks/locale/${locale}/default-prd.md`;
    templates.set(relativePath, readTemplate(relativePath));
  }
  return templates;
}
