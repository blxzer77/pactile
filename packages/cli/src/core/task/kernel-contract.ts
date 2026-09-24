/**
 * Stage 1 Kernel Data Contract (P28 D05 / P30 Stage 1).
 *
 * Frozen here: record categories (identity, revision, 3D state, Transition
 * Request, atomic audit) and legal phase edges. Disk field names are an
 * implementation choice for this wave; user-visible `task.json.status`
 * enumerations are not switched.
 */

import {
  isPlainObject,
  taskRecordSchema,
  type PactileTaskRecord,
} from "./schema.js";
import {
  assuranceSatisfiesV1, policyWithinCeilingV1, parseResolvedProviderV1,
  decodePolicyCeilingV1, type PolicyCeilingV1, type ResolvedProviderV1,
} from "../pactile/provider.js";
import { parseTileManifestV1, tilePolicyCeilingV1, TILE_EVIDENCE_KINDS_V1, type TileEvidenceKindV1 } from "../pactile/tile.js";
import {
  ContractDecoderV1, PACTILE_FINGERPRINT_PATTERN, decodeOpaqueReferenceV1,
  fingerprintPactileContractV1,
} from "../pactile/validation.js";

/** Compatibility policy is supplied at the surface, never a registry in the store. */
export type KernelExtrasBoundary = (
  extras: Record<string, unknown>,
  record: { id?: string; parent?: string | null; children?: string[] },
  phase: "create" | "start" | "archive" | "patch",
) => void;

/** New host-neutral callers explicitly opt out of legacy projection defaults. */
export const neutralKernelExtrasBoundary: KernelExtrasBoundary = () => undefined;

export interface ProviderResolutionFact {
  readonly tileId: string;
  readonly authorized: boolean;
  readonly resolution: ResolvedProviderV1;
}

export interface EvidenceFact {
  readonly ref: string;
  readonly exists: boolean;
  readonly kind: TileEvidenceKindV1;
  readonly fingerprint: string;
}

export interface EvidenceFactPort {
  /** Lookup a logical handle only; no source body or credential arguments. */
  lookup(ref: string): EvidenceFact | null;
}

export interface CompositionValidationInput {
  /** Already compiled, model-selected order. This port never loads or sorts Tiles. */
  /** fingerprint is the M0 manifest decoder fingerprint, NOT a compiler/SKILL bundle fingerprint. */
  readonly tiles: readonly { readonly manifest: unknown; readonly fingerprint: string }[];
  readonly policyCeiling: PolicyCeilingV1;
  readonly providers: readonly ProviderResolutionFact[];
  readonly evidenceRefs?: readonly string[];
  readonly requireEvidence?: boolean;
  readonly attempts?: Readonly<Record<string, number>>;
}

export type CompositionReasonCode =
  | "invalid-composition" | "invalid-tile" | "fingerprint-mismatch" | "duplicate-tile"
  | "dependency-missing" | "dependency-order" | "tile-conflict" | "policy-exceeded"
  | "attempt-limit" | "provider-missing" | "provider-invalid" | "provider-unavailable"
  | "provider-unauthorized" | "provider-assurance" | "provider-policy"
  | "evidence-invalid" | "evidence-missing";

export interface CompositionValidationOutcome {
  readonly outcome: "accepted" | "rejected";
  readonly reasonCodes: readonly CompositionReasonCode[];
  readonly selectedTileIds: readonly string[];
  readonly fingerprint: string;
}

export interface CompositionValidationPort {
  validate(input: CompositionValidationInput, evidence?: EvidenceFactPort): CompositionValidationOutcome;
}

/** Pure contract validation: no catalog, provider selection/probe, host or filesystem. */
export function validateComposition(input: CompositionValidationInput, evidence?: EvidenceFactPort): CompositionValidationOutcome {
  try { return evaluateComposition(input, evidence); }
  catch {
    const value = { outcome: "rejected" as const, reasonCodes: ["invalid-composition" as const], selectedTileIds: [] };
    return { ...value, fingerprint: fingerprintPactileContractV1(value) };
  }
}

function evaluateComposition(input: CompositionValidationInput, evidence?: EvidenceFactPort): CompositionValidationOutcome {
  const reasons: CompositionReasonCode[] = [];
  const ids: string[] = [];
  const validatedFacts: string[] = [];
  const add = (code: CompositionReasonCode): void => { if (!reasons.includes(code)) reasons.push(code); };
  const finish = (): CompositionValidationOutcome => {
    const value = { outcome: reasons.length === 0 ? "accepted" as const : "rejected" as const, reasonCodes: reasons, selectedTileIds: ids };
    return { ...value, fingerprint: fingerprintPactileContractV1({ ...value, validatedFacts }) };
  };
  if (!input || !Array.isArray(input.tiles) || !Array.isArray(input.providers)) {
    add("invalid-composition"); return finish();
  }
  const policyDecoder = new ContractDecoderV1();
  const policy = decodePolicyCeilingV1(input.policyCeiling, policyDecoder, "$");
  if (policyDecoder.issues.length > 0) { add("invalid-composition"); return finish(); }
  validatedFacts.push(fingerprintPactileContractV1(policy));
  if ((input.evidenceRefs !== undefined && !Array.isArray(input.evidenceRefs)) ||
      (input.requireEvidence !== undefined && typeof input.requireEvidence !== "boolean") ||
      (input.attempts !== undefined && !isPlainObject(input.attempts))) {
    add("invalid-composition"); return finish();
  }
  // Use decoded manifests, not casts of caller-owned values.
  const decoded = input.tiles.flatMap((tile) => {
    try {
      const result = parseTileManifestV1(tile.manifest);
      if (!result.success) { add("invalid-tile"); return []; }
      if (tile.fingerprint !== result.fingerprint) add("fingerprint-mismatch");
      validatedFacts.push(result.fingerprint);
      const id = result.data.identity.id;
      if (ids.includes(id)) add("duplicate-tile");
      ids.push(id);
      return [result.data];
    } catch { add("invalid-tile"); return []; }
  });
  const observed = new Set<TileEvidenceKindV1>();
  for (const ref of input.evidenceRefs ?? []) {
    const decoder = new ContractDecoderV1();
    decodeOpaqueReferenceV1(ref, decoder, "$", ["evidence"]);
    if (decoder.issues.length > 0) { add("evidence-invalid"); continue; }
    try {
      const fact = evidence?.lookup(ref);
      if (fact?.exists !== true) add("evidence-missing");
      else if (fact.ref !== ref || !TILE_EVIDENCE_KINDS_V1.includes(fact.kind) || !PACTILE_FINGERPRINT_PATTERN.test(fact.fingerprint)) add("evidence-invalid");
      else { observed.add(fact.kind); validatedFacts.push(fact.fingerprint); }
    } catch { add("evidence-missing"); }
  }
  for (const [position, tile] of decoded.entries()) {
    for (const dependency of tile.dependencies) {
      const dependencyPosition = ids.indexOf(dependency);
      if (dependencyPosition < 0) add("dependency-missing");
      else if (dependencyPosition >= position) add("dependency-order");
    }
    if (tile.conflicts.some((conflict) => ids.includes(conflict))) add("tile-conflict");
    const tilePolicy = tilePolicyCeilingV1(tile);
    if (!policyWithinCeilingV1(tilePolicy, policy)) add("policy-exceeded");
    const attempts = input.attempts && Object.hasOwn(input.attempts, tile.identity.id)
      ? input.attempts[tile.identity.id] : 0;
    if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts >= tile.stop.maxAttempts) add("attempt-limit");
    if (input.requireEvidence && tile.evidence.some((need) => need.required && !observed.has(need.kind))) add("evidence-missing");
    for (const intent of tile.trigger.intents) {
      const facts = input.providers.filter((fact) => fact.tileId === tile.identity.id && fact.resolution?.intent === intent);
      if (facts.length !== 1) { add(facts.length === 0 ? "provider-missing" : "provider-invalid"); continue; }
      const fact = facts[0];
      if (fact.authorized !== true) add("provider-unauthorized");
      const result = parseResolvedProviderV1(fact.resolution);
      if (!result.success) { add("provider-invalid"); continue; }
      const provider = result.data;
      validatedFacts.push(result.fingerprint);
      if (provider.origin === "unsupported" || provider.readiness !== "ready") add("provider-unavailable");
      if (provider.assurance === null || !assuranceSatisfiesV1(provider.assurance, tile.minimumAssurance)) add("provider-assurance");
      if (provider.effectivePolicy === null || !policyWithinCeilingV1(provider.effectivePolicy, tilePolicy) || !policyWithinCeilingV1(provider.requestedPolicy, policy)) add("provider-policy");
      if (provider.fallbackFromProviderId !== null && (
        !tile.fallback.allowed || tile.fallback.policy === null || tile.fallback.minimumAssurance === null ||
        provider.assurance === null || !assuranceSatisfiesV1(provider.assurance, tile.fallback.minimumAssurance) ||
        provider.effectivePolicy === null || !policyWithinCeilingV1(provider.effectivePolicy, tilePolicyCeilingV1(tile.fallback.policy))
      )) add("provider-policy");
    }
  }
  if (input.providers.some((fact) => !decoded.some((tile) => tile.identity.id === fact.tileId && tile.trigger.intents.includes(fact.resolution.intent)))) add("provider-invalid");
  return finish();
}

export const compositionValidationPort: CompositionValidationPort = { validate: validateComposition };

export const KERNEL_SCHEMA_VERSION = 1 as const;

export const KERNEL_JSON_BASENAME = "kernel.json";

export const KERNEL_PHASES = [
  "open",
  "define",
  "approve",
  "execute",
  "verify",
  "integrate",
  "close",
] as const;

export type KernelPhase = (typeof KERNEL_PHASES)[number];

export const KERNEL_CONDITIONS = [
  "ready",
  "active",
  "waiting",
  "blocked",
] as const;

export type KernelCondition = (typeof KERNEL_CONDITIONS)[number];

export const KERNEL_OUTCOMES = ["completed", "cancelled", "failed"] as const;

export type KernelOutcome = (typeof KERNEL_OUTCOMES)[number];

export type KernelErrorCode =
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "REVISION_CONFLICT"
  | "INVALID_TRANSITION"
  | "GATE_HOOK_UNIMPLEMENTED"
  | "POLICY_HOOK_UNIMPLEMENTED"
  | "IDEMPOTENCY_MISMATCH"
  | "CORRUPT_STATE"
  | "LOCK_TIMEOUT"
  | "HALF_CONVERSION";

export class KernelError extends Error {
  readonly code: KernelErrorCode;

  constructor(code: KernelErrorCode, message: string) {
    super(message);
    this.name = "KernelError";
    this.code = code;
  }
}

export interface KernelState {
  phase: KernelPhase;
  condition: KernelCondition;
  outcome: KernelOutcome | null;
}

export interface KernelIdentity {
  taskId: string;
}

export interface KernelAuditEvent {
  id: string;
  at: string;
  actor: string;
  idempotencyKey: string;
  evidence: string | null;
  from: KernelState & { revision: number };
  to: KernelState & { revision: number };
}

export interface KernelGates {
  schemaVersion: 1;
  transitions: Record<string, Record<string, unknown>>;
}

export interface KernelLegacyProjection {
  status: string;
  record: PactileTaskRecord;
  extras: Record<string, unknown>;
}

export interface KernelSnapshot {
  schemaVersion: typeof KERNEL_SCHEMA_VERSION;
  identity: KernelIdentity;
  revision: number;
  phase: KernelPhase;
  condition: KernelCondition;
  outcome: KernelOutcome | null;
  audit: KernelAuditEvent[];
  gates: KernelGates;
  projection: KernelLegacyProjection | null;
}

export const KERNEL_COMMAND_OPS = [
  "read",
  "transition",
  "create",
  "start",
  "record-gate",
  "archive",
  "patch",
  "migrate",
  "inspect-projection",
  "repair-projection",
] as const;

export type KernelCommandOp = (typeof KERNEL_COMMAND_OPS)[number];

export interface TransitionRequest {
  taskDir: string;
  expectedRevision: number;
  targetPhase: KernelPhase;
  actor: string;
  idempotencyKey: string;
  evidence?: string;
  /** Stage 1 placeholder — if present, the transition is rejected (not fake-green). */
  gate?: unknown;
  /** Stage 1 placeholder — if present, the transition is rejected (not fake-green). */
  policy?: unknown;
  cwd?: string;
}

export interface LegacyTaskProjection {
  status: string;
  id: string;
  name: string;
  title: string;
}

/**
 * Legal Kernel phase edges for Stage 1. Integrate is optional (P28);
 * Close is reachable from Verify or Integrate. Condition/outcome are
 * derived from the target phase — they are not independently requested.
 */
export const KERNEL_PHASE_EDGES: readonly (readonly [KernelPhase, KernelPhase])[] =
  [
    ["open", "define"],
    ["define", "approve"],
    ["approve", "execute"],
    ["execute", "verify"],
    ["verify", "integrate"],
    ["verify", "close"],
    ["integrate", "close"],
  ];

const EDGE_SET: ReadonlySet<string> = new Set(
  KERNEL_PHASE_EDGES.map(([from, to]) => `${from}->${to}`),
);

const EXECUTE_PATH: readonly KernelPhase[] = [
  "open",
  "define",
  "approve",
  "execute",
];

const CLOSE_PATH: readonly KernelPhase[] = [
  "open",
  "define",
  "approve",
  "execute",
  "verify",
  "close",
];

export function emptyKernelGates(): KernelGates {
  return { schemaVersion: 1, transitions: {} };
}

export function isKernelPhase(value: unknown): value is KernelPhase {
  return (
    typeof value === "string" &&
    (KERNEL_PHASES as readonly string[]).includes(value)
  );
}

export function isKernelCondition(value: unknown): value is KernelCondition {
  return (
    typeof value === "string" &&
    (KERNEL_CONDITIONS as readonly string[]).includes(value)
  );
}

export function isKernelOutcome(value: unknown): value is KernelOutcome {
  return (
    typeof value === "string" &&
    (KERNEL_OUTCOMES as readonly string[]).includes(value)
  );
}

export function isLegalPhaseEdge(from: KernelPhase, to: KernelPhase): boolean {
  return EDGE_SET.has(`${from}->${to}`);
}

export function deriveStateForPhase(phase: KernelPhase): KernelState {
  switch (phase) {
    case "open":
    case "define":
      return { phase, condition: "ready", outcome: null };
    case "approve":
    case "verify":
    case "integrate":
      return { phase, condition: "waiting", outcome: null };
    case "execute":
      return { phase, condition: "active", outcome: null };
    case "close":
      return { phase, condition: "ready", outcome: "completed" };
  }
}

/**
 * Read-only projection of the legacy `task.json.status` enum onto Kernel
 * 3D state. Does not mutate user-visible status names.
 */
export function projectLegacyStatus(status: string): KernelState {
  switch (status) {
    case "planning":
      return deriveStateForPhase("define");
    case "in_progress":
      return deriveStateForPhase("execute");
    case "review":
      return deriveStateForPhase("verify");
    case "completed":
    case "done":
      return deriveStateForPhase("close");
    default:
      return deriveStateForPhase("open");
  }
}

/**
 * User-visible `task.json.status` names stay on the Stage 1 enum.
 * Approve maps to planning so start-execution is the only planning→in_progress cut.
 */
export function kernelPhaseToLegacyStatus(phase: KernelPhase): string {
  switch (phase) {
    case "open":
    case "define":
    case "approve":
      return "planning";
    case "execute":
      return "in_progress";
    case "verify":
    case "integrate":
      return "review";
    case "close":
      return "completed";
  }
}

export function hopsToExecute(from: KernelPhase): KernelPhase[] {
  if (from === "execute") return [];
  const index = EXECUTE_PATH.indexOf(from);
  if (index === -1) {
    throw new KernelError(
      "INVALID_TRANSITION",
      `cannot start-execution from Kernel phase ${from}`,
    );
  }
  return EXECUTE_PATH.slice(index + 1);
}

export function hopsToClose(from: KernelPhase): KernelPhase[] {
  if (from === "close") return [];
  if (from === "integrate") return ["close"];
  const index = CLOSE_PATH.indexOf(from);
  if (index === -1) {
    throw new KernelError(
      "INVALID_TRANSITION",
      `cannot archive/close from Kernel phase ${from}`,
    );
  }
  return CLOSE_PATH.slice(index + 1);
}

export function parseKernelSnapshot(input: unknown): KernelSnapshot {
  if (!isPlainObject(input)) {
    throw new KernelError("CORRUPT_STATE", "kernel snapshot must be a JSON object");
  }
  if (input.schemaVersion !== KERNEL_SCHEMA_VERSION) {
    throw new KernelError(
      "CORRUPT_STATE",
      `unsupported kernel schemaVersion: ${String(input.schemaVersion)}`,
    );
  }
  if (!isPlainObject(input.identity) || typeof input.identity.taskId !== "string") {
    throw new KernelError("CORRUPT_STATE", "kernel.identity.taskId must be a string");
  }
  if (!isNonNegativeInt(input.revision)) {
    throw new KernelError("CORRUPT_STATE", "kernel.revision must be a non-negative integer");
  }
  if (!isKernelPhase(input.phase)) {
    throw new KernelError("CORRUPT_STATE", "kernel.phase is invalid");
  }
  if (!isKernelCondition(input.condition)) {
    throw new KernelError("CORRUPT_STATE", "kernel.condition is invalid");
  }
  const outcome = parseOutcome(input.outcome);
  if (!Array.isArray(input.audit)) {
    throw new KernelError("CORRUPT_STATE", "kernel.audit must be an array");
  }
  return {
    schemaVersion: KERNEL_SCHEMA_VERSION,
    identity: { taskId: input.identity.taskId },
    revision: input.revision,
    phase: input.phase,
    condition: input.condition,
    outcome,
    audit: input.audit.map((event, index) => parseAuditEvent(event, index)),
    gates: parseGates(input.gates),
    projection: parseProjection(input.projection),
  };
}

function parseGates(input: unknown): KernelGates {
  if (input === undefined || input === null) return emptyKernelGates();
  if (!isPlainObject(input)) {
    throw new KernelError("CORRUPT_STATE", "kernel.gates must be an object");
  }
  const schemaVersion = input.schemaVersion === undefined ? 1 : input.schemaVersion;
  if (schemaVersion !== 1) {
    throw new KernelError(
      "CORRUPT_STATE",
      `unsupported kernel.gates.schemaVersion: ${String(schemaVersion)}`,
    );
  }
  const transitionsIn = input.transitions;
  if (transitionsIn === undefined || transitionsIn === null) {
    return emptyKernelGates();
  }
  if (!isPlainObject(transitionsIn)) {
    throw new KernelError("CORRUPT_STATE", "kernel.gates.transitions must be an object");
  }
  const transitions: Record<string, Record<string, unknown>> = {};
  for (const [transition, gates] of Object.entries(transitionsIn)) {
    if (!isPlainObject(gates)) {
      throw new KernelError(
        "CORRUPT_STATE",
        `kernel.gates.transitions.${transition} must be an object`,
      );
    }
    Object.defineProperty(transitions, transition, {
      value: { ...gates }, enumerable: true, configurable: true, writable: true,
    });
  }
  return { schemaVersion: 1, transitions };
}

function parseProjection(input: unknown): KernelLegacyProjection | null {
  if (input === undefined || input === null) return null;
  if (!isPlainObject(input)) {
    throw new KernelError("CORRUPT_STATE", "kernel.projection must be an object");
  }
  if (typeof input.status !== "string" || input.status.trim() === "") {
    throw new KernelError("CORRUPT_STATE", "kernel.projection.status must be a string");
  }
  const extras =
    input.extras === undefined || input.extras === null
      ? {}
      : isPlainObject(input.extras)
        ? { ...input.extras }
        : (() => {
            throw new KernelError(
              "CORRUPT_STATE",
              "kernel.projection.extras must be an object",
            );
          })();
  try {
    return {
      status: input.status,
      record: taskRecordSchema.parse(input.record),
      extras,
    };
  } catch (err) {
    throw new KernelError(
      "CORRUPT_STATE",
      `kernel.projection.record is invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function parseOutcome(value: unknown): KernelOutcome | null {
  if (value === null) return null;
  if (isKernelOutcome(value)) return value;
  throw new KernelError("CORRUPT_STATE", "kernel.outcome is invalid");
}

function parseAuditEvent(input: unknown, index: number): KernelAuditEvent {
  if (!isPlainObject(input)) {
    throw new KernelError("CORRUPT_STATE", `kernel.audit[${index}] must be an object`);
  }
  if (typeof input.id !== "string" || typeof input.at !== "string") {
    throw new KernelError("CORRUPT_STATE", `kernel.audit[${index}] is missing id/at`);
  }
  if (typeof input.actor !== "string" || typeof input.idempotencyKey !== "string") {
    throw new KernelError(
      "CORRUPT_STATE",
      `kernel.audit[${index}] is missing actor/idempotencyKey`,
    );
  }
  const evidence =
    input.evidence === null || input.evidence === undefined
      ? null
      : typeof input.evidence === "string"
        ? input.evidence
        : (() => {
            throw new KernelError(
              "CORRUPT_STATE",
              `kernel.audit[${index}].evidence must be a string or null`,
            );
          })();
  return {
    id: input.id,
    at: input.at,
    actor: input.actor,
    idempotencyKey: input.idempotencyKey,
    evidence,
    from: parseStateRevision(input.from, `kernel.audit[${index}].from`),
    to: parseStateRevision(input.to, `kernel.audit[${index}].to`),
  };
}

function parseStateRevision(
  input: unknown,
  path: string,
): KernelState & { revision: number } {
  if (!isPlainObject(input)) {
    throw new KernelError("CORRUPT_STATE", `${path} must be an object`);
  }
  if (!isKernelPhase(input.phase)) {
    throw new KernelError("CORRUPT_STATE", `${path}.phase is invalid`);
  }
  if (!isKernelCondition(input.condition)) {
    throw new KernelError("CORRUPT_STATE", `${path}.condition is invalid`);
  }
  if (!isNonNegativeInt(input.revision)) {
    throw new KernelError("CORRUPT_STATE", `${path}.revision is invalid`);
  }
  return {
    phase: input.phase,
    condition: input.condition,
    outcome: parseOutcome(input.outcome),
    revision: input.revision,
  };
}

export function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new KernelError("INVALID_REQUEST", `${field} must be a non-empty string`);
  }
  return value;
}

export function hookIsPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}
