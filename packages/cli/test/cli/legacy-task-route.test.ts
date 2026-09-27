import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildLegacyTaskV2Import } from "../../src/core/task/legacy-task-v2-import.js";
import { scanLegacyTaskMigration } from "../../src/core/task/legacy-task-migration.js";
import {
  readLegacyTaskImportRecord,
  readLegacyTaskMigrationFile,
} from "../../src/core/task/legacy-task-migration-reader.js";
import {
  createTaskKernel,
  readTaskKernel,
} from "../../src/core/task/task-kernel.js";
import { resolveTaskDirectoryById } from "../../src/core/task/task-kernel-paths.js";
import { runLegacyTaskBatch } from "../../src/pactile/migration/legacy-task-batch.js";
import { runTaskCli } from "../../src/commands/task.js";
import { applyLegacyTaskUpdate } from "../../src/pactile/migration/legacy-task-update.js";

const CLI_SOURCE = fileURLToPath(
  new URL("../../src/cli/index.ts", import.meta.url),
);
const TSX_LOADER = import.meta.resolve("tsx/esm");
const HISTORY_FIXTURE = fileURLToPath(
  new URL("../fixtures/pactile/p36-legacy-task-source/input", import.meta.url),
);
const RECONCILE_FIXTURE = fileURLToPath(
  new URL("../fixtures/legacy-v050-task-source/input", import.meta.url),
);
const HELD_TASK_PATH = "09-26-v050-migration-sample";
const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pactile-legacy-task-route-"),
  );
  roots.push(root);
  return root;
}

function markLegacyProjectVersion(root: string): void {
  fs.writeFileSync(path.join(root, ".pactile", ".version"), "0.5.0\n", "utf8");
}

function copyHistoryFixture(root: string): void {
  const runtimePath = path.join(".pactile", "runtime");
  fs.cpSync(HISTORY_FIXTURE, root, {
    recursive: true,
    filter(source) {
      const relative = path.relative(HISTORY_FIXTURE, source);
      return (
        relative !== runtimePath &&
        !relative.startsWith(`${runtimePath}${path.sep}`)
      );
    },
  });
}

function createV2Task(root: string, directory: string, id: string): string {
  const taskDir = path.join(root, ".pactile", "tasks", directory);
  createTaskKernel({
    root,
    taskDir,
    cwd: root,
    actor: "migration-route-test",
    idempotencyKey: `create-${id}`,
    definition: {
      taskId: id,
      title: `Existing ${id}`,
      description: "Existing independently managed Task.",
      deliverable: "An existing V2 result.",
      deliveryLevel: "local-result",
      acceptanceCriteria: [
        { id: "AC-1", description: "The existing Task remains unchanged." },
      ],
      dependencies: [],
    },
  });
  return taskDir;
}

function makeV2KernelBytes(id: string): Buffer {
  const isolatedRoot = makeRoot();
  const taskDir = createV2Task(isolatedRoot, "01-kernel-source", id);
  return fs.readFileSync(path.join(taskDir, "kernel.json"));
}

function snapshotTree(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        const relative = path
          .relative(root, absolute)
          .split(path.sep)
          .join("/");
        files.push(
          `${relative}:${fs.readFileSync(absolute).toString("base64")}`,
        );
      } else if (entry.isSymbolicLink()) {
        const relative = path
          .relative(root, absolute)
          .split(path.sep)
          .join("/");
        files.push(`${relative}:symlink:${fs.readlinkSync(absolute)}`);
      } else {
        throw new Error(`unsupported test fixture entry: ${entry.name}`);
      }
    }
  };
  visit(root);
  return files;
}

function runCli(root: string, args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ["--import", TSX_LOADER, CLI_SOURCE, ...args],
    {
      cwd: root,
      env: { ...process.env },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
}

function parseJsonOutput(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function importHeldTask(
  root: string,
  includeNestedChild = false,
): Promise<void> {
  fs.cpSync(RECONCILE_FIXTURE, root, { recursive: true });
  if (includeNestedChild) {
    const sourceTaskDir = path.join(
      RECONCILE_FIXTURE,
      ".pactile",
      "tasks",
      HELD_TASK_PATH,
    );
    const nestedChildDir = path.join(
      root,
      ".pactile",
      "tasks",
      HELD_TASK_PATH,
      "nested-child",
    );
    fs.mkdirSync(nestedChildDir, { recursive: true });
    for (const name of ["task.json", "prd.md", "verify.md"]) {
      fs.copyFileSync(
        path.join(sourceTaskDir, name),
        path.join(nestedChildDir, name),
      );
    }
    const childTaskPath = path.join(nestedChildDir, "task.json");
    const childTask = JSON.parse(
      fs.readFileSync(childTaskPath, "utf8"),
    ) as Record<string, unknown>;
    childTask.id = "nested-v050-child";
    childTask.name = "nested-v050-child";
    childTask.title = "Nested v0.5.0 held Child";
    fs.writeFileSync(
      childTaskPath,
      `${JSON.stringify(childTask, null, 2)}\n`,
      "utf8",
    );
  }
  markLegacyProjectVersion(root);
  const plan = scanLegacyTaskMigration({ projectRoot: root });
  const imported = buildLegacyTaskV2Import(plan);
  const result = await runLegacyTaskBatch(
    { projectRoot: root, plan, targets: imported.targets },
    { approved: true },
  );
  expect(result.status).toBe("completed");
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("legacy-task CLI route", () => {
  it("routes history through the CLI and leaves archived fixture bytes unchanged", () => {
    const root = makeRoot();
    copyHistoryFixture(root);
    markLegacyProjectVersion(root);
    const before = snapshotTree(root);

    const result = runCli(root, [
      "legacy-task",
      "history",
      "archive/2026-08/08-20-closed-lite",
      "--json",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Pactile update available: 0.5.0");
    const report = parseJsonOutput(result.stdout);
    expect(report).toMatchObject({
      status: "archived-historical-only",
      runnable: false,
      lifecyclePolicy: "source-only-no-v2-run-review-or-close",
    });
    expect(
      (report.files as { path: string }[]).some((file) =>
        file.path.endsWith("/task.json"),
      ),
    ).toBe(true);
    expect(snapshotTree(root)).toEqual(before);

    const humanResult = runCli(root, [
      "legacy-task",
      "history",
      "archive/2026-08/08-20-closed-lite",
    ]);
    expect(humanResult.status, humanResult.stderr).toBe(0);
    expect(humanResult.stdout).toContain("Pactile update available: 0.5.0");
    expect(humanResult.stdout).toContain("Archived legacy Task:");
    expect(snapshotTree(root)).toEqual(before);
  });

  it("indexes archived and interrupted sources, exposes source metadata, and explicitly restores them through CLI", async () => {
    const root = makeRoot();
    copyHistoryFixture(root);
    markLegacyProjectVersion(root);
    const archivedDir = path.join(
      root,
      ".pactile",
      "tasks",
      "archive",
      "2026-08",
      "08-20-closed-lite",
    );
    const interruptedDir = path.join(
      root,
      ".pactile",
      "tasks",
      "08-23-interrupted",
    );
    const archivedBefore = snapshotTree(archivedDir);
    const interruptedBefore = snapshotTree(interruptedDir);

    const updateResult = await applyLegacyTaskUpdate(root);

    expect(updateResult.status).toBe("completed");
    expect(snapshotTree(archivedDir)).toEqual(archivedBefore);
    expect(snapshotTree(interruptedDir)).toEqual(interruptedBefore);

    const archiveHistory = runCli(root, [
      "legacy-task",
      "history",
      "archive/2026-08/08-20-closed-lite",
      "--json",
    ]);
    expect(archiveHistory.status, archiveHistory.stderr).toBe(0);
    const archiveReport = parseJsonOutput(archiveHistory.stdout);
    expect(archiveReport).toMatchObject({
      status: "held-source-read-only",
      migrationStatus: "archived-historical-only",
      archived: true,
      runnable: false,
      missingDefinitionFields: expect.arrayContaining([
        "deliverable",
        "deliveryLevel",
        "acceptanceCriteria",
      ]),
    });

    const interruptedHistory = runCli(root, [
      "legacy-task",
      "history",
      "held/08-23-interrupted",
      "--json",
    ]);
    expect(interruptedHistory.status, interruptedHistory.stderr).toBe(0);
    expect(parseJsonOutput(interruptedHistory.stdout)).toMatchObject({
      status: "held-source-read-only",
      migrationStatus: "needs-definition",
      archived: false,
      missingDefinitionFields: expect.arrayContaining([
        "acceptanceCriteria",
        "deliverable",
        "deliveryLevel",
        "legacyHistoryGap",
      ]),
      legacyHistoryDiagnostics: [
        "legacy-kernel-unparsed:.pactile/tasks/08-23-interrupted/kernel.json",
      ],
      legacySourceMetadata: {
        typeMarkers: {
          meta: { classification: "full" },
        },
      },
    });

    const archiveReconcileArgs = [
      "legacy-task",
      "reconcile",
      "archive/2026-08/08-20-closed-lite",
      "--target-path",
      "09-26-restored-archive",
      "--idempotency-key",
      "restore-archive-once",
      "--activation-at",
      "2026-09-26T12:00:00.000Z",
      "--deliverable",
      "A new active result with preserved archive evidence.",
      "--delivery-level",
      "local-result",
      "--accept",
      "The original archived bytes remain queryable.",
      "--approved",
    ];
    const archiveRestore = runCli(root, archiveReconcileArgs);
    expect(
      archiveRestore.status,
      `${archiveRestore.stderr}\n${archiveRestore.stdout}`,
    ).toBe(0);
    expect(parseJsonOutput(archiveRestore.stdout)).toMatchObject({
      status: "completed",
      taskPath: ".pactile/tasks/09-26-restored-archive",
      visible: true,
    });
    const archiveTargetDir = path.join(
      root,
      ".pactile",
      "tasks",
      "09-26-restored-archive",
    );
    const archiveKernel = readTaskKernel({
      root,
      taskDir: archiveTargetDir,
      cwd: root,
    });
    expect(archiveKernel).toMatchObject({
      kind: "task-kernel-v2",
      kernel: {
        phase: "define",
        outcome: null,
        runs: [],
        reviews: [],
        closure: null,
      },
    });
    const restoredArchiveRecord = readLegacyTaskImportRecord(
      root,
      archiveTargetDir,
    );
    expect(restoredArchiveRecord).toMatchObject({
      status: "imported",
      legacySourceMetadata: {
        fileReferences: {
          taskJson: {
            path: ".pactile/tasks/archive/2026-08/08-20-closed-lite/task.json",
          },
        },
      },
    });
    expect(resolveTaskDirectoryById(root, "closed-lite-legacy")).toBe(
      archiveTargetDir,
    );

    const archiveOverlayKernel = readLegacyTaskMigrationFile(
      root,
      archiveTargetDir,
      "kernel.json",
    );
    const interruptedOverlayCollision = runCli(root, [
      "legacy-task",
      "reconcile",
      "08-23-interrupted",
      "--target-path",
      "09-26-restored-archive",
      "--acknowledge-history-gap",
      "--idempotency-key",
      "restore-interrupted-to-archive-overlay",
      "--activation-at",
      "2026-09-26T12:20:00.000Z",
      "--deliverable",
      "A new active result after explicit history-gap review.",
      "--delivery-level",
      "documentation",
      "--accept",
      "The archived target overlay remains unchanged.",
      "--approved",
    ]);
    expect(interruptedOverlayCollision.status).toBe(1);
    expect(parseJsonOutput(interruptedOverlayCollision.stdout)).toMatchObject({
      status: "blocked",
      reason: "legacy-task-reconciliation-target-occupied",
      wrote: false,
      visible: false,
    });
    expect(
      readLegacyTaskMigrationFile(root, archiveTargetDir, "kernel.json"),
    ).toEqual(archiveOverlayKernel);
    expect(readLegacyTaskImportRecord(root, interruptedDir)?.status).toBe(
      "needs-definition",
    );
    expect(snapshotTree(interruptedDir)).toEqual(interruptedBefore);

    const interruptedReconcileArgs = [
      "legacy-task",
      "reconcile",
      "08-23-interrupted",
      "--target-path",
      "09-27-restored-interrupted",
      "--acknowledge-history-gap",
      "--idempotency-key",
      "restore-interrupted-once",
      "--activation-at",
      "2026-09-26T12:30:00.000Z",
      "--deliverable",
      "A new active result after explicit history-gap review.",
      "--delivery-level",
      "documentation",
      "--accept",
      "The damaged Kernel bytes remain available without inferred history.",
      "--approved",
    ];
    const interruptedRestore = runCli(root, interruptedReconcileArgs);
    expect(interruptedRestore.status, interruptedRestore.stderr).toBe(0);
    expect(parseJsonOutput(interruptedRestore.stdout)).toMatchObject({
      status: "completed",
      taskPath: ".pactile/tasks/09-27-restored-interrupted",
      visible: true,
    });
    const interruptedTargetDir = path.join(
      root,
      ".pactile",
      "tasks",
      "09-27-restored-interrupted",
    );
    const interruptedKernel = readTaskKernel({
      root,
      taskDir: interruptedTargetDir,
      cwd: root,
    });
    expect(interruptedKernel).toMatchObject({
      kind: "task-kernel-v2",
      kernel: {
        phase: "define",
        outcome: null,
        runs: [],
        reviews: [],
        closure: null,
      },
    });
    expect(
      readLegacyTaskImportRecord(root, interruptedTargetDir),
    ).toMatchObject({
      status: "imported",
      legacySourceMetadata: {
        fileReferences: {
          taskJson: { path: ".pactile/tasks/08-23-interrupted/task.json" },
        },
      },
      reconciliation: { acknowledgedLegacyHistoryGap: true },
    });
    expect(resolveTaskDirectoryById(root, "interrupted-legacy")).toBe(
      interruptedTargetDir,
    );
    expect(snapshotTree(archivedDir)).toEqual(archivedBefore);
    expect(snapshotTree(interruptedDir)).toEqual(interruptedBefore);

    const archiveUserFile = path.join(archiveTargetDir, "user-note.txt");
    fs.mkdirSync(archiveTargetDir, { recursive: true });
    fs.writeFileSync(
      archiveUserFile,
      "User-owned archive target content.\n",
      "utf8",
    );
    const retriedArchiveRestore = runCli(root, archiveReconcileArgs);
    expect(retriedArchiveRestore.status, retriedArchiveRestore.stderr).toBe(0);
    expect(parseJsonOutput(retriedArchiveRestore.stdout)).toMatchObject({
      status: "completed",
      wrote: false,
      visible: true,
    });
    expect(fs.readFileSync(archiveUserFile, "utf8")).toBe(
      "User-owned archive target content.\n",
    );
    const rereadArchive = runCli(root, [
      "legacy-task",
      "history",
      "archive/2026-08/08-20-closed-lite",
      "--json",
    ]);
    expect(rereadArchive.status, rereadArchive.stderr).toBe(0);
    expect(parseJsonOutput(rereadArchive.stdout)).toMatchObject({
      migrationStatus: "archived-historical-only",
      archived: true,
    });
    expect((await applyLegacyTaskUpdate(root)).status).toBe("already-active");
    const taskList = runCli(root, ["task", "list"]);
    expect(taskList.status, taskList.stderr).toBe(0);
    expect(taskList.stdout).toContain("09-26-restored-archive/");
    expect(taskList.stdout).toContain("09-27-restored-interrupted/");
    expect(taskList.stdout).not.toContain(
      "08-23-interrupted/ (needs definition",
    );
  });

  it("rejects occupied archive restore targets and duplicate V2 IDs without hiding data, then retries a free target", async () => {
    const root = makeRoot();
    const duplicateKernel = makeV2KernelBytes("closed-lite-legacy");
    copyHistoryFixture(root);
    markLegacyProjectVersion(root);
    const archivedDir = path.join(
      root,
      ".pactile",
      "tasks",
      "archive",
      "2026-08",
      "08-20-closed-lite",
    );
    const interruptedDir = path.join(
      root,
      ".pactile",
      "tasks",
      "08-23-interrupted",
    );
    const sourceBefore = snapshotTree(archivedDir);
    const interruptedBefore = snapshotTree(interruptedDir);
    await applyLegacyTaskUpdate(root);

    const existingTarget = createV2Task(
      root,
      "09-26-existing-v2",
      "existing-v2",
    );
    const existingKernel = fs.readFileSync(
      path.join(existingTarget, "kernel.json"),
    );
    const occupied = runCli(root, [
      "legacy-task",
      "reconcile",
      "archive/2026-08/08-20-closed-lite",
      "--target-path",
      "09-26-existing-v2",
      "--idempotency-key",
      "restore-to-occupied-target",
      "--activation-at",
      "2026-09-26T13:00:00.000Z",
      "--deliverable",
      "A newly defined active result.",
      "--delivery-level",
      "local-result",
      "--accept",
      "The archive remains unchanged and queryable.",
      "--approved",
    ]);
    expect(occupied.status).toBe(1);
    expect(parseJsonOutput(occupied.stdout)).toMatchObject({
      status: "blocked",
      reason: "legacy-task-reconciliation-target-occupied",
      wrote: false,
      visible: false,
    });
    expect(fs.readFileSync(path.join(existingTarget, "kernel.json"))).toEqual(
      existingKernel,
    );
    expect(
      readTaskKernel({ root, taskDir: existingTarget, cwd: root }),
    ).toMatchObject({
      kind: "task-kernel-v2",
      kernel: { identity: { taskId: "existing-v2" } },
    });
    expect(snapshotTree(archivedDir)).toEqual(sourceBefore);

    const userTarget = path.join(
      root,
      ".pactile",
      "tasks",
      "09-27-user-directory",
    );
    fs.mkdirSync(userTarget, { recursive: true });
    fs.writeFileSync(path.join(userTarget, "keep.txt"), "user data\n", "utf8");
    const userDirectoryFailure = runCli(root, [
      "legacy-task",
      "reconcile",
      "archive/2026-08/08-20-closed-lite",
      "--target-path",
      "09-27-user-directory",
      "--idempotency-key",
      "restore-to-user-directory",
      "--activation-at",
      "2026-09-26T13:10:00.000Z",
      "--deliverable",
      "A newly defined active result.",
      "--delivery-level",
      "local-result",
      "--accept",
      "The archive remains unchanged and queryable.",
      "--approved",
    ]);
    expect(userDirectoryFailure.status).toBe(1);
    expect(parseJsonOutput(userDirectoryFailure.stdout)).toMatchObject({
      status: "blocked",
      reason: "legacy-task-reconciliation-target-occupied",
      wrote: false,
      visible: false,
    });
    expect(fs.readFileSync(path.join(userTarget, "keep.txt"), "utf8")).toBe(
      "user data\n",
    );
    expect(snapshotTree(archivedDir)).toEqual(sourceBefore);

    const interruptedTargetFailure = runCli(root, [
      "legacy-task",
      "reconcile",
      "08-23-interrupted",
      "--target-path",
      "09-26-existing-v2",
      "--acknowledge-history-gap",
      "--idempotency-key",
      "restore-interrupted-to-occupied-target",
      "--activation-at",
      "2026-09-26T13:20:00.000Z",
      "--deliverable",
      "A new active result after explicit history-gap review.",
      "--delivery-level",
      "documentation",
      "--accept",
      "The malformed Kernel bytes remain preserved as source history.",
      "--approved",
    ]);
    expect(interruptedTargetFailure.status).toBe(1);
    expect(parseJsonOutput(interruptedTargetFailure.stdout)).toMatchObject({
      status: "blocked",
      reason: "legacy-task-reconciliation-target-occupied",
      wrote: false,
      visible: false,
    });
    expect(fs.readFileSync(path.join(existingTarget, "kernel.json"))).toEqual(
      existingKernel,
    );
    expect(snapshotTree(interruptedDir)).toEqual(interruptedBefore);
    expect(snapshotTree(archivedDir)).toEqual(sourceBefore);

    const retry = runCli(root, [
      "legacy-task",
      "reconcile",
      "archive/2026-08/08-20-closed-lite",
      "--target-path",
      "09-30-restored-after-occupancy-rejection",
      "--idempotency-key",
      "restore-after-occupied-retries",
      "--activation-at",
      "2026-09-26T13:30:00.000Z",
      "--deliverable",
      "A newly defined active result.",
      "--delivery-level",
      "local-result",
      "--accept",
      "The archive remains unchanged and queryable.",
      "--approved",
    ]);
    expect(retry.status).toBe(0);
    expect(parseJsonOutput(retry.stdout)).toMatchObject({
      status: "completed",
      visible: true,
    });
    expect(snapshotTree(archivedDir)).toEqual(sourceBefore);

    const duplicateRoot = makeRoot();
    copyHistoryFixture(duplicateRoot);
    markLegacyProjectVersion(duplicateRoot);
    const duplicateArchive = path.join(
      duplicateRoot,
      ".pactile",
      "tasks",
      "archive",
      "2026-08",
      "08-20-closed-lite",
    );
    const duplicateSourceBefore = snapshotTree(duplicateArchive);
    await applyLegacyTaskUpdate(duplicateRoot);
    const duplicateTarget = path.join(
      duplicateRoot,
      ".pactile",
      "tasks",
      "09-28-duplicate-legacy-id",
    );
    fs.mkdirSync(duplicateTarget, { recursive: true });
    fs.writeFileSync(
      path.join(duplicateTarget, "kernel.json"),
      duplicateKernel,
    );
    const duplicate = runCli(duplicateRoot, [
      "legacy-task",
      "reconcile",
      "archive/2026-08/08-20-closed-lite",
      "--target-path",
      "09-29-free-but-duplicate-id",
      "--idempotency-key",
      "restore-with-duplicate-id",
      "--activation-at",
      "2026-09-26T13:20:00.000Z",
      "--deliverable",
      "A newly defined active result.",
      "--delivery-level",
      "local-result",
      "--accept",
      "The archive remains unchanged and queryable.",
      "--approved",
    ]);
    expect(duplicate.status).toBe(1);
    expect(duplicate.stdout).toContain(
      "Task ID already exists: closed-lite-legacy",
    );
    expect(fs.readFileSync(path.join(duplicateTarget, "kernel.json"))).toEqual(
      duplicateKernel,
    );
    expect(
      fs.existsSync(
        path.join(
          duplicateRoot,
          ".pactile",
          "tasks",
          "09-29-free-but-duplicate-id",
        ),
      ),
    ).toBe(false);
    expect(snapshotTree(duplicateArchive)).toEqual(duplicateSourceBefore);
  });

  it("requires an explicit unique V2 task ID mapping for legacy slugs outside the V2 ID grammar", async () => {
    const root = makeRoot();
    fs.cpSync(RECONCILE_FIXTURE, root, { recursive: true });
    markLegacyProjectVersion(root);
    const existingTaskDir = path.join(
      root,
      ".pactile",
      "tasks",
      "09-27-existing-mapped-id",
    );
    fs.mkdirSync(existingTaskDir, { recursive: true });
    fs.writeFileSync(
      path.join(existingTaskDir, "task.json"),
      `${JSON.stringify(
        {
          id: "mapped-task",
          name: "Existing mapped task",
          title: "Existing mapped task",
          description:
            "A legacy Task that imports as an independent V2 identity.",
          deliverable: "An existing mapped result.",
          deliveryLevel: "local-result",
          createdAt: "2026-09-25T00:00:00.000Z",
          depends_on: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(existingTaskDir, "prd.md"),
      "# Existing mapped task\n\n## Acceptance Criteria\n\n- The existing V2 Task remains independently addressable.\n",
      "utf8",
    );
    const sourceDir = path.join(root, ".pactile", "tasks", HELD_TASK_PATH);
    const taskJsonPath = path.join(sourceDir, "task.json");
    const legacyTask = JSON.parse(
      fs.readFileSync(taskJsonPath, "utf8"),
    ) as Record<string, unknown>;
    legacyTask.id = "Foo_Bar";
    legacyTask.name = "Foo_Bar";
    fs.writeFileSync(
      taskJsonPath,
      `${JSON.stringify(legacyTask, null, 2)}\n`,
      "utf8",
    );
    const kernelJsonPath = path.join(sourceDir, "kernel.json");
    const legacyKernel = JSON.parse(
      fs.readFileSync(kernelJsonPath, "utf8"),
    ) as { identity: { taskId: string } };
    legacyKernel.identity.taskId = "Foo_Bar";
    fs.writeFileSync(
      kernelJsonPath,
      `${JSON.stringify(legacyKernel, null, 2)}\n`,
      "utf8",
    );
    const originalTaskBytes = fs.readFileSync(taskJsonPath);
    const plan = scanLegacyTaskMigration({ projectRoot: root });
    const imported = buildLegacyTaskV2Import(plan);
    const batch = await runLegacyTaskBatch(
      { projectRoot: root, plan, targets: imported.targets },
      { approved: true },
    );
    expect(batch.status, batch.reason).toBe("completed");
    expect(readLegacyTaskImportRecord(root, sourceDir)).toMatchObject({
      status: "needs-definition",
      legacyTaskId: "Foo_Bar",
      missingDefinitionFields: expect.arrayContaining(["taskId"]),
    });
    expect(readLegacyTaskImportRecord(root, existingTaskDir)?.status).toBe(
      "imported",
    );
    const existingKernel = readLegacyTaskMigrationFile(
      root,
      existingTaskDir,
      "kernel.json",
    );
    expect(existingKernel).not.toBeNull();

    const args = [
      "legacy-task",
      "reconcile",
      HELD_TASK_PATH,
      "--idempotency-key",
      "map-legacy-id-once",
      "--activation-at",
      "2026-09-26T14:45:00.000Z",
      "--task-id",
      "mapped-task",
      "--deliverable",
      "A user-defined active result.",
      "--delivery-level",
      "local-result",
      "--accept",
      "The source ID remains queryable as legacy metadata.",
      "--approved",
    ];
    const duplicate = runCli(root, args);
    expect(duplicate.status).toBe(1);
    expect(duplicate.stdout).toContain("Task ID already exists: mapped-task");
    expect(
      readLegacyTaskMigrationFile(root, existingTaskDir, "kernel.json"),
    ).toEqual(existingKernel);
    expect(readLegacyTaskImportRecord(root, sourceDir)?.status).toBe(
      "needs-definition",
    );
    expect(fs.readFileSync(taskJsonPath)).toEqual(originalTaskBytes);

    const recovered = runCli(root, [
      ...args.slice(0, args.indexOf("mapped-task")),
      "mapped-task-v2",
      ...args.slice(args.indexOf("mapped-task") + 1),
    ]);
    expect(recovered.status, `${recovered.stderr}\n${recovered.stdout}`).toBe(
      0,
    );
    expect(parseJsonOutput(recovered.stdout)).toMatchObject({
      status: "completed",
      visible: true,
    });
    expect(readLegacyTaskImportRecord(root, sourceDir)).toMatchObject({
      status: "imported",
      legacyTaskId: "Foo_Bar",
      reconciliation: { mappedTaskId: "mapped-task-v2" },
    });
    expect(
      readTaskKernel({ root, taskDir: sourceDir, cwd: root }),
    ).toMatchObject({
      kind: "task-kernel-v2",
      kernel: { identity: { taskId: "mapped-task-v2" } },
    });
    expect(resolveTaskDirectoryById(root, "mapped-task-v2")).toBe(sourceDir);
    expect(fs.readFileSync(taskJsonPath)).toEqual(originalTaskBytes);
  });

  it("reads a still-held source and keeps run-start and close gated without writes", async () => {
    const root = makeRoot();
    await importHeldTask(root);
    const before = snapshotTree(root);

    const result = runCli(root, [
      "legacy-task",
      "history",
      `held/${HELD_TASK_PATH}`,
      "--json",
    ]);

    expect(result.status, result.stderr).toBe(0);
    const report = parseJsonOutput(result.stdout);
    expect(report).toMatchObject({
      taskPath: `.pactile/tasks/${HELD_TASK_PATH}`,
      status: "held-source-read-only",
      migrationStatus: "needs-definition",
      legacyTaskId: "v050-migration-sample",
      runnable: false,
      lifecyclePolicy: "source-only-no-v2-run-review-or-close",
    });
    const files = report.files as {
      path: string;
      sha256: string;
      content: string;
    }[];
    expect(files.some((file) => file.path.endsWith("/task.json"))).toBe(true);
    expect(files.some((file) => file.path.endsWith("/prd.md"))).toBe(true);
    expect(files.some((file) => file.path.endsWith("/verify.md"))).toBe(true);
    expect(
      files.find((file) => file.path.endsWith("/verify.md"))?.content,
    ).toContain("# 验证证据");
    expect(
      files.every((file) => /^sha256:[a-f0-9]{64}$/.test(file.sha256)),
    ).toBe(true);
    expect(snapshotTree(root)).toEqual(before);

    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      expect(runTaskCli(["run-start", HELD_TASK_PATH], root)).toBe(1);
      expect(String(errors.mock.calls.at(-1)?.[0])).toContain(
        "needs definition fields before it can run",
      );
      expect(snapshotTree(root)).toEqual(before);

      expect(runTaskCli(["close", HELD_TASK_PATH], root)).toBe(1);
      expect(String(errors.mock.calls.at(-1)?.[0])).toContain(
        "needs definition fields before it can run",
      );
      expect(snapshotTree(root)).toEqual(before);
    } finally {
      errors.mockRestore();
    }
  });

  it("reads nested Parent and Child sources by scanner ownership and detects Child source drift", async () => {
    const root = makeRoot();
    await importHeldTask(root, true);
    const before = snapshotTree(root);

    const parentResult = runCli(root, [
      "legacy-task",
      "history",
      `held/${HELD_TASK_PATH}`,
      "--json",
    ]);
    expect(parentResult.status, parentResult.stderr).toBe(0);
    const parentReport = parseJsonOutput(parentResult.stdout);
    expect(parentReport).toMatchObject({
      taskPath: `.pactile/tasks/${HELD_TASK_PATH}`,
      status: "held-source-read-only",
      runnable: false,
    });
    const parentFiles = parentReport.files as { path: string }[];
    expect(parentFiles.some((file) => file.path.endsWith("/task.json"))).toBe(
      true,
    );
    expect(
      parentFiles.some((file) => file.path.includes("/nested-child/")),
    ).toBe(false);
    expect(snapshotTree(root)).toEqual(before);

    const childResult = runCli(root, [
      "legacy-task",
      "history",
      `held/${HELD_TASK_PATH}/nested-child`,
      "--json",
    ]);
    expect(childResult.status, childResult.stderr).toBe(0);
    const childReport = parseJsonOutput(childResult.stdout);
    expect(childReport).toMatchObject({
      taskPath: `.pactile/tasks/${HELD_TASK_PATH}/nested-child`,
      status: "held-source-read-only",
      legacyTaskId: "nested-v050-child",
      runnable: false,
    });
    const childFiles = childReport.files as { path: string }[];
    expect(
      childFiles.some((file) => file.path.endsWith("/nested-child/task.json")),
    ).toBe(true);
    expect(snapshotTree(root)).toEqual(before);

    const changedRoot = makeRoot();
    await importHeldTask(changedRoot, true);
    fs.appendFileSync(
      path.join(
        changedRoot,
        ".pactile",
        "tasks",
        HELD_TASK_PATH,
        "nested-child",
        "verify.md",
      ),
      "\nchanged after import\n",
      "utf8",
    );
    const changedBefore = snapshotTree(changedRoot);
    const changed = runCli(changedRoot, [
      "legacy-task",
      "history",
      `held/${HELD_TASK_PATH}`,
      "--json",
    ]);
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain(
      "legacy-task-held-history-authority-stale",
    );
    expect(snapshotTree(changedRoot)).toEqual(changedBefore);
  });

  it("rejects traversal, changed source, stale authority, and linked source paths", async () => {
    const traversalRoot = makeRoot();
    await importHeldTask(traversalRoot);
    const traversalBefore = snapshotTree(traversalRoot);
    const traversal = runCli(traversalRoot, [
      "legacy-task",
      "history",
      "held/../outside",
      "--json",
    ]);
    expect(traversal.status).toBe(1);
    expect(traversal.stderr).toContain("legacy-task-held-history-path-invalid");
    expect(snapshotTree(traversalRoot)).toEqual(traversalBefore);

    const changedRoot = makeRoot();
    await importHeldTask(changedRoot);
    fs.appendFileSync(
      path.join(changedRoot, ".pactile", "tasks", HELD_TASK_PATH, "verify.md"),
      "\nchanged after import\n",
      "utf8",
    );
    const changedBefore = snapshotTree(changedRoot);
    const changed = runCli(changedRoot, [
      "legacy-task",
      "history",
      `held/${HELD_TASK_PATH}`,
      "--json",
    ]);
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain("legacy-task-held-history-source-stale");
    expect(snapshotTree(changedRoot)).toEqual(changedBefore);

    const staleRoot = makeRoot();
    await importHeldTask(staleRoot);
    const unrelatedTaskDir = path.join(
      staleRoot,
      ".pactile",
      "tasks",
      "unrelated-legacy-task",
    );
    fs.mkdirSync(unrelatedTaskDir, { recursive: true });
    fs.writeFileSync(
      path.join(unrelatedTaskDir, "task.json"),
      `${JSON.stringify(
        {
          id: "unrelated-legacy-task",
          title: "Unrelated source added after import",
          description: "Changes the migration source fingerprint.",
          createdAt: "2026-09-26",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const staleBefore = snapshotTree(staleRoot);
    const stale = runCli(staleRoot, [
      "legacy-task",
      "history",
      `held/${HELD_TASK_PATH}`,
      "--json",
    ]);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("legacy-task-held-history-authority-stale");
    expect(snapshotTree(staleRoot)).toEqual(staleBefore);

    const linkedRoot = makeRoot();
    await importHeldTask(linkedRoot, true);
    const outside = path.join(linkedRoot, "outside-source");
    fs.mkdirSync(outside);
    const linkPath = path.join(
      linkedRoot,
      ".pactile",
      "tasks",
      HELD_TASK_PATH,
      "nested-child",
      "linked-source",
    );
    fs.symlinkSync(outside, linkPath, "junction");
    const linkedBefore = snapshotTree(linkedRoot);
    const linked = runCli(linkedRoot, [
      "legacy-task",
      "history",
      `held/${HELD_TASK_PATH}`,
      "--json",
    ]);
    expect(linked.status).toBe(1);
    expect(linked.stderr).toContain("legacy-task-held-history-link-invalid");
    expect(snapshotTree(linkedRoot)).toEqual(linkedBefore);
  });

  it("routes reconcile check and approved modes, and rejects invalid options without writes", async () => {
    const root = makeRoot();
    fs.cpSync(RECONCILE_FIXTURE, root, { recursive: true });
    markLegacyProjectVersion(root);
    const plan = scanLegacyTaskMigration({ projectRoot: root });
    const imported = buildLegacyTaskV2Import(plan);
    const importResult = await runLegacyTaskBatch(
      { projectRoot: root, plan, targets: imported.targets },
      { approved: true },
    );
    expect(importResult.status).toBe("completed");

    const baseArgs = [
      "legacy-task",
      "reconcile",
      "09-26-v050-migration-sample",
      "--idempotency-key",
      "cli-route-define-once",
      "--activation-at",
      "2026-09-26T12:00:00.000Z",
      "--deliverable",
      "A user supplied migration output.",
      "--delivery-level",
      "local-result",
      "--accept",
      "The original source bytes remain available.",
      "--accept",
      "No historical Run, Review, or Close is created.",
    ];
    const beforeInvalid = snapshotTree(root);
    const invalid = runCli(root, [...baseArgs, "--unknown"]);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("unknown option: --unknown");
    expect(snapshotTree(root)).toEqual(beforeInvalid);

    const beforeCheck = snapshotTree(root);
    const checked = runCli(root, [...baseArgs, "--check"]);
    expect(checked.status, checked.stderr).toBe(0);
    expect(checked.stderr).toContain("Pactile update available: 0.5.0");
    expect(parseJsonOutput(checked.stdout)).toMatchObject({
      status: "dry-run",
      wrote: false,
      visible: false,
    });
    expect(snapshotTree(root)).toEqual(beforeCheck);

    const approved = runCli(root, [...baseArgs, "--approved"]);
    expect(approved.status, approved.stderr).toBe(0);
    expect(approved.stderr).toContain("Pactile update available: 0.5.0");
    expect(parseJsonOutput(approved.stdout)).toMatchObject({
      status: "completed",
      visible: true,
      taskPath: ".pactile/tasks/09-26-v050-migration-sample",
    });
    expect(
      readTaskKernel({
        root,
        taskDir: path.join(
          root,
          ".pactile",
          "tasks",
          "09-26-v050-migration-sample",
        ),
        cwd: root,
      }).kind,
    ).toBe("task-kernel-v2");
  });
});
