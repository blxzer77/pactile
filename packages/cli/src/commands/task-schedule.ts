import fs from "node:fs";
import path from "node:path";
import { listTaskKernelSnapshots } from "../core/task/index.js";
import {
  scheduleTaskKernelGraphWithJevV1,
  readTaskKernelScheduleReceiptV1,
  scheduleTaskKernelGraph,
  type ConflictParallelAuthorizationV1,
  type JevScheduleAdviceOptionsV1,
  type TaskKernelScheduleDecisionReceiptV1,
} from "../pactile/scheduler/index.js";
import {
  createJevDecisionFacadeV1,
  type JevEgressAuthorizationV1,
} from "../pactile/jev/index.js";
import { JEV_ORIGIN_V1 } from "../pactile/jev/contracts.js";
import {
  dispatchTaskKernelWaveV1,
  type TaskKernelWaveDispatchOptionsV1,
  type TaskKernelWaveRunnerV1,
} from "../pactile/scheduler/task-kernel-wave-dispatch.js";
import { PiTaskBridge, type PiRunRecord } from "../pactile/pi/bridge.js";
import type { PiRpcLaunch } from "../pactile/pi/rpc.js";

const MAX_CONFLICT_AUTHORIZATION_FILE_BYTES = 64 * 1024;
const MAX_CONFLICT_AUTHORIZATION_PATH_SEGMENTS = 32;

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function assertSafeAuthorizationFilePath(
  rootValue: string,
  value: string,
): { root: string; file: string; segments: string[] } {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\0") ||
    value.includes(":") ||
    path.isAbsolute(value) ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  )
    throw new Error(
      "conflict authorization file path must be a project-relative path without drive or stream syntax",
    );
  const segments = value.split(/[\\/]/);
  if (
    segments.length > MAX_CONFLICT_AUTHORIZATION_PATH_SEGMENTS ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  )
    throw new Error(
      "conflict authorization file path contains an unsafe path segment",
    );

  const root = fs.realpathSync(rootValue);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink())
      throw new Error("conflict authorization file path may not use symlinks");
    if (index < segments.length - 1 && !stat.isDirectory())
      throw new Error(
        "conflict authorization file path parent must be a directory",
      );
  }
  const stat = fs.lstatSync(current);
  if (!stat.isFile())
    throw new Error("conflict authorization path must name a regular file");
  const file = fs.realpathSync(current);
  if (!pathIsInside(root, file))
    throw new Error("conflict authorization file must stay inside the project");
  return { root, file, segments };
}

function readConflictAuthorizationBytes(
  rootValue: string,
  relativePath: string,
): Buffer {
  const checked = assertSafeAuthorizationFilePath(rootValue, relativePath);
  const pathStat = fs.lstatSync(checked.file);
  if (pathStat.isSymbolicLink() || !pathStat.isFile())
    throw new Error("conflict authorization path must name a regular file");
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(checked.file, flags);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile())
      throw new Error("conflict authorization path must name a regular file");
    if (pathStat.dev !== before.dev || pathStat.ino !== before.ino)
      throw new Error("conflict authorization file changed while being opened");
    if (before.size > MAX_CONFLICT_AUTHORIZATION_FILE_BYTES)
      throw new Error(
        `conflict authorization file exceeds ${MAX_CONFLICT_AUTHORIZATION_FILE_BYTES} bytes`,
      );
    const boundedBuffer = Buffer.alloc(
      MAX_CONFLICT_AUTHORIZATION_FILE_BYTES + 1,
    );
    let bytesRead = 0;
    while (bytesRead < boundedBuffer.length) {
      const count = fs.readSync(
        fd,
        boundedBuffer,
        bytesRead,
        boundedBuffer.length - bytesRead,
        bytesRead,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_CONFLICT_AUTHORIZATION_FILE_BYTES)
      throw new Error(
        `conflict authorization file exceeds ${MAX_CONFLICT_AUTHORIZATION_FILE_BYTES} bytes`,
      );
    const bytes = boundedBuffer.subarray(0, bytesRead);
    const after = fs.fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.length !== after.size
    )
      throw new Error("conflict authorization file changed while being read");
    const rechecked = assertSafeAuthorizationFilePath(
      checked.root,
      relativePath,
    );
    if (rechecked.file !== checked.file)
      throw new Error("conflict authorization file changed while being read");
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function parseConflictParallelizations(
  root: string,
  relativePath: string,
  candidateTaskIds: readonly string[],
): ConflictParallelAuthorizationV1[] {
  const bytes = readConflictAuthorizationBytes(root, relativePath);
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (error) {
    throw new Error(
      "conflict authorization file must contain valid UTF-8 JSON: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const maximumPairs =
    (candidateTaskIds.length * (candidateTaskIds.length - 1)) / 2;
  if (
    !Array.isArray(decoded) ||
    decoded.length === 0 ||
    decoded.length > maximumPairs
  )
    throw new Error(
      "conflict authorization file must be a nonempty JSON array with no more than one authorization per candidate pair",
    );

  const candidateIds = new Set(candidateTaskIds);
  const seenPairs = new Set<string>();
  return decoded.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(
        `conflict authorization entry ${index + 1} must be an object`,
      );
    const record = entry as Record<string, unknown>;
    const expectedKeys = [
      "approvedBy",
      "authorizationRef",
      "integrationOwner",
      "integrationPlan",
      "taskIds",
    ];
    if (
      Object.keys(record).length !== expectedKeys.length ||
      Object.keys(record).some((key) => !expectedKeys.includes(key))
    )
      throw new Error(
        `conflict authorization entry ${index + 1} must contain only taskIds, approvedBy, authorizationRef, integrationOwner, and integrationPlan`,
      );
    if (
      !Array.isArray(record.taskIds) ||
      record.taskIds.length !== 2 ||
      !record.taskIds.every(
        (taskId) => typeof taskId === "string" && taskId.length > 0,
      )
    )
      throw new Error(
        `conflict authorization entry ${index + 1} taskIds must contain exactly two Task IDs`,
      );
    const [left, right] = record.taskIds as [string, string];
    if (left === right)
      throw new Error(
        `conflict authorization entry ${index + 1} must name two distinct Task IDs`,
      );
    if (!candidateIds.has(left) || !candidateIds.has(right))
      throw new Error(
        `conflict authorization entry ${index + 1} must name two candidates in this schedule plan`,
      );
    const pairKey = JSON.stringify([left, right].sort());
    if (seenPairs.has(pairKey))
      throw new Error(
        `conflict authorization file repeats the pair ${left} / ${right}`,
      );
    seenPairs.add(pairKey);

    const boundedString = (
      key:
        | "approvedBy"
        | "authorizationRef"
        | "integrationOwner"
        | "integrationPlan",
      maxLength: number,
    ): string => {
      const value = record[key];
      if (
        typeof value !== "string" ||
        value.trim().length === 0 ||
        value.length > maxLength ||
        value.includes("\0")
      )
        throw new Error(
          `conflict authorization entry ${index + 1} ${key} must be a nonempty string of at most ${maxLength} characters`,
        );
      return value;
    };
    return {
      taskIds: [left, right],
      approvedBy: boundedString("approvedBy", 200),
      authorizationRef: boundedString("authorizationRef", 512),
      integrationOwner: boundedString("integrationOwner", 200),
      integrationPlan: boundedString("integrationPlan", 4096),
    };
  });
}

export interface TaskScheduleDispatchCliOptionsV1 {
  runner?: TaskKernelWaveRunnerV1;
  runnerLabel?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  launch?: PiRpcLaunch;
}

export function createPiTaskKernelWaveRunnerV1(
  rootValue: string,
  launch?: PiRpcLaunch,
): TaskKernelWaveRunnerV1 {
  const root = path.resolve(rootValue);
  return async (request) => {
    const bridge = new PiTaskBridge(root, launch);
    try {
      const record: PiRunRecord = await bridge.run({
        root,
        task: request.taskId,
        role: "implement",
        prompt: request.prompt,
        timeoutMs: request.timeoutMs,
        runId: request.runId,
        scheduleReceiptFingerprint: request.scheduleReceiptFingerprint,
        signal: request.signal,
      });
      const processExit = record.process_stop_receipt?.processExit;
      return {
        outcome: record.outcome === "running" ? "interrupted" : record.outcome,
        scheduleReceiptFingerprint: record.schedule_receipt_fingerprint ?? null,
        admissionReceiptFingerprint:
          record.admission_receipt_fingerprint ?? null,
        hostStopVerified:
          processExit?.terminationVerified === true &&
          typeof processExit.exitObservedAt === "string",
        leaseReleased: record.dispatch_lease_released === true,
        evidenceRef:
          record.dispatch_stop_proof_ref ?? record.result_file ?? null,
        reason:
          record.dispatch_lease_release_reason ??
          record.process_stop_error ??
          record.reason,
      };
    } finally {
      await bridge.close();
    }
  };
}

export async function runTaskScheduleDispatchCli(
  args: string[],
  root = process.cwd(),
  options: TaskScheduleDispatchCliOptionsV1 = {},
): Promise<number> {
  let timeoutMs = options.timeoutMs ?? 30 * 60_000;
  let fingerprint: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--timeout-ms") {
      const value = args[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error(
          "--timeout-ms requires an integer number of milliseconds",
        );
      timeoutMs = Number(value);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--"))
      throw new Error(`task schedule dispatch does not accept ${arg}`);
    if (fingerprint !== undefined)
      throw new Error(
        "task schedule dispatch accepts one schedule receipt fingerprint",
      );
    fingerprint = arg;
  }
  if (!fingerprint)
    throw new Error(
      "task schedule dispatch requires one schedule receipt fingerprint and optional --timeout-ms <milliseconds>",
    );
  const runner =
    options.runner ?? createPiTaskKernelWaveRunnerV1(root, options.launch);
  const dispatchOptions: TaskKernelWaveDispatchOptionsV1 = {
    timeoutMs,
    runner,
    runnerLabel:
      options.runnerLabel ??
      (options.runner ? "injected-task-run-provider" : "pi-rpc"),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const result = await dispatchTaskKernelWaveV1(
    root,
    fingerprint,
    dispatchOptions,
  );
  console.log(JSON.stringify(result, null, 2));
  return result.status === "provider-runs-complete" ||
    result.status === "no-work"
    ? 0
    : 1;
}

interface ListedTask {
  taskId: string;
  title: string;
  phase: string;
  revision: number;
  taskPath: string;
}

function receiptDisplay(
  receipt: TaskKernelScheduleDecisionReceiptV1,
  integrity:
    | "fingerprint-verified"
    | "legacy-fingerprint-excludes-createdAt" = receipt.integrityVersion === 2
    ? "fingerprint-verified"
    : "legacy-fingerprint-excludes-createdAt",
): {
  integrity: "fingerprint-verified" | "legacy-fingerprint-excludes-createdAt";
  receipt: Record<string, unknown>;
  unverifiedCreatedAt?: string;
} {
  if (integrity === "fingerprint-verified")
    return {
      integrity: "fingerprint-verified",
      receipt: { ...receipt },
    };
  const { createdAt, ...legacyReceipt } = receipt;
  return {
    integrity: "legacy-fingerprint-excludes-createdAt",
    receipt: { ...legacyReceipt },
    unverifiedCreatedAt: createdAt,
  };
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
    "Plan explicitly with: pactile task schedule plan <task-id> [task-id ...] [--conflict-authorizations-file <project-relative-json>]",
  );
  console.log(
    "Plan may use bounded Jev advice only to break a first-wave equal-critical-path tie; it does not authorize or dispatch Runs.",
  );
  return 0;
}

function parseTaskSchedulePlanArgs(
  args: string[],
  root: string,
): {
  candidateTaskIds: string[];
  conflictParallelizations: ConflictParallelAuthorizationV1[] | undefined;
} {
  const candidateTaskIds: string[] = [];
  let conflictAuthorizationFile: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--conflict-authorizations-file") {
      if (conflictAuthorizationFile !== undefined)
        throw new Error(
          "task schedule plan accepts --conflict-authorizations-file once",
        );
      const file = args[index + 1];
      if (!file || file.startsWith("--"))
        throw new Error(
          "--conflict-authorizations-file requires a project-relative JSON file path",
        );
      conflictAuthorizationFile = file;
      index += 1;
      continue;
    }
    if (arg?.startsWith("--"))
      throw new Error(`task schedule plan does not accept ${arg}`);
    if (arg) candidateTaskIds.push(arg);
  }
  if (!candidateTaskIds.length)
    throw new Error(
      "at least one V2 Task ID is required; list candidates with `pactile task schedule list`",
    );
  const conflictParallelizations = conflictAuthorizationFile
    ? parseConflictParallelizations(
        root,
        conflictAuthorizationFile,
        candidateTaskIds,
      )
    : undefined;
  return { candidateTaskIds, conflictParallelizations };
}

function printTaskSchedulePlan(
  result: ReturnType<typeof scheduleTaskKernelGraph>,
): void {
  const display = receiptDisplay(result.receipt);
  console.log(
    JSON.stringify(
      {
        receiptFile: result.receiptFile,
        receiptStatus: result.created ? "created" : "reused",
        integrity: display.integrity,
        ...(display.unverifiedCreatedAt
          ? { unverifiedCreatedAt: display.unverifiedCreatedAt }
          : {}),
        execution: "not-dispatched",
        receipt: display.receipt,
      },
      null,
      2,
    ),
  );
}

function scheduleTaskPlan(args: string[], root: string): number {
  const { candidateTaskIds, conflictParallelizations } =
    parseTaskSchedulePlanArgs(args, root);
  const result = scheduleTaskKernelGraph(root, candidateTaskIds, {
    ...(conflictParallelizations ? { conflictParallelizations } : {}),
  });
  printTaskSchedulePlan(result);
  return 0;
}

function createTaskScheduleJevOptions(): JevScheduleAdviceOptionsV1 {
  const enabledValue = process.env.PACTILE_JEV_ENABLED?.trim().toLowerCase();
  const explicitlyDisabled = enabledValue === "false";
  const deadlineMs = 2_500;
  const facade = createJevDecisionFacadeV1({
    ...(explicitlyDisabled ? { enabled: false } : {}),
    maxDecisions: 1,
    maxDeadlineMs: deadlineMs,
    transport: {
      apiKey: process.env.PACTILE_JEV_API_KEY,
      deadlineMs,
      maxRetries: 1,
    },
  });
  const egress: JevEgressAuthorizationV1 = {
    network: "project-authorized",
    privacy: "project-approved-egress",
    credentials: "project-authorized",
    destination: JEV_ORIGIN_V1,
    egressDestinations: [JEV_ORIGIN_V1],
    contentDecision: "task-summary-approved",
  };
  return { facade, egress };
}

async function scheduleTaskPlanWithJev(
  args: string[],
  root: string,
): Promise<number> {
  const { candidateTaskIds, conflictParallelizations } =
    parseTaskSchedulePlanArgs(args, root);
  const jevOptions = createTaskScheduleJevOptions();
  const result = await scheduleTaskKernelGraphWithJevV1(
    root,
    candidateTaskIds,
    { ...(conflictParallelizations ? { conflictParallelizations } : {}) },
    jevOptions,
  );
  printTaskSchedulePlan(result);
  return 0;
}

function scheduleTaskShow(args: string[], root: string): number {
  if (args.length !== 1)
    throw new Error("task schedule show requires one receipt fingerprint");
  const [fingerprint] = args;
  if (!fingerprint)
    throw new Error("task schedule show requires one receipt fingerprint");
  const loaded = readTaskKernelScheduleReceiptV1(root, fingerprint);
  const display = receiptDisplay(loaded.receipt, loaded.integrity);
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
        integrity: display.integrity,
        ...(display.unverifiedCreatedAt
          ? { unverifiedCreatedAt: display.unverifiedCreatedAt }
          : {}),
        taskRevisionFreshness: "not-rechecked",
        execution: "not-dispatched",
        receipt: display.receipt,
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

/** Promise-aware V2 plan entry for task CLI wrappers that can await Jev advice. */
export function runTaskSchedulePlanCliAsync(
  args: string[],
  root = process.cwd(),
): Promise<number> {
  return scheduleTaskPlanWithJev(args, root);
}

/** Async-compatible schedule entry; list and show retain their synchronous path. */
export async function runTaskScheduleCliAsync(
  args: string[],
  root = process.cwd(),
): Promise<number> {
  const [operation, ...rest] = args;
  if (operation === "plan") return runTaskSchedulePlanCliAsync(rest, root);
  return runTaskScheduleCli(args, root);
}
