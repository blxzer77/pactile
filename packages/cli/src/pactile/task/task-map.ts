import fs from "node:fs";
import path from "node:path";
import { readKernel, type PactileTaskRecord } from "@blxzer/pactile-core/task";

export const CHILD_STATES = ["open", "working", "blocked", "review", "changes", "accepted", "integrating", "integrated", "cancelled"] as const;
export type ChildState = typeof CHILD_STATES[number];
export interface ChildEntry {
  id: string;
  state: ChildState;
  depends_on: string[];
  touches: string[];
  isolation: string;
  ref: string | null;
  [key: string]: unknown;
}
export interface TaskMap {
  parent_id: string;
  contract_epoch: number;
  execution_topology: string;
  merge_limit: number;
  children: ChildEntry[];
  stages: Record<string, unknown>[];
  integration_queue: string[];
  [key: string]: unknown;
}

function parseValue(input: string): unknown {
  const value = input.trim().replace(/^['"]|['"]$/g, "");
  if (value === "null") return null;
  if (value === "[]") return [];
  if (/^\d+$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1).split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  return value;
}

function renderValue(input: unknown): string {
  if (input === null || input === undefined) return "null";
  if (Array.isArray(input)) return `[${input.map((item) => String(item)).join(", ")}]`;
  return String(input);
}

function splitFrontmatter(content: string): { data: Record<string, unknown> | null; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: null, body: content };
  const data: Record<string, unknown> = {};
  let listKey = "";
  let current: Record<string, unknown> | null = null;
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^[^\s].*?:/.test(line)) {
      const separator = line.indexOf(":");
      const key = line.slice(0, separator).trim();
      const raw = line.slice(separator + 1).trim();
      if ((key === "children" || key === "stages") && !raw) { data[key] = []; listKey = key; current = null; }
      else { data[key] = parseValue(raw); listKey = ""; current = null; }
      continue;
    }
    const item = line.match(/^\s{2}-\s+([^:]+):\s*(.*)$/);
    if (item && listKey) {
      current = { [item[1].trim()]: parseValue(item[2]) };
      (data[listKey] as Record<string, unknown>[]).push(current);
      continue;
    }
    const property = line.match(/^\s{4}([^:]+):\s*(.*)$/);
    if (property && current) current[property[1].trim()] = parseValue(property[2]);
  }
  return { data, body: match[2] };
}

function safeChildren(value: unknown): ChildEntry[] {
  return Array.isArray(value) ? value.filter((entry): entry is ChildEntry => !!entry && typeof entry === "object" && typeof entry.id === "string") : [];
}

export function readTaskMap(parentDir: string): { data: TaskMap | null; body: string } {
  const file = path.join(parentDir, "task-map.md");
  if (!fs.existsSync(file)) return { data: null, body: "" };
  const parsed = splitFrontmatter(fs.readFileSync(file, "utf8"));
  if (!parsed.data) return { data: null, body: parsed.body };
  const raw = parsed.data;
  return { data: {
    ...raw,
    parent_id: String(raw.parent_id ?? path.basename(parentDir)),
    contract_epoch: Number(raw.contract_epoch ?? 1),
    execution_topology: String(raw.execution_topology ?? "parallel"),
    merge_limit: Number(raw.merge_limit ?? 1),
    children: safeChildren(raw.children),
    stages: Array.isArray(raw.stages) ? raw.stages as Record<string, unknown>[] : [],
    integration_queue: Array.isArray(raw.integration_queue) ? raw.integration_queue.filter((item): item is string => typeof item === "string") : [],
  }, body: parsed.body };
}

function defaultChild(id: string): ChildEntry {
  return { id, state: "open", depends_on: [], touches: [], isolation: "git-worktree", ref: null };
}

function renderMap(data: TaskMap, body: string): string {
  const scalarKeys = ["parent_id", "contract_epoch", "execution_topology", "merge_limit", "serial_reason", "parallel_groups", "merge_points", "conflict_surface", "graph_authority", "topology_kind"];
  const lines: string[] = ["---"];
  for (const key of scalarKeys) if (data[key] !== undefined && data[key] !== null) lines.push(`${key}: ${renderValue(data[key])}`);
  lines.push("children:");
  for (const child of data.children) {
    lines.push(`  - id: ${renderValue(child.id)}`);
    for (const [key, value] of Object.entries(child)) if (key !== "id" && value !== undefined) lines.push(`    ${key}: ${renderValue(value)}`);
  }
  if (data.stages.length) {
    lines.push("stages:");
    for (const stage of data.stages) {
      const [first, ...rest] = Object.entries(stage);
      if (!first) continue;
      lines.push(`  - ${first[0]}: ${renderValue(first[1])}`);
      for (const [key, value] of rest) lines.push(`    ${key}: ${renderValue(value)}`);
    }
  }
  lines.push(`integration_queue: ${renderValue(data.integration_queue)}`);
  const extra = Object.keys(data).filter((key) => ![...scalarKeys, "children", "stages", "integration_queue"].includes(key));
  for (const key of extra) if (typeof data[key] !== "object") lines.push(`${key}: ${renderValue(data[key])}`);
  lines.push("---", "", body.trim() || "# Parent Task Map\n\n## Event Log");
  return `${lines.join("\n").trimEnd()}\n`;
}

export function writeTaskMap(parentDir: string, data: TaskMap, body: string, event?: string): void {
  const eventBody = event ? `${body.trimEnd()}\n\n${body.includes("## Event Log") ? "" : "## Event Log\n\n"}- ${new Date().toISOString()} - ${event}\n` : body;
  fs.writeFileSync(path.join(parentDir, "task-map.md"), renderMap(data, eventBody), "utf8");
}

export function ensureTaskMap(parentDir: string, parent: PactileTaskRecord, event?: string): TaskMap {
  const { data, body } = readTaskMap(parentDir);
  const next: TaskMap = data ?? { parent_id: parent.id || path.basename(parentDir), contract_epoch: 1, execution_topology: "parallel", merge_limit: 1, children: [], stages: [], integration_queue: [] };
  for (const id of parent.children) if (!next.children.some((entry) => entry.id === id)) next.children.push(defaultChild(id));
  next.children = next.children.filter((entry) => parent.children.includes(entry.id));
  next.graph_authority = "kernel-extras";
  next.topology_kind = parent.children.length ? "parent-child" : "single";
  writeTaskMap(parentDir, next, body, event);
  return next;
}

export function childStateErrors(parentDir: string, parent: PactileTaskRecord, childDir: string, state: ChildState, evidence: string, options: { ref?: string; reason?: string } = {}): string[] {
  const errors: string[] = [];
  const childName = path.basename(childDir);
  if (!parent.children.includes(childName)) errors.push(`child is not linked to parent: ${childName}`);
  if (!evidence.trim() || evidence.length > 240 || /[\r\n]/.test(evidence)) errors.push("evidence must be a short single-line reference");
  const { data } = readTaskMap(parentDir);
  if (!data) return [...errors, "task-map.md"];
  const entry = data.children.find((item) => item.id === childName);
  if (!entry) return [...errors, `child missing from task-map.md: ${childName}`];
  if (["accepted", "changes"].includes(state) && entry.state !== "review") errors.push(`${state} requires current Child state review`);
  if (state === "integrating" && entry.state !== "accepted") errors.push("integrating requires current Child state accepted");
  if (state === "integrated" && entry.state !== "integrating") errors.push("integrated requires current Child state integrating");
  if (["changes", "cancelled"].includes(state) && !options.reason) errors.push(`${state} requires --reason`);
  if (["accepted", "integrating", "integrated"].includes(state)) {
    if (!options.ref) errors.push(`${state} requires --ref`);
    for (const name of ["verify.md", "handoff.md"]) if (!fs.existsSync(path.join(childDir, name)) || !fs.readFileSync(path.join(childDir, name), "utf8").trim()) errors.push(`${name} required for ${state}`);
    const verifyPath = path.join(childDir, "verify.md");
    const verify = fs.existsSync(verifyPath) ? fs.readFileSync(verifyPath, "utf8") : "";
    if (!/^\s*(?:[-*]\s*)?validation(?:\s+(?:commands?|results?|evidence))?\s*:\s*\S.{2,}$/im.test(verify)) errors.push(`verify.md missing validation evidence for ${state}`);
    if (!/^\s*(?:[-*]\s*)?(?:(?:final|user)\s+)?acceptance(?:\s+evidence)?\s*:\s*\S.{2,}$/im.test(verify)
      && !/^\s*(?:[-*]\s*)?accepted\s+by\s+user\s*:\s*\S.{2,}$/im.test(verify)) errors.push(`verify.md missing final acceptance evidence for ${state}`);
  }
  if (state === "integrating" && data.children.filter((item) => item.id !== childName && item.state === "integrating").length >= data.merge_limit) errors.push(`merge_limit ${data.merge_limit} blocks integrating ${childName}`);
  if (state === "working") {
    const child = JSON.parse(fs.readFileSync(path.join(childDir, "task.json"), "utf8")) as PactileTaskRecord;
    const raw = child as unknown as Record<string, unknown>;
    const dependencies = Array.isArray(raw.depends_on) ? raw.depends_on.filter((item): item is string => typeof item === "string") : [];
    for (const dependency of dependencies) {
      const target = data.children.find((item) => item.id === dependency || item.id.endsWith(`-${dependency}`));
      if (!target || !["integrated", "cancelled"].includes(target.state)) errors.push(`requires unmet: ${dependency}`);
    }
  }
  return errors;
}

export function parentArchiveErrors(parentDir: string, parent: PactileTaskRecord): string[] {
  const { data } = readTaskMap(parentDir);
  if (!data) return ["task-map.md"];
  const errors: string[] = [];
  for (const id of parent.children) {
    const entry = data.children.find((item) => item.id === id);
    if (!entry) { errors.push(`child missing from task-map.md: ${id}`); continue; }
    if (!["integrated", "cancelled"].includes(entry.state)) errors.push(`child not terminal: ${id} (${entry.state})`);
    if (entry.state === "integrated") {
      for (const name of ["verify.md", "handoff.md"]) {
        const active = path.join(path.dirname(parentDir), id);
        const archiveRoot = path.join(path.dirname(parentDir), "archive");
        const archived = fs.existsSync(archiveRoot) ? fs.readdirSync(archiveRoot, { withFileTypes: true })
          .filter((month) => month.isDirectory()).map((month) => path.join(archiveRoot, month.name, id)).find((candidate) => fs.existsSync(candidate)) : undefined;
        const file = path.join(fs.existsSync(active) ? active : archived ?? active, name);
        if (!fs.existsSync(file) || !fs.readFileSync(file, "utf8").trim()) errors.push(`integrated child ${id} missing ${name}`);
      }
    }
  }
  const kernel = readKernel({ taskDir: parentDir }).kernel;
  if ((kernel.projection?.extras?.topology as Record<string, unknown> | undefined)?.kind !== "parent-child") errors.push("Kernel topology is not parent-child");
  const verify = fs.existsSync(path.join(parentDir, "verify.md")) ? fs.readFileSync(path.join(parentDir, "verify.md"), "utf8") : "";
  if (!/^\s*(?:[-*]\s*)?(?:final\s+)?integration(?:\s+evidence)?\s*:\s*\S.{2,}$/im.test(verify)) errors.push("verify.md missing final integration evidence");
  return errors;
}
