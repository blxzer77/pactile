/**
 * Path constants for the Pactile workflow structure
 *
 * Change these values to rename directories across the entire project.
 * All paths should be relative to the project root.
 */

import { DEFAULT_CANONICAL_PATHS_V1 } from "../core/index.js";

/** Canonical Pactile Runtime SSOT. */
export const PACTILE_PATHS = DEFAULT_CANONICAL_PATHS_V1;

export const DIR_NAMES = {
  /** Root workflow directory */
  WORKFLOW: ".pactile",
  /** Workspace directory (under .pactile/) - developer work areas */
  WORKSPACE: "workspace",
  /** Tasks directory (under .pactile/) - unified task storage */
  TASKS: "tasks",
  /** Archive directory (under tasks/) */
  ARCHIVE: "archive",
  /** Spec/guidelines directory (under .pactile/) */
  SPEC: "spec",
  /** Framework docs directory (under .pactile/) - framework-owned, update-managed */
  FRAMEWORK: "framework",
  /** Scripts directory (under .pactile/) */
  SCRIPTS: "scripts",
  /** Short-contract modules (under .pactile/) — index.json + <id>/contract.md */
  MODULES: "modules",
  /** User middleware overlay (under .pactile/) — never written/hashed by init/update */
  MIDDLEWARE: "middleware",
} as const;

// File names
export const FILE_NAMES = {
  /** Root agent instructions file */
  AGENTS: "AGENTS.md",
  /** Developer identity file */
  DEVELOPER: ".developer",
  /** Current task pointer */
  CURRENT_TASK: ".current-task",
  /** Task metadata */
  TASK_JSON: "task.json",
  /** Requirements document */
  PRD: "prd.md",
  /** Workflow guide */
  WORKFLOW_GUIDE: "workflow.md",
  /** Journal file prefix */
  JOURNAL_PREFIX: "journal-",
} as const;

// Constructed paths (relative to project root)
export const PATHS = {
  /** .pactile/ */
  WORKFLOW: DIR_NAMES.WORKFLOW,
  /** .pactile/workspace/ */
  WORKSPACE: `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.WORKSPACE}`,
  /** .pactile/tasks/ */
  TASKS: `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.TASKS}`,
  /** .pactile/spec/ */
  SPEC: `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.SPEC}`,
  /** .pactile/framework/ */
  FRAMEWORK: `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.FRAMEWORK}`,
  /** .pactile/scripts/ */
  SCRIPTS: `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.SCRIPTS}`,
  /** .pactile/modules/ — user-shipped short contracts (not catalog.ts) */
  MODULES: `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.MODULES}`,
  /** .pactile/middleware/ — user overlay; update never writes, deletes, or hashes */
  MIDDLEWARE: `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.MIDDLEWARE}`,
  /** .pactile/.developer */
  DEVELOPER_FILE: `${DIR_NAMES.WORKFLOW}/${FILE_NAMES.DEVELOPER}`,
  /** .pactile/.current-task */
  CURRENT_TASK_FILE: `${DIR_NAMES.WORKFLOW}/${FILE_NAMES.CURRENT_TASK}`,
  /** .pactile/workflow.md */
  WORKFLOW_GUIDE_FILE: `${DIR_NAMES.WORKFLOW}/${FILE_NAMES.WORKFLOW_GUIDE}`,
} as const;

/**
 * Get developer's workspace directory path
 * @example getWorkspaceDir("john") => ".pactile/workspace/john"
 */
export function getWorkspaceDir(developer: string): string {
  return `${PATHS.WORKSPACE}/${developer}`;
}

/**
 * Get task directory path
 * @example getTaskDir("01-21-my-task") => ".pactile/tasks/01-21-my-task"
 */
export function getTaskDir(taskName: string): string {
  return `${PATHS.TASKS}/${taskName}`;
}

/**
 * Get archive directory path
 * @example getArchiveDir() => ".pactile/tasks/archive"
 */
export function getArchiveDir(): string {
  return `${PATHS.TASKS}/${DIR_NAMES.ARCHIVE}`;
}

/**
 * True for the user middleware overlay and any file under it.
 * `pactile init` / `pactile update` must never write, delete, or hash these paths.
 */
export function isUserMiddlewareOverlayPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return (
    normalized === PATHS.MIDDLEWARE ||
    normalized.startsWith(`${PATHS.MIDDLEWARE}/`)
  );
}
