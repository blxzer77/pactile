#!/usr/bin/env node

import {
  compareCliPackageFiles,
  defaultPackageRoot,
} from "./cli-pack-files-utils.js";

const errors = compareCliPackageFiles(defaultPackageRoot());

if (errors.length > 0) {
  console.error(
    "CLI package.json files drift from the package allowlist:",
  );
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  console.error(
    "Run: pnpm run sync:pack-files  (from packages/cli) to refresh the allowlist.",
  );
  process.exit(1);
}

console.log(
    "ok CLI package.json files match the package allowlist.",
);
