import { describe, expect, it } from "vitest";

import {
  planTaskScheduleV1,
  TaskScheduleError,
  type SchedulerCostVectorV1,
  type SchedulerTaskV1,
  type TaskScheduleRequestV1,
} from "../../../src/pactile/scheduler/index.js";

const zeroCosts = (): SchedulerCostVectorV1 => ({
  latencyMs: 0,
  waitingMs: 0,
  executionMs: 0,
  integrationMs: 0,
  reworkMs: 0,
  reviewMs: 0,
});

function task(
  taskId: string,
  overrides: Partial<SchedulerTaskV1> & { costMs?: number } = {},
): SchedulerTaskV1 {
  const { costMs = 10, ...taskOverrides } = overrides;
  return {
    taskId,
    dependsOn: [],
    state: "waiting",
    writeSet: [`src/${taskId}.ts`],
    estimatedCosts: { ...zeroCosts(), executionMs: costMs },
    ...taskOverrides,
  };
}

function request(
  tasks: readonly SchedulerTaskV1[],
  overrides: Partial<TaskScheduleRequestV1> = {},
): TaskScheduleRequestV1 {
  return { schemaVersion: 1, tasks, ...overrides };
}

function expectSchedulerError(
  action: () => unknown,
  code: TaskScheduleError["code"],
): void {
  try {
    action();
    throw new Error("expected scheduler error");
  } catch (error) {
    expect(error).toBeInstanceOf(TaskScheduleError);
    expect((error as TaskScheduleError).code).toBe(code);
  }
}

describe("Pactile Task scheduler V1 validation", () => {
  it("rejects missing dependencies and cycles before producing a plan", () => {
    expectSchedulerError(
      () =>
        planTaskScheduleV1(request([task("a", { dependsOn: ["missing"] })])),
      "missing-dependency",
    );
    expectSchedulerError(
      () =>
        planTaskScheduleV1(
          request([
            task("a", { dependsOn: ["b"] }),
            task("b", { dependsOn: ["a"] }),
          ]),
        ),
      "dependency-cycle",
    );
  });

  it("rejects a conflict-parallelization authorization without an integration plan", () => {
    const invalidAuthorization = {
      taskIds: ["a", "b"],
      approvedBy: "owner",
      authorizationRef: "approval:p37",
      integrationPlan: "  ",
    } as unknown as NonNullable<
      TaskScheduleRequestV1["conflictParallelizations"]
    >[number];
    expectSchedulerError(
      () =>
        planTaskScheduleV1(
          request(
            [
              task("a", { writeSet: ["src/shared"] }),
              task("b", { writeSet: ["src/shared/child.ts"] }),
            ],
            { conflictParallelizations: [invalidAuthorization] },
          ),
        ),
      "invalid-conflict-authorization",
    );
  });

  it("rejects an authorization that does not name an actual write-set conflict", () => {
    expectSchedulerError(
      () =>
        planTaskScheduleV1(
          request(
            [
              task("a", { writeSet: ["src/a.ts"] }),
              task("b", { writeSet: ["src/b.ts"] }),
            ],
            {
              conflictParallelizations: [
                {
                  taskIds: ["a", "b"],
                  approvedBy: "owner",
                  authorizationRef: "approval:p37",
                  integrationPlan: "Integrate a before b.",
                },
              ],
            },
          ),
        ),
      "invalid-conflict-authorization",
    );
  });
});

describe("Pactile Task scheduler V1 plan", () => {
  it("schedules dependency-ready DAG waves and returns a deterministic receipt", () => {
    const tasks = [
      task("a", { costMs: 10 }),
      task("b", { dependsOn: ["a"], costMs: 20 }),
      task("c", { costMs: 5 }),
    ];
    const first = planTaskScheduleV1(request(tasks));
    const second = planTaskScheduleV1(request([...tasks].reverse()));

    expect(first).toEqual(second);
    expect(first.waves).toMatchObject([
      { taskIds: ["a", "c"], estimatedDurationMs: 10, estimatedSavingsMs: 5 },
      { taskIds: ["b"], startedAfterMs: 10, estimatedDurationMs: 20 },
    ]);
    expect(first.estimatedCompletionSavingsMs).toBe(5);
    expect(
      first.decisions.find((decision) => decision.taskId === "b")
        ?.criticalPathMs,
    ).toBe(20);
  });

  it("does not schedule blocked work or let a Jev hint override a hard dependency", () => {
    const receipt = planTaskScheduleV1(
      request(
        [
          task("blocked", { state: "blocked", costMs: 100 }),
          task("waiting-child", { dependsOn: ["blocked"], costMs: 100 }),
          task("ready", { costMs: 5 }),
        ],
        {
          jevAdvice: {
            taskOrder: ["waiting-child", "blocked", "ready"],
            evidenceRef: "jev:hint-1",
          },
        },
      ),
    );

    expect(receipt.waves.map((wave) => wave.taskIds)).toEqual([["ready"]]);
    expect(
      receipt.decisions.find((decision) => decision.taskId === "blocked"),
    )?.toMatchObject({
      action: "blocked",
      reasonCodes: ["task-blocked"],
    });
    expect(
      receipt.decisions.find((decision) => decision.taskId === "waiting-child"),
    )?.toMatchObject({
      action: "blocked",
      reasonCodes: ["blocked-by-dependency"],
    });
    expect(receipt.jevAdvice).toMatchObject({
      evidenceRef: "jev:hint-1",
      ignoredTaskIds: ["waiting-child", "blocked"],
    });
  });

  it("serializes overlapping write sets by default, including ancestor paths", () => {
    const receipt = planTaskScheduleV1(
      request([
        task("a", { writeSet: ["src/shared/"], costMs: 8 }),
        task("b", { writeSet: ["SRC\\SHARED\\child.ts"], costMs: 7 }),
      ]),
    );

    expect(receipt.waves.map((wave) => wave.taskIds)).toEqual([["a"], ["b"]]);
    expect(receipt.waves.every((wave) => wave.estimatedSavingsMs === 0)).toBe(
      true,
    );
    expect(
      receipt.decisions.find((decision) => decision.taskId === "b")
        ?.reasonCodes,
    ).toContain("write-set-conflict-serialized");
  });

  it("treats an unknown write set as conflicting with writers but not known read-only tasks", () => {
    const unknownAndWriter = planTaskScheduleV1(
      request([
        task("unknown", { writeSet: null, costMs: 5 }),
        task("writer", { writeSet: ["src/result.ts"], costMs: 5 }),
      ]),
    );
    const unknownAndReadOnly = planTaskScheduleV1(
      request([
        task("unknown", { writeSet: null, costMs: 5 }),
        task("reader", { writeSet: [], costMs: 5 }),
      ]),
    );

    expect(unknownAndWriter.waves.map((wave) => wave.taskIds)).toEqual([
      ["unknown"],
      ["writer"],
    ]);
    expect(unknownAndReadOnly.waves).toHaveLength(1);
    expect(unknownAndReadOnly.waves[0]?.taskIds).toEqual(["reader", "unknown"]);
  });

  it("does not parallelize a compatible group when the estimate shows no completion-time gain", () => {
    const receipt = planTaskScheduleV1(
      request([
        task("a", { estimatedCosts: { ...zeroCosts(), integrationMs: 5 } }),
        task("b", { estimatedCosts: { ...zeroCosts(), reviewMs: 5 } }),
      ]),
    );

    expect(receipt.waves.map((wave) => wave.taskIds)).toEqual([["a"], ["b"]]);
    expect(receipt.waves[0]).toMatchObject({
      decision: "parallelism-rejected-no-time-saved",
      candidateTaskIds: ["a", "b"],
      candidateSerialEquivalentMs: 10,
      candidateParallelDurationMs: 10,
      candidateEstimatedSavingsMs: 0,
    });
  });

  it("defers an active write conflict unless an exact pair authorization is recorded", () => {
    const receipt = planTaskScheduleV1(
      request([
        task("active", {
          state: "running",
          writeSet: ["src/shared.ts"],
          costMs: 20,
        }),
        task("waiting", { writeSet: ["src/shared.ts"], costMs: 10 }),
      ]),
    );

    expect(receipt.waves).toEqual([]);
    expect(
      receipt.decisions.find((decision) => decision.taskId === "waiting"),
    ).toMatchObject({
      action: "deferred",
      reasonCodes: ["active-write-set-conflict"],
    });
  });

  it("allows overlapping writes only with recorded authorization and integration plan", () => {
    const authorization = {
      taskIds: ["a", "b"] as const,
      approvedBy: "task-owner",
      authorizationRef: "approval:p37-conflict-1",
      integrationPlan:
        "Apply a, resolve the shared file, then apply b and run the shared checks.",
    };
    const receipt = planTaskScheduleV1(
      request(
        [
          task("a", { writeSet: ["src/shared.ts"], costMs: 10 }),
          task("b", { writeSet: ["src/shared.ts"], costMs: 10 }),
        ],
        { conflictParallelizations: [authorization] },
      ),
    );

    expect(receipt.waves).toHaveLength(1);
    expect(receipt.waves[0]).toMatchObject({
      taskIds: ["a", "b"],
      decision: "parallel-time-saved",
      estimatedSavingsMs: 10,
      conflictAuthorizations: [authorization],
    });
  });

  it("uses no fixed concurrency cap for disjoint tasks when their plan saves time", () => {
    const tasks = Array.from({ length: 9 }, (_, index) =>
      task(`task-${index + 1}`, { costMs: 5 }),
    );
    const receipt = planTaskScheduleV1(request(tasks));

    expect(receipt.waves).toHaveLength(1);
    expect(receipt.waves[0]?.taskIds).toHaveLength(9);
    expect(receipt.waves[0]?.estimatedSavingsMs).toBe(40);
    expect(receipt.waves[0]).not.toHaveProperty("concurrencyLimit");
  });

  it("reorders conflicting work when downstream critical-path or review cost changes", () => {
    const initial = [
      task("a", { writeSet: ["src/shared.ts"], costMs: 1 }),
      task("a-next", { dependsOn: ["a"], costMs: 20 }),
      task("b", { writeSet: ["src/shared.ts"], costMs: 10 }),
    ];
    const before = planTaskScheduleV1(request(initial));
    const after = planTaskScheduleV1(
      request([
        ...initial.slice(0, 2),
        task("b", {
          writeSet: ["src/shared.ts"],
          estimatedCosts: { ...zeroCosts(), executionMs: 10, reviewMs: 40 },
        }),
      ]),
    );

    expect(before.waves[0]?.taskIds).toEqual(["a"]);
    expect(after.waves[0]?.taskIds).toEqual(["b"]);
    expect(
      after.decisions.find((decision) => decision.taskId === "b")
        ?.criticalPathMs,
    ).toBe(50);
  });

  it("uses Jev only as a tie-break and records measured delay, waiting, rework, and review", () => {
    const receipt = planTaskScheduleV1(
      request(
        [
          task("a", {
            estimatedCosts: { ...zeroCosts(), executionMs: 10 },
            observedCosts: {
              latencyMs: 2,
              waitingMs: 3,
              reworkMs: 4,
              reviewMs: 5,
            },
          }),
          task("z", { estimatedCosts: { ...zeroCosts(), executionMs: 10 } }),
          task("blocked", { state: "blocked" }),
        ],
        {
          jevAdvice: {
            taskOrder: ["blocked", "z", "a"],
            evidenceRef: "jev:cost-hint",
          },
        },
      ),
    );

    expect(receipt.waves[0]?.taskIds).toEqual(["z", "a"]);
    expect(
      receipt.decisions.find((decision) => decision.taskId === "a")
        ?.observedCosts,
    ).toEqual({
      latencyMs: 2,
      waitingMs: 3,
      executionMs: null,
      integrationMs: null,
      reworkMs: 4,
      reviewMs: 5,
    });
    expect(receipt.jevAdvice).toMatchObject({
      tieBreakAppliedTaskIds: ["a", "z"],
      ignoredTaskIds: ["blocked"],
    });
  });
});
