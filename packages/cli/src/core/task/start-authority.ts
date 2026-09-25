import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseAcceptanceItems } from "./full-quality.js";
import { readDependencyGraph, unmetRequires } from "./ondemand-topology.js";
import { parseKernelSnapshot, type KernelSnapshot } from "./kernel-contract.js";
import type { PactileTaskRecord } from "./schema.js";
import { currentGateErrors, readStrategyContract, requiredGates } from "./strategy.js";

const STABLE_TASK_KEYS = ["id", "name", "title", "description", "status", "dev_type", "scope", "package", "priority", "creator", "assignee", "parent", "children", "subtasks", "relatedFiles", "notes", "meta", "branch", "base_branch", "task_kind", "task_type", "kind", "mode", "contract_epoch", "depends_on"];

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sorted(nested)]));
  }
  return value;
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(sorted(value)) ?? "undefined").digest("hex")}`;
}

function stableTask(record: PactileTaskRecord): Record<string, unknown> {
  const source = record as unknown as Record<string, unknown>;
  return Object.fromEntries(STABLE_TASK_KEYS.filter((key) => key in source).map((key) => [key, source[key]]));
}

export function startFingerprints(dir: string, record: PactileTaskRecord): { contractFingerprint: string; artifactFingerprint: string } {
  const stable = stableTask(record);
  const files = ["prd.md", "design.md", "implement.md"].map((name) => ({
    path: name,
    content: fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), "utf8") : null,
  }));
  return {
    contractFingerprint: fingerprint({ schema_version: 1, task_dir: path.basename(dir), stable_task: stable, strategy_contract: {} }),
    artifactFingerprint: fingerprint({ schema_version: 1, transition: "start-execution", gate: "baseline-check", task_dir: path.basename(dir), stable_task: stable, parent_contract: null, reviewed_change_set: null, files }),
  };
}

/** Resolve only completed task references; dangling or active dependencies remain unmet. */
export function dependencyStatus(root: string, dir: string, record: PactileTaskRecord): { warnings: string[]; satisfied: string[] } {
  const raw = record as unknown as Record<string, unknown>;
  const deps = Array.isArray(raw.depends_on) ? raw.depends_on.filter((item): item is string => typeof item === "string") : [];
  const warnings: string[] = [];
  const satisfied: string[] = [];
  const taskRoot = path.join(root, ".pactile", "tasks");
  for (const ref of deps) {
    const active = (fs.existsSync(taskRoot) ? fs.readdirSync(taskRoot, { withFileTypes: true }) : [])
      .filter((item) => item.isDirectory() && (item.name === ref || item.name.endsWith(`-${ref}`)))
      .map((item) => path.join(taskRoot, item.name));
    const archiveRoot = path.join(taskRoot, "archive");
    const archived = fs.existsSync(archiveRoot) ? fs.readdirSync(archiveRoot, { withFileTypes: true })
      .filter((month) => month.isDirectory()).flatMap((month) => fs.readdirSync(path.join(archiveRoot, month.name), { withFileTypes: true })
        .filter((item) => item.isDirectory() && (item.name === ref || item.name.endsWith(`-${ref}`)))
        .map((item) => path.join(archiveRoot, month.name, item.name))) : [];
    const candidates = [...active, ...archived].filter((candidate) => candidate !== dir);
    if (candidates.length !== 1) {
      warnings.push(candidates.length ? `ambiguous dependency: ${ref}` : `dangling dependency: ${ref}`);
      continue;
    }
    try {
      const kernel = parseKernelSnapshot(JSON.parse(fs.readFileSync(path.join(candidates[0], "kernel.json"), "utf8")) as unknown);
      if (kernel.phase === "close" && kernel.projection?.status === "completed") satisfied.push(ref);
      else warnings.push(`dependency not satisfied: ${ref} (Kernel phase=${kernel.phase})`);
    } catch { warnings.push(`dangling dependency: ${ref}`); }
  }
  return { warnings, satisfied };
}

/** Final authority check used by every Kernel start caller, including direct API callers. */
export function startAuthorityErrors(
  root: string,
  dir: string,
  current: KernelSnapshot,
  incoming: PactileTaskRecord,
  extras: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  const projection = current.projection;
  if (!projection) return ["start requires a canonical Planning task projection"];
  const previous = projection.record;
  if (fingerprint(extras.required_controls) !== fingerprint(projection.extras.required_controls)) {
    errors.push("required controls changed during start");
  }
  if (fingerprint(readDependencyGraph(extras)) !== fingerprint(readDependencyGraph(projection.extras))) {
    errors.push("dependency graph changed during start");
  }
  let liveRecord: PactileTaskRecord;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid task.json");
    liveRecord = raw as PactileTaskRecord;
  } catch { return ["start requires a readable task.json projection"]; }
  if (current.phase !== "define" && current.phase !== "approve") errors.push(`start requires Define or Approve phase, got ${current.phase}`);
  if (previous.status !== "planning" || incoming.status !== "in_progress") errors.push("start requires planning → in_progress status");
  if (previous.id !== current.identity.taskId || incoming.id !== previous.id) errors.push("task identity changed during start");
  const canonicalKeys = Object.keys(previous as unknown as Record<string, unknown>);
  const canonical = (record: PactileTaskRecord): Record<string, unknown> => Object.fromEntries(canonicalKeys.map((key) => [key, (record as unknown as Record<string, unknown>)[key]]));
  if (fingerprint(canonical(previous)) !== fingerprint(canonical({ ...incoming, status: "planning" }))
    || fingerprint(canonical(previous)) !== fingerprint(canonical(liveRecord))) errors.push("task contract changed during start");
  const prd = path.join(dir, "prd.md");
  if (!fs.statSync(prd, { throwIfNoEntry: false })?.isFile() || !fs.readFileSync(prd, "utf8").trim()) errors.push("start requires non-empty prd.md");

  const approval = extras.execution_approval && typeof extras.execution_approval === "object"
    ? extras.execution_approval as Record<string, unknown> : null;
  const expected = startFingerprints(dir, liveRecord);
  if (approval?.transition !== "start-execution" || approval.approved_by !== "user"
    || approval.task_id !== previous.id || typeof approval.approval_source !== "string" || !approval.approval_source.trim()
    || typeof approval.approved_at !== "string" || Number.isNaN(Date.parse(approval.approved_at))) {
    errors.push("start requires a recorded, task-bound caller assertion of user approval");
  } else if (approval.contract_fingerprint !== expected.contractFingerprint || approval.artifact_fingerprint !== expected.artifactFingerprint) {
    errors.push("stale execution approval: task contract or artifacts changed");
  }

  if ((projection.extras.required_controls as Record<string, unknown> | undefined)?.rigor === "full") {
    const prdContent = fs.statSync(prd, { throwIfNoEntry: false })?.isFile() ? fs.readFileSync(prd, "utf8") : "";
    if (!/^\s*#{1,6}\s*acceptance\s+criteria\s*$/im.test(prdContent) || !parseAcceptanceItems(prdContent).length) {
      errors.push("Full start requires acceptance criteria in prd.md");
    }
    const parsed = readStrategyContract(dir);
    errors.push(...parsed.errors);
    if (parsed.contract) {
      errors.push(...currentGateErrors(dir, liveRecord, "start-execution", requiredGates("start-execution", parsed.contract),
        parsed.contract, current.gates as unknown as Record<string, unknown>));
    }
  }

  const liveSatisfied = dependencyStatus(root, dir, liveRecord).satisfied;
  const claimedSatisfied = Array.isArray(extras.dependency_satisfied)
    ? extras.dependency_satisfied.filter((item): item is string => typeof item === "string") : [];
  const unexpected = claimedSatisfied.filter((item) => !liveSatisfied.includes(item));
  if (unexpected.length) errors.push(`unverified dependency satisfaction: ${unexpected.join(", ")}`);
  const unmet = unmetRequires(readDependencyGraph(extras), liveSatisfied, previous.id);
  if (unmet.length) {
    const override = extras.dependency_override && typeof extras.dependency_override === "object"
      ? extras.dependency_override as Record<string, unknown> : null;
    const waived = override?.approved_by === "user" && override.transition === "start-execution"
      && Array.isArray(override.dependencies) ? override.dependencies.filter((item): item is string => typeof item === "string") : [];
    const unwaived = unmet.filter((item) => !waived.includes(item));
    if (unwaived.length) errors.push(`requires unmet: ${unwaived.join(", ")}`);
  }
  return errors;
}
