import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTaskKernel,
  fingerprintTaskValue,
  listTaskKernelSnapshots,
} from "../../src/core/task/index.js";
import { runTaskCli } from "../../src/commands/task.js";
import { planTaskKernelGraphV1 } from "../../src/pactile/scheduler/index.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-task-schedule-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
  return root;
}

function createV2Task(
  root: string,
  taskId: string,
  dependencies: string[] = [],
): string {
  const taskDir = path.join(root, ".pactile", "tasks", taskId);
  createTaskKernel({
    root,
    taskDir,
    actor: "author",
    idempotencyKey: `create:${taskId}`,
    definition: {
      taskId,
      title: taskId,
      description: "schedule CLI fixture",
      deliverable: "one reviewable result",
      deliveryLevel: "local-result",
      acceptanceCriteria: [{ id: "AC-1", description: "result exists" }],
      dependencies,
    },
  });
  return taskDir;
}

describe("V2 Task schedule CLI", () => {
  it("lists current V2 IDs, writes and reads an auditable plan receipt without changing Task state", () => {
    const root = makeRoot();
    createV2Task(root, "schedule-prerequisite");
    createV2Task(root, "schedule-candidate", ["schedule-prerequisite"]);
    const archived = createV2Task(root, "schedule-archived");
    const archiveDir = path.join(
      root,
      ".pactile",
      "tasks",
      "archive",
      "2026-09",
    );
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.renameSync(archived, path.join(archiveDir, "schedule-archived"));
    const revisionsBefore = new Map(
      listTaskKernelSnapshots(root).map(({ kernel }) => [
        kernel.identity.taskId,
        kernel.revision,
      ]),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(runTaskCli(["schedule", "list", "--json"], root)).toBe(0);
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
      scope: "task-kernel-v2",
      tasks: [
        { taskId: "schedule-candidate" },
        { taskId: "schedule-prerequisite" },
      ],
    });

    expect(runTaskCli(["schedule", "plan", "schedule-candidate"], root)).toBe(
      0,
    );
    const planned = JSON.parse(String(log.mock.lastCall?.[0])) as {
      receiptFile: string;
      receiptStatus: string;
      integrity: string;
      execution: string;
      receipt: {
        receiptFingerprint: string;
        createdAt: string;
        integrityVersion: number;
        candidateTaskIds: string[];
        taskKernelRevisions: Record<string, number>;
        request: { tasks: { taskId: string; dependsOn: string[] }[] };
      };
    };
    expect(planned).toMatchObject({
      receiptStatus: "created",
      integrity: "fingerprint-verified",
      execution: "not-dispatched",
      receipt: {
        scope: "task-kernel-v2",
        integrityVersion: 2,
        candidateTaskIds: ["schedule-candidate"],
        request: {
          tasks: [
            {
              taskId: "schedule-candidate",
              dependsOn: ["schedule-prerequisite"],
            },
            { taskId: "schedule-prerequisite", dependsOn: [] },
          ],
        },
      },
    });
    expect(planned.receipt.taskKernelRevisions).toEqual({
      "schedule-candidate": revisionsBefore.get("schedule-candidate"),
      "schedule-prerequisite": revisionsBefore.get("schedule-prerequisite"),
    });
    expect(
      listTaskKernelSnapshots(root).map(({ kernel }) => [
        kernel.identity.taskId,
        kernel.revision,
      ]),
    ).toEqual([...revisionsBefore.entries()]);

    expect(runTaskCli(["schedule", "plan", "schedule-candidate"], root)).toBe(
      0,
    );
    const replay = JSON.parse(String(log.mock.lastCall?.[0])) as {
      receiptStatus: string;
      receipt: { receiptFingerprint: string; createdAt: string };
    };
    expect(replay.receiptStatus).toBe("reused");
    expect(replay.receipt.receiptFingerprint).toBe(
      planned.receipt.receiptFingerprint,
    );
    expect(replay.receipt.createdAt).toBe(planned.receipt.createdAt);

    expect(
      runTaskCli(
        ["schedule", "show", planned.receipt.receiptFingerprint],
        root,
      ),
    ).toBe(0);
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
      receiptFile: planned.receiptFile,
      integrity: "fingerprint-verified",
      taskRevisionFreshness: "not-rechecked",
      execution: "not-dispatched",
      receipt: planned.receipt,
    });

    const receiptPath = path.resolve(root, planned.receiptFile);
    const tampered = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as {
      createdAt: string;
    };
    tampered.createdAt = "2000-01-01T00:00:00.000Z";
    fs.writeFileSync(
      receiptPath,
      `${JSON.stringify(tampered, null, 2)}\n`,
      "utf8",
    );
    expect(
      runTaskCli(
        ["schedule", "show", planned.receipt.receiptFingerprint],
        root,
      ),
    ).toBe(1);
    expect(String(error.mock.lastCall?.[0])).toContain(
      "fingerprint does not match",
    );
  });

  it("reuses a valid legacy receipt without presenting its unsigned createdAt as verified", () => {
    const root = makeRoot();
    createV2Task(root, "legacy-schedule-task");
    const planned = planTaskKernelGraphV1(root, ["legacy-schedule-task"]);
    const receiptBase = {
      candidateTaskIds: planned.candidateTaskIds,
      taskKernelRevisions: planned.taskKernelRevisions,
      request: planned.request,
      plan: planned.plan,
      lifecycle: planned.lifecycle,
    };
    const fingerprint = fingerprintTaskValue(receiptBase);
    const receipt = {
      ...receiptBase,
      schemaVersion: 1,
      scope: "task-kernel-v2",
      receiptFingerprint: fingerprint,
      createdAt: "2000-01-01T00:00:00.000Z",
    };
    const receiptDir = path.join(
      root,
      ".pactile",
      ".runtime",
      "scheduler",
      "receipts",
    );
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(
      path.join(receiptDir, `${fingerprint}.json`),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(runTaskCli(["schedule", "plan", "legacy-schedule-task"], root)).toBe(
      0,
    );
    const replayed = JSON.parse(String(log.mock.lastCall?.[0]));
    expect(replayed).toMatchObject({
      receiptStatus: "reused",
      integrity: "legacy-fingerprint-excludes-createdAt",
      unverifiedCreatedAt: "2000-01-01T00:00:00.000Z",
      receipt: { receiptFingerprint: fingerprint },
    });
    expect(replayed.receipt.createdAt).toBeUndefined();

    expect(runTaskCli(["schedule", "show", fingerprint], root)).toBe(0);
    const shown = JSON.parse(String(log.mock.lastCall?.[0]));
    expect(shown).toMatchObject({
      integrity: "legacy-fingerprint-excludes-createdAt",
      unverifiedCreatedAt: "2000-01-01T00:00:00.000Z",
    });
    expect(shown.receipt.createdAt).toBeUndefined();
  });
});
