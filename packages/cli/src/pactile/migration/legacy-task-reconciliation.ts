/** Explicit, append-only completion of a held P36 legacy import. */

import fs from "node:fs";
import path from "node:path";

import { buildLegacyTaskV2Reconciliation, type LegacyTaskV2ReconciliationInput } from "../../core/task/legacy-task-v2-import.js";
import { scanLegacyTaskMigration, type LegacyTaskMigrationPlan } from "../../core/task/legacy-task-migration.js";
import {
  readLegacyTaskImportRecord,
  readLegacyTaskMigrationBaseView,
  readLegacyTaskMigrationView,
  type LegacyTaskImportRecord,
  type LegacyTaskMigrationFile,
  type LegacyTaskMigrationView,
} from "../../core/task/legacy-task-migration-reader.js";
import {
  LEGACY_TASK_RECONCILIATION_STORE,
  verifyLegacyTaskReconciliationGeneration,
  type LegacyTaskReconciliationAuthority,
} from "../../core/task/legacy-task-reconciliation-reader.js";
import { readTaskKernel } from "../../core/task/task-kernel.js";
import { assertLegacyTaskKernelMigrationOverlaysIntact } from "../../core/task/task-kernel-store-v2.js";
import { assertCanonicalWriteTarget } from "../runtime/paths.js";
import {
  atomicReplace,
  ensureDirectory,
  readRegularFile,
  storagePath,
  withLock,
  writeExclusive,
} from "./legacy-task-batch-io.js";
import { digest, jsonBytes } from "./legacy-task-batch-types.js";

type ReconciliationPhase = "generation-staged" | "authority-written" | "authority-committed";

export interface LegacyTaskReconciliationRequest {
  readonly projectRoot: string;
  readonly plan: LegacyTaskMigrationPlan;
  readonly input: LegacyTaskV2ReconciliationInput;
}

export interface LegacyTaskReconciliationOptions {
  readonly approved?: boolean;
  readonly dryRun?: boolean;
  readonly cancelled?: boolean;
  readonly occurredAt?: string;
  readonly onPhase?: (phase: ReconciliationPhase) => void | Promise<void>;
}

export type LegacyTaskReconciliationResult =
  | {
      readonly status: "dry-run" | "cancelled";
      readonly taskPath: string;
      readonly requestFingerprint: string;
      readonly wrote: false;
      readonly visible: false;
    }
  | {
      readonly status: "completed";
      readonly taskPath: string;
      readonly generationId: string;
      readonly requestFingerprint: string;
      readonly resumed: boolean;
      readonly wrote: boolean;
      readonly visible: true;
    }
  | {
      readonly status: "blocked" | "interrupted";
      readonly taskPath: string;
      readonly reason: string;
      readonly requestFingerprint: string | null;
      readonly wrote: boolean;
      readonly visible: false | true;
    };

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
}

interface ReconciliationJournal {
  readonly schemaVersion: 1;
  readonly kind: "legacy-task-reconciliation-journal";
  readonly generationId: string;
  readonly baseGenerationId: string;
  readonly sourceFingerprint: string;
  readonly requestFingerprint: string;
  readonly idempotencyKey: string;
  readonly expectedAuthorityFingerprint: string | null;
  readonly state: "staged" | "committing" | "committed";
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface StagedFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly fingerprint: string;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function reconciliationAuthorityPath(root: string): string {
  return storagePath(root, "reconciliations", "authority.json");
}

function generationDirectory(root: string, generationId: string): string {
  return storagePath(root, "reconciliations", "generations", generationId);
}

function journalPath(root: string, generationId: string): string {
  return storagePath(root, "reconciliations", "journals", `${generationId}.json`);
}

function canonicalTaskPath(value: string): string {
  if (
    !value ||
    value.length > 2048 ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  )
    throw new Error("legacy-task-reconciliation-task-path-invalid");
  const parts = value.split("/");
  const hasProjectPrefix = parts[0] === ".pactile" && parts[1] === "tasks";
  const taskParts = hasProjectPrefix ? parts.slice(2) : parts;
  if (
    taskParts.length === 0 ||
    taskParts.length > 32 ||
    taskParts.some((part) => part.length > 255) ||
    parts.some((part) => part === "" || part === "." || part === "..") ||
    taskParts.some((part) => part.toLowerCase() === "archive")
  ) throw new Error("legacy-task-reconciliation-task-path-invalid");
  return `.pactile/tasks/${taskParts.join("/")}`;
}

function parseJournal(bytes: Buffer): ReconciliationJournal {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("legacy-task-reconciliation-journal-invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("legacy-task-reconciliation-journal-invalid");
  const journal = value as Partial<ReconciliationJournal>;
  if (
    journal.schemaVersion !== 1 ||
    journal.kind !== "legacy-task-reconciliation-journal" ||
    typeof journal.generationId !== "string" ||
    !/^reconcile-[a-f0-9]{64}$/.test(journal.generationId) ||
    typeof journal.baseGenerationId !== "string" ||
    !/^legacy-[a-f0-9]{64}$/.test(journal.baseGenerationId) ||
    !/^sha256:[a-f0-9]{64}$/.test(journal.sourceFingerprint ?? "") ||
    !/^sha256:[a-f0-9]{64}$/.test(journal.requestFingerprint ?? "") ||
    typeof journal.idempotencyKey !== "string" ||
    !(journal.expectedAuthorityFingerprint === null || /^sha256:[a-f0-9]{64}$/.test(journal.expectedAuthorityFingerprint ?? "")) ||
    !["staged", "committing", "committed"].includes(String(journal.state)) ||
    typeof journal.createdAt !== "string" || Number.isNaN(Date.parse(journal.createdAt)) ||
    typeof journal.updatedAt !== "string" || Number.isNaN(Date.parse(journal.updatedAt))
  ) throw new Error("legacy-task-reconciliation-journal-invalid");
  return journal as ReconciliationJournal;
}

function readJournal(root: string, generationId: string): ReconciliationJournal | null {
  const bytes = readRegularFile(root, journalPath(root, generationId));
  return bytes ? parseJournal(bytes) : null;
}

function writeJournal(root: string, journal: ReconciliationJournal): void {
  const target = journalPath(root, journal.generationId);
  ensureDirectory(root, path.dirname(target));
  const lock = `${target}.lock`;
  withLock(root, lock, () => {
    const current = readRegularFile(root, target);
    let currentJournal: ReconciliationJournal | null = null;
    if (current) currentJournal = parseJournal(current);
    if (currentJournal && (
      currentJournal.generationId !== journal.generationId ||
      currentJournal.requestFingerprint !== journal.requestFingerprint ||
      currentJournal.idempotencyKey !== journal.idempotencyKey ||
      currentJournal.expectedAuthorityFingerprint !== journal.expectedAuthorityFingerprint
    )) throw new Error("legacy-task-reconciliation-journal-cas-mismatch");
    const priorRank = { staged: 1, committing: 2, committed: 3 }[currentJournal?.state ?? "staged"];
    const nextRank = { staged: 1, committing: 2, committed: 3 }[journal.state];
    if (currentJournal && nextRank < priorRank)
      throw new Error("legacy-task-reconciliation-journal-regression");
    atomicReplace(root, target, jsonBytes(journal));
  });
}

function stageGeneration(
  root: string,
  authority: LegacyTaskReconciliationAuthority,
  baseFiles: ReadonlyMap<string, LegacyTaskMigrationFile>,
  files: readonly StagedFile[],
  occurredAt: string,
  createdAt: string,
): void {
  const directory = generationDirectory(root, authority.generationId);
  ensureDirectory(root, directory);
  for (const file of files) {
    const target = assertCanonicalWriteTarget(root, path.join(directory, "files", ...file.path.split("/")));
    ensureDirectory(root, path.dirname(target));
    writeExclusive(root, target, file.bytes);
  }
  const manifest: ReconciliationManifest = {
    schemaVersion: 1,
    kind: "legacy-task-reconciliation-generation",
    baseGenerationId: authority.baseGenerationId,
    sourceFingerprint: authority.sourceFingerprint,
    generationId: authority.generationId,
    targetFingerprint: authority.targetFingerprint,
    requestFingerprint: authority.requestFingerprint,
    idempotencyKey: authority.idempotencyKey,
    expectedAuthorityFingerprint: authority.expectedAuthorityFingerprint,
    files: files.map((file) => ({ path: file.path, byteLength: file.bytes.byteLength, fingerprint: file.fingerprint })),
    createdAt,
  };
  writeExclusive(root, path.join(directory, "manifest.json"), jsonBytes(manifest));
  verifyLegacyTaskReconciliationGeneration(root, authority, baseFiles);
  const prior = readJournal(root, authority.generationId);
  if (prior?.state === "committed")
    throw new Error("legacy-task-reconciliation-recovery-requires-authority-check");
  if (prior?.state === "committing") return;
  writeJournal(root, {
    schemaVersion: 1,
    kind: "legacy-task-reconciliation-journal",
    generationId: authority.generationId,
    baseGenerationId: authority.baseGenerationId,
    sourceFingerprint: authority.sourceFingerprint,
    requestFingerprint: authority.requestFingerprint,
    idempotencyKey: authority.idempotencyKey,
    expectedAuthorityFingerprint: authority.expectedAuthorityFingerprint,
    state: "staged",
    createdAt: prior?.createdAt ?? createdAt,
    updatedAt: occurredAt,
  });
}

function setJournalState(
  root: string,
  authority: LegacyTaskReconciliationAuthority,
  state: ReconciliationJournal["state"],
  at: string,
): void {
  const prior = readJournal(root, authority.generationId);
  if (prior?.requestFingerprint !== authority.requestFingerprint)
    throw new Error("legacy-task-reconciliation-journal-missing");
  writeJournal(root, { ...prior, state, updatedAt: at });
}

function finalizeJournalAfterVisibleAuthority(
  root: string,
  authority: LegacyTaskReconciliationAuthority,
): boolean {
  const pointerPath = reconciliationAuthorityPath(root);
  return withLock(root, `${pointerPath}.lock`, () => {
    const journal = readJournal(root, authority.generationId);
    if (
      journal?.requestFingerprint !== authority.requestFingerprint ||
      journal.idempotencyKey !== authority.idempotencyKey ||
      journal.expectedAuthorityFingerprint !== authority.expectedAuthorityFingerprint
    ) throw new Error("legacy-task-reconciliation-journal-missing");
    if (journal.state === "committed") return false;
    if (journal.state !== "committing")
      throw new Error("legacy-task-reconciliation-journal-state-invalid-after-authority");
    const pointerBytes = readRegularFile(root, pointerPath);
    if (!pointerBytes || digest(pointerBytes) !== digest(jsonBytes(authority)))
      throw new Error("legacy-task-reconciliation-authority-cas-mismatch");
    setJournalState(root, authority, "committed", authority.committedAt);
    return true;
  });
}

function requestFingerprint(
  authority: LegacyTaskMigrationView["authority"],
  input: LegacyTaskV2ReconciliationInput,
): string {
  return digest(stable({
    baseGenerationId: authority.generationId,
    sourceFingerprint: authority.sourceFingerprint,
    taskPath: input.taskPath,
    idempotencyKey: input.idempotencyKey,
    activationAt: input.activationAt,
    definition: input.definition ?? {},
    dependencyResolutions: [...(input.dependencyResolutions ?? [])].map((item) => ({ reference: item.reference.trim(), taskId: item.taskId })).sort((a, b) => {
      const left = `${a.reference}\0${a.taskId}`;
      const right = `${b.reference}\0${b.taskId}`;
      return left < right ? -1 : left > right ? 1 : 0;
    }),
  }));
}

function parseReconciliationMetadata(record: LegacyTaskImportRecord): {
  idempotencyKey?: unknown;
  requestFingerprint?: unknown;
} | null {
  const value = (record as LegacyTaskImportRecord & { reconciliation?: unknown }).reconciliation;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as { idempotencyKey?: unknown; requestFingerprint?: unknown }
    : null;
}

function readBaseImportRecord(view: LegacyTaskMigrationView, taskPath: string): LegacyTaskImportRecord | null {
  const file = view.baseFiles.get(`${taskPath}/legacy-import.json`);
  if (!file) return null;
  try {
    return JSON.parse(file.bytes.toString("utf8")) as LegacyTaskImportRecord;
  } catch {
    throw new Error("legacy-task-migration-record-invalid");
  }
}

function currentReconciliationFiles(view: LegacyTaskMigrationView): StagedFile[] {
  return [...view.reconciliationFiles.values()].map((file) => ({
    path: file.path,
    bytes: Buffer.from(file.bytes),
    fingerprint: file.fingerprint,
  }));
}

function readCurrentAuthorityFingerprint(root: string): string | null {
  const bytes = readRegularFile(root, reconciliationAuthorityPath(root));
  return bytes ? digest(bytes) : null;
}

function assertOnlyRecoveryArtifacts(root: string, generationId: string): void {
  const recRoot = path.join(root, ...LEGACY_TASK_RECONCILIATION_STORE.split("/"));
  const stat = fs.lstatSync(recRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("legacy-task-reconciliation-store-invalid");
  const top = fs.readdirSync(recRoot).sort();
  if (top.length !== 2 || top.some((name) => !["generations", "journals"].includes(name)))
    throw new Error("legacy-task-reconciliation-recovery-not-safe");
  const generations = path.join(recRoot, "generations");
  const journals = path.join(recRoot, "journals");
  const directories = [generations, journals].map((directory) => {
    const childStat = fs.lstatSync(directory);
    if (!childStat.isDirectory() || childStat.isSymbolicLink())
      throw new Error("legacy-task-reconciliation-recovery-not-safe");
    return fs.readdirSync(directory).sort();
  });
  const generationNames = directories[0] ?? [];
  const journalNames = directories[1] ?? [];
  if (
    generationNames.length !== 1 || generationNames[0] !== generationId ||
    journalNames.length !== 1 || journalNames[0] !== `${generationId}.json`
  ) throw new Error("legacy-task-reconciliation-recovery-not-safe");
  const stagedGeneration = path.join(generations, generationId);
  const stagedStat = fs.lstatSync(stagedGeneration);
  if (!stagedStat.isDirectory() || stagedStat.isSymbolicLink())
    throw new Error("legacy-task-reconciliation-recovery-not-safe");
  const journalStat = fs.lstatSync(path.join(journals, `${generationId}.json`));
  if (!journalStat.isFile() || journalStat.isSymbolicLink() || journalStat.nlink !== 1)
    throw new Error("legacy-task-reconciliation-recovery-not-safe");
}

function reconcileResultFromActive(
  root: string,
  taskPath: string,
  generationId: string,
  fingerprint: string,
  idempotencyKey: string,
  resumed: boolean,
): LegacyTaskReconciliationResult {
  const taskDir = path.join(root, ...taskPath.split("/"));
  const record = readLegacyTaskImportRecord(root, taskDir);
  const metadata = record ? parseReconciliationMetadata(record) : null;
  if (
    record?.status !== "imported" ||
    metadata?.idempotencyKey !== idempotencyKey ||
    metadata.requestFingerprint !== fingerprint
  ) return {
    status: "blocked",
    taskPath,
    reason: "legacy-task-reconciliation-already-applied-differently",
    requestFingerprint: fingerprint,
    wrote: false,
    visible: true,
  };
  const read = readTaskKernel({ root, taskDir, cwd: root });
  if (read.kind !== "task-kernel-v2") throw new Error("legacy-task-reconciliation-kernel-unavailable");
  return {
    status: "completed",
    taskPath,
    generationId,
    requestFingerprint: fingerprint,
    resumed,
    wrote: false,
    visible: true,
  };
}

/**
 * Activate exactly one previously held legacy Task through an immutable
 * secondary generation and pointer. The original P36 authority and overlays
 * remain byte-for-byte unchanged.
 */
export async function runLegacyTaskReconciliation(
  request: LegacyTaskReconciliationRequest,
  options: LegacyTaskReconciliationOptions = {},
): Promise<LegacyTaskReconciliationResult> {
  const root = path.resolve(request.projectRoot);
  let taskPath = request.input.taskPath;
  let input: LegacyTaskV2ReconciliationInput = request.input;
  let wrote = false;
  let visible = false;
  let committedHere = false;
  let fingerprint: string | null = null;
  try {
    taskPath = canonicalTaskPath(taskPath);
    input = { ...request.input, taskPath };
    if (
      !path.isAbsolute(request.projectRoot) ||
      path.resolve(request.plan.projectRoot) !== root ||
      request.plan.readOnly !== true ||
      request.plan.wrote !== false ||
      request.plan.preflight.status !== "clear-to-review" ||
      !request.plan.sourceFingerprint ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.idempotencyKey) ||
      Number.isNaN(Date.parse(input.activationAt))
    ) throw new Error("legacy-task-reconciliation-preflight-blocked");
    const baseView = readLegacyTaskMigrationBaseView(root);
    if (!baseView) throw new Error("legacy-task-migration-authority-missing");
    if (request.plan.sourceFingerprint !== baseView.authority.sourceFingerprint)
      throw new Error("legacy-task-reconciliation-source-fingerprint-mismatch");
    const currentScan = scanLegacyTaskMigration({ projectRoot: root });
    if (
      currentScan.preflight.status !== "clear-to-review" ||
      currentScan.sourceFingerprint !== baseView.authority.sourceFingerprint
    ) throw new Error("legacy-task-reconciliation-source-drift");

    fingerprint = requestFingerprint(baseView.authority, input);
    const taskDir = path.join(root, ...taskPath.split("/"));
    let currentView: LegacyTaskMigrationView | null = null;
    let orphanRecovery = false;
    let currentViewError: unknown = null;
    try {
      currentView = readLegacyTaskMigrationView(root);
    } catch (error) {
      currentViewError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (message !== "legacy-task-reconciliation-authority-missing-with-residual-state") throw error;
      orphanRecovery = true;
    }
    let finalizedPriorJournal = false;
    if (
      currentView?.reconciliationAuthority &&
      options.approved === true &&
      options.dryRun !== true &&
      options.cancelled !== true
    ) finalizedPriorJournal = finalizeJournalAfterVisibleAuthority(root, currentView.reconciliationAuthority);
    const effectiveRecordBytes = currentView?.files.get(`${taskPath}/legacy-import.json`)?.bytes ??
      baseView.baseFiles.get(`${taskPath}/legacy-import.json`)?.bytes;
    const activeImport = effectiveRecordBytes
      ? JSON.parse(effectiveRecordBytes.toString("utf8")) as LegacyTaskImportRecord
      : null;
    const activeMetadata = activeImport ? parseReconciliationMetadata(activeImport) : null;
    if (activeImport?.status === "imported") {
      visible = true;
      if (activeMetadata?.idempotencyKey === input.idempotencyKey && activeMetadata.requestFingerprint === fingerprint) {
        if (!currentView?.reconciliationAuthority)
          throw new Error("legacy-task-reconciliation-authority-invalid");
        const result = reconcileResultFromActive(root, taskPath, currentView.reconciliationAuthority.generationId, fingerprint, input.idempotencyKey, true);
        return finalizedPriorJournal && result.status === "completed" ? { ...result, wrote: true } : result;
      }
      throw new Error("legacy-task-reconciliation-task-already-active");
    }
    const baseRecord = readBaseImportRecord(baseView, taskPath);
    if (
      baseRecord?.taskPath !== taskPath ||
      baseRecord.sourceFingerprint !== baseView.authority.sourceFingerprint ||
      (baseRecord.status !== "needs-definition" && baseRecord.status !== "needs-coordination")
    )
      throw new Error("legacy-task-reconciliation-task-not-held");

    const buildInput: LegacyTaskV2ReconciliationInput = { ...input, requestFingerprint: fingerprint };
    const built = buildLegacyTaskV2Reconciliation(currentScan, buildInput);
    const effectiveView = currentView;
    const expectedAuthorityFingerprint = orphanRecovery ? null : readCurrentAuthorityFingerprint(root);
    const previousGenerationId = effectiveView?.reconciliationAuthority?.generationId ?? null;
    if (effectiveView?.reconciliationAuthority && expectedAuthorityFingerprint === null)
      throw new Error("legacy-task-reconciliation-authority-missing-after-commit");
    const filesByPath = new Map<string, StagedFile>();
    if (effectiveView) {
      for (const file of currentReconciliationFiles(effectiveView)) filesByPath.set(file.path, file);
    }
    for (const target of built.targets) {
      const file: StagedFile = { path: target.path, bytes: Buffer.from(target.bytes), fingerprint: digest(target.bytes) };
      filesByPath.set(file.path, file);
    }
    const stagedFiles = [...filesByPath.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const targetFacts = stagedFiles.map((file) => ({ path: file.path, byteLength: file.bytes.byteLength, fingerprint: file.fingerprint }));
    const targetFingerprint = digest(jsonBytes(targetFacts));
    const generationId = `reconcile-${digest(stable({ fingerprint, expectedAuthorityFingerprint, previousGenerationId })).slice("sha256:".length)}`;
    const occurredAt = options.occurredAt ?? input.activationAt;
    if (Number.isNaN(Date.parse(occurredAt))) throw new Error("legacy-task-reconciliation-time-invalid");
    const authority: LegacyTaskReconciliationAuthority = {
      schemaVersion: 1,
      kind: "legacy-task-reconciliation-authority",
      baseGenerationId: baseView.authority.generationId,
      sourceFingerprint: baseView.authority.sourceFingerprint,
      generationId,
      targetFingerprint,
      requestFingerprint: fingerprint,
      idempotencyKey: input.idempotencyKey,
      expectedAuthorityFingerprint,
      committedAt: occurredAt,
    };

    if (orphanRecovery) {
      if (expectedAuthorityFingerprint !== null || currentViewError === null)
        throw new Error("legacy-task-reconciliation-recovery-not-safe");
      const journal = readJournal(root, generationId);
      if (
        journal?.state !== "staged" ||
        journal.expectedAuthorityFingerprint !== null ||
        journal.requestFingerprint !== fingerprint ||
        journal.idempotencyKey !== input.idempotencyKey
      ) throw new Error("legacy-task-reconciliation-recovery-not-safe");
      assertOnlyRecoveryArtifacts(root, generationId);
    }

    if (options.dryRun) return { status: "dry-run", taskPath, requestFingerprint: fingerprint, wrote: false, visible: false };
    if (options.cancelled || options.approved !== true)
      return { status: "cancelled", taskPath, requestFingerprint: fingerprint, wrote: false, visible: false };

    if (!orphanRecovery) assertLegacyTaskKernelMigrationOverlaysIntact(root);
    const occurred = occurredAt;
    stageGeneration(root, authority, baseView.baseFiles, stagedFiles, occurred, occurred);
    wrote = true;
    await options.onPhase?.("generation-staged");

    const pointerPath = reconciliationAuthorityPath(root);
    const lockPath = `${pointerPath}.lock`;
    withLock(root, lockPath, () => {
      const currentBytes = readRegularFile(root, pointerPath);
      const currentFingerprint = currentBytes ? digest(currentBytes) : null;
      if (currentFingerprint !== expectedAuthorityFingerprint)
        throw new Error("legacy-task-reconciliation-authority-cas-mismatch");
      if (currentBytes && expectedAuthorityFingerprint === null)
        throw new Error("legacy-task-reconciliation-authority-cas-mismatch");
      const currentBase = readLegacyTaskMigrationBaseView(root);
      const finalScan = scanLegacyTaskMigration({ projectRoot: root });
      if (
        currentBase?.authority.generationId !== baseView.authority.generationId ||
        currentBase.authority.sourceFingerprint !== baseView.authority.sourceFingerprint ||
        finalScan.preflight.status !== "clear-to-review" ||
        finalScan.sourceFingerprint !== baseView.authority.sourceFingerprint
      ) throw new Error("legacy-task-reconciliation-source-drift");
      verifyLegacyTaskReconciliationGeneration(root, authority, baseView.baseFiles);
      setJournalState(root, authority, "committing", occurred);
      atomicReplace(root, pointerPath, jsonBytes(authority));
      visible = true;
      committedHere = true;
    });
    await options.onPhase?.("authority-written");
    finalizeJournalAfterVisibleAuthority(root, authority);
    await options.onPhase?.("authority-committed");
    assertLegacyTaskKernelMigrationOverlaysIntact(root);
    const read = readTaskKernel({ root, taskDir, cwd: root });
    if (read.kind !== "task-kernel-v2") throw new Error("legacy-task-reconciliation-kernel-unavailable");
    return { status: "completed", taskPath, generationId, requestFingerprint: fingerprint, resumed: orphanRecovery, wrote, visible: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: committedHere ? "interrupted" : "blocked",
      taskPath,
      reason,
      requestFingerprint: fingerprint,
      wrote,
      visible,
    };
  }
}
