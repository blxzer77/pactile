#!/usr/bin/env node
/**
 * CLI package.json `files` allowlist helpers.
 *
 * Pactile publishes one package with an explicit file allowlist. This module
 * contains the pack-files check/sync surface used by:
 *   - scripts/sync-cli-pack-files.ts
 *   - scripts/check-cli-pack-files.ts
 */

import fs from "node:fs";
import path from "node:path";
import { resolveCliPackageRoot } from "./script-paths.js";

/** Static npm `files` entries for @blxzer/pactile. */
const cliPackFilesStatic = ["dist", "README.md", "CHANGELOG.md", "LICENSE"];

export function defaultPackageRoot() {
  return resolveCliPackageRoot(import.meta.url);
}

/**
 * Expected full `package.json` `files` array for publish.
 * @param {string} [_packageRoot] unused; kept for call-site compatibility
 */
export function expectedCliPackageFiles(_packageRoot = defaultPackageRoot()) {
  return [...cliPackFilesStatic];
}

export function readCliPackageFiles(packageRoot = defaultPackageRoot()) {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  if (!Array.isArray(packageJson.files)) {
    throw new Error("package.json is missing a files array");
  }
  return packageJson.files.map((entry) => String(entry).replace(/\\/g, "/"));
}

export function compareCliPackageFiles(packageRoot = defaultPackageRoot()) {
  const expected = expectedCliPackageFiles(packageRoot);
  const actual = readCliPackageFiles(packageRoot);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const errors = [];

  for (const file of expected) {
    if (!actualSet.has(file)) {
      errors.push(`missing from package.json files: ${file}`);
    }
  }
  for (const file of actual) {
    if (!expectedSet.has(file)) {
      errors.push(`extra pack entry: ${file}`);
    }
  }
  return errors;
}
