/**
 * Stage 4 Full Quality contract (P28 Artifact/Quality, P29 Full Check, P30 S4).
 *
 * Pure helpers: resolve required_controls, AC → Evidence ledger, graded
 * Independent Check. Does not write Kernel store or task.json. Disk field
 * names here are an implementation choice — not a frozen Manifest schema.
 * Fingerprints are a testable sha256 fixture, not a locked algorithm.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { KernelError } from "./kernel-contract.js";
import { isPlainObject } from "./schema.js";

export const FULL_QUALITY_SOURCE = "full-quality-contract";
export const FULL_QUALITY_SCHEMA_VERSION = 1 as const;

export const FULL_BASELINE_CONTROLS = [
  "definition",
  "execution-contract",
  "verification-plan",
  "evidence",
  "independent-check",
] as const;

export const FULL_OPTIONAL_CONTROLS = ["design"] as const;

export const DEFAULT_CONTROL_SURFACES: Record<string, string> = {
  definition: "prd.md",
  "execution-contract": "implement.md",
  "verification-plan": "implement.md",
  evidence: "verify.md",
  design: "design.md",
};

export const DESIGN_RISK_SIGNALS = [
  "architecture",
  "public-contract",
  "schema",
  "security",
  "secret",
  "framework-semantics",
  "runtime-semantics",
] as const;

const START_FILE_CONTROLS = new Set([
  "definition",
  "execution-contract",
  "verification-plan",
  "design",
]);

const ARCHIVE_FILE_CONTROLS = new Set([
  "definition",
  "execution-contract",
  "verification-plan",
  "evidence",
  "design",
]);

const PLACEHOLDER_VALUE_RE = /^(TBD|TODO|待定|待补充|N\/?A|NA|NONE|-|\.\.\.)$/i;
const AC_ITEM_RE = /^\s*-\s*\[[ xX]\]\s+(.+)$/gm;

export type FullQualityRigor = "lite" | "full";
export type FullQualityPhase = "start" | "archive";
export type IndependentCheckMode = "self-review" | "true-independent";
export type IndependentCheckResult = "PASS" | "FAIL" | "BLOCKED";

export type FullQualityControlId =
  | (typeof FULL_BASELINE_CONTROLS)[number]
  | (typeof FULL_OPTIONAL_CONTROLS)[number];

export interface ResolveRequiredControlsInput {
  rigor?: FullQualityRigor;
  verificationProfile?: string | null;
  riskSignals?: readonly string[];
  policyRequiresDesign?: boolean;
  explicitControls?: readonly string[];
  surfaces?: Record<string, string>;
}

export interface RequiredControlsBundle {
  schema_version: typeof FULL_QUALITY_SCHEMA_VERSION;
  source: typeof FULL_QUALITY_SOURCE;
  rigor: FullQualityRigor;
  controls: string[];
  surfaces: Record<string, string>;
  resolved_from: {
    verification_profile: string | null;
    risk_signals: string[];
    policy_requires_design: boolean;
  };
}

export interface AcceptanceItem {
  id: string;
  statement: string;
}

export interface AcEvidenceMapping {
  ac_id: string;
  evidence_ref: string;
}

export interface AcEvidenceLedger {
  schema_version: typeof FULL_QUALITY_SCHEMA_VERSION;
  items: AcEvidenceMapping[];
  source_fingerprint: string;
  evidence_fingerprint: string;
  tested_code_fingerprint?: string;
}

export interface IndependentCheckVerdict {
  schema_version: typeof FULL_QUALITY_SCHEMA_VERSION;
  mode: IndependentCheckMode;
  readonly: true;
  result: IndependentCheckResult;
  evidence: string;
  independent_worker: boolean;
  code_fingerprint: string;
}

export interface EvaluateIndependentCheckInput {
  mode: IndependentCheckMode;
  independentWorkerAvailable: boolean;
  evidence: string;
  codeFingerprint: string;
  attemptedWrites?: boolean;
}

export function qualityFingerprint(payload: string): string {
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

export function resolveRequiredControls(
  input: ResolveRequiredControlsInput = {},
): RequiredControlsBundle {
  const rigor: FullQualityRigor = input.rigor === "full" ? "full" : "lite";
  const profile =
    typeof input.verificationProfile === "string" &&
    input.verificationProfile.trim() !== ""
      ? input.verificationProfile.trim()
      : null;
  const riskSignals = (input.riskSignals ?? []).map((signal) =>
    signal.trim().toLowerCase(),
  );
  const policyRequiresDesign = input.policyRequiresDesign === true;
  const designRequired =
    rigor === "full" &&
    (policyRequiresDesign ||
      profile === "architecture" ||
      riskSignals.some((signal) =>
        (DESIGN_RISK_SIGNALS as readonly string[]).includes(signal),
      ));

  let controls: string[];
  if (input.explicitControls && input.explicitControls.length > 0) {
    controls = uniqueControls(input.explicitControls);
  } else if (rigor === "full") {
    controls = [...FULL_BASELINE_CONTROLS];
    if (designRequired) controls.push("design");
  } else {
    controls = ["definition", "evidence"];
  }

  if (designRequired && !controls.includes("design")) {
    controls = [...controls, "design"];
  }

  return {
    schema_version: FULL_QUALITY_SCHEMA_VERSION,
    source: FULL_QUALITY_SOURCE,
    rigor,
    controls,
    surfaces: {
      ...DEFAULT_CONTROL_SURFACES,
      ...(input.surfaces ?? {}),
    },
    resolved_from: {
      verification_profile: profile,
      risk_signals: riskSignals,
      policy_requires_design: policyRequiresDesign,
    },
  };
}

export function parseAcceptanceItems(prdText: string): AcceptanceItem[] {
  const items: AcceptanceItem[] = [];
  AC_ITEM_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = AC_ITEM_RE.exec(prdText)) !== null) {
    const statement = match[1]?.trim() ?? "";
    if (!statement || PLACEHOLDER_VALUE_RE.test(statement)) continue;
    index += 1;
    items.push({ id: `AC-${index}`, statement });
  }
  return items;
}

export function buildAcEvidenceLedger(input: {
  acceptanceItems: readonly AcceptanceItem[];
  mappings: readonly AcEvidenceMapping[];
  sourceFingerprint: string;
  evidenceFingerprint: string;
  testedCodeFingerprint?: string;
}): AcEvidenceLedger {
  const byId = new Map(
    input.mappings.map((mapping) => [mapping.ac_id, mapping] as const),
  );
  const items: AcEvidenceMapping[] = [];
  for (const ac of input.acceptanceItems) {
    const mapping = byId.get(ac.id);
    if (!mapping || mapping.evidence_ref.trim() === "") {
      throw new KernelError(
        "INVALID_REQUEST",
        `AC → Evidence ledger missing mapping for ${ac.id}`,
      );
    }
    if (PLACEHOLDER_VALUE_RE.test(mapping.evidence_ref.trim())) {
      throw new KernelError(
        "INVALID_REQUEST",
        `AC → Evidence ledger placeholder mapping for ${ac.id} (no fake-green)`,
      );
    }
    items.push({
      ac_id: ac.id,
      evidence_ref: mapping.evidence_ref.trim(),
    });
  }
  return {
    schema_version: FULL_QUALITY_SCHEMA_VERSION,
    items,
    source_fingerprint: input.sourceFingerprint,
    evidence_fingerprint: input.evidenceFingerprint,
    tested_code_fingerprint: input.testedCodeFingerprint,
  };
}

export function evaluateIndependentCheck(
  input: EvaluateIndependentCheckInput,
): IndependentCheckVerdict {
  if (input.attemptedWrites) {
    throw new KernelError(
      "INVALID_REQUEST",
      "Independent Check is read-only; repairs return to Execute",
    );
  }
  const evidence = input.evidence.trim();
  if (input.mode === "true-independent" && !input.independentWorkerAvailable) {
    return {
      schema_version: FULL_QUALITY_SCHEMA_VERSION,
      mode: "true-independent",
      readonly: true,
      result: "BLOCKED",
      evidence,
      independent_worker: false,
      code_fingerprint: input.codeFingerprint,
    };
  }
  if (evidence === "" || PLACEHOLDER_VALUE_RE.test(evidence)) {
    throw new KernelError(
      "INVALID_REQUEST",
      "Independent Check PASS/FAIL requires non-empty evidence (no fake-green)",
    );
  }
  return {
    schema_version: FULL_QUALITY_SCHEMA_VERSION,
    mode: input.mode,
    readonly: true,
    result: "PASS",
    evidence,
    independent_worker: input.independentWorkerAvailable,
    code_fingerprint: input.codeFingerprint,
  };
}

export function readRequiredControls(
  extras: Record<string, unknown>,
): RequiredControlsBundle | null {
  const raw = extras.required_controls;
  if (raw === undefined || raw === null) return null;
  return normalizeRequiredControls(raw);
}

export function normalizeRequiredControls(raw: unknown): RequiredControlsBundle {
  if (!isPlainObject(raw)) {
    throw new KernelError(
      "INVALID_REQUEST",
      "required_controls must be a JSON object",
    );
  }
  const rigor = raw.rigor === "full" ? "full" : raw.rigor === "lite" ? "lite" : null;
  if (rigor === null) {
    throw new KernelError(
      "INVALID_REQUEST",
      "required_controls.rigor must be lite or full",
    );
  }
  const controlsIn = raw.controls;
  const controls = Array.isArray(controlsIn)
    ? uniqueControls(
        controlsIn.filter((item): item is string => typeof item === "string"),
      )
    : rigor === "full"
      ? [...FULL_BASELINE_CONTROLS]
      : ["definition", "evidence"];
  const surfaces =
    isPlainObject(raw.surfaces) &&
    Object.values(raw.surfaces).every((value) => typeof value === "string")
      ? {
          ...DEFAULT_CONTROL_SURFACES,
          ...(raw.surfaces as Record<string, string>),
        }
      : { ...DEFAULT_CONTROL_SURFACES };
  const resolved =
    isPlainObject(raw.resolved_from) ? raw.resolved_from : {};
  return {
    schema_version: FULL_QUALITY_SCHEMA_VERSION,
    source: FULL_QUALITY_SOURCE,
    rigor,
    controls,
    surfaces,
    resolved_from: {
      verification_profile:
        typeof resolved.verification_profile === "string"
          ? resolved.verification_profile
          : null,
      risk_signals: Array.isArray(resolved.risk_signals)
        ? resolved.risk_signals.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
      policy_requires_design: resolved.policy_requires_design === true,
    },
  };
}

export function normalizeRequiredControlsInExtras(
  extras: Record<string, unknown>,
): void {
  if (extras.required_controls === undefined || extras.required_controls === null) {
    extras.required_controls = resolveRequiredControls({ rigor: "lite" });
    return;
  }
  extras.required_controls = normalizeRequiredControls(extras.required_controls);
}

export function assertFullQualityForPhase(
  taskDir: string,
  extras: Record<string, unknown>,
  phase: FullQualityPhase,
  options: { testedCodeFingerprint?: string } = {},
): void {
  const bundle = readRequiredControls(extras);
  if (bundle?.rigor !== "full") return;

  const fileControls = phase === "start" ? START_FILE_CONTROLS : ARCHIVE_FILE_CONTROLS;
  assertControlSurfaces(taskDir, bundle, fileControls);

  if (phase === "start") return;

  assertArchiveEvidenceNotPlaceholder(taskDir, bundle);
  assertAcEvidenceLedgerFresh(taskDir, bundle, extras, options);
  assertIndependentCheckForClose(extras, options);
}

export function assertIndependentCheckGateRecord(
  record: Record<string, unknown>,
): void {
  const mode = readCheckMode(record.mode ?? record.assurance);
  if (record.readonly === false) {
    throw new KernelError(
      "INVALID_REQUEST",
      "Independent Check is read-only; repairs return to Execute",
    );
  }
  if (mode === "true-independent" && record.independent_worker !== true) {
    throw new KernelError(
      "INVALID_REQUEST",
      "true-independent Check cannot be satisfied without an independent worker",
    );
  }
}

function assertControlSurfaces(
  taskDir: string,
  bundle: RequiredControlsBundle,
  fileControls: ReadonlySet<string>,
): void {
  const seen = new Set<string>();
  for (const control of bundle.controls) {
    if (!fileControls.has(control)) continue;
    const relative = bundle.surfaces[control] ?? DEFAULT_CONTROL_SURFACES[control];
    if (!relative) continue;
    if (seen.has(relative)) continue;
    seen.add(relative);
    const file = path.join(taskDir, relative);
    if (!fs.existsSync(file)) {
      throw new KernelError(
        "INVALID_REQUEST",
        `Full required control ${control} missing surface ${relative}`,
      );
    }
    const text = fs.readFileSync(file, "utf-8").trim();
    if (text === "") {
      throw new KernelError(
        "INVALID_REQUEST",
        `Full required control ${control} has empty surface ${relative}`,
      );
    }
  }
}

function assertArchiveEvidenceNotPlaceholder(
  taskDir: string,
  bundle: RequiredControlsBundle,
): void {
  if (!bundle.controls.includes("evidence")) return;
  const relative = bundle.surfaces.evidence ?? DEFAULT_CONTROL_SURFACES.evidence;
  const file = path.join(taskDir, relative);
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf-8");
  const validation = text.match(
    /validation(?:\s+(?:commands?|results?|evidence))?\s*:\s*(\S[^\r\n]*)/i,
  );
  const value = validation?.[1]?.trim() ?? "";
  if (!value || PLACEHOLDER_VALUE_RE.test(value)) {
    throw new KernelError(
      "INVALID_REQUEST",
      `${relative} looks like placeholder evidence (no fake-green)`,
    );
  }
}

function assertAcEvidenceLedgerFresh(
  taskDir: string,
  bundle: RequiredControlsBundle,
  extras: Record<string, unknown>,
  options: { testedCodeFingerprint?: string },
): void {
  const raw = extras.ac_evidence_ledger;
  if (!isPlainObject(raw)) {
    throw new KernelError(
      "INVALID_REQUEST",
      "Full Close requires a machine-readable AC → Evidence ledger",
    );
  }
  const definitionPath =
    bundle.surfaces.definition ?? DEFAULT_CONTROL_SURFACES.definition;
  const evidencePath = bundle.surfaces.evidence ?? DEFAULT_CONTROL_SURFACES.evidence;
  const prdText = readOptional(taskDir, definitionPath);
  const acceptance = parseAcceptanceItems(prdText);
  if (acceptance.length === 0) {
    throw new KernelError(
      "INVALID_REQUEST",
      `${definitionPath} has no Acceptance Criteria items to map`,
    );
  }
  const mappings = Array.isArray(raw.items)
    ? raw.items
        .filter(isPlainObject)
        .map((item) => ({
          ac_id: typeof item.ac_id === "string" ? item.ac_id : "",
          evidence_ref:
            typeof item.evidence_ref === "string" ? item.evidence_ref : "",
        }))
    : [];
  const currentSource = qualityFingerprint(prdText);
  const currentEvidence = qualityFingerprint(readOptional(taskDir, evidencePath));
  if (
    typeof raw.source_fingerprint === "string" &&
    raw.source_fingerprint !== currentSource
  ) {
    throw new KernelError(
      "INVALID_REQUEST",
      "AC → Evidence ledger is stale after Definition/code change; re-run Verify",
    );
  }
  if (
    typeof raw.evidence_fingerprint === "string" &&
    raw.evidence_fingerprint !== currentEvidence
  ) {
    throw new KernelError(
      "INVALID_REQUEST",
      "AC → Evidence ledger is stale after Evidence change; re-run Verify",
    );
  }
  const expectedCode =
    options.testedCodeFingerprint ??
    (typeof raw.tested_code_fingerprint === "string"
      ? raw.tested_code_fingerprint
      : undefined);
  if (
    expectedCode &&
    typeof raw.tested_code_fingerprint === "string" &&
    raw.tested_code_fingerprint !== expectedCode
  ) {
    throw new KernelError(
      "INVALID_REQUEST",
      "AC → Evidence ledger is stale after tested-code change; re-run Verify",
    );
  }
  buildAcEvidenceLedger({
    acceptanceItems: acceptance,
    mappings,
    sourceFingerprint: currentSource,
    evidenceFingerprint: currentEvidence,
    testedCodeFingerprint: expectedCode,
  });
}

function assertIndependentCheckForClose(
  extras: Record<string, unknown>,
  options: { testedCodeFingerprint?: string },
): void {
  const raw = extras.independent_check;
  if (!isPlainObject(raw)) {
    throw new KernelError(
      "INVALID_REQUEST",
      "Full Close requires a graded Independent Check verdict",
    );
  }
  if (raw.readonly === false) {
    throw new KernelError(
      "INVALID_REQUEST",
      "Independent Check is read-only; repairs return to Execute",
    );
  }
  const mode = readCheckMode(raw.mode ?? raw.assurance);
  if (mode === "true-independent" && raw.independent_worker !== true) {
    throw new KernelError(
      "INVALID_REQUEST",
      "true-independent Check cannot be satisfied without an independent worker",
    );
  }
  if (raw.result === "BLOCKED") {
    throw new KernelError(
      "INVALID_REQUEST",
      "Independent Check is blocked; do not silently claim independent",
    );
  }
  if (raw.result !== "PASS") {
    throw new KernelError(
      "INVALID_REQUEST",
      "Full Close requires Independent Check result PASS",
    );
  }
  if (typeof raw.evidence !== "string" || raw.evidence.trim() === "") {
    throw new KernelError(
      "INVALID_REQUEST",
      "Independent Check PASS requires non-empty evidence (no fake-green)",
    );
  }
  const currentCode = options.testedCodeFingerprint;
  if (
    currentCode &&
    typeof raw.code_fingerprint === "string" &&
    raw.code_fingerprint !== currentCode
  ) {
    throw new KernelError(
      "INVALID_REQUEST",
      "Independent Check verdict is stale after code change; return to Execute and re-check",
    );
  }
  const ledger = extras.ac_evidence_ledger;
  if (
    isPlainObject(ledger) &&
    typeof ledger.tested_code_fingerprint === "string" &&
    typeof raw.code_fingerprint === "string" &&
    raw.code_fingerprint !== ledger.tested_code_fingerprint
  ) {
    throw new KernelError(
      "INVALID_REQUEST",
      "Independent Check verdict is stale after code change; return to Execute and re-check",
    );
  }
}

function readCheckMode(value: unknown): IndependentCheckMode {
  if (value === "self-review" || value === "true-independent") return value;
  throw new KernelError(
    "INVALID_REQUEST",
    "Independent Check mode must be self-review or true-independent",
  );
}

function uniqueControls(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const id = value.trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

function readOptional(taskDir: string, relative: string): string {
  const file = path.join(taskDir, relative);
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf-8");
}
