#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  defaultPackageRoot,
  expectedCliPackageFiles,
} from "./smart-search-vendor-utils.js";

const packageRoot = defaultPackageRoot();
const packageJsonPath = path.join(packageRoot, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
packageJson.files = expectedCliPackageFiles(packageRoot);
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf-8");
console.log(`Updated ${packageJsonPath} files (${packageJson.files.length} entries).`);