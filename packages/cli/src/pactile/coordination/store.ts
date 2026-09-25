import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertCanonicalWriteTarget } from "../runtime/paths.js";
import {
  canonicalCoordinationJson,
  coordinationEnvelopeSchema,
  coordinationEventHash,
  coordinationEventSchema,
  COORDINATION_GENESIS_HASH,
  hasForbiddenCoordinationControl,
  COORDINATION_MAX_EVENT_BYTES,
  COORDINATION_MAX_LOG_BYTES,
  COORDINATION_MAX_LOG_EVENTS,
  redactCoordinationText,
  type CoordinationActor,
  type CoordinationEnvelope,
  type CoordinationEvidenceLevel,
  type CoordinationEvent,
  type CoordinationMessageCreated,
  type CoordinationMessageReceipt,
  type CoordinationMessageSnapshot,
  type CoordinationMessageStatus,
  type CoordinationRunProgress,
  type CoordinationRunResult,
  type CoordinationRunSnapshot,
  type CoordinationRunStarted,
  type CoordinationSnapshot,
  type CoordinationTaskBlocked,
  type CoordinationTaskUnblocked,
} from "./model.js";

export type CoordinationErrorCode =
  | "invalid-input"
  | "unsafe-path"
  | "store-corrupt"
  | "store-locked"
  | "store-limit"
  | "state-conflict"
  | "store-io";

export class CoordinationError extends Error {
  constructor(readonly code: CoordinationErrorCode) {
    super(code);
    this.name = "CoordinationError";
  }
}

export interface CreateCoordinationMessageInput {
  messageId?: string;
  fromTaskId: string;
  toTaskId: string;
  fromRunId?: string | null;
  toRunId?: string | null;
  sender: CoordinationActor;
  evidenceLevel: CoordinationEvidenceLevel;
  body: string;
  requestId?: string | null;
  hostRef?: string | null;
}

export interface RecordCoordinationReceiptInput {
  messageId: string;
  receiptId: string;
  status: CoordinationMessageReceipt["status"];
  actor: CoordinationActor;
  evidenceLevel: CoordinationEvidenceLevel;
  externalRef?: string | null;
  note?: string | null;
}

export interface BlockCoordinationTaskInput {
  taskId: string;
  blockId?: string;
  blockedByTaskId?: string | null;
  messageId?: string | null;
  reason: string;
  actor: CoordinationActor;
  evidenceLevel: CoordinationEvidenceLevel;
}

export interface UnblockCoordinationTaskInput {
  taskId: string;
  blockId: string;
  unblockedByTaskId?: string | null;
  resolutionMessageId?: string | null;
  reason: string;
  actor: CoordinationActor;
  evidenceLevel: CoordinationEvidenceLevel;
}

export interface StartCoordinationRunInput {
  taskId: string;
  runId: string;
  role?: string | null;
  workspaceId?: string | null;
  providerRunId?: string | null;
  actor: CoordinationActor;
  evidenceLevel: CoordinationEvidenceLevel;
}

export interface RecordCoordinationRunProgressInput {
  taskId: string;
  runId: string;
  sequence: number;
  name: string;
  summary: string;
  evidenceRefs?: string[];
  actor: CoordinationActor;
  evidenceLevel: CoordinationEvidenceLevel;
}

export interface RecordCoordinationRunResultInput {
  taskId: string;
  runId: string;
  outcome: CoordinationRunResult["outcome"];
  summary: string;
  evidenceRefs?: string[];
  actor: CoordinationActor;
  evidenceLevel: CoordinationEvidenceLevel;
}

interface RunState {
  started: CoordinationRunStarted;
  progress: CoordinationRunProgress[];
  result: CoordinationRunResult | null;
}

interface ReplayState {
  events: CoordinationEvent[];
  eventIds: Set<string>;
  messages: Map<string, CoordinationMessageCreated>;
  receipts: Map<string, CoordinationMessageReceipt[]>;
  receiptIds: Map<string, CoordinationMessageReceipt>;
  blocks: Map<string, CoordinationTaskBlocked>;
  activeBlocks: Map<string, CoordinationTaskBlocked>;
  unblocks: Map<string, CoordinationTaskUnblocked>;
  runs: Map<string, RunState>;
}

interface JournalRead {
  state: ReplayState;
  bytes: number;
  lastHash: string;
}

type TransactionDecision<T extends CoordinationEvent> =
  | { kind: "append"; event: T }
  | { kind: "existing"; event: T };

const STORE_RELATIVE_DIR = ".pactile/runtime/coordination";
const STORE_FILE = `${STORE_RELATIVE_DIR}/events.jsonl`;
const LOCK_FILE = `${STORE_RELATIVE_DIR}/events.lock`;
const LOGICAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RECEIPT_TRANSITIONS: Record<
  CoordinationMessageStatus,
  readonly CoordinationMessageReceipt["status"][]
> = {
  pending: ["queued", "sent", "delivered", "acknowledged", "failed"],
  queued: ["sent", "delivered", "acknowledged", "failed"],
  sent: ["delivered", "acknowledged", "failed"],
  delivered: ["acknowledged", "failed"],
  acknowledged: [],
  failed: [],
};

function createReplayState(): ReplayState {
  return {
    events: [],
    eventIds: new Set(),
    messages: new Map(),
    receipts: new Map(),
    receiptIds: new Map(),
    blocks: new Map(),
    activeBlocks: new Map(),
    unblocks: new Map(),
    runs: new Map(),
  };
}

function runStateKey(runId: string): string {
  return runId;
}

function receiptStateKey(messageId: string, receiptId: string): string {
  return `${messageId}\u0000${receiptId}`;
}

function cloneEvent<T extends CoordinationEvent>(event: T): T {
  return JSON.parse(JSON.stringify(event)) as T;
}

function sameEventPayload(
  existing: CoordinationEvent,
  candidate: CoordinationEvent,
): boolean {
  const stripMeta = (event: CoordinationEvent): Record<string, unknown> => {
    const payload = { ...event } as Record<string, unknown>;
    delete payload.event_id;
    delete payload.recorded_at;
    return payload;
  };
  return (
    canonicalCoordinationJson(stripMeta(existing)) ===
    canonicalCoordinationJson(stripMeta(candidate))
  );
}

function invalidInput<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof CoordinationError) throw error;
    throw new CoordinationError("invalid-input");
  }
}

function normalizedId(value: string): string {
  if (
    typeof value !== "string" ||
    !LOGICAL_ID_PATTERN.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new CoordinationError("invalid-input");
  }
  return value;
}

function normalizedNullableId(value: string | null | undefined): string | null {
  return value == null ? null : normalizedId(value);
}

function normalizedActor(value: CoordinationActor): CoordinationActor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CoordinationError("invalid-input");
  }
  if (
    !(["codex", "pi", "pactile", "user", "host", "other"] as const).includes(
      value.platform,
    )
  ) {
    throw new CoordinationError("invalid-input");
  }
  return { platform: value.platform, id: normalizedNullableId(value.id) };
}

function normalizedText(value: string): string {
  if (typeof value !== "string") throw new CoordinationError("invalid-input");
  const normalized = redactCoordinationText(value);
  if (!normalized || Buffer.byteLength(normalized, "utf8") > 4_096) {
    throw new CoordinationError("invalid-input");
  }
  return normalized;
}

function normalizedEvidenceRefs(values: string[] | undefined): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 16) {
    throw new CoordinationError("invalid-input");
  }
  return values.map((value) => {
    if (
      typeof value !== "string" ||
      !value ||
      value.length > 512 ||
      value.startsWith("/") ||
      value.startsWith("\\") ||
      /^[A-Za-z]:/u.test(value) ||
      value.includes("\\") ||
      /[<>:"|?*]/u.test(value) ||
      hasForbiddenCoordinationControl(value) ||
      value.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new CoordinationError("invalid-input");
    }
    return value;
  });
}

function newBase(type: CoordinationEvent["type"]): {
  schema_version: 1;
  event_id: string;
  recorded_at: string;
  type: CoordinationEvent["type"];
} {
  return {
    schema_version: 1,
    event_id: randomUUID(),
    recorded_at: new Date().toISOString(),
    type,
  };
}

function currentMessageStatus(
  state: ReplayState,
  messageId: string,
): CoordinationMessageStatus {
  return state.receipts.get(messageId)?.at(-1)?.status ?? "pending";
}

function assertRunBinding(
  state: ReplayState,
  taskId: string,
  runId: string,
): RunState {
  const run = state.runs.get(runStateKey(runId));
  if (run?.started.task_id !== taskId) {
    throw new CoordinationError("state-conflict");
  }
  return run;
}

function applyEvent(state: ReplayState, event: CoordinationEvent): void {
  if (state.eventIds.has(event.event_id)) {
    throw new CoordinationError("state-conflict");
  }
  switch (event.type) {
    case "message.created": {
      if (
        event.from_task_id === event.to_task_id ||
        state.messages.has(event.message_id)
      ) {
        throw new CoordinationError("state-conflict");
      }
      if (event.from_run_id) {
        assertRunBinding(state, event.from_task_id, event.from_run_id);
      }
      if (event.to_run_id) {
        assertRunBinding(state, event.to_task_id, event.to_run_id);
      }
      state.messages.set(event.message_id, event);
      state.receipts.set(event.message_id, []);
      break;
    }
    case "message.receipt": {
      const message = state.messages.get(event.message_id);
      if (!message) throw new CoordinationError("state-conflict");
      const key = receiptStateKey(event.message_id, event.receipt_id);
      if (state.receiptIds.has(key))
        throw new CoordinationError("state-conflict");
      const status = currentMessageStatus(state, event.message_id);
      if (!RECEIPT_TRANSITIONS[status].includes(event.status)) {
        throw new CoordinationError("state-conflict");
      }
      state.receiptIds.set(key, event);
      state.receipts.get(event.message_id)?.push(event);
      break;
    }
    case "task.blocked": {
      if (
        state.blocks.has(event.block_id) ||
        state.activeBlocks.has(event.task_id)
      ) {
        throw new CoordinationError("state-conflict");
      }
      if (event.message_id) {
        const message = state.messages.get(event.message_id);
        if (
          message?.to_task_id !== event.task_id ||
          (event.blocked_by_task_id !== null &&
            message?.from_task_id !== event.blocked_by_task_id)
        ) {
          throw new CoordinationError("state-conflict");
        }
      }
      state.blocks.set(event.block_id, event);
      state.activeBlocks.set(event.task_id, event);
      break;
    }
    case "task.unblocked": {
      const block = state.blocks.get(event.block_id);
      if (
        block?.task_id !== event.task_id ||
        state.activeBlocks.get(event.task_id)?.block_id !== event.block_id ||
        state.unblocks.has(event.block_id)
      ) {
        throw new CoordinationError("state-conflict");
      }
      if (event.resolution_message_id) {
        const message = state.messages.get(event.resolution_message_id);
        if (
          message?.to_task_id !== event.task_id ||
          (event.unblocked_by_task_id !== null &&
            message?.from_task_id !== event.unblocked_by_task_id)
        ) {
          throw new CoordinationError("state-conflict");
        }
      }
      state.unblocks.set(event.block_id, event);
      state.activeBlocks.delete(event.task_id);
      break;
    }
    case "run.started": {
      if (state.runs.has(runStateKey(event.run_id))) {
        throw new CoordinationError("state-conflict");
      }
      state.runs.set(runStateKey(event.run_id), {
        started: event,
        progress: [],
        result: null,
      });
      break;
    }
    case "run.progress": {
      const run = assertRunBinding(state, event.task_id, event.run_id);
      const lastProgress = run.progress.at(-1);
      if (
        run.result ||
        (lastProgress !== undefined && event.sequence <= lastProgress.sequence)
      ) {
        throw new CoordinationError("state-conflict");
      }
      run.progress.push(event);
      break;
    }
    case "run.result": {
      const run = assertRunBinding(state, event.task_id, event.run_id);
      if (run.result) throw new CoordinationError("state-conflict");
      run.result = event;
      break;
    }
  }
  state.eventIds.add(event.event_id);
  state.events.push(event);
}

function safeTarget(root: string, target: string): string {
  try {
    return assertCanonicalWriteTarget(root, target);
  } catch {
    throw new CoordinationError("unsafe-path");
  }
}

function errorCode(error: unknown): string | null {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}

function ensureStoreDirectory(root: string): void {
  const directory = path.join(
    path.resolve(root),
    ...STORE_RELATIVE_DIR.split("/"),
  );
  const target = safeTarget(root, directory);
  try {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    safeTarget(root, target);
  } catch (error) {
    if (error instanceof CoordinationError) throw error;
    throw new CoordinationError("store-io");
  }
}

function withStoreLock<T>(root: string, action: () => T): T {
  ensureStoreDirectory(root);
  const lockPath = path.join(path.resolve(root), ...LOCK_FILE.split("/"));
  const target = safeTarget(root, lockPath);
  const token = randomUUID();
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new CoordinationError("unsafe-path");
    }
    fs.writeFileSync(descriptor, token, "utf8");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        /* The primary lock failure is reported below. */
      }
      descriptor = null;
    }
    if (error instanceof CoordinationError) throw error;
    if (errorCode(error) === "EEXIST") {
      throw new CoordinationError("store-locked");
    }
    throw new CoordinationError("store-io");
  }
  try {
    const lockDescriptor = descriptor;
    if (lockDescriptor === null) throw new CoordinationError("store-io");
    descriptor = null;
    try {
      fs.closeSync(lockDescriptor);
    } catch {
      throw new CoordinationError("store-io");
    }
    return action();
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        /* A write error remains the primary result. */
      }
    }
    try {
      const lockTarget = safeTarget(root, target);
      const readDescriptor = fs.openSync(
        lockTarget,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      let ownsLock = false;
      try {
        const stat = fs.fstatSync(readDescriptor);
        ownsLock =
          stat.isFile() &&
          stat.nlink === 1 &&
          fs.readFileSync(readDescriptor, { encoding: "utf8" }) === token;
      } finally {
        fs.closeSync(readDescriptor);
      }
      if (ownsLock) fs.unlinkSync(safeTarget(root, target));
    } catch {
      /* A leftover lock is visible and is never removed unless it is ours. */
    }
  }
}

function readJournal(root: string): JournalRead {
  const file = path.join(path.resolve(root), ...STORE_FILE.split("/"));
  const target = safeTarget(root, file);
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return {
        state: createReplayState(),
        bytes: 0,
        lastHash: COORDINATION_GENESIS_HASH,
      };
    }
    throw new CoordinationError("store-io");
  }

  let content: string;
  let byteLength: number;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new CoordinationError("unsafe-path");
    }
    if (stat.size > COORDINATION_MAX_LOG_BYTES) {
      throw new CoordinationError("store-limit");
    }
    byteLength = stat.size;
    content = fs.readFileSync(descriptor, { encoding: "utf8" });
  } catch (error) {
    if (error instanceof CoordinationError) throw error;
    throw new CoordinationError("store-io");
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch {
      /* Read failures are reported by the original operation. */
    }
  }

  const state = createReplayState();
  if (content.length === 0) {
    return { state, bytes: byteLength, lastHash: COORDINATION_GENESIS_HASH };
  }
  if (!content.endsWith("\n")) {
    const lockPath = path.join(path.resolve(root), ...LOCK_FILE.split("/"));
    if (fs.existsSync(lockPath)) throw new CoordinationError("store-locked");
    throw new CoordinationError("store-corrupt");
  }

  const lines = content.slice(0, -1).split("\n");
  if (lines.length > COORDINATION_MAX_LOG_EVENTS) {
    throw new CoordinationError("store-limit");
  }
  let lastHash = COORDINATION_GENESIS_HASH;
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > COORDINATION_MAX_EVENT_BYTES) {
      throw new CoordinationError("store-corrupt");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new CoordinationError("store-corrupt");
    }
    const envelopeResult = coordinationEnvelopeSchema.safeParse(parsed);
    if (!envelopeResult.success) throw new CoordinationError("store-corrupt");
    const envelope: CoordinationEnvelope = envelopeResult.data;
    if (
      envelope.previous_hash !== lastHash ||
      coordinationEventHash(lastHash, envelope.event) !== envelope.hash
    ) {
      throw new CoordinationError("store-corrupt");
    }
    try {
      applyEvent(state, envelope.event);
    } catch {
      throw new CoordinationError("store-corrupt");
    }
    lastHash = envelope.hash;
  }
  return { state, bytes: byteLength, lastHash };
}

function appendEnvelope(
  root: string,
  journal: JournalRead,
  event: CoordinationEvent,
): void {
  const envelope: CoordinationEnvelope = {
    schema_version: 1,
    previous_hash: journal.lastHash,
    hash: coordinationEventHash(journal.lastHash, event),
    event,
  };
  const line = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
  if (line.byteLength > COORDINATION_MAX_EVENT_BYTES) {
    throw new CoordinationError("store-limit");
  }
  if (
    journal.state.events.length >= COORDINATION_MAX_LOG_EVENTS ||
    journal.bytes + line.byteLength > COORDINATION_MAX_LOG_BYTES
  ) {
    throw new CoordinationError("store-limit");
  }
  const file = path.join(path.resolve(root), ...STORE_FILE.split("/"));
  const target = safeTarget(root, file);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_WRONLY |
        fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new CoordinationError("unsafe-path");
    }
    if (stat.size !== journal.bytes) {
      throw new CoordinationError("state-conflict");
    }
    safeTarget(root, target);
    let offset = 0;
    while (offset < line.byteLength) {
      const written = fs.writeSync(
        descriptor,
        line,
        offset,
        line.byteLength - offset,
        null,
      );
      if (written < 1) throw new CoordinationError("store-io");
      offset += written;
    }
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof CoordinationError) throw error;
    throw new CoordinationError("store-io");
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        /* A committed journal line has already been synced. */
      }
    }
  }
}

function parseEvent<T extends CoordinationEvent>(event: T): T {
  const parsed = coordinationEventSchema.safeParse(event);
  if (!parsed.success) throw new CoordinationError("invalid-input");
  return parsed.data as T;
}

function toSnapshot(state: ReplayState): CoordinationSnapshot {
  const messages: CoordinationMessageSnapshot[] = [
    ...state.messages.values(),
  ].map((message) => {
    const receipts = state.receipts.get(message.message_id) ?? [];
    return {
      message,
      status: receipts.at(-1)?.status ?? "pending",
      receipts,
    };
  });
  const runs: CoordinationRunSnapshot[] = [...state.runs.values()].map(
    ({ started, progress, result }) => ({ started, progress, result }),
  );
  return {
    events: state.events.map((event) => cloneEvent(event)),
    messages: messages.map(
      (message) =>
        JSON.parse(JSON.stringify(message)) as CoordinationMessageSnapshot,
    ),
    blocked_tasks: [...state.activeBlocks.values()].map((event) =>
      cloneEvent(event),
    ),
    runs: runs.map(
      (run) => JSON.parse(JSON.stringify(run)) as CoordinationRunSnapshot,
    ),
  };
}

/**
 * Project-local, append-only coordination journal. It has no host calls or
 * background process; adapters may attach host/provider receipts afterward.
 */
export class CoordinationStore {
  readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  snapshot(): CoordinationSnapshot {
    return toSnapshot(readJournal(this.projectRoot).state);
  }

  createMessage(
    input: CreateCoordinationMessageInput,
  ): CoordinationMessageCreated {
    const normalized = invalidInput(() => ({
      messageId: normalizedId(input.messageId ?? randomUUID()),
      fromTaskId: normalizedId(input.fromTaskId),
      toTaskId: normalizedId(input.toTaskId),
      fromRunId: normalizedNullableId(input.fromRunId),
      toRunId: normalizedNullableId(input.toRunId),
      sender: normalizedActor(input.sender),
      evidenceLevel: input.evidenceLevel,
      body: normalizedText(input.body),
      requestId: normalizedNullableId(input.requestId),
      hostRef: normalizedNullableId(input.hostRef),
    }));
    const candidate = parseEvent({
      ...newBase("message.created"),
      type: "message.created",
      message_id: normalized.messageId,
      from_task_id: normalized.fromTaskId,
      to_task_id: normalized.toTaskId,
      from_run_id: normalized.fromRunId,
      to_run_id: normalized.toRunId,
      sender: normalized.sender,
      evidence_level: normalized.evidenceLevel,
      body: normalized.body,
      request_id: normalized.requestId,
      host_ref: normalized.hostRef,
    } as CoordinationMessageCreated);
    return this.transact((state) => {
      const existing = state.messages.get(candidate.message_id);
      if (existing) {
        if (sameEventPayload(existing, candidate))
          return { kind: "existing", event: existing };
        throw new CoordinationError("state-conflict");
      }
      return { kind: "append", event: candidate };
    }) as CoordinationMessageCreated;
  }

  recordMessageReceipt(
    input: RecordCoordinationReceiptInput,
  ): CoordinationMessageReceipt {
    const normalized = invalidInput(() => ({
      messageId: normalizedId(input.messageId),
      receiptId: normalizedId(input.receiptId),
      status: input.status,
      actor: normalizedActor(input.actor),
      evidenceLevel: input.evidenceLevel,
      externalRef: normalizedNullableId(input.externalRef),
      note: input.note?.trim() ? normalizedText(input.note) : null,
    }));
    const candidate = parseEvent({
      ...newBase("message.receipt"),
      type: "message.receipt",
      message_id: normalized.messageId,
      receipt_id: normalized.receiptId,
      status: normalized.status,
      actor: normalized.actor,
      evidence_level: normalized.evidenceLevel,
      external_ref: normalized.externalRef,
      note: normalized.note,
    } as CoordinationMessageReceipt);
    return this.transact((state) => {
      const key = receiptStateKey(candidate.message_id, candidate.receipt_id);
      const existing = state.receiptIds.get(key);
      if (existing) {
        if (sameEventPayload(existing, candidate))
          return { kind: "existing", event: existing };
        throw new CoordinationError("state-conflict");
      }
      return { kind: "append", event: candidate };
    }) as CoordinationMessageReceipt;
  }

  blockTask(input: BlockCoordinationTaskInput): CoordinationTaskBlocked {
    const normalized = invalidInput(() => ({
      taskId: normalizedId(input.taskId),
      blockId: normalizedId(input.blockId ?? randomUUID()),
      blockedByTaskId: normalizedNullableId(input.blockedByTaskId),
      messageId: normalizedNullableId(input.messageId),
      reason: normalizedText(input.reason),
      actor: normalizedActor(input.actor),
      evidenceLevel: input.evidenceLevel,
    }));
    const candidate = parseEvent({
      ...newBase("task.blocked"),
      type: "task.blocked",
      task_id: normalized.taskId,
      block_id: normalized.blockId,
      blocked_by_task_id: normalized.blockedByTaskId,
      message_id: normalized.messageId,
      reason: normalized.reason,
      actor: normalized.actor,
      evidence_level: normalized.evidenceLevel,
    } as CoordinationTaskBlocked);
    return this.transact((state) => {
      const existing = state.blocks.get(candidate.block_id);
      if (existing) {
        if (sameEventPayload(existing, candidate))
          return { kind: "existing", event: existing };
        throw new CoordinationError("state-conflict");
      }
      return { kind: "append", event: candidate };
    }) as CoordinationTaskBlocked;
  }

  unblockTask(input: UnblockCoordinationTaskInput): CoordinationTaskUnblocked {
    const normalized = invalidInput(() => ({
      taskId: normalizedId(input.taskId),
      blockId: normalizedId(input.blockId),
      unblockedByTaskId: normalizedNullableId(input.unblockedByTaskId),
      resolutionMessageId: normalizedNullableId(input.resolutionMessageId),
      reason: normalizedText(input.reason),
      actor: normalizedActor(input.actor),
      evidenceLevel: input.evidenceLevel,
    }));
    const candidate = parseEvent({
      ...newBase("task.unblocked"),
      type: "task.unblocked",
      task_id: normalized.taskId,
      block_id: normalized.blockId,
      unblocked_by_task_id: normalized.unblockedByTaskId,
      resolution_message_id: normalized.resolutionMessageId,
      reason: normalized.reason,
      actor: normalized.actor,
      evidence_level: normalized.evidenceLevel,
    } as CoordinationTaskUnblocked);
    return this.transact((state) => {
      const existing = state.unblocks.get(candidate.block_id);
      if (existing) {
        if (sameEventPayload(existing, candidate))
          return { kind: "existing", event: existing };
        throw new CoordinationError("state-conflict");
      }
      return { kind: "append", event: candidate };
    }) as CoordinationTaskUnblocked;
  }

  startRun(input: StartCoordinationRunInput): CoordinationRunStarted {
    const normalized = invalidInput(() => ({
      taskId: normalizedId(input.taskId),
      runId: normalizedId(input.runId),
      role: normalizedNullableId(input.role),
      workspaceId: normalizedNullableId(input.workspaceId),
      providerRunId: normalizedNullableId(input.providerRunId),
      actor: normalizedActor(input.actor),
      evidenceLevel: input.evidenceLevel,
    }));
    const candidate = parseEvent({
      ...newBase("run.started"),
      type: "run.started",
      task_id: normalized.taskId,
      run_id: normalized.runId,
      role: normalized.role,
      workspace_id: normalized.workspaceId,
      provider_run_id: normalized.providerRunId,
      actor: normalized.actor,
      evidence_level: normalized.evidenceLevel,
    } as CoordinationRunStarted);
    return this.transact((state) => {
      const existing = state.runs.get(candidate.run_id)?.started;
      if (existing) {
        if (sameEventPayload(existing, candidate))
          return { kind: "existing", event: existing };
        throw new CoordinationError("state-conflict");
      }
      return { kind: "append", event: candidate };
    }) as CoordinationRunStarted;
  }

  recordRunProgress(
    input: RecordCoordinationRunProgressInput,
  ): CoordinationRunProgress {
    const normalized = invalidInput(() => ({
      taskId: normalizedId(input.taskId),
      runId: normalizedId(input.runId),
      sequence: input.sequence,
      name: normalizedId(input.name),
      summary: normalizedText(input.summary),
      evidenceRefs: normalizedEvidenceRefs(input.evidenceRefs),
      actor: normalizedActor(input.actor),
      evidenceLevel: input.evidenceLevel,
    }));
    const candidate = parseEvent({
      ...newBase("run.progress"),
      type: "run.progress",
      task_id: normalized.taskId,
      run_id: normalized.runId,
      sequence: normalized.sequence,
      name: normalized.name,
      summary: normalized.summary,
      evidence_refs: normalized.evidenceRefs,
      actor: normalized.actor,
      evidence_level: normalized.evidenceLevel,
    } as CoordinationRunProgress);
    return this.transact((state) => {
      const run = state.runs.get(candidate.run_id);
      const existing = run?.progress.find(
        (event) => event.sequence === candidate.sequence,
      );
      if (existing) {
        if (sameEventPayload(existing, candidate))
          return { kind: "existing", event: existing };
        throw new CoordinationError("state-conflict");
      }
      return { kind: "append", event: candidate };
    }) as CoordinationRunProgress;
  }

  recordRunResult(
    input: RecordCoordinationRunResultInput,
  ): CoordinationRunResult {
    const normalized = invalidInput(() => ({
      taskId: normalizedId(input.taskId),
      runId: normalizedId(input.runId),
      outcome: input.outcome,
      summary: normalizedText(input.summary),
      evidenceRefs: normalizedEvidenceRefs(input.evidenceRefs),
      actor: normalizedActor(input.actor),
      evidenceLevel: input.evidenceLevel,
    }));
    const candidate = parseEvent({
      ...newBase("run.result"),
      type: "run.result",
      task_id: normalized.taskId,
      run_id: normalized.runId,
      outcome: normalized.outcome,
      summary: normalized.summary,
      evidence_refs: normalized.evidenceRefs,
      actor: normalized.actor,
      evidence_level: normalized.evidenceLevel,
    } as CoordinationRunResult);
    return this.transact((state) => {
      const existing = state.runs.get(candidate.run_id)?.result;
      if (existing) {
        if (sameEventPayload(existing, candidate))
          return { kind: "existing", event: existing };
        throw new CoordinationError("state-conflict");
      }
      return { kind: "append", event: candidate };
    }) as CoordinationRunResult;
  }

  private transact<T extends CoordinationEvent>(
    decide: (state: ReplayState) => TransactionDecision<T>,
  ): T {
    return withStoreLock(this.projectRoot, () => {
      const journal = readJournal(this.projectRoot);
      const decision = decide(journal.state);
      if (decision.kind === "existing") return cloneEvent(decision.event);
      const event = parseEvent(decision.event);
      try {
        applyEvent(journal.state, event);
      } catch (error) {
        if (error instanceof CoordinationError) throw error;
        throw new CoordinationError("state-conflict");
      }
      appendEnvelope(this.projectRoot, journal, event);
      return cloneEvent(event);
    });
  }
}

export function readCoordinationSnapshot(
  projectRoot: string,
): CoordinationSnapshot {
  return new CoordinationStore(projectRoot).snapshot();
}
