import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { scanLegacyTaskMigration } from "../../../src/core/task/legacy-task-migration.js";
import {
  readPreparedLegacyTaskBatch,
  runLegacyTaskBatch,
  type LegacyTaskBatchRequest,
  type LegacyTaskBatchTargetFile,
} from "../../../src/pactile/migration/legacy-task-batch.js";

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

  it("uses pointer CAS so a racing batch cannot publish a partial generation", async () => {
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
    expect(competitorResult?.status).toBe("completed");
    expect(result).toMatchObject({
      status: "review",
      reason: "migration-authority-cas-mismatch",
    });
    expect(readPreparedLegacyTaskBatch(root)?.batchId).toBe(
      competitorResult && competitorResult.status === "completed"
        ? competitorResult.batchId
        : null,
    );
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
    const blockedRequest = requestFor(blockedFixture);
    const blocked = await runLegacyTaskBatch(blockedRequest, {
      approved: true,
    });
    expect(blocked).toMatchObject({ status: "blocked", wrote: false });
    expect(fs.existsSync(storePath(blockedFixture))).toBe(false);
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
