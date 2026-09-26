import path from "node:path";
import { listTaskKernelSnapshots } from "../core/task/index.js";
import {
  readTaskKernelScheduleReceiptV1,
  scheduleTaskKernelGraph,
} from "../pactile/scheduler/index.js";

interface ListedTask {
  taskId: string;
  title: string;
  phase: string;
  revision: number;
  taskPath: string;
}

function activeV2Tasks(rootValue: string): ListedTask[] {
  const root = path.resolve(rootValue);
  const archivePrefix =
    `${path.resolve(root, ".pactile", "tasks", "archive")}${path.sep}`.toLowerCase();
  return listTaskKernelSnapshots(root)
    .filter(
      ({ taskDir }) =>
        !path.resolve(taskDir).toLowerCase().startsWith(archivePrefix),
    )
    .map(({ taskDir, kernel }) => ({
      taskId: kernel.identity.taskId,
      title: kernel.definition.title,
      phase: kernel.phase,
      revision: kernel.revision,
      taskPath: path.relative(root, taskDir).replaceAll("\\", "/"),
    }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function scheduleTaskList(args: string[], root: string): number {
  const json = args.includes("--json");
  if (args.some((arg) => arg !== "--json"))
    throw new Error("task schedule list accepts only --json");
  const tasks = activeV2Tasks(root);
  if (json) {
    console.log(
      JSON.stringify(
        { schemaVersion: 1, scope: "task-kernel-v2", tasks },
        null,
        2,
      ),
    );
    return 0;
  }
  console.log("Active Task Kernel v2 schedule candidates:");
  if (!tasks.length) console.log("  (none)");
  for (const task of tasks)
    console.log(
      `  - ${task.taskId} (${task.phase}; revision ${task.revision}) — ${task.taskPath}`,
    );
  console.log(
    "Plan explicitly with: pactile task schedule plan <task-id> [task-id ...]",
  );
  return 0;
}

function scheduleTaskPlan(args: string[], root: string): number {
  const candidateTaskIds = args.filter((arg) => !arg.startsWith("--"));
  if (args.length !== candidateTaskIds.length)
    throw new Error(
      "task schedule plan accepts Task IDs only; list candidates with `pactile task schedule list`",
    );
  if (!candidateTaskIds.length)
    throw new Error(
      "at least one V2 Task ID is required; list candidates with `pactile task schedule list`",
    );
  const result = scheduleTaskKernelGraph(root, candidateTaskIds);
  console.log(
    JSON.stringify(
      {
        receiptFile: result.receiptFile,
        receiptStatus: result.created ? "created" : "reused",
        execution: "not-dispatched",
        receipt: result.receipt,
      },
      null,
      2,
    ),
  );
  return 0;
}

function scheduleTaskShow(args: string[], root: string): number {
  if (args.length !== 1)
    throw new Error("task schedule show requires one receipt fingerprint");
  const [fingerprint] = args;
  if (!fingerprint)
    throw new Error("task schedule show requires one receipt fingerprint");
  const receipt = readTaskKernelScheduleReceiptV1(root, fingerprint);
  const receiptFile = path.posix.join(
    ".pactile",
    ".runtime",
    "scheduler",
    "receipts",
    `${fingerprint}.json`,
  );
  console.log(
    JSON.stringify(
      {
        receiptFile,
        integrity: "fingerprint-verified",
        taskRevisionFreshness: "not-rechecked",
        execution: "not-dispatched",
        receipt,
      },
      null,
      2,
    ),
  );
  return 0;
}

export function runTaskScheduleCli(
  args: string[],
  root = process.cwd(),
): number {
  const [operation, ...rest] = args;
  switch (operation) {
    case "list":
      return scheduleTaskList(rest, root);
    case "plan":
      return scheduleTaskPlan(rest, root);
    case "show":
      return scheduleTaskShow(rest, root);
    default:
      throw new Error(
        "Use `pactile task schedule list|plan|show`; this command plans V2 Task Kernel DAGs and does not dispatch Runs.",
      );
  }
}
