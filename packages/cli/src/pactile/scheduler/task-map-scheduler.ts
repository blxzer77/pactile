import fs from "node:fs";
import path from "node:path";
import {
  KernelError,
  fingerprintTaskValue,
  listTaskKernelSnapshots,
  projectTaskKernelLifecycle,
  readTaskKernel,
  type AnyTaskKernelReadResult,
  type TaskKernelSnapshotV2,
  type TaskRunV2,
} from "../../core/task/index.js";
import {
  readLegacyTaskImportRecord,
  type LegacyTaskImportRecord,
} from "../../core/task/legacy-task-migration-reader.js";
import { approvedTask, piWorkdir } from "../pi/bridge.js";
import { resolveTaskDir } from "../task/session.js";
import { readTaskMap, type ChildEntry } from "../task/task-map.js";
import {
  finalizeJevTaskScheduleAdviceV1,
  finalizeJevTaskScheduleEligibilityV1,
  requestJevTaskScheduleAdviceV1,
  supersedeJevTaskScheduleAdviceV1,
  type JevScheduleAdviceAuditV1,
  type JevScheduleAdviceOptionsV1,
  type JevScheduleCandidateFilterV1,
  type JevScheduleCandidateV1,
} from "../jev/scheduler-advice.js";
import {
  listProjectWriteLeases,
  projectWriteSetsConflict,
  withProjectSchedulerMutex,
} from "./project-lease-store.js";
import {
  planTaskScheduleV1,
  type SchedulerCostVectorV1,
  type SchedulerTaskStateV1,
  type TaskScheduleReceiptV1,
  type TaskScheduleRequestV1,
} from "./scheduler.js";

const TASK_RECORD = "task.json";
const KERNEL_RECORD = "kernel.json";
const RECEIPT_SCHEMA_VERSION = 1;
const COST_FIELDS = [
  "latencyMs",
  "waitingMs",
  "executionMs",
  "integrationMs",
  "reworkMs",
  "reviewMs",
] as const satisfies readonly (keyof SchedulerCostVectorV1)[];

export type SchedulerTaskCostOverridesV1 = Record<
  string,
  Partial<SchedulerCostVectorV1>
>;

export interface TaskMapScheduleOptionsV1 {
  /** Limit candidate scheduling while retaining dependency context from every Parent Child. */
  candidateTaskIds?: readonly string[];
  estimatedCosts?: SchedulerTaskCostOverridesV1;
  conflictParallelizations?: TaskScheduleRequestV1["conflictParallelizations"];
  jevAdvice?: TaskScheduleRequestV1["jevAdvice"];
}

export interface TaskScheduleLifecycleSnapshotV1 {
  taskId: string;
  taskDir: string;
  sourceKind: AnyTaskKernelReadResult["kind"];
  taskMapChildId: string | null;
  childState: ChildEntry["state"] | null;
  kernelRevision: number | null;
  lifecyclePhase: string | null;
  lifecycleCondition: string | null;
  runId: string | null;
  runState: TaskRunV2["state"] | null;
  runMeasurementRefs: TaskRunV2["measurementRefs"] | null;
  observedCostEvidenceRefs: string[];
  schedulerState: SchedulerTaskStateV1;
  dependencyTaskIds: string[];
  writeSet: string[] | null;
  writeSetBasis: string;
  estimatedCosts: SchedulerCostVectorV1;
  estimateBasis: Record<keyof SchedulerCostVectorV1, string>;
  observedCosts: Record<keyof SchedulerCostVectorV1, number | null>;
  projectionNotes: string[];
}

export interface TaskScheduleDecisionReceiptV1 {
  schemaVersion: 1;
  receiptFingerprint: string;
  createdAt: string;
  parentTaskDir: string;
  taskMapFingerprint: string;
  request: TaskScheduleRequestV1;
  plan: TaskScheduleReceiptV1;
  lifecycle: TaskScheduleLifecycleSnapshotV1[];
  jevAdviceAudit?: JevScheduleAdviceAuditV1;
}

export interface PersistedTaskScheduleV1 {
  receipt: TaskScheduleDecisionReceiptV1;
  receiptFile: string;
  created: boolean;
}

export type TaskKernelScheduleOptionsV1 = Omit<
  TaskMapScheduleOptionsV1,
  "candidateTaskIds"
>;

export interface TaskKernelScheduleDecisionReceiptV1 {
  schemaVersion: 1;
  scope: "task-kernel-v2";
  receiptFingerprint: string;
  createdAt: string;
  /** Version 2 protects the full receipt envelope, including createdAt. */
  integrityVersion?: 2;
  /** Stable request identity used only to preserve idempotent receipt reuse. */
  scheduleKey?: string;
  candidateTaskIds: string[];
  taskKernelRevisions: Record<string, number>;
  request: TaskScheduleRequestV1;
  plan: TaskScheduleReceiptV1;
  lifecycle: TaskScheduleLifecycleSnapshotV1[];
}

export interface PersistedTaskKernelScheduleV1 {
  receipt: TaskKernelScheduleDecisionReceiptV1;
  receiptFile: string;
  created: boolean;
}

export interface ReadTaskKernelScheduleReceiptV1 {
  receipt: TaskKernelScheduleDecisionReceiptV1;
  integrity: "fingerprint-verified" | "legacy-fingerprint-excludes-createdAt";
}

interface IndexedTask {
  dir: string;
  taskId: string;
  read: AnyTaskKernelReadResult;
  kernel: TaskKernelSnapshotV2 | null;
}

interface ReconciliationIndexedTask {
  dir: string;
  taskId: string;
  migrationStatus: "needs-definition" | "needs-coordination";
  reconciliationDetail: string;
}

type TaskKernelGraphIndexedTask = IndexedTask | ReconciliationIndexedTask;
type ReconciliationStatus = Exclude<
  LegacyTaskImportRecord["status"],
  "imported"
>;

interface SelectedTask extends IndexedTask {
  child: ChildEntry;
  dependencies: string[];
  notes: string[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function relativeTaskDir(root: string, dir: string): string {
  return path.relative(root, dir).replaceAll("\\", "/");
}

function canonicalFilePath(file: string): string {
  return path.resolve(file);
}

function activeTaskDirectories(root: string): string[] {
  const tasksRoot = path.resolve(root, ".pactile", "tasks");
  if (!fs.existsSync(tasksRoot)) return [];
  return fs
    .readdirSync(tasksRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !["archive", "locale", "templates"].includes(entry.name),
    )
    .map((entry) => path.join(tasksRoot, entry.name))
    .filter(
      (dir) =>
        fs.existsSync(path.join(dir, TASK_RECORD)) ||
        fs.existsSync(path.join(dir, KERNEL_RECORD)),
    )
    .sort(compareText);
}

function indexTasks(root: string): {
  byId: Map<string, IndexedTask>;
  byDir: Map<string, IndexedTask>;
  byArchivedId: Map<string, IndexedTask>;
} {
  const byId = new Map<string, IndexedTask>();
  const byDir = new Map<string, IndexedTask>();
  const byArchivedId = new Map<string, IndexedTask>();
  for (const dir of activeTaskDirectories(root)) {
    const read = readTaskKernel({ root, taskDir: dir });
    const taskId =
      read.kind === "task-kernel-v2"
        ? read.kernel.identity.taskId
        : read.kernel.kernel.identity.taskId;
    if (byId.has(taskId))
      throw new Error(`Duplicate active Task identity: ${taskId}`);
    const indexed: IndexedTask = {
      dir,
      taskId,
      read,
      kernel: read.kind === "task-kernel-v2" ? read.kernel : null,
    };
    byId.set(taskId, indexed);
    byDir.set(canonicalFilePath(dir), indexed);
  }
  const archivePrefix = `${path.resolve(root, ".pactile", "tasks", "archive")}${path.sep}`.toLowerCase();
  for (const { taskDir, kernel } of listTaskKernelSnapshots(root)) {
    const dir = path.resolve(taskDir);
    if (!dir.toLowerCase().startsWith(archivePrefix)) continue;
    const taskId = kernel.identity.taskId;
    if (byId.has(taskId) || byArchivedId.has(taskId))
      throw new Error(`Duplicate active or archived Task identity: ${taskId}`);
    byArchivedId.set(taskId, {
      dir,
      taskId,
      read: { kind: "task-kernel-v2", kernel },
      kernel,
    });
  }
  return { byId, byDir, byArchivedId };
}

function reconciliationRecordForError(
  error: unknown,
): ReconciliationStatus | null {
  if (!(error instanceof KernelError)) return null;
  if (error.code === "LEGACY_TASK_REQUIRES_DEFINITION")
    return "needs-definition";
  if (error.code === "LEGACY_TASK_REQUIRES_COORDINATION")
    return "needs-coordination";
  return null;
}

function reconciliationDetail(
  record: LegacyTaskImportRecord,
  status: ReconciliationStatus,
): string {
  return status === "needs-definition"
    ? `missing definition fields: ${record.missingDefinitionFields.join(", ")}`
    : `unresolved blocking legacy dependencies: ${record.coordinationReasons.join(", ")}`;
}

function isReconciliationIndexedTask(
  task: TaskKernelGraphIndexedTask,
): task is ReconciliationIndexedTask {
  return "migrationStatus" in task;
}

function indexTaskKernelGraphTasks(root: string): {
  byId: Map<string, TaskKernelGraphIndexedTask>;
  byArchivedId: Map<string, IndexedTask>;
} {
  const byId = new Map<string, TaskKernelGraphIndexedTask>();
  const byArchivedId = new Map<string, IndexedTask>();
  for (const dir of activeTaskDirectories(root)) {
    let read: AnyTaskKernelReadResult;
    try {
      read = readTaskKernel({ root, taskDir: dir });
    } catch (error) {
      const expectedStatus = reconciliationRecordForError(error);
      if (!expectedStatus) throw error;
      const record = readLegacyTaskImportRecord(root, dir);
      if (record?.status !== expectedStatus) throw error;
      if (record.taskPath !== relativeTaskDir(root, dir)) throw error;
      if (byId.has(record.legacyTaskId))
        throw new Error(
          `Duplicate active Task identity: ${record.legacyTaskId}`,
        );
      byId.set(record.legacyTaskId, {
        dir,
        taskId: record.legacyTaskId,
        migrationStatus: expectedStatus,
        reconciliationDetail: reconciliationDetail(record, expectedStatus),
      });
      continue;
    }
    const taskId =
      read.kind === "task-kernel-v2"
        ? read.kernel.identity.taskId
        : read.kernel.kernel.identity.taskId;
    if (byId.has(taskId))
      throw new Error(`Duplicate active Task identity: ${taskId}`);
    byId.set(taskId, {
      dir,
      taskId,
      read,
      kernel: read.kind === "task-kernel-v2" ? read.kernel : null,
    });
  }
  const archivePrefix =
    `${path.resolve(root, ".pactile", "tasks", "archive")}${path.sep}`.toLowerCase();
  for (const { taskDir, kernel } of listTaskKernelSnapshots(root)) {
    const dir = path.resolve(taskDir);
    if (!dir.toLowerCase().startsWith(archivePrefix)) continue;
    const taskId = kernel.identity.taskId;
    if (byId.has(taskId) || byArchivedId.has(taskId))
      throw new Error(`Duplicate active or archived Task identity: ${taskId}`);
    byArchivedId.set(taskId, {
      dir,
      taskId,
      read: { kind: "task-kernel-v2", kernel },
      kernel,
    });
  }
  return { byId, byArchivedId };
}

function reconciliationFailure(
  task: ReconciliationIndexedTask,
  relation: "candidate" | "dependency",
): Error {
  const subject =
    relation === "candidate" ? "Task candidate" : "Hard Task dependency";
  const reason =
    task.migrationStatus === "needs-definition"
      ? "must be completed before it can run"
      : "must be coordinated before it can run";
  return new Error(
    `${subject} ${task.taskId} requires legacy reconciliation (${task.migrationStatus}): ${reason}; ${task.reconciliationDetail}`,
  );
}

function resolveChildDependency(
  dependency: string,
  children: readonly ChildEntry[],
  selectedByChildId: Map<string, SelectedTask>,
  byId: Map<string, IndexedTask>,
): IndexedTask {
  const child = children.find(
    (candidate) =>
      candidate.id === dependency || candidate.id.endsWith(`-${dependency}`),
  );
  if (child) {
    const selected = selectedByChildId.get(child.id);
    if (!selected)
      throw new Error(
        `Parent Child dependency is not in the schedule snapshot: ${dependency}`,
      );
    return selected;
  }
  const indexed = byId.get(dependency);
  if (!indexed) throw new Error(`Missing hard Task dependency: ${dependency}`);
  return indexed;
}

function stateForChild(childState: ChildEntry["state"]): SchedulerTaskStateV1 {
  switch (childState) {
    case "integrated":
      return "completed";
    case "blocked":
    case "cancelled":
      return "blocked";
    case "working":
    case "review":
    case "accepted":
    case "integrating":
      return "running";
    case "open":
    case "changes":
      return "waiting";
  }
}

function stateForV2(
  kernel: TaskKernelSnapshotV2,
  child: ChildEntry | null,
): SchedulerTaskStateV1 {
  const lifecycle = projectTaskKernelLifecycle(kernel);
  if (
    lifecycle.condition === "blocked" ||
    child?.state === "blocked" ||
    child?.state === "cancelled"
  )
    return "blocked";
  if (lifecycle.closed && lifecycle.outcome === "completed") return "completed";
  if (child?.state === "integrated") return "blocked";
  const latest = kernel.runs.at(-1) ?? null;
  if (latest?.state === "failed") return "failed";
  if (latest?.state === "blocked") return "blocked";
  if (latest?.state === "running") return "running";
  if (latest?.state === "waiting") return "waiting";
  if (latest?.state === "completed") return "running";
  if (child) return stateForChild(child.state);
  return "blocked";
}

function stateForTaskKernelCandidate(
  kernel: TaskKernelSnapshotV2,
): SchedulerTaskStateV1 {
  const projectedState = stateForV2(kernel, null);
  const lifecycle = projectTaskKernelLifecycle(kernel);
  if (
    projectedState === "blocked" &&
    kernel.condition === "ready" &&
    lifecycle.gateSnapshot.runStart.phaseAllowsRun
  ) {
    return "waiting";
  }
  return projectedState;
}

function stateForLegacy(
  indexed: IndexedTask,
  child: ChildEntry | null,
): SchedulerTaskStateV1 {
  if (child) return stateForChild(child.state);
  if (indexed.read.kind !== "legacy-task-kernel-v1") return "blocked";
  const legacyStatus = indexed.read.kernel.legacy.status.toLowerCase();
  if (["completed", "integrated"].includes(legacyStatus)) return "completed";
  if (legacyStatus === "failed") return "failed";
  return "blocked";
}

function sourceDependencies(
  indexed: IndexedTask,
  child: ChildEntry | null,
  children: readonly ChildEntry[],
  selectedByChildId: Map<string, SelectedTask>,
  byId: Map<string, IndexedTask>,
): string[] {
  if (indexed.kernel) {
    return indexed.kernel.definition.dependencies.map((dependency) => {
      const resolved = resolveChildDependency(
        dependency,
        children,
        selectedByChildId,
        byId,
      );
      return resolved.taskId;
    });
  }
  if (child) {
    return child.depends_on.map((dependency) => {
      const resolved = resolveChildDependency(
        dependency,
        children,
        selectedByChildId,
        byId,
      );
      return resolved.taskId;
    });
  }
  return [];
}

function parseInstant(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeDelta(
  start: number | null,
  end: number | null,
): number | null {
  if (start === null || end === null || end < start) return null;
  return end - start;
}

function runObservedCosts(
  kernel: TaskKernelSnapshotV2 | null,
  run: TaskRunV2 | null,
  child: ChildEntry | null,
  taskMapBody: string,
): Record<keyof SchedulerCostVectorV1, number | null> {
  const observed = Object.fromEntries(
    COST_FIELDS.map((key) => [key, null]),
  ) as Record<keyof SchedulerCostVectorV1, number | null>;
  if (kernel && run) {
    const runEvents = kernel.events.filter(
      (event) => event.entityId === run.id,
    );
    const queuedAt = parseInstant(
      runEvents.find((event) => event.type === "run.queued")?.at,
    );
    const startedEvent = runEvents.find(
      (event) => event.type === "run.started" || event.type === "run.resumed",
    );
    const startedAt = parseInstant(startedEvent?.at);
    observed.waitingMs = nonNegativeDelta(queuedAt, startedAt);
    observed.executionMs = nonNegativeDelta(
      startedAt,
      parseInstant(run.completedAt),
    );
    const review = kernel.reviews
      .filter((candidate) => candidate.runId === run.id)
      .at(-1);
    observed.reviewMs = nonNegativeDelta(
      parseInstant(run.completedAt),
      parseInstant(review?.reviewedAt),
    );
  }
  if (child) {
    const escaped = child.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `^- (\\d{4}-\\d\\d-\\d\\dT[^ ]+) - (?:Parent integrated|Child reported) ${escaped} as (changes|accepted|integrating|integrated)\\.$`,
      "gm",
    );
    const events = [...taskMapBody.matchAll(pattern)]
      .map((match) => ({ at: parseInstant(match[1]), state: match[2] }))
      .filter(
        (event): event is { at: number; state: string } => event.at !== null,
      )
      .sort((left, right) => left.at - right.at);
    let openedRework: number | null = null;
    let integrationStart: number | null = null;
    let reworkTotal = 0;
    let integrationTotal = 0;
    let completedReworkCycles = 0;
    let completedIntegrationCycles = 0;
    for (const event of events) {
      if (event.state === "changes") openedRework = event.at;
      else if (
        openedRework !== null &&
        ["accepted", "integrating", "integrated"].includes(event.state)
      ) {
        reworkTotal += Math.max(0, event.at - openedRework);
        completedReworkCycles += 1;
        openedRework = null;
      }
      if (event.state === "integrating") integrationStart = event.at;
      if (event.state === "integrated" && integrationStart !== null) {
        integrationTotal += Math.max(0, event.at - integrationStart);
        completedIntegrationCycles += 1;
        integrationStart = null;
      }
    }
    if (completedReworkCycles) observed.reworkMs = reworkTotal;
    if (completedIntegrationCycles) observed.integrationMs = integrationTotal;
  }
  return observed;
}

function emptyCosts(): SchedulerCostVectorV1 {
  return {
    latencyMs: 0,
    waitingMs: 0,
    executionMs: 0,
    integrationMs: 0,
    reworkMs: 0,
    reviewMs: 0,
  };
}

function definedObservedCosts(
  costs: Record<keyof SchedulerCostVectorV1, number | null>,
): Partial<SchedulerCostVectorV1> {
  return Object.fromEntries(
    COST_FIELDS.flatMap((field) =>
      costs[field] === null ? [] : [[field, costs[field]]],
    ),
  ) as Partial<SchedulerCostVectorV1>;
}

function mergedWriteSet(
  indexed: IndexedTask,
  child: ChildEntry | null,
): { value: string[] | null; basis: string } {
  const run = indexed.kernel?.runs.at(-1) ?? null;
  const values = new Set<string>();
  const bases: string[] = [];
  if (run?.writeSetSnapshot.length) {
    run.writeSetSnapshot.forEach((value) => values.add(value));
    bases.push("task-run-writeSetSnapshot");
  }
  if (run?.workspace?.writeSet.length) {
    run.workspace.writeSet.forEach((value) => values.add(value));
    bases.push("run-workspace-writeSet");
  }
  if (child?.touches.length) {
    child.touches.forEach((value) => values.add(value));
    bases.push("task-map-touches");
  }
  if (!values.size) return { value: null, basis: "unknown-write-scope" };
  return { value: [...values].sort(compareText), basis: bases.join("+") };
}

function estimatedCosts(
  indexed: IndexedTask,
  overrides: Partial<SchedulerCostVectorV1> | undefined,
): {
  costs: SchedulerCostVectorV1;
  basis: Record<keyof SchedulerCostVectorV1, string>;
} {
  const run = indexed.kernel?.runs.at(-1) ?? null;
  const runEstimate = run?.estimatedDurations;
  const basis = {} as Record<keyof SchedulerCostVectorV1, string>;
  const costs = {} as SchedulerCostVectorV1;
  for (const field of COST_FIELDS) {
    const supplied = overrides?.[field];
    const runValue =
      field === "executionMs"
        ? runEstimate?.executionMs
        : field === "waitingMs"
          ? runEstimate?.waitingMs
          : field === "reviewMs"
            ? runEstimate?.reviewMs
            : null;
    if (supplied !== undefined) {
      costs[field] = supplied;
      basis[field] = "caller-estimate";
    } else if (typeof runValue === "number") {
      costs[field] = runValue;
      basis[field] = "task-run-estimate";
    } else {
      costs[field] = 0;
      basis[field] = "unmeasured-zero";
    }
  }
  return { costs, basis };
}

function toSnapshot(
  root: string,
  indexed: IndexedTask,
  child: ChildEntry | null,
  taskMapBody: string,
  overrides: Partial<SchedulerCostVectorV1> | undefined,
  dependencyTaskIds: string[],
  notes: string[],
): TaskScheduleLifecycleSnapshotV1 {
  const kernel = indexed.kernel;
  const run = kernel?.runs.at(-1) ?? null;
  const write = mergedWriteSet(indexed, child);
  const estimate = estimatedCosts(indexed, overrides);
  if (
    kernel &&
    child?.state === "integrated" &&
    !projectTaskKernelLifecycle(kernel).closed
  ) {
    notes.push("task-map-integrated-without-v2-close");
  }
  return {
    taskId: indexed.taskId,
    taskDir: relativeTaskDir(root, indexed.dir),
    sourceKind: indexed.read.kind,
    taskMapChildId: child?.id ?? null,
    childState: child?.state ?? null,
    kernelRevision: kernel?.revision ?? null,
    lifecyclePhase: kernel?.phase ?? null,
    lifecycleCondition: kernel?.condition ?? null,
    runId: run?.id ?? null,
    runState: run?.state ?? null,
    runMeasurementRefs: run ? { ...run.measurementRefs } : null,
    observedCostEvidenceRefs: [
      ...(kernel && run
        ? kernel.events
            .filter((event) => event.entityId === run.id)
            .map((event) => `kernel-event:${event.id}`)
        : []),
      ...(kernel && run
        ? kernel.reviews
            .filter((review) => review.runId === run.id)
            .map((review) => `kernel-review:${review.id}`)
        : []),
      ...(child ? [`task-map-event-log:${child.id}`] : []),
    ],
    schedulerState: kernel
      ? stateForV2(kernel, child)
      : child
        ? stateForChild(child.state)
        : "blocked",
    dependencyTaskIds: [...dependencyTaskIds].sort(compareText),
    writeSet: write.value,
    writeSetBasis: write.basis,
    estimatedCosts: estimate.costs,
    estimateBasis: estimate.basis,
    observedCosts: runObservedCosts(kernel, run, child, taskMapBody),
    projectionNotes: notes,
  };
}

function activeTaskState(
  indexed: IndexedTask,
  child: ChildEntry | null,
): SchedulerTaskStateV1 {
  return indexed.kernel
    ? stateForV2(indexed.kernel, child)
    : stateForLegacy(indexed, child);
}

function allDependencies(
  indexed: IndexedTask,
  child: ChildEntry | null,
  children: readonly ChildEntry[],
  selectedByChildId: Map<string, SelectedTask>,
  byId: Map<string, IndexedTask>,
): string[] {
  return sourceDependencies(indexed, child, children, selectedByChildId, byId);
}

function buildPlanningSnapshot(
  rootValue: string,
  parentRef: string,
  options: TaskMapScheduleOptionsV1,
): {
  parentDir: string;
  taskMapFingerprint: string;
  request: TaskScheduleRequestV1;
  lifecycle: TaskScheduleLifecycleSnapshotV1[];
} {
  const root = path.resolve(rootValue);
  const parentDir = resolveTaskDir(root, parentRef);
  const parentMap = readTaskMap(parentDir);
  if (!parentMap.data)
    throw new Error("Parent task-map.md is required for Task scheduling");
  const map = parentMap.data;
  if (map.execution_topology !== "parallel")
    throw new Error(
      "Parent execution_topology must be parallel for Task scheduling",
    );
  if (
    new Set(map.children.map((child) => child.id)).size !== map.children.length
  )
    throw new Error("Parent task-map.md contains duplicate Child IDs");

  const { byId, byDir } = indexTasks(root);
  const selectedByChildId = new Map<string, SelectedTask>();
  const selectedByTaskId = new Map<string, SelectedTask>();
  for (const child of map.children) {
    const dir = resolveTaskDir(root, child.id);
    const indexed = byDir.get(canonicalFilePath(dir));
    if (!indexed)
      throw new Error(`Parent Child task record is missing: ${child.id}`);
    if (selectedByTaskId.has(indexed.taskId))
      throw new Error(
        `Parent task-map maps multiple Children to Task ${indexed.taskId}`,
      );
    const selected: SelectedTask = {
      ...indexed,
      child,
      dependencies: [],
      notes: [],
    };
    selectedByChildId.set(child.id, selected);
    selectedByTaskId.set(indexed.taskId, selected);
  }
  for (const selected of selectedByTaskId.values()) {
    selected.dependencies = allDependencies(
      selected,
      selected.child,
      map.children,
      selectedByChildId,
      byId,
    );
  }
  const candidateTaskIds = options.candidateTaskIds
    ? new Set(options.candidateTaskIds)
    : new Set(selectedByTaskId.keys());
  if (
    options.candidateTaskIds &&
    candidateTaskIds.size !== options.candidateTaskIds.length
  )
    throw new Error("candidateTaskIds contains duplicates");
  const unknownCandidates = [...candidateTaskIds].filter(
    (id) => !selectedByTaskId.has(id),
  );
  if (unknownCandidates.length)
    throw new Error(
      `Schedule candidates are not Parent Children: ${unknownCandidates.sort(compareText).join(", ")}`,
    );

  const graphNodes = new Map<
    string,
    {
      indexed: IndexedTask;
      child: ChildEntry | null;
      dependencies: string[];
      notes: string[];
      external: boolean;
    }
  >();
  const visit = (
    taskId: string,
    selected: SelectedTask | undefined,
    visiting: Set<string>,
  ): void => {
    const existing = graphNodes.get(taskId);
    if (existing) return;
    if (visiting.has(taskId)) return;
    const indexed = selected ?? byId.get(taskId);
    if (!indexed) throw new Error(`Missing hard Task dependency: ${taskId}`);
    const child = selected?.child ?? null;
    const isCandidate = candidateTaskIds.has(taskId);
    const currentState = activeTaskState(indexed, child);
    const schedulerState =
      !isCandidate && currentState !== "completed"
        ? currentState === "failed"
          ? "failed"
          : currentState === "running"
            ? "running"
            : "blocked"
        : currentState;
    const isCompleted = schedulerState === "completed";
    const noteList = selected?.notes ?? [];
    const dependencies = isCompleted
      ? []
      : (selected?.dependencies ??
        allDependencies(indexed, null, map.children, selectedByChildId, byId));
    graphNodes.set(taskId, {
      indexed,
      child,
      dependencies,
      notes: noteList,
      external: !isCandidate,
    });
    const nextVisiting = new Set(visiting);
    nextVisiting.add(taskId);
    for (const dependencyId of dependencies) {
      const dependency = selectedByTaskId.get(dependencyId);
      visit(dependencyId, dependency, nextVisiting);
    }
  };
  for (const taskId of [...candidateTaskIds].sort(compareText)) {
    const selected = selectedByTaskId.get(taskId);
    if (selected) visit(taskId, selected, new Set());
  }

  const costOverrides = options.estimatedCosts ?? {};
  const unknownOverrides = Object.keys(costOverrides).filter(
    (id) => !candidateTaskIds.has(id),
  );
  if (unknownOverrides.length)
    throw new Error(
      `Cost estimates reference non-candidate Task IDs: ${unknownOverrides.sort(compareText).join(", ")}`,
    );
  const lifecycle: TaskScheduleLifecycleSnapshotV1[] = [];
  const tasks: TaskScheduleRequestV1["tasks"][number][] = [];
  for (const [taskId, graphNode] of [...graphNodes.entries()].sort(
    ([left], [right]) => compareText(left, right),
  )) {
    const { indexed, child, dependencies, notes, external } = graphNode;
    const schedulerState =
      external && activeTaskState(indexed, child) !== "completed"
        ? activeTaskState(indexed, child) === "failed"
          ? "failed"
          : "blocked"
        : activeTaskState(indexed, child);
    const projected = toSnapshot(
      root,
      indexed,
      child,
      parentMap.body,
      external ? undefined : costOverrides[taskId],
      dependencies,
      notes,
    );
    if (external && schedulerState !== "completed")
      projected.projectionNotes.push("external-hard-dependency-not-closed");
    projected.schedulerState = schedulerState;
    lifecycle.push(projected);
    const schedulerWriteSet = external ? null : projected.writeSet;
    const schedulerCosts = external ? emptyCosts() : projected.estimatedCosts;
    tasks.push({
      taskId,
      dependsOn: dependencies,
      state: schedulerState,
      writeSet: schedulerWriteSet,
      estimatedCosts: schedulerCosts,
      observedCosts: external
        ? {}
        : definedObservedCosts(projected.observedCosts),
    });
  }
  const request: TaskScheduleRequestV1 = {
    schemaVersion: 1,
    tasks,
    ...(options.conflictParallelizations
      ? { conflictParallelizations: options.conflictParallelizations }
      : {}),
    ...(options.jevAdvice ? { jevAdvice: options.jevAdvice } : {}),
  };
  return {
    parentDir,
    taskMapFingerprint: fingerprintTaskValue({
      data: map,
      body: parentMap.body,
    }),
    request,
    lifecycle,
  };
}

/** Projects a Parent task-map and its Task Kernel records into a deterministic DAG plan. */
export function planParentTaskScheduleV1(
  root: string,
  parentRef: string,
  options: TaskMapScheduleOptionsV1 = {},
): {
  request: TaskScheduleRequestV1;
  plan: TaskScheduleReceiptV1;
  lifecycle: TaskScheduleLifecycleSnapshotV1[];
  taskMapFingerprint: string;
} {
  const snapshot = buildPlanningSnapshot(root, parentRef, options);
  const plan = planTaskScheduleV1(snapshot.request);
  return {
    request: snapshot.request,
    plan,
    lifecycle: snapshot.lifecycle,
    taskMapFingerprint: snapshot.taskMapFingerprint,
  };
}

function receiptFingerprint(
  receipt: Omit<
    TaskScheduleDecisionReceiptV1,
    "schemaVersion" | "receiptFingerprint" | "createdAt"
  >,
): string {
  return fingerprintTaskValue(receipt);
}

function readExistingReceipt(
  file: string,
  fingerprint: string,
): TaskScheduleDecisionReceiptV1 {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid Task schedule receipt: ${file}`);
  const receipt = value as TaskScheduleDecisionReceiptV1;
  const {
    schemaVersion,
    receiptFingerprint: storedFingerprint,
    createdAt: _createdAt,
    ...base
  } = receipt;
  if (
    schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    storedFingerprint !== fingerprint ||
    fingerprintTaskValue(base) !== fingerprint
  ) {
    throw new Error(
      `Task schedule receipt fingerprint does not match its contents: ${file}`,
    );
  }
  return receipt;
}

function persistReceipt(
  parentDir: string,
  receiptBase: Omit<
    TaskScheduleDecisionReceiptV1,
    "schemaVersion" | "receiptFingerprint" | "createdAt"
  >,
): PersistedTaskScheduleV1 {
  const fingerprint = receiptFingerprint(receiptBase);
  const folder = path.join(parentDir, "scheduler", "receipts");
  const file = path.join(folder, `${fingerprint}.json`);
  fs.mkdirSync(folder, { recursive: true });
  if (fs.existsSync(file)) {
    return {
      receipt: readExistingReceipt(file, fingerprint),
      receiptFile: file,
      created: false,
    };
  }
  const receipt: TaskScheduleDecisionReceiptV1 = {
    ...receiptBase,
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    receiptFingerprint: fingerprint,
    createdAt: new Date().toISOString(),
  };
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    try {
      fs.copyFileSync(temporary, file, fs.constants.COPYFILE_EXCL);
      return { receipt, receiptFile: file, created: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return {
        receipt: readExistingReceipt(file, fingerprint),
        receiptFile: file,
        created: false,
      };
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Plans and stores a content-addressed, append-only decision receipt under the Parent Task. */
export function scheduleParentTaskGraph(
  rootValue: string,
  parentRef: string,
  options: TaskMapScheduleOptionsV1 = {},
): PersistedTaskScheduleV1 {
  const root = path.resolve(rootValue);
  const snapshot = buildPlanningSnapshot(root, parentRef, options);
  const plan = planTaskScheduleV1(snapshot.request);
  const receiptBase: Omit<
    TaskScheduleDecisionReceiptV1,
    "schemaVersion" | "receiptFingerprint" | "createdAt"
  > = {
    parentTaskDir: relativeTaskDir(root, snapshot.parentDir),
    taskMapFingerprint: snapshot.taskMapFingerprint,
    request: snapshot.request,
    plan,
    lifecycle: snapshot.lifecycle,
  };
  const stored = persistReceipt(snapshot.parentDir, receiptBase);
  return { ...stored, receiptFile: relativeTaskDir(root, stored.receiptFile) };
}

export type JevParentScheduleOptionsV1 = Omit<
  TaskMapScheduleOptionsV1,
  "jevAdvice"
>;

function firstCriticalPathCandidates(
  plan: TaskScheduleReceiptV1,
): JevScheduleCandidateV1[] {
  const firstWave = plan.waves[0];
  if (!firstWave) return [];
  const decisions = new Map(plan.decisions.map((item) => [item.taskId, item]));
  const candidates = firstWave.candidateTaskIds
    .map((taskId) => decisions.get(taskId))
    .filter(
      (decision): decision is NonNullable<typeof decision> =>
        !!decision && decision.action === "scheduled",
    );
  if (candidates.length < 2) return [];
  const highestCriticalPath = Math.max(
    ...candidates.map((candidate) => candidate.criticalPathMs),
  );
  return candidates
    .filter((candidate) => candidate.criticalPathMs === highestCriticalPath)
    .map((candidate) => ({
      taskId: candidate.taskId,
      criticalPathMs: candidate.criticalPathMs,
      estimatedCostMs: candidate.estimatedCostMs,
    }))
    .sort((left, right) => compareText(left.taskId, right.taskId));
}

function sameTaskIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((taskId, index) => taskId === right[index])
  );
}

function sameTaskIdSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((taskId) => right.includes(taskId))
  );
}

function eligibilityFingerprint(
  filteredCandidates: readonly JevScheduleCandidateFilterV1[],
  candidates: readonly JevScheduleCandidateV1[],
): string {
  return fingerprintTaskValue({
    candidateTaskIds: candidates.map(({ taskId }) => taskId),
    filteredCandidates: filteredCandidates.map(({ taskId, reasonCode }) => ({
      taskId,
      reasonCode,
    })),
  });
}

function verifyJevScheduleCandidates(
  root: string,
  snapshot: ReturnType<typeof buildPlanningSnapshot>,
  candidates: readonly JevScheduleCandidateV1[],
): {
  candidates: JevScheduleCandidateV1[];
  filteredCandidates: JevScheduleCandidateFilterV1[];
  approvalPassedTaskIds: string[];
  worktreePassedTaskIds: string[];
  activeLeaseCheckAt: string | null;
} {
  let activeLeases: ReturnType<typeof listProjectWriteLeases> | null = null;
  let activeLeaseCheckAt: string | null = null;
  try {
    activeLeases = withProjectSchedulerMutex(root, () =>
      listProjectWriteLeases(root),
    );
    activeLeaseCheckAt = new Date().toISOString();
  } catch {
    // An unreadable lease set is not safe input for an external advice request.
  }

  const byTaskId = new Map(
    snapshot.lifecycle.map((item) => [item.taskId, item]),
  );
  const eligible: JevScheduleCandidateV1[] = [];
  const filteredCandidates: JevScheduleCandidateFilterV1[] = [];
  const approvalPassedTaskIds: string[] = [];
  const worktreePassedTaskIds: string[] = [];
  for (const candidate of candidates) {
    const lifecycle = byTaskId.get(candidate.taskId);
    const taskRef = lifecycle?.taskMapChildId;
    if (!lifecycle || !taskRef) {
      filteredCandidates.push({
        taskId: candidate.taskId,
        reasonCode: "candidate-identity-unavailable",
      });
      continue;
    }
    let taskDir: string;
    try {
      taskDir = approvedTask(root, taskRef, "implement");
      approvalPassedTaskIds.push(candidate.taskId);
    } catch {
      filteredCandidates.push({
        taskId: candidate.taskId,
        reasonCode: "approval-rejected",
      });
      continue;
    }
    try {
      piWorkdir(root, taskDir, "implement");
      worktreePassedTaskIds.push(candidate.taskId);
    } catch {
      filteredCandidates.push({
        taskId: candidate.taskId,
        reasonCode: "worktree-rejected",
      });
      continue;
    }
    if (activeLeases === null) {
      filteredCandidates.push({
        taskId: candidate.taskId,
        reasonCode: "lease-state-unavailable",
      });
      continue;
    }
    const conflictsWithActiveLease = activeLeases.some(({ lease }) => {
      if (lifecycle.writeSet?.length === 0) return false;
      return projectWriteSetsConflict(lifecycle.writeSet ?? [], lease.touches);
    });
    if (conflictsWithActiveLease) {
      filteredCandidates.push({
        taskId: candidate.taskId,
        reasonCode: "active-write-lease-conflict",
      });
      continue;
    }
    eligible.push(candidate);
  }
  return {
    candidates: eligible,
    filteredCandidates,
    approvalPassedTaskIds,
    worktreePassedTaskIds,
    activeLeaseCheckAt,
  };
}

function scheduleSnapshotFingerprint(
  snapshot: ReturnType<typeof buildPlanningSnapshot>,
): string {
  return fingerprintTaskValue({
    taskMapFingerprint: snapshot.taskMapFingerprint,
    request: snapshot.request,
    lifecycle: snapshot.lifecycle,
  });
}

/**
 * Plans a Parent graph with an optional Jev tie-break after deterministic,
 * execution-approval, worktree, and active-lease checks. The API persists only
 * one final immutable schedule receipt; P37 admission must still recheck it.
 */
export async function scheduleParentTaskGraphWithJevV1(
  rootValue: string,
  parentRef: string,
  options: JevParentScheduleOptionsV1 = {},
  jev?: JevScheduleAdviceOptionsV1,
): Promise<PersistedTaskScheduleV1> {
  const root = path.resolve(rootValue);
  const planningOptions: TaskMapScheduleOptionsV1 = { ...options };
  delete planningOptions.jevAdvice;

  const previewSnapshot = buildPlanningSnapshot(
    root,
    parentRef,
    planningOptions,
  );
  const previewPlan = planTaskScheduleV1(previewSnapshot.request);
  const structuralCandidates = firstCriticalPathCandidates(previewPlan);
  let initialEligibility: ReturnType<typeof verifyJevScheduleCandidates> = {
    candidates: [],
    filteredCandidates: [],
    approvalPassedTaskIds: [],
    worktreePassedTaskIds: [],
    activeLeaseCheckAt: null,
  };
  let requested: Awaited<ReturnType<typeof requestJevTaskScheduleAdviceV1>>;

  if (structuralCandidates.length > 0) {
    initialEligibility = verifyJevScheduleCandidates(
      root,
      previewSnapshot,
      structuralCandidates,
    );
    requested = await requestJevTaskScheduleAdviceV1({
      candidates: initialEligibility.candidates,
      filteredCandidates: initialEligibility.filteredCandidates,
      eligibility: {
        approvalPassedTaskIds: initialEligibility.approvalPassedTaskIds,
        worktreePassedTaskIds: initialEligibility.worktreePassedTaskIds,
        activeLeaseCheckAt: initialEligibility.activeLeaseCheckAt,
      },
      options: jev,
    });
  } else {
    requested = await requestJevTaskScheduleAdviceV1({
      candidates: [],
      filteredCandidates: [],
      eligibility: {
        approvalPassedTaskIds: [],
        worktreePassedTaskIds: [],
        activeLeaseCheckAt: null,
      },
      options: jev,
    });
  }

  const finalSnapshot = buildPlanningSnapshot(root, parentRef, planningOptions);
  const finalStructuralCandidates = firstCriticalPathCandidates(
    planTaskScheduleV1(finalSnapshot.request),
  );
  const finalEligibility = verifyJevScheduleCandidates(
    root,
    finalSnapshot,
    finalStructuralCandidates,
  );
  let finalRequest = finalSnapshot.request;
  const advice = requested.advice;
  const requestStateStable =
    scheduleSnapshotFingerprint(previewSnapshot) ===
      scheduleSnapshotFingerprint(finalSnapshot) &&
    sameTaskIds(
      structuralCandidates.map(({ taskId }) => taskId),
      finalStructuralCandidates.map(({ taskId }) => taskId),
    ) &&
    eligibilityFingerprint(
      initialEligibility.filteredCandidates,
      initialEligibility.candidates,
    ) ===
      eligibilityFingerprint(
        finalEligibility.filteredCandidates,
        finalEligibility.candidates,
      );
  const adviceMatchesFinalCandidates =
    advice === null ||
    sameTaskIdSet(
      advice.taskOrder,
      finalEligibility.candidates.map(({ taskId }) => taskId),
    );
  const eligibilityChanged =
    !requestStateStable || !adviceMatchesFinalCandidates;
  let audit = finalizeJevTaskScheduleEligibilityV1(
    requested.audit,
    finalEligibility.candidates,
    finalEligibility.filteredCandidates,
    {
      approvalPassedTaskIds: finalEligibility.approvalPassedTaskIds,
      worktreePassedTaskIds: finalEligibility.worktreePassedTaskIds,
      activeLeaseCheckAt: finalEligibility.activeLeaseCheckAt,
    },
    eligibilityChanged,
  );

  if (advice) {
    if (!eligibilityChanged) {
      finalRequest = { ...finalSnapshot.request, jevAdvice: advice };
      audit = finalizeJevTaskScheduleAdviceV1(
        audit,
        planTaskScheduleV1(finalRequest),
      );
    } else {
      audit = supersedeJevTaskScheduleAdviceV1(audit);
    }
  }

  const plan = planTaskScheduleV1(finalRequest);
  const receiptBase: Omit<
    TaskScheduleDecisionReceiptV1,
    "schemaVersion" | "receiptFingerprint" | "createdAt"
  > = {
    parentTaskDir: relativeTaskDir(root, finalSnapshot.parentDir),
    taskMapFingerprint: finalSnapshot.taskMapFingerprint,
    request: finalRequest,
    plan,
    lifecycle: finalSnapshot.lifecycle,
    jevAdviceAudit: audit,
  };
  const stored = persistReceipt(finalSnapshot.parentDir, receiptBase);
  return { ...stored, receiptFile: relativeTaskDir(root, stored.receiptFile) };
}

function buildTaskKernelGraphSnapshot(
  rootValue: string,
  candidateTaskIds: readonly string[],
  options: TaskKernelScheduleOptionsV1,
): {
  candidateTaskIds: string[];
  request: TaskScheduleRequestV1;
  lifecycle: TaskScheduleLifecycleSnapshotV1[];
  taskKernelRevisions: Record<string, number>;
} {
  const root = path.resolve(rootValue);
  if (!candidateTaskIds.length)
    throw new Error("At least one V2 Task candidate is required");
  const candidateSet = new Set(candidateTaskIds);
  if (candidateSet.size !== candidateTaskIds.length)
    throw new Error("candidateTaskIds contains duplicates");

  const { byId, byArchivedId } = indexTaskKernelGraphTasks(root);
  const unknownCandidates = [...candidateSet].filter(
    (taskId) => !byId.has(taskId),
  );
  if (unknownCandidates.length)
    throw new Error(
      `Unknown Task candidates: ${unknownCandidates.sort(compareText).join(", ")}`,
    );
  for (const taskId of candidateSet) {
    const indexed = byId.get(taskId);
    if (indexed && isReconciliationIndexedTask(indexed))
      throw reconciliationFailure(indexed, "candidate");
    if (!indexed?.kernel)
      throw new Error(`Task candidate must use Task Kernel v2: ${taskId}`);
  }

  const graphNodes = new Map<
    string,
    { indexed: IndexedTask; dependencies: string[]; external: boolean }
  >();
  const visit = (
    taskId: string,
    external: boolean,
    visiting: Set<string>,
  ): void => {
    if (graphNodes.has(taskId)) return;
    if (visiting.has(taskId)) return;
    const activeIndexed = byId.get(taskId);
    const archivedIndexed = byArchivedId.get(taskId);
    const indexed = activeIndexed ?? archivedIndexed;
    if (!indexed) throw new Error(`Missing hard Task dependency: ${taskId}`);
    if (isReconciliationIndexedTask(indexed))
      throw reconciliationFailure(indexed, "dependency");
    if (!indexed.kernel)
      throw new Error(
        `Hard Task dependency must use Task Kernel v2: ${taskId}`,
      );
    const kernel = indexed.kernel;
    const completed =
      projectTaskKernelLifecycle(kernel).closed &&
      projectTaskKernelLifecycle(kernel).outcome === "completed";
    if (archivedIndexed && !completed)
      throw new Error(
        `Archived hard Task dependency is not closed with completed outcome: ${taskId}`,
      );
    const dependencies = completed ? [] : [...kernel.definition.dependencies];
    graphNodes.set(taskId, { indexed, dependencies, external });
    const nextVisiting = new Set(visiting);
    nextVisiting.add(taskId);
    for (const dependencyId of dependencies) {
      visit(dependencyId, !candidateSet.has(dependencyId), nextVisiting);
    }
  };
  for (const taskId of [...candidateSet].sort(compareText))
    visit(taskId, false, new Set());

  const overrides = options.estimatedCosts ?? {};
  const unknownOverrides = Object.keys(overrides).filter(
    (taskId) => !candidateSet.has(taskId),
  );
  if (unknownOverrides.length)
    throw new Error(
      `Cost estimates reference non-candidate Task IDs: ${unknownOverrides.sort(compareText).join(", ")}`,
    );

  const lifecycle: TaskScheduleLifecycleSnapshotV1[] = [];
  const tasks: TaskScheduleRequestV1["tasks"][number][] = [];
  const taskKernelRevisions: Record<string, number> = {};
  for (const [taskId, graphNode] of [...graphNodes.entries()].sort(
    ([left], [right]) => compareText(left, right),
  )) {
    const kernel = graphNode.indexed.kernel;
    if (!kernel)
      throw new Error(
        `Hard Task dependency must use Task Kernel v2: ${taskId}`,
      );
    const isClosed =
      projectTaskKernelLifecycle(kernel).closed &&
      projectTaskKernelLifecycle(kernel).outcome === "completed";
    const currentState = stateForTaskKernelCandidate(kernel);
    const schedulerState =
      graphNode.external && !isClosed
        ? currentState === "failed"
          ? "failed"
          : "blocked"
        : currentState;
    const notes =
      graphNode.external && !isClosed
        ? ["external-hard-dependency-not-closed"]
        : [];
    const projected = toSnapshot(
      root,
      graphNode.indexed,
      null,
      "",
      graphNode.external ? undefined : overrides[taskId],
      graphNode.dependencies,
      notes,
    );
    projected.schedulerState = schedulerState;
    if (
      !graphNode.external &&
      !kernel.runs.length &&
      schedulerState === "waiting"
    )
      projected.projectionNotes.push("task-ready-no-run-yet");
    lifecycle.push(projected);
    taskKernelRevisions[taskId] = kernel.revision;
    tasks.push({
      taskId,
      dependsOn: graphNode.dependencies,
      state: schedulerState,
      writeSet: graphNode.external ? null : projected.writeSet,
      estimatedCosts: graphNode.external
        ? emptyCosts()
        : projected.estimatedCosts,
      observedCosts: graphNode.external
        ? {}
        : definedObservedCosts(projected.observedCosts),
    });
  }
  return {
    candidateTaskIds: [...candidateSet].sort(compareText),
    request: {
      schemaVersion: 1,
      tasks,
      ...(options.conflictParallelizations
        ? { conflictParallelizations: options.conflictParallelizations }
        : {}),
      ...(options.jevAdvice ? { jevAdvice: options.jevAdvice } : {}),
    },
    lifecycle,
    taskKernelRevisions,
  };
}

/**
 * Plans a Task Kernel v2 dependency graph directly. It does not read or create
 * a Parent Task Map and never mutates Task or Run state.
 */
export function planTaskKernelGraphV1(
  root: string,
  candidateTaskIds: readonly string[],
  options: TaskKernelScheduleOptionsV1 = {},
): {
  candidateTaskIds: string[];
  request: TaskScheduleRequestV1;
  plan: TaskScheduleReceiptV1;
  lifecycle: TaskScheduleLifecycleSnapshotV1[];
  taskKernelRevisions: Record<string, number>;
} {
  const snapshot = buildTaskKernelGraphSnapshot(
    root,
    candidateTaskIds,
    options,
  );
  return { ...snapshot, plan: planTaskScheduleV1(snapshot.request) };
}

function taskKernelReceiptFingerprint(
  receipt: Omit<TaskKernelScheduleDecisionReceiptV1, "receiptFingerprint">,
): string {
  return fingerprintTaskValue(receipt);
}

function taskKernelScheduleRequestFingerprint(
  receipt: TaskKernelScheduleDecisionReceiptV1,
): string {
  const {
    schemaVersion: _schemaVersion,
    scope: _scope,
    receiptFingerprint: _receiptFingerprint,
    createdAt: _createdAt,
    integrityVersion: _integrityVersion,
    scheduleKey: _scheduleKey,
    ...request
  } = receipt;
  return fingerprintTaskValue(request);
}

function readExistingTaskKernelReceipt(
  file: string,
  fingerprint: string,
): TaskKernelScheduleDecisionReceiptV1 {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid Task Kernel schedule receipt: ${file}`);
  const receipt = value as TaskKernelScheduleDecisionReceiptV1;
  const {
    schemaVersion,
    scope,
    receiptFingerprint: storedFingerprint,
    createdAt,
    integrityVersion,
    ...legacyBase
  } = receipt;
  const { receiptFingerprint: _excludedFingerprint, ...fullEnvelope } = receipt;
  const legacyFingerprint =
    integrityVersion === undefined && fingerprintTaskValue(legacyBase) === fingerprint;
  const fullFingerprint =
    integrityVersion === 2 &&
    typeof createdAt === "string" &&
    fingerprintTaskValue(fullEnvelope) === fingerprint;
  if (
    schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    scope !== "task-kernel-v2" ||
    storedFingerprint !== fingerprint ||
    typeof createdAt !== "string" ||
    (!fullFingerprint && !legacyFingerprint)
  ) {
    throw new Error(
      `Task Kernel schedule receipt fingerprint does not match its contents: ${file}`,
    );
  }
  return receipt;
}

/** Reads a V2 schedule receipt and reports when a legacy digest excludes createdAt. */
export function readTaskKernelScheduleReceiptV1(
  rootValue: string,
  fingerprint: string,
): ReadTaskKernelScheduleReceiptV1 {
  if (!/^[a-f0-9]{64}$/u.test(fingerprint))
    throw new Error("Task Kernel schedule receipt fingerprint must be a lowercase SHA-256 digest");
  const file = path.join(
    path.resolve(rootValue),
    ".pactile",
    ".runtime",
    "scheduler",
    "receipts",
    `${fingerprint}.json`,
  );
  if (!fs.existsSync(file))
    throw new Error(`Task Kernel schedule receipt not found: ${fingerprint}`);
  const receipt = readExistingTaskKernelReceipt(file, fingerprint);
  return {
    receipt,
    integrity:
      receipt.integrityVersion === 2
        ? "fingerprint-verified"
        : "legacy-fingerprint-excludes-createdAt",
  };
}

function persistTaskKernelReceipt(
  root: string,
  receiptBase: Omit<
    TaskKernelScheduleDecisionReceiptV1,
    | "schemaVersion"
    | "scope"
    | "receiptFingerprint"
    | "createdAt"
    | "integrityVersion"
  >,
): PersistedTaskKernelScheduleV1 {
  const requestFingerprint = fingerprintTaskValue(receiptBase);
  const folder = path.join(root, ".pactile", ".runtime", "scheduler", "receipts");
  return withProjectSchedulerMutex(root, () => {
    fs.mkdirSync(folder, { recursive: true });
    const legacyFile = path.join(folder, `${requestFingerprint}.json`);
    if (fs.existsSync(legacyFile)) {
      const receipt = readExistingTaskKernelReceipt(legacyFile, requestFingerprint);
      if (taskKernelScheduleRequestFingerprint(receipt) !== requestFingerprint)
        throw new Error(`Task Kernel schedule receipt request does not match its content: ${legacyFile}`);
      return { receipt, receiptFile: legacyFile, created: false };
    }

    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const fingerprint = entry.name.slice(0, -".json".length);
      if (!/^[a-f0-9]{64}$/u.test(fingerprint)) continue;
      const file = path.join(folder, entry.name);
      let value: unknown;
      try {
        value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      } catch {
        continue;
      }
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (value as { scheduleKey?: unknown }).scheduleKey !== requestFingerprint
      )
        continue;
      const receipt = readExistingTaskKernelReceipt(file, fingerprint);
      if (taskKernelScheduleRequestFingerprint(receipt) !== requestFingerprint)
        throw new Error(`Task Kernel schedule receipt request does not match its content: ${file}`);
      if (receipt.integrityVersion === 2)
        return { receipt, receiptFile: file, created: false };
    }

    const unsignedReceipt: Omit<
      TaskKernelScheduleDecisionReceiptV1,
      "receiptFingerprint"
    > = {
      ...receiptBase,
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      scope: "task-kernel-v2",
      createdAt: new Date().toISOString(),
      integrityVersion: 2,
      scheduleKey: requestFingerprint,
    };
    const fingerprint = taskKernelReceiptFingerprint(unsignedReceipt);
    const file = path.join(folder, `${fingerprint}.json`);
    const receipt: TaskKernelScheduleDecisionReceiptV1 = {
      ...unsignedReceipt,
      receiptFingerprint: fingerprint,
    };
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      try {
        fs.copyFileSync(temporary, file, fs.constants.COPYFILE_EXCL);
        return { receipt, receiptFile: file, created: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        return {
          receipt: readExistingTaskKernelReceipt(file, fingerprint),
          receiptFile: file,
          created: false,
        };
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  });
}

/** Stores an idempotent Task/Run DAG decision receipt under project runtime state. */
export function scheduleTaskKernelGraph(
  rootValue: string,
  candidateTaskIds: readonly string[],
  options: TaskKernelScheduleOptionsV1 = {},
): PersistedTaskKernelScheduleV1 {
  const root = path.resolve(rootValue);
  const snapshot = buildTaskKernelGraphSnapshot(
    root,
    candidateTaskIds,
    options,
  );
  const receiptBase: Omit<
    TaskKernelScheduleDecisionReceiptV1,
    "schemaVersion" | "scope" | "receiptFingerprint" | "createdAt"
  > = {
    candidateTaskIds: snapshot.candidateTaskIds,
    taskKernelRevisions: snapshot.taskKernelRevisions,
    request: snapshot.request,
    plan: planTaskScheduleV1(snapshot.request),
    lifecycle: snapshot.lifecycle,
  };
  const stored = persistTaskKernelReceipt(root, receiptBase);
  return { ...stored, receiptFile: relativeTaskDir(root, stored.receiptFile) };
}
