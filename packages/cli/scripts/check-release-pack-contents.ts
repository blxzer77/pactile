import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createCommandRunner } from "./release-guard.js";

export const REQUIRED_RELEASE_FILES = [
  "dist/bin/pactile.js",
  "dist/bin/cstl.js",
  "dist/bin/compat-warning.js",
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
  "dist/migrations/manifests/0.6.0-beta.2.json",
  "dist/migrations/manifests/0.6.0-beta.3.json",
  "dist/migrations/manifests/0.6.0.json",
  "dist/core/index.js",
  "dist/core/index.d.ts",
  "dist/core/task/index.js",
  "dist/core/task/index.d.ts",
  "dist/templates/pactile/index.js",
  "dist/templates/pactile/workflow.md",
  "dist/templates/pactile/modules/index.json",
  "dist/templates/pactile/modules/intake-basic/contract.md",
  "README.md",
  "LICENSE",
];

const FORBIDDEN_FRAGMENTS = [
  "dist/bin/smart-search.js",
  ".smart-search-python",
  "vendor/",
  "__pycache__",
  ".egg-info",
];
const FORBIDDEN_SUFFIXES = [".py", ".pyc", ".pyo"];
const CURSOR_IDE_CONTENT_RULES = [
  { label: "host name", pattern: /\bCursor\b/u },
  {
    label: "host phrase",
    pattern: /\bcursor[-\s]+(?:ide|editor|agent)\b/iu,
  },
  {
    label: "editor file surface",
    pattern: /(?:^|[\s"'`])\.cursor(?:[/\\]|(?=[\s"'`]|$))/iu,
  },
  {
    label: "editor command option",
    pattern: /(?:^|\s)--cursor(?=[\s=.,;:]|$)/iu,
  },
  {
    label: "legacy editor command",
    pattern: /\bpactile\s+(?:init|install|detach)\s+cursor\b/iu,
  },
  {
    label: "legacy editor package name",
    pattern: /@blxzer\/cursor-trellis(?:-core)?\b/iu,
  },
  { label: "editor rule extension", pattern: /\.mdc\b/iu },
];

function resolvePackageRoot(): string {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.cwd(),
    path.resolve(scriptDirectory, ".."),
    path.resolve(scriptDirectory, "../.."),
  ];
  for (const candidate of candidates) {
    const packageJsonPath = path.join(candidate, "package.json");
    if (!fs.existsSync(packageJsonPath)) continue;
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      if (packageJson.name === "@blxzer/pactile") return candidate;
    } catch {
      // Keep looking when the candidate does not contain readable package data.
    }
  }
  throw new Error("unable to locate the @blxzer/pactile package root");
}

const packageRoot = resolvePackageRoot();

function isCursorIdePath(file: string): boolean {
  return /(?:^|\/)(?:\.cursor|cursor|cursor-ide)(?:\/|$)/iu.test(file);
}

export function validateReleasePackPaths(
  inputPaths: string[],
  readPackedContent?: (file: string) => string | null,
) {
  const paths = new Set<string>(
    inputPaths.map((file) => String(file).replace(/\\/g, "/")),
  );
  const errors: string[] = [];

  for (const file of REQUIRED_RELEASE_FILES) {
    if (!paths.has(file)) errors.push(`missing required packed file: ${file}`);
  }
  for (const file of paths) {
    if (isCursorIdePath(file)) {
      errors.push(`forbidden Cursor IDE packed path: ${file}`);
    }
    for (const fragment of FORBIDDEN_FRAGMENTS) {
      if (file.includes(fragment))
        errors.push(`forbidden packed path: ${file}`);
    }
    for (const suffix of FORBIDDEN_SUFFIXES) {
      if (file.endsWith(suffix)) errors.push(`forbidden packed path: ${file}`);
    }
    if (readPackedContent !== undefined) {
      let content: string | null;
      try {
        content = readPackedContent(file);
      } catch (error) {
        errors.push(
          `unable to inspect packed file ${file}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (content === null) continue;
      for (const rule of CURSOR_IDE_CONTENT_RULES) {
        if (rule.pattern.test(content)) {
          errors.push(
            `forbidden Cursor IDE ${rule.label} in packed file: ${file}`,
          );
        }
      }
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
    { capture: true },
  );
  const payload = JSON.parse(String(raw));
  const paths = (payload[0]?.files ?? []).map((file) => file.path);
  const errors = validateReleasePackPaths(paths, (file) => {
    const absolutePath = path.resolve(packageRoot, ...file.split("/"));
    const relativePath = path.relative(packageRoot, absolutePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error("packed path resolves outside the CLI package");
    }
    const content = fs.readFileSync(absolutePath);
    return content.includes(0) ? null : content.toString("utf8");
  });
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
