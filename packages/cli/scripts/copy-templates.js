#!/usr/bin/env node

/**
 * Cross-platform script to copy template files to dist/
 *
 * This script copies src/templates/ to dist/templates/ (excluding .ts files).
 *
 * The templates are product templates for user projects:
 * - src/templates/pactile/ - workflow scripts and config
 * - src/templates/common/ - shared Codex Skills and commands
 * - src/templates/markdown/ - Markdown templates (spec, guides)
 *
 * The source is the package template tree, never a maintainer checkout's
 * project-local configuration.
 */

import { cpSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";

const EXCLUDED_TEMPLATE_ENTRIES = new Set(["__pycache__", ".DS_Store"]);
const EXCLUDED_TEMPLATE_EXTENSIONS = new Set([".pyc", ".pyo", ".ts"]);

function shouldSkipTemplateEntry(entry) {
  return (
    EXCLUDED_TEMPLATE_ENTRIES.has(entry) ||
    EXCLUDED_TEMPLATE_EXTENSIONS.has(extname(entry))
  );
}

/**
 * Recursively copy directory, excluding source and runtime cache artifacts.
 * Python hooks are executed during local tests, so ignored `__pycache__`
 * directories can exist in src/templates; they must not be copied into the npm
 * tarball.
 *
 * @param {string} src - Source directory
 * @param {string} dest - Destination directory
 */
function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });

  for (const entry of readdirSync(src)) {
    if (shouldSkipTemplateEntry(entry)) {
      continue;
    }

    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      cpSync(srcPath, destPath);
    }
  }
}

// Copy src/templates to dist/templates
copyDir("src/templates", "dist/templates");
console.log("Copied src/templates/ to dist/templates/");

// Copy src/migrations/manifests to dist/migrations/manifests
copyDir("src/migrations/manifests", "dist/migrations/manifests");
console.log("Copied src/migrations/manifests/ to dist/migrations/manifests/");

console.log("Template copy complete.");
