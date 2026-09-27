import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fingerprintTaskValue } from "../../src/core/task/index.js";
import { runTaskCli } from "../../src/commands/task.js";
import { runCodexCli } from "../../src/commands/codex.js";
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
import { CoordinationStore } from "../../src/pactile/coordination/index.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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

function writeRunCandidateFile(
  root: string,
  repositoryPath: string,
  content: string,
): string {
  const file = path.join(root, ...repositoryPath.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function writeTaskEvidenceFile(
  root: string,
  task: string,
  reference: string,
  content: string,
): void {
  const file = path.join(root, ".pactile", "tasks", task, reference);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
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

function seedV2ExecuteThread(
  root: string,
  task: string,
  runId: string,
): { threadId: string; hostId: string } {
  const taskDir = path.join(root, ".pactile", "tasks", task);
  const kernel = JSON.parse(
    fs.readFileSync(path.join(taskDir, "kernel.json"), "utf8"),
  ) as {
    identity: { taskId: string };
    revision: number;
    definition: unknown;
    runs: {
      id: string;
      candidateSnapshot: { id: string; fingerprint: string } | null;
    }[];
  };
  const run = kernel.runs.find((candidate) => candidate.id === runId);
  if (!run) throw new Error("V2 Execute Run fixture missing");
  const requestId = "c7ddcae9-d110-4fb3-b79f-ea7e84ed055e";
  const threadId = "v2-execute-thread";
  const hostId = "v2-execute-host";
  const requestPayload: Omit<CodexBridgeRequest, "request_fingerprint"> = {
    schema_version: 1,
    request_id: requestId,
    task: `.pactile/tasks/${task}`,
    task_id: kernel.identity.taskId,
    task_kernel_kind: "task-kernel-v2",
    kernel_revision: kernel.revision,
    contract_fingerprint: fingerprintTaskValue(kernel.definition),
    run_id: runId,
    candidate_snapshot_id: run.candidateSnapshot?.id ?? null,
    candidate_fingerprint: run.candidateSnapshot?.fingerprint ?? null,
    to_task: null,
    to_task_id: null,
    to_kernel_revision: null,
    to_task_kernel_kind: null,
    to_contract_fingerprint: null,
    to_run_id: null,
    to_candidate_snapshot_id: null,
    to_candidate_fingerprint: null,
    coordination_message_id: null,
    created_at: "2026-09-26T00:00:00.000Z",
    tool: "create_thread",
    role: "execute",
    thread_id: null,
    host_id: null,
    arguments: {},
    prompt_sha256: null,
  };
  const request: CodexBridgeRequest = {
    ...requestPayload,
    request_fingerprint: fingerprintTaskValue(requestPayload),
  };
  const receipt: CodexBridgeReceipt = {
    schema_version: 1,
    request_id: requestId,
    task_id: kernel.identity.taskId,
    run_id: runId,
    candidate_snapshot_id: run.candidateSnapshot?.id ?? null,
    candidate_fingerprint: run.candidateSnapshot?.fingerprint ?? null,
    request_fingerprint: request.request_fingerprint,
    evidence_level: "desktop-native",
    thread_creation_state: "created",
    tool: "create_thread",
    outcome: "ok",
    thread_id: threadId,
    client_thread_id: null,
    host_id: hostId,
    status: null,
    cursor: null,
    reason: null,
    kernel_revision_at_receipt: kernel.revision,
    contract_stale: false,
    recorded_at: "2026-09-26T00:00:01.000Z",
    assurance: "host-reported",
  };
  const bridgeDir = path.join(taskDir, "codex-bridge");
  fs.mkdirSync(path.join(bridgeDir, "requests"), { recursive: true });
  fs.mkdirSync(path.join(bridgeDir, "receipts"), { recursive: true });
  fs.writeFileSync(
    path.join(bridgeDir, "requests", `${requestId}.json`),
    `${JSON.stringify(request, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(bridgeDir, "receipts", `${requestId}.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  return { threadId, hostId };
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

  it("binds a V2 unblock to its current Kernel barrier and authorizes Resume", () => {
    const { root, task: senderTask, prompt } = fixture();
    expect(
      runTaskCli(
        [
          "create",
          "Resume barrier receiver",
          "--slug",
          "resume-barrier-receiver",
          "--deliverable",
          "A waiting Run can resume after a native coordination response",
          "--delivery-level",
          "documentation",
          "--accept",
          "AC-1=The unblock is causally bound to Kernel Resume",
        ],
        root,
      ),
    ).toBe(0);
    const receiverTask = fs
      .readdirSync(path.join(root, ".pactile", "tasks"))
      .find((name) => name.endsWith("-resume-barrier-receiver"));
    if (!receiverTask) throw new Error("V2 receiver Task fixture missing");

    const targetThread = prepareCodexRequest({
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
      targetThread.request_id,
      result(root, {
        request_id: targetThread.request_id,
        tool: targetThread.tool,
        outcome: "ok",
        thread_id: "resume-barrier-target-thread",
        host_id: "local",
      }),
    );
    const staleMessage = prepareCodexRequest({
      root,
      task: senderTask,
      tool: "send_message_to_thread",
      threadId: "resume-barrier-target-thread",
      toTask: receiverTask,
      promptFile: prompt,
    });
    recordCodexReceipt(
      root,
      senderTask,
      staleMessage.request_id,
      result(root, {
        request_id: staleMessage.request_id,
        tool: staleMessage.tool,
        outcome: "ok",
        thread_id: "resume-barrier-target-thread",
        host_id: "local",
      }),
    );

    expect(
      runTaskCli(
        [
          "run-start",
          receiverTask,
          "--actor",
          "implementer",
          "--input-summary",
          "Wait for a coordination response",
          "--approved-by",
          "approver",
          "--authorization-scope",
          "the reviewed documentation file",
          "--authorization-evidence",
          "approval.json",
          "--write-set",
          "docs/result.md",
          "--wait",
        ],
        root,
      ),
    ).toBe(0);
    const kernelFile = path.join(
      root,
      ".pactile",
      "tasks",
      receiverTask,
      "kernel.json",
    );
    const startedKernel = JSON.parse(fs.readFileSync(kernelFile, "utf8")) as {
      revision: number;
      runs: { id: string }[];
    };
    const runId = startedKernel.runs.at(-1)?.id;
    if (!runId) throw new Error("Receiver waiting Run missing");
    expect(() =>
      blockCodexTask(root, receiverTask, {
        messageId: staleMessage.request_id,
        reason: "A stale message cannot block the new Run",
      }),
    ).toThrow(/stale|misbound|not authoritative/i);

    const waitingMessage = prepareCodexRequest({
      root,
      task: senderTask,
      tool: "send_message_to_thread",
      threadId: "resume-barrier-target-thread",
      toTask: receiverTask,
      promptFile: prompt,
    });
    recordCodexReceipt(
      root,
      senderTask,
      waitingMessage.request_id,
      result(root, {
        request_id: waitingMessage.request_id,
        tool: waitingMessage.tool,
        outcome: "ok",
        thread_id: "resume-barrier-target-thread",
        host_id: "local",
      }),
    );
    const blocked = blockCodexTask(root, receiverTask, {
      messageId: waitingMessage.request_id,
      reason: "Waiting for a current response about the active Run",
    });
    expect(blocked.evidence_level).toBe("simulated");

    const beforeUnblock = JSON.parse(fs.readFileSync(kernelFile, "utf8")) as {
      revision: number;
      events: { id: string; revision: number }[];
    };
    const barrierEvent = beforeUnblock.events.at(-1);
    if (!barrierEvent) throw new Error("Kernel barrier event missing");
    const resolution = prepareCodexRequest({
      root,
      task: senderTask,
      tool: "send_message_to_thread",
      threadId: "resume-barrier-target-thread",
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
        thread_id: "resume-barrier-target-thread",
        host_id: "local",
      }),
      "desktop-native",
    );
    const unblocked = unblockCodexTask(root, receiverTask, {
      blockId: blocked.block_id,
      resolutionMessageId: resolution.request_id,
      reason: "The current native response was recorded",
    });
    expect(unblocked).toMatchObject({
      run_id: runId,
      kernel_revision_at_unblock: beforeUnblock.revision,
      kernel_event_id_at_unblock: barrierEvent.id,
      evidence_level: "desktop-native",
    });

    expect(
      runTaskCli(
        ["run-resume", receiverTask, runId, "--actor", "scheduler"],
        root,
      ),
    ).toBe(0);
    const resumedKernel = JSON.parse(fs.readFileSync(kernelFile, "utf8")) as {
      events: {
        id: string;
        type: string;
        entityId: string;
        revision: number;
      }[];
    };
    const resumedEvent = resumedKernel.events.findLast(
      (event) => event.type === "run.resumed" && event.entityId === runId,
    );
    if (!resumedEvent) throw new Error("Kernel Resume event missing");
    expect(new CoordinationStore(root).snapshot().events).toContainEqual(
      expect.objectContaining({
        type: "run.resume-authorized",
        task_id: codexBridgeStatus(root, receiverTask).task_id,
        run_id: runId,
        unblock_event_id: unblocked.event_id,
        kernel_revision: resumedEvent.revision,
        kernel_event_id: resumedEvent.id,
      }),
    );
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

  it("fails closed on V2 Execute create and cross-task Resume without P37 admission", () => {
    const { root, task: senderTask, prompt } = fixture();
    expect(
      runTaskCli(
        [
          "create",
          "V2 Execute receiver",
          "--slug",
          "v2-execute-receiver",
          "--description",
          "A receiver with an explicit Run contract",
          "--deliverable",
          "A reviewable implementation",
          "--delivery-level",
          "documentation",
          "--accept",
          "AC-1=The Execute dispatch remains admitted",
        ],
        root,
      ),
    ).toBe(0);
    const receiverTask = fs
      .readdirSync(path.join(root, ".pactile", "tasks"))
      .find((name) => name.endsWith("-v2-execute-receiver"));
    if (!receiverTask) throw new Error("V2 Execute receiver Task missing");
    expect(
      runTaskCli(
        [
          "run-start",
          receiverTask,
          "--actor",
          "implementer",
          "--input-summary",
          "Implement the approved deliverable",
          "--approved-by",
          "approver",
          "--authorization-scope",
          "the reviewed documentation file",
          "--authorization-evidence",
          "approval.json",
          "--write-set",
          "docs/result.md",
          "--wait",
        ],
        root,
      ),
    ).toBe(0);
    const receiverKernel = JSON.parse(
      fs.readFileSync(
        path.join(root, ".pactile", "tasks", receiverTask, "kernel.json"),
        "utf8",
      ),
    ) as { runs: { id: string }[] };
    const runId = receiverKernel.runs.at(-1)?.id;
    if (!runId) throw new Error("V2 Execute Run missing");

    expect(() =>
      prepareCodexRequest({
        root,
        task: receiverTask,
        tool: "create_thread",
        role: "execute",
        runId,
        promptFile: prompt,
        projectId: "project-1",
        environment: "worktree",
      }),
    ).toThrow("P37 admission, lease and Resume/block validation");

    const { threadId } = seedV2ExecuteThread(root, receiverTask, runId);
    const blocked = blockCodexTask(root, receiverTask, {
      reason: "Waiting for the upstream resolution",
      blockedByTaskId: codexBridgeStatus(root, senderTask).task_id,
    });
    expect(() =>
      prepareCodexRequest({
        root,
        task: senderTask,
        tool: "send_message_to_thread",
        threadId,
        toTask: receiverTask,
        toRunId: runId,
        resumeExecute: true,
        promptFile: prompt,
      }),
    ).toThrow("P37 admission, lease and Resume/block validation");
    expect(codexBridgeStatus(root, senderTask).pending).toEqual([]);

    unblockCodexTask(root, receiverTask, {
      blockId: blocked.block_id,
      reason: "The owner manually cleared the coordination block",
    });
    expect(
      runTaskCli(
        ["run-resume", receiverTask, runId, "--actor", "scheduler"],
        root,
      ),
    ).toBe(0);
    expect(() =>
      prepareCodexRequest({
        root,
        task: receiverTask,
        tool: "create_thread",
        role: "execute",
        runId,
        promptFile: prompt,
        projectId: "project-1",
        environment: "worktree",
      }),
    ).toThrow("P37 admission, lease and Resume/block validation");
    expect(codexBridgeStatus(root, receiverTask).pending).toEqual([]);
  });

  it.each(["plan", "review"] as const)(
    "fails closed on V2 --resume-execute sent through a bound %s thread",
    (role) => {
      const { root, task: senderTask, prompt } = fixture();
      const slug = `resume-${role}-receiver`;
      expect(
        runTaskCli(
          [
            "create",
            `Resume ${role} receiver`,
            "--slug",
            slug,
            "--description",
            "A V2 Task with a bound non-Execute thread",
            "--deliverable",
            "A reviewable implementation",
            "--delivery-level",
            "documentation",
            "--accept",
            "AC-1=Resume dispatch remains fail closed",
          ],
          root,
        ),
      ).toBe(0);
      const receiverTask = fs
        .readdirSync(path.join(root, ".pactile", "tasks"))
        .find((name) => name.endsWith(`-${slug}`));
      if (!receiverTask) throw new Error("V2 receiver Task missing");

      let runId: string | undefined;
      if (role === "review") {
        expect(
          runTaskCli(
            [
              "run-start",
              receiverTask,
              "--actor",
              "implementer",
              "--input-summary",
              "Implement the approved deliverable",
              "--approved-by",
              "approver",
              "--authorization-scope",
              "the reviewed documentation file",
              "--authorization-evidence",
              "approval.json",
              "--write-set",
              "docs/result.md",
              "--wait",
            ],
            root,
          ),
        ).toBe(0);
        const startedKernel = JSON.parse(
          fs.readFileSync(
            path.join(root, ".pactile", "tasks", receiverTask, "kernel.json"),
            "utf8",
          ),
        ) as { runs: { id: string }[] };
        runId = startedKernel.runs.at(-1)?.id;
        if (!runId) throw new Error("V2 Review Run missing");
        expect(
          runTaskCli(
            ["run-resume", receiverTask, runId, "--actor", "scheduler"],
            root,
          ),
        ).toBe(0);
        const candidateFingerprint = writeRunCandidateFile(
          root,
          "docs/result.md",
          "The candidate is ready for Review.\n",
        );
        writeTaskEvidenceFile(
          root,
          receiverTask,
          "test-output.txt",
          "The review candidate was generated and inspected.\n",
        );
        expect(
          runTaskCli(
            [
              "run-result",
              receiverTask,
              runId,
              "--outcome",
              "completed",
              "--summary",
              "The candidate is ready for review",
              "--candidate",
              `docs/result.md=${candidateFingerprint}`,
              "--evidence",
              "test-output.txt",
            ],
            root,
          ),
        ).toBe(0);
      }

      const targetThread = prepareCodexRequest({
        root,
        task: receiverTask,
        tool: "create_thread",
        role,
        ...(runId ? { runId } : {}),
        promptFile: prompt,
        targetType: "projectless",
      });
      recordCodexReceipt(
        root,
        receiverTask,
        targetThread.request_id,
        result(root, {
          request_id: targetThread.request_id,
          tool: targetThread.tool,
          outcome: "ok",
          thread_id: `resume-${role}-thread`,
          host_id: "local",
        }),
      );

      expect(() =>
        prepareCodexRequest({
          root,
          task: senderTask,
          tool: "send_message_to_thread",
          threadId: `resume-${role}-thread`,
          toTask: receiverTask,
          ...(runId ? { toRunId: runId } : {}),
          resumeExecute: true,
          promptFile: prompt,
        }),
      ).toThrow("Task Kernel v2 --resume-execute dispatch is disabled");
      expect(codexBridgeStatus(root, senderTask).pending).toEqual([]);
    },
  );

  it("writes paired Pi escalation send and native read receipts through Codex CLI", () => {
    const { root, task: replyTask, prompt } = fixture();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sourceSlug = "pi-escalation-source";
    expect(
      runTaskCli(
        [
          "create",
          "Pi Review escalation source",
          "--slug",
          sourceSlug,
          "--description",
          "A V2 Review that requests Codex coordination",
          "--deliverable",
          "A reviewable result",
          "--delivery-level",
          "documentation",
          "--accept",
          "AC-1=The current Review can request bounded Codex input",
        ],
        root,
      ),
    ).toBe(0);
    const sourceTask = fs
      .readdirSync(path.join(root, ".pactile", "tasks"))
      .find((name) => name.endsWith(`-${sourceSlug}`));
    if (!sourceTask) throw new Error("Pi escalation source Task missing");
    expect(
      runTaskCli(
        [
          "run-start",
          sourceTask,
          "--actor",
          "implementer",
          "--input-summary",
          "Implement the approved deliverable",
          "--approved-by",
          "approver",
          "--authorization-scope",
          "the reviewed documentation file",
          "--authorization-evidence",
          "approval.json",
          "--write-set",
          "docs/result.md",
          "--wait",
        ],
        root,
      ),
    ).toBe(0);
    let sourceKernel = JSON.parse(
      fs.readFileSync(
        path.join(root, ".pactile", "tasks", sourceTask, "kernel.json"),
        "utf8",
      ),
    ) as {
      revision: number;
      runs: {
        id: string;
        candidateSnapshot: { id: string; fingerprint: string } | null;
      }[];
    };
    const sourceRunId = sourceKernel.runs.at(-1)?.id;
    if (!sourceRunId) throw new Error("Pi escalation source Run missing");
    expect(
      runTaskCli(
        ["run-resume", sourceTask, sourceRunId, "--actor", "scheduler"],
        root,
      ),
    ).toBe(0);
    const sourceCandidateFingerprint = writeRunCandidateFile(
      root,
      "docs/result.md",
      "Candidate ready for independent Review.\n",
    );
    writeTaskEvidenceFile(
      root,
      sourceTask,
      "test-output.txt",
      "Pi Run output was persisted before settlement.\n",
    );
    expect(
      runTaskCli(
        [
          "run-result",
          sourceTask,
          sourceRunId,
          "--outcome",
          "completed",
          "--summary",
          "Candidate ready for independent Review",
          "--candidate",
          `docs/result.md=${sourceCandidateFingerprint}`,
          "--evidence",
          "test-output.txt",
        ],
        root,
      ),
    ).toBe(0);
    sourceKernel = JSON.parse(
      fs.readFileSync(
        path.join(root, ".pactile", "tasks", sourceTask, "kernel.json"),
        "utf8",
      ),
    ) as typeof sourceKernel;
    const sourceRun = sourceKernel.runs.at(-1);
    const candidate = sourceRun?.candidateSnapshot;
    if (!candidate) throw new Error("Pi escalation source candidate missing");
    writeTaskEvidenceFile(
      root,
      sourceTask,
      "review.md",
      "An uncertain finding requires coordination input before completion.\n",
    );
    expect(
      runTaskCli(
        [
          "review",
          sourceTask,
          "--run",
          sourceRunId,
          "--decision",
          "needs-changes",
          "--candidate-id",
          candidate.id,
          "--candidate-fingerprint",
          candidate.fingerprint,
          "--reviewer",
          "tester",
          "--actor",
          "tester",
          "--evidence",
          "review.md",
          "--blocker",
          "Codex input is required for an uncertain finding",
        ],
        root,
      ),
    ).toBe(0);

    const targetThread = prepareCodexRequest({
      root,
      task: replyTask,
      tool: "create_thread",
      role: "plan",
      promptFile: prompt,
      targetType: "projectless",
    });
    recordCodexReceipt(
      root,
      replyTask,
      targetThread.request_id,
      result(root, {
        request_id: targetThread.request_id,
        tool: targetThread.tool,
        outcome: "ok",
        thread_id: "p40-escalation-thread",
        host_id: "local",
      }),
    );

    const escalationId = "pi-escalation:12345678-1234-1234-1234-123456789abc";
    expect(
      runCodexCli(
        [
          "prepare",
          sourceTask,
          "--tool",
          "message",
          "--thread-id",
          "p40-escalation-thread",
          "--to-task",
          replyTask,
          "--run-id",
          sourceRunId,
          "--escalation-id",
          escalationId,
          "--prompt-file",
          prompt,
        ],
        root,
      ),
    ).toBe(0);
    const sendPending = codexBridgeStatus(root, sourceTask).pending.at(-1);
    if (!sendPending) throw new Error("Escalation send request missing");
    const sourceDir = path.join(root, ".pactile", "tasks", sourceTask);
    const sendRequest = JSON.parse(
      fs.readFileSync(
        path.join(
          sourceDir,
          "codex-bridge",
          "requests",
          `${sendPending.request_id}.json`,
        ),
        "utf8",
      ),
    ) as CodexBridgeRequest;
    expect(sendRequest).toMatchObject({
      request_id: sendPending.request_id,
      escalation_id: escalationId,
      task_id: codexBridgeStatus(root, sourceTask).task_id,
      run_id: sourceRunId,
      candidate_snapshot_id: candidate.id,
      candidate_fingerprint: candidate.fingerprint,
      to_task_id: codexBridgeStatus(root, replyTask).task_id,
      to_run_id: null,
      to_candidate_snapshot_id: null,
      to_candidate_fingerprint: null,
      thread_id: "p40-escalation-thread",
      host_id: "local",
    });
    const sendResult = result(root, {
      request_id: sendRequest.request_id,
      tool: "send_message_to_thread",
      outcome: "ok",
      thread_id: "p40-escalation-thread",
      host_id: "local",
    });
    expect(
      runCodexCli(
        [
          "receipt",
          sourceTask,
          sendRequest.request_id,
          "--result-file",
          path.relative(root, sendResult),
        ],
        root,
      ),
    ).toBe(1);
    const sendReceiptFile = path.join(
      sourceDir,
      "codex-bridge",
      "receipts",
      `${sendRequest.request_id}.json`,
    );
    expect(fs.existsSync(sendReceiptFile)).toBe(false);
    expect(
      runCodexCli(
        [
          "receipt",
          sourceTask,
          sendRequest.request_id,
          "--result-file",
          path.relative(root, sendResult),
          "--evidence-level",
          "desktop-native",
        ],
        root,
      ),
    ).toBe(0);
    const sendReceipt = JSON.parse(
      fs.readFileSync(sendReceiptFile, "utf8"),
    ) as CodexBridgeReceipt;
    expect(sendReceipt).toMatchObject({
      request_id: sendRequest.request_id,
      request_fingerprint: sendRequest.request_fingerprint,
      escalation_id: escalationId,
      task_id: sendRequest.task_id,
      run_id: sourceRunId,
      candidate_snapshot_id: candidate.id,
      candidate_fingerprint: candidate.fingerprint,
      to_task_id: sendRequest.to_task_id,
      to_run_id: null,
      to_candidate_snapshot_id: null,
      to_candidate_fingerprint: null,
      thread_id: "p40-escalation-thread",
      host_id: "local",
      evidence_level: "desktop-native",
      contract_stale: false,
    });

    expect(
      runCodexCli(
        [
          "prepare",
          replyTask,
          "--tool",
          "read",
          "--thread-id",
          "p40-escalation-thread",
          "--reply-to-escalation-id",
          escalationId,
        ],
        root,
      ),
    ).toBe(0);
    const readPending = codexBridgeStatus(root, replyTask).pending.at(-1);
    if (!readPending) throw new Error("Escalation read request missing");
    const replyDir = path.join(root, ".pactile", "tasks", replyTask);
    const readRequest = JSON.parse(
      fs.readFileSync(
        path.join(
          replyDir,
          "codex-bridge",
          "requests",
          `${readPending.request_id}.json`,
        ),
        "utf8",
      ),
    ) as CodexBridgeRequest;
    expect(readRequest).toMatchObject({
      request_id: readPending.request_id,
      tool: "read_thread",
      reply_to_escalation_id: escalationId,
      task_id: codexBridgeStatus(root, replyTask).task_id,
      run_id: null,
      candidate_snapshot_id: null,
      candidate_fingerprint: null,
      thread_id: "p40-escalation-thread",
      host_id: "local",
    });
    const replyBody =
      "Codex reply: the review finding is supported by the linked test result.";
    const readResult = result(root, {
      request_id: readRequest.request_id,
      tool: "read_thread",
      outcome: "ok",
      status: "completed",
      thread_id: "p40-escalation-thread",
      host_id: "local",
      reply_to_escalation_id: escalationId,
      reply_evidence: {
        reply_to_escalation_id: escalationId,
        response_turn_id: "turn:codex-reply-1",
        body: replyBody,
        body_sha256: createHash("sha256")
          .update(replyBody, "utf8")
          .digest("hex"),
      },
    });
    expect(
      runCodexCli(
        [
          "receipt",
          replyTask,
          readRequest.request_id,
          "--result-file",
          path.relative(root, readResult),
        ],
        root,
      ),
    ).toBe(1);
    const readReceiptFile = path.join(
      replyDir,
      "codex-bridge",
      "receipts",
      `${readRequest.request_id}.json`,
    );
    expect(fs.existsSync(readReceiptFile)).toBe(false);
    const invalidReadResult = result(root, {
      request_id: readRequest.request_id,
      tool: "read_thread",
      outcome: "ok",
      status: "completed",
      thread_id: "p40-escalation-thread",
      host_id: "local",
      reply_to_escalation_id: escalationId,
      reply_evidence: {
        reply_to_escalation_id: escalationId,
        response_turn_id: "turn:codex-reply-1",
        body: "A tampered reply hash must be rejected.",
        body_sha256: "0".repeat(64),
      },
    });
    expect(
      runCodexCli(
        [
          "receipt",
          replyTask,
          readRequest.request_id,
          "--result-file",
          path.relative(root, invalidReadResult),
          "--evidence-level",
          "desktop-native",
        ],
        root,
      ),
    ).toBe(1);
    expect(fs.existsSync(readReceiptFile)).toBe(false);
    expect(
      runCodexCli(
        [
          "receipt",
          replyTask,
          readRequest.request_id,
          "--result-file",
          path.relative(root, readResult),
          "--evidence-level",
          "desktop-native",
        ],
        root,
      ),
    ).toBe(0);
    const readReceipt = JSON.parse(
      fs.readFileSync(readReceiptFile, "utf8"),
    ) as CodexBridgeReceipt;
    expect(readReceipt).toMatchObject({
      request_id: readRequest.request_id,
      request_fingerprint: readRequest.request_fingerprint,
      reply_to_escalation_id: escalationId,
      task_id: readRequest.task_id,
      run_id: null,
      candidate_snapshot_id: null,
      candidate_fingerprint: null,
      thread_id: "p40-escalation-thread",
      host_id: "local",
      evidence_level: "desktop-native",
      status: "completed",
      contract_stale: false,
      reply_evidence: {
        reply_to_escalation_id: escalationId,
        response_turn_id: "turn:codex-reply-1",
        body: replyBody,
        body_sha256: createHash("sha256")
          .update(replyBody, "utf8")
          .digest("hex"),
      },
    });
    expect(path.relative(root, sendReceiptFile).replaceAll("\\", "/")).toBe(
      `.pactile/tasks/${sourceTask}/codex-bridge/receipts/${sendRequest.request_id}.json`,
    );
    expect(path.relative(root, readReceiptFile).replaceAll("\\", "/")).toBe(
      `.pactile/tasks/${replyTask}/codex-bridge/receipts/${readRequest.request_id}.json`,
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

    const simulatedResolution = prepareCodexRequest({
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
      simulatedResolution.request_id,
      result(root, {
        request_id: simulatedResolution.request_id,
        tool: simulatedResolution.tool,
        outcome: "ok",
        thread_id: threadId,
        host_id: "local",
      }),
    );
    expect(() =>
      unblockCodexTask(root, receiverTask, {
        blockId: blocked.block_id,
        resolutionMessageId: simulatedResolution.request_id,
        reason: "A simulated receipt cannot clear the coordination block.",
      }),
    ).toThrow("successful desktop-native resolution receipt");

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
      "desktop-native",
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
    const lateCreate = prepareCodexRequest({
      root,
      task,
      tool: "create_thread",
      role: "plan",
      promptFile: prompt,
      targetType: "projectless",
    });
    expect(runTaskCli(["start-execution", task, "--approved"], root)).toBe(0);
    fs.appendFileSync(
      path.join(root, ".pactile", "tasks", task, "verify.md"),
      "\nValidation commands: bridge test passed\nFinal acceptance evidence: receipt retained\n",
    );
    expect(runTaskCli(["archive", task, "--no-commit"], root)).toBe(0);
    expect(() =>
      recordCodexReceipt(
        root,
        task,
        lateCreate.request_id,
        result(root, {
          request_id: lateCreate.request_id,
          tool: lateCreate.tool,
          outcome: "ok",
          thread_id: "too-late-thread",
          host_id: "local",
        }),
      ),
    ).toThrow("Cannot record a new Codex receipt for an archived Task");
    expect(codexBridgeStatus(root, task)).toMatchObject({
      archived: true,
      phase: "close",
      threads: [{ threadId: "thread-archived" }],
      pending: [{ request_id: lateCreate.request_id }],
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
