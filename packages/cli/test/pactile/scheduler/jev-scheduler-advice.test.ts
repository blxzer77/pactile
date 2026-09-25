import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTaskCli } from "../../../src/commands/task.js";
import {
  createJevDecisionFacadeV1,
  type JevDecisionFacadeV1,
  type JevEgressAuthorizationV1,
} from "../../../src/pactile/jev/index.js";
import {
  planParentTaskScheduleV1,
  scheduleParentTaskGraph,
  scheduleParentTaskGraphWithJevV1,
} from "../../../src/pactile/scheduler/index.js";
import { reserveParallelChild } from "../../../src/pactile/parallel/policy.js";
import {
  writeTaskMap,
  type ChildEntry,
  type TaskMap,
} from "../../../src/pactile/task/task-map.js";

const roots: string[] = [];

const egress: JevEgressAuthorizationV1 = {
  network: "project-authorized",
  privacy: "project-approved-egress",
  credentials: "project-authorized",
  destination: "https://api.typesafe.ai",
  egressDestinations: ["https://api.typesafe.ai"],
  contentDecision: "task-summary-approved",
};

const implementationContract = (isolation: "main-worktree" | "git-worktree") =>
  `execution_mode: worker\nisolation: ${isolation}\nverification_profile: standard\nretrieval_profile: exact-only\noptional_capabilities: []\nquality_gates:\n  mode: profile\n`;

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-jev-schedule-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".pactile", "worktrees"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".pactile", "config.yaml"),
    "artifact_locale: en\n",
  );
  fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=tester\n");
  return root;
}

function child(
  id: string,
  touches: string[],
  isolation: "main-worktree" | "git-worktree" = "main-worktree",
): ChildEntry {
  return {
    id,
    state: "open",
    depends_on: [],
    touches,
    isolation,
    ref: null,
  };
}

function createParent(root: string, children: ChildEntry[]): string {
  expect(
    runTaskCli(
      [
        "legacy-create",
        "jev-scheduler-parent",
        "--slug",
        "jev-scheduler-parent",
      ],
      root,
    ),
  ).toBe(0);
  const tasksRoot = path.join(root, ".pactile", "tasks");
  const parentName = fs
    .readdirSync(tasksRoot)
    .find((name) => name.endsWith("-jev-scheduler-parent"));
  if (!parentName) throw new Error("Parent task was not created");
  const parentDir = path.join(tasksRoot, parentName);
  for (const { id } of children) {
    expect(runTaskCli(["add-subtask", parentName, id], root)).toBe(0);
  }
  const map: TaskMap = {
    parent_id: "jev-scheduler-parent",
    contract_epoch: 1,
    execution_topology: "parallel",
    merge_limit: 1,
    children,
    stages: [],
    integration_queue: [],
  };
  writeTaskMap(parentDir, map, "# Parent\n\n## Event Log\n");
  return parentDir;
}

function createTask(
  root: string,
  slug: string,
  options: {
    isolation?: "main-worktree" | "git-worktree";
  } = {},
): string {
  expect(runTaskCli(["legacy-create", slug, "--slug", slug], root)).toBe(0);
  const tasksRoot = path.join(root, ".pactile", "tasks");
  const taskId = fs
    .readdirSync(tasksRoot)
    .find((name) => name.endsWith(`-${slug}`));
  if (!taskId) throw new Error(`Task was not created: ${slug}`);
  const taskDir = path.join(tasksRoot, taskId);
  fs.writeFileSync(
    path.join(taskDir, "design.md"),
    "# Design\nBounded fixture.\n",
  );
  fs.writeFileSync(
    path.join(taskDir, "implement.md"),
    implementationContract(options.isolation ?? "main-worktree"),
  );
  return taskId;
}

function approveTask(root: string, taskId: string): void {
  expect(runTaskCli(["start-execution", taskId, "--approved"], root)).toBe(0);
}

function prepareGitWorktree(
  root: string,
  parentId: string,
  taskId: string,
): void {
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  if (!fs.existsSync(path.join(root, ".git"))) {
    git("init");
    fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
    git("add", "README.md");
    git(
      "-c",
      "user.name=Pactile Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
  }
  expect(
    runTaskCli(
      [
        "prepare-child-worktree",
        parentId,
        taskId,
        "--branch",
        `feat/${taskId}`,
        "--base",
        "HEAD",
      ],
      root,
    ),
  ).toBe(0);
}

function scheduleOptions(root: string) {
  const snapshot = planParentTaskScheduleV1(root, "jev-scheduler-parent");
  return {
    estimatedCosts: Object.fromEntries(
      snapshot.lifecycle.map(({ taskId }) => [taskId, { executionMs: 100 }]),
    ),
  };
}

function scheduleTaskId(root: string, childFolderId: string): string {
  const snapshot = planParentTaskScheduleV1(root, "jev-scheduler-parent");
  const lifecycle = snapshot.lifecycle.find(
    (item) => item.taskMapChildId === childFolderId,
  );
  if (!lifecycle) throw new Error(`Missing scheduled Child: ${childFolderId}`);
  return lifecycle.taskId;
}

function answeredFacade(
  beforeAnswer?: () => void,
  latencyMs = 7,
  selectedChoice: "candidate-01" | "candidate-02" = "candidate-02",
): JevDecisionFacadeV1 & { decide: ReturnType<typeof vi.fn> } {
  return {
    decide: vi.fn(async () => {
      beforeAnswer?.();
      const otherChoice =
        selectedChoice === "candidate-01" ? "candidate-02" : "candidate-01";
      return {
        node: "task-scheduling" as const,
        status: "answered" as const,
        answers: {
          first_task: {
            type: "choice" as const,
            choice: selectedChoice,
            confidence: 0.96,
            probabilities: {
              [selectedChoice]: 0.96,
              [otherChoice]: 0.04,
            },
          },
        },
        fallback: null,
        receipt: {
          schemaVersion: 1 as const,
          node: "task-scheduling" as const,
          transport: {
            provider: "typesafe-jev" as const,
            outcome: "answered" as const,
            reasonCode: null,
            attempts: 1,
            latencyMs,
            httpStatus: 200,
            requestId: "request-safe",
            model: "jev-test",
            inputTokens: 42,
            outputTokens: 0,
            estimatedInputCostMicrousd: 2,
          },
          budget: {
            maxDecisions: 1,
            decisionsUsed: 1,
            decisionsRemaining: 0,
            maximumHttpAttempts: 2,
            observedEstimatedInputCostMicrousd: 2,
          },
        },
      };
    }),
  };
}

function approvedPair(
  root: string,
  isolation: "main-worktree" | "git-worktree" = "main-worktree",
  touches: readonly [string, string] = ["src/alpha.ts", "src/beta.ts"],
) {
  const first = createTask(root, "alpha", { isolation });
  const second = createTask(root, "beta", { isolation });
  createParent(root, [
    child(first, [touches[0]], isolation),
    child(second, [touches[1]], isolation),
  ]);
  approveTask(root, first);
  approveTask(root, second);
  return { first, second };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("P34 Jev scheduler advice", () => {
  it("uses an approved same-critical-path tie-break and stores a content-free audit", async () => {
    const root = makeRoot();
    const { first, second } = approvedPair(root, "main-worktree", [
      "CONFIDENTIAL/payroll.csv",
      "SECRET/internal-plan.md",
    ]);
    const firstTaskId = scheduleTaskId(root, first);
    const secondTaskId = scheduleTaskId(root, second);
    const priorSchedule = scheduleParentTaskGraph(
      root,
      "jev-scheduler-parent",
      scheduleOptions(root),
    );
    const priorReceiptPath = path.join(root, priorSchedule.receiptFile);
    const priorReceiptContents = fs.readFileSync(priorReceiptPath, "utf8");
    const facade = answeredFacade();

    const result = await scheduleParentTaskGraphWithJevV1(
      root,
      "jev-scheduler-parent",
      scheduleOptions(root),
      { facade, egress },
    );

    expect(facade.decide).toHaveBeenCalledTimes(1);
    expect(result.receipt.request.jevAdvice?.taskOrder).toEqual([
      secondTaskId,
      firstTaskId,
    ]);
    expect(result.receipt.plan.waves[0]?.taskIds[0]).toBe(secondTaskId);
    expect(result.receiptFile).not.toBe(priorSchedule.receiptFile);
    expect(fs.readFileSync(priorReceiptPath, "utf8")).toBe(
      priorReceiptContents,
    );
    expect(result.receipt.jevAdviceAudit).toMatchObject({
      status: "answered",
      preparedRequestSnapshot: {
        candidateTaskIds: [firstTaskId, secondTaskId],
        inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      sentRequestSnapshot: {
        candidateTaskIds: [firstTaskId, secondTaskId],
        inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      finalEligibleCandidates: {
        candidateTaskIds: [firstTaskId, secondTaskId],
        filteredCandidates: [],
        eligibility: {
          approvalPassedTaskIds: [firstTaskId, secondTaskId],
          worktreePassedTaskIds: [firstTaskId, secondTaskId],
        },
      },
      eligibilityChanged: false,
      suggestedTaskIds: [secondTaskId, firstTaskId],
      adoptedTaskIds: [secondTaskId, firstTaskId],
      overriddenTaskIds: [],
      transport: {
        latencyMs: 7,
        attempts: 1,
        httpStatus: 200,
        model: "jev-test",
      },
    });
    const invocation = facade.decide.mock.calls[0]?.[0] as {
      request: { taskSummary: string; sourceSnippets?: readonly unknown[] };
    };
    expect(invocation.request.sourceSnippets).toBeUndefined();
    expect(invocation.request.taskSummary).not.toContain(first);
    expect(invocation.request.taskSummary).not.toContain(second);
    expect(invocation.request.taskSummary).not.toContain(root);
    expect(invocation.request.taskSummary).not.toMatch(
      /CONFIDENTIAL|SECRET|payroll|internal-plan/u,
    );
    expect(
      result.receipt.jevAdviceAudit?.sentRequestSnapshot?.inputDigest,
    ).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(result.receipt.jevAdviceAudit)).not.toContain(
      "test-key",
    );
    expect(JSON.stringify(result.receipt.jevAdviceAudit)).not.toContain(
      invocation.request.taskSummary,
    );
  });

  it("records a recommendation matching deterministic order as adopted", async () => {
    const root = makeRoot();
    const { first, second } = approvedPair(root);
    const taskIds = [scheduleTaskId(root, first), scheduleTaskId(root, second)];
    const baseline = scheduleParentTaskGraph(
      root,
      "jev-scheduler-parent",
      scheduleOptions(root),
    );
    const baselineOrder = baseline.receipt.plan.waves[0]?.candidateTaskIds.filter(
      (taskId) => taskIds.includes(taskId),
    );

    const result = await scheduleParentTaskGraphWithJevV1(
      root,
      "jev-scheduler-parent",
      scheduleOptions(root),
      { facade: answeredFacade(undefined, 7, "candidate-01"), egress },
    );

    expect(result.receipt.jevAdviceAudit?.suggestedTaskIds).toEqual(
      baselineOrder,
    );
    expect(result.receipt.jevAdviceAudit).toMatchObject({
      adoptedTaskIds: baselineOrder,
      overriddenTaskIds: [],
    });
  });

  it("filters a rejected approval and never calls Jev with only one eligible candidate", async () => {
    const root = makeRoot();
    const approved = createTask(root, "approved", {
      isolation: "main-worktree",
    });
    const unapproved = createTask(root, "unapproved", {
      isolation: "main-worktree",
    });
    createParent(root, [
      child(approved, ["src/approved.ts"]),
      child(unapproved, ["src/unapproved.ts"]),
    ]);
    approveTask(root, approved);
    const approvedTaskId = scheduleTaskId(root, approved);
    const unapprovedTaskId = scheduleTaskId(root, unapproved);
    const facade = answeredFacade();

    const result = await scheduleParentTaskGraphWithJevV1(
      root,
      "jev-scheduler-parent",
      scheduleOptions(root),
      { facade, egress },
    );

    expect(facade.decide).not.toHaveBeenCalled();
    expect(result.receipt.request.jevAdvice).toBeUndefined();
    expect(result.receipt.jevAdviceAudit).toMatchObject({
      status: "skipped",
      reasonCode: "insufficient-candidates",
      sentRequestSnapshot: null,
      finalEligibleCandidates: {
        candidateTaskIds: [approvedTaskId],
        filteredCandidates: [
          { taskId: unapprovedTaskId, reasonCode: "approval-rejected" },
        ],
      },
    });
  });

  it("filters a missing required worktree before requesting Jev advice", async () => {
    const root = makeRoot();
    const first = createTask(root, "alpha", { isolation: "git-worktree" });
    const second = createTask(root, "beta", { isolation: "main-worktree" });
    createParent(root, [
      child(first, ["src/alpha.ts"], "git-worktree"),
      child(second, ["src/beta.ts"], "main-worktree"),
    ]);
    approveTask(root, first);
    approveTask(root, second);
    const firstTaskId = scheduleTaskId(root, first);
    const facade = answeredFacade();

    const result = await scheduleParentTaskGraphWithJevV1(
      root,
      "jev-scheduler-parent",
      scheduleOptions(root),
      { facade, egress },
    );

    expect(facade.decide).not.toHaveBeenCalled();
    expect(result.receipt.request.jevAdvice).toBeUndefined();
    expect(
      result.receipt.jevAdviceAudit?.finalEligibleCandidates.filteredCandidates,
    ).toContainEqual({ taskId: firstTaskId, reasonCode: "worktree-rejected" });
  });

  it("does not ask Jev to reorder candidates behind an unmet hard dependency", async () => {
    const root = makeRoot();
    const first = createTask(root, "alpha", { isolation: "main-worktree" });
    const second = createTask(root, "beta", { isolation: "main-worktree" });
    createParent(root, [
      child(first, ["src/alpha.ts"], "main-worktree"),
      {
        ...child(second, ["src/beta.ts"], "main-worktree"),
        depends_on: [first],
      },
    ]);
    approveTask(root, first);
    approveTask(root, second);
    const secondTaskId = scheduleTaskId(root, second);
    const facade = answeredFacade();

    const result = await scheduleParentTaskGraphWithJevV1(
      root,
      "jev-scheduler-parent",
      scheduleOptions(root),
      { facade, egress },
    );

    expect(facade.decide).not.toHaveBeenCalled();
    expect(result.receipt.request.jevAdvice).toBeUndefined();
    expect(result.receipt.jevAdviceAudit).toMatchObject({
      status: "skipped",
      reasonCode: "insufficient-candidates",
    });
    expect(
      result.receipt.jevAdviceAudit?.finalEligibleCandidates.candidateTaskIds,
    ).not.toContain(secondTaskId);
    expect(result.receipt.plan.waves[0]?.taskIds).toHaveLength(1);
  });

  it("filters a candidate that conflicts with an active Parent writer lease", async () => {
    const root = makeRoot();
    const { first, second } = approvedPair(root);
    const firstTaskId = scheduleTaskId(root, first);
    const secondTaskId = scheduleTaskId(root, second);
    const release = reserveParallelChild(
      root,
      path.join(root, ".pactile", "tasks", first),
    );
    try {
      const facade = answeredFacade();
      const result = await scheduleParentTaskGraphWithJevV1(
        root,
        "jev-scheduler-parent",
        scheduleOptions(root),
        { facade, egress },
      );

      expect(facade.decide).not.toHaveBeenCalled();
      expect(result.receipt.request.jevAdvice).toBeUndefined();
      expect(result.receipt.jevAdviceAudit).toMatchObject({
        status: "skipped",
        sentRequestSnapshot: null,
        finalEligibleCandidates: {
          candidateTaskIds: [secondTaskId],
          filteredCandidates: [
            { taskId: firstTaskId, reasonCode: "active-write-lease-conflict" },
          ],
        },
      });
      expect(
        result.receipt.jevAdviceAudit?.finalEligibleCandidates.eligibility
          .activeLeaseCheckAt,
      ).toBeTruthy();
    } finally {
      release();
    }
  });

  it.skipIf(process.platform !== "win32")(
    "fails closed before Jev when the project lease store contains an ADS alias",
    async () => {
      const root = makeRoot();
      const { first, second } = approvedPair(root);
      const taskIds = [scheduleTaskId(root, first), scheduleTaskId(root, second)];
      const activeDir = path.join(
        root,
        ".pactile",
        "tasks",
        "legacy-parent",
        "parallel",
        "active",
      );
      fs.mkdirSync(activeDir, { recursive: true });
      fs.writeFileSync(
        path.join(activeDir, "legacy-ads.json"),
        `${JSON.stringify({
          id: "legacy-ads",
          pid: process.pid,
          durable: true,
          touches: ["src/alpha.ts:stream"],
        })}\n`,
      );
      const facade = answeredFacade();

      const result = await scheduleParentTaskGraphWithJevV1(
        root,
        "jev-scheduler-parent",
        scheduleOptions(root),
        { facade, egress },
      );

      expect(facade.decide).not.toHaveBeenCalled();
      expect(result.receipt.request.jevAdvice).toBeUndefined();
      expect(result.receipt.jevAdviceAudit).toMatchObject({
        status: "skipped",
        sentRequestSnapshot: null,
        finalEligibleCandidates: {
          candidateTaskIds: [],
          filteredCandidates: taskIds.map((taskId) => ({
            taskId,
            reasonCode: "lease-state-unavailable",
          })),
        },
      });
    },
  );

  it("supersedes an answer when approval changes before the final receipt is created", async () => {
    const root = makeRoot();
    const { first, second } = approvedPair(root);
    const firstTaskId = scheduleTaskId(root, first);
    const secondTaskId = scheduleTaskId(root, second);
    const firstContract = path.join(
      root,
      ".pactile",
      "tasks",
      first,
      "implement.md",
    );
    const facade = answeredFacade(() => {
      fs.appendFileSync(firstContract, "# renewed contract\n");
    });

    const result = await scheduleParentTaskGraphWithJevV1(
      root,
      "jev-scheduler-parent",
      scheduleOptions(root),
      { facade, egress },
    );

    expect(facade.decide).toHaveBeenCalledTimes(1);
    expect(result.receipt.request.jevAdvice).toBeUndefined();
    expect(result.receipt.plan.waves[0]?.taskIds).not.toContain(second);
    expect(result.receipt.jevAdviceAudit).toMatchObject({
      status: "superseded",
      reasonCode: "eligibility-changed",
      preparedRequestSnapshot: {
        candidateTaskIds: [firstTaskId, secondTaskId],
      },
      sentRequestSnapshot: {
        candidateTaskIds: [firstTaskId, secondTaskId],
        inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      finalEligibleCandidates: {
        candidateTaskIds: [secondTaskId],
        filteredCandidates: [
          { taskId: firstTaskId, reasonCode: "approval-rejected" },
        ],
      },
      eligibilityChanged: true,
      adoptedTaskIds: [],
      overriddenTaskIds: [secondTaskId, firstTaskId],
    });
  });

  it.each([
    {
      outcome: "timeout",
      reasonCode: "deadline-exceeded",
      drift: "approval",
      status: null,
    },
    {
      outcome: "503",
      reasonCode: "service-unavailable",
      drift: "lease",
      status: 503,
    },
    {
      outcome: "low-confidence",
      reasonCode: "low-confidence",
      drift: "approval",
      status: 200,
    },
  ] as const)(
    "keeps request-time candidates beside final eligibility after $outcome and $drift drift",
    async ({ outcome, reasonCode, drift, status }) => {
      const root = makeRoot();
      const { first, second } = approvedPair(root);
      const firstTaskId = scheduleTaskId(root, first);
      const secondTaskId = scheduleTaskId(root, second);
      const firstContract = path.join(
        root,
        ".pactile",
        "tasks",
        first,
        "implement.md",
      );
      const causeDrift = () => {
        if (drift === "approval") {
          fs.appendFileSync(firstContract, "# renewed contract\n");
          return;
        }
        const activeDir = path.join(
          root,
          ".pactile",
          "tasks",
          "legacy-parent",
          "parallel",
          "active",
        );
        fs.mkdirSync(activeDir, { recursive: true });
        fs.writeFileSync(
          path.join(activeDir, "lease-drift.json"),
          `${JSON.stringify({
            id: "lease-drift",
            pid: process.pid,
            durable: true,
            touches: ["src/alpha.ts"],
          })}\n`,
        );
      };
      const fetchImpl = vi.fn(async () => {
        causeDrift();
        if (outcome === "timeout") {
          return await new Promise<Response>(() => undefined);
        }
        if (outcome === "503") return new Response("service error", { status });
        return new Response(
          JSON.stringify({
            model: "jev-test",
            answers: {
              first_task: {
                type: "choice",
                choice: "candidate-02",
                confidence: 0.4,
                probabilities: { "candidate-01": 0.4, "candidate-02": 0.6 },
              },
            },
            usage: { input_tokens: 12, output_tokens: 0 },
          }),
          { status, headers: { "content-type": "application/json" } },
        );
      });
      const facade = createJevDecisionFacadeV1({
        enabled: true,
        transport: {
          apiKey: "test-key-not-persisted",
          fetchImpl: fetchImpl as unknown as typeof fetch,
          deadlineMs: outcome === "timeout" ? 10 : 100,
          maxRetries: 0,
        },
      });
      const baseline = planParentTaskScheduleV1(
        root,
        "jev-scheduler-parent",
        scheduleOptions(root),
      );

      const result = await scheduleParentTaskGraphWithJevV1(
        root,
        "jev-scheduler-parent",
        scheduleOptions(root),
        { facade, egress },
      );

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.receipt.plan).toEqual(baseline.plan);
      expect(result.receipt.request.jevAdvice).toBeUndefined();
      expect(result.receipt.jevAdviceAudit).toMatchObject({
        status: "fallback",
        reasonCode,
        preparedRequestSnapshot: {
          candidateTaskIds: [firstTaskId, secondTaskId],
          inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        sentRequestSnapshot: {
          candidateTaskIds: [firstTaskId, secondTaskId],
          inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        finalEligibleCandidates: {
          candidateTaskIds: [secondTaskId],
          filteredCandidates: [
            {
              taskId: firstTaskId,
              reasonCode:
                drift === "approval"
                  ? "approval-rejected"
                  : "active-write-lease-conflict",
            },
          ],
        },
        eligibilityChanged: true,
        transport: {
          attempts: 1,
          httpStatus: outcome === "timeout" ? null : status,
        },
      });
      expect(JSON.stringify(result.receipt.jevAdviceAudit)).not.toContain(
        "test-key-not-persisted",
      );
      expect(JSON.stringify(result.receipt.jevAdviceAudit)).not.toContain(
        "service error",
      );
    },
  );

  it("uses the configured Jev transport and records fallback without changing the deterministic plan", async () => {
    const root = makeRoot();
    const { first, second } = approvedPair(root);
    const firstTaskId = scheduleTaskId(root, first);
    const secondTaskId = scheduleTaskId(root, second);
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "jev-test",
            answers: {
              first_task: {
                type: "choice",
                choice: "candidate-02",
                confidence: 0.45,
                probabilities: { "candidate-01": 0.5, "candidate-02": 0.5 },
              },
            },
            usage: { input_tokens: 12, output_tokens: 0 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;
    const facade = createJevDecisionFacadeV1({
      enabled: true,
      transport: { apiKey: "test-key-not-persisted", fetchImpl },
    });
    const result = await scheduleParentTaskGraphWithJevV1(
      root,
      "jev-scheduler-parent",
      scheduleOptions(root),
      { facade, egress, minimumDecisionConfidence: 0.8 },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.receipt.request.jevAdvice).toBeUndefined();
    expect(result.receipt.jevAdviceAudit).toMatchObject({
      status: "fallback",
      reasonCode: "low-confidence",
      preparedRequestSnapshot: {
        candidateTaskIds: [firstTaskId, secondTaskId],
      },
      sentRequestSnapshot: {
        candidateTaskIds: [firstTaskId, secondTaskId],
        inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      finalEligibleCandidates: {
        candidateTaskIds: [firstTaskId, secondTaskId],
        filteredCandidates: [],
      },
      eligibilityChanged: false,
      suggestedTaskIds: [],
      transport: { attempts: 1, httpStatus: 200, model: "jev-test" },
    });
    expect(JSON.stringify(result.receipt.jevAdviceAudit)).not.toContain(
      "test-key-not-persisted",
    );
  });

  it("verifies a prepared Git worktree before including that task in a request", async () => {
    const root = makeRoot();
    const first = createTask(root, "alpha", { isolation: "git-worktree" });
    const second = createTask(root, "beta", { isolation: "main-worktree" });
    const parentDir = createParent(root, [
      child(first, ["src/alpha.ts"], "git-worktree"),
      child(second, ["src/beta.ts"], "main-worktree"),
    ]);
    prepareGitWorktree(root, path.basename(parentDir), first);
    approveTask(root, first);
    approveTask(root, second);
    const firstTaskId = scheduleTaskId(root, first);
    const secondTaskId = scheduleTaskId(root, second);
    const facade = answeredFacade();

    const result = await scheduleParentTaskGraphWithJevV1(
      root,
      "jev-scheduler-parent",
      scheduleOptions(root),
      { facade, egress },
    );

    expect(facade.decide).toHaveBeenCalledTimes(1);
    expect(
      result.receipt.jevAdviceAudit?.finalEligibleCandidates.eligibility
        .worktreePassedTaskIds,
    ).toEqual([firstTaskId, secondTaskId]);
  });

  it("keeps the deterministic plan when Jev configuration is omitted", async () => {
    const root = makeRoot();
    const { first, second } = approvedPair(root);
    const firstTaskId = scheduleTaskId(root, first);
    const secondTaskId = scheduleTaskId(root, second);
    const baseline = planParentTaskScheduleV1(
      root,
      "jev-scheduler-parent",
      scheduleOptions(root),
    );

    const result = await scheduleParentTaskGraphWithJevV1(
      root,
      "jev-scheduler-parent",
      scheduleOptions(root),
    );

    expect(result.receipt.plan).toEqual(baseline.plan);
    expect(result.receipt.request.jevAdvice).toBeUndefined();
    expect(result.receipt.jevAdviceAudit).toMatchObject({
      status: "skipped",
      reasonCode: "disabled",
      preparedRequestSnapshot: null,
      sentRequestSnapshot: null,
      finalEligibleCandidates: {
        candidateTaskIds: [firstTaskId, secondTaskId],
        eligibility: {
          approvalPassedTaskIds: [firstTaskId, secondTaskId],
          worktreePassedTaskIds: [firstTaskId, secondTaskId],
        },
      },
      transport: { latencyMs: 0, attempts: 0 },
    });

    const fetchImpl = vi.fn(async () => new Response("unused", { status: 200 }));
    const missingKeyFacade = createJevDecisionFacadeV1({
      enabled: true,
      transport: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    const missingKey = await scheduleParentTaskGraphWithJevV1(
      root,
      "jev-scheduler-parent",
      scheduleOptions(root),
      { facade: missingKeyFacade, egress },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(missingKey.receipt.plan).toEqual(baseline.plan);
    expect(missingKey.receipt.jevAdviceAudit).toMatchObject({
      status: "fallback",
      reasonCode: "configuration-missing",
      preparedRequestSnapshot: {
        candidateTaskIds: [firstTaskId, secondTaskId],
        inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      sentRequestSnapshot: null,
      finalEligibleCandidates: {
        candidateTaskIds: [firstTaskId, secondTaskId],
      },
      transport: { attempts: 0, httpStatus: null },
    });
  });

  it("records an egress-denied fallback without opening a network request", async () => {
    const root = makeRoot();
    const { first, second } = approvedPair(root);
    const fetchImpl = vi.fn(
      async () => new Response("unused", { status: 200 }),
    );
    const facade = createJevDecisionFacadeV1({
      enabled: true,
      transport: {
        apiKey: "test-key-not-persisted",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    });

    const result = await scheduleParentTaskGraphWithJevV1(
      root,
      "jev-scheduler-parent",
      scheduleOptions(root),
      { facade, egress: { ...egress, egressDestinations: [] } },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.receipt.request.jevAdvice).toBeUndefined();
    expect(result.receipt.jevAdviceAudit).toMatchObject({
      status: "fallback",
      reasonCode: "egress-denied",
      sentRequestSnapshot: null,
      preparedRequestSnapshot: {
        candidateTaskIds: [
          scheduleTaskId(root, first),
          scheduleTaskId(root, second),
        ],
      },
      finalEligibleCandidates: {
        candidateTaskIds: [
          scheduleTaskId(root, first),
          scheduleTaskId(root, second),
        ],
      },
      transport: { attempts: 0, httpStatus: null },
    });
  });

  it("records deadline and service failures and retains the deterministic plan", async () => {
    const root = makeRoot();
    approvedPair(root);
    const baseline = planParentTaskScheduleV1(
      root,
      "jev-scheduler-parent",
      scheduleOptions(root),
    );
    const neverRespond = vi.fn(
      async () => await new Promise<Response>(() => undefined),
    ) as unknown as typeof fetch;
    const timeoutFacade = createJevDecisionFacadeV1({
      enabled: true,
      transport: {
        apiKey: "test-key-not-persisted",
        fetchImpl: neverRespond,
        deadlineMs: 10,
        maxRetries: 0,
      },
    });
    const timedOut = await scheduleParentTaskGraphWithJevV1(
      root,
      "jev-scheduler-parent",
      scheduleOptions(root),
      { facade: timeoutFacade, egress },
    );

    expect(timedOut.receipt.plan).toEqual(baseline.plan);
    expect(timedOut.receipt.jevAdviceAudit).toMatchObject({
      status: "fallback",
      reasonCode: "deadline-exceeded",
      transport: { attempts: 1, httpStatus: null },
    });

    const serviceFailure = vi.fn(
      async () => new Response("service error", { status: 503 }),
    ) as unknown as typeof fetch;
    const unavailableFacade = createJevDecisionFacadeV1({
      enabled: true,
      transport: {
        apiKey: "test-key-not-persisted",
        fetchImpl: serviceFailure,
        deadlineMs: 100,
        maxRetries: 0,
      },
    });
    const unavailable = await scheduleParentTaskGraphWithJevV1(
      root,
      "jev-scheduler-parent",
      scheduleOptions(root),
      { facade: unavailableFacade, egress },
    );

    expect(unavailable.receipt.plan).toEqual(baseline.plan);
    expect(unavailable.receipt.jevAdviceAudit).toMatchObject({
      status: "fallback",
      reasonCode: "service-unavailable",
      transport: { attempts: 1, httpStatus: 503 },
    });
    expect(JSON.stringify(unavailable.receipt.jevAdviceAudit)).not.toContain(
      "service error",
    );
  });
});
