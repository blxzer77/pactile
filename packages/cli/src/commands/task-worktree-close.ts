import { execFileSync } from "node:child_process";
import { readTaskKernel } from "../core/task/index.js";
import { resolveTaskDir } from "../pactile/task/session.js";
import { reclaimRunWorktree } from "../pactile/worktree/index.js";
import { readDeveloper } from "../utils/developer.js";
import { runTaskCliAsync } from "./task.js";
import type { TaskScheduleDispatchCliOptionsV1 } from "./task-schedule.js";
import { runTaskVerifyPlanCli } from "./task-verify-plan.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function repositoryRoot(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Run the existing Close command, then automatically attempt safe cleanup for its bound Run. */
export async function runTaskCliWithWorkspaceReclaim(
  argv: string[],
  cwd = process.cwd(),
  scheduleDispatchOptions: TaskScheduleDispatchCliOptionsV1 = {},
): Promise<number> {
  if (argv[0] === "verify-plan")
    return runTaskVerifyPlanCli(argv.slice(1), cwd);

  const closeCode = await runTaskCliAsync(argv, cwd, scheduleDispatchOptions);
  if (closeCode !== 0 || argv[0] !== "close" || argv.includes("--check"))
    return closeCode;

  try {
    const taskReference = argv[1];
    const runId = option(argv, "--run");
    if (!taskReference || !runId) return closeCode;

    const cwdTaskDir = resolveTaskDir(cwd, taskReference);
    const cwdRead = readTaskKernel({
      root: cwd,
      taskDir: cwdTaskDir,
      cwd,
    });
    if (cwdRead.kind !== "task-kernel-v2") return closeCode;
    const cwdRun = cwdRead.kernel.runs.find((item) => item.id === runId);
    if (!cwdRun?.workspace?.manager) return closeCode;

    const repoRoot = repositoryRoot(cwd);
    const taskDir = resolveTaskDir(repoRoot, taskReference);
    const read = readTaskKernel({ root: repoRoot, taskDir, cwd: repoRoot });
    if (read.kind !== "task-kernel-v2") return closeCode;
    const run = read.kernel.runs.find((item) => item.id === runId);
    if (!run?.workspace?.manager) return closeCode;

    const cleanup = await reclaimRunWorktree({
      repoRoot,
      taskDir,
      runId,
      actor: option(argv, "--actor") ?? readDeveloper(repoRoot) ?? "user",
      idempotencyKey: `${option(argv, "--idempotency-key") ?? `task-close:${read.kernel.identity.taskId}`}:worktree-cleanup:${runId}`,
    });
    const status = {
      operation: "task-close-worktree-cleanup",
      taskId: read.kernel.identity.taskId,
      runId,
      state: cleanup.state,
      path: cleanup.path,
      receiptRef: "receiptRef" in cleanup ? cleanup.receiptRef : null,
      reason:
        "reason" in cleanup
          ? (cleanup.reason ?? null)
          : "Manual cleanup action is required",
    };
    (cleanup.state === "reclaimed" ? console.log : console.error)(
      JSON.stringify(status, null, 2),
    );
    return closeCode;
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          operation: "task-close-worktree-cleanup",
          runId: option(argv, "--run") ?? null,
          state: "cleanup-error-retained",
          reason: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    );
    return closeCode;
  }
}
