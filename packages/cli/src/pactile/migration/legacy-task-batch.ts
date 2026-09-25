import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  scanLegacyTaskMigration,
  type LegacySourceFile,
  type LegacyTaskMigrationPlan,
} from "../../core/task/legacy-task-migration.js";
import {
  assertCanonicalWriteTarget,
  caseFoldComponent,
  normalizeRuntimeRelativePath,
} from "../runtime/paths.js";

const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const STORAGE_RELATIVE = ".pactile/runtime/legacy-task-migrations";
const JOURNAL_STATES = [
  "planned",
  "backed-up",
  "staged",
  "validated",
  "committed",
  "review",
] as const;
const JOURNAL_EVENTS = [
  "planned",
  "source-backed-up",
  "targets-staged",
  "targets-validated",
  "authority-committed",
  "needs-review",
] as const;

export interface LegacyTaskBatchTargetFile {
  /** Relative to the immutable staged batch's files/ directory. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface LegacyTaskBatchRequest {
  readonly projectRoot: string;
  readonly plan: LegacyTaskMigrationPlan;
  /** Complete candidate payload, supplied by a future version-specific adapter. */
  readonly targets: readonly LegacyTaskBatchTargetFile[];
}

export interface LegacyTaskBatchValidationContext {
  readonly batchId: string;
  readonly generationId: string;
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
  readonly targets: readonly {
    readonly path: string;
    readonly fingerprint: string;
    readonly byteLength: number;
  }[];
}

export type LegacyTaskBatchPhase =
  | "source-backed-up"
  | "targets-staged"
  | "targets-validated"
  | "authority-committed";

export interface LegacyTaskBatchOptions {
  readonly dryRun?: boolean;
  /** No user-state write occurs unless this is true. */
  readonly approved?: boolean;
  readonly validateStaged?: (
    context: LegacyTaskBatchValidationContext,
  ) => boolean | Promise<boolean>;
  /** Progress hook, also useful to verify recovery at persisted boundaries. */
  readonly onPhase?: (phase: LegacyTaskBatchPhase) => void | Promise<void>;
  readonly occurredAt?: string;
}

export interface LegacyTaskBatchJournal {
  readonly schemaVersion: 1;
  readonly batchId: string;
  readonly generationId: string;
  readonly state: (typeof JOURNAL_STATES)[number];
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
  readonly planFingerprint: string;
  readonly expectedAuthorityFingerprint: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reason: string | null;
  readonly events: readonly {
    readonly sequence: number;
    readonly at: string;
    readonly event: (typeof JOURNAL_EVENTS)[number];
    readonly evidenceFingerprint: string;
  }[];
}

export interface LegacyTaskBatchAuthority {
  readonly schemaVersion: 1;
  readonly kind: "prepared-legacy-task-batch";
  /** This pointer exposes a complete staged batch only; Task readers do not consume it yet. */
  readonly visibility: "staged-only";
  readonly batchId: string;
  readonly generationId: string;
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
  readonly committedAt: string;
}

export type LegacyTaskBatchResult =
  | {
      readonly status: "dry-run" | "cancelled";
      readonly batchId: string;
      readonly generationId: string;
      readonly sourceFingerprint: string;
      readonly targetFingerprint: string;
      readonly wrote: false;
      readonly journal: null;
    }
  | {
      readonly status: "completed";
      readonly resumed: boolean;
      readonly batchId: string;
      readonly generationId: string;
      readonly sourceFingerprint: string;
      readonly targetFingerprint: string;
      readonly wrote: boolean;
      readonly journal: LegacyTaskBatchJournal;
    }
  | {
      readonly status: "blocked" | "review" | "interrupted";
      readonly reason: string;
      readonly batchId: string | null;
      readonly generationId: string | null;
      readonly sourceFingerprint: string | null;
      readonly targetFingerprint: string | null;
      readonly wrote: boolean;
      readonly journal: LegacyTaskBatchJournal | null;
    };

interface NormalizedTarget {
  readonly path: string;
  readonly bytes: Buffer;
  readonly fingerprint: string;
}

interface NormalizedRequest {
  readonly projectRoot: string;
  readonly plan: LegacyTaskMigrationPlan;
  readonly targets: readonly NormalizedTarget[];
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
  readonly planFingerprint: string;
  readonly batchId: string;
  readonly generationId: string;
}

interface JournalSnapshot {
  readonly journal: LegacyTaskBatchJournal;
  readonly fingerprint: string;
}

interface AuthoritySnapshot {
  readonly authority: LegacyTaskBatchAuthority;
  readonly fingerprint: string;
}

function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function bytesForSource(file: LegacySourceFile): Buffer {
  return file.encoding === "utf8"
    ? Buffer.from(file.content, "utf8")
    : Buffer.from(file.content, "base64");
}

function fingerprintSources(plan: LegacyTaskMigrationPlan): string | null {
  const files = plan.tasks.flatMap((task) => task.files);
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )) {
    const bytes = bytesForSource(file);
    if (bytes.byteLength !== file.byteLength || digest(bytes) !== file.sha256)
      return null;
    hash.update(file.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(bytes.byteLength), "utf8");
    hash.update("\0", "utf8");
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function canonicalTargetPath(value: string): string {
  const normalized = normalizeRuntimeRelativePath(value);
  if (normalized.split("/").some((part) => part.toLowerCase() === "archive"))
    throw new Error("archived-target-write-forbidden");
  return normalized;
}

function normalizeRequest(
  request: LegacyTaskBatchRequest,
): NormalizedRequest | null {
  try {
    const projectRoot = path.resolve(request.projectRoot);
    const plan = request.plan;
    if (
      !path.isAbsolute(request.projectRoot) ||
      path.resolve(plan.projectRoot) !== projectRoot ||
      plan.tasksRoot !== path.join(projectRoot, ".pactile", "tasks") ||
      plan.readOnly !== true ||
      plan.wrote !== false ||
      plan.preflight.status !== "clear-to-review" ||
      plan.preflight.blockerCount !== 0 ||
      !FINGERPRINT.test(plan.sourceFingerprint ?? "") ||
      !Array.isArray(request.targets) ||
      request.targets.length === 0
    )
      return null;

    const sourceFingerprint = fingerprintSources(plan);
    if (
      !sourceFingerprint ||
      !plan.sourceFingerprint ||
      sourceFingerprint !== plan.sourceFingerprint
    )
      return null;
    const targets = request.targets
      .map((target): NormalizedTarget => {
        const targetPath = canonicalTargetPath(target.path);
        const bytes = Buffer.from(target.bytes);
        return { path: targetPath, bytes, fingerprint: digest(bytes) };
      })
      .sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      );
    const foldedPaths = targets.map((target) =>
      target.path.split("/").map(caseFoldComponent).join("/"),
    );
    if (new Set(foldedPaths).size !== targets.length) return null;

    const targetFingerprint = digest(
      jsonBytes(
        targets.map(({ path: targetPath, bytes, fingerprint }) => ({
          path: targetPath,
          byteLength: bytes.byteLength,
          fingerprint,
        })),
      ),
    );
    const planFingerprint = digest(
      jsonBytes({ sourceFingerprint, targetFingerprint }),
    );
    const batchId = `legacy-${planFingerprint.slice("sha256:".length)}`;
    return {
      projectRoot,
      plan,
      targets,
      sourceFingerprint,
      targetFingerprint,
      planFingerprint,
      batchId,
      generationId: batchId,
    };
  } catch {
    return null;
  }
}

function storagePath(projectRoot: string, ...parts: string[]): string {
  return assertCanonicalWriteTarget(
    projectRoot,
    path.join(projectRoot, STORAGE_RELATIVE, ...parts),
  );
}

function ensureDirectory(projectRoot: string, target: string): void {
  const safe = assertCanonicalWriteTarget(projectRoot, target);
  fs.mkdirSync(safe, { recursive: true });
  assertCanonicalWriteTarget(projectRoot, safe);
}

function readRegularFile(projectRoot: string, target: string): Buffer | null {
  const safe = assertCanonicalWriteTarget(projectRoot, target);
  try {
    const stat = fs.lstatSync(safe);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error("migration-store-file-invalid");
    assertCanonicalWriteTarget(projectRoot, safe);
    return fs.readFileSync(safe);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

function writeExclusive(
  projectRoot: string,
  target: string,
  bytes: Uint8Array,
): "written" | "already-matched" {
  const safe = assertCanonicalWriteTarget(projectRoot, target);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      safe,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("migration-store-file-invalid");
    assertCanonicalWriteTarget(projectRoot, safe);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    return "written";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      const existing = readRegularFile(projectRoot, safe);
      if (existing?.equals(Buffer.from(bytes))) return "already-matched";
      throw new Error("migration-immutable-collision");
    }
    throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function atomicReplace(
  projectRoot: string,
  target: string,
  bytes: Uint8Array,
): void {
  const safe = assertCanonicalWriteTarget(projectRoot, target);
  const temporary = assertCanonicalWriteTarget(
    projectRoot,
    `${safe}.tmp-${randomUUID()}`,
  );
  let created = false;
  try {
    writeExclusive(projectRoot, temporary, bytes);
    created = true;
    assertCanonicalWriteTarget(projectRoot, safe);
    assertCanonicalWriteTarget(projectRoot, temporary);
    fs.renameSync(temporary, safe);
    created = false;
  } finally {
    if (created) {
      try {
        assertCanonicalWriteTarget(projectRoot, temporary);
        fs.unlinkSync(temporary);
      } catch {
        /* A leftover unique temporary is reported by recovery inspection. */
      }
    }
  }
}

function withLock<T>(
  projectRoot: string,
  lockPath: string,
  action: () => T,
): T {
  const safe = assertCanonicalWriteTarget(projectRoot, lockPath);
  const token = JSON.stringify({ pid: process.pid, token: randomUUID() });
  let descriptor: number | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      descriptor = fs.openSync(
        safe,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      break;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
      if (attempt === 0 && reclaimDeadProcessLock(projectRoot, safe)) continue;
      throw new Error("migration-lock-unavailable");
    }
  }
  if (descriptor === null) throw new Error("migration-lock-unavailable");
  try {
    fs.writeFileSync(descriptor, token, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    return action();
  } finally {
    try {
      assertCanonicalWriteTarget(projectRoot, safe);
      if (fs.readFileSync(safe, "utf8") === token) fs.unlinkSync(safe);
    } catch {
      /* Do not remove a lock whose ownership can no longer be proven. */
    }
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    return true;
  }
}

function reclaimDeadProcessLock(projectRoot: string, target: string): boolean {
  const original = readRegularFile(projectRoot, target);
  if (!original) return false;
  let owner: unknown;
  try {
    owner = JSON.parse(original.toString("utf8")) as unknown;
  } catch {
    return false;
  }
  if (
    !owner ||
    typeof owner !== "object" ||
    Array.isArray(owner) ||
    typeof (owner as { pid?: unknown }).pid !== "number" ||
    typeof (owner as { token?: unknown }).token !== "string" ||
    (owner as { token: string }).token.length < 8 ||
    processIsAlive((owner as { pid: number }).pid)
  )
    return false;
  const current = readRegularFile(projectRoot, target);
  if (!current?.equals(original)) return false;
  assertCanonicalWriteTarget(projectRoot, target);
  fs.unlinkSync(target);
  return true;
}

function parseJournal(value: unknown): LegacyTaskBatchJournal {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("migration-journal-invalid");
  const journal = value as Partial<LegacyTaskBatchJournal>;
  if (
    journal.schemaVersion !== 1 ||
    typeof journal.batchId !== "string" ||
    typeof journal.generationId !== "string" ||
    !JOURNAL_STATES.includes(
      journal.state as (typeof JOURNAL_STATES)[number],
    ) ||
    !FINGERPRINT.test(journal.sourceFingerprint ?? "") ||
    !FINGERPRINT.test(journal.targetFingerprint ?? "") ||
    !FINGERPRINT.test(journal.planFingerprint ?? "") ||
    (journal.expectedAuthorityFingerprint !== null &&
      !FINGERPRINT.test(journal.expectedAuthorityFingerprint ?? "")) ||
    typeof journal.createdAt !== "string" ||
    Number.isNaN(Date.parse(journal.createdAt)) ||
    typeof journal.updatedAt !== "string" ||
    Number.isNaN(Date.parse(journal.updatedAt)) ||
    !(journal.reason === null || typeof journal.reason === "string") ||
    !Array.isArray(journal.events) ||
    journal.events.some(
      (event, index) =>
        event.sequence !== index + 1 ||
        !JOURNAL_EVENTS.includes(event.event) ||
        !FINGERPRINT.test(event.evidenceFingerprint) ||
        Number.isNaN(Date.parse(event.at)),
    )
  )
    throw new Error("migration-journal-invalid");
  return journal as LegacyTaskBatchJournal;
}

function journalPath(projectRoot: string, batchId: string): string {
  return storagePath(projectRoot, "journals", `${batchId}.json`);
}

function readJournal(
  projectRoot: string,
  batchId: string,
): JournalSnapshot | null {
  const bytes = readRegularFile(projectRoot, journalPath(projectRoot, batchId));
  if (!bytes) return null;
  try {
    const journal = parseJournal(JSON.parse(bytes.toString("utf8")) as unknown);
    return { journal, fingerprint: digest(jsonBytes(journal)) };
  } catch {
    throw new Error("migration-journal-invalid");
  }
}

function writeJournal(
  projectRoot: string,
  batchId: string,
  expectedFingerprint: string | null,
  journal: LegacyTaskBatchJournal,
): JournalSnapshot {
  const directory = storagePath(projectRoot, "journals");
  ensureDirectory(projectRoot, directory);
  const target = journalPath(projectRoot, batchId);
  const lock = `${target}.lock`;
  return withLock(projectRoot, lock, () => {
    const current = readJournal(projectRoot, batchId);
    if ((current?.fingerprint ?? null) !== expectedFingerprint)
      throw new Error("migration-journal-cas-mismatch");
    const parsed = parseJournal(journal);
    const bytes = jsonBytes(parsed);
    atomicReplace(projectRoot, target, bytes);
    return { journal: parsed, fingerprint: digest(bytes) };
  });
}

function parseAuthority(value: unknown): LegacyTaskBatchAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("migration-authority-invalid");
  const authority = value as Partial<LegacyTaskBatchAuthority>;
  if (
    authority.schemaVersion !== 1 ||
    authority.kind !== "prepared-legacy-task-batch" ||
    authority.visibility !== "staged-only" ||
    typeof authority.batchId !== "string" ||
    typeof authority.generationId !== "string" ||
    !FINGERPRINT.test(authority.sourceFingerprint ?? "") ||
    !FINGERPRINT.test(authority.targetFingerprint ?? "") ||
    typeof authority.committedAt !== "string" ||
    Number.isNaN(Date.parse(authority.committedAt))
  )
    throw new Error("migration-authority-invalid");
  return authority as LegacyTaskBatchAuthority;
}

function authorityPath(projectRoot: string): string {
  return storagePath(projectRoot, "authority.json");
}

function readAuthoritySnapshot(projectRoot: string): AuthoritySnapshot | null {
  const bytes = readRegularFile(projectRoot, authorityPath(projectRoot));
  if (!bytes) return null;
  try {
    const authority = parseAuthority(
      JSON.parse(bytes.toString("utf8")) as unknown,
    );
    verifyGeneration(projectRoot, authority.generationId, {
      batchId: authority.batchId,
      sourceFingerprint: authority.sourceFingerprint,
      targetFingerprint: authority.targetFingerprint,
    });
    verifySourceBackup(projectRoot, authority.sourceFingerprint);
    return { authority, fingerprint: digest(jsonBytes(authority)) };
  } catch {
    throw new Error("migration-authority-invalid");
  }
}

function writeAuthority(
  projectRoot: string,
  expectedFingerprint: string | null,
  authority: LegacyTaskBatchAuthority,
): AuthoritySnapshot {
  const target = authorityPath(projectRoot);
  ensureDirectory(projectRoot, path.dirname(target));
  return withLock(projectRoot, `${target}.lock`, () => {
    const current = readAuthoritySnapshot(projectRoot);
    if ((current?.fingerprint ?? null) !== expectedFingerprint)
      throw new Error("migration-authority-cas-mismatch");
    verifyGeneration(projectRoot, authority.generationId, {
      batchId: authority.batchId,
      sourceFingerprint: authority.sourceFingerprint,
      targetFingerprint: authority.targetFingerprint,
    });
    const bytes = jsonBytes(authority);
    atomicReplace(projectRoot, target, bytes);
    return { authority, fingerprint: digest(bytes) };
  });
}

function validatePlanAtRoot(
  projectRoot: string,
  plan: LegacyTaskMigrationPlan,
): boolean {
  return (
    path.resolve(plan.projectRoot) === path.resolve(projectRoot) &&
    plan.tasksRoot ===
      path.join(path.resolve(projectRoot), ".pactile", "tasks") &&
    plan.readOnly === true &&
    plan.wrote === false &&
    plan.preflight.status === "clear-to-review" &&
    plan.preflight.blockerCount === 0 &&
    plan.scannedTaskCount === plan.tasks.length &&
    plan.scannedFileCount ===
      plan.tasks.reduce((count, task) => count + task.files.length, 0) &&
    fingerprintSources(plan) === plan.sourceFingerprint
  );
}

function assertSourceUnchanged(request: NormalizedRequest): void {
  const current = scanLegacyTaskMigration({ projectRoot: request.projectRoot });
  if (
    current.preflight.status !== "clear-to-review" ||
    current.sourceFingerprint !== request.sourceFingerprint
  )
    throw new Error("migration-source-changed");
}

function backupManifest(plan: LegacyTaskMigrationPlan): Buffer {
  const files = plan.tasks
    .flatMap((task) => task.files)
    .map((file) => ({
      path: file.path,
      role: file.role,
      byteLength: file.byteLength,
      fingerprint: file.sha256,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return jsonBytes({
    schemaVersion: 1,
    kind: "legacy-task-source-snapshot",
    sourceFingerprint: plan.sourceFingerprint,
    files,
  });
}

function writeSourceBackup(request: NormalizedRequest): void {
  const root = storagePath(
    request.projectRoot,
    "sources",
    request.sourceFingerprint.slice("sha256:".length),
  );
  ensureDirectory(request.projectRoot, root);
  for (const file of request.plan.tasks.flatMap((task) => task.files)) {
    const bytes = bytesForSource(file);
    if (digest(bytes) !== file.sha256 || bytes.byteLength !== file.byteLength)
      throw new Error("migration-source-plan-invalid");
    const target = assertCanonicalWriteTarget(
      request.projectRoot,
      path.join(root, "files", file.path),
    );
    ensureDirectory(request.projectRoot, path.dirname(target));
    writeExclusive(request.projectRoot, target, bytes);
  }
  const manifest = backupManifest(request.plan);
  writeExclusive(
    request.projectRoot,
    path.join(root, "manifest.json"),
    manifest,
  );
  verifySourceBackup(request.projectRoot, request.sourceFingerprint);
}

function verifySourceBackup(
  projectRoot: string,
  sourceFingerprint: string,
): void {
  const directory = storagePath(
    projectRoot,
    "sources",
    sourceFingerprint.slice("sha256:".length),
  );
  const manifestPath = path.join(directory, "manifest.json");
  const bytes = readRegularFile(projectRoot, manifestPath);
  if (!bytes) throw new Error("migration-source-backup-invalid");
  let manifest: unknown;
  try {
    manifest = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("migration-source-backup-invalid");
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    (manifest as { sourceFingerprint?: unknown }).sourceFingerprint !==
      sourceFingerprint ||
    (manifest as { kind?: unknown }).kind !== "legacy-task-source-snapshot"
  )
    throw new Error("migration-source-backup-invalid");
  const files = (manifest as { files?: unknown }).files;
  if (!Array.isArray(files)) throw new Error("migration-source-backup-invalid");
  const found = new Set<string>();
  const recompute = new Map<
    string,
    { byteLength: number; fingerprint: string; bytes: Buffer }
  >();
  for (const item of files) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("migration-source-backup-invalid");
    const entry = item as {
      path?: unknown;
      byteLength?: unknown;
      fingerprint?: unknown;
    };
    if (
      typeof entry.path !== "string" ||
      typeof entry.byteLength !== "number" ||
      !FINGERPRINT.test(
        typeof entry.fingerprint === "string" ? entry.fingerprint : "",
      )
    )
      throw new Error("migration-source-backup-invalid");
    const relative = normalizeRuntimeRelativePath(entry.path);
    if (relative !== entry.path)
      throw new Error("migration-source-backup-invalid");
    const filePath = assertCanonicalWriteTarget(
      projectRoot,
      path.join(directory, "files", relative),
    );
    const fileBytes = readRegularFile(projectRoot, filePath);
    if (!fileBytes) throw new Error("migration-source-backup-invalid");
    if (
      fileBytes.byteLength !== entry.byteLength ||
      digest(fileBytes) !== entry.fingerprint
    )
      throw new Error("migration-source-backup-invalid");
    found.add(relative);
    recompute.set(relative, {
      byteLength: fileBytes.byteLength,
      fingerprint: digest(fileBytes),
      bytes: fileBytes,
    });
  }
  const manifestEntries = (
    manifest as {
      files: { path: string; byteLength: number; fingerprint: string }[];
    }
  ).files;
  const ordered = [...manifestEntries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const sourceHash = createHash("sha256");
  for (const entry of ordered) {
    const file = recompute.get(entry.path);
    if (!file) throw new Error("migration-source-backup-invalid");
    if (
      entry.byteLength !== file.byteLength ||
      entry.fingerprint !== file.fingerprint
    )
      throw new Error("migration-source-backup-invalid");
    sourceHash.update(entry.path, "utf8");
    sourceHash.update("\0", "utf8");
    sourceHash.update(String(file.byteLength), "utf8");
    sourceHash.update("\0", "utf8");
    sourceHash.update(file.bytes);
  }
  const actualFiles = listFiles(projectRoot, path.join(directory, "files"))
    .map((target) =>
      path
        .relative(path.join(directory, "files"), target)
        .split(path.sep)
        .join("/"),
    )
    .sort();
  const expectedFiles = ordered.map((entry) => entry.path);
  if (
    new Set(manifestEntries.map((item) => item.path)).size !== found.size ||
    `sha256:${sourceHash.digest("hex")}` !== sourceFingerprint ||
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((file, index) => file !== expectedFiles[index])
  )
    throw new Error("migration-source-backup-invalid");
}

function listFiles(projectRoot: string, root: string): string[] {
  const output: string[] = [];
  const visit = (directory: string): void => {
    assertCanonicalWriteTarget(projectRoot, directory);
    for (const name of fs.readdirSync(directory).sort()) {
      const target = assertCanonicalWriteTarget(
        projectRoot,
        path.join(directory, name),
      );
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink())
        throw new Error("migration-store-link-invalid");
      if (stat.isDirectory()) visit(target);
      else if (stat.isFile() && stat.nlink === 1) output.push(target);
      else throw new Error("migration-store-file-invalid");
    }
  };
  visit(root);
  return output;
}

interface GenerationManifest {
  readonly schemaVersion: 1;
  readonly kind: "legacy-task-staged-generation";
  readonly batchId: string;
  readonly generationId: string;
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
  readonly files: readonly {
    readonly path: string;
    readonly byteLength: number;
    readonly fingerprint: string;
  }[];
  readonly createdAt: string;
}

function generationDirectory(
  projectRoot: string,
  generationId: string,
): string {
  return storagePath(projectRoot, "generations", generationId);
}

function stageTargets(request: NormalizedRequest, createdAt: string): void {
  const directory = generationDirectory(
    request.projectRoot,
    request.generationId,
  );
  ensureDirectory(request.projectRoot, directory);
  for (const target of request.targets) {
    const absolute = assertCanonicalWriteTarget(
      request.projectRoot,
      path.join(directory, "files", target.path),
    );
    ensureDirectory(request.projectRoot, path.dirname(absolute));
    writeExclusive(request.projectRoot, absolute, target.bytes);
  }
  const manifest: GenerationManifest = {
    schemaVersion: 1,
    kind: "legacy-task-staged-generation",
    batchId: request.batchId,
    generationId: request.generationId,
    sourceFingerprint: request.sourceFingerprint,
    targetFingerprint: request.targetFingerprint,
    files: request.targets.map((target) => ({
      path: target.path,
      byteLength: target.bytes.byteLength,
      fingerprint: target.fingerprint,
    })),
    createdAt,
  };
  writeExclusive(
    request.projectRoot,
    path.join(directory, "manifest.json"),
    jsonBytes(manifest),
  );
  verifyGeneration(request.projectRoot, request.generationId, {
    batchId: request.batchId,
    sourceFingerprint: request.sourceFingerprint,
    targetFingerprint: request.targetFingerprint,
  });
}

function verifyGeneration(
  projectRoot: string,
  generationId: string,
  expected: {
    readonly batchId: string;
    readonly sourceFingerprint: string;
    readonly targetFingerprint: string;
  },
): GenerationManifest {
  const directory = generationDirectory(projectRoot, generationId);
  const manifestBytes = readRegularFile(
    projectRoot,
    path.join(directory, "manifest.json"),
  );
  if (!manifestBytes) throw new Error("migration-generation-invalid");
  let value: unknown;
  try {
    value = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("migration-generation-invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("migration-generation-invalid");
  const manifest = value as Partial<GenerationManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "legacy-task-staged-generation" ||
    manifest.batchId !== expected.batchId ||
    manifest.generationId !== generationId ||
    manifest.sourceFingerprint !== expected.sourceFingerprint ||
    manifest.targetFingerprint !== expected.targetFingerprint ||
    typeof manifest.createdAt !== "string" ||
    !Array.isArray(manifest.files)
  )
    throw new Error("migration-generation-invalid");

  const fileEntries = manifest.files;
  const names = new Set<string>();
  const targetFacts: {
    path: string;
    byteLength: number;
    fingerprint: string;
  }[] = [];
  for (const entry of fileEntries) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      typeof entry.byteLength !== "number" ||
      !FINGERPRINT.test(entry.fingerprint)
    )
      throw new Error("migration-generation-invalid");
    const relative = canonicalTargetPath(entry.path);
    const folded = relative.split("/").map(caseFoldComponent).join("/");
    if (names.has(folded)) throw new Error("migration-generation-invalid");
    names.add(folded);
    const fileBytes = readRegularFile(
      projectRoot,
      path.join(directory, "files", relative),
    );
    if (
      !fileBytes ||
      fileBytes.byteLength !== entry.byteLength ||
      digest(fileBytes) !== entry.fingerprint
    )
      throw new Error("migration-generation-invalid");
    targetFacts.push({
      path: relative,
      byteLength: entry.byteLength,
      fingerprint: entry.fingerprint,
    });
  }
  if (
    digest(jsonBytes(targetFacts)) !== manifest.targetFingerprint ||
    targetFacts.length === 0
  )
    throw new Error("migration-generation-invalid");
  const actualFiles = listFiles(projectRoot, path.join(directory, "files"))
    .map((target) =>
      path
        .relative(path.join(directory, "files"), target)
        .split(path.sep)
        .join("/"),
    )
    .sort();
  const expectedFiles = targetFacts.map((item) => item.path).sort();
  if (
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((file, index) => file !== expectedFiles[index])
  )
    throw new Error("migration-generation-invalid");
  return manifest as GenerationManifest;
}

function initialJournal(
  request: NormalizedRequest,
  expectedAuthorityFingerprint: string | null,
  at: string,
): LegacyTaskBatchJournal {
  return {
    schemaVersion: 1,
    batchId: request.batchId,
    generationId: request.generationId,
    state: "planned",
    sourceFingerprint: request.sourceFingerprint,
    targetFingerprint: request.targetFingerprint,
    planFingerprint: request.planFingerprint,
    expectedAuthorityFingerprint,
    createdAt: at,
    updatedAt: at,
    reason: null,
    events: [
      {
        sequence: 1,
        at,
        event: "planned",
        evidenceFingerprint: request.planFingerprint,
      },
    ],
  };
}

function nextJournal(
  journal: LegacyTaskBatchJournal,
  state: LegacyTaskBatchJournal["state"],
  event: (typeof JOURNAL_EVENTS)[number],
  evidenceFingerprint: string,
  at: string,
  reason: string | null = null,
): LegacyTaskBatchJournal {
  return {
    ...journal,
    state,
    updatedAt: at,
    reason,
    events: [
      ...journal.events,
      {
        sequence: journal.events.length + 1,
        at,
        event,
        evidenceFingerprint,
      },
    ],
  };
}

function commitJournal(
  projectRoot: string,
  snapshot: JournalSnapshot,
  journal: LegacyTaskBatchJournal,
): JournalSnapshot {
  return writeJournal(
    projectRoot,
    journal.batchId,
    snapshot.fingerprint,
    journal,
  );
}

function makeResult(
  status: "blocked" | "review" | "interrupted",
  reason: string,
  request: NormalizedRequest | null,
  wrote: boolean,
  journal: LegacyTaskBatchJournal | null,
): LegacyTaskBatchResult {
  return {
    status,
    reason,
    batchId: request?.batchId ?? null,
    generationId: request?.generationId ?? null,
    sourceFingerprint: request?.sourceFingerprint ?? null,
    targetFingerprint: request?.targetFingerprint ?? null,
    wrote,
    journal,
  };
}

function completedResult(
  request: NormalizedRequest,
  journal: LegacyTaskBatchJournal,
  resumed: boolean,
  wrote: boolean,
): LegacyTaskBatchResult {
  return {
    status: "completed",
    resumed,
    batchId: request.batchId,
    generationId: request.generationId,
    sourceFingerprint: request.sourceFingerprint,
    targetFingerprint: request.targetFingerprint,
    wrote,
    journal,
  };
}

async function checkpoint(
  options: LegacyTaskBatchOptions,
  phase: LegacyTaskBatchPhase,
): Promise<void> {
  await options.onPhase?.(phase);
}

/** Read the one prepared-batch pointer and verify every staged byte before exposing it. */
export function readPreparedLegacyTaskBatch(
  projectRoot: string,
): LegacyTaskBatchAuthority | null {
  const root = path.resolve(projectRoot);
  const snapshot = readAuthoritySnapshot(root);
  if (snapshot) {
    const current = scanLegacyTaskMigration({ projectRoot: root });
    if (
      current.preflight.status !== "clear-to-review" ||
      current.sourceFingerprint !== snapshot.authority.sourceFingerprint
    )
      throw new Error("migration-authority-source-stale");
  }
  return snapshot?.authority ?? null;
}

/**
 * Prepare a complete source-preserving migration batch outside `.pactile/tasks`.
 * Nothing becomes a Task Kernel until a later Kernel adapter consumes this
 * staged-only pointer. The entire batch is exposed by one atomic pointer CAS.
 */
export async function runLegacyTaskBatch(
  request: LegacyTaskBatchRequest,
  options: LegacyTaskBatchOptions = {},
): Promise<LegacyTaskBatchResult> {
  const normalized = normalizeRequest(request);
  if (
    !normalized ||
    !validatePlanAtRoot(path.resolve(request.projectRoot), request.plan)
  )
    return makeResult(
      "blocked",
      "invalid-or-blocked-source-plan",
      null,
      false,
      null,
    );

  let currentPlan: LegacyTaskMigrationPlan;
  try {
    currentPlan = scanLegacyTaskMigration({
      projectRoot: normalized.projectRoot,
    });
  } catch {
    return makeResult(
      "blocked",
      "source-preflight-unavailable",
      normalized,
      false,
      null,
    );
  }
  if (
    currentPlan.preflight.status !== "clear-to-review" ||
    currentPlan.sourceFingerprint !== normalized.sourceFingerprint
  )
    return makeResult(
      "blocked",
      "migration-source-changed",
      normalized,
      false,
      null,
    );

  let authorityAtStart: AuthoritySnapshot | null;
  try {
    authorityAtStart = readAuthoritySnapshot(normalized.projectRoot);
  } catch {
    return makeResult(
      "review",
      "migration-authority-invalid",
      normalized,
      false,
      null,
    );
  }

  if (options.dryRun) {
    return {
      status: "dry-run",
      batchId: normalized.batchId,
      generationId: normalized.generationId,
      sourceFingerprint: normalized.sourceFingerprint,
      targetFingerprint: normalized.targetFingerprint,
      wrote: false,
      journal: null,
    };
  }
  if (options.approved !== true) {
    return {
      status: "cancelled",
      batchId: normalized.batchId,
      generationId: normalized.generationId,
      sourceFingerprint: normalized.sourceFingerprint,
      targetFingerprint: normalized.targetFingerprint,
      wrote: false,
      journal: null,
    };
  }

  const occurredAt = options.occurredAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(occurredAt)))
    return makeResult("blocked", "invalid-event-time", normalized, false, null);
  let snapshot: JournalSnapshot | null = null;
  let wrote = false;
  let resumed = false;
  try {
    snapshot = readJournal(normalized.projectRoot, normalized.batchId);
    if (snapshot) {
      resumed = true;
      if (
        snapshot.journal.planFingerprint !== normalized.planFingerprint ||
        snapshot.journal.sourceFingerprint !== normalized.sourceFingerprint ||
        snapshot.journal.targetFingerprint !== normalized.targetFingerprint
      )
        return makeResult(
          "review",
          "migration-plan-conflict",
          normalized,
          false,
          snapshot.journal,
        );
      if (snapshot.journal.state === "review")
        return makeResult(
          "review",
          snapshot.journal.reason ?? "migration-needs-review",
          normalized,
          false,
          snapshot.journal,
        );
      if (snapshot.journal.state === "committed")
        return completedResult(normalized, snapshot.journal, true, false);
    } else {
      const journal = initialJournal(
        normalized,
        authorityAtStart?.fingerprint ?? null,
        occurredAt,
      );
      snapshot = writeJournal(
        normalized.projectRoot,
        normalized.batchId,
        null,
        journal,
      );
      wrote = true;
    }

    if (snapshot.journal.state === "planned") {
      assertSourceUnchanged(normalized);
      writeSourceBackup(normalized);
      wrote = true;
      const next = nextJournal(
        snapshot.journal,
        "backed-up",
        "source-backed-up",
        normalized.sourceFingerprint,
        occurredAt,
      );
      snapshot = commitJournal(normalized.projectRoot, snapshot, next);
      await checkpoint(options, "source-backed-up");
    }

    if (snapshot.journal.state === "backed-up") {
      assertSourceUnchanged(normalized);
      stageTargets(normalized, snapshot.journal.createdAt);
      wrote = true;
      const next = nextJournal(
        snapshot.journal,
        "staged",
        "targets-staged",
        normalized.targetFingerprint,
        occurredAt,
      );
      snapshot = commitJournal(normalized.projectRoot, snapshot, next);
      await checkpoint(options, "targets-staged");
    }

    if (snapshot.journal.state === "staged") {
      const manifest = verifyGeneration(
        normalized.projectRoot,
        normalized.generationId,
        {
          batchId: normalized.batchId,
          sourceFingerprint: normalized.sourceFingerprint,
          targetFingerprint: normalized.targetFingerprint,
        },
      );
      const context: LegacyTaskBatchValidationContext = {
        batchId: normalized.batchId,
        generationId: normalized.generationId,
        sourceFingerprint: normalized.sourceFingerprint,
        targetFingerprint: normalized.targetFingerprint,
        targets: manifest.files,
      };
      if (options.validateStaged && !(await options.validateStaged(context))) {
        const review = nextJournal(
          snapshot.journal,
          "review",
          "needs-review",
          normalized.targetFingerprint,
          occurredAt,
          "migration-validation-failed",
        );
        snapshot = commitJournal(normalized.projectRoot, snapshot, review);
        return makeResult(
          "review",
          "migration-validation-failed",
          normalized,
          wrote,
          snapshot.journal,
        );
      }
      assertSourceUnchanged(normalized);
      const next = nextJournal(
        snapshot.journal,
        "validated",
        "targets-validated",
        normalized.targetFingerprint,
        occurredAt,
      );
      snapshot = commitJournal(normalized.projectRoot, snapshot, next);
      await checkpoint(options, "targets-validated");
    }

    if (snapshot.journal.state === "validated") {
      assertSourceUnchanged(normalized);
      const current = readAuthoritySnapshot(normalized.projectRoot);
      if (
        current?.authority.batchId === normalized.batchId &&
        current.authority.generationId === normalized.generationId
      ) {
        // The process may have stopped after the atomic pointer replace.
      } else if (
        (current?.fingerprint ?? null) !==
        snapshot.journal.expectedAuthorityFingerprint
      ) {
        const review = nextJournal(
          snapshot.journal,
          "review",
          "needs-review",
          current?.fingerprint ?? digest("no-authority"),
          occurredAt,
          "migration-authority-cas-mismatch",
        );
        snapshot = commitJournal(normalized.projectRoot, snapshot, review);
        return makeResult(
          "review",
          "migration-authority-cas-mismatch",
          normalized,
          wrote,
          snapshot.journal,
        );
      } else {
        const authority: LegacyTaskBatchAuthority = {
          schemaVersion: 1,
          kind: "prepared-legacy-task-batch",
          visibility: "staged-only",
          batchId: normalized.batchId,
          generationId: normalized.generationId,
          sourceFingerprint: normalized.sourceFingerprint,
          targetFingerprint: normalized.targetFingerprint,
          committedAt: occurredAt,
        };
        writeAuthority(
          normalized.projectRoot,
          snapshot.journal.expectedAuthorityFingerprint,
          authority,
        );
        wrote = true;
      }
      await checkpoint(options, "authority-committed");
      const committed = nextJournal(
        snapshot.journal,
        "committed",
        "authority-committed",
        normalized.planFingerprint,
        occurredAt,
      );
      snapshot = commitJournal(normalized.projectRoot, snapshot, committed);
    }

    return completedResult(normalized, snapshot.journal, resumed, wrote);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "migration-interrupted";
    try {
      snapshot ??= readJournal(normalized.projectRoot, normalized.batchId);
    } catch {
      /* Report interruption even when the persisted journal is unreadable. */
    }
    return makeResult(
      reason === "migration-source-changed" ? "blocked" : "interrupted",
      reason,
      normalized,
      wrote,
      snapshot?.journal ?? null,
    );
  }
}
