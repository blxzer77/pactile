import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  KernelError,
  deriveStateForPhase,
  isNonNegativeInt,
  requireNonEmptyString,
  type KernelAuditEvent,
  type KernelCondition,
  type KernelOutcome,
  type KernelPhase,
  type KernelState,
} from "./kernel-contract.js";
import {
  readKernel,
  readKernelStateDocument,
  withKernelStateLock,
  writeKernelStateDocument,
} from "./kernel-store.js";
import { isPlainObject } from "./schema.js";
import { parseDefinition, parseTaskKernelSnapshotV2, fingerprintTaskValue, requireArrayEntry } from "./task-kernel-schema.js";
import {
  LEGACY_TASK_MIGRATION_STORE,
  legacyTaskMigrationOverlayPath,
  listLegacyTaskMigrationDirectories,
  readLegacyTaskImportRecord,
  readLegacyTaskMigrationFile,
  readLegacyTaskMigrationView,
  type LegacyTaskImportRecord,
  type LegacyTaskMigrationView,
} from "./legacy-task-migration-reader.js";
import {
  assertDependenciesResolvable,
  assertNoDependencyCycle,
  assertUniqueTaskId,
  canonicalProjectRoot,
  resolveInsideTaskRoot,
  resolveInsideTasksRoot,
} from "./task-kernel-paths.js";
import {
  TASK_KERNEL_SCHEMA_VERSION,
  type AnyTaskKernelReadResult,
  type CreateTaskKernelRequest,
  type TaskKernelEventType,
  type TaskKernelEventV2,
  type TaskKernelMutationResult,
  type TaskKernelSnapshotV2,
} from "./task-kernel-types.js";

const OVERLAY_JOURNAL_DIRECTORY = `${LEGACY_TASK_MIGRATION_STORE}/overlay-journal`;
const OVERLAY_FINGERPRINT = /^sha256:[a-f0-9]{64}$/;

interface LegacyTaskKernelOverlayJournalEntry {
  readonly schemaVersion: 1;
  readonly kind: "legacy-task-kernel-overlay-mutation";
  readonly taskPath: string;
  readonly taskId: string;
  readonly generationId: string;
  readonly sourceFingerprint: string;
  readonly previousRevision: number;
  readonly revision: number;
  readonly previousKernelFingerprint: string;
  readonly kernelFingerprint: string;
}

export function readTaskKernel(options: { root: string; taskDir: string; cwd?: string }): AnyTaskKernelReadResult {
  const root = canonicalProjectRoot(options.root, options.cwd);
  const taskDir = resolveInsideTasksRoot(root, options.taskDir, options.cwd);
  let migrationView: ReturnType<typeof readLegacyTaskMigrationView>;
  try {
    migrationView = readLegacyTaskMigrationView(root);
  } catch (error) {
    throw new KernelError("CORRUPT_STATE", error instanceof Error ? error.message : String(error));
  }
  const importRecord = readLegacyTaskImportRecord(root, taskDir, migrationView);
  if (importRecord?.status === "needs-definition") {
    throw new KernelError(
      "LEGACY_TASK_REQUIRES_DEFINITION",
      `Task ${importRecord.legacyTaskId} needs definition fields before it can run: ${importRecord.missingDefinitionFields.join(", ")}`,
    );
  }
  if (importRecord?.status === "needs-coordination") {
    throw new KernelError(
      "LEGACY_TASK_REQUIRES_COORDINATION",
      `Task ${importRecord.legacyTaskId} has unresolved blocking legacy dependencies: ${importRecord.coordinationReasons.join(", ")}`,
    );
  }
  if (importRecord?.status === "imported") {
    if (!migrationView)
      throw new KernelError("CORRUPT_STATE", "legacy-task-migration-view-missing");
    const overlayBytes = readLegacyTaskKernelOverlay({
      root,
      taskDir,
      record: importRecord,
      view: migrationView,
      cwd: options.cwd,
    });
    if (overlayBytes) {
      let overlayDocument: unknown;
      try {
        overlayDocument = JSON.parse(overlayBytes.toString("utf8")) as unknown;
      } catch {
        throw new KernelError("CORRUPT_STATE", "legacy Task Kernel overlay JSON is invalid");
      }
      return { kind: "task-kernel-v2", kernel: parseTaskKernelSnapshotV2(overlayDocument) };
    }
    const staged = readLegacyTaskMigrationFile(root, taskDir, "kernel.json", migrationView);
    if (!staged) throw new KernelError("CORRUPT_STATE", "legacy-task-migration-kernel-missing");
    let document: unknown;
    try {
      document = JSON.parse(staged.toString("utf8")) as unknown;
    } catch {
      throw new KernelError("CORRUPT_STATE", "legacy-task-migration-kernel-invalid");
    }
    return { kind: "task-kernel-v2", kernel: parseTaskKernelSnapshotV2(document) };
  }
  const document = withKernelStateLock(taskDir, options.cwd, (dir) => readKernelStateDocument(dir));
  if (isPlainObject(document) && document.schemaVersion === TASK_KERNEL_SCHEMA_VERSION) {
    return {
      kind: "task-kernel-v2",
      kernel: parseTaskKernelSnapshotV2(document),
    };
  }
  return {
    kind: "legacy-task-kernel-v1",
    kernel: readKernel({ taskDir, cwd: options.cwd }),
  };
}

export function createTaskKernel(request: CreateTaskKernelRequest): TaskKernelMutationResult {
  const root = canonicalProjectRoot(request.root, request.cwd);
  const actor = requireNonEmptyString(request.actor, "actor");
  const idempotencyKey = requireNonEmptyString(request.idempotencyKey, "idempotencyKey");
  const taskDir = resolveInsideTaskRoot(root, request.taskDir, request.cwd);
  const createdAt = new Date().toISOString();
  const definition = parseDefinition({ ...request.definition, createdAt, createdBy: actor }, "definition");
  const requestFingerprint = fingerprintTaskValue({ definition: request.definition, actor });
  return withKernelStateLock(taskDir, request.cwd, (dir) => {
    const existing = readKernelStateDocument(dir);
    if (existing !== null) {
      if (!isPlainObject(existing) || existing.schemaVersion !== TASK_KERNEL_SCHEMA_VERSION) {
        throw new KernelError("INVALID_REQUEST", "legacy Kernel data exists; Task Kernel v2 will not migrate or overwrite it");
      }
      const kernel = parseTaskKernelSnapshotV2(existing);
      const prior = findIdempotent(kernel, idempotencyKey, requestFingerprint);
      if (prior) return { kernel, idempotent: true, audit: findAuditForKey(kernel, idempotencyKey), event: prior };
      throw new KernelError("INVALID_REQUEST", `kernel.json already exists for ${kernel.identity.taskId}`);
    }
    const taskJson = path.join(dir, "task.json");
    if (fs.existsSync(taskJson)) throw new KernelError("INVALID_REQUEST", "legacy task.json exists; Task Kernel v2 will not migrate or overwrite it");
    assertUniqueTaskId(root, definition.taskId, dir);
    assertDependenciesResolvable(root, definition.taskId, definition.dependencies, dir);
    assertNoDependencyCycle(root, definition.taskId, definition.dependencies, dir);
    const state = deriveStateForPhase("define");
    const audit = makeAudit(state, 0, state, 1, actor, idempotencyKey, "Task defined.");
    const event = makeEvent(1, actor, idempotencyKey, "task.created", definition.taskId, requestFingerprint);
    const kernel: TaskKernelSnapshotV2 = {
      schemaVersion: TASK_KERNEL_SCHEMA_VERSION,
      identity: { taskId: definition.taskId },
      revision: 1,
      ...state,
      definition,
      runs: [],
      reviews: [],
      closure: null,
      audit: [audit],
      events: [event],
    };
    writeKernelStateDocument(dir, kernel);
    return { kernel, idempotent: false, audit, event };
  });
}

export function listTaskKernelSnapshots(root: string): { taskDir: string; kernel: TaskKernelSnapshotV2 }[] {
  const canonicalRoot = canonicalProjectRoot(root);
  let migrationView: ReturnType<typeof readLegacyTaskMigrationView>;
  try {
    migrationView = readLegacyTaskMigrationView(canonicalRoot);
  } catch (error) {
    throw new KernelError("CORRUPT_STATE", error instanceof Error ? error.message : String(error));
  }
  const tasksRoot = path.resolve(canonicalRoot, ".pactile", "tasks");
  const output: { taskDir: string; kernel: TaskKernelSnapshotV2 }[] = [];
  const directories: string[] = [];
  if (fs.existsSync(tasksRoot)) {
    for (const entry of fs.readdirSync(tasksRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || ["archive", "locale", "templates"].includes(entry.name)) continue;
      directories.push(path.join(tasksRoot, entry.name));
    }
    const archive = path.join(tasksRoot, "archive");
    if (fs.existsSync(archive)) {
      for (const month of fs.readdirSync(archive, { withFileTypes: true })) {
        if (!month.isDirectory()) continue;
        const monthDir = path.join(archive, month.name);
        for (const entry of fs.readdirSync(monthDir, { withFileTypes: true })) {
          if (entry.isDirectory()) directories.push(path.join(monthDir, entry.name));
        }
      }
    }
  }
  directories.push(...listLegacyTaskMigrationDirectories(canonicalRoot, migrationView));
  for (const taskDir of [...new Set(directories)]) {
    try {
      const document = readTaskKernel({ root: canonicalRoot, taskDir });
      if (document?.kind === "task-kernel-v2") output.push({ taskDir, kernel: document.kernel });
    } catch (error) {
      const importRecord = readLegacyTaskImportRecord(canonicalRoot, taskDir, migrationView);
      if (importRecord?.status === "imported") throw error;
      // Non-imported and unrelated malformed Tasks remain available for explicit recovery.
    }
  }
  return output.sort((a, b) => a.taskDir.localeCompare(b.taskDir));
}

/** Refuse update retries when an active imported Task overlay has lost integrity. */
export function assertLegacyTaskKernelMigrationOverlaysIntact(root: string): void {
  const canonicalRoot = canonicalProjectRoot(root);
  const migrationView = readLegacyTaskMigrationView(canonicalRoot);
  if (!migrationView) return;
  for (const taskDir of listLegacyTaskMigrationDirectories(canonicalRoot, migrationView)) {
    const record = readLegacyTaskImportRecord(canonicalRoot, taskDir, migrationView);
    if (record?.status === "imported")
      readTaskKernel({ root: canonicalRoot, taskDir });
  }
}

function findIdempotent(kernel: TaskKernelSnapshotV2, key: string, fingerprint: string): TaskKernelEventV2 | null {
  const prior = kernel.events.find((event) => event.idempotencyKey === key);
  if (!prior) return null;
  if (prior.requestFingerprint !== fingerprint) throw new KernelError("IDEMPOTENCY_MISMATCH", `idempotency key ${key} was already used for another request`);
  return prior;
}

function findAuditForKey(kernel: TaskKernelSnapshotV2, key: string): KernelAuditEvent {
  const audit = kernel.audit.find((event) => event.idempotencyKey === key || event.idempotencyKey.startsWith(`${key}#`));
  if (!audit) throw new KernelError("CORRUPT_STATE", `idempotent event ${key} has no audit record`);
  return audit;
}

export function mutateTaskKernel(
  root: string,
  taskDir: string,
  expectedRevision: number,
  actorValue: string,
  idempotencyKeyValue: string,
  requestFingerprint: string,
  cwd: string | undefined,
  operation: (current: TaskKernelSnapshotV2, resolvedDir: string) => TaskKernelSnapshotV2,
): TaskKernelMutationResult {
  requireNonEmptyString(actorValue, "actor");
  const idempotencyKey = requireNonEmptyString(idempotencyKeyValue, "idempotencyKey");
  if (!isNonNegativeInt(expectedRevision)) throw new KernelError("INVALID_REQUEST", "expectedRevision must be a non-negative integer");
  const canonicalRoot = canonicalProjectRoot(root, cwd);
  const safeTaskDir = resolveInsideTaskRoot(canonicalRoot, taskDir, cwd);
  let migrationView: ReturnType<typeof readLegacyTaskMigrationView>;
  try {
    migrationView = readLegacyTaskMigrationView(canonicalRoot);
  } catch (error) {
    throw new KernelError("CORRUPT_STATE", error instanceof Error ? error.message : String(error));
  }
  const importRecord = readLegacyTaskImportRecord(canonicalRoot, safeTaskDir, migrationView);
  if (importRecord?.status === "needs-definition") {
    throw new KernelError(
      "LEGACY_TASK_REQUIRES_DEFINITION",
      `Task ${importRecord.legacyTaskId} needs definition fields before it can run: ${importRecord.missingDefinitionFields.join(", ")}`,
    );
  }
  if (importRecord?.status === "needs-coordination") {
    throw new KernelError(
      "LEGACY_TASK_REQUIRES_COORDINATION",
      `Task ${importRecord.legacyTaskId} has unresolved blocking legacy dependencies: ${importRecord.coordinationReasons.join(", ")}`,
    );
  }
  const overlayDir = importRecord?.status === "imported"
    ? legacyTaskMigrationOverlayPath(canonicalRoot, safeTaskDir)
    : null;
  if (importRecord?.status === "imported" && !overlayDir)
    throw new KernelError("CORRUPT_STATE", "legacy-task-migration-overlay-path-invalid");
  const stateDir = overlayDir ?? safeTaskDir;
  if (overlayDir) assertSafeMigrationOverlayDirectory(canonicalRoot, overlayDir, true);
  return withKernelStateLock(stateDir, cwd, (dir) => {
    let document: unknown | null;
    let currentBytes: Buffer | null = null;
    if (overlayDir && importRecord?.status === "imported" && migrationView) {
      currentBytes = readLegacyTaskKernelOverlay({
        root: canonicalRoot,
        taskDir: safeTaskDir,
        record: importRecord,
        view: migrationView,
        cwd,
        alreadyLocked: true,
      });
    }
    if (currentBytes) {
      try {
        document = JSON.parse(currentBytes.toString("utf8")) as unknown;
      } catch {
        throw new KernelError("CORRUPT_STATE", "legacy Task Kernel overlay JSON is invalid");
      }
    } else if (overlayDir) {
      const staged = readLegacyTaskMigrationFile(canonicalRoot, safeTaskDir, "kernel.json", migrationView);
      if (!staged) throw new KernelError("CORRUPT_STATE", "legacy-task-migration-kernel-missing");
      currentBytes = staged;
      try {
        document = JSON.parse(staged.toString("utf8")) as unknown;
      } catch {
        throw new KernelError("CORRUPT_STATE", "legacy-task-migration-kernel-invalid");
      }
    } else document = readKernelStateDocument(dir);
    const current = parseTaskKernelSnapshotV2(document);
    const prior = findIdempotent(current, idempotencyKey, requestFingerprint);
    if (prior) return { kernel: current, idempotent: true, audit: findAuditForKey(current, idempotencyKey), event: prior };
    if (expectedRevision !== current.revision) throw new KernelError("REVISION_CONFLICT", `expected revision ${expectedRevision} but kernel is at ${current.revision}`);
    const next = operation(current, safeTaskDir);
    const audit = requireArrayEntry(next.audit.at(-1), "Kernel audit event");
    const event = requireArrayEntry(next.events.at(-1), "Kernel event");
    if (overlayDir && importRecord?.status === "imported" && migrationView && currentBytes) {
      appendLegacyTaskKernelOverlayJournal({
        root: canonicalRoot,
        record: importRecord,
        view: migrationView,
        previousBytes: currentBytes,
        nextBytes: serializeKernelState(next),
      });
    }
    writeKernelStateDocument(dir, next);
    return { kernel: next, idempotent: false, audit, event };
  });
}

function assertSafeMigrationOverlayDirectory(
  projectRoot: string,
  target: string,
  createMissing: boolean,
): void {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(target);
  const relative = path.relative(root, absolute);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new KernelError(
      "INVALID_REQUEST",
      "legacy Task Kernel overlay must remain inside the project root",
    );
  }
  let cursor = root;
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component);
    try {
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new KernelError(
          "CORRUPT_STATE",
          "legacy Task Kernel overlay path is unsafe",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!createMissing) return;
      fs.mkdirSync(cursor, { mode: 0o700 });
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new KernelError(
          "CORRUPT_STATE",
          "legacy Task Kernel overlay path is unsafe",
        );
      }
    }
  }
}

function serializeKernelState(document: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
}

function migrationOverlayJournalPath(
  projectRoot: string,
  record: LegacyTaskImportRecord,
): string {
  const taskPathHash = createHash("sha256").update(record.taskPath).digest("hex");
  return path.join(
    path.resolve(projectRoot),
    ...OVERLAY_JOURNAL_DIRECTORY.split("/"),
    `${taskPathHash}.jsonl`,
  );
}

function overlayFingerprint(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function overlayIntegrityError(
  projectRoot: string,
  record: LegacyTaskImportRecord,
  journalPath: string,
  reason: string,
): KernelError {
  const relativeJournal = path.relative(projectRoot, journalPath).replaceAll(path.sep, "/");
  return new KernelError(
    "CORRUPT_STATE",
    `legacy Task Kernel overlay ${reason} for ${record.taskPath}; recovery evidence: source=${record.sourceFingerprint}, journal=${relativeJournal}`,
  );
}

function hasUniqueRegularFile(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new KernelError("CORRUPT_STATE", `legacy Task Kernel overlay file is unsafe: ${filePath}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseOverlayJournalEntries(
  projectRoot: string,
  taskDir: string,
  record: LegacyTaskImportRecord,
  view: LegacyTaskMigrationView,
  journalPath: string,
): LegacyTaskKernelOverlayJournalEntry[] | null {
  assertSafeMigrationOverlayDirectory(projectRoot, path.dirname(journalPath), false);
  if (!hasUniqueRegularFile(journalPath)) return null;
  const relativeTaskPath = path.relative(projectRoot, taskDir).replaceAll(path.sep, "/");
  if (record.taskPath !== relativeTaskPath)
    throw overlayIntegrityError(projectRoot, record, journalPath, "task-path-mismatch");
  const stagedBytes = readLegacyTaskMigrationFile(projectRoot, taskDir, "kernel.json", view);
  if (!stagedBytes)
    throw overlayIntegrityError(projectRoot, record, journalPath, "staged-kernel-missing");
  let stagedDocument: unknown;
  try {
    stagedDocument = JSON.parse(stagedBytes.toString("utf8")) as unknown;
  } catch {
    throw overlayIntegrityError(projectRoot, record, journalPath, "staged-kernel-invalid");
  }
  const stagedKernel = parseTaskKernelSnapshotV2(stagedDocument);
  let priorRevision = stagedKernel.revision;
  let priorFingerprint = overlayFingerprint(stagedBytes);
  const raw = fs.readFileSync(journalPath, "utf8");
  const lines = raw.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.some((line) => line.trim() === ""))
    throw overlayIntegrityError(projectRoot, record, journalPath, "journal-invalid");
  const entries: LegacyTaskKernelOverlayJournalEntry[] = [];
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw overlayIntegrityError(projectRoot, record, journalPath, "journal-invalid");
    }
    if (!isPlainObject(value))
      throw overlayIntegrityError(projectRoot, record, journalPath, "journal-invalid");
    const entry = value as Partial<LegacyTaskKernelOverlayJournalEntry>;
    if (
      entry.schemaVersion !== 1 ||
      entry.kind !== "legacy-task-kernel-overlay-mutation" ||
      entry.taskPath !== record.taskPath ||
      entry.taskId !== record.legacyTaskId ||
      entry.generationId !== view.authority.generationId ||
      entry.sourceFingerprint !== record.sourceFingerprint ||
      entry.previousRevision !== priorRevision ||
      typeof entry.revision !== "number" ||
      !Number.isInteger(entry.revision) ||
      entry.revision <= priorRevision ||
      entry.previousKernelFingerprint !== priorFingerprint ||
      !OVERLAY_FINGERPRINT.test(entry.previousKernelFingerprint ?? "") ||
      !OVERLAY_FINGERPRINT.test(entry.kernelFingerprint ?? "")
    ) {
      throw overlayIntegrityError(projectRoot, record, journalPath, "journal-chain-invalid");
    }
    const validEntry = entry as LegacyTaskKernelOverlayJournalEntry;
    entries.push(validEntry);
    priorRevision = validEntry.revision;
    priorFingerprint = validEntry.kernelFingerprint;
  }
  return entries;
}

function readLegacyTaskKernelOverlay(options: {
  readonly root: string;
  readonly taskDir: string;
  readonly record: LegacyTaskImportRecord;
  readonly view: LegacyTaskMigrationView;
  readonly cwd?: string;
  readonly alreadyLocked?: boolean;
}): Buffer | null {
  const root = path.resolve(options.root);
  const overlayDir = legacyTaskMigrationOverlayPath(root, options.taskDir);
  if (!overlayDir)
    throw new KernelError("CORRUPT_STATE", "legacy-task-migration-overlay-path-invalid");
  const journalPath = migrationOverlayJournalPath(root, options.record);
  const kernelPath = path.join(overlayDir, "kernel.json");
  assertSafeMigrationOverlayDirectory(root, overlayDir, false);
  const entries = parseOverlayJournalEntries(
    root,
    options.taskDir,
    options.record,
    options.view,
    journalPath,
  );
  const hasKernel = hasUniqueRegularFile(kernelPath);
  if (!entries) {
    if (hasKernel)
      throw overlayIntegrityError(root, options.record, journalPath, "journal-missing");
    return null;
  }
  const last = entries.at(-1);
  if (!last) throw overlayIntegrityError(root, options.record, journalPath, "journal-invalid");
  if (!hasKernel)
    throw overlayIntegrityError(root, options.record, journalPath, "kernel-missing");
  const read = (): Buffer => {
    assertSafeMigrationOverlayDirectory(root, overlayDir, false);
    const bytes = fs.readFileSync(kernelPath);
    if (overlayFingerprint(bytes) !== last.kernelFingerprint)
      throw overlayIntegrityError(root, options.record, journalPath, "hash-mismatch");
    let document: unknown;
    try {
      document = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw overlayIntegrityError(root, options.record, journalPath, "kernel-invalid");
    }
    const kernel = parseTaskKernelSnapshotV2(document);
    if (kernel.revision !== last.revision)
      throw overlayIntegrityError(root, options.record, journalPath, "revision-mismatch");
    return bytes;
  };
  if (options.alreadyLocked) return read();
  return withKernelStateLock(overlayDir, options.cwd, read);
}

function appendLegacyTaskKernelOverlayJournal(options: {
  readonly root: string;
  readonly record: LegacyTaskImportRecord;
  readonly view: LegacyTaskMigrationView;
  readonly previousBytes: Buffer;
  readonly nextBytes: Buffer;
}): void {
  const journalPath = migrationOverlayJournalPath(options.root, options.record);
  assertSafeMigrationOverlayDirectory(options.root, path.dirname(journalPath), true);
  if (hasUniqueRegularFile(journalPath)) {
    const raw = fs.readFileSync(journalPath, "utf8");
    const lines = raw.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    if (!lines.length) throw overlayIntegrityError(options.root, options.record, journalPath, "journal-invalid");
    const last = JSON.parse(lines.at(-1) ?? "null") as Partial<LegacyTaskKernelOverlayJournalEntry>;
    if (last.kernelFingerprint !== overlayFingerprint(options.previousBytes))
      throw overlayIntegrityError(options.root, options.record, journalPath, "journal-chain-invalid");
  } else if (fs.existsSync(journalPath)) {
    throw overlayIntegrityError(options.root, options.record, journalPath, "journal-unsafe");
  }
  let previousDocument: unknown;
  let nextDocument: unknown;
  try {
    previousDocument = JSON.parse(options.previousBytes.toString("utf8")) as unknown;
    nextDocument = JSON.parse(options.nextBytes.toString("utf8")) as unknown;
  } catch {
    throw overlayIntegrityError(options.root, options.record, journalPath, "kernel-invalid");
  }
  const previousKernel = parseTaskKernelSnapshotV2(previousDocument);
  const nextKernel = parseTaskKernelSnapshotV2(nextDocument);
  const entry: LegacyTaskKernelOverlayJournalEntry = {
    schemaVersion: 1,
    kind: "legacy-task-kernel-overlay-mutation",
    taskPath: options.record.taskPath,
    taskId: options.record.legacyTaskId,
    generationId: options.view.authority.generationId,
    sourceFingerprint: options.record.sourceFingerprint,
    previousRevision: previousKernel.revision,
    revision: nextKernel.revision,
    previousKernelFingerprint: overlayFingerprint(options.previousBytes),
    kernelFingerprint: overlayFingerprint(options.nextBytes),
  };
  if (entry.revision <= entry.previousRevision)
    throw overlayIntegrityError(options.root, options.record, journalPath, "revision-transition-invalid");
  const fd = fs.openSync(journalPath, "a");
  try {
    fs.writeSync(fd, `${JSON.stringify(entry)}\n`, undefined, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function appendMutation(
  current: TaskKernelSnapshotV2,
  actor: string,
  idempotencyKey: string,
  type: TaskKernelEventType,
  entityId: string,
  fingerprint: string,
  patch: Partial<Pick<TaskKernelSnapshotV2, "definition" | "runs" | "reviews" | "closure" | "condition" | "outcome">>,
  evidence: string,
): TaskKernelSnapshotV2 {
  const nextRevision = current.revision + 1;
  const from: KernelState & { revision: number } = { phase: current.phase, condition: current.condition, outcome: current.outcome, revision: current.revision };
  const nextState = { phase: current.phase, condition: patch.condition ?? current.condition, outcome: patch.outcome === undefined ? current.outcome : patch.outcome };
  const audit = makeAudit(from, current.revision, nextState, nextRevision, actor, idempotencyKey, evidence);
  return {
    ...current, ...patch, ...nextState, revision: nextRevision,
    audit: [...current.audit, audit],
    events: [...current.events, makeEvent(nextRevision, actor, idempotencyKey, type, entityId, fingerprint)],
  };
}

export function appendDomainEvent(
  current: TaskKernelSnapshotV2,
  actor: string,
  idempotencyKey: string,
  type: TaskKernelEventType,
  entityId: string,
  fingerprint: string,
): TaskKernelSnapshotV2 {
  return appendMutation(current, actor, idempotencyKey, type, entityId, fingerprint, {}, type);
}

export function appendPhase(
  current: TaskKernelSnapshotV2,
  target: KernelPhase,
  actor: string,
  idempotencyKey: string,
  evidence: string,
  options: { condition?: KernelCondition; outcome?: KernelOutcome | null } = {},
): TaskKernelSnapshotV2 {
  const allowed = current.phase === target ||
    (current.phase === "define" && target === "approve") ||
    (current.phase === "approve" && target === "execute") ||
    (current.phase === "define" && target === "execute") ||
    (current.phase === "verify" && target === "execute") ||
    (current.phase === "execute" && target === "verify") ||
    (current.phase === "verify" && target === "close");
  if (!allowed) throw new KernelError("INVALID_TRANSITION", `illegal Task Kernel v2 edge ${current.phase} -> ${target}`);
  const nextRevision = current.revision + 1;
  const derived = deriveStateForPhase(target);
  const to = { ...derived, condition: options.condition ?? derived.condition, outcome: options.outcome === undefined ? derived.outcome : options.outcome };
  const from = { phase: current.phase, condition: current.condition, outcome: current.outcome, revision: current.revision };
  const audit = makeAudit(from, current.revision, to, nextRevision, actor, idempotencyKey, evidence);
  return { ...current, ...to, revision: nextRevision, audit: [...current.audit, audit] };
}

export function makeAudit(
  fromState: KernelState,
  fromRevision: number,
  toState: KernelState,
  toRevision: number,
  actor: string,
  idempotencyKey: string,
  evidence: string,
): KernelAuditEvent {
  return {
    id: randomUUID(), at: new Date().toISOString(), actor, idempotencyKey, evidence,
    from: { ...fromState, revision: fromRevision }, to: { ...toState, revision: toRevision },
  };
}

export function makeEvent(
  revision: number,
  actor: string,
  idempotencyKey: string,
  type: TaskKernelEventType,
  entityId: string,
  requestFingerprint: string,
): TaskKernelEventV2 {
  return { id: randomUUID(), revision, at: new Date().toISOString(), actor, idempotencyKey, type, entityId, requestFingerprint };
}
