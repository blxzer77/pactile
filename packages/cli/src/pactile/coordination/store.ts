import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  CoordinationError,
  COORDINATION_MAX_EVENT_BYTES,
  COORDINATION_MAX_LOG_BYTES,
  COORDINATION_MAX_LOG_EVENTS,
  coordinationEventHash,
  type CoordinationActor,
  type CoordinationEvidenceLevel,
  type CoordinationEvent,
  type CoordinationMessageCreated,
  type CoordinationMessageReceipt,
  type CoordinationRunProgress,
  type CoordinationRunResult,
  type CoordinationRunStarted,
  type CoordinationSnapshot,
  type CoordinationTaskBlocked,
  type CoordinationTaskUnblocked,
} from "./model.js";
import {
  appendCoordinationEnvelope,
  readCoordinationJournal,
  withCoordinationJournalLock,
} from "./journal.js";
import {
  applyCoordinationEvent,
  cloneCoordinationEvent,
  newCoordinationEventBase,
  normalizeCoordinationActor,
  normalizeCoordinationEvidenceRefs,
  normalizeCoordinationId,
  normalizeCoordinationNullableId,
  normalizeCoordinationText,
  parseCoordinationEvent,
  replayCoordinationEvents,
  sameCoordinationEventPayload,
  toCoordinationSnapshot,
  validateCoordinationInput,
  type CoordinationReplayState,
  type TransactionDecision,
} from "./state.js";

export { CoordinationError, type CoordinationErrorCode } from "./model.js";

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
  runId?: string | null;
  kernelRevisionAtUnblock?: number | null;
  kernelEventIdAtUnblock?: string | null;
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

function blockEvent(
  input: BlockCoordinationTaskInput,
): CoordinationTaskBlocked {
  const normalized = validateCoordinationInput(() => ({
    taskId: normalizeCoordinationId(input.taskId),
    blockId: normalizeCoordinationId(input.blockId ?? randomUUID()),
    blockedByTaskId: normalizeCoordinationNullableId(input.blockedByTaskId),
    messageId: normalizeCoordinationNullableId(input.messageId),
    reason: normalizeCoordinationText(input.reason),
    actor: normalizeCoordinationActor(input.actor),
    evidenceLevel: input.evidenceLevel,
  }));
  return parseCoordinationEvent({
    ...newCoordinationEventBase("task.blocked"),
    type: "task.blocked",
    task_id: normalized.taskId,
    block_id: normalized.blockId,
    blocked_by_task_id: normalized.blockedByTaskId,
    message_id: normalized.messageId,
    reason: normalized.reason,
    actor: normalized.actor,
    evidence_level: normalized.evidenceLevel,
  } as CoordinationTaskBlocked);
}

function unblockEvent(
  input: UnblockCoordinationTaskInput,
): CoordinationTaskUnblocked {
  const normalized = validateCoordinationInput(() => ({
    taskId: normalizeCoordinationId(input.taskId),
    blockId: normalizeCoordinationId(input.blockId),
    unblockedByTaskId: normalizeCoordinationNullableId(input.unblockedByTaskId),
    resolutionMessageId: normalizeCoordinationNullableId(
      input.resolutionMessageId,
    ),
    runId: normalizeCoordinationNullableId(input.runId),
    kernelRevisionAtUnblock: input.kernelRevisionAtUnblock ?? null,
    kernelEventIdAtUnblock: normalizeCoordinationNullableId(
      input.kernelEventIdAtUnblock,
    ),
    reason: normalizeCoordinationText(input.reason),
    actor: normalizeCoordinationActor(input.actor),
    evidenceLevel: input.evidenceLevel,
  }));
  return parseCoordinationEvent({
    ...newCoordinationEventBase("task.unblocked"),
    type: "task.unblocked",
    task_id: normalized.taskId,
    block_id: normalized.blockId,
    unblocked_by_task_id: normalized.unblockedByTaskId,
    resolution_message_id: normalized.resolutionMessageId,
    run_id: normalized.runId,
    kernel_revision_at_unblock: normalized.kernelRevisionAtUnblock,
    kernel_event_id_at_unblock: normalized.kernelEventIdAtUnblock,
    reason: normalized.reason,
    actor: normalized.actor,
    evidence_level: normalized.evidenceLevel,
  } as CoordinationTaskUnblocked);
}

function coordinationEnvelopeLineBytes(
  previousHash: string,
  event: CoordinationEvent,
): number {
  return Buffer.byteLength(
    `${JSON.stringify({
      schema_version: 1,
      previous_hash: previousHash,
      hash: coordinationEventHash(previousHash, event),
      event,
    })}\n`,
    "utf8",
  );
}

export class CoordinationStore {
  readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  snapshot(): CoordinationSnapshot {
    return toCoordinationSnapshot(
      replayCoordinationEvents(
        readCoordinationJournal(this.projectRoot).events,
      ),
    );
  }

  createMessage(
    input: CreateCoordinationMessageInput,
  ): CoordinationMessageCreated {
    const normalized = validateCoordinationInput(() => ({
      messageId: normalizeCoordinationId(input.messageId ?? randomUUID()),
      fromTaskId: normalizeCoordinationId(input.fromTaskId),
      toTaskId: normalizeCoordinationId(input.toTaskId),
      fromRunId: normalizeCoordinationNullableId(input.fromRunId),
      toRunId: normalizeCoordinationNullableId(input.toRunId),
      sender: normalizeCoordinationActor(input.sender),
      evidenceLevel: input.evidenceLevel,
      body: normalizeCoordinationText(input.body),
      requestId: normalizeCoordinationNullableId(input.requestId),
      hostRef: normalizeCoordinationNullableId(input.hostRef),
    }));
    const candidate = parseCoordinationEvent({
      ...newCoordinationEventBase("message.created"),
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
        if (sameCoordinationEventPayload(existing, candidate))
          return { kind: "existing", event: existing };
        throw new CoordinationError("state-conflict");
      }
      return { kind: "append", event: candidate };
    }) as CoordinationMessageCreated;
  }

  recordMessageReceipt(
    input: RecordCoordinationReceiptInput,
  ): CoordinationMessageReceipt {
    const normalized = validateCoordinationInput(() => ({
      messageId: normalizeCoordinationId(input.messageId),
      receiptId: normalizeCoordinationId(input.receiptId),
      status: input.status,
      actor: normalizeCoordinationActor(input.actor),
      evidenceLevel: input.evidenceLevel,
      externalRef: normalizeCoordinationNullableId(input.externalRef),
      note: input.note?.trim() ? normalizeCoordinationText(input.note) : null,
    }));
    const candidate = parseCoordinationEvent({
      ...newCoordinationEventBase("message.receipt"),
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
      const key = `${candidate.message_id}\u0000${candidate.receipt_id}`;
      const existing = state.receiptIds.get(key);
      if (existing) {
        if (sameCoordinationEventPayload(existing, candidate))
          return { kind: "existing", event: existing };
        throw new CoordinationError("state-conflict");
      }
      return { kind: "append", event: candidate };
    }) as CoordinationMessageReceipt;
  }

  blockTask(input: BlockCoordinationTaskInput): CoordinationTaskBlocked {
    const candidate = blockEvent(input);
    return this.transact((state) => {
      const existing = state.blocks.get(candidate.block_id);
      if (existing) {
        if (sameCoordinationEventPayload(existing, candidate))
          return { kind: "existing", event: existing };
        throw new CoordinationError("state-conflict");
      }
      return { kind: "append", event: candidate };
    }) as CoordinationTaskBlocked;
  }

  blockTaskWithPrecondition(
    input: BlockCoordinationTaskInput,
    validate: (
      event: CoordinationTaskBlocked,
      snapshot: CoordinationSnapshot,
    ) => void,
  ): CoordinationTaskBlocked {
    const candidate = blockEvent(input);
    return withCoordinationJournalLock(this.projectRoot, () => {
      const journal = readCoordinationJournal(this.projectRoot);
      const state = replayCoordinationEvents(journal.events);
      const existing = state.blocks.get(candidate.block_id);
      if (existing) {
        if (!sameCoordinationEventPayload(existing, candidate)) {
          throw new CoordinationError("state-conflict");
        }
        validate(
          cloneCoordinationEvent(existing),
          toCoordinationSnapshot(state),
        );
        return cloneCoordinationEvent(existing);
      }

      validate(
        cloneCoordinationEvent(candidate),
        toCoordinationSnapshot(state),
      );
      try {
        applyCoordinationEvent(state, candidate);
      } catch (error) {
        if (error instanceof CoordinationError) throw error;
        throw new CoordinationError("state-conflict");
      }
      appendCoordinationEnvelope(this.projectRoot, journal, candidate);
      return cloneCoordinationEvent(candidate);
    });
  }

  unblockTask(input: UnblockCoordinationTaskInput): CoordinationTaskUnblocked {
    const candidate = unblockEvent(input);
    return this.transact((state) => {
      const existing = state.unblocks.get(candidate.block_id);
      if (existing) {
        if (sameCoordinationEventPayload(existing, candidate))
          return { kind: "existing", event: existing };
        throw new CoordinationError("state-conflict");
      }
      return { kind: "append", event: candidate };
    }) as CoordinationTaskUnblocked;
  }

  /**
   * Appends an unblock, validates its postcondition, and records a compensating
   * block before releasing the journal lock if validation fails. Admission uses
   * this same lock, so it cannot consume the temporary unblock state.
   */
  unblockTaskWithPostcondition(
    input: UnblockCoordinationTaskInput,
    validate: (event: CoordinationTaskUnblocked) => void,
    compensation: BlockCoordinationTaskInput,
  ): CoordinationTaskUnblocked {
    const candidate = unblockEvent(input);
    const compensationEvent = blockEvent(compensation);
    if (candidate.task_id !== compensationEvent.task_id) {
      throw new CoordinationError("invalid-input");
    }

    return withCoordinationJournalLock(this.projectRoot, () => {
      const journal = readCoordinationJournal(this.projectRoot);
      const state = replayCoordinationEvents(journal.events);
      const existing = state.unblocks.get(candidate.block_id);
      let event: CoordinationTaskUnblocked;
      if (existing) {
        if (!sameCoordinationEventPayload(existing, candidate)) {
          throw new CoordinationError("state-conflict");
        }
        event = existing;
        if (!state.blocks.has(compensationEvent.block_id)) {
          const compensationLineBytes = coordinationEnvelopeLineBytes(
            journal.lastHash,
            compensationEvent,
          );
          if (
            compensationLineBytes > COORDINATION_MAX_EVENT_BYTES ||
            journal.events.length + 1 > COORDINATION_MAX_LOG_EVENTS ||
            journal.bytes + compensationLineBytes > COORDINATION_MAX_LOG_BYTES
          ) {
            throw new CoordinationError("store-limit");
          }
        }
      } else {
        try {
          applyCoordinationEvent(state, candidate);
        } catch (error) {
          if (error instanceof CoordinationError) throw error;
          throw new CoordinationError("state-conflict");
        }

        const unblockLineBytes = coordinationEnvelopeLineBytes(
          journal.lastHash,
          candidate,
        );
        const compensationLineBytes = coordinationEnvelopeLineBytes(
          coordinationEventHash(journal.lastHash, candidate),
          compensationEvent,
        );
        if (
          unblockLineBytes > COORDINATION_MAX_EVENT_BYTES ||
          compensationLineBytes > COORDINATION_MAX_EVENT_BYTES ||
          journal.events.length + 2 > COORDINATION_MAX_LOG_EVENTS ||
          journal.bytes + unblockLineBytes + compensationLineBytes >
            COORDINATION_MAX_LOG_BYTES
        ) {
          throw new CoordinationError("store-limit");
        }
        appendCoordinationEnvelope(this.projectRoot, journal, candidate);
        event = candidate;
      }

      try {
        validate(cloneCoordinationEvent(event) as CoordinationTaskUnblocked);
      } catch (postconditionError) {
        try {
          const compensationJournal = readCoordinationJournal(this.projectRoot);
          const compensationState = replayCoordinationEvents(
            compensationJournal.events,
          );
          const existingCompensation = compensationState.blocks.get(
            compensationEvent.block_id,
          );
          if (existingCompensation) {
            if (
              !sameCoordinationEventPayload(
                existingCompensation,
                compensationEvent,
              )
            ) {
              throw new CoordinationError("state-conflict");
            }
          } else {
            try {
              applyCoordinationEvent(compensationState, compensationEvent);
            } catch (error) {
              if (error instanceof CoordinationError) throw error;
              throw new CoordinationError("state-conflict");
            }
            appendCoordinationEnvelope(
              this.projectRoot,
              compensationJournal,
              compensationEvent,
            );
          }
        } catch {
          throw new Error("coordination-unblock-compensation-failed");
        }
        throw postconditionError;
      }

      return cloneCoordinationEvent(event) as CoordinationTaskUnblocked;
    });
  }

  startRun(input: StartCoordinationRunInput): CoordinationRunStarted {
    const normalized = validateCoordinationInput(() => ({
      taskId: normalizeCoordinationId(input.taskId),
      runId: normalizeCoordinationId(input.runId),
      role: normalizeCoordinationNullableId(input.role),
      workspaceId: normalizeCoordinationNullableId(input.workspaceId),
      providerRunId: normalizeCoordinationNullableId(input.providerRunId),
      actor: normalizeCoordinationActor(input.actor),
      evidenceLevel: input.evidenceLevel,
    }));
    const candidate = parseCoordinationEvent({
      ...newCoordinationEventBase("run.started"),
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
        if (sameCoordinationEventPayload(existing, candidate))
          return { kind: "existing", event: existing };
        throw new CoordinationError("state-conflict");
      }
      return { kind: "append", event: candidate };
    }) as CoordinationRunStarted;
  }

  recordRunProgress(
    input: RecordCoordinationRunProgressInput,
  ): CoordinationRunProgress {
    const normalized = validateCoordinationInput(() => ({
      taskId: normalizeCoordinationId(input.taskId),
      runId: normalizeCoordinationId(input.runId),
      sequence: input.sequence,
      name: normalizeCoordinationId(input.name),
      summary: normalizeCoordinationText(input.summary),
      evidenceRefs: normalizeCoordinationEvidenceRefs(input.evidenceRefs),
      actor: normalizeCoordinationActor(input.actor),
      evidenceLevel: input.evidenceLevel,
    }));
    const candidate = parseCoordinationEvent({
      ...newCoordinationEventBase("run.progress"),
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
        if (sameCoordinationEventPayload(existing, candidate))
          return { kind: "existing", event: existing };
        throw new CoordinationError("state-conflict");
      }
      return { kind: "append", event: candidate };
    }) as CoordinationRunProgress;
  }

  recordRunResult(
    input: RecordCoordinationRunResultInput,
  ): CoordinationRunResult {
    const normalized = validateCoordinationInput(() => ({
      taskId: normalizeCoordinationId(input.taskId),
      runId: normalizeCoordinationId(input.runId),
      outcome: input.outcome,
      summary: normalizeCoordinationText(input.summary),
      evidenceRefs: normalizeCoordinationEvidenceRefs(input.evidenceRefs),
      actor: normalizeCoordinationActor(input.actor),
      evidenceLevel: input.evidenceLevel,
    }));
    const candidate = parseCoordinationEvent({
      ...newCoordinationEventBase("run.result"),
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
        if (sameCoordinationEventPayload(existing, candidate))
          return { kind: "existing", event: existing };
        throw new CoordinationError("state-conflict");
      }
      return { kind: "append", event: candidate };
    }) as CoordinationRunResult;
  }

  private transact<T extends CoordinationEvent>(
    decide: (state: CoordinationReplayState) => TransactionDecision<T>,
  ): T {
    return withCoordinationJournalLock(this.projectRoot, () => {
      const journal = readCoordinationJournal(this.projectRoot);
      const state = replayCoordinationEvents(journal.events);
      const decision = decide(state);
      if (decision.kind === "existing")
        return cloneCoordinationEvent(decision.event);
      const event = parseCoordinationEvent(decision.event);
      try {
        applyCoordinationEvent(state, event);
      } catch (error) {
        if (error instanceof CoordinationError) throw error;
        throw new CoordinationError("state-conflict");
      }
      appendCoordinationEnvelope(this.projectRoot, journal, event);
      return cloneCoordinationEvent(event);
    });
  }
}

export function readCoordinationSnapshot(
  projectRoot: string,
): CoordinationSnapshot {
  return new CoordinationStore(projectRoot).snapshot();
}
