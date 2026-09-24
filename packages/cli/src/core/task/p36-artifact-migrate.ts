/**
 * P36 wave B — artifact dual-read + optional write (not wave C).
 *
 * User default: keep reading old task.json / evidence. Maintainer may write
 * required_controls + Topology projections. Never delete
 * business prose. Archive is read-only. Failure rolls back to dual-read.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveRequiredControls, type RequiredControlsBundle } from "./full-quality.js";
import { projectLegacyStatus } from "./kernel-contract.js";
import {
  STAGE5_SCHEMA_VERSION,
  defaultDependencyGraph,
  defaultTopology,
  expandDependsOnToRequires,
  topologyKindFromChildren,
  type DependencyGraph,
  type TopologyState,
} from "./ondemand-topology.js";
import { loadTaskRecord, writeTaskRecord } from "./records.js";
import { isPlainObject } from "./schema.js";

export const P36_ARTIFACT_SOURCE = "p36-artifact-migrate";

export interface ArtifactWriteTarget {
  path: string;
  extra?: {
    required_controls?: RequiredControlsBundle;
    topology?: TopologyState;
    dependency_graph?: DependencyGraph;
  };
}

export interface ArtifactTaskScan {
  path: string;
  id: string;
  status: string;
  archive: boolean;
  continueOk: boolean;
  dualRead: boolean;
  writable: boolean;
  missing: string[];
}

export interface ArtifactMigratePlan {
  scanned: number;
  dualRead: number;
  activeDualRead: number;
  archiveSkipped: number;
  writable: ArtifactWriteTarget[];
  tasks: ArtifactTaskScan[];
  degraded: string[];
  continueOk: boolean;
}

export interface PlanArtifactMigrationOptions {
  root: string;
  tasksDir?: string;
}

export interface ApplyArtifactMigrationOptions {
  root: string;
  plan: ArtifactMigratePlan;
  onBeforeWrite?: (target: ArtifactWriteTarget) => void;
}

export interface ApplyArtifactMigrationResult {
  ok: boolean;
  wrote: boolean;
  written: number;
  rolledBack: boolean;
  error?: string;
}

export function planArtifactMigration(
  options: PlanArtifactMigrationOptions,
): ArtifactMigratePlan {
  const root = path.resolve(options.root);
  const tasksRoot = options.tasksDir
    ? path.resolve(options.tasksDir)
    : path.join(root, ".pactile", "tasks");

  const degraded: string[] = [];
  const tasks: ArtifactTaskScan[] = [];
  const writable: ArtifactWriteTarget[] = [];

  for (const file of collectFiles(tasksRoot)) {
    const scanned = scanTaskArtifact(file, tasksRoot);
    if (scanned.degraded) {
      degraded.push(scanned.degraded);
      continue;
    }
    if (!scanned.task) continue;
    tasks.push(scanned.task);
    if (scanned.write) writable.push(scanned.write);
  }

  const dualRead = tasks.filter((task) => task.dualRead).length;
  const activeDualRead = tasks.filter(
    (task) => task.dualRead && !task.archive && isActiveStatus(task.status),
  ).length;
  const archiveSkipped = tasks.filter((task) => task.archive).length;

  return {
    scanned: tasks.length,
    dualRead,
    activeDualRead,
    archiveSkipped,
    writable,
    tasks,
    degraded,
    continueOk: tasks.length === 0 || tasks.every((task) => task.continueOk),
  };
}

export function applyArtifactMigration(
  options: ApplyArtifactMigrationOptions,
): ApplyArtifactMigrationResult {
  const snapshots: { path: string; content: string | null }[] = [];
  let written = 0;

  try {
    for (const target of options.plan.writable) {
      if (options.onBeforeWrite) options.onBeforeWrite(target);
      if (!fs.existsSync(target.path)) {
        throw new Error(`missing ${target.path}`);
      }
      snapshots.push({
        path: target.path,
        content: fs.readFileSync(target.path, "utf-8"),
      });
      writeArtifactTarget(target);
      written += 1;
    }
    return { ok: true, wrote: written > 0, written, rolledBack: false };
  } catch (err) {
    restoreSnapshots(snapshots);
    return {
      ok: false,
      wrote: false,
      written: 0,
      rolledBack: snapshots.length > 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function formatArtifactVernacular(
  plan: ArtifactMigratePlan,
  writeArtifacts: boolean,
): string[] {
  const lines = [
    writeArtifacts
      ? `产物：将写入 ${plan.writable.length} 个投影（required_controls / Topology；不删正文）。归档 ${plan.archiveSkipped} 个只读。`
      : `产物：${plan.activeDualRead} 个进行中的任务仍按旧形状可读，这次不用改它们。归档 ${plan.archiveSkipped} 个只读。`,
  ];
  if (plan.degraded.length > 0) {
    lines.push(`degraded：${plan.degraded.length}（仍可再跑 update）`);
  } else {
    lines.push("degraded：无");
  }
  return lines;
}

function writeArtifactTarget(target: ArtifactWriteTarget): void {
  const record = loadTaskRecord({ taskDir: path.dirname(target.path) });
  writeTaskRecord({
    taskDir: path.dirname(target.path),
    record,
    extra: target.extra ?? {},
  });
}

function restoreSnapshots(
  snapshots: { path: string; content: string | null }[],
): void {
  for (const snapshot of [...snapshots].reverse()) {
    if (snapshot.content === null) {
      if (fs.existsSync(snapshot.path)) fs.unlinkSync(snapshot.path);
      continue;
    }
    fs.writeFileSync(snapshot.path, snapshot.content, "utf-8");
  }
}

function scanTaskArtifact(
  file: string,
  tasksRoot: string,
): {
  task?: ArtifactTaskScan;
  write?: ArtifactWriteTarget;
  degraded?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return { degraded: `${file}: task.json is not readable JSON` };
  }
  if (!isPlainObject(parsed)) {
    return { degraded: `${file}: task.json is not an object` };
  }

  const id = typeof parsed.id === "string" ? parsed.id : path.basename(path.dirname(file));
  const status = typeof parsed.status === "string" ? parsed.status : "";
  const archive = isArchivePath(tasksRoot, file);
  const continueOk = status.trim() !== "";
  if (continueOk) {
    projectLegacyStatus(status);
  }

  const missing: string[] = [];
  const extra: ArtifactWriteTarget["extra"] = {};

  if (!hasRequiredControls(parsed)) {
    missing.push("required_controls");
    extra.required_controls = resolveRequiredControls({
      rigor: inferLegacyRigor(parsed),
    });
  }

  const parent =
    typeof parsed.parent === "string" && parsed.parent.trim() !== ""
      ? parsed.parent
      : null;
  const children = asStringArray(parsed.children);
  if (!hasTopology(parsed)) {
    missing.push("topology");
    extra.topology = defaultTopology({
      id,
      parent,
      children,
    });
  } else {
    const repaired = repairMisclassifiedTopology(parsed, { id, parent, children });
    if (repaired) {
      missing.push("topology");
      extra.topology = repaired;
    }
  }

  const dependsOn = asStringArray(parsed.depends_on);
  if (!hasDependencyGraph(parsed) && dependsOn.length > 0) {
    missing.push("dependency_graph");
    extra.dependency_graph = expandDependsOnToRequires(
      defaultDependencyGraph(),
      id,
      dependsOn,
    );
  }

  const dualRead = missing.length > 0;
  const writable = dualRead && !archive && Object.keys(extra).length > 0;

  return {
    task: {
      path: file,
      id,
      status,
      archive,
      continueOk,
      dualRead,
      writable,
      missing,
    },
    write: writable
      ? {
          path: file,
          extra,
        }
      : undefined,
  };
}

function collectFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name === "task.json") {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function isArchivePath(root: string, file: string): boolean {
  const rel = path.relative(root, file).replace(/\\/g, "/");
  return rel.split("/").includes("archive");
}

function hasRequiredControls(parsed: Record<string, unknown>): boolean {
  const raw = parsed.required_controls;
  return (
    isPlainObject(raw) && (raw.rigor === "lite" || raw.rigor === "full")
  );
}

function hasTopology(parsed: Record<string, unknown>): boolean {
  const raw = parsed.topology;
  return isPlainObject(raw) && (raw.kind === "single" || raw.kind === "parent-child");
}

function repairMisclassifiedTopology(
  parsed: Record<string, unknown>,
  record: { id: string; parent: string | null; children: string[] },
): TopologyState | null {
  const raw = parsed.topology;
  if (!isPlainObject(raw)) return null;
  const parentId =
    raw.parent_id === null || raw.parent_id === undefined
      ? record.parent
      : typeof raw.parent_id === "string" && raw.parent_id.trim() !== ""
        ? raw.parent_id.trim()
        : null;
  const children = uniqueStrings([
    ...asStringArray(raw.children),
    ...record.children,
  ]);
  const expectedKind = topologyKindFromChildren(children);
  if (raw.kind === expectedKind) return null;
  return {
    schema_version: STAGE5_SCHEMA_VERSION,
    kind: expectedKind,
    parent_id: parentId,
    children,
  };
}

function uniqueStrings(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

function hasDependencyGraph(parsed: Record<string, unknown>): boolean {
  const raw = parsed.dependency_graph;
  return isPlainObject(raw) && Array.isArray(raw.edges);
}

function inferLegacyRigor(parsed: Record<string, unknown>): "lite" | "full" {
  const meta = isPlainObject(parsed.meta) ? parsed.meta : {};
  const candidates = [
    parsed.task_kind,
    parsed.task_type,
    parsed.kind,
    parsed.mode,
    meta.task_kind,
    meta.task_type,
    meta.classification,
    meta.mode,
  ];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const normalized = value.toLowerCase().replace(/_/g, "-");
    if (normalized.includes("full")) return "full";
    if (normalized.includes("lite")) return "lite";
  }
  return "lite";
}

function isActiveStatus(status: string): boolean {
  return !["completed", "done", "cancelled", "canceled"].includes(status);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
