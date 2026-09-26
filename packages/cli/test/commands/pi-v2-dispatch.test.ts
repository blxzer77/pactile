import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTaskKernel,
  bindTaskRunWorkspace,
  readTaskKernel,
  recordTaskRunResult,
  startTaskRun,
} from "../../src/core/task/index.js";
import {
  acquireTaskKernelRunDispatchV1,
  assertTaskKernelRunDispatchLeaseV1,
  scheduleTaskKernelGraph,
} from "../../src/pactile/scheduler/index.js";
import * as taskKernel from "../../src/core/task/index.js";
import * as scheduler from "../../src/pactile/scheduler/index.js";
import { createTaskRunWorktree } from "../../src/pactile/worktree/index.js";
import { PiTaskBridge, readPiHostStopReceipt } from "../../src/pactile/pi/bridge.js";
import { PiRpcClient } from "../../src/pactile/pi/rpc.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface V2TaskFixture {
  taskId: string;
  taskDir: string;
  runId: string | null;
}

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-pi-v2-dispatch-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Pactile Test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "pactile@example.invalid"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "Pi V2 dispatch fixture\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  execFileSync("git", ["add", "README.md", ".gitignore"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "fixture base"], { cwd: root, stdio: "ignore" });
  fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function createTask(
  root: string,
  taskId: string,
  options: { dependencies?: string[]; writeSet?: string[]; start?: boolean } = {},
): V2TaskFixture {
  const taskDir = path.join(root, ".pactile", "tasks", `09-26-${taskId}`);
  fs.mkdirSync(taskDir, { recursive: true });
  const created = createTaskKernel({
    root,
    taskDir,
    definition: {
      taskId,
      title: `Pi V2 ${taskId}`,
      description: "V2 Pi dispatch fixture",
      deliverable: "A bounded implementation result",
      deliveryLevel: "local-result",
      acceptanceCriteria: [{ id: "AC-1", description: "A result is recorded" }],
      dependencies: options.dependencies ?? [],
    },
    actor: "test-author",
    idempotencyKey: `create:${taskId}`,
  });
  if (options.start === false) return { taskId, taskDir, runId: null };
  const started = startTaskRun({
    root,
    taskDir,
    expectedRevision: created.kernel.revision,
    actor: "test-approver",
    idempotencyKey: `start:${taskId}`,
    input: { summary: "Implement the declared result", references: [] },
    authorization: {
      approvedBy: "test-approver",
      approvedAt: "2026-09-26T00:00:00.000Z",
      scope: "src",
      evidenceRef: "approval.md",
    },
    writeSetSnapshot: options.writeSet ?? ["src"],
  });
  return { taskId, taskDir, runId: started.kernel.runs.at(-1)?.id ?? null };
}

function attachManagedWorktree(root: string, task: V2TaskFixture): string {
  if (!task.runId) throw new Error("V2 Run is missing");
  const created = createTaskRunWorktree({
    repoRoot: root,
    taskDir: task.taskDir,
    runId: task.runId,
    branch: `feat/${task.taskId}`,
    baseRef: git(root, "rev-parse", "HEAD"),
    actor: "test-worktree-manager",
    idempotencyKey: `worktree:${task.taskId}`,
  });
  return created.binding.canonicalPath;
}

function piScript(root: string, marker: string, hang = false): string {
  const script = path.join(root, "fake-pi-v2.mjs");
  const markerLiteral = JSON.stringify(marker);
  fs.writeFileSync(script, `
import fs from 'node:fs';
import path from 'node:path';
fs.writeFileSync(${markerLiteral}, 'started');
const session = path.join(process.env.PI_CODING_AGENT_SESSION_DIR, 'v2-session.jsonl');
fs.mkdirSync(path.dirname(session), { recursive: true });
fs.writeFileSync(session, 'session\\n');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk.toString();
  let at;
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    const reply = data => process.stdout.write(JSON.stringify({ id: request.id, type: 'response', command: request.type, success: true, ...data }) + '\\n');
    if (request.type === 'get_state') reply({ data: { isStreaming: false, sessionId: 'pi-session-v2', sessionFile: session } });
    else if (request.type === 'prompt') {
      reply();
      process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\\n');
      ${hang ? "" : "process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'V2 result recorded' }], stopReason: 'stop' }] }) + '\\n');"}
    } else if (request.type === 'abort') reply();
  }
});
process.stdin.on('end', () => process.exit(0));
`);
  return script;
}

function ownerForAdmission() {
  return {
    host: "pi",
    role: "implement",
    sessionId: null,
    threadId: null,
    hostId: null,
    startRequestId: null,
    processId: null,
  };
}

function leaseForTask(root: string, task: V2TaskFixture): string {
  if (!task.runId) throw new Error("task run is missing");
  const schedule = scheduleTaskKernelGraph(root, [task.taskId]);
  const admission = acquireTaskKernelRunDispatchV1(root, {
    scheduleReceiptFingerprint: schedule.receipt.receiptFingerprint,
    taskId: task.taskId,
    runId: task.runId,
    owner: ownerForAdmission(),
  });
  if (!admission.permitted) throw new Error(`fixture admission rejected: ${admission.receipt.reasonCodes.join(",")}`);
  return admission.leaseId;
}

describe("Pi V2 dispatch admission and host stop", () => {
  it("admits a dated TaskDir Run, binds Pi after start, then releases only on verified close", async () => {
    const root = makeRoot();
    const task = createTask(root, "dated-pi-task");
    if (!task.runId) throw new Error("V2 Run is missing");
    attachManagedWorktree(root, task);
    const marker = path.join(root, "pi-started.txt");
    const bridge = new PiTaskBridge(root, { command: process.execPath, args: [piScript(root, marker)] });
    const record = await bridge.run({
      root,
      task: task.taskId,
      runId: task.runId,
      role: "implement",
      prompt: "Implement the V2 fixture.",
      timeoutMs: 5_000,
    });
    const kernel = readTaskKernel({ root, taskDir: task.taskDir, cwd: root });
    if (kernel.kind !== "task-kernel-v2") throw new Error("V2 Kernel is missing");
    const run = kernel.kernel.runs.at(-1);
    expect(record).toMatchObject({
      schema_version: 2,
      outcome: "settled",
      task_id: task.taskId,
      task_run_id: task.runId,
      task_host_id: "pi",
      dispatch_lease_released: true,
    });
    expect(fs.existsSync(marker)).toBe(true);
    expect(run).toMatchObject({ state: "running", candidateSnapshot: null, result: null });
    expect(run?.host).toMatchObject({
      host: "pi",
      role: "implement",
      sessionId: "pi-session-v2",
      assuranceSource: "manager-owned-child-exit",
    });
    expect(run?.host?.requestRefs).toContain(record.start_request_id);
    expect(run?.host?.eventRefs).toContain(record.settle_receipt_id);
    expect(run?.host?.resultRefs).toContain(`pi-bridge/runs/${record.run_id}.json`);
    expect(record.process_stop_receipt?.processExit.terminationVerified).toBe(true);
    expect(record.dispatch_stop_proof_ref).toMatch(/^pi-bridge\/dispatch-proofs\/[a-f0-9]+\.json$/u);
    expect(readPiHostStopReceipt(root, task.taskId, task.runId)).toMatchObject({
      taskId: task.taskId,
      taskRunId: task.runId,
      terminal: "exited",
      assurance: "manager-owned-child-exit",
    });
    expect(assertTaskKernelRunDispatchLeaseV1(root, {
      leaseId: record.dispatch_lease_id as string,
      taskId: task.taskId,
      runId: task.runId,
    })).toMatchObject({ asserted: false, reasonCode: "dispatch-lease-not-active" });
    await bridge.close();
  });

  it("refuses a Git project-root Run without a manager-owned workspace", async () => {
    const root = makeRoot();
    const task = createTask(root, "missing-managed-workspace");
    const marker = path.join(root, "must-not-start.txt");
    const bridge = new PiTaskBridge(root, { command: process.execPath, args: [piScript(root, marker)] });
    await expect(bridge.run({
      root,
      task: task.taskId,
      runId: task.runId as string,
      role: "implement",
      prompt: "A project-root Run is not a managed isolated workspace.",
      timeoutMs: 5_000,
    })).rejects.toThrow("P38-managed or approved-adopted Run worktree");
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(task.taskDir, "pi-bridge"))).toBe(false);
    await bridge.close();
  });

  it("refuses an unregistered foreign Git repository under the worktree directory", async () => {
    const root = makeRoot();
    const task = createTask(root, "foreign-worktree");
    if (!task.runId) throw new Error("V2 Run is missing");
    const foreign = path.join(root, ".pactile", "worktrees", "foreign");
    fs.mkdirSync(path.join(foreign, "src"), { recursive: true });
    git(foreign, "init", "-q", "-b", "main");
    git(foreign, "config", "user.name", "Foreign Repository");
    git(foreign, "config", "user.email", "foreign@example.invalid");
    fs.writeFileSync(path.join(foreign, "src", "foreign.ts"), "export const foreign = true;\n");
    git(foreign, "add", "src/foreign.ts");
    git(foreign, "commit", "-q", "-m", "foreign base");
    const read = readTaskKernel({ root, taskDir: task.taskDir, cwd: root });
    if (read.kind !== "task-kernel-v2") throw new Error("V2 Kernel is missing");
    const manager = {
      version: 1 as const,
      credentialId: "forged-manager-record",
      projectRoot: root,
      commonDir: git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      gitDir: git(foreign, "rev-parse", "--absolute-git-dir"),
      source: "created" as const,
      recordedAt: "2026-09-26T00:00:00.000Z",
    };
    bindTaskRunWorkspace({
      root,
      taskDir: task.taskDir,
      expectedRevision: read.kernel.revision,
      runId: task.runId,
      workspace: {
        ownerRunId: task.runId,
        canonicalPath: fs.realpathSync(foreign),
        branch: "main",
        baseSha: git(foreign, "rev-parse", "HEAD"),
        writeSet: ["src"],
        integrationState: "not-integrated",
        reclamationState: "not-requested",
        manager,
        integrationReceipt: null,
        cleanupLease: null,
      },
      actor: "test-forger",
      idempotencyKey: "bind-foreign-worktree",
      cwd: root,
    });
    const marker = path.join(root, "must-not-start.txt");
    const bridge = new PiTaskBridge(root, { command: process.execPath, args: [piScript(root, marker)] });
    await expect(bridge.run({
      root,
      task: task.taskId,
      runId: task.runId,
      role: "implement",
      prompt: "A foreign repository is not a manager worktree.",
      timeoutMs: 5_000,
    })).rejects.toThrow(/manager-verified base checkout/u);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(task.taskDir, "pi-bridge"))).toBe(false);
    await bridge.close();
  });

  it("rechecks managed worktree provenance immediately before process start", async () => {
    const root = makeRoot();
    const task = createTask(root, "workspace-race", { writeSet: ["src/shared.ts"] });
    if (!task.runId) throw new Error("V2 Run is missing");
    const worktree = attachManagedWorktree(root, task);
    const contender = createTask(root, "workspace-race-contender", { writeSet: ["src/shared.ts"] });
    const marker = path.join(root, "must-not-start.txt");
    const bridge = new PiTaskBridge(root, { command: process.execPath, args: [piScript(root, marker)] });
    const evidenceDir = path.join(task.taskDir, "pi-bridge");
    const mkdir = fs.mkdirSync;
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation((...args) => {
      const result = mkdir(...args);
      if (path.resolve(String(args[0])) === evidenceDir) {
        git(worktree, "checkout", "--detach", "HEAD");
      }
      return result;
    });
    try {
      const record = await bridge.run({
        root,
        task: task.taskId,
        runId: task.runId,
        role: "implement",
        prompt: "A worktree change after admission must stop dispatch before spawn.",
        timeoutMs: 5_000,
      });
      expect(record.outcome).toBe("failed");
      expect(record.reason).toMatch(/manager-verified base checkout/u);
      expect(record.dispatch_lease_released).toBe(false);
      expect(record.process_stop_receipt).toBeNull();
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.existsSync(path.join(task.taskDir, "pi-bridge", "runs", `${record.run_id}.json`))).toBe(true);
      const contenderSchedule = scheduleTaskKernelGraph(root, [contender.taskId]);
      const denied = acquireTaskKernelRunDispatchV1(root, {
        scheduleReceiptFingerprint: contenderSchedule.receipt.receiptFingerprint,
        taskId: contender.taskId,
        runId: contender.runId as string,
        owner: ownerForAdmission(),
      });
      expect(denied.permitted).toBe(false);
      if (!denied.permitted) expect(denied.receipt.reasonCodes).toContain("project-write-set-conflict");
    } finally {
      mkdirSpy.mockRestore();
      await bridge.close();
    }
  });

  it("does not start Pi without a latest Run, even when a hard dependency is open", async () => {
    const root = makeRoot();
    createTask(root, "open-dependency", { start: false });
    const target = createTask(root, "blocked-pi-task", { dependencies: ["open-dependency"], start: false });
    const marker = path.join(root, "must-not-start.txt");
    const bridge = new PiTaskBridge(root, { command: process.execPath, args: [piScript(root, marker)] });
    await expect(bridge.run({
      root,
      task: target.taskId,
      runId: "missing-run",
      role: "implement",
      prompt: "Do not run without the dependency.",
      timeoutMs: 5_000,
    })).rejects.toThrow("latest Task Run");
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(target.taskDir, "pi-bridge"))).toBe(false);
  });

  it("does not start Pi when another active lease overlaps the Run write set", async () => {
    const root = makeRoot();
    const competing = createTask(root, "competing-writer", { writeSet: ["src/shared.ts"] });
    const target = createTask(root, "target-writer", { writeSet: ["src/shared.ts"] });
    leaseForTask(root, competing);
    attachManagedWorktree(root, target);
    const marker = path.join(root, "must-not-start.txt");
    const bridge = new PiTaskBridge(root, { command: process.execPath, args: [piScript(root, marker)] });
    await expect(bridge.run({
      root,
      task: target.taskId,
      runId: target.runId as string,
      role: "implement",
      prompt: "The overlapping write lease must block Pi.",
      timeoutMs: 5_000,
    })).rejects.toThrow(/project-write-set-conflict/u);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(target.taskDir, "pi-bridge"))).toBe(false);
  });

  it("keeps the lease when Pi start is uncertain and there is no terminal receipt", async () => {
    const root = makeRoot();
    const task = createTask(root, "uncertain-start");
    if (!task.runId) throw new Error("V2 Run is missing");
    attachManagedWorktree(root, task);
    const bridge = new PiTaskBridge(root, { command: path.join(root, "missing-pi-command.exe"), args: [] });
    const record = await bridge.run({
      root,
      task: task.taskId,
      runId: task.runId,
      role: "implement",
      prompt: "Start may fail before identity is observed.",
      timeoutMs: 5_000,
    });
    expect(record.dispatch_lease_released).toBe(false);
    expect(record.process_stop_receipt).toBeNull();
    const contender = createTask(root, "writer-after-unknown", { writeSet: ["src"] });
    const contenderSchedule = scheduleTaskKernelGraph(root, [contender.taskId]);
    const contention = acquireTaskKernelRunDispatchV1(root, {
      scheduleReceiptFingerprint: contenderSchedule.receipt.receiptFingerprint,
      taskId: contender.taskId,
      runId: contender.runId as string,
      owner: ownerForAdmission(),
    });
    expect(contention.permitted).toBe(false);
    if (!contention.permitted) expect(contention.receipt.reasonCodes).toContain("project-write-set-conflict");
    await bridge.close();
  });

  it("retains the lease when the Kernel host binding fails after Pi starts", async () => {
    const root = makeRoot();
    const task = createTask(root, "host-bind-failure", { writeSet: ["src/shared.ts"] });
    if (!task.runId) throw new Error("V2 Run is missing");
    attachManagedWorktree(root, task);
    const marker = path.join(root, "pi-started.txt");
    const bridge = new PiTaskBridge(root, { command: process.execPath, args: [piScript(root, marker)] });
    const bindSpy = vi.spyOn(taskKernel, "bindTaskRunHostReceipt").mockImplementation(() => {
      throw new Error("injected host binding failure");
    });
    try {
      const record = await bridge.run({
        root,
        task: task.taskId,
        runId: task.runId,
        role: "implement",
        prompt: "Host binding will fail after process start.",
        timeoutMs: 5_000,
      });
      expect(fs.existsSync(marker)).toBe(true);
      expect(record.outcome).toBe("failed");
      expect(record.process_stop_receipt?.processExit.terminationVerified).toBe(true);
      expect(record.dispatch_lease_released).toBe(false);
      const contender = createTask(root, "host-bind-conflict", { writeSet: ["src/shared.ts"] });
      const contenderSchedule = scheduleTaskKernelGraph(root, [contender.taskId]);
      const contention = acquireTaskKernelRunDispatchV1(root, {
        scheduleReceiptFingerprint: contenderSchedule.receipt.receiptFingerprint,
        taskId: contender.taskId,
        runId: contender.runId as string,
        owner: ownerForAdmission(),
      });
      expect(contention.permitted).toBe(false);
      if (!contention.permitted) expect(contention.receipt.reasonCodes).toContain("project-write-set-conflict");
    } finally {
      bindSpy.mockRestore();
      await bridge.close();
    }
  });

  it("retains the lease when dispatch owner binding fails after Kernel host binding", async () => {
    const root = makeRoot();
    const task = createTask(root, "owner-bind-failure", { writeSet: ["src/shared.ts"] });
    if (!task.runId) throw new Error("V2 Run is missing");
    attachManagedWorktree(root, task);
    const marker = path.join(root, "pi-started.txt");
    const bridge = new PiTaskBridge(root, { command: process.execPath, args: [piScript(root, marker)] });
    const bindSpy = vi.spyOn(scheduler, "bindTaskKernelRunDispatchOwnerV1").mockImplementation(() => {
      throw new Error("injected dispatch owner binding failure");
    });
    try {
      const record = await bridge.run({
        root,
        task: task.taskId,
        runId: task.runId,
        role: "implement",
        prompt: "Dispatch owner binding will fail after host binding.",
        timeoutMs: 5_000,
      });
      expect(fs.existsSync(marker)).toBe(true);
      expect(record.outcome).toBe("failed");
      expect(record.process_stop_receipt?.processExit.terminationVerified).toBe(true);
      expect(record.dispatch_lease_released).toBe(false);
      const contender = createTask(root, "owner-bind-conflict", { writeSet: ["src/shared.ts"] });
      const contenderSchedule = scheduleTaskKernelGraph(root, [contender.taskId]);
      const contention = acquireTaskKernelRunDispatchV1(root, {
        scheduleReceiptFingerprint: contenderSchedule.receipt.receiptFingerprint,
        taskId: contender.taskId,
        runId: contender.runId as string,
        owner: ownerForAdmission(),
      });
      expect(contention.permitted).toBe(false);
      if (!contention.permitted) expect(contention.receipt.reasonCodes).toContain("project-write-set-conflict");
    } finally {
      bindSpy.mockRestore();
      await bridge.close();
    }
  });

  it("settles cancellation and timeout only after stopping the manager-owned child", async () => {
    const root = makeRoot();
    const cancelledTask = createTask(root, "cancelled-run");
    if (!cancelledTask.runId) throw new Error("V2 Run is missing");
    attachManagedWorktree(root, cancelledTask);
    const cancelMarker = path.join(root, "cancel-started.txt");
    const cancelBridge = new PiTaskBridge(root, { command: process.execPath, args: [piScript(root, cancelMarker, true)] });
    const controller = new AbortController();
    const cancelRun = cancelBridge.run({
      root,
      task: cancelledTask.taskId,
      runId: cancelledTask.runId,
      role: "implement",
      prompt: "Cancellation must still stop the child before lease release.",
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    const deadline = Date.now() + 3_000;
    while (!fs.existsSync(cancelMarker) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    const cancelled = await cancelRun;
    expect(cancelled.outcome).toBe("cancelled");
    expect(cancelled.process_stop_receipt?.terminal).toBe("cancelled");
    expect(cancelled.process_stop_receipt?.processExit.terminationVerified).toBe(true);
    expect(cancelled.dispatch_lease_released).toBe(true);
    await cancelBridge.close();

    const timedOutTask = createTask(root, "timed-out-run");
    if (!timedOutTask.runId) throw new Error("V2 Run is missing");
    attachManagedWorktree(root, timedOutTask);
    const timeoutMarker = path.join(root, "timeout-started.txt");
    const timeoutBridge = new PiTaskBridge(root, { command: process.execPath, args: [piScript(root, timeoutMarker, true)] });
    const timedOut = await timeoutBridge.run({
      root,
      task: timedOutTask.taskId,
      runId: timedOutTask.runId,
      role: "implement",
      prompt: "Timeout must still stop the child before lease release.",
      timeoutMs: 1_000,
    });
    expect(fs.existsSync(timeoutMarker)).toBe(true);
    expect(timedOut.outcome).toBe("timed_out");
    expect(timedOut.process_stop_receipt?.processExit.terminationVerified).toBe(true);
    expect(timedOut.dispatch_lease_released).toBe(true);
    await timeoutBridge.close();
  });

  it("keeps the lease when a terminal close receipt is not observed", async () => {
    const root = makeRoot();
    const task = createTask(root, "unknown-stop");
    if (!task.runId) throw new Error("V2 Run is missing");
    attachManagedWorktree(root, task);
    const marker = path.join(root, "pi-started.txt");
    const bridge = new PiTaskBridge(root, { command: process.execPath, args: [piScript(root, marker)] });
    const closeSpy = vi.spyOn(PiRpcClient.prototype, "closeAndObserve").mockResolvedValue({
      processId: 12345,
      stopRequestedAt: new Date().toISOString(),
      killRequestedAt: null,
      exitObservedAt: null,
      exitCode: null,
      signalCode: null,
      terminationVerified: false,
    });
    try {
      const record = await bridge.run({
        root,
        task: task.taskId,
        runId: task.runId,
        role: "implement",
        prompt: "The completion event does not prove process exit.",
        timeoutMs: 5_000,
      });
      expect(record.outcome).toBe("settled");
      expect(record.dispatch_lease_released).toBe(false);
      expect(record.process_stop_receipt).toBeNull();
      expect(assertTaskKernelRunDispatchLeaseV1(root, {
        leaseId: record.dispatch_lease_id as string,
        taskId: task.taskId,
        runId: task.runId,
      }).asserted).toBe(true);
    } finally {
      closeSpy.mockRestore();
      await bridge.close();
    }
  });

  it("rejects a wrong Run ID and a completed candidate before Pi starts", async () => {
    const root = makeRoot();
    const task = createTask(root, "wrong-run-id");
    if (!task.runId) throw new Error("V2 Run is missing");
    attachManagedWorktree(root, task);
    const marker = path.join(root, "must-not-start.txt");
    const launch = { command: process.execPath, args: [piScript(root, marker)] };
    const wrong = new PiTaskBridge(root, launch);
    await expect(wrong.run({
      root,
      task: task.taskId,
      runId: "wrong-run",
      role: "implement",
      prompt: "A mismatched run is not dispatchable.",
      timeoutMs: 5_000,
    })).rejects.toThrow(/latest Task Run/u);
    expect(fs.existsSync(marker)).toBe(false);

    const read = readTaskKernel({ root, taskDir: task.taskDir, cwd: root });
    if (read.kind !== "task-kernel-v2") throw new Error("V2 Kernel is missing");
    recordTaskRunResult({
      root,
      taskDir: task.taskDir,
      expectedRevision: read.kernel.revision,
      runId: task.runId,
      outcome: "completed",
      summary: "Candidate already recorded",
      candidateEntries: [{ ref: "src/result.ts", fingerprint: "a".repeat(64) }],
      evidenceRefs: [],
      actor: "test-runner",
      idempotencyKey: "complete:wrong-run-id",
    });
    const completed = new PiTaskBridge(root, launch);
    await expect(completed.run({
      root,
      task: task.taskId,
      runId: task.runId,
      role: "implement",
      prompt: "A completed candidate cannot start another writer.",
      timeoutMs: 5_000,
    })).rejects.toThrow("Pi V2 Run is not dispatchable: completed");
    expect(fs.existsSync(marker)).toBe(false);
  });
});
