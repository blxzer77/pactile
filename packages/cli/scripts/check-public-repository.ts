#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: path.dirname(fileURLToPath(import.meta.url)),
  encoding: "utf8",
}).trim();
const publicDirectories = new Set([
  ".github",
  "docs",
  "examples",
  "packages",
  "scripts",
]);
const publicRootFiles = new Set([
  ".gitignore",
  "AGENTS.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "COPYRIGHT",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
  "SUPPORT.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
]);
const tracked = execFileSync("git", ["ls-files", "--cached", "-z"], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
const unexpected = tracked.filter((file) => {
  if (
    file.startsWith("docs/community/") ||
    file.startsWith("docs/history/community/") ||
    file === "docs/history/research/personal-skills-integration.md"
  ) {
    return true;
  }
  const separator = file.indexOf("/");
  return separator < 0
    ? !publicRootFiles.has(file)
    : !publicDirectories.has(file.slice(0, separator));
});

if (unexpected.length > 0) {
  console.error(
    "Files outside the public Pactile product and developer-documentation boundary:",
  );
  for (const file of unexpected) console.error(`- ${file}`);
  process.exitCode = 1;
} else {
  console.log(`ok public repository boundary: ${tracked.length} tracked files`);
}
