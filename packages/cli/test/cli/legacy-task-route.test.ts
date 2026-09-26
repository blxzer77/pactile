import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { buildLegacyTaskV2Import } from "../../src/core/task/legacy-task-v2-import.js";
import { scanLegacyTaskMigration } from "../../src/core/task/legacy-task-migration.js";
import { readTaskKernel } from "../../src/core/task/task-kernel.js";
import { runLegacyTaskBatch } from "../../src/pactile/migration/legacy-task-batch.js";

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
