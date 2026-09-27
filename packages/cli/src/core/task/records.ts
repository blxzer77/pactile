import fs from "node:fs";
import path from "node:path";

import {
  TASK_RECORD_FIELD_ORDER,
  emptyTaskRecord,
  isPlainObject,
  taskRecordSchema,
  type PactileTaskRecord,
} from "./schema.js";

const TASK_JSON_BASENAME = "task.json";

export interface LoadTaskRecordOptions {
  /** Absolute or repo-relative directory containing `task.json`. */
  taskDir: string;
  /** Optional repo root used to resolve relative `taskDir` values. */
  cwd?: string;
}

export interface WriteTaskRecordOptions {
  /** Absolute or repo-relative directory containing `task.json`. */
  taskDir: string;
  /** Canonical record to persist. Unknown fields on disk are preserved. */
  record: PactileTaskRecord;
  /** Optional repo root used to resolve relative `taskDir` values. */
  cwd?: string;
  /**
   * Non-canonical projection fields owned by a Kernel Command
   * (`execution_approval`, `quality_gate_results`, …). Canonical keys are ignored.
   */
  extra?: Record<string, unknown>;
}

/**
 * Read a task.json file and return a canonicalized record.
 *
 * Unknown fields on disk that are not part of the canonical 24-field
 * shape are NOT returned — `loadTaskRecord` is the structured public API.
 * To preserve unknown fields across a load/write cycle, callers should
 * use {@link writeTaskRecord}, which merges canonical updates on top of
 * the on-disk JSON object instead of overwriting it.
 */
export function loadTaskRecord(
  options: LoadTaskRecordOptions,
): PactileTaskRecord {
  const file = resolveTaskJsonPath(options.taskDir, options.cwd);
  const raw = fs.readFileSync(file, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse ${file}: ${err instanceof Error ? err.message : err}`,
    );
  }
  return taskRecordSchema.parse(parsed);
}

/**
 * Write a task.json file with canonical field ordering. Unknown fields
 * already present on disk are preserved verbatim — only the canonical
 * fields are overwritten by `record`. Field order: canonical fields
 * first (in `TASK_RECORD_FIELD_ORDER`), then any preserved unknown
 * fields in their original insertion order. If an existing `task.json` is
 * present but cannot be parsed as a JSON object, the write is rejected instead
 * of silently replacing potentially recoverable local data.
 *
 * The directory containing `task.json` is created if it does not exist.
 *
 * Stage 2 (P28/P30): Kernel Commands may call this for same-command
 * legacy projection. Do not add another `writeFileSync`
 * primitive for `task.json`.
 */
export function writeTaskRecord(options: WriteTaskRecordOptions): void {
  const record = taskRecordSchema.parse(options.record);
  const file = resolveTaskJsonPath(options.taskDir, options.cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const existing = readExistingObject(file);
  const out: Record<string, unknown> = {};

  const recordBag = record as unknown as Record<string, unknown>;
  for (const field of TASK_RECORD_FIELD_ORDER) {
    out[field] = recordBag[field];
  }
  if (options.extra) {
    for (const [key, value] of Object.entries(options.extra)) {
      if ((TASK_RECORD_FIELD_ORDER as readonly string[]).includes(key)) continue;
      out[key] = value;
    }
  }
  if (existing) {
    for (const key of Object.keys(existing)) {
      if (!(key in out)) {
        out[key] = existing[key];
      }
    }
  }

  const json = JSON.stringify(out, null, 2) + "\n";
  fs.writeFileSync(file, json, "utf-8");
}

function readExistingObject(file: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Refusing to overwrite corrupt ${file}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Refusing to overwrite non-object task record at ${file}`);
  }
  return parsed;
}

function resolveTaskJsonPath(taskDir: string, cwd?: string): string {
  if (path.isAbsolute(taskDir)) {
    return path.join(taskDir, TASK_JSON_BASENAME);
  }
  const base = cwd ?? process.cwd();
  return path.join(path.resolve(base, taskDir), TASK_JSON_BASENAME);
}

// Re-exported so callers can build a starter record without hitting the
// schema module directly.
export { emptyTaskRecord };
