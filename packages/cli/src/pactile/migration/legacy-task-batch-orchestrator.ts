import fs from "node:fs";
import path from "node:path";

import { assertUniqueTaskIdForLegacyBatchTarget } from "../../core/task/task-kernel-paths.js";
import { parseTaskKernelSnapshotV2 } from "../../core/task/task-kernel-schema.js";
import { assertLegacyTaskMigrationAuthorityOrCleanStore } from "../../core/task/legacy-task-migration-reader.js";
import {
  JOURNAL_EVENTS,
  digest,
  jsonBytes,
  normalizeRequest,
  type AuthoritySnapshot,
  type JournalSnapshot,
  type LegacyTaskBatchAuthority,
  type LegacyTaskBatchJournal,
  type LegacyTaskBatchOptions,
  type LegacyTaskBatchPhase,
  type LegacyTaskBatchRequest,
  type LegacyTaskBatchResult,
  type NormalizedRequest,
  type LegacyTaskBatchValidationContext,
  STORAGE_RELATIVE,
} from "./legacy-task-batch-types.js";
import {
  assertSourceUnchanged,
  sourceMatchesPlan,
  validatePlanAtRoot,
  verifySourceBackup,
  writeSourceBackup,
} from "./legacy-task-batch-source.js";
import {
  stageTargets,
  verifyGeneration,
} from "./legacy-task-batch-generation.js";
import {
  readAuthoritySnapshot,
  readJournal,
  writeAuthority,
  writeJournal,
} from "./legacy-task-batch-journal.js";
import {
  ensureDirectory,
  storagePath,
  withAsyncLock,
} from "./legacy-task-batch-io.js";

export function legacyTaskBatchTaskIdConflict(
  projectRoot: string,
  targets: readonly { readonly path: string; readonly bytes: Uint8Array }[],
): string | null {
  const root = path.resolve(projectRoot);
  const kernels: { path: string; taskDir: string; taskId: string }[] = [];
  try {
    for (const target of targets) {
      if (!target.path.endsWith("/kernel.json")) continue;
      const taskDirPath = target.path.slice(0, -"/kernel.json".length);
      if (!taskDirPath.startsWith(".pactile/tasks/") || taskDirPath.split("/").some((part) => part.toLowerCase() === "archive"))
        continue;
      const kernel = parseTaskKernelSnapshotV2(JSON.parse(Buffer.from(target.bytes).toString("utf8")) as unknown);
      kernels.push({ path: target.path, taskDir: path.join(root, ...taskDirPath.split("/")), taskId: kernel.identity.taskId });
    }
    const ids = new Set<string>();
    for (const kernel of kernels) {
      if (ids.has(kernel.taskId)) return `legacy-task-migration-task-id-duplicate:${kernel.taskId}`;
      ids.add(kernel.taskId);
      const existingPath = path.join(kernel.taskDir, "kernel.json");
      try {
        const stat = fs.lstatSync(existingPath);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          let existing: unknown;
          try { existing = JSON.parse(fs.readFileSync(existingPath, "utf8")) as unknown; } catch { existing = null; }
          if (existing && typeof existing === "object" && !Array.isArray(existing) && (existing as { schemaVersion?: unknown }).schemaVersion === 2)
            return "legacy-task-migration-target-kernel-occupied";
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      assertUniqueTaskIdForLegacyBatchTarget(root, kernel.taskId, kernel.taskDir);
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "legacy-task-migration-task-id-check-failed";
  }
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

/** Read the one committed-batch pointer and verify its source and staged bytes. */
export function readPreparedLegacyTaskBatch(
  projectRoot: string,
): LegacyTaskBatchAuthority | null {
  const root = path.resolve(projectRoot);
  return readAuthoritySnapshot(root)?.authority ?? null;
}

function hasOnlyExpectedJournalLock(
  projectRoot: string,
  batchId: string,
): boolean {
  const store = path.join(
    projectRoot,
    ".pactile",
    "runtime",
    "legacy-task-migrations",
  );
  const journalDirectory = path.join(store, "journals");
  const lockPath = path.join(journalDirectory, `${batchId}.json.lock`);
  try {
    const storeEntries = fs.readdirSync(store);
    const journalDirectoryStat = fs.lstatSync(journalDirectory);
    const journalEntries = fs.readdirSync(journalDirectory);
    const lockStat = fs.lstatSync(lockPath);
    return (
      storeEntries.length === 1 &&
      storeEntries[0] === "journals" &&
      journalDirectoryStat.isDirectory() &&
      !journalDirectoryStat.isSymbolicLink() &&
      journalEntries.length === 1 &&
      journalEntries[0] === `${batchId}.json.lock` &&
      lockStat.isFile() &&
      !lockStat.isSymbolicLink() &&
      lockStat.nlink === 1
    );
  } catch {
    return false;
  }
}

/**
 * A missing pointer may be retried only for a matching, pre-commit journal
 * whose backup/staged generation verifies and which has no post-commit overlay.
 * A lone lock for this exact batch may also reach `withLock`, which only reclaims
 * it after confirming that its recorded process is dead.
 */
export function canResumeLegacyTaskBatchWithoutAuthority(
  request: LegacyTaskBatchRequest,
): boolean {
  const normalized = normalizeRequest(request);
  if (
    !normalized ||
    !validatePlanAtRoot(normalized.projectRoot, normalized.plan)
  ) return false;
  if (legacyTaskBatchTaskIdConflict(normalized.projectRoot, normalized.targets)) return false;
  try {
    if (readAuthoritySnapshot(normalized.projectRoot)) return false;
    const snapshot = readJournal(normalized.projectRoot, normalized.batchId);
    if (!snapshot)
      return hasOnlyExpectedJournalLock(
        normalized.projectRoot,
        normalized.batchId,
      );
    const journal = snapshot.journal;
    if (
      journal.batchId !== normalized.batchId ||
      journal.generationId !== normalized.generationId ||
      journal.sourceFingerprint !== normalized.sourceFingerprint ||
      journal.targetFingerprint !== normalized.targetFingerprint ||
      journal.planFingerprint !== normalized.planFingerprint ||
      journal.expectedAuthorityFingerprint !== null
    ) return false;
    return readRecoverablePrecommitJournals(request) !== null;
  } catch {
    return false;
  }
}

function directoryEntries(directory: string): string[] | null {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return fs.readdirSync(directory).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return null;
  }
}

function directoryExistsSafely(directory: string): boolean | null {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return null;
  }
}

function journalLifecycleEvents(
  journal: LegacyTaskBatchJournal,
): readonly { readonly event: string; readonly evidenceFingerprint: string }[] | null {
  const events = [{ event: "planned", evidenceFingerprint: journal.planFingerprint }];
  if (journal.state === "backed-up" || journal.state === "staged" || journal.state === "validated")
    events.push({ event: "source-backed-up", evidenceFingerprint: journal.sourceFingerprint });
  if (journal.state === "staged" || journal.state === "validated")
    events.push({ event: "targets-staged", evidenceFingerprint: journal.targetFingerprint });
  if (journal.state === "validated")
    events.push({ event: "targets-validated", evidenceFingerprint: journal.targetFingerprint });
  if (![
    "planned",
    "backed-up",
    "staged",
    "validated",
  ].includes(journal.state)) return null;
  return events;
}

function journalMatchesPrecommitEvidence(
  projectRoot: string,
  journal: LegacyTaskBatchJournal,
  requiredSources: Set<string>,
  requiredGenerations: Set<string>,
): boolean {
  const expectedEvents = journalLifecycleEvents(journal);
  const lifecycleEvents = journal.events.filter(
    (event) => event.event !== "source-change-reconciled",
  );
  const markerEvents = journal.events.filter(
    (event) => event.event === "source-change-reconciled",
  );
  if (
    expectedEvents?.length !== lifecycleEvents.length ||
    lifecycleEvents.some(
      (event, index) =>
        event.event !== expectedEvents?.[index]?.event ||
        event.evidenceFingerprint !== expectedEvents?.[index]?.evidenceFingerprint,
    ) ||
    markerEvents.some(
      (event) => journal.events.indexOf(event) < expectedEvents.length,
    ) ||
    journal.expectedAuthorityFingerprint !== null ||
    journal.reason !== null ||
    journal.batchId !== `legacy-${journal.planFingerprint.slice("sha256:".length)}` ||
    journal.generationId !== journal.batchId ||
    journal.planFingerprint !==
      digest(jsonBytes({
        sourceFingerprint: journal.sourceFingerprint,
        targetFingerprint: journal.targetFingerprint,
      }))
  ) return false;

  const markerKeys = new Set<string>();
  for (const event of markerEvents) {
    const markerKey = `${event.relatedBatchId}\0${event.relatedSourceFingerprint}\0${event.relatedPlanFingerprint}`;
    if (
      event.relatedBatchId !==
        `legacy-${event.relatedPlanFingerprint?.slice("sha256:".length)}` ||
      event.evidenceFingerprint !== event.relatedPlanFingerprint ||
      event.relatedSourceFingerprint === journal.sourceFingerprint ||
      markerKeys.has(markerKey)
    ) return false;
    markerKeys.add(markerKey);
  }

  const sourceDirectory = storagePath(
    projectRoot,
    "sources",
    journal.sourceFingerprint.slice("sha256:".length),
  );
  const sourceBackupExists = directoryExistsSafely(sourceDirectory);
  if (sourceBackupExists === null) return false;
  if (sourceBackupExists) {
    verifySourceBackup(projectRoot, journal.sourceFingerprint);
    requiredSources.add(journal.sourceFingerprint.slice("sha256:".length));
  } else if (journal.state !== "planned") {
    return false;
  }

  const generationDirectory = storagePath(
    projectRoot,
    "generations",
    journal.generationId,
  );
  const generationExists = directoryExistsSafely(generationDirectory);
  if (generationExists === null) return false;
  if (generationExists) {
    verifyGeneration(projectRoot, journal.generationId, {
      batchId: journal.batchId,
      sourceFingerprint: journal.sourceFingerprint,
      targetFingerprint: journal.targetFingerprint,
    });
    requiredGenerations.add(journal.generationId);
  } else if (journal.state === "staged" || journal.state === "validated") {
    return false;
  }
  if (journal.state === "planned" && generationExists) return false;
  return true;
}

/**
 * Validate all authority-less P36 artifacts before offering an approved
 * replacement batch. Only intact pre-commit journals with intact snapshots can
 * be superseded; malformed, committed, overlay, or unreferenced artifacts
 * remain fail-closed.
 */
function readRecoverablePrecommitJournals(
  request: LegacyTaskBatchRequest,
): JournalSnapshot[] | null {
  const normalized = normalizeRequest(request);
  if (
    !normalized ||
    !validatePlanAtRoot(normalized.projectRoot, normalized.plan) ||
    legacyTaskBatchTaskIdConflict(normalized.projectRoot, normalized.targets)
  ) return null;

  try {
    if (readAuthoritySnapshot(normalized.projectRoot)) return null;
    const store = path.join(normalized.projectRoot, STORAGE_RELATIVE);
    const storeEntries = directoryEntries(store);
    if (
      !storeEntries?.includes("journals") ||
      storeEntries.some((entry) => !["journals", "sources", "generations"].includes(entry))
    ) return null;
    for (const name of ["sources", "generations"] as const) {
      if (storeEntries.includes(name) && directoryEntries(path.join(store, name)) === null)
        return null;
    }

    const journalDirectory = path.join(store, "journals");
    const journalNames = directoryEntries(journalDirectory);
    if (!journalNames?.length) return null;
    const journals: JournalSnapshot[] = [];
    const journalIds = new Set<string>();
    const requiredSources = new Set<string>();
    const requiredGenerations = new Set<string>();
    let hasCurrentBatch = false;
    for (const name of journalNames) {
      const match = /^(legacy-[a-f0-9]{64})\.json$/.exec(name);
      const batchId = match?.[1];
      if (!batchId) return null;
      const snapshot = readJournal(normalized.projectRoot, batchId);
      if (!snapshot?.journal) return null;
      const journal = snapshot.journal;
      if (
        journal.batchId !== batchId ||
        journalIds.has(batchId) ||
        !journalMatchesPrecommitEvidence(
          normalized.projectRoot,
          journal,
          requiredSources,
          requiredGenerations,
        )
      ) return null;
      journalIds.add(batchId);

      const isCurrent = journal.batchId === normalized.batchId;
      if (isCurrent) {
        if (
          journal.sourceFingerprint !== normalized.sourceFingerprint ||
          journal.targetFingerprint !== normalized.targetFingerprint ||
          journal.planFingerprint !== normalized.planFingerprint
        ) return null;
        hasCurrentBatch = true;
      } else if (journal.sourceFingerprint === normalized.sourceFingerprint) {
        // Same-source competing plans need explicit reconciliation semantics.
        return null;
      }
      journals.push(snapshot);
    }

    const actualSources = storeEntries.includes("sources")
      ? directoryEntries(path.join(store, "sources"))
      : [];
    const actualGenerations = storeEntries.includes("generations")
      ? directoryEntries(path.join(store, "generations"))
      : [];
    if (
      !actualSources ||
      !actualGenerations ||
      actualSources.some((name) => !/^[a-f0-9]{64}$/.test(name) || !requiredSources.has(name)) ||
      actualSources.length !== requiredSources.size ||
      actualGenerations.some((name) => !requiredGenerations.has(name)) ||
      actualGenerations.length !== requiredGenerations.size
    ) return null;

    // A changed-source retry can have no journal for the new batch yet. A
    // same-batch retry is also accepted here after validating every artifact.
    return hasCurrentBatch || journals.some(
      ({ journal }) => journal.sourceFingerprint !== normalized.sourceFingerprint,
    ) ? journals : null;
  } catch {
    return null;
  }
}

/** Pure preflight for explicitly approved recovery from source-change residue. */
export function canReconcileLegacyTaskBatchSourceChangeWithoutAuthority(
  request: LegacyTaskBatchRequest,
): boolean {
  return readRecoverablePrecommitJournals(request) !== null;
}

function reconcilePrecommitJournals(
  request: LegacyTaskBatchRequest,
  occurredAt: string,
  onWrite: () => void,
): void {
  const normalized = normalizeRequest(request);
  if (!normalized) throw new Error("invalid-or-blocked-source-plan");
  const snapshots = readRecoverablePrecommitJournals(request);
  if (!snapshots) throw new Error("legacy-task-migration-authority-missing-with-residual-state");
  assertSourceUnchanged(normalized);
  for (const snapshot of snapshots) {
    const old = snapshot.journal;
    if (old.batchId === normalized.batchId) continue;
    const alreadyRecorded = old.events.some(
      (event) => event.event === "source-change-reconciled" &&
        event.relatedBatchId === normalized.batchId &&
        event.relatedSourceFingerprint === normalized.sourceFingerprint &&
        event.relatedPlanFingerprint === normalized.planFingerprint,
    );
    if (alreadyRecorded) continue;
    const reconciled: LegacyTaskBatchJournal = {
      ...old,
      updatedAt: occurredAt,
      events: [
        ...old.events,
        {
          sequence: old.events.length + 1,
          at: occurredAt,
          event: "source-change-reconciled",
          evidenceFingerprint: normalized.planFingerprint,
          relatedBatchId: normalized.batchId,
          relatedSourceFingerprint: normalized.sourceFingerprint,
          relatedPlanFingerprint: normalized.planFingerprint,
        },
      ],
    };
    writeJournal(normalized.projectRoot, old.batchId, snapshot.fingerprint, reconciled);
    onWrite();
  }
  assertSourceUnchanged(normalized);
}

/**
 * Prepare a complete source-preserving migration batch outside `.pactile/tasks`.
 * The original files are never rewritten. The entire Task/needs-reconciliation
 * generation becomes visible to the Kernel through one atomic pointer CAS.
 */
async function runLegacyTaskBatchUnlocked(
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

  const taskIdConflict = legacyTaskBatchTaskIdConflict(normalized.projectRoot, normalized.targets);
  if (taskIdConflict) return makeResult("blocked", taskIdConflict, normalized, false, null);

  let currentSourceMatches: boolean;
  try {
    currentSourceMatches = sourceMatchesPlan(normalized);
  } catch {
    return makeResult(
      "blocked",
      "source-preflight-unavailable",
      normalized,
      false,
      null,
    );
  }
  if (!currentSourceMatches)
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

  if (authorityAtStart) {
    if (
      authorityAtStart.authority.sourceFingerprint !==
      normalized.sourceFingerprint
    ) {
      return makeResult(
        "review",
        "migration-authority-source-changed-after-commit",
        normalized,
        false,
        null,
      );
    }
    if (authorityAtStart.authority.batchId !== normalized.batchId) {
      return makeResult(
        "review",
        "migration-authority-already-committed",
        normalized,
        false,
        null,
      );
    }
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

  let reconcileResidualState = false;
  if (!authorityAtStart) {
    try {
      assertLegacyTaskMigrationAuthorityOrCleanStore(
        normalized.projectRoot,
      );
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : String(error);
      const changedSourceCanReconcile =
        canReconcileLegacyTaskBatchSourceChangeWithoutAuthority(request);
      const recoverableMissingAuthority =
        reason ===
          "legacy-task-migration-authority-missing-with-residual-state" &&
        (changedSourceCanReconcile ||
          hasOnlyExpectedJournalLock(normalized.projectRoot, normalized.batchId));
      if (!recoverableMissingAuthority) {
        return makeResult("review", reason, normalized, false, null);
      }
      reconcileResidualState = changedSourceCanReconcile;
    }
  }

  const occurredAt = options.occurredAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(occurredAt)))
    return makeResult("blocked", "invalid-event-time", normalized, false, null);
  let snapshot: JournalSnapshot | null = null;
  let wrote = false;
  let resumed = false;
  try {
    if (reconcileResidualState)
      reconcilePrecommitJournals(request, occurredAt, () => { wrote = true; });
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
        const taskIdConflict = legacyTaskBatchTaskIdConflict(normalized.projectRoot, normalized.targets);
        if (taskIdConflict) {
          const review = nextJournal(
            snapshot.journal,
            "review",
            "needs-review",
            normalized.targetFingerprint,
            occurredAt,
            taskIdConflict,
          );
          snapshot = commitJournal(normalized.projectRoot, snapshot, review);
          return makeResult("review", taskIdConflict, normalized, wrote, snapshot.journal);
        }
        const authority: LegacyTaskBatchAuthority = {
          schemaVersion: 1,
          kind: "prepared-legacy-task-batch",
          visibility: "active-v2",
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

export async function runLegacyTaskBatch(
  request: LegacyTaskBatchRequest,
  options: LegacyTaskBatchOptions = {},
): Promise<LegacyTaskBatchResult> {
  const normalized = normalizeRequest(request);
  if (!normalized || options.approved !== true || options.dryRun)
    return runLegacyTaskBatchUnlocked(request, options);

  const lockPath = path.join(
    normalized.projectRoot,
    ".pactile",
    "runtime",
    "legacy-task-migration-batch.lock",
  );
  try {
    ensureDirectory(normalized.projectRoot, path.dirname(lockPath));
    return await withAsyncLock(normalized.projectRoot, lockPath, () =>
      runLegacyTaskBatchUnlocked(request, options),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : "migration-interrupted";
    if (reason === "migration-lock-unavailable") {
      try {
        assertLegacyTaskMigrationAuthorityOrCleanStore(normalized.projectRoot);
      } catch (storeError) {
        const storeReason = storeError instanceof Error ? storeError.message : String(storeError);
        if (
          storeReason === "legacy-task-migration-authority-missing-with-residual-state" &&
          !canResumeLegacyTaskBatchWithoutAuthority(request)
        ) return makeResult("review", storeReason, normalized, false, null);
      }
    }
    return makeResult(
      "interrupted",
      reason,
      normalized,
      false,
      null,
    );
  }
}
