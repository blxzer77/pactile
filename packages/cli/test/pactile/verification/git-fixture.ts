import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TemporaryGitRepository {
  readonly root: string;
  readonly branch: string;
  readonly head: string;
}

export function runGit(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trimEnd();
}

export function createTemporaryGitRepository(): TemporaryGitRepository {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-verification-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "task.ts"),
    "export const task = 'base';\n",
  );
  runGit(root, ["init", "--quiet"]);
  runGit(root, ["config", "user.name", "Verification Test"]);
  runGit(root, ["config", "user.email", "verification@example.invalid"]);
  runGit(root, ["add", "--all"]);
  runGit(root, ["commit", "--quiet", "-m", "initial candidate"]);
  return {
    root,
    branch: runGit(root, ["branch", "--show-current"]),
    head: runGit(root, ["rev-parse", "HEAD"]).toLowerCase(),
  };
}

export function removeTemporaryGitRepository(
  repository: TemporaryGitRepository,
): void {
  fs.rmSync(repository.root, { recursive: true, force: true });
}
