import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskKernel, startTaskRun } from "../../src/core/task/index.js";
import { runTaskCli } from "../../src/commands/task.js";
import { runTaskCliWithWorkspaceReclaim } from "../../src/commands/task-worktree-close.js";
import { createPiTaskKernelWaveRunnerV1 } from "../../src/commands/task-schedule.js";
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
    initialState: "waiting",
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
