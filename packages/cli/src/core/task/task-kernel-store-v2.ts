import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  KernelError,
  deriveStateForPhase,
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
import { parseDefinition, parseTaskKernelSnapshotV2, fingerprintTaskValue, requireArrayEntry } from "./task-kernel-schema.js";
import {
  assertDependenciesResolvable,
  assertNoDependencyCycle,
  assertUniqueTaskId,
  canonicalProjectRoot,
  resolveInsideTaskRoot,
  resolveInsideTasksRoot,
} from "./task-kernel-paths.js";
import {
  TASK_KERNEL_SCHEMA_VERSION,
  type AnyTaskKernelReadResult,
  type CreateTaskKernelRequest,
  type TaskKernelEventType,
  type TaskKernelEventV2,
  type TaskKernelMutationResult,
  type TaskKernelSnapshotV2,
} from "./task-kernel-types.js";

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

export function mutateTaskKernel(
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

export function appendMutation(
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

export function appendDomainEvent(
  current: TaskKernelSnapshotV2,
  actor: string,
  idempotencyKey: string,
  type: TaskKernelEventType,
  entityId: string,
  fingerprint: string,
): TaskKernelSnapshotV2 {
  return appendMutation(current, actor, idempotencyKey, type, entityId, fingerprint, {}, type);
}

export function appendPhase(
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

export function makeAudit(
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

export function makeEvent(
  revision: number,
  actor: string,
  idempotencyKey: string,
  type: TaskKernelEventType,
  entityId: string,
  requestFingerprint: string,
): TaskKernelEventV2 {
  return { id: randomUUID(), revision, at: new Date().toISOString(), actor, idempotencyKey, type, entityId, requestFingerprint };
}
