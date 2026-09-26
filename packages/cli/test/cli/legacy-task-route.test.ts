import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildLegacyTaskV2Import } from "../../src/core/task/legacy-task-v2-import.js";
import { scanLegacyTaskMigration } from "../../src/core/task/legacy-task-migration.js";
import { readTaskKernel } from "../../src/core/task/task-kernel.js";
import { runLegacyTaskBatch } from "../../src/pactile/migration/legacy-task-batch.js";
import { runTaskCli } from "../../src/commands/task.js";

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

async function importHeldTask(root: string): Promise<void> {
  fs.cpSync(RECONCILE_FIXTURE, root, { recursive: true });
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
    fs.cpSync(HISTORY_FIXTURE, root, { recursive: true });
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
    await importHeldTask(linkedRoot);
    const outside = path.join(linkedRoot, "outside-source");
    fs.mkdirSync(outside);
    const linkPath = path.join(
      linkedRoot,
      ".pactile",
      "tasks",
      HELD_TASK_PATH,
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
