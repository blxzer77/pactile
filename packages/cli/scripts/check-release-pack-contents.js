import path from "node:path";
import { pathToFileURL } from "node:url";

import { createCommandRunner } from "./release-guard.js";

export const REQUIRED_RELEASE_FILES = [
  "bin/pactile.js",
  "bin/cstl.js",
  "bin/compat-warning.js",
  "bin/smart-search.js",
  "dist/cli/index.js",
  "dist/commands/pi.js",
  "dist/commands/codex.js",
  "dist/commands/parallel.js",
  "dist/pactile/pi/bridge.js",
  "dist/pactile/pi/rpc.js",
  "dist/pactile/codex/bridge.js",
  "dist/pactile/parallel/batch.js",
  "dist/pactile/parallel/policy.js",
  "dist/migrations/manifests/0.6.0-beta.1.json",
  "dist/migrations/manifests/0.6.0.json",
  "dist/core/index.js",
  "dist/core/index.d.ts",
  "dist/core/task/index.js",
  "dist/core/task/index.d.ts",
  "dist/templates/pactile/index.js",
  "dist/templates/pactile/workflow.md",
  "dist/templates/pactile/modules/index.json",
  "dist/templates/pactile/modules/intake-basic/contract.md",
  "scripts/postinstall.js",
  "README.md",
  "LICENSE",
];

const FORBIDDEN_FRAGMENTS = [
  ".smart-search-python",
  "vendor/",
  "__pycache__",
  ".egg-info",
];
const FORBIDDEN_SUFFIXES = [".py", ".pyc", ".pyo"];

export function validateReleasePackPaths(inputPaths) {
  const paths = new Set(
    inputPaths.map((file) => String(file).replace(/\\/g, "/")),
  );
  const errors = [];

  for (const file of REQUIRED_RELEASE_FILES) {
    if (!paths.has(file)) errors.push(`missing required packed file: ${file}`);
  }
  for (const file of paths) {
    for (const fragment of FORBIDDEN_FRAGMENTS) {
      if (file.includes(fragment))
        errors.push(`forbidden packed path: ${file}`);
    }
    for (const suffix of FORBIDDEN_SUFFIXES) {
      if (file.endsWith(suffix)) errors.push(`forbidden packed path: ${file}`);
    }
  }
  if (
    ![...paths].some((file) => file.startsWith("dist/migrations/manifests/"))
  ) {
    errors.push("missing migration manifests under dist/migrations/manifests/");
  }
  if (
    ![...paths].some((file) =>
      file.startsWith("dist/templates/common/bundled-skills/"),
    )
  ) {
    errors.push(
      "missing bundled skill templates under dist/templates/common/bundled-skills/",
    );
  }
  return errors;
}

export function checkReleasePackContents({
  runner = createCommandRunner(),
} = {}) {
  const raw = runner(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      capture: true,
      env: {
        ...process.env,
        PACTILE_SKIP_SMART_SEARCH_POSTINSTALL: "1",
      },
    },
  );
  const payload = JSON.parse(String(raw));
  const paths = (payload[0]?.files ?? []).map((file) => file.path);
  const errors = validateReleasePackPaths(paths);
  if (errors.length > 0) {
    throw new Error(
      `Release pack contents check failed:\n${errors
        .map((error) => `  - ${error}`)
        .join("\n")}`,
    );
  }
  return paths.length;
}

function main() {
  try {
    const count = checkReleasePackContents();
    console.log(
      `ok release pack contents include runtime assets and exclude generated artifacts (${count} files).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const invokedAs = process.argv[1];
if (
  invokedAs &&
  import.meta.url === pathToFileURL(path.resolve(invokedAs)).href
) {
  main();
}
