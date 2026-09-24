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

export type KernelCliSuccess =
  | ({ ok: true; op: "inspect-projection" } & ProjectionInspection)
  | ({ ok: true; op: "repair-projection" } & ProjectionRepairReceipt)
  | ({ ok: true; op: "read" } & KernelReadResult)
  | ({ ok: true; op: "transition" } & KernelTransitionResult)
  | ({
      ok: true;
      op: "create" | "start" | "record-gate" | "archive" | "patch";
    } & KernelCommandResult)
  | ({ ok: true; op: "migrate" } & ContractMigrateReport);

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
