import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTaskKernel,
  readTaskKernel,
  resumeTaskRun,
  startTaskRun,
} from "../../../src/core/task/index.js";
import { runTaskSchedulePlanCliAsync } from "../../../src/commands/task-schedule.js";
import {
  type JevDecisionFacadeV1,
  type JevEgressAuthorizationV1,
} from "../../../src/pactile/jev/index.js";
import {
  planTaskKernelGraphV1,
  readTaskKernelScheduleReceiptV1,
  scheduleTaskKernelGraphWithJevV1,
} from "../../../src/pactile/scheduler/index.js";
import { createTaskRunWorktree } from "../../../src/pactile/worktree/index.js";

const roots: string[] = [];

const egress: JevEgressAuthorizationV1 = {
  network: "project-authorized",
  privacy: "project-approved-egress",
  credentials: "project-authorized",
  destination: "https://api.typesafe.ai",
  egressDestinations: ["https://api.typesafe.ai"],
  contentDecision: "task-summary-approved",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeGitRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pactile-v2-jev-schedule-"),
  );
  roots.push(root);
  fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "scheduler fixture\n", "utf8");
  git(root, "init");
  git(root, "add", "README.md");
  git(
    root,
    "-c",
    "user.name=Pactile Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "scheduler fixture",
  );
  return root;
}

interface TaskFixture {
  taskId: string;
  taskDir: string;
  runId: string | null;
}

function makeTask(
  root: string,
  taskId: string,
  options: { dependencies?: string[]; start?: boolean } = {},
): TaskFixture {
  const taskDir = path.join(root, ".pactile", "tasks", taskId);
  const created = createTaskKernel({
    root,
    taskDir,
    actor: "test-author",
    idempotencyKey: `create:${taskId}`,
    definition: {
      taskId,
      title: `V2 schedule ${taskId}`,
      description: "Jev scheduling fixture",
      deliverable: "one bounded implementation result",
      deliveryLevel: "local-result",
      acceptanceCriteria: [{ id: "AC-1", description: "result is reviewable" }],
      dependencies: options.dependencies ?? [],
    },
  });
  if (options.start === false) return { taskId, taskDir, runId: null };
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
      scope: "declared Task write set",
      evidenceRef: `approval:${taskId}`,
    },
    initialState: "waiting",
    writeSetSnapshot: [`src/${taskId}.ts`],
    estimatedDurations: { executionMs: 100_000 },
  });
  const runId = started.kernel.runs.at(-1)?.id;
  if (!runId) throw new Error(`Task Run was not recorded: ${taskId}`);
  return { taskId, taskDir, runId };
}

function attachManagedWorktree(root: string, task: TaskFixture): void {
  if (!task.runId) throw new Error(`Task Run is missing: ${task.taskId}`);
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

function answerFacade(
  input: {
    beforeAnswer?: () => void;
    choice?: "candidate-01" | "candidate-02";
  } = {},
): JevDecisionFacadeV1 & { decide: ReturnType<typeof vi.fn> } {
  const choice = input.choice ?? "candidate-02";
  const other = choice === "candidate-01" ? "candidate-02" : "candidate-01";
  return {
    decide: vi.fn(async () => {
      input.beforeAnswer?.();
      return {
        node: "task-scheduling" as const,
        status: "answered" as const,
        answers: {
          first_task: {
            type: "choice" as const,
            choice,
            confidence: 0.96,
            probabilities: { [choice]: 0.96, [other]: 0.04 },
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
            latencyMs: 7,
            httpStatus: 200,
            requestId: "test-request",
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
      } as Awaited<ReturnType<JevDecisionFacadeV1["decide"]>>;
    }),
  };
}

function successResponse(choice: "candidate-01" | "candidate-02"): Response {
  const other = choice === "candidate-01" ? "candidate-02" : "candidate-01";
  return new Response(
    JSON.stringify({
      model: "jev-test",
      answers: {
        first_task: {
          type: "choice",
          choice,
          confidence: 0.96,
          probabilities: { [choice]: 0.96, [other]: 0.04 },
        },
      },
      usage: { input_tokens: 42, output_tokens: 0 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("V2 Task Jev schedule advice", () => {
  it("advises only the first-wave eligible Run tie and binds adoption into the receipt", async () => {
    const root = makeGitRoot();
    const first = makeTask(root, "jev-schedule-a");
    const second = makeTask(root, "jev-schedule-b");
    attachManagedWorktree(root, first);
    attachManagedWorktree(root, second);
    const baseline = planTaskKernelGraphV1(root, [first.taskId, second.taskId]);
    const facade = answerFacade();

    const result = await scheduleTaskKernelGraphWithJevV1(
      root,
      [first.taskId, second.taskId],
      {},
      { facade, egress },
    );

    expect(facade.decide).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(facade.decide.mock.calls[0]?.[0]);
    expect(sent).not.toContain(first.taskId);
    expect(sent).not.toContain(second.taskId);
    expect(sent).not.toContain("src/jev-schedule-");
    expect(sent).toContain("candidate-01");
    expect(result.receipt.request.tasks).toEqual(baseline.request.tasks);
    expect(result.receipt.plan.waves[0]?.taskIds).toHaveLength(2);
    expect(result.receipt.jevAdviceAudit).toMatchObject({
      status: "answered",
      reasonCode: null,
      eligibilityChanged: false,
      suggestedTaskIds: [second.taskId, first.taskId],
      adoptedTaskIds: [second.taskId, first.taskId],
      overriddenTaskIds: [],
      finalEligibleCandidates: {
        candidateTaskIds: [first.taskId, second.taskId],
        eligibility: {
          approvalPassedTaskIds: [first.taskId, second.taskId],
          worktreePassedTaskIds: [first.taskId, second.taskId],
        },
      },
    });
    expect(
      readTaskKernelScheduleReceiptV1(root, result.receipt.receiptFingerprint)
        .integrity,
    ).toBe("fingerprint-verified");
    expect(
      readTaskKernelScheduleReceiptV1(root, result.receipt.receiptFingerprint)
        .receipt.jevAdviceAudit,
    ).toEqual(result.receipt.jevAdviceAudit);
  });

  it("keeps an unresolved hard dependency out of Jev candidates and preserves the dependency plan", async () => {
    const root = makeGitRoot();
    const prerequisite = makeTask(root, "jev-schedule-prerequisite");
    const independent = makeTask(root, "jev-schedule-independent");
    const dependent = makeTask(root, "jev-schedule-dependent", {
      dependencies: [prerequisite.taskId],
      start: false,
    });
    attachManagedWorktree(root, prerequisite);
    attachManagedWorktree(root, independent);
    const facade = answerFacade({ choice: "candidate-01" });

    const result = await scheduleTaskKernelGraphWithJevV1(
      root,
      [prerequisite.taskId, independent.taskId, dependent.taskId],
      {},
      { facade, egress },
    );

    expect(facade.decide).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(facade.decide.mock.calls[0]?.[0]);
    expect(sent).not.toContain(dependent.taskId);
    expect(
      result.receipt.request.tasks.find(
        ({ taskId }) => taskId === dependent.taskId,
      ),
    ).toMatchObject({ dependsOn: [prerequisite.taskId], state: "waiting" });
    const prerequisiteDecision = result.receipt.plan.decisions.find(
      ({ taskId }) => taskId === prerequisite.taskId,
    );
    const dependentDecision = result.receipt.plan.decisions.find(
      ({ taskId }) => taskId === dependent.taskId,
    );
    expect(prerequisiteDecision?.action).toBe("scheduled");
    expect(dependentDecision?.action).toBe("scheduled");
    expect(dependentDecision?.wave).toBeGreaterThan(
      prerequisiteDecision?.wave ?? 0,
    );
    expect(result.receipt.plan.waves[0]?.candidateTaskIds).not.toContain(
      dependent.taskId,
    );
    expect(result.receipt.jevAdviceAudit?.suggestedTaskIds).not.toContain(
      dependent.taskId,
    );
  });

  it("supersedes a Jev answer when the waiting Run changes during the request", async () => {
    const root = makeGitRoot();
    const first = makeTask(root, "jev-stale-a");
    const second = makeTask(root, "jev-stale-b");
    attachManagedWorktree(root, first);
    attachManagedWorktree(root, second);
    const facade = answerFacade({
      beforeAnswer: () => {
        const read = readTaskKernel({
          root,
          taskDir: first.taskDir,
          cwd: root,
        });
        if (read.kind !== "task-kernel-v2")
          throw new Error("Expected Task Kernel V2");
        if (!first.runId) throw new Error("Run fixture is missing");
        resumeTaskRun({
          root,
          taskDir: first.taskDir,
          expectedRevision: read.kernel.revision,
          runId: first.runId,
          actor: "test-worker",
          idempotencyKey: "resume-during-jev",
        });
      },
    });

    const result = await scheduleTaskKernelGraphWithJevV1(
      root,
      [first.taskId, second.taskId],
      {},
      { facade, egress },
    );

    expect(result.receipt.request.jevAdvice).toBeUndefined();
    expect(result.receipt.jevAdviceAudit).toMatchObject({
      status: "superseded",
      reasonCode: "eligibility-changed",
      eligibilityChanged: true,
      adoptedTaskIds: [],
      overriddenTaskIds: [second.taskId, first.taskId],
    });
    expect(result.receipt.taskKernelRevisions[first.taskId]).toBeGreaterThan(2);
  });

  it("does not ask Jev to rank a candidate without its approved manager-owned Run worktree", async () => {
    const root = makeGitRoot();
    const eligible = makeTask(root, "jev-eligible-a");
    const unbound = makeTask(root, "jev-unbound-b");
    attachManagedWorktree(root, eligible);
    const facade = answerFacade();

    const result = await scheduleTaskKernelGraphWithJevV1(
      root,
      [eligible.taskId, unbound.taskId],
      {},
      { facade, egress },
    );

    expect(facade.decide).not.toHaveBeenCalled();
    expect(result.receipt.request.jevAdvice).toBeUndefined();
    expect(result.receipt.jevAdviceAudit).toMatchObject({
      status: "skipped",
      reasonCode: "insufficient-candidates",
      finalEligibleCandidates: {
        candidateTaskIds: [eligible.taskId],
        filteredCandidates: [
          { taskId: unbound.taskId, reasonCode: "worktree-rejected" },
        ],
      },
    });
  });

  it.each([
    ["deny", "jev:\n  egress: deny\n", "egress-denied"],
    ["invalid", "jev:\n  egress: maybe\n", "configuration-invalid"],
  ] as const)(
    "uses deterministic CLI planning and zero network for project egress %s",
    async (_label, config, reasonCode) => {
      const root = makeGitRoot();
      const first = makeTask(root, `jev-egress-a-${reasonCode}`);
      const second = makeTask(root, `jev-egress-b-${reasonCode}`);
      attachManagedWorktree(root, first);
      attachManagedWorktree(root, second);
      fs.writeFileSync(
        path.join(root, ".pactile", "config.yaml"),
        config,
        "utf8",
      );
      vi.stubEnv("PACTILE_JEV_API_KEY", "test-schedule-key-not-for-output");
      vi.stubEnv("PACTILE_JEV_ENABLED", "true");
      const fetchMock = vi.fn(async () => successResponse("candidate-02"));
      vi.stubGlobal("fetch", fetchMock);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const before = planTaskKernelGraphV1(root, [first.taskId, second.taskId]);

      await expect(
        runTaskSchedulePlanCliAsync([first.taskId, second.taskId], root),
      ).resolves.toBe(0);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(1);
      const output = JSON.parse(String(log.mock.lastCall?.[0])) as {
        receipt: {
          request: { jevAdvice?: unknown };
          plan: unknown;
          jevAdviceAudit: {
            status: string;
            reasonCode: string;
            sentRequestSnapshot: unknown;
            transport: { attempts: number };
          };
        };
      };
      expect(output.receipt.request.jevAdvice).toBeUndefined();
      expect(output.receipt.plan).toEqual(before.plan);
      expect(output.receipt.jevAdviceAudit).toMatchObject({
        status: "fallback",
        reasonCode,
        sentRequestSnapshot: null,
        transport: { attempts: 0 },
      });
      expect(JSON.stringify(output)).not.toContain(
        "test-schedule-key-not-for-output",
      );
      expect(fetchMock.mock.calls).toHaveLength(0);
    },
  );
});
