#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");

for (const file of ["README.md", "LICENSE"]) {
  const source = path.join(repoRoot, file);
  const target = path.join(packageRoot, file);
  if (!fs.existsSync(source)) {
    console.error(`Missing release asset: ${source}`);
    process.exit(1);
  }
  fs.copyFileSync(source, target);
  console.log(`Copied ${file} into packages/cli`);
}
