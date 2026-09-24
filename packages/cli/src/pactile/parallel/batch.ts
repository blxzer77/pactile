import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PiTaskBridge, approvedTask, piWorkdir, type PiRunRecord } from "../pi/bridge.js";
import type { PiRpcLaunch } from "../pi/rpc.js";
import { resolveTaskDir } from "../task/session.js";
import { readTaskMap } from "../task/task-map.js";
import { parallelChild, parallelLimit, touchesConflict } from "./policy.js";

export interface BatchItem { task: string; prompt_file: string; review_cost: "low" | "medium" | "high"; }
export interface BatchManifest { schema_version: 1; limit?: number; children: BatchItem[]; }
export interface BatchResult {
  schema_version: 1;
  batch_id: string;
  event_file: string;
  parent: string;
  integration_owner: "parent";
  merge_limit: number;
  concurrency_limit: number;
  started_at: string;
  ended_at: string;
  wall_ms: number;
  queue_wait_total_ms: number;
  max_active: number;
  children: { task: string; review_cost: BatchItem["review_cost"]; queue_wait_ms: number; started_at: string; ended_at: string; outcome: string; pi_run_id: string | null; event_count: number; tool_errors: number; reason: string | null }[];
}

function readManifest(file: string): BatchManifest {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid parallel manifest");
  const manifest = value as BatchManifest;
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.children) || manifest.children.length < 1 || manifest.children.length > 32) {
    throw new Error("Parallel manifest requires schema_version 1 and 1 to 32 children");
  }
  return manifest;
}

function alive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** Runs only approved Pi Child tasks. Parent review and integration remain manual, serial gates. */
export async function runParallelBatch(root: string, parent: string, manifestFile: string, launch?: PiRpcLaunch): Promise<BatchResult> {
  const parentDir = resolveTaskDir(root, parent);
  const { data: map } = readTaskMap(parentDir);
  if (!map) throw new Error("Parent task-map.md is required");
  if (map.execution_topology !== "parallel") throw new Error("Parent execution_topology must be parallel for batch dispatch");
  if (map.merge_limit !== 1) throw new Error("Parallel batch requires serial Parent integration (merge_limit: 1)");
  const manifest = readManifest(manifestFile);
  const cap = parallelLimit(map);
  const limit = manifest.limit ?? cap;
  if (!Number.isInteger(limit) || limit < 1 || limit > cap) throw new Error(`Batch limit must be 1 to ${cap}`);
  const seen = new Set<string>();
  const children = manifest.children.map((item) => {
    if (!item || typeof item.task !== "string" || typeof item.prompt_file !== "string" || !["low", "medium", "high"].includes(item.review_cost)) {
      throw new Error("Each Child needs task, prompt_file and review_cost: low|medium|high");
    }
    const dir = approvedTask(root, item.task, "implement");
    piWorkdir(root, dir, "implement");
    const policy = parallelChild(root, dir);
    if (policy?.parentDir !== parentDir) throw new Error(`Task is not a Child of ${path.basename(parentDir)}: ${item.task}`);
    if (seen.has(policy.entry.id)) throw new Error(`Duplicate Child: ${policy.entry.id}`);
    seen.add(policy.entry.id);
    const promptFile = path.resolve(root, item.prompt_file);
    if (!fs.statSync(promptFile, { throwIfNoEntry: false })?.isFile()) throw new Error(`Prompt file not found: ${item.prompt_file}`);
    const prompt = fs.readFileSync(promptFile, "utf8");
    if (!prompt.trim() || prompt.length > 64 * 1024) throw new Error(`Prompt must contain 1 to 65536 characters: ${item.task}`);
    return { task: policy.entry.id, touches: policy.touches, reviewCost: item.review_cost, prompt };
  });
  const folder = path.join(parentDir, "parallel");
  const activeFile = path.join(folder, "batch-active.json");
  fs.mkdirSync(folder, { recursive: true });
  if (fs.existsSync(activeFile)) {
    const active = JSON.parse(fs.readFileSync(activeFile, "utf8")) as { pid?: number };
    if (alive(active.pid)) throw new Error("A parallel batch is already active for this Parent");
    fs.rmSync(activeFile, { force: true });
  }
  const batchId = randomUUID();
  fs.writeFileSync(activeFile, JSON.stringify({ batch_id: batchId, pid: process.pid }), { flag: "wx", mode: 0o600 });
  const eventFile = path.join(folder, "runs", `${batchId}.events.jsonl`);
  fs.mkdirSync(path.dirname(eventFile), { recursive: true });
  const event = (value: Record<string, unknown>): void => fs.appendFileSync(eventFile,
    `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`, { encoding: "utf8", mode: 0o600 });
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const pending = [...children];
  const running = new Map<string, { touches: string[]; reviewCost: BatchItem["review_cost"]; promise: Promise<void> }>();
  const records: BatchResult["children"] = [];
  let maxActive = 0;
  try {
    while (pending.length || running.size) {
      while (running.size < limit && pending.length) {
        const index = pending.findIndex((candidate) => [...running.values()].every((current) =>
          current.reviewCost !== "high" && candidate.reviewCost !== "high" && !touchesConflict(current.touches, candidate.touches)));
        if (index < 0) break;
        const [child] = pending.splice(index, 1);
        const queueWaitMs = Math.round(performance.now() - started);
        const runStartedAt = new Date().toISOString();
        event({ type: "child_started", task: child.task, queue_wait_ms: queueWaitMs, review_cost: child.reviewCost });
        const bridge = new PiTaskBridge(root, launch);
        const promise = (async (): Promise<void> => {
          let result: PiRunRecord | null = null;
          let reason: string | null = null;
          try { result = await bridge.run({ root, task: child.task, role: "implement", prompt: child.prompt, timeoutMs: 30 * 60_000 }); }
          catch (error) { reason = error instanceof Error ? error.message : String(error); }
          finally {
            try { await bridge.close(); }
            catch (error) { reason = `${reason ?? "Pi close failed"}; ${error instanceof Error ? error.message : String(error)}`; }
          }
          records.push({ task: child.task, review_cost: child.reviewCost, queue_wait_ms: queueWaitMs,
            started_at: runStartedAt, ended_at: new Date().toISOString(), outcome: reason ? "failed" : result?.outcome ?? "failed",
            pi_run_id: result?.run_id ?? null, event_count: result?.event_count ?? 0,
            tool_errors: result?.tool_errors ?? 0, reason: result?.reason ?? reason });
          event({ type: "child_ended", task: child.task, outcome: reason ? "failed" : result?.outcome ?? "failed", pi_run_id: result?.run_id ?? null,
            event_count: result?.event_count ?? 0, tool_errors: result?.tool_errors ?? 0 });
        })().finally(() => running.delete(child.task));
        running.set(child.task, { touches: child.touches, reviewCost: child.reviewCost, promise });
        maxActive = Math.max(maxActive, running.size);
      }
      if (running.size) await Promise.race([...running.values()].map((item) => item.promise));
    }
    const result: BatchResult = { schema_version: 1, batch_id: batchId, event_file: path.relative(parentDir, eventFile).replaceAll("\\", "/"), parent: path.basename(parentDir),
      integration_owner: "parent", merge_limit: 1, concurrency_limit: limit, started_at: startedAt,
      ended_at: new Date().toISOString(), wall_ms: Math.round(performance.now() - started),
      queue_wait_total_ms: records.reduce((sum, item) => sum + item.queue_wait_ms, 0), max_active: maxActive,
      children: records.sort((a, b) => children.findIndex((item) => item.task === a.task) - children.findIndex((item) => item.task === b.task)) };
    atomicJson(path.join(folder, "runs", `${batchId}.json`), result);
    atomicJson(path.join(folder, "latest.json"), result);
    return result;
  } catch (error) {
    await Promise.allSettled([...running.values()].map((item) => item.promise));
    atomicJson(path.join(folder, "runs", `${batchId}.failure.json`), {
      schema_version: 1, batch_id: batchId, parent: path.basename(parentDir),
      started_at: startedAt, ended_at: new Date().toISOString(),
      reason: error instanceof Error ? error.message : String(error), completed_children: records,
    });
    throw error;
  } finally { fs.rmSync(activeFile, { force: true }); }
}

export function parallelStatus(root: string, parent: string): Record<string, unknown> {
  const parentDir = resolveTaskDir(root, parent);
  const { data: map, body } = readTaskMap(parentDir);
  if (!map) throw new Error("Parent task-map.md is required");
  const latestFile = path.join(parentDir, "parallel", "latest.json");
  const latest = fs.existsSync(latestFile) ? JSON.parse(fs.readFileSync(latestFile, "utf8")) as BatchResult : null;
  const activeFile = path.join(parentDir, "parallel", "batch-active.json");
  const active = fs.existsSync(activeFile) ? JSON.parse(fs.readFileSync(activeFile, "utf8")) as { batch_id: string; pid: number } : null;
  const eventFile = active ? path.join(parentDir, "parallel", "runs", `${active.batch_id}.events.jsonl`) : null;
  const recentEvents = eventFile && fs.existsSync(eventFile) ? fs.readFileSync(eventFile, "utf8").trim().split(/\r?\n/).slice(-100).map((line) => JSON.parse(line) as unknown) : [];
  const integration = map.children.map((child) => ({ task: child.id, state: child.state, ref: child.ref }));
  const reworkOpened = new Map<string, number>();
  let recordedReworkEvents = 0;
  let recordedReworkMs = 0;
  for (const match of body.matchAll(/^- (\d{4}-\d\d-\d\dT[^ ]+) - (?:Parent integrated|Child reported) (\S+) as (changes|accepted|integrating|integrated)\./gm)) {
    const [, at, child, state] = match;
    const time = Date.parse(at);
    if (!Number.isFinite(time)) continue;
    if (state === "changes") { recordedReworkEvents += 1; reworkOpened.set(child, time); }
    else if (reworkOpened.has(child)) {
      recordedReworkMs += Math.max(0, time - (reworkOpened.get(child) ?? time));
      reworkOpened.delete(child);
    }
  }
  return { parent: path.basename(parentDir), integration_owner: "parent", merge_limit: map.merge_limit,
    latest_batch: latest, active_batch: active && alive(active.pid) ? { batch_id: active.batch_id, recent_events: recentEvents } : null,
    integration, integration_complete: integration.length > 0 && integration.every((child) => child.state === "integrated"),
    terminal_complete: integration.length > 0 && integration.every((child) => child.state === "integrated" || child.state === "cancelled"),
    recorded_rework_events: recordedReworkEvents, recorded_rework_ms: recordedReworkMs,
    open_rework_events: reworkOpened.size };
}
