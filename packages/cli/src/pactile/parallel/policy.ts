import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readTaskMap, type ChildEntry, type TaskMap } from "../task/task-map.js";

export interface ParallelChild { parentDir: string; map: TaskMap; entry: ChildEntry; touches: string[]; }

function taskRecord(dir: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid task.json");
  return value as Record<string, unknown>;
}

export function normalizeTouches(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) return ["*"];
  return value.map((item) => {
    if (typeof item !== "string") throw new Error("touches must contain paths");
    const name = item.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (!name || name === "." || name.startsWith("/") || /^[A-Za-z]:/.test(name)
      || name.split("/").some((part) => !part || part === ".." || part === ".")
      || ["*", "?", "[", "]"].some((symbol) => name.includes(symbol))) {
      throw new Error(`touches must contain concrete project-relative paths: ${item}`);
    }
    return name;
  });
}

export function touchesConflict(left: readonly string[], right: readonly string[]): boolean {
  return left.some((rawA) => right.some((rawB) => {
    const a = process.platform === "win32" ? rawA.toLowerCase() : rawA;
    const b = process.platform === "win32" ? rawB.toLowerCase() : rawB;
    return a === "*" || b === "*" || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  }));
}

export function parallelLimit(map: TaskMap): number {
  const limit = map.parallel_limit ?? 2;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 4) throw new Error("parallel_limit must be an integer from 1 to 4");
  return Number(limit);
}

export function parallelChild(root: string, dir: string): ParallelChild | null {
  const child = taskRecord(dir);
  if (typeof child.parent !== "string" || !child.parent) return null;
  if (path.basename(child.parent) !== child.parent) throw new Error("Invalid Parent task reference");
  const parentDir = path.join(root, ".pactile", "tasks", child.parent);
  const parent = taskRecord(parentDir);
  const { data: map } = readTaskMap(parentDir);
  if (!map || !Array.isArray(parent.children) || !parent.children.includes(path.basename(dir))) throw new Error("Child is not linked to Parent task-map");
  const entry = map.children.find((item) => item.id === path.basename(dir));
  if (!entry) throw new Error("Child missing from Parent task-map");
  if (!["open", "working", "changes"].includes(entry.state)) throw new Error(`Child cannot be dispatched in state ${entry.state}`);
  for (const dependency of entry.depends_on) {
    const target = map.children.find((item) => item.id === dependency || item.id.endsWith(`-${dependency}`));
    if (target?.state !== "integrated") throw new Error(`requires unmet: ${dependency}`);
  }
  return { parentDir, map, entry, touches: normalizeTouches(entry.touches) };
}

function alive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

interface Lease { id: string; pid: number; child_pid?: number; durable?: boolean; child: string; touches: string[]; }

function withMutex<T>(parentDir: string, action: () => T): T {
  const folder = path.join(parentDir, "parallel");
  const mutex = path.join(folder, ".mutex");
  fs.mkdirSync(folder, { recursive: true });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { fs.mkdirSync(mutex); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const ownerFile = path.join(mutex, "owner.json");
      let owner: { pid?: number } = {};
      try { if (fs.existsSync(ownerFile)) owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as { pid?: number }; }
      catch { /* Incomplete owner write; wait or recover by age. */ }
      if (!alive(owner.pid) && Date.now() - fs.statSync(mutex).mtimeMs > 5_000) {
        fs.rmSync(ownerFile, { force: true });
        try { fs.rmdirSync(mutex); } catch { /* Another process took the lock. */ }
      }
      if (attempt === 199) throw new Error("Parallel reservation lock timed out");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  const ownerFile = path.join(mutex, "owner.json");
  try {
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    return action();
  } finally {
    fs.rmSync(ownerFile, { force: true });
    fs.rmdirSync(mutex);
  }
}

export function reserveParallelChild(root: string, dir: string, options: { id?: string; durable?: boolean } = {}): () => void {
  const child = parallelChild(root, dir);
  if (!child) return () => undefined;
  const { parentDir, entry, touches, map } = child;
  const folder = path.join(parentDir, "parallel", "active");
  const lease: Lease = { id: options.id ?? randomUUID(), pid: process.pid, durable: options.durable, child: entry.id, touches };
  withMutex(parentDir, () => {
    fs.mkdirSync(folder, { recursive: true });
    const active: Lease[] = [];
    for (const file of fs.readdirSync(folder).filter((name) => name.endsWith(".json"))) {
      const location = path.join(folder, file);
      let prior: Lease;
      try { prior = JSON.parse(fs.readFileSync(location, "utf8")) as Lease; }
      catch { throw new Error(`Invalid parallel lease: ${file}`); }
      if (!prior.durable && !alive(prior.pid) && !alive(prior.child_pid)) { fs.rmSync(location, { force: true }); continue; }
      active.push(prior);
    }
    if (active.some((prior) => prior.child === entry.id)) throw new Error(`Child already dispatched: ${entry.id}`);
    if (active.length >= parallelLimit(map)) throw new Error(`parallel_limit ${parallelLimit(map)} reached`);
    const collision = active.find((prior) => touchesConflict(prior.touches, touches));
    if (collision) throw new Error(`write-set conflict with active Child ${collision.child}`);
    fs.writeFileSync(path.join(folder, `${lease.id}.json`), JSON.stringify(lease), { flag: "wx", mode: 0o600 });
  });
  return () => withMutex(parentDir, () => fs.rmSync(path.join(folder, `${lease.id}.json`), { force: true }));
}

export function releaseParallelChild(root: string, dir: string, id: string): void {
  const child = taskRecord(dir);
  if (typeof child.parent !== "string" || !child.parent) return;
  if (path.basename(child.parent) !== child.parent) throw new Error("Invalid Parent task reference");
  const parentDir = path.join(root, ".pactile", "tasks", child.parent);
  withMutex(parentDir, () => fs.rmSync(path.join(parentDir, "parallel", "active", `${id}.json`), { force: true }));
}

export function updateParallelChildPid(root: string, dir: string, id: string, pid: number | undefined): void {
  if (!pid) return;
  const child = taskRecord(dir);
  if (typeof child.parent !== "string" || !child.parent || path.basename(child.parent) !== child.parent) return;
  const parentDir = path.join(root, ".pactile", "tasks", child.parent);
  withMutex(parentDir, () => {
    const file = path.join(parentDir, "parallel", "active", `${id}.json`);
    const lease = JSON.parse(fs.readFileSync(file, "utf8")) as Lease;
    if (lease.id !== id || lease.child !== path.basename(dir)) throw new Error("Parallel lease identity changed");
    fs.writeFileSync(file, JSON.stringify({ ...lease, child_pid: pid }), { mode: 0o600 });
  });
}
