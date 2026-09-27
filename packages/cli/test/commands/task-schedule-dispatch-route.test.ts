import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTaskKernel,
  readTaskKernel,
  startTaskRun,
} from "../../src/core/task/index.js";
import { runTaskCli } from "../../src/commands/task.js";
import { runTaskCliWithWorkspaceReclaim } from "../../src/commands/task-worktree-close.js";
import { createPiTaskKernelWaveRunnerV1 } from "../../src/commands/task-schedule.js";
import { acquireTaskKernelRunDispatchV1 } from "../../src/pactile/scheduler/index.js";
import type {
  TaskKernelWaveRunRequestV1,
  TaskKernelWaveRunResultV1,
} from "../../src/pactile/scheduler/task-kernel-wave-dispatch.js";
import { createTaskRunWorktree } from "../../src/pactile/worktree/index.js";

const roots: string[] = [];
const FAKE_PI_WAVE_PROVIDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.tmp/p31-script-build/fixtures/fake-pi-wave-provider.js",
);

afterEach(() => {
  vi.restoreAllMocks();
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

function makeRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pactile-task-schedule-route-"),
  );
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], {
    cwd: root,
    stdio: "ignore",
  });
  git(root, "config", "user.name", "Pactile Test");
  git(root, "config", "user.email", "pactile@example.invalid");
  fs.writeFileSync(
    path.join(root, "README.md"),
    "Task schedule dispatch route fixture\n",
  );
  fs.writeFileSync(path.join(root, ".gitignore"), ".pactile/\n");
  git(root, "add", "README.md", ".gitignore");
  git(root, "commit", "-q", "-m", "fixture base");
  return root;
}

function createCandidate(
  root: string,
  taskId: string,
  writeSet: string[],
  initialState: "waiting" | "running" = "waiting",
): string {
  const taskDir = path.join(root, ".pactile", "tasks", taskId);
  const created = createTaskKernel({
    root,
    taskDir,
    actor: "test-author",
    idempotencyKey: `create:${taskId}`,
    definition: {
      taskId,
      title: "P37 route fixture",
      description: "Route the public schedule dispatch command.",
      deliverable: "A reviewable provider result",
      deliveryLevel: "local-result",
      acceptanceCriteria: [
        { id: "AC-1", description: "The runner receives the receipt" },
      ],
      dependencies: [],
    },
  });
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
      scope: writeSet.join(", "),
      evidenceRef: `approval:${taskId}`,
    },
    initialState,
    writeSetSnapshot: writeSet,
    estimatedDurations: { executionMs: 10_000 },
  });
  const runId = started.kernel.runs.at(-1)?.id;
  if (!runId) throw new Error("V2 Run is missing");
  createTaskRunWorktree({
    repoRoot: root,
    taskDir,
    runId,
    branch: `feat/${taskId}`,
    baseRef: git(root, "rev-parse", "HEAD"),
    actor: "test-worktree-manager",
    idempotencyKey: `worktree:${taskId}`,
  });
  return runId;
}

describe("task schedule async CLI route", () => {
  it("plans and dispatches explicitly authorized overlapping Tasks from one receipt", async () => {
    const root = makeRoot();
    const taskIds = ["route-wave-left", "route-wave-right"] as const;
    const runIds = taskIds.map((taskId) =>
      createCandidate(root, taskId, ["src/shared.ts"]),
    );
    const authorization = {
      taskIds,
      approvedBy: "release-owner",
      authorizationRef: "approval:parallel-write:42",
      integrationOwner: "parent-integrator",
      integrationPlan:
        "Review both isolated worktrees, resolve src/shared.ts conflicts, then integrate left before right.",
    };
    fs.writeFileSync(
      path.join(root, "conflict-authorizations.json"),
      JSON.stringify([authorization]),
    );

    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
      output.push(String(value));
    });
    for (let index = 0; index < taskIds.length; index += 1) {
      expect(
        runTaskCli(
          ["run-resume", taskIds[index] as string, runIds[index] as string],
          root,
        ),
      ).toBe(0);
    }
    output.length = 0;
    const planCode = runTaskCli(
      [
        "schedule",
        "plan",
        ...taskIds,
        "--conflict-authorizations-file",
        "conflict-authorizations.json",
      ],
      root,
    );
    expect(planCode).toBe(0);
    expect(output).toHaveLength(1);
    const planOutput = JSON.parse(output.pop() as string) as {
      receipt: {
        receiptFingerprint: string;
        request: { conflictParallelizations: unknown[] };
        plan: { waves: { taskIds: string[]; decision: string }[] };
      };
    };
    const fingerprint = planOutput.receipt.receiptFingerprint;
    expect(planOutput.receipt.request.conflictParallelizations).toEqual([
      authorization,
    ]);
    expect(planOutput.receipt.plan.waves[0]).toMatchObject({
      taskIds: [...taskIds],
      decision: "parallel-time-saved",
    });

    const requests: TaskKernelWaveRunRequestV1[] = [];
    let active = 0;
    let peakActive = 0;
    const piRunner = createPiTaskKernelWaveRunnerV1(root, {
      command: process.execPath,
      args: [
        FAKE_PI_WAVE_PROVIDER,
        "--started-directory",
        path.join(root, "route-provider-starts"),
        "--barrier-size",
        "2",
      ],
    });
    const runner = vi.fn(
      async (request: TaskKernelWaveRunRequestV1): Promise<TaskKernelWaveRunResultV1> => {
        requests.push(request);
        active += 1;
        peakActive = Math.max(peakActive, active);
        try {
          return await piRunner(request);
        } finally {
          active -= 1;
        }
      },
    );

    const exitCode = await runTaskCliWithWorkspaceReclaim(
      ["schedule", "dispatch", fingerprint, "--timeout-ms", "5000"],
      root,
      { runner, runnerLabel: "fake-pi-rpc-provider-test-only" },
    );

    expect(exitCode).toBe(0);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(peakActive).toBe(2);
    expect(requests.map(({ taskId }) => taskId).sort()).toEqual(
      [...taskIds].sort(),
    );
    expect(requests.map(({ runId }) => runId).sort()).toEqual(
      [...runIds].sort(),
    );
    expect(
      requests.every(
        (request) => request.scheduleReceiptFingerprint === fingerprint,
      ),
    ).toBe(true);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] as string)).toMatchObject({
      status: "provider-runs-complete",
      runnerLabel: "fake-pi-rpc-provider-test-only",
      scheduleReceiptFingerprint: fingerprint,
      kernelRunSettlement: "not-performed",
      integrationPlan: {
        scheduleReceiptFingerprint: fingerprint,
        waves: [
          {
            taskIds: [...taskIds],
            conflictAuthorizations: [authorization],
            integration: { mode: "parallel-review" },
          },
        ],
      },
      tasks: taskIds.map((taskId) =>
        expect.objectContaining({
          taskId,
          status: "provider-runs-settled",
          hostStopVerified: true,
          leaseReleased: true,
        }),
      ),
    });
  });

  it("fails closed for a waiting Run before starting any provider and explains resume plus replanning", async () => {
    const root = makeRoot();
    const taskId = "route-waiting-dispatch";
    const runId = createCandidate(root, taskId, ["src/waiting.ts"]);
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
      output.push(String(value));
    });

    expect(runTaskCli(["schedule", "plan", taskId], root)).toBe(0);
    const planOutput = JSON.parse(output.pop() as string) as {
      receipt: {
        receiptFingerprint: string;
        plan: { decisions: { taskId: string; action: string }[] };
      };
    };
    expect(planOutput.receipt.plan.decisions).toContainEqual(
      expect.objectContaining({ taskId, action: "scheduled" }),
    );

    const runner = vi.fn(
      async (
        request: TaskKernelWaveRunRequestV1,
      ): Promise<TaskKernelWaveRunResultV1> => ({
        outcome: "settled",
        scheduleReceiptFingerprint: request.scheduleReceiptFingerprint,
        admissionReceiptFingerprint: "a".repeat(64),
        hostStopVerified: true,
        leaseReleased: true,
        evidenceRef: "unused-provider-result",
        reason: null,
      }),
    );
    const exitCode = await runTaskCliWithWorkspaceReclaim(
      [
        "schedule",
        "dispatch",
        planOutput.receipt.receiptFingerprint,
        "--timeout-ms",
        "5000",
      ],
      root,
      { runner, runnerLabel: "waiting-run-gate-test-only" },
    );

    expect(exitCode).toBe(1);
    expect(runner).not.toHaveBeenCalled();
    const result = JSON.parse(output.pop() as string) as {
      status: string;
      measurements: { waves: unknown[] };
      tasks: { taskId: string; status: string; reasonCode: string | null }[];
    };
    expect(result).toMatchObject({
      status: "blocked",
      measurements: { waves: [] },
      tasks: [
        {
          taskId,
          status: "blocked",
          reasonCode: "task-run-waiting-requires-run-resume-and-replan",
        },
      ],
    });
    const read = readTaskKernel({
      root,
      taskDir: path.join(root, ".pactile", "tasks", taskId),
      cwd: root,
    });
    expect(read.kind).toBe("task-kernel-v2");
    if (read.kind === "task-kernel-v2") {
      expect(read.kernel.runs.find((run) => run.id === runId)).toMatchObject({
        state: "waiting",
        host: null,
      });
    }
  });

  it("resumes through the public lifecycle, requires a fresh plan, then completes a settled Pi Run", async () => {
    const root = makeRoot();
    const taskId = "route-resumed-dispatch";
    const runId = createCandidate(root, taskId, ["src/resumed.ts"]);
    const output: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
      output.push(String(value));
    });
    vi.spyOn(console, "error").mockImplementation((value?: unknown) => {
      errors.push(String(value));
    });

    expect(runTaskCli(["schedule", "plan", taskId], root)).toBe(0);
    const queuedPlan = JSON.parse(output.pop() as string) as {
      receipt: { receiptFingerprint: string };
    };
    const staleRunner = vi.fn(
      async (): Promise<TaskKernelWaveRunResultV1> => {
        throw new Error("stale receipt must not start a provider");
      },
    );
    expect(runTaskCli(["run-resume", taskId, runId], root)).toBe(0);
    const staleExit = await runTaskCliWithWorkspaceReclaim(
      ["schedule", "dispatch", queuedPlan.receipt.receiptFingerprint],
      root,
      { runner: staleRunner, runnerLabel: "stale-receipt-test-only" },
    );
    expect(staleExit).toBe(1);
    expect(errors.at(-1)).toContain("schedule receipt is stale");
    expect(staleRunner).not.toHaveBeenCalled();

    output.length = 0;
    expect(runTaskCli(["schedule", "plan", taskId], root)).toBe(0);
    const freshPlan = JSON.parse(output.pop() as string) as {
      receipt: { receiptFingerprint: string };
    };
    expect(freshPlan.receipt.receiptFingerprint).not.toBe(
      queuedPlan.receipt.receiptFingerprint,
    );
    const piRunner = createPiTaskKernelWaveRunnerV1(root, {
      command: process.execPath,
      args: [
        FAKE_PI_WAVE_PROVIDER,
        "--started-directory",
        path.join(root, "resumed-provider-starts"),
      ],
    });
    const dispatchExit = await runTaskCliWithWorkspaceReclaim(
      ["schedule", "dispatch", freshPlan.receipt.receiptFingerprint, "--timeout-ms", "5000"],
      root,
      { runner: piRunner, runnerLabel: "fake-pi-rpc-provider-test-only" },
    );

    expect(dispatchExit).toBe(0);
    const dispatch = JSON.parse(output.pop() as string) as {
      status: string;
      tasks: { taskId: string; status: string; hostStopVerified: boolean; leaseReleased: boolean }[];
    };
    expect(dispatch).toMatchObject({
      status: "provider-runs-complete",
      tasks: [
        {
          taskId,
          status: "provider-runs-settled",
          hostStopVerified: true,
          leaseReleased: true,
        },
      ],
    });
    const settled = readTaskKernel({
      root,
      taskDir: path.join(root, ".pactile", "tasks", taskId),
      cwd: root,
    });
    expect(settled.kind).toBe("task-kernel-v2");
    if (settled.kind === "task-kernel-v2")
      expect(settled.kernel.runs.find((run) => run.id === runId)?.state).toBe(
        "running",
      );

    output.length = 0;
    expect(
      runTaskCli(
        [
          "run-result",
          taskId,
          runId,
          "--outcome",
          "completed",
          "--summary",
          "Settled provider result recorded through the public Run-result command.",
        ],
        root,
      ),
    ).toBe(0);
    const completed = readTaskKernel({
      root,
      taskDir: path.join(root, ".pactile", "tasks", taskId),
      cwd: root,
    });
    expect(completed.kind).toBe("task-kernel-v2");
    if (completed.kind === "task-kernel-v2")
      expect(completed.kernel.runs.find((run) => run.id === runId)?.state).toBe(
        "completed",
      );
  });

  it("keeps a Run with an existing admission in flight and refuses redispatch", async () => {
    const root = makeRoot();
    const taskId = "route-already-admitted";
    const runId = createCandidate(root, taskId, ["src/admitted.ts"]);
    const output: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
      output.push(String(value));
    });
    vi.spyOn(console, "error").mockImplementation((value?: unknown) => {
      errors.push(String(value));
    });
    expect(runTaskCli(["run-resume", taskId, runId], root)).toBe(0);
    output.length = 0;
    expect(runTaskCli(["schedule", "plan", taskId], root)).toBe(0);
    const queuedPlan = JSON.parse(output.pop() as string) as {
      receipt: {
        receiptFingerprint: string;
        plan: { decisions: { action: string }[] };
      };
    };
    expect(queuedPlan.receipt.plan.decisions[0]?.action).toBe("scheduled");

    const admission = acquireTaskKernelRunDispatchV1(root, {
      scheduleReceiptFingerprint: queuedPlan.receipt.receiptFingerprint,
      taskId,
      runId,
      owner: {
        host: "pi",
        role: "implement",
        sessionId: null,
        threadId: null,
        hostId: null,
      },
    });
    expect(admission.permitted).toBe(true);

    const runner = vi.fn(
      async (): Promise<TaskKernelWaveRunResultV1> => {
        throw new Error("an admitted Run must not start another provider");
      },
    );
    const staleExit = await runTaskCliWithWorkspaceReclaim(
      ["schedule", "dispatch", queuedPlan.receipt.receiptFingerprint],
      root,
      { runner, runnerLabel: "redispatch-after-admission-test-only" },
    );
    expect(staleExit).toBe(1);
    expect(errors.at(-1)).toContain("schedule receipt is stale");
    expect(runner).not.toHaveBeenCalled();

    output.length = 0;
    expect(runTaskCli(["schedule", "plan", taskId], root)).toBe(0);
    const inFlightPlan = JSON.parse(output.pop() as string) as {
      receipt: {
        receiptFingerprint: string;
        plan: {
          waves: unknown[];
          decisions: { action: string; reasonCodes: string[] }[];
        };
      };
    };
    expect(inFlightPlan.receipt.plan).toMatchObject({
      waves: [],
      decisions: [
        { action: "in-flight", reasonCodes: ["already-running"] },
      ],
    });
    const repeatExit = await runTaskCliWithWorkspaceReclaim(
      ["schedule", "dispatch", inFlightPlan.receipt.receiptFingerprint],
      root,
      { runner, runnerLabel: "redispatch-after-admission-test-only" },
    );
    expect(repeatExit).toBe(1);
    expect(runner).not.toHaveBeenCalled();
    expect(JSON.parse(output.pop() as string)).toMatchObject({
      status: "blocked",
      tasks: [
        {
          taskId,
          status: "blocked",
          reasonCode: "task-not-scheduled:in-flight",
        },
      ],
    });
  });

  it("rejects traversal and malformed authorization files before creating a receipt", () => {
    const root = makeRoot();
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((value?: unknown) => {
      errors.push(String(value));
    });
    const traversalCode = runTaskCli(
      [
        "schedule",
        "plan",
        "untrusted-candidate",
        "--conflict-authorizations-file",
        "../outside.json",
      ],
      root,
    );
    expect(traversalCode).toBe(1);
    expect(errors.at(-1)).toContain("unsafe path segment");

    fs.writeFileSync(
      path.join(root, "malformed-authorizations.json"),
      JSON.stringify([
        {
          taskIds: ["untrusted-candidate", "another-candidate"],
          approvedBy: "owner",
          authorizationRef: "approval:1",
          integrationOwner: "parent-integrator",
          integrationPlan: "Review before merge.",
          dispatch: true,
        },
      ]),
    );
    const malformedCode = runTaskCli(
      [
        "schedule",
        "plan",
        "untrusted-candidate",
        "another-candidate",
        "--conflict-authorizations-file",
        "malformed-authorizations.json",
      ],
      root,
    );
    expect(malformedCode).toBe(1);
    expect(errors.at(-1)).toContain("must contain only");

    fs.writeFileSync(
      path.join(root, "oversized-authorizations.json"),
      " ".repeat(64 * 1024 + 1),
    );
    const oversizedCode = runTaskCli(
      [
        "schedule",
        "plan",
        "untrusted-candidate",
        "another-candidate",
        "--conflict-authorizations-file",
        "oversized-authorizations.json",
      ],
      root,
    );
    expect(oversizedCode).toBe(1);
    expect(errors.at(-1)).toContain("exceeds 65536 bytes");
  });

  it("rejects symbolic links for authorization file input", (context) => {
    const root = makeRoot();
    fs.writeFileSync(
      path.join(root, "authorization-target.json"),
      JSON.stringify([
        {
          taskIds: ["untrusted-candidate", "another-candidate"],
          approvedBy: "owner",
          authorizationRef: "approval:1",
          integrationOwner: "parent-integrator",
          integrationPlan: "Review before merge.",
        },
      ]),
    );
    try {
      fs.symlinkSync(
        "authorization-target.json",
        path.join(root, "authorization-link.json"),
        "file",
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }

    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((value?: unknown) => {
      errors.push(String(value));
    });
    const exitCode = runTaskCli(
      [
        "schedule",
        "plan",
        "untrusted-candidate",
        "another-candidate",
        "--conflict-authorizations-file",
        "authorization-link.json",
      ],
      root,
    );
    expect(exitCode).toBe(1);
    expect(errors.at(-1)).toContain("may not use symlinks");
  });
});
