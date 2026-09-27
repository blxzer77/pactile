import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface SelectedTask {
  taskPath: string | null;
  source: string;
  contextKey: string | null;
  stale: boolean;
}

function safeContextKey(raw: string): string {
  const value = raw.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "").slice(0, 160);
  return value || createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

/** A shell without a stable session key never inherits another task's selection. */
export function resolveContextKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.PACTILE_CONTEXT_ID?.trim();
  return value ? safeContextKey(value) : null;
}

function contextFile(root: string, key: string): string {
  return path.join(root, ".pactile", ".runtime", "sessions", `${key}.json`);
}

function readContext(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function resolveTaskDir(root: string, taskRef: string): string {
  const normalized = taskRef.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  const tasks = path.resolve(root, ".pactile", "tasks");
  const insideTasks = (candidate: string): string => {
    const resolved = path.resolve(candidate);
    const relative = path.relative(tasks, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.split(path.sep).includes("archive")) {
      throw new Error(`Task reference must name an active task under .pactile/tasks: ${taskRef}`);
    }
    if (fs.existsSync(resolved) && fs.existsSync(tasks)) {
      const realRoot = fs.realpathSync(tasks);
      const realTask = fs.realpathSync(resolved);
      const realRelative = path.relative(realRoot, realTask);
      if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
        throw new Error(`Task reference resolves outside .pactile/tasks: ${taskRef}`);
      }
    }
    return resolved;
  };
  if (path.isAbsolute(taskRef)) return insideTasks(taskRef);
  if (normalized.includes("/") || normalized.startsWith(".pactile")) {
    return insideTasks(path.resolve(root, normalized));
  }
  if (fs.existsSync(path.join(tasks, normalized))) return insideTasks(path.join(tasks, normalized));
  if (fs.existsSync(tasks)) {
    const match = fs.readdirSync(tasks, { withFileTypes: true })
      .find((item) => item.isDirectory() && item.name.endsWith(`-${normalized}`));
    if (match) return insideTasks(path.join(tasks, match.name));
  }
  return insideTasks(path.join(tasks, normalized));
}

export function resolveSelectedTask(root: string, env: NodeJS.ProcessEnv = process.env): SelectedTask {
  const key = resolveContextKey(env);
  if (!key) return { taskPath: null, source: "none", contextKey: null, stale: false };
  const value = readContext(contextFile(root, key)).selected_task;
  if (typeof value !== "string" || !value.trim()) {
    return { taskPath: null, source: "none", contextKey: key, stale: false };
  }
  return {
    taskPath: value,
    source: `session:${key}`,
    contextKey: key,
    stale: !fs.statSync(resolveTaskDir(root, value), { throwIfNoEntry: false })?.isDirectory(),
  };
}

export function selectTask(root: string, taskRef: string, env: NodeJS.ProcessEnv = process.env): SelectedTask {
  const dir = resolveTaskDir(root, taskRef);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Task not found: ${taskRef}`);
  }
  const key = resolveContextKey(env);
  if (!key) throw new Error("session identity not available; set PACTILE_CONTEXT_ID before selecting a task");
  const file = contextFile(root, key);
  const prior = readContext(file);
  const selected = path.relative(root, dir).replaceAll("\\", "/");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  delete prior.current_task;
  fs.writeFileSync(file, `${JSON.stringify({
    ...prior,
    platform: key.startsWith("codex_") ? "codex" : "session",
    last_seen_at: new Date().toISOString(),
    selected_task: selected,
    current_run: prior.current_run ?? null,
  }, null, 2)}\n`, "utf8");
  return { taskPath: selected, source: `session:${key}`, contextKey: key, stale: false };
}

export function exitTask(root: string, env: NodeJS.ProcessEnv = process.env): SelectedTask {
  const selected = resolveSelectedTask(root, env);
  if (selected.contextKey) {
    fs.rmSync(contextFile(root, selected.contextKey), { force: true });
  }
  return selected;
}
