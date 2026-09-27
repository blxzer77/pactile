import path from "node:path";
import fs from "node:fs";
import { resolveLegacyWorkflowDirName } from "../pactile/runtime/paths.js";

/** Legacy workflow root retained as a read-only migration input. */
export const LEGACY_WORKFLOW_DIR = ".trellis";
export const LEGACY_CSTL_WORKFLOW_DIR = ".cstl";
export const CANONICAL_WORKFLOW_DIR = ".pactile";

/**
 * Resolve the active workflow directory name for this project. New writes use
 * `.pactile/`; legacy roots remain read-only discovery inputs during 0.5.x.
 */
export function resolveWorkflowDirName(cwd: string): string | null {
  if (fs.existsSync(path.join(cwd, CANONICAL_WORKFLOW_DIR)))
    return CANONICAL_WORKFLOW_DIR;
  return resolveLegacyWorkflowDirName(cwd);
}

/** Absolute path to the active workflow root, or null when not initialized. */
export function workflowDirPath(cwd: string): string | null {
  const name = resolveWorkflowDirName(cwd);
  return name ? path.join(cwd, name) : null;
}

export function isWorkflowInitialized(cwd: string): boolean {
  return resolveWorkflowDirName(cwd) !== null;
}

/** Join a path segment under the active workflow dir (POSIX-style relative segments). */
export function workflowPath(
  cwd: string,
  ...segments: string[]
): string | null {
  const root = workflowDirPath(cwd);
  if (!root) {
    return null;
  }
  return path.join(root, ...segments);
}
