import fs from "node:fs";
import path from "node:path";
import { assertFullQualityForPhase, parseAcceptanceItems, readDependencyGraph, readKernel, unmetRequires, type PactileTaskRecord } from "../../core/task/index.js";
import { dependencyStatus, startFingerprints } from "../../core/task/start-authority.js";
import { currentGateErrors, readStrategyContract, requiredGates } from "./strategy.js";
import { parentArchiveErrors, readTaskMap } from "./task-map.js";

export { dependencyStatus } from "../../core/task/start-authority.js";

const REQUIRED_LIFECYCLE_SLOTS = ["define-basic", "approval-personal", "execute-agent", "verify-basic", "close-basic"];
const BASELINE_EIGHT = ["intake-basic", ...REQUIRED_LIFECYCLE_SLOTS, "context-progressive", "observability-local"];

export interface TaskGuard {
  ok: boolean;
  errors: string[];
  warnings: string[];
  contractFingerprint: string;
  artifactFingerprint: string;
}

export interface ArchiveGuard {
  ok: boolean;
  errors: string[];
}

function hasEvidence(content: string, pattern: RegExp): boolean {
  const placeholder = /^(?:TBD|TODO|待定|待补充|N\/?A|NA|NONE|-|\.\.\.)$/i;
  for (const match of content.matchAll(pattern)) {
    const value = match[1]?.trim() ?? "";
    if (value.length >= 3 && !placeholder.test(value)) return true;
  }
  return false;
}

/** Archive preflight includes the same Full quality checks run by Kernel mutation. */
export function checkArchive(dir: string, record: PactileTaskRecord): ArchiveGuard {
  const errors = requiredFileErrors(dir, ["verify.md"]);
  const active = new Set(baselineSlots(dir, record));
  for (const slot of REQUIRED_LIFECYCLE_SLOTS) if (!active.has(slot)) errors.push(`missing required lifecycle slot: ${slot}`);
  const extras = readKernel({ taskDir: dir }).kernel.projection?.extras ?? {};
  const rigor = taskRigor(record, extras);
  if (rigor === "full") {
    if ((extras.required_controls as Record<string, unknown> | undefined)?.rigor !== "full") errors.push("Full task requires persisted required_controls.rigor=full");
    const { contract, errors: contractErrors } = readStrategyContract(dir);
    errors.push(...contractErrors);
    if (contract) errors.push(...currentGateErrors(dir, record, "full-task-complete", requiredGates("full-task-complete", contract), contract, readKernel({ taskDir: dir }).kernel.gates as unknown as Record<string, unknown>));
    try { assertFullQualityForPhase(dir, extras, "archive"); }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  if (rigor === "parent") {
    errors.push(...parentArchiveErrors(dir, record));
    const parsed = fs.existsSync(path.join(dir, "implement.md")) ? readStrategyContract(dir) : { contract: null, errors: [] };
    errors.push(...parsed.errors);
    if (!parsed.errors.length) errors.push(...currentGateErrors(dir, record, "parent-integrated", requiredGates("parent-integrated", parsed.contract), parsed.contract, readKernel({ taskDir: dir }).kernel.gates as unknown as Record<string, unknown>));
  }
  if (typeof record.parent === "string" && record.parent) {
    const parentDir = path.join(path.dirname(dir), record.parent);
    const map = readTaskMap(parentDir).data;
    const state = map?.children.find((entry) => entry.id === path.basename(dir))?.state;
    if (state !== "integrated" && state !== "cancelled") errors.push(`child archive requires Parent integrated or cancelled state, got ${state ?? "missing"}`);
    if (state === "integrated") errors.push(...requiredFileErrors(dir, ["handoff.md"]));
  }
  if (fs.existsSync(path.join(dir, "verify.md"))) {
    const content = fs.readFileSync(path.join(dir, "verify.md"), "utf8");
    if (!hasEvidence(content, /^\s*(?:[-*]\s*)?validation(?:\s+(?:commands?|results?|evidence))?\s*:\s*(\S[^\r\n]*)$/gim)) {
      errors.push("verify.md missing validation evidence");
    }
    if (!hasEvidence(content, /^\s*(?:[-*]\s*)?(?:(?:final|user)\s+)?acceptance(?:\s+evidence)?\s*:\s*(\S[^\r\n]*)$/gim)
      && !hasEvidence(content, /^\s*(?:[-*]\s*)?accepted\s+by\s+user\s*:\s*(\S[^\r\n]*)$/gim)) {
      errors.push("verify.md missing final acceptance evidence");
    }
    if (rigor !== "lite") {
      if (!/\bno\s+durable\s+learning\b/i.test(content)
        && !hasEvidence(content, /^\s*(?:[-*]\s*)?(?:durable\s+learning(?:\s+decision)?|learning\s+decision|spec\s+updates?|spec\s+update\s+(?:needed|evidence)|updated\s+spec|retrospective(?:\.md)?|learning\s+artifact)\s*:\s*(\S[^\r\n]*)$/gim)) errors.push("verify.md missing durable-learning decision evidence");
      if (!hasEvidence(content, /^\s*(?:[-*]\s*)?(?:check\s+evidence|pactile-check(?:\s+evidence)?)\s*:\s*(\S[^\r\n]*)$/gim)) errors.push("verify.md missing check evidence");
      if (!hasEvidence(`${content}\n${fs.existsSync(path.join(dir, "handoff.md")) ? fs.readFileSync(path.join(dir, "handoff.md"), "utf8") : ""}`, /^\s*(?:[-*]\s*)?(?:reviewed\s+)?(?:change[- ]set|changeset|diff|git\s+diff|ref|git\s+ref)(?:\s+(?:identity|evidence|summary|ref))?\s*:\s*(\S[^\r\n]*)$/gim)) errors.push("verify.md or handoff.md missing reviewed change-set evidence");
    }
  }
  return { ok: errors.length === 0, errors };
}

function requiredFileErrors(dir: string, names: string[]): string[] {
  const errors: string[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) errors.push(name);
    else if (!fs.readFileSync(file, "utf8").trim()) errors.push(`${name} is empty`);
  }
  return errors;
}

function taskRigor(record: PactileTaskRecord, extras: Record<string, unknown>): "lite" | "full" | "parent" {
  const raw = record as unknown as Record<string, unknown>;
  const topology = raw.topology ?? extras.topology;
  if (topology && typeof topology === "object" && (topology as Record<string, unknown>).kind === "parent-child") return "parent";
  const controls = raw.required_controls ?? extras.required_controls;
  if (controls && typeof controls === "object" && (controls as Record<string, unknown>).rigor === "full") return "full";
  const meta = record.meta && typeof record.meta === "object" ? record.meta : {};
  const legacy = [raw.task_kind, raw.task_type, raw.kind, raw.mode, meta.task_kind, meta.task_type, meta.classification, meta.mode]
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.toLowerCase().replaceAll("_", "-"));
  if (legacy.some((item) => item.includes("parent"))) return "parent";
  if (legacy.some((item) => item.includes("full"))) return "full";
  return "lite";
}

function baselineSlots(dir: string, record: PactileTaskRecord): string[] {
  const raw = record as unknown as Record<string, unknown>;
  const extras = readKernel({ taskDir: dir }).kernel.projection?.extras ?? {};
  const block = raw.baseline_modules ?? extras.baseline_modules;
  if (!block || typeof block !== "object" || !("active" in block)) return BASELINE_EIGHT;
  const active = (block as Record<string, unknown>).active;
  return Array.isArray(active) ? active.filter((item): item is string => typeof item === "string") : [];
}

/** Check the Node lifecycle and dependency gates before execution starts. */
export function checkStartExecution(root: string, dir: string, record: PactileTaskRecord, _mutate = false, ignoreDeps = false): TaskGuard {
  const errors = requiredFileErrors(dir, ["prd.md"]);
  const active = new Set(baselineSlots(dir, record));
  for (const slot of REQUIRED_LIFECYCLE_SLOTS) if (!active.has(slot)) errors.push(`missing required lifecycle slot: ${slot}`);
  if (!["planning", "in_progress"].includes(record.status)) errors.push(`task status must be planning or in_progress, got ${record.status}`);
  const design = fs.existsSync(path.join(dir, "design.md"));
  const implement = fs.existsSync(path.join(dir, "implement.md"));
  if (design !== implement) errors.push("design.md and implement.md must be present together for Full Tasks");
  const extras = readKernel({ taskDir: dir }).kernel.projection?.extras ?? {};
  const rigor = taskRigor(record, extras);
  if (rigor === "full") {
    if ((extras.required_controls as Record<string, unknown> | undefined)?.rigor !== "full") errors.push("Full task requires persisted required_controls.rigor=full");
    const { contract, errors: contractErrors } = readStrategyContract(dir);
    errors.push(...contractErrors);
    if (contract) {
      for (const gate of requiredGates("start-execution", contract)) {
        if (gate === "requirements-review") {
          const prd = fs.existsSync(path.join(dir, "prd.md")) ? fs.readFileSync(path.join(dir, "prd.md"), "utf8") : "";
          if (!/^\s*#{1,6}\s*acceptance\s+criteria\s*$/im.test(prd) || !parseAcceptanceItems(prd).length) errors.push("prd.md needs a non-placeholder Acceptance Criteria checkbox for requirements-review");
        } else if (gate === "architecture-review") errors.push(...requiredFileErrors(dir, ["design.md", "implement.md"]));
      }
      errors.push(...currentGateErrors(dir, record, "start-execution", requiredGates("start-execution", contract),
        contract, readKernel({ taskDir: dir, cwd: root }).kernel.gates as unknown as Record<string, unknown>));
    }
    try { assertFullQualityForPhase(dir, extras, "start"); }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  if (rigor === "parent") {
    const map = readTaskMap(dir).data;
    if (!map) errors.push("task-map.md");
    else if (!record.children.every((id) => map.children.some((entry) => entry.id === id))) errors.push("task-map.md missing structural children");
    if (fs.existsSync(path.join(dir, "implement.md"))) errors.push(...readStrategyContract(dir).errors);
  }
  const status = dependencyStatus(root, dir, record);
  const warnings = status.warnings;
  const graph = readDependencyGraph(extras);
  const missing = unmetRequires(graph, status.satisfied, record.id);
  if (missing.length && !ignoreDeps) errors.push(`requires unmet: ${missing.join(", ")}`);
  if (missing.length && ignoreDeps) warnings.push(`explicit dependency override requested: ${missing.join(", ")}`);
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    ...startFingerprints(dir, record),
  };
}
