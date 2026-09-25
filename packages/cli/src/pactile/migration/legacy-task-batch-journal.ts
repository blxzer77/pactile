import path from "node:path";

import { verifyGeneration } from "./legacy-task-batch-generation.js";
import {
  ensureDirectory,
  atomicReplace,
  readRegularFile,
  storagePath,
  withLock,
} from "./legacy-task-batch-io.js";
import { verifySourceBackup } from "./legacy-task-batch-source.js";
import {
  FINGERPRINT,
  JOURNAL_EVENTS,
  JOURNAL_STATES,
  digest,
  jsonBytes,
  type AuthoritySnapshot,
  type JournalSnapshot,
  type LegacyTaskBatchAuthority,
  type LegacyTaskBatchJournal,
} from "./legacy-task-batch-types.js";
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

export function readJournal(
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

export function writeJournal(
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

export function readAuthoritySnapshot(
  projectRoot: string,
): AuthoritySnapshot | null {
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

export function writeAuthority(
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
