import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fingerprintTaskValue, readTaskKernel } from "../../core/task/index.js";
import {
  readTaskMap,
  type ChildEntry,
  type TaskMap,
} from "../task/task-map.js";
import {
  planParentTaskScheduleV1,
  type ConflictParallelAuthorizationV1,
  type TaskScheduleDecisionReceiptV1,
} from "../scheduler/index.js";

export interface ParallelChild {
  parentDir: string;
  map: TaskMap;
  entry: ChildEntry;
  touches: string[];
}

function taskRecord(dir: string): Record<string, unknown> {
  const value: unknown = JSON.parse(
    fs.readFileSync(path.join(dir, "task.json"), "utf8"),
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid task.json");
  return value as Record<string, unknown>;
}

export function normalizeTouches(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) return ["*"];
  return value.map((item) => {
    if (typeof item !== "string") throw new Error("touches must contain paths");
    const name = item
      .trim()
      .replaceAll("\\", "/")
      .replace(/^\.\//, "")
      .replace(/\/$/, "");
    if (
      !name ||
      name === "." ||
      name.startsWith("/") ||
      /^[A-Za-z]:/.test(name) ||
      name.split("/").some((part) => !part || part === ".." || part === ".") ||
      ["*", "?", "[", "]"].some((symbol) => name.includes(symbol))
    ) {
      throw new Error(
        `touches must contain concrete project-relative paths: ${item}`,
      );
    }
    return name;
  });
}

export function touchesConflict(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.some((rawA) =>
    right.some((rawB) => {
      const a = process.platform === "win32" ? rawA.toLowerCase() : rawA;
      const b = process.platform === "win32" ? rawB.toLowerCase() : rawB;
      return (
        a === "*" ||
        b === "*" ||
        a === b ||
        a.startsWith(`${b}/`) ||
        b.startsWith(`${a}/`)
      );
    }),
  );
}

export function parallelChild(root: string, dir: string): ParallelChild | null {
  const child = taskRecord(dir);
  if (typeof child.parent !== "string" || !child.parent) return null;
  if (path.basename(child.parent) !== child.parent)
    throw new Error("Invalid Parent task reference");
  const parentDir = path.join(root, ".pactile", "tasks", child.parent);
  const parent = taskRecord(parentDir);
  const { data: map } = readTaskMap(parentDir);
  if (
    !map ||
    !Array.isArray(parent.children) ||
    !parent.children.includes(path.basename(dir))
  )
    throw new Error("Child is not linked to Parent task-map");
  const entry = map.children.find((item) => item.id === path.basename(dir));
  if (!entry) throw new Error("Child missing from Parent task-map");
  if (!["open", "working", "changes"].includes(entry.state))
    throw new Error(`Child cannot be dispatched in state ${entry.state}`);
  for (const dependency of entry.depends_on) {
    const target = map.children.find(
      (item) => item.id === dependency || item.id.endsWith(`-${dependency}`),
    );
    if (target?.state !== "integrated")
      throw new Error(`requires unmet: ${dependency}`);
  }
  const schedule = planParentTaskScheduleV1(root, parentDir);
  const lifecycle = schedule.lifecycle.find(
    (item) => item.taskMapChildId === entry.id,
  );
  const decision =
    lifecycle &&
    schedule.plan.decisions.find((item) => item.taskId === lifecycle.taskId);
  if (decision?.action !== "scheduled") {
    throw new Error(
      `Scheduler gate rejects Child ${entry.id}: ${decision?.action ?? "missing-decision"} (${decision?.reasonCodes.join(", ") ?? "no decision"})`,
    );
  }
  return { parentDir, map, entry, touches: normalizeTouches(entry.touches) };
}

function alive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

interface Lease {
  id: string;
  pid: number;
  child_pid?: number;
  durable?: boolean;
  child: string;
  task_id?: string;
  schedule_receipt_fingerprint?: string;
  authorized_conflicts?: ConflictParallelAuthorizationV1[];
  touches: string[];
}

function readScheduleReceiptForDispatch(
  root: string,
  parentDir: string,
  childId: string,
  fingerprint: string,
): TaskScheduleDecisionReceiptV1 {
  if (!/^[a-f0-9]{64}$/.test(fingerprint))
    throw new Error("Invalid scheduler receipt fingerprint");
  const file = path.join(
    parentDir,
    "scheduler",
    "receipts",
    `${fingerprint}.json`,
  );
  if (!fs.existsSync(file))
    throw new Error(`Scheduler decision receipt is missing: ${fingerprint}`);
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid scheduler decision receipt");
  const receipt = value as TaskScheduleDecisionReceiptV1;
  const {
    schemaVersion: _schemaVersion,
    receiptFingerprint,
    createdAt: _createdAt,
    ...base
  } = receipt;
  if (
    receipt.schemaVersion !== 1 ||
    receiptFingerprint !== fingerprint ||
    fingerprintTaskValue(base) !== fingerprint
  ) {
    throw new Error(
      "Scheduler decision receipt fingerprint does not match its contents",
    );
  }
  const map = readTaskMap(parentDir);
  if (
    !map.data ||
    fingerprintTaskValue({ data: map.data, body: map.body }) !==
      receipt.taskMapFingerprint
  ) {
    throw new Error(
      "Scheduler decision receipt is stale: Parent task-map changed",
    );
  }
  for (const snapshot of receipt.lifecycle) {
    if (snapshot.kernelRevision === null) continue;
    const taskDir = path.resolve(root, snapshot.taskDir);
    const read = readTaskKernel({ root, taskDir });
    if (
      read.kind !== "task-kernel-v2" ||
      read.kernel.revision !== snapshot.kernelRevision
    ) {
      throw new Error(
        `Scheduler decision receipt is stale: Task ${snapshot.taskId} changed`,
      );
    }
  }
  const task = receipt.lifecycle.find(
    (item) => item.taskMapChildId === childId,
  );
  if (
    !task ||
    receipt.plan.decisions.find((item) => item.taskId === task.taskId)
      ?.action !== "scheduled"
  ) {
    throw new Error(
      `Scheduler decision does not authorize Child dispatch: ${childId}`,
    );
  }
  return receipt;
}

function receiptAuthorizesPair(
  receipt: TaskScheduleDecisionReceiptV1,
  left: string,
  right: string,
): ConflictParallelAuthorizationV1 | undefined {
  return receipt.plan.waves
    .find((wave) => wave.taskIds.includes(left) && wave.taskIds.includes(right))
    ?.conflictAuthorizations.find(
      (authorization) =>
        authorization.taskIds.includes(left) &&
        authorization.taskIds.includes(right),
    );
}

function withMutex<T>(parentDir: string, action: () => T): T {
  const folder = path.join(parentDir, "parallel");
  const mutex = path.join(folder, ".mutex");
  fs.mkdirSync(folder, { recursive: true });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      fs.mkdirSync(mutex);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const ownerFile = path.join(mutex, "owner.json");
      let owner: { pid?: number } = {};
      try {
        if (fs.existsSync(ownerFile))
          owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as {
            pid?: number;
          };
      } catch {
        /* Incomplete owner write; wait or recover by age. */
      }
      if (
        !alive(owner.pid) &&
        Date.now() - fs.statSync(mutex).mtimeMs > 5_000
      ) {
        fs.rmSync(ownerFile, { force: true });
        try {
          fs.rmdirSync(mutex);
        } catch {
          /* Another process took the lock. */
        }
      }
      if (attempt === 199)
        throw new Error("Parallel reservation lock timed out");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  const ownerFile = path.join(mutex, "owner.json");
  try {
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid }), {
      mode: 0o600,
    });
    return action();
  } finally {
    fs.rmSync(ownerFile, { force: true });
    fs.rmdirSync(mutex);
  }
}

export function reserveParallelChild(
  root: string,
  dir: string,
  options: {
    id?: string;
    durable?: boolean;
    scheduleReceiptFingerprint?: string;
  } = {},
): () => void {
  const child = parallelChild(root, dir);
  if (!child) return () => undefined;
  const { parentDir, entry, touches } = child;
  const folder = path.join(parentDir, "parallel", "active");
  const scheduleReceipt = options.scheduleReceiptFingerprint
    ? readScheduleReceiptForDispatch(
        root,
        parentDir,
        entry.id,
        options.scheduleReceiptFingerprint,
      )
    : null;
  const selectedTask = scheduleReceipt?.lifecycle.find(
    (item) => item.taskMapChildId === entry.id,
  );
  const lease: Lease = {
    id: options.id ?? randomUUID(),
    pid: process.pid,
    durable: options.durable,
    child: entry.id,
    ...(selectedTask ? { task_id: selectedTask.taskId } : {}),
    ...(scheduleReceipt
      ? { schedule_receipt_fingerprint: scheduleReceipt.receiptFingerprint }
      : {}),
    touches,
  };
  withMutex(parentDir, () => {
    fs.mkdirSync(folder, { recursive: true });
    const active: Lease[] = [];
    for (const file of fs
      .readdirSync(folder)
      .filter((name) => name.endsWith(".json"))) {
      const location = path.join(folder, file);
      let prior: Lease;
      try {
        prior = JSON.parse(fs.readFileSync(location, "utf8")) as Lease;
      } catch {
        throw new Error(`Invalid parallel lease: ${file}`);
      }
      if (!prior.durable && !alive(prior.pid) && !alive(prior.child_pid)) {
        fs.rmSync(location, { force: true });
        continue;
      }
      active.push(prior);
    }
    if (active.some((prior) => prior.child === entry.id))
      throw new Error(`Child already dispatched: ${entry.id}`);
    const collision = active.find((prior) =>
      touchesConflict(prior.touches, touches),
    );
    if (collision) {
      const authorized =
        scheduleReceipt &&
        collision.task_id &&
        selectedTask &&
        collision.schedule_receipt_fingerprint ===
          scheduleReceipt.receiptFingerprint
          ? receiptAuthorizesPair(
              scheduleReceipt,
              selectedTask.taskId,
              collision.task_id,
            )
          : undefined;
      if (!authorized)
        throw new Error(
          `write-set conflict with active Child ${collision.child}`,
        );
      lease.authorized_conflicts = [authorized];
    }
    fs.writeFileSync(
      path.join(folder, `${lease.id}.json`),
      JSON.stringify(lease),
      { flag: "wx", mode: 0o600 },
    );
  });
  return () =>
    withMutex(parentDir, () =>
      fs.rmSync(path.join(folder, `${lease.id}.json`), { force: true }),
    );
}

export function releaseParallelChild(
  root: string,
  dir: string,
  id: string,
): void {
  const child = taskRecord(dir);
  if (typeof child.parent !== "string" || !child.parent) return;
  if (path.basename(child.parent) !== child.parent)
    throw new Error("Invalid Parent task reference");
  const parentDir = path.join(root, ".pactile", "tasks", child.parent);
  withMutex(parentDir, () =>
    fs.rmSync(path.join(parentDir, "parallel", "active", `${id}.json`), {
      force: true,
    }),
  );
}

export function updateParallelChildPid(
  root: string,
  dir: string,
  id: string,
  pid: number | undefined,
): void {
  if (!pid) return;
  const child = taskRecord(dir);
  if (
    typeof child.parent !== "string" ||
    !child.parent ||
    path.basename(child.parent) !== child.parent
  )
    return;
  const parentDir = path.join(root, ".pactile", "tasks", child.parent);
  withMutex(parentDir, () => {
    const file = path.join(parentDir, "parallel", "active", `${id}.json`);
    const lease = JSON.parse(fs.readFileSync(file, "utf8")) as Lease;
    if (lease.id !== id || lease.child !== path.basename(dir))
      throw new Error("Parallel lease identity changed");
    fs.writeFileSync(file, JSON.stringify({ ...lease, child_pid: pid }), {
      mode: 0o600,
    });
  });
}
