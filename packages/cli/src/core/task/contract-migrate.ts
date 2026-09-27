/**
 * Stage 7 Contract dry-run (P28 §15.9 Expand → Migrate → Contract).
 *
 * Read-only scan of old Task / Profile / Artifact references. Field names
 * here are an implementation choice — not a frozen Manifest / migrate ABI.
 * This module must not write task.json, kernel.json, Archive, or verify.md.
 */

import fs from "node:fs";
import path from "node:path";

import { isPlainObject } from "./schema.js";

export const RETIRED_TOP_LEVEL_FIELDS = [
  "task_kind",
  "task_type",
  "kind",
  "mode",
] as const;

export const RETIRED_META_FIELDS = [
  "classification",
  "task_kind",
  "task_type",
  "mode",
] as const;

export type ContractMigrateFindingKind =
  | "retired-field"
  | "legacy-parent"
  | "artifact-inference"
  | "depends-mode"
  | "file-inferred-rigor"
  | "children-inferred-parent"
  | "profile-ref";

export interface ContractMigrateFinding {
  path: string;
  kind: ContractMigrateFindingKind;
  detail: string;
}

export interface ContractMigrateReport {
  dryRun: true;
  wrote: false;
  scanned: number;
  findings: ContractMigrateFinding[];
}

export interface ScanContractMigrationOptions {
  root: string;
  tasksDir?: string;
}

function omitKeys(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const omitted = new Set(keys);
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !omitted.has(key)),
  );
}

export function stripRetiredExtras(
  extras: Record<string, unknown>,
): Record<string, unknown> {
  return omitKeys(extras, RETIRED_TOP_LEVEL_FIELDS);
}

export function stripRetiredMeta(
  meta: Record<string, unknown>,
): Record<string, unknown> {
  return omitKeys(meta, RETIRED_META_FIELDS);
}

export function scanContractMigration(
  options: ScanContractMigrationOptions,
): ContractMigrateReport {
  const tasksRoot = options.tasksDir
    ? path.resolve(options.tasksDir)
    : path.join(path.resolve(options.root), ".pactile", "tasks");
  const files = collectTaskJsonFiles(tasksRoot);
  const findings: ContractMigrateFinding[] = [];

  for (const file of files) {
    findings.push(...scanTaskFile(file));
  }

  findings.push(...scanProfileRefs(options.root));

  return {
    dryRun: true,
    wrote: false,
    scanned: files.length,
    findings,
  };
}

function collectTaskJsonFiles(tasksRoot: string): string[] {
  if (!fs.existsSync(tasksRoot)) return [];
  const out: string[] = [];
  const stack = [tasksRoot];
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

function scanTaskFile(file: string): ContractMigrateFinding[] {
  const findings: ContractMigrateFinding[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return [
      {
        path: file,
        kind: "retired-field",
        detail: "task.json is not readable JSON",
      },
    ];
  }
  if (!isPlainObject(parsed)) return findings;

  for (const key of RETIRED_TOP_LEVEL_FIELDS) {
    if (parsed[key] !== undefined) {
      findings.push({
        path: file,
        kind: "retired-field",
        detail: `top-level ${key}=${stringifySmall(parsed[key])}`,
      });
    }
  }

  const meta = isPlainObject(parsed.meta) ? parsed.meta : {};
  for (const key of RETIRED_META_FIELDS) {
    if (meta[key] !== undefined) {
      findings.push({
        path: file,
        kind: "retired-field",
        detail: `meta.${key}=${stringifySmall(meta[key])}`,
      });
    }
  }

  if (parsed.depends_mode !== undefined) {
    findings.push({
      path: file,
      kind: "depends-mode",
      detail: `depends_mode=${stringifySmall(parsed.depends_mode)}`,
    });
  }

  const topology = isPlainObject(parsed.topology) ? parsed.topology : {};
  const parent =
    typeof parsed.parent === "string" && parsed.parent.trim() !== ""
      ? parsed.parent
      : null;
  if (parent && topology.parent_id !== parent) {
    findings.push({
      path: file,
      kind: "legacy-parent",
      detail: `canonical parent=${parent} without matching topology.parent_id`,
    });
  }

  const children = Array.isArray(parsed.children)
    ? parsed.children.filter((item): item is string => typeof item === "string")
    : [];
  if (children.length > 0 && topology.kind !== "parent-child") {
    findings.push({
      path: file,
      kind: "children-inferred-parent",
      detail: `children[]=${children.join(",")} without topology.kind=parent-child`,
    });
  }

  const taskDir = path.dirname(file);
  const hasDesign = fs.existsSync(path.join(taskDir, "design.md"));
  const hasImplement = fs.existsSync(path.join(taskDir, "implement.md"));
  const rigor =
    isPlainObject(parsed.required_controls) &&
    (parsed.required_controls.rigor === "lite" ||
      parsed.required_controls.rigor === "full")
      ? parsed.required_controls.rigor
      : null;
  if (hasDesign && hasImplement && rigor === null) {
    findings.push({
      path: file,
      kind: "file-inferred-rigor",
      detail: "design.md+implement.md present without required_controls.rigor",
    });
    findings.push({
      path: file,
      kind: "artifact-inference",
      detail: "artifact files would have inferred Full Rigor under the old closeout path",
    });
  }

  if (parsed.profile !== undefined || meta.profile !== undefined) {
    findings.push({
      path: file,
      kind: "profile-ref",
      detail: "legacy profile reference on task record",
    });
  }

  return findings;
}

function scanProfileRefs(root: string): ContractMigrateFinding[] {
  const configPath = path.join(path.resolve(root), ".pactile", "config.yaml");
  if (!fs.existsSync(configPath)) return [];
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf-8");
  } catch {
    return [];
  }
  if (!/\b(task_kind|task_type|depends_mode|classification)\b/.test(text)) {
    return [];
  }
  return [
    {
      path: configPath,
      kind: "profile-ref",
      detail: "config.yaml mentions retired Task/Profile contract tokens",
    },
  ];
}

function stringifySmall(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}
