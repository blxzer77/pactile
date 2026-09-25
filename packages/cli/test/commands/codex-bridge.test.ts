import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprintTaskValue } from "../../src/core/task/index.js";
import { runTaskCli } from "../../src/commands/task.js";
import {
  blockCodexTask,
  codexBridgeStatus,
  prepareCodexRequest,
  recordCodexReceipt,
  unblockCodexTask,
} from "../../src/pactile/codex/bridge.js";
import {
  buildCodexDispatchStopProof,
  writeCodexDispatchStopProof,
} from "../../src/pactile/codex/dispatch-stop-proof.js";
import type {
  CodexBridgeReceipt,
  CodexBridgeRequest,
} from "../../src/pactile/codex/bridge.js";
import { approvedTask as approvedPiTask } from "../../src/pactile/pi/bridge.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; task: string; prompt: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-codex-bridge-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".pactile", "tasks", "locale", "en"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, ".pactile", "tasks", "locale", "en", "default-prd.md"),
    "# {title}\n{goal}\n",
  );
  fs.writeFileSync(
    path.join(root, ".pactile", "config.yaml"),
    "artifact_locale: en\n",
  );
  fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=tester\n");
  expect(
    runTaskCli(
      ["legacy-create", "Codex bridge", "--slug", "codex-bridge"],
      root,
    ),
  ).toBe(0);
  const task = fs
    .readdirSync(path.join(root, ".pactile", "tasks"))
    .find((name) => name.endsWith("-codex-bridge"));
  if (!task) throw new Error("Task fixture missing");
  const prompt = path.join(root, "prompt.md");
  fs.writeFileSync(prompt, "Plan the acceptance evidence. Do not implement.\n");
  return { root, task, prompt };
}

function result(root: string, body: Record<string, unknown>): string {
  const file = path.join(root, `receipt-${Math.random()}.json`);
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

function dispatchProofFixture(
  disposition: "native-terminal" | "not-created",
  evidenceLevel: "simulated" | "desktop-native" = "desktop-native",
): { request: CodexBridgeRequest; receipt: CodexBridgeReceipt } {
  const terminal = disposition === "native-terminal";
  const requestPayload: Omit<CodexBridgeRequest, "request_fingerprint"> = {
    schema_version: 1,
    request_id: "c7ddcae9-d110-4fb3-b79f-ea7e84ed055e",
    task: ".pactile/tasks/task-1",
    task_id: "task-1",
    task_kernel_kind: "task-kernel-v2",
    kernel_revision: 4,
    contract_fingerprint: "a".repeat(64),
    run_id: "run-1",
    dispatch_task_id: "task-1",
    dispatch_run_id: "run-1",
    dispatch_lease_id: "lease-1",
    schedule_receipt_fingerprint: "b".repeat(64),
    dispatch_admission_receipt_fingerprint: "c".repeat(64),
    created_at: "2026-09-26T00:00:00.000Z",
    tool: terminal ? "wait_threads" : "create_thread",
    role: "execute",
    thread_id: terminal ? "thread-1" : null,
    host_id: terminal ? "host-1" : null,
    arguments: {},
    prompt_sha256: null,
  };
  const request = {
    ...requestPayload,
    request_fingerprint: fingerprintTaskValue(requestPayload),
  };
  const receipt: CodexBridgeReceipt = {
    schema_version: 1,
    request_id: request.request_id,
    task_id: request.task_id,
    run_id: request.run_id,
    request_fingerprint: request.request_fingerprint,
    evidence_level: evidenceLevel,
    ...(terminal ? {} : { thread_creation_state: "not_created" as const }),
    tool: request.tool,
    outcome: terminal ? "ok" : "failed",
    thread_id: terminal ? "thread-1" : null,
    client_thread_id: null,
    host_id: terminal ? "host-1" : null,
    status: terminal ? "completed" : null,
    cursor: null,
    reason: terminal ? null : "Host confirmed thread was not created",
    kernel_revision_at_receipt: 4,
    contract_stale: false,
    recorded_at: "2026-09-26T00:01:00.000Z",
    assurance: "host-reported",
  };
  return { request, receipt };
}

describe("Codex desktop request and receipt bridge", () => {
  it("builds content-addressed stop proofs only from explicit native stop facts", () => {
    const terminal = dispatchProofFixture("native-terminal");
    const proof = buildCodexDispatchStopProof({
      ...terminal,
      disposition: "native-terminal",
      requestRef: ".pactile/tasks/task-1/codex-bridge/requests/request-1.json",
      nativeReceiptRef:
        ".pactile/tasks/task-1/codex-bridge/receipts/request-1.json",
    });
    expect(proof).toMatchObject({
      scope: "task-kernel-v2-run-dispatch-stop",
      source: "codex-bridge",
      disposition: "native-terminal",
      writer_exited: true,
      owner: {
        host: "codex-desktop",
        role: "execute",
        start_request_id: null,
        process_id: null,
        thread_id: "thread-1",
        host_id: "host-1",
      },
      request_fingerprint: terminal.request.request_fingerprint,
    });
    const payload: Record<string, unknown> = { ...proof };
    delete payload.proof_fingerprint;
    expect(proof.proof_fingerprint).toBe(fingerprintTaskValue(payload));

    const notCreated = dispatchProofFixture("not-created");
    expect(
      buildCodexDispatchStopProof({
        ...notCreated,
        disposition: "not-created",
        requestRef: ".pactile/tasks/task-1/codex-bridge/requests/create.json",
        nativeReceiptRef:
          ".pactile/tasks/task-1/codex-bridge/receipts/create.json",
      }).owner,
    ).toEqual({
      host: "codex-desktop",
      role: "execute",
      session_id: null,
      thread_id: null,
      host_id: null,
      start_request_id: null,
      process_id: null,
    });

    const simulated = dispatchProofFixture("native-terminal", "simulated");
    expect(() =>
      buildCodexDispatchStopProof({
        ...simulated,
        disposition: "native-terminal",
        requestRef: ".pactile/tasks/task-1/request.json",
        nativeReceiptRef: ".pactile/tasks/task-1/receipt.json",
      }),
    ).toThrow("not a current native receipt");
  });

  it("writes dispatch proofs idempotently and rejects project path escapes", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "pactile-dispatch-proof-"),
    );
    roots.push(root);
    const fixture = dispatchProofFixture("not-created");
    const proof = buildCodexDispatchStopProof({
      ...fixture,
      disposition: "not-created",
      requestRef: ".pactile/tasks/task-1/codex-bridge/requests/create.json",
      nativeReceiptRef:
        ".pactile/tasks/task-1/codex-bridge/receipts/create.json",
    });
    const ref = writeCodexDispatchStopProof(root, proof);
    expect(ref).toBe(
      `.pactile/codex-bridge/dispatch-proofs/${proof.proof_fingerprint}.json`,
    );
    expect(writeCodexDispatchStopProof(root, proof)).toBe(ref);
    const proofFile = path.join(root, ref);
    expect(JSON.parse(fs.readFileSync(proofFile, "utf8"))).toEqual(proof);
    fs.writeFileSync(proofFile, "{}\n", "utf8");
    expect(() => writeCodexDispatchStopProof(root, proof)).toThrow(
      "content-address collision",
    );
    expect(() =>
      buildCodexDispatchStopProof({
        ...fixture,
        disposition: "not-created",
        requestRef: "../outside/request.json",
        nativeReceiptRef: ".pactile/tasks/task-1/receipt.json",
      }),
    ).toThrow("request_ref must remain within the project root");
  });

  it("does not infer not-created from an ambiguous native create result", () => {
    const fixture = dispatchProofFixture("not-created");
    const ambiguous = {
      ...fixture.receipt,
      thread_creation_state: "unknown" as const,
    };
    expect(() =>
      buildCodexDispatchStopProof({
        ...fixture,
        receipt: ambiguous,
        disposition: "not-created",
        requestRef: ".pactile/tasks/task-1/request.json",
        nativeReceiptRef: ".pactile/tasks/task-1/receipt.json",
      }),
    ).toThrow("explicit native create failure");
  });

  it("does not release from a needs-attention or stale wait receipt", () => {
    const fixture = dispatchProofFixture("native-terminal");
    expect(() =>
      buildCodexDispatchStopProof({
        ...fixture,
        receipt: { ...fixture.receipt, status: "needs_attention" },
        disposition: "native-terminal",
        requestRef: ".pactile/tasks/task-1/request.json",
        nativeReceiptRef: ".pactile/tasks/task-1/receipt.json",
      }),
    ).toThrow("completed wait");
    expect(() =>
      buildCodexDispatchStopProof({
        ...fixture,
        receipt: { ...fixture.receipt, contract_stale: true },
        disposition: "native-terminal",
        requestRef: ".pactile/tasks/task-1/request.json",
        nativeReceiptRef: ".pactile/tasks/task-1/receipt.json",
      }),
    ).toThrow("not a current native receipt");
  });

  it("requires the wait candidate to match its request and forbids candidates on not-created", () => {
    const terminal = dispatchProofFixture("native-terminal");
    expect(() =>
      buildCodexDispatchStopProof({
        ...terminal,
        receipt: {
          ...terminal.receipt,
          candidate_snapshot_id: "different-candidate",
          candidate_fingerprint: "d".repeat(64),
        },
        disposition: "native-terminal",
        requestRef: ".pactile/tasks/task-1/codex-bridge/requests/wait.json",
        nativeReceiptRef:
          ".pactile/tasks/task-1/codex-bridge/receipts/wait.json",
      }),
    ).toThrow("candidate does not match the request");

    const notCreated = dispatchProofFixture("not-created");
    const notCreatedRequestPayload = {
      ...notCreated.request,
      candidate_snapshot_id: "candidate-1",
      candidate_fingerprint: "e".repeat(64),
    };
    delete (notCreatedRequestPayload as Partial<CodexBridgeRequest>)[
      "request_fingerprint"
    ];
    const requestFingerprint = fingerprintTaskValue(notCreatedRequestPayload);
    expect(() =>
      buildCodexDispatchStopProof({
        request: {
          ...notCreatedRequestPayload,
          request_fingerprint: requestFingerprint,
        },
        receipt: {
          ...notCreated.receipt,
          request_fingerprint: requestFingerprint,
          candidate_snapshot_id: "candidate-1",
          candidate_fingerprint: "e".repeat(64),
        },
        disposition: "not-created",
        requestRef: ".pactile/tasks/task-1/codex-bridge/requests/create.json",
        nativeReceiptRef:
          ".pactile/tasks/task-1/codex-bridge/receipts/create.json",
      }),
    ).toThrow("without a thread or candidate");
  });

  it("lets a blocked Task Kernel v2 Task receive coordination without a Run", () => {
    const { root, task: senderTask, prompt } = fixture();
    expect(
      runTaskCli(
        [
          "create",
          "Blocked V2 receiver",
          "--slug",
          "blocked-v2-receiver",
          "--deliverable",
          "A coordination message can be recorded while blocked",
          "--delivery-level",
          "documentation",
          "--accept",
          "AC-1=The Task stays blocked after a coordination message",
        ],
        root,
      ),
    ).toBe(0);
    const receiverTask = fs
      .readdirSync(path.join(root, ".pactile", "tasks"))
      .find((name) => name.endsWith("-blocked-v2-receiver"));
    if (!receiverTask) throw new Error("V2 receiver Task fixture missing");

    const senderThread = prepareCodexRequest({
      root,
      task: senderTask,
      tool: "create_thread",
      role: "plan",
      promptFile: prompt,
      targetType: "projectless",
    });
    recordCodexReceipt(
      root,
      senderTask,
      senderThread.request_id,
      result(root, {
        request_id: senderThread.request_id,
        tool: senderThread.tool,
        outcome: "ok",
        thread_id: "blocked-v2-sender-thread",
        host_id: "local",
      }),
    );
    const receiverThread = prepareCodexRequest({
      root,
      task: receiverTask,
      tool: "create_thread",
      role: "plan",
      promptFile: prompt,
      targetType: "projectless",
    });
    recordCodexReceipt(
      root,
      receiverTask,
      receiverThread.request_id,
      result(root, {
        request_id: receiverThread.request_id,
        tool: receiverThread.tool,
        outcome: "ok",
        thread_id: "blocked-v2-receiver-thread",
        host_id: "local",
      }),
    );

    const receiverDir = path.join(root, ".pactile", "tasks", receiverTask);
    const kernelFile = path.join(receiverDir, "kernel.json");
    const revisionBeforeBlock = JSON.parse(
      fs.readFileSync(kernelFile, "utf8"),
    ).revision;
    const block = blockCodexTask(root, receiverTask, {
      reason: "Waiting for the upstream decision",
      blockedByTaskId: codexBridgeStatus(root, senderTask).task_id,
    });
    const blockedTaskState = codexBridgeStatus(root, receiverTask);
    expect(blockedTaskState.task_kernel_kind).toBe("task-kernel-v2");
    expect(blockedTaskState.coordination.blocked_tasks).toMatchObject([
      { block_id: block.block_id },
    ]);
    expect(blockedTaskState.coordination.runs).toEqual([]);
    expect(JSON.parse(fs.readFileSync(kernelFile, "utf8")).revision).toBe(
      revisionBeforeBlock,
    );

    const coordination = prepareCodexRequest({
      root,
      task: senderTask,
      tool: "send_message_to_thread",
      threadId: "blocked-v2-receiver-thread",
      toTask: receiverTask,
      promptFile: prompt,
    });
    expect(coordination.arguments.prompt).toContain(
      "Preserve any blocked or waiting state",
    );
    expect(coordination.to_run_id).toBeNull();
    expect(coordination.dispatch_lease_id).toBeUndefined();
    recordCodexReceipt(
      root,
      senderTask,
      coordination.request_id,
      result(root, {
        request_id: coordination.request_id,
        tool: coordination.tool,
        outcome: "ok",
        thread_id: "blocked-v2-receiver-thread",
        host_id: "local",
      }),
    );

    expect(JSON.parse(fs.readFileSync(kernelFile, "utf8")).revision).toBe(
      revisionBeforeBlock,
    );
    expect(
      codexBridgeStatus(root, receiverTask).coordination.blocked_tasks,
    ).toMatchObject([{ block_id: block.block_id }]);
    expect(
      codexBridgeStatus(root, receiverTask).coordination.messages,
    ).toMatchObject([
      {
        message_id: coordination.request_id,
        from_task_id: codexBridgeStatus(root, senderTask).task_id,
        to_task_id: codexBridgeStatus(root, receiverTask).task_id,
        to_run_id: null,
        status: "sent",
      },
    ]);
  });

  it("uses shared Execute approval while keeping Pi worker mode specific to Pi", () => {
    const { root, task, prompt } = fixture();
    const dir = path.join(root, ".pactile", "tasks", task);
    fs.writeFileSync(path.join(dir, "design.md"), "# Inline design\n");
    fs.writeFileSync(
      path.join(dir, "implement.md"),
      [
        "execution_mode: inline",
        "isolation: git-worktree",
        "verification_profile: standard",
        "retrieval_profile: exact-only",
        "optional_capabilities: []",
        "quality_gates:",
        "  mode: profile",
        "",
      ].join("\n"),
    );
    const input = {
      root,
      task,
      tool: "create_thread" as const,
      role: "execute" as const,
      promptFile: prompt,
      projectId: "project-1",
      environment: "worktree" as const,
    };
    expect(() => prepareCodexRequest(input)).toThrow("approved Execute task");
    expect(runTaskCli(["start-execution", task, "--approved"], root)).toBe(0);
    expect(prepareCodexRequest(input).role).toBe("execute");
    expect(() => approvedPiTask(root, task, "implement")).toThrow(
      "execution_mode: worker",
    );
    fs.appendFileSync(path.join(dir, "prd.md"), "\nUnapproved scope change.\n");
    expect(() => prepareCodexRequest(input)).toThrow(
      "Execution contract changed after approval",
    );
  });

  it("binds a native desktop task and records message/wait receipts without changing Kernel", () => {
    const { root, task, prompt } = fixture();
    const create = prepareCodexRequest({
      root,
      task,
      tool: "create_thread",
      role: "plan",
      promptFile: prompt,
      projectId: "project-1",
      environment: "worktree",
      title: "Plan Pactile task",
    });
    expect(create.arguments).toMatchObject({
      target: {
        type: "project",
        projectId: "project-1",
        environment: { type: "worktree" },
      },
    });
    expect(String(create.arguments.prompt)).toContain(
      `Pactile task: .pactile/tasks/${task}`,
    );
    expect(codexBridgeStatus(root, task).pending).toHaveLength(1);
    expect(JSON.stringify(codexBridgeStatus(root, task))).not.toContain(
      "Plan the acceptance evidence",
    );
    const threadId = "01a0cca7-8fe7-7c82-a682-1366b68e2139";
    const created = recordCodexReceipt(
      root,
      task,
      create.request_id,
      result(root, {
        request_id: create.request_id,
        tool: create.tool,
        outcome: "ok",
        thread_id: threadId,
        host_id: "local",
      }),
    );
    expect(created).toMatchObject({
      assurance: "host-reported",
      contract_stale: false,
    });
    const message = prepareCodexRequest({
      root,
      task,
      tool: "send_message_to_thread",
      threadId,
      promptFile: prompt,
    });
    expect(message.arguments).toMatchObject({ threadId, hostId: "local" });
    expect(() =>
      recordCodexReceipt(
        root,
        task,
        message.request_id,
        result(root, {
          request_id: message.request_id,
          tool: message.tool,
          outcome: "ok",
          thread_id: "wrong",
          host_id: "local",
        }),
      ),
    ).toThrow("thread identity changed");
    recordCodexReceipt(
      root,
      task,
      message.request_id,
      result(root, {
        request_id: message.request_id,
        tool: message.tool,
        outcome: "ok",
        thread_id: threadId,
        host_id: "local",
      }),
    );
    const wait = prepareCodexRequest({
      root,
      task,
      tool: "wait_threads",
      threadId,
      timeoutMs: 0,
    });
    expect(wait.arguments).toMatchObject({
      targets: [{ threadId, hostId: "local" }],
      timeoutMs: 0,
    });
    recordCodexReceipt(
      root,
      task,
      wait.request_id,
      result(root, {
        request_id: wait.request_id,
        tool: wait.tool,
        outcome: "ok",
        thread_id: threadId,
        host_id: "local",
        status: "completed",
        cursor: "cursor-1",
      }),
    );
    const secondWait = prepareCodexRequest({
      root,
      task,
      tool: "wait_threads",
      threadId,
      timeoutMs: 0,
    });
    expect(secondWait.arguments).toMatchObject({
      targets: [{ afterCursor: "cursor-1" }],
    });
    recordCodexReceipt(
      root,
      task,
      secondWait.request_id,
      result(root, {
        request_id: secondWait.request_id,
        tool: secondWait.tool,
        outcome: "ok",
        thread_id: threadId,
        host_id: "local",
        status: "completed",
        cursor: "cursor-2",
      }),
    );
    expect(
      prepareCodexRequest({
        root,
        task,
        tool: "wait_threads",
        threadId,
        timeoutMs: 0,
      }).arguments,
    ).toMatchObject({ targets: [{ afterCursor: "cursor-2" }] });
    const nativeWait = prepareCodexRequest({
      root,
      task,
      tool: "wait_threads",
      threadId,
      timeoutMs: 0,
    });
    expect(() =>
      recordCodexReceipt(
        root,
        task,
        nativeWait.request_id,
        result(root, {
          request_id: nativeWait.request_id,
          tool: nativeWait.tool,
          outcome: "ok",
          status: "completed",
          cursor: "cursor-3",
        }),
        "desktop-native",
      ),
    ).toThrow("must echo the native thread_id and host_id");
    const read = prepareCodexRequest({
      root,
      task,
      tool: "read_thread",
      threadId,
    });
    expect(
      recordCodexReceipt(
        root,
        task,
        read.request_id,
        result(root, {
          request_id: read.request_id,
          tool: read.tool,
          outcome: "failed",
          reason: "App temporarily unavailable",
        }),
      ),
    ).toMatchObject({
      outcome: "failed",
      thread_id: threadId,
      host_id: "local",
    });
    expect(codexBridgeStatus(root, task)).toMatchObject({
      phase: "define",
      threads: [{ threadId, hostId: "local", role: "plan" }],
    });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(root, ".pactile", "tasks", task, "kernel.json"),
          "utf8",
        ),
      ).phase,
    ).toBe("define");
  });

  it("rejects unbound, phase-invalid, mismatched and duplicate receipts", () => {
    const { root, task, prompt } = fixture();
    expect(() =>
      prepareCodexRequest({
        root,
        task,
        tool: "send_message_to_thread",
        threadId: "other",
        promptFile: prompt,
      }),
    ).toThrow("not bound");
    expect(() =>
      prepareCodexRequest({
        root,
        task,
        tool: "create_thread",
        role: "review",
        promptFile: prompt,
        projectId: "project-1",
        environment: "local",
      }),
    ).toThrow("review requires");
    const create = prepareCodexRequest({
      root,
      task,
      tool: "create_thread",
      role: "plan",
      promptFile: prompt,
      projectId: "project-1",
      environment: "local",
    });
    expect(() =>
      recordCodexReceipt(
        root,
        task,
        create.request_id,
        result(root, {
          request_id: "different",
          tool: create.tool,
          outcome: "ok",
          thread_id: "thread-1",
          host_id: "local",
        }),
      ),
    ).toThrow("does not match");
    const file = result(root, {
      request_id: create.request_id,
      tool: create.tool,
      outcome: "ok",
      thread_id: "thread-1",
      host_id: "local",
    });
    recordCodexReceipt(root, task, create.request_id, file);
    expect(() =>
      recordCodexReceipt(root, task, create.request_id, file),
    ).toThrow();
  });

  it("detects changed request content and preserves create uncertainty", () => {
    const { root, task, prompt } = fixture();
    const create = prepareCodexRequest({
      root,
      task,
      tool: "create_thread",
      role: "plan",
      promptFile: prompt,
      projectId: "project-1",
      environment: "worktree",
    });
    expect(create.request_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const requestPath = path.join(
      root,
      ".pactile",
      "tasks",
      task,
      "codex-bridge",
      "requests",
      `${create.request_id}.json`,
    );
    const persisted = JSON.parse(fs.readFileSync(requestPath, "utf8")) as {
      request_fingerprint: string;
      [key: string]: unknown;
    };
    persisted.prompt_sha256 = "0".repeat(64);
    fs.writeFileSync(requestPath, `${JSON.stringify(persisted)}\n`);
    expect(() =>
      recordCodexReceipt(
        root,
        task,
        create.request_id,
        result(root, {
          request_id: create.request_id,
          tool: create.tool,
          outcome: "failed",
          reason: "The desktop host is unavailable.",
          thread_creation_state: "not_created",
        }),
      ),
    ).toThrow("Request fingerprint does not match");

    const knownMissing = prepareCodexRequest({
      root,
      task,
      tool: "create_thread",
      role: "plan",
      promptFile: prompt,
      projectId: "project-1",
      environment: "worktree",
    });
    const receipt = recordCodexReceipt(
      root,
      task,
      knownMissing.request_id,
      result(root, {
        request_id: knownMissing.request_id,
        tool: knownMissing.tool,
        outcome: "failed",
        reason: "The desktop host confirmed no thread was created.",
        thread_creation_state: "not_created",
      }),
      "simulated",
    );
    expect(receipt).toMatchObject({
      outcome: "failed",
      evidence_level: "simulated",
      thread_creation_state: "not_created",
      thread_id: null,
      client_thread_id: null,
    });

    const inconsistent = prepareCodexRequest({
      root,
      task,
      tool: "create_thread",
      role: "plan",
      promptFile: prompt,
      projectId: "project-1",
      environment: "worktree",
    });
    expect(() =>
      recordCodexReceipt(
        root,
        task,
        inconsistent.request_id,
        result(root, {
          request_id: inconsistent.request_id,
          tool: inconsistent.tool,
          outcome: "failed",
          reason: "The host result is contradictory.",
          thread_id: "thread-exists",
          host_id: "local",
          thread_creation_state: "not_created",
        }),
        "desktop-native",
      ),
    ).toThrow("not_created requires no thread_id or client_thread_id");
  });

  it("marks receipts stale when the canonical task changes after preparation", () => {
    const { root, task, prompt } = fixture();
    const create = prepareCodexRequest({
      root,
      task,
      tool: "create_thread",
      role: "plan",
      promptFile: prompt,
      projectId: "project-1",
      environment: "local",
    });
    expect(runTaskCli(["set-scope", task, "changed"], root)).toBe(0);
    const receipt = recordCodexReceipt(
      root,
      task,
      create.request_id,
      result(root, {
        request_id: create.request_id,
        tool: create.tool,
        outcome: "ok",
        thread_id: "thread-2",
        host_id: "local",
      }),
    );
    expect(receipt.contract_stale).toBe(true);
  });

  it("does not use a queued clientThreadId for cross-task messaging", () => {
    const { root, task, prompt } = fixture();
    const create = prepareCodexRequest({
      root,
      task,
      tool: "create_thread",
      role: "plan",
      promptFile: prompt,
      projectId: "project-1",
      environment: "worktree",
    });
    recordCodexReceipt(
      root,
      task,
      create.request_id,
      result(root, {
        request_id: create.request_id,
        tool: create.tool,
        outcome: "queued",
        client_thread_id: "client-123",
      }),
    );
    expect(codexBridgeStatus(root, task).queued).toHaveLength(1);
    expect(() =>
      prepareCodexRequest({
        root,
        task,
        tool: "send_message_to_thread",
        threadId: "client-123",
        promptFile: prompt,
      }),
    ).toThrow("not bound");
    expect(() =>
      recordCodexReceipt(
        root,
        task,
        create.request_id,
        result(root, {
          request_id: create.request_id,
          tool: create.tool,
          outcome: "ok",
          client_thread_id: "different",
          thread_id: "thread-123",
          host_id: "local",
        }),
      ),
    ).toThrow("must match");
    recordCodexReceipt(
      root,
      task,
      create.request_id,
      result(root, {
        request_id: create.request_id,
        tool: create.tool,
        outcome: "ok",
        client_thread_id: "client-123",
        thread_id: "thread-123",
        host_id: "local",
      }),
    );
    expect(codexBridgeStatus(root, task).queued).toHaveLength(0);
    expect(codexBridgeStatus(root, task).threads).toMatchObject([
      { threadId: "thread-123" },
    ]);
  });

  it("supports a projectless desktop task when the product checkout is not saved in the App", () => {
    const { root, task, prompt } = fixture();
    const request = prepareCodexRequest({
      root,
      task,
      tool: "create_thread",
      role: "plan",
      promptFile: prompt,
      targetType: "projectless",
    });
    expect(request.arguments.target).toEqual({ type: "projectless" });
  });

  it("records cross-task send receipts and requires a successful resolution message to unblock", () => {
    const { root, task: senderTask, prompt } = fixture();
    expect(
      runTaskCli(
        ["legacy-create", "Receiver task", "--slug", "receiver-task"],
        root,
      ),
    ).toBe(0);
    const receiverTask = fs
      .readdirSync(path.join(root, ".pactile", "tasks"))
      .find((name) => name.endsWith("-receiver-task"));
    if (!receiverTask) throw new Error("Receiver Task fixture missing");
    const create = prepareCodexRequest({
      root,
      task: receiverTask,
      tool: "create_thread",
      role: "plan",
      promptFile: prompt,
      targetType: "projectless",
    });
    const threadId = "receiver-thread";
    recordCodexReceipt(
      root,
      receiverTask,
      create.request_id,
      result(root, {
        request_id: create.request_id,
        tool: create.tool,
        outcome: "ok",
        thread_id: threadId,
        host_id: "local",
      }),
    );

    const message = prepareCodexRequest({
      root,
      task: senderTask,
      tool: "send_message_to_thread",
      threadId,
      toTask: receiverTask,
      promptFile: prompt,
    });
    expect(message.coordination_message_id).toBe(message.request_id);
    expect(String(message.arguments.prompt)).toContain("coordination-only");
    recordCodexReceipt(
      root,
      senderTask,
      message.request_id,
      result(root, {
        request_id: message.request_id,
        tool: message.tool,
        outcome: "ok",
        thread_id: threadId,
        host_id: "local",
      }),
    );

    const blocked = blockCodexTask(root, receiverTask, {
      messageId: message.request_id,
      reason: "Waiting for the sending Task to provide the agreed input.",
    });
    expect(blocked).toMatchObject({
      type: "task.blocked",
      task_id: expect.any(String),
      message_id: message.request_id,
    });
    const receiverKernelFile = path.join(
      root,
      ".pactile",
      "tasks",
      receiverTask,
      "kernel.json",
    );
    const blockedKernelRevision = JSON.parse(
      fs.readFileSync(receiverKernelFile, "utf8"),
    ).revision;
    const followUp = prepareCodexRequest({
      root,
      task: senderTask,
      tool: "send_message_to_thread",
      threadId,
      toTask: receiverTask,
      promptFile: prompt,
    });
    expect(String(followUp.arguments.prompt)).toContain(
      "Preserve any blocked or waiting state",
    );
    recordCodexReceipt(
      root,
      senderTask,
      followUp.request_id,
      result(root, {
        request_id: followUp.request_id,
        tool: followUp.tool,
        outcome: "ok",
        thread_id: threadId,
        host_id: "local",
      }),
    );
    expect(
      codexBridgeStatus(root, receiverTask).coordination.blocked_tasks,
    ).toMatchObject([{ block_id: blocked.block_id }]);
    expect(
      codexBridgeStatus(root, receiverTask).coordination.task_events,
    ).toHaveLength(1);
    expect(
      JSON.parse(fs.readFileSync(receiverKernelFile, "utf8")).revision,
    ).toBe(blockedKernelRevision);
    const failedResolution = prepareCodexRequest({
      root,
      task: senderTask,
      tool: "send_message_to_thread",
      threadId,
      toTask: receiverTask,
      promptFile: prompt,
    });
    recordCodexReceipt(
      root,
      senderTask,
      failedResolution.request_id,
      result(root, {
        request_id: failedResolution.request_id,
        tool: failedResolution.tool,
        outcome: "failed",
        thread_id: threadId,
        host_id: "local",
        reason: "The receiver task was unavailable.",
      }),
    );
    expect(() =>
      unblockCodexTask(root, receiverTask, {
        blockId: blocked.block_id,
        resolutionMessageId: failedResolution.request_id,
        reason: "No successful resolution message yet.",
      }),
    ).toThrow("unblock requires a non-stale successful resolution receipt");

    const resolution = prepareCodexRequest({
      root,
      task: senderTask,
      tool: "send_message_to_thread",
      threadId,
      toTask: receiverTask,
      promptFile: prompt,
    });
    recordCodexReceipt(
      root,
      senderTask,
      resolution.request_id,
      result(root, {
        request_id: resolution.request_id,
        tool: resolution.tool,
        outcome: "ok",
        thread_id: threadId,
        host_id: "local",
      }),
    );
    const unblocked = unblockCodexTask(root, receiverTask, {
      blockId: blocked.block_id,
      resolutionMessageId: resolution.request_id,
      reason:
        "The resolution message was accepted by the destination Codex task.",
    });
    expect(unblocked).toMatchObject({
      type: "task.unblocked",
      block_id: blocked.block_id,
      resolution_message_id: resolution.request_id,
    });
    expect(
      codexBridgeStatus(root, receiverTask).coordination.task_events,
    ).toHaveLength(2);
  });

  it("keeps receipts readable after the Pactile task is archived", () => {
    const { root, task, prompt } = fixture();
    const create = prepareCodexRequest({
      root,
      task,
      tool: "create_thread",
      role: "plan",
      promptFile: prompt,
      targetType: "projectless",
    });
    recordCodexReceipt(
      root,
      task,
      create.request_id,
      result(root, {
        request_id: create.request_id,
        tool: create.tool,
        outcome: "ok",
        thread_id: "thread-archived",
        host_id: "local",
      }),
    );
    expect(runTaskCli(["start-execution", task, "--approved"], root)).toBe(0);
    fs.appendFileSync(
      path.join(root, ".pactile", "tasks", task, "verify.md"),
      "\nValidation commands: bridge test passed\nFinal acceptance evidence: receipt retained\n",
    );
    expect(runTaskCli(["archive", task, "--no-commit"], root)).toBe(0);
    expect(codexBridgeStatus(root, task)).toMatchObject({
      archived: true,
      phase: "close",
      threads: [{ threadId: "thread-archived" }],
    });
    expect(() =>
      prepareCodexRequest({
        root,
        task,
        tool: "read_thread",
        threadId: "thread-archived",
      }),
    ).toThrow("Task not found");
  });
});
