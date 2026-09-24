import { types as utilTypes } from "node:util";

import type { CapabilityBindingV1 } from "../capability.js";
import { parseCapabilityBindingV1 } from "../capability.js";
import {
  ASSURANCE_LEVELS_V1,
  COST_CEILINGS_V1,
  CREDENTIAL_CEILINGS_V1,
  FILESYSTEM_CEILINGS_V1,
  NETWORK_CEILINGS_V1,
  PRIVACY_CEILINGS_V1,
  PROCESS_CEILINGS_V1,
  PROVIDER_FRESHNESS_V1,
  PROVIDER_PROBE_RESULTS_V1,
  PROVIDER_READINESS_V1,
  TELEMETRY_CEILINGS_V1,
  assuranceSatisfiesV1,
  parseProviderManifestV1,
  parseResolvedProviderV1,
  policyWithinCeilingV1,
  type AssuranceLevelV1,
  type PactileIntentV1,
  type PolicyCeilingV1,
  type ProviderFreshnessV1,
  type ProviderManifestV1,
  type ProviderProbeResultV1,
  type ProviderReadinessV1,
  type ResolvedProviderV1,
} from "../provider.js";
import {
  PACTILE_CONTRACT_SCHEMA_VERSION,
  PACTILE_LOGICAL_ID_PATTERN,
  PACTILE_SEMVER_PATTERN,
  fingerprintPactileContractV1,
} from "../validation.js";
import {
  isSafeEvidenceReferenceV1,
  isSafePolicyDestinationV1,
} from "./redaction.js";

export const PROVIDER_RESOLUTION_REASON_CODES_V1 = [
  "provider-selected",
  "provider-unsupported",
  "provider-input-invalid",
  "provider-manifest-invalid",
  "provider-manifest-duplicate",
  "provider-runtime-fact-duplicate",
  "provider-binding-duplicate",
  "provider-not-authorized",
  "provider-intent-mismatch",
  "provider-capability-mismatch",
  "provider-policy-filesystem-exceeded",
  "provider-policy-process-exceeded",
  "provider-policy-network-exceeded",
  "provider-policy-credentials-exceeded",
  "provider-policy-privacy-exceeded",
  "provider-policy-egress-exceeded",
  "provider-policy-telemetry-exceeded",
  "provider-policy-cost-exceeded",
  "provider-policy-exceeded",
  "provider-binding-missing",
  "provider-binding-capability-mismatch",
  "provider-binding-intent-mismatch",
  "provider-binding-readiness-unknown",
  "provider-binding-unavailable",
  "provider-runtime-fact-missing",
  "provider-runtime-version-mismatch",
  "provider-readiness-unknown",
  "provider-readiness-unavailable",
  "provider-probe-unexpected",
  "provider-probe-not-run",
  "provider-probe-failed",
  "provider-probe-time-invalid",
  "provider-probe-from-future",
  "provider-probe-expired",
  "provider-freshness-unknown",
  "provider-freshness-stale",
  "provider-assurance-exceeds-manifest",
  "provider-assurance-insufficient",
  "provider-evidence-missing",
  "provider-degraded-without-evidence",
  "provider-active-missing",
  "provider-fallback-disabled",
  "provider-not-preferred",
  "provider-not-selected",
  "provider-eligible",
  "provider-selected-active",
  "provider-selected-fallback",
  "provider-selected-stable",
] as const;

export type ProviderResolutionReasonCodeV1 =
  (typeof PROVIDER_RESOLUTION_REASON_CODES_V1)[number];

export type ProviderRuntimeReadinessV1 = ProviderReadinessV1 | "unknown";

export interface ProviderRuntimeFactV1 {
  providerId: string;
  providerVersion: string;
  readiness: ProviderRuntimeReadinessV1;
  assurance: AssuranceLevelV1 | null;
  freshness: ProviderFreshnessV1;
  probedAt: string | null;
  probeResult: ProviderProbeResultV1;
  evidenceRefs: readonly string[];
}

export interface ProviderResolutionInputV1 {
  schemaVersion: typeof PACTILE_CONTRACT_SCHEMA_VERSION;
  intent: PactileIntentV1;
  capabilityId: string | null;
  minimumAssurance: AssuranceLevelV1;
  requestedPolicy: PolicyCeilingV1;
  authorizedProviderIds: readonly string[];
  activeProviderIds: readonly string[];
  standbyProviderIds: readonly string[];
  fallbackAllowed: boolean;
  manifests: readonly ProviderManifestV1[];
  bindings: readonly CapabilityBindingV1[];
  runtimeFacts: readonly ProviderRuntimeFactV1[];
  now: string;
}

export type ProviderCandidateRoleV1 = "active" | "standby" | "default";

export interface ProviderCandidateExplainV1 {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly role: ProviderCandidateRoleV1;
  readonly accepted: boolean;
  readonly selected: boolean;
  readonly reasonCodes: readonly ProviderResolutionReasonCodeV1[];
  readonly effectivePolicy: PolicyCeilingV1 | null;
  readonly evidenceRefs: readonly string[];
}

export interface ProviderExplainV1 {
  readonly schemaVersion: typeof PACTILE_CONTRACT_SCHEMA_VERSION;
  readonly decision: "supported" | "unsupported" | "invalid";
  readonly reasonCode: ProviderResolutionReasonCodeV1;
  readonly selectedProviderId: string | null;
  readonly fallbackFromProviderId: string | null;
  readonly effectivePolicy: PolicyCeilingV1 | null;
  readonly evidenceRefs: readonly string[];
  readonly candidates: readonly ProviderCandidateExplainV1[];
}

export interface ProviderResolutionResultV1 {
  readonly schemaVersion: typeof PACTILE_CONTRACT_SCHEMA_VERSION;
  readonly status: "supported" | "unsupported" | "invalid";
  readonly resolution: ResolvedProviderV1 | null;
  /** Fingerprint of normalized caller facts; `now` is intentionally excluded. */
  readonly fingerprint: string | null;
  readonly explain: ProviderExplainV1;
}

interface NormalizedInputV1 extends Omit<ProviderResolutionInputV1, "now"> {
  readonly nowEpochMs: number;
}

interface EvaluatedCandidateV1 {
  readonly manifest: ProviderManifestV1;
  readonly fact: ProviderRuntimeFactV1 | null;
  readonly role: ProviderCandidateRoleV1;
  readonly rejection: ProviderResolutionReasonCodeV1 | null;
}

const RFC3339_PATTERN =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(?:Z|([+-])([0-9]{2}):([0-9]{2}))$/;
const INVALID_JSON_VALUE = Symbol("invalid-json-value");
const FORBIDDEN_JSON_RECORD_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

type PlainJsonValue =
  | null
  | boolean
  | number
  | string
  | PlainJsonValue[]
  | { [key: string]: PlainJsonValue };

function snapshotPlainJsonValue(
  value: unknown,
  seen = new Set<object>(),
): PlainJsonValue | typeof INVALID_JSON_VALUE {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : INVALID_JSON_VALUE;
  }
  if (typeof value !== "object" || utilTypes.isProxy(value)) {
    return INVALID_JSON_VALUE;
  }
  if (seen.has(value)) return INVALID_JSON_VALUE;
  seen.add(value);
  const reject = (): typeof INVALID_JSON_VALUE => {
    seen.delete(value);
    return INVALID_JSON_VALUE;
  };

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      return reject();
    }
    const descriptors = Object.getOwnPropertyDescriptors(
      value,
    ) as unknown as Record<PropertyKey, PropertyDescriptor>;
    const descriptorKeys = Reflect.ownKeys(descriptors);
    if (descriptorKeys.some((key) => typeof key !== "string")) {
      return reject();
    }
    const lengthDescriptor: PropertyDescriptor | undefined =
      descriptors["length"];
    const arrayLength = lengthDescriptor?.value;
    if (
      lengthDescriptor === undefined ||
      typeof arrayLength !== "number" ||
      !Number.isSafeInteger(arrayLength) ||
      arrayLength < 0 ||
      descriptorKeys.length !== arrayLength + 1
    ) {
      return reject();
    }
    const result: PlainJsonValue[] = [];
    for (let index = 0; index < arrayLength; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return reject();
      }
      const item = snapshotPlainJsonValue(descriptor.value, seen);
      if (item === INVALID_JSON_VALUE) return reject();
      result.push(item);
    }
    seen.delete(value);
    return result;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return reject();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, PlainJsonValue> = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || FORBIDDEN_JSON_RECORD_KEYS.has(key)) {
      return reject();
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return reject();
    }
    const item = snapshotPlainJsonValue(descriptor.value, seen);
    if (item === INVALID_JSON_VALUE) return reject();
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: item,
      writable: true,
    });
  }
  seen.delete(value);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readExactOwnDataRecord(
  value: unknown,
  fieldNames: readonly string[],
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const knownFields = new Set(fieldNames);
  if (Object.keys(value).some((key) => !knownFields.has(key))) return null;

  const result: Record<string, unknown> = {};
  for (const fieldName of fieldNames) {
    const descriptor = Object.getOwnPropertyDescriptor(value, fieldName);
    if (descriptor === undefined || !("value" in descriptor)) return null;
    Object.defineProperty(result, fieldName, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    });
  }
  return result;
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(ordinalCompare);
}

function rank<T extends string>(values: readonly T[], value: T): number {
  return values.indexOf(value);
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function parseTimestampEpochMs(value: string): number | null {
  const match = RFC3339_PATTERN.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const offsetSign = match[8];
  const offsetHour = Number(match[9] ?? 0);
  const offsetMinute = Number(match[10] ?? 0);
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    year === 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysInMonth[month - 1] ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }

  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour, minute, second, Number(`${fraction}000`.slice(0, 3)));
  const signedOffsetMinutes =
    (offsetSign === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  return utc.getTime() - signedOffsetMinutes * 60_000;
}

function validTimestamp(value: string): boolean {
  return parseTimestampEpochMs(value) !== null;
}

function normalizePolicy(value: unknown): PolicyCeilingV1 | null {
  const fields = readExactOwnDataRecord(value, [
    "filesystem",
    "process",
    "network",
    "credentials",
    "privacy",
    "egressDestinations",
    "telemetry",
    "cost",
  ]);
  if (fields === null || !Array.isArray(fields.egressDestinations)) return null;
  if (
    !fields.egressDestinations.every(
      (item) => typeof item === "string" && isSafePolicyDestinationV1(item),
    )
  ) {
    return null;
  }
  return {
    filesystem: fields.filesystem as PolicyCeilingV1["filesystem"],
    process: fields.process as PolicyCeilingV1["process"],
    network: fields.network as PolicyCeilingV1["network"],
    credentials: fields.credentials as PolicyCeilingV1["credentials"],
    privacy: fields.privacy as PolicyCeilingV1["privacy"],
    egressDestinations: sortedUnique(fields.egressDestinations),
    telemetry: fields.telemetry as PolicyCeilingV1["telemetry"],
    cost: fields.cost as PolicyCeilingV1["cost"],
  };
}

function normalizeIdList(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item) =>
        typeof item === "string" && PACTILE_LOGICAL_ID_PATTERN.test(item),
    )
  ) {
    return null;
  }
  return sortedUnique(value);
}

function normalizeManifest(value: unknown): ProviderManifestV1 | null {
  const parsed = parseProviderManifestV1(value);
  if (!parsed.success) return null;
  const policyCeiling = normalizePolicy(parsed.data.policyCeiling);
  if (policyCeiling === null) return null;
  return {
    ...parsed.data,
    intents: [...parsed.data.intents].sort(ordinalCompare),
    capabilityIds: [...parsed.data.capabilityIds].sort(ordinalCompare),
    policyCeiling,
    evidenceKinds: [...parsed.data.evidenceKinds].sort(ordinalCompare),
  };
}

function normalizeBinding(value: unknown): CapabilityBindingV1 | null {
  const parsed = parseCapabilityBindingV1(value);
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    intents: [...parsed.data.intents].sort(ordinalCompare),
  };
}

function normalizeRuntimeFact(value: unknown): ProviderRuntimeFactV1 | null {
  const fields = readExactOwnDataRecord(value, [
    "providerId",
    "providerVersion",
    "readiness",
    "assurance",
    "freshness",
    "probedAt",
    "probeResult",
    "evidenceRefs",
  ]);
  if (fields === null) return null;
  if (
    typeof fields.providerId !== "string" ||
    !PACTILE_LOGICAL_ID_PATTERN.test(fields.providerId) ||
    typeof fields.providerVersion !== "string" ||
    !PACTILE_SEMVER_PATTERN.test(fields.providerVersion) ||
    ![...PROVIDER_READINESS_V1, "unknown"].includes(
      fields.readiness as ProviderRuntimeReadinessV1,
    ) ||
    !(
      fields.assurance === null ||
      ASSURANCE_LEVELS_V1.includes(fields.assurance as AssuranceLevelV1)
    ) ||
    !PROVIDER_FRESHNESS_V1.includes(fields.freshness as ProviderFreshnessV1) ||
    !PROVIDER_PROBE_RESULTS_V1.includes(
      fields.probeResult as ProviderProbeResultV1,
    ) ||
    !Array.isArray(fields.evidenceRefs) ||
    !fields.evidenceRefs.every(
      (item) => typeof item === "string" && isSafeEvidenceReferenceV1(item),
    )
  ) {
    return null;
  }
  if (
    !(
      fields.probedAt === null ||
      (typeof fields.probedAt === "string" && validTimestamp(fields.probedAt))
    )
  ) {
    return null;
  }
  if (
    (fields.probeResult === "not-run" && fields.probedAt !== null) ||
    (fields.probeResult !== "not-run" && fields.probedAt === null)
  ) {
    return null;
  }
  return {
    providerId: fields.providerId,
    providerVersion: fields.providerVersion,
    readiness: fields.readiness as ProviderRuntimeReadinessV1,
    assurance: fields.assurance as AssuranceLevelV1 | null,
    freshness: fields.freshness as ProviderFreshnessV1,
    probedAt: fields.probedAt as string | null,
    probeResult: fields.probeResult as ProviderProbeResultV1,
    evidenceRefs: sortedUnique(fields.evidenceRefs),
  };
}

function invalidResult(
  reasonCode: ProviderResolutionReasonCodeV1,
): ProviderResolutionResultV1 {
  return {
    schemaVersion: PACTILE_CONTRACT_SCHEMA_VERSION,
    status: "invalid",
    resolution: null,
    fingerprint: null,
    explain: {
      schemaVersion: PACTILE_CONTRACT_SCHEMA_VERSION,
      decision: "invalid",
      reasonCode,
      selectedProviderId: null,
      fallbackFromProviderId: null,
      effectivePolicy: null,
      evidenceRefs: [],
      candidates: [],
    },
  };
}

function normalizeInput(
  value: unknown,
):
  | { readonly ok: true; readonly input: NormalizedInputV1 }
  | { readonly ok: false; readonly reason: ProviderResolutionReasonCodeV1 } {
  const fields = readExactOwnDataRecord(value, [
    "schemaVersion",
    "intent",
    "capabilityId",
    "minimumAssurance",
    "requestedPolicy",
    "authorizedProviderIds",
    "activeProviderIds",
    "standbyProviderIds",
    "fallbackAllowed",
    "manifests",
    "bindings",
    "runtimeFacts",
    "now",
  ]);
  if (fields?.schemaVersion !== PACTILE_CONTRACT_SCHEMA_VERSION) {
    return { ok: false, reason: "provider-input-invalid" };
  }
  const requestedPolicy = normalizePolicy(fields.requestedPolicy);
  const authorizedProviderIds = normalizeIdList(fields.authorizedProviderIds);
  const activeProviderIds = normalizeIdList(fields.activeProviderIds);
  const standbyProviderIds = normalizeIdList(fields.standbyProviderIds);
  const nowEpochMs =
    typeof fields.now === "string" ? parseTimestampEpochMs(fields.now) : null;
  if (
    requestedPolicy === null ||
    authorizedProviderIds === null ||
    activeProviderIds === null ||
    standbyProviderIds === null ||
    activeProviderIds.some((id) => standbyProviderIds.includes(id)) ||
    typeof fields.fallbackAllowed !== "boolean" ||
    nowEpochMs === null ||
    !(
      fields.capabilityId === null ||
      (typeof fields.capabilityId === "string" &&
        PACTILE_LOGICAL_ID_PATTERN.test(fields.capabilityId))
    ) ||
    !Array.isArray(fields.manifests) ||
    !Array.isArray(fields.bindings) ||
    !Array.isArray(fields.runtimeFacts)
  ) {
    return { ok: false, reason: "provider-input-invalid" };
  }

  const baseResolution = parseResolvedProviderV1({
    schemaVersion: PACTILE_CONTRACT_SCHEMA_VERSION,
    intent: fields.intent,
    minimumAssurance: fields.minimumAssurance,
    origin: "unsupported",
    providerId: null,
    providerVersion: null,
    assurance: null,
    readiness: "unavailable",
    requestedPolicy,
    effectivePolicy: null,
    evidenceRefs: [],
    freshness: "not-applicable",
    probedAt: null,
    probeResult: "not-run",
    fallbackFromProviderId: null,
  });
  if (!baseResolution.success) {
    return { ok: false, reason: "provider-input-invalid" };
  }

  const manifests: ProviderManifestV1[] = [];
  for (const item of fields.manifests) {
    const manifest = normalizeManifest(item);
    if (manifest === null) {
      return { ok: false, reason: "provider-manifest-invalid" };
    }
    manifests.push(manifest);
  }
  manifests.sort((left, right) =>
    ordinalCompare(
      `${left.id}\u0000${left.version}`,
      `${right.id}\u0000${right.version}`,
    ),
  );
  if (
    manifests.some(
      (manifest, index) =>
        index > 0 &&
        manifests[index - 1]?.id === manifest.id &&
        manifests[index - 1]?.version === manifest.version,
    )
  ) {
    return { ok: false, reason: "provider-manifest-duplicate" };
  }

  const bindings: CapabilityBindingV1[] = [];
  for (const item of fields.bindings) {
    const binding = normalizeBinding(item);
    if (binding === null) {
      return { ok: false, reason: "provider-input-invalid" };
    }
    bindings.push(binding);
  }
  bindings.sort((left, right) => ordinalCompare(left.id, right.id));
  if (
    bindings.some(
      (binding, index) => index > 0 && bindings[index - 1]?.id === binding.id,
    )
  ) {
    return { ok: false, reason: "provider-binding-duplicate" };
  }

  const runtimeFacts: ProviderRuntimeFactV1[] = [];
  for (const item of fields.runtimeFacts) {
    const fact = normalizeRuntimeFact(item);
    if (fact === null) {
      return { ok: false, reason: "provider-input-invalid" };
    }
    runtimeFacts.push(fact);
  }
  runtimeFacts.sort((left, right) =>
    ordinalCompare(
      `${left.providerId}\u0000${left.providerVersion}`,
      `${right.providerId}\u0000${right.providerVersion}`,
    ),
  );
  if (
    runtimeFacts.some(
      (fact, index) =>
        index > 0 &&
        runtimeFacts[index - 1]?.providerId === fact.providerId &&
        runtimeFacts[index - 1]?.providerVersion === fact.providerVersion,
    )
  ) {
    return { ok: false, reason: "provider-runtime-fact-duplicate" };
  }

  return {
    ok: true,
    input: {
      schemaVersion: PACTILE_CONTRACT_SCHEMA_VERSION,
      intent: baseResolution.data.intent,
      capabilityId: fields.capabilityId as string | null,
      minimumAssurance: baseResolution.data.minimumAssurance,
      requestedPolicy,
      authorizedProviderIds,
      activeProviderIds,
      standbyProviderIds,
      fallbackAllowed: fields.fallbackAllowed,
      manifests,
      bindings,
      runtimeFacts,
      nowEpochMs,
    },
  };
}

function policyRejection(
  requested: PolicyCeilingV1,
  ceiling: PolicyCeilingV1,
): ProviderResolutionReasonCodeV1 | null {
  if (
    rank(FILESYSTEM_CEILINGS_V1, requested.filesystem) >
    rank(FILESYSTEM_CEILINGS_V1, ceiling.filesystem)
  ) {
    return "provider-policy-filesystem-exceeded";
  }
  if (
    rank(PROCESS_CEILINGS_V1, requested.process) >
    rank(PROCESS_CEILINGS_V1, ceiling.process)
  ) {
    return "provider-policy-process-exceeded";
  }
  if (
    rank(NETWORK_CEILINGS_V1, requested.network) >
    rank(NETWORK_CEILINGS_V1, ceiling.network)
  ) {
    return "provider-policy-network-exceeded";
  }
  if (
    rank(CREDENTIAL_CEILINGS_V1, requested.credentials) >
    rank(CREDENTIAL_CEILINGS_V1, ceiling.credentials)
  ) {
    return "provider-policy-credentials-exceeded";
  }
  if (
    rank(PRIVACY_CEILINGS_V1, requested.privacy) >
    rank(PRIVACY_CEILINGS_V1, ceiling.privacy)
  ) {
    return "provider-policy-privacy-exceeded";
  }
  if (
    requested.egressDestinations.some(
      (destination) => !ceiling.egressDestinations.includes(destination),
    )
  ) {
    return "provider-policy-egress-exceeded";
  }
  if (
    rank(TELEMETRY_CEILINGS_V1, requested.telemetry) >
    rank(TELEMETRY_CEILINGS_V1, ceiling.telemetry)
  ) {
    return "provider-policy-telemetry-exceeded";
  }
  if (
    rank(COST_CEILINGS_V1, requested.cost) >
    rank(COST_CEILINGS_V1, ceiling.cost)
  ) {
    return "provider-policy-cost-exceeded";
  }
  return policyWithinCeilingV1(requested, ceiling)
    ? null
    : "provider-policy-exceeded";
}

function roleFor(
  providerId: string,
  input: NormalizedInputV1,
): ProviderCandidateRoleV1 {
  if (input.activeProviderIds.includes(providerId)) return "active";
  if (input.standbyProviderIds.includes(providerId)) return "standby";
  return "default";
}

function evaluateCandidate(
  manifest: ProviderManifestV1,
  input: NormalizedInputV1,
): EvaluatedCandidateV1 {
  const role = roleFor(manifest.id, input);
  const reject = (
    rejection: ProviderResolutionReasonCodeV1,
    fact: ProviderRuntimeFactV1 | null = null,
  ): EvaluatedCandidateV1 => ({ manifest, fact, role, rejection });

  if (!input.authorizedProviderIds.includes(manifest.id)) {
    return reject("provider-not-authorized");
  }
  if (!manifest.intents.includes(input.intent)) {
    return reject("provider-intent-mismatch");
  }
  if (
    input.capabilityId !== null &&
    !manifest.capabilityIds.includes(input.capabilityId)
  ) {
    return reject("provider-capability-mismatch");
  }
  const rejectedPolicy = policyRejection(
    input.requestedPolicy,
    manifest.policyCeiling,
  );
  if (rejectedPolicy !== null) return reject(rejectedPolicy);

  const providerBindings = input.bindings.filter(
    (binding) => binding.providerId === manifest.id,
  );
  if (providerBindings.length === 0) {
    return reject("provider-binding-missing");
  }
  const capabilityBindings = providerBindings.filter((binding) =>
    input.capabilityId === null
      ? manifest.capabilityIds.includes(binding.capabilityId)
      : binding.capabilityId === input.capabilityId,
  );
  if (capabilityBindings.length === 0) {
    return reject("provider-binding-capability-mismatch");
  }
  const intentBindings = capabilityBindings.filter((binding) =>
    binding.intents.includes(input.intent),
  );
  if (intentBindings.length === 0) {
    return reject("provider-binding-intent-mismatch");
  }
  const readyBindings = intentBindings.filter(
    (binding) =>
      binding.asset.readiness === "ready" ||
      binding.asset.readiness === "degraded",
  );
  if (readyBindings.length === 0) {
    return reject(
      intentBindings.some((binding) => binding.asset.readiness === "unknown")
        ? "provider-binding-readiness-unknown"
        : "provider-binding-unavailable",
    );
  }

  const fact = input.runtimeFacts.find(
    (item) =>
      item.providerId === manifest.id &&
      item.providerVersion === manifest.version,
  );
  if (!fact) {
    return reject(
      input.runtimeFacts.some((item) => item.providerId === manifest.id)
        ? "provider-runtime-version-mismatch"
        : "provider-runtime-fact-missing",
    );
  }
  if (fact.readiness === "unknown") {
    return reject("provider-readiness-unknown", fact);
  }
  if (fact.readiness === "unavailable") {
    return reject("provider-readiness-unavailable", fact);
  }

  if (manifest.probe.supported) {
    if (fact.probeResult === "not-run") {
      return reject("provider-probe-not-run", fact);
    }
    if (fact.probeResult === "failed") {
      return reject("provider-probe-failed", fact);
    }
    if (fact.freshness === "unknown" || fact.freshness === "not-applicable") {
      return reject("provider-freshness-unknown", fact);
    }
    if (fact.freshness === "stale") {
      return reject("provider-freshness-stale", fact);
    }
    if (fact.probedAt === null || manifest.probe.maxAgeSeconds === null) {
      return reject("provider-probe-time-invalid", fact);
    }
    const probedAtEpochMs = parseTimestampEpochMs(fact.probedAt);
    if (probedAtEpochMs === null) {
      return reject("provider-probe-time-invalid", fact);
    }
    if (probedAtEpochMs > input.nowEpochMs) {
      return reject("provider-probe-from-future", fact);
    }
    if (
      input.nowEpochMs - probedAtEpochMs >
      manifest.probe.maxAgeSeconds * 1_000
    ) {
      return reject("provider-probe-expired", fact);
    }
  } else if (
    fact.probeResult !== "not-run" ||
    fact.probedAt !== null ||
    (fact.freshness !== "unknown" && fact.freshness !== "not-applicable")
  ) {
    return reject("provider-probe-unexpected", fact);
  }

  if (fact.assurance === null) {
    return reject("provider-assurance-insufficient", fact);
  }
  if (
    rank(ASSURANCE_LEVELS_V1, fact.assurance) >
    rank(ASSURANCE_LEVELS_V1, manifest.maximumAssurance)
  ) {
    return reject("provider-assurance-exceeds-manifest", fact);
  }
  if (!assuranceSatisfiesV1(fact.assurance, input.minimumAssurance)) {
    return reject("provider-assurance-insufficient", fact);
  }
  if (
    assuranceSatisfiesV1(fact.assurance, "evidence-backed") &&
    fact.evidenceRefs.length === 0
  ) {
    return reject("provider-evidence-missing", fact);
  }
  if (
    (fact.readiness === "degraded" ||
      readyBindings.every(
        (binding) => binding.asset.readiness === "degraded",
      )) &&
    (!assuranceSatisfiesV1(fact.assurance, "evidence-backed") ||
      fact.evidenceRefs.length === 0)
  ) {
    return reject("provider-degraded-without-evidence", fact);
  }

  return { manifest, fact, role, rejection: null };
}

function unsupportedResolution(input: NormalizedInputV1): ResolvedProviderV1 {
  const parsed = parseResolvedProviderV1({
    schemaVersion: PACTILE_CONTRACT_SCHEMA_VERSION,
    intent: input.intent,
    minimumAssurance: input.minimumAssurance,
    origin: "unsupported",
    providerId: null,
    providerVersion: null,
    assurance: null,
    readiness: "unavailable",
    requestedPolicy: input.requestedPolicy,
    effectivePolicy: null,
    evidenceRefs: [],
    freshness: "not-applicable",
    probedAt: null,
    probeResult: "not-run",
    fallbackFromProviderId: null,
  });
  if (!parsed.success) {
    throw new Error("provider resolver produced an invalid unsupported result");
  }
  return parsed.data;
}

function resolutionFingerprint(input: NormalizedInputV1): string {
  return fingerprintPactileContractV1({
    schemaVersion: input.schemaVersion,
    intent: input.intent,
    capabilityId: input.capabilityId,
    minimumAssurance: input.minimumAssurance,
    requestedPolicy: input.requestedPolicy,
    authorizedProviderIds: input.authorizedProviderIds,
    activeProviderIds: input.activeProviderIds,
    standbyProviderIds: input.standbyProviderIds,
    fallbackAllowed: input.fallbackAllowed,
    manifests: input.manifests,
    bindings: input.bindings,
    runtimeFacts: input.runtimeFacts,
  });
}

/**
 * Resolve one Provider from caller-supplied, already-observed facts.
 *
 * The function is pure: it performs no probe, filesystem, process, network,
 * credential, host-config, or clock read. Invalid input returns a redacted
 * `invalid` result; a valid request with no eligible candidate returns an
 * honest M0 `ResolvedProviderV1` unsupported value.
 */
function resolvePlainProviderV1(value: unknown): ProviderResolutionResultV1 {
  const normalized = normalizeInput(value);
  if (!normalized.ok) return invalidResult(normalized.reason);
  const input = normalized.input;
  const fingerprint = resolutionFingerprint(input);
  const evaluated = input.manifests.map((manifest) =>
    evaluateCandidate(manifest, input),
  );
  const eligible = evaluated.filter(
    (candidate) => candidate.rejection === null,
  );

  let selected: EvaluatedCandidateV1 | undefined;
  let fallbackFromProviderId: string | null = null;
  if (input.activeProviderIds.length > 0) {
    selected = eligible.find((candidate) => candidate.role === "active");
    if (!selected && input.fallbackAllowed) {
      selected = eligible.find((candidate) => candidate.role === "standby");
      if (selected) fallbackFromProviderId = input.activeProviderIds[0] ?? null;
    }
  } else if (input.standbyProviderIds.length === 0) {
    selected = eligible[0];
  }

  const candidateExplain: ProviderCandidateExplainV1[] = evaluated.map(
    (candidate) => {
      const isSelected = candidate === selected;
      if (candidate.rejection !== null) {
        return {
          providerId: candidate.manifest.id,
          providerVersion: candidate.manifest.version,
          role: candidate.role,
          accepted: false,
          selected: false,
          reasonCodes: [candidate.rejection],
          effectivePolicy: null,
          evidenceRefs: [],
        };
      }
      if (isSelected) {
        const selectedReason: ProviderResolutionReasonCodeV1 =
          candidate.role === "active"
            ? "provider-selected-active"
            : candidate.role === "standby"
              ? "provider-selected-fallback"
              : "provider-selected-stable";
        return {
          providerId: candidate.manifest.id,
          providerVersion: candidate.manifest.version,
          role: candidate.role,
          accepted: true,
          selected: true,
          reasonCodes: [selectedReason],
          effectivePolicy: input.requestedPolicy,
          evidenceRefs: candidate.fact?.evidenceRefs ?? [],
        };
      }
      const selectionRejection: ProviderResolutionReasonCodeV1 =
        candidate.role === "standby" && !input.fallbackAllowed
          ? "provider-fallback-disabled"
          : input.activeProviderIds.length > 0 && candidate.role === "default"
            ? "provider-not-preferred"
            : "provider-not-selected";
      return {
        providerId: candidate.manifest.id,
        providerVersion: candidate.manifest.version,
        role: candidate.role,
        accepted: false,
        selected: false,
        reasonCodes: [selectionRejection],
        effectivePolicy: null,
        evidenceRefs: [],
      };
    },
  );

  if (!selected?.fact) {
    const reasonCode: ProviderResolutionReasonCodeV1 =
      input.activeProviderIds.length === 0 &&
      input.standbyProviderIds.length > 0
        ? "provider-active-missing"
        : input.activeProviderIds.length > 0 && !input.fallbackAllowed
          ? "provider-fallback-disabled"
          : (candidateExplain[0]?.reasonCodes[0] ?? "provider-unsupported");
    return {
      schemaVersion: PACTILE_CONTRACT_SCHEMA_VERSION,
      status: "unsupported",
      resolution: unsupportedResolution(input),
      fingerprint,
      explain: {
        schemaVersion: PACTILE_CONTRACT_SCHEMA_VERSION,
        decision: "unsupported",
        reasonCode,
        selectedProviderId: null,
        fallbackFromProviderId: null,
        effectivePolicy: null,
        evidenceRefs: [],
        candidates: candidateExplain,
      },
    };
  }

  const resolutionCandidate: ResolvedProviderV1 = {
    schemaVersion: PACTILE_CONTRACT_SCHEMA_VERSION,
    intent: input.intent,
    minimumAssurance: input.minimumAssurance,
    origin: selected.manifest.origin,
    providerId: selected.manifest.id,
    providerVersion: selected.manifest.version,
    assurance: selected.fact.assurance,
    readiness: selected.fact.readiness as ProviderReadinessV1,
    requestedPolicy: input.requestedPolicy,
    effectivePolicy: input.requestedPolicy,
    evidenceRefs: selected.fact.evidenceRefs,
    freshness: selected.fact.freshness,
    probedAt: selected.fact.probedAt,
    probeResult: selected.fact.probeResult,
    fallbackFromProviderId,
  };
  const parsed = parseResolvedProviderV1(resolutionCandidate);
  if (!parsed.success) return invalidResult("provider-input-invalid");

  return {
    schemaVersion: PACTILE_CONTRACT_SCHEMA_VERSION,
    status: "supported",
    resolution: parsed.data,
    fingerprint,
    explain: {
      schemaVersion: PACTILE_CONTRACT_SCHEMA_VERSION,
      decision: "supported",
      reasonCode: "provider-selected",
      selectedProviderId: parsed.data.providerId,
      fallbackFromProviderId,
      effectivePolicy: parsed.data.effectivePolicy,
      evidenceRefs: parsed.data.evidenceRefs,
      candidates: candidateExplain,
    },
  };
}

export function resolveProviderV1(value: unknown): ProviderResolutionResultV1 {
  try {
    const snapshot = snapshotPlainJsonValue(value);
    if (snapshot === INVALID_JSON_VALUE || !isRecord(snapshot)) {
      return invalidResult("provider-input-invalid");
    }
    return resolvePlainProviderV1(snapshot);
  } catch {
    return invalidResult("provider-input-invalid");
  }
}
