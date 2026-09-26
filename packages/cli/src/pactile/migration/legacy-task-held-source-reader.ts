/** Read the original files for one still-held P36 import without activating it. */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { scanLegacyTaskMigration } from "../../core/task/legacy-task-migration.js";
import {
  readLegacyTaskImportRecord,
  readLegacyTaskMigrationView,
  type LegacyTaskImportRecord,
} from "../../core/task/legacy-task-migration-reader.js";

const TASKS_ROOT = ".pactile/tasks";
const SOURCE_PATH_PREFIX = `${TASKS_ROOT}/`;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const MAX_FILES = 512;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_FILE_FACTS = 32_768;
const MAX_DIRECTORY_DEPTH = 32;

export interface LegacyTaskHeldSourceFile {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly encoding: "utf8" | "base64";
  readonly content: string;
}

export interface LegacyTaskHeldSourceView {
  readonly taskPath: string;
  readonly status: "held-source-read-only";
  readonly migrationStatus: "needs-definition" | "needs-coordination";
  readonly legacyTaskId: string;
  readonly runnable: false;
  readonly lifecyclePolicy: "source-only-no-v2-run-review-or-close";
  readonly sourceFingerprint: string;
  readonly files: readonly LegacyTaskHeldSourceFile[];
}

interface SourceFileFact {
  readonly path: string;
  readonly fingerprint: string;
}

function validRelativePath(value: string): boolean {
  if (
    !value ||
    value.length > 4096 ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every(
      (part) =>
        part !== "" && part !== "." && part !== ".." && part.length <= 255,
    );
}

function heldTaskRelativePath(value: string): string {
  const relative = value.startsWith(`${SOURCE_PATH_PREFIX}`)
    ? value.slice(SOURCE_PATH_PREFIX.length)
    : value;
  if (
    !validRelativePath(relative) ||
    relative.length > 2048 ||
    relative.split("/").length > 32 ||
    relative.split("/").some((part) => part.toLowerCase() === "archive")
  ) {
    throw new Error("legacy-task-held-history-path-invalid");
  }
  return relative;
}

function assertRealTaskDirectory(root: string, relative: string): string {
  let cursor = path.resolve(root);
  try {
    const rootStat = fs.lstatSync(cursor);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("legacy-task-held-history-directory-invalid");
    }
    for (const part of [".pactile", "tasks", ...relative.split("/")]) {
      cursor = path.join(cursor, part);
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        throw new Error("legacy-task-held-history-link-invalid");
      }
      if (!stat.isDirectory()) {
        throw new Error("legacy-task-held-history-directory-invalid");
      }
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("legacy-task-held-history-")
    ) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("legacy-task-held-history-path-missing");
    }
    throw error;
  }
  return cursor;
}

function utf8OrBase64(bytes: Buffer): {
  encoding: "utf8" | "base64";
  content: string;
} {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes)
    ? { encoding: "utf8", content: text }
    : { encoding: "base64", content: bytes.toString("base64") };
}

function fingerprint(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function readHeldTaskFiles(
  taskDir: string,
  relativeTaskPath: string,
): LegacyTaskHeldSourceFile[] {
  const files: LegacyTaskHeldSourceFile[] = [];
  let totalBytes = 0;
  const visit = (
    directory: string,
    relativeDirectory: string,
    depth: number,
  ): void => {
    if (depth > MAX_DIRECTORY_DEPTH) {
      throw new Error("legacy-task-held-history-size-limit-exceeded");
    }
    const directoryStat = fs.lstatSync(directory);
    if (directoryStat.isSymbolicLink()) {
      throw new Error("legacy-task-held-history-link-invalid");
    }
    if (!directoryStat.isDirectory()) {
      throw new Error("legacy-task-held-history-directory-invalid");
    }
    for (const name of fs.readdirSync(directory).sort()) {
      if (!name || name === "." || name === ".." || name.includes("\\")) {
        throw new Error("legacy-task-held-history-path-invalid");
      }
      const file = path.join(directory, name);
      const childPath = `${relativeDirectory}/${name}`;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        throw new Error("legacy-task-held-history-link-invalid");
      }
      if (stat.isDirectory()) {
        visit(file, childPath, depth + 1);
      } else if (stat.isFile() && stat.nlink === 1) {
        if (stat.size > MAX_FILE_BYTES || files.length >= MAX_FILES) {
          throw new Error("legacy-task-held-history-size-limit-exceeded");
        }
        totalBytes += stat.size;
        if (totalBytes > MAX_TOTAL_BYTES) {
          throw new Error("legacy-task-held-history-size-limit-exceeded");
        }
        const bytes = fs.readFileSync(file);
        const afterRead = fs.lstatSync(file);
        if (
          !afterRead.isFile() ||
          afterRead.isSymbolicLink() ||
          afterRead.nlink !== 1 ||
          afterRead.dev !== stat.dev ||
          afterRead.ino !== stat.ino ||
          bytes.byteLength !== stat.size
        ) {
          throw new Error("legacy-task-held-history-file-changed-during-read");
        }
        files.push({
          path: childPath,
          byteLength: bytes.byteLength,
          sha256: fingerprint(bytes),
          ...utf8OrBase64(bytes),
        });
      } else {
        throw new Error("legacy-task-held-history-file-invalid");
      }
    }
  };
  visit(taskDir, `${TASKS_ROOT}/${relativeTaskPath}`, 0);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function migrationSourceFacts(
  record: LegacyTaskImportRecord,
): SourceFileFact[] {
  if (
    !Array.isArray(record.sourceFiles) ||
    record.sourceFiles.length > MAX_SOURCE_FILE_FACTS
  ) {
    throw new Error("legacy-task-held-history-record-invalid");
  }
  const seen = new Set<string>();
  const facts = record.sourceFiles.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("legacy-task-held-history-record-invalid");
    }
    const value = item as { path?: unknown; fingerprint?: unknown };
    if (
      typeof value.path !== "string" ||
      !validRelativePath(value.path) ||
      !value.path.startsWith(SOURCE_PATH_PREFIX) ||
      typeof value.fingerprint !== "string" ||
      !FINGERPRINT.test(value.fingerprint) ||
      seen.has(value.path)
    ) {
      throw new Error("legacy-task-held-history-record-invalid");
    }
    seen.add(value.path);
    return { path: value.path, fingerprint: value.fingerprint };
  });
  return facts.sort((left, right) => left.path.localeCompare(right.path));
}

function sameFacts(
  left: readonly SourceFileFact[],
  right: readonly SourceFileFact[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.path === right[index]?.path &&
        item.fingerprint === right[index]?.fingerprint,
    )
  );
}

/** Read one current Task only when its committed P36 record is still held and its source is unchanged. */
export function readLegacyTaskHeldSource(
  projectRoot: string,
  taskPath: string,
): LegacyTaskHeldSourceView {
  const root = path.resolve(projectRoot);
  const relative = heldTaskRelativePath(taskPath);
  const taskDir = assertRealTaskDirectory(root, relative);
  const canonicalTaskPath = `${TASKS_ROOT}/${relative}`;
  const view = readLegacyTaskMigrationView(root);
  if (!view) {
    throw new Error("legacy-task-held-history-migration-authority-missing");
  }
  const recordPath = `${canonicalTaskPath}/legacy-import.json`;
  const baseRecord = view.baseFiles.get(recordPath);
  const activeRecord = view.files.get(recordPath);
  if (!baseRecord || !activeRecord?.bytes.equals(baseRecord.bytes)) {
    throw new Error("legacy-task-held-history-record-not-base-import");
  }
  const record = readLegacyTaskImportRecord(root, taskDir, view);
  if (!record) {
    throw new Error("legacy-task-held-history-record-missing");
  }
  if (
    record.taskPath !== canonicalTaskPath ||
    (record.status !== "needs-definition" &&
      record.status !== "needs-coordination")
  ) {
    throw new Error("legacy-task-held-history-task-not-held");
  }
  if (record.sourceFingerprint !== view.authority.sourceFingerprint) {
    throw new Error("legacy-task-held-history-authority-stale");
  }

  const files = readHeldTaskFiles(taskDir, relative);
  const prefix = `${canonicalTaskPath}/`;
  const expectedFacts = migrationSourceFacts(record).filter((fact) =>
    fact.path.startsWith(prefix),
  );
  const actualFacts = files.map(({ path: filePath, sha256 }) => ({
    path: filePath,
    fingerprint: sha256,
  }));
  if (
    !expectedFacts.some((fact) => fact.path === `${prefix}task.json`) ||
    expectedFacts.length > MAX_FILES ||
    !sameFacts(expectedFacts, actualFacts)
  ) {
    throw new Error("legacy-task-held-history-source-stale");
  }

  const plan = scanLegacyTaskMigration({ projectRoot: root });
  const scannedTask = plan.tasks.find(
    (task) => task.directory === canonicalTaskPath,
  );
  const scannedFacts = scannedTask?.files
    .map((file) => ({ path: file.path, fingerprint: file.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (
    plan.preflight.status !== "clear-to-review" ||
    plan.sourceFingerprint !== view.authority.sourceFingerprint ||
    !scannedTask ||
    scannedTask.archivedByPath ||
    scannedTask.preflight !== "clear-to-review" ||
    !scannedTask.sourceFingerprint ||
    !scannedFacts ||
    !sameFacts(expectedFacts, scannedFacts)
  ) {
    throw new Error("legacy-task-held-history-authority-stale");
  }

  return {
    taskPath: canonicalTaskPath,
    status: "held-source-read-only",
    migrationStatus: record.status,
    legacyTaskId: record.legacyTaskId,
    runnable: false,
    lifecyclePolicy: "source-only-no-v2-run-review-or-close",
    sourceFingerprint: view.authority.sourceFingerprint,
    files,
  };
}
