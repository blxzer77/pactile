import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CoordinationError,
  CoordinationStore,
  readCoordinationSnapshot,
  type CoordinationActor,
} from "../../../src/pactile/coordination/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): { root: string; store: CoordinationStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-coordination-"));
  roots.push(root);
  return { root, store: new CoordinationStore(root) };
}

function actor(
  platform: CoordinationActor["platform"],
  id: string | null = null,
): CoordinationActor {
  return { platform, id };
}

function expectCoordinationError(
  action: () => unknown,
  code: CoordinationError["code"],
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CoordinationError);
    expect((error as CoordinationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected coordination error ${code}`);
}

describe("Pactile local coordination journal", () => {
  it("replays cross-task messages and monotonic host receipts idempotently", () => {
    const { root, store } = fixture();
    store.startRun({
      taskId: "task-a",
      runId: "run-a",
      role: "plan",
      actor: actor("codex"),
      evidenceLevel: "desktop-native",
    });
    store.startRun({
      taskId: "task-b",
      runId: "run-b",
      role: "implement",
      workspaceId: "worktree-b",
      actor: actor("pi"),
      evidenceLevel: "provider",
    });
    const message = store.createMessage({
      messageId: "message-1",
      fromTaskId: "task-a",
      toTaskId: "task-b",
      fromRunId: "run-a",
      toRunId: "run-b",
      sender: actor("codex", "desktop-task"),
      evidenceLevel: "desktop-native",
      body: "The API contract is ready; please confirm before proceeding.",
      requestId: "request-1",
      hostRef: "thread-1",
    });
    expect(message.type).toBe("message.created");
    expect(store.snapshot().messages[0]?.status).toBe("pending");
    expect(
      store.createMessage({
        messageId: "message-1",
        fromTaskId: "task-a",
        toTaskId: "task-b",
        fromRunId: "run-a",
        toRunId: "run-b",
        sender: actor("codex", "desktop-task"),
        evidenceLevel: "desktop-native",
        body: "The API contract is ready; please confirm before proceeding.",
        requestId: "request-1",
        hostRef: "thread-1",
      }).event_id,
    ).toBe(message.event_id);

    const queued = store.recordMessageReceipt({
      messageId: "message-1",
      receiptId: "receipt-queued",
      status: "queued",
      actor: actor("host"),
      evidenceLevel: "desktop-native",
      externalRef: "client-thread-1",
    });
    expect(
      store.recordMessageReceipt({
        messageId: "message-1",
        receiptId: "receipt-queued",
        status: "queued",
        actor: actor("host"),
        evidenceLevel: "desktop-native",
        externalRef: "client-thread-1",
      }).event_id,
    ).toBe(queued.event_id);
    store.recordMessageReceipt({
      messageId: "message-1",
      receiptId: "receipt-sent",
      status: "sent",
      actor: actor("host"),
      evidenceLevel: "desktop-native",
    });
    store.recordMessageReceipt({
      messageId: "message-1",
      receiptId: "receipt-delivered",
      status: "delivered",
      actor: actor("host"),
      evidenceLevel: "desktop-native",
    });
    expectCoordinationError(
      () =>
        store.recordMessageReceipt({
          messageId: "message-1",
          receiptId: "receipt-regression",
          status: "sent",
          actor: actor("host"),
          evidenceLevel: "desktop-native",
        }),
      "state-conflict",
    );
    store.recordMessageReceipt({
      messageId: "message-1",
      receiptId: "receipt-ack",
      status: "acknowledged",
      actor: actor("pi", "task-b-agent"),
      evidenceLevel: "provider",
      note: "Recipient confirmed receipt.",
    });

    const snapshot = readCoordinationSnapshot(root);
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]).toMatchObject({
      message: {
        message_id: "message-1",
        from_task_id: "task-a",
        to_task_id: "task-b",
        from_run_id: "run-a",
        to_run_id: "run-b",
      },
      status: "acknowledged",
    });
    expect(
      snapshot.messages[0]?.receipts.map((receipt) => receipt.status),
    ).toEqual(["queued", "sent", "delivered", "acknowledged"]);
    expect(snapshot.events.length).toBe(7);
  });

  it("records task blocks and explicit unblock references without losing history", () => {
    const { store } = fixture();
    store.createMessage({
      messageId: "handoff-1",
      fromTaskId: "task-a",
      toTaskId: "task-b",
      sender: actor("codex"),
      evidenceLevel: "simulated",
      body: "Waiting for the schema decision.",
    });
    const blocked = store.blockTask({
      taskId: "task-b",
      blockId: "block-b-1",
      blockedByTaskId: "task-a",
      messageId: "handoff-1",
      reason: "Task A owns the schema decision.",
      actor: actor("pactile"),
      evidenceLevel: "local",
    });
    expect(
      store.blockTask({
        taskId: "task-b",
        blockId: "block-b-1",
        blockedByTaskId: "task-a",
        messageId: "handoff-1",
        reason: "Task A owns the schema decision.",
        actor: actor("pactile"),
        evidenceLevel: "local",
      }).event_id,
    ).toBe(blocked.event_id);
    expectCoordinationError(
      () =>
        store.blockTask({
          taskId: "task-b",
          blockId: "block-b-2",
          reason: "A second active block must not replace the first.",
          actor: actor("pactile"),
          evidenceLevel: "local",
        }),
      "state-conflict",
    );

    store.createMessage({
      messageId: "resolution-1",
      fromTaskId: "task-a",
      toTaskId: "task-b",
      sender: actor("codex"),
      evidenceLevel: "desktop-native",
      body: "The schema decision is recorded in the contract.",
    });
    const unblocked = store.unblockTask({
      taskId: "task-b",
      blockId: "block-b-1",
      unblockedByTaskId: "task-a",
      resolutionMessageId: "resolution-1",
      reason: "The requested contract decision arrived.",
      actor: actor("pactile"),
      evidenceLevel: "local",
    });
    expect(
      store.unblockTask({
        taskId: "task-b",
        blockId: "block-b-1",
        unblockedByTaskId: "task-a",
        resolutionMessageId: "resolution-1",
        reason: "The requested contract decision arrived.",
        actor: actor("pactile"),
        evidenceLevel: "local",
      }).event_id,
    ).toBe(unblocked.event_id);
    expectCoordinationError(
      () =>
        store.unblockTask({
          taskId: "task-b",
          blockId: "wrong-block",
          reason: "Wrong blocker.",
          actor: actor("pactile"),
          evidenceLevel: "local",
        }),
      "state-conflict",
    );
    expect(store.snapshot().blocked_tasks).toEqual([]);
    expect(store.snapshot().events.map((event) => event.type)).toEqual([
      "message.created",
      "task.blocked",
      "message.created",
      "task.unblocked",
    ]);
  });

  it("binds sequenced Pi progress and terminal result to one Task, Run and workspace id", () => {
    const { root, store } = fixture();
    store.startRun({
      taskId: "task-pi",
      runId: "pi-run-1",
      role: "implement",
      workspaceId: "worktree-pi-1",
      providerRunId: "provider-session-7",
      actor: actor("pi", "worker"),
      evidenceLevel: "provider",
    });
    const progress = store.recordRunProgress({
      taskId: "task-pi",
      runId: "pi-run-1",
      sequence: 1,
      name: "tool_execution_end",
      summary: "The implementation check finished.",
      evidenceRefs: [".pactile/tasks/task-pi/pi-bridge/events/run-1.jsonl"],
      actor: actor("pi", "worker"),
      evidenceLevel: "provider",
    });
    expect(
      store.recordRunProgress({
        taskId: "task-pi",
        runId: "pi-run-1",
        sequence: 1,
        name: "tool_execution_end",
        summary: "The implementation check finished.",
        evidenceRefs: [".pactile/tasks/task-pi/pi-bridge/events/run-1.jsonl"],
        actor: actor("pi", "worker"),
        evidenceLevel: "provider",
      }).event_id,
    ).toBe(progress.event_id);
    expectCoordinationError(
      () =>
        store.recordRunProgress({
          taskId: "task-pi",
          runId: "pi-run-1",
          sequence: 0,
          name: "out_of_order",
          summary: "Run sequence cannot move backward.",
          actor: actor("pi", "worker"),
          evidenceLevel: "provider",
        }),
      "state-conflict",
    );
    store.recordRunResult({
      taskId: "task-pi",
      runId: "pi-run-1",
      outcome: "needs_review",
      summary: "Pi completed work that still needs independent review.",
      evidenceRefs: [".pactile/tasks/task-pi/pi-bridge/results/run-1.md"],
      actor: actor("pi", "worker"),
      evidenceLevel: "provider",
    });
    expectCoordinationError(
      () =>
        store.recordRunProgress({
          taskId: "task-pi",
          runId: "pi-run-1",
          sequence: 2,
          name: "late_event",
          summary: "Events after a terminal result are refused.",
          actor: actor("pi"),
          evidenceLevel: "provider",
        }),
      "state-conflict",
    );
    expectCoordinationError(
      () =>
        store.recordRunProgress({
          taskId: "wrong-task",
          runId: "pi-run-1",
          sequence: 1,
          name: "tool_execution_end",
          summary: "Wrong task binding.",
          actor: actor("pi"),
          evidenceLevel: "provider",
        }),
      "state-conflict",
    );

    const snapshot = readCoordinationSnapshot(root);
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]).toMatchObject({
      started: {
        task_id: "task-pi",
        run_id: "pi-run-1",
        workspace_id: "worktree-pi-1",
        provider_run_id: "provider-session-7",
        evidence_level: "provider",
      },
      progress: [{ sequence: 1, evidence_level: "provider" }],
      result: { outcome: "needs_review", evidence_level: "provider" },
    });
  });

  it("redacts common credential forms, rejects unbounded input and preserves hash-chain failures", () => {
    const { root, store } = fixture();
    const message = store.createMessage({
      messageId: "safe-message",
      fromTaskId: "task-a",
      toTaskId: "task-b",
      sender: actor("user"),
      evidenceLevel: "local",
      body: "Please check api_key=sample-secret-value and Bearer abcdefghijklmnop.",
    });
    expect(message.body).not.toContain("sample-secret-value");
    expect(message.body).not.toContain("abcdefghijklmnop");
    expect(message.body).toContain("[redacted]");
    expectCoordinationError(
      () =>
        store.createMessage({
          fromTaskId: "../outside",
          toTaskId: "task-b",
          sender: actor("user"),
          evidenceLevel: "local",
          body: "invalid logical id",
        }),
      "invalid-input",
    );
    expectCoordinationError(
      () =>
        store.createMessage({
          fromTaskId: "task-a",
          toTaskId: "task-b",
          sender: actor("user"),
          evidenceLevel: "local",
          body: "x".repeat(4_097),
        }),
      "invalid-input",
    );

    const journal = path.join(
      root,
      ".pactile",
      "runtime",
      "coordination",
      "events.jsonl",
    );
    const bytes = fs.readFileSync(journal, "utf8");
    fs.writeFileSync(
      journal,
      bytes.replace("message.created", "message.creatEd"),
    );
    expectCoordinationError(() => store.snapshot(), "store-corrupt");
  });

  it("fails closed on an existing writer lock instead of stealing it", () => {
    const { root, store } = fixture();
    const directory = path.join(root, ".pactile", "runtime", "coordination");
    fs.mkdirSync(directory, { recursive: true });
    const lockPath = path.join(directory, "events.lock");
    fs.writeFileSync(lockPath, "owned-by-another-writer", { mode: 0o600 });
    expectCoordinationError(
      () =>
        store.createMessage({
          fromTaskId: "task-a",
          toTaskId: "task-b",
          sender: actor("user"),
          evidenceLevel: "local",
          body: "Try writing while a writer owns the lock.",
        }),
      "store-locked",
    );
    expect(fs.readFileSync(lockPath, "utf8")).toBe("owned-by-another-writer");
    expect(fs.existsSync(path.join(directory, "events.jsonl"))).toBe(false);
  });
});
