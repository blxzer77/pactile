import {
  PACTILE_CONTRACT_SCHEMA_VERSION,
  type ContractDecoderV1,
  type PactileContractParseResultV1,
  childPathV1,
  decodeLogicalIdV1,
  decodeNullableTimestampV1,
  decodeSchemaVersionV1,
  decodeSemverV1,
  definePactileContractSchemaV1,
} from "./validation.js";

export const PACTILE_INTENTS_V1 = [
  "exact",
  "semantic",
  "structural",
  "external",
] as const;
export type PactileIntentV1 = (typeof PACTILE_INTENTS_V1)[number];

export const ASSURANCE_LEVELS_V1 = [
  "best-effort",
  "evidence-backed",
  "verified",
] as const;
export type Assurance = (typeof ASSURANCE_LEVELS_V1)[number];
export type AssuranceLevelV1 = Assurance;

export const PROVIDER_ORIGINS_V1 = [
  "native",
  "provider",
  "heuristic",
  "unsupported",
] as const;
export type ProviderOriginV1 = (typeof PROVIDER_ORIGINS_V1)[number];
export type SupportedProviderOriginV1 = Exclude<
  ProviderOriginV1,
  "unsupported"
>;

export const PROVIDER_READINESS_V1 = [
  "ready",
  "degraded",
  "unavailable",
] as const;
export type ProviderReadinessV1 = (typeof PROVIDER_READINESS_V1)[number];

export const FILESYSTEM_CEILINGS_V1 = ["none", "read", "write"] as const;
export type FilesystemCeilingV1 = (typeof FILESYSTEM_CEILINGS_V1)[number];

export const PROCESS_CEILINGS_V1 = ["none", "execute"] as const;
export type ProcessCeilingV1 = (typeof PROCESS_CEILINGS_V1)[number];

export const NETWORK_CEILINGS_V1 = [
  "forbidden",
  "project-authorized",
] as const;
export type NetworkCeilingV1 = (typeof NETWORK_CEILINGS_V1)[number];

export const CREDENTIAL_CEILINGS_V1 = [
  "forbidden",
  "project-authorized",
] as const;
export type CredentialCeilingV1 = (typeof CREDENTIAL_CEILINGS_V1)[number];

export const PRIVACY_CEILINGS_V1 = [
  "local-only",
  "project-approved-egress",
  "external",
] as const;
export type PrivacyCeilingV1 = (typeof PRIVACY_CEILINGS_V1)[number];

export const TELEMETRY_CEILINGS_V1 = [
  "forbidden",
  "local-only",
  "project-authorized",
] as const;
export type TelemetryCeilingV1 = (typeof TELEMETRY_CEILINGS_V1)[number];

export const COST_CEILINGS_V1 = [
  "none",
  "free",
  "low",
  "medium",
  "high",
] as const;
export type CostCeilingV1 = (typeof COST_CEILINGS_V1)[number];

export interface PolicyCeilingV1 {
  readonly filesystem: FilesystemCeilingV1;
  readonly process: ProcessCeilingV1;
  readonly network: NetworkCeilingV1;
  readonly credentials: CredentialCeilingV1;
  readonly privacy: PrivacyCeilingV1;
  readonly egressDestinations: readonly string[];
  readonly telemetry: TelemetryCeilingV1;
  readonly cost: CostCeilingV1;
}

export interface ProviderProbePolicyV1 {
  readonly supported: boolean;
  readonly maxAgeSeconds: number | null;
}

export interface ProviderManifestV1 {
  readonly schemaVersion: typeof PACTILE_CONTRACT_SCHEMA_VERSION;
  readonly id: string;
  readonly version: string;
  readonly origin: SupportedProviderOriginV1;
  readonly intents: readonly PactileIntentV1[];
  readonly capabilityIds: readonly string[];
  readonly maximumAssurance: AssuranceLevelV1;
  readonly policyCeiling: PolicyCeilingV1;
  readonly evidenceKinds: readonly string[];
  readonly probe: ProviderProbePolicyV1;
}

export const PROVIDER_FRESHNESS_V1 = [
  "fresh",
  "stale",
  "unknown",
  "not-applicable",
] as const;
export type ProviderFreshnessV1 = (typeof PROVIDER_FRESHNESS_V1)[number];

export const PROVIDER_PROBE_RESULTS_V1 = [
  "passed",
  "failed",
  "not-run",
] as const;
export type ProviderProbeResultV1 =
  (typeof PROVIDER_PROBE_RESULTS_V1)[number];

export interface ResolvedProviderV1 {
  readonly schemaVersion: typeof PACTILE_CONTRACT_SCHEMA_VERSION;
  readonly intent: PactileIntentV1;
  readonly minimumAssurance: AssuranceLevelV1;
  readonly origin: ProviderOriginV1;
  readonly providerId: string | null;
  readonly providerVersion: string | null;
  readonly assurance: AssuranceLevelV1 | null;
  readonly readiness: ProviderReadinessV1;
  readonly requestedPolicy: PolicyCeilingV1;
  readonly effectivePolicy: PolicyCeilingV1 | null;
  readonly evidenceRefs: readonly string[];
  readonly freshness: ProviderFreshnessV1;
  readonly probedAt: string | null;
  readonly probeResult: ProviderProbeResultV1;
  readonly fallbackFromProviderId: string | null;
}

const rank = <T extends string>(values: readonly T[], value: T): number =>
  values.indexOf(value);

export function assuranceSatisfiesV1(
  actual: AssuranceLevelV1,
  minimum: AssuranceLevelV1,
): boolean {
  return rank(ASSURANCE_LEVELS_V1, actual) >= rank(ASSURANCE_LEVELS_V1, minimum);
}

/** True when every requested capability stays at or below the policy ceiling. */
export function policyWithinCeilingV1(
  requested: PolicyCeilingV1,
  ceiling: PolicyCeilingV1,
): boolean {
  return (
    rank(FILESYSTEM_CEILINGS_V1, requested.filesystem) <=
      rank(FILESYSTEM_CEILINGS_V1, ceiling.filesystem) &&
    rank(PROCESS_CEILINGS_V1, requested.process) <=
      rank(PROCESS_CEILINGS_V1, ceiling.process) &&
    rank(NETWORK_CEILINGS_V1, requested.network) <=
      rank(NETWORK_CEILINGS_V1, ceiling.network) &&
    rank(CREDENTIAL_CEILINGS_V1, requested.credentials) <=
      rank(CREDENTIAL_CEILINGS_V1, ceiling.credentials) &&
    rank(PRIVACY_CEILINGS_V1, requested.privacy) <=
      rank(PRIVACY_CEILINGS_V1, ceiling.privacy) &&
    requested.egressDestinations.every((destination) =>
      ceiling.egressDestinations.includes(destination),
    ) &&
    rank(TELEMETRY_CEILINGS_V1, requested.telemetry) <=
      rank(TELEMETRY_CEILINGS_V1, ceiling.telemetry) &&
    rank(COST_CEILINGS_V1, requested.cost) <=
      rank(COST_CEILINGS_V1, ceiling.cost)
  );
}

export function decodePolicyCeilingV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): PolicyCeilingV1 {
  const record = decoder.object(value, path, [
    "filesystem",
    "process",
    "network",
    "credentials",
    "privacy",
    "egressDestinations",
    "telemetry",
    "cost",
  ]);
  const policy: PolicyCeilingV1 = {
    filesystem: decoder.enumValue(
      decoder.required(record, "filesystem", path),
      FILESYSTEM_CEILINGS_V1,
      childPathV1(path, "filesystem"),
    ),
    process: decoder.enumValue(
      decoder.required(record, "process", path),
      PROCESS_CEILINGS_V1,
      childPathV1(path, "process"),
    ),
    network: decoder.enumValue(
      decoder.required(record, "network", path),
      NETWORK_CEILINGS_V1,
      childPathV1(path, "network"),
    ),
    credentials: decoder.enumValue(
      decoder.required(record, "credentials", path),
      CREDENTIAL_CEILINGS_V1,
      childPathV1(path, "credentials"),
    ),
    privacy: decoder.enumValue(
      decoder.required(record, "privacy", path),
      PRIVACY_CEILINGS_V1,
      childPathV1(path, "privacy"),
    ),
    egressDestinations: decoder.stringArray(
      decoder.required(record, "egressDestinations", path),
      childPathV1(path, "egressDestinations"),
      { nonEmptyItems: true, unique: true },
    ),
    telemetry: decoder.enumValue(
      decoder.required(record, "telemetry", path),
      TELEMETRY_CEILINGS_V1,
      childPathV1(path, "telemetry"),
    ),
    cost: decoder.enumValue(
      decoder.required(record, "cost", path),
      COST_CEILINGS_V1,
      childPathV1(path, "cost"),
    ),
  };
  if (
    policy.network === "forbidden" &&
    (policy.privacy !== "local-only" || policy.egressDestinations.length > 0)
  ) {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "privacy"),
      "network-forbidden policy cannot permit egress privacy levels or destinations",
    );
  }
  if (
    policy.network === "project-authorized" &&
    policy.privacy !== "local-only" &&
    policy.egressDestinations.length === 0
  ) {
    decoder.issue(
      "required",
      childPathV1(path, "egressDestinations"),
      "must declare allowed destinations when external egress is permitted",
    );
  }
  if (
    policy.network === "forbidden" &&
    policy.telemetry === "project-authorized"
  ) {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "telemetry"),
      "network-forbidden policy cannot permit remote telemetry",
    );
  }
  return policy;
}

function decodeProviderProbePolicyV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): ProviderProbePolicyV1 {
  const record = decoder.object(value, path, ["supported", "maxAgeSeconds"]);
  const supported = decoder.boolean(
    decoder.required(record, "supported", path),
    childPathV1(path, "supported"),
  );
  const maxAgeValue = decoder.required(record, "maxAgeSeconds", path);
  let maxAgeSeconds: number | null;
  if (maxAgeValue === null) {
    maxAgeSeconds = null;
  } else {
    maxAgeSeconds = decoder.integer(
      maxAgeValue,
      childPathV1(path, "maxAgeSeconds"),
      { min: 1 },
    );
  }
  if (supported && maxAgeSeconds === null) {
    decoder.issue(
      "required",
      childPathV1(path, "maxAgeSeconds"),
      "is required when probe support is enabled",
    );
  }
  if (!supported && maxAgeSeconds !== null) {
    decoder.issue(
      "conflict",
      childPathV1(path, "maxAgeSeconds"),
      "must be null when probe support is disabled",
    );
  }
  return { supported, maxAgeSeconds };
}

function decodeProviderManifestV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): ProviderManifestV1 {
  const record = decoder.object(value, path, [
    "schemaVersion",
    "id",
    "version",
    "origin",
    "intents",
    "capabilityIds",
    "maximumAssurance",
    "policyCeiling",
    "evidenceKinds",
    "probe",
  ]);
  const intents = decoder.array(
    decoder.required(record, "intents", path),
    childPathV1(path, "intents"),
    (item, itemPath) => decoder.enumValue(item, PACTILE_INTENTS_V1, itemPath),
  );
  decoder.unique(intents, (intent) => intent, childPathV1(path, "intents"), "intent");
  if (intents.length === 0) {
    decoder.issue(
      "invalid-value",
      childPathV1(path, "intents"),
      "must declare at least one intent",
    );
  }
  const maximumAssurance = decoder.enumValue(
    decoder.required(record, "maximumAssurance", path),
    ASSURANCE_LEVELS_V1,
    childPathV1(path, "maximumAssurance"),
  );
  const evidenceKinds = decoder.stringArray(
    decoder.required(record, "evidenceKinds", path),
    childPathV1(path, "evidenceKinds"),
    { nonEmptyItems: true, unique: true },
  );
  const probe = decodeProviderProbePolicyV1(
    decoder.required(record, "probe", path),
    decoder,
    childPathV1(path, "probe"),
  );
  if (
    assuranceSatisfiesV1(maximumAssurance, "evidence-backed") &&
    evidenceKinds.length === 0
  ) {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "evidenceKinds"),
      "evidence-backed or verified providers must declare evidence kinds",
    );
  }
  if (maximumAssurance === "verified" && !probe.supported) {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "probe"),
      "verified capability requires a freshness-bounded probe",
    );
  }

  return {
    schemaVersion: decodeSchemaVersionV1(record, decoder, path),
    id: decodeLogicalIdV1(
      decoder.required(record, "id", path),
      decoder,
      childPathV1(path, "id"),
    ),
    version: decodeSemverV1(
      decoder.required(record, "version", path),
      decoder,
      childPathV1(path, "version"),
    ),
    origin: decoder.enumValue(
      decoder.required(record, "origin", path),
      ["native", "provider", "heuristic"] as const,
      childPathV1(path, "origin"),
    ),
    intents,
    capabilityIds: decoder.stringArray(
      decoder.required(record, "capabilityIds", path),
      childPathV1(path, "capabilityIds"),
      {
        nonEmptyItems: true,
        unique: true,
        pattern: /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/,
        patternDescription: "a lowercase logical capability id",
      },
    ),
    maximumAssurance,
    policyCeiling: decodePolicyCeilingV1(
      decoder.required(record, "policyCeiling", path),
      decoder,
      childPathV1(path, "policyCeiling"),
    ),
    evidenceKinds,
    probe,
  };
}

function decodeNullableLogicalIdV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): string | null {
  if (value === null) return null;
  return decodeLogicalIdV1(value, decoder, path);
}

function decodeNullableSemverV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): string | null {
  if (value === null) return null;
  return decodeSemverV1(value, decoder, path);
}

function decodeNullableAssuranceV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): AssuranceLevelV1 | null {
  if (value === null) return null;
  return decoder.enumValue(value, ASSURANCE_LEVELS_V1, path);
}

function decodeNullablePolicyV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): PolicyCeilingV1 | null {
  if (value === null) return null;
  return decodePolicyCeilingV1(value, decoder, path);
}

function decodeResolvedProviderV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): ResolvedProviderV1 {
  const record = decoder.object(value, path, [
    "schemaVersion",
    "intent",
    "minimumAssurance",
    "origin",
    "providerId",
    "providerVersion",
    "assurance",
    "readiness",
    "requestedPolicy",
    "effectivePolicy",
    "evidenceRefs",
    "freshness",
    "probedAt",
    "probeResult",
    "fallbackFromProviderId",
  ]);
  const origin = decoder.enumValue(
    decoder.required(record, "origin", path),
    PROVIDER_ORIGINS_V1,
    childPathV1(path, "origin"),
  );
  const providerId = decodeNullableLogicalIdV1(
    decoder.required(record, "providerId", path),
    decoder,
    childPathV1(path, "providerId"),
  );
  const providerVersion = decodeNullableSemverV1(
    decoder.required(record, "providerVersion", path),
    decoder,
    childPathV1(path, "providerVersion"),
  );
  const minimumAssurance = decoder.enumValue(
    decoder.required(record, "minimumAssurance", path),
    ASSURANCE_LEVELS_V1,
    childPathV1(path, "minimumAssurance"),
  );
  const assurance = decodeNullableAssuranceV1(
    decoder.required(record, "assurance", path),
    decoder,
    childPathV1(path, "assurance"),
  );
  const readiness = decoder.enumValue(
    decoder.required(record, "readiness", path),
    PROVIDER_READINESS_V1,
    childPathV1(path, "readiness"),
  );
  const requestedPolicy = decodePolicyCeilingV1(
    decoder.required(record, "requestedPolicy", path),
    decoder,
    childPathV1(path, "requestedPolicy"),
  );
  const effectivePolicy = decodeNullablePolicyV1(
    decoder.required(record, "effectivePolicy", path),
    decoder,
    childPathV1(path, "effectivePolicy"),
  );
  const evidenceRefs = decoder.stringArray(
    decoder.required(record, "evidenceRefs", path),
    childPathV1(path, "evidenceRefs"),
    { nonEmptyItems: true, unique: true },
  );
  const freshness = decoder.enumValue(
    decoder.required(record, "freshness", path),
    PROVIDER_FRESHNESS_V1,
    childPathV1(path, "freshness"),
  );
  const probedAt = decodeNullableTimestampV1(
    decoder.required(record, "probedAt", path),
    decoder,
    childPathV1(path, "probedAt"),
  );
  const probeResult = decoder.enumValue(
    decoder.required(record, "probeResult", path),
    PROVIDER_PROBE_RESULTS_V1,
    childPathV1(path, "probeResult"),
  );
  const fallbackFromProviderId = decodeNullableLogicalIdV1(
    decoder.required(record, "fallbackFromProviderId", path),
    decoder,
    childPathV1(path, "fallbackFromProviderId"),
  );

  if (origin === "unsupported") {
    if (
      providerId !== null ||
      providerVersion !== null ||
      assurance !== null ||
      effectivePolicy !== null
    ) {
      decoder.issue(
        "conflict",
        path,
        "unsupported resolution cannot claim a provider, assurance, or effective policy",
      );
    }
    if (
      readiness !== "unavailable" ||
      evidenceRefs.length > 0 ||
      freshness !== "not-applicable" ||
      probedAt !== null ||
      probeResult !== "not-run"
    ) {
      decoder.issue(
        "conflict",
        path,
        "unsupported resolution must be unavailable with no evidence or probe claim",
      );
    }
  } else {
    if (providerId === null || providerVersion === null || assurance === null) {
      decoder.issue(
        "required",
        path,
        "supported resolution requires providerId, providerVersion, and assurance",
      );
    }
    if (effectivePolicy === null) {
      decoder.issue(
        "required",
        childPathV1(path, "effectivePolicy"),
        "is required for a supported resolution",
      );
    } else if (!policyWithinCeilingV1(effectivePolicy, requestedPolicy)) {
      decoder.issue(
        "policy-violation",
        childPathV1(path, "effectivePolicy"),
        "must not exceed the requested authorization, privacy, credential, telemetry, or cost ceiling",
      );
    }
    if (readiness === "unavailable") {
      decoder.issue(
        "conflict",
        childPathV1(path, "readiness"),
        "supported origin cannot report unavailable readiness",
      );
    }
    if (assurance !== null) {
      if (!assuranceSatisfiesV1(assurance, minimumAssurance)) {
        decoder.issue(
          "policy-violation",
          childPathV1(path, "assurance"),
          `does not satisfy minimum assurance '${minimumAssurance}'`,
        );
      }
      if (
        assuranceSatisfiesV1(assurance, "evidence-backed") &&
        evidenceRefs.length === 0
      ) {
        decoder.issue(
          "policy-violation",
          childPathV1(path, "evidenceRefs"),
          "evidence-backed or verified assurance requires evidence references",
        );
      }
      if (
        assurance === "verified" &&
        (freshness !== "fresh" || probeResult !== "passed" || probedAt === null)
      ) {
        decoder.issue(
          "policy-violation",
          path,
          "verified assurance requires fresh evidence from a passed, timestamped probe",
        );
      }
    }
    if (probeResult === "not-run" && probedAt !== null) {
      decoder.issue(
        "conflict",
        childPathV1(path, "probedAt"),
        "must be null when no probe ran",
      );
    }
    if (probeResult !== "not-run" && probedAt === null) {
      decoder.issue(
        "required",
        childPathV1(path, "probedAt"),
        "is required when a probe ran",
      );
    }
  }
  if (providerId !== null && fallbackFromProviderId === providerId) {
    decoder.issue(
      "conflict",
      childPathV1(path, "fallbackFromProviderId"),
      "must differ from the resolved provider id",
    );
  }

  return {
    schemaVersion: decodeSchemaVersionV1(record, decoder, path),
    intent: decoder.enumValue(
      decoder.required(record, "intent", path),
      PACTILE_INTENTS_V1,
      childPathV1(path, "intent"),
    ),
    minimumAssurance,
    origin,
    providerId,
    providerVersion,
    assurance,
    readiness,
    requestedPolicy,
    effectivePolicy,
    evidenceRefs,
    freshness,
    probedAt,
    probeResult,
    fallbackFromProviderId,
  };
}

export const providerManifestV1Schema = definePactileContractSchemaV1(
  "ProviderManifestV1",
  decodeProviderManifestV1,
);

export const resolvedProviderV1Schema = definePactileContractSchemaV1(
  "ResolvedProviderV1",
  decodeResolvedProviderV1,
);

export function parseProviderManifestV1(
  input: unknown,
): PactileContractParseResultV1<ProviderManifestV1> {
  return providerManifestV1Schema.parse(input);
}

export function parseResolvedProviderV1(
  input: unknown,
): PactileContractParseResultV1<ResolvedProviderV1> {
  return resolvedProviderV1Schema.parse(input);
}
