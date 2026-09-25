/**
 * Stateless Kernel JSON CLI (stdin → stdout). Stage 2 write channel for
 * Task core state: create / start / record-gate / archive / patch project
 * the legacy task.json surface as the same command. `transition` stays the
 * Stage 1 kernel.json-only hop (no status rewrite).
 */

import {
  scanContractMigration,
  type ContractMigrateReport,
} from "./contract-migrate.js";
import { isPlainObject, taskRecordSchema, type PactileTaskRecord } from "./schema.js";
import {
  KernelError,
  isKernelPhase,
  isNonNegativeInt,
  type KernelErrorCode,
  type TransitionRequest,
} from "./kernel-contract.js";
import {
  applyKernelArchive,
  applyKernelCreate,
  applyKernelPatch,
  applyKernelRecordGate,
  applyKernelStart,
  applyKernelTransition,
  readKernel,
  inspectTaskProjection,
  repairTaskProjection,
  type KernelArchiveRequest,
  type KernelCommandResult,
  type KernelCreateRequest,
  type KernelPatchRequest,
  type KernelReadResult,
  type KernelRecordGateRequest,
  type KernelStartRequest,
  type KernelTransitionResult,
} from "./kernel-store.js";
import type { ProjectionInspection, ProjectionRepairReceipt } from "./kernel-surface.js";
import {
  addTaskDependency,
  checkTaskClose,
  closeTaskKernel,
  createTaskKernel,
  readTaskKernel,
  recordTaskReview,
  recordTaskRunResult,
  resumeTaskRun,
  startTaskRun,
} from "./task-kernel.js";
import type { AnyTaskKernelReadResult, TaskKernelMutationResult } from "./task-kernel.js";
import type {
  CheckTaskCloseRequest,
  CloseTaskKernelRequest,
  CreateTaskKernelRequest,
  RecordTaskReviewRequest,
  RecordTaskRunResultRequest,
  StartTaskRunRequest,
} from "./task-kernel.js";

export type KernelCliSuccess =
  | ({ ok: true; op: "inspect-projection" } & ProjectionInspection)
  | ({ ok: true; op: "repair-projection" } & ProjectionRepairReceipt)
  | ({ ok: true; op: "read" } & KernelReadResult)
  | ({ ok: true; op: "transition" } & KernelTransitionResult)
  | ({
      ok: true;
      op: "create" | "start" | "record-gate" | "archive" | "patch";
    } & KernelCommandResult)
  | ({ ok: true; op: "migrate" } & ContractMigrateReport)
  | ({ ok: true; op: "task-read"; result: AnyTaskKernelReadResult })
  | ({ ok: true; op: "task-create" | "dependency-add" | "run-start" | "run-resume" | "run-result" | "review-record" | "task-close"; result: TaskKernelMutationResult })
  | ({ ok: true; op: "task-close-check"; errors: string[] });

export interface KernelCliFailure {
  ok: false;
  error: { code: KernelErrorCode | "INVALID_REQUEST"; message: string };
  halfConversion?: { kernelPersisted: boolean; projectionPersisted: boolean };
}

export type KernelCliResponse = KernelCliSuccess | KernelCliFailure;

export interface KernelCliIo {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  cwd?: string;
}

export function handleKernelRequest(
  input: unknown,
  options: { cwd?: string } = {},
): KernelCliResponse {
  try {
    return dispatchKernelRequest(input, options.cwd);
  } catch (err) {
    return toFailure(err);
  }
}

export async function runKernelJsonCli(io: KernelCliIo = {}): Promise<number> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const raw = (await readAll(stdin)).trim();
  let parsed: unknown;
  try {
    parsed = raw === "" ? {} : JSON.parse(raw);
  } catch (err) {
    const response: KernelCliFailure = {
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: `stdin is not JSON: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
    stdout.write(`${JSON.stringify(response)}\n`);
    return 1;
  }
  const response = handleKernelRequest(parsed, { cwd: io.cwd });
  stdout.write(`${JSON.stringify(response)}\n`);
  return response.ok ? 0 : 1;
}

function dispatchKernelRequest(
  input: unknown,
  cwd: string | undefined,
): KernelCliSuccess {
  if (!isPlainObject(input)) {
    throw new KernelError("INVALID_REQUEST", "request must be a JSON object");
  }
  const op = input.op;
  if (op === "inspect-projection") {
    return { ok: true, op, ...inspectTaskProjection({ taskDir: requireTaskDir(input.taskDir), cwd: optionalCwd(input.cwd, cwd) }) };
  }
  if (op === "repair-projection") {
    if (!isNonNegativeInt(input.expectedCanonicalRevision) ||
        (input.expectedCurrentFingerprint !== null && typeof input.expectedCurrentFingerprint !== "string")) {
      throw new KernelError("INVALID_REQUEST", "repair requires expectedCanonicalRevision and expectedCurrentFingerprint");
    }
    return { ok: true, op, ...repairTaskProjection({
      taskDir: requireTaskDir(input.taskDir), cwd: optionalCwd(input.cwd, cwd),
      expectedCanonicalRevision: input.expectedCanonicalRevision,
      expectedCurrentFingerprint: input.expectedCurrentFingerprint,
    }) };
  }
  if (op === "read") {
    const taskDir = requireTaskDir(input.taskDir);
    const result = readKernel({
      taskDir,
      cwd: optionalCwd(input.cwd, cwd),
    });
    return { ok: true, op: "read", ...result };
  }
  if (op === "transition") {
    const request = parseTransitionRequest(input, cwd);
    const result = applyKernelTransition(request);
    return { ok: true, op: "transition", ...result };
  }
  if (op === "create") {
    const result = applyKernelCreate(parseCreateRequest(input, cwd));
    return { ok: true, op: "create", ...result };
  }
  if (op === "start") {
    const result = applyKernelStart(parseStartRequest(input, cwd));
    return { ok: true, op: "start", ...result };
  }
  if (op === "record-gate") {
    const result = applyKernelRecordGate(parseRecordGateRequest(input, cwd));
    return { ok: true, op: "record-gate", ...result };
  }
  if (op === "archive") {
    const result = applyKernelArchive(parseArchiveRequest(input, cwd));
    return { ok: true, op: "archive", ...result };
  }
  if (op === "patch") {
    const result = applyKernelPatch(parsePatchRequest(input, cwd));
    return { ok: true, op: "patch", ...result };
  }
  if (op === "migrate") {
    return { ok: true, op: "migrate", ...parseMigrateDryRun(input, cwd) };
  }
  const taskCwd = optionalCwd(input.cwd, cwd);
  const taskRoot = requestRoot(input.root, taskCwd);
  if (op === "task-read") {
    const taskDir = requireTaskDir(input.taskDir);
    return { ok: true, op, result: readTaskKernel({ root: taskRoot, taskDir, cwd: taskCwd }) };
  }
  if (op === "task-create") {
    if (!isPlainObject(input.definition)) throw new KernelError("INVALID_REQUEST", "definition must be a JSON object");
    const request: CreateTaskKernelRequest = {
      root: taskRoot, taskDir: requireTaskDir(input.taskDir),
      definition: input.definition as CreateTaskKernelRequest["definition"],
      actor: requireString(input.actor, "actor"), idempotencyKey: requireString(input.idempotencyKey, "idempotencyKey"),
      cwd: taskCwd,
    };
    return { ok: true, op, result: createTaskKernel(request) };
  }
  if (op === "dependency-add") {
    return { ok: true, op, result: addTaskDependency({
      root: taskRoot, taskDir: requireTaskDir(input.taskDir), expectedRevision: requireRevision(input.expectedRevision),
      dependencyId: requireString(input.dependencyId, "dependencyId"), actor: requireString(input.actor, "actor"),
      idempotencyKey: requireString(input.idempotencyKey, "idempotencyKey"), cwd: taskCwd,
    }) };
  }
  if (op === "run-start") {
    if (!isPlainObject(input.input) || !isPlainObject(input.authorization)) throw new KernelError("INVALID_REQUEST", "run-start requires input and authorization objects");
    if (input.workspace !== undefined && input.workspace !== null && !isPlainObject(input.workspace)) throw new KernelError("INVALID_REQUEST", "workspace must be a JSON object");
    if (input.host !== undefined && input.host !== null && !isPlainObject(input.host)) throw new KernelError("INVALID_REQUEST", "host must be a JSON object");
    const request: StartTaskRunRequest = {
      root: taskRoot, taskDir: requireTaskDir(input.taskDir), expectedRevision: requireRevision(input.expectedRevision),
      actor: requireString(input.actor, "actor"), idempotencyKey: requireString(input.idempotencyKey, "idempotencyKey"),
      input: input.input as unknown as StartTaskRunRequest["input"], authorization: input.authorization as unknown as StartTaskRunRequest["authorization"],
      ...(input.initialState === undefined ? {} : { initialState: requireString(input.initialState, "initialState") as StartTaskRunRequest["initialState"] }),
      ...(input.writeSetSnapshot === undefined ? {} : { writeSetSnapshot: parseStringArray(input.writeSetSnapshot, "writeSetSnapshot", true) }),
      ...(input.estimatedDurations === undefined ? {} : { estimatedDurations: input.estimatedDurations as StartTaskRunRequest["estimatedDurations"] }),
      ...(input.workspace ? { workspace: input.workspace as StartTaskRunRequest["workspace"] } : {}),
      ...(input.host ? { host: input.host as StartTaskRunRequest["host"] } : {}),
      cwd: taskCwd,
    };
    return { ok: true, op, result: startTaskRun(request) };
  }
  if (op === "run-resume") {
    return { ok: true, op, result: resumeTaskRun({
      root: taskRoot, taskDir: requireTaskDir(input.taskDir), expectedRevision: requireRevision(input.expectedRevision), runId: requireString(input.runId, "runId"),
      actor: requireString(input.actor, "actor"), idempotencyKey: requireString(input.idempotencyKey, "idempotencyKey"), cwd: taskCwd,
    }) };
  }
  if (op === "run-result") {
    if (input.failure !== undefined && input.failure !== null && !isPlainObject(input.failure)) throw new KernelError("INVALID_REQUEST", "failure must be a JSON object");
    const request: RecordTaskRunResultRequest = {
      root: taskRoot, taskDir: requireTaskDir(input.taskDir), expectedRevision: requireRevision(input.expectedRevision), runId: requireString(input.runId, "runId"),
      outcome: requireString(input.outcome, "outcome") as RecordTaskRunResultRequest["outcome"],
      ...(input.summary === undefined ? {} : { summary: requireString(input.summary, "summary") }),
      evidenceRefs: input.evidenceRefs === undefined ? [] : parseStringArray(input.evidenceRefs, "evidenceRefs"),
      candidateEntries: input.candidateEntries === undefined ? [] : input.candidateEntries as RecordTaskRunResultRequest["candidateEntries"],
      ...(input.measurementRefs === undefined ? {} : { measurementRefs: input.measurementRefs as RecordTaskRunResultRequest["measurementRefs"] }),
      ...(input.failure ? { failure: input.failure as RecordTaskRunResultRequest["failure"] } : {}),
      actor: requireString(input.actor, "actor"), idempotencyKey: requireString(input.idempotencyKey, "idempotencyKey"), cwd: taskCwd,
    };
    return { ok: true, op, result: recordTaskRunResult(request) };
  }
  if (op === "review-record") {
    if (input.acceptanceEvidence !== undefined && input.acceptanceEvidence !== null && !isPlainObject(input.acceptanceEvidence)) throw new KernelError("INVALID_REQUEST", "acceptanceEvidence must be a JSON object");
    if (input.unresolvedBlockers !== undefined) parseStringArray(input.unresolvedBlockers, "unresolvedBlockers", true);
    const request: RecordTaskReviewRequest = {
      root: taskRoot, taskDir: requireTaskDir(input.taskDir), expectedRevision: requireRevision(input.expectedRevision), runId: requireString(input.runId, "runId"),
      candidateSnapshotId: requireString(input.candidateSnapshotId, "candidateSnapshotId"), candidateFingerprint: requireString(input.candidateFingerprint, "candidateFingerprint"), reviewer: requireString(input.reviewer, "reviewer"),
      decision: requireString(input.decision, "decision") as RecordTaskReviewRequest["decision"],
      evidenceRefs: parseStringArray(input.evidenceRefs, "evidenceRefs"),
      ...(input.acceptanceEvidence ? { acceptanceEvidence: input.acceptanceEvidence as Record<string, string[]> } : {}),
      ...(input.unresolvedBlockers ? { unresolvedBlockers: parseStringArray(input.unresolvedBlockers, "unresolvedBlockers", true) } : {}),
      ...(input.measurementRef === undefined ? {} : { measurementRef: requireString(input.measurementRef, "measurementRef") }),
      actor: requireString(input.actor, "actor"), idempotencyKey: requireString(input.idempotencyKey, "idempotencyKey"), cwd: taskCwd,
    };
    return { ok: true, op, result: recordTaskReview(request) };
  }
  if (op === "task-close-check") {
    if (!isPlainObject(input.deliveryEvidence)) throw new KernelError("INVALID_REQUEST", "deliveryEvidence must be a JSON object");
    if (!isPlainObject(input.candidateObservation)) throw new KernelError("INVALID_REQUEST", "candidateObservation must be a JSON object");
    const request: CheckTaskCloseRequest = {
      root: taskRoot, taskDir: requireTaskDir(input.taskDir), expectedRevision: requireRevision(input.expectedRevision),
      runId: requireString(input.runId, "runId"), reviewId: requireString(input.reviewId, "reviewId"),
      candidateObservation: input.candidateObservation as unknown as CloseTaskKernelRequest["candidateObservation"],
      deliveryEvidence: input.deliveryEvidence as unknown as CloseTaskKernelRequest["deliveryEvidence"], cwd: taskCwd,
    };
    return { ok: true, op, errors: checkTaskClose(request) };
  }
  if (op === "task-close") {
    if (!isPlainObject(input.deliveryEvidence)) throw new KernelError("INVALID_REQUEST", "deliveryEvidence must be a JSON object");
    if (!isPlainObject(input.candidateObservation)) throw new KernelError("INVALID_REQUEST", "candidateObservation must be a JSON object");
    const request: CloseTaskKernelRequest = {
      root: taskRoot, taskDir: requireTaskDir(input.taskDir), expectedRevision: requireRevision(input.expectedRevision),
      runId: requireString(input.runId, "runId"), reviewId: requireString(input.reviewId, "reviewId"),
      candidateObservation: input.candidateObservation as unknown as CloseTaskKernelRequest["candidateObservation"],
      deliveryEvidence: input.deliveryEvidence as unknown as CloseTaskKernelRequest["deliveryEvidence"],
      actor: requireString(input.actor, "actor"), idempotencyKey: requireString(input.idempotencyKey, "idempotencyKey"), cwd: taskCwd,
    };
    return { ok: true, op, result: closeTaskKernel(request) };
  }
  throw new KernelError(
    "INVALID_REQUEST",
    `unsupported Kernel op: ${String(op)}`,
  );
}

function parseTransitionRequest(
  input: Record<string, unknown>,
  cwd: string | undefined,
): TransitionRequest {
  if (!isKernelPhase(input.targetPhase)) {
    throw new KernelError("INVALID_REQUEST", "targetPhase is not a Kernel phase");
  }
  if (!isNonNegativeInt(input.expectedRevision)) {
    throw new KernelError(
      "INVALID_REQUEST",
      "expectedRevision must be a non-negative integer",
    );
  }
  const request: TransitionRequest = {
    taskDir: requireTaskDir(input.taskDir),
    expectedRevision: input.expectedRevision,
    targetPhase: input.targetPhase,
    actor: requireString(input.actor, "actor"),
    idempotencyKey: requireString(input.idempotencyKey, "idempotencyKey"),
    cwd: optionalCwd(input.cwd, cwd),
  };
  if (input.evidence !== undefined) {
    request.evidence = requireString(input.evidence, "evidence");
  }
  if (input.gate !== undefined) {
    request.gate = input.gate;
  }
  if (input.policy !== undefined) {
    request.policy = input.policy;
  }
  return request;
}

function parseCreateRequest(
  input: Record<string, unknown>,
  cwd: string | undefined,
): KernelCreateRequest {
  return {
    taskDir: requireTaskDir(input.taskDir),
    actor: requireString(input.actor, "actor"),
    idempotencyKey: requireString(input.idempotencyKey, "idempotencyKey"),
    record: parseRecord(input.record),
    extras: parseExtras(input.extras),
    evidence:
      input.evidence === undefined
        ? undefined
        : requireString(input.evidence, "evidence"),
    gate: input.gate,
    policy: input.policy,
    cwd: optionalCwd(input.cwd, cwd),
  };
}

function parseStartRequest(
  input: Record<string, unknown>,
  cwd: string | undefined,
): KernelStartRequest {
  if (!isNonNegativeInt(input.expectedRevision)) {
    throw new KernelError(
      "INVALID_REQUEST",
      "expectedRevision must be a non-negative integer",
    );
  }
  return {
    taskDir: requireTaskDir(input.taskDir),
    expectedRevision: input.expectedRevision,
    actor: requireString(input.actor, "actor"),
    idempotencyKey: requireString(input.idempotencyKey, "idempotencyKey"),
    record: parseRecord(input.record),
    extras: parseExtras(input.extras),
    evidence:
      input.evidence === undefined
        ? undefined
        : requireString(input.evidence, "evidence"),
    gate: input.gate,
    policy: input.policy,
    cwd: optionalCwd(input.cwd, cwd),
  };
}

function parseRecordGateRequest(
  input: Record<string, unknown>,
  cwd: string | undefined,
): KernelRecordGateRequest {
  if (!isNonNegativeInt(input.expectedRevision)) {
    throw new KernelError(
      "INVALID_REQUEST",
      "expectedRevision must be a non-negative integer",
    );
  }
  if (!isPlainObject(input.record)) {
    throw new KernelError("INVALID_REQUEST", "record must be a JSON object");
  }
  return {
    taskDir: requireTaskDir(input.taskDir),
    expectedRevision: input.expectedRevision,
    actor: requireString(input.actor, "actor"),
    idempotencyKey: requireString(input.idempotencyKey, "idempotencyKey"),
    transition: requireString(input.transition, "transition"),
    gateName: requireString(input.gate, "gate"),
    record: input.record,
    extras: parseExtras(input.extras),
    evidence:
      input.evidence === undefined
        ? undefined
        : requireString(input.evidence, "evidence"),
    cwd: optionalCwd(input.cwd, cwd),
  };
}

function parseArchiveRequest(
  input: Record<string, unknown>,
  cwd: string | undefined,
): KernelArchiveRequest {
  if (!isNonNegativeInt(input.expectedRevision)) {
    throw new KernelError(
      "INVALID_REQUEST",
      "expectedRevision must be a non-negative integer",
    );
  }
  return {
    taskDir: requireTaskDir(input.taskDir),
    expectedRevision: input.expectedRevision,
    actor: requireString(input.actor, "actor"),
    idempotencyKey: requireString(input.idempotencyKey, "idempotencyKey"),
    record: parseRecord(input.record),
    extras: parseExtras(input.extras),
    evidence:
      input.evidence === undefined
        ? undefined
        : requireString(input.evidence, "evidence"),
    gate: input.gate,
    policy: input.policy,
    cwd: optionalCwd(input.cwd, cwd),
  };
}

function parsePatchRequest(
  input: Record<string, unknown>,
  cwd: string | undefined,
): KernelPatchRequest {
  if (!isNonNegativeInt(input.expectedRevision)) {
    throw new KernelError(
      "INVALID_REQUEST",
      "expectedRevision must be a non-negative integer",
    );
  }
  if (input.record !== undefined && input.record !== null && !isPlainObject(input.record)) {
    throw new KernelError("INVALID_REQUEST", "record must be a JSON object");
  }
  return {
    taskDir: requireTaskDir(input.taskDir),
    expectedRevision: input.expectedRevision,
    actor: requireString(input.actor, "actor"),
    idempotencyKey: requireString(input.idempotencyKey, "idempotencyKey"),
    record: input.record,
    extras: parseExtras(input.extras),
    evidence:
      input.evidence === undefined
        ? undefined
        : requireString(input.evidence, "evidence"),
    gate: input.gate,
    policy: input.policy,
    cwd: optionalCwd(input.cwd, cwd),
  };
}

function parseRecord(value: unknown): PactileTaskRecord {
  try {
    return taskRecordSchema.parse(value);
  } catch (err) {
    throw new KernelError(
      "INVALID_REQUEST",
      `record is not a canonical task.json shape: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function parseMigrateDryRun(
  input: Record<string, unknown>,
  cwd: string | undefined,
): ContractMigrateReport {
  if (input.dryRun !== true) {
    throw new KernelError(
      "INVALID_REQUEST",
      "migrate is read-only and requires dryRun: true",
    );
  }
  const root =
    typeof input.cwd === "string" && input.cwd.trim() !== ""
      ? input.cwd
      : cwd ?? process.cwd();
  const tasksDir =
    input.tasksDir === undefined || input.tasksDir === null
      ? undefined
      : requireString(input.tasksDir, "tasksDir");
  return scanContractMigration({ root, tasksDir });
}

function parseExtras(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    throw new KernelError("INVALID_REQUEST", "extras must be a JSON object");
  }
  return value;
}

function requireTaskDir(value: unknown): string {
  return requireString(value, "taskDir");
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new KernelError("INVALID_REQUEST", `${field} must be a non-empty string`);
  }
  return value;
}

function requireRevision(value: unknown): number {
  if (!isNonNegativeInt(value)) throw new KernelError("INVALID_REQUEST", "expectedRevision must be a non-negative integer");
  return value;
}

function requestRoot(value: unknown, cwd: string | undefined): string {
  if (value === undefined || value === null) return cwd ?? process.cwd();
  return requireString(value, "root");
}

function parseStringArray(value: unknown, field: string, allowEmpty = true): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new KernelError("INVALID_REQUEST", `${field} must be an array of non-empty strings`);
  }
  if (!allowEmpty && value.length === 0) throw new KernelError("INVALID_REQUEST", `${field} must contain at least one reference`);
  return [...value] as string[];
}

function optionalCwd(fromRequest: unknown, fallback: string | undefined): string | undefined {
  if (fromRequest === undefined || fromRequest === null) return fallback;
  if (typeof fromRequest !== "string" || fromRequest.trim() === "") {
    throw new KernelError("INVALID_REQUEST", "cwd must be a non-empty string");
  }
  return fromRequest;
}

function toFailure(err: unknown): KernelCliFailure {
  if (err instanceof KernelError) {
    const failure: KernelCliFailure = {
      ok: false,
      error: { code: err.code, message: err.message },
    };
    if (err.code === "HALF_CONVERSION") {
      failure.halfConversion = {
        kernelPersisted: true,
        projectionPersisted: false,
      };
    }
    return failure;
  }
  return {
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    stream.on("error", reject);
  });
}
