import fs from "node:fs";
import path from "node:path";

/** Git and Node may spell one Windows directory with different aliases. */
export function sameGitRoot(gitRoot: string, expectedRoot: string): boolean {
  const gitPath = path.resolve(gitRoot);
  const expectedPath = path.resolve(expectedRoot);
  try {
    const git = fs.statSync(gitPath, { bigint: true });
    const expected = fs.statSync(expectedPath, { bigint: true });
    if (!git.isDirectory() || !expected.isDirectory()) return false;
    if (git.dev === expected.dev && git.ino !== 0n && git.ino === expected.ino) return true;
    // Some filesystems do not expose a useful inode. Accept only the same
    // resolved spelling there; an unverified alias must not pass this guard.
    return process.platform === "win32"
      ? gitPath.toLowerCase() === expectedPath.toLowerCase()
      : gitPath === expectedPath;
  } catch {
    return false;
  }
}
