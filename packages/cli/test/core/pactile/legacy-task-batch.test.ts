import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildLegacyTaskV2Import } from "../../../src/core/task/legacy-task-v2-import.js";
import { readLegacyTaskMigrationView } from "../../../src/core/task/legacy-task-migration-reader.js";
import { scanLegacyTaskMigration } from "../../../src/core/task/legacy-task-migration.js";
import {
  readPreparedLegacyTaskBatch,
  runLegacyTaskBatch,
  type LegacyTaskBatchRequest,
  type LegacyTaskBatchTargetFile,
} from "../../../src/pactile/migration/legacy-task-batch.js";
import {
  applyLegacyTaskUpdate,
  inspectLegacyTaskUpdate,
} from "../../../src/pactile/migration/legacy-task-update.js";

const temporaryRoots: string[] = [];

function tempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-p36-batch-"));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, ".pactile", "tasks", "09-26-legacy"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, ".pactile", "tasks", "09-26-legacy", "task.json"),
    `${JSON.stringify(
      {
        id: "legacy-sample",
        status: "planning",
        user_extension: { preserve: true },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, ".pactile", "tasks", "09-26-legacy", "prd.md"),
    "# User-authored legacy PRD\n\nKeep exact source text.\n",
    "utf8",
  );
  return root;
}

function requestFor(
  projectRoot: string,
  targets: readonly LegacyTaskBatchTargetFile[] = [
    {
      path: "prepared/source-index.json",
      bytes: Buffer.from('{"kind":"test-only-staged-envelope"}\n', "utf8"),
    },
  ],
): LegacyTaskBatchRequest {
  return {
    projectRoot,
    plan: scanLegacyTaskMigration({ projectRoot }),
    targets,
  };
}

function storePath(projectRoot: string, ...parts: string[]): string {
  return path.join(
    projectRoot,
    ".pactile",
    "runtime",
    "legacy-task-migrations",
    ...parts,
  );
}

function rewriteTaskJsonWithUserNote(taskPath: string, note: string): void {
  const value = JSON.parse(fs.readFileSync(taskPath, "utf8")) as {
    user_extension?: Record<string, unknown>;
  };
  value.user_extension ??= {};
  value.user_extension.recovery_note = note;
  fs.writeFileSync(taskPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(bytes: Buffer): string {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("legacy Task batch staging transaction", () => {
  it("keeps dry-run and cancelled batches completely write-free", async () => {
    const root = tempProject();
    const request = requestFor(root);
    const dryRun = await runLegacyTaskBatch(request, {
      dryRun: true,
      approved: true,
    });
    expect(dryRun).toMatchObject({
      status: "dry-run",
      wrote: false,
      journal: null,
    });
    expect(fs.existsSync(storePath(root))).toBe(false);

    const cancelled = await runLegacyTaskBatch(request, { approved: false });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      wrote: false,
      journal: null,
    });
    expect(fs.existsSync(storePath(root))).toBe(false);
    expect(readPreparedLegacyTaskBatch(root)).toBeNull();
  });

  it("backs up exact source bytes and switches only the staged-batch pointer", async () => {
    const root = tempProject();
    const sourceTask = path.join(
      root,
      ".pactile",
      "tasks",
      "09-26-legacy",
      "task.json",
    );
    const originalTaskBytes = fs.readFileSync(sourceTask);
    const request = requestFor(root);
    const result = await runLegacyTaskBatch(request, { approved: true });

    expect(result.status).toBe("completed");
    if (result.status !== "completed")
      throw new Error("expected completed result");
    expect(result.journal.state).toBe("committed");
    expect(result.wrote).toBe(true);
    expect(fs.readFileSync(sourceTask).equals(originalTaskBytes)).toBe(true);
    expect(
      fs.existsSync(
        path.join(root, ".pactile", "tasks", "09-26-legacy", "kernel.json"),
      ),
    ).toBe(false);

    const backupTask = path.join(
      storePath(
        root,
        "sources",
        result.sourceFingerprint.slice("sha256:".length),
      ),
      "files",
      ".pactile",
      "tasks",
      "09-26-legacy",
      "task.json",
    );
    expect(fs.readFileSync(backupTask).equals(originalTaskBytes)).toBe(true);
    expect(
      fs.readFileSync(backupTask).includes(Buffer.from('"user_extension"')),
    ).toBe(true);

    const stagedFile = path.join(
      storePath(root, "generations", result.generationId, "files"),
      "prepared",
      "source-index.json",
    );
    expect(fs.readFileSync(stagedFile)).toEqual(request.targets[0]?.bytes);
    expect(readPreparedLegacyTaskBatch(root)).toMatchObject({
      kind: "prepared-legacy-task-batch",
      visibility: "active-v2",
      batchId: result.batchId,
      generationId: result.generationId,
    });
    expect(
      fs.readFileSync(path.join(storePath(root, "authority.json")), "utf8"),
    ).toContain('"visibility": "active-v2"');

    const pointerBeforeRetry = fs.readFileSync(
      storePath(root, "authority.json"),
    );
    const repeated = await runLegacyTaskBatch(request, { approved: true });
    expect(repeated).toMatchObject({
      status: "completed",
      resumed: true,
      wrote: false,
    });
    expect(
      fs
        .readFileSync(storePath(root, "authority.json"))
        .equals(pointerBeforeRetry),
    ).toBe(true);
  });

  it("refuses a changed source fingerprint before writing any migration state", async () => {
    const root = tempProject();
    const request = requestFor(root);
    const taskPath = path.join(
      root,
      ".pactile",
      "tasks",
      "09-26-legacy",
      "task.json",
    );
    fs.appendFileSync(taskPath, "\n ", "utf8");

    const result = await runLegacyTaskBatch(request, { approved: true });
    expect(result).toMatchObject({
      status: "blocked",
      reason: "migration-source-changed",
      wrote: false,
    });
    expect(fs.existsSync(storePath(root))).toBe(false);
    expect(fs.readFileSync(taskPath, "utf8")).toMatch(/\n $/);
  });

  it.each(["source-backed-up", "targets-staged", "targets-validated"] as const)(
    "resumes idempotently after interruption at %s",
    async (phase) => {
      const root = tempProject();
      const request = requestFor(root);
      let interrupted = false;
      const first = await runLegacyTaskBatch(request, {
        approved: true,
        onPhase(current) {
          if (current === phase && !interrupted) {
            interrupted = true;
            throw new Error(`simulated-interruption:${phase}`);
          }
        },
      });
      expect(first.status).toBe("interrupted");
      expect(readPreparedLegacyTaskBatch(root)).toBeNull();
      expect(interrupted).toBe(true);

      const recovered = await runLegacyTaskBatch(request, { approved: true });
      expect(recovered.status).toBe("completed");
      if (recovered.status !== "completed")
        throw new Error("expected completed result");
      expect(recovered.resumed).toBe(true);
      expect(recovered.journal.state).toBe("committed");
      expect(readPreparedLegacyTaskBatch(root)?.batchId).toBe(
        recovered.batchId,
      );
    },
  );

  it("recovers a crash after pointer replacement but before journal completion", async () => {
    const root = tempProject();
    const request = requestFor(root);
    const first = await runLegacyTaskBatch(request, {
      approved: true,
      onPhase(phase) {
        if (phase === "authority-committed")
          throw new Error("simulated-crash-after-pointer");
      },
    });
    expect(first.status).toBe("interrupted");
    expect(readPreparedLegacyTaskBatch(root)?.batchId).toBe(first.batchId);

    const recovered = await runLegacyTaskBatch(request, { approved: true });
    expect(recovered.status).toBe("completed");
    if (recovered.status !== "completed")
      throw new Error("expected completed result");
    expect(recovered.resumed).toBe(true);
    expect(recovered.journal.state).toBe("committed");
  });

  it.each(["overlay-journal", "overrides"] as const)(
    "blocks direct API recovery from a validated journal when %s evidence exists",
    async (artifact) => {
      const root = tempProject();
      const request = requestFor(root);
      const sourcePath = path.join(
        root,
        ".pactile",
        "tasks",
        "09-26-legacy",
        "task.json",
      );
      const sourceBefore = fs.readFileSync(sourcePath);
      const interrupted = await runLegacyTaskBatch(request, {
        approved: true,
        onPhase(phase) {
          if (phase === "targets-validated")
            throw new Error("simulated-process-interruption-before-pointer");
        },
      });
      expect(interrupted).toMatchObject({
        status: "interrupted",
        journal: { state: "validated" },
      });
      if (!interrupted.batchId || !interrupted.generationId)
        throw new Error("expected persisted batch identity");
      const journalFile = storePath(
        root,
        "journals",
        `${interrupted.batchId}.json`,
      );
      const stagedFile = storePath(
        root,
        "generations",
        interrupted.generationId,
        "files",
        "prepared",
        "source-index.json",
      );
      const journalBefore = fs.readFileSync(journalFile);
      const stagedBefore = fs.readFileSync(stagedFile);
      const overlayEvidence = storePath(root, artifact);
      fs.mkdirSync(overlayEvidence, { recursive: true });

      const retry = await runLegacyTaskBatch(request, { approved: true });

      expect(retry).toMatchObject({
        status: "review",
        reason: "legacy-task-migration-authority-missing-with-residual-state",
        wrote: false,
      });
      expect(
        fs.existsSync(storePath(root, "authority.json")),
      ).toBe(false);
      expect(fs.readFileSync(sourcePath).equals(sourceBefore)).toBe(true);
      expect(fs.readFileSync(journalFile).equals(journalBefore)).toBe(true);
      expect(fs.readFileSync(stagedFile).equals(stagedBefore)).toBe(true);
      expect(fs.existsSync(overlayEvidence)).toBe(true);
    },
  );

  it("blocks direct API replay of a committed journal when its authority pointer is missing", async () => {
    const root = tempProject();
    const request = requestFor(root);
    const sourcePath = path.join(
      root,
      ".pactile",
      "tasks",
      "09-26-legacy",
      "task.json",
    );
    const sourceBefore = fs.readFileSync(sourcePath);
    const committed = await runLegacyTaskBatch(request, { approved: true });
    expect(committed.status).toBe("completed");
    if (committed.status !== "completed")
      throw new Error("expected a committed batch");
    const journalFile = storePath(
      root,
      "journals",
      `${committed.batchId}.json`,
    );
    const stagedFile = storePath(
      root,
      "generations",
      committed.generationId,
      "files",
      "prepared",
      "source-index.json",
    );
    const journalBefore = fs.readFileSync(journalFile);
    const stagedBefore = fs.readFileSync(stagedFile);
    const authorityPath = storePath(root, "authority.json");
    fs.rmSync(authorityPath);

    const retry = await runLegacyTaskBatch(request, { approved: true });

    expect(retry).toMatchObject({
      status: "review",
      reason: "legacy-task-migration-authority-missing-with-residual-state",
      wrote: false,
    });
    expect(fs.existsSync(authorityPath)).toBe(false);
    expect(fs.readFileSync(sourcePath).equals(sourceBefore)).toBe(true);
    expect(fs.readFileSync(journalFile).equals(journalBefore)).toBe(true);
    expect(fs.readFileSync(stagedFile).equals(stagedBefore)).toBe(true);
  });

  it("does not commit a batch that fails staged validation", async () => {
    const root = tempProject();
    const request = requestFor(root);
    const result = await runLegacyTaskBatch(request, {
      approved: true,
      validateStaged: () => false,
    });
    expect(result).toMatchObject({
      status: "review",
      reason: "migration-validation-failed",
      wrote: true,
    });
    expect(readPreparedLegacyTaskBatch(root)).toBeNull();
    expect(result.journal?.state).toBe("review");
  });

  it("rechecks the source fingerprint after staging and before commit", async () => {
    const root = tempProject();
    const request = requestFor(root);
    let changed = false;
    const result = await runLegacyTaskBatch(request, {
      approved: true,
      onPhase(phase) {
        if (phase === "targets-validated" && !changed) {
          changed = true;
          fs.appendFileSync(
            path.join(root, ".pactile", "tasks", "09-26-legacy", "prd.md"),
            "\nuser edit after preflight\n",
            "utf8",
          );
        }
      },
    });
    expect(result).toMatchObject({
      status: "blocked",
      reason: "migration-source-changed",
      wrote: true,
    });
    expect(readPreparedLegacyTaskBatch(root)).toBeNull();
  });

  it("reconciles a user source rewrite after validation without losing the old snapshot", async () => {
    const root = tempProject();
    const sourceTaskPath = path.join(
      root,
      ".pactile",
      "tasks",
      "09-26-legacy",
      "task.json",
    );
    const originalSource = fs.readFileSync(sourceTaskPath);
    const firstPlan = scanLegacyTaskMigration({ projectRoot: root });
    const firstTargets = buildLegacyTaskV2Import(firstPlan).targets;
    const firstRequest = {
      projectRoot: root,
      plan: firstPlan,
      targets: firstTargets,
    };
    const first = await runLegacyTaskBatch(firstRequest, {
      approved: true,
      onPhase(phase) {
        if (phase === "targets-validated")
          fs.appendFileSync(sourceTaskPath, "\n ", "utf8");
      },
    });
    expect(first).toMatchObject({
      status: "blocked",
      reason: "migration-source-changed",
      journal: { state: "validated" },
    });
    if (!first.batchId || !first.generationId || !first.sourceFingerprint)
      throw new Error("expected a preserved pre-commit batch");
    const changedSource = fs.readFileSync(sourceTaskPath);
    expect(changedSource.equals(originalSource)).toBe(false);
    expect(readPreparedLegacyTaskBatch(root)).toBeNull();
    expect(() => readLegacyTaskMigrationView(root)).toThrow(
      /authority-missing-with-residual-state/,
    );

    const journalPath = storePath(root, "journals", `${first.batchId}.json`);
    const oldJournal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
      events: readonly unknown[];
    };
    const oldBackup = storePath(
      root,
      "sources",
      first.sourceFingerprint.slice("sha256:".length),
      "files",
      ".pactile",
      "tasks",
      "09-26-legacy",
      "task.json",
    );
    const firstTarget = firstTargets[0];
    if (!firstTarget) throw new Error("expected a staged target");
    const oldGeneration = storePath(
      root,
      "generations",
      first.generationId,
      "files",
      ...firstTarget.path.split("/"),
    );
    const oldGenerationBytes = fs.readFileSync(oldGeneration);

    const inspection = inspectLegacyTaskUpdate(root);
    expect(inspection.status).toBe("ready");
    const recovered = await applyLegacyTaskUpdate(root);
    expect(recovered.status).toBe("completed");
    expect(fs.readFileSync(sourceTaskPath)).toEqual(changedSource);
    expect(fs.readFileSync(oldBackup)).toEqual(originalSource);
    expect(fs.readFileSync(oldGeneration)).toEqual(oldGenerationBytes);

    const reconciledJournal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
      state: string;
      events: readonly { event: string; relatedSourceFingerprint?: string }[];
    };
    expect(reconciledJournal.state).toBe("validated");
    expect(reconciledJournal.events.slice(0, oldJournal.events.length)).toEqual(
      oldJournal.events,
    );
    expect(reconciledJournal.events.at(-1)).toMatchObject({
      event: "source-change-reconciled",
    });
    expect(reconciledJournal.events.at(-1)?.relatedSourceFingerprint).toBe(
      scanLegacyTaskMigration({ projectRoot: root }).sourceFingerprint,
    );
    expect(readPreparedLegacyTaskBatch(root)?.sourceFingerprint).toBe(
      scanLegacyTaskMigration({ projectRoot: root }).sourceFingerprint,
    );
    expect(readLegacyTaskMigrationView(root)).not.toBeNull();
  });

  it("retries an interrupted replacement and reconciles a second source rewrite", async () => {
    const root = tempProject();
    const sourceTaskPath = path.join(
      root,
      ".pactile",
      "tasks",
      "09-26-legacy",
      "task.json",
    );
    const firstRequest: LegacyTaskBatchRequest = {
      projectRoot: root,
      plan: scanLegacyTaskMigration({ projectRoot: root }),
      targets: buildLegacyTaskV2Import(
        scanLegacyTaskMigration({ projectRoot: root }),
      ).targets,
    };
    const first = await runLegacyTaskBatch(firstRequest, {
      approved: true,
      onPhase(phase) {
        if (phase === "targets-validated")
          rewriteTaskJsonWithUserNote(sourceTaskPath, "first user edit");
      },
    });
    expect(first.status).toBe("blocked");

    const replacementPlan = scanLegacyTaskMigration({ projectRoot: root });
    const replacementRequest: LegacyTaskBatchRequest = {
      projectRoot: root,
      plan: replacementPlan,
      targets: buildLegacyTaskV2Import(replacementPlan).targets,
    };
    const interrupted = await runLegacyTaskBatch(replacementRequest, {
      approved: true,
      onPhase(phase) {
        if (phase === "targets-staged")
          throw new Error("simulated-recovery-interruption");
      },
    });
    expect(interrupted).toMatchObject({
      status: "interrupted",
      journal: { state: "staged" },
    });
    if (!first.batchId) throw new Error("expected the first journal to remain");
    const firstJournalPath = storePath(root, "journals", `${first.batchId}.json`);
    const firstJournalAfterReconcile = fs.readFileSync(firstJournalPath);
    expect(readPreparedLegacyTaskBatch(root)).toBeNull();
    expect(() => readLegacyTaskMigrationView(root)).toThrow(
      /authority-missing-with-residual-state/,
    );

    const recoveredPlan = scanLegacyTaskMigration({ projectRoot: root });
    const recoveredRequest: LegacyTaskBatchRequest = {
      projectRoot: root,
      plan: recoveredPlan,
      targets: buildLegacyTaskV2Import(recoveredPlan).targets,
    };
    const secondRewrite = await runLegacyTaskBatch(recoveredRequest, {
      approved: true,
      onPhase(phase) {
        if (phase === "targets-validated")
          rewriteTaskJsonWithUserNote(sourceTaskPath, "second user edit");
      },
    });
    expect(secondRewrite).toMatchObject({
      status: "blocked",
      reason: "migration-source-changed",
      journal: { state: "validated" },
    });
    expect(fs.readFileSync(firstJournalPath)).toEqual(firstJournalAfterReconcile);

    const finalInspection = inspectLegacyTaskUpdate(root);
    expect(finalInspection.status).toBe("ready");
    const finalRecovery = await applyLegacyTaskUpdate(root);
    expect(finalRecovery.status).toBe("completed");
    const finalSource = fs.readFileSync(sourceTaskPath);
    expect(finalSource.toString("utf8")).toContain("second user edit");
    expect(readPreparedLegacyTaskBatch(root)?.sourceFingerprint).toBe(
      scanLegacyTaskMigration({ projectRoot: root }).sourceFingerprint,
    );
    expect(readLegacyTaskMigrationView(root)).not.toBeNull();
  });

  it("does not reconcile changed-source residue without approval", async () => {
    const root = tempProject();
    const sourceTaskPath = path.join(
      root,
      ".pactile",
      "tasks",
      "09-26-legacy",
      "task.json",
    );
    const firstPlan = scanLegacyTaskMigration({ projectRoot: root });
    const first = await runLegacyTaskBatch(
      {
        projectRoot: root,
        plan: firstPlan,
        targets: buildLegacyTaskV2Import(firstPlan).targets,
      },
      {
        approved: true,
        onPhase(phase) {
          if (phase === "targets-validated")
            rewriteTaskJsonWithUserNote(sourceTaskPath, "unapproved user edit");
        },
      },
    );
    expect(first.status).toBe("blocked");
    if (!first.batchId) throw new Error("expected a journal to remain");
    const oldJournalPath = storePath(root, "journals", `${first.batchId}.json`);
    const journalBefore = fs.readFileSync(oldJournalPath);
    const sourceBefore = fs.readFileSync(sourceTaskPath);

    const newPlan = scanLegacyTaskMigration({ projectRoot: root });
    const refused = await runLegacyTaskBatch(
      {
        projectRoot: root,
        plan: newPlan,
        targets: buildLegacyTaskV2Import(newPlan).targets,
      },
      { approved: false },
    );
    expect(refused).toMatchObject({ status: "cancelled", wrote: false });
    expect(fs.readFileSync(oldJournalPath)).toEqual(journalBefore);
    expect(fs.readFileSync(sourceTaskPath)).toEqual(sourceBefore);
    expect(readPreparedLegacyTaskBatch(root)).toBeNull();
    expect(() => readLegacyTaskMigrationView(root)).toThrow(
      /authority-missing-with-residual-state/,
    );
  });

  it("rejects a duplicate-shaped journal alias before writing any reconciliation marker", async () => {
    const root = tempProject();
    const sourceTaskPath = path.join(
      root,
      ".pactile",
      "tasks",
      "09-26-legacy",
      "task.json",
    );
    const firstPlan = scanLegacyTaskMigration({ projectRoot: root });
    const first = await runLegacyTaskBatch(
      {
        projectRoot: root,
        plan: firstPlan,
        targets: buildLegacyTaskV2Import(firstPlan).targets,
      },
      {
        approved: true,
        onPhase(phase) {
          if (phase === "targets-validated")
            fs.appendFileSync(sourceTaskPath, "\n ", "utf8");
        },
      },
    );
    expect(first.status).toBe("blocked");
    if (!first.batchId) throw new Error("expected a preserved pre-commit journal");
    const originalJournalPath = storePath(root, "journals", `${first.batchId}.json`);
    const originalJournalBytes = fs.readFileSync(originalJournalPath);
    const aliasBatchId = `legacy-${"a".repeat(64)}`;
    if (aliasBatchId === first.batchId)
      throw new Error("synthetic alias must differ from the real batch id");
    const aliasPath = storePath(root, "journals", `${aliasBatchId}.json`);
    fs.writeFileSync(aliasPath, originalJournalBytes);
    const aliasJournalBytes = fs.readFileSync(aliasPath);
    const sourceBefore = fs.readFileSync(sourceTaskPath);

    const inspection = inspectLegacyTaskUpdate(root);
    expect(inspection).toMatchObject({
      status: "blocked",
      reason: "legacy-task-migration-authority-missing-with-residual-state",
    });
    const applied = await applyLegacyTaskUpdate(root);
    expect(applied).toMatchObject({ status: "blocked", batchResult: null });
    const currentPlan = scanLegacyTaskMigration({ projectRoot: root });
    const directRetry = await runLegacyTaskBatch(
      {
        projectRoot: root,
        plan: currentPlan,
        targets: buildLegacyTaskV2Import(currentPlan).targets,
      },
      { approved: true },
    );

    expect(directRetry).toMatchObject({
      status: "review",
      reason: "legacy-task-migration-authority-missing-with-residual-state",
      wrote: false,
    });
    expect(fs.readFileSync(originalJournalPath)).toEqual(originalJournalBytes);
    expect(fs.readFileSync(aliasPath)).toEqual(aliasJournalBytes);
    expect(fs.readFileSync(sourceTaskPath)).toEqual(sourceBefore);
    expect(readPreparedLegacyTaskBatch(root)).toBeNull();
    expect(fs.existsSync(storePath(root, "authority.json"))).toBe(false);
  });

  it("rejects an incomplete lifecycle event chain before recovering a changed source", async () => {
    const root = tempProject();
    const sourceTaskPath = path.join(
      root,
      ".pactile",
      "tasks",
      "09-26-legacy",
      "task.json",
    );
    const firstPlan = scanLegacyTaskMigration({ projectRoot: root });
    const first = await runLegacyTaskBatch(
      {
        projectRoot: root,
        plan: firstPlan,
        targets: buildLegacyTaskV2Import(firstPlan).targets,
      },
      {
        approved: true,
        onPhase(phase) {
          if (phase === "targets-validated")
            fs.appendFileSync(sourceTaskPath, "\n ", "utf8");
        },
      },
    );
    expect(first.status).toBe("blocked");
    if (!first.batchId) throw new Error("expected a preserved pre-commit journal");
    const journalPath = storePath(root, "journals", `${first.batchId}.json`);
    const malformed = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
      events: Record<string, unknown>[];
    };
    const validatedEvent = malformed.events.at(-1);
    if (!validatedEvent)
      throw new Error("expected a persisted targets-validated event");
    malformed.events = [{ ...validatedEvent, sequence: 1 }];
    fs.writeFileSync(journalPath, `${JSON.stringify(malformed, null, 2)}\n`, "utf8");
    const malformedJournalBytes = fs.readFileSync(journalPath);
    const sourceBefore = fs.readFileSync(sourceTaskPath);

    const inspection = inspectLegacyTaskUpdate(root);
    expect(inspection).toMatchObject({
      status: "blocked",
      reason: "legacy-task-migration-authority-missing-with-residual-state",
    });
    const applied = await applyLegacyTaskUpdate(root);
    expect(applied).toMatchObject({ status: "blocked", batchResult: null });
    const currentPlan = scanLegacyTaskMigration({ projectRoot: root });
    const directRetry = await runLegacyTaskBatch(
      {
        projectRoot: root,
        plan: currentPlan,
        targets: buildLegacyTaskV2Import(currentPlan).targets,
      },
      { approved: true },
    );

    expect(directRetry).toMatchObject({
      status: "review",
      reason: "legacy-task-migration-authority-missing-with-residual-state",
      wrote: false,
    });
    expect(fs.readFileSync(journalPath)).toEqual(malformedJournalBytes);
    expect(fs.readFileSync(sourceTaskPath)).toEqual(sourceBefore);
    expect(readPreparedLegacyTaskBatch(root)).toBeNull();
    expect(fs.existsSync(storePath(root, "authority.json"))).toBe(false);
  });

  it("recovers a backed-up journal when staging finished before its state transition", async () => {
    const root = tempProject();
    const sourceTaskPath = path.join(
      root,
      ".pactile",
      "tasks",
      "09-26-legacy",
      "task.json",
    );
    const firstPlan = scanLegacyTaskMigration({ projectRoot: root });
    const first = await runLegacyTaskBatch(
      {
        projectRoot: root,
        plan: firstPlan,
        targets: buildLegacyTaskV2Import(firstPlan).targets,
      },
      {
        approved: true,
        onPhase(phase) {
          if (phase === "targets-validated")
            rewriteTaskJsonWithUserNote(sourceTaskPath, "source changed after stage");
        },
      },
    );
    expect(first).toMatchObject({
      status: "blocked",
      journal: { state: "validated" },
    });
    if (!first.batchId) throw new Error("expected a preserved pre-commit journal");
    const journalPath = storePath(root, "journals", `${first.batchId}.json`);
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
      state: string;
      updatedAt: string;
      events: Record<string, unknown>[];
    };
    journal.state = "backed-up";
    journal.events = journal.events.slice(0, 2);
    journal.updatedAt = String(journal.events.at(-1)?.at);
    fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");

    const inspection = inspectLegacyTaskUpdate(root);
    expect(inspection.status).toBe("ready");
    const recovery = await applyLegacyTaskUpdate(root);
    expect(recovery.status).toBe("completed");
    expect(readPreparedLegacyTaskBatch(root)?.sourceFingerprint).toBe(
      scanLegacyTaskMigration({ projectRoot: root }).sourceFingerprint,
    );
    expect(readLegacyTaskMigrationView(root)).not.toBeNull();
  });

  it("reports partial reconciliation writes when a later journal write fails", async () => {
    const root = tempProject();
    const sourceTaskPath = path.join(
      root,
      ".pactile",
      "tasks",
      "09-26-legacy",
      "task.json",
    );
    const firstPlan = scanLegacyTaskMigration({ projectRoot: root });
    const first = await runLegacyTaskBatch(
      {
        projectRoot: root,
        plan: firstPlan,
        targets: buildLegacyTaskV2Import(firstPlan).targets,
      },
      {
        approved: true,
        onPhase(phase) {
          if (phase === "targets-validated")
            rewriteTaskJsonWithUserNote(sourceTaskPath, "first rewrite");
        },
      },
    );
    expect(first.status).toBe("blocked");

    const secondPlan = scanLegacyTaskMigration({ projectRoot: root });
    const second = await runLegacyTaskBatch(
      {
        projectRoot: root,
        plan: secondPlan,
        targets: buildLegacyTaskV2Import(secondPlan).targets,
      },
      {
        approved: true,
        onPhase(phase) {
          if (phase === "targets-validated")
            rewriteTaskJsonWithUserNote(sourceTaskPath, "second rewrite");
        },
      },
    );
    expect(second).toMatchObject({
      status: "blocked",
      reason: "migration-source-changed",
    });

    const firstJournalPath = storePath(root, "journals", `${first.batchId}.json`);
    const secondJournalPath = storePath(root, "journals", `${second.batchId}.json`);
    const firstJournalBeforeRecovery = fs.readFileSync(firstJournalPath);
    const secondJournalBeforeRecovery = fs.readFileSync(secondJournalPath);
    const recoveryPlan = scanLegacyTaskMigration({ projectRoot: root });
    const recoveryRequest = {
      projectRoot: root,
      plan: recoveryPlan,
      targets: buildLegacyTaskV2Import(recoveryPlan).targets,
    };
    const originalRename = fs.renameSync.bind(fs);
    let renameCount = 0;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      renameCount += 1;
      if (renameCount === 2)
        throw new Error("simulated-second-journal-write-failure");
      return originalRename(...args);
    });
    let recovery: Awaited<ReturnType<typeof runLegacyTaskBatch>>;
    try {
      recovery = await runLegacyTaskBatch(recoveryRequest, { approved: true });
    } finally {
      renameSpy.mockRestore();
    }

    expect(recovery).toMatchObject({
      status: "interrupted",
      reason: "simulated-second-journal-write-failure",
      wrote: true,
    });
    expect(fs.readFileSync(firstJournalPath)).not.toEqual(firstJournalBeforeRecovery);
    expect(fs.readFileSync(secondJournalPath)).toEqual(secondJournalBeforeRecovery);
    expect(readPreparedLegacyTaskBatch(root)).toBeNull();
    expect(fs.existsSync(storePath(root, "authority.json"))).toBe(false);
  });

  it("keeps a committed V2 pointer active and refuses re-import after later source edits", async () => {
    const root = tempProject();
    const request = requestFor(root);
    const result = await runLegacyTaskBatch(request, { approved: true });
    expect(result.status).toBe("completed");
    const editedTaskPath = path.join(
      root,
      ".pactile",
      "tasks",
      "09-26-legacy",
      "task.json",
    );
    const editedTask = JSON.parse(
      fs.readFileSync(editedTaskPath, "utf8"),
    ) as Record<string, unknown>;
    editedTask.user_after_migration = "preserve this edit";
    fs.writeFileSync(
      editedTaskPath,
      `${JSON.stringify(editedTask, null, 2)}\n`,
      "utf8",
    );
    expect(readPreparedLegacyTaskBatch(root)?.batchId).toBe(result.batchId);
    const retry = await runLegacyTaskBatch(requestFor(root), {
      approved: true,
    });
    expect(retry).toMatchObject({
      status: "review",
      reason: "migration-authority-source-changed-after-commit",
      wrote: false,
    });
    expect(readPreparedLegacyTaskBatch(root)?.batchId).toBe(result.batchId);
  });

  it("blocks a competing batch while a validated generation lacks its authority pointer", async () => {
    const root = tempProject();
    const request = requestFor(root);
    let competitorResult: Awaited<
      ReturnType<typeof runLegacyTaskBatch>
    > | null = null;
    const result = await runLegacyTaskBatch(request, {
      approved: true,
      async onPhase(phase) {
        if (phase !== "targets-validated" || competitorResult !== null) return;
        competitorResult = await runLegacyTaskBatch(
          requestFor(root, [
            {
              path: "prepared/competitor.json",
              bytes: Buffer.from(
                '{"kind":"competing-staged-envelope"}\n',
                "utf8",
              ),
            },
          ]),
          { approved: true },
        );
      },
    });
    expect(competitorResult).toMatchObject({
      status: "review",
      reason: "legacy-task-migration-authority-missing-with-residual-state",
      wrote: false,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed")
      throw new Error("expected the original staged batch to commit");
    expect(readPreparedLegacyTaskBatch(root)?.batchId).toBe(result.batchId);
    expect(
      fs.existsSync(
        storePath(
          root,
          "generations",
          result.generationId,
          "files",
          "prepared",
          "competitor.json",
        ),
      ),
    ).toBe(false);
  });

  it("reclaims a journal lock only when its recorded process is confirmed dead", async () => {
    const root = tempProject();
    const request = requestFor(root);
    const dryRun = await runLegacyTaskBatch(request, { dryRun: true });
    if (dryRun.status !== "dry-run") throw new Error("expected dry-run result");
    const lockPath = storePath(root, "journals", `${dryRun.batchId}.json.lock`);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 123456789, token: "dead-owner-token" }),
      "utf8",
    );
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("process not found"), { code: "ESRCH" });
    });
    try {
      const result = await runLegacyTaskBatch(request, { approved: true });
      expect(result.status).toBe("completed");
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      processKill.mockRestore();
    }
  });

  it("does not steal a migration lock owned by a live process", async () => {
    const root = tempProject();
    const request = requestFor(root);
    const dryRun = await runLegacyTaskBatch(request, { dryRun: true });
    if (dryRun.status !== "dry-run") throw new Error("expected dry-run result");
    const lockPath = storePath(root, "journals", `${dryRun.batchId}.json.lock`);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const lockBytes = Buffer.from(
      JSON.stringify({ pid: process.pid, token: "live-owner-token" }),
      "utf8",
    );
    fs.writeFileSync(lockPath, lockBytes);

    const result = await runLegacyTaskBatch(request, { approved: true });
    expect(result).toMatchObject({
      status: "interrupted",
      reason: "migration-lock-unavailable",
      wrote: false,
    });
    expect(fs.readFileSync(lockPath).equals(lockBytes)).toBe(true);
    expect(readPreparedLegacyTaskBatch(root)).toBeNull();
  });

  it("keeps archived legacy records byte-identical and outside staged targets", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-p36-archive-"));
    temporaryRoots.push(root);
    const archivedDir = path.join(
      root,
      ".pactile",
      "tasks",
      "archive",
      "2026-09",
      "09-20-legacy-closed",
    );
    fs.mkdirSync(archivedDir, { recursive: true });
    const archivedTask = path.join(archivedDir, "task.json");
    fs.writeFileSync(
      archivedTask,
      '{"id":"legacy-closed","status":"completed"}\n',
    );
    const before = fs.readFileSync(archivedTask);
    const request = requestFor(root);
    expect(request.plan.tasks[0]?.archivedByPath).toBe(true);

    const result = await runLegacyTaskBatch(request, { approved: true });
    expect(result.status).toBe("completed");
    expect(fs.readFileSync(archivedTask).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(archivedDir, "kernel.json"))).toBe(false);
  });

  it("rejects a corrupt staged byte even when the authority pointer exists", async () => {
    const root = tempProject();
    const request = requestFor(root);
    const result = await runLegacyTaskBatch(request, { approved: true });
    expect(result.status).toBe("completed");
    if (result.status !== "completed")
      throw new Error("expected completed result");
    const stagedFile = path.join(
      storePath(root, "generations", result.generationId, "files", "prepared"),
      "source-index.json",
    );
    fs.writeFileSync(stagedFile, "tampered\n", "utf8");
    expect(() => readPreparedLegacyTaskBatch(root)).toThrow(
      "migration-authority-invalid",
    );
  });

  it("rejects archived output paths and preserves blocked source plans without writes", async () => {
    const root = tempProject();
    const pathRequest = requestFor(root, [
      { path: "archive/should-not-write.json", bytes: Buffer.from("{}\n") },
    ]);
    const invalidTarget = await runLegacyTaskBatch(pathRequest, {
      approved: true,
    });
    expect(invalidTarget).toMatchObject({ status: "blocked", wrote: false });
    expect(fs.existsSync(storePath(root))).toBe(false);

    const blockedFixture = path.resolve(
      process.cwd(),
      "test/fixtures/pactile/p36-legacy-task-source/input",
    );
    const blockedCopy = fs.mkdtempSync(
      path.join(os.tmpdir(), "pactile-p36-batch-blocked-"),
    );
    temporaryRoots.push(blockedCopy);
    const runtimePath = path.join(".pactile", "runtime");
    fs.cpSync(blockedFixture, blockedCopy, {
      recursive: true,
      filter(source) {
        const relative = path.relative(blockedFixture, source);
        return (
          relative !== runtimePath &&
          !relative.startsWith(`${runtimePath}${path.sep}`)
        );
      },
    });
    const orphanDir = path.join(
      blockedCopy,
      ".pactile",
      "tasks",
      "orphan-design-only",
    );
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(
      path.join(orphanDir, "design.md"),
      "A real unindexed legacy artifact.\n",
      "utf8",
    );
    const blockedRequest = requestFor(blockedCopy);
    expect(blockedRequest.plan.preflight.status).toBe("blocked");
    expect(blockedRequest.plan.findings).toContainEqual(
      expect.objectContaining({
        code: "orphan-task-artifacts",
        sourcePath: ".pactile/tasks/orphan-design-only",
      }),
    );
    const blocked = await runLegacyTaskBatch(blockedRequest, {
      approved: true,
    });
    expect(blocked).toMatchObject({ status: "blocked", wrote: false });
    expect(fs.existsSync(storePath(blockedCopy))).toBe(false);
    expect(fs.readFileSync(path.join(orphanDir, "design.md"), "utf8")).toBe(
      "A real unindexed legacy artifact.\n",
    );
  });

  it("reports stable byte fingerprints for immutable backups", async () => {
    const root = tempProject();
    const request = requestFor(root);
    const result = await runLegacyTaskBatch(request, { approved: true });
    expect(result.status).toBe("completed");
    if (result.status !== "completed")
      throw new Error("expected completed result");
    const manifestPath = path.join(
      storePath(
        root,
        "sources",
        result.sourceFingerprint.slice("sha256:".length),
      ),
      "manifest.json",
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      sourceFingerprint: string;
      files: { path: string; byteLength: number; fingerprint: string }[];
    };
    expect(manifest.sourceFingerprint).toBe(result.sourceFingerprint);
    for (const file of manifest.files) {
      const backupFile = path.join(
        storePath(
          root,
          "sources",
          result.sourceFingerprint.slice("sha256:".length),
          "files",
        ),
        file.path,
      );
      const bytes = fs.readFileSync(backupFile);
      expect(bytes.byteLength).toBe(file.byteLength);
      expect(sha256(bytes)).toBe(file.fingerprint);
    }
  });
});
