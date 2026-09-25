/**
 * Task Kernel schema v2.
 *
 * One kernel.json remains the sole lifecycle authority. Version 2 stores a
 * deliverable Task together with append-only Run and Review records; version 1
 * remains readable through kernel-store.ts and is never migrated on read.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  KernelError,
  deriveStateForPhase,
  isKernelCondition,
  isKernelOutcome,
  isKernelPhase,
  isNonNegativeInt,
  requireNonEmptyString,
  type KernelAuditEvent,
  type KernelCondition,
  type KernelOutcome,
  type KernelPhase,
  type KernelState,
} from "./kernel-contract.js";
import {
  readKernel,
  readKernelStateDocument,
  withKernelStateLock,
  writeKernelStateDocument,
} from "./kernel-store.js";
import { isPlainObject } from "./schema.js";

export const TASK_KERNEL_SCHEMA_VERSION = 2 as const;

export const TASK_DELIVERY_LEVELS = [
  "local-result",
  "pull-request",
  "merged-result",
  "documentation",
] as const;
export type TaskDeliveryLevel = (typeof TASK_DELIVERY_LEVELS)[number];

export interface TaskAcceptanceCriterion {
  id: string;
  description: string;
}

export interface TaskDefinitionV2 {
  taskId: string;
  title: string;
  description: string;
  deliverable: string;
  deliveryLevel: TaskDeliveryLevel;
  acceptanceCriteria: TaskAcceptanceCriterion[];
  /** Every dependency is a hard requirement and must be closed successfully. */
  dependencies: string[];
  createdAt: string;
  createdBy: string;
}

export interface TaskSnapshotEntry {
  ref: string;
  fingerprint: string;
}

export interface TaskCandidateSnapshot {
  id: string;
  entries: TaskSnapshotEntry[];
  fingerprint: string;
}

/** Caller-supplied observation of the candidate at Close time. The Kernel checks
 * identity/fingerprint agreement, but does not inspect Git or filesystem bytes. */
export interface TaskCandidateObservation {
  snapshotId: string;
  fingerprint: string;
  observedBy: string;
  observedAt: string;
  source: string;
  evidenceRef: string;
}

export interface TaskRunInput {
  summary: string;
  references: string[];
  fingerprint: string;
}

export interface TaskRunAuthorization {
  approvedBy: string;
  approvedAt: string;
  scope: string;
  evidenceRef: string;
}

export type TaskRunState = "waiting" | "running" | "completed" | "failed" | "blocked";

export interface TaskRunDurations {
  executionMs: number | null;
  waitingMs: number | null;
  reviewMs: number | null;
}

export interface TaskRunMeasurementRefs {
  execution: string | null;
  waiting: string | null;
  review: string | null;
}

export interface TaskRunResult {
  summary: string;
  evidenceRefs: string[];
}

export interface TaskRunFailure {
  category: string;
  message: string;
  evidenceRef: string | null;
}

/** Optional workspace facts reserved for a Run-owned checkout lifecycle. */
export interface TaskRunWorkspaceBinding {
  ownerRunId: string;
  canonicalPath: string;
  branch: string;
  baseSha: string;
  writeSet: string[];
  integrationState: "not-integrated" | "integrated";
  reclamationState: "not-requested" | "pending" | "reclaimed" | "failed";
}

/** Optional host receipt binding; the Task Kernel itself remains host-neutral. */
export interface TaskRunHostBinding {
  host: string;
  role: string;
  sessionId: string | null;
  threadId: string | null;
  kernelRevision: number;
  contractFingerprint: string;
  requestRefs: string[];
  eventRefs: string[];
  resultRefs: string[];
  assuranceSource: string | null;
}

export interface TaskRunV2 {
  id: string;
  taskId: string;
  /** One-based retry/attempt count, stable for this Run for its lifetime. */
  attempt: number;
  sequence: number;
  state: TaskRunState;
  startedAt: string;
  startedBy: string;
  input: TaskRunInput;
  authorization: TaskRunAuthorization;
  writeSetSnapshot: string[];
  estimatedDurations: TaskRunDurations;
  measurementRefs: TaskRunMeasurementRefs;
  workspace: TaskRunWorkspaceBinding | null;
  host: TaskRunHostBinding | null;
  candidateSnapshot: TaskCandidateSnapshot | null;
  result: TaskRunResult | null;
  failure: TaskRunFailure | null;
  completedAt: string | null;
}

export type TaskReviewDecision = "pass" | "fail" | "needs-changes";

export interface TaskReviewV2 {
  id: string;
  taskId: string;
  runId: string;
  candidateSnapshotId: string;
  candidateFingerprint: string;
  reviewer: string;
  independent: true;
  decision: TaskReviewDecision;
  evidenceRefs: string[];
  acceptanceEvidence: Record<string, string[]>;
  unresolvedBlockers: string[];
  reviewedAt: string;
}

export interface TaskDeliveryEvidence {
  level: TaskDeliveryLevel;
  reference: string;
  summary: string;
}

export interface TaskClosureV2 {
  runId: string;
  reviewId: string;
  candidateSnapshotId: string;
  candidateFingerprint: string;
  candidateObservation: TaskCandidateObservation;
  deliveryEvidence: TaskDeliveryEvidence;
  acceptanceEvidence: Record<string, string[]>;
  closedAt: string;
  closedBy: string;
}

export type TaskKernelEventType =
  | "task.created"
  | "task.dependency-added"
  | "run.queued"
  | "run.started"
  | "run.resumed"
  | "run.completed"
  | "run.failed"
  | "run.blocked"
  | "review.recorded"
  | "task.closed";

export interface TaskKernelEventV2 {
  id: string;
  revision: number;
  at: string;
  actor: string;
  idempotencyKey: string;
  type: TaskKernelEventType;
  entityId: string;
  requestFingerprint: string;
}

export interface TaskKernelSnapshotV2 {
  schemaVersion: typeof TASK_KERNEL_SCHEMA_VERSION;
  identity: { taskId: string };
  revision: number;
  phase: KernelPhase;
  condition: KernelCondition;
  outcome: KernelOutcome | null;
  definition: TaskDefinitionV2;
  runs: TaskRunV2[];
  reviews: TaskReviewV2[];
  closure: TaskClosureV2 | null;
  audit: KernelAuditEvent[];
  events: TaskKernelEventV2[];
}

export interface TaskKernelMutationResult {
  kernel: TaskKernelSnapshotV2;
  idempotent: boolean;
  audit: KernelAuditEvent;
  event: TaskKernelEventV2;
}

export interface CreateTaskKernelRequest {
  root: string;
  taskDir: string;
  definition: Omit<TaskDefinitionV2, "createdAt" | "createdBy">;
  actor: string;
  idempotencyKey: string;
  cwd?: string;
}

export interface AddTaskDependencyRequest {
  root: string;
  taskDir: string;
  expectedRevision: number;
  dependencyId: string;
  actor: string;
  idempotencyKey: string;
  cwd?: string;
}

export interface StartTaskRunRequest {
  root: string;
  taskDir: string;
  expectedRevision: number;
  actor: string;
  idempotencyKey: string;
  input: Omit<TaskRunInput, "fingerprint">;
  authorization: TaskRunAuthorization;
  initialState?: "waiting" | "running";
  writeSetSnapshot?: string[];
  estimatedDurations?: Partial<TaskRunDurations>;
  workspace?: Omit<TaskRunWorkspaceBinding, "ownerRunId">;
  host?: Omit<TaskRunHostBinding, "kernelRevision" | "contractFingerprint"> & {
    kernelRevision?: number;
    contractFingerprint?: string;
  };
  cwd?: string;
}

export interface RecordTaskRunResultRequest {
  root: string;
  taskDir: string;
  expectedRevision: number;
  runId: string;
  outcome: "completed" | "failed" | "blocked";
  summary?: string;
  evidenceRefs?: string[];
  candidateEntries?: TaskSnapshotEntry[];
  measurementRefs?: Partial<TaskRunMeasurementRefs>;
  failure?: Omit<TaskRunFailure, "evidenceRef"> & { evidenceRef?: string | null };
  actor: string;
  idempotencyKey: string;
  cwd?: string;
}

export interface RecordTaskReviewRequest {
  root: string;
  taskDir: string;
  expectedRevision: number;
  runId: string;
  candidateSnapshotId: string;
  candidateFingerprint: string;
  reviewer: string;
  decision: TaskReviewDecision;
  evidenceRefs: string[];
  acceptanceEvidence?: Record<string, string[]>;
  unresolvedBlockers?: string[];
  measurementRef?: string;
  actor: string;
  idempotencyKey: string;
  cwd?: string;
}

export interface CloseTaskKernelRequest {
  root: string;
  taskDir: string;
  expectedRevision: number;
  runId: string;
  reviewId: string;
  candidateObservation: TaskCandidateObservation;
  deliveryEvidence: TaskDeliveryEvidence;
  actor: string;
  idempotencyKey: string;
  cwd?: string;
}

export type CheckTaskCloseRequest = Omit<CloseTaskKernelRequest, "idempotencyKey" | "actor">;

export interface TaskKernelReadResult {
  kind: "task-kernel-v2";
  kernel: TaskKernelSnapshotV2;
}

export interface LegacyTaskKernelReadResult {
  kind: "legacy-task-kernel-v1";
  kernel: ReturnType<typeof readKernel>;
}

export type AnyTaskKernelReadResult = TaskKernelReadResult | LegacyTaskKernelReadResult;

function requireArrayEntry<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new KernelError("CORRUPT_STATE", `${field} is missing`);
  return value;
}

export interface TaskKernelLifecycleProjection {
  taskId: string;
  revision: number;
  phase: KernelPhase;
  condition: KernelCondition;
  outcome: KernelOutcome | null;
  deliveryLevel: TaskDeliveryLevel;
  dependencies: string[];
  closed: boolean;
  approvalSnapshot: {
    recorded: boolean;
    runId: string | null;
    approvedBy: string | null;
    approvedAt: string | null;
    scope: string | null;
    evidenceRef: string | null;
  };
  /** Read-only facts at `revision`; authorization and dependency outcomes still
   * have to be checked by the Kernel mutation that consumes them. */
  gateSnapshot: {
    kernelRevision: number;
    runStart: {
      phaseAllowsRun: boolean;
      activeRunId: string | null;
      hardDependencies: string[];
      dependencyKernelCheckRequired: boolean;
    };
    review: {
      phaseAllowsReview: boolean;
      runId: string | null;
      candidateSnapshotId: string | null;
      latestReviewId: string | null;
      latestDecision: TaskReviewDecision | null;
      unresolvedBlockers: string[];
    };
    close: {
      phaseAllowsClose: boolean;
      runId: string | null;
      reviewId: string | null;
      candidateSnapshotId: string | null;
      candidateFingerprint: string | null;
      missingAcceptanceCriteria: string[];
      unresolvedBlockers: string[];
      currentCandidateObservationRequired: true;
      deliveryEvidenceRequired: true;
    };
  };
}

const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const TASK_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RUN_STATES: readonly TaskRunState[] = ["waiting", "running", "completed", "failed", "blocked"];
const REVIEW_DECISIONS: readonly TaskReviewDecision[] = ["pass", "fail", "needs-changes"];
const EVENT_TYPES: readonly TaskKernelEventType[] = [
  "task.created", "task.dependency-added", "run.queued", "run.started", "run.resumed", "run.completed",
  "run.failed", "run.blocked", "review.recorded", "task.closed",
];

export function isTaskDeliveryLevel(value: unknown): value is TaskDeliveryLevel {
  return typeof value === "string" && (TASK_DELIVERY_LEVELS as readonly string[]).includes(value);
}

export function fingerprintTaskValue(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function createTaskCandidateSnapshot(entries: readonly TaskSnapshotEntry[]): TaskCandidateSnapshot {
  const parsed = parseSnapshotEntries(entries, "candidateEntries");
  if (!parsed.length) throw new KernelError("INVALID_REQUEST", "a completed Run requires at least one candidate snapshot entry");
  return { id: randomUUID(), entries: parsed, fingerprint: fingerprintTaskValue(parsed) };
}

/** Pure V2 lifecycle projection for consumers that need replayable gate facts without mutation. */
export function projectTaskKernelLifecycle(kernel: TaskKernelSnapshotV2): TaskKernelLifecycleProjection {
  const latestRun = kernel.runs.at(-1) ?? null;
  const candidate = latestRun?.candidateSnapshot ?? null;
  const latestReview = latestRun && candidate
    ? kernel.reviews.filter((review) => review.runId === latestRun.id && review.candidateSnapshotId === candidate.id && review.candidateFingerprint === candidate.fingerprint).at(-1) ?? null
    : null;
  const missingAcceptanceCriteria = latestReview
    ? kernel.definition.acceptanceCriteria.filter((criterion) => !getOwnRecordValue(latestReview.acceptanceEvidence, criterion.id)?.length).map((criterion) => criterion.id)
    : kernel.definition.acceptanceCriteria.map((criterion) => criterion.id);
  const activeRun = kernel.runs.find((run) => run.state === "running" || run.state === "waiting") ?? null;
  return {
    taskId: kernel.identity.taskId,
    revision: kernel.revision,
    phase: kernel.phase,
    condition: kernel.condition,
    outcome: kernel.outcome,
    deliveryLevel: kernel.definition.deliveryLevel,
    dependencies: [...kernel.definition.dependencies],
    closed: kernel.phase === "close" && kernel.closure !== null,
    approvalSnapshot: latestRun ? {
      recorded: true,
      runId: latestRun.id,
      approvedBy: latestRun.authorization.approvedBy,
      approvedAt: latestRun.authorization.approvedAt,
      scope: latestRun.authorization.scope,
      evidenceRef: latestRun.authorization.evidenceRef,
    } : {
      recorded: false, runId: null, approvedBy: null, approvedAt: null, scope: null, evidenceRef: null,
    },
    gateSnapshot: {
      kernelRevision: kernel.revision,
      runStart: {
        phaseAllowsRun: ["define", "approve", "execute", "verify"].includes(kernel.phase),
        activeRunId: activeRun?.id ?? null,
        hardDependencies: [...kernel.definition.dependencies],
        dependencyKernelCheckRequired: kernel.definition.dependencies.length > 0,
      },
      review: {
        phaseAllowsReview: kernel.phase === "verify" && latestRun?.state === "completed" && candidate !== null,
        runId: latestRun?.id ?? null,
        candidateSnapshotId: candidate?.id ?? null,
        latestReviewId: latestReview?.id ?? null,
        latestDecision: latestReview?.decision ?? null,
        unresolvedBlockers: [...(latestReview?.unresolvedBlockers ?? [])],
      },
      close: {
        phaseAllowsClose: kernel.phase === "verify" && latestRun?.state === "completed" && candidate !== null && latestReview?.decision === "pass",
        runId: latestRun?.id ?? null,
        reviewId: latestReview?.id ?? null,
        candidateSnapshotId: candidate?.id ?? null,
        candidateFingerprint: candidate?.fingerprint ?? null,
        missingAcceptanceCriteria,
        unresolvedBlockers: [...(latestReview?.unresolvedBlockers ?? [])],
        currentCandidateObservationRequired: true,
        deliveryEvidenceRequired: true,
      },
    },
  };
}

export function parseTaskKernelSnapshotV2(input: unknown): TaskKernelSnapshotV2 {
  if (!isPlainObject(input) || input.schemaVersion !== TASK_KERNEL_SCHEMA_VERSION) {
    throw new KernelError("CORRUPT_STATE", "kernel is not a Task Kernel schema v2 snapshot");
  }
  const identity = parseObject(input.identity, "kernel.identity");
  const taskId = requireTaskId(identity.taskId, "kernel.identity.taskId");
  const definition = parseDefinition(input.definition, "kernel.definition");
  if (definition.taskId !== taskId) throw new KernelError("CORRUPT_STATE", "kernel identity and Task definition IDs differ");
  if (!isNonNegativeInt(input.revision)) throw new KernelError("CORRUPT_STATE", "kernel.revision must be a non-negative integer");
  if (!isKernelPhase(input.phase)) throw new KernelError("CORRUPT_STATE", "kernel.phase is invalid");
  if (!isKernelCondition(input.condition)) throw new KernelError("CORRUPT_STATE", "kernel.condition is invalid");
  if (input.outcome !== null && !isKernelOutcome(input.outcome)) throw new KernelError("CORRUPT_STATE", "kernel.outcome is invalid");
  if (!Array.isArray(input.runs) || !Array.isArray(input.reviews) || !Array.isArray(input.audit) || !Array.isArray(input.events)) {
    throw new KernelError("CORRUPT_STATE", "kernel runs, reviews, audit, and events must be arrays");
  }
  const runs = input.runs.map((value, index) => parseRun(value, `kernel.runs[${index}]`));
  const reviews = input.reviews.map((value, index) => parseReview(value, `kernel.reviews[${index}]`));
  const audit = input.audit.map((value, index) => parseKernelAudit(value, index));
  const events = input.events.map((value, index) => parseEvent(value, index));
  const runIds = new Set<string>();
  for (const run of runs) {
    if (run.taskId !== taskId || runIds.has(run.id)) throw new KernelError("CORRUPT_STATE", "Run identity is duplicated or belongs to another Task");
    runIds.add(run.id);
  }
  const reviewIds = new Set<string>();
  for (const review of reviews) {
    if (review.taskId !== taskId || !runIds.has(review.runId) || reviewIds.has(review.id)) {
      throw new KernelError("CORRUPT_STATE", "Review identity is duplicated or references another Task or missing Run");
    }
    const run = runs.find((candidate) => candidate.id === review.runId);
    if (review.candidateSnapshotId !== run?.candidateSnapshot?.id || review.candidateFingerprint !== run.candidateSnapshot.fingerprint) {
      throw new KernelError("CORRUPT_STATE", "Review is not bound to its Run candidate snapshot");
    }
    if (review.decision === "pass" && review.unresolvedBlockers.length) throw new KernelError("CORRUPT_STATE", "passing Review cannot contain unresolved blockers");
    reviewIds.add(review.id);
  }
  const closure = input.closure === null ? null : parseClosure(input.closure, "kernel.closure");
  if (closure && (!runIds.has(closure.runId) || !reviewIds.has(closure.reviewId))) {
    throw new KernelError("CORRUPT_STATE", "Task closure references a missing Run or Review");
  }
  if (closure) {
    const run = runs.find((candidate) => candidate.id === closure.runId);
    const review = reviews.find((candidate) => candidate.id === closure.reviewId);
    if (!run || !review || !run.candidateSnapshot) throw new KernelError("CORRUPT_STATE", "Task closure references an incomplete Run or Review");
    if (closure.candidateSnapshotId !== run.candidateSnapshot.id || closure.candidateFingerprint !== run.candidateSnapshot.fingerprint || review.runId !== run.id || review.candidateSnapshotId !== closure.candidateSnapshotId || review.candidateFingerprint !== closure.candidateFingerprint) {
      throw new KernelError("CORRUPT_STATE", "Task closure is not bound to its Run and Review candidate snapshot");
    }
    if (closure.candidateObservation.snapshotId !== closure.candidateSnapshotId || closure.candidateObservation.fingerprint !== closure.candidateFingerprint) {
      throw new KernelError("CORRUPT_STATE", "Task closure candidate observation does not match the accepted candidate");
    }
  }
  validateAuditChain(audit, input.revision);
  validateEvents(events, input.revision);
  return {
    schemaVersion: TASK_KERNEL_SCHEMA_VERSION,
    identity: { taskId },
    revision: input.revision,
    phase: input.phase,
    condition: input.condition,
    outcome: input.outcome as KernelOutcome | null,
    definition,
    runs,
    reviews,
    closure,
    audit,
    events,
  };
}

export function readTaskKernel(options: { root: string; taskDir: string; cwd?: string }): AnyTaskKernelReadResult {
  const root = canonicalProjectRoot(options.root, options.cwd);
  const taskDir = resolveInsideTasksRoot(root, options.taskDir, options.cwd);
  const document = withKernelStateLock(taskDir, options.cwd, (dir) => readKernelStateDocument(dir));
  if (isPlainObject(document) && document.schemaVersion === TASK_KERNEL_SCHEMA_VERSION) {
    return {
      kind: "task-kernel-v2",
      kernel: parseTaskKernelSnapshotV2(document),
    };
  }
  return {
    kind: "legacy-task-kernel-v1",
    kernel: readKernel({ taskDir, cwd: options.cwd }),
  };
}

export function createTaskKernel(request: CreateTaskKernelRequest): TaskKernelMutationResult {
  const root = canonicalProjectRoot(request.root, request.cwd);
  const actor = requireNonEmptyString(request.actor, "actor");
  const idempotencyKey = requireNonEmptyString(request.idempotencyKey, "idempotencyKey");
  const taskDir = resolveInsideTaskRoot(root, request.taskDir, request.cwd);
  const createdAt = new Date().toISOString();
  const definition = parseDefinition({ ...request.definition, createdAt, createdBy: actor }, "definition");
  const requestFingerprint = fingerprintTaskValue({ definition: request.definition, actor });
  return withKernelStateLock(taskDir, request.cwd, (dir) => {
    const existing = readKernelStateDocument(dir);
    if (existing !== null) {
      if (!isPlainObject(existing) || existing.schemaVersion !== TASK_KERNEL_SCHEMA_VERSION) {
        throw new KernelError("INVALID_REQUEST", "legacy Kernel data exists; Task Kernel v2 will not migrate or overwrite it");
      }
      const kernel = parseTaskKernelSnapshotV2(existing);
      const prior = findIdempotent(kernel, idempotencyKey, requestFingerprint);
      if (prior) return { kernel, idempotent: true, audit: findAuditForKey(kernel, idempotencyKey), event: prior };
      throw new KernelError("INVALID_REQUEST", `kernel.json already exists for ${kernel.identity.taskId}`);
    }
    const taskJson = path.join(dir, "task.json");
    if (fs.existsSync(taskJson)) throw new KernelError("INVALID_REQUEST", "legacy task.json exists; Task Kernel v2 will not migrate or overwrite it");
    assertUniqueTaskId(root, definition.taskId, dir);
    assertDependenciesResolvable(root, definition.taskId, definition.dependencies, dir);
    assertNoDependencyCycle(root, definition.taskId, definition.dependencies, dir);
    const state = deriveStateForPhase("define");
    const audit = makeAudit(state, 0, state, 1, actor, idempotencyKey, "Task defined.");
    const event = makeEvent(1, actor, idempotencyKey, "task.created", definition.taskId, requestFingerprint);
    const kernel: TaskKernelSnapshotV2 = {
      schemaVersion: TASK_KERNEL_SCHEMA_VERSION,
      identity: { taskId: definition.taskId },
      revision: 1,
      ...state,
      definition,
      runs: [],
      reviews: [],
      closure: null,
      audit: [audit],
      events: [event],
    };
    writeKernelStateDocument(dir, kernel);
    return { kernel, idempotent: false, audit, event };
  });
}

export function addTaskDependency(request: AddTaskDependencyRequest): TaskKernelMutationResult {
  const root = canonicalProjectRoot(request.root, request.cwd);
  const actor = requireNonEmptyString(request.actor, "actor");
  const dependencyId = requireTaskId(request.dependencyId, "dependencyId");
  const fingerprint = fingerprintTaskValue({ dependencyId });
  return mutateTaskKernel(root, request.taskDir, request.expectedRevision, actor, request.idempotencyKey, fingerprint, request.cwd, (current, dir) => {
    if (current.phase !== "define") throw new KernelError("INVALID_TRANSITION", "hard dependencies can be changed only while Task is in Define");
    if (dependencyId === current.identity.taskId) throw new KernelError("INVALID_REQUEST", "a Task cannot depend on itself");
    if (current.definition.dependencies.includes(dependencyId)) throw new KernelError("INVALID_REQUEST", `hard dependency already exists: ${dependencyId}`);
    assertDependenciesResolvable(root, current.identity.taskId, [dependencyId], dir);
    const dependencies = [...current.definition.dependencies, dependencyId];
    assertNoDependencyCycle(root, current.identity.taskId, dependencies, dir);
    const definition = { ...current.definition, dependencies };
    return appendMutation(current, actor, request.idempotencyKey, "task.dependency-added", dependencyId, fingerprint, { definition }, "Hard dependency added.");
  });
}

export function startTaskRun(request: StartTaskRunRequest): TaskKernelMutationResult {
  const root = canonicalProjectRoot(request.root, request.cwd);
  const actor = requireNonEmptyString(request.actor, "actor");
  const fingerprint = fingerprintTaskValue({ actor, input: request.input, authorization: request.authorization, initialState: request.initialState ?? "running", writeSetSnapshot: request.writeSetSnapshot ?? request.workspace?.writeSet ?? [], estimatedDurations: request.estimatedDurations ?? null, workspace: request.workspace ?? null, host: request.host ?? null });
  return mutateTaskKernel(root, request.taskDir, request.expectedRevision, actor, request.idempotencyKey, fingerprint, request.cwd, (current, dir) => {
    if (current.closure || current.phase === "close") throw new KernelError("INVALID_TRANSITION", "closed Tasks cannot start another Run");
    if (current.runs.some((run) => run.state === "running" || run.state === "waiting")) throw new KernelError("INVALID_TRANSITION", "Task already has an active or waiting Run");
    assertHardDependenciesSatisfied(root, current.definition.dependencies, dir);
    const input = parseRunInput(request.input, "input");
    const authorization = parseAuthorization(request.authorization, "authorization");
    const initialState = request.initialState ?? "running";
    if (initialState !== "running" && initialState !== "waiting") throw new KernelError("INVALID_REQUEST", "initialState must be running or waiting");
    const writeSetSnapshot = parseStringArray(request.writeSetSnapshot ?? request.workspace?.writeSet ?? [], "writeSetSnapshot", true);
    const estimatedDurations = parseDurations(request.estimatedDurations ?? {}, "estimatedDurations");
    const id = randomUUID();
    const workspace = request.workspace ? parseWorkspaceBinding({ ...request.workspace, ownerRunId: id }, id, "workspace") : null;
    const host = request.host ? parseHostBinding({
      ...request.host,
      kernelRevision: request.expectedRevision,
      contractFingerprint: fingerprintTaskValue(current.definition),
    }, "host") : null;
    const run: TaskRunV2 = {
      id, taskId: current.identity.taskId, attempt: current.runs.length + 1, sequence: current.runs.length + 1,
      state: initialState, startedAt: new Date().toISOString(), startedBy: actor,
      input, authorization, workspace, host, candidateSnapshot: null, result: null, failure: null, completedAt: null,
      writeSetSnapshot, estimatedDurations,
      measurementRefs: { execution: null, waiting: null, review: null },
    };
    let kernel = current;
    if (kernel.phase === "define") kernel = appendPhase(kernel, "approve", actor, `${request.idempotencyKey}#approve`, "Run authorization recorded.");
    if (kernel.phase === "approve" || kernel.phase === "verify") kernel = appendPhase(kernel, "execute", actor, `${request.idempotencyKey}#execute`, "Run started.");
    else if (kernel.phase === "execute") kernel = appendPhase(kernel, "execute", actor, `${request.idempotencyKey}#execute`, "Run started.");
    else throw new KernelError("INVALID_TRANSITION", `cannot start a Run from Kernel phase ${kernel.phase}`);
    const next = { ...kernel, condition: initialState === "waiting" ? "waiting" as const : "active" as const, runs: [...kernel.runs, run] };
    return appendDomainEvent(next, actor, request.idempotencyKey, initialState === "waiting" ? "run.queued" : "run.started", run.id, fingerprint);
  });
}

export interface ResumeTaskRunRequest {
  root: string;
  taskDir: string;
  expectedRevision: number;
  runId: string;
  actor: string;
  idempotencyKey: string;
  cwd?: string;
}

export function resumeTaskRun(request: ResumeTaskRunRequest): TaskKernelMutationResult {
  const root = canonicalProjectRoot(request.root, request.cwd);
  const actor = requireNonEmptyString(request.actor, "actor");
  const fingerprint = fingerprintTaskValue({ runId: request.runId, action: "resume" });
  return mutateTaskKernel(root, request.taskDir, request.expectedRevision, actor, request.idempotencyKey, fingerprint, request.cwd, (current) => {
    if (current.phase !== "execute") throw new KernelError("INVALID_TRANSITION", `Run resume requires Execute phase, got ${current.phase}`);
    const index = current.runs.findIndex((run) => run.id === request.runId);
    if (index < 0) throw new KernelError("NOT_FOUND", `Run not found: ${request.runId}`);
    const prior = requireArrayEntry(current.runs[index], "Run");
    if (prior.state !== "waiting" || current.runs.at(-1)?.id !== prior.id) throw new KernelError("INVALID_TRANSITION", "only the latest waiting Run can resume");
    if (current.runs.some((run) => run.id !== prior.id && run.state === "running")) throw new KernelError("INVALID_TRANSITION", "another Run is already running");
    const run = { ...prior, state: "running" as const };
    const kernel = { ...current, condition: "active" as const, runs: current.runs.map((item, i) => i === index ? run : item) };
    return appendDomainEvent(kernel, actor, request.idempotencyKey, "run.resumed", run.id, fingerprint);
  });
}

export function recordTaskRunResult(request: RecordTaskRunResultRequest): TaskKernelMutationResult {
  const root = canonicalProjectRoot(request.root, request.cwd);
  const actor = requireNonEmptyString(request.actor, "actor");
  if (!(new Set(["completed", "failed", "blocked"]).has(request.outcome))) throw new KernelError("INVALID_REQUEST", "Run outcome must be completed, failed, or blocked");
  const fingerprint = fingerprintTaskValue({
    runId: request.runId, outcome: request.outcome, summary: request.summary ?? "",
    evidenceRefs: request.evidenceRefs ?? [], candidateEntries: request.candidateEntries ?? [], failure: request.failure ?? null, measurementRefs: request.measurementRefs ?? {},
  });
  return mutateTaskKernel(root, request.taskDir, request.expectedRevision, actor, request.idempotencyKey, fingerprint, request.cwd, (current) => {
    const index = current.runs.findIndex((run) => run.id === request.runId);
    if (index < 0) throw new KernelError("NOT_FOUND", `Run not found: ${request.runId}`);
    const prior = requireArrayEntry(current.runs[index], "Run");
    if (prior.state !== "running") throw new KernelError("INVALID_TRANSITION", `Run ${prior.id} is already ${prior.state}`);
    if (current.phase !== "execute") throw new KernelError("INVALID_TRANSITION", `Run result cannot be recorded during ${current.phase}`);
    const now = new Date().toISOString();
    const evidenceRefs = parseStringArray(request.evidenceRefs ?? [], "evidenceRefs", true);
    const measurementRefs = parseMeasurementRefs({ ...prior.measurementRefs, ...request.measurementRefs }, "measurementRefs");
    let run: TaskRunV2;
    let condition: KernelCondition;
    if (request.outcome === "completed") {
      if (request.failure) throw new KernelError("INVALID_REQUEST", "a completed Run cannot carry failure details");
      const summary = requireNonEmptyString(request.summary, "summary");
      const candidateSnapshot = createTaskCandidateSnapshot(request.candidateEntries ?? []);
      run = { ...prior, state: "completed", candidateSnapshot, result: { summary, evidenceRefs }, failure: null, completedAt: now, measurementRefs };
      condition = "waiting";
    } else {
      if (!request.failure) throw new KernelError("INVALID_REQUEST", `${request.outcome} Run requires failure.category and failure.message`);
      const failure = parseFailure(request.failure, "failure");
      run = {
        ...prior, state: request.outcome, candidateSnapshot: request.candidateEntries?.length ? createTaskCandidateSnapshot(request.candidateEntries) : null,
        result: request.summary?.trim() ? { summary: request.summary.trim(), evidenceRefs } : null,
        failure, completedAt: now, measurementRefs,
      };
      condition = request.outcome === "blocked" ? "blocked" : "ready";
    }
    let kernel: TaskKernelSnapshotV2 = { ...current, runs: current.runs.map((item, i) => i === index ? run : item) };
    if (request.outcome === "completed") kernel = appendPhase(kernel, "verify", actor, `${request.idempotencyKey}#verify`, "Run produced a candidate snapshot.");
    else kernel = appendPhase(kernel, "execute", actor, `${request.idempotencyKey}#${request.outcome}`, `Run ${request.outcome}.`, { condition });
    const type = request.outcome === "completed" ? "run.completed" : request.outcome === "failed" ? "run.failed" : "run.blocked";
    return appendDomainEvent(kernel, actor, request.idempotencyKey, type, run.id, fingerprint);
  });
}

export function recordTaskReview(request: RecordTaskReviewRequest): TaskKernelMutationResult {
  const root = canonicalProjectRoot(request.root, request.cwd);
  const actor = requireNonEmptyString(request.actor, "actor");
  const fingerprint = fingerprintTaskValue({
    runId: request.runId, candidateSnapshotId: request.candidateSnapshotId, candidateFingerprint: request.candidateFingerprint, reviewer: request.reviewer,
    decision: request.decision, evidenceRefs: request.evidenceRefs, acceptanceEvidence: request.acceptanceEvidence ?? {}, unresolvedBlockers: request.unresolvedBlockers ?? [], measurementRef: request.measurementRef ?? null,
  });
  return mutateTaskKernel(root, request.taskDir, request.expectedRevision, actor, request.idempotencyKey, fingerprint, request.cwd, (current) => {
    if (current.phase !== "verify") throw new KernelError("INVALID_TRANSITION", `Review requires Verify phase, got ${current.phase}`);
    const runIndex = current.runs.findIndex((candidate) => candidate.id === request.runId);
    const run = current.runs[runIndex];
    if (run?.state !== "completed" || !run.candidateSnapshot || current.runs.at(-1)?.id !== run.id) throw new KernelError("INVALID_TRANSITION", "Review requires the latest completed Run with a candidate snapshot");
    if (request.candidateSnapshotId !== run.candidateSnapshot.id || request.candidateFingerprint !== run.candidateSnapshot.fingerprint) throw new KernelError("CANDIDATE_MISMATCH", "Review candidate snapshot ID and fingerprint must match the Run snapshot");
    const reviewer = requireNonEmptyString(request.reviewer, "reviewer");
    if (reviewer !== actor) throw new KernelError("REVIEW_NOT_INDEPENDENT", "the Review actor must match the recorded reviewer");
    if (reviewer === run.startedBy || reviewer === run.authorization.approvedBy) throw new KernelError("REVIEW_NOT_INDEPENDENT", "Review must be performed by someone other than the Run executor and approver");
    if (!(REVIEW_DECISIONS as readonly string[]).includes(request.decision)) throw new KernelError("INVALID_REQUEST", "Review decision must be pass, fail, or needs-changes");
    const evidenceRefs = parseStringArray(request.evidenceRefs, "evidenceRefs");
    const acceptanceEvidence = parseAcceptanceEvidence(request.acceptanceEvidence ?? {}, current.definition.acceptanceCriteria, request.decision === "pass");
    const unresolvedBlockers = parseStringArray(request.unresolvedBlockers ?? [], "unresolvedBlockers", true);
    if (request.decision === "pass" && unresolvedBlockers.length) throw new KernelError("TASK_GATE_UNSATISFIED", "a passing Review cannot have unresolved blockers");
    const review: TaskReviewV2 = {
      id: randomUUID(), taskId: current.identity.taskId, runId: run.id,
      candidateSnapshotId: run.candidateSnapshot.id, candidateFingerprint: run.candidateSnapshot.fingerprint, reviewer, independent: true,
      decision: request.decision, evidenceRefs, acceptanceEvidence, unresolvedBlockers, reviewedAt: new Date().toISOString(),
    };
    const condition: KernelCondition = request.decision === "pass" ? "ready" : "blocked";
    const measurementRefs = parseMeasurementRefs({ ...run.measurementRefs, ...(request.measurementRef ? { review: request.measurementRef } : {}) }, "measurementRefs");
    const kernel = { ...current, condition, runs: current.runs.map((item, index) => index === runIndex ? { ...run, measurementRefs } : item), reviews: [...current.reviews, review] };
    return appendDomainEvent(kernel, actor, request.idempotencyKey, "review.recorded", review.id, fingerprint);
  });
}

export function checkTaskClose(request: CheckTaskCloseRequest): string[] {
  const root = canonicalProjectRoot(request.root, request.cwd);
  const read = readTaskKernel({ root, taskDir: request.taskDir, cwd: request.cwd });
  if (read.kind !== "task-kernel-v2") throw new KernelError("INVALID_REQUEST", "Close requires a Task Kernel schema v2 task");
  const errors = taskCloseErrors(read.kernel, root, request.runId, request.reviewId, request.candidateObservation, request.deliveryEvidence, resolveInsideTaskRoot(root, request.taskDir, request.cwd));
  if (request.expectedRevision !== read.kernel.revision) errors.unshift(`revision conflict: expected ${request.expectedRevision}, current ${read.kernel.revision}`);
  return errors;
}

export function closeTaskKernel(request: CloseTaskKernelRequest): TaskKernelMutationResult {
  const root = canonicalProjectRoot(request.root, request.cwd);
  const actor = requireNonEmptyString(request.actor, "actor");
  const fingerprint = fingerprintTaskValue({ runId: request.runId, reviewId: request.reviewId, candidateObservation: request.candidateObservation, deliveryEvidence: request.deliveryEvidence });
  return mutateTaskKernel(root, request.taskDir, request.expectedRevision, actor, request.idempotencyKey, fingerprint, request.cwd, (current, dir) => {
    const errors = taskCloseErrors(current, root, request.runId, request.reviewId, request.candidateObservation, request.deliveryEvidence, dir);
    if (errors.length) throw new KernelError("TASK_GATE_UNSATISFIED", errors.join("; "));
    const run = current.runs.find((item) => item.id === request.runId);
    const review = current.reviews.find((item) => item.id === request.reviewId);
    if (!run || !review || !run.candidateSnapshot) throw new KernelError("TASK_GATE_UNSATISFIED", "Close references a missing or incomplete Run or Review");
    const closure: TaskClosureV2 = {
      runId: run.id, reviewId: review.id,
      candidateSnapshotId: run.candidateSnapshot.id,
      candidateFingerprint: run.candidateSnapshot.fingerprint,
      candidateObservation: parseCandidateObservation(request.candidateObservation),
      deliveryEvidence: parseDeliveryEvidence(request.deliveryEvidence, current.definition.deliveryLevel),
      acceptanceEvidence: review.acceptanceEvidence, closedAt: new Date().toISOString(), closedBy: actor,
    };
    let kernel = appendPhase(current, "close", actor, `${request.idempotencyKey}#close`, "Task acceptance and delivery evidence satisfied.");
    kernel = { ...kernel, outcome: "completed", condition: "ready", closure };
    return appendDomainEvent(kernel, actor, request.idempotencyKey, "task.closed", current.identity.taskId, fingerprint);
  });
}

export function listTaskKernelSnapshots(root: string): { taskDir: string; kernel: TaskKernelSnapshotV2 }[] {
  const canonicalRoot = canonicalProjectRoot(root);
  const tasksRoot = path.resolve(canonicalRoot, ".pactile", "tasks");
  if (!fs.existsSync(tasksRoot)) return [];
  const output: { taskDir: string; kernel: TaskKernelSnapshotV2 }[] = [];
  const directories: string[] = [];
  for (const entry of fs.readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || ["archive", "locale", "templates"].includes(entry.name)) continue;
    directories.push(path.join(tasksRoot, entry.name));
  }
  const archive = path.join(tasksRoot, "archive");
  if (fs.existsSync(archive)) {
    for (const month of fs.readdirSync(archive, { withFileTypes: true })) {
      if (!month.isDirectory()) continue;
      const monthDir = path.join(archive, month.name);
      for (const entry of fs.readdirSync(monthDir, { withFileTypes: true })) {
        if (entry.isDirectory()) directories.push(path.join(monthDir, entry.name));
      }
    }
  }
  for (const taskDir of directories) {
    try {
      const document = readTaskKernel({ root: canonicalRoot, taskDir });
      if (document?.kind === "task-kernel-v2") output.push({ taskDir, kernel: document.kernel });
    } catch { /* A malformed task remains available for explicit recovery. */ }
  }
  return output.sort((a, b) => a.taskDir.localeCompare(b.taskDir));
}

function mutateTaskKernel(
  root: string,
  taskDir: string,
  expectedRevision: number,
  actorValue: string,
  idempotencyKeyValue: string,
  requestFingerprint: string,
  cwd: string | undefined,
  operation: (current: TaskKernelSnapshotV2, resolvedDir: string) => TaskKernelSnapshotV2,
): TaskKernelMutationResult {
  requireNonEmptyString(actorValue, "actor");
  const idempotencyKey = requireNonEmptyString(idempotencyKeyValue, "idempotencyKey");
  if (!isNonNegativeInt(expectedRevision)) throw new KernelError("INVALID_REQUEST", "expectedRevision must be a non-negative integer");
  const canonicalRoot = canonicalProjectRoot(root, cwd);
  const safeTaskDir = resolveInsideTaskRoot(canonicalRoot, taskDir, cwd);
  return withKernelStateLock(safeTaskDir, cwd, (dir) => {
    const current = parseTaskKernelSnapshotV2(readKernelStateDocument(dir));
    const prior = findIdempotent(current, idempotencyKey, requestFingerprint);
    if (prior) return { kernel: current, idempotent: true, audit: findAuditForKey(current, idempotencyKey), event: prior };
    if (expectedRevision !== current.revision) throw new KernelError("REVISION_CONFLICT", `expected revision ${expectedRevision} but kernel is at ${current.revision}`);
    const next = operation(current, dir);
    const audit = requireArrayEntry(next.audit.at(-1), "Kernel audit event");
    const event = requireArrayEntry(next.events.at(-1), "Kernel event");
    writeKernelStateDocument(dir, next);
    return { kernel: next, idempotent: false, audit, event };
  });
}

function appendMutation(
  current: TaskKernelSnapshotV2,
  actor: string,
  idempotencyKey: string,
  type: TaskKernelEventType,
  entityId: string,
  fingerprint: string,
  patch: Partial<Pick<TaskKernelSnapshotV2, "definition" | "runs" | "reviews" | "closure" | "condition" | "outcome">>,
  evidence: string,
): TaskKernelSnapshotV2 {
  const nextRevision = current.revision + 1;
  const from: KernelState & { revision: number } = { phase: current.phase, condition: current.condition, outcome: current.outcome, revision: current.revision };
  const nextState = { phase: current.phase, condition: patch.condition ?? current.condition, outcome: patch.outcome === undefined ? current.outcome : patch.outcome };
  const audit = makeAudit(from, current.revision, nextState, nextRevision, actor, idempotencyKey, evidence);
  return {
    ...current, ...patch, ...nextState, revision: nextRevision,
    audit: [...current.audit, audit],
    events: [...current.events, makeEvent(nextRevision, actor, idempotencyKey, type, entityId, fingerprint)],
  };
}

function appendDomainEvent(
  current: TaskKernelSnapshotV2,
  actor: string,
  idempotencyKey: string,
  type: TaskKernelEventType,
  entityId: string,
  fingerprint: string,
): TaskKernelSnapshotV2 {
  return appendMutation(current, actor, idempotencyKey, type, entityId, fingerprint, {}, type);
}

function appendPhase(
  current: TaskKernelSnapshotV2,
  target: KernelPhase,
  actor: string,
  idempotencyKey: string,
  evidence: string,
  options: { condition?: KernelCondition; outcome?: KernelOutcome | null } = {},
): TaskKernelSnapshotV2 {
  const allowed = current.phase === target ||
    (current.phase === "define" && target === "approve") ||
    (current.phase === "approve" && target === "execute") ||
    (current.phase === "define" && target === "execute") ||
    (current.phase === "verify" && target === "execute") ||
    (current.phase === "execute" && target === "verify") ||
    (current.phase === "verify" && target === "close");
  if (!allowed) throw new KernelError("INVALID_TRANSITION", `illegal Task Kernel v2 edge ${current.phase} -> ${target}`);
  const nextRevision = current.revision + 1;
  const derived = deriveStateForPhase(target);
  const to = { ...derived, condition: options.condition ?? derived.condition, outcome: options.outcome === undefined ? derived.outcome : options.outcome };
  const from = { phase: current.phase, condition: current.condition, outcome: current.outcome, revision: current.revision };
  const audit = makeAudit(from, current.revision, to, nextRevision, actor, idempotencyKey, evidence);
  return { ...current, ...to, revision: nextRevision, audit: [...current.audit, audit] };
}

function makeAudit(
  fromState: KernelState,
  fromRevision: number,
  toState: KernelState,
  toRevision: number,
  actor: string,
  idempotencyKey: string,
  evidence: string,
): KernelAuditEvent {
  return {
    id: randomUUID(), at: new Date().toISOString(), actor, idempotencyKey, evidence,
    from: { ...fromState, revision: fromRevision }, to: { ...toState, revision: toRevision },
  };
}

function makeEvent(
  revision: number,
  actor: string,
  idempotencyKey: string,
  type: TaskKernelEventType,
  entityId: string,
  requestFingerprint: string,
): TaskKernelEventV2 {
  return { id: randomUUID(), revision, at: new Date().toISOString(), actor, idempotencyKey, type, entityId, requestFingerprint };
}

function taskCloseErrors(
  kernel: TaskKernelSnapshotV2,
  root: string,
  runId: string,
  reviewId: string,
  observationInput: TaskCandidateObservation,
  deliveryInput: TaskDeliveryEvidence,
  currentTaskDir?: string,
): string[] {
  const errors: string[] = [];
  if (kernel.phase !== "verify") errors.push(`Task must reach Verify before Close (current phase: ${kernel.phase})`);
  if (kernel.closure || kernel.phase === "close") errors.push("Task is already closed");
  const run = kernel.runs.find((item) => item.id === runId);
  if (run?.state !== "completed" || !run.candidateSnapshot) errors.push("Close requires a completed Run with a frozen candidate snapshot");
  if (run && kernel.runs.at(-1)?.id !== run.id) errors.push("Close requires the latest recorded Run; older candidates cannot be closed after a retry");
  const review = kernel.reviews.find((item) => item.id === reviewId);
  if (!review) errors.push("Close requires a recorded independent Review");
  if (run && review) {
    if (review.runId !== run.id) errors.push("Review must belong to the selected Run");
    if (review.candidateSnapshotId !== run.candidateSnapshot?.id || review.candidateFingerprint !== run.candidateSnapshot.fingerprint) errors.push("Review must match the selected Run candidate snapshot ID and fingerprint");
    if (review.independent !== true || review.reviewer === run.startedBy || review.reviewer === run.authorization.approvedBy) errors.push("Review must be independent from the Run executor and approver");
    const later = kernel.reviews.filter((candidate) => candidate.runId === run.id && candidate.candidateSnapshotId === review.candidateSnapshotId && candidate.candidateFingerprint === review.candidateFingerprint).at(-1);
    if (later?.id !== review.id) errors.push("the latest Review for the selected candidate must be used");
    if (review.decision !== "pass") errors.push("the latest Review for the selected candidate must pass");
    if (review.unresolvedBlockers.length) errors.push("the latest Review has unresolved blockers");
    if (!review.evidenceRefs.length) errors.push("the latest Review must include structured evidence references");
    for (const criterion of kernel.definition.acceptanceCriteria) {
      const refs = getOwnRecordValue(review.acceptanceEvidence, criterion.id);
      if (!refs?.length) errors.push(`acceptance evidence missing for ${criterion.id}`);
    }
  }
  try {
    const observation = parseCandidateObservation(observationInput);
    if (observation.snapshotId !== run?.candidateSnapshot?.id || observation.fingerprint !== run.candidateSnapshot.fingerprint) {
      errors.push("Close requires a caller-supplied current candidate observation matching the selected Run snapshot ID and fingerprint");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try { assertHardDependenciesSatisfied(root, kernel.definition.dependencies, currentTaskDir); }
  catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  try { parseDeliveryEvidence(deliveryInput, kernel.definition.deliveryLevel); }
  catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  return errors;
}

function parseDefinition(value: unknown, field: string): TaskDefinitionV2 {
  const input = parseObject(value, field);
  const taskId = requireTaskId(input.taskId, `${field}.taskId`);
  if (!isTaskDeliveryLevel(input.deliveryLevel)) throw new KernelError("INVALID_REQUEST", `${field}.deliveryLevel is invalid`);
  if (!Array.isArray(input.acceptanceCriteria) || input.acceptanceCriteria.length === 0) throw new KernelError("INVALID_REQUEST", `${field}.acceptanceCriteria must contain at least one criterion`);
  const criteria = input.acceptanceCriteria.map((item, index) => {
    const criterion = parseObject(item, `${field}.acceptanceCriteria[${index}]`);
    return { id: requireNonEmptyString(criterion.id, `${field}.acceptanceCriteria[${index}].id`), description: requireNonEmptyString(criterion.description, `${field}.acceptanceCriteria[${index}].description`) };
  });
  if (new Set(criteria.map((item) => item.id)).size !== criteria.length) throw new KernelError("INVALID_REQUEST", `${field}.acceptanceCriteria IDs must be unique`);
  const dependencies = parseStringArray(input.dependencies, `${field}.dependencies`, true).map((id, index) => requireTaskId(id, `${field}.dependencies[${index}]`));
  if (new Set(dependencies).size !== dependencies.length || dependencies.includes(taskId)) throw new KernelError("INVALID_REQUEST", `${field}.dependencies must be unique and cannot include the Task itself`);
  return {
    taskId,
    title: requireNonEmptyString(input.title, `${field}.title`),
    description: input.description === undefined ? "" : requireString(input.description, `${field}.description`, true),
    deliverable: requireNonEmptyString(input.deliverable, `${field}.deliverable`),
    deliveryLevel: input.deliveryLevel,
    acceptanceCriteria: criteria,
    dependencies,
    createdAt: requireNonEmptyString(input.createdAt, `${field}.createdAt`),
    createdBy: requireNonEmptyString(input.createdBy, `${field}.createdBy`),
  };
}

function parseRun(value: unknown, field: string): TaskRunV2 {
  const input = parseObject(value, field);
  const state = input.state;
  if (typeof state !== "string" || !(RUN_STATES as readonly string[]).includes(state)) throw new KernelError("CORRUPT_STATE", `${field}.state is invalid`);
  const snapshot = input.candidateSnapshot === null ? null : parseCandidateSnapshot(input.candidateSnapshot, `${field}.candidateSnapshot`);
  const result = input.result === null ? null : parseRunResult(input.result, `${field}.result`);
  const failure = input.failure === null ? null : parseFailure(input.failure, `${field}.failure`);
  if ((state === "running" || state === "waiting") && (snapshot || result || failure || input.completedAt !== null)) throw new KernelError("CORRUPT_STATE", `${field} non-terminal state cannot have terminal data`);
  if (state === "completed" && (!snapshot || !result || failure || typeof input.completedAt !== "string")) throw new KernelError("CORRUPT_STATE", `${field} completed state requires candidate, result, and completion time`);
  if ((state === "failed" || state === "blocked") && (!failure || typeof input.completedAt !== "string" || result && !result.summary)) throw new KernelError("CORRUPT_STATE", `${field} failed/blocked state requires failure details and completion time`);
  return {
    id: requireNonEmptyString(input.id, `${field}.id`), taskId: requireTaskId(input.taskId, `${field}.taskId`),
    attempt: requirePositiveInt(input.attempt, `${field}.attempt`), sequence: requirePositiveInt(input.sequence, `${field}.sequence`), state: state as TaskRunState,
    startedAt: requireNonEmptyString(input.startedAt, `${field}.startedAt`), startedBy: requireNonEmptyString(input.startedBy, `${field}.startedBy`),
    input: parseRunInput(input.input, `${field}.input`), authorization: parseAuthorization(input.authorization, `${field}.authorization`),
    writeSetSnapshot: parseStringArray(input.writeSetSnapshot, `${field}.writeSetSnapshot`, true),
    estimatedDurations: parseDurations(input.estimatedDurations, `${field}.estimatedDurations`),
    measurementRefs: parseMeasurementRefs(input.measurementRefs, `${field}.measurementRefs`),
    workspace: input.workspace === null ? null : parseWorkspaceBinding(input.workspace, requireNonEmptyString(input.id, `${field}.id`), `${field}.workspace`),
    host: input.host === null ? null : parseHostBinding(input.host, `${field}.host`),
    candidateSnapshot: snapshot, result, failure,
    completedAt: input.completedAt === null ? null : requireNonEmptyString(input.completedAt, `${field}.completedAt`),
  };
}

function parseReview(value: unknown, field: string): TaskReviewV2 {
  const input = parseObject(value, field);
  if (!(REVIEW_DECISIONS as readonly unknown[]).includes(input.decision)) throw new KernelError("CORRUPT_STATE", `${field}.decision is invalid`);
  if (input.independent !== true) throw new KernelError("CORRUPT_STATE", `${field}.independent must be true`);
  const unresolvedBlockers = parseStringArray(input.unresolvedBlockers, `${field}.unresolvedBlockers`, true);
  if (input.decision === "pass" && unresolvedBlockers.length) throw new KernelError("CORRUPT_STATE", `${field} passing Review cannot contain unresolved blockers`);
  return {
    id: requireNonEmptyString(input.id, `${field}.id`), taskId: requireTaskId(input.taskId, `${field}.taskId`),
    runId: requireNonEmptyString(input.runId, `${field}.runId`), candidateSnapshotId: requireNonEmptyString(input.candidateSnapshotId, `${field}.candidateSnapshotId`), candidateFingerprint: requireFingerprint(input.candidateFingerprint, `${field}.candidateFingerprint`),
    reviewer: requireNonEmptyString(input.reviewer, `${field}.reviewer`), independent: true,
    decision: input.decision as TaskReviewDecision, evidenceRefs: parseStringArray(input.evidenceRefs, `${field}.evidenceRefs`),
    acceptanceEvidence: parseEvidenceMap(input.acceptanceEvidence, `${field}.acceptanceEvidence`), unresolvedBlockers,
    reviewedAt: requireNonEmptyString(input.reviewedAt, `${field}.reviewedAt`),
  };
}

function parseClosure(value: unknown, field: string): TaskClosureV2 {
  const input = parseObject(value, field);
  return {
    runId: requireNonEmptyString(input.runId, `${field}.runId`), reviewId: requireNonEmptyString(input.reviewId, `${field}.reviewId`),
    candidateSnapshotId: requireNonEmptyString(input.candidateSnapshotId, `${field}.candidateSnapshotId`),
    candidateFingerprint: requireFingerprint(input.candidateFingerprint, `${field}.candidateFingerprint`),
    candidateObservation: parseCandidateObservation(input.candidateObservation),
    deliveryEvidence: parseDeliveryEvidence(input.deliveryEvidence), acceptanceEvidence: parseEvidenceMap(input.acceptanceEvidence, `${field}.acceptanceEvidence`),
    closedAt: requireNonEmptyString(input.closedAt, `${field}.closedAt`), closedBy: requireNonEmptyString(input.closedBy, `${field}.closedBy`),
  };
}

function parseDeliveryEvidence(value: unknown, expectedLevel?: TaskDeliveryLevel): TaskDeliveryEvidence {
  const input = parseObject(value, "deliveryEvidence");
  if (!isTaskDeliveryLevel(input.level)) throw new KernelError("INVALID_DELIVERY_EVIDENCE", "delivery evidence level is invalid");
  if (expectedLevel && input.level !== expectedLevel) throw new KernelError("INVALID_DELIVERY_EVIDENCE", `Task requires delivery level ${expectedLevel}, got ${input.level}`);
  const reference = requireNonEmptyString(input.reference, "deliveryEvidence.reference");
  const summary = requireNonEmptyString(input.summary, "deliveryEvidence.summary");
  if (input.level === "pull-request" || input.level === "merged-result") {
    let url: URL;
    try { url = new URL(reference); }
    catch { throw new KernelError("INVALID_DELIVERY_EVIDENCE", `${input.level} requires an absolute HTTPS URL reference`); }
    if (url.protocol !== "https:") throw new KernelError("INVALID_DELIVERY_EVIDENCE", `${input.level} requires an HTTPS reference`);
  }
  return { level: input.level, reference, summary };
}

function parseRunInput(value: unknown, field: string): TaskRunInput {
  const input = parseObject(value, field);
  const summary = requireNonEmptyString(input.summary, `${field}.summary`);
  const references = parseStringArray(input.references, `${field}.references`, true);
  const expected = fingerprintTaskValue({ summary, references });
  if (input.fingerprint !== undefined && input.fingerprint !== expected) throw new KernelError("INVALID_REQUEST", `${field}.fingerprint does not match its contents`);
  return { summary, references, fingerprint: expected };
}

function parseAuthorization(value: unknown, field: string): TaskRunAuthorization {
  const input = parseObject(value, field);
  return {
    approvedBy: requireNonEmptyString(input.approvedBy, `${field}.approvedBy`),
    approvedAt: requireNonEmptyString(input.approvedAt, `${field}.approvedAt`),
    scope: requireNonEmptyString(input.scope, `${field}.scope`),
    evidenceRef: requireNonEmptyString(input.evidenceRef, `${field}.evidenceRef`),
  };
}

function parseCandidateSnapshot(value: unknown, field: string): TaskCandidateSnapshot {
  const input = parseObject(value, field);
  const entries = parseSnapshotEntries(input.entries, `${field}.entries`);
  if (!entries.length) throw new KernelError("CORRUPT_STATE", `${field}.entries cannot be empty`);
  const fingerprint = fingerprintTaskValue(entries);
  if (input.fingerprint !== fingerprint) throw new KernelError("CORRUPT_STATE", `${field}.fingerprint does not match its entries`);
  return { id: requireNonEmptyString(input.id, `${field}.id`), entries, fingerprint };
}

function parseCandidateObservation(value: unknown): TaskCandidateObservation {
  const input = parseObject(value, "candidateObservation");
  return {
    snapshotId: requireNonEmptyString(input.snapshotId, "candidateObservation.snapshotId"),
    fingerprint: requireFingerprint(input.fingerprint, "candidateObservation.fingerprint"),
    observedBy: requireNonEmptyString(input.observedBy, "candidateObservation.observedBy"),
    observedAt: requireNonEmptyString(input.observedAt, "candidateObservation.observedAt"),
    source: requireNonEmptyString(input.source, "candidateObservation.source"),
    evidenceRef: requireNonEmptyString(input.evidenceRef, "candidateObservation.evidenceRef"),
  };
}

function parseDurations(value: unknown, field: string): TaskRunDurations {
  const input = parseObject(value, field);
  const duration = (name: keyof TaskRunDurations): number | null => {
    const raw = input[name];
    if (raw === undefined || raw === null) return null;
    if (!isNonNegativeInt(raw)) throw new KernelError("INVALID_REQUEST", `${field}.${name} must be a non-negative integer or null`);
    return raw;
  };
  return { executionMs: duration("executionMs"), waitingMs: duration("waitingMs"), reviewMs: duration("reviewMs") };
}

function parseMeasurementRefs(value: unknown, field: string): TaskRunMeasurementRefs {
  const input = parseObject(value, field);
  const reference = (name: keyof TaskRunMeasurementRefs): string | null => input[name] === undefined || input[name] === null ? null : requireNonEmptyString(input[name], `${field}.${name}`);
  return { execution: reference("execution"), waiting: reference("waiting"), review: reference("review") };
}

function parseSnapshotEntries(value: unknown, field: string): TaskSnapshotEntry[] {
  if (!Array.isArray(value)) throw new KernelError("INVALID_REQUEST", `${field} must be an array`);
  const entries = value.map((item, index) => {
    const input = parseObject(item, `${field}[${index}]`);
    return { ref: requireNonEmptyString(input.ref, `${field}[${index}].ref`), fingerprint: requireFingerprint(input.fingerprint, `${field}[${index}].fingerprint`) };
  }).sort((a, b) => a.ref.localeCompare(b.ref));
  if (new Set(entries.map((entry) => entry.ref)).size !== entries.length) throw new KernelError("INVALID_REQUEST", `${field} refs must be unique`);
  return entries;
}

function parseRunResult(value: unknown, field: string): TaskRunResult {
  const input = parseObject(value, field);
  return { summary: requireNonEmptyString(input.summary, `${field}.summary`), evidenceRefs: parseStringArray(input.evidenceRefs, `${field}.evidenceRefs`, true) };
}

function parseFailure(value: unknown, field: string): TaskRunFailure {
  const input = parseObject(value, field);
  return {
    category: requireNonEmptyString(input.category, `${field}.category`),
    message: requireNonEmptyString(input.message, `${field}.message`),
    evidenceRef: input.evidenceRef === null || input.evidenceRef === undefined ? null : requireNonEmptyString(input.evidenceRef, `${field}.evidenceRef`),
  };
}

function parseWorkspaceBinding(value: unknown, runId: string, field: string): TaskRunWorkspaceBinding {
  const input = parseObject(value, field);
  if (input.ownerRunId !== runId) throw new KernelError("CORRUPT_STATE", `${field}.ownerRunId must match its Run`);
  const canonicalPath = requireNonEmptyString(input.canonicalPath, `${field}.canonicalPath`);
  if (!path.isAbsolute(canonicalPath)) throw new KernelError("INVALID_REQUEST", `${field}.canonicalPath must be absolute`);
  if (input.integrationState !== "not-integrated" && input.integrationState !== "integrated") throw new KernelError("CORRUPT_STATE", `${field}.integrationState is invalid`);
  if (!["not-requested", "pending", "reclaimed", "failed"].includes(String(input.reclamationState))) throw new KernelError("CORRUPT_STATE", `${field}.reclamationState is invalid`);
  return {
    ownerRunId: runId,
    canonicalPath,
    branch: requireNonEmptyString(input.branch, `${field}.branch`),
    baseSha: requireNonEmptyString(input.baseSha, `${field}.baseSha`),
    writeSet: parseStringArray(input.writeSet, `${field}.writeSet`, true),
    integrationState: input.integrationState,
    reclamationState: input.reclamationState as TaskRunWorkspaceBinding["reclamationState"],
  };
}

function parseHostBinding(value: unknown, field: string): TaskRunHostBinding {
  const input = parseObject(value, field);
  if (!isNonNegativeInt(input.kernelRevision)) throw new KernelError("CORRUPT_STATE", `${field}.kernelRevision is invalid`);
  return {
    host: requireNonEmptyString(input.host, `${field}.host`),
    role: requireNonEmptyString(input.role, `${field}.role`),
    sessionId: input.sessionId === null || input.sessionId === undefined ? null : requireNonEmptyString(input.sessionId, `${field}.sessionId`),
    threadId: input.threadId === null || input.threadId === undefined ? null : requireNonEmptyString(input.threadId, `${field}.threadId`),
    kernelRevision: input.kernelRevision,
    contractFingerprint: requireFingerprint(input.contractFingerprint, `${field}.contractFingerprint`),
    requestRefs: parseStringArray(input.requestRefs ?? [], `${field}.requestRefs`, true),
    eventRefs: parseStringArray(input.eventRefs ?? [], `${field}.eventRefs`, true),
    resultRefs: parseStringArray(input.resultRefs ?? [], `${field}.resultRefs`, true),
    assuranceSource: input.assuranceSource === null || input.assuranceSource === undefined ? null : requireNonEmptyString(input.assuranceSource, `${field}.assuranceSource`),
  };
}

function parseAcceptanceEvidence(value: unknown, criteria: readonly TaskAcceptanceCriterion[], requireComplete: boolean): Record<string, string[]> {
  const evidence = parseEvidenceMap(value, "acceptanceEvidence");
  const allowed = new Set(criteria.map((criterion) => criterion.id));
  for (const key of Object.keys(evidence)) if (!allowed.has(key)) throw new KernelError("INVALID_REQUEST", `acceptanceEvidence references unknown criterion ${key}`);
  if (requireComplete) {
    const missing = criteria.filter((criterion) => !getOwnRecordValue(evidence, criterion.id)?.length).map((criterion) => criterion.id);
    if (missing.length) throw new KernelError("ACCEPTANCE_EVIDENCE_MISSING", `passing Review requires evidence for every acceptance criterion: ${missing.join(", ")}`);
  }
  return evidence;
}

function parseEvidenceMap(value: unknown, field: string): Record<string, string[]> {
  const input = parseObject(value, field);
  const result: Record<string, string[]> = {};
  for (const [key, refs] of Object.entries(input)) {
    Object.defineProperty(result, requireNonEmptyString(key, `${field} key`), {
      value: parseStringArray(refs, `${field}.${key}`), enumerable: true, writable: true, configurable: true,
    });
  }
  return result;
}

function parseEvent(value: unknown, index: number): TaskKernelEventV2 {
  const field = `kernel.events[${index}]`;
  const input = parseObject(value, field);
  if (!(EVENT_TYPES as readonly unknown[]).includes(input.type)) throw new KernelError("CORRUPT_STATE", `${field}.type is invalid`);
  return {
    id: requireNonEmptyString(input.id, `${field}.id`), revision: requirePositiveInt(input.revision, `${field}.revision`),
    at: requireNonEmptyString(input.at, `${field}.at`), actor: requireNonEmptyString(input.actor, `${field}.actor`),
    idempotencyKey: requireNonEmptyString(input.idempotencyKey, `${field}.idempotencyKey`), type: input.type as TaskKernelEventType,
    entityId: requireNonEmptyString(input.entityId, `${field}.entityId`), requestFingerprint: requireFingerprint(input.requestFingerprint, `${field}.requestFingerprint`),
  };
}

function parseKernelAudit(value: unknown, index: number): KernelAuditEvent {
  const field = `kernel.audit[${index}]`;
  const input = parseObject(value, field);
  const parseState = (raw: unknown, name: string): KernelState & { revision: number } => {
    const state = parseObject(raw, name);
    if (!isKernelPhase(state.phase) || !isKernelCondition(state.condition) || !isNonNegativeInt(state.revision) || (state.outcome !== null && !isKernelOutcome(state.outcome))) {
      throw new KernelError("CORRUPT_STATE", `${name} state is invalid`);
    }
    return { phase: state.phase, condition: state.condition, outcome: state.outcome as KernelOutcome | null, revision: state.revision };
  };
  if (input.evidence !== null && typeof input.evidence !== "string") throw new KernelError("CORRUPT_STATE", `${field}.evidence is invalid`);
  return {
    id: requireNonEmptyString(input.id, `${field}.id`), at: requireNonEmptyString(input.at, `${field}.at`),
    actor: requireNonEmptyString(input.actor, `${field}.actor`), idempotencyKey: requireNonEmptyString(input.idempotencyKey, `${field}.idempotencyKey`),
    evidence: input.evidence as string | null, from: parseState(input.from, `${field}.from`), to: parseState(input.to, `${field}.to`),
  };
}

function validateAuditChain(audit: readonly KernelAuditEvent[], revision: number): void {
  if (!audit.length) throw new KernelError("CORRUPT_STATE", "Task Kernel v2 requires an audit event");
  for (let index = 0; index < audit.length; index++) {
    const event = requireArrayEntry(audit[index], `kernel.audit[${index}]`);
    const previous = index > 0 ? requireArrayEntry(audit[index - 1], `kernel.audit[${index - 1}]`) : null;
    if (event.to.revision !== event.from.revision + 1 || (previous && previous.to.revision !== event.from.revision)) {
      throw new KernelError("CORRUPT_STATE", "Task Kernel v2 audit revisions are not contiguous");
    }
  }
  if (requireArrayEntry(audit.at(-1), "latest kernel audit event").to.revision !== revision) throw new KernelError("CORRUPT_STATE", "Task Kernel v2 audit does not end at the current revision");
}

function validateEvents(events: readonly TaskKernelEventV2[], revision: number): void {
  const keys = new Set<string>();
  const ids = new Set<string>();
  for (const event of events) {
    if (event.revision > revision) throw new KernelError("CORRUPT_STATE", "Task Kernel event revision is in the future");
    if (keys.has(event.idempotencyKey) || ids.has(event.id)) throw new KernelError("CORRUPT_STATE", "Task Kernel events contain a duplicate ID or idempotency key");
    keys.add(event.idempotencyKey);
    ids.add(event.id);
  }
  if (!events.length) throw new KernelError("CORRUPT_STATE", "Task Kernel v2 requires a domain event");
}

function findIdempotent(kernel: TaskKernelSnapshotV2, key: string, fingerprint: string): TaskKernelEventV2 | null {
  const prior = kernel.events.find((event) => event.idempotencyKey === key);
  if (!prior) return null;
  if (prior.requestFingerprint !== fingerprint) throw new KernelError("IDEMPOTENCY_MISMATCH", `idempotency key ${key} was already used for another request`);
  return prior;
}

function findAuditForKey(kernel: TaskKernelSnapshotV2, key: string): KernelAuditEvent {
  const audit = kernel.audit.find((event) => event.idempotencyKey === key || event.idempotencyKey.startsWith(`${key}#`));
  if (!audit) throw new KernelError("CORRUPT_STATE", `idempotent event ${key} has no audit record`);
  return audit;
}

function assertUniqueTaskId(root: string, taskId: string, ignoredDir: string): void {
  const match = findTaskById(root, taskId, ignoredDir);
  if (match && path.resolve(match.taskDir) !== path.resolve(ignoredDir)) throw new KernelError("INVALID_REQUEST", `Task ID already exists: ${taskId}`);
}

function assertDependenciesResolvable(root: string, taskId: string, dependencies: readonly string[], ignoredDir?: string): void {
  const canonicalRoot = canonicalProjectRoot(root);
  for (const dependency of dependencies) {
    if (dependency === taskId) throw new KernelError("INVALID_REQUEST", "a Task cannot depend on itself");
    if (!findTaskById(canonicalRoot, dependency, ignoredDir)) throw new KernelError("DEPENDENCY_UNSATISFIED", `hard dependency not found: ${dependency}`);
  }
}

function assertNoDependencyCycle(root: string, taskId: string, dependencies: readonly string[], ignoredDir: string): void {
  const canonicalRoot = canonicalProjectRoot(root);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (currentId: string): void => {
    if (currentId === taskId) throw new KernelError("INVALID_REQUEST", `hard dependency cycle reaches ${taskId}`);
    if (visited.has(currentId) || visiting.has(currentId)) return;
    visiting.add(currentId);
    const located = findTaskById(canonicalRoot, currentId, ignoredDir);
    if (located && path.resolve(located.taskDir) !== path.resolve(ignoredDir)) {
      for (const dependency of located.dependencies) visit(dependency);
    }
    visiting.delete(currentId);
    visited.add(currentId);
  };
  for (const dependency of dependencies) visit(dependency);
}

function assertHardDependenciesSatisfied(root: string, dependencies: readonly string[], ignoredDir?: string): void {
  const canonicalRoot = canonicalProjectRoot(root);
  const unmet = dependencies.filter((id) => {
    const task = findTaskById(canonicalRoot, id, ignoredDir);
    return task?.phase !== "close" || task.outcome !== "completed";
  });
  if (unmet.length) throw new KernelError("DEPENDENCY_UNSATISFIED", `hard dependencies must be closed successfully: ${unmet.join(", ")}`);
}

interface LocatedTask {
  taskDir: string;
  taskId: string;
  phase: KernelPhase;
  outcome: KernelOutcome | null;
  dependencies: string[];
}

function findTaskById(root: string, taskId: string, ignoredDir?: string): LocatedTask | null {
  const canonicalRoot = canonicalProjectRoot(root);
  const matches = enumerateTaskDirs(canonicalRoot).flatMap((taskDir) => {
    if (ignoredDir && path.resolve(taskDir) === path.resolve(ignoredDir)) return [];
    try {
      const document = withKernelStateLock(taskDir, undefined, (dir) => readKernelStateDocument(dir));
      if (isPlainObject(document) && document.schemaVersion === TASK_KERNEL_SCHEMA_VERSION) {
        const kernel = parseTaskKernelSnapshotV2(document);
        return kernel.identity.taskId === taskId ? [{ taskDir, taskId, phase: kernel.phase, outcome: kernel.outcome, dependencies: kernel.definition.dependencies }] : [];
      }
      const legacy = readKernel({ taskDir });
      if (legacy.legacy.id !== taskId) return [];
      const rawExtras = legacy.kernel.projection?.extras ?? {};
      return [{ taskDir, taskId, phase: legacy.kernel.phase, outcome: legacy.kernel.outcome, dependencies: Array.isArray(rawExtras.depends_on) ? rawExtras.depends_on.filter((value): value is string => typeof value === "string") : [] }];
    } catch { return []; }
  });
  if (matches.length > 1) throw new KernelError("INVALID_REQUEST", `Task ID is ambiguous across active and archived records: ${taskId}`);
  return matches[0] ?? null;
}

function enumerateTaskDirs(root: string): string[] {
  const canonicalRoot = canonicalProjectRoot(root);
  const tasksRoot = path.resolve(canonicalRoot, ".pactile", "tasks");
  if (!fs.existsSync(tasksRoot)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || ["archive", "locale", "templates"].includes(entry.name)) continue;
    result.push(path.join(tasksRoot, entry.name));
  }
  const archive = path.join(tasksRoot, "archive");
  if (fs.existsSync(archive)) for (const month of fs.readdirSync(archive, { withFileTypes: true })) {
    if (!month.isDirectory()) continue;
    const monthDir = path.join(archive, month.name);
    for (const entry of fs.readdirSync(monthDir, { withFileTypes: true })) if (entry.isDirectory()) result.push(path.join(monthDir, entry.name));
  }
  return result;
}

function resolveInsideTasksRoot(root: string, taskDir: string, cwd?: string): string {
  const base = cwd ?? process.cwd();
  const canonicalRoot = canonicalProjectRoot(root, cwd);
  const tasksRoot = path.resolve(canonicalRoot, ".pactile", "tasks");
  if (fs.existsSync(tasksRoot) && fs.realpathSync(tasksRoot) !== tasksRoot) {
    throw new KernelError("INVALID_REQUEST", "project .pactile/tasks must resolve inside the canonical project root");
  }
  const candidate = canonicalizePath(path.resolve(base, taskDir));
  const relative = path.relative(tasksRoot, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new KernelError("INVALID_REQUEST", "Task path must belong to the supplied project's .pactile/tasks tree");
  }
  return candidate;
}

function resolveInsideTaskRoot(root: string, taskDir: string, cwd?: string): string {
  const candidate = resolveInsideTasksRoot(root, taskDir, cwd);
  const canonicalRoot = canonicalProjectRoot(root, cwd);
  const relative = path.relative(path.resolve(canonicalRoot, ".pactile", "tasks"), candidate);
  if (relative.split(path.sep).includes("archive")) {
    throw new KernelError("INVALID_REQUEST", "new Task Kernel mutations must target active .pactile/tasks records");
  }
  return candidate;
}

function canonicalProjectRoot(root: string, cwd?: string): string {
  const canonicalRoot = canonicalizePath(path.resolve(cwd ?? process.cwd(), requireNonEmptyString(root, "root")));
  if (fs.existsSync(canonicalRoot) && !fs.statSync(canonicalRoot).isDirectory()) {
    throw new KernelError("INVALID_REQUEST", "project root must be a directory");
  }
  return canonicalRoot;
}

function canonicalizePath(candidate: string): string {
  let existing = candidate;
  const suffix: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return candidate;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.resolve(fs.realpathSync(existing), ...suffix);
}

function getOwnRecordValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function parseObject(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new KernelError("CORRUPT_STATE", `${field} must be an object`);
  return value;
}

function parseStringArray(value: unknown, field: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new KernelError("INVALID_REQUEST", `${field} must be an array of non-empty strings`);
  if (!allowEmpty && value.length === 0) throw new KernelError("INVALID_REQUEST", `${field} must contain at least one reference`);
  return [...value] as string[];
}

function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new KernelError("INVALID_REQUEST", `${field} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  return value;
}

function requireTaskId(value: unknown, field: string): string {
  const taskId = requireNonEmptyString(value, field);
  if (!TASK_ID_RE.test(taskId)) throw new KernelError("INVALID_REQUEST", `${field} must be a lowercase slug`);
  return taskId;
}

function requireFingerprint(value: unknown, field: string): string {
  if (typeof value !== "string" || !FINGERPRINT_RE.test(value)) throw new KernelError("INVALID_REQUEST", `${field} must be a lowercase SHA-256 fingerprint`);
  return value;
}

function requirePositiveInt(value: unknown, field: string): number {
  if (!isNonNegativeInt(value) || value < 1) throw new KernelError("CORRUPT_STATE", `${field} must be a positive integer`);
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
