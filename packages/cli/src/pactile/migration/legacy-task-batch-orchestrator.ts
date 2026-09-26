import fs from "node:fs";
import path from "node:path";

import {
  scanLegacyTaskMigration,
  type LegacyTaskMigrationPlan,
} from "../../core/task/legacy-task-migration.js";
import {
  JOURNAL_EVENTS,
  digest,
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
} from "./legacy-task-batch-types.js";
import {
  assertSourceUnchanged,
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

/**
 * A missing pointer may be retried only for a matching, pre-commit journal
 * whose backup/staged generation verifies and which has no post-commit overlay.
 */
export function canResumeLegacyTaskBatchWithoutAuthority(
  request: LegacyTaskBatchRequest,
): boolean {
  const normalized = normalizeRequest(request);
  if (
    !normalized ||
    !validatePlanAtRoot(normalized.projectRoot, normalized.plan)
  ) return false;
  try {
    if (readAuthoritySnapshot(normalized.projectRoot)) return false;
    const snapshot = readJournal(normalized.projectRoot, normalized.batchId);
    if (!snapshot) return false;
    const journal = snapshot.journal;
    const finalEvent = journal.events.at(-1)?.event;
    const stateEvent: Partial<Record<LegacyTaskBatchJournal["state"], string>> = {
      planned: "planned",
      "backed-up": "source-backed-up",
      staged: "targets-staged",
      validated: "targets-validated",
    };
    if (
      !stateEvent[journal.state] ||
      finalEvent !== stateEvent[journal.state] ||
      journal.batchId !== normalized.batchId ||
      journal.generationId !== normalized.generationId ||
      journal.sourceFingerprint !== normalized.sourceFingerprint ||
      journal.targetFingerprint !== normalized.targetFingerprint ||
      journal.planFingerprint !== normalized.planFingerprint ||
      journal.expectedAuthorityFingerprint !== null
    ) return false;

    for (const relative of [
      ".pactile/runtime/legacy-task-migrations/overlay-journal",
      ".pactile/runtime/legacy-task-migrations/overrides",
    ]) {
      try {
        fs.lstatSync(path.join(normalized.projectRoot, relative));
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
    }
    if (journal.state !== "planned")
      verifySourceBackup(normalized.projectRoot, normalized.sourceFingerprint);
    if (journal.state === "staged" || journal.state === "validated")
      verifyGeneration(normalized.projectRoot, normalized.generationId, {
        batchId: normalized.batchId,
        sourceFingerprint: normalized.sourceFingerprint,
        targetFingerprint: normalized.targetFingerprint,
      });
    return true;
  } catch {
    return false;
  }
}

/**
 * Prepare a complete source-preserving migration batch outside `.pactile/tasks`.
 * The original files are never rewritten. The entire Task/needs-reconciliation
 * generation becomes visible to the Kernel through one atomic pointer CAS.
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
