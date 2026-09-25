import { execFileSync } from "node:child_process";

/** Removes only a Git-registered worktree; Git's non-force safety checks remain authoritative. */
export function removeManagedGitWorktree(repoRoot: string, canonicalPath: string, verifyBeforeRemove: () => void): void {
  verifyBeforeRemove();
  execFileSync("git", ["worktree", "remove", canonicalPath], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}
