import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeTaskKernel,
  createTaskKernel,
  recordTaskReview,
  recordTaskRunResult,
  readTaskKernel,
  resumeTaskRun,
  startTaskRun,
} from "../../../src/core/task/index.js";
import { init } from "../../../src/commands/init.js";
import { applyLegacyTaskUpdate } from "../../../src/pactile/migration/legacy-task-update.js";
import {
  dispatchTaskKernelWaveV1,
  type TaskKernelWaveRunRequestV1,
  type TaskKernelWaveRunResultV1,
} from "../../../src/pactile/scheduler/task-kernel-wave-dispatch.js";
import { scheduleTaskKernelGraph } from "../../../src/pactile/scheduler/index.js";
import { createTaskRunWorktree } from "../../../src/pactile/worktree/index.js";
import { createPiTaskKernelWaveRunnerV1 } from "../../../src/commands/task-schedule.js";
import { PiRpcClient } from "../../../src/pactile/pi/rpc.js";

const roots: string[] = [];
const FAKE_PI_WAVE_PROVIDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.tmp/p31-script-build/fixtures/fake-pi-wave-provider.js",
);

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

interface TaskFixture {
  taskId: string;
  taskDir: string;
  runId: string | null;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeGitRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-p37-wave-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], {
    cwd: root,
    stdio: "ignore",
  });
  git(root, "config", "user.name", "Pactile Test");
  git(root, "config", "user.email", "pactile@example.invalid");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "P37 wave fixture\n");
  fs.writeFileSync(path.join(root, "src", "base.ts"), "export {};\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".pactile/\n");
  git(root, "add", "README.md", ".gitignore", "src/base.ts");
  git(root, "commit", "-q", "-m", "fixture base");
  return root;
}

function makeTask(
  root: string,
  taskId: string,
  options: {
    dependencies?: string[];
    writeSet?: string[];
    start?: boolean;
  } = {},
): TaskFixture {
  const taskDir = path.join(root, ".pactile", "tasks", taskId);
  const created = createTaskKernel({
    root,
    taskDir,
    actor: "test-author",
    idempotencyKey: `create:${taskId}`,
    definition: {
      taskId,
      title: `P37 ${taskId}`,
      description: "Wave-dispatch fixture",
      deliverable: "One bounded implementation result",
      deliveryLevel: "local-result",
      acceptanceCriteria: [{ id: "AC-1", description: "Result is reviewable" }],
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
    writeSetSnapshot: options.writeSet ?? [`src/${taskId}.ts`],
  });
  return { taskId, taskDir, runId: started.kernel.runs.at(-1)?.id ?? null };
}

function attachManagedWorktree(root: string, task: TaskFixture): string {
  if (!task.runId) throw new Error(`Task Run is missing: ${task.taskId}`);
  return createTaskRunWorktree({
    repoRoot: root,
    taskDir: task.taskDir,
    runId: task.runId,
    branch: `feat/${task.taskId}`,
    baseRef: git(root, "rev-parse", "HEAD"),
    actor: "test-worktree-manager",
    idempotencyKey: `worktree:${task.taskId}`,
  }).binding.canonicalPath;
}

function closePrerequisite(root: string, taskId: string): TaskFixture {
  const task = makeTask(root, taskId, { start: false });
  const started = startTaskRun({
    root,
    taskDir: task.taskDir,
    expectedRevision: 1,
    actor: "test-worker",
    idempotencyKey: `start:${taskId}`,
    input: { summary: "Complete the prerequisite", references: [] },
    authorization: {
      approvedBy: "test-approver",
      approvedAt: "2026-09-26T00:00:00.000Z",
      scope: "declared prerequisite",
      evidenceRef: `approval:${taskId}`,
    },
    writeSetSnapshot: [`src/${taskId}.ts`],
  });
  const runId = started.kernel.runs.at(-1)?.id;
  if (!runId) throw new Error("Prerequisite Run is missing");
  fs.writeFileSync(
    path.join(root, "src", `${taskId}.ts`),
    "export const prerequisite = true;\n",
  );
  fs.writeFileSync(path.join(task.taskDir, "result.txt"), "closed prerequisite\n");
  const completed = recordTaskRunResult({
    root,
    taskDir: task.taskDir,
    expectedRevision: started.kernel.revision,
    runId,
    outcome: "completed",
    summary: "Prerequisite result is complete",
    evidenceRefs: ["result.txt"],
    actor: "test-worker",
    idempotencyKey: `result:${taskId}`,
  });
  const candidate = completed.kernel.runs.at(-1)?.candidateSnapshot;
  if (!candidate) throw new Error("Prerequisite candidate is missing");
  fs.writeFileSync(path.join(task.taskDir, "review.json"), "{}\n");
  const reviewed = recordTaskReview({
    root,
    taskDir: task.taskDir,
    expectedRevision: completed.kernel.revision,
    runId,
    candidateSnapshotId: candidate.id,
    candidateFingerprint: candidate.fingerprint,
    reviewer: "test-reviewer",
    decision: "pass",
    evidenceRefs: ["review.json"],
    acceptanceEvidence: { "AC-1": [`src/${taskId}.ts`] },
    actor: "test-reviewer",
    idempotencyKey: `review:${taskId}`,
  });
  const review = reviewed.kernel.reviews.at(-1);
  if (!review) throw new Error("Prerequisite passing review is missing");
  closeTaskKernel({
    root,
    taskDir: task.taskDir,
    expectedRevision: reviewed.kernel.revision,
    runId,
    reviewId: review.id,
    candidateObservation: {
      snapshotId: candidate.id,
      fingerprint: candidate.fingerprint,
      observedBy: "test-closer",
      observedAt: "2026-09-26T00:05:00.000Z",
      source: "caller-attested",
      evidenceRef: `candidate:${taskId}`,
    },
    deliveryEvidence: {
      level: "local-result",
      reference: `src/${taskId}.ts`,
      summary: "The accepted prerequisite result is present",
    },
    actor: "test-closer",
    idempotencyKey: `close:${taskId}`,
  });
  return { ...task, runId };
}

function archiveTask(root: string, task: TaskFixture): void {
  const archiveDir = path.join(root, ".pactile", "tasks", "archive", "2026-09");
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.renameSync(task.taskDir, path.join(archiveDir, task.taskId));
}

function estimatedCosts(taskIds: readonly string[]) {
  return Object.fromEntries(
    taskIds.map((taskId) => [
      taskId,
      {
        latencyMs: 10,
        waitingMs: 10,
        executionMs: 1_000,
        integrationMs: 5,
        reworkMs: 5,
        reviewMs: 5,
      },
    ]),
  );
}

function testProviderResult(
  request: TaskKernelWaveRunRequestV1,
  overrides: Partial<TaskKernelWaveRunResultV1> = {},
): TaskKernelWaveRunResultV1 {
  return {
    outcome: "settled",
    scheduleReceiptFingerprint: request.scheduleReceiptFingerprint,
    admissionReceiptFingerprint: "a".repeat(64),
    hostStopVerified: true,
    leaseReleased: true,
    evidenceRef: `fake-pi-provider-test-only:${request.taskId}`,
    reason: null,
    ...overrides,
  };
}

function fakePiScript(
  root: string,
  options: {
    barrierSize?: number;
    failTaskIds?: string[];
    hangTaskIds?: string[];
    startedDirectory?: string;
  } = {},
): string[] {
  const args = [
    FAKE_PI_WAVE_PROVIDER,
    "--started-directory",
    options.startedDirectory ?? path.join(root, "provider-starts"),
    "--barrier-size",
    String(options.barrierSize ?? 0),
  ];
  for (const taskId of options.failTaskIds ?? [])
    args.push("--fail-task-id", taskId);
  for (const taskId of options.hangTaskIds ?? [])
    args.push("--hang-task-id", taskId);
  return args;
}

function fakePiLaunch(args: string[]) {
  return { command: process.execPath, args };
}

describe("Task Kernel V2 writer-wave dispatch", () => {
  it("runs two independent isolated Tasks concurrently against the same persisted receipt using a fake Pi provider", async () => {
    const root = makeGitRoot();
    const first = makeTask(root, "wave-independent-a", {
      writeSet: ["src/a.ts"],
    });
    const second = makeTask(root, "wave-independent-b", {
      writeSet: ["src/b.ts"],
    });
    attachManagedWorktree(root, first);
    attachManagedWorktree(root, second);
    const schedule = scheduleTaskKernelGraph(
      root,
      [first.taskId, second.taskId],
      { estimatedCosts: estimatedCosts([first.taskId, second.taskId]) },
    );
    expect(schedule.receipt.plan.waves[0]?.decision).toBe(
      "parallel-time-saved",
    );
    expect(schedule.receipt.plan.waves[0]?.taskIds).toHaveLength(2);
    const script = fakePiScript(root, { barrierSize: 2 });

    const result = await dispatchTaskKernelWaveV1(
      root,
      schedule.receipt.receiptFingerprint,
      {
        timeoutMs: 10_000,
        runnerLabel: "fake-pi-rpc-provider-test-only",
        runner: createPiTaskKernelWaveRunnerV1(root, fakePiLaunch(script)),
      },
    );

    expect(result).toMatchObject({
      status: "provider-runs-complete",
      scheduleReceiptFingerprint: schedule.receipt.receiptFingerprint,
      kernelRunSettlement: "not-performed",
      integrationPlan: {
        waves: [
          {
            decision: "parallel-time-saved",
            integration: { mode: "parallel-review" },
            costEstimate: {
              source: "schedule-receipt-estimates",
              candidateEstimatedSavingsMs: expect.any(Number),
            },
          },
        ],
      },
      measurements: {
        source: "dispatch-wall-clock",
        elapsedMs: expect.any(Number),
        waves: [{ elapsedMs: expect.any(Number) }],
      },
    });
    expect(result.tasks).toHaveLength(2);
    expect(
      result.tasks.every((task) => task.status === "provider-runs-settled"),
    ).toBe(true);
    expect(result.tasks.every((task) => task.admissionReceiptFingerprint)).toBe(
      true,
    );
    expect(result.tasks.every((task) => Number.isFinite(task.elapsedMs))).toBe(
      true,
    );
    expect(
      result.tasks.every((task) => task.hostStopVerified && task.leaseReleased),
    ).toBe(true);
    expect(
      result.integrationPlan.tasks.find(({ taskId }) => taskId === first.taskId)
        ?.costs,
    ).toMatchObject({
      estimateBasis: { executionMs: "caller-estimate" },
      observed: { executionMs: null },
    });
    expect(
      result.integrationPlan.tasks[0]?.costs?.observedEvidenceRefs.length,
    ).toBeGreaterThan(0);
    const latestRecords = [first, second].map(
      ({ taskDir }) =>
        JSON.parse(
          fs.readFileSync(
            path.join(taskDir, "pi-bridge", "latest.json"),
            "utf8",
          ),
        ) as {
          schedule_receipt_fingerprint?: string;
          dispatch_lease_released?: boolean;
          process_stop_receipt?: {
            processExit?: { terminationVerified?: boolean };
          };
        },
    );
    expect(
      latestRecords.every(
        (record) =>
          record.schedule_receipt_fingerprint ===
            schedule.receipt.receiptFingerprint &&
          record.dispatch_lease_released === true &&
          record.process_stop_receipt?.processExit?.terminationVerified ===
            true,
      ),
    ).toBe(true);
    expect(
      fs
        .readdirSync(path.join(root, "provider-starts"))
        .filter((name) => name.endsWith(".started")),
    ).toHaveLength(2);
    for (const task of [first, second]) {
      const read = readTaskKernel({ root, taskDir: task.taskDir, cwd: root });
      if (read.kind !== "task-kernel-v2")
        throw new Error("Expected Task Kernel V2");
      expect(read.kernel.runs.at(-1)?.candidateSnapshot).toBeNull();
      expect(read.kernel.runs.at(-1)?.result).toBeNull();
    }
  }, 30_000);

  it("rechecks the complete receipt before any provider starts when a Task revision goes stale", async () => {
    const root = makeGitRoot();
    const task = makeTask(root, "wave-stale-receipt");
    attachManagedWorktree(root, task);
    const schedule = scheduleTaskKernelGraph(root, [task.taskId]);
    const read = readTaskKernel({ root, taskDir: task.taskDir, cwd: root });
    if (read.kind !== "task-kernel-v2")
      throw new Error("Expected Task Kernel V2");
    resumeTaskRun({
      root,
      taskDir: task.taskDir,
      expectedRevision: read.kernel.revision,
      runId: task.runId as string,
      actor: "test-worker",
      idempotencyKey: "resume-after-schedule",
    });
    const runner = vi.fn(async (request: TaskKernelWaveRunRequestV1) =>
      testProviderResult(request),
    );

    await expect(
      dispatchTaskKernelWaveV1(root, schedule.receipt.receiptFingerprint, {
        timeoutMs: 5_000,
        runnerLabel: "fake-pi-provider-test-only",
        runner,
      }),
    ).rejects.toThrow(/schedule receipt is stale/u);
    expect(runner).not.toHaveBeenCalled();
  });

  it("blocks a candidate with an unresolved hard dependency before invoking the provider", async () => {
    const root = makeGitRoot();
    makeTask(root, "wave-open-prerequisite", { start: false });
    const dependent = makeTask(root, "wave-hard-dependent", {
      dependencies: ["wave-open-prerequisite"],
      writeSet: ["src/dependent.ts"],
      start: false,
    });
    const schedule = scheduleTaskKernelGraph(root, [dependent.taskId]);
    const runner = vi.fn(async (request: TaskKernelWaveRunRequestV1) =>
      testProviderResult(request),
    );

    const result = await dispatchTaskKernelWaveV1(
      root,
      schedule.receipt.receiptFingerprint,
      { timeoutMs: 5_000, runnerLabel: "fake-pi-provider-test-only", runner },
    );

    expect(
      schedule.receipt.plan.decisions.find(
        ({ taskId }) => taskId === dependent.taskId,
      )?.action,
    ).toBe("blocked");
    expect(result.status).toBe("blocked");
    expect(result.tasks).toContainEqual(
      expect.objectContaining({
        taskId: dependent.taskId,
        status: "blocked",
      }),
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it("dispatches after resolving a successfully closed dependency from the Task archive", async () => {
    const root = makeGitRoot();
    const prerequisite = closePrerequisite(root, "wave-archived-prerequisite");
    archiveTask(root, prerequisite);
    const dependent = makeTask(root, "wave-archived-dependent", {
      dependencies: [prerequisite.taskId],
      writeSet: ["src/dependent.ts"],
    });
    attachManagedWorktree(root, dependent);
    const schedule = scheduleTaskKernelGraph(root, [dependent.taskId]);
    const runner = vi.fn(
      createPiTaskKernelWaveRunnerV1(root, fakePiLaunch(fakePiScript(root))),
    );

    const result = await dispatchTaskKernelWaveV1(
      root,
      schedule.receipt.receiptFingerprint,
      { timeoutMs: 10_000, runnerLabel: "fake-pi-rpc-provider-test-only", runner },
    );

    expect(schedule.receipt.plan.decisions).toContainEqual(
      expect.objectContaining({ taskId: dependent.taskId, action: "scheduled" }),
    );
    expect(result.status).toBe("provider-runs-complete");
    expect(result.tasks).toContainEqual(
      expect.objectContaining({ taskId: dependent.taskId, status: "provider-runs-settled" }),
    );
    expect(runner).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("rejects an archived dependency that is not closed successfully before dispatch", () => {
    const root = makeGitRoot();
    const prerequisite = makeTask(root, "wave-archived-open-prerequisite", {
      start: false,
    });
    const dependent = makeTask(root, "wave-archived-open-dependent", {
      dependencies: [prerequisite.taskId],
      start: false,
    });
    archiveTask(root, prerequisite);

    expect(() => scheduleTaskKernelGraph(root, [dependent.taskId])).toThrow(
      /Archived hard Task dependency is not closed with completed outcome/u,
    );
  });

  it("keeps predicted overlapping write sets in separate serial waves by default", async () => {
    const root = makeGitRoot();
    const first = makeTask(root, "wave-overlap-a", {
      writeSet: ["src/shared"],
    });
    const second = makeTask(root, "wave-overlap-b", {
      writeSet: ["src/shared/file.ts"],
    });
    attachManagedWorktree(root, first);
    attachManagedWorktree(root, second);
    const schedule = scheduleTaskKernelGraph(
      root,
      [first.taskId, second.taskId],
      { estimatedCosts: estimatedCosts([first.taskId, second.taskId]) },
    );
    expect(schedule.receipt.plan.waves).toHaveLength(2);
    const activeCounts: number[] = [];
    let active = 0;
    const piRunner = createPiTaskKernelWaveRunnerV1(
      root,
      fakePiLaunch(fakePiScript(root)),
    );
    const runner = vi.fn(async (request: TaskKernelWaveRunRequestV1) => {
      active += 1;
      activeCounts.push(active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return await piRunner(request);
      } finally {
        active -= 1;
      }
    });

    const result = await dispatchTaskKernelWaveV1(
      root,
      schedule.receipt.receiptFingerprint,
      { timeoutMs: 5_000, runnerLabel: "fake-pi-provider-test-only", runner },
    );

    expect(result.status).toBe("provider-runs-complete");
    expect(result.integrationPlan.waves.map(({ taskIds }) => taskIds)).toEqual([
      [first.taskId],
      [second.taskId],
    ]);
    expect(Math.max(...activeCounts)).toBe(1);
    expect(
      runner.mock.calls.map(([request]) => request.scheduleReceiptFingerprint),
    ).toEqual([
      schedule.receipt.receiptFingerprint,
      schedule.receipt.receiptFingerprint,
    ]);
  });

  it("records the authorization and ordered integration plan when overlapping writers are explicitly parallelized", async () => {
    const root = makeGitRoot();
    const first = makeTask(root, "wave-authorized-overlap-a", {
      writeSet: ["src/shared"],
    });
    const second = makeTask(root, "wave-authorized-overlap-b", {
      writeSet: ["src/shared/file.ts"],
    });
    attachManagedWorktree(root, first);
    attachManagedWorktree(root, second);
    const integrationPlan =
      "Review both isolated results, integrate A before B, then verify the shared module.";
    const schedule = scheduleTaskKernelGraph(
      root,
      [first.taskId, second.taskId],
      {
        estimatedCosts: estimatedCosts([first.taskId, second.taskId]),
        conflictParallelizations: [
          {
            taskIds: [first.taskId, second.taskId],
            approvedBy: "test-approver",
            authorizationRef: "approval:authorized-overlap",
            integrationPlan,
          },
        ],
      },
    );
    expect(schedule.receipt.plan.waves[0]?.decision).toBe(
      "parallel-time-saved",
    );
    let active = 0;
    let peak = 0;
    const piRunner = createPiTaskKernelWaveRunnerV1(
      root,
      fakePiLaunch(fakePiScript(root)),
    );
    const runner = vi.fn(async (request: TaskKernelWaveRunRequestV1) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return await piRunner(request);
      } finally {
        active -= 1;
      }
    });

    const result = await dispatchTaskKernelWaveV1(
      root,
      schedule.receipt.receiptFingerprint,
      { timeoutMs: 5_000, runnerLabel: "fake-pi-provider-test-only", runner },
    );

    expect(result.status).toBe("provider-runs-complete");
    expect(peak).toBe(2);
    expect(result.integrationPlan.waves[0]?.integration.mode).toBe(
      "parallel-review",
    );
    expect(result.integrationPlan.waves[0]?.conflictAuthorizations).toEqual([
      expect.objectContaining({
        approvedBy: "test-approver",
        authorizationRef: "approval:authorized-overlap",
        integrationPlan,
      }),
    ]);
  });

  it("reports a partial fake-Pi result while requiring a verified Host stop and lease release for each run", async () => {
    const root = makeGitRoot();
    const completed = makeTask(root, "wave-partial-a", {
      writeSet: ["src/a.ts"],
    });
    const needsReview = makeTask(root, "wave-partial-b", {
      writeSet: ["src/b.ts"],
    });
    attachManagedWorktree(root, completed);
    attachManagedWorktree(root, needsReview);
    const schedule = scheduleTaskKernelGraph(
      root,
      [completed.taskId, needsReview.taskId],
      {
        estimatedCosts: estimatedCosts([completed.taskId, needsReview.taskId]),
      },
    );
    const script = fakePiScript(root, { failTaskIds: [needsReview.taskId] });

    const result = await dispatchTaskKernelWaveV1(
      root,
      schedule.receipt.receiptFingerprint,
      {
        timeoutMs: 10_000,
        runnerLabel: "fake-pi-rpc-provider-test-only",
        runner: createPiTaskKernelWaveRunnerV1(root, fakePiLaunch(script)),
      },
    );

    expect(result.status).toBe("partial");
    expect(result.kernelRunSettlement).toBe("not-performed");
    expect(
      result.tasks.find(({ taskId }) => taskId === completed.taskId),
    ).toMatchObject({
      status: "provider-runs-settled",
      hostStopVerified: true,
      leaseReleased: true,
    });
    expect(
      result.tasks.find(({ taskId }) => taskId === needsReview.taskId),
    ).toMatchObject({
      status: "provider-run-failed",
      outcome: "needs_review",
      hostStopVerified: true,
      leaseReleased: true,
    });
  }, 30_000);

  it("marks later conflicting work blocked when the real fake-Pi child stop is unverified", async () => {
    const root = makeGitRoot();
    const first = makeTask(root, "wave-unverified-stop-a", {
      writeSet: ["src/shared"],
    });
    const second = makeTask(root, "wave-unverified-stop-b", {
      writeSet: ["src/shared"],
    });
    attachManagedWorktree(root, first);
    attachManagedWorktree(root, second);
    const schedule = scheduleTaskKernelGraph(root, [
      first.taskId,
      second.taskId,
    ]);
    const script = fakePiScript(root);
    vi.spyOn(PiRpcClient.prototype, "closeAndObserve").mockResolvedValueOnce({
      processId: 42424,
      stopRequestedAt: new Date().toISOString(),
      killRequestedAt: null,
      exitObservedAt: null,
      exitCode: null,
      signalCode: null,
      terminationVerified: false,
    });
    const runner = vi.fn(
      createPiTaskKernelWaveRunnerV1(root, fakePiLaunch(script)),
    );

    const result = await dispatchTaskKernelWaveV1(
      root,
      schedule.receipt.receiptFingerprint,
      {
        timeoutMs: 10_000,
        runnerLabel: "fake-pi-rpc-provider-test-only",
        runner,
      },
    );

    expect(runner).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("partial");
    expect(result.tasks).toContainEqual(
      expect.objectContaining({
        taskId: first.taskId,
        status: "host-stop-unverified",
        hostStopVerified: false,
        leaseReleased: false,
      }),
    );
    expect(result.tasks).toContainEqual(
      expect.objectContaining({
        taskId: second.taskId,
        status: "blocked",
        reasonCode: "prior-wave-did-not-prove-writer-stop",
      }),
    );
  }, 30_000);

  it("rejects a runner's forged settled booleans without persisted admission, Host stop, and lease evidence", async () => {
    const root = makeGitRoot();
    const task = makeTask(root, "wave-untrusted-runner");
    attachManagedWorktree(root, task);
    const schedule = scheduleTaskKernelGraph(root, [task.taskId]);
    const runner = vi.fn(async (request: TaskKernelWaveRunRequestV1) => ({
      outcome: "settled" as const,
      scheduleReceiptFingerprint: request.scheduleReceiptFingerprint,
      admissionReceiptFingerprint: "a".repeat(64),
      hostStopVerified: true,
      leaseReleased: true,
      evidenceRef: null,
      reason: null,
    }));

    const result = await dispatchTaskKernelWaveV1(
      root,
      schedule.receipt.receiptFingerprint,
      { timeoutMs: 5_000, runnerLabel: "untrusted-runner-test-only", runner },
    );

    expect(result.status).toBe("partial");
    expect(result.tasks).toContainEqual(
      expect.objectContaining({
        taskId: task.taskId,
        status: "host-stop-unverified",
        outcome: "failed",
        admissionReceiptFingerprint: null,
        hostStopVerified: false,
        leaseReleased: false,
        evidenceRef: null,
      }),
    );
    expect(runner).toHaveBeenCalledTimes(1);
    const read = readTaskKernel({ root, taskDir: task.taskDir, cwd: root });
    if (read.kind !== "task-kernel-v2")
      throw new Error("Expected Task Kernel V2");
    expect(read.kernel.runs.at(-1)?.host).toBeNull();
  });

  it("cancels fake-Pi dispatch only after observing and recording the child process exit", async () => {
    const root = makeGitRoot();
    const first = makeTask(root, "wave-cancel-a", { writeSet: ["src/shared"] });
    const second = makeTask(root, "wave-cancel-b", {
      writeSet: ["src/shared"],
    });
    attachManagedWorktree(root, first);
    attachManagedWorktree(root, second);
    const schedule = scheduleTaskKernelGraph(root, [
      first.taskId,
      second.taskId,
    ]);
    const startedDirectory = path.join(root, "cancel-provider-starts");
    const script = fakePiScript(root, {
      hangTaskIds: [first.taskId],
      startedDirectory,
    });
    const controller = new AbortController();
    const dispatch = dispatchTaskKernelWaveV1(
      root,
      schedule.receipt.receiptFingerprint,
      {
        timeoutMs: 10_000,
        runnerLabel: "fake-pi-rpc-provider-test-only",
        runner: createPiTaskKernelWaveRunnerV1(root, fakePiLaunch(script)),
        signal: controller.signal,
      },
    );
    const marker = path.join(startedDirectory, `${first.taskId}.started`);
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(marker) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fs.existsSync(marker)).toBe(true);
    controller.abort();

    const result = await dispatch;

    expect(result.status).toBe("cancelled");
    expect(result.kernelRunSettlement).toBe("not-performed");
    expect(result.tasks).toContainEqual(
      expect.objectContaining({
        taskId: first.taskId,
        status: "cancelled",
        hostStopVerified: true,
        leaseReleased: true,
      }),
    );
    expect(result.tasks).toContainEqual(
      expect.objectContaining({
        taskId: second.taskId,
        status: "cancelled",
        reasonCode: "dispatch-cancelled-before-wave",
      }),
    );
    const latest = JSON.parse(
      fs.readFileSync(
        path.join(first.taskDir, "pi-bridge", "latest.json"),
        "utf8",
      ),
    ) as {
      outcome?: string;
      process_stop_receipt?: {
        terminal?: string;
        processExit?: { terminationVerified?: boolean };
      };
      dispatch_lease_released?: boolean;
    };
    expect(latest).toMatchObject({
      outcome: "cancelled",
      process_stop_receipt: {
        terminal: "cancelled",
        processExit: { terminationVerified: true },
      },
      dispatch_lease_released: true,
    });
  }, 30_000);

  it("blocks dispatch when no P38 manager-owned Git worktree exists", async () => {
    const root = makeGitRoot();
    const task = makeTask(root, "wave-no-worktree");
    const schedule = scheduleTaskKernelGraph(root, [task.taskId]);
    const runner = vi.fn(async (request: TaskKernelWaveRunRequestV1) =>
      testProviderResult(request),
    );

    const result = await dispatchTaskKernelWaveV1(
      root,
      schedule.receipt.receiptFingerprint,
      { timeoutMs: 5_000, runnerLabel: "fake-pi-provider-test-only", runner },
    );

    expect(result.status).toBe("blocked");
    expect(result.tasks).toContainEqual(
      expect.objectContaining({
        taskId: task.taskId,
        status: "blocked",
        reasonCode: "p38-managed-run-worktree-required",
      }),
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it("keeps P36 needs-definition records outside V2 writer dispatch", async () => {
    const root = makeGitRoot();
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await init({ yes: true, user: "p37-wave-fixture", skipReadiness: true });
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
    const updated = await applyLegacyTaskUpdate(root);
    expect(updated.status).toBe("completed");
    expect(updated.import.needsDefinition).toBeGreaterThan(0);

    expect(() => scheduleTaskKernelGraph(root, [bootstrapTask.id])).toThrow(
      /needs-definition.*missing definition fields/u,
    );
  }, 120_000);
});
