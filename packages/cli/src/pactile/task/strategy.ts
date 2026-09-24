import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PactileTaskRecord } from "@blxzer/pactile-core/task";

export interface StrategyContract {
  execution_mode: string;
  isolation: string;
  verification_profile: string;
  retrieval_profile: string;
  optional_capabilities: string[];
  quality_gates: { mode: string; profile?: string; enabled?: string[] };
}

const MODES = new Set(["inline", "worker", "child-task"]);
const ISOLATION = new Set(["main-worktree", "git-worktree"]);
const VERIFICATION = new Set(["standard", "strict", "architecture"]);
const RETRIEVAL = new Set(["exact-only", "semantic", "structure", "architecture-memory"]);
const GATES = new Set(["requirements-review", "code-review", "architecture-review", "architecture-deep-review", "integration-review"]);
const TOP_LEVEL = new Set(["execution_mode", "isolation", "verification_profile", "retrieval_profile", "optional_capabilities", "quality_gates"]);

function inlineList(value: string): string[] {
  const cleaned = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  return cleaned ? cleaned.split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean) : [];
}

/** Parse only the documented Development Strategy Contract block of implement.md. */
export function readStrategyContract(dir: string): { contract: StrategyContract | null; errors: string[] } {
  const file = path.join(dir, "implement.md");
  if (!fs.existsSync(file)) return { contract: null, errors: ["implement.md"] };
  const values: Record<string, unknown> = {};
  let section = "";
  let listKey = "";
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#") || stripped.startsWith("```")) continue;
    const top = stripped.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (top && TOP_LEVEL.has(top[1])) {
      const [, key, raw] = top;
      section = key === "quality_gates" ? key : "";
      listKey = key === "optional_capabilities" && !raw ? key : "";
      if (key === "quality_gates") values[key] = {};
      else if (key === "optional_capabilities") values[key] = raw ? inlineList(raw) : [];
      else values[key] = raw.trim();
      continue;
    }
    const nested = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (nested && section === "quality_gates") {
      const gateConfig = values.quality_gates as Record<string, unknown>;
      const key = nested[1];
      const raw = nested[2].trim();
      gateConfig[key] = key === "enabled" ? inlineList(raw) : raw;
      listKey = key === "enabled" && !raw ? "quality_gates.enabled" : "";
      continue;
    }
    const item = line.match(/^\s*-\s+(.+)$/);
    if (item && listKey === "optional_capabilities") (values.optional_capabilities as string[]).push(item[1].trim());
    else if (item && listKey === "quality_gates.enabled") ((values.quality_gates as Record<string, unknown>).enabled as string[]).push(item[1].trim());
  }
  const errors: string[] = [];
  for (const key of TOP_LEVEL) if (!(key in values)) errors.push(`Development Strategy Contract missing ${key}`);
  if (values.execution_mode && !MODES.has(String(values.execution_mode))) errors.push(`invalid execution_mode: ${values.execution_mode}`);
  if (values.isolation && !ISOLATION.has(String(values.isolation))) errors.push(`invalid isolation: ${values.isolation}`);
  if (values.verification_profile && !VERIFICATION.has(String(values.verification_profile))) errors.push(`invalid verification_profile: ${values.verification_profile}`);
  if (values.retrieval_profile && !RETRIEVAL.has(String(values.retrieval_profile))) errors.push(`invalid retrieval_profile: ${values.retrieval_profile}`);
  const quality = values.quality_gates as Record<string, unknown> | undefined;
  if (quality) {
    if (quality.mode !== "profile" && quality.mode !== "explicit") errors.push("quality_gates.mode must be profile or explicit");
    if (quality.profile && !VERIFICATION.has(String(quality.profile))) errors.push(`invalid quality_gates.profile: ${quality.profile}`);
    if (quality.mode === "explicit" && !Array.isArray(quality.enabled)) errors.push("quality_gates.enabled is required in explicit mode");
    if (Array.isArray(quality.enabled)) for (const gate of quality.enabled) if (!GATES.has(String(gate))) errors.push(`invalid quality gate: ${gate}`);
  }
  return { contract: errors.length ? null : values as unknown as StrategyContract, errors };
}

export function requiredGates(transition: "start-execution" | "full-task-complete" | "child-review" | "parent-integrated", contract: StrategyContract | null): string[] {
  if (transition === "parent-integrated") return ["integration-review"];
  const quality = contract?.quality_gates;
  const profile = quality?.profile ?? contract?.verification_profile ?? "standard";
  const enabled = quality?.mode === "explicit" ? quality.enabled ?? [] :
    profile === "architecture" ? ["requirements-review", "architecture-review", "code-review"] : ["requirements-review", "code-review"];
  if (transition === "start-execution") return ["requirements-review", ...(enabled.includes("architecture-review") ? ["architecture-review"] : [])];
  return ["code-review", ...["architecture-review", "architecture-deep-review"].filter((gate) => enabled.includes(gate))];
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)]));
  return value;
}

export function gateFingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex")}`;
}

const STABLE_KEYS = ["id", "name", "title", "description", "status", "dev_type", "scope", "package", "priority", "creator", "assignee", "parent", "children", "subtasks", "relatedFiles", "notes", "meta", "branch", "base_branch"];

export function contractFingerprint(dir: string, record: PactileTaskRecord, contract: StrategyContract | null): string {
  const stable = Object.fromEntries(STABLE_KEYS.map((key) => [key, (record as unknown as Record<string, unknown>)[key]]));
  return gateFingerprint({ schema_version: 1, task_dir: path.basename(dir), stable_task: stable, strategy_contract: contract ?? {} });
}

export function artifactFingerprint(dir: string, record: PactileTaskRecord, transition: string, gate: string): string {
  const files = transition === "start-execution" ? ["prd.md", "design.md", "implement.md"] :
    transition === "full-task-complete" ? ["prd.md", "design.md", "implement.md", "verify.md"] :
    transition === "child-review" ? ["prd.md", "design.md", "implement.md", "verify.md", "handoff.md"] :
    transition === "parent-integrated" ? ["task-map.md", "verify.md"] : ["prd.md", "verify.md"];
  return gateFingerprint({ schema_version: 1, transition, gate, task_dir: path.basename(dir), record_id: record.id,
    files: files.map((name) => ({ path: name, content: fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), "utf8") : null })) });
}

export function currentGateErrors(dir: string, record: PactileTaskRecord, transition: string, gates: string[], contract: StrategyContract | null, records: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const expectedContract = contractFingerprint(dir, record, contract);
  const transitions = records.transitions && typeof records.transitions === "object" ? records.transitions as Record<string, unknown> : {};
  const transitionRecords = transitions[transition] && typeof transitions[transition] === "object" ? transitions[transition] as Record<string, unknown> : {};
  for (const gate of gates) {
    const raw = transitionRecords[gate];
    if (!raw || typeof raw !== "object") { errors.push(`missing gate record: ${transition}/${gate}`); continue; }
    const entry = raw as Record<string, unknown>;
    if (entry.result !== "PASS" && !(entry.result === "SKIPPED" && (entry.approved_skip as Record<string, unknown> | undefined)?.approved_by === "user")) errors.push(`gate not passed: ${transition}/${gate}`);
    if (entry.contract_fingerprint !== expectedContract) errors.push(`stale gate contract: ${transition}/${gate}`);
    if (entry.artifact_fingerprint !== artifactFingerprint(dir, record, transition, gate)) errors.push(`stale gate artifact: ${transition}/${gate}`);
  }
  return errors;
}
