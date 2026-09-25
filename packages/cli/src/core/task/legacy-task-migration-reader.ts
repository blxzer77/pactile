/**
 * Read the committed P36 legacy-task generation without changing legacy files.
 *
 * The migration pointer is the single visibility boundary. Readers validate
 * the complete generation and source backup before consuming any staged file.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const LEGACY_TASK_MIGRATION_STORE =
  ".pactile/runtime/legacy-task-migrations";

const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const TARGET_ROOT = ".pactile/tasks/";

export type LegacyTaskImportStatus =
  | "imported"
  | "needs-definition"
  | "needs-coordination";

export interface LegacyTaskImportRecord {
  readonly schemaVersion: 1;
  readonly kind: "legacy-task-import-record";
  readonly status: LegacyTaskImportStatus;
  readonly taskPath: string;
  readonly legacyTaskId: string;
  readonly sourceFingerprint: string;
  readonly sourceFiles: readonly {
    readonly path: string;
    readonly fingerprint: string;
  }[];
  readonly historicalStatus: {
    readonly present: boolean;
    readonly value?: unknown;
  };
  readonly dependencyFacts: {
    readonly taskJsonDependsOn: {
      readonly present: boolean;
      readonly value?: unknown;
    };
    readonly topLevelDependsMode: {
      readonly present: boolean;
      readonly value?: unknown;
    };
    readonly metaDependsMode: {
      readonly present: boolean;
      readonly value?: unknown;
    };
    readonly hardDependencies: readonly string[];
    readonly diagnostics: readonly string[];
  };
  readonly missingDefinitionFields: readonly string[];
  readonly coordinationReasons: readonly string[];
}

export interface LegacyTaskMigrationCommit {
  readonly schemaVersion: 1;
  readonly kind: "prepared-legacy-task-batch";
  readonly visibility: "active-v2";
  readonly batchId: string;
  readonly generationId: string;
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
  readonly committedAt: string;
}

export interface LegacyTaskMigrationFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly fingerprint: string;
}

export interface LegacyTaskMigrationView {
  readonly authority: LegacyTaskMigrationCommit;
  readonly files: ReadonlyMap<string, LegacyTaskMigrationFile>;
}

interface GenerationManifest {
  schemaVersion: 1;
  kind: "legacy-task-staged-generation";
  batchId: string;
  generationId: string;
  sourceFingerprint: string;
  targetFingerprint: string;
  files: { path: string; byteLength: number; fingerprint: string }[];
  createdAt: string;
}

interface SourceBackupManifest {
  schemaVersion: 1;
  kind: "legacy-task-source-snapshot";
  sourceFingerprint: string;
  files: {
    path: string;
    role: string;
    byteLength: number;
    fingerprint: string;
  }[];
}

function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validRelative(value: string): boolean {
  if (!value || value.includes("\\") || path.posix.isAbsolute(value))
    return false;
  const parts = value.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function readInternalFile(
  projectRoot: string,
  relative: string,
): Buffer | null {
  if (!validRelative(relative))
    throw new Error("legacy-task-migration-path-invalid");
  const root = path.resolve(projectRoot);
  let cursor = root;
  const parts = relative.split("/");
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (stat.isSymbolicLink())
      throw new Error("legacy-task-migration-link-invalid");
    const final = index === parts.length - 1;
    if (final ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) {
      throw new Error("legacy-task-migration-file-invalid");
    }
  }
  return fs.readFileSync(cursor);
}

function listInternalFiles(
  projectRoot: string,
  relativeRoot: string,
): string[] {
  if (!validRelative(relativeRoot))
    throw new Error("legacy-task-migration-path-invalid");
  const root = path.resolve(projectRoot);
  const start = path.join(root, ...relativeRoot.split("/"));
  const output: string[] = [];
  const visit = (directory: string, relative: string): void => {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("legacy-task-migration-directory-invalid");
    }
    for (const name of fs.readdirSync(directory).sort()) {
      const child = path.join(directory, name);
      const childRelative = `${relative}/${name}`;
      const stat = fs.lstatSync(child);
      if (stat.isSymbolicLink())
        throw new Error("legacy-task-migration-link-invalid");
      if (stat.isDirectory()) visit(child, childRelative);
      else if (stat.isFile() && stat.nlink === 1) output.push(childRelative);
      else throw new Error("legacy-task-migration-file-invalid");
    }
  };
  visit(start, relativeRoot);
  return output.sort();
}

function parseAuthority(value: unknown): LegacyTaskMigrationCommit {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("legacy-task-migration-authority-invalid");
  }
  const authority = value as Partial<LegacyTaskMigrationCommit>;
  if (
    authority.schemaVersion !== 1 ||
    authority.kind !== "prepared-legacy-task-batch" ||
    authority.visibility !== "active-v2" ||
    typeof authority.batchId !== "string" ||
    !/^legacy-[a-f0-9]{64}$/.test(authority.batchId) ||
    authority.generationId !== authority.batchId ||
    !FINGERPRINT.test(authority.sourceFingerprint ?? "") ||
    !FINGERPRINT.test(authority.targetFingerprint ?? "") ||
    typeof authority.committedAt !== "string" ||
    Number.isNaN(Date.parse(authority.committedAt))
  ) {
    throw new Error("legacy-task-migration-authority-invalid");
  }
  return authority as LegacyTaskMigrationCommit;
}

function parseGeneration(
  value: unknown,
  authority: LegacyTaskMigrationCommit,
): GenerationManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("legacy-task-migration-generation-invalid");
  }
  const manifest = value as Partial<GenerationManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "legacy-task-staged-generation" ||
    manifest.batchId !== authority.batchId ||
    manifest.generationId !== authority.generationId ||
    manifest.sourceFingerprint !== authority.sourceFingerprint ||
    manifest.targetFingerprint !== authority.targetFingerprint ||
    typeof manifest.createdAt !== "string" ||
    Number.isNaN(Date.parse(manifest.createdAt)) ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("legacy-task-migration-generation-invalid");
  }
  return manifest as GenerationManifest;
}

function parseSourceBackup(
  value: unknown,
  sourceFingerprint: string,
): SourceBackupManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("legacy-task-migration-backup-invalid");
  }
  const manifest = value as Partial<SourceBackupManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "legacy-task-source-snapshot" ||
    manifest.sourceFingerprint !== sourceFingerprint ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("legacy-task-migration-backup-invalid");
  }
  return manifest as SourceBackupManifest;
}

function verifySourceBackup(
  projectRoot: string,
  sourceFingerprint: string,
): void {
  const base = `${LEGACY_TASK_MIGRATION_STORE}/sources/${sourceFingerprint.slice("sha256:".length)}`;
  const manifestBytes = readInternalFile(projectRoot, `${base}/manifest.json`);
  if (!manifestBytes) throw new Error("legacy-task-migration-backup-invalid");
  let manifest: SourceBackupManifest;
  try {
    manifest = parseSourceBackup(
      JSON.parse(manifestBytes.toString("utf8")) as unknown,
      sourceFingerprint,
    );
  } catch {
    throw new Error("legacy-task-migration-backup-invalid");
  }
  const sourceFiles = [...manifest.files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const sourceHash = createHash("sha256");
  for (const entry of sourceFiles) {
    if (!validRelative(entry.path) || !FINGERPRINT.test(entry.fingerprint)) {
      throw new Error("legacy-task-migration-backup-invalid");
    }
    const bytes = readInternalFile(projectRoot, `${base}/files/${entry.path}`);
    if (
      bytes?.byteLength !== entry.byteLength ||
      digest(bytes) !== entry.fingerprint
    ) {
      throw new Error("legacy-task-migration-backup-invalid");
    }
    sourceHash.update(entry.path, "utf8");
    sourceHash.update("\0", "utf8");
    sourceHash.update(String(bytes.byteLength), "utf8");
    sourceHash.update("\0", "utf8");
    sourceHash.update(bytes);
  }
  const actualFiles = listInternalFiles(projectRoot, `${base}/files`);
  const expectedFiles = sourceFiles.map(
    (entry) => `${base}/files/${entry.path}`,
  );
  if (
    `sha256:${sourceHash.digest("hex")}` !== sourceFingerprint ||
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((file, index) => file !== expectedFiles[index])
  ) {
    throw new Error("legacy-task-migration-backup-invalid");
  }
}

function verifyGeneration(
  projectRoot: string,
  authority: LegacyTaskMigrationCommit,
): Map<string, LegacyTaskMigrationFile> {
  const base = `${LEGACY_TASK_MIGRATION_STORE}/generations/${authority.generationId}`;
  const manifestBytes = readInternalFile(projectRoot, `${base}/manifest.json`);
  if (!manifestBytes)
    throw new Error("legacy-task-migration-generation-invalid");
  let manifest: GenerationManifest;
  try {
    manifest = parseGeneration(
      JSON.parse(manifestBytes.toString("utf8")) as unknown,
      authority,
    );
  } catch {
    throw new Error("legacy-task-migration-generation-invalid");
  }
  const entries = [...manifest.files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const files = new Map<string, LegacyTaskMigrationFile>();
  const facts: { path: string; byteLength: number; fingerprint: string }[] = [];
  for (const entry of entries) {
    if (
      !validRelative(entry.path) ||
      !entry.path.startsWith(TARGET_ROOT) ||
      entry.path.split("/").some((part) => part.toLowerCase() === "archive") ||
      typeof entry.byteLength !== "number" ||
      !Number.isSafeInteger(entry.byteLength) ||
      entry.byteLength < 0 ||
      !FINGERPRINT.test(entry.fingerprint) ||
      files.has(entry.path)
    ) {
      throw new Error("legacy-task-migration-generation-invalid");
    }
    const bytes = readInternalFile(projectRoot, `${base}/files/${entry.path}`);
    if (
      bytes?.byteLength !== entry.byteLength ||
      digest(bytes) !== entry.fingerprint
    ) {
      throw new Error("legacy-task-migration-generation-invalid");
    }
    files.set(entry.path, {
      path: entry.path,
      bytes,
      fingerprint: entry.fingerprint,
    });
    facts.push({
      path: entry.path,
      byteLength: bytes.byteLength,
      fingerprint: digest(bytes),
    });
  }
  const actualFiles = listInternalFiles(projectRoot, `${base}/files`).map(
    (file) => file.slice(`${base}/files/`.length),
  );
  if (
    facts.length === 0 ||
    digest(jsonBytes(facts)) !== authority.targetFingerprint ||
    actualFiles.length !== entries.length ||
    actualFiles.some((file, index) => file !== entries[index]?.path)
  ) {
    throw new Error("legacy-task-migration-generation-invalid");
  }
  return files;
}

/** Return a fully verified active migration snapshot, or null before first import. */
export function readLegacyTaskMigrationView(
  projectRoot: string,
): LegacyTaskMigrationView | null {
  const root = path.resolve(projectRoot);
  const authorityPath = `${LEGACY_TASK_MIGRATION_STORE}/authority.json`;
  const authorityBytes = readInternalFile(root, authorityPath);
  if (!authorityBytes) return null;
  let authority: LegacyTaskMigrationCommit;
  try {
    authority = parseAuthority(
      JSON.parse(authorityBytes.toString("utf8")) as unknown,
    );
  } catch {
    throw new Error("legacy-task-migration-authority-invalid");
  }
  verifySourceBackup(root, authority.sourceFingerprint);
  return { authority, files: verifyGeneration(root, authority) };
}

function taskRelativePath(projectRoot: string, taskDir: string): string | null {
  const root = path.resolve(projectRoot);
  const tasksRoot = path.join(root, ".pactile", "tasks");
  const candidate = path.resolve(taskDir);
  const relative = path.relative(tasksRoot, candidate);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  const posix = relative.split(path.sep).join("/");
  if (posix.split("/").some((part) => part.toLowerCase() === "archive"))
    return null;
  return posix;
}

/** Read one file from the committed generation using a canonical task directory. */
export function readLegacyTaskMigrationFile(
  projectRoot: string,
  taskDir: string,
  basename: "kernel.json" | "legacy-import.json",
  view?: LegacyTaskMigrationView | null,
): Buffer | null {
  const relative = taskRelativePath(projectRoot, taskDir);
  if (!relative) return null;
  const snapshot =
    view === undefined ? readLegacyTaskMigrationView(projectRoot) : view;
  return (
    snapshot?.files.get(`${TARGET_ROOT}${relative}/${basename}`)?.bytes ?? null
  );
}

export function readLegacyTaskImportRecord(
  projectRoot: string,
  taskDir: string,
  view?: LegacyTaskMigrationView | null,
): LegacyTaskImportRecord | null {
  const bytes = readLegacyTaskMigrationFile(
    projectRoot,
    taskDir,
    "legacy-import.json",
    view,
  );
  return bytes ? parseLegacyTaskImportRecord(bytes) : null;
}

export function legacyTaskMigrationOverlayPath(
  projectRoot: string,
  taskDir: string,
): string | null {
  const relative = taskRelativePath(projectRoot, taskDir);
  if (!relative) return null;
  return path.join(
    path.resolve(projectRoot),
    ...LEGACY_TASK_MIGRATION_STORE.split("/"),
    "overrides",
    ...relative.split("/"),
  );
}

/** List canonical task directories represented by this committed generation. */
export function listLegacyTaskMigrationDirectories(
  projectRoot: string,
  view?: LegacyTaskMigrationView | null,
): string[] {
  const snapshot =
    view === undefined ? readLegacyTaskMigrationView(projectRoot) : view;
  if (!snapshot) return [];
  const directories = new Set<string>();
  for (const relative of snapshot.files.keys()) {
    if (!relative.startsWith(TARGET_ROOT)) continue;
    const suffix = relative.slice(TARGET_ROOT.length);
    const separator = suffix.lastIndexOf("/");
    if (separator > 0) {
      directories.add(
        path.join(
          projectRoot,
          ".pactile",
          "tasks",
          ...suffix.slice(0, separator).split("/"),
        ),
      );
    }
  }
  return [...directories].sort();
}

export function listLegacyTaskImportRecords(
  projectRoot: string,
  view?: LegacyTaskMigrationView | null,
): { taskDir: string; record: LegacyTaskImportRecord }[] {
  const snapshot =
    view === undefined ? readLegacyTaskMigrationView(projectRoot) : view;
  if (!snapshot) return [];
  const output: { taskDir: string; record: LegacyTaskImportRecord }[] = [];
  for (const file of snapshot.files.values()) {
    if (
      !file.path.startsWith(TARGET_ROOT) ||
      !file.path.endsWith("/legacy-import.json")
    )
      continue;
    const relative = file.path.slice(
      TARGET_ROOT.length,
      -"/legacy-import.json".length,
    );
    output.push({
      taskDir: path.join(
        projectRoot,
        ".pactile",
        "tasks",
        ...relative.split("/"),
      ),
      record: parseLegacyTaskImportRecord(file.bytes),
    });
  }
  return output.sort((left, right) =>
    left.taskDir.localeCompare(right.taskDir),
  );
}

export function parseLegacyTaskImportRecord(
  bytes: Uint8Array,
): LegacyTaskImportRecord {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw new Error("legacy-task-migration-record-invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("legacy-task-migration-record-invalid");
  }
  const record = value as Partial<LegacyTaskImportRecord>;
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "legacy-task-import-record" ||
    !["imported", "needs-definition", "needs-coordination"].includes(
      String(record.status),
    ) ||
    typeof record.taskPath !== "string" ||
    !validRelative(record.taskPath) ||
    typeof record.legacyTaskId !== "string" ||
    !record.legacyTaskId.trim() ||
    !FINGERPRINT.test(record.sourceFingerprint ?? "") ||
    !Array.isArray(record.sourceFiles) ||
    !Array.isArray(record.missingDefinitionFields) ||
    !Array.isArray(record.coordinationReasons) ||
    !record.dependencyFacts ||
    typeof record.dependencyFacts !== "object" ||
    !record.historicalStatus ||
    typeof record.historicalStatus !== "object"
  ) {
    throw new Error("legacy-task-migration-record-invalid");
  }
  return record as LegacyTaskImportRecord;
}
