import {
  ASSURANCE_LEVELS_V1,
  PACTILE_INTENTS_V1,
  fingerprintPactileContractV1,
  parseResolvedProviderV1,
  parseTileManifestV1,
  policyWithinCeilingV1,
  tilePolicyCeilingV1,
  type AssuranceLevelV1,
  type PactileIntentV1,
  type PolicyCeilingV1,
} from "../../core/index.js";
import {
  KERNEL_CONDITIONS,
  KERNEL_OUTCOMES,
  KERNEL_PHASES,
  type KernelCondition,
  type KernelOutcome,
  type KernelPhase,
} from "../../core/task/index.js";
import {
  buildTileCatalog,
  compareTileRefs,
  conflictDiagnostics,
  diagnostic,
  expandTileSelection,
  isCanonicalTileCallerReference,
  sortTileDiagnostics,
  type TileCatalog,
} from "./catalog.js";
import {
  compileTileComposition,
  type TileCapabilityFact,
  type TileCompositionRequest,
  type TileProviderFact,
  type CompiledComposition,
} from "./compiler.js";
import {
  TILE_COMPILER_ABI_VERSION,
  type TileCatalogEntry,
  type TileDiagnostic,
  type TileResult,
} from "./loader.js";

export const TILE_SELECTION_SCHEMA_VERSION = 1 as const;
export const MAX_TILE_SELECTION_CATALOG = 128;
export const MAX_TILE_SELECTION_OUTPUTS = 32;
export const MAX_TILE_SELECTION_CAPABILITIES = 128;
export const MAX_TILE_SELECTION_REFERENCES = 32;
export const MAX_TILE_SELECTION_SEARCH_NODES = 4096;

export const BASELINE_TILE_PHASES: Readonly<Record<string, readonly KernelPhase[]>> = {
  "intake-basic": ["open"],
  "define-basic": ["define"],
  "approval-personal": ["approve"],
  "execute-agent": ["execute"],
  "verify-basic": ["verify"],
  "close-basic": ["close"],
  "context-progressive": ["open", "define", "approve", "execute", "verify", "integrate", "close"],
  "observability-local": ["execute"],
};

export const ONDEMAND_TILE_PHASES: Readonly<Record<string, readonly KernelPhase[]>> = {
  "define-extended": ["define"],
  "independent-check": ["verify"],
  "worker-orchestration": ["execute"],
  "parent-child": ["define", "execute", "integrate", "verify"],
  "spec-learning": ["close"],
  "vcs-integration": ["close"],
};

export type TileSelectionTier = "baseline" | "on-demand";
export type TileLifecycleState = "active" | "registered" | "deprecated" | "disabled" | "retired" | "degraded";
export type TileSelectionChannel = "agent" | "explicit";

export interface TileSelectionGrantFact {
  readonly source: "safe-default" | "task-kernel-approval-snapshot";
  /** The Kernel records a caller assertion; this does not authenticate identity. */
  readonly assurance: "no-grant" | "recorded-user-assertion";
  readonly fingerprint: string;
}

export function tileAllowedInTaskPhase(
  tileId: string,
  tier: TileSelectionTier,
  phase: KernelPhase,
): boolean {
  const phases = tier === "baseline"
    ? BASELINE_TILE_PHASES[tileId]
    : ONDEMAND_TILE_PHASES[tileId];
  return phases?.includes(phase) ?? false;
}

export interface TileTaskLifecycleFact {
  readonly taskId: string;
  /** Stable hash of the project root; the path itself is never exposed. */
  readonly projectFingerprint: string;
  /** Hashed project-root + Task-directory identity; no local path is exposed. */
  readonly scopeFingerprint: string;
  readonly selectionGrant: TileSelectionGrantFact;
  readonly revision: number;
  readonly phase: KernelPhase;
  readonly condition: KernelCondition;
  readonly outcome: KernelOutcome | null;
}

export type TileSelectionLifecycleFailureCode =
  | "tile-selection-no-current-task"
  | "tile-selection-task-stale"
  | "tile-selection-task-read-failed"
  | "tile-selection-task-lifecycle-missing"
  | "tile-selection-task-lifecycle-invalid";

/** Safe, deterministic receipt for a closed task-selection boundary. */
export interface TileSelectionLifecycleFailureReceipt {
  readonly schemaVersion: typeof TILE_SELECTION_SCHEMA_VERSION;
  readonly outcome: "lifecycle-unavailable";
  readonly reasonCode: TileSelectionLifecycleFailureCode;
  readonly taskLifecycle: TileTaskLifecycleFact | null;
  readonly fingerprint: string;
}

export function createTileSelectionLifecycleFailureReceipt(
  reasonCode: TileSelectionLifecycleFailureCode,
  taskLifecycle: TileTaskLifecycleFact | null = null,
): TileSelectionLifecycleFailureReceipt {
  const body = {
    schemaVersion: TILE_SELECTION_SCHEMA_VERSION,
    outcome: "lifecycle-unavailable" as const,
    reasonCode,
    taskLifecycle,
  };
  return { ...body, fingerprint: fingerprintPactileContractV1(body) };
}

/** Registry-owned facts stay separate from the frozen Tile manifest contract. */
export interface TileSelectionFact {
  readonly ref: string;
  readonly tier: TileSelectionTier;
  readonly lifecycle: TileLifecycleState;
}

export interface TileSelectionRequest {
  readonly intent: PactileIntentV1;
  readonly requiredOutputs: readonly string[];
  readonly policyCeiling: PolicyCeilingV1;
  readonly capabilities: readonly TileCapabilityFact[];
  readonly providerFacts?: readonly TileProviderFact[];
  /** `agent` also covers an optional configured Jev caller. */
  readonly channel?: TileSelectionChannel;
  /** Present on the current-task entry point and fingerprinted into the offer. */
  readonly taskLifecycle?: TileTaskLifecycleFact;
}

/**
 * Read-only request profile used by the built-in Task/Agent entry points.
 * Callers may further restrict it; the selected-Task registry intersects it
 * with the Task's recorded Tile grant before preparing an offer.
 */
export function taskTileSelectionRequest(phase: KernelPhase): Omit<TileSelectionRequest, "taskLifecycle"> {
  const intentByPhase: Record<KernelPhase, PactileIntentV1> = {
    open: "semantic",
    define: "structural",
    approve: "exact",
    execute: "structural",
    verify: "structural",
    integrate: "structural",
    close: "exact",
  };
  const outputsByPhase: Record<KernelPhase, readonly string[]> = {
    open: ["request.scope"],
    define: ["task.design"],
    approve: ["approval.boundary"],
    execute: ["worker.handoff"],
    verify: ["review.verdict"],
    integrate: ["integration.candidate"],
    close: ["close.outcome"],
  };
  return {
    intent: intentByPhase[phase],
    requiredOutputs: outputsByPhase[phase],
    policyCeiling: {
      filesystem: "read",
      process: "none",
      network: "forbidden",
      credentials: "forbidden",
      privacy: "local-only",
      egressDestinations: [],
      telemetry: "local-only",
      cost: "low",
    },
    capabilities: [],
    providerFacts: [],
    channel: "agent",
  };
}

export interface TileSelectionCandidate {
  readonly ref: string;
  readonly tier: TileSelectionTier;
  readonly lifecycle: TileLifecycleState;
  readonly summary: string;
  readonly trigger: TileCatalogEntry["manifest"]["trigger"];
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly dependencies: readonly string[];
  readonly conflicts: readonly string[];
  readonly dependencyClosure: readonly string[];
  readonly minimumAssurance: AssuranceLevelV1;
  readonly fingerprint: string;
  readonly outputScore: number;
  readonly explanations: readonly string[];
}

export interface TileSelectionSuggestion {
  /** Requested roots. The compiler expands dependencies again at decision time. */
  readonly selectedRefs: readonly string[];
  readonly expandedSelection: readonly string[];
  readonly coveredOutputs: readonly string[];
  readonly missingOutputs: readonly string[];
  readonly complete: boolean;
  readonly searchStatus: "solution-found" | "no-solution" | "budget-exhausted";
}

export interface TileSelectionOffer {
  readonly schemaVersion: typeof TILE_SELECTION_SCHEMA_VERSION;
  readonly compilerAbiVersion: typeof TILE_COMPILER_ABI_VERSION;
  readonly catalogFingerprint: string;
  readonly inputFingerprint: string;
  readonly intent: PactileIntentV1;
  readonly channel: TileSelectionChannel;
  readonly requiredOutputs: readonly string[];
  readonly taskLifecycle: TileTaskLifecycleFact | null;
  /** Only candidates that passed every hard filter are exposed here. */
  readonly candidates: readonly TileSelectionCandidate[];
  readonly suggestion: TileSelectionSuggestion;
  readonly fingerprint: string;
}

/** Internal audit accompanies the offer but is not part of its Agent-facing payload. */
export interface TileSelectionAuditItem {
  readonly ref: string;
  readonly tier: TileSelectionTier;
  readonly lifecycle: TileLifecycleState;
  readonly eligible: boolean;
  readonly filterCodes: readonly string[];
}

export interface TileSelectionPlan {
  readonly offer: TileSelectionOffer;
  readonly audit: readonly TileSelectionAuditItem[];
}

export type TileSelectionDecisionKind = "adopt" | "override" | "no-match";
export type TileSelectionOutcome =
  | "selected"
  | "overridden"
  | "mis-selection"
  | "no-match"
  | "invalid-selection"
  | "compile-rejected"
  | "search-incomplete"
  | "stale-offer";

export interface TileSelectionDecision {
  /** `invalid` is the safe replay encoding for an unsupported user choice. */
  readonly kind: TileSelectionDecisionKind | "invalid";
  readonly offerFingerprint: string;
  /** Required for override. Invalid references are counted and redacted. */
  readonly selectedRefs?: readonly string[];
  /** Optional earlier attempt retained when a user corrects a mistaken choice. */
  readonly priorAttemptRefs?: readonly string[];
}

export interface TileSelectionAttemptReceipt {
  readonly outcome: "valid" | "mis-selection" | "invalid-selection";
  readonly selectedRefs: readonly string[];
  readonly invalidReferenceCount: number;
  readonly compilerPassed: boolean;
  readonly coveredOutputs: readonly string[];
  readonly missingOutputs: readonly string[];
  readonly diagnosticCodes: readonly string[];
}

export interface TileSelectionDecisionReceipt {
  readonly schemaVersion: typeof TILE_SELECTION_SCHEMA_VERSION;
  readonly catalogFingerprint: string;
  readonly inputFingerprint: string;
  readonly offerFingerprint: string;
  readonly decision: TileSelectionDecisionKind | "invalid";
  readonly outcome: TileSelectionOutcome;
  readonly selectedRefs: readonly string[];
  readonly expandedSelection: readonly string[];
  readonly invalidReferenceCount: number;
  readonly compilerPassed: boolean;
  readonly compositionFingerprint: string | null;
  readonly coveredOutputs: readonly string[];
  readonly missingOutputs: readonly string[];
  readonly taskLifecycle: TileTaskLifecycleFact | null;
  readonly diagnostics: readonly TileDiagnostic[];
  readonly priorAttempt: TileSelectionAttemptReceipt | null;
  readonly fingerprint: string;
}

interface NormalizedRequest {
  readonly intent: PactileIntentV1;
  readonly requiredOutputs: readonly string[];
  readonly policyCeiling: PolicyCeilingV1;
  readonly capabilities: readonly TileCapabilityFact[];
  readonly providerFacts: readonly TileProviderFact[];
  readonly channel: TileSelectionChannel;
  readonly taskLifecycle: TileTaskLifecycleFact | null;
}

interface EligibleCandidate {
  readonly candidate: TileSelectionCandidate;
  readonly outputs: readonly string[];
}

const TIER_ORDER: Record<TileSelectionTier, number> = {
  baseline: 0,
  "on-demand": 1,
};

function failure(code: string, at = "$", tileRef: string | null = null): TileResult<never> {
  return {
    success: false,
    diagnostics: [diagnostic(code, tileRef, null, at)],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalPolicy(policy: PolicyCeilingV1): PolicyCeilingV1 {
  return {
    ...policy,
    egressDestinations: [...policy.egressDestinations].sort(compareTileRefs),
  };
}

function normalizeRequest(
  catalog: TileCatalog,
  request: TileSelectionRequest,
): TileResult<NormalizedRequest> {
  if (!isRecord(request)) return failure("tile-selection-invalid-request");
  if (!PACTILE_INTENTS_V1.includes(request.intent))
    return failure("tile-selection-invalid-intent", "$.intent");
  const channel = request.channel ?? "agent";
  if (channel !== "agent" && channel !== "explicit")
    return failure("tile-selection-invalid-channel", "$.channel");
  let taskLifecycle: TileTaskLifecycleFact | null = null;
  if (request.taskLifecycle !== undefined) {
    const task = request.taskLifecycle;
    if (
      !isRecord(task) ||
      !isCanonicalTileCallerReference(task.taskId, false) ||
      typeof task.projectFingerprint !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(task.projectFingerprint) ||
      typeof task.scopeFingerprint !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(task.scopeFingerprint) ||
      !isRecord(task.selectionGrant) ||
      !(task.selectionGrant.source === "safe-default" || task.selectionGrant.source === "task-kernel-approval-snapshot") ||
      !(task.selectionGrant.assurance === "no-grant" || task.selectionGrant.assurance === "recorded-user-assertion") ||
      typeof task.selectionGrant.fingerprint !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(task.selectionGrant.fingerprint) ||
      !Number.isSafeInteger(task.revision) ||
      Number(task.revision) < 0 ||
      !KERNEL_PHASES.includes(task.phase as KernelPhase) ||
      !KERNEL_CONDITIONS.includes(task.condition as KernelCondition) ||
      !(task.outcome === null || KERNEL_OUTCOMES.includes(task.outcome as KernelOutcome))
    )
      return failure("tile-selection-invalid-task-lifecycle", "$.taskLifecycle");
    taskLifecycle = {
      taskId: task.taskId as string,
      projectFingerprint: task.projectFingerprint as string,
      scopeFingerprint: task.scopeFingerprint as string,
      selectionGrant: {
        source: task.selectionGrant.source,
        assurance: task.selectionGrant.assurance,
        fingerprint: task.selectionGrant.fingerprint,
      },
      revision: task.revision as number,
      phase: task.phase as KernelPhase,
      condition: task.condition as KernelCondition,
      outcome: task.outcome as KernelOutcome | null,
    };
  }
  if (
    !Array.isArray(request.requiredOutputs) ||
    request.requiredOutputs.length === 0 ||
    request.requiredOutputs.length > MAX_TILE_SELECTION_OUTPUTS
  )
    return failure("tile-selection-output-bound", "$.requiredOutputs");
  const requiredOutputs = [...request.requiredOutputs];
  if (
    requiredOutputs.some((output) => !isCanonicalTileCallerReference(output, false)) ||
    new Set(requiredOutputs).size !== requiredOutputs.length
  )
    return failure("tile-selection-invalid-output", "$.requiredOutputs");
  if (
    !Array.isArray(request.capabilities) ||
    request.capabilities.length > MAX_TILE_SELECTION_CAPABILITIES
  )
    return failure("tile-selection-capability-bound", "$.capabilities");
  if (
    !Array.isArray(request.providerFacts ?? []) ||
    (request.providerFacts ?? []).length > MAX_TILE_SELECTION_CAPABILITIES
  )
    return failure("tile-selection-invalid-provider-facts", "$.providerFacts");

  const policy = request.policyCeiling;
  if (!isRecord(policy) || !Array.isArray(policy.egressDestinations))
    return failure("tile-invalid-policy", "$.policyCeiling");
  const probe = catalog.entries[0];
  if (!probe) return failure("tile-selection-empty-catalog");
  const validPolicy = parseTileManifestV1({
    ...probe.manifest,
    permissions: {
      filesystem: policy.filesystem,
      process: policy.process,
      credentials: policy.credentials,
    },
    egress: {
      network: policy.network,
      privacy: policy.privacy,
      telemetry: policy.telemetry,
      destinations: policy.egressDestinations,
    },
    cost: { ceiling: policy.cost },
    fallback: { allowed: false, minimumAssurance: null, policy: null },
  });
  if (!validPolicy.success) return failure("tile-invalid-policy", "$.policyCeiling");

  const capabilities: TileCapabilityFact[] = [];
  for (const [index, fact] of request.capabilities.entries()) {
    if (
      !isRecord(fact) ||
      !isCanonicalTileCallerReference(fact.id, false) ||
      !ASSURANCE_LEVELS_V1.includes(fact.assurance as AssuranceLevelV1)
    )
      return failure("tile-selection-invalid-capability", `$.capabilities[${index}]`);
    capabilities.push({ id: fact.id, assurance: fact.assurance as AssuranceLevelV1 });
  }
  const providerFacts: TileProviderFact[] = [];
  for (const [index, fact] of (request.providerFacts ?? []).entries()) {
    const resolution = isRecord(fact) ? parseResolvedProviderV1(fact.resolution) : null;
    if (
      !isRecord(fact) ||
      !Array.isArray(fact.capabilityIds) ||
      fact.capabilityIds.some((id) => !isCanonicalTileCallerReference(id, false)) ||
      typeof fact.authorized !== "boolean" ||
      !resolution?.success
    )
      return failure("tile-selection-invalid-provider-facts", `$.providerFacts[${index}]`);
    providerFacts.push({
      capabilityIds: [...fact.capabilityIds].sort(compareTileRefs) as string[],
      authorized: fact.authorized,
      resolution: {
        ...resolution.data,
        evidenceRefs: resolution.data.evidenceRefs.map((ref) =>
          /^pactile-evidence-ref-sha256:[a-f0-9]{64}$/.test(ref)
            ? ref
            : `pactile-evidence-ref-sha256:${fingerprintPactileContractV1({
                schemaVersion: 1,
                kind: "pactile.tile-selection.provider-evidence-ref",
                reference: ref,
              }).slice(7)}`,
        ),
      },
    });
  }
  const canonicalCapabilities = capabilities.sort((left, right) =>
    compareTileRefs(JSON.stringify(left), JSON.stringify(right)),
  );
  const canonicalProviders = providerFacts.sort((left, right) =>
    compareTileRefs(fingerprintPactileContractV1(left), fingerprintPactileContractV1(right)),
  );
  return {
    success: true,
    data: {
      intent: request.intent,
      requiredOutputs: requiredOutputs.sort(compareTileRefs),
      policyCeiling: canonicalPolicy(policy as unknown as PolicyCeilingV1),
      capabilities: canonicalCapabilities,
      providerFacts: canonicalProviders,
      channel,
      taskLifecycle,
    },
  };
}

/** Canonical request validation without requiring a full catalog fact table. */
export function normalizeTileSelectionRequest(
  catalog: TileCatalog,
  request: TileSelectionRequest,
): TileResult<TileSelectionRequest> {
  const checked = buildTileCatalog(catalog.entries);
  if (!checked.success) return checked;
  const normalized = normalizeRequest(checked.data, request);
  if (!normalized.success) return normalized;
  const value = normalized.data;
  return {
    success: true,
    data: {
      intent: value.intent,
      requiredOutputs: value.requiredOutputs,
      policyCeiling: value.policyCeiling,
      capabilities: value.capabilities,
      providerFacts: value.providerFacts,
      channel: value.channel,
      ...(value.taskLifecycle ? { taskLifecycle: value.taskLifecycle } : {}),
    },
  };
}

function validateSelectionFacts(
  catalog: TileCatalog,
  facts: readonly TileSelectionFact[],
): TileResult<ReadonlyMap<string, TileSelectionFact>> {
  if (!Array.isArray(facts) || facts.length !== catalog.entries.length)
    return failure("tile-selection-facts-mismatch", "$.facts");
  const known = new Set(catalog.entries.map((entry) => entry.ref));
  const byRef = new Map<string, TileSelectionFact>();
  for (const [index, fact] of facts.entries()) {
    if (
      !isRecord(fact) ||
      typeof fact.ref !== "string" ||
      !known.has(fact.ref) ||
      (fact.tier !== "baseline" && fact.tier !== "on-demand") ||
      !["active", "registered", "deprecated", "disabled", "retired", "degraded"].includes(String(fact.lifecycle)) ||
      byRef.has(fact.ref)
    )
      return failure("tile-selection-invalid-fact", `$.facts[${index}]`);
    byRef.set(fact.ref, fact as unknown as TileSelectionFact);
  }
  for (const entry of catalog.entries)
    if (!byRef.has(entry.ref)) return failure("tile-selection-facts-mismatch", "$.facts");
  return { success: true, data: byRef };
}

export interface NormalizedTileSelectionReplayInput {
  readonly request: TileSelectionRequest;
  readonly facts: readonly TileSelectionFact[];
}

/** Canonical, validated inputs for a durable decision replay snapshot. */
export function normalizeTileSelectionReplayInput(
  catalog: TileCatalog,
  request: TileSelectionRequest,
  facts: readonly TileSelectionFact[],
): TileResult<NormalizedTileSelectionReplayInput> {
  const checked = buildTileCatalog(catalog.entries);
  if (!checked.success) return checked;
  const normalized = normalizeRequest(checked.data, request);
  if (!normalized.success) return normalized;
  const validatedFacts = validateSelectionFacts(checked.data, facts);
  if (!validatedFacts.success) return validatedFacts;
  const normalizedRequest = normalizeTileSelectionRequest(checked.data, request);
  if (!normalizedRequest.success) return normalizedRequest;
  return {
    success: true,
    data: {
      request: normalizedRequest.data,
      facts: [...validatedFacts.data.values()].sort((left, right) => compareTileRefs(left.ref, right.ref)),
    },
  };
}

function compositionOutputs(
  catalog: TileCatalog,
  expandedRefs: readonly string[],
): readonly string[] {
  const entries = new Map(catalog.entries.map((entry) => [entry.ref, entry]));
  return [...new Set(
    expandedRefs.flatMap((ref) => entries.get(ref)?.manifest.outputs ?? []),
  )].sort(compareTileRefs);
}

function coverage(
  required: readonly string[],
  available: readonly string[],
): { covered: string[]; missing: string[] } {
  const availableSet = new Set(available);
  const covered = required.filter((output) => availableSet.has(output));
  const missing = required.filter((output) => !availableSet.has(output));
  return { covered, missing };
}

function channelAllows(
  mode: TileCatalogEntry["manifest"]["trigger"]["mode"],
  channel: TileSelectionChannel,
): boolean {
  return mode === "both" || (channel === "agent" ? mode === "model" : mode === "explicit");
}

function isSelectableLifecycle(fact: TileSelectionFact): boolean {
  return fact.lifecycle === "active" ||
    (fact.tier === "on-demand" && fact.lifecycle === "registered");
}

function compilerRequest(
  request: NormalizedRequest,
  requestedSelection: readonly string[],
): TileCompositionRequest {
  return {
    requestedSelection,
    capabilities: request.capabilities,
    providerFacts: request.providerFacts,
    policyCeiling: request.policyCeiling,
  };
}

function buildSuggestion(
  catalog: TileCatalog,
  request: NormalizedRequest,
  eligible: readonly EligibleCandidate[],
): TileSelectionSuggestion {
  interface SearchState {
    readonly selectedRefs: readonly string[];
    readonly expandedSelection: readonly string[];
    readonly coveredOutputs: readonly string[];
    readonly missingOutputs: readonly string[];
  }
  interface SearchOption {
    readonly selectedRefs: readonly string[];
    readonly composition: CompiledComposition;
    readonly outputs: readonly string[];
    readonly gainedOutputs: readonly string[];
  }

  let visitedStates = 0;
  let searchBudgetExhausted = false;
  let solution: SearchState | null = null;
  let bestPartial: SearchState = {
    selectedRefs: [],
    expandedSelection: [],
    coveredOutputs: [],
    missingOutputs: [...request.requiredOutputs],
  };
  const visited = new Set<string>();
  const isBetterPartial = (candidate: SearchState, current: SearchState): boolean =>
    candidate.coveredOutputs.length > current.coveredOutputs.length ||
    (candidate.coveredOutputs.length === current.coveredOutputs.length &&
      (candidate.selectedRefs.length < current.selectedRefs.length ||
        (candidate.selectedRefs.length === current.selectedRefs.length &&
          (candidate.expandedSelection.length < current.expandedSelection.length ||
            (candidate.expandedSelection.length === current.expandedSelection.length &&
              compareTileRefs(JSON.stringify(candidate.selectedRefs), JSON.stringify(current.selectedRefs)) < 0)))));

  const visit = (
    selectedRefs: readonly string[],
    knownComposition?: CompiledComposition,
    knownOutputs?: readonly string[],
  ): void => {
    if (solution || searchBudgetExhausted) return;
    const canonicalRefs = [...selectedRefs].sort(compareTileRefs);
    const key = JSON.stringify(canonicalRefs);
    if (visited.has(key)) return;
    if (visitedStates >= MAX_TILE_SELECTION_SEARCH_NODES) {
      searchBudgetExhausted = true;
      return;
    }
    visited.add(key);
    visitedStates += 1;

    let composition = knownComposition;
    let outputs = knownOutputs ?? [];
    if (canonicalRefs.length && !composition) {
      const compiled = compileTileComposition(catalog, compilerRequest(request, canonicalRefs));
      if (!compiled.success) return;
      composition = compiled.data;
      outputs = compositionOutputs(catalog, composition.expandedSelection);
    }
    const currentCoverage = coverage(request.requiredOutputs, outputs);
    const state: SearchState = {
      selectedRefs: canonicalRefs,
      expandedSelection: composition?.expandedSelection ?? [],
      coveredOutputs: currentCoverage.covered,
      missingOutputs: currentCoverage.missing,
    };
    if (isBetterPartial(state, bestPartial)) bestPartial = state;
    if (currentCoverage.missing.length === 0) {
      solution = state;
      return;
    }

    const options: SearchOption[] = [];
    for (const candidate of eligible) {
      if (canonicalRefs.includes(candidate.candidate.ref)) continue;
      const combined = [...canonicalRefs, candidate.candidate.ref].sort(compareTileRefs);
      const compiled = compileTileComposition(catalog, compilerRequest(request, combined));
      if (!compiled.success) continue;
      const combinedOutputs = compositionOutputs(catalog, compiled.data.expandedSelection);
      const gainedOutputs = currentCoverage.missing.filter((output) => combinedOutputs.includes(output));
      if (!gainedOutputs.length) continue;
      options.push({
        selectedRefs: combined,
        composition: compiled.data,
        outputs: combinedOutputs,
        gainedOutputs,
      });
    }

    const outputChoices = currentCoverage.missing.map((output) => ({
      output,
      options: options.filter((option) => option.gainedOutputs.includes(output)),
    }));
    outputChoices.sort((left, right) =>
      left.options.length - right.options.length || compareTileRefs(left.output, right.output),
    );
    const nextChoices = outputChoices[0]?.options ?? [];
    for (const option of nextChoices) {
      visit(option.selectedRefs, option.composition, option.outputs);
      if (solution || searchBudgetExhausted) return;
    }
  };

  visit([]);
  const result = solution ?? bestPartial;
  const searchStatus = solution
    ? "solution-found"
    : searchBudgetExhausted
      ? "budget-exhausted"
      : "no-solution";
  return {
    selectedRefs: result.selectedRefs,
    expandedSelection: result.expandedSelection,
    coveredOutputs: result.coveredOutputs,
    missingOutputs: result.missingOutputs,
    complete: result.missingOutputs.length === 0,
    searchStatus,
  };
}

/**
 * Build an Agent-facing offer only after intent, lifecycle, dependency,
 * permission, conflict and compiler checks have accepted each candidate.
 */
export function prepareTileSelection(
  sourceCatalog: TileCatalog,
  request: TileSelectionRequest,
  facts: readonly TileSelectionFact[],
): TileResult<TileSelectionPlan> {
  if (sourceCatalog.entries.length > MAX_TILE_SELECTION_CATALOG)
    return failure("tile-selection-catalog-bound");
  const checked = buildTileCatalog(sourceCatalog.entries);
  if (!checked.success) return checked;
  const normalized = normalizeRequest(checked.data, request);
  if (!normalized.success) return normalized;
  const factMap = validateSelectionFacts(checked.data, facts);
  if (!factMap.success) return factMap;

  const inputFingerprint = fingerprintPactileContractV1({
    compilerAbiVersion: TILE_COMPILER_ABI_VERSION,
    catalogFingerprint: checked.data.fingerprint,
    request: normalized.data,
    facts: [...factMap.data.values()].sort((left, right) => compareTileRefs(left.ref, right.ref)),
  });
  const audit: TileSelectionAuditItem[] = [];
  const eligible: EligibleCandidate[] = [];
  for (const entry of checked.data.entries) {
    const fact = factMap.data.get(entry.ref);
    if (!fact) return failure("tile-selection-facts-mismatch");
    const filterCodes: string[] = [];
    if (
      normalized.data.taskLifecycle &&
      (normalized.data.taskLifecycle.outcome !== null ||
        (normalized.data.taskLifecycle.condition !== "ready" &&
          normalized.data.taskLifecycle.condition !== "active"))
    )
      filterCodes.push("tile-selection-task-lifecycle-inactive");
    if (
      normalized.data.taskLifecycle &&
      !tileAllowedInTaskPhase(
        entry.manifest.identity.id,
        fact.tier,
        normalized.data.taskLifecycle.phase,
      )
    )
      filterCodes.push("tile-selection-phase-ineligible");
    if (!entry.manifest.trigger.intents.includes(normalized.data.intent))
      filterCodes.push("tile-selection-intent-mismatch");
    if (!channelAllows(entry.manifest.trigger.mode, normalized.data.channel))
      filterCodes.push("tile-selection-channel-mismatch");

    const closure = expandTileSelection(checked.data.entries, [entry.ref]);
    if (!closure.success) filterCodes.push("tile-selection-dependency-invalid");
    const closureEntries = closure.success ? closure.data : [];
    if (closureEntries.some((dependency) => {
      const dependencyFact = factMap.data.get(dependency.ref);
      return !dependencyFact || !isSelectableLifecycle(dependencyFact);
    }))
      filterCodes.push("tile-selection-lifecycle-ineligible");
    if (
      closureEntries.some((dependency) =>
        !policyWithinCeilingV1(
          tilePolicyCeilingV1(dependency.manifest),
          normalized.data.policyCeiling,
        ),
      )
    )
      filterCodes.push("tile-selection-permission-exceeded");
    if (closure.success && conflictDiagnostics(closure.data).length)
      filterCodes.push("tile-selection-conflict");

    let compiled: ReturnType<typeof compileTileComposition> | null = null;
    if (filterCodes.length === 0) {
      compiled = compileTileComposition(checked.data, compilerRequest(normalized.data, [entry.ref]));
      if (!compiled.success) filterCodes.push("tile-selection-compiler-rejected");
    }
    const uniqueCodes = [...new Set(filterCodes)];
    const item: TileSelectionAuditItem = {
      ref: entry.ref,
      tier: fact.tier,
      lifecycle: fact.lifecycle,
      eligible: uniqueCodes.length === 0,
      filterCodes: uniqueCodes,
    };
    audit.push(item);
    if (!item.eligible || !compiled?.success) continue;
    const outputs = compositionOutputs(checked.data, compiled.data.expandedSelection);
    const matches = coverage(normalized.data.requiredOutputs, outputs).covered;
    const explanations = [
      "intent-match",
      "channel-allowed",
      fact.lifecycle === "registered" ? "lifecycle-registered" : "lifecycle-active",
      ...(normalized.data.taskLifecycle ? ["task-lifecycle-actionable"] : []),
      "dependencies-available",
      "permissions-within-ceiling",
      "conflict-free",
      "compiler-valid",
      ...(matches.length ? ["required-output-match"] : []),
    ];
    eligible.push({
      candidate: {
        ref: entry.ref,
        tier: fact.tier,
        lifecycle: fact.lifecycle,
        summary: entry.manifest.summary,
        trigger: entry.manifest.trigger,
        inputs: entry.manifest.inputs,
        outputs: entry.manifest.outputs,
        dependencies: entry.manifest.dependencies,
        conflicts: entry.manifest.conflicts,
        dependencyClosure: compiled.data.expandedSelection,
        minimumAssurance: compiled.data.minimumAssurance,
        fingerprint: entry.fingerprint,
        outputScore: matches.length,
      explanations,
      },
      outputs,
    });
  }

  eligible.sort((left, right) =>
    right.candidate.outputScore - left.candidate.outputScore ||
    left.candidate.dependencyClosure.length - right.candidate.dependencyClosure.length ||
    TIER_ORDER[left.candidate.tier] - TIER_ORDER[right.candidate.tier] ||
    compareTileRefs(left.candidate.ref, right.candidate.ref),
  );
  const suggestion = buildSuggestion(checked.data, normalized.data, eligible);
  const eligibleIds = new Set(eligible.map((item) => item.candidate.ref.slice(0, item.candidate.ref.lastIndexOf("@"))));
  const offerContent = {
    schemaVersion: TILE_SELECTION_SCHEMA_VERSION,
    compilerAbiVersion: TILE_COMPILER_ABI_VERSION,
    catalogFingerprint: checked.data.fingerprint,
    inputFingerprint,
    intent: normalized.data.intent,
    channel: normalized.data.channel,
    requiredOutputs: normalized.data.requiredOutputs,
    taskLifecycle: normalized.data.taskLifecycle,
    candidates: eligible.map((item) => ({
      ...item.candidate,
      conflicts: item.candidate.conflicts.filter((id) => eligibleIds.has(id)),
    })),
    suggestion,
  };
  return {
    success: true,
    data: {
      offer: {
        ...offerContent,
        fingerprint: fingerprintPactileContractV1(offerContent),
      },
      audit,
    },
  };
}

interface NormalizedAttempt {
  readonly refs: readonly string[];
  readonly invalidReferenceCount: number;
  readonly diagnostics: readonly TileDiagnostic[];
}

function normalizeAttempt(
  candidateRefs: ReadonlySet<string>,
  values: readonly string[] | undefined,
  required: boolean,
): NormalizedAttempt {
  const diagnostics: TileDiagnostic[] = [];
  const references = values ?? [];
  let invalidReferenceCount = 0;
  if (!Array.isArray(references) || references.length > MAX_TILE_SELECTION_REFERENCES) {
    return {
      refs: [],
      invalidReferenceCount: Array.isArray(references)
        ? MAX_TILE_SELECTION_REFERENCES + 1
        : 1,
      diagnostics: [diagnostic("tile-selection-reference-bound", null)],
    };
  }
  if (required && references.length === 0)
    diagnostics.push(diagnostic("tile-empty-selection", null));
  const refs = new Set<string>();
  for (const [index, reference] of references.entries()) {
    if (!isCanonicalTileCallerReference(reference, true)) {
      invalidReferenceCount += 1;
      diagnostics.push(diagnostic("tile-invalid-caller-reference", null, null, `$.selectedRefs[${index}]`));
      continue;
    }
    const resolved = resolveCandidateSelectionRef(candidateRefs, reference);
    if (!resolved) {
      invalidReferenceCount += 1;
      diagnostics.push(diagnostic("tile-missing-reference", null, null, `$.selectedRefs[${index}]`));
      continue;
    }
    if (refs.has(resolved)) {
      diagnostics.push(diagnostic("tile-duplicate-selection", resolved));
      continue;
    }
    refs.add(resolved);
    if (!candidateRefs.has(resolved))
      diagnostics.push(diagnostic("tile-selection-not-eligible", resolved));
  }
  return {
    refs: [...refs].sort(compareTileRefs),
    invalidReferenceCount,
    diagnostics: sortTileDiagnostics(diagnostics),
  };
}

function resolveCandidateSelectionRef(candidateRefs: ReadonlySet<string>, reference: string): string | null {
  const matches = [...candidateRefs].filter((candidateRef) =>
    reference.includes("@")
      ? candidateRef === reference
      : candidateRef.slice(0, candidateRef.lastIndexOf("@")) === reference,
  );
  return matches.length === 1 ? matches[0] : null;
}

function redactedMissingReference(
  candidateRefs: ReadonlySet<string>,
  index: number,
): string {
  const ids = new Set([...candidateRefs].map((ref) => ref.slice(0, ref.lastIndexOf("@"))));
  let suffix = index;
  let candidate = `pactile-redacted-ref-${suffix}`;
  while (ids.has(candidate)) candidate = `pactile-redacted-ref-${++suffix}`;
  return candidate;
}

function sanitizeDecisionReferences(
  candidateRefs: ReadonlySet<string>,
  values: readonly string[] | undefined,
): readonly string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) return undefined;
  if (values.length > MAX_TILE_SELECTION_REFERENCES)
    return Array.from({ length: MAX_TILE_SELECTION_REFERENCES + 1 }, (_, index) =>
      redactedMissingReference(candidateRefs, index),
    );
  return values.map((value, index) => {
    if (typeof value !== "string" || !isCanonicalTileCallerReference(value, true))
      return "<redacted-invalid-ref>";
    return resolveCandidateSelectionRef(candidateRefs, value) ? value : redactedMissingReference(candidateRefs, index);
  });
}

/** Redact caller strings using only references already present in the offer. */
export function sanitizeTileSelectionDecisionForOffer(
  offer: TileSelectionOffer,
  decision: TileSelectionDecision,
): TileResult<TileSelectionDecision> {
  if (!isRecord(decision) || typeof decision.offerFingerprint !== "string")
    return failure("tile-selection-replay-decision-invalid");
  const isKnownKind = decision.kind === "adopt" || decision.kind === "override" || decision.kind === "no-match";
  const kind: TileSelectionDecision["kind"] = isKnownKind ? decision.kind : "invalid";
  const candidateRefs = new Set(offer.candidates.map((candidate) => candidate.ref));
  const knownFingerprint = /^sha256:[a-f0-9]{64}$/.test(decision.offerFingerprint);
  const alternateFingerprint = offer.fingerprint === `sha256:${"0".repeat(64)}`
    ? `sha256:${"1".repeat(64)}`
    : `sha256:${"0".repeat(64)}`;
  const safeDecision: TileSelectionDecision = {
    kind,
    offerFingerprint: knownFingerprint ? decision.offerFingerprint : alternateFingerprint,
    ...(!isKnownKind ? {} : decision.selectedRefs !== undefined
      ? {
          selectedRefs: kind === "adopt"
            ? []
            : sanitizeDecisionReferences(candidateRefs, decision.selectedRefs),
        }
      : {}),
    ...(isKnownKind && decision.priorAttemptRefs !== undefined
      ? { priorAttemptRefs: sanitizeDecisionReferences(candidateRefs, decision.priorAttemptRefs) }
      : {}),
  };
  return { success: true, data: safeDecision };
}

/** Redact invalid refs before comparing current-input replay receipts. */
export function sanitizeTileSelectionDecisionForReplay(
  catalog: TileCatalog,
  request: TileSelectionRequest,
  facts: readonly TileSelectionFact[],
  decision: TileSelectionDecision,
): TileResult<TileSelectionDecision> {
  if (!isRecord(decision) || typeof decision.offerFingerprint !== "string")
    return failure("tile-selection-replay-decision-invalid");
  const plan = prepareTileSelection(catalog, request, facts);
  if (!plan.success) return plan;
  const safeDecision = sanitizeTileSelectionDecisionForOffer(plan.data.offer, decision);
  if (!safeDecision.success) return safeDecision;
  const original = decideTileSelection(catalog, request, facts, decision);
  if (!original.success) return original;
  const sanitized = decideTileSelection(catalog, request, facts, safeDecision.data);
  if (!sanitized.success) return sanitized;
  if (original.data.fingerprint !== sanitized.data.fingerprint)
    return failure("tile-selection-replay-redaction-mismatch");
  return safeDecision;
}

function outputCoverageForComposition(
  catalog: TileCatalog,
  requiredOutputs: readonly string[],
  expandedRefs: readonly string[],
): { covered: string[]; missing: string[] } {
  return coverage(requiredOutputs, compositionOutputs(catalog, expandedRefs));
}

function makeAttemptReceipt(
  catalog: TileCatalog,
  request: NormalizedRequest,
  refs: readonly string[],
  invalidReferenceCount: number,
  initialDiagnostics: readonly TileDiagnostic[],
  candidates: ReadonlySet<string>,
): TileSelectionAttemptReceipt {
  const diagnostics = [...initialDiagnostics];
  if (refs.some((ref) => !candidates.has(ref)))
    diagnostics.push(...refs.filter((ref) => !candidates.has(ref)).map((ref) => diagnostic("tile-selection-not-eligible", ref)));
  const canCompile = diagnostics.length === 0 && refs.length > 0;
  const compiled = canCompile
    ? compileTileComposition(catalog, compilerRequest(request, refs))
    : null;
  if (compiled && !compiled.success) diagnostics.push(...compiled.diagnostics);
  const compilerPassed = !!compiled?.success;
  const resultCoverage = compiled?.success
    ? outputCoverageForComposition(catalog, request.requiredOutputs, compiled.data.expandedSelection)
    : { covered: [], missing: [...request.requiredOutputs] };
  const outcome =
    diagnostics.length > 0 || invalidReferenceCount > 0 || !compilerPassed
      ? "invalid-selection"
      : resultCoverage.missing.length > 0
        ? "mis-selection"
        : "valid";
  return {
    outcome,
    selectedRefs: refs,
    invalidReferenceCount,
    compilerPassed,
    coveredOutputs: resultCoverage.covered,
    missingOutputs: resultCoverage.missing,
    diagnosticCodes: [...new Set(diagnostics.map((item) => item.code))].sort(compareTileRefs),
  };
}

function receiptFingerprint(
  receipt: Omit<TileSelectionDecisionReceipt, "fingerprint">,
): string {
  return fingerprintPactileContractV1(receipt);
}

function decideTileSelectionAgainstOffer(
  checked: TileCatalog,
  normalized: NormalizedRequest,
  offer: TileSelectionOffer,
  decision: TileSelectionDecision,
): TileResult<TileSelectionDecisionReceipt> {
  const candidates = new Set(offer.candidates.map((candidate) => candidate.ref));
  const diagnostics: TileDiagnostic[] = [];
  const decisionRecord = isRecord(decision) ? decision : null;
  const decisionKind = decisionRecord?.kind;
  const safeDecisionKind: TileSelectionDecisionReceipt["decision"] =
    decisionKind === "adopt"
      ? "adopt"
      : decisionKind === "override"
        ? "override"
        : decisionKind === "no-match"
          ? "no-match"
          : "invalid";
  const decisionIsValid = safeDecisionKind !== "invalid";
  let selectedRefs: readonly string[] = [];
  let invalidReferenceCount = 0;
  let compilerPassed = false;
  let compositionFingerprint: string | null = null;
  let expandedSelection: readonly string[] = [];
  let coveredOutputs: readonly string[] = [];
  let missingOutputs: readonly string[] = [...normalized.requiredOutputs];
  let priorAttempt: TileSelectionAttemptReceipt | null = null;
  let outcome: TileSelectionOutcome;

  if (!decisionIsValid || typeof decisionRecord?.offerFingerprint !== "string") {
    diagnostics.push(diagnostic("tile-selection-invalid-decision", null));
    outcome = "invalid-selection";
  } else if (decisionRecord.offerFingerprint !== offer.fingerprint) {
    diagnostics.push(diagnostic("tile-selection-stale-offer", null));
    outcome = "stale-offer";
  } else {
    const decisionValue = decisionRecord as unknown as TileSelectionDecision;
    if (decisionValue.priorAttemptRefs !== undefined) {
      const attempt = normalizeAttempt(candidates, decisionValue.priorAttemptRefs, true);
      priorAttempt = makeAttemptReceipt(
        checked,
        normalized,
        attempt.refs,
        attempt.invalidReferenceCount,
        attempt.diagnostics,
        candidates,
      );
    }

    if (decisionKind === "no-match") {
      if (decisionValue.selectedRefs !== undefined) {
        const attemptedSelection = normalizeAttempt(candidates, decisionValue.selectedRefs, false);
        if (attemptedSelection.refs.length || attemptedSelection.diagnostics.length || attemptedSelection.invalidReferenceCount) {
          diagnostics.push(diagnostic("tile-no-match-has-selection", null));
          outcome = "invalid-selection";
        } else outcome = "no-match";
      } else outcome = "no-match";
    } else if (decisionKind === "adopt") {
      selectedRefs = offer.suggestion.selectedRefs;
      if (!offer.suggestion.complete) {
        selectedRefs = [];
        if (offer.suggestion.searchStatus === "budget-exhausted") {
          diagnostics.push(diagnostic("tile-selection-search-budget-exhausted", null));
          outcome = "search-incomplete";
        } else {
          diagnostics.push(diagnostic("tile-suggestion-incomplete", null));
          outcome = "no-match";
        }
      } else if (decisionValue.selectedRefs !== undefined) {
        diagnostics.push(diagnostic("tile-adopt-selection-must-use-suggestion", null));
        outcome = "invalid-selection";
      } else outcome = "selected";
    } else {
      const attempt = normalizeAttempt(candidates, decisionValue.selectedRefs, true);
      selectedRefs = attempt.refs;
      invalidReferenceCount = attempt.invalidReferenceCount;
      diagnostics.push(...attempt.diagnostics);
      if (attempt.diagnostics.length || attempt.invalidReferenceCount) outcome = "invalid-selection";
      else outcome = "overridden";
    }

    if (outcome === "selected" || outcome === "overridden") {
      const compiled = compileTileComposition(
        checked,
        compilerRequest(normalized, selectedRefs),
      );
      if (!compiled.success) {
        diagnostics.push(...compiled.diagnostics);
        outcome = "compile-rejected";
      } else {
        compilerPassed = true;
        compositionFingerprint = compiled.data.fingerprint;
        expandedSelection = compiled.data.expandedSelection;
        const resultCoverage = outputCoverageForComposition(
          checked,
          normalized.requiredOutputs,
          compiled.data.expandedSelection,
        );
        coveredOutputs = resultCoverage.covered;
        missingOutputs = resultCoverage.missing;
        if (missingOutputs.length) outcome = "mis-selection";
      }
    }
  }

  const normalizedDiagnostics = sortTileDiagnostics(diagnostics);
  const receiptBody: Omit<TileSelectionDecisionReceipt, "fingerprint"> = {
    schemaVersion: TILE_SELECTION_SCHEMA_VERSION,
    catalogFingerprint: checked.fingerprint,
    inputFingerprint: offer.inputFingerprint,
    offerFingerprint: offer.fingerprint,
    decision: safeDecisionKind,
    outcome,
    selectedRefs,
    expandedSelection,
    invalidReferenceCount,
    compilerPassed,
    compositionFingerprint,
    coveredOutputs,
    missingOutputs,
    taskLifecycle: normalized.taskLifecycle,
    diagnostics: normalizedDiagnostics,
    priorAttempt,
  };
  return {
    success: true,
    data: { ...receiptBody, fingerprint: receiptFingerprint(receiptBody) },
  };
}

function sameSelectionValue(left: unknown, right: unknown): boolean {
  return fingerprintPactileContractV1(left) === fingerprintPactileContractV1(right);
}

function validateHistoricalOffer(
  catalog: TileCatalog,
  request: NormalizedRequest,
  offer: TileSelectionOffer,
  candidateFacts: readonly TileSelectionFact[],
): TileResult<true> {
  if (!isRecord(offer) || !Array.isArray(offer.candidates) || offer.candidates.length > catalog.entries.length)
    return failure("tile-selection-snapshot-offer-invalid");
  const { fingerprint, ...offerContent } = offer;
  if (
    offer.schemaVersion !== TILE_SELECTION_SCHEMA_VERSION ||
    offer.compilerAbiVersion !== TILE_COMPILER_ABI_VERSION ||
    offer.catalogFingerprint !== catalog.fingerprint ||
    !/^sha256:[a-f0-9]{64}$/.test(offer.inputFingerprint) ||
    typeof fingerprint !== "string" ||
    fingerprintPactileContractV1(offerContent) !== fingerprint ||
    offer.intent !== request.intent ||
    offer.channel !== request.channel ||
    !sameSelectionValue(offer.requiredOutputs, request.requiredOutputs) ||
    !sameSelectionValue(offer.taskLifecycle, request.taskLifecycle)
  )
    return failure("tile-selection-snapshot-offer-mismatch");

  const catalogByRef = new Map(catalog.entries.map((entry) => [entry.ref, entry]));
  const candidateRefs = new Set<string>();
  for (const candidate of offer.candidates) {
    if (!isRecord(candidate) || typeof candidate.ref !== "string" || candidateRefs.has(candidate.ref))
      return failure("tile-selection-snapshot-offer-invalid");
    candidateRefs.add(candidate.ref);
  }
  const eligibleIds = new Set([...candidateRefs].map((ref) => ref.slice(0, ref.lastIndexOf("@"))));
  const factsByRef = new Map<string, TileSelectionFact>();
  const requiredFactRefs = new Set<string>();
  for (const candidate of offer.candidates) {
    requiredFactRefs.add(candidate.ref);
    if (!Array.isArray(candidate.dependencyClosure))
      return failure("tile-selection-snapshot-offer-invalid");
    for (const ref of candidate.dependencyClosure) {
      if (typeof ref !== "string" || !catalogByRef.has(ref))
        return failure("tile-selection-snapshot-offer-invalid");
      requiredFactRefs.add(ref);
    }
  }
  if (!Array.isArray(candidateFacts) || candidateFacts.length !== requiredFactRefs.size)
    return failure("tile-selection-snapshot-input-mismatch");
  for (const fact of candidateFacts) {
    if (
      !isRecord(fact) ||
      typeof fact.ref !== "string" ||
      !requiredFactRefs.has(fact.ref) ||
      (fact.tier !== "baseline" && fact.tier !== "on-demand") ||
      !["active", "registered", "deprecated", "disabled", "retired", "degraded"].includes(String(fact.lifecycle)) ||
      factsByRef.has(fact.ref)
    )
      return failure("tile-selection-snapshot-input-mismatch");
    factsByRef.set(fact.ref, fact as unknown as TileSelectionFact);
  }
  if ([...requiredFactRefs].some((ref) => !factsByRef.has(ref)))
    return failure("tile-selection-snapshot-input-mismatch");
  const lifecycle = request.taskLifecycle;
  if (lifecycle && (lifecycle.outcome !== null || (lifecycle.condition !== "ready" && lifecycle.condition !== "active")))
    return failure("tile-selection-snapshot-offer-invalid");

  const eligible: EligibleCandidate[] = [];
  for (const candidate of offer.candidates) {
    const entry = catalogByRef.get(candidate.ref);
    const fact = factsByRef.get(candidate.ref);
    if (!entry || !fact || !isSelectableLifecycle(fact) || fact.tier !== candidate.tier || fact.lifecycle !== candidate.lifecycle)
      return failure("tile-selection-snapshot-offer-invalid");
    const manifest = entry.manifest;
    if (
      (lifecycle && !tileAllowedInTaskPhase(manifest.identity.id, fact.tier, lifecycle.phase)) ||
      !manifest.trigger.intents.includes(request.intent) ||
      !channelAllows(manifest.trigger.mode, request.channel)
    )
      return failure("tile-selection-snapshot-offer-invalid");
    const closure = expandTileSelection(catalog.entries, [entry.ref]);
    if (!closure.success || conflictDiagnostics(closure.data).length)
      return failure("tile-selection-snapshot-offer-invalid");
    if (closure.data.some((dependency) => {
      const dependencyFact = factsByRef.get(dependency.ref);
      return !dependencyFact || !isSelectableLifecycle(dependencyFact) ||
        !policyWithinCeilingV1(tilePolicyCeilingV1(dependency.manifest), request.policyCeiling);
    }))
      return failure("tile-selection-snapshot-offer-invalid");
    const compiled = compileTileComposition(catalog, compilerRequest(request, [entry.ref]));
    if (!compiled.success)
      return failure("tile-selection-snapshot-offer-invalid");
    const outputs = compositionOutputs(catalog, compiled.data.expandedSelection);
    const matches = coverage(request.requiredOutputs, outputs).covered;
    const expectedCandidate: TileSelectionCandidate = {
      ref: entry.ref,
      tier: fact.tier,
      lifecycle: fact.lifecycle,
      summary: manifest.summary,
      trigger: manifest.trigger,
      inputs: manifest.inputs,
      outputs: manifest.outputs,
      dependencies: manifest.dependencies,
      conflicts: manifest.conflicts.filter((id) => eligibleIds.has(id)),
      dependencyClosure: compiled.data.expandedSelection,
      minimumAssurance: compiled.data.minimumAssurance,
      fingerprint: entry.fingerprint,
      outputScore: matches.length,
      explanations: [
        "intent-match",
        "channel-allowed",
        fact.lifecycle === "registered" ? "lifecycle-registered" : "lifecycle-active",
        ...(lifecycle ? ["task-lifecycle-actionable"] : []),
        "dependencies-available",
        "permissions-within-ceiling",
        "conflict-free",
        "compiler-valid",
        ...(matches.length ? ["required-output-match"] : []),
      ],
    };
    if (!sameSelectionValue(candidate, expectedCandidate))
      return failure("tile-selection-snapshot-offer-invalid");
    eligible.push({ candidate: expectedCandidate, outputs });
  }
  eligible.sort((left, right) =>
    right.candidate.outputScore - left.candidate.outputScore ||
    left.candidate.dependencyClosure.length - right.candidate.dependencyClosure.length ||
    TIER_ORDER[left.candidate.tier] - TIER_ORDER[right.candidate.tier] ||
    compareTileRefs(left.candidate.ref, right.candidate.ref),
  );
  if (!sameSelectionValue(offer.candidates, eligible.map((item) => item.candidate)))
    return failure("tile-selection-snapshot-offer-invalid");
  const expectedSuggestion = buildSuggestion(catalog, request, eligible);
  if (!sameSelectionValue(offer.suggestion, expectedSuggestion))
    return failure("tile-selection-snapshot-offer-invalid");
  return { success: true, data: true };
}

/** Re-run a historical decision from a filtered Offer and the matching catalog version. */
export function replayTileSelectionDecisionFromOffer(
  sourceCatalog: TileCatalog,
  request: TileSelectionRequest,
  offer: TileSelectionOffer,
  candidateFacts: readonly TileSelectionFact[],
  decision: TileSelectionDecision,
): TileResult<TileSelectionDecisionReceipt> {
  const checked = buildTileCatalog(sourceCatalog.entries);
  if (!checked.success) return checked;
  const normalized = normalizeRequest(checked.data, request);
  if (!normalized.success) return normalized;
  const validatedOffer = validateHistoricalOffer(checked.data, normalized.data, offer, candidateFacts);
  if (!validatedOffer.success) return validatedOffer;
  return decideTileSelectionAgainstOffer(checked.data, normalized.data, offer, decision);
}

/**
 * Produce a replayable decision result. Adoption and override both re-run the
 * compiler; overrides can change the suggestion but cannot bypass its checks.
 */
export function decideTileSelection(
  catalog: TileCatalog,
  request: TileSelectionRequest,
  facts: readonly TileSelectionFact[],
  decision: TileSelectionDecision,
): TileResult<TileSelectionDecisionReceipt> {
  const plan = prepareTileSelection(catalog, request, facts);
  if (!plan.success) return plan;
  const checked = buildTileCatalog(catalog.entries);
  if (!checked.success) return checked;
  const normalized = normalizeRequest(checked.data, request);
  if (!normalized.success) return normalized;
  return decideTileSelectionAgainstOffer(checked.data, normalized.data, plan.data.offer, decision);
}

/** Recompute the same offer and decision receipt from their original inputs. */
export function replayTileSelectionDecision(
  catalog: TileCatalog,
  request: TileSelectionRequest,
  facts: readonly TileSelectionFact[],
  decision: TileSelectionDecision,
): TileResult<TileSelectionDecisionReceipt> {
  return decideTileSelection(catalog, request, facts, decision);
}
