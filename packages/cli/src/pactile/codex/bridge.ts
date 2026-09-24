import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readKernel } from "../../core/task/index.js";
import { resolveTaskDir } from "../task/session.js";
import { approvedTask } from "../pi/bridge.js";
import { parallelChild, releaseParallelChild, reserveParallelChild } from "../parallel/policy.js";

export type CodexBridgeTool = "create_thread" | "send_message_to_thread" | "wait_threads" | "read_thread";
export type CodexBridgeRole = "plan" | "review" | "execute";

export interface CodexBridgeRequest {
  schema_version: 1;
  request_id: string;
  task: string;
  kernel_revision: number;
  created_at: string;
  tool: CodexBridgeTool;
  role: CodexBridgeRole;
  thread_id: string | null;
  host_id: string | null;
  arguments: Record<string, unknown>;
  prompt_sha256: string | null;
}

export interface CodexBridgeReceipt {
  schema_version: 1;
  request_id: string;
  tool: CodexBridgeTool;
  outcome: "ok" | "failed" | "queued";
  thread_id: string | null;
  client_thread_id: string | null;
  host_id: string | null;
  status: string | null;
  cursor: string | null;
  reason: string | null;
  kernel_revision_at_receipt: number;
  contract_stale: boolean;
  recorded_at: string;
  assurance: "host-reported";
}

export interface PendingCodexRequest {
  request_id: string;
  tool: CodexBridgeTool;
  role: CodexBridgeRole;
  thread_id: string | null;
  kernel_revision: number;
  created_at: string;
  prompt_sha256: string | null;
}

interface BoundThread {
  threadId: string;
  hostId: string;
  role: CodexBridgeRole;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function taskContext(root: string, reference: string): { dir: string; task: string; phase: string; revision: number } {
  const dir = resolveTaskDir(root, reference);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Task not found: ${reference}`);
  const { kernel } = readKernel({ taskDir: dir, cwd: root });
  if (!kernel.projection) throw new Error("Task has no canonical Kernel projection");
  return { dir, task: path.relative(root, dir).replaceAll("\\", "/"), phase: kernel.phase, revision: kernel.revision };
}

function archivedTaskContext(root: string, reference: string): { dir: string; task: string; phase: string; revision: number } {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(reference)) throw new Error("Archived task reference must be a task name or id");
  const archive = path.join(root, ".pactile", "tasks", "archive");
  if (!fs.statSync(archive, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Task not found: ${reference}`);
  const matches = fs.readdirSync(archive, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name))
    .flatMap((entry) => fs.readdirSync(path.join(archive, entry.name), { withFileTypes: true })
      .filter((task) => task.isDirectory() && (task.name === reference || task.name.endsWith(`-${reference}`)))
      .map((task) => path.join(archive, entry.name, task.name)));
  if (matches.length !== 1) throw new Error(matches.length ? `Archived task reference is ambiguous: ${reference}` : `Task not found: ${reference}`);
  const dir = matches[0];
  const realArchive = fs.realpathSync(archive);
  const relative = path.relative(realArchive, fs.realpathSync(dir));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Archived task resolves outside the task archive");
  const { kernel } = readKernel({ taskDir: dir, cwd: root });
  return { dir, task: path.relative(root, dir).replaceAll("\\", "/"), phase: kernel.phase, revision: kernel.revision };
}

function bridgeDir(dir: string): string { return path.join(dir, "codex-bridge"); }
function requestFile(dir: string, id: string): string { return path.join(bridgeDir(dir), "requests", `${id}.json`); }
function receiptFile(dir: string, id: string): string { return path.join(bridgeDir(dir), "receipts", `${id}.json`); }
function queuedFile(dir: string, id: string): string { return path.join(bridgeDir(dir), "queued", `${id}.json`); }

function writeNew(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function readJson(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid JSON object: ${file}`);
  return value as Record<string, unknown>;
}

function requests(dir: string): CodexBridgeRequest[] {
  const folder = path.join(bridgeDir(dir), "requests");
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter((file) => uuidPattern.test(file.replace(/\.json$/, "")) && file.endsWith(".json"))
    .map((file) => readJson(path.join(folder, file)) as unknown as CodexBridgeRequest)
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.request_id.localeCompare(right.request_id));
}

function boundThreads(dir: string): Map<string, BoundThread> {
  const bound = new Map<string, BoundThread>();
  for (const request of requests(dir)) {
    if (request.tool !== "create_thread") continue;
    const file = receiptFile(dir, request.request_id);
    if (!fs.existsSync(file)) continue;
    const receipt = readJson(file);
    if (receipt.outcome === "ok" && typeof receipt.thread_id === "string" && typeof receipt.host_id === "string") {
      bound.set(receipt.thread_id, { threadId: receipt.thread_id, hostId: receipt.host_id, role: request.role });
    }
  }
  return bound;
}

function latestWaitCursor(dir: string, threadId: string): string | null {
  const waits = requests(dir).filter((request) => request.tool === "wait_threads" && request.thread_id === threadId);
  for (const request of waits.reverse()) {
    const file = receiptFile(dir, request.request_id);
    if (!fs.existsSync(file)) continue;
    const receipt = readJson(file);
    if (receipt.outcome === "ok" && typeof receipt.cursor === "string") return receipt.cursor;
  }
  return null;
}

function checkPhase(role: CodexBridgeRole, phase: string): void {
  if (role === "plan" && !["open", "define", "approve"].includes(phase)) throw new Error(`Codex planning requires an open/define/approve task; got ${phase}`);
  if (role === "review" && !["verify", "integrate"].includes(phase)) throw new Error(`Codex review requires a verify/integrate task; got ${phase}`);
  if (role === "execute" && phase !== "execute") throw new Error(`Codex execution requires an approved Execute task; got ${phase}`);
}

function textFile(file: string): string {
  const content = fs.readFileSync(file, "utf8").trim();
  if (!content || content.length > 64 * 1024) throw new Error("Prompt file must contain 1 to 65536 characters");
  return content;
}

function roleBoundary(role: CodexBridgeRole): string {
  if (role === "plan") return "Planning may update Pactile planning artifacts, but must not edit product code or approve Execute.";
  if (role === "review") return "Review is read-only: inspect the change set and evidence, report findings, and do not alter code or declare acceptance.";
  return "Implement only the approved Execute contract and write set. Do not commit, integrate, archive, change Kernel approval, or declare acceptance.";
}

export function prepareCodexRequest(input: {
  root: string; task: string; tool: CodexBridgeTool; role?: CodexBridgeRole;
  threadId?: string; promptFile?: string; projectId?: string; targetType?: "project" | "projectless";
  environment?: "local" | "worktree"; title?: string; timeoutMs?: number;
}): CodexBridgeRequest {
  const context = taskContext(input.root, input.task);
  const bound = input.threadId ? boundThreads(context.dir).get(input.threadId) : undefined;
  const role = input.tool === "create_thread" ? input.role : bound?.role;
  if (!role) throw new Error(input.tool === "create_thread" ? "--role plan|review|execute is required" : "Thread is not bound to this Pactile task");
  if (role !== "plan" && role !== "review" && role !== "execute") throw new Error("Codex role must be plan, review or execute");
  if (input.tool === "create_thread" || input.tool === "send_message_to_thread") checkPhase(role, context.phase);
  if (role === "execute" && (input.tool === "create_thread" || input.tool === "send_message_to_thread")) approvedTask(input.root, input.task, "implement");
  if ((input.tool === "wait_threads" || input.tool === "read_thread") && input.promptFile) {
    throw new Error("wait/read do not accept --prompt-file");
  }
  const prompt = input.promptFile ? textFile(input.promptFile) : null;
  const executeScope = role === "execute" && (input.tool === "create_thread" || input.tool === "send_message_to_thread")
    ? parallelChild(input.root, context.dir) : null;
  const scopeLine = executeScope ? `Parent-approved write set: ${executeScope.touches.join(", ")}. Integration owner: Parent.` : "";
  const record: unknown = JSON.parse(fs.readFileSync(path.join(context.dir, "task.json"), "utf8"));
  const baseBranch = record && typeof record === "object" && "base_branch" in record ? (record as { base_branch?: unknown }).base_branch : null;
  if (role === "execute" && baseBranch && (typeof baseBranch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(baseBranch) || baseBranch.includes(".."))) {
    throw new Error("Invalid approved base_branch for Codex Execute");
  }
  let args: Record<string, unknown>;
  if (input.tool === "create_thread") {
    if (!prompt) throw new Error("create requires --prompt-file");
    const targetType = input.targetType ?? "project";
    if (targetType !== "project" && targetType !== "projectless") throw new Error("--target must be project or projectless");
    if (targetType === "project" && (!input.projectId || !idPattern.test(input.projectId) || !["local", "worktree"].includes(input.environment ?? ""))) {
      throw new Error("project create requires --project-id and --environment local|worktree");
    }
    if (role === "execute" && (targetType !== "project" || input.environment !== "worktree")) throw new Error("Codex Execute requires a project worktree");
    const target = targetType === "projectless" ? { type: "projectless" } :
      { type: "project", projectId: input.projectId, environment: { type: input.environment,
        ...(role === "execute" && typeof baseBranch === "string" && baseBranch ? { startingState: { type: "branch", branchName: baseBranch } } : {}) } };
    args = { prompt: `Pactile task: ${context.task}\nCanonical Pactile task directory: ${context.dir}\nCodex role: ${role}\nKernel revision: ${context.revision}\nUse Pactile as the task lifecycle and evidence source. ${roleBoundary(role)} ${scopeLine} Do not change Kernel approval or claim acceptance from a message alone. Do not dispatch Codex subagents.\n\n${prompt}`,
      target, ...(input.title ? { title: input.title } : {}) };
  } else {
    if (!bound) throw new Error("Thread is not bound to this Pactile task");
    if (input.tool === "send_message_to_thread") {
      if (!prompt) throw new Error("message requires --prompt-file");
      args = { threadId: bound.threadId, hostId: bound.hostId,
        prompt: `Pactile task: ${context.task}\nCanonical Pactile task directory: ${context.dir}\nKernel revision: ${context.revision}\n${roleBoundary(role)} ${scopeLine}\n\n${prompt}` };
    } else if (input.tool === "wait_threads") {
      const timeoutMs = input.timeoutMs ?? 120_000;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000) throw new Error("wait timeout must be 0 to 120000 ms");
      const afterCursor = latestWaitCursor(context.dir, bound.threadId);
      args = { targets: [{ threadId: bound.threadId, hostId: bound.hostId,
        ...(afterCursor ? { afterCursor } : {}) }], timeoutMs };
    } else {
      args = { threadId: bound.threadId, hostId: bound.hostId, turnLimit: 1 };
    }
  }
  const request: CodexBridgeRequest = {
    schema_version: 1, request_id: randomUUID(), task: context.task, kernel_revision: context.revision,
    created_at: new Date().toISOString(), tool: input.tool, role,
    thread_id: bound?.threadId ?? null, host_id: bound?.hostId ?? null,
    arguments: args, prompt_sha256: prompt ? createHash("sha256").update(prompt).digest("hex") : null,
  };
  const release = role === "execute" && input.tool === "create_thread"
    ? reserveParallelChild(input.root, context.dir, { id: request.request_id, durable: true }) : null;
  try { writeNew(requestFile(context.dir, request.request_id), request); }
  catch (error) { release?.(); throw error; }
  return request;
}

export function recordCodexReceipt(root: string, task: string, requestId: string, resultFile: string): CodexBridgeReceipt {
  if (!uuidPattern.test(requestId)) throw new Error("Invalid request id");
  const context = taskContext(root, task);
  const request = readJson(requestFile(context.dir, requestId)) as unknown as CodexBridgeRequest;
  if (request.task !== context.task || request.request_id !== requestId) throw new Error("Request belongs to another task");
  const result = readJson(resultFile);
  if (result.request_id !== requestId || result.tool !== request.tool) throw new Error("Receipt does not match the request");
  if (!["ok", "failed", "queued"].includes(String(result.outcome)) ||
      (result.outcome === "queued" && request.tool !== "create_thread")) {
    throw new Error("Receipt outcome must be ok, failed or queued for create");
  }
  const successful = result.outcome === "ok";
  const threadId = typeof result.thread_id === "string" && idPattern.test(result.thread_id) ? result.thread_id : request.thread_id;
  const hostId = typeof result.host_id === "string" && idPattern.test(result.host_id) ? result.host_id : request.host_id;
  const clientThreadId = typeof result.client_thread_id === "string" && idPattern.test(result.client_thread_id) ? result.client_thread_id : null;
  if (successful && (!threadId || !hostId)) throw new Error("Successful receipt requires thread_id and host_id");
  if (result.outcome === "queued" && (!clientThreadId || threadId)) throw new Error("Queued create requires client_thread_id without thread_id");
  if (request.thread_id && (threadId !== request.thread_id || hostId !== request.host_id)) throw new Error("Receipt thread identity changed");
  const queuedPath = queuedFile(context.dir, requestId);
  if (fs.existsSync(queuedPath) && result.outcome !== "queued" && readJson(queuedPath).client_thread_id !== clientThreadId) {
    throw new Error("Ready receipt must match the queued client_thread_id");
  }
  const status = typeof result.status === "string" && result.status.length <= 80 ? result.status : null;
  if (successful && request.tool === "wait_threads" && !["completed", "needs_attention", "timeout"].includes(status ?? "")) {
    throw new Error("Wait receipt requires completed, needs_attention or timeout status");
  }
  const reason = typeof result.reason === "string" && result.reason.length <= 500 ? result.reason : null;
  if (result.outcome === "failed" && !reason) throw new Error("Failed receipt requires a short reason");
  const cursor = typeof result.cursor === "string" && result.cursor.length <= 2048 ? result.cursor : null;
  const receipt: CodexBridgeReceipt = {
    schema_version: 1, request_id: requestId, tool: request.tool, outcome: result.outcome as "ok" | "failed" | "queued",
    thread_id: threadId, client_thread_id: clientThreadId, host_id: hostId, status, cursor, reason,
    kernel_revision_at_receipt: context.revision, contract_stale: context.revision !== request.kernel_revision,
    recorded_at: new Date().toISOString(), assurance: "host-reported",
  };
  writeNew(result.outcome === "queued" ? queuedPath : receiptFile(context.dir, requestId), receipt);
  if (request.role === "execute" && request.tool === "create_thread" && result.outcome === "failed") {
    releaseParallelChild(root, context.dir, requestId);
  }
  if (request.role === "execute" && request.tool === "wait_threads" && result.outcome === "ok" && status === "completed") {
    const create = requests(context.dir).find((candidate) => candidate.tool === "create_thread" && candidate.role === "execute"
      && fs.existsSync(receiptFile(context.dir, candidate.request_id))
      && readJson(receiptFile(context.dir, candidate.request_id)).thread_id === threadId);
    if (create) releaseParallelChild(root, context.dir, create.request_id);
  }
  return receipt;
}

export function codexBridgeStatus(root: string, task: string): {
  task: string; archived: boolean; phase: string; kernel_revision: number; threads: BoundThread[];
  pending: PendingCodexRequest[]; queued: CodexBridgeReceipt[]; receipts: CodexBridgeReceipt[];
} {
  let context: ReturnType<typeof taskContext>;
  let archived = false;
  try { context = taskContext(root, task); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Task not found:")) throw error;
    context = archivedTaskContext(root, task);
    archived = true;
  }
  const all = requests(context.dir);
  const receipts = all.flatMap((request) => {
    const file = receiptFile(context.dir, request.request_id);
    return fs.existsSync(file) ? [readJson(file) as unknown as CodexBridgeReceipt] : [];
  });
  const completed = new Set(receipts.map((receipt) => receipt.request_id));
  const queued = all.flatMap((request) => {
    const file = queuedFile(context.dir, request.request_id);
    return fs.existsSync(file) && !completed.has(request.request_id) ? [readJson(file) as unknown as CodexBridgeReceipt] : [];
  });
  return { task: context.task, archived, phase: context.phase, kernel_revision: context.revision,
    threads: [...boundThreads(context.dir).values()], pending: all.filter((request) => !completed.has(request.request_id))
      .map(({ request_id, tool, role, thread_id, kernel_revision, created_at, prompt_sha256 }) =>
        ({ request_id, tool, role, thread_id, kernel_revision, created_at, prompt_sha256 })), queued, receipts };
}
