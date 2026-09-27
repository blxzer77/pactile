import path from "node:path";
import {
  readTaskKernel,
  resumeTaskRun,
  type ResumeTaskRunRequest,
  type TaskKernelMutationResult,
} from "../../core/task/index.js";
import {
  CoordinationError,
  type CoordinationEvent,
  type CoordinationRunResumeAuthorized,
  type CoordinationTaskUnblocked,
} from "./model.js";
import {
  appendCoordinationEnvelope,
  readCoordinationJournal,
  withCoordinationJournalLock,
} from "./journal.js";
import {
  applyCoordinationEvent,
  newCoordinationEventBase,
  parseCoordinationEvent,
  replayCoordinationEvents,
} from "./state.js";

/**
 * Resume a Kernel Run while holding the coordination journal lock. The
 * authorization event binds the exact Kernel `run.resumed` event to the latest
 * unblock so dispatch admission can verify the causal chain.
 */
export function resumeTaskRunWithCoordinationBarrier(
  request: ResumeTaskRunRequest,
): TaskKernelMutationResult {
  const root = path.resolve(request.root);
  return withCoordinationJournalLock(root, () => {
    const journal = readCoordinationJournal(root);
    const state = replayCoordinationEvents(journal.events);
    const before = readTaskKernel({
      root,
      taskDir: request.taskDir,
      cwd: request.cwd,
    });
    if (before.kind !== "task-kernel-v2") {
      throw new Error("coordination-resume-requires-task-kernel-v2");
    }
    const taskId = before.kernel.identity.taskId;
    if (state.activeBlocks.has(taskId)) {
      throw new Error("coordination-task-blocked");
    }

    const latestUnblock = [...state.events]
      .reverse()
      .find(
        (event): event is CoordinationTaskUnblocked =>
          event.type === "task.unblocked" && event.task_id === taskId,
      );
    if (!latestUnblock) return resumeTaskRun(request);

    const barrierRevision = latestUnblock.kernel_revision_at_unblock;
    const barrierEventId = latestUnblock.kernel_event_id_at_unblock;
    if (
      typeof barrierRevision !== "number" ||
      typeof barrierEventId !== "string"
    ) {
      throw new Error("coordination-unblock-kernel-barrier-missing");
    }
    const barrierIndex = before.kernel.events.findIndex(
      (event) => event.id === barrierEventId,
    );
    const barrierEvent = before.kernel.events[barrierIndex];
    if (barrierEvent?.revision !== barrierRevision || barrierIndex < 0) {
      throw new Error("coordination-unblock-kernel-barrier-invalid");
    }
    const runEntryIndex = before.kernel.events.findIndex(
      (event) =>
        event.entityId === request.runId &&
        (event.type === "run.queued" || event.type === "run.started"),
    );
    const runEntry = before.kernel.events[runEntryIndex];
    if (!runEntry) throw new Error("task-run-start-event-missing");
    if (
      runEntryIndex <= barrierIndex &&
      (runEntry.type !== "run.queued" || latestUnblock.run_id !== request.runId)
    ) {
      throw new Error("coordination-running-run-requires-terminal-retry");
    }

    const result = resumeTaskRun(request);
    if (
      result.event.type !== "run.resumed" ||
      result.event.entityId !== request.runId ||
      result.kernel.events.find((event) => event.id === result.event.id)
        ?.revision !== result.event.revision
    ) {
      throw new Error("coordination-resume-kernel-event-mismatch");
    }

    const existing = state.events.find(
      (event): event is CoordinationRunResumeAuthorized =>
        event.type === "run.resume-authorized" &&
        event.task_id === taskId &&
        event.run_id === request.runId &&
        event.unblock_event_id === latestUnblock.event_id,
    );
    if (existing) {
      if (
        existing.kernel_revision === result.event.revision &&
        existing.kernel_event_id === result.event.id
      ) {
        return result;
      }
      throw new CoordinationError("state-conflict");
    }

    const event = parseCoordinationEvent({
      ...newCoordinationEventBase("run.resume-authorized"),
      type: "run.resume-authorized",
      task_id: taskId,
      run_id: request.runId,
      unblock_event_id: latestUnblock.event_id,
      kernel_revision: result.event.revision,
      kernel_event_id: result.event.id,
      actor: { platform: "pactile", id: null },
      evidence_level: "local",
    } as CoordinationRunResumeAuthorized);
    applyCoordinationEvent(state, event as CoordinationEvent);
    appendCoordinationEnvelope(root, journal, event);
    return result;
  });
}
