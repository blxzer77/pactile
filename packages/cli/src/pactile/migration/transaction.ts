import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  canonicalizePactileJsonV1,
  fingerprintPactileContractV1,
  parseMigrationJournalV1,
  parseMigrationPlanV1,
  type MigrationJournalV1,
  type MigrationPlanV1,
} from "../../core/index.js";
import { GenerationStore, InstallStateStore } from "../runtime/stores.js";
import {
  assertCanonicalWriteTarget,
  normalizeRuntimeRelativePath,
  resolveCanonicalPaths,
} from "../runtime/paths.js";

export type MigrationFileClassification = "active" | "closed" | "generated";

export interface MigrationSourceFile {
  readonly sourceRef: string;
  readonly targetPath: string;
  readonly classification: MigrationFileClassification;
  readonly sourceBytes: Uint8Array;
  readonly targetBytes: Uint8Array;
  readonly expectedSourceFingerprint: string;
}

export interface MigrationTransactionRequest {
  readonly projectRoot: string;
  readonly id: string;
  readonly generationId: string;
  readonly sourceRoot: ".cstl" | ".trellis";
  readonly sourceRuntimeVersion: string | null;
  readonly sourceSchemaVersion: number | null;
  readonly runtimeVersion: string;
  readonly expectedInstallStateFingerprint: string | null;
  readonly occurredAt: string;
  readonly files: readonly MigrationSourceFile[];
}

export interface MigrationValidationContext {
  readonly plan: MigrationPlanV1;
  readonly generationId: string;
  readonly files: readonly {
    sourceRef: string;
    targetPath: string;
    classification: MigrationFileClassification;
    fingerprint: string;
  }[];
}

export interface MigrationTransactionOptions {
  /** Additional schema validation at the public staged-generation boundary. */
  readonly validateStaged?: (
    context: MigrationValidationContext,
  ) => boolean | Promise<boolean>;
}

export type MigrationTransactionResult =
  | {
      readonly status: "completed";
      readonly resumed: boolean;
      readonly plan: MigrationPlanV1;
      readonly planFingerprint: string;
      readonly journal: MigrationJournalV1;
    }
  | {
      readonly status: "review" | "interrupted";
      readonly reason:
        | "invalid-migration-request"
        | "migration-plan-conflict"
        | "migration-validation-failed"
        | "migration-interrupted";
      readonly plan: MigrationPlanV1 | null;
      readonly journal: MigrationJournalV1 | null;
    };

interface NormalizedFile {
  readonly sourceRef: string;
  readonly targetPath: string;
  readonly classification: MigrationFileClassification;
  readonly sourceBytes: Buffer;
  readonly targetBytes: Buffer;
  readonly expectedSourceFingerprint: string;
}

interface NormalizedRequest extends Omit<MigrationTransactionRequest, "files"> {
  readonly files: readonly NormalizedFile[];
}

interface JournalSnapshot {
  readonly journal: MigrationJournalV1;
  readonly fingerprint: string;
}

const LOGICAL_ID = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const MAX_MIGRATION_FILE_BYTES = 16 * 1024 * 1024;

function fingerprintBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function normalizeRequest(
  request: MigrationTransactionRequest,
): NormalizedRequest | null {
  try {
    if (
      !path.isAbsolute(request.projectRoot) ||
      !LOGICAL_ID.test(request.id) ||
      !LOGICAL_ID.test(request.generationId) ||
      ![".cstl", ".trellis"].includes(request.sourceRoot) ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(request.runtimeVersion) ||
      (request.expectedInstallStateFingerprint !== null &&
        !FINGERPRINT.test(request.expectedInstallStateFingerprint)) ||
      Number.isNaN(Date.parse(request.occurredAt)) ||
      request.files.length === 0
    )
      return null;
    const files = request.files
      .map(
        (file): NormalizedFile => ({
          sourceRef: file.sourceRef,
          targetPath: normalizeRuntimeRelativePath(file.targetPath),
          classification: file.classification,
          sourceBytes: Buffer.from(file.sourceBytes),
          targetBytes: Buffer.from(file.targetBytes),
          expectedSourceFingerprint: file.expectedSourceFingerprint,
        }),
      )
      .sort((left, right) => left.targetPath.localeCompare(right.targetPath));
    if (
      new Set(files.map((file) => file.targetPath.toLowerCase())).size !==
        files.length ||
      files.some(
        (file) =>
          !file.sourceRef ||
          file.sourceRef.length > 512 ||
          /[\0\r\n]/.test(file.sourceRef) ||
          !["active", "closed", "generated"].includes(file.classification) ||
          !FINGERPRINT.test(file.expectedSourceFingerprint) ||
          file.sourceBytes.byteLength > MAX_MIGRATION_FILE_BYTES ||
          file.targetBytes.byteLength > MAX_MIGRATION_FILE_BYTES ||
          fingerprintBytes(file.sourceBytes) !==
            file.expectedSourceFingerprint ||
          (file.classification === "closed" &&
            !file.sourceBytes.equals(file.targetBytes)),
      )
    )
      return null;
    return { ...request, files };
  } catch {
    return null;
  }
}

export function planMigrationTransaction(
  request: MigrationTransactionRequest,
): { readonly plan: MigrationPlanV1; readonly fingerprint: string } | null {
  const input = normalizeRequest(request);
  if (!input) return null;
  const detectId = `${input.id}.detect`;
  const backupId = `${input.id}.backup`;
  const validateId = `${input.id}.validate`;
  const commitId = `${input.id}.commit`;
  const doctorId = `${input.id}.doctor`;
  const candidate = {
    schemaVersion: 1,
    id: input.id,
    source: {
      kind: "legacy",
      root: input.sourceRoot,
      access: "read-only",
      runtimeVersion: input.sourceRuntimeVersion,
      schemaVersion: input.sourceSchemaVersion,
    },
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
        sourceRef: `legacy://${input.sourceRoot.slice(1)}`,
        targetRef: null,
        adapterId: null,
        reversible: true,
      },
      {
        id: backupId,
        phase: "backup",
        kind: "snapshot",
        domain: "canonical",
        sourceRef: `legacy://${input.sourceRoot.slice(1)}`,
        targetRef: `backup://${input.id}`,
        adapterId: null,
        reversible: true,
      },
      ...input.files.map((file, index) => ({
        id: `${input.id}.stage.${index + 1}`,
        phase: "stage" as const,
        kind:
          file.classification === "closed"
            ? ("copy-byte-preserved" as const)
            : file.classification === "generated"
              ? ("write-generation" as const)
              : ("transform-schema" as const),
        domain: "canonical" as const,
        sourceRef: file.sourceRef,
        targetRef: `generation://${input.generationId}/${file.targetPath}`,
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
    preservation: {
      bytePreservedRefs: input.files
        .filter((file) => file.classification === "closed")
        .map((file) => file.sourceRef),
      transformedRefs: input.files
        .filter((file) => file.classification !== "closed")
        .map((file) => file.sourceRef),
    },
    recovery: {
      backupRef: `backup://${input.id}`,
      preserveNewerData: true,
    },
    projectionPlanIds: [],
  };
  const parsed = parseMigrationPlanV1(candidate);
  return parsed.success
    ? { plan: parsed.data, fingerprint: parsed.fingerprint }
    : null;
}

class MigrationJournalStore {
  private readonly directory: string;

  constructor(private readonly projectRoot: string) {
    this.directory = resolveCanonicalPaths(projectRoot).migrationJournalsPath;
  }

  private target(id: string): string {
    if (!LOGICAL_ID.test(id)) throw new Error("invalid-journal-id");
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
      return parsed.success
        ? { journal: parsed.data, fingerprint: parsed.fingerprint }
        : null;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw new Error("migration-journal-unavailable");
    }
  }

  write(
    id: string,
    expectedFingerprint: string | null,
    journal: MigrationJournalV1,
  ): JournalSnapshot {
    const parsed = parseMigrationJournalV1(journal);
    if (!parsed.success) throw new Error("invalid-migration-journal");
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
    try {
      descriptor = fs.openSync(lock, "wx", 0o600);
      const current = this.read(id);
      if ((current?.fingerprint ?? null) !== expectedFingerprint)
        throw new Error("migration-journal-cas-mismatch");
      fs.writeFileSync(temporary, canonicalizePactileJsonV1(parsed.data), {
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(temporary, target);
      return { journal: parsed.data, fingerprint: parsed.fingerprint };
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(lock);
      } catch {
        /* An unavailable cleanup remains visible to recovery. */
      }
      try {
        fs.unlinkSync(temporary);
      } catch {
        /* The successful rename consumes the temporary file. */
      }
    }
  }
}

function event(
  journal: MigrationJournalV1,
  at: string,
  name: MigrationJournalV1["events"][number]["event"],
  actionId: string,
  evidenceRef: string,
): MigrationJournalV1["events"][number] {
  return {
    sequence: journal.events.length + 1,
    at,
    event: name,
    actionId,
    adapterId: null,
    evidenceRefs: [evidenceRef],
  };
}

function initialJournal(
  request: NormalizedRequest,
  plan: MigrationPlanV1,
  planFingerprint: string,
): MigrationJournalV1 {
  return {
    schemaVersion: 1,
    id: request.id,
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
      status: "not-required",
      backupRef: plan.recovery.backupRef,
      updatedAt: request.occurredAt,
      error: null,
    },
    adapterReconciliations: [],
    events: [
      {
        sequence: 1,
        at: request.occurredAt,
        event: "planned",
        actionId: `${request.id}.detect`,
        adapterId: null,
        evidenceRefs: [planFingerprint],
      },
    ],
  };
}

function updateJournal(
  journal: MigrationJournalV1,
  patch: Partial<MigrationJournalV1>,
): MigrationJournalV1 {
  return { ...journal, ...patch };
}

export async function runMigrationTransaction(
  request: MigrationTransactionRequest,
  options: MigrationTransactionOptions = {},
): Promise<MigrationTransactionResult> {
  const input = normalizeRequest(request);
  const planned = input ? planMigrationTransaction(input) : null;
  if (!input || !planned)
    return {
      status: "review",
      reason: "invalid-migration-request",
      plan: null,
      journal: null,
    };
  const journals = new MigrationJournalStore(input.projectRoot);
  const generations = new GenerationStore(input.projectRoot);
  const installs = new InstallStateStore(input.projectRoot);
  let snapshot: JournalSnapshot | null = null;
  let resumed = false;
  try {
    snapshot = journals.read(input.id);
    if (snapshot) {
      resumed = true;
      if (
        snapshot.journal.planId !== planned.plan.id ||
        snapshot.journal.planFingerprint !== planned.fingerprint
      )
        return {
          status: "review",
          reason: "migration-plan-conflict",
          plan: planned.plan,
          journal: snapshot.journal,
        };
    } else {
      snapshot = journals.write(
        input.id,
        null,
        initialJournal(input, planned.plan, planned.fingerprint),
      );
    }

    if (snapshot.journal.state === "completed")
      return {
        status: "completed",
        resumed,
        plan: planned.plan,
        planFingerprint: planned.fingerprint,
        journal: snapshot.journal,
      };

    if (snapshot.journal.state === "planned") {
      const next = updateJournal(snapshot.journal, {
        state: "backed-up",
        recovery: {
          status: "available",
          backupRef: planned.plan.recovery.backupRef,
          updatedAt: input.occurredAt,
          error: null,
        },
        events: [
          ...snapshot.journal.events,
          event(
            snapshot.journal,
            input.occurredAt,
            "backup-completed",
            `${input.id}.backup`,
            planned.fingerprint,
          ),
        ],
      });
      snapshot = journals.write(input.id, snapshot.fingerprint, next);
    }

    if (snapshot.journal.state === "backed-up") {
      generations.stage(input.generationId);
      const written = input.files.map((file) =>
        generations.writeFile(
          input.generationId,
          file.targetPath,
          file.targetBytes,
        ),
      );
      const seal = generations.seal(input.generationId, written);
      const next = updateJournal(snapshot.journal, {
        state: "staged",
        events: [
          ...snapshot.journal.events,
          event(
            snapshot.journal,
            input.occurredAt,
            "stage-completed",
            `${input.id}.stage.1`,
            seal.fingerprint,
          ),
        ],
      });
      snapshot = journals.write(input.id, snapshot.fingerprint, next);
    }

    if (snapshot.journal.state === "staged") {
      generations.verify(input.generationId);
      const validationFiles = input.files.map((file) => {
        const bytes = generations.readFile(input.generationId, file.targetPath);
        if (
          !bytes.equals(file.targetBytes) ||
          (file.classification === "closed" &&
            fingerprintBytes(bytes) !== file.expectedSourceFingerprint)
        )
          throw new Error("migration-validation-failed");
        return {
          sourceRef: file.sourceRef,
          targetPath: file.targetPath,
          classification: file.classification,
          fingerprint: fingerprintBytes(bytes),
        };
      });
      if (
        options.validateStaged &&
        !(await options.validateStaged({
          plan: planned.plan,
          generationId: input.generationId,
          files: validationFiles,
        }))
      )
        return {
          status: "review",
          reason: "migration-validation-failed",
          plan: planned.plan,
          journal: snapshot.journal,
        };
      const next = updateJournal(snapshot.journal, {
        state: "validated",
        events: [
          ...snapshot.journal.events,
          event(
            snapshot.journal,
            input.occurredAt,
            "validation-completed",
            `${input.id}.validate`,
            fingerprintPactileContractV1(validationFiles),
          ),
        ],
      });
      snapshot = journals.write(input.id, snapshot.fingerprint, next);
    }

    if (snapshot.journal.state === "validated") {
      const current = installs.read();
      if (
        current?.state.generationId !== input.generationId ||
        current.state.lastMigrationJournalId !== input.id
      ) {
        installs.compareAndSwap(input.expectedInstallStateFingerprint, {
          schemaVersion: 1,
          product: "pactile",
          canonicalRoot: ".pactile",
          runtimeVersion: input.runtimeVersion,
          contractVersion: 1,
          generationId: input.generationId,
          status: "active",
          installedAdapters: current?.state.installedAdapters ?? [],
          lastMigrationJournalId: input.id,
          createdAt: current?.state.createdAt ?? input.occurredAt,
          updatedAt: input.occurredAt,
        });
      }
      const next = updateJournal(snapshot.journal, {
        state: "committed",
        canonicalCommit: {
          status: "committed",
          actionId: planned.plan.canonicalCommitPointActionId,
          generationId: input.generationId,
          committedAt: input.occurredAt,
        },
        events: [
          ...snapshot.journal.events,
          event(
            snapshot.journal,
            input.occurredAt,
            "canonical-committed",
            planned.plan.canonicalCommitPointActionId,
            `generation:${input.generationId}`,
          ),
        ],
      });
      snapshot = journals.write(input.id, snapshot.fingerprint, next);
    }

    if (snapshot.journal.state === "committed") {
      const next = updateJournal(snapshot.journal, {
        state: "completed",
        events: [
          ...snapshot.journal.events,
          event(
            snapshot.journal,
            input.occurredAt,
            "doctor-completed",
            `${input.id}.doctor`,
            `generation:${input.generationId}`,
          ),
        ],
      });
      snapshot = journals.write(input.id, snapshot.fingerprint, next);
    }

    return {
      status: "completed",
      resumed,
      plan: planned.plan,
      planFingerprint: planned.fingerprint,
      journal: snapshot.journal,
    };
  } catch (error) {
    return {
      status: "interrupted",
      reason:
        error instanceof Error &&
        error.message === "migration-validation-failed"
          ? "migration-validation-failed"
          : "migration-interrupted",
      plan: planned.plan,
      journal: journals.read(input.id)?.journal ?? snapshot?.journal ?? null,
    };
  }
}
