#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Probe wrapper: smart-search is an independent Middleware Provider.
// Missing package is degraded, not a Core/Kernel load failure.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const smartSearchBin = join(
  __dirname,
  "..",
  "..",
  "node_modules",
  "@blxzer",
  "smart-search",
  "npm",
  "bin",
  "smart-search.js"
);

if (!existsSync(smartSearchBin)) {
  console.error(
    "smart-search Provider is not installed. Pactile treats this as optional Middleware (external-knowledge). Install @blxzer/smart-search separately, or continue tasks that do not need external knowledge.",
  );
  process.exit(2);
}

const child = spawn(process.execPath, [smartSearchBin, ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true,
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
