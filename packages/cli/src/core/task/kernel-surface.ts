/**
 * Read-only Kernel surface for humans and agents.
 *
 * Dashboard and other projections should use {@link projectKernelSurface}
 * (`phase` / `condition` / `outcome` + human title). `task.json.status`
 * stays a compatibility machine field — this module never deletes it.
 */

import {
  type KernelExtrasBoundary,
  type KernelSnapshot,
  deriveStateForPhase,
  isKernelCondition,
  isKernelOutcome,
  isKernelPhase,
  kernelPhaseToLegacyStatus,
  projectLegacyStatus,
  type KernelCondition,
  type KernelOutcome,
  type KernelPhase,
  type KernelState,
} from "./kernel-contract.js";
import { normalizeStage5InExtrasAndAssert } from "./ondemand-topology.js";
import { normalizeStage6InExtrasAndAssert } from "./adapter-middleware.js";
import { isPlainObject, taskRecordSchema, TASK_RECORD_FIELD_ORDER } from "./schema.js";
import { fingerprintPactileContractV1 } from "../pactile/validation.js";
import { createHash } from "node:crypto";

/**
 * Legacy projection boundary only. Old module/provider catalogs must not leak
 * into neutral validation or store business logic. This adapter normalizes an
 * owned in-memory copy; it does not discover catalogs or write files.
 */
export const legacyKernelExtrasBoundary: KernelExtrasBoundary = (extras, record, phase) => {
  normalizeStage5InExtrasAndAssert(extras, record, phase);
  normalizeStage6InExtrasAndAssert(extras, phase);
};

export interface ProjectionInspection {
  readonly status: "in-sync" | "missing" | "drifted" | "malformed";
  readonly canonicalRevision: number;
  readonly expectedFingerprint: string;
  /** Exact observed bytes, including foreign keys and whitespace, for repair CAS. */
  readonly currentFingerprint: string | null;
}

export interface ProjectionRepairReceipt {
  readonly status: "repaired" | "in-sync" | "cas-mismatch";
  readonly canonicalRevision: number;
  readonly beforeFingerprint: string | null;
  readonly afterFingerprint: string | null;
}

export interface TaskProjectionPort {
  inspect(): ProjectionInspection;
  repair(expected: { canonicalRevision: number; currentFingerprint: string | null }): ProjectionRepairReceipt;
}

export function projectionBytesFingerprint(raw: string | Uint8Array | null): string | null {
  return raw === null ? null : `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

/** Canonical fields win even when an old extras object contains a duplicate. */
export function expectedTaskProjection(canonical: KernelSnapshot): Record<string, unknown> {
  if (!canonical.projection) throw new Error("PACTILE_PROJECTION_CANONICAL_MISSING");
  return { ...canonical.projection.extras, ...canonical.projection.record, status: canonical.projection.status };
}

/** Pure read-only comparison. Foreign keys are preserved, not claimed by Kernel. */
export function inspectProjection(canonical: KernelSnapshot, current: string | Uint8Array | null): ProjectionInspection {
  const expected = expectedTaskProjection(canonical);
  const base = {
    canonicalRevision: canonical.revision,
    expectedFingerprint: fingerprintPactileContractV1(expected),
    currentFingerprint: projectionBytesFingerprint(current),
  };
  if (current === null) return { ...base, status: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof current === "string" ? current : Buffer.from(current).toString("utf8"));
    if (!isPlainObject(parsed)) return { ...base, status: "malformed" };
    taskRecordSchema.parse(parsed);
  } catch { return { ...base, status: "malformed" }; }
  const owned: Record<string, unknown> = Object.fromEntries(
    [...new Set([...TASK_RECORD_FIELD_ORDER, ...Object.keys(expected)])]
      .filter((key) => Object.hasOwn(parsed, key))
      .map((key) => [key, parsed[key]]),
  );
  return { ...base, status: fingerprintPactileContractV1(owned) === base.expectedFingerprint ? "in-sync" : "drifted" };
}

export type KernelSurfaceLocale = "en" | "zh";

export const KERNEL_PHASE_HUMAN_EN: Readonly<Record<KernelPhase, string>> = {
  open: "Open",
  define: "Define",
  approve: "Approve",
  execute: "Execute",
  verify: "Verify",
  integrate: "Integrate",
  close: "Close",
};

export const KERNEL_PHASE_HUMAN_ZH: Readonly<Record<KernelPhase, string>> = {
  open: "打开",
  define: "定义",
  approve: "批准",
  execute: "执行",
  verify: "验证",
  integrate: "集成",
  close: "关闭",
};

export interface KernelSurfaceInput {
  phase?: unknown;
  condition?: unknown;
  outcome?: unknown;
  /** Legacy `task.json.status`; kept on the projection, never stripped. */
  status?: string | null;
  /** Topology kind (`single` | `parent-child`). Integrate is optional. */
  topologyKind?: string | null;
  locale?: KernelSurfaceLocale;
}

export interface KernelSurfaceProjection extends KernelState {
  /** Compatibility machine field mirrored from `task.json.status`. */
  status: string;
  /** Dashboard / agent section title (Open/Define/… or zh). */
  humanPhase: string;
  /** True when Integrate is a real lifecycle slot for this task. */
  showIntegrate: boolean;
}

export function kernelPhaseHumanTitle(
  phase: KernelPhase,
  locale: KernelSurfaceLocale = "en",
): string {
  return locale === "zh"
    ? KERNEL_PHASE_HUMAN_ZH[phase]
    : KERNEL_PHASE_HUMAN_EN[phase];
}

export function topologyNeedsIntegrate(
  topologyKind: string | null | undefined,
): boolean {
  return topologyKind === "parent-child";
}

/**
 * Stable read-only 3D Kernel projection plus human phase title.
 *
 * Prefers an explicit Kernel `phase` when valid; otherwise maps the
 * legacy status enum. Does not mutate disk.
 */
export function projectKernelSurface(
  input: KernelSurfaceInput = {},
): KernelSurfaceProjection {
  const locale = input.locale ?? "en";
  const state = resolveSurfaceState(input);
  const status =
    typeof input.status === "string" && input.status.trim() !== ""
      ? input.status
      : kernelPhaseToLegacyStatus(state.phase);
  return {
    ...state,
    status,
    humanPhase: kernelPhaseHumanTitle(state.phase, locale),
    showIntegrate:
      state.phase === "integrate" ||
      topologyNeedsIntegrate(input.topologyKind),
  };
}

function resolveSurfaceState(input: KernelSurfaceInput): KernelState {
  if (isKernelPhase(input.phase)) {
    const derived = deriveStateForPhase(input.phase);
    const condition: KernelCondition = isKernelCondition(input.condition)
      ? input.condition
      : derived.condition;
    const outcome: KernelOutcome | null = resolveOutcome(
      input.outcome,
      derived.outcome,
    );
    return { phase: input.phase, condition, outcome };
  }
  return projectLegacyStatus(
    typeof input.status === "string" ? input.status : "",
  );
}

function resolveOutcome(
  value: unknown,
  fallback: KernelOutcome | null,
): KernelOutcome | null {
  if (value === undefined) return fallback;
  if (value === null || isKernelOutcome(value)) return value;
  return fallback;
}
