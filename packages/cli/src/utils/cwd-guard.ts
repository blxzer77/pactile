/**
 * Homedir guard for destructive commands (init, uninstall).
 *
 * Running `pactile init` / `pactile uninstall` in `$HOME` is unsafe:
 * platforms like Claude Code, Codex, OpenCode all store global runtime data
 * (`.claude/projects/<sanitized-cwd>/*.jsonl` chat history, `.codex/sessions/`,
 * `.opencode/` caches, etc.) directly in the user's home directory. If
 * Pactile manages the same `.{platform}/` config dirs and the hash manifest
 * picks up runtime data, uninstall would later unlink it.
 *
 * Subdirectories of home (`~/Documents/projects/foo/`) are NOT blocked — only
 * exact-home match.
 *
 * Bypass: `PACTILE_ALLOW_HOMEDIR=1`.
 */

import { realpathSync } from "node:fs";
import * as os from "node:os";

import {
  PACTILE_ENVIRONMENT_KEYS,
  readPactileEnvironment,
} from "../core/index.js";

/**
 * Returns true if `process.cwd()` is exactly the user's home directory.
 *
 * Uses `realpathSync.native()` on both sides so symlinks, `..` segments, and
 * case differences (Windows) don't confuse the comparison. On Windows the
 * comparison is also case-insensitive — `C:\Users\Alice` matches
 * `c:\users\alice`.
 *
 * Permissive on lookup failure: if realpath fails for any reason (broken
 * symlink, EACCES, etc.) we return false so a safety check doesn't crash
 * the command.
 */
export function isCwdHomedir(): boolean {
  try {
    let cwd = realpathSync.native(process.cwd());
    let home = realpathSync.native(os.homedir());
    if (process.platform === "win32") {
      cwd = cwd.toLowerCase();
      home = home.toLowerCase();
    }
    return cwd === home;
  } catch {
    return false;
  }
}

/**
 * Error message printed by destructive Pactile commands when
 * the homedir guard trips.
 */
export function homedirGuardMessage(
  commandName: "init" | "uninstall" | "detach" | "rollback" | "purge",
): string {
  return (
    `✗ Refusing to run \`pactile ${commandName}\` in your home directory.\n\n` +
    `Pactile manages platform config dirs like .claude/, .codex/, .opencode/, which\n` +
    `in your home directory also contain runtime data from those CLIs (chat history,\n` +
    `session JSONLs, caches). Running here can wipe that data.\n\n` +
    `Run pactile from your project directory instead. If you really want to run in\n` +
    `$HOME, set PACTILE_ALLOW_HOMEDIR=1.`
  );
}

/**
 * Returns true when the bypass env var is set.
 */
export function homedirBypassEnabled(): boolean {
  return (
    readPactileEnvironment(PACTILE_ENVIRONMENT_KEYS.allowHomeDirectory) === "1"
  );
}
