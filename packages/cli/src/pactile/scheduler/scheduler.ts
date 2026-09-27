export type SchedulerTaskStateV1 =
  | "waiting"
  | "running"
  | "completed"
  | "failed"
  | "blocked";

export interface SchedulerCostVectorV1 {
  latencyMs: number;
  waitingMs: number;
  executionMs: number;
  integrationMs: number;
  reworkMs: number;
  reviewMs: number;
}

export interface SchedulerTaskV1 {
  taskId: string;
  dependsOn: readonly string[];
  state: SchedulerTaskStateV1;
  /** null means the task's write scope is unknown and conflicts with every writer. */
  writeSet: readonly string[] | null;
  estimatedCosts: SchedulerCostVectorV1;
  observedCosts?: Partial<SchedulerCostVectorV1>;
}

export interface ConflictParallelAuthorizationV1 {
  taskIds: readonly [string, string];
  approvedBy: string;
  authorizationRef: string;
  /** Person or role accountable for integrating explicitly parallelized writers. */
  integrationOwner: string;
  integrationPlan: string;
}

export interface JevSchedulerAdviceV1 {
  /** Earlier entries are preferred only when critical-path costs tie. */
  taskOrder: readonly string[];
  evidenceRef: string;
}

export interface TaskScheduleRequestV1 {
  schemaVersion: 1;
  tasks: readonly SchedulerTaskV1[];
  conflictParallelizations?: readonly ConflictParallelAuthorizationV1[];
  jevAdvice?: JevSchedulerAdviceV1;
}

export type SchedulerErrorCodeV1 =
  | "invalid-request"
  | "duplicate-task"
  | "missing-dependency"
  | "dependency-cycle"
  | "invalid-cost"
  | "invalid-write-set"
  | "invalid-conflict-authorization";

export class TaskScheduleError extends Error {
  readonly code: SchedulerErrorCodeV1;

  constructor(code: SchedulerErrorCodeV1, message: string) {
    super(message);
    this.name = "TaskScheduleError";
    this.code = code;
  }
}

export type SchedulerTaskActionV1 =
  | "scheduled"
  | "completed"
  | "in-flight"
  | "failed"
  | "blocked"
  | "deferred";

export interface SchedulerTaskDecisionV1 {
  taskId: string;
  action: SchedulerTaskActionV1;
  reasonCodes: string[];
  criticalPathMs: number;
  estimatedCostMs: number;
  estimatedCosts: SchedulerCostVectorV1;
  /** All fields are returned so a receipt can be stored without losing absent measurements. */
  observedCosts: Record<keyof SchedulerCostVectorV1, number | null>;
  jevHintRank: number | null;
  jevHintApplied: boolean;
  wave: number | null;
}

export interface TaskScheduleWaveV1 {
  sequence: number;
  taskIds: string[];
  candidateTaskIds: string[];
  startedAfterMs: number;
  estimatedDurationMs: number;
  estimatedCompletionMs: number;
  serialEquivalentMs: number;
  estimatedSavingsMs: number;
  candidateSerialEquivalentMs: number;
  candidateParallelDurationMs: number;
  candidateEstimatedSavingsMs: number;
  decision:
    | "single-ready-task"
    | "parallel-time-saved"
    | "parallelism-rejected-no-time-saved";
  conflictAuthorizations: ConflictParallelAuthorizationV1[];
}

export interface TaskScheduleReceiptV1 {
  schemaVersion: 1;
  decisions: SchedulerTaskDecisionV1[];
  waves: TaskScheduleWaveV1[];
  serialEstimatedCompletionMs: number;
  plannedEstimatedCompletionMs: number;
  estimatedCompletionSavingsMs: number;
  jevAdvice: null | {
    evidenceRef: string;
    hintedTaskIds: string[];
    tieBreakAppliedTaskIds: string[];
    ignoredTaskIds: string[];
  };
}

const COST_FIELDS = [
  "latencyMs",
  "waitingMs",
  "executionMs",
  "integrationMs",
  "reworkMs",
  "reviewMs",
] as const satisfies readonly (keyof SchedulerCostVectorV1)[];

const TASK_STATES = new Set<SchedulerTaskStateV1>([
  "waiting",
  "running",
  "completed",
  "failed",
  "blocked",
]);

interface NormalizedTask extends Omit<
  SchedulerTaskV1,
  "dependsOn" | "writeSet" | "estimatedCosts" | "observedCosts"
> {
  dependsOn: string[];
  writeSet: string[];
  estimatedCosts: SchedulerCostVectorV1;
  observedCosts: Record<keyof SchedulerCostVectorV1, number | null>;
  estimatedCostMs: number;
  parallelPhaseMs: number;
  integrationReviewMs: number;
}

function fail(code: SchedulerErrorCodeV1, message: string): never {
  throw new TaskScheduleError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyText(
  value: unknown,
  field: string,
  code: SchedulerErrorCodeV1,
): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    fail(code, `${field} must be a non-empty trimmed string`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeAdd(left: number, right: number, label: string): number {
  const sum = left + right;
  if (!Number.isFinite(sum))
    fail("invalid-cost", `${label} exceeds the finite millisecond range`);
  return sum;
}

function parseCosts(
  value: unknown,
  field: string,
  partial: boolean,
): Record<keyof SchedulerCostVectorV1, number | null> {
  if (!isRecord(value)) fail("invalid-cost", `${field} must be an object`);
  const allowed = new Set<string>(COST_FIELDS);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      fail("invalid-cost", `${field} contains unknown cost field: ${key}`);
  }
  const result = {} as Record<keyof SchedulerCostVectorV1, number | null>;
  let total = 0;
  for (const key of COST_FIELDS) {
    const raw = value[key];
    if (raw === undefined && partial) {
      result[key] = null;
      continue;
    }
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      fail(
        "invalid-cost",
        `${field}.${key} must be a finite non-negative number`,
      );
    }
    result[key] = raw;
    total = safeAdd(total, raw, field);
  }
  if (!partial) {
    for (const key of COST_FIELDS) {
      if (result[key] === null)
        fail("invalid-cost", `${field}.${key} is required`);
    }
  }
  return result;
}

function normalizeWritePath(value: unknown, taskId: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail(
      "invalid-write-set",
      `writeSet for ${taskId} must contain non-empty paths`,
    );
  }
  const original = value.trim();
  const slashed = original
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  const segments = slashed.split("/");
  const hasWindowsAlternateDataStream =
    process.platform === "win32" &&
    segments.some((segment) => segment.includes(":"));
  if (
    !slashed ||
    slashed === "." ||
    slashed.startsWith("/") ||
    /^[A-Za-z]:/.test(slashed) ||
    hasWindowsAlternateDataStream ||
    slashed.includes("*") ||
    slashed.includes("?") ||
    slashed.includes("[") ||
    slashed.includes("]") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    fail(
      "invalid-write-set",
      `writeSet must use concrete project-relative paths: ${value}`,
    );
  }
  return slashed.normalize("NFC").toLowerCase();
}

function pathSetsConflict(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (!left.length || !right.length) return false;
  if (left.includes("*") || right.includes("*")) return true;
  return left.some((a) =>
    right.some(
      (b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`),
    ),
  );
}

function pairKey(left: string, right: string): string {
  const [first, second] =
    compareText(left, right) <= 0 ? [left, right] : [right, left];
  return JSON.stringify([first, second]);
}

function validateRequest(input: TaskScheduleRequestV1): {
  tasks: Map<string, NormalizedTask>;
  taskIds: string[];
  topologicalOrder: string[];
  authorizations: Map<string, ConflictParallelAuthorizationV1>;
  hints: Map<string, number>;
  advice: TaskScheduleRequestV1["jevAdvice"];
} {
  if (
    !isRecord(input) ||
    input.schemaVersion !== 1 ||
    !Array.isArray(input.tasks)
  ) {
    fail(
      "invalid-request",
      "scheduler request requires schemaVersion 1 and a tasks array",
    );
  }
  const tasks = new Map<string, NormalizedTask>();
  for (const candidate of input.tasks) {
    if (!isRecord(candidate))
      fail("invalid-request", "each scheduler task must be an object");
    const taskId = nonEmptyText(candidate.taskId, "taskId", "invalid-request");
    if (taskId.includes("\0"))
      fail("invalid-request", `taskId contains a null byte: ${taskId}`);
    if (tasks.has(taskId))
      fail("duplicate-task", `duplicate taskId: ${taskId}`);
    if (!TASK_STATES.has(candidate.state as SchedulerTaskStateV1)) {
      fail("invalid-request", `invalid state for ${taskId}`);
    }
    if (!Array.isArray(candidate.dependsOn)) {
      fail("invalid-request", `dependsOn for ${taskId} must be an array`);
    }
    const dependsOn = candidate.dependsOn.map((dependency) =>
      nonEmptyText(
        dependency,
        `dependsOn entry for ${taskId}`,
        "invalid-request",
      ),
    );
    if (new Set(dependsOn).size !== dependsOn.length) {
      fail("invalid-request", `dependsOn for ${taskId} contains duplicates`);
    }
    if (dependsOn.includes(taskId))
      fail("dependency-cycle", `task depends on itself: ${taskId}`);
    if (candidate.writeSet !== null && !Array.isArray(candidate.writeSet)) {
      fail(
        "invalid-write-set",
        `writeSet for ${taskId} must be an array or null`,
      );
    }
    const writeSet =
      candidate.writeSet === null
        ? ["*"]
        : candidate.writeSet.length
          ? [
              ...new Set(
                candidate.writeSet.map((entry) =>
                  normalizeWritePath(entry, taskId),
                ),
              ),
            ].sort(compareText)
          : [];
    const estimatedCosts = parseCosts(
      candidate.estimatedCosts,
      `estimatedCosts for ${taskId}`,
      false,
    ) as SchedulerCostVectorV1;
    const observedCosts = parseCosts(
      candidate.observedCosts === undefined ? {} : candidate.observedCosts,
      `observedCosts for ${taskId}`,
      true,
    );
    const estimatedCostMs = COST_FIELDS.reduce(
      (sum, key) =>
        safeAdd(sum, estimatedCosts[key], `estimatedCosts for ${taskId}`),
      0,
    );
    const parallelPhaseMs = [
      estimatedCosts.latencyMs,
      estimatedCosts.waitingMs,
      estimatedCosts.executionMs,
      estimatedCosts.reworkMs,
    ].reduce(
      (sum, value) => safeAdd(sum, value, `parallel phase for ${taskId}`),
      0,
    );
    const integrationReviewMs = safeAdd(
      estimatedCosts.integrationMs,
      estimatedCosts.reviewMs,
      `integration and review costs for ${taskId}`,
    );
    tasks.set(taskId, {
      taskId,
      dependsOn,
      state: candidate.state as SchedulerTaskStateV1,
      writeSet,
      estimatedCosts,
      observedCosts,
      estimatedCostMs,
      parallelPhaseMs,
      integrationReviewMs,
    });
  }

  const taskIds = [...tasks.keys()].sort(compareText);
  for (const task of tasks.values()) {
    for (const dependency of task.dependsOn) {
      if (!tasks.has(dependency)) {
        fail(
          "missing-dependency",
          `task ${task.taskId} references missing dependency ${dependency}`,
        );
      }
    }
  }

  const dependents = new Map(taskIds.map((taskId) => [taskId, [] as string[]]));
  const remainingDependencies = new Map<string, number>();
  for (const task of tasks.values()) {
    remainingDependencies.set(task.taskId, task.dependsOn.length);
    for (const dependency of task.dependsOn)
      dependents.get(dependency)?.push(task.taskId);
  }
  for (const children of dependents.values()) children.sort(compareText);
  const ready = taskIds.filter(
    (taskId) => remainingDependencies.get(taskId) === 0,
  );
  const topologicalOrder: string[] = [];
  while (ready.length) {
    ready.sort(compareText);
    const taskId = ready.shift();
    if (!taskId) break;
    topologicalOrder.push(taskId);
    for (const dependent of dependents.get(taskId) ?? []) {
      const left = (remainingDependencies.get(dependent) ?? 0) - 1;
      remainingDependencies.set(dependent, left);
      if (left === 0) ready.push(dependent);
    }
  }
  if (topologicalOrder.length !== tasks.size) {
    const cycleMembers = taskIds.filter(
      (taskId) => (remainingDependencies.get(taskId) ?? 0) > 0,
    );
    fail(
      "dependency-cycle",
      `dependency cycle detected among: ${cycleMembers.join(", ")}`,
    );
  }

  const authorizations = new Map<string, ConflictParallelAuthorizationV1>();
  if (input.conflictParallelizations === null) {
    fail(
      "invalid-conflict-authorization",
      "conflictParallelizations must be an array",
    );
  }
  const rawAuthorizations = input.conflictParallelizations ?? [];
  if (!Array.isArray(rawAuthorizations)) {
    fail(
      "invalid-conflict-authorization",
      "conflictParallelizations must be an array",
    );
  }
  for (const candidate of rawAuthorizations) {
    if (
      !isRecord(candidate) ||
      !Array.isArray(candidate.taskIds) ||
      candidate.taskIds.length !== 2
    ) {
      fail(
        "invalid-conflict-authorization",
        "each conflict authorization requires exactly two task IDs",
      );
    }
    const left = nonEmptyText(
      candidate.taskIds[0],
      "authorized task ID",
      "invalid-conflict-authorization",
    );
    const right = nonEmptyText(
      candidate.taskIds[1],
      "authorized task ID",
      "invalid-conflict-authorization",
    );
    if (left === right || !tasks.has(left) || !tasks.has(right)) {
      fail(
        "invalid-conflict-authorization",
        `conflict authorization must reference two distinct known tasks: ${left}, ${right}`,
      );
    }
    const approvedBy = nonEmptyText(
      candidate.approvedBy,
      "approvedBy",
      "invalid-conflict-authorization",
    );
    const authorizationRef = nonEmptyText(
      candidate.authorizationRef,
      "authorizationRef",
      "invalid-conflict-authorization",
    );
    const integrationOwner = nonEmptyText(
      candidate.integrationOwner,
      "integrationOwner",
      "invalid-conflict-authorization",
    );
    const integrationPlan = nonEmptyText(
      candidate.integrationPlan,
      "integrationPlan",
      "invalid-conflict-authorization",
    );
    const key = pairKey(left, right);
    if (authorizations.has(key)) {
      fail(
        "invalid-conflict-authorization",
        `duplicate conflict authorization for ${left} and ${right}`,
      );
    }
    if (
      !pathSetsConflict(
        tasks.get(left)?.writeSet ?? [],
        tasks.get(right)?.writeSet ?? [],
      )
    ) {
      fail(
        "invalid-conflict-authorization",
        `authorization does not match an overlapping write set: ${left}, ${right}`,
      );
    }
    const [first, second] =
      compareText(left, right) <= 0 ? [left, right] : [right, left];
    authorizations.set(key, {
      taskIds: [first, second],
      approvedBy,
      authorizationRef,
      integrationOwner,
      integrationPlan,
    });
  }

  const hints = new Map<string, number>();
  let advice: TaskScheduleRequestV1["jevAdvice"];
  if (input.jevAdvice !== undefined) {
    if (
      !isRecord(input.jevAdvice) ||
      !Array.isArray(input.jevAdvice.taskOrder)
    ) {
      fail("invalid-request", "jevAdvice requires taskOrder and evidenceRef");
    }
    const evidenceRef = nonEmptyText(
      input.jevAdvice.evidenceRef,
      "jevAdvice.evidenceRef",
      "invalid-request",
    );
    const advisedIds = input.jevAdvice.taskOrder.map((taskId) =>
      nonEmptyText(taskId, "Jev advised task ID", "invalid-request"),
    );
    if (new Set(advisedIds).size !== advisedIds.length) {
      fail("invalid-request", "jevAdvice.taskOrder contains duplicates");
    }
    for (const taskId of advisedIds) {
      if (!tasks.has(taskId))
        fail("invalid-request", `jevAdvice references unknown task: ${taskId}`);
    }
    advisedIds.forEach((taskId, rank) => hints.set(taskId, rank));
    advice = { taskOrder: advisedIds, evidenceRef };
  }

  return { tasks, taskIds, topologicalOrder, authorizations, hints, advice };
}

function hasWriteConflict(
  left: NormalizedTask,
  right: NormalizedTask,
): boolean {
  return pathSetsConflict(left.writeSet, right.writeSet);
}

function approvedConflict(
  left: string,
  right: string,
  authorizations: Map<string, ConflictParallelAuthorizationV1>,
): ConflictParallelAuthorizationV1 | undefined {
  return authorizations.get(pairKey(left, right));
}

function computeBlockedBy(
  tasks: Map<string, NormalizedTask>,
  topologicalOrder: readonly string[],
): Map<string, string[]> {
  const blockedBy = new Map<string, string[]>();
  for (const taskId of topologicalOrder) {
    const task = tasks.get(taskId);
    if (!task) continue;
    if (task.state === "blocked" || task.state === "failed") {
      blockedBy.set(taskId, [taskId]);
      continue;
    }
    const blockers = new Set<string>();
    for (const dependency of task.dependsOn) {
      for (const blocker of blockedBy.get(dependency) ?? [])
        blockers.add(blocker);
    }
    if (blockers.size) blockedBy.set(taskId, [...blockers].sort(compareText));
  }
  return blockedBy;
}

function computeCriticalPaths(
  tasks: Map<string, NormalizedTask>,
  taskIds: readonly string[],
  topologicalOrder: readonly string[],
  blockedBy: Map<string, string[]>,
): Map<string, number> {
  const dependents = new Map(taskIds.map((taskId) => [taskId, [] as string[]]));
  for (const task of tasks.values()) {
    for (const dependency of task.dependsOn)
      dependents.get(dependency)?.push(task.taskId);
  }
  const criticalPath = new Map<string, number>();
  for (const taskId of [...topologicalOrder].reverse()) {
    const task = tasks.get(taskId);
    if (!task) continue;
    const downstream = (dependents.get(taskId) ?? []).reduce(
      (maximum, dependent) =>
        Math.max(maximum, criticalPath.get(dependent) ?? 0),
      0,
    );
    const activeCost =
      blockedBy.has(taskId) || task.state === "completed"
        ? 0
        : task.estimatedCostMs;
    criticalPath.set(
      taskId,
      safeAdd(activeCost, downstream, `critical path for ${taskId}`),
    );
  }
  return criticalPath;
}

function priorityOrder(
  taskIds: readonly string[],
  criticalPath: Map<string, number>,
  hints: Map<string, number>,
  tieBreakApplied: Set<string>,
): string[] {
  const groups = new Map<number, string[]>();
  for (const taskId of taskIds) {
    const pathCost = criticalPath.get(taskId) ?? 0;
    const group = groups.get(pathCost) ?? [];
    group.push(taskId);
    groups.set(pathCost, group);
  }
  const result: string[] = [];
  const costs = [...groups.keys()].sort((left, right) => right - left);
  for (const cost of costs) {
    const group = groups.get(cost) ?? [];
    const lexical = [...group].sort(compareText);
    const advised = [...group].sort((left, right) => {
      const leftRank = hints.get(left) ?? Number.POSITIVE_INFINITY;
      const rightRank = hints.get(right) ?? Number.POSITIVE_INFINITY;
      return leftRank - rightRank || compareText(left, right);
    });
    if (
      advised.some(
        (taskId, index) => taskId !== lexical[index] && hints.has(taskId),
      )
    ) {
      for (const taskId of advised) {
        if (hints.has(taskId)) tieBreakApplied.add(taskId);
      }
    }
    result.push(...advised);
  }
  return result;
}

function taskTotal(task: NormalizedTask): number {
  return task.estimatedCostMs;
}

function groupSerialCost(group: readonly NormalizedTask[]): number {
  return group.reduce(
    (sum, task) => safeAdd(sum, taskTotal(task), "serial wave cost"),
    0,
  );
}

function groupParallelCost(group: readonly NormalizedTask[]): number {
  const parallelWork = group.reduce(
    (maximum, task) => Math.max(maximum, task.parallelPhaseMs),
    0,
  );
  const serialIntegrationAndReview = group.reduce(
    (sum, task) =>
      safeAdd(
        sum,
        task.integrationReviewMs,
        "integration and review wave cost",
      ),
    0,
  );
  return safeAdd(
    parallelWork,
    serialIntegrationAndReview,
    "parallel wave cost",
  );
}

function normalizeObservedCosts(
  costs: Record<keyof SchedulerCostVectorV1, number | null>,
): Record<keyof SchedulerCostVectorV1, number | null> {
  return Object.fromEntries(
    COST_FIELDS.map((key) => [key, costs[key]]),
  ) as Record<keyof SchedulerCostVectorV1, number | null>;
}

/**
 * Produces a deterministic schedule receipt from a Task DAG snapshot. It never
 * starts, approves, integrates, or reviews a Run; callers own those side effects.
 */
export function planTaskScheduleV1(
  input: TaskScheduleRequestV1,
): TaskScheduleReceiptV1 {
  const { tasks, taskIds, topologicalOrder, authorizations, hints, advice } =
    validateRequest(input);
  const blockedBy = computeBlockedBy(tasks, topologicalOrder);
  const criticalPath = computeCriticalPaths(
    tasks,
    taskIds,
    topologicalOrder,
    blockedBy,
  );
  const pending = new Set(
    taskIds.filter(
      (taskId) =>
        tasks.get(taskId)?.state === "waiting" && !blockedBy.has(taskId),
    ),
  );
  const running = taskIds
    .map((taskId) => tasks.get(taskId))
    .filter((task): task is NormalizedTask => task?.state === "running");
  const simulatedCompleted = new Set(
    taskIds.filter((taskId) => tasks.get(taskId)?.state === "completed"),
  );
  const tieBreakApplied = new Set<string>();
  const waveByTask = new Map<string, number>();
  const schedulingReasons = new Map<string, Set<string>>();
  const addSchedulingReason = (taskId: string, reason: string): void => {
    const reasons = schedulingReasons.get(taskId) ?? new Set<string>();
    reasons.add(reason);
    schedulingReasons.set(taskId, reasons);
  };
  const waves: TaskScheduleWaveV1[] = [];
  let elapsedMs = 0;

  while (pending.size) {
    const dependencyReady = [...pending].filter((taskId) =>
      tasks
        .get(taskId)
        ?.dependsOn.every((dependency) => simulatedCompleted.has(dependency)),
    );
    if (!dependencyReady.length) break;

    const executable: string[] = [];
    for (const taskId of dependencyReady) {
      const task = tasks.get(taskId);
      if (!task) continue;
      const blockedByRunning = running.some((active) => {
        if (!hasWriteConflict(task, active)) return false;
        return !approvedConflict(taskId, active.taskId, authorizations);
      });
      if (!blockedByRunning) executable.push(taskId);
      else addSchedulingReason(taskId, "active-write-set-conflict");
    }
    if (!executable.length) break;

    const ordered = priorityOrder(
      executable,
      criticalPath,
      hints,
      tieBreakApplied,
    );
    const groups: string[][] = [];
    for (const taskId of ordered) {
      const compatibleGroup = groups.find((group) =>
        group.every((memberId) => {
          const left = tasks.get(taskId);
          const right = tasks.get(memberId);
          if (!left || !right || !hasWriteConflict(left, right)) return true;
          return !!approvedConflict(taskId, memberId, authorizations);
        }),
      );
      if (compatibleGroup) compatibleGroup.push(taskId);
      else groups.push([taskId]);
    }
    const group = groups[0] ?? [];
    const priorityGroup = group
      .map((taskId) => tasks.get(taskId))
      .filter((task): task is NormalizedTask => !!task);
    if (!priorityGroup.length) break;

    const serialEquivalentMs = groupSerialCost(priorityGroup);
    const candidateParallelMs =
      group.length > 1 ? groupParallelCost(priorityGroup) : serialEquivalentMs;
    const candidateSavingsMs = serialEquivalentMs - candidateParallelMs;
    const parallelize = group.length > 1 && candidateSavingsMs > 0;
    const selectedIds = parallelize ? group : [ordered[0] as string];
    const selectedTasks = selectedIds
      .map((taskId) => tasks.get(taskId))
      .filter((task): task is NormalizedTask => !!task);
    const selectedSerialMs = groupSerialCost(selectedTasks);
    const estimatedDurationMs = parallelize
      ? candidateParallelMs
      : (selectedTasks[0]?.estimatedCostMs ?? 0);
    const selectedSavingsMs = Math.max(
      0,
      selectedSerialMs - estimatedDurationMs,
    );
    const selectedSet = new Set(selectedIds);
    for (const taskId of executable) {
      if (selectedSet.has(taskId)) continue;
      const conflictsWithSelected = selectedIds.some((selectedId) => {
        const candidate = tasks.get(taskId);
        const selected = tasks.get(selectedId);
        return (
          !!candidate &&
          !!selected &&
          hasWriteConflict(candidate, selected) &&
          !approvedConflict(taskId, selectedId, authorizations)
        );
      });
      if (conflictsWithSelected)
        addSchedulingReason(taskId, "write-set-conflict-serialized");
      else if (group.includes(taskId) && group.length > 1 && !parallelize) {
        addSchedulingReason(taskId, "parallelism-rejected-no-time-savings");
      } else addSchedulingReason(taskId, "later-ready-wave");
    }
    const selectedAuthorizations = [...authorizations.values()]
      .filter((authorization) => {
        const [left, right] = authorization.taskIds;
        return (
          (selectedSet.has(left) && selectedSet.has(right)) ||
          (selectedSet.has(left) &&
            running.some((active) => active.taskId === right)) ||
          (selectedSet.has(right) &&
            running.some((active) => active.taskId === left))
        );
      })
      .sort((left, right) =>
        compareText(pairKey(...left.taskIds), pairKey(...right.taskIds)),
      );
    const sequence = waves.length + 1;
    const startedAfterMs = elapsedMs;
    elapsedMs = safeAdd(
      elapsedMs,
      estimatedDurationMs,
      "planned completion time",
    );
    waves.push({
      sequence,
      taskIds: [...selectedIds],
      candidateTaskIds: [...group],
      startedAfterMs,
      estimatedDurationMs,
      estimatedCompletionMs: elapsedMs,
      serialEquivalentMs: selectedSerialMs,
      estimatedSavingsMs: selectedSavingsMs,
      candidateSerialEquivalentMs: serialEquivalentMs,
      candidateParallelDurationMs: candidateParallelMs,
      candidateEstimatedSavingsMs: candidateSavingsMs,
      decision: parallelize
        ? "parallel-time-saved"
        : group.length > 1
          ? "parallelism-rejected-no-time-saved"
          : "single-ready-task",
      conflictAuthorizations: selectedAuthorizations,
    });
    for (const taskId of selectedIds) {
      pending.delete(taskId);
      simulatedCompleted.add(taskId);
      waveByTask.set(taskId, sequence);
    }
  }

  const decisions: SchedulerTaskDecisionV1[] = taskIds.map((taskId) => {
    const task = tasks.get(taskId);
    if (!task) throw new Error("validated task disappeared");
    const wave = waveByTask.get(taskId) ?? null;
    let action: SchedulerTaskActionV1;
    let reasonCodes: string[];
    if (wave !== null) {
      action = "scheduled";
      reasonCodes = [
        ...(schedulingReasons.get(taskId) ?? []),
        ...(waves[wave - 1]?.decision === "parallel-time-saved"
          ? ["ready-dependencies", "positive-completion-time-savings"]
          : ["ready-dependencies", "serial-wave"]),
      ];
    } else if (task.state === "completed") {
      action = "completed";
      reasonCodes = ["already-completed"];
    } else if (task.state === "running") {
      action = "in-flight";
      reasonCodes = ["already-running"];
    } else if (task.state === "failed") {
      action = "failed";
      reasonCodes = ["task-failed"];
    } else if (task.state === "blocked") {
      action = "blocked";
      reasonCodes = ["task-blocked"];
    } else if (blockedBy.has(taskId)) {
      action = "blocked";
      reasonCodes = ["blocked-by-dependency"];
    } else {
      action = "deferred";
      const unresolvedDependencies = task.dependsOn.filter(
        (dependency) => !simulatedCompleted.has(dependency),
      );
      if (unresolvedDependencies.length) {
        reasonCodes = ["dependency-not-complete"];
      } else if (
        running.some(
          (active) =>
            hasWriteConflict(task, active) &&
            !approvedConflict(taskId, active.taskId, authorizations),
        )
      ) {
        reasonCodes = [
          ...new Set([
            "active-write-set-conflict",
            ...(schedulingReasons.get(taskId) ?? []),
          ]),
        ];
      } else {
        reasonCodes = ["deferred-after-current-plan"];
      }
    }
    const appliedTieBreak = tieBreakApplied.has(taskId);
    return {
      taskId,
      action,
      reasonCodes,
      criticalPathMs: criticalPath.get(taskId) ?? 0,
      estimatedCostMs: task.estimatedCostMs,
      estimatedCosts: { ...task.estimatedCosts },
      observedCosts: normalizeObservedCosts(task.observedCosts),
      jevHintRank: hints.get(taskId) ?? null,
      jevHintApplied: appliedTieBreak,
      wave,
    };
  });
  const serialEstimatedCompletionMs = decisions
    .filter((decision) => decision.action === "scheduled")
    .reduce(
      (sum, decision) =>
        safeAdd(sum, decision.estimatedCostMs, "serial completion time"),
      0,
    );
  const estimatedCompletionSavingsMs = Math.max(
    0,
    serialEstimatedCompletionMs - elapsedMs,
  );
  const hintedTaskIds = advice?.taskOrder ? [...advice.taskOrder] : [];
  const ignoredTaskIds = hintedTaskIds
    .filter((taskId) => !waveByTask.has(taskId))
    .sort(
      (left, right) =>
        (hints.get(left) ?? 0) - (hints.get(right) ?? 0) ||
        compareText(left, right),
    );

  return {
    schemaVersion: 1,
    decisions,
    waves,
    serialEstimatedCompletionMs,
    plannedEstimatedCompletionMs: elapsedMs,
    estimatedCompletionSavingsMs,
    jevAdvice: advice
      ? {
          evidenceRef: advice.evidenceRef,
          hintedTaskIds,
          tieBreakAppliedTaskIds: [...tieBreakApplied]
            .filter((taskId) => waveByTask.has(taskId))
            .sort(compareText),
          ignoredTaskIds,
        }
      : null,
  };
}
