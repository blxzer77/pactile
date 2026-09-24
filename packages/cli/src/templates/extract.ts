import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type TemplateCategory = "markdown" | "commands";

/**
 * Get the path to the pactile templates directory (.pactile/ scaffolding).
 */
export function getPactileTemplatePath(): string {
  const templatePath = path.join(__dirname, "pactile");
  if (fs.existsSync(templatePath)) {
    return templatePath;
  }
  throw new Error(
    "Could not find pactile templates directory. Expected at templates/pactile/",
  );
}

/** @deprecated Use getPactileTemplatePath() instead. */
export function getPactileSourcePath(): string {
  return getPactileTemplatePath();
}

/**
 * Read a file from the pactile template directory.
 */
export function readPactileFile(relativePath: string): string {
  const pactilePath = getPactileSourcePath();
  const filePath = path.join(pactilePath, relativePath);
  return fs.readFileSync(filePath, "utf-8");
}

/**
 * Read template content from a category directory.
 */
export function readTemplate(
  category: TemplateCategory,
  filename: string,
): string {
  const templatePath = path.join(__dirname, category, filename);
  return fs.readFileSync(templatePath, "utf-8");
}

export function readMarkdown(relativePath: string): string {
  return readPactileFile(relativePath);
}

export function readCommand(filename: string): string {
  return readTemplate("commands", filename);
}

const USER_MODULE_INDEX = "index.json";
const USER_MODULE_CONTRACT = "contract.md";

/**
 * User `.pactile/modules/` may only contain the catalog index and each module's
 * short contract. CLI source next to the templates (`catalog.ts`, any `.ts`)
 * must not be copied, hashed, or written into the user tree.
 */
export function isUserShippedModuleFile(relativePosix: string): boolean {
  const normalized = relativePosix.replace(/\\/g, "/");
  if (normalized.endsWith(".ts")) {
    return false;
  }
  if (normalized === USER_MODULE_INDEX) {
    return true;
  }
  const parts = normalized.split("/");
  return (
    parts.length === 2 &&
    parts[0].length > 0 &&
    parts[1] === USER_MODULE_CONTRACT
  );
}

function walkUserModuleFiles(
  absDir: string,
  relDir: string,
  out: Map<string, string>,
): void {
  if (!fs.existsSync(absDir)) {
    return;
  }
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      walkUserModuleFiles(abs, rel, out);
      continue;
    }
    if (!isUserShippedModuleFile(rel)) {
      continue;
    }
    out.set(rel, fs.readFileSync(abs, "utf-8"));
  }
}

/**
 * Walk `templates/pactile/modules/` and return the user-shipped subset.
 * Keys are POSIX paths relative to `modules/` (`index.json`, `<id>/contract.md`).
 * Shared by init (`createWorkflowStructure`) and update (`collectTemplateFiles`).
 */
export function collectUserModuleTemplates(): Map<string, string> {
  const modulesRoot = path.join(getPactileTemplatePath(), "modules");
  const files = new Map<string, string>();
  walkUserModuleFiles(modulesRoot, "", files);
  return files;
}
