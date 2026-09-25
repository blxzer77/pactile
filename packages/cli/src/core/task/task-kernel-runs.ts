import { randomUUID } from "node:crypto";

import { KernelError, requireNonEmptyString, type KernelCondition } from "./kernel-contract.js";
import { appendDomainEvent, appendPhase, mutateTaskKernel } from "./task-kernel-store-v2.js";
import {
  createTaskCandidateSnapshot,
  fingerprintTaskValue,
  parseDurations,
  parseAuthorization,
  parseFailure,
  parseHostBinding,
  parseMeasurementRefs,
  parseRunInput,
  parseStringArray,
  parseWorkspaceBinding,
  requireArrayEntry,
} from "./task-kernel-schema.js";
import { assertHardDependenciesSatisfied, canonicalProjectRoot } from "./task-kernel-paths.js";
import type {
  RecordTaskRunResultRequest,
  ResumeTaskRunRequest,
  StartTaskRunRequest,
  TaskKernelMutationResult,
  TaskKernelSnapshotV2,
  TaskRunV2,
} from "./task-kernel-types.js";

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
  if (!(new Set(["completed", "failed", "blocked", "cancelled"]).has(request.outcome))) throw new KernelError("INVALID_REQUEST", "Run outcome must be completed, failed, blocked, or cancelled");
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
    const type = request.outcome === "completed" ? "run.completed"
      : request.outcome === "failed" ? "run.failed"
        : request.outcome === "cancelled" ? "run.cancelled" : "run.blocked";
    return appendDomainEvent(kernel, actor, request.idempotencyKey, type, run.id, fingerprint);
  });
}
