import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  canonicalizePactileJsonV1,
  fingerprintPactileContractV1,
  parseMigrationJournalV1,
  parseMigrationPlanV1,
  parseProjectionPlanV1,
  type InstallStateV1,
  type MigrationJournalEventV1,
  type MigrationJournalV1,
  type MigrationPlanV1,
  type OwnershipLedgerV1,
} from "../../core/index.js";
import {
  runMigrationTransaction,
  type MigrationFileClassification,
  type MigrationTransactionRequest,
  type MigrationValidationContext,
} from "../migration/transaction.js";
import {
  MAX_PROJECTION_BYTES,
  type ProjectionInputs,
  type ProjectionPreview,
} from "../projection/planner.js";
import {
  ProjectionStore,
  type ProjectionStoreOptions,
} from "../projection/store.js";
import {
  GenerationStore,
  InstallStateStore,
  type GenerationFile,
  type GenerationSeal,
  type InstallStateSnapshot,
} from "../runtime/stores.js";
import {
  assertCanonicalWriteTarget,
  normalizeRuntimeRelativePath,
  resolveCanonicalPaths,
} from "../runtime/paths.js";

const LOGICAL_ID = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface LifecycleGenerationFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface LifecycleLegacyFile extends LifecycleGenerationFile {
  readonly sourceRef: string;
  readonly classification: MigrationFileClassification;
  readonly sourceBytes: Uint8Array;
  readonly expectedSourceFingerprint: string;
}

export type LifecycleSource =
  | {
      readonly kind: "fresh";
      readonly files: readonly LifecycleGenerationFile[];
    }
  | {
      readonly kind: "canonical";
      readonly generationId: string;
      readonly runtimeVersion: string;
      readonly schemaVersion: 1;
      readonly files: readonly LifecycleGenerationFile[];
    }
  | {
      readonly kind: "legacy";
      /** Batch 3 only wires the owned cstl importer. Trellis stays explicit. */
      readonly root: ".cstl";
      readonly runtimeVersion: string | null;
      readonly schemaVersion: number | null;
      readonly files: readonly LifecycleLegacyFile[];
    };

export interface LifecycleProjectionContext {
  readonly generationId: string;
  readonly canonicalFingerprint: string;
  readonly ledger: OwnershipLedgerV1 | null;
  readonly ledgerFingerprint: string | null;
  readonly occurredAt: string;
}

export interface LifecycleAdapter {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly projectionPlanId: string;
  /** Called only after the canonical generation has been committed. */
  readonly buildProjection: (
    context: LifecycleProjectionContext,
  ) => ProjectionInputs | Promise<ProjectionInputs>;
}

export interface LifecycleRequest {
  readonly projectRoot: string;
  readonly id: string;
  readonly generationId: string;
  readonly runtimeVersion: string;
  readonly expectedInstallStateFingerprint: string | null;
  readonly occurredAt: string;
  readonly source: LifecycleSource;
  readonly adapters: readonly LifecycleAdapter[];
  /** Idempotent canonical live-view materialization after generation commit. */
  readonly materializeCanonical?: (
    context: LifecycleMaterializationContext,
  ) => void | Promise<void>;
}

export interface LifecycleValidationContext {
  readonly generationId: string;
  readonly files: readonly GenerationFile[];
  readonly readFile: (relativePath: string) => Uint8Array;
  /** Read several sealed files after one generation-inventory verification. */
  readonly readFiles?: (
    relativePaths: readonly string[],
  ) => ReadonlyMap<string, Uint8Array>;
}

export type LifecycleMaterializationContext = LifecycleValidationContext;

export interface LifecycleOrchestratorOptions {
  readonly validateGeneration?: (
    context: LifecycleValidationContext,
  ) => boolean | Promise<boolean>;
  readonly projectionStore?: (
    projectRoot: string,
    adapterId: string,
  ) => ProjectionStore;
  readonly migrationRunner?: typeof runMigrationTransaction;
  /** In-memory fault seam. It receives no paths, bytes, or credentials. */
  readonly fault?: (
    phase:
      | "after-stage"
      | "before-canonical-commit"
      | "after-canonical-commit"
      | "before-adapter"
      | "after-adapter",
    adapterId?: string,
  ) => void;
}

export interface LifecycleAdapterResult {
  readonly adapterId: string;
  readonly status: "succeeded" | "failed" | "pending";
  readonly attempts: number;
  readonly reason: string | null;
  readonly retryable: boolean;
  readonly projectionFingerprint: string | null;
}

export type LifecycleResult =
  | {
      readonly status: "completed" | "degraded";
      readonly resumed: boolean;
      readonly reason: null;
      readonly plan: MigrationPlanV1;
      readonly planFingerprint: string;
      readonly generationFingerprint: string;
      readonly journal: MigrationJournalV1;
      readonly installState: InstallStateSnapshot;
      readonly adapters: readonly LifecycleAdapterResult[];
    }
  | {
      readonly status: "review" | "interrupted";
      readonly resumed: boolean;
      readonly reason:
        | "invalid-lifecycle-request"
        | "lifecycle-plan-conflict"
        | "lifecycle-journal-unavailable"
        | "generation-validation-failed"
        | "canonical-commit-not-completed";
      readonly plan: MigrationPlanV1 | null;
      readonly planFingerprint: string | null;
      readonly generationFingerprint: string | null;
      readonly journal: MigrationJournalV1 | null;
      readonly installState: InstallStateSnapshot | null;
      readonly adapters: readonly LifecycleAdapterResult[];
    };

interface NormalizedGenerationFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly fingerprint: string;
}

interface NormalizedLegacyFile extends NormalizedGenerationFile {
  readonly sourceRef: string;
  readonly classification: MigrationFileClassification;
  readonly sourceBytes: Buffer;
  readonly expectedSourceFingerprint: string;
}

type NormalizedSource =
  | {
      readonly kind: "fresh";
      readonly files: readonly NormalizedGenerationFile[];
    }
  | {
      readonly kind: "canonical";
      readonly generationId: string;
      readonly runtimeVersion: string;
      readonly schemaVersion: 1;
      readonly files: readonly NormalizedGenerationFile[];
    }
  | {
      readonly kind: "legacy";
      readonly root: ".cstl";
      readonly runtimeVersion: string | null;
      readonly schemaVersion: number | null;
      readonly files: readonly NormalizedLegacyFile[];
    };

interface NormalizedRequest extends Omit<
  LifecycleRequest,
  "source" | "adapters"
> {
  readonly source: NormalizedSource;
  readonly adapters: readonly LifecycleAdapter[];
}

interface JournalSnapshot {
  readonly journal: MigrationJournalV1;
  readonly fingerprint: string;
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function normalizeGenerationFiles(
  files: readonly LifecycleGenerationFile[],
): readonly NormalizedGenerationFile[] | null {
  try {
    if (files.length === 0) return null;
    const normalized = files
      .map((file) => {
        const bytes = Buffer.from(file.bytes);
        return {
          path: normalizeRuntimeRelativePath(file.path),
          bytes,
          fingerprint: digest(bytes),
        };
      })
      .sort((left, right) => lexical(left.path, right.path));
    if (
      normalized.some((file) => file.bytes.byteLength > MAX_PROJECTION_BYTES) ||
      new Set(
        normalized.map((file) => file.path.normalize("NFC").toLowerCase()),
      ).size !== normalized.length
    )
      return null;
    return normalized;
  } catch {
    return null;
  }
}

function normalizeRequest(request: LifecycleRequest): NormalizedRequest | null {
  try {
    if (
      !path.isAbsolute(request.projectRoot) ||
      !fs.statSync(request.projectRoot).isDirectory() ||
      !LOGICAL_ID.test(request.id) ||
      !LOGICAL_ID.test(request.generationId) ||
      !SEMVER.test(request.runtimeVersion) ||
      (request.expectedInstallStateFingerprint !== null &&
        !FINGERPRINT.test(request.expectedInstallStateFingerprint)) ||
      Number.isNaN(Date.parse(request.occurredAt))
    )
      return null;

    const adapters = [...request.adapters].sort((left, right) =>
      lexical(left.adapterId, right.adapterId),
    );
    if (
      new Set(adapters.map((adapter) => adapter.adapterId)).size !==
        adapters.length ||
      new Set(adapters.map((adapter) => adapter.projectionPlanId)).size !==
        adapters.length ||
      adapters.some(
        (adapter) =>
          !LOGICAL_ID.test(adapter.adapterId) ||
          !LOGICAL_ID.test(adapter.projectionPlanId) ||
          !SEMVER.test(adapter.adapterVersion) ||
          typeof adapter.buildProjection !== "function",
      )
    )
      return null;

    let source: NormalizedSource;
    if (request.source.kind === "fresh") {
      const files = normalizeGenerationFiles(request.source.files);
      if (!files) return null;
      source = { kind: "fresh", files };
    } else if (request.source.kind === "canonical") {
      const files = normalizeGenerationFiles(request.source.files);
      if (
        !files ||
        !LOGICAL_ID.test(request.source.generationId) ||
        !SEMVER.test(request.source.runtimeVersion) ||
        request.source.schemaVersion !== 1
      )
        return null;
      source = { ...request.source, files };
    } else {
      const files = normalizeGenerationFiles(request.source.files);
      if (
        request.source.root !== ".cstl" ||
        (request.source.runtimeVersion !== null &&
          !SEMVER.test(request.source.runtimeVersion)) ||
        (request.source.schemaVersion !== null &&
          (!Number.isInteger(request.source.schemaVersion) ||
            request.source.schemaVersion < 0)) ||
        !files
      )
        return null;
      const byPath = new Map(files.map((file) => [file.path, file]));
      const legacyFiles = request.source.files
        .map((file): NormalizedLegacyFile | null => {
          const targetPath = normalizeRuntimeRelativePath(file.path);
          const target = byPath.get(targetPath);
          const sourceBytes = Buffer.from(file.sourceBytes);
          if (
            !target ||
            !file.sourceRef ||
            file.sourceRef.length > 512 ||
            /[\0\r\n]/.test(file.sourceRef) ||
            !["active", "closed", "generated"].includes(file.classification) ||
            !FINGERPRINT.test(file.expectedSourceFingerprint) ||
            sourceBytes.byteLength > MAX_PROJECTION_BYTES ||
            digest(sourceBytes) !== file.expectedSourceFingerprint ||
            (file.classification === "closed" &&
              !sourceBytes.equals(target.bytes))
          )
            return null;
          return {
            ...target,
            sourceRef: file.sourceRef,
            classification: file.classification,
            sourceBytes,
            expectedSourceFingerprint: file.expectedSourceFingerprint,
          };
        })
        .sort((left, right) =>
          left && right ? lexical(left.path, right.path) : left ? -1 : 1,
        );
      if (
        legacyFiles.some((file) => file === null) ||
        new Set(
          legacyFiles.map((file) => (file as NormalizedLegacyFile).sourceRef),
        ).size !== legacyFiles.length
      )
        return null;
      source = {
        ...request.source,
        files: legacyFiles as readonly NormalizedLegacyFile[],
      };
    }
    return { ...request, source, adapters };
  } catch {
    return null;
  }
}

function generationFiles(
  input: NormalizedRequest,
): readonly NormalizedGenerationFile[] {
  return input.source.files;
}

function sourceReference(
  source: NormalizedSource,
  file: NormalizedGenerationFile,
): string {
  // Two canonical targets may intentionally contain identical bytes (for
  // example, per-package spec seeds in a monorepo). Migration preservation
  // references are unique contract keys, so bind the byte fingerprint to the
  // target identity without exposing the relative path itself.
  if (source.kind === "fresh")
    return `content://${digest(
      Buffer.from(`${file.path}\0${file.fingerprint}`, "utf8"),
    )}`;
  if (source.kind === "canonical")
    return `generation://${source.generationId}/${file.path}#${file.fingerprint}`;
  const legacy = source.files.find((candidate) => candidate.path === file.path);
  if (!legacy) throw new Error("legacy-file-mismatch");
  return `${legacy.sourceRef}#${legacy.expectedSourceFingerprint}->${file.fingerprint}`;
}

function buildPlan(input: NormalizedRequest): {
  readonly plan: MigrationPlanV1;
  readonly fingerprint: string;
} | null {
  const detectId = `${input.id}.detect`;
  const backupId = `${input.id}.backup`;
  const validateId = `${input.id}.validate`;
  const commitId = `${input.id}.commit`;
  const doctorId = `${input.id}.doctor`;
  const files = generationFiles(input);
  const reconcileActions = input.adapters.map((adapter, index) => ({
    id: `${input.id}.reconcile.${index + 1}`,
    phase: "reconcile" as const,
    kind: "reconcile-projection" as const,
    domain: "projection" as const,
    sourceRef: `projection://${adapter.projectionPlanId}`,
    targetRef: `adapter://${adapter.adapterId}`,
    adapterId: adapter.adapterId,
    reversible: true,
  }));
  const source =
    input.source.kind === "fresh"
      ? {
          kind: "fresh" as const,
          root: null,
          access: "none" as const,
          runtimeVersion: null,
          schemaVersion: null,
        }
      : input.source.kind === "canonical"
        ? {
            kind: "canonical" as const,
            root: ".pactile" as const,
            access: "read-write" as const,
            runtimeVersion: input.source.runtimeVersion,
            schemaVersion: input.source.schemaVersion,
          }
        : {
            kind: "legacy" as const,
            root: input.source.root,
            access: "read-only" as const,
            runtimeVersion: input.source.runtimeVersion,
            schemaVersion: input.source.schemaVersion,
          };
  const preservation =
    input.source.kind === "legacy"
      ? {
          bytePreservedRefs: input.source.files
            .filter((file) => file.classification === "closed")
            .map((file) => file.sourceRef),
          transformedRefs: input.source.files
            .filter((file) => file.classification !== "closed")
            .map((file) => file.sourceRef),
        }
      : {
          bytePreservedRefs: [],
          transformedRefs: files.map((file) =>
            sourceReference(input.source, file),
          ),
        };
  const candidate = {
    schemaVersion: 1,
    id: input.id,
    source,
    target: {
      root: ".pactile",
      runtimeVersion: input.runtimeVersion,
      schemaVersion: 1,
      generationId: input.generationId,
    },
    actions: [
      {
        id: detectId,
        phase: "detect",
        kind: "capture-facts",
        domain: "canonical",
        sourceRef:
          input.source.kind === "fresh"
            ? null
            : input.source.kind === "canonical"
              ? `generation://${input.source.generationId}`
              : "legacy://cstl",
        targetRef: null,
        adapterId: null,
        reversible: true,
      },
      {
        id: backupId,
        phase: "backup",
        kind: "snapshot",
        domain: "canonical",
        sourceRef:
          input.source.kind === "fresh"
            ? null
            : input.source.kind === "canonical"
              ? `generation://${input.source.generationId}`
              : "legacy://cstl",
        targetRef:
          input.source.kind === "fresh"
            ? "backup://not-required"
            : input.source.kind === "canonical"
              ? `generation://${input.source.generationId}`
              : `migration://${input.id}.canonical`,
        adapterId: null,
        reversible: true,
      },
      ...files.map((file, index) => ({
        id: `${input.id}.stage.${index + 1}`,
        phase: "stage" as const,
        kind:
          input.source.kind === "legacy"
            ? input.source.files[index]?.classification === "closed"
              ? ("copy-byte-preserved" as const)
              : input.source.files[index]?.classification === "generated"
                ? ("write-generation" as const)
                : ("transform-schema" as const)
            : ("write-generation" as const),
        domain: "canonical" as const,
        sourceRef: sourceReference(input.source, file),
        targetRef: `generation://${input.generationId}/${file.path}`,
        adapterId: null,
        reversible: true,
      })),
      {
        id: validateId,
        phase: "validate",
        kind: "validate-generation",
        domain: "canonical",
        sourceRef: `generation://${input.generationId}`,
        targetRef: null,
        adapterId: null,
        reversible: true,
      },
      {
        id: commitId,
        phase: "commit",
        kind: "activate-generation",
        domain: "canonical",
        sourceRef: `generation://${input.generationId}`,
        targetRef: "install-state://active",
        adapterId: null,
        reversible: true,
      },
      ...reconcileActions,
      {
        id: doctorId,
        phase: "doctor",
        kind: "doctor",
        domain: "canonical",
        sourceRef: `generation://${input.generationId}`,
        targetRef: null,
        adapterId: null,
        reversible: true,
      },
    ],
    canonicalCommitPointActionId: commitId,
    preservation,
    recovery: {
      backupRef:
        input.source.kind === "fresh"
          ? "backup://not-required"
          : input.source.kind === "canonical"
            ? `generation://${input.source.generationId}`
            : `migration://${input.id}.canonical`,
      preserveNewerData: true,
    },
    projectionPlanIds: input.adapters.map(
      (adapter) => adapter.projectionPlanId,
    ),
  };
  const parsed = parseMigrationPlanV1(candidate);
  return parsed.success
    ? { plan: parsed.data, fingerprint: parsed.fingerprint }
    : null;
}

class LifecycleJournalStore {
  private readonly directory: string;

  constructor(private readonly projectRoot: string) {
    this.directory = resolveCanonicalPaths(projectRoot).migrationJournalsPath;
  }

  private target(id: string): string {
    if (!LOGICAL_ID.test(id)) throw new Error("invalid-lifecycle-journal-id");
    return assertCanonicalWriteTarget(
      this.projectRoot,
      path.join(this.directory, `${id}.json`),
    );
  }

  read(id: string): JournalSnapshot | null {
    try {
      const value: unknown = JSON.parse(
        fs.readFileSync(this.target(id), "utf8"),
      );
      const parsed = parseMigrationJournalV1(value);
      if (!parsed.success) throw new Error("invalid-lifecycle-journal");
      return { journal: parsed.data, fingerprint: parsed.fingerprint };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw new Error("lifecycle-journal-unavailable");
    }
  }

  write(
    id: string,
    expectedFingerprint: string | null,
    journal: MigrationJournalV1,
  ): JournalSnapshot {
    const parsed = parseMigrationJournalV1(journal);
    if (!parsed.success) throw new Error("invalid-lifecycle-journal");
    fs.mkdirSync(assertCanonicalWriteTarget(this.projectRoot, this.directory), {
      recursive: true,
    });
    const target = this.target(id);
    const lock = assertCanonicalWriteTarget(this.projectRoot, `${target}.lock`);
    const temporary = assertCanonicalWriteTarget(
      this.projectRoot,
      `${target}.tmp-${randomUUID()}`,
    );
    let descriptor: number | null = null;
    let ownedLock: { readonly dev: number; readonly ino: number } | null = null;
    try {
      descriptor = fs.openSync(lock, "wx", 0o600);
      const opened = fs.fstatSync(descriptor);
      ownedLock = { dev: opened.dev, ino: opened.ino };
      const current = this.read(id);
      if ((current?.fingerprint ?? null) !== expectedFingerprint)
        throw new Error("lifecycle-journal-cas-mismatch");
      fs.writeFileSync(temporary, canonicalizePactileJsonV1(parsed.data), {
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(temporary, target);
      return { journal: parsed.data, fingerprint: parsed.fingerprint };
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
      if (ownedLock) {
        try {
          const visible = fs.lstatSync(lock);
          if (
            visible.isFile() &&
            !visible.isSymbolicLink() &&
            visible.nlink === 1 &&
            visible.dev === ownedLock.dev &&
            visible.ino === ownedLock.ino
          )
            fs.unlinkSync(lock);
        } catch {
          /* A stale or replaced lock stays diagnosable. */
        }
      }
      try {
        fs.unlinkSync(temporary);
      } catch {
        /* A successful rename consumes the temporary file. */
      }
    }
  }
}

function journalEvent(
  journal: MigrationJournalV1,
  at: string,
  event: MigrationJournalEventV1["event"],
  actionId: string,
  evidenceRefs: readonly string[],
  adapterId: string | null = null,
): MigrationJournalEventV1 {
  return {
    sequence: journal.events.length + 1,
    at,
    event,
    actionId,
    adapterId,
    evidenceRefs,
  };
}

function initialJournal(
  input: NormalizedRequest,
  plan: MigrationPlanV1,
  planFingerprint: string,
): MigrationJournalV1 {
  return {
    schemaVersion: 1,
    id: input.id,
    planId: plan.id,
    planFingerprint,
    state: "planned",
    canonicalCommit: {
      status: "pending",
      actionId: plan.canonicalCommitPointActionId,
      generationId: null,
      committedAt: null,
    },
    recovery: {
      status: input.source.kind === "fresh" ? "not-required" : "available",
      backupRef: plan.recovery.backupRef,
      updatedAt: input.occurredAt,
      error: null,
    },
    adapterReconciliations: input.adapters.map((adapter) => ({
      adapterId: adapter.adapterId,
      projectionPlanId: adapter.projectionPlanId,
      status: "pending",
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
    })),
    events: [
      {
        sequence: 1,
        at: input.occurredAt,
        event: "planned",
        actionId: `${input.id}.detect`,
        adapterId: null,
        evidenceRefs: [planFingerprint],
      },
    ],
  };
}

function updateJournal(
  snapshot: JournalSnapshot,
  store: LifecycleJournalStore,
  id: string,
  patch: Partial<MigrationJournalV1>,
): JournalSnapshot {
  return store.write(id, snapshot.fingerprint, {
    ...snapshot.journal,
    ...patch,
  });
}

function sealMatches(
  seal: GenerationSeal,
  files: readonly NormalizedGenerationFile[],
): boolean {
  return (
    canonicalizePactileJsonV1(seal.files) ===
    canonicalizePactileJsonV1(
      files.map((file) => ({ path: file.path, fingerprint: file.fingerprint })),
    )
  );
}

function ensureGeneration(
  generations: GenerationStore,
  input: NormalizedRequest,
): GenerationSeal {
  const files = generationFiles(input);
  try {
    const existing = generations.verify(input.generationId);
    if (!sealMatches(existing, files)) throw new Error("generation-conflict");
    return existing;
  } catch {
    generations.stage(input.generationId);
  }
  const written = files.map((file) =>
    generations.writeFile(input.generationId, file.path, file.bytes),
  );
  const seal = generations.seal(input.generationId, written);
  if (!sealMatches(seal, files)) throw new Error("generation-conflict");
  return seal;
}

async function validateGeneration(
  generations: GenerationStore,
  input: NormalizedRequest,
  options: LifecycleOrchestratorOptions,
): Promise<boolean> {
  const files = generationFiles(input);
  const seal = generations.verify(input.generationId);
  if (!sealMatches(seal, files)) return false;
  const verifiedFiles = generations.readFiles(
    input.generationId,
    files.map((file) => file.path),
  );
  for (const file of files) {
    const actual = verifiedFiles.get(file.path);
    if (!actual?.equals(file.bytes)) return false;
  }
  return options.validateGeneration
    ? options.validateGeneration({
        generationId: input.generationId,
        files: seal.files,
        readFile: (relativePath) =>
          generations.readFile(input.generationId, relativePath),
      })
    : true;
}

function pendingInstallState(
  input: NormalizedRequest,
  current: InstallStateSnapshot | null,
): InstallStateV1 {
  const adapters = new Map(
    (current?.state.installedAdapters ?? []).map((adapter) => [
      adapter.id,
      adapter,
    ]),
  );
  for (const adapter of input.adapters) {
    const previous = adapters.get(adapter.adapterId);
    adapters.set(adapter.adapterId, {
      id: adapter.adapterId,
      version: adapter.adapterVersion,
      status: "degraded",
      lastProjectionFingerprint: previous?.lastProjectionFingerprint ?? null,
      reconciledAt: previous?.reconciledAt ?? null,
    });
  }
  const installedAdapters = [...adapters.values()].sort((left, right) =>
    lexical(left.id, right.id),
  );
  return {
    schemaVersion: 1,
    product: "pactile",
    canonicalRoot: ".pactile",
    runtimeVersion: input.runtimeVersion,
    contractVersion: 1,
    generationId: input.generationId,
    status: installedAdapters.some((adapter) => adapter.status === "degraded")
      ? "degraded"
      : "active",
    installedAdapters,
    lastMigrationJournalId: input.id,
    createdAt: current?.state.createdAt ?? input.occurredAt,
    updatedAt: input.occurredAt,
  };
}

function canonicalAlreadyCommitted(
  current: InstallStateSnapshot | null,
  input: NormalizedRequest,
): boolean {
  return (
    current?.state.generationId === input.generationId &&
    current.state.lastMigrationJournalId === input.id
  );
}

function commitInstallState(
  installs: InstallStateStore,
  input: NormalizedRequest,
): InstallStateSnapshot {
  const current = installs.read();
  if (canonicalAlreadyCommitted(current, input))
    return current as InstallStateSnapshot;

  if (input.source.kind === "fresh") {
    if (current !== null) throw new Error("unexpected-existing-install-state");
  } else if (input.source.kind === "canonical") {
    if (current?.state.generationId !== input.source.generationId)
      throw new Error("canonical-source-generation-mismatch");
    if (current.fingerprint !== input.expectedInstallStateFingerprint)
      throw new Error("canonical-install-state-cas-mismatch");
  } else if (current?.state.generationId !== input.generationId) {
    throw new Error("legacy-import-commit-missing");
  }

  const expected =
    input.source.kind === "legacy"
      ? (current?.fingerprint ?? null)
      : input.expectedInstallStateFingerprint;
  return installs.compareAndSwap(expected, pendingInstallState(input, current));
}

function migrationRequest(
  input: NormalizedRequest,
): MigrationTransactionRequest {
  if (input.source.kind !== "legacy") throw new Error("not-legacy-source");
  return {
    projectRoot: input.projectRoot,
    id: `${input.id}.canonical`,
    generationId: input.generationId,
    sourceRoot: input.source.root,
    sourceRuntimeVersion: input.source.runtimeVersion,
    sourceSchemaVersion: input.source.schemaVersion,
    runtimeVersion: input.runtimeVersion,
    expectedInstallStateFingerprint: input.expectedInstallStateFingerprint,
    occurredAt: input.occurredAt,
    files: input.source.files.map((file) => ({
      sourceRef: file.sourceRef,
      targetPath: file.path,
      classification: file.classification,
      sourceBytes: file.sourceBytes,
      targetBytes: file.bytes,
      expectedSourceFingerprint: file.expectedSourceFingerprint,
    })),
  };
}

async function advanceCanonical(
  input: NormalizedRequest,
  plan: MigrationPlanV1,
  store: LifecycleJournalStore,
  snapshot: JournalSnapshot,
  options: LifecycleOrchestratorOptions,
): Promise<{
  readonly snapshot: JournalSnapshot;
  readonly seal: GenerationSeal;
  readonly installState: InstallStateSnapshot;
}> {
  const generations = new GenerationStore(input.projectRoot);
  const installs = new InstallStateStore(input.projectRoot);
  let current = snapshot;
  let seal: GenerationSeal;

  if (input.source.kind === "legacy" && current.journal.state === "planned") {
    const migration = await (
      options.migrationRunner ?? runMigrationTransaction
    )(migrationRequest(input), {
      validateStaged: options.validateGeneration
        ? async (context: MigrationValidationContext) =>
            options.validateGeneration?.({
              generationId: context.generationId,
              files: context.files.map((file) => ({
                path: file.targetPath,
                fingerprint: file.fingerprint,
              })),
              readFile: (relativePath) =>
                generations.readFile(context.generationId, relativePath),
            }) ?? true
        : undefined,
    });
    if (migration.status !== "completed")
      throw new Error(
        migration.reason === "migration-validation-failed"
          ? "generation-validation-failed"
          : "legacy-migration-not-completed",
      );
  }

  if (current.journal.state === "planned") {
    const nextEvents = [
      ...current.journal.events,
      journalEvent(
        current.journal,
        input.occurredAt,
        "backup-completed",
        `${input.id}.backup`,
        [plan.recovery.backupRef],
      ),
    ];
    current = updateJournal(current, store, input.id, {
      state: "backed-up",
      events: nextEvents,
    });
  }

  if (current.journal.state === "backed-up") {
    seal =
      input.source.kind === "legacy"
        ? generations.verify(input.generationId)
        : input.source.kind === "canonical" &&
            input.source.generationId === input.generationId
          ? generations.verify(input.generationId)
          : ensureGeneration(generations, input);
    if (!sealMatches(seal, generationFiles(input)))
      throw new Error("generation-conflict");
    options.fault?.("after-stage");
    current = updateJournal(current, store, input.id, {
      state: "staged",
      events: [
        ...current.journal.events,
        journalEvent(
          current.journal,
          input.occurredAt,
          "stage-completed",
          `${input.id}.stage.1`,
          [seal.fingerprint],
        ),
      ],
    });
  }

  if (current.journal.state === "staged") {
    if (!(await validateGeneration(generations, input, options)))
      throw new Error("generation-validation-failed");
    const validationFingerprint = fingerprintPactileContractV1(
      generationFiles(input).map((file) => ({
        path: file.path,
        fingerprint: file.fingerprint,
      })),
    );
    current = updateJournal(current, store, input.id, {
      state: "validated",
      events: [
        ...current.journal.events,
        journalEvent(
          current.journal,
          input.occurredAt,
          "validation-completed",
          `${input.id}.validate`,
          [validationFingerprint],
        ),
      ],
    });
  }

  if (current.journal.state === "validated") {
    options.fault?.("before-canonical-commit");
    const installed = commitInstallState(installs, input);
    options.fault?.("after-canonical-commit");
    current = updateJournal(current, store, input.id, {
      state: "committed",
      canonicalCommit: {
        status: "committed",
        actionId: plan.canonicalCommitPointActionId,
        generationId: input.generationId,
        committedAt: input.occurredAt,
      },
      events: [
        ...current.journal.events,
        journalEvent(
          current.journal,
          input.occurredAt,
          "canonical-committed",
          plan.canonicalCommitPointActionId,
          [installed.fingerprint],
        ),
      ],
    });
  }

  seal = generations.verify(input.generationId);
  const installState = installs.read();
  if (
    current.journal.canonicalCommit.status !== "committed" ||
    installState?.state.generationId !== input.generationId
  )
    throw new Error("canonical-commit-not-completed");
  return { snapshot: current, seal, installState };
}

function actionId(plan: MigrationPlanV1, adapterId: string): string {
  const action = plan.actions.find(
    (candidate) =>
      candidate.kind === "reconcile-projection" &&
      candidate.adapterId === adapterId,
  );
  if (!action) throw new Error("missing-adapter-action");
  return action.id;
}

function failureRetryable(reason: string): boolean {
  return [
    "projection-busy",
    "projection-apply-not-completed",
    "pending-projection-recovery",
    "projection-cas-mismatch",
    "ledger-cas-mismatch",
    "target-cas-mismatch",
    "applied-state-drift",
    "interrupted-attempt-recovered",
  ].includes(reason);
}

function adaptersNeedingReconcile(
  input: NormalizedRequest,
  journal: MigrationJournalV1,
  installState: InstallStateSnapshot,
  options: LifecycleOrchestratorOptions,
): ReadonlySet<string> {
  const needed = new Set<string>();
  const canonicalCurrent = canonicalAlreadyCommitted(installState, input);
  for (const adapter of input.adapters) {
    const record = journal.adapterReconciliations.find(
      (entry) => entry.adapterId === adapter.adapterId,
    );
    const installed = installState.state.installedAdapters.find(
      (entry) => entry.id === adapter.adapterId,
    );
    if (
      !canonicalCurrent ||
      record?.status !== "succeeded" ||
      installed?.status !== "active" ||
      installed.version !== adapter.adapterVersion
    ) {
      needed.add(adapter.adapterId);
      continue;
    }
    const store =
      options.projectionStore?.(input.projectRoot, adapter.adapterId) ??
      new ProjectionStore(input.projectRoot);
    if (
      store.verifyAdapterState(
        adapter.adapterId,
        installed.lastProjectionFingerprint,
      ).status !== "applied"
    )
      needed.add(adapter.adapterId);
  }
  return needed;
}

type InspectedAdapterProjection =
  | {
      readonly status: "ready";
      readonly preview: ProjectionPreview;
    }
  | {
      readonly status: "failed";
      readonly reason: string;
    };

async function inspectAdapterProjection(
  input: NormalizedRequest,
  adapter: LifecycleAdapter,
  seal: GenerationSeal,
  projectionStore: ProjectionStore,
): Promise<InspectedAdapterProjection> {
  const ledger = projectionStore.readLedger();
  const projection = await adapter.buildProjection({
    generationId: input.generationId,
    canonicalFingerprint: seal.fingerprint,
    ledger: ledger?.ledger ?? null,
    ledgerFingerprint: ledger?.fingerprint ?? null,
    occurredAt: input.occurredAt,
  });
  const parsed = parseProjectionPlanV1(projection.plan);
  if (
    !parsed.success ||
    parsed.data.id !== adapter.projectionPlanId ||
    parsed.data.adapterId !== adapter.adapterId ||
    parsed.data.generationId !== input.generationId ||
    parsed.data.canonicalFingerprint !== seal.fingerprint ||
    parsed.data.expectedLedgerFingerprint !== (ledger?.fingerprint ?? null) ||
    projection.canonicalFingerprint !== seal.fingerprint
  )
    return { status: "failed", reason: "invalid-adapter-projection" };
  const preview = projectionStore.inspect({
    plan: projection.plan,
    canonicalFingerprint: projection.canonicalFingerprint,
    updatedAt: projection.updatedAt,
    resolveContent: projection.resolveContent,
    externalClaims: projection.externalClaims,
  });
  return preview.status === "ready"
    ? { status: "ready", preview }
    : { status: "failed", reason: preview.reason };
}

function adapterResults(
  journal: MigrationJournalV1,
): readonly LifecycleAdapterResult[] {
  return journal.adapterReconciliations.map((adapter) => {
    const succeeded = [...journal.events]
      .reverse()
      .find(
        (event) =>
          event.adapterId === adapter.adapterId &&
          event.event === "adapter-reconcile-succeeded",
      );
    return {
      adapterId: adapter.adapterId,
      status:
        adapter.status === "succeeded"
          ? "succeeded"
          : adapter.status === "pending"
            ? "pending"
            : "failed",
      attempts: adapter.attempts,
      reason: adapter.lastError,
      retryable: adapter.lastError
        ? failureRetryable(adapter.lastError)
        : false,
      projectionFingerprint: succeeded?.evidenceRefs[0] ?? null,
    };
  });
}

function updateAdapterRecord(
  journal: MigrationJournalV1,
  adapterId: string,
  patch: Partial<MigrationJournalV1["adapterReconciliations"][number]>,
): MigrationJournalV1["adapterReconciliations"] {
  return journal.adapterReconciliations.map((entry) =>
    entry.adapterId === adapterId ? { ...entry, ...patch } : entry,
  );
}

function failAdapter(
  snapshot: JournalSnapshot,
  store: LifecycleJournalStore,
  input: NormalizedRequest,
  plan: MigrationPlanV1,
  adapterId: string,
  occurredAt: string,
  reason: string,
): JournalSnapshot {
  const adapter = snapshot.journal.adapterReconciliations.find(
    (entry) => entry.adapterId === adapterId,
  );
  if (!adapter) throw new Error("missing-adapter-journal");
  return updateJournal(snapshot, store, input.id, {
    state: "degraded",
    adapterReconciliations: updateAdapterRecord(snapshot.journal, adapterId, {
      status: "failed",
      attempts: adapter.attempts,
      lastAttemptAt: occurredAt,
      lastError: reason,
    }),
    events: [
      ...snapshot.journal.events,
      journalEvent(
        snapshot.journal,
        occurredAt,
        "adapter-reconcile-failed",
        actionId(plan, adapterId),
        [
          fingerprintPactileContractV1({
            reason,
            retryable: failureRetryable(reason),
          }),
        ],
        adapterId,
      ),
    ],
  });
}

async function reconcileAdapters(
  input: NormalizedRequest,
  plan: MigrationPlanV1,
  seal: GenerationSeal,
  store: LifecycleJournalStore,
  snapshot: JournalSnapshot,
  options: LifecycleOrchestratorOptions,
  needed: ReadonlySet<string>,
): Promise<JournalSnapshot> {
  let current = snapshot;
  for (const adapter of input.adapters) {
    let record = current.journal.adapterReconciliations.find(
      (entry) => entry.adapterId === adapter.adapterId,
    );
    if (!record || !needed.has(adapter.adapterId)) continue;

    if (record.status === "in-progress") {
      current = failAdapter(
        current,
        store,
        input,
        plan,
        adapter.adapterId,
        input.occurredAt,
        "interrupted-attempt-recovered",
      );
      record = current.journal.adapterReconciliations.find(
        (entry) => entry.adapterId === adapter.adapterId,
      );
      if (!record) throw new Error("missing-adapter-journal");
    }

    const attemptedAt = input.occurredAt;
    current = updateJournal(current, store, input.id, {
      state: "reconciling",
      adapterReconciliations: updateAdapterRecord(
        current.journal,
        adapter.adapterId,
        {
          status: "in-progress",
          attempts: record.attempts + 1,
          lastAttemptAt: attemptedAt,
          lastError: null,
        },
      ),
      events: [
        ...current.journal.events,
        journalEvent(
          current.journal,
          attemptedAt,
          "adapter-reconcile-started",
          actionId(plan, adapter.adapterId),
          [adapter.projectionPlanId],
          adapter.adapterId,
        ),
      ],
    });

    let failure: string | null = null;
    let projectionFingerprint: string | null = null;
    try {
      options.fault?.("before-adapter", adapter.adapterId);
      const projectionStore =
        options.projectionStore?.(input.projectRoot, adapter.adapterId) ??
        new ProjectionStore(input.projectRoot);
      const recovery = projectionStore.recover();
      if (recovery.status === "busy") failure = "projection-busy";
      else if (recovery.status === "review")
        failure = recovery.reason ?? "pending-projection-recovery";
      if (!failure) {
        const inspected = await inspectAdapterProjection(
          input,
          adapter,
          seal,
          projectionStore,
        );
        if (inspected.status === "failed") failure = inspected.reason;
        else {
          const applied = projectionStore.apply(inspected.preview);
          if (
            applied.status === "applied" ||
            applied.status === "already-applied"
          )
            projectionFingerprint = applied.receipt.planFingerprint;
          else
            failure =
              "reason" in applied
                ? applied.reason
                : "projection-apply-not-completed";
        }
      }
      options.fault?.("after-adapter", adapter.adapterId);
    } catch {
      failure = "projection-apply-not-completed";
    }

    if (failure) {
      current = failAdapter(
        current,
        store,
        input,
        plan,
        adapter.adapterId,
        attemptedAt,
        failure,
      );
      continue;
    }
    if (!projectionFingerprint)
      throw new Error("missing-projection-fingerprint");
    current = updateJournal(current, store, input.id, {
      state: current.journal.adapterReconciliations.some(
        (entry) =>
          entry.adapterId !== adapter.adapterId && entry.status === "failed",
      )
        ? "degraded"
        : "committed",
      adapterReconciliations: updateAdapterRecord(
        current.journal,
        adapter.adapterId,
        {
          status: "succeeded",
          lastAttemptAt: attemptedAt,
          lastError: null,
        },
      ),
      events: [
        ...current.journal.events,
        journalEvent(
          current.journal,
          attemptedAt,
          "adapter-reconcile-succeeded",
          actionId(plan, adapter.adapterId),
          [projectionFingerprint],
          adapter.adapterId,
        ),
      ],
    });
  }
  return current;
}

function finalizeInstallState(
  installs: InstallStateStore,
  input: NormalizedRequest,
  journal: MigrationJournalV1,
): InstallStateSnapshot {
  const current = installs.read();
  if (
    current?.state.generationId !== input.generationId ||
    current.state.lastMigrationJournalId !== input.id
  )
    throw new Error("canonical-install-state-missing");
  const adapters = new Map(
    current.state.installedAdapters.map((adapter) => [adapter.id, adapter]),
  );
  for (const requested of input.adapters) {
    const reconciliation = journal.adapterReconciliations.find(
      (entry) => entry.adapterId === requested.adapterId,
    );
    if (!reconciliation) throw new Error("missing-adapter-journal");
    const previous = adapters.get(requested.adapterId);
    const successEvent = [...journal.events]
      .reverse()
      .find(
        (event) =>
          event.adapterId === requested.adapterId &&
          event.event === "adapter-reconcile-succeeded",
      );
    adapters.set(requested.adapterId, {
      id: requested.adapterId,
      version: requested.adapterVersion,
      status: reconciliation.status === "succeeded" ? "active" : "degraded",
      lastProjectionFingerprint:
        successEvent?.evidenceRefs[0] ??
        previous?.lastProjectionFingerprint ??
        null,
      reconciledAt: successEvent?.at ?? previous?.reconciledAt ?? null,
    });
  }
  const installedAdapters = [...adapters.values()].sort((left, right) =>
    lexical(left.id, right.id),
  );
  const next: InstallStateV1 = {
    ...current.state,
    runtimeVersion: input.runtimeVersion,
    status: installedAdapters.some((adapter) => adapter.status === "degraded")
      ? "degraded"
      : "active",
    installedAdapters,
    updatedAt: input.occurredAt,
  };
  if (
    canonicalizePactileJsonV1(next) === canonicalizePactileJsonV1(current.state)
  )
    return current;
  return installs.compareAndSwap(current.fingerprint, next);
}

function failureResult(
  status: "review" | "interrupted",
  reason: Extract<
    LifecycleResult,
    { status: "review" | "interrupted" }
  >["reason"],
  resumed: boolean,
  plan: { readonly plan: MigrationPlanV1; readonly fingerprint: string } | null,
  snapshot: JournalSnapshot | null,
  generationFingerprint: string | null,
  installState: InstallStateSnapshot | null,
): LifecycleResult {
  return {
    status,
    resumed,
    reason,
    plan: plan?.plan ?? null,
    planFingerprint: plan?.fingerprint ?? null,
    generationFingerprint,
    journal: snapshot?.journal ?? null,
    installState,
    adapters: snapshot ? adapterResults(snapshot.journal) : [],
  };
}

/**
 * Durable Batch 3 lifecycle seam. Canonical generation activation is complete
 * before any Adapter factory or ProjectionStore write is allowed to run.
 */
export async function runLifecycleTransaction(
  request: LifecycleRequest,
  options: LifecycleOrchestratorOptions = {},
): Promise<LifecycleResult> {
  const input = normalizeRequest(request);
  const planned = input ? buildPlan(input) : null;
  if (!input || !planned)
    return failureResult(
      "review",
      "invalid-lifecycle-request",
      false,
      null,
      null,
      null,
      null,
    );

  const journals = new LifecycleJournalStore(input.projectRoot);
  let snapshot: JournalSnapshot | null = null;
  let resumed = false;
  let generationFingerprint: string | null = null;
  let installState: InstallStateSnapshot | null = null;
  let neededAdapters: ReadonlySet<string> | null = null;
  try {
    snapshot = journals.read(input.id);
    if (snapshot) {
      resumed = true;
      if (
        snapshot.journal.planId !== planned.plan.id ||
        snapshot.journal.planFingerprint !== planned.fingerprint
      )
        return failureResult(
          "review",
          "lifecycle-plan-conflict",
          true,
          planned,
          snapshot,
          null,
          new InstallStateStore(input.projectRoot).read(),
        );
    } else {
      snapshot = journals.write(
        input.id,
        null,
        initialJournal(input, planned.plan, planned.fingerprint),
      );
    }

    if (snapshot.journal.state === "completed") {
      const seal = new GenerationStore(input.projectRoot).verify(
        input.generationId,
      );
      const installed = new InstallStateStore(input.projectRoot).read();
      if (!installed) throw new Error("canonical-install-state-missing");
      generationFingerprint = seal.fingerprint;
      installState = installed;
      neededAdapters = adaptersNeedingReconcile(
        input,
        snapshot.journal,
        installed,
        options,
      );
      if (
        canonicalAlreadyCommitted(installed, input) &&
        neededAdapters.size === 0
      ) {
        if (input.materializeCanonical) {
          const generations = new GenerationStore(input.projectRoot);
          await input.materializeCanonical({
            generationId: input.generationId,
            files: seal.files,
            readFile: (relativePath) =>
              generations.readFile(input.generationId, relativePath),
            readFiles: (relativePaths) =>
              generations.readFiles(input.generationId, relativePaths),
          });
        }
        return {
          status: "completed",
          resumed,
          reason: null,
          plan: planned.plan,
          planFingerprint: planned.fingerprint,
          generationFingerprint: seal.fingerprint,
          journal: snapshot.journal,
          installState: installed,
          adapters: adapterResults(snapshot.journal),
        };
      }

      installState = commitInstallState(
        new InstallStateStore(input.projectRoot),
        input,
      );
      snapshot = updateJournal(snapshot, journals, input.id, {
        state: "committed",
      });
    }

    if (
      ["planned", "backed-up", "staged", "validated"].includes(
        snapshot.journal.state,
      )
    ) {
      const advanced = await advanceCanonical(
        input,
        planned.plan,
        journals,
        snapshot,
        options,
      );
      snapshot = advanced.snapshot;
      generationFingerprint = advanced.seal.fingerprint;
      installState = advanced.installState;
    } else {
      const seal = new GenerationStore(input.projectRoot).verify(
        input.generationId,
      );
      generationFingerprint = seal.fingerprint;
      installState = new InstallStateStore(input.projectRoot).read();
    }

    if (!generationFingerprint || !installState)
      throw new Error("canonical-commit-not-completed");

    if (input.materializeCanonical) {
      const generations = new GenerationStore(input.projectRoot);
      const seal = generations.verify(input.generationId);
      await input.materializeCanonical({
        generationId: input.generationId,
        files: seal.files,
        readFile: (relativePath) =>
          generations.readFile(input.generationId, relativePath),
        readFiles: (relativePaths) =>
          generations.readFiles(input.generationId, relativePaths),
      });
    }

    neededAdapters ??= adaptersNeedingReconcile(
      input,
      snapshot.journal,
      installState,
      options,
    );

    snapshot = await reconcileAdapters(
      input,
      planned.plan,
      { ...new GenerationStore(input.projectRoot).verify(input.generationId) },
      journals,
      snapshot,
      options,
      neededAdapters,
    );
    installState = finalizeInstallState(
      new InstallStateStore(input.projectRoot),
      input,
      snapshot.journal,
    );

    const failed = snapshot.journal.adapterReconciliations.some(
      (adapter) => adapter.status !== "succeeded",
    );
    if (!failed) {
      snapshot = updateJournal(snapshot, journals, input.id, {
        state: "completed",
        events: [
          ...snapshot.journal.events,
          journalEvent(
            snapshot.journal,
            input.occurredAt,
            "doctor-completed",
            `${input.id}.doctor`,
            [installState.fingerprint],
          ),
        ],
      });
    }
    return {
      status: failed ? "degraded" : "completed",
      resumed,
      reason: null,
      plan: planned.plan,
      planFingerprint: planned.fingerprint,
      generationFingerprint,
      journal: snapshot.journal,
      installState,
      adapters: adapterResults(snapshot.journal),
    };
  } catch (error) {
    let latest = snapshot;
    try {
      latest = journals.read(input.id) ?? snapshot;
    } catch {
      return failureResult(
        "review",
        "lifecycle-journal-unavailable",
        resumed,
        planned,
        snapshot,
        generationFingerprint,
        installState,
      );
    }
    const validationFailed =
      error instanceof Error &&
      error.message === "generation-validation-failed";
    return failureResult(
      validationFailed ? "review" : "interrupted",
      validationFailed
        ? "generation-validation-failed"
        : "canonical-commit-not-completed",
      resumed,
      planned,
      latest,
      generationFingerprint,
      new InstallStateStore(input.projectRoot).read(),
    );
  }
}

export function createProjectionStore(
  projectRoot: string,
  options: ProjectionStoreOptions = {},
): ProjectionStore {
  return new ProjectionStore(projectRoot, options);
}
