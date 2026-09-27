import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  PiTaskBridge,
  approvedTask,
  piWorkdir,
  type PiRunRecord,
} from "../pi/bridge.js";
import type { PiRpcLaunch } from "../pi/rpc.js";
import { createJevDecisionFacadeV1 } from "../jev/index.js";
import {
  JEV_ORIGIN_V1,
  type JevEgressAuthorizationV1,
} from "../jev/contracts.js";
import type { JevScheduleAdviceOptionsV1 } from "../jev/scheduler-advice.js";
import { resolveTaskDir } from "../task/session.js";
import { readTaskMap } from "../task/task-map.js";
import {
  planParentTaskScheduleV1,
  scheduleParentTaskGraph,
  scheduleParentTaskGraphWithJevV1,
  type SchedulerCostVectorV1,
  type TaskMapScheduleOptionsV1,
} from "../scheduler/index.js";
import { parallelChild } from "./policy.js";

export interface BatchItem {
  task: string;
  prompt_file: string;
  review_cost: "low" | "medium" | "high";
  estimated_costs?: Partial<SchedulerCostVectorV1>;
}
export interface BatchManifest {
  schema_version: 1;
  /** Read-only compatibility field. Active scheduling uses the DAG plan. */
  limit?: number;
  children: BatchItem[];
  conflict_parallelizations?: {
    task_ids: [string, string];
    approved_by: string;
    authorization_ref: string;
    /** Required for new authorizations; optional only in readable legacy manifests. */
    integration_owner?: string;
    integration_plan: string;
  }[];
  jev_advice?: { task_order: string[]; evidence_ref: string };
}
export interface BatchResult {
  schema_version: 2;
  batch_id: string;
  event_file: string;
  schedule_receipt_fingerprint: string;
  schedule_receipt_file: string;
  /** Explicit manifest advice retains the legacy synchronous planner. */
  schedule_advice_route: "manifest-explicit" | "jev-aware";
  compatibility_limit_ignored: number | null;
  parent: string;
  integration_owner: "parent";
  merge_limit: number;
  started_at: string;
  ended_at: string;
  wall_ms: number;
  queue_wait_total_ms: number;
  max_active: number;
  children: {
    task: string;
    review_cost: BatchItem["review_cost"];
    queue_wait_ms: number;
    started_at: string;
    ended_at: string;
    outcome: string;
    pi_run_id: string | null;
    event_count: number;
    tool_errors: number;
    reason: string | null;
  }[];
}

function readManifest(file: string): BatchManifest {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid parallel manifest");
  const manifest = value as BatchManifest;
  if (
    manifest.schema_version !== 1 ||
    !Array.isArray(manifest.children) ||
    manifest.children.length < 1
  ) {
    throw new Error(
      "Parallel manifest requires schema_version 1 and at least one Child",
    );
  }
  return manifest;
}

const REVIEW_COST_PRIOR_MS = {
  low: 60_000,
  medium: 300_000,
  high: 900_000,
} as const;

function coreTaskIdForChild(
  childId: string,
  lifecycle: ReturnType<typeof planParentTaskScheduleV1>["lifecycle"],
): string {
  const snapshot = lifecycle.find((item) => item.taskMapChildId === childId);
  if (!snapshot)
    throw new Error(
      `Scheduler cannot resolve Parent Child identity: ${childId}`,
    );
  return snapshot.taskId;
}

function scheduleOptionsForManifest(
  manifest: BatchManifest,
  childTaskIds: ReadonlyMap<string, string>,
  initial: ReturnType<typeof planParentTaskScheduleV1>,
): TaskMapScheduleOptionsV1 {
  const estimatedCosts: NonNullable<
    TaskMapScheduleOptionsV1["estimatedCosts"]
  > = {};
  for (const item of manifest.children) {
    const taskId = childTaskIds.get(item.task);
    if (!taskId)
      throw new Error(`Scheduler cannot resolve manifest Child: ${item.task}`);
    const estimates = { ...item.estimated_costs };
    if (
      estimates.reviewMs === undefined &&
      initial.lifecycle.find((entry) => entry.taskId === taskId)?.estimateBasis
        .reviewMs === "unmeasured-zero"
    ) {
      estimates.reviewMs = REVIEW_COST_PRIOR_MS[item.review_cost];
    }
    estimatedCosts[taskId] = estimates;
  }
  const resolveTaskId = (reference: string): string => {
    if ([...childTaskIds.values()].includes(reference)) return reference;
    const match = [...childTaskIds.entries()].find(
      ([childId]) => childId === reference || childId.endsWith(`-${reference}`),
    );
    if (!match)
      throw new Error(
        `Schedule hint references a Child outside the manifest: ${reference}`,
      );
    return match[1];
  };
  return {
    candidateTaskIds: [...childTaskIds.values()],
    estimatedCosts,
    ...(manifest.conflict_parallelizations
      ? {
          conflictParallelizations: manifest.conflict_parallelizations.map(
            (authorization) => {
              if (
                typeof authorization.integration_owner !== "string" ||
                !authorization.integration_owner.trim()
              )
                throw new Error(
                  "Conflict parallelization requires integration_owner",
                );
              return {
                taskIds: [
                  resolveTaskId(authorization.task_ids[0]),
                  resolveTaskId(authorization.task_ids[1]),
                ] as [string, string],
                approvedBy: authorization.approved_by,
                authorizationRef: authorization.authorization_ref,
                integrationOwner: authorization.integration_owner,
                integrationPlan: authorization.integration_plan,
              };
            },
          ),
        }
      : {}),
    ...(manifest.jev_advice
      ? {
          jevAdvice: {
            taskOrder: manifest.jev_advice.task_order.map(resolveTaskId),
            evidenceRef: manifest.jev_advice.evidence_ref,
          },
        }
      : {}),
  };
}

function alive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

function createBatchScheduleJevOptions(): JevScheduleAdviceOptionsV1 {
  const explicitlyDisabled =
    process.env.PACTILE_JEV_ENABLED?.trim().toLowerCase() === "false";
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

/** Runs only approved Pi Child tasks. Parent review and integration remain manual, serial gates. */
export async function runParallelBatch(
  root: string,
  parent: string,
  manifestFile: string,
  launch?: PiRpcLaunch,
): Promise<BatchResult> {
  const parentDir = resolveTaskDir(root, parent);
  const { data: map } = readTaskMap(parentDir);
  if (!map) throw new Error("Parent task-map.md is required");
  if (map.execution_topology !== "parallel")
    throw new Error(
      "Parent execution_topology must be parallel for batch dispatch",
    );
  if (map.merge_limit !== 1)
    throw new Error(
      "Parallel batch requires serial Parent integration (merge_limit: 1)",
    );
  const manifest = readManifest(manifestFile);
  const initialPlan = planParentTaskScheduleV1(root, parentDir);
  const seen = new Set<string>();
  const childTaskIds = new Map<string, string>();
  const children = manifest.children.map((item) => {
    if (
      !item ||
      typeof item.task !== "string" ||
      typeof item.prompt_file !== "string" ||
      !["low", "medium", "high"].includes(item.review_cost)
    ) {
      throw new Error(
        "Each Child needs task, prompt_file and review_cost: low|medium|high",
      );
    }
    const dir = approvedTask(root, item.task, "implement");
    piWorkdir(root, dir, "implement");
    const policy = parallelChild(root, dir);
    if (policy?.parentDir !== parentDir)
      throw new Error(
        `Task is not a Child of ${path.basename(parentDir)}: ${item.task}`,
      );
    if (seen.has(policy.entry.id))
      throw new Error(`Duplicate Child: ${policy.entry.id}`);
    seen.add(policy.entry.id);
    childTaskIds.set(
      policy.entry.id,
      coreTaskIdForChild(policy.entry.id, initialPlan.lifecycle),
    );
    const promptFile = path.resolve(root, item.prompt_file);
    if (!fs.statSync(promptFile, { throwIfNoEntry: false })?.isFile())
      throw new Error(`Prompt file not found: ${item.prompt_file}`);
    const prompt = fs.readFileSync(promptFile, "utf8");
    if (!prompt.trim() || prompt.length > 64 * 1024)
      throw new Error(
        `Prompt must contain 1 to 65536 characters: ${item.task}`,
      );
    return { task: policy.entry.id, reviewCost: item.review_cost, prompt };
  });
  const scheduleOptions = scheduleOptionsForManifest(
    manifest,
    childTaskIds,
    initialPlan,
  );
  const scheduleAdviceRoute = manifest.jev_advice
    ? "manifest-explicit"
    : "jev-aware";
  const schedule = manifest.jev_advice
    ? scheduleParentTaskGraph(root, parentDir, scheduleOptions)
    : await scheduleParentTaskGraphWithJevV1(
        root,
        parentDir,
        scheduleOptions,
        createBatchScheduleJevOptions(),
      );
  const selectedByTaskId = new Map(
    [...childTaskIds.entries()].map(([childId, taskId]) => [
      taskId,
      children.find((child) => child.task === childId),
    ]),
  );
  for (const [taskId, child] of selectedByTaskId) {
    if (!child)
      throw new Error(`Scheduler manifest identity disappeared: ${taskId}`);
    const decision = schedule.receipt.plan.decisions.find(
      (item) => item.taskId === taskId,
    );
    if (decision?.action !== "scheduled") {
      throw new Error(
        `Scheduler gate rejects Child ${child.task}: ${decision?.action ?? "missing-decision"} (${decision?.reasonCodes.join(", ") ?? "no decision"})`,
      );
    }
  }
  const taskToChild = new Map(
    [...childTaskIds.entries()].map(([childId, taskId]) => [taskId, childId]),
  );
  const scheduledWaves = schedule.receipt.plan.waves.map((wave) => {
    const waveChildren = wave.taskIds.map((taskId) => {
      const childId = taskToChild.get(taskId);
      const child = children.find((candidate) => candidate.task === childId);
      if (!child)
        throw new Error(
          `Scheduler wave contains a Child outside the manifest: ${taskId}`,
        );
      return child;
    });
    return {
      sequence: wave.sequence,
      taskIds: wave.taskIds,
      children: waveChildren,
    };
  });
  const scheduledCount = scheduledWaves.reduce(
    (sum, wave) => sum + wave.taskIds.length,
    0,
  );
  if (scheduledCount !== children.length)
    throw new Error(
      "Scheduler plan does not contain every manifest Child exactly once",
    );
  const folder = path.join(parentDir, "parallel");
  const activeFile = path.join(folder, "batch-active.json");
  fs.mkdirSync(folder, { recursive: true });
  if (fs.existsSync(activeFile)) {
    const active = JSON.parse(fs.readFileSync(activeFile, "utf8")) as {
      pid?: number;
    };
    if (alive(active.pid))
      throw new Error("A parallel batch is already active for this Parent");
    fs.rmSync(activeFile, { force: true });
  }
  const batchId = randomUUID();
  fs.writeFileSync(
    activeFile,
    JSON.stringify({ batch_id: batchId, pid: process.pid }),
    { flag: "wx", mode: 0o600 },
  );
  const eventFile = path.join(folder, "runs", `${batchId}.events.jsonl`);
  fs.mkdirSync(path.dirname(eventFile), { recursive: true });
  const event = (value: Record<string, unknown>): void =>
    fs.appendFileSync(
      eventFile,
      `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const running = new Map<string, Promise<void>>();
  const records: BatchResult["children"] = [];
  let maxActive = 0;
  try {
    event({
      type: "schedule_persisted",
      schedule_receipt_fingerprint: schedule.receipt.receiptFingerprint,
      schedule_receipt_file: schedule.receiptFile,
      schedule_advice_route: scheduleAdviceRoute,
      wave_count: scheduledWaves.length,
    });
    for (const wave of scheduledWaves) {
      event({
        type: "schedule_wave_started",
        sequence: wave.sequence,
        task_ids: wave.taskIds,
      });
      for (const child of wave.children) {
        const queueWaitMs = Math.round(performance.now() - started);
        const runStartedAt = new Date().toISOString();
        event({
          type: "child_started",
          task: child.task,
          queue_wait_ms: queueWaitMs,
          review_cost: child.reviewCost,
          scheduler_wave: wave.sequence,
        });
        const bridge = new PiTaskBridge(root, launch);
        const promise = (async (): Promise<void> => {
          let result: PiRunRecord | null = null;
          let reason: string | null = null;
          try {
            result = await bridge.run({
              root,
              task: child.task,
              role: "implement",
              prompt: child.prompt,
              timeoutMs: 30 * 60_000,
              scheduleReceiptFingerprint: schedule.receipt.receiptFingerprint,
            });
          } catch (error) {
            reason = error instanceof Error ? error.message : String(error);
          } finally {
            try {
              await bridge.close();
            } catch (error) {
              reason = `${reason ?? "Pi close failed"}; ${error instanceof Error ? error.message : String(error)}`;
            }
          }
          records.push({
            task: child.task,
            review_cost: child.reviewCost,
            queue_wait_ms: queueWaitMs,
            started_at: runStartedAt,
            ended_at: new Date().toISOString(),
            outcome: reason ? "failed" : (result?.outcome ?? "failed"),
            pi_run_id: result?.run_id ?? null,
            event_count: result?.event_count ?? 0,
            tool_errors: result?.tool_errors ?? 0,
            reason: result?.reason ?? reason,
          });
          event({
            type: "child_ended",
            task: child.task,
            outcome: reason ? "failed" : (result?.outcome ?? "failed"),
            pi_run_id: result?.run_id ?? null,
            event_count: result?.event_count ?? 0,
            tool_errors: result?.tool_errors ?? 0,
            scheduler_wave: wave.sequence,
          });
        })().finally(() => running.delete(child.task));
        running.set(child.task, promise);
      }
      maxActive = Math.max(maxActive, wave.children.length);
      await Promise.all([...running.values()]);
      event({ type: "schedule_wave_ended", sequence: wave.sequence });
    }
    const result: BatchResult = {
      schema_version: 2,
      batch_id: batchId,
      event_file: path.relative(parentDir, eventFile).replaceAll("\\", "/"),
      schedule_receipt_fingerprint: schedule.receipt.receiptFingerprint,
      schedule_receipt_file: schedule.receiptFile,
      schedule_advice_route: scheduleAdviceRoute,
      compatibility_limit_ignored:
        typeof manifest.limit === "number" &&
        Number.isSafeInteger(manifest.limit)
          ? manifest.limit
          : null,
      parent: path.basename(parentDir),
      integration_owner: "parent",
      merge_limit: 1,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      wall_ms: Math.round(performance.now() - started),
      queue_wait_total_ms: records.reduce(
        (sum, item) => sum + item.queue_wait_ms,
        0,
      ),
      max_active: maxActive,
      children: records.sort(
        (a, b) =>
          children.findIndex((item) => item.task === a.task) -
          children.findIndex((item) => item.task === b.task),
      ),
    };
    atomicJson(path.join(folder, "runs", `${batchId}.json`), result);
    atomicJson(path.join(folder, "latest.json"), result);
    return result;
  } catch (error) {
    await Promise.allSettled([...running.values()]);
    atomicJson(path.join(folder, "runs", `${batchId}.failure.json`), {
      schema_version: 1,
      batch_id: batchId,
      schedule_receipt_fingerprint: schedule.receipt.receiptFingerprint,
      schedule_receipt_file: schedule.receiptFile,
      schedule_advice_route: scheduleAdviceRoute,
      parent: path.basename(parentDir),
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      reason: error instanceof Error ? error.message : String(error),
      completed_children: records,
    });
    throw error;
  } finally {
    fs.rmSync(activeFile, { force: true });
  }
}

export function parallelStatus(
  root: string,
  parent: string,
): Record<string, unknown> {
  const parentDir = resolveTaskDir(root, parent);
  const { data: map, body } = readTaskMap(parentDir);
  if (!map) throw new Error("Parent task-map.md is required");
  const latestFile = path.join(parentDir, "parallel", "latest.json");
  const latest = fs.existsSync(latestFile)
    ? (JSON.parse(fs.readFileSync(latestFile, "utf8")) as BatchResult)
    : null;
  const activeFile = path.join(parentDir, "parallel", "batch-active.json");
  const active = fs.existsSync(activeFile)
    ? (JSON.parse(fs.readFileSync(activeFile, "utf8")) as {
        batch_id: string;
        pid: number;
      })
    : null;
  const eventFile = active
    ? path.join(
        parentDir,
        "parallel",
        "runs",
        `${active.batch_id}.events.jsonl`,
      )
    : null;
  const recentEvents =
    eventFile && fs.existsSync(eventFile)
      ? fs
          .readFileSync(eventFile, "utf8")
          .trim()
          .split(/\r?\n/)
          .slice(-100)
          .map((line) => JSON.parse(line) as unknown)
      : [];
  const integration = map.children.map((child) => ({
    task: child.id,
    state: child.state,
    ref: child.ref,
  }));
  const reworkOpened = new Map<string, number>();
  let recordedReworkEvents = 0;
  let recordedReworkMs = 0;
  for (const match of body.matchAll(
    /^- (\d{4}-\d\d-\d\dT[^ ]+) - (?:Parent integrated|Child reported) (\S+) as (changes|accepted|integrating|integrated)\./gm,
  )) {
    const [, at, child, state] = match;
    const time = Date.parse(at);
    if (!Number.isFinite(time)) continue;
    if (state === "changes") {
      recordedReworkEvents += 1;
      reworkOpened.set(child, time);
    } else if (reworkOpened.has(child)) {
      recordedReworkMs += Math.max(0, time - (reworkOpened.get(child) ?? time));
      reworkOpened.delete(child);
    }
  }
  return {
    parent: path.basename(parentDir),
    integration_owner: "parent",
    merge_limit: map.merge_limit,
    latest_batch: latest,
    active_batch:
      active && alive(active.pid)
        ? { batch_id: active.batch_id, recent_events: recentEvents }
        : null,
    integration,
    integration_complete:
      integration.length > 0 &&
      integration.every((child) => child.state === "integrated"),
    terminal_complete:
      integration.length > 0 &&
      integration.every(
        (child) => child.state === "integrated" || child.state === "cancelled",
      ),
    recorded_rework_events: recordedReworkEvents,
    recorded_rework_ms: recordedReworkMs,
    open_rework_events: reworkOpened.size,
  };
}
