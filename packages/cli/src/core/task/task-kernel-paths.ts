import fs from "node:fs";
import path from "node:path";

import { KernelError, requireNonEmptyString, type KernelOutcome, type KernelPhase } from "./kernel-contract.js";
import { readKernel, readKernelStateDocument, withKernelStateLock } from "./kernel-store.js";
import { isPlainObject } from "./schema.js";
import { parseTaskKernelSnapshotV2 } from "./task-kernel-schema.js";
import {
  listLegacyTaskMigrationDirectories,
  listSupersededLegacyTaskSourceDirectories,
  readLegacyTaskImportRecord,
  readLegacyTaskMigrationView,
  type LegacyTaskMigrationView,
} from "./legacy-task-migration-reader.js";
import { readTaskKernel } from "./task-kernel-store-v2.js";
import { TASK_KERNEL_SCHEMA_VERSION } from "./task-kernel-types.js";

export function assertUniqueTaskId(
  root: string,
  taskId: string,
  ignoredDir: string,
  validatedView?: LegacyTaskMigrationView | null,
): void {
  const match = findTaskById(root, taskId, ignoredDir, validatedView);
  if (match && path.resolve(match.taskDir) !== path.resolve(ignoredDir)) throw new KernelError("INVALID_REQUEST", `Task ID already exists: ${taskId}`);
}

export function assertDependenciesResolvable(root: string, taskId: string, dependencies: readonly string[], ignoredDir?: string): void {
  const canonicalRoot = canonicalProjectRoot(root);
  for (const dependency of dependencies) {
    if (dependency === taskId) throw new KernelError("INVALID_REQUEST", "a Task cannot depend on itself");
    if (!findTaskById(canonicalRoot, dependency, ignoredDir)) throw new KernelError("DEPENDENCY_UNSATISFIED", `hard dependency not found: ${dependency}`);
  }
}

export function assertNoDependencyCycle(
  root: string,
  taskId: string,
  dependencies: readonly string[],
  ignoredDir: string,
  validatedView?: LegacyTaskMigrationView | null,
): string {
  const canonicalRoot = canonicalProjectRoot(root);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const graph = new Map<string, { readonly taskDir: string | null; readonly dependencies: readonly string[] }>();
  const visit = (currentId: string): void => {
    if (currentId === taskId) throw new KernelError("INVALID_REQUEST", `hard dependency cycle reaches ${taskId}`);
    if (visited.has(currentId) || visiting.has(currentId)) return;
    visiting.add(currentId);
    const located = findTaskById(canonicalRoot, currentId, ignoredDir, validatedView);
    graph.set(currentId, {
      taskDir: located ? path.resolve(located.taskDir) : null,
      dependencies: located ? [...new Set(located.dependencies)].sort() : [],
    });
    if (located && path.resolve(located.taskDir) !== path.resolve(ignoredDir)) {
      for (const dependency of located.dependencies) visit(dependency);
    }
    visiting.delete(currentId);
    visited.add(currentId);
  };
  for (const dependency of dependencies) visit(dependency);
  return JSON.stringify(
    [...graph.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, node]) => ({ id, ...node })),
  );
}

export function assertHardDependenciesSatisfied(root: string, dependencies: readonly string[], ignoredDir?: string): void {
  const canonicalRoot = canonicalProjectRoot(root);
  const unmet = dependencies.filter((id) => {
    const task = findTaskById(canonicalRoot, id, ignoredDir);
    return task?.phase !== "close" || task.outcome !== "completed";
  });
  if (unmet.length) throw new KernelError("DEPENDENCY_UNSATISFIED", `hard dependencies must be closed successfully: ${unmet.join(", ")}`);
}

/** Resolves a Task ID across active and archived records for read-only evidence checks. */
export function resolveTaskDirectoryById(
  root: string,
  taskId: string,
  validatedView?: LegacyTaskMigrationView | null,
): string | null {
  const located = findTaskById(root, requireNonEmptyString(taskId, "taskId"), undefined, validatedView);
  return located?.taskDir ?? null;
}

interface LocatedTask {
  taskDir: string;
  taskId: string;
  phase: KernelPhase;
  outcome: KernelOutcome | null;
  dependencies: string[];
}

function findTaskById(
  root: string,
  taskId: string,
  ignoredDir?: string,
  validatedView?: LegacyTaskMigrationView | null,
): LocatedTask | null {
  const canonicalRoot = canonicalProjectRoot(root);
  let migrationView: ReturnType<typeof readLegacyTaskMigrationView>;
  try {
    migrationView = validatedView === undefined
      ? readLegacyTaskMigrationView(canonicalRoot)
      : validatedView;
  } catch (error) {
    throw new KernelError("CORRUPT_STATE", error instanceof Error ? error.message : String(error));
  }
  const supersededSources = new Set(listSupersededLegacyTaskSourceDirectories(canonicalRoot, migrationView));
  const matches = enumerateTaskDirs(canonicalRoot, migrationView).flatMap((taskDir) => {
    if (ignoredDir && path.resolve(taskDir) === path.resolve(ignoredDir)) return [];
    if (supersededSources.has(path.resolve(taskDir))) return [];
    const importRecord = readLegacyTaskImportRecord(canonicalRoot, taskDir, migrationView);
    if (importRecord) {
      if (importRecord.status !== "imported") {
        if (importRecord.legacyTaskId !== taskId) return [];
        return [{
          taskDir,
          taskId,
          phase: "define" as KernelPhase,
          outcome: null,
          dependencies: [...importRecord.dependencyFacts.hardDependencies],
        }];
      }
      try {
        const read = readTaskKernel({ root: canonicalRoot, taskDir, validatedView: migrationView });
        if (read.kind === "task-kernel-v2" && read.kernel.identity.taskId === taskId) {
          return [{ taskDir, taskId, phase: read.kernel.phase, outcome: read.kernel.outcome, dependencies: read.kernel.definition.dependencies }];
        }
      } catch {
        if (importRecord.legacyTaskId === taskId)
          return [{ taskDir, taskId, phase: "define" as KernelPhase, outcome: null, dependencies: [...importRecord.dependencyFacts.hardDependencies] }];
      }
      return [];
    }
    try {
      const document = withKernelStateLock(taskDir, undefined, (dir) => readKernelStateDocument(dir));
      if (isPlainObject(document) && document.schemaVersion === TASK_KERNEL_SCHEMA_VERSION) {
        const kernel = parseTaskKernelSnapshotV2(document);
        return kernel.identity.taskId === taskId ? [{ taskDir, taskId, phase: kernel.phase, outcome: kernel.outcome, dependencies: kernel.definition.dependencies }] : [];
      }
      const legacy = readKernel({ taskDir });
      if (legacy.legacy.id !== taskId) return [];
      const rawExtras = legacy.kernel.projection?.extras ?? {};
      return [{ taskDir, taskId, phase: legacy.kernel.phase, outcome: legacy.kernel.outcome, dependencies: Array.isArray(rawExtras.depends_on) ? rawExtras.depends_on.filter((value): value is string => typeof value === "string") : [] }];
    } catch { return []; }
  });
  if (matches.length > 1) throw new KernelError("INVALID_REQUEST", `Task ID is ambiguous across active and archived records: ${taskId}`);
  return matches[0] ?? null;
}

function enumerateTaskDirs(root: string, migrationView?: ReturnType<typeof readLegacyTaskMigrationView>): string[] {
  const canonicalRoot = canonicalProjectRoot(root);
  const tasksRoot = path.resolve(canonicalRoot, ".pactile", "tasks");
  const result: string[] = [];
  if (fs.existsSync(tasksRoot)) {
    for (const entry of fs.readdirSync(tasksRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || ["archive", "locale", "templates"].includes(entry.name)) continue;
      result.push(path.join(tasksRoot, entry.name));
    }
    const archive = path.join(tasksRoot, "archive");
    if (fs.existsSync(archive)) for (const month of fs.readdirSync(archive, { withFileTypes: true })) {
      if (!month.isDirectory()) continue;
      const monthDir = path.join(archive, month.name);
      for (const entry of fs.readdirSync(monthDir, { withFileTypes: true })) if (entry.isDirectory()) result.push(path.join(monthDir, entry.name));
    }
  }
  result.push(...listLegacyTaskMigrationDirectories(root, migrationView));
  return [...new Set(result)];
}

export function resolveInsideTasksRoot(root: string, taskDir: string, cwd?: string): string {
  const base = cwd ?? process.cwd();
  const canonicalRoot = canonicalProjectRoot(root, cwd);
  const tasksRoot = path.resolve(canonicalRoot, ".pactile", "tasks");
  if (fs.existsSync(tasksRoot) && fs.realpathSync(tasksRoot) !== tasksRoot) {
    throw new KernelError("INVALID_REQUEST", "project .pactile/tasks must resolve inside the canonical project root");
  }
  const candidate = canonicalizePath(path.resolve(base, taskDir));
  const relative = path.relative(tasksRoot, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new KernelError("INVALID_REQUEST", "Task path must belong to the supplied project's .pactile/tasks tree");
  }
  return candidate;
}

export function resolveInsideTaskRoot(root: string, taskDir: string, cwd?: string): string {
  const candidate = resolveInsideTasksRoot(root, taskDir, cwd);
  const canonicalRoot = canonicalProjectRoot(root, cwd);
  const relative = path.relative(path.resolve(canonicalRoot, ".pactile", "tasks"), candidate);
  if (relative.split(path.sep).includes("archive")) {
    throw new KernelError("INVALID_REQUEST", "new Task Kernel mutations must target active .pactile/tasks records");
  }
  return candidate;
}

export function canonicalProjectRoot(root: string, cwd?: string): string {
  const canonicalRoot = canonicalizePath(path.resolve(cwd ?? process.cwd(), requireNonEmptyString(root, "root")));
  if (fs.existsSync(canonicalRoot) && !fs.statSync(canonicalRoot).isDirectory()) {
    throw new KernelError("INVALID_REQUEST", "project root must be a directory");
  }
  return canonicalRoot;
}

function canonicalizePath(candidate: string): string {
  let existing = candidate;
  const suffix: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return candidate;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.resolve(fs.realpathSync(existing), ...suffix);
}
