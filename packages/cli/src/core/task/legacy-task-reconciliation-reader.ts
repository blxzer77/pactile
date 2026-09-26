/** Verify the secondary, append-only reconciliation pointer used to activate held imports. */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseTaskKernelSnapshotV2 } from "./task-kernel-schema.js";
import type {
  LegacyTaskImportRecord,
  LegacyTaskMigrationCommit,
  LegacyTaskMigrationFile,
} from "./legacy-task-migration-reader.js";

export const LEGACY_TASK_RECONCILIATION_STORE =
  ".pactile/runtime/legacy-task-migrations/reconciliations";

export interface LegacyTaskReconciliationAuthority {
  readonly schemaVersion: 1;
  readonly kind: "legacy-task-reconciliation-authority";
  readonly baseGenerationId: string;
  readonly sourceFingerprint: string;
  readonly generationId: string;
  readonly targetFingerprint: string;
  readonly requestFingerprint: string;
  readonly idempotencyKey: string;
  readonly expectedAuthorityFingerprint: string | null;
  readonly committedAt: string;
  /** Original held source path when an archived record is restored elsewhere. */
  readonly sourceTaskPath?: string;
  /** Active destination associated with sourceTaskPath for this generation. */
  readonly targetTaskPath?: string;
}

interface ReconciliationManifest {
  readonly schemaVersion: 1;
  readonly kind: "legacy-task-reconciliation-generation";
  readonly baseGenerationId: string;
  readonly sourceFingerprint: string;
  readonly generationId: string;
  readonly targetFingerprint: string;
  readonly requestFingerprint: string;
  readonly idempotencyKey: string;
  readonly expectedAuthorityFingerprint: string | null;
  readonly files: readonly {
    readonly path: string;
    readonly byteLength: number;
    readonly fingerprint: string;
  }[];
  readonly createdAt: string;
  readonly sourceTaskPath?: string;
  readonly targetTaskPath?: string;
}

const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RECONCILIATION_ID = /^reconcile-[a-f0-9]{64}$/;
const TARGET_ROOT = ".pactile/tasks/";

function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validRelative(value: string): boolean {
  if (!value || value.includes("\\") || path.posix.isAbsolute(value)) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function validTaskPath(value: unknown, allowArchive: boolean): value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith(TARGET_ROOT) ||
    !validRelative(value)
  ) return false;
  const parts = value.slice(TARGET_ROOT.length).split("/");
  return (
    parts.length > 0 &&
    parts.length <= 32 &&
    parts.every((part) => part.length <= 255) &&
    parts.every((part, index) =>
      part.toLowerCase() !== "archive" || (allowArchive && index === 0),
    )
  );
}

function readInternalFile(projectRoot: string, relative: string): Buffer | null {
  if (!validRelative(relative)) throw new Error("legacy-task-reconciliation-path-invalid");
  let cursor = path.resolve(projectRoot);
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
    if (stat.isSymbolicLink()) throw new Error("legacy-task-reconciliation-link-invalid");
    const final = index === parts.length - 1;
    if (final ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
      throw new Error("legacy-task-reconciliation-file-invalid");
  }
  return fs.readFileSync(cursor);
}

function listInternalFiles(projectRoot: string, relative: string): string[] {
  if (!validRelative(relative)) throw new Error("legacy-task-reconciliation-path-invalid");
  const start = path.join(path.resolve(projectRoot), ...relative.split("/"));
  const output: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("legacy-task-reconciliation-directory-invalid");
    for (const name of fs.readdirSync(directory).sort()) {
      const child = path.join(directory, name);
      const childRelative = `${prefix}/${name}`;
      const childStat = fs.lstatSync(child);
      if (childStat.isSymbolicLink()) throw new Error("legacy-task-reconciliation-link-invalid");
      if (childStat.isDirectory()) visit(child, childRelative);
      else if (childStat.isFile() && childStat.nlink === 1) output.push(childRelative);
      else throw new Error("legacy-task-reconciliation-file-invalid");
    }
  };
  visit(start, relative);
  return output.sort();
}

function assertEmptyWithoutAuthority(projectRoot: string): void {
  const directory = path.join(path.resolve(projectRoot), ...LEGACY_TASK_RECONCILIATION_STORE.split("/"));
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("legacy-task-reconciliation-store-invalid");
    if (fs.readdirSync(directory).length)
      throw new Error("legacy-task-reconciliation-authority-missing-with-residual-state");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function parseAuthority(value: unknown): LegacyTaskReconciliationAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("legacy-task-reconciliation-authority-invalid");
  const authority = value as Partial<LegacyTaskReconciliationAuthority>;
  if (
    authority.schemaVersion !== 1 ||
    authority.kind !== "legacy-task-reconciliation-authority" ||
    typeof authority.baseGenerationId !== "string" ||
    !/^legacy-[a-f0-9]{64}$/.test(authority.baseGenerationId) ||
    !FINGERPRINT.test(authority.sourceFingerprint ?? "") ||
    typeof authority.generationId !== "string" ||
    !RECONCILIATION_ID.test(authority.generationId) ||
    !FINGERPRINT.test(authority.targetFingerprint ?? "") ||
    !FINGERPRINT.test(authority.requestFingerprint ?? "") ||
    typeof authority.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(authority.idempotencyKey) ||
    (authority.expectedAuthorityFingerprint !== null &&
      !FINGERPRINT.test(authority.expectedAuthorityFingerprint ?? "")) ||
    typeof authority.committedAt !== "string" ||
    Number.isNaN(Date.parse(authority.committedAt)) ||
    authority.sourceTaskPath !== undefined &&
      !validTaskPath(authority.sourceTaskPath, true) ||
    authority.targetTaskPath !== undefined &&
      !validTaskPath(authority.targetTaskPath, false)
  ) throw new Error("legacy-task-reconciliation-authority-invalid");
  return authority as LegacyTaskReconciliationAuthority;
}

function parseManifest(
  value: unknown,
  authority: LegacyTaskReconciliationAuthority,
): ReconciliationManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("legacy-task-reconciliation-generation-invalid");
  const manifest = value as Partial<ReconciliationManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "legacy-task-reconciliation-generation" ||
    manifest.baseGenerationId !== authority.baseGenerationId ||
    manifest.sourceFingerprint !== authority.sourceFingerprint ||
    manifest.generationId !== authority.generationId ||
    manifest.targetFingerprint !== authority.targetFingerprint ||
    manifest.requestFingerprint !== authority.requestFingerprint ||
    manifest.idempotencyKey !== authority.idempotencyKey ||
    manifest.expectedAuthorityFingerprint !== authority.expectedAuthorityFingerprint ||
    manifest.sourceTaskPath !== authority.sourceTaskPath ||
    manifest.targetTaskPath !== authority.targetTaskPath ||
    typeof manifest.createdAt !== "string" ||
    Number.isNaN(Date.parse(manifest.createdAt)) ||
    !Array.isArray(manifest.files)
  ) throw new Error("legacy-task-reconciliation-generation-invalid");
  return manifest as ReconciliationManifest;
}

function parseRecord(bytes: Buffer): LegacyTaskImportRecord {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("legacy-task-reconciliation-record-invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("legacy-task-reconciliation-record-invalid");
  const record = value as Partial<LegacyTaskImportRecord>;
  const reconciliation = (value as { reconciliation?: unknown }).reconciliation;
  const acknowledgedLegacyHistoryGap =
    reconciliation && typeof reconciliation === "object" && !Array.isArray(reconciliation)
      ? (reconciliation as { acknowledgedLegacyHistoryGap?: unknown }).acknowledgedLegacyHistoryGap
      : undefined;
  const mappedTaskId =
    reconciliation && typeof reconciliation === "object" && !Array.isArray(reconciliation)
      ? (reconciliation as { mappedTaskId?: unknown }).mappedTaskId
      : undefined;
  const hasLegacyHistoryGap =
    Array.isArray(record.legacyHistoryDiagnostics) &&
    record.legacyHistoryDiagnostics.some((item) =>
      typeof item === "string" && item.startsWith("legacy-kernel-unparsed:"),
    );
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "legacy-task-import-record" ||
    record.status !== "imported" ||
    typeof record.taskPath !== "string" ||
    typeof record.legacyTaskId !== "string" ||
    !FINGERPRINT.test(record.sourceFingerprint ?? "") ||
    !Array.isArray(record.sourceFiles) ||
    !Array.isArray(record.missingDefinitionFields) ||
    record.missingDefinitionFields.length !== 0 ||
    !Array.isArray(record.coordinationReasons) ||
    record.coordinationReasons.length !== 0 ||
    !reconciliation || typeof reconciliation !== "object" || Array.isArray(reconciliation) ||
    (reconciliation as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    (reconciliation as { kind?: unknown }).kind !== "explicit-legacy-task-reconciliation" ||
    typeof (reconciliation as { idempotencyKey?: unknown }).idempotencyKey !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test((reconciliation as { idempotencyKey: string }).idempotencyKey) ||
    !FINGERPRINT.test((reconciliation as { requestFingerprint?: string }).requestFingerprint ?? "") ||
    typeof (reconciliation as { activationAt?: unknown }).activationAt !== "string" ||
    Number.isNaN(Date.parse((reconciliation as { activationAt: string }).activationAt)) ||
    (reconciliation as { historyPolicy?: unknown }).historyPolicy !== "legacy-lifecycle-remains-source-only" ||
    acknowledgedLegacyHistoryGap !== undefined && acknowledgedLegacyHistoryGap !== true ||
    mappedTaskId !== undefined && (typeof mappedTaskId !== "string" || !TASK_ID.test(mappedTaskId) || mappedTaskId === record.legacyTaskId) ||
    hasLegacyHistoryGap !== (acknowledgedLegacyHistoryGap === true) ||
    !Array.isArray((reconciliation as { resolvedDependencies?: unknown }).resolvedDependencies)
  ) throw new Error("legacy-task-reconciliation-record-invalid");
  return record as LegacyTaskImportRecord;
}

function sourceTaskPathForReconciledRecord(
  record: LegacyTaskImportRecord,
  projectTaskPath: string,
  baseFiles: ReadonlyMap<string, LegacyTaskMigrationFile>,
): string {
  const sourceFilePath = record.legacySourceMetadata?.fileReferences.taskJson?.path;
  if (!sourceFilePath?.startsWith(TARGET_ROOT) || !sourceFilePath.endsWith("/task.json"))
    return projectTaskPath;
  const candidate = sourceFilePath.slice(0, -"/task.json".length);
  if (
    !validTaskPath(candidate, true) ||
    !baseFiles.has(`${candidate}/legacy-import.json`)
  ) return projectTaskPath;
  return candidate;
}

export function verifyLegacyTaskReconciliationGeneration(
  projectRoot: string,
  authority: LegacyTaskReconciliationAuthority,
  baseFiles: ReadonlyMap<string, LegacyTaskMigrationFile>,
): Map<string, LegacyTaskMigrationFile> {
  const generationRoot = `${LEGACY_TASK_RECONCILIATION_STORE}/generations/${authority.generationId}`;
  const manifestBytes = readInternalFile(projectRoot, `${generationRoot}/manifest.json`);
  if (!manifestBytes) throw new Error("legacy-task-reconciliation-generation-invalid");
  let manifest: ReconciliationManifest;
  try {
    manifest = parseManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown, authority);
  } catch {
    throw new Error("legacy-task-reconciliation-generation-invalid");
  }
  const entries = [...manifest.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const files = new Map<string, LegacyTaskMigrationFile>();
  const facts: { path: string; byteLength: number; fingerprint: string }[] = [];
  const taskPaths = new Set<string>();
  for (const entry of entries) {
    if (
      !validRelative(entry.path) ||
      !entry.path.startsWith(TARGET_ROOT) ||
      entry.path.split("/").some((part) => part.toLowerCase() === "archive") ||
      !entry.path.endsWith("/legacy-import.json") && !entry.path.endsWith("/kernel.json") ||
      !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0 ||
      !FINGERPRINT.test(entry.fingerprint) || files.has(entry.path)
    ) throw new Error("legacy-task-reconciliation-generation-invalid");
    const taskPath = entry.path.slice(TARGET_ROOT.length).replace(/\/(?:legacy-import|kernel)\.json$/, "");
    taskPaths.add(taskPath);
    const bytes = readInternalFile(projectRoot, `${generationRoot}/files/${entry.path}`);
    if (bytes?.byteLength !== entry.byteLength || digest(bytes) !== entry.fingerprint)
      throw new Error("legacy-task-reconciliation-generation-invalid");
    files.set(entry.path, { path: entry.path, bytes, fingerprint: entry.fingerprint });
    facts.push({ path: entry.path, byteLength: bytes.byteLength, fingerprint: entry.fingerprint });
  }
  if (!files.size || digest(jsonBytes(facts)) !== authority.targetFingerprint)
    throw new Error("legacy-task-reconciliation-generation-invalid");
  const actual = listInternalFiles(projectRoot, `${generationRoot}/files`).map((file) => file.slice(`${generationRoot}/files/`.length));
  if (actual.length !== entries.length || actual.some((file, index) => file !== entries[index]?.path))
    throw new Error("legacy-task-reconciliation-generation-invalid");
  for (const taskPath of taskPaths) {
    const importPath = `${TARGET_ROOT}${taskPath}/legacy-import.json`;
    const kernelPath = `${TARGET_ROOT}${taskPath}/kernel.json`;
    const projectTaskPath = `${TARGET_ROOT}${taskPath}`;
    const recordFile = files.get(importPath);
    const kernelFile = files.get(kernelPath);
    if (!recordFile || !kernelFile || baseFiles.has(kernelPath))
      throw new Error("legacy-task-reconciliation-generation-invalid");
    const targetRecord = parseRecord(recordFile.bytes);
    const baseSourceTaskPath = projectTaskPath === authority.targetTaskPath
      ? authority.sourceTaskPath ?? sourceTaskPathForReconciledRecord(targetRecord, projectTaskPath, baseFiles)
      : sourceTaskPathForReconciledRecord(targetRecord, projectTaskPath, baseFiles);
    const baseRecordFile = baseFiles.get(`${baseSourceTaskPath}/legacy-import.json`);
    if (!baseRecordFile)
      throw new Error("legacy-task-reconciliation-generation-invalid");
    const baseRecord = JSON.parse(baseRecordFile.bytes.toString("utf8")) as Partial<LegacyTaskImportRecord>;
    const baseFacts = baseRecord.dependencyFacts as unknown as Record<string, unknown> | undefined;
    const archivedSource = baseSourceTaskPath
      .slice(TARGET_ROOT.length)
      .split("/")[0]
      ?.toLowerCase() === "archive";
    if (
      baseRecord.taskPath !== baseSourceTaskPath ||
      baseRecord.status !== "needs-definition" &&
        baseRecord.status !== "needs-coordination" &&
        baseRecord.status !== "archived-historical-only" ||
      archivedSource !== (baseRecord.status === "archived-historical-only") ||
      baseRecord.sourceFingerprint !== authority.sourceFingerprint
    ) throw new Error("legacy-task-reconciliation-generation-invalid");
    const record = targetRecord;
    if (
      record.taskPath !== projectTaskPath ||
      record.sourceFingerprint !== authority.sourceFingerprint ||
      record.legacyTaskId !== baseRecord.legacyTaskId ||
      JSON.stringify(record.sourceFiles) !== JSON.stringify(baseRecord.sourceFiles) ||
      JSON.stringify(record.historicalStatus) !== JSON.stringify(baseRecord.historicalStatus) ||
      JSON.stringify(record.legacySourceMetadata) !== JSON.stringify(baseRecord.legacySourceMetadata) ||
      JSON.stringify(record.legacyHistoryDiagnostics) !== JSON.stringify(baseRecord.legacyHistoryDiagnostics) ||
      JSON.stringify((record.dependencyFacts as unknown as Record<string, unknown>).taskJsonDependsOn) !== JSON.stringify(baseFacts?.taskJsonDependsOn) ||
      JSON.stringify((record.dependencyFacts as unknown as Record<string, unknown>).topLevelDependsMode) !== JSON.stringify(baseFacts?.topLevelDependsMode) ||
      JSON.stringify((record.dependencyFacts as unknown as Record<string, unknown>).metaDependsMode) !== JSON.stringify(baseFacts?.metaDependsMode) ||
      JSON.stringify((record.dependencyFacts as unknown as Record<string, unknown>).rawModes) !== JSON.stringify(baseFacts?.rawModes)
    ) throw new Error("legacy-task-reconciliation-generation-invalid");
    let kernelValue: unknown;
    try {
      kernelValue = JSON.parse(kernelFile.bytes.toString("utf8")) as unknown;
    } catch {
      throw new Error("legacy-task-reconciliation-kernel-invalid");
    }
    const kernel = parseTaskKernelSnapshotV2(kernelValue);
    const mappedTaskId = record.reconciliation?.mappedTaskId;
    if (
      kernel.identity.taskId !== (mappedTaskId ?? record.legacyTaskId) ||
      kernel.phase !== "define" ||
      kernel.outcome !== null ||
      kernel.runs.length !== 0 ||
      kernel.reviews.length !== 0 ||
      kernel.closure !== null ||
      !Array.isArray((record.dependencyFacts as unknown as Record<string, unknown>).hardDependencies) ||
      JSON.stringify(kernel.definition.dependencies) !== JSON.stringify((record.dependencyFacts as unknown as Record<string, unknown>).hardDependencies)
    ) throw new Error("legacy-task-reconciliation-kernel-invalid");
  }
  if (files.size !== taskPaths.size * 2)
    throw new Error("legacy-task-reconciliation-generation-invalid");
  return files;
}

/** Return verified reconciliations for a base migration authority, failing closed on orphan state. */
export function readLegacyTaskReconciliationFiles(
  projectRoot: string,
  baseAuthority: LegacyTaskMigrationCommit,
  baseFiles: ReadonlyMap<string, LegacyTaskMigrationFile>,
): { authority: LegacyTaskReconciliationAuthority | null; files: Map<string, LegacyTaskMigrationFile> } {
  const pointerBytes = readInternalFile(projectRoot, `${LEGACY_TASK_RECONCILIATION_STORE}/authority.json`);
  if (!pointerBytes) {
    assertEmptyWithoutAuthority(projectRoot);
    return { authority: null, files: new Map() };
  }
  let authority: LegacyTaskReconciliationAuthority;
  try {
    authority = parseAuthority(JSON.parse(pointerBytes.toString("utf8")) as unknown);
  } catch {
    throw new Error("legacy-task-reconciliation-authority-invalid");
  }
  if (
    authority.baseGenerationId !== baseAuthority.generationId ||
    authority.sourceFingerprint !== baseAuthority.sourceFingerprint
  ) throw new Error("legacy-task-reconciliation-base-authority-mismatch");
  return {
    authority,
    files: verifyLegacyTaskReconciliationGeneration(projectRoot, authority, baseFiles),
  };
}
