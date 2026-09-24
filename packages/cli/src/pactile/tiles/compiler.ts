import {
  ASSURANCE_LEVELS_V1,
  COST_CEILINGS_V1,
  CREDENTIAL_CEILINGS_V1,
  FILESYSTEM_CEILINGS_V1,
  NETWORK_CEILINGS_V1,
  PRIVACY_CEILINGS_V1,
  PROCESS_CEILINGS_V1,
  TELEMETRY_CEILINGS_V1,
  assuranceSatisfiesV1,
  fingerprintPactileContractV1,
  parseResolvedProviderV1,
  parseTileManifestV1,
  policyWithinCeilingV1,
  tilePolicyCeilingV1,
  type AssuranceLevelV1,
  type PolicyCeilingV1,
  type ResolvedProviderV1,
  type TileEvidenceKindV1,
  type TileManifestV1,
  type TileStopConditionV1,
} from "../../core/index.js";
import {
  buildTileCatalog,
  compareTileRefs,
  conflictDiagnostics,
  diagnostic,
  expandTileSelection,
  isCanonicalTileCallerReference,
  resolveTileReference,
  sortTileDiagnostics,
  type TileCatalog,
} from "./catalog.js";
import {
  TILE_COMPILER_ABI_VERSION,
  type TileDiagnostic,
  type TileResult,
} from "./loader.js";

/** Facts come from the caller, never from environment/config discovery here. */
export interface TileCapabilityFact {
  readonly id: string;
  readonly assurance: AssuranceLevelV1;
}
export interface TileProviderFact {
  readonly capabilityIds: readonly string[];
  readonly authorized: boolean;
  readonly resolution: ResolvedProviderV1;
}
export interface TileCompositionRequest {
  readonly requestedSelection: readonly string[];
  readonly capabilities: readonly TileCapabilityFact[];
  readonly providerFacts?: readonly TileProviderFact[];
  readonly policyCeiling?: PolicyCeilingV1;
  /** Explicit caller choice of fallback, not a compiler-selected alternate. */
  readonly fallbackTileIds?: readonly string[];
}
export interface CompiledTile {
  readonly ref: string;
  readonly manifest: TileManifestV1;
  readonly fingerprint: string;
}
export interface TileEvidenceObligation {
  readonly kind: TileEvidenceKindV1;
  readonly required: boolean;
  readonly description: string;
  readonly tileRefs: readonly string[];
}
export interface TileStopObligation {
  readonly condition: TileStopConditionV1;
  readonly tileRefs: readonly string[];
}
export interface CompiledComposition {
  readonly compilerAbiVersion: typeof TILE_COMPILER_ABI_VERSION;
  readonly requestedSelection: readonly string[];
  readonly expandedSelection: readonly string[];
  readonly fallbackSelection: readonly string[];
  readonly tiles: readonly CompiledTile[];
  readonly policyCeiling: PolicyCeilingV1;
  readonly minimumAssurance: AssuranceLevelV1;
  readonly evidenceObligations: readonly TileEvidenceObligation[];
  readonly stopObligations: readonly TileStopObligation[];
  readonly maxAttempts: number;
  readonly fingerprint: string;
}

function least<T extends string>(values: readonly T[], left: T, right: T): T {
  return values[Math.min(values.indexOf(left), values.indexOf(right))];
}

/** Intersection, not union: composing Tiles can only narrow authority. */
export function intersectTilePolicies(
  left: PolicyCeilingV1,
  right: PolicyCeilingV1,
): PolicyCeilingV1 {
  let network = least(NETWORK_CEILINGS_V1, left.network, right.network);
  let privacy = least(PRIVACY_CEILINGS_V1, left.privacy, right.privacy);
  const destinations = left.egressDestinations
    .filter((destination) => right.egressDestinations.includes(destination))
    .sort(compareTileRefs);
  if (destinations.length === 0 || privacy === "local-only") {
    network = "forbidden";
    privacy = "local-only";
  }
  let telemetry = least(TELEMETRY_CEILINGS_V1, left.telemetry, right.telemetry);
  if (network === "forbidden" && telemetry === "project-authorized")
    telemetry = "local-only";
  return {
    filesystem: least(
      FILESYSTEM_CEILINGS_V1,
      left.filesystem,
      right.filesystem,
    ),
    process: least(PROCESS_CEILINGS_V1, left.process, right.process),
    network,
    credentials: least(
      CREDENTIAL_CEILINGS_V1,
      left.credentials,
      right.credentials,
    ),
    privacy,
    egressDestinations: network === "forbidden" ? [] : destinations,
    telemetry,
    cost: least(COST_CEILINGS_V1, left.cost, right.cost),
  };
}

function stricterAssurance(
  left: AssuranceLevelV1,
  right: AssuranceLevelV1,
): AssuranceLevelV1 {
  return assuranceSatisfiesV1(left, right) ? left : right;
}

function validateCallerReferences(
  request: TileCompositionRequest,
): TileDiagnostic[] {
  const issues: TileDiagnostic[] = [];
  const validate = (
    value: unknown,
    allowVersion: boolean,
    at: string,
  ): void => {
    if (!isCanonicalTileCallerReference(value, allowVersion)) {
      issues.push(diagnostic("tile-invalid-caller-reference", null, null, at));
    }
  };
  for (const [index, value] of request.requestedSelection.entries()) {
    validate(value, true, `$.requestedSelection[${index}]`);
  }
  for (const [index, value] of (request.fallbackTileIds ?? []).entries()) {
    validate(value, true, `$.fallbackTileIds[${index}]`);
  }
  for (const [index, fact] of request.capabilities.entries()) {
    validate(fact.id, false, `$.capabilities[${index}].id`);
  }
  for (const [providerIndex, fact] of (request.providerFacts ?? []).entries()) {
    for (const [index, value] of fact.capabilityIds.entries()) {
      validate(
        value,
        false,
        `$.providerFacts[${providerIndex}].capabilityIds[${index}]`,
      );
    }
  }
  return sortTileDiagnostics(issues);
}

/** Validate a model-owned selection and produce JSON data, never an execution plan. */
export function compileTileComposition(
  catalog: TileCatalog,
  request: TileCompositionRequest,
): TileResult<CompiledComposition> {
  const malformed = validateCallerReferences(request);
  if (malformed.length) return { success: false, diagnostics: malformed };
  // Revalidate entries at this boundary instead of trusting a mutable catalog cache.
  const checked = buildTileCatalog(catalog.entries);
  if (!checked.success) return checked;
  const diagnostics: TileDiagnostic[] = [];
  if (!request.requestedSelection.length)
    return {
      success: false,
      diagnostics: [diagnostic("tile-empty-selection", null)],
    };
  if (
    new Set(request.requestedSelection).size !==
    request.requestedSelection.length
  )
    return {
      success: false,
      diagnostics: [diagnostic("tile-duplicate-selection", null)],
    };
  const closure = expandTileSelection(
    checked.data.entries,
    request.requestedSelection,
  );
  if (!closure.success) return closure;
  diagnostics.push(...conflictDiagnostics(closure.data));
  const requested = request.requestedSelection
    .flatMap((reference) => {
      const resolved = resolveTileReference(checked.data.entries, reference);
      return resolved.success ? [resolved.data.ref] : [];
    })
    .sort(compareTileRefs);
  if (new Set(requested).size !== requested.length)
    diagnostics.push(diagnostic("tile-duplicate-selection", null));
  const fallback = new Set<string>();
  for (const reference of request.fallbackTileIds ?? []) {
    const found = resolveTileReference(closure.data, reference);
    if (!found.success)
      diagnostics.push(
        diagnostic("tile-invalid-fallback-selection", null, reference),
      );
    else fallback.add(found.data.ref);
  }
  let policy: PolicyCeilingV1 | undefined;
  let assurance: AssuranceLevelV1 = "best-effort";
  for (const entry of closure.data) {
    let ceiling = tilePolicyCeilingV1(entry.manifest);
    let minimum = entry.manifest.minimumAssurance;
    if (fallback.has(entry.ref)) {
      const alternate = entry.manifest.fallback;
      if (
        !alternate.allowed ||
        !alternate.policy ||
        !alternate.minimumAssurance
      )
        diagnostics.push(diagnostic("tile-fallback-denied", entry.ref));
      else {
        ceiling = tilePolicyCeilingV1(alternate.policy);
        minimum = alternate.minimumAssurance;
      }
    }
    policy = policy ? intersectTilePolicies(policy, ceiling) : ceiling;
    assurance = stricterAssurance(assurance, minimum);
  }
  if (!policy)
    return {
      success: false,
      diagnostics: [diagnostic("tile-empty-selection", null)],
    };
  if (request.policyCeiling) {
    // Use the M0 decoder for policy values too; do not invent a second enum schema.
    const supplied = request.policyCeiling;
    const validation = parseTileManifestV1({
      ...closure.data[0].manifest,
      permissions: {
        filesystem: supplied.filesystem,
        process: supplied.process,
        credentials: supplied.credentials,
      },
      egress: {
        network: supplied.network,
        privacy: supplied.privacy,
        telemetry: supplied.telemetry,
        destinations: supplied.egressDestinations,
      },
      cost: { ceiling: supplied.cost },
      fallback: { allowed: false, minimumAssurance: null, policy: null },
    });
    if (!validation.success)
      return {
        success: false,
        diagnostics: [diagnostic("tile-invalid-policy", null)],
      };
    policy = intersectTilePolicies(
      policy,
      tilePolicyCeilingV1(validation.data),
    );
  }

  const capabilities = new Map<string, AssuranceLevelV1>();
  for (const fact of request.capabilities) {
    if (!ASSURANCE_LEVELS_V1.includes(fact.assurance)) {
      diagnostics.push(diagnostic("tile-invalid-capability", null, fact.id));
      continue;
    }
    const previous = capabilities.get(fact.id);
    // Contradictory duplicate facts conservatively keep the weaker assurance.
    capabilities.set(
      fact.id,
      previous
        ? least(ASSURANCE_LEVELS_V1, previous, fact.assurance)
        : fact.assurance,
    );
  }
  for (const fact of request.providerFacts ?? []) {
    const parsed = parseResolvedProviderV1(fact.resolution);
    if (!parsed.success) {
      diagnostics.push(diagnostic("tile-invalid-provider-fact", null));
      continue;
    }
    const resolved = parsed.data;
    const consumers = closure.data.filter((entry) =>
      entry.manifest.inputs.some((input) => fact.capabilityIds.includes(input)),
    );
    if (
      consumers.some(
        (entry) => !entry.manifest.trigger.intents.includes(resolved.intent),
      )
    ) {
      diagnostics.push(diagnostic("tile-provider-intent-denied", null));
      continue;
    }
    if (
      fact.authorized !== true ||
      resolved.origin === "unsupported" ||
      resolved.readiness !== "ready" ||
      resolved.assurance === null ||
      (resolved.freshness !== "fresh" &&
        resolved.freshness !== "not-applicable")
    ) {
      diagnostics.push(diagnostic("tile-provider-unavailable", null));
      continue;
    }
    if (resolved.fallbackFromProviderId !== null) {
      if (
        !consumers.length ||
        consumers.some((entry) => !fallback.has(entry.ref))
      ) {
        diagnostics.push(diagnostic("tile-provider-fallback-denied", null));
        continue;
      }
    }
    if (
      !resolved.effectivePolicy ||
      !policyWithinCeilingV1(resolved.effectivePolicy, policy) ||
      !assuranceSatisfiesV1(resolved.assurance, assurance)
    ) {
      diagnostics.push(diagnostic("tile-provider-policy-denied", null));
      continue;
    }
    for (const id of fact.capabilityIds) {
      const previous = capabilities.get(id);
      capabilities.set(
        id,
        previous
          ? least(ASSURANCE_LEVELS_V1, previous, resolved.assurance)
          : resolved.assurance,
      );
    }
  }
  const inheritedOutputs = new Map<string, Map<string, AssuranceLevelV1>>();
  for (const entry of closure.data) {
    const available = new Map(capabilities);
    for (const dependency of entry.manifest.dependencies)
      for (const [id, level] of inheritedOutputs.get(dependency) ?? []) {
        const existing = available.get(id);
        available.set(
          id,
          existing ? stricterAssurance(existing, level) : level,
        );
      }
    const minimum = fallback.has(entry.ref)
      ? (entry.manifest.fallback.minimumAssurance ??
        entry.manifest.minimumAssurance)
      : entry.manifest.minimumAssurance;
    for (const input of entry.manifest.inputs) {
      const actual = available.get(input);
      if (!actual)
        diagnostics.push(
          diagnostic("tile-missing-capability", entry.ref, input),
        );
      else if (!assuranceSatisfiesV1(actual, minimum))
        diagnostics.push(
          diagnostic("tile-capability-assurance-denied", entry.ref, input),
        );
    }
    for (const output of entry.manifest.outputs) available.set(output, minimum);
    inheritedOutputs.set(entry.manifest.identity.id, available);
  }
  if (diagnostics.length)
    return { success: false, diagnostics: sortTileDiagnostics(diagnostics) };

  const evidence = new Map<
    string,
    {
      kind: TileEvidenceKindV1;
      required: boolean;
      description: string;
      tileRefs: string[];
    }
  >();
  const stops = new Map<TileStopConditionV1, string[]>();
  for (const entry of closure.data) {
    for (const obligation of entry.manifest.evidence) {
      const key = JSON.stringify([obligation.kind, obligation.description]);
      const prior = evidence.get(key);
      evidence.set(key, {
        ...obligation,
        required: obligation.required || (prior?.required ?? false),
        tileRefs: [...(prior?.tileRefs ?? []), entry.ref].sort(compareTileRefs),
      });
    }
    for (const condition of entry.manifest.stop.conditions)
      stops.set(
        condition,
        [...(stops.get(condition) ?? []), entry.ref].sort(compareTileRefs),
      );
  }
  const candidate = {
    compilerAbiVersion: TILE_COMPILER_ABI_VERSION,
    requestedSelection: requested,
    expandedSelection: closure.data.map((entry) => entry.ref),
    fallbackSelection: [...fallback].sort(compareTileRefs),
    tiles: closure.data.map(({ ref, manifest, fingerprint }) => ({
      ref,
      manifest,
      fingerprint,
    })),
    policyCeiling: policy,
    minimumAssurance: assurance,
    evidenceObligations: [...evidence.entries()]
      .sort(([a], [b]) => compareTileRefs(a, b))
      .map(([, value]) => value),
    stopObligations: [...stops.entries()]
      .sort(([a], [b]) => compareTileRefs(a, b))
      .map(([condition, tileRefs]) => ({ condition, tileRefs })),
    maxAttempts: Math.min(
      ...closure.data.map((entry) => entry.manifest.stop.maxAttempts),
    ),
  };
  return {
    success: true,
    data: {
      ...candidate,
      fingerprint: fingerprintPactileContractV1(candidate),
    },
  };
}
