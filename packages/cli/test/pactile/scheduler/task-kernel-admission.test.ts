import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTaskKernel,
  fingerprintTaskValue,
  bindTaskRunHostReceipt,
  readTaskKernel,
  recordTaskRunResult,
  resumeTaskRun,
  startTaskRun,
  type ResumeTaskRunRequest,
} from "../../../src/core/task/index.js";
import {
  createTaskCandidateEntry,
  observeTaskRunCandidate,
} from "../../../src/core/task/task-candidate-observer.js";
import {
  acquireTaskKernelRunDispatchV1,
  assertTaskKernelRunDispatchLeaseV1,
  assertTaskKernelRunDispatchPreSpawnV1,
  bindTaskKernelRunDispatchOwnerV1,
  releaseTaskKernelRunDispatchV1,
  readTaskKernelScheduleReceiptV1,
  validateTaskKernelRunDispatchStopProofV1,
  scheduleTaskKernelGraph,
  type TaskKernelRunDispatchOwnerV1,
  type TaskKernelRunDispatchStopProofV1,
} from "../../../src/pactile/scheduler/index.js";
import { normalizeProjectWriteSet } from "../../../src/pactile/scheduler/project-lease-store.js";
import {
  CoordinationStore,
  resumeTaskRunWithCoordinationBarrier,
} from "../../../src/pactile/coordination/index.js";
import { listProjectWriteLeases } from "../../../src/pactile/scheduler/project-lease-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-v2-admission-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
  return root;
}

function createTask(
  root: string,
  taskId: string,
  options: {
    dependencies?: string[];
    writeSet?: string[];
    executionMs?: number;
    host?:
      | boolean
      | {
          host: string;
          role: string;
          sessionId: string | null;
          threadId: string | null;
          requestRefs?: string[];
          eventRefs?: string[];
          resultRefs?: string[];
          assuranceSource?: string | null;
        };
    state?: "waiting" | "running";
    startRun?: boolean;
  } = {},
): { taskDir: string; runId: string; revision: number } {
  const taskDir = path.join(root, ".pactile", "tasks", taskId);
  const created = createTaskKernel({
    root,
    taskDir,
    actor: "author",
    idempotencyKey: `create:${taskId}`,
    definition: {
      taskId,
      title: taskId,
      description: "V2 admission fixture",
      deliverable: "one bounded result",
      deliveryLevel: "local-result",
      acceptanceCriteria: [{ id: "AC-1", description: "result exists" }],
      dependencies: options.dependencies ?? [],
    },
  });
  if (options.startRun === false) {
    return { taskDir, runId: "", revision: created.kernel.revision };
  }
  const run = startTaskRun({
    root,
    taskDir,
    expectedRevision: created.kernel.revision,
    actor: "implementer",
    idempotencyKey: `run:${taskId}`,
    input: { summary: "admission fixture", references: [] },
    authorization: {
      approvedBy: "approver",
      approvedAt: "2026-09-26T00:00:00.000Z",
      scope: "fixture",
      evidenceRef: "approval.json",
    },
    initialState: options.state ?? "waiting",
    writeSetSnapshot: options.writeSet ?? [`src/${taskId}.ts`],
    estimatedDurations: { executionMs: options.executionMs ?? 10_000 },
    ...(options.host
      ? {
          host:
            options.host === true
              ? {
                  host: "codex-desktop",
                  role: "execute",
                  sessionId: null,
                  threadId: `thread-${taskId}`,
                  requestRefs: [],
                  eventRefs: [],
                  resultRefs: [],
                  assuranceSource: "desktop-native",
                }
              : options.host,
        }
      : {}),
  });
  return {
    taskDir,
    runId: run.kernel.runs.at(-1)?.id ?? "",
    revision: run.kernel.revision,
  };
}

function runOwner(root: string, taskId: string): TaskKernelRunDispatchOwnerV1 {
  const read = readTaskKernel({
    root,
    taskDir: path.join(root, ".pactile", "tasks", taskId),
  });
  if (read.kind !== "task-kernel-v2") throw new Error("missing V2 kernel");
  const host = read.kernel.runs.at(-1)?.host;
  if (!host) throw new Error("missing host binding");
  return {
    host: host.host,
    role: host.role,
    sessionId: host.sessionId,
    threadId: host.threadId,
    hostId: null,
    contractFingerprint: host.contractFingerprint,
  };
}

function makeNativeStopProof(
  root: string,
  input: {
    leaseId: string;
    taskId: string;
    runId: string;
    scheduleReceiptFingerprint: string;
    admissionReceiptFingerprint: string;
    owner: TaskKernelRunDispatchOwnerV1;
    disposition: "native-terminal" | "not-created";
  },
): string {
  const baseDir = path.join(
    root,
    ".pactile",
    "tasks",
    input.taskId,
    "codex-bridge",
  );
  const requestDir = path.join(baseDir, "requests");
  const receiptDir = path.join(baseDir, "receipts");
  const proofDir = path.join(baseDir, "dispatch-proofs");
  fs.mkdirSync(requestDir, { recursive: true });
  fs.mkdirSync(receiptDir, { recursive: true });
  fs.mkdirSync(proofDir, { recursive: true });
  const requestId = `request-${input.disposition}`;
  const tool =
    input.disposition === "native-terminal" ? "wait_threads" : "create_thread";
  const kernelRead = readTaskKernel({
    root,
    taskDir: path.join(root, ".pactile", "tasks", input.taskId),
  });
  const candidate =
    kernelRead.kind === "task-kernel-v2"
      ? (kernelRead.kernel.runs.at(-1)?.candidateSnapshot ?? null)
      : null;
  const requestBase = {
    schema_version: 1,
    request_id: requestId,
    task_id: input.taskId,
    task_kernel_kind: "task-kernel-v2",
    kernel_revision: 1,
    contract_fingerprint: input.owner.contractFingerprint,
    run_id: input.runId,
    candidate_snapshot_id: candidate?.id ?? null,
    candidate_fingerprint: candidate?.fingerprint ?? null,
    dispatch_task_id: input.taskId,
    dispatch_run_id: input.runId,
    dispatch_lease_id: input.leaseId,
    schedule_receipt_fingerprint: input.scheduleReceiptFingerprint,
    dispatch_admission_receipt_fingerprint: input.admissionReceiptFingerprint,
    tool,
    role: input.owner.role,
    thread_id: input.owner.threadId,
    host_id: input.owner.hostId,
    arguments: {},
    prompt_sha256: "0".repeat(64),
  };
  const requestFingerprint = fingerprintTaskValue(requestBase);
  const request = { ...requestBase, request_fingerprint: requestFingerprint };
  const requestRef = path.join(requestDir, `${requestId}.json`);
  fs.writeFileSync(requestRef, `${JSON.stringify(request, null, 2)}\n`);
  const nativeReceipt = {
    schema_version: 1,
    request_id: requestId,
    request_fingerprint: requestFingerprint,
    task_id: input.taskId,
    run_id: input.runId,
    candidate_snapshot_id: candidate?.id ?? null,
    candidate_fingerprint: candidate?.fingerprint ?? null,
    evidence_level: "desktop-native",
    tool,
    outcome: input.disposition === "native-terminal" ? "ok" : "failed",
    thread_id: input.owner.threadId,
    client_thread_id: null,
    host_id: input.owner.hostId,
    status: input.disposition === "native-terminal" ? "completed" : "failed",
    cursor: null,
    reason: null,
    kernel_revision_at_receipt: 1,
    contract_stale: false,
    recorded_at: "2026-09-26T00:10:00.000Z",
    assurance: {},
    ...(input.disposition === "not-created"
      ? { thread_creation_state: "not_created" }
      : {}),
  };
  const nativeReceiptRef = path.join(receiptDir, `${requestId}.json`);
  fs.writeFileSync(
    nativeReceiptRef,
    `${JSON.stringify(nativeReceipt, null, 2)}\n`,
  );
  const proofBase = {
    schema_version: 1,
    scope: "task-kernel-v2-run-dispatch-stop",
    lease_id: input.leaseId,
    task_id: input.taskId,
    run_id: input.runId,
    schedule_receipt_fingerprint: input.scheduleReceiptFingerprint,
    admission_receipt_fingerprint: input.admissionReceiptFingerprint,
    source: "codex-bridge" as const,
    disposition: input.disposition,
    writer_exited: true as const,
    owner: {
      host: input.owner.host,
      role: input.owner.role,
      session_id: input.owner.sessionId,
      thread_id: input.owner.threadId,
      host_id: input.owner.hostId,
      start_request_id: null,
      process_id: null,
    },
    request_ref: path.relative(root, requestRef).replaceAll("\\", "/"),
    request_fingerprint: requestFingerprint,
    native_receipt_ref: path
      .relative(root, nativeReceiptRef)
      .replaceAll("\\", "/"),
    native_receipt_fingerprint: fingerprintTaskValue(nativeReceipt),
  };
  const proofFingerprint = fingerprintTaskValue(proofBase);
  const proofRef = path.join(proofDir, `${proofFingerprint}.json`);
  fs.writeFileSync(
    proofRef,
    `${JSON.stringify({ ...proofBase, proof_fingerprint: proofFingerprint }, null, 2)}\n`,
  );
  return path.relative(root, proofRef).replaceAll("\\", "/");
}

function makePiStopProof(
  root: string,
  input: {
    leaseId: string;
    taskId: string;
    runId: string;
    scheduleReceiptFingerprint: string;
    admissionReceiptFingerprint: string;
    owner: TaskKernelRunDispatchOwnerV1;
    terminationVerified?: boolean;
  },
): string {
  if (!input.owner.startRequestId || !input.owner.processId)
    throw new Error(
      "Pi fixture owner must include a start request and process",
    );
  const taskDir = path.join(root, ".pactile", "tasks", input.taskId);
  const piRunId = `pi-run-${input.taskId}`;
  const baseDir = path.join(taskDir, "pi-bridge");
  const startDir = path.join(baseDir, "starts");
  const eventDir = path.join(baseDir, "events");
  const runDir = path.join(baseDir, "runs");
  const proofDir = path.join(baseDir, "dispatch-proofs");
  fs.mkdirSync(startDir, { recursive: true });
  fs.mkdirSync(eventDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(proofDir, { recursive: true });
  const requestRef = path.join(startDir, `${piRunId}.json`);
  const nativeReceiptRef = path.join(runDir, `${piRunId}.json`);
  const progressEvidenceRef = path.join(eventDir, `${piRunId}.jsonl`);
  fs.writeFileSync(progressEvidenceRef, "{}\n");
  const projectRequestRef = path
    .relative(root, requestRef)
    .replaceAll("\\", "/");
  const projectReceiptRef = path
    .relative(root, nativeReceiptRef)
    .replaceAll("\\", "/");
  const projectProgressRef = path
    .relative(root, progressEvidenceRef)
    .replaceAll("\\", "/");
  const stop = {
    schemaVersion: 1,
    source: "pactile-pi-rpc",
    assurance: "manager-owned-child-exit",
    taskId: input.taskId,
    taskRunId: input.runId,
    piRunId,
    role: "implement",
    sessionId: input.owner.sessionId,
    processId: input.owner.processId,
    startRequestId: input.owner.startRequestId,
    settleReceiptId: `settle-${piRunId}`,
    terminal: "exited",
    exitCode: 0,
    signalCode: null,
    cancellationRequestId: null,
    evidenceRef: projectReceiptRef,
    progressEvidenceRef: projectProgressRef,
    resultRef: `${projectReceiptRef}.result`,
    resultSha256: "a".repeat(64),
    recordedAt: "2026-09-26T00:20:00.000Z",
    processExit: {
      processId: input.owner.processId,
      stopRequestedAt: "2026-09-26T00:19:00.000Z",
      killRequestedAt: null,
      exitObservedAt: "2026-09-26T00:20:00.000Z",
      exitCode: 0,
      signalCode: null,
      terminationVerified: input.terminationVerified ?? true,
    },
  };
  const startReceipt = {
    schemaVersion: 1,
    source: "pactile-pi-rpc",
    taskId: input.taskId,
    taskRunId: input.runId,
    piRunId,
    role: "implement",
    sessionId: input.owner.sessionId,
    processId: input.owner.processId,
    startRequestId: input.owner.startRequestId,
    progressEvidenceRef: projectProgressRef,
    evidenceRef: projectReceiptRef,
    recordedAt: "2026-09-26T00:18:00.000Z",
  };
  fs.writeFileSync(requestRef, `${JSON.stringify(startReceipt, null, 2)}\n`);
  fs.writeFileSync(
    nativeReceiptRef,
    `${JSON.stringify(
      {
        run_id: piRunId,
        task_id: input.taskId,
        task_run_id: input.runId,
        role: "implement",
        session_id: input.owner.sessionId,
        process_id: input.owner.processId,
        start_request_id: input.owner.startRequestId,
        host_start_receipt_ref: projectRequestRef,
        progress_evidence_ref: projectProgressRef,
        settle_receipt_id: stop.settleReceiptId,
        process_stop_receipt: stop,
      },
      null,
      2,
    )}\n`,
  );
  const proofBase = {
    schema_version: 1,
    scope: "task-kernel-v2-run-dispatch-stop",
    lease_id: input.leaseId,
    task_id: input.taskId,
    run_id: input.runId,
    schedule_receipt_fingerprint: input.scheduleReceiptFingerprint,
    admission_receipt_fingerprint: input.admissionReceiptFingerprint,
    source: "pi-host" as const,
    disposition: "native-terminal" as const,
    writer_exited: true as const,
    owner: {
      host: input.owner.host,
      role: input.owner.role,
      session_id: input.owner.sessionId,
      thread_id: input.owner.threadId,
      host_id: input.owner.hostId,
      start_request_id: input.owner.startRequestId,
      process_id: input.owner.processId,
    },
    request_ref: projectRequestRef,
    request_fingerprint: fingerprintTaskValue(startReceipt),
    native_receipt_ref: projectReceiptRef,
    native_receipt_fingerprint: fingerprintTaskValue(stop),
  };
  const proofFingerprint = fingerprintTaskValue(proofBase);
  const proofRef = path.join(proofDir, `${proofFingerprint}.json`);
  fs.writeFileSync(
    proofRef,
    `${JSON.stringify({ ...proofBase, proof_fingerprint: proofFingerprint }, null, 2)}\n`,
  );
  return path.relative(root, proofRef).replaceAll("\\", "/");
}

function admit(
  root: string,
  scheduleReceiptFingerprint: string,
  taskId: string,
  runId: string,
  owner?: TaskKernelRunDispatchOwnerV1,
) {
  return acquireTaskKernelRunDispatchV1(root, {
    scheduleReceiptFingerprint,
    taskId,
    runId,
    ...(owner ? { owner } : {}),
  });
}

function spawnResumeWorker(input: {
  workerFile: string;
  request: ResumeTaskRunRequest;
  readyFile: string;
  goFile: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", input.workerFile],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PACTILE_RESUME_WORKER_PAYLOAD: JSON.stringify(input.request),
          PACTILE_RESUME_WORKER_READY: input.readyFile,
          PACTILE_RESUME_WORKER_GO: input.goFile,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`resume worker exited ${code}: ${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function spawnUnblockWorker(input: {
  workerFile: string;
  request: { root: string; taskId: string; blockId: string };
  readyFile: string;
  releaseFile: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", input.workerFile],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PACTILE_UNBLOCK_WORKER_PAYLOAD: JSON.stringify(input.request),
          PACTILE_UNBLOCK_WORKER_READY: input.readyFile,
          PACTILE_UNBLOCK_WORKER_RELEASE: input.releaseFile,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`unblock worker exited ${code}: ${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function withoutRecordKeys(
  value: Record<string, unknown>,
  omitted: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !omitted.includes(key)),
  );
}

function writeLegacyScheduleReceiptWithoutIntegrationOwner(
  root: string,
  fingerprint: string,
): string {
  const folder = path.join(
    root,
    ".pactile",
    ".runtime",
    "scheduler",
    "receipts",
  );
  const originalFile = path.join(folder, `${fingerprint}.json`);
  const receipt = JSON.parse(fs.readFileSync(originalFile, "utf8")) as Record<
    string,
    unknown
  >;
  const request = receipt.request as {
    conflictParallelizations?: Record<string, unknown>[];
  };
  request.conflictParallelizations = (
    request.conflictParallelizations ?? []
  ).map((authorization) =>
    withoutRecordKeys(authorization, ["integrationOwner"]),
  );
  const plan = receipt.plan as {
    waves: { conflictAuthorizations: Record<string, unknown>[] }[];
  };
  for (const wave of plan.waves)
    wave.conflictAuthorizations = wave.conflictAuthorizations.map(
      (authorization) => withoutRecordKeys(authorization, ["integrationOwner"]),
    );

  const receiptBase = withoutRecordKeys(receipt, [
    "schemaVersion",
    "scope",
    "receiptFingerprint",
    "createdAt",
    "integrityVersion",
    "scheduleKey",
  ]);
  receipt.scheduleKey = fingerprintTaskValue(receiptBase);
  const envelope = withoutRecordKeys(receipt, ["receiptFingerprint"]);
  const legacyFingerprint = fingerprintTaskValue(envelope);
  receipt.receiptFingerprint = legacyFingerprint;
  fs.writeFileSync(
    path.join(folder, `${legacyFingerprint}.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx" },
  );
  fs.rmSync(originalFile, { force: true });
  return legacyFingerprint;
}

describe("Task Kernel V2 Run dispatch admission", () => {
  it("rejects a coordination-blocked Task before creating a writer lease", () => {
    const root = makeRoot();
    const taskId = "v2-coordination-blocked-admission";
    const task = createTask(root, taskId);
    const schedule = scheduleTaskKernelGraph(root, [taskId]);
    new CoordinationStore(root).blockTask({
      taskId,
      blockId: "coordination-block-admission",
      reason: "Waiting for an upstream decision",
      actor: { platform: "user", id: "reviewer" },
      evidenceLevel: "simulated",
    });

    const result = admit(
      root,
      schedule.receipt.receiptFingerprint,
      taskId,
      task.runId,
    );

    expect(result).toMatchObject({
      permitted: false,
      receipt: {
        reasonCodes: ["coordination-task-blocked"],
        leaseId: null,
      },
    });
    expect(listProjectWriteLeases(root)).toEqual([]);
  });

  it("requires a lock-bound Kernel Resume after a causal unblock", () => {
    const root = makeRoot();
    const taskId = "v2-coordination-unblock-resume";
    const task = createTask(root, taskId);
    const beforeUnblock = readTaskKernel({ root, taskDir: task.taskDir });
    if (beforeUnblock.kind !== "task-kernel-v2")
      throw new Error("Fixture has no V2 kernel");
    const kernelBarrier = beforeUnblock.kernel.events.at(-1);
    if (!kernelBarrier) throw new Error("Fixture has no Kernel event");
    const coordination = new CoordinationStore(root);
    const block = coordination.blockTask({
      taskId,
      blockId: "coordination-block-resume",
      reason: "Waiting for the desktop resolution",
      actor: { platform: "user", id: "reviewer" },
      evidenceLevel: "local",
    });
    const unblock = coordination.unblockTask({
      taskId,
      blockId: block.block_id,
      runId: task.runId,
      kernelRevisionAtUnblock: beforeUnblock.kernel.revision,
      kernelEventIdAtUnblock: kernelBarrier.id,
      reason: "The resolution was recorded",
      actor: { platform: "user", id: "reviewer" },
      evidenceLevel: "desktop-native",
    });

    const beforeResumeSchedule = scheduleTaskKernelGraph(root, [taskId]);
    expect(
      admit(
        root,
        beforeResumeSchedule.receipt.receiptFingerprint,
        taskId,
        task.runId,
      ),
    ).toMatchObject({
      permitted: false,
      receipt: {
        reasonCodes: ["coordination-unblock-requires-kernel-resume"],
        leaseId: null,
      },
    });
    expect(listProjectWriteLeases(root)).toEqual([]);

    const resumed = resumeTaskRunWithCoordinationBarrier({
      root,
      taskDir: task.taskDir,
      expectedRevision: task.revision,
      runId: task.runId,
      actor: "implementer",
      idempotencyKey: "resume:v2-coordination-unblock-resume",
    });
    expect(resumed.event).toMatchObject({
      type: "run.resumed",
      entityId: task.runId,
    });
    expect(coordination.snapshot().events.at(-1)).toMatchObject({
      type: "run.resume-authorized",
      task_id: taskId,
      run_id: task.runId,
      unblock_event_id: unblock.event_id,
      kernel_revision: resumed.event.revision,
      kernel_event_id: resumed.event.id,
    });

    const owner: TaskKernelRunDispatchOwnerV1 = {
      host: "pi",
      role: "implement",
      sessionId: null,
      threadId: null,
      hostId: null,
    };
    const afterResumeSchedule = scheduleTaskKernelGraph(root, [taskId]);
    expect(
      admit(
        root,
        afterResumeSchedule.receipt.receiptFingerprint,
        taskId,
        task.runId,
        owner,
      ).permitted,
    ).toBe(true);
  });

  it("denies a direct Core Resume after unblock without the causal authorization event", () => {
    const root = makeRoot();
    const taskId = "v2-coordination-direct-resume";
    const task = createTask(root, taskId);
    const beforeUnblock = readTaskKernel({ root, taskDir: task.taskDir });
    if (beforeUnblock.kind !== "task-kernel-v2")
      throw new Error("Fixture has no V2 kernel");
    const kernelBarrier = beforeUnblock.kernel.events.at(-1);
    if (!kernelBarrier) throw new Error("Fixture has no Kernel event");
    const coordination = new CoordinationStore(root);
    const block = coordination.blockTask({
      taskId,
      blockId: "coordination-block-direct-resume",
      reason: "Waiting for the response",
      actor: { platform: "user", id: "reviewer" },
      evidenceLevel: "local",
    });
    coordination.unblockTask({
      taskId,
      blockId: block.block_id,
      runId: task.runId,
      kernelRevisionAtUnblock: beforeUnblock.kernel.revision,
      kernelEventIdAtUnblock: kernelBarrier.id,
      reason: "The local decision is recorded",
      actor: { platform: "user", id: "reviewer" },
      evidenceLevel: "local",
    });
    resumeTaskRun({
      root,
      taskDir: task.taskDir,
      expectedRevision: task.revision,
      runId: task.runId,
      actor: "implementer",
      idempotencyKey: "resume:v2-coordination-direct-resume",
    });

    const schedule = scheduleTaskKernelGraph(root, [taskId]);
    const result = admit(
      root,
      schedule.receipt.receiptFingerprint,
      taskId,
      task.runId,
    );
    expect(result).toMatchObject({
      permitted: false,
      receipt: {
        reasonCodes: ["coordination-unblock-resume-authorization-missing"],
        leaseId: null,
      },
    });
    expect(listProjectWriteLeases(root)).toEqual([]);
  });

  it("serializes simultaneous Kernel Resume attempts across Node processes", async () => {
    const root = makeRoot();
    const taskId = "v2-coordination-multiprocess-resume";
    const task = createTask(root, taskId);
    const beforeUnblock = readTaskKernel({ root, taskDir: task.taskDir });
    if (beforeUnblock.kind !== "task-kernel-v2")
      throw new Error("Fixture has no V2 kernel");
    const kernelBarrier = beforeUnblock.kernel.events.at(-1);
    if (!kernelBarrier) throw new Error("Fixture has no Kernel event");
    const coordination = new CoordinationStore(root);
    const block = coordination.blockTask({
      taskId,
      blockId: "coordination-block-multiprocess-resume",
      reason: "Waiting for a response",
      actor: { platform: "user", id: "reviewer" },
      evidenceLevel: "local",
    });
    coordination.unblockTask({
      taskId,
      blockId: block.block_id,
      runId: task.runId,
      kernelRevisionAtUnblock: beforeUnblock.kernel.revision,
      kernelEventIdAtUnblock: kernelBarrier.id,
      reason: "The response has been recorded",
      actor: { platform: "user", id: "reviewer" },
      evidenceLevel: "local",
    });

    const temp = path.join(root, "resume-workers");
    fs.mkdirSync(temp);
    const goFile = path.join(temp, "go");
    const workerFile = path.resolve(
      process.cwd(),
      "test",
      "fixtures",
      "coordination-resume-worker.ts",
    );
    const baseRequest = {
      root,
      taskDir: task.taskDir,
      expectedRevision: task.revision,
      runId: task.runId,
      actor: "implementer",
    } as const;
    const firstReady = path.join(temp, "first.ready");
    const secondReady = path.join(temp, "second.ready");
    const first = spawnResumeWorker({
      workerFile,
      request: {
        ...baseRequest,
        idempotencyKey: "resume:multiprocess:first",
      },
      readyFile: firstReady,
      goFile,
    });
    const second = spawnResumeWorker({
      workerFile,
      request: {
        ...baseRequest,
        idempotencyKey: "resume:multiprocess:second",
      },
      readyFile: secondReady,
      goFile,
    });
    const deadline = Date.now() + 10_000;
    while (
      (!fs.existsSync(firstReady) || !fs.existsSync(secondReady)) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(fs.existsSync(firstReady)).toBe(true);
    expect(fs.existsSync(secondReady)).toBe(true);
    fs.writeFileSync(goFile, "go\n", { flag: "wx" });
    const outcomes = (await Promise.all([first, second])).map(
      (line) =>
        JSON.parse(line) as { ok: boolean; error?: string; revision?: number },
    );

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(1);
    const finalKernel = readTaskKernel({ root, taskDir: task.taskDir });
    if (finalKernel.kind !== "task-kernel-v2")
      throw new Error("Fixture has no final V2 kernel");
    expect(
      finalKernel.kernel.events.filter(
        (event) =>
          event.type === "run.resumed" && event.entityId === task.runId,
      ),
    ).toHaveLength(1);
    expect(
      coordination
        .snapshot()
        .events.filter(
          (event) =>
            event.type === "run.resume-authorized" &&
            event.task_id === taskId &&
            event.run_id === task.runId,
        ),
    ).toHaveLength(1);
  });

  it("keeps a running Run non-dispatchable after its Task is blocked and unblocked", () => {
    const root = makeRoot();
    const taskId = "v2-coordination-running-block-unblock";
    const task = createTask(root, taskId, { state: "running" });
    const beforeUnblock = readTaskKernel({ root, taskDir: task.taskDir });
    if (beforeUnblock.kind !== "task-kernel-v2")
      throw new Error("Fixture has no V2 kernel");
    const kernelBarrier = beforeUnblock.kernel.events.at(-1);
    if (!kernelBarrier) throw new Error("Fixture has no Kernel event");
    const coordination = new CoordinationStore(root);
    const block = coordination.blockTask({
      taskId,
      blockId: "coordination-block-running-run",
      reason: "The active attempt must stop before recovery",
      actor: { platform: "user", id: "reviewer" },
      evidenceLevel: "local",
    });
    coordination.unblockTask({
      taskId,
      blockId: block.block_id,
      runId: task.runId,
      kernelRevisionAtUnblock: beforeUnblock.kernel.revision,
      kernelEventIdAtUnblock: kernelBarrier.id,
      reason: "The decision is recorded; the running attempt needs termination",
      actor: { platform: "user", id: "reviewer" },
      evidenceLevel: "local",
    });
    const schedule = scheduleTaskKernelGraph(root, [taskId]);

    expect(
      admit(root, schedule.receipt.receiptFingerprint, taskId, task.runId),
    ).toMatchObject({
      permitted: false,
      receipt: {
        reasonCodes: ["coordination-running-run-requires-terminal-retry"],
        leaseId: null,
      },
    });
    expect(listProjectWriteLeases(root)).toEqual([]);
  });

  it("does not admit while an unblock postcondition holds the journal lock", async () => {
    const root = makeRoot();
    const taskId = "v2-coordination-unblock-admission-race";
    const task = createTask(root, taskId);
    const schedule = scheduleTaskKernelGraph(root, [taskId]);
    const block = new CoordinationStore(root).blockTask({
      taskId,
      blockId: "coordination-unblock-admission-race-block",
      reason: "Waiting for a current resolution",
      actor: { platform: "user", id: "reviewer" },
      evidenceLevel: "local",
    });
    const workerDir = path.join(root, "unblock-workers");
    fs.mkdirSync(workerDir);
    const readyFile = path.join(workerDir, "unblock-appended");
    const releaseFile = path.join(workerDir, "release");
    const workerFile = path.resolve(
      process.cwd(),
      "test",
      "fixtures",
      "coordination-unblock-postcondition-worker.ts",
    );
    const worker = spawnUnblockWorker({
      workerFile,
      request: { root, taskId, blockId: block.block_id },
      readyFile,
      releaseFile,
    });

    let admission: ReturnType<typeof admit> | null = null;
    let probeError: unknown;
    try {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(readyFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(fs.existsSync(readyFile)).toBe(true);
      expect(new CoordinationStore(root).snapshot().events.at(-1)?.type).toBe(
        "task.unblocked",
      );
      admission = admit(
        root,
        schedule.receipt.receiptFingerprint,
        taskId,
        task.runId,
      );
    } catch (error) {
      probeError = error;
    } finally {
      fs.writeFileSync(releaseFile, "release\n", { flag: "wx" });
    }

    const unblock = JSON.parse(await worker) as {
      ok: boolean;
      error?: string;
    };
    if (probeError) throw probeError;
    expect(admission).toMatchObject({
      permitted: false,
      receipt: {
        reasonCodes: ["coordination-state-unreadable"],
        leaseId: null,
      },
    });
    expect(unblock).toMatchObject({
      ok: false,
      error: "simulated stale unblock",
    });
    expect(new CoordinationStore(root).snapshot().blocked_tasks).toMatchObject([
      { task_id: taskId, blocked_by_task_id: "upstream" },
    ]);
    expect(listProjectWriteLeases(root)).toEqual([]);
  });

  it("rechecks a new block before spawn and leaves the acquired lease intact", () => {
    const root = makeRoot();
    const taskId = "v2-coordination-pre-spawn-race";
    const task = createTask(root, taskId);
    const owner: TaskKernelRunDispatchOwnerV1 = {
      host: "pi",
      role: "implement",
      sessionId: null,
      threadId: null,
      hostId: null,
    };
    const schedule = scheduleTaskKernelGraph(root, [taskId]);
    const permit = admit(
      root,
      schedule.receipt.receiptFingerprint,
      taskId,
      task.runId,
      owner,
    );
    if (!permit.permitted) throw new Error("Fixture admission was rejected");
    const leaseFile = path.join(root, permit.leaseFile);
    const leaseBefore = fs.readFileSync(leaseFile, "utf8");
    new CoordinationStore(root).blockTask({
      taskId,
      blockId: "coordination-block-pre-spawn-race",
      reason: "A block arrived after admission",
      actor: { platform: "user", id: "reviewer" },
      evidenceLevel: "simulated",
    });

    expect(
      assertTaskKernelRunDispatchLeaseV1(root, {
        leaseId: permit.leaseId,
        taskId,
        runId: task.runId,
      }),
    ).toMatchObject({
      asserted: false,
      reasonCode: "coordination-task-blocked",
    });
    let spawnCount = 0;
    const gate = assertTaskKernelRunDispatchPreSpawnV1(root, {
      leaseId: permit.leaseId,
      taskId,
      runId: task.runId,
      scheduleReceiptFingerprint: schedule.receipt.receiptFingerprint,
      owner,
    });
    if (gate.asserted) spawnCount += 1;

    expect(gate).toMatchObject({
      asserted: false,
      reasonCode: "coordination-task-blocked",
      hostBound: null,
    });
    expect(spawnCount).toBe(0);
    expect(fs.readFileSync(leaseFile, "utf8")).toBe(leaseBefore);
    expect(listProjectWriteLeases(root)).toHaveLength(1);
  });

  it("validates the active pre-spawn lease against its admission write set", () => {
    const root = makeRoot();
    const task = createTask(root, "v2-pre-spawn-write-set", {
      state: "running",
      writeSet: ["src/declared.ts"],
    });
    const owner: TaskKernelRunDispatchOwnerV1 = {
      host: "pi",
      role: "implement",
      sessionId: null,
      threadId: null,
      hostId: null,
      contractFingerprint: null,
      startRequestId: null,
      processId: null,
    };
    const schedule = scheduleTaskKernelGraph(root, ["v2-pre-spawn-write-set"]);
    const permit = admit(
      root,
      schedule.receipt.receiptFingerprint,
      "v2-pre-spawn-write-set",
      task.runId,
      owner,
    );
    expect(permit.permitted).toBe(true);
    if (!permit.permitted) return;
    const request = {
      leaseId: permit.leaseId,
      taskId: "v2-pre-spawn-write-set",
      runId: task.runId,
      scheduleReceiptFingerprint: schedule.receipt.receiptFingerprint,
      owner,
    };
    expect(assertTaskKernelRunDispatchPreSpawnV1(root, request)).toMatchObject({
      asserted: true,
      reasonCode: null,
      hostBound: false,
      scheduleReceiptFingerprint: schedule.receipt.receiptFingerprint,
      writeSet: ["src/declared.ts"],
    });
    expect(
      assertTaskKernelRunDispatchPreSpawnV1(root, {
        ...request,
        scheduleReceiptFingerprint: "0".repeat(64),
      }),
    ).toMatchObject({
      asserted: false,
      reasonCode: "schedule-receipt-fingerprint-mismatch",
      hostBound: null,
    });
    expect(
      assertTaskKernelRunDispatchPreSpawnV1(root, {
        ...request,
        owner: { ...owner, hostId: "unexpected-host" },
      }),
    ).toMatchObject({
      asserted: false,
      reasonCode: "dispatch-lease-owner-mismatch",
      hostBound: null,
    });

    const leaseFile = path.join(root, permit.leaseFile);
    const lease = JSON.parse(fs.readFileSync(leaseFile, "utf8")) as {
      touches: string[];
    };
    lease.touches = ["unrelated"];
    fs.writeFileSync(leaseFile, `${JSON.stringify(lease, null, 2)}\n`);
    expect(assertTaskKernelRunDispatchPreSpawnV1(root, request)).toMatchObject({
      asserted: false,
      reasonCode: "dispatch-lease-write-set-mismatch",
      hostBound: null,
    });
  });

  it("accepts the unbound Pi owner before spawn and rejects that gate after Host binding", () => {
    const root = makeRoot();
    const task = createTask(root, "v2-pre-spawn-host-timing", {
      state: "running",
      writeSet: ["src/output.ts"],
    });
    const admissionOwner: TaskKernelRunDispatchOwnerV1 = {
      host: "pi",
      role: "implement",
      sessionId: null,
      threadId: null,
      hostId: null,
      contractFingerprint: null,
      startRequestId: null,
      processId: null,
    };
    const schedule = scheduleTaskKernelGraph(root, [
      "v2-pre-spawn-host-timing",
    ]);
    const permit = admit(
      root,
      schedule.receipt.receiptFingerprint,
      "v2-pre-spawn-host-timing",
      task.runId,
      admissionOwner,
    );
    expect(permit.permitted).toBe(true);
    if (!permit.permitted) return;
    const request = {
      leaseId: permit.leaseId,
      taskId: "v2-pre-spawn-host-timing",
      runId: task.runId,
      scheduleReceiptFingerprint: schedule.receipt.receiptFingerprint,
      owner: admissionOwner,
    };
    expect(assertTaskKernelRunDispatchPreSpawnV1(root, request)).toMatchObject({
      asserted: true,
      hostBound: false,
    });

    bindTaskRunHostReceipt({
      root,
      taskDir: task.taskDir,
      expectedRevision: task.revision,
      runId: task.runId,
      host: {
        host: "pi",
        role: "implement",
        sessionId: "pi-session-after-spawn",
        hostId: null,
        threadId: null,
        requestRefs: ["pi-start-request"],
        eventRefs: ["pi-progress"],
        resultRefs: [],
        assuranceSource: "manager-owned-child-exit",
      },
      actor: "test-pi-bridge",
      idempotencyKey: "bind-host-after-start",
      cwd: root,
    });
    const dispatchOwner: TaskKernelRunDispatchOwnerV1 = {
      ...admissionOwner,
      sessionId: "pi-session-after-spawn",
      startRequestId: "pi-start-request",
      processId: 42,
    };
    expect(
      bindTaskKernelRunDispatchOwnerV1(root, {
        leaseId: permit.leaseId,
        taskId: "v2-pre-spawn-host-timing",
        runId: task.runId,
        owner: dispatchOwner,
      }).bound,
    ).toBe(true);
    expect(assertTaskKernelRunDispatchPreSpawnV1(root, request)).toMatchObject({
      asserted: false,
      hostBound: null,
    });
    expect(
      assertTaskKernelRunDispatchLeaseV1(root, {
        leaseId: permit.leaseId,
        taskId: "v2-pre-spawn-host-timing",
        runId: task.runId,
      }).asserted,
    ).toBe(true);
  });

  it.skipIf(process.platform !== "win32")(
    "rejects NTFS alternate data stream paths without changing ordinary or drive-path rules",
    () => {
      expect(normalizeProjectWriteSet(["src/a.ts"])).toEqual(["src/a.ts"]);
      expect(() => normalizeProjectWriteSet(["src/a.ts:stream"])).toThrow(
        /concrete project-relative paths/,
      );
      expect(() => normalizeProjectWriteSet(["src:stream/a.ts"])).toThrow(
        /concrete project-relative paths/,
      );
      expect(() => normalizeProjectWriteSet(["C:/src/a.ts"])).toThrow(
        /concrete project-relative paths/,
      );
      expect(() => normalizeProjectWriteSet(["C:\\src\\a.ts"])).toThrow(
        /concrete project-relative paths/,
      );
    },
  );

  it.skipIf(process.platform !== "win32")(
    "rejects ADS paths in Task Run declarations and fails closed on durable legacy ADS leases",
    () => {
      const declaredRoot = makeRoot();
      createTask(declaredRoot, "v2-ads-declared", {
        writeSet: ["src/a.ts:stream"],
        host: true,
      });
      expect(() =>
        scheduleTaskKernelGraph(declaredRoot, ["v2-ads-declared"]),
      ).toThrow(/concrete project-relative paths/);

      const leaseRoot = makeRoot();
      const task = createTask(leaseRoot, "v2-ads-lease", {
        writeSet: ["src/a.ts"],
        host: true,
      });
      const schedule = scheduleTaskKernelGraph(leaseRoot, ["v2-ads-lease"]);
      const legacyActive = path.join(
        leaseRoot,
        ".pactile",
        "tasks",
        "legacy-parent",
        "parallel",
        "active",
      );
      fs.mkdirSync(legacyActive, { recursive: true });
      fs.writeFileSync(
        path.join(legacyActive, "legacy-ads.json"),
        `${JSON.stringify({
          id: "legacy-ads",
          pid: process.pid,
          durable: true,
          touches: ["src/a.ts:stream"],
        })}\n`,
      );

      const result = admit(
        leaseRoot,
        schedule.receipt.receiptFingerprint,
        "v2-ads-lease",
        task.runId,
      );
      expect(result).toMatchObject({
        permitted: false,
        receipt: {
          reasonCodes: ["project-active-leases-unreadable"],
          leaseId: null,
        },
      });
    },
  );

  it("persists a replayable Task/Run receipt, honors simulated critical-path planning but rechecks hard dependencies before dispatch", () => {
    const root = makeRoot();
    createTask(root, "v2-priority-short", {
      writeSet: ["src/shared.ts"],
      executionMs: 20_000,
      host: true,
    });
    createTask(root, "v2-priority-critical", {
      writeSet: ["src/shared.ts"],
      executionMs: 40_000,
      host: true,
    });
    createTask(root, "v2-priority-tail", {
      dependencies: ["v2-priority-critical"],
      executionMs: 30_000,
      host: true,
      startRun: false,
    });
    const first = scheduleTaskKernelGraph(root, [
      "v2-priority-short",
      "v2-priority-critical",
      "v2-priority-tail",
    ]);
    const replay = scheduleTaskKernelGraph(root, [
      "v2-priority-short",
      "v2-priority-critical",
      "v2-priority-tail",
    ]);
    expect(first.receipt.plan.waves[0]?.taskIds).toEqual([
      "v2-priority-critical",
    ]);
    expect(replay.created).toBe(false);
    expect(replay.receipt.receiptFingerprint).toBe(
      first.receipt.receiptFingerprint,
    );

    const rootWithOpenDependency = makeRoot();
    const prerequisite = createTask(rootWithOpenDependency, "v2-open-a", {
      host: true,
    });
    const dependent = createTask(rootWithOpenDependency, "v2-open-b", {
      host: true,
    });
    const dependentKernelFile = path.join(dependent.taskDir, "kernel.json");
    const dependentKernel = JSON.parse(
      fs.readFileSync(dependentKernelFile, "utf8"),
    ) as {
      definition: { dependencies: string[] };
    };
    dependentKernel.definition.dependencies = ["v2-open-a"];
    fs.writeFileSync(
      dependentKernelFile,
      `${JSON.stringify(dependentKernel, null, 2)}\n`,
    );
    const simulated = scheduleTaskKernelGraph(rootWithOpenDependency, [
      "v2-open-a",
      "v2-open-b",
    ]);
    expect(
      simulated.receipt.plan.decisions.find(
        (decision) => decision.taskId === "v2-open-b",
      )?.action,
    ).toBe("scheduled");
    expect(simulated.receipt.plan.waves.map((wave) => wave.taskIds)).toEqual([
      ["v2-open-a"],
      ["v2-open-b"],
    ]);
    const denied = admit(
      rootWithOpenDependency,
      simulated.receipt.receiptFingerprint,
      "v2-open-b",
      dependent.runId,
    );
    expect(denied).toMatchObject({
      permitted: false,
      receipt: { reasonCodes: ["hard-dependency-not-closed:v2-open-a"] },
    });
    expect(prerequisite.runId).not.toBe(dependent.runId);
  });

  it("rejects dependent dispatch after a prerequisite Run fails", () => {
    const root = makeRoot();
    const prerequisite = createTask(root, "v2-failed-a", {
      host: true,
      state: "running",
    });
    const dependent = createTask(root, "v2-failed-b", { host: true });
    const failed = recordTaskRunResult({
      root,
      taskDir: prerequisite.taskDir,
      expectedRevision: prerequisite.revision,
      runId: prerequisite.runId,
      outcome: "failed",
      summary: "fixture failure",
      failure: { category: "fixture", message: "failed before close" },
      actor: "implementer",
      idempotencyKey: "fail:v2-failed-a",
    });
    const dependentKernelFile = path.join(dependent.taskDir, "kernel.json");
    const dependentKernel = JSON.parse(
      fs.readFileSync(dependentKernelFile, "utf8"),
    ) as {
      definition: { dependencies: string[] };
    };
    dependentKernel.definition.dependencies = ["v2-failed-a"];
    fs.writeFileSync(
      dependentKernelFile,
      `${JSON.stringify(dependentKernel, null, 2)}\n`,
    );
    const schedule = scheduleTaskKernelGraph(root, [
      "v2-failed-a",
      "v2-failed-b",
    ]);
    const denied = admit(
      root,
      schedule.receipt.receiptFingerprint,
      "v2-failed-b",
      dependent.runId,
    );
    expect(failed.kernel.runs.at(-1)?.state).toBe("failed");
    expect(denied).toMatchObject({
      permitted: false,
      receipt: { reasonCodes: ["task-not-admitted-by-plan"] },
    });
  });

  it("reserves project writes, blocks overlapping Runs, and admits more than 32 disjoint Runs", () => {
    const root = makeRoot();
    const first = createTask(root, "v2-conflict-a", {
      writeSet: ["src/shared.ts"],
      host: true,
    });
    const second = createTask(root, "v2-conflict-b", {
      writeSet: ["src/shared.ts"],
      host: true,
    });
    const schedule = scheduleTaskKernelGraph(root, [
      "v2-conflict-a",
      "v2-conflict-b",
    ]);
    expect(schedule.receipt.plan.waves).toHaveLength(2);
    const firstPermit = admit(
      root,
      schedule.receipt.receiptFingerprint,
      "v2-conflict-a",
      first.runId,
    );
    expect(firstPermit.permitted).toBe(true);
    const blocked = admit(
      root,
      schedule.receipt.receiptFingerprint,
      "v2-conflict-b",
      second.runId,
    );
    expect(blocked).toMatchObject({
      permitted: false,
      receipt: { reasonCodes: ["project-write-set-conflict"] },
    });

    const manyRoot = makeRoot();
    const taskIds = Array.from(
      { length: 40 },
      (_, index) => `v2-unbounded-${index}`,
    );
    const runIds = new Map<string, string>();
    for (const taskId of taskIds)
      runIds.set(taskId, createTask(manyRoot, taskId, { host: true }).runId);
    const manySchedule = scheduleTaskKernelGraph(manyRoot, taskIds);
    expect(manySchedule.receipt.plan.waves[0]?.taskIds).toHaveLength(40);
    const permits = taskIds.map((taskId) =>
      admit(
        manyRoot,
        manySchedule.receipt.receiptFingerprint,
        taskId,
        runIds.get(taskId) ?? "",
      ),
    );
    expect(permits.every((result) => result.permitted)).toBe(true);
  });

  it("rejects direct V2 lease admission for a fingerprint-valid same-wave overlap without an integration owner", () => {
    const root = makeRoot();
    const firstTaskId = "v2-old-owner-a";
    const secondTaskId = "v2-old-owner-b";
    const first = createTask(root, firstTaskId, {
      writeSet: ["src/shared.ts"],
      host: true,
    });
    const second = createTask(root, secondTaskId, {
      writeSet: ["src/shared.ts"],
      host: true,
    });
    const schedule = scheduleTaskKernelGraph(
      root,
      [firstTaskId, secondTaskId],
      {
        conflictParallelizations: [
          {
            taskIds: [firstTaskId, secondTaskId],
            approvedBy: "approver",
            authorizationRef: "approval://old-owner-pair",
            integrationOwner: "parent-integrator",
            integrationPlan: "Review and integrate the shared writer pair.",
          },
        ],
      },
    );
    expect(schedule.receipt.plan.waves[0]?.taskIds).toHaveLength(2);
    const legacyFingerprint = writeLegacyScheduleReceiptWithoutIntegrationOwner(
      root,
      schedule.receipt.receiptFingerprint,
    );
    expect(
      readTaskKernelScheduleReceiptV1(root, legacyFingerprint).integrity,
    ).toBe("fingerprint-verified");

    const firstPermit = admit(
      root,
      legacyFingerprint,
      firstTaskId,
      first.runId,
    );
    expect(firstPermit.permitted).toBe(true);
    const blocked = admit(root, legacyFingerprint, secondTaskId, second.runId);
    expect(blocked).toMatchObject({
      permitted: false,
      receipt: {
        reasonCodes: ["project-write-set-conflict-integration-owner-missing"],
        conflictingLeaseIds: [firstPermit.permitted ? firstPermit.leaseId : ""],
      },
    });
  });

  it("checks every active overlap and rejects the unapproved conflict even when another pair is authorized", () => {
    const root = makeRoot();
    const taskC = createTask(root, "v2-multi-c", {
      writeSet: ["src/b.ts"],
      host: true,
    });
    const cSchedule = scheduleTaskKernelGraph(root, ["v2-multi-c"]);
    const cPermit = admit(
      root,
      cSchedule.receipt.receiptFingerprint,
      "v2-multi-c",
      taskC.runId,
    );
    expect(cPermit.permitted).toBe(true);

    const taskA = createTask(root, "v2-multi-a", {
      writeSet: ["src"],
      executionMs: 100_000,
      host: true,
    });
    const taskB = createTask(root, "v2-multi-b", {
      writeSet: ["src/a.ts"],
      executionMs: 100_000,
      host: true,
    });
    const abSchedule = scheduleTaskKernelGraph(
      root,
      ["v2-multi-a", "v2-multi-b"],
      {
        conflictParallelizations: [
          {
            taskIds: ["v2-multi-a", "v2-multi-b"],
            approvedBy: "approver",
            authorizationRef: "approval://pair-v2-multi-a-b",
            integrationOwner: "parent-integrator",
            integrationPlan: "integrate A then run verification",
          },
        ],
      },
    );
    expect(
      abSchedule.receipt.plan.waves[0]?.conflictAuthorizations,
    ).toHaveLength(1);
    const bPermit = admit(
      root,
      abSchedule.receipt.receiptFingerprint,
      "v2-multi-b",
      taskB.runId,
    );
    expect(bPermit.permitted).toBe(true);
    const aDenied = admit(
      root,
      abSchedule.receipt.receiptFingerprint,
      "v2-multi-a",
      taskA.runId,
    );
    expect(aDenied).toMatchObject({
      permitted: false,
      receipt: {
        reasonCodes: ["project-write-set-conflict"],
        conflictingLeaseIds: [cPermit.permitted ? cPermit.leaseId : ""],
      },
    });
  });

  it("releases only after a fingerprinted native terminal receipt and keeps a lease on proof tampering", () => {
    const root = makeRoot();
    const task = createTask(root, "v2-native-stop", {
      writeSet: ["src/output.txt"],
      host: {
        host: "codex-desktop",
        role: "execute",
        sessionId: null,
        threadId: "thread-v2-native-stop",
        requestRefs: ["request-start-v2-native-stop"],
        eventRefs: ["request-native-terminal"],
        resultRefs: [
          ".pactile/tasks/v2-native-stop/codex-bridge/receipts/request-native-terminal.json",
        ],
        assuranceSource: "desktop-native",
      },
    });
    const owner = runOwner(root, "v2-native-stop");
    const schedule = scheduleTaskKernelGraph(root, ["v2-native-stop"]);
    const permit = admit(
      root,
      schedule.receipt.receiptFingerprint,
      "v2-native-stop",
      task.runId,
      owner,
    );
    expect(permit.permitted).toBe(true);
    if (!permit.permitted) return;
    expect(
      assertTaskKernelRunDispatchLeaseV1(root, {
        leaseId: permit.leaseId,
        taskId: task.runId,
        runId: task.runId,
      }).asserted,
    ).toBe(false);
    expect(
      assertTaskKernelRunDispatchLeaseV1(root, {
        leaseId: permit.leaseId,
        taskId: "wrong-task",
        runId: task.runId,
      }).asserted,
    ).toBe(false);
    const running = resumeTaskRun({
      root,
      taskDir: task.taskDir,
      expectedRevision: task.revision,
      runId: task.runId,
      actor: "implementer",
      idempotencyKey: "resume:v2-native-stop",
    });
    const activeRun = running.kernel.runs.at(-1);
    if (!activeRun) throw new Error("native-stop Run was not resumed");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src", "output.txt"),
      "native child exited\n",
    );
    const observation = observeTaskRunCandidate({
      run: activeRun,
      repositoryRoot: root,
    });
    const outputFile = observation.currentFiles.find(
      (file) => file.path === "src/output.txt",
    );
    if (!outputFile?.sha256)
      throw new Error(
        "native-stop Run output was not observed in its write set",
      );
    const settled = recordTaskRunResult({
      root,
      taskDir: task.taskDir,
      expectedRevision: running.kernel.revision,
      runId: task.runId,
      outcome: "completed",
      summary: "native child exited",
      candidateEntries: [
        { ref: outputFile.path, fingerprint: outputFile.sha256 },
        createTaskCandidateEntry(observation),
      ],
      actor: "implementer",
      idempotencyKey: "complete:v2-native-stop",
    });
    expect(settled.kernel.runs.at(-1)?.state).toBe("completed");
    expect(
      assertTaskKernelRunDispatchLeaseV1(root, {
        leaseId: permit.leaseId,
        taskId: "v2-native-stop",
        runId: task.runId,
        allowSettled: true,
      }).asserted,
    ).toBe(true);
    const stopProof = makeNativeStopProof(root, {
      leaseId: permit.leaseId,
      taskId: "v2-native-stop",
      runId: task.runId,
      scheduleReceiptFingerprint: schedule.receipt.receiptFingerprint,
      admissionReceiptFingerprint: permit.receipt.receiptFingerprint,
      owner,
      disposition: "native-terminal",
    });
    const proofFile = path.join(root, stopProof);
    const proof = JSON.parse(
      fs.readFileSync(proofFile, "utf8"),
    ) as TaskKernelRunDispatchStopProofV1;
    proof.disposition = "not-created";
    fs.writeFileSync(proofFile, `${JSON.stringify(proof, null, 2)}\n`);
    expect(
      validateTaskKernelRunDispatchStopProofV1(root, {
        leaseId: permit.leaseId,
        taskId: "v2-native-stop",
        runId: task.runId,
        stopReceiptRef: stopProof,
      }),
    ).toMatchObject({
      valid: false,
      reasonCode: "dispatch-stop-proof-integrity-failed",
    });
    const rejected = releaseTaskKernelRunDispatchV1(root, {
      leaseId: permit.leaseId,
      taskId: "v2-native-stop",
      runId: task.runId,
      stopReceiptRef: stopProof,
    });
    expect(rejected).toMatchObject({
      released: false,
      reasonCode: "dispatch-stop-proof-integrity-failed",
    });
    expect(fs.existsSync(path.join(root, permit.leaseFile))).toBe(true);
    const validProof = makeNativeStopProof(root, {
      leaseId: permit.leaseId,
      taskId: "v2-native-stop",
      runId: task.runId,
      scheduleReceiptFingerprint: schedule.receipt.receiptFingerprint,
      admissionReceiptFingerprint: permit.receipt.receiptFingerprint,
      owner,
      disposition: "native-terminal",
    });
    expect(
      validateTaskKernelRunDispatchStopProofV1(root, {
        leaseId: permit.leaseId,
        taskId: "v2-native-stop",
        runId: task.runId,
        stopReceiptRef: validProof,
      }),
    ).toMatchObject({ valid: true, reasonCode: null });
    const released = releaseTaskKernelRunDispatchV1(root, {
      leaseId: permit.leaseId,
      taskId: "v2-native-stop",
      runId: task.runId,
      stopReceiptRef: validProof,
    });
    expect(released).toMatchObject({ released: true, reasonCode: null });
  });

  it("accepts explicit not-created proof only while the same Run remains active and unbound", () => {
    const root = makeRoot();
    const task = createTask(root, "v2-not-created");
    const owner: TaskKernelRunDispatchOwnerV1 = {
      host: "codex-desktop",
      role: "execute",
      sessionId: null,
      threadId: null,
      hostId: null,
      contractFingerprint: null,
    };
    const schedule = scheduleTaskKernelGraph(root, ["v2-not-created"]);
    const permit = admit(
      root,
      schedule.receipt.receiptFingerprint,
      "v2-not-created",
      task.runId,
      owner,
    );
    expect(permit.permitted).toBe(true);
    if (!permit.permitted) return;
    const proofRef = makeNativeStopProof(root, {
      leaseId: permit.leaseId,
      taskId: "v2-not-created",
      runId: task.runId,
      scheduleReceiptFingerprint: schedule.receipt.receiptFingerprint,
      admissionReceiptFingerprint: permit.receipt.receiptFingerprint,
      owner,
      disposition: "not-created",
    });
    const released = releaseTaskKernelRunDispatchV1(root, {
      leaseId: permit.leaseId,
      taskId: "v2-not-created",
      runId: task.runId,
      stopReceiptRef: proofRef,
    });
    expect(released).toMatchObject({ released: true, reasonCode: null });
  });

  it("validates Pi manager-owned process exit and rejects an unverifiable child stop", () => {
    const root = makeRoot();
    const taskId = "v2-pi-stop";
    const startRequestId = "pi-start-v2-pi-stop";
    const taskDir = path.join(root, ".pactile", "tasks", taskId);
    const runRef = `.pactile/tasks/${taskId}/pi-bridge/runs/pi-run-${taskId}.json`;
    const progressRef = `.pactile/tasks/${taskId}/pi-bridge/events/pi-run-${taskId}.jsonl`;
    const task = createTask(root, taskId, {
      host: {
        host: "pi",
        role: "implement",
        sessionId: "pi-session-v2-pi-stop",
        threadId: null,
        requestRefs: [startRequestId],
        eventRefs: [progressRef, `settle-pi-run-${taskId}`],
        resultRefs: [runRef],
        assuranceSource: "manager-owned-child-exit",
      },
    });
    const owner: TaskKernelRunDispatchOwnerV1 = {
      host: "pi",
      role: "implement",
      sessionId: "pi-session-v2-pi-stop",
      threadId: null,
      hostId: null,
      contractFingerprint: runOwner(root, taskId).contractFingerprint,
      startRequestId,
      processId: 32145,
    };
    const schedule = scheduleTaskKernelGraph(root, [taskId]);
    const permit = admit(
      root,
      schedule.receipt.receiptFingerprint,
      taskId,
      task.runId,
      owner,
    );
    expect(permit.permitted).toBe(true);
    if (!permit.permitted) return;

    const unverified = makePiStopProof(root, {
      leaseId: permit.leaseId,
      taskId,
      runId: task.runId,
      scheduleReceiptFingerprint: schedule.receipt.receiptFingerprint,
      admissionReceiptFingerprint: permit.receipt.receiptFingerprint,
      owner,
      terminationVerified: false,
    });
    expect(
      validateTaskKernelRunDispatchStopProofV1(root, {
        leaseId: permit.leaseId,
        taskId,
        runId: task.runId,
        stopReceiptRef: unverified,
      }),
    ).toMatchObject({
      valid: false,
      reasonCode: "dispatch-stop-proof-pi-identity-mismatch",
    });

    const valid = makePiStopProof(root, {
      leaseId: permit.leaseId,
      taskId,
      runId: task.runId,
      scheduleReceiptFingerprint: schedule.receipt.receiptFingerprint,
      admissionReceiptFingerprint: permit.receipt.receiptFingerprint,
      owner,
    });
    expect(
      validateTaskKernelRunDispatchStopProofV1(root, {
        leaseId: permit.leaseId,
        taskId,
        runId: task.runId,
        stopReceiptRef: valid,
      }),
    ).toMatchObject({ valid: true, reasonCode: null });
    expect(
      releaseTaskKernelRunDispatchV1(root, {
        leaseId: permit.leaseId,
        taskId,
        runId: task.runId,
        stopReceiptRef: valid,
      }),
    ).toMatchObject({ released: true, reasonCode: null });
    expect(fs.existsSync(taskDir)).toBe(true);
  });
});
