import { randomUUID } from "node:crypto";
import {
  canonicalCoordinationJson,
  coordinationEventSchema,
  CoordinationError,
  hasForbiddenCoordinationControl,
  redactCoordinationText,
  type CoordinationActor,
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

interface RunState {
  started: CoordinationRunStarted;
  progress: CoordinationRunProgress[];
  result: CoordinationRunResult | null;
}

export interface CoordinationReplayState {
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

export type TransactionDecision<T extends CoordinationEvent> =
  | { kind: "append"; event: T }
  | { kind: "existing"; event: T };

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

export function createCoordinationReplayState(): CoordinationReplayState {
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

export function replayCoordinationEvents(
  events: readonly CoordinationEvent[],
): CoordinationReplayState {
  const state = createCoordinationReplayState();
  try {
    for (const event of events) applyCoordinationEvent(state, event);
  } catch {
    throw new CoordinationError("store-corrupt");
  }
  return state;
}

function runStateKey(runId: string): string {
  return runId;
}

function receiptStateKey(messageId: string, receiptId: string): string {
  return `${messageId}\u0000${receiptId}`;
}

export function cloneCoordinationEvent<T extends CoordinationEvent>(
  event: T,
): T {
  return JSON.parse(JSON.stringify(event)) as T;
}

export function sameCoordinationEventPayload(
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

export function validateCoordinationInput<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof CoordinationError) throw error;
    throw new CoordinationError("invalid-input");
  }
}

export function normalizeCoordinationId(value: string): string {
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

export function normalizeCoordinationNullableId(
  value: string | null | undefined,
): string | null {
  return value == null ? null : normalizeCoordinationId(value);
}

export function normalizeCoordinationActor(
  value: CoordinationActor,
): CoordinationActor {
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
  return {
    platform: value.platform,
    id: normalizeCoordinationNullableId(value.id),
  };
}

export function normalizeCoordinationText(value: string): string {
  if (typeof value !== "string") throw new CoordinationError("invalid-input");
  const normalized = redactCoordinationText(value);
  if (!normalized || Buffer.byteLength(normalized, "utf8") > 4_096) {
    throw new CoordinationError("invalid-input");
  }
  return normalized;
}

export function normalizeCoordinationEvidenceRefs(
  values: string[] | undefined,
): string[] {
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

export function newCoordinationEventBase(type: CoordinationEvent["type"]): {
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

export function parseCoordinationEvent<T extends CoordinationEvent>(
  event: T,
): T {
  const parsed = coordinationEventSchema.safeParse(event);
  if (!parsed.success) throw new CoordinationError("invalid-input");
  return parsed.data as T;
}

function currentMessageStatus(
  state: CoordinationReplayState,
  messageId: string,
): CoordinationMessageStatus {
  return state.receipts.get(messageId)?.at(-1)?.status ?? "pending";
}

function assertRunBinding(
  state: CoordinationReplayState,
  taskId: string,
  runId: string,
): RunState {
  const run = state.runs.get(runStateKey(runId));
  if (run?.started.task_id !== taskId) {
    throw new CoordinationError("state-conflict");
  }
  return run;
}

export function applyCoordinationEvent(
  state: CoordinationReplayState,
  event: CoordinationEvent,
): void {
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

export function toCoordinationSnapshot(
  state: CoordinationReplayState,
): CoordinationSnapshot {
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
    events: state.events.map((event) => cloneCoordinationEvent(event)),
    messages: messages.map(
      (message) =>
        JSON.parse(JSON.stringify(message)) as CoordinationMessageSnapshot,
    ),
    blocked_tasks: [...state.activeBlocks.values()].map((event) =>
      cloneCoordinationEvent(event),
    ),
    runs: runs.map(
      (run) => JSON.parse(JSON.stringify(run)) as CoordinationRunSnapshot,
    ),
  };
}
