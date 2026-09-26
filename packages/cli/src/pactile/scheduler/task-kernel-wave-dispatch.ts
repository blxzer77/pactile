import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  fingerprintTaskValue,
  projectTaskKernelLifecycle,
  readTaskKernel,
  type TaskRunV2,
} from "../../core/task/index.js";
import { resolveTaskDirectoryById } from "../../core/task/task-kernel-paths.js";
import { resolveTaskDir } from "../task/session.js";
import { inspectRunWorktree } from "../worktree/manager.js";
import { projectWriteSetsConflict } from "./project-lease-store.js";
import {
  planTaskKernelGraphV1,
  readTaskKernelScheduleReceiptV1,
  type TaskKernelScheduleDecisionReceiptV1,
} from "./task-map-scheduler.js";
import type { SchedulerCostVectorV1, TaskScheduleWaveV1 } from "./scheduler.js";

export type TaskKernelWaveRunOutcomeV1 =
  | "settled"
  | "needs_review"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export interface TaskKernelWaveRunRequestV1 {
  taskId: string;
  taskDir: string;
  runId: string;
  scheduleReceiptFingerprint: string;
  prompt: string;
  timeoutMs: number;
  signal: AbortSignal;
}

/** The provider must not claim a stop or release without native Host evidence. */
export interface TaskKernelWaveRunResultV1 {
  outcome: TaskKernelWaveRunOutcomeV1;
  scheduleReceiptFingerprint: string | null;
  admissionReceiptFingerprint: string | null;
  hostStopVerified: boolean;
  leaseReleased: boolean;
  evidenceRef: string | null;
  reason: string | null;
}

export type TaskKernelWaveRunnerV1 = (
  request: TaskKernelWaveRunRequestV1,
) => Promise<TaskKernelWaveRunResultV1>;

export interface TaskKernelWaveDispatchOptionsV1 {
  timeoutMs: number;
  runner: TaskKernelWaveRunnerV1;
  runnerLabel: string;
  signal?: AbortSignal;
  /** Execute tasks within each planned wave sequentially for a measured control run. */
  serialControl?: boolean;
}

export interface TaskKernelWaveIntegrationTaskV1 {
  taskId: string;
  runId: string | null;
  action: string;
  reasonCodes: string[];
  dependsOn: string[];
  writeSet: string[] | null;
  costs: {
    estimated: SchedulerCostVectorV1;
    estimateBasis: Record<keyof SchedulerCostVectorV1, string>;
    observed: Record<keyof SchedulerCostVectorV1, number | null>;
    observedEvidenceRefs: string[];
  } | null;
  worktree: null | {
    path: string;
    branch: string | null;
    baseSha: string;
    headSha: string | null;
  };
}

export interface TaskKernelWaveIntegrationWaveV1 {
  sequence: number;
  taskIds: string[];
  candidateTaskIds: string[];
  decision: TaskScheduleWaveV1["decision"];
  costEstimate: {
    source: "schedule-receipt-estimates";
    startedAfterMs: number;
    estimatedDurationMs: number;
    estimatedCompletionMs: number;
    serialEquivalentMs: number;
    estimatedSavingsMs: number;
    candidateSerialEquivalentMs: number;
    candidateParallelDurationMs: number;
    candidateEstimatedSavingsMs: number;
  };
  conflictAuthorizations: TaskScheduleWaveV1["conflictAuthorizations"];
  integration: {
    mode: "sequential-review" | "parallel-review";
    requiredBeforeTaskClose: string[];
  };
}

export interface TaskKernelWaveIntegrationPlanV1 {
  schemaVersion: 1;
  scheduleReceiptFingerprint: string;
  policy: "isolated-write-sets; review-and-integrate-before-dependent-runs";
  waves: TaskKernelWaveIntegrationWaveV1[];
  tasks: TaskKernelWaveIntegrationTaskV1[];
  blockers: { taskId: string; reasonCodes: string[] }[];
}

export interface TaskKernelWaveDispatchTaskResultV1 {
  taskId: string;
  runId: string | null;
  wave: number | null;
  status:
    | "provider-runs-settled"
    | "provider-run-failed"
    | "cancelled"
    | "blocked"
    | "host-stop-unverified"
    | "schedule-receipt-mismatch";
  outcome: TaskKernelWaveRunOutcomeV1 | null;
  admissionReceiptFingerprint: string | null;
  hostStopVerified: boolean;
  leaseReleased: boolean;
  evidenceRef: string | null;
  reasonCode: string | null;
  waitingMs: number | null;
  elapsedMs: number | null;
}

export interface TaskKernelWaveMeasurementV1 {
  source: "dispatch-wall-clock";
  mode: "serial-control" | "scheduled-waves";
  elapsedMs: number;
  waves: { sequence: number; taskIds: string[]; elapsedMs: number }[];
}

export interface TaskKernelWaveObservedCostTaskV1 {
  taskId: string;
  observedCosts: Record<keyof SchedulerCostVectorV1, number | null>;
  evidenceRefs: string[];
}

export interface TaskKernelWaveObservedCostLedgerV1 {
  source: "task-kernel-dispatch-and-parent-task-map";
  tasks: TaskKernelWaveObservedCostTaskV1[];
}

export interface TaskKernelWaveScenarioMeasurementV1 {
  dispatch: TaskKernelWaveDispatchResultV1;
  /** Wall clock from planning through provider stop, Review, rework and integration observation. */
  endToEndElapsedMs: number;
  conditions: TaskKernelWaveComparisonConditionsV1;
  lifecycleCosts: TaskKernelWaveObservedCostLedgerV1;
}

export interface TaskKernelWaveComparisonConditionsV1 {
  worktreeBaseCommitSha: string;
  runInputsSha256: string;
  promptsSha256: string;
  providerConfigSha256: string;
}

export interface TaskKernelWaveDispatchCostTotalV1 {
  totalMs: number | null;
  observedTaskCount: number;
  candidateTaskCount: number;
  evidenceRefs: string[];
}

export interface TaskKernelWaveDispatchComparisonV1 {
  schemaVersion: 1;
  source: "paired-controlled-dispatch-wall-clock";
  workloadFingerprint: string;
  taskIds: string[];
  estimates: {
    serialEquivalentMs: number;
    plannedWavesMs: number;
    estimatedSavingsMs: number;
    taskCostTotals: SchedulerCostVectorV1;
  };
  conditions: TaskKernelWaveComparisonConditionsV1 & {
    fingerprint: string;
  };
  measured: {
    serialControlDispatchMs: number;
    scheduledWavesDispatchMs: number;
    dispatchSavingsMs: number;
    serialControlEndToEndMs: number;
    scheduledWavesEndToEndMs: number;
    endToEndSavingsMs: number;
    endToEndSavingsRatio: number | null;
  };
  observedLifecycleCosts: {
    source: "task-kernel-dispatch-and-parent-task-map";
    serialControl: Record<
      keyof SchedulerCostVectorV1,
      TaskKernelWaveDispatchCostTotalV1
    >;
    scheduledWaves: Record<
      keyof SchedulerCostVectorV1,
      TaskKernelWaveDispatchCostTotalV1
    >;
  };
}

export interface TaskKernelWaveDispatchResultV1 {
  schemaVersion: 1;
  dispatchId: string;
  runnerLabel: string;
  scheduleReceiptFingerprint: string;
  status:
    | "provider-runs-complete"
    | "partial"
    | "blocked"
    | "cancelled"
    | "no-work";
  kernelRunSettlement: "not-performed";
  integrationPlan: TaskKernelWaveIntegrationPlanV1;
  tasks: TaskKernelWaveDispatchTaskResultV1[];
  measurements: TaskKernelWaveMeasurementV1;
}

interface PreparedTask {
  taskId: string;
  taskDir: string;
  runId: string | null;
  kernelRevision: number | null;
  action: string;
  reasonCodes: string[];
  dependsOn: string[];
  writeSet: string[] | null;
  workspace: TaskRunV2["workspace"] | null;
  costs: TaskKernelWaveIntegrationTaskV1["costs"];
  worktree: TaskKernelWaveIntegrationTaskV1["worktree"];
  queuedAtMs: number | null;
  blockedReason: string | null;
}

interface TaskKernelWaveRunCallResultV1 {
  task: PreparedTask;
  result: TaskKernelWaveRunResultV1 | null;
  error: unknown | null;
  waitingMs: number | null;
  elapsedMs: number;
}

interface TaskKernelWaveDispatchWorkloadShapeV1 {
  taskIds: string[];
  policy: TaskKernelWaveIntegrationPlanV1["policy"];
  tasks: {
    taskId: string;
    action: string;
    reasonCodes: string[];
    dependsOn: string[];
    writeSet: string[] | null;
    estimated: SchedulerCostVectorV1 | null;
    estimateBasis: Record<keyof SchedulerCostVectorV1, string> | null;
  }[];
  waves: {
    sequence: number;
    taskIds: string[];
    candidateTaskIds: string[];
    decision: TaskScheduleWaveV1["decision"];
    conflictAuthorizations: {
      taskIds: string[];
      approvedBy: string;
      authorizationRef: string;
      integrationOwner: string;
      integrationPlan: string;
    }[];
  }[];
  blockers: TaskKernelWaveIntegrationPlanV1["blockers"];
}

function stableEqual(left: unknown, right: unknown): boolean {
  return fingerprintTaskValue(left) === fingerprintTaskValue(right);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function dispatchWorkloadShape(
  dispatch: TaskKernelWaveDispatchResultV1,
): TaskKernelWaveDispatchWorkloadShapeV1 {
  return {
    taskIds: [...dispatch.integrationPlan.tasks]
      .filter((task) => task.action === "scheduled")
      .map((task) => task.taskId)
      .sort(compareText),
    policy: dispatch.integrationPlan.policy,
    tasks: [...dispatch.integrationPlan.tasks]
      .filter((task) => task.action === "scheduled")
      .map((task) => ({
        taskId: task.taskId,
        action: task.action,
        reasonCodes: [...task.reasonCodes].sort(compareText),
        dependsOn: [...task.dependsOn].sort(compareText),
        writeSet: task.writeSet ? [...task.writeSet].sort(compareText) : null,
        estimated: task.costs ? { ...task.costs.estimated } : null,
        estimateBasis: task.costs ? { ...task.costs.estimateBasis } : null,
      }))
      .sort((left, right) => compareText(left.taskId, right.taskId)),
    waves: dispatch.integrationPlan.waves.map((wave) => ({
      sequence: wave.sequence,
      taskIds: [...wave.taskIds].sort(compareText),
      candidateTaskIds: [...wave.candidateTaskIds].sort(compareText),
      decision: wave.decision,
      conflictAuthorizations: wave.conflictAuthorizations
        .map((authorization) => ({
          taskIds: [...authorization.taskIds].sort(compareText),
          approvedBy: authorization.approvedBy,
          authorizationRef: authorization.authorizationRef,
          integrationOwner: authorization.integrationOwner,
          integrationPlan: authorization.integrationPlan,
        }))
        .sort((left, right) =>
          compareText(left.taskIds.join("\0"), right.taskIds.join("\0")),
        ),
    })),
    blockers: [...dispatch.integrationPlan.blockers]
      .map((blocker) => ({
        taskId: blocker.taskId,
        reasonCodes: [...blocker.reasonCodes].sort(compareText),
      }))
      .sort((left, right) => compareText(left.taskId, right.taskId)),
  };
}

function checkedDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${label} must be a finite non-negative duration`);
  return Math.round(value);
}

function scenarioCandidateIds(
  dispatch: TaskKernelWaveDispatchResultV1,
): string[] {
  return dispatch.integrationPlan.tasks
    .filter((task) => task.action === "scheduled")
    .map((task) => task.taskId)
    .sort(compareText);
}

function measuredScenarioLedger(
  scenario: TaskKernelWaveScenarioMeasurementV1,
  candidateTaskIds: readonly string[],
): TaskKernelWaveObservedCostLedgerV1 {
  if (
    scenario.lifecycleCosts.source !==
    "task-kernel-dispatch-and-parent-task-map"
  )
    throw new Error("Observed lifecycle costs have an unsupported source");
  const lifecycleByTask = new Map(
    scenario.lifecycleCosts.tasks.map((task) => [task.taskId, task]),
  );
  const dispatchByTask = new Map(
    scenario.dispatch.tasks.map((task) => [task.taskId, task]),
  );
  const candidateSet = new Set(candidateTaskIds);
  if (
    lifecycleByTask.size !== scenario.lifecycleCosts.tasks.length ||
    scenario.lifecycleCosts.tasks.some(
      (task) => !candidateSet.has(task.taskId),
    ) ||
    lifecycleByTask.size !== candidateSet.size
  )
    throw new Error(
      "Observed lifecycle cost ledger task set does not match the candidate set",
    );
  return {
    source: "task-kernel-dispatch-and-parent-task-map",
    tasks: candidateTaskIds.map((taskId) => {
      const observed = lifecycleByTask.get(taskId);
      const dispatch = dispatchByTask.get(taskId);
      if (!observed || !dispatch)
        throw new Error(`Measured costs are missing for ${taskId}`);
      if (
        dispatch.status !== "provider-runs-settled" ||
        !dispatch.evidenceRef ||
        dispatch.waitingMs === null ||
        dispatch.elapsedMs === null
      )
        throw new Error(`Verified dispatch timings are missing for ${taskId}`);
      return {
        taskId,
        observedCosts: {
          ...observed.observedCosts,
          waitingMs: checkedDuration(dispatch.waitingMs, `${taskId}.waitingMs`),
          executionMs: checkedDuration(
            dispatch.elapsedMs,
            `${taskId}.executionMs`,
          ),
        },
        evidenceRefs: [
          ...new Set([...observed.evidenceRefs, dispatch.evidenceRef]),
        ].sort(compareText),
      };
    }),
  };
}

function validateComparisonConditions(
  conditions: TaskKernelWaveComparisonConditionsV1,
  label: string,
): void {
  if (
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(
      conditions.worktreeBaseCommitSha,
    )
  )
    throw new Error(`${label} worktree base must be a full Git commit SHA`);
  for (const field of [
    "runInputsSha256",
    "promptsSha256",
    "providerConfigSha256",
  ] as const) {
    if (!/^[a-f0-9]{64}$/u.test(conditions[field]))
      throw new Error(`${label} ${field} must be a SHA-256 digest`);
  }
}

function summarizeObservedCosts(
  ledger: TaskKernelWaveObservedCostLedgerV1,
  candidateTaskIds: readonly string[],
): Record<keyof SchedulerCostVectorV1, TaskKernelWaveDispatchCostTotalV1> {
  if (ledger.source !== "task-kernel-dispatch-and-parent-task-map")
    throw new Error("Observed lifecycle costs have an unsupported source");
  const candidateIds = new Set(candidateTaskIds);
  const fields: (keyof SchedulerCostVectorV1)[] = [
    "latencyMs",
    "waitingMs",
    "executionMs",
    "integrationMs",
    "reworkMs",
    "reviewMs",
  ];
  const seen = new Set<string>();
  for (const task of ledger.tasks) {
    if (!candidateIds.has(task.taskId) || seen.has(task.taskId))
      throw new Error(
        "Observed lifecycle cost ledger task set does not match the candidate set",
      );
    seen.add(task.taskId);
    if (
      !Array.isArray(task.evidenceRefs) ||
      !task.evidenceRefs.length ||
      task.evidenceRefs.some((ref) => typeof ref !== "string" || !ref.trim())
    )
      throw new Error(
        `Observed lifecycle cost evidence is missing for ${task.taskId}`,
      );
    if (
      !task.observedCosts ||
      fields.some((field) => !(field in task.observedCosts))
    )
      throw new Error(
        `Observed lifecycle cost fields are incomplete for ${task.taskId}`,
      );
    for (const field of fields) {
      const value = task.observedCosts[field];
      if (value !== null) checkedDuration(value, `${task.taskId}.${field}`);
    }
  }
  if (seen.size !== candidateIds.size)
    throw new Error(
      "Observed lifecycle cost ledger does not cover every scheduled candidate",
    );

  return Object.fromEntries(
    fields.map((field) => {
      const measured = ledger.tasks.filter(
        (task) => task.observedCosts[field] !== null,
      );
      return [
        field,
        {
          totalMs:
            measured.length === candidateIds.size
              ? measured.reduce(
                  (sum, task) => sum + (task.observedCosts[field] ?? 0),
                  0,
                )
              : null,
          observedTaskCount: measured.length,
          candidateTaskCount: candidateIds.size,
          evidenceRefs: [
            ...new Set(measured.flatMap((task) => task.evidenceRefs)),
          ].sort(compareText),
        },
      ];
    }),
  ) as Record<keyof SchedulerCostVectorV1, TaskKernelWaveDispatchCostTotalV1>;
}

/** Compare paired, same-workload measurements; estimates and observations stay separate. */
export function compareTaskKernelWaveDispatchV1(
  serialControl: TaskKernelWaveScenarioMeasurementV1,
  scheduledWaves: TaskKernelWaveScenarioMeasurementV1,
): TaskKernelWaveDispatchComparisonV1 {
  if (serialControl.dispatch.measurements.mode !== "serial-control")
    throw new Error("First scenario must be a serial-control dispatch");
  if (scheduledWaves.dispatch.measurements.mode !== "scheduled-waves")
    throw new Error("Second scenario must be a scheduled-waves dispatch");
  for (const [label, scenario] of [
    ["serial-control", serialControl],
    ["scheduled-waves", scheduledWaves],
  ] as const) {
    if (scenario.dispatch.status !== "provider-runs-complete")
      throw new Error(
        `${label} scenario did not complete every scheduled provider Run`,
      );
    checkedDuration(
      scenario.dispatch.measurements.elapsedMs,
      `${label} dispatch elapsedMs`,
    );
    checkedDuration(
      scenario.endToEndElapsedMs,
      `${label} end-to-end elapsedMs`,
    );
    if (scenario.endToEndElapsedMs < scenario.dispatch.measurements.elapsedMs)
      throw new Error(
        `${label} end-to-end time cannot be shorter than dispatch time`,
      );
  }
  validateComparisonConditions(serialControl.conditions, "serial-control");
  validateComparisonConditions(scheduledWaves.conditions, "scheduled-waves");
  const mismatchedConditions = (
    [
      "worktreeBaseCommitSha",
      "runInputsSha256",
      "promptsSha256",
      "providerConfigSha256",
    ] as const
  ).filter(
    (field) =>
      serialControl.conditions[field] !== scheduledWaves.conditions[field],
  );
  if (mismatchedConditions.length)
    throw new Error(
      `Paired scenarios differ in worktree base, Run inputs, prompts, or provider configuration: ${mismatchedConditions.map((field) => `${field} serial=${serialControl.conditions[field]} scheduled=${scheduledWaves.conditions[field]}`).join(", ")}`,
    );
  const serialShape = dispatchWorkloadShape(serialControl.dispatch);
  const waveShape = dispatchWorkloadShape(scheduledWaves.dispatch);
  if (!stableEqual(serialShape, waveShape))
    throw new Error(
      "Paired dispatch scenarios do not have the same scheduled workload and wave plan",
    );
  const taskIds = scenarioCandidateIds(serialControl.dispatch);
  if (!taskIds.length)
    throw new Error(
      "Paired dispatch scenarios require at least one scheduled candidate",
    );
  const scheduledTaskIds = scenarioCandidateIds(scheduledWaves.dispatch);
  const serialTaskResults = new Map(
    serialControl.dispatch.tasks.map((task) => [task.taskId, task]),
  );
  const waveTaskResults = new Map(
    scheduledWaves.dispatch.tasks.map((task) => [task.taskId, task]),
  );
  for (const taskId of taskIds) {
    if (serialTaskResults.get(taskId)?.status !== "provider-runs-settled")
      throw new Error(
        `Serial-control candidate ${taskId} has no settled provider Run`,
      );
    if (waveTaskResults.get(taskId)?.status !== "provider-runs-settled")
      throw new Error(
        `Scheduled-wave candidate ${taskId} has no settled provider Run`,
      );
  }

  const scheduledTasks = serialControl.dispatch.integrationPlan.tasks.filter(
    (task) => task.action === "scheduled",
  );
  const estimateFields = [
    "latencyMs",
    "waitingMs",
    "executionMs",
    "integrationMs",
    "reworkMs",
    "reviewMs",
  ] as const;
  const estimates = estimateFields.reduce<SchedulerCostVectorV1>(
    (totals, field) => {
      totals[field] = scheduledTasks.reduce((sum, task) => {
        const value = task.costs?.estimated[field];
        if (typeof value !== "number")
          throw new Error(`Estimated ${field} is missing for ${task.taskId}`);
        return (
          sum + checkedDuration(value, `${task.taskId}.estimated.${field}`)
        );
      }, 0);
      return totals;
    },
    {
      latencyMs: 0,
      waitingMs: 0,
      executionMs: 0,
      integrationMs: 0,
      reworkMs: 0,
      reviewMs: 0,
    },
  );
  const serialEquivalentMs =
    serialControl.dispatch.integrationPlan.waves.reduce(
      (sum, wave) => sum + wave.costEstimate.candidateSerialEquivalentMs,
      0,
    );
  const plannedWavesMs = scheduledWaves.dispatch.integrationPlan.waves.reduce(
    (sum, wave) => sum + wave.costEstimate.candidateParallelDurationMs,
    0,
  );
  const serialControlDispatchMs = Math.round(
    serialControl.dispatch.measurements.elapsedMs,
  );
  const scheduledWavesDispatchMs = Math.round(
    scheduledWaves.dispatch.measurements.elapsedMs,
  );
  const serialControlEndToEndMs = checkedDuration(
    serialControl.endToEndElapsedMs,
    "serial-control end-to-end elapsedMs",
  );
  const scheduledWavesEndToEndMs = checkedDuration(
    scheduledWaves.endToEndElapsedMs,
    "scheduled-waves end-to-end elapsedMs",
  );
  const endToEndSavingsMs = serialControlEndToEndMs - scheduledWavesEndToEndMs;
  return {
    schemaVersion: 1,
    source: "paired-controlled-dispatch-wall-clock",
    workloadFingerprint: fingerprintTaskValue(serialShape),
    taskIds,
    estimates: {
      serialEquivalentMs,
      plannedWavesMs,
      estimatedSavingsMs: serialEquivalentMs - plannedWavesMs,
      taskCostTotals: estimates,
    },
    conditions: {
      ...serialControl.conditions,
      fingerprint: fingerprintTaskValue(serialControl.conditions),
    },
    measured: {
      serialControlDispatchMs,
      scheduledWavesDispatchMs,
      dispatchSavingsMs: serialControlDispatchMs - scheduledWavesDispatchMs,
      serialControlEndToEndMs,
      scheduledWavesEndToEndMs,
      endToEndSavingsMs,
      endToEndSavingsRatio:
        serialControlEndToEndMs === 0
          ? null
          : endToEndSavingsMs / serialControlEndToEndMs,
    },
    observedLifecycleCosts: {
      source: "task-kernel-dispatch-and-parent-task-map",
      serialControl: summarizeObservedCosts(
        measuredScenarioLedger(serialControl, taskIds),
        taskIds,
      ),
      scheduledWaves: summarizeObservedCosts(
        measuredScenarioLedger(scheduledWaves, scheduledTaskIds),
        scheduledTaskIds,
      ),
    },
  };
}

function plannedOptions(
  receipt: TaskKernelScheduleDecisionReceiptV1,
): NonNullable<Parameters<typeof planTaskKernelGraphV1>[2]> {
  const candidates = new Set(receipt.candidateTaskIds);
  const estimatedCosts: Record<
    string,
    Partial<
      TaskKernelScheduleDecisionReceiptV1["request"]["tasks"][number]["estimatedCosts"]
    >
  > = {};
  for (const task of receipt.request.tasks) {
    if (candidates.has(task.taskId))
      estimatedCosts[task.taskId] = { ...task.estimatedCosts };
  }
  return {
    estimatedCosts,
    ...(receipt.request.conflictParallelizations
      ? { conflictParallelizations: receipt.request.conflictParallelizations }
      : {}),
    ...(receipt.request.jevAdvice
      ? { jevAdvice: receipt.request.jevAdvice }
      : {}),
  };
}

/** Recomputes the complete DAG snapshot before the first provider can start. */
function assertScheduleReceiptFresh(
  root: string,
  receipt: TaskKernelScheduleDecisionReceiptV1,
): void {
  let current: ReturnType<typeof planTaskKernelGraphV1>;
  try {
    current = planTaskKernelGraphV1(
      root,
      receipt.candidateTaskIds,
      plannedOptions(receipt),
    );
  } catch (error) {
    throw new Error(
      "Task schedule receipt is stale or no longer schedulable: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const expected = {
    candidateTaskIds: receipt.candidateTaskIds,
    taskKernelRevisions: receipt.taskKernelRevisions,
    request: receipt.request,
    plan: receipt.plan,
  };
  const observed = {
    candidateTaskIds: current.candidateTaskIds,
    taskKernelRevisions: current.taskKernelRevisions,
    request: current.request,
    plan: current.plan,
  };
  if (!stableEqual(expected, observed))
    throw new Error(
      "Task schedule receipt is stale; create a new schedule plan",
    );
}

function normalizedWriteSet(run: TaskRunV2): string[] | null {
  const binding = run.workspace;
  if (!binding) return null;
  return [...new Set([...run.writeSetSnapshot, ...binding.writeSet])].sort(
    (left, right) => (left < right ? -1 : left > right ? 1 : 0),
  );
}

function inspectTask(
  root: string,
  receipt: TaskKernelScheduleDecisionReceiptV1,
  taskId: string,
): PreparedTask {
  const decision = receipt.plan.decisions.find(
    (candidate) => candidate.taskId === taskId,
  );
  const lifecycle = receipt.lifecycle.find(
    (candidate) => candidate.taskId === taskId,
  );
  const taskDir = resolveTaskDir(root, taskId);
  const defaults: PreparedTask = {
    taskId,
    taskDir,
    runId: lifecycle?.runId ?? null,
    kernelRevision: lifecycle?.kernelRevision ?? null,
    action: decision?.action ?? "missing-plan-decision",
    reasonCodes: decision
      ? [...decision.reasonCodes]
      : ["missing-plan-decision"],
    dependsOn: lifecycle ? [...lifecycle.dependencyTaskIds] : [],
    writeSet: lifecycle?.writeSet ? [...lifecycle.writeSet] : null,
    costs: lifecycle
      ? {
          estimated: { ...lifecycle.estimatedCosts },
          estimateBasis: { ...lifecycle.estimateBasis },
          observed: { ...lifecycle.observedCosts },
          observedEvidenceRefs: [...lifecycle.observedCostEvidenceRefs],
        }
      : null,
    workspace: null,
    worktree: null,
    queuedAtMs: null,
    blockedReason: null,
  };
  if (!decision || !lifecycle) {
    defaults.blockedReason = "task-missing-from-schedule-receipt";
    return defaults;
  }
  if (decision.action !== "scheduled") {
    if (decision.action !== "completed")
      defaults.blockedReason = "task-not-scheduled:" + decision.action;
    return defaults;
  }
  if (!lifecycle.runId) {
    defaults.blockedReason = "task-run-missing";
    return defaults;
  }

  let kernel;
  try {
    const read = readTaskKernel({ root, taskDir, cwd: root });
    if (read.kind !== "task-kernel-v2") {
      defaults.blockedReason = "task-kernel-v2-required";
      return defaults;
    }
    kernel = read.kernel;
  } catch (error) {
    defaults.blockedReason =
      error instanceof Error ? error.message : String(error);
    return defaults;
  }
  const run = kernel.runs.find((candidate) => candidate.id === lifecycle.runId);
  if (run?.taskId !== taskId) {
    defaults.blockedReason = "task-run-identity-mismatch";
    return defaults;
  }
  const queuedAt = kernel.events.find(
    (event) => event.entityId === run.id && event.type === "run.queued",
  )?.at;
  const queuedAtMs = queuedAt ? Date.parse(queuedAt) : Number.NaN;
  defaults.queuedAtMs = Number.isFinite(queuedAtMs) ? queuedAtMs : null;
  if (
    kernel.revision !== receipt.taskKernelRevisions[taskId] ||
    kernel.revision !== lifecycle.kernelRevision
  ) {
    defaults.blockedReason = "task-kernel-revision-changed";
    return defaults;
  }
  if (run.state !== "waiting" && run.state !== "running") {
    defaults.blockedReason = "task-run-not-dispatchable:" + run.state;
    return defaults;
  }
  if (run.host) {
    defaults.blockedReason = "task-run-already-host-bound";
    return defaults;
  }
  if (run.candidateSnapshot) {
    defaults.blockedReason = "task-run-candidate-snapshot-exists";
    return defaults;
  }
  if (!run.workspace?.manager || run.workspace.ownerRunId !== run.id) {
    defaults.blockedReason = "p38-managed-run-worktree-required";
    return defaults;
  }
  const runWriteSet = [...run.writeSetSnapshot].sort();
  const workspaceWriteSet = [...run.workspace.writeSet].sort();
  if (!stableEqual(runWriteSet, workspaceWriteSet)) {
    defaults.blockedReason = "run-worktree-write-set-mismatch";
    return defaults;
  }
  let inspection;
  try {
    inspection = inspectRunWorktree({
      repoRoot: root,
      runId: run.id,
      runState: run.state,
      binding: run.workspace,
      knownOwners: [],
    });
  } catch (error) {
    defaults.blockedReason =
      "run-worktree-inspection-failed:" +
      (error instanceof Error ? error.message : String(error));
    return defaults;
  }
  const invalidIssues = inspection.issues.filter(
    (issue) => issue !== "unintegrated",
  );
  if (
    invalidIssues.length ||
    inspection.state !== "unintegrated" ||
    inspection.dirty ||
    inspection.headSha?.toLowerCase() !== run.workspace.baseSha.toLowerCase() ||
    !inspection.actualPath
  ) {
    defaults.blockedReason =
      "run-worktree-not-a-clean-manager-verified-base:" +
      (invalidIssues.join(",") || inspection.state);
    return defaults;
  }
  defaults.workspace = run.workspace;
  defaults.writeSet = normalizedWriteSet(run);
  defaults.worktree = {
    path: inspection.actualPath,
    branch: inspection.branch,
    baseSha: inspection.baseSha,
    headSha: inspection.headSha,
  };
  return defaults;
}

function hardDependenciesClosed(root: string, task: PreparedTask): string[] {
  const blockers: string[] = [];
  for (const dependencyId of task.dependsOn) {
    try {
      const dependencyDir = resolveTaskDirectoryById(root, dependencyId);
      if (!dependencyDir) {
        blockers.push("hard-dependency-missing-or-invalid:" + dependencyId);
        continue;
      }
      const read = readTaskKernel({ root, taskDir: dependencyDir, cwd: root });
      if (read.kind !== "task-kernel-v2") {
        blockers.push("hard-dependency-not-v2-closed:" + dependencyId);
        continue;
      }
      const lifecycle = projectTaskKernelLifecycle(read.kernel);
      if (!lifecycle.closed || lifecycle.outcome !== "completed")
        blockers.push("hard-dependency-not-closed:" + dependencyId);
    } catch {
      blockers.push("hard-dependency-missing-or-invalid:" + dependencyId);
    }
  }
  return blockers;
}

function buildIntegrationPlan(
  root: string,
  receipt: TaskKernelScheduleDecisionReceiptV1,
): {
  plan: TaskKernelWaveIntegrationPlanV1;
  prepared: Map<string, PreparedTask>;
} {
  const prepared = new Map<string, PreparedTask>();
  for (const taskId of receipt.candidateTaskIds)
    prepared.set(taskId, inspectTask(root, receipt, taskId));
  const initialBlockers = [...prepared.values()]
    .filter((task) => task.blockedReason)
    .map((task) => ({
      taskId: task.taskId,
      reasonCodes: [task.blockedReason as string],
    }));
  const waves: TaskKernelWaveIntegrationWaveV1[] = receipt.plan.waves.map(
    (wave) => ({
      sequence: wave.sequence,
      taskIds: [...wave.taskIds],
      candidateTaskIds: [...wave.candidateTaskIds],
      decision: wave.decision,
      costEstimate: {
        source: "schedule-receipt-estimates",
        startedAfterMs: wave.startedAfterMs,
        estimatedDurationMs: wave.estimatedDurationMs,
        estimatedCompletionMs: wave.estimatedCompletionMs,
        serialEquivalentMs: wave.serialEquivalentMs,
        estimatedSavingsMs: wave.estimatedSavingsMs,
        candidateSerialEquivalentMs: wave.candidateSerialEquivalentMs,
        candidateParallelDurationMs: wave.candidateParallelDurationMs,
        candidateEstimatedSavingsMs: wave.candidateEstimatedSavingsMs,
      },
      conflictAuthorizations: [...wave.conflictAuthorizations],
      integration: {
        mode:
          wave.decision === "parallel-time-saved"
            ? "parallel-review"
            : "sequential-review",
        requiredBeforeTaskClose: [
          "review-each-isolated-Task-Run-result",
          "verify-Task-Run write set and acceptance evidence",
          "integrate only after all required reviewers accept",
        ],
      },
    }),
  );
  const overlapBlockers: { taskId: string; reasonCodes: string[] }[] = [];
  for (const wave of receipt.plan.waves) {
    const waveTasks = wave.taskIds
      .map((taskId) => prepared.get(taskId))
      .filter((task): task is PreparedTask => !!task);
    for (let left = 0; left < waveTasks.length; left += 1) {
      for (let right = left + 1; right < waveTasks.length; right += 1) {
        const first = waveTasks[left];
        const second = waveTasks[right];
        if (
          !first ||
          !second ||
          !projectWriteSetsConflict(first.writeSet ?? [], second.writeSet ?? [])
        )
          continue;
        const authorization = wave.conflictAuthorizations.find(
          (candidate) =>
            candidate.taskIds.includes(first.taskId) &&
            candidate.taskIds.includes(second.taskId),
        );
        if (!authorization) {
          const taskId = second?.taskId ?? first?.taskId ?? "unknown";
          const item = prepared.get(taskId);
          if (item)
            item.blockedReason = "write-set-overlap-without-authorization";
          overlapBlockers.push({
            taskId,
            reasonCodes: ["write-set-overlap-without-authorization"],
          });
        }
      }
    }
  }
  const tasks = [...prepared.values()];
  return {
    prepared,
    plan: {
      schemaVersion: 1,
      scheduleReceiptFingerprint: receipt.receiptFingerprint,
      policy: "isolated-write-sets; review-and-integrate-before-dependent-runs",
      waves,
      tasks: tasks.map((task) => ({
        taskId: task.taskId,
        runId: task.runId,
        action: task.action,
        reasonCodes: task.reasonCodes,
        dependsOn: task.dependsOn,
        writeSet: task.writeSet,
        costs: task.costs,
        worktree: task.worktree,
      })),
      blockers: [
        ...new Map(
          [...initialBlockers, ...overlapBlockers].map((blocker) => [
            blocker.taskId,
            blocker,
          ]),
        ).values(),
      ],
    },
  };
}

function taskPrompt(
  receipt: TaskKernelScheduleDecisionReceiptV1,
  taskId: string,
): string {
  const lifecycle = receipt.lifecycle.find(
    (candidate) => candidate.taskId === taskId,
  );
  return [
    "Implement only Pactile Task " + taskId + ".",
    "Read the Task definition, acceptance criteria, and approved implement contract in its own Task directory.",
    "Work only inside the Task Run's manager-verified isolated worktree and declared write set.",
    "Do not integrate branches or mutate Pactile Task Kernel state.",
    "Report files changed, evidence for each acceptance criterion, and any blocker.",
    lifecycle
      ? "Schedule snapshot phase: " + lifecycle.lifecyclePhase + "."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function taskResult(
  task: PreparedTask,
  wave: number | null,
  status: TaskKernelWaveDispatchTaskResultV1["status"],
  reasonCode: string | null,
  result?: TaskKernelWaveRunResultV1,
): TaskKernelWaveDispatchTaskResultV1 {
  return {
    taskId: task.taskId,
    runId: task.runId,
    wave,
    status,
    outcome: result?.outcome ?? null,
    admissionReceiptFingerprint: result?.admissionReceiptFingerprint ?? null,
    hostStopVerified: result?.hostStopVerified ?? false,
    leaseReleased: result?.leaseReleased ?? false,
    evidenceRef: result?.evidenceRef ?? null,
    reasonCode,
    waitingMs: null,
    elapsedMs: null,
  };
}

function statusFor(
  result: TaskKernelWaveRunResultV1,
  expectedFingerprint: string,
  verified: {
    verified: boolean;
    outcome: string | null;
    scheduleReceiptFingerprint: string | null;
    admissionReceiptFingerprint: string | null;
    hostStopVerified: boolean;
    leaseReleased: boolean;
    evidenceRef: string | null;
    reasonCode: string | null;
  },
): TaskKernelWaveDispatchTaskResultV1["status"] {
  if (result.scheduleReceiptFingerprint !== expectedFingerprint)
    return "schedule-receipt-mismatch";
  if (
    !verified.verified ||
    verified.scheduleReceiptFingerprint !== expectedFingerprint ||
    !verified.hostStopVerified ||
    !verified.leaseReleased ||
    result.hostStopVerified !== true ||
    result.leaseReleased !== true ||
    !result.admissionReceiptFingerprint ||
    result.admissionReceiptFingerprint !==
      verified.admissionReceiptFingerprint ||
    !result.evidenceRef ||
    result.evidenceRef !== verified.evidenceRef ||
    result.outcome !== verified.outcome
  )
    return "host-stop-unverified";
  if (verified.outcome === "settled") return "provider-runs-settled";
  if (verified.outcome === "cancelled") return "cancelled";
  return "provider-run-failed";
}

/**
 * Consumes one persisted Task Kernel schedule receipt and dispatches only
 * currently eligible writer Runs. Per-Task admission remains the provider's
 * responsibility and receives the exact persisted fingerprint.
 */
export async function dispatchTaskKernelWaveV1(
  rootValue: string,
  fingerprint: string,
  options: TaskKernelWaveDispatchOptionsV1,
): Promise<TaskKernelWaveDispatchResultV1> {
  const root = path.resolve(rootValue);
  if (!/^[a-f0-9]{64}$/u.test(fingerprint))
    throw new Error(
      "Task schedule dispatch requires a lowercase SHA-256 fingerprint",
    );
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1_000 ||
    options.timeoutMs > 86_400_000
  )
    throw new Error("Task schedule timeout must be 1 second to 24 hours");
  if (typeof options.runner !== "function")
    throw new Error("Task schedule dispatch requires a Pi run provider");
  if (!options.runnerLabel.trim())
    throw new Error("Task schedule dispatch requires a runner label");

  const dispatchStartedAt = performance.now();
  const loaded = readTaskKernelScheduleReceiptV1(root, fingerprint);
  const receipt = loaded.receipt;
  if (
    loaded.integrity !== "fingerprint-verified" ||
    receipt.integrityVersion !== 2
  )
    throw new Error(
      "Task schedule dispatch requires a fully fingerprint-verified receipt",
    );
  assertScheduleReceiptFresh(root, receipt);

  const { plan, prepared } = buildIntegrationPlan(root, receipt);
  const dispatchId = randomUUID();
  const tasks: TaskKernelWaveDispatchTaskResultV1[] = plan.blockers.map(
    (blocker) => {
      const task = prepared.get(blocker.taskId);
      if (!task) {
        return {
          taskId: blocker.taskId,
          runId: null,
          wave: null,
          status: "blocked",
          outcome: null,
          admissionReceiptFingerprint: null,
          hostStopVerified: false,
          leaseReleased: false,
          evidenceRef: null,
          reasonCode: blocker.reasonCodes.join(","),
          waitingMs: null,
          elapsedMs: null,
        };
      }
      return taskResult(task, null, "blocked", blocker.reasonCodes.join(","));
    },
  );
  const scheduled = receipt.plan.decisions.filter(
    (decision) => decision.action === "scheduled",
  );
  if (!scheduled.length) {
    return {
      schemaVersion: 1,
      dispatchId,
      runnerLabel: options.runnerLabel,
      scheduleReceiptFingerprint: fingerprint,
      status: tasks.length ? "blocked" : "no-work",
      kernelRunSettlement: "not-performed",
      integrationPlan: plan,
      tasks,
      measurements: {
        source: "dispatch-wall-clock",
        mode: options.serialControl ? "serial-control" : "scheduled-waves",
        elapsedMs: Math.max(
          0,
          Math.round(performance.now() - dispatchStartedAt),
        ),
        waves: [],
      },
    };
  }

  const signal = options.signal ?? new AbortController().signal;
  let stopLaterWaves = signal.aborted;
  const waveMeasurements: TaskKernelWaveMeasurementV1["waves"] = [];
  for (const wave of receipt.plan.waves) {
    const waveTasks: PreparedTask[] = [];
    for (const taskId of wave.taskIds) {
      const task = prepared.get(taskId);
      if (!task || task.blockedReason) continue;
      if (signal.aborted) {
        tasks.push(
          taskResult(
            task,
            wave.sequence,
            "cancelled",
            "dispatch-cancelled-before-start",
          ),
        );
        continue;
      }
      const liveBlockers = hardDependenciesClosed(root, task);
      if (liveBlockers.length) {
        tasks.push(
          taskResult(task, wave.sequence, "blocked", liveBlockers.join(",")),
        );
        continue;
      }
      try {
        const read = readTaskKernel({ root, taskDir: task.taskDir, cwd: root });
        if (
          read.kind !== "task-kernel-v2" ||
          read.kernel.revision !== receipt.taskKernelRevisions[task.taskId] ||
          read.kernel.identity.taskId !== task.taskId
        ) {
          tasks.push(
            taskResult(
              task,
              wave.sequence,
              "blocked",
              "task-kernel-revision-changed-before-wave",
            ),
          );
          continue;
        }
      } catch (error) {
        tasks.push(
          taskResult(
            task,
            wave.sequence,
            "blocked",
            "task-kernel-read-failed:" +
              (error instanceof Error ? error.message : String(error)),
          ),
        );
        continue;
      }
      waveTasks.push(task);
    }
    if (!waveTasks.length) {
      if (signal.aborted) break;
      continue;
    }
    const plannedWave = receipt.plan.waves.find(
      (candidate) => candidate.sequence === wave.sequence,
    );
    if (!plannedWave) {
      for (const task of waveTasks)
        tasks.push(
          taskResult(task, wave.sequence, "blocked", "schedule-wave-missing"),
        );
      continue;
    }
    for (let left = 0; left < waveTasks.length; left += 1) {
      for (let right = left + 1; right < waveTasks.length; right += 1) {
        const first = waveTasks[left];
        const second = waveTasks[right];
        if (
          !first ||
          !second ||
          !projectWriteSetsConflict(first.writeSet ?? [], second.writeSet ?? [])
        )
          continue;
        const authorized = plannedWave.conflictAuthorizations.some(
          (authorization) =>
            authorization.taskIds.includes(first.taskId) &&
            authorization.taskIds.includes(second.taskId) &&
            Boolean(authorization.integrationPlan.trim()),
        );
        if (!authorized) {
          for (const task of [first, second]) {
            if (task)
              tasks.push(
                taskResult(
                  task,
                  wave.sequence,
                  "blocked",
                  "write-set-overlap-without-integration-authorization",
                ),
              );
          }
        }
      }
    }
    const waveBlockedIds = new Set(
      tasks
        .filter(
          (task) => task.wave === wave.sequence && task.status === "blocked",
        )
        .map((task) => task.taskId),
    );
    const eligibleTasks = waveTasks.filter(
      (task) => !waveBlockedIds.has(task.taskId),
    );
    if (!eligibleTasks.length) continue;
    const waveStartedAt = performance.now();
    const runTask = async (
      task: PreparedTask,
    ): Promise<TaskKernelWaveRunCallResultV1> => {
      const taskStartedAt = performance.now();
      const taskStartedAtMs = Date.now();
      const waitingMs =
        task.queuedAtMs === null
          ? null
          : Math.max(0, taskStartedAtMs - task.queuedAtMs);
      if (!task.runId) {
        return {
          task,
          result: null,
          error: new Error("task-run-missing"),
          waitingMs,
          elapsedMs: Math.max(0, Math.round(performance.now() - taskStartedAt)),
        };
      }
      try {
        const result = await options.runner({
          taskId: task.taskId,
          taskDir: task.taskDir,
          runId: task.runId,
          scheduleReceiptFingerprint: fingerprint,
          prompt: taskPrompt(receipt, task.taskId),
          timeoutMs: options.timeoutMs,
          signal,
        });
        return {
          task,
          result,
          error: null,
          waitingMs,
          elapsedMs: Math.max(0, Math.round(performance.now() - taskStartedAt)),
        };
      } catch (error) {
        return {
          task,
          result: null,
          error,
          waitingMs,
          elapsedMs: Math.max(0, Math.round(performance.now() - taskStartedAt)),
        };
      }
    };
    const results: TaskKernelWaveRunCallResultV1[] = [];
    if (options.serialControl) {
      for (const task of eligibleTasks) results.push(await runTask(task));
    } else {
      results.push(...(await Promise.all(eligibleTasks.map(runTask))));
    }
    const waveElapsedMs = Math.max(
      0,
      Math.round(performance.now() - waveStartedAt),
    );
    waveMeasurements.push({
      sequence: wave.sequence,
      taskIds: eligibleTasks.map(({ taskId }) => taskId),
      elapsedMs: waveElapsedMs,
    });
    for (const item of results) {
      if (item.error || !item.result) {
        const reason =
          item.error instanceof Error
            ? item.error.message
            : String(item.error ?? "provider-returned-no-result");
        tasks.push({
          ...taskResult(
            item.task,
            wave.sequence,
            "provider-run-failed",
            reason,
          ),
          waitingMs: item.waitingMs,
          elapsedMs: item.elapsedMs,
        });
        stopLaterWaves = true;
        continue;
      }
      const verified = item.task.runId
        ? await import("../pi/v2-dispatch.js").then(
            ({ verifyPiV2RunSettlementV1 }) =>
              verifyPiV2RunSettlementV1(
                root,
                item.task.taskId,
                item.task.runId as string,
                fingerprint,
              ),
          )
        : null;
      const status = verified
        ? statusFor(item.result, fingerprint, verified)
        : "host-stop-unverified";
      const verifiedResult: TaskKernelWaveRunResultV1 = {
        outcome:
          verified &&
          [
            "settled",
            "needs_review",
            "failed",
            "cancelled",
            "timed_out",
            "interrupted",
          ].includes(verified.outcome ?? "")
            ? (verified.outcome as TaskKernelWaveRunOutcomeV1)
            : "failed",
        scheduleReceiptFingerprint:
          verified?.scheduleReceiptFingerprint ?? null,
        admissionReceiptFingerprint:
          verified?.admissionReceiptFingerprint ?? null,
        hostStopVerified: verified?.hostStopVerified ?? false,
        leaseReleased: verified?.leaseReleased ?? false,
        evidenceRef: verified?.evidenceRef ?? null,
        reason:
          verified?.reasonCode ??
          (status === "host-stop-unverified"
            ? "runner-result-not-corroborated-by-persisted-kernel-host-stop-and-lease-evidence"
            : item.result.reason),
      };
      tasks.push({
        ...taskResult(
          item.task,
          wave.sequence,
          status,
          verifiedResult.reason,
          verifiedResult,
        ),
        waitingMs: item.waitingMs,
        elapsedMs: item.elapsedMs,
      });
      if (
        status === "host-stop-unverified" ||
        status === "schedule-receipt-mismatch"
      )
        stopLaterWaves = true;
    }
    if (signal.aborted) stopLaterWaves = true;
    if (stopLaterWaves) break;
  }

  const resultTaskIds = new Set(tasks.map(({ taskId }) => taskId));
  for (const decision of scheduled) {
    if (resultTaskIds.has(decision.taskId)) continue;
    const task = prepared.get(decision.taskId);
    if (!task) continue;
    if (signal.aborted) {
      tasks.push(
        taskResult(
          task,
          decision.wave,
          "cancelled",
          "dispatch-cancelled-before-wave",
        ),
      );
    } else if (stopLaterWaves) {
      tasks.push(
        taskResult(
          task,
          decision.wave,
          "blocked",
          "prior-wave-did-not-prove-writer-stop",
        ),
      );
    }
  }

  const completedCount = tasks.filter(
    (task) => task.status === "provider-runs-settled",
  ).length;
  const failedCount = tasks.filter(
    (task) =>
      task.status === "provider-run-failed" ||
      task.status === "host-stop-unverified" ||
      task.status === "schedule-receipt-mismatch",
  ).length;
  const blockedCount = tasks.filter((task) => task.status === "blocked").length;
  const cancelledCount = tasks.filter(
    (task) => task.status === "cancelled" || task.outcome === "cancelled",
  ).length;
  const status: TaskKernelWaveDispatchResultV1["status"] =
    signal.aborted || cancelledCount > 0
      ? "cancelled"
      : failedCount > 0
        ? "partial"
        : blockedCount > 0 && completedCount === 0
          ? "blocked"
          : blockedCount > 0 || completedCount < scheduled.length
            ? "partial"
            : completedCount === 0
              ? "no-work"
              : "provider-runs-complete";
  return {
    schemaVersion: 1,
    dispatchId,
    runnerLabel: options.runnerLabel,
    scheduleReceiptFingerprint: fingerprint,
    status,
    kernelRunSettlement: "not-performed",
    integrationPlan: plan,
    tasks,
    measurements: {
      source: "dispatch-wall-clock",
      mode: options.serialControl ? "serial-control" : "scheduled-waves",
      elapsedMs: Math.max(0, Math.round(performance.now() - dispatchStartedAt)),
      waves: waveMeasurements,
    },
  };
}
