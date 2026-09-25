import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertCanonicalWriteTarget } from "../runtime/paths.js";

export interface DeferredLiveWrite {
  readonly content: string;
  readonly executable: boolean;
  readonly original: Buffer | null;
  readonly originalMode?: number;
}

interface PendingDeferredLivePlan {
  schemaVersion: 1;
  sourceGenerationId: string;
  committedGenerationId: string | null;
  writes: { path: string; content: string; executable: boolean; original: string | null; originalMode?: number }[];
}

function pendingPath(root: string): string {
  return assertCanonicalWriteTarget(root, ".pactile/.runtime/update-deferred-live.json");
}

function readPending(root: string): PendingDeferredLivePlan | null {
  const file = pendingPath(root);
  if (!fs.existsSync(file)) return null;
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid pending deferred live update");
  const plan = value as PendingDeferredLivePlan;
  if (plan.schemaVersion !== 1 || typeof plan.sourceGenerationId !== "string" || !plan.sourceGenerationId
    || (plan.committedGenerationId !== null && (typeof plan.committedGenerationId !== "string" || !plan.committedGenerationId))
    || !Array.isArray(plan.writes) || plan.writes.some((entry) => !entry || typeof entry.path !== "string"
      || typeof entry.content !== "string" || typeof entry.executable !== "boolean"
      || (entry.original !== null && typeof entry.original !== "string")
      || (entry.originalMode !== undefined && (!Number.isInteger(entry.originalMode) || entry.originalMode < 0 || entry.originalMode > 0o7777)))) {
    throw new Error("Invalid pending deferred live update");
  }
  if (new Set(plan.writes.map((entry) => entry.path)).size !== plan.writes.length) throw new Error("Invalid pending deferred live update");
  return plan;
}

function writePending(root: string, plan: PendingDeferredLivePlan): void {
  const file = pendingPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  assertCanonicalWriteTarget(root, file);
  const temporary = assertCanonicalWriteTarget(root, `${file}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(plan)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function clearDeferredLivePlan(root: string): void {
  const file = pendingPath(root);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

/** Save a retryable plan before the canonical commit; it remains private runtime state. */
export function prepareDeferredLivePlan(root: string, sourceGenerationId: string, writes: ReadonlyMap<string, DeferredLiveWrite>): void {
  if (!writes.size) return;
  if (readPending(root)) throw new Error("A deferred live update is already pending");
  const plan: PendingDeferredLivePlan = {
    schemaVersion: 1, sourceGenerationId, committedGenerationId: null,
    writes: [...writes].map(([relativePath, write]) => ({ path: relativePath, content: write.content,
      executable: write.executable, original: write.original?.toString("base64") ?? null,
      ...(write.originalMode !== undefined ? { originalMode: write.originalMode } : {}) })),
  };
  writePending(root, plan);
}

export function commitDeferredLivePlan(root: string, generationId: string): void {
  const plan = readPending(root);
  if (!plan) return;
  writePending(root, { ...plan, committedGenerationId: generationId });
}

/** Resume only when the recorded canonical generation is still active. */
export function resumeDeferredLivePlan(root: string, activeGenerationId: string | null): boolean {
  const plan = readPending(root);
  if (!plan) return false;
  if (plan.committedGenerationId === null && plan.sourceGenerationId === activeGenerationId) {
    clearDeferredLivePlan(root);
    return false;
  }
  if (plan.committedGenerationId === null || plan.committedGenerationId !== activeGenerationId) {
    throw new Error("Deferred live update needs review: canonical generation changed outside its recorded commit");
  }
  const writes = new Map(plan.writes.map((entry) => [entry.path, {
    content: entry.content, executable: entry.executable,
    original: entry.original === null ? null : Buffer.from(entry.original, "base64"),
    ...(entry.originalMode !== undefined ? { originalMode: entry.originalMode } : {}),
  }]));
  applyDeferredLiveWrites(root, writes);
  clearDeferredLivePlan(root);
  return true;
}

function liveTarget(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.startsWith("/") || relativePath.startsWith("\\")) {
    throw new Error(`Invalid deferred live path: ${relativePath}`);
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...relativePath.replaceAll("\\", "/").split("/"));
  const within = path.relative(resolvedRoot, target);
  if (!within || within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    throw new Error(`Deferred live path escapes project: ${relativePath}`);
  }
  let cursor = resolvedRoot;
  for (const segment of within.split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (fs.lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Deferred live path crosses a symlink: ${relativePath}`);
    }
  }
  return target;
}

/** Capture the project-file bytes that the update plan actually reviewed. */
export function captureDeferredLiveWrite(root: string, relativePath: string, content: string, executable: boolean): DeferredLiveWrite {
  const target = liveTarget(root, relativePath);
  const stat = fs.statSync(target, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error(`Deferred live target is not a standalone file: ${relativePath}`);
  return { content, executable, original: stat ? fs.readFileSync(target) : null,
    ...(stat ? { originalMode: stat.mode & 0o7777 } : {}) };
}

/** Prevalidate the whole batch, then restore prior bytes if any write fails. */
export function applyDeferredLiveWrites(root: string, writes: ReadonlyMap<string, DeferredLiveWrite>): void {
  const planned = [...writes].map(([relativePath, write]) => {
    const target = liveTarget(root, relativePath);
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error(`Deferred live target is not a standalone file: ${relativePath}`);
    const actual = stat ? fs.readFileSync(target) : null;
    const intended = Buffer.from(write.content);
    const matches = actual === null ? write.original === null : write.original?.equals(actual) === true;
    if (!matches && actual?.equals(intended) !== true) {
      throw new Error(`Deferred live file changed after planning: ${relativePath}`);
    }
    return { relativePath, target, write, alreadyApplied: actual?.equals(intended) === true };
  });

  const attempted: typeof planned = [];
  try {
    for (const entry of planned) {
      if (entry.alreadyApplied) continue;
      fs.mkdirSync(path.dirname(entry.target), { recursive: true });
      attempted.push(entry);
      fs.writeFileSync(entry.target, entry.write.content);
      if (entry.write.executable) fs.chmodSync(entry.target, 0o755);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const entry of attempted.reverse()) {
      try {
        const actual = fs.statSync(entry.target, { throwIfNoEntry: false })?.isFile() ? fs.readFileSync(entry.target) : null;
        const intended = Buffer.from(entry.write.content);
        if (actual !== null && !actual.equals(intended)
          && entry.write.original?.equals(actual) !== true) {
          rollbackErrors.push(`${entry.relativePath}: changed during rollback; preserved current bytes`);
          continue;
        }
        if (entry.write.original === null) {
          if (actual !== null) fs.unlinkSync(entry.target);
        } else if (actual?.equals(entry.write.original) !== true) {
          fs.writeFileSync(entry.target, entry.write.original);
          if (entry.write.originalMode !== undefined) fs.chmodSync(entry.target, entry.write.originalMode);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${entry.relativePath}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    if (rollbackErrors.length) throw new Error(`Deferred live write failed and rollback was incomplete: ${rollbackErrors.join("; ")}`, { cause: error });
    throw error;
  }
}
