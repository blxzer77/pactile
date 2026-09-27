import fs from "node:fs";
import path from "node:path";

/** Inventory only: never follow links or execute a retired Python entry. */
export function listLegacyPythonScripts(projectRoot: string): string[] {
  const root = path.join(projectRoot, ".pactile", "scripts");
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat) return [];
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("legacy-script-root-unsafe");
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.name.endsWith(".py")) {
        found.push(path.relative(projectRoot, target).split(path.sep).join("/"));
      }
    }
  };
  visit(root);
  return found.sort();
}
