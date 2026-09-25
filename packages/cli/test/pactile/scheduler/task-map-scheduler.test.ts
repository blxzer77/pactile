import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTaskKernel,
  emptyTaskRecord,
  recordTaskReview,
  recordTaskRunResult,
  resumeTaskRun,
  startTaskRun,
  writeTaskRecord,
} from "../../../src/core/task/index.js";
import {
  writeTaskMap,
  type ChildEntry,
  type TaskMap,
} from "../../../src/pactile/task/task-map.js";
import {
  planParentTaskScheduleV1,
  planTaskKernelGraphV1,
  scheduleParentTaskGraph,
  scheduleTaskKernelGraph,
  type SchedulerTaskCostOverridesV1,
} from "../../../src/pactile/scheduler/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pactile-scheduler-project-"),
  );
  roots.push(root);
  fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
  return root;
}

function child(id: string, patch: Partial<ChildEntry> = {}): ChildEntry {
  return {
    id,
    state: "open",
    depends_on: [],
    touches: [],
    isolation: "git-worktree",
    ref: null,
    ...patch,
  };
}

function makeParent(root: string, children: ChildEntry[]): string {
  const dir = path.join(root, ".pactile", "tasks", "scheduler-parent");
  fs.mkdirSync(dir, { recursive: true });
  const map: TaskMap = {
    parent_id: "scheduler-parent",
    contract_epoch: 1,
    execution_topology: "parallel",
    merge_limit: 1,
    children,
    stages: [],
    integration_queue: [],
  };
  writeTaskMap(dir, map, "# Parent\n\n## Event Log\n");
  return dir;
}

function createV2Task(
  root: string,
  taskId: string,
  dependencies: string[] = [],
  options: {
    state?: "waiting" | "running";
    writeSet?: string[];
    estimatedCosts?: Partial<{
      executionMs: number;
      waitingMs: number;
      reviewMs: number;
    }>;
  } = {},
): string {
  const taskDir = path.join(root, ".pactile", "tasks", taskId);
  const created = createTaskKernel({
    root,
    taskDir,
    actor: "author",
    idempotencyKey: `create:${taskId}`,
    definition: {
      taskId,
      title: taskId,
      description: "scheduler fixture",
      deliverable: "one reviewable result",
      deliveryLevel: "local-result",
      acceptanceCriteria: [{ id: "AC-1", description: "result exists" }],
      dependencies,
    },
  });
  if (options.state) {
    startTaskRun({
      root,
      taskDir,
      expectedRevision: created.kernel.revision,
      actor: "implementer",
      idempotencyKey: `run:${taskId}`,
      input: { summary: "scheduler fixture", references: [] },
      authorization: {
        approvedBy: "approver",
        approvedAt: "2026-09-26T00:00:00.000Z",
        scope: "fixture",
        evidenceRef: "approval.json",
      },
      initialState: options.state,
      writeSetSnapshot: options.writeSet ?? [],
      estimatedDurations: options.estimatedCosts,
    });
  }
  return taskDir;
}

function createLegacyTask(
  root: string,
  taskId: string,
  status = "planning",
): string {
  const taskDir = path.join(root, ".pactile", "tasks", taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const record = emptyTaskRecord({
    id: taskId,
    name: taskId,
    title: taskId,
    creator: "author",
    assignee: "author",
  });
  writeTaskRecord({ taskDir, cwd: root, record: { ...record, status } });
  return taskDir;
}

function overrideDependencies(taskDir: string, dependencies: string[]): void {
  const file = path.join(taskDir, "kernel.json");
  const kernel = JSON.parse(fs.readFileSync(file, "utf8")) as {
    definition: { dependencies: string[] };
  };
  kernel.definition.dependencies = dependencies;
  fs.writeFileSync(file, `${JSON.stringify(kernel, null, 2)}\n`, "utf8");
}

describe("Parent Task Kernel schedule projection", () => {
  it("projects hard V2 dependencies, Run state, estimates, and Run write sets", () => {
    const root = makeRoot();
    createV2Task(root, "scheduler-prerequisite", [], {
      state: "running",
      writeSet: ["src/prerequisite.ts"],
      estimatedCosts: { executionMs: 100_000 },
    });
    createV2Task(root, "scheduler-dependent", ["scheduler-prerequisite"]);
    makeParent(root, [
      child("scheduler-prerequisite"),
      child("scheduler-dependent"),
    ]);

    const result = planParentTaskScheduleV1(root, "scheduler-parent");
    const prerequisite = result.lifecycle.find(
      (item) => item.taskId === "scheduler-prerequisite",
    );
    const dependent = result.lifecycle.find(
      (item) => item.taskId === "scheduler-dependent",
    );

    expect(prerequisite).toMatchObject({
      sourceKind: "task-kernel-v2",
      runState: "running",
      schedulerState: "running",
      writeSet: ["src/prerequisite.ts"],
      writeSetBasis: "task-run-writeSetSnapshot",
      estimatedCosts: { executionMs: 100_000 },
    });
    expect(dependent?.dependencyTaskIds).toEqual(["scheduler-prerequisite"]);
    expect(
      result.plan.decisions.find(
        (item) => item.taskId === "scheduler-dependent",
      )?.action,
    ).toBe("deferred");
  });

  it("fails closed for missing hard dependencies and dependency cycles", () => {
    const missingRoot = makeRoot();
    const missingDir = createV2Task(missingRoot, "scheduler-missing-child");
    overrideDependencies(missingDir, ["not-present"]);
    makeParent(missingRoot, [child("scheduler-missing-child")]);
    expect(() =>
      planParentTaskScheduleV1(missingRoot, "scheduler-parent"),
    ).toThrow(/Missing hard Task dependency: not-present/);

    const cycleRoot = makeRoot();
    const cycleA = createV2Task(cycleRoot, "scheduler-cycle-a");
    const cycleB = createV2Task(cycleRoot, "scheduler-cycle-b");
    overrideDependencies(cycleA, ["scheduler-cycle-b"]);
    overrideDependencies(cycleB, ["scheduler-cycle-a"]);
    makeParent(cycleRoot, [
      child("scheduler-cycle-a"),
      child("scheduler-cycle-b"),
    ]);
    expect(() =>
      planParentTaskScheduleV1(cycleRoot, "scheduler-parent"),
    ).toThrow(/dependency cycle/);
  });

  it("blocks descendants of blocked Tasks and unknown write scopes conflict by default", () => {
    const root = makeRoot();
    createV2Task(root, "scheduler-blocked-source");
    createV2Task(root, "scheduler-blocked-dependent", [
      "scheduler-blocked-source",
    ]);
    createV2Task(root, "scheduler-unknown-write");
    makeParent(root, [
      child("scheduler-blocked-source", { state: "blocked" }),
      child("scheduler-blocked-dependent"),
      child("scheduler-unknown-write"),
    ]);

    const result = planParentTaskScheduleV1(root, "scheduler-parent");
    expect(
      result.plan.decisions.find(
        (item) => item.taskId === "scheduler-blocked-source",
      )?.action,
    ).toBe("blocked");
    expect(
      result.plan.decisions.find(
        (item) => item.taskId === "scheduler-blocked-dependent",
      ),
    ).toMatchObject({
      action: "blocked",
      reasonCodes: ["blocked-by-dependency"],
    });
    expect(
      result.lifecycle.find((item) => item.taskId === "scheduler-unknown-write")
        ?.writeSet,
    ).toBeNull();
  });

  it("uses write conflicts, conflict authorization, and integration plans as hard scheduling gates", () => {
    const root = makeRoot();
    for (const taskId of ["scheduler-shared-a", "scheduler-shared-b"]) {
      createV2Task(root, taskId, [], {
        state: "waiting",
        writeSet: ["src/shared.ts"],
        estimatedCosts: { executionMs: 100_000, reviewMs: 20_000 },
      });
    }
    makeParent(root, [
      child("scheduler-shared-a"),
      child("scheduler-shared-b"),
    ]);

    const serial = planParentTaskScheduleV1(root, "scheduler-parent");
    expect(serial.plan.waves[0]?.taskIds).toHaveLength(1);
    expect(
      serial.plan.decisions.find((item) => item.taskId === "scheduler-shared-b")
        ?.reasonCodes,
    ).toContain("write-set-conflict-serialized");

    const parallel = planParentTaskScheduleV1(root, "scheduler-parent", {
      conflictParallelizations: [
        {
          taskIds: ["scheduler-shared-a", "scheduler-shared-b"],
          approvedBy: "human-reviewer",
          authorizationRef: "approval/P37-1",
          integrationPlan:
            "Integrate scheduler-shared-a, then scheduler-shared-b, and resolve the shared file once.",
        },
      ],
    });
    expect(parallel.plan.waves[0]).toMatchObject({
      taskIds: ["scheduler-shared-a", "scheduler-shared-b"],
      decision: "parallel-time-saved",
      conflictAuthorizations: [
        { approvedBy: "human-reviewer", authorizationRef: "approval/P37-1" },
      ],
    });
    expect(
      parallel.lifecycle.find((item) => item.taskId === "scheduler-shared-a")
        ?.estimatedCosts.reviewMs,
    ).toBe(20_000);
    expect(() =>
      planParentTaskScheduleV1(root, "scheduler-parent", {
        conflictParallelizations: [
          {
            taskIds: ["scheduler-shared-a", "scheduler-shared-b"],
            approvedBy: "human-reviewer",
            authorizationRef: "approval/P37-1",
            integrationPlan: " ",
          },
        ],
      }),
    ).toThrow(/integrationPlan/);
  });

  it("schedules more than four independent Tasks without an implicit numeric cap", () => {
    const root = makeRoot();
    const children = Array.from({ length: 7 }, (_, index) => {
      const id = `scheduler-unbounded-${index}`;
      createV2Task(root, id, [], {
        state: "waiting",
        writeSet: [`src/${id}.ts`],
        estimatedCosts: { executionMs: 80_000, reviewMs: 5_000 },
      });
      return child(id);
    });
    makeParent(root, children);

    const result = planParentTaskScheduleV1(root, "scheduler-parent");
    expect(result.plan.waves[0]?.taskIds).toHaveLength(7);
    expect(result.plan.waves[0]?.estimatedSavingsMs).toBeGreaterThan(0);
  });

  it("persists an idempotent, content-addressed decision receipt and leaves legacy records read-only", () => {
    const root = makeRoot();
    const legacyDir = createLegacyTask(root, "scheduler-legacy-child");
    const originalTaskRecord = fs.readFileSync(
      path.join(legacyDir, "task.json"),
      "utf8",
    );
    makeParent(root, [
      child("scheduler-legacy-child", { touches: ["docs/legacy.md"] }),
    ]);
    const first = scheduleParentTaskGraph(root, "scheduler-parent");
    const second = scheduleParentTaskGraph(root, "scheduler-parent");

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.receipt.receiptFingerprint).toBe(
      second.receipt.receiptFingerprint,
    );
    expect(first.receipt.lifecycle[0]).toMatchObject({
      sourceKind: "legacy-task-kernel-v1",
      schedulerState: "waiting",
      taskMapChildId: "scheduler-legacy-child",
      writeSet: ["docs/legacy.md"],
    });
    expect(fs.existsSync(path.join(legacyDir, "kernel.json"))).toBe(false);
    expect(fs.readFileSync(path.join(legacyDir, "task.json"), "utf8")).toBe(
      originalTaskRecord,
    );
    expect(fs.existsSync(path.resolve(root, first.receiptFile))).toBe(true);
    const receiptFile = path.resolve(root, first.receiptFile);
    const tampered = JSON.parse(fs.readFileSync(receiptFile, "utf8")) as {
      plan: { estimatedCompletionSavingsMs: number };
    };
    tampered.plan.estimatedCompletionSavingsMs += 1;
    fs.writeFileSync(receiptFile, `${JSON.stringify(tampered, null, 2)}\n`);
    expect(() => scheduleParentTaskGraph(root, "scheduler-parent")).toThrow(
      /fingerprint does not match its contents/,
    );
  });

  it("lets explicit cost estimates change the critical-path order", () => {
    const root = makeRoot();
    for (const taskId of ["scheduler-cost-a", "scheduler-cost-b"]) {
      createV2Task(root, taskId, [], {
        state: "waiting",
        writeSet: [`src/${taskId}.ts`],
      });
    }
    makeParent(root, [child("scheduler-cost-a"), child("scheduler-cost-b")]);
    const costs: SchedulerTaskCostOverridesV1 = {
      "scheduler-cost-a": { executionMs: 100_000 },
      "scheduler-cost-b": { executionMs: 20_000 },
    };

    const result = planParentTaskScheduleV1(root, "scheduler-parent", {
      estimatedCosts: costs,
    });
    expect(result.plan.waves[0]?.taskIds).toContain("scheduler-cost-a");
    expect(
      result.lifecycle.find((item) => item.taskId === "scheduler-cost-a")
        ?.estimateBasis.executionMs,
    ).toBe("caller-estimate");
  });

  it("records measured Run wait, execution, review, integration, and rework intervals with evidence refs", () => {
    const root = makeRoot();
    const taskDir = createV2Task(root, "scheduler-observed-costs");
    makeParent(root, [child("scheduler-observed-costs")]);
    const created = JSON.parse(
      fs.readFileSync(path.join(taskDir, "kernel.json"), "utf8"),
    ) as { revision: number; identity: { taskId: string } };
    const queued = startTaskRun({
      root,
      taskDir,
      expectedRevision: created.revision,
      actor: "implementer",
      idempotencyKey: "observed:queue",
      input: { summary: "observe lifecycle", references: [] },
      authorization: {
        approvedBy: "approver",
        approvedAt: "2026-09-26T00:00:00.000Z",
        scope: "fixture",
        evidenceRef: "approval.json",
      },
      initialState: "waiting",
    });
    const queuedRun = queued.kernel.runs[0];
    if (!queuedRun) throw new Error("waiting Run was not recorded");
    const runId = queuedRun.id;
    const started = resumeTaskRun({
      root,
      taskDir,
      expectedRevision: queued.kernel.revision,
      runId,
      actor: "scheduler",
      idempotencyKey: "observed:start",
    });
    const completed = recordTaskRunResult({
      root,
      taskDir,
      expectedRevision: started.kernel.revision,
      runId,
      outcome: "completed",
      summary: "candidate ready",
      candidateEntries: [{ ref: "result.txt", fingerprint: "a".repeat(64) }],
      actor: "implementer",
      idempotencyKey: "observed:complete",
    });
    const candidate = completed.kernel.runs[0]?.candidateSnapshot;
    if (!candidate) throw new Error("completed Run candidate was not recorded");
    recordTaskReview({
      root,
      taskDir,
      expectedRevision: completed.kernel.revision,
      runId,
      candidateSnapshotId: candidate.id,
      candidateFingerprint: candidate.fingerprint,
      reviewer: "reviewer",
      decision: "needs-changes",
      evidenceRefs: ["review.md"],
      unresolvedBlockers: ["one follow-up"],
      actor: "reviewer",
      idempotencyKey: "observed:review",
    });
    const parentDir = path.join(root, ".pactile", "tasks", "scheduler-parent");
    fs.appendFileSync(
      path.join(parentDir, "task-map.md"),
      [
        "- 2026-09-26T00:00:00.000Z - Child reported scheduler-observed-costs as changes.",
        "- 2026-09-26T00:00:00.010Z - Child reported scheduler-observed-costs as accepted.",
        "- 2026-09-26T00:00:00.020Z - Child reported scheduler-observed-costs as integrating.",
        "- 2026-09-26T00:00:00.035Z - Parent integrated scheduler-observed-costs as integrated.",
        "",
      ].join("\n"),
    );

    const result = planParentTaskScheduleV1(root, "scheduler-parent");
    const snapshot = result.lifecycle[0];
    expect(snapshot?.observedCosts.waitingMs).not.toBeNull();
    expect(snapshot?.observedCosts.executionMs).not.toBeNull();
    expect(snapshot?.observedCosts.reviewMs).not.toBeNull();
    expect(snapshot?.observedCosts.reworkMs).toBe(10);
    expect(snapshot?.observedCosts.integrationMs).toBe(15);
    expect(
      snapshot?.observedCostEvidenceRefs.some((ref) =>
        ref.startsWith("kernel-event:"),
      ),
    ).toBe(true);
    expect(snapshot?.observedCostEvidenceRefs).toContain(
      "task-map-event-log:scheduler-observed-costs",
    );
  });

  it("schedules a V2 Task/Run DAG directly without a Parent or Child map and replays its receipt", () => {
    const root = makeRoot();
    createV2Task(root, "v2-hard-prerequisite");
    createV2Task(root, "v2-hard-dependent", ["v2-hard-prerequisite"]);

    const planned = planTaskKernelGraphV1(
      root,
      ["v2-hard-prerequisite", "v2-hard-dependent"],
      {
        estimatedCosts: {
          "v2-hard-prerequisite": { executionMs: 100_000 },
          "v2-hard-dependent": { executionMs: 30_000 },
        },
      },
    );
    expect(planned.plan.waves.map((wave) => wave.taskIds)).toEqual([
      ["v2-hard-prerequisite"],
      ["v2-hard-dependent"],
    ]);
    expect(
      planned.plan.decisions.find(
        (decision) => decision.taskId === "v2-hard-dependent",
      )?.reasonCodes,
    ).toContain("ready-dependencies");
    expect(
      fs.existsSync(path.join(root, ".pactile", "tasks", "scheduler-parent")),
    ).toBe(false);

    const first = scheduleTaskKernelGraph(root, [
      "v2-hard-prerequisite",
      "v2-hard-dependent",
    ]);
    const second = scheduleTaskKernelGraph(root, [
      "v2-hard-prerequisite",
      "v2-hard-dependent",
    ]);
    expect(first.receipt.scope).toBe("task-kernel-v2");
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.receipt.receiptFingerprint).toBe(
      first.receipt.receiptFingerprint,
    );
    expect(fs.existsSync(path.resolve(root, first.receiptFile))).toBe(true);
    expect(
      fs.existsSync(path.join(root, ".pactile", "tasks", "scheduler-parent")),
    ).toBe(false);
    const receiptFile = path.resolve(root, first.receiptFile);
    const tampered = JSON.parse(fs.readFileSync(receiptFile, "utf8")) as {
      plan: { estimatedCompletionSavingsMs: number };
    };
    tampered.plan.estimatedCompletionSavingsMs += 1;
    fs.writeFileSync(receiptFile, `${JSON.stringify(tampered, null, 2)}\n`);
    expect(() =>
      scheduleTaskKernelGraph(root, [
        "v2-hard-prerequisite",
        "v2-hard-dependent",
      ]),
    ).toThrow(/fingerprint does not match its contents/);
  });

  it("prioritizes a longer critical path, serializes conflicting V2 writes, and has no four-task cap", () => {
    const root = makeRoot();
    createV2Task(root, "v2-short-conflict", [], {
      state: "waiting",
      writeSet: ["src/shared.ts"],
    });
    createV2Task(root, "v2-critical-conflict", [], {
      state: "waiting",
      writeSet: ["src/shared.ts"],
    });
    createV2Task(root, "v2-critical-tail", ["v2-critical-conflict"]);
    const longPath = planTaskKernelGraphV1(
      root,
      ["v2-short-conflict", "v2-critical-conflict", "v2-critical-tail"],
      {
        estimatedCosts: {
          "v2-short-conflict": { executionMs: 20_000 },
          "v2-critical-conflict": { executionMs: 40_000 },
          "v2-critical-tail": { executionMs: 30_000 },
        },
      },
    );
    expect(
      longPath.plan.decisions.find(
        (decision) => decision.taskId === "v2-critical-conflict",
      )?.criticalPathMs,
    ).toBeGreaterThan(
      longPath.plan.decisions.find(
        (decision) => decision.taskId === "v2-short-conflict",
      )?.criticalPathMs ?? 0,
    );
    expect(longPath.plan.waves[0]?.taskIds).toEqual(["v2-critical-conflict"]);
    expect(
      longPath.plan.decisions.find(
        (decision) => decision.taskId === "v2-short-conflict",
      )?.reasonCodes,
    ).toContain("write-set-conflict-serialized");

    const manyRoot = makeRoot();
    const manyCandidates = Array.from(
      { length: 40 },
      (_, index) => `v2-many-${index}`,
    );
    for (const taskId of manyCandidates) {
      createV2Task(manyRoot, taskId, [], {
        state: "waiting",
        writeSet: [`src/${taskId}.ts`],
        estimatedCosts: { executionMs: 50_000 },
      });
    }
    const many = planTaskKernelGraphV1(manyRoot, manyCandidates);
    expect(many.plan.waves[0]?.taskIds).toHaveLength(40);
  });

  it("rejects missing and cyclic V2 hard dependencies without a Parent map", () => {
    const missingRoot = makeRoot();
    const missingDir = createV2Task(missingRoot, "v2-missing-dependency", [], {
      state: "waiting",
    });
    overrideDependencies(missingDir, ["v2-not-present"]);
    expect(() =>
      planTaskKernelGraphV1(missingRoot, ["v2-missing-dependency"]),
    ).toThrow(/Missing hard Task dependency: v2-not-present/);

    const cycleRoot = makeRoot();
    const cycleA = createV2Task(cycleRoot, "v2-cycle-a", [], {
      state: "waiting",
    });
    const cycleB = createV2Task(cycleRoot, "v2-cycle-b", [], {
      state: "waiting",
    });
    overrideDependencies(cycleA, ["v2-cycle-b"]);
    overrideDependencies(cycleB, ["v2-cycle-a"]);
    expect(() => planTaskKernelGraphV1(cycleRoot, ["v2-cycle-a"])).toThrow(
      /dependency cycle/,
    );
  });
});
