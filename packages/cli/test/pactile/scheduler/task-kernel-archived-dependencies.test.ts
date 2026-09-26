import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeTaskKernel,
  createTaskKernel,
  recordTaskReview,
  recordTaskRunResult,
  startTaskRun,
} from "../../../src/core/task/index.js";
import { planTaskKernelGraphV1 } from "../../../src/pactile/scheduler/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pactile-archived-dependency-"),
  );
  roots.push(root);
  fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
  return root;
}

function createTask(
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
      description: "archived dependency fixture",
      deliverable: "one reviewable result",
      deliveryLevel: "local-result",
      acceptanceCriteria: [{ id: "AC-1", description: "result exists" }],
      dependencies,
    },
  });
  return taskDir;
}

function closeSuccessfully(root: string, taskId: string): string {
  const taskDir = createTask(root, taskId);
  const started = startTaskRun({
    root,
    taskDir,
    expectedRevision: 1,
    actor: "implementer",
    idempotencyKey: `run:${taskId}`,
    input: { summary: "complete the prerequisite", references: [] },
    authorization: {
      approvedBy: "approver",
      approvedAt: "2026-09-26T00:00:00.000Z",
      scope: "fixture",
      evidenceRef: "approval.json",
    },
  });
  const run = started.kernel.runs.at(-1);
  if (!run) throw new Error("Run was not started");
  const completed = recordTaskRunResult({
    root,
    taskDir,
    expectedRevision: started.kernel.revision,
    runId: run.id,
    outcome: "completed",
    summary: "prerequisite result is ready",
    candidateEntries: [{ ref: "result.txt", fingerprint: "a".repeat(64) }],
    evidenceRefs: ["tests.json"],
    actor: "implementer",
    idempotencyKey: `result:${taskId}`,
  });
  const candidateRun = completed.kernel.runs.at(-1);
  const candidate = candidateRun?.candidateSnapshot;
  if (!candidate) throw new Error("Run candidate was not recorded");
  const reviewed = recordTaskReview({
    root,
    taskDir,
    expectedRevision: completed.kernel.revision,
    runId: run.id,
    candidateSnapshotId: candidate.id,
    candidateFingerprint: candidate.fingerprint,
    reviewer: "reviewer",
    decision: "pass",
    evidenceRefs: ["review.json"],
    acceptanceEvidence: { "AC-1": ["result.txt"] },
    actor: "reviewer",
    idempotencyKey: `review:${taskId}`,
  });
  const review = reviewed.kernel.reviews.at(-1);
  if (!review) throw new Error("Review was not recorded");
  closeTaskKernel({
    root,
    taskDir,
    expectedRevision: reviewed.kernel.revision,
    runId: run.id,
    reviewId: review.id,
    candidateObservation: {
      snapshotId: candidate.id,
      fingerprint: candidate.fingerprint,
      observedBy: "closer",
      observedAt: "2026-09-26T00:05:00.000Z",
      source: "caller-attested",
      evidenceRef: "candidate.json",
    },
    deliveryEvidence: {
      level: "local-result",
      reference: "result.txt",
      summary: "The accepted deliverable is present",
    },
    actor: "closer",
    idempotencyKey: `close:${taskId}`,
  });
  return taskDir;
}

function cancelRun(root: string, taskDir: string, taskId: string): void {
  const started = startTaskRun({
    root,
    taskDir,
    expectedRevision: 1,
    actor: "implementer",
    idempotencyKey: `run:${taskId}`,
    input: { summary: "cancel the prerequisite", references: [] },
    authorization: {
      approvedBy: "approver",
      approvedAt: "2026-09-26T00:00:00.000Z",
      scope: "fixture",
      evidenceRef: "approval.json",
    },
  });
  const run = started.kernel.runs.at(-1);
  if (!run) throw new Error("Run was not started");
  recordTaskRunResult({
    root,
    taskDir,
    expectedRevision: started.kernel.revision,
    runId: run.id,
    outcome: "cancelled",
    failure: { category: "user-cancelled", message: "cancelled for test" },
    actor: "implementer",
    idempotencyKey: `cancel:${taskId}`,
  });
}

function archiveTask(root: string, taskDir: string, taskId: string): void {
  const archiveDir = path.join(root, ".pactile", "tasks", "archive", "2026-09");
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.renameSync(taskDir, path.join(archiveDir, taskId));
}

describe("V2 Task DAG archived dependencies", () => {
  it("uses a successfully closed archived dependency as context, never as a candidate", () => {
    const root = makeRoot();
    const prerequisiteDir = closeSuccessfully(root, "archived-success");
    createTask(root, "active-dependent", ["archived-success"]);
    archiveTask(root, prerequisiteDir, "archived-success");

    const planned = planTaskKernelGraphV1(root, ["active-dependent"]);
    expect(planned.candidateTaskIds).toEqual(["active-dependent"]);
    expect(planned.request.tasks).toHaveLength(2);
    expect(
      planned.request.tasks.find((task) => task.taskId === "active-dependent"),
    ).toMatchObject({
      taskId: "active-dependent",
      dependsOn: ["archived-success"],
      state: "waiting",
    });
    expect(
      planned.request.tasks.find((task) => task.taskId === "archived-success"),
    ).toMatchObject({
      taskId: "archived-success",
      dependsOn: [],
      state: "completed",
      writeSet: null,
    });
    expect(
      planned.plan.decisions.find(
        (decision) => decision.taskId === "active-dependent",
      )?.action,
    ).toBe("scheduled");
    expect(() => planTaskKernelGraphV1(root, ["archived-success"])).toThrow(
      /Unknown Task candidates: archived-success/,
    );
  });

  it.each(["cancelled", "uncompleted"] as const)(
    "rejects an archived %s hard dependency",
    (state) => {
      const root = makeRoot();
      const prerequisiteDir = createTask(root, `archived-${state}`);
      createTask(root, `dependent-on-${state}`, [`archived-${state}`]);
      if (state === "cancelled")
        cancelRun(root, prerequisiteDir, `archived-${state}`);
      archiveTask(root, prerequisiteDir, `archived-${state}`);

      expect(() =>
        planTaskKernelGraphV1(root, [`dependent-on-${state}`]),
      ).toThrow(
        new RegExp(
          `Archived hard Task dependency is not closed with completed outcome: archived-${state}`,
        ),
      );
    },
  );
});
