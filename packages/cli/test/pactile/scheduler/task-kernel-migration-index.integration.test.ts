import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { init } from "../../../src/commands/init.js";
import {
  applyKernelCreate,
  createTaskKernel,
  emptyTaskRecord,
  readTaskKernel,
  startTaskRun,
} from "../../../src/core/task/index.js";
import {
  legacyTaskMigrationOverlayPath,
  listLegacyTaskImportRecords,
} from "../../../src/core/task/legacy-task-migration-reader.js";
import { applyLegacyTaskUpdate } from "../../../src/pactile/migration/legacy-task-update.js";
import { preparePiV2RunDispatch } from "../../../src/pactile/pi/v2-dispatch.js";
import { scheduleTaskKernelGraph } from "../../../src/pactile/scheduler/index.js";
import { createTaskRunWorktree } from "../../../src/pactile/worktree/index.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function makeGitRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pactile-p37-migration-index-"),
  );
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], {
    cwd: root,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Pactile Test"], {
    cwd: root,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.email", "pactile@example.invalid"], {
    cwd: root,
    stdio: "ignore",
  });
  fs.writeFileSync(
    path.join(root, "README.md"),
    "P37 migration index fixture\n",
  );
  execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "fixture base"], {
    cwd: root,
    stdio: "ignore",
  });
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function addLegacyTask(
  root: string,
  taskId: string,
  options: { readonly blockingDependency?: string } = {},
): string {
  const taskDir = path.join(root, ".pactile", "tasks", taskId);
  const record = emptyTaskRecord({
    id: taskId,
    name: taskId,
    title: `Legacy ${taskId}`,
    creator: "test-author",
    assignee: "test-author",
  });
  applyKernelCreate({
    taskDir,
    cwd: root,
    actor: "test-author",
    idempotencyKey: `legacy-create:${taskId}`,
    record: { ...record, status: "in_progress" },
    evidence: "P37 P36 migration fixture",
    extras: {
      deliverable: `A reviewable result for ${taskId}`,
      deliveryLevel: "local-result",
      ...(options.blockingDependency
        ? {
            depends_on: [options.blockingDependency],
            depends_mode: "block",
          }
        : {}),
    },
  });
  fs.writeFileSync(
    path.join(taskDir, "prd.md"),
    "# Task\n\nKeep the source description.\n\n## Acceptance Criteria\n\n- The result contains the requested values.\n",
    "utf8",
  );
  return taskDir;
}

function createV2Task(
  root: string,
  taskId: string,
  dependencies: string[] = [],
  start = false,
): { taskId: string; taskDir: string; runId: string | null } {
  const taskDir = path.join(root, ".pactile", "tasks", taskId);
  const created = createTaskKernel({
    root,
    taskDir,
    actor: "test-author",
    idempotencyKey: `create:${taskId}`,
    definition: {
      taskId,
      title: `V2 ${taskId}`,
      description: "P37 V2 scheduler fixture",
      deliverable: "A bounded result",
      deliveryLevel: "local-result",
      acceptanceCriteria: [{ id: "AC-1", description: "A result is recorded" }],
      dependencies,
    },
  });
  if (!start) return { taskId, taskDir, runId: null };
  const started = startTaskRun({
    root,
    taskDir,
    expectedRevision: created.kernel.revision,
    actor: "test-approver",
    idempotencyKey: `start:${taskId}`,
    input: { summary: "Implement the declared result", references: [] },
    authorization: {
      approvedBy: "test-approver",
      approvedAt: "2026-09-26T00:00:00.000Z",
      scope: "src",
      evidenceRef: "approval.md",
    },
    initialState: "waiting",
    writeSetSnapshot: ["src"],
  });
  return {
    taskId,
    taskDir,
    runId: started.kernel.runs.at(-1)?.id ?? null,
  };
}

function attachManagedWorktree(
  root: string,
  task: { taskId: string; taskDir: string; runId: string | null },
): void {
  if (!task.runId) throw new Error("V2 Run is missing");
  createTaskRunWorktree({
    repoRoot: root,
    taskDir: task.taskDir,
    runId: task.runId,
    branch: `feat/${task.taskId}`,
    baseRef: git(root, "rev-parse", "HEAD"),
    actor: "test-worktree-manager",
    idempotencyKey: `worktree:${task.taskId}`,
  });
}

function migrationRecord(root: string, taskId: string) {
  const match = listLegacyTaskImportRecords(root).find(
    ({ record }) => record.legacyTaskId === taskId,
  );
  if (!match) throw new Error(`P36 migration record is missing: ${taskId}`);
  return match;
}

describe("V2 Task graph indexing with P36 reconciliation records", () => {
  it("keeps unrelated V2 scheduling and Pi preparation available after fresh-init update, while gating explicit legacy dependencies", async () => {
    const root = makeGitRoot();
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await init({ yes: true, user: "p37-fixture", skipReadiness: true });

    const bootstrapTask = JSON.parse(
      fs.readFileSync(
        path.join(
          root,
          ".pactile",
          "tasks",
          "00-bootstrap-guidelines",
          "task.json",
        ),
        "utf8",
      ),
    ) as { id: string };
    const blockedLegacyTaskId = "p37-blocked-legacy-task";
    addLegacyTask(root, blockedLegacyTaskId, {
      blockingDependency: "p37-missing-block-target",
    });

    const independent = createV2Task(root, "p37-independent-task", [], true);
    if (!independent.runId) throw new Error("V2 Run is missing");
    attachManagedWorktree(root, independent);
    const definitionDependent = createV2Task(root, "p37-definition-dependent", [
      bootstrapTask.id,
    ]);
    const coordinationDependent = createV2Task(
      root,
      "p37-coordination-dependent",
      [blockedLegacyTaskId],
    );

    // A fresh V1 init seed remains compatible until P36 migration is applied.
    const beforeUpdate = scheduleTaskKernelGraph(root, [independent.taskId]);
    expect(beforeUpdate.receipt.scope).toBe("task-kernel-v2");
    const legacySeed = readTaskKernel({
      root,
      taskDir: path.join(root, ".pactile", "tasks", "00-bootstrap-guidelines"),
    });
    expect(legacySeed.kind).toBe("legacy-task-kernel-v1");

    const updated = await applyLegacyTaskUpdate(root);
    expect(updated.status).toBe("completed");
    expect(updated.import.needsDefinition).toBeGreaterThan(0);
    expect(updated.import.needsCoordination).toBeGreaterThan(0);
    expect(migrationRecord(root, bootstrapTask.id).record.status).toBe(
      "needs-definition",
    );
    expect(migrationRecord(root, blockedLegacyTaskId).record.status).toBe(
      "needs-coordination",
    );

    const plan = scheduleTaskKernelGraph(root, [independent.taskId]);
    expect(plan.receipt.scope).toBe("task-kernel-v2");
    expect(plan.receipt.candidateTaskIds).toEqual([independent.taskId]);
    const dispatch = preparePiV2RunDispatch(
      root,
      independent.taskId,
      independent.runId,
    );
    expect(dispatch).toMatchObject({
      taskId: independent.taskId,
      runId: independent.runId,
      scheduleReceiptFingerprint: plan.receipt.receiptFingerprint,
    });
    expect(dispatch.leaseId).toBeTruthy();

    expect(() =>
      preparePiV2RunDispatch(root, bootstrapTask.id, "missing-run"),
    ).toThrow(/needs definition fields/u);
    expect(() =>
      preparePiV2RunDispatch(root, blockedLegacyTaskId, "missing-run"),
    ).toThrow(/unresolved blocking legacy dependencies/u);

    expect(() => scheduleTaskKernelGraph(root, [bootstrapTask.id])).toThrow(
      /Task candidate .*needs-definition.*missing definition fields/u,
    );
    expect(() => scheduleTaskKernelGraph(root, [blockedLegacyTaskId])).toThrow(
      /Task candidate .*needs-coordination.*unresolved blocking legacy dependencies/u,
    );
    expect(() =>
      scheduleTaskKernelGraph(root, [definitionDependent.taskId]),
    ).toThrow(
      /Hard Task dependency .*needs-definition.*missing definition fields/u,
    );
    expect(() =>
      scheduleTaskKernelGraph(root, [coordinationDependent.taskId]),
    ).toThrow(
      /Hard Task dependency .*needs-coordination.*unresolved blocking legacy dependencies/u,
    );
  }, 120_000);

  it("continues to fail closed for damaged migration authority, overlays, and unrelated malformed Tasks", async () => {
    const root = makeGitRoot();
    addLegacyTask(root, "p37-imported-legacy-task");
    const independent = createV2Task(root, "p37-corruption-check");
    const updated = await applyLegacyTaskUpdate(root);
    expect(updated.status).toBe("completed");

    const imported = migrationRecord(root, "p37-imported-legacy-task");
    expect(imported.record.status).toBe("imported");
    const migratedKernel = readTaskKernel({ root, taskDir: imported.taskDir });
    if (migratedKernel.kind !== "task-kernel-v2")
      throw new Error("expected imported V2 Task");
    const started = startTaskRun({
      root,
      taskDir: imported.taskDir,
      expectedRevision: migratedKernel.kernel.revision,
      actor: "test-approver",
      idempotencyKey: "p37-imported-overlay-run",
      input: { summary: "Create overlay state", references: [] },
      authorization: {
        approvedBy: "test-approver",
        approvedAt: "2026-09-26T00:00:00.000Z",
        scope: "one Task",
        evidenceRef: "approval.md",
      },
      initialState: "waiting",
    });
    expect(started.kernel.runs.at(-1)?.state).toBe("waiting");

    const overlayDir = legacyTaskMigrationOverlayPath(root, imported.taskDir);
    if (!overlayDir) throw new Error("missing migrated Task overlay path");
    const overlayFile = path.join(overlayDir, "kernel.json");
    const validOverlay = fs.readFileSync(overlayFile);
    fs.writeFileSync(
      overlayFile,
      Buffer.concat([validOverlay, Buffer.from(" ")]),
    );
    expect(() => scheduleTaskKernelGraph(root, [independent.taskId])).toThrow(
      /overlay hash-mismatch/u,
    );

    fs.writeFileSync(overlayFile, validOverlay);
    const authorityFile = path.join(
      root,
      ".pactile",
      "runtime",
      "legacy-task-migrations",
      "authority.json",
    );
    const validAuthority = fs.readFileSync(authorityFile);
    fs.writeFileSync(authorityFile, "{ damaged authority\n", "utf8");
    expect(() => scheduleTaskKernelGraph(root, [independent.taskId])).toThrow(
      /authority|migration view|invalid/u,
    );

    fs.writeFileSync(authorityFile, validAuthority);
    const malformedTask = createV2Task(root, "p37-malformed-unrelated-task");
    fs.writeFileSync(
      path.join(malformedTask.taskDir, "kernel.json"),
      "{ damaged kernel\n",
      "utf8",
    );
    expect(() => scheduleTaskKernelGraph(root, [independent.taskId])).toThrow(
      /Failed to parse|CORRUPT_STATE|Unexpected token/u,
    );
  }, 120_000);
});
