/**
 * Stage 6 Adapter + Middleware compatibility facade.
 *
 * Pure helpers persisted through existing create extras / patch. Does not
 * write Kernel store or task.json. Field names here are an implementation
 * choice — not a frozen Manifest / Event ABI schema.
 */

import { KernelError } from "./kernel-contract.js";
import { isPlainObject } from "./schema.js";
import { safeEvidenceReferenceV1 } from "../pactile/middleware/redaction.js";

export type {
  ProviderRuntimeReadinessV1,
  ProviderRuntimeFactV1,
  ProviderResolutionInputV1,
  ProviderCandidateRoleV1,
  ProviderCandidateExplainV1,
  ProviderExplainV1,
  ProviderResolutionResultV1,
  ProviderResolutionReasonCodeV1,
} from "../pactile/middleware/resolver.js";
export {
  PROVIDER_RESOLUTION_REASON_CODES_V1,
  resolveProviderV1,
} from "../pactile/middleware/resolver.js";

export const STAGE6_SOURCE = "stage6-adapter-middleware";
export const STAGE6_SCHEMA_VERSION = 1 as const;

export const STAGE6_HOOK_EVENTS = [
  "sessionStart",
  "preToolUse",
  "beforeSubmitPrompt",
  "beforeShellExecution",
  "afterShellExecution",
  "stop",
] as const;

export type Stage6HookEvent = (typeof STAGE6_HOOK_EVENTS)[number];

export const RETRIEVAL_INTENTS = [
  "exact",
  "semantic",
  "structural",
  "external",
] as const;

export type RetrievalIntent = (typeof RETRIEVAL_INTENTS)[number];

export type MiddlewareProbeKind = "cli" | "mcp" | "host";

export const SHIPPED_MIDDLEWARE_PROVIDERS = [] as const;

/** @deprecated Provider identities are project-manifest data in Pactile v1. */
export type ShippedMiddlewareProvider = string;

/** Default `registered` catalog (Protocol v1 shipped table). */
export const DEFAULT_MIDDLEWARE_PROVIDERS = SHIPPED_MIDDLEWARE_PROVIDERS;

export const DEFAULT_REQUIRED_MIDDLEWARE_PROVIDERS = [] as const;

export const OPTIONAL_CODE_INTEL_PROVIDERS = [] as const;

/** @deprecated Compatibility alias; no concrete Provider is auto-registered. */
export const SMART_SEARCH_PROVIDER = "legacy.external";
export const EXTERNAL_KNOWLEDGE_CAPABILITY = "external-knowledge";

export const SHIPPED_PROVIDER_CAPABILITY: Record<
  ShippedMiddlewareProvider,
  string
> = {};

export const SHIPPED_PROVIDER_PROBE: Record<
  ShippedMiddlewareProvider,
  MiddlewareProbeKind
> = {};

export type Stage6CommandPhase = "create" | "start" | "archive" | "patch";

export type ProviderReadinessStatus =
  | "ready"
  | "missing"
  | "failed"
  | "unknown";

export interface EventSubscription {
  event: string;
  module: string;
}

export interface EventBridgeLastEvent {
  event: string;
  at: string;
  source: string;
  delivered: string[];
  skipped: string[];
}

export interface EventBridgeState {
  schema_version: typeof STAGE6_SCHEMA_VERSION;
  source: typeof STAGE6_SOURCE;
  subscriptions: EventSubscription[];
  last_event?: EventBridgeLastEvent;
}

export interface ProviderReadiness {
  status: ProviderReadinessStatus;
  capability: string;
  evidence?: string | null;
}

export interface MiddlewareProviders {
  schema_version: typeof STAGE6_SCHEMA_VERSION;
  source: typeof STAGE6_SOURCE;
  registered: string[];
  required: string[];
  active: string[];
  degraded: string[];
  readiness: Record<string, ProviderReadiness>;
}

export interface CapabilityRouter {
  schema_version: typeof STAGE6_SCHEMA_VERSION;
  source: typeof STAGE6_SOURCE;
  exact?: true;
  semantic?: true;
  structural?: true;
  external?: true;
}

export interface DispatchHookEventInput {
  event: string;
  source?: string;
  at?: string;
}

export function defaultEventBridge(): EventBridgeState {
  return {
    schema_version: STAGE6_SCHEMA_VERSION,
    source: STAGE6_SOURCE,
    subscriptions: [],
  };
}

function defaultReadinessMap(): Record<string, ProviderReadiness> {
  const readiness: Record<string, ProviderReadiness> = {};
  for (const id of SHIPPED_MIDDLEWARE_PROVIDERS) {
    readiness[id] = {
      status: "unknown",
      capability: SHIPPED_PROVIDER_CAPABILITY[id],
      evidence: null,
    };
  }
  return readiness;
}

export function defaultMiddlewareProviders(): MiddlewareProviders {
  return {
    schema_version: STAGE6_SCHEMA_VERSION,
    source: STAGE6_SOURCE,
    registered: [...SHIPPED_MIDDLEWARE_PROVIDERS],
    required: [...DEFAULT_REQUIRED_MIDDLEWARE_PROVIDERS],
    active: [],
    degraded: [],
    readiness: defaultReadinessMap(),
  };
}

export function defaultCapabilityRouter(): CapabilityRouter {
  return {
    schema_version: STAGE6_SCHEMA_VERSION,
    source: STAGE6_SOURCE,
    exact: true,
    semantic: true,
    structural: true,
    external: true,
  };
}

export function subscribeEvent(
  extras: Record<string, unknown>,
  event: string,
  moduleName: string,
): EventBridgeState {
  const current = readEventBridge(extras);
  const eventName = requireId(event, "event_bridge.subscriptions[].event");
  const module = requireId(moduleName, "event_bridge.subscriptions[].module");
  const subscriptions = [...current.subscriptions];
  if (
    !subscriptions.some(
      (item) => item.event === eventName && item.module === module,
    )
  ) {
    subscriptions.push({ event: eventName, module });
  }
  const next: EventBridgeState = { ...current, subscriptions };
  extras.event_bridge = next;
  return next;
}

/**
 * Record and dispatch one hook event. Unsubscribed modules are skipped and
 * never fail the hook.
 */
export function recordHookEvent(
  extras: Record<string, unknown>,
  input: DispatchHookEventInput,
): EventBridgeLastEvent {
  const current = readEventBridge(extras);
  const event = requireId(input.event, "event_bridge.last_event.event");
  const delivered: string[] = [];
  const skipped: string[] = [];
  for (const sub of current.subscriptions) {
    if (sub.event !== event) {
      skipped.push(sub.module);
      continue;
    }
    if (!delivered.includes(sub.module)) delivered.push(sub.module);
  }
  const lastEvent: EventBridgeLastEvent = {
    event,
    at:
      typeof input.at === "string" && input.at.trim() !== ""
        ? input.at
        : new Date().toISOString(),
    source:
      typeof input.source === "string" && input.source.trim() !== ""
        ? input.source
        : "host-hooks",
    delivered,
    skipped,
  };
  extras.event_bridge = { ...current, last_event: lastEvent };
  return lastEvent;
}

export function shippedProviderCapability(id: string): string {
  if (Object.hasOwn(SHIPPED_PROVIDER_CAPABILITY, id)) {
    return SHIPPED_PROVIDER_CAPABILITY[id as ShippedMiddlewareProvider];
  }
  return id === SMART_SEARCH_PROVIDER
    ? EXTERNAL_KNOWLEDGE_CAPABILITY
    : "unknown";
}

export function shippedProviderProbeKind(
  id: string,
): MiddlewareProbeKind | null {
  if (Object.hasOwn(SHIPPED_PROVIDER_PROBE, id)) {
    return SHIPPED_PROVIDER_PROBE[id as ShippedMiddlewareProvider];
  }
  return null;
}

export function classifyTransportProbe(input: {
  kind?: MiddlewareProbeKind;
  present?: boolean;
  reachable?: boolean;
  available?: boolean;
  status?: ProviderReadinessStatus;
  evidence?: string | null;
}): Pick<ProviderReadiness, "status" | "evidence"> {
  if (
    input.status === "ready" ||
    input.status === "missing" ||
    input.status === "failed" ||
    input.status === "unknown"
  ) {
    return {
      status: input.status,
      evidence: safeEvidenceReferenceV1(input.evidence),
    };
  }
  const present = input.present ?? input.available;
  if (present === false) {
    return {
      status: "missing",
      evidence: safeEvidenceReferenceV1(input.evidence),
    };
  }
  if (present === true && input.reachable === false) {
    return {
      status: "failed",
      evidence: safeEvidenceReferenceV1(input.evidence),
    };
  }
  if (present === true) {
    return {
      status: "ready",
      evidence: safeEvidenceReferenceV1(input.evidence),
    };
  }
  return {
    status: "unknown",
    evidence: safeEvidenceReferenceV1(input.evidence),
  };
}

export function mcpServerIdsFromConfig(raw: unknown): string[] {
  if (!isPlainObject(raw)) return [];
  const servers = raw.mcpServers;
  if (!isPlainObject(servers)) return [];
  return Object.keys(servers);
}

export function selectRegisteredMcpServers(
  configuredServerIds: readonly string[],
  registered: readonly string[] = SHIPPED_MIDDLEWARE_PROVIDERS,
): string[] {
  return uniqueStrings(configuredServerIds).filter((id) =>
    registered.includes(id),
  );
}

export function probeShippedProviderReadiness(
  id: string,
  input: {
    present?: boolean;
    reachable?: boolean;
    available?: boolean;
    status?: ProviderReadinessStatus;
    evidence?: string | null;
    capability?: string;
  } = {},
): ProviderReadiness {
  const classified = classifyTransportProbe({
    kind: shippedProviderProbeKind(id) ?? undefined,
    ...input,
  });
  return {
    status: classified.status,
    capability:
      typeof input.capability === "string" && input.capability.trim() !== ""
        ? input.capability.trim()
        : shippedProviderCapability(id),
    evidence: classified.evidence ?? null,
  };
}

export function probeSmartSearchReadiness(
  input: {
    available?: boolean;
    status?: ProviderReadinessStatus;
    evidence?: string | null;
  } = {},
): ProviderReadiness {
  return probeShippedProviderReadiness(SMART_SEARCH_PROVIDER, input);
}

export function applyShippedProviderReadiness(
  extras: Record<string, unknown>,
  id: string,
  readiness: ProviderReadiness,
): MiddlewareProviders {
  const current = readMiddlewareProviders(extras);
  if (!current.registered.includes(id)) {
    extras.middleware_providers = applyProviderHealth(current, extras);
    return extras.middleware_providers as MiddlewareProviders;
  }
  const next: MiddlewareProviders = {
    ...current,
    readiness: {
      ...current.readiness,
      [id]: {
        ...readiness,
        capability:
          typeof readiness.capability === "string" &&
          readiness.capability.trim() !== ""
            ? readiness.capability.trim()
            : shippedProviderCapability(id),
        evidence: safeEvidenceReferenceV1(readiness.evidence),
      },
    },
  };
  extras.middleware_providers = applyProviderHealth(next, extras);
  return extras.middleware_providers as MiddlewareProviders;
}

export function applySmartSearchReadiness(
  extras: Record<string, unknown>,
  readiness: ProviderReadiness,
): MiddlewareProviders {
  return applyShippedProviderReadiness(
    extras,
    SMART_SEARCH_PROVIDER,
    readiness,
  );
}

export function normalizeEventBridge(raw: unknown): EventBridgeState {
  if (raw === undefined || raw === null) return defaultEventBridge();
  if (!isPlainObject(raw)) {
    throw new KernelError(
      "INVALID_REQUEST",
      "event_bridge must be a JSON object",
    );
  }
  const subscriptionsIn = raw.subscriptions;
  const subscriptions: EventSubscription[] = [];
  if (subscriptionsIn !== undefined && subscriptionsIn !== null) {
    if (!Array.isArray(subscriptionsIn)) {
      throw new KernelError(
        "INVALID_REQUEST",
        "event_bridge.subscriptions must be an array",
      );
    }
    for (const item of subscriptionsIn) {
      if (!isPlainObject(item)) {
        throw new KernelError(
          "INVALID_REQUEST",
          "event_bridge.subscriptions[] must be objects",
        );
      }
      const sub: EventSubscription = {
        event: requireId(item.event, "event_bridge.subscriptions[].event"),
        module: requireId(item.module, "event_bridge.subscriptions[].module"),
      };
      if (
        !subscriptions.some(
          (existing) =>
            existing.event === sub.event && existing.module === sub.module,
        )
      ) {
        subscriptions.push(sub);
      }
    }
  }
  const lastRaw = raw.last_event;
  let lastEvent: EventBridgeLastEvent | undefined;
  if (lastRaw !== undefined && lastRaw !== null) {
    if (!isPlainObject(lastRaw)) {
      throw new KernelError(
        "INVALID_REQUEST",
        "event_bridge.last_event must be an object",
      );
    }
    lastEvent = {
      event: requireId(lastRaw.event, "event_bridge.last_event.event"),
      at:
        typeof lastRaw.at === "string" && lastRaw.at.trim() !== ""
          ? lastRaw.at
          : new Date().toISOString(),
      source:
        typeof lastRaw.source === "string" && lastRaw.source.trim() !== ""
          ? lastRaw.source
          : "host-hooks",
      delivered: uniqueStrings(asStringArray(lastRaw.delivered)),
      skipped: uniqueStrings(asStringArray(lastRaw.skipped)),
    };
  }
  return {
    schema_version: STAGE6_SCHEMA_VERSION,
    source: STAGE6_SOURCE,
    subscriptions,
    ...(lastEvent ? { last_event: lastEvent } : {}),
  };
}

export function normalizeMiddlewareProviders(
  raw: unknown,
): MiddlewareProviders {
  if (raw === undefined || raw === null) return defaultMiddlewareProviders();
  if (!isPlainObject(raw)) {
    throw new KernelError(
      "INVALID_REQUEST",
      "middleware_providers must be a JSON object",
    );
  }
  const defaults = defaultMiddlewareProviders();
  const registered = uniqueStrings(asStringArray(raw.registered));
  const required = uniqueStrings(asStringArray(raw.required)).filter((name) =>
    registered.includes(name),
  );
  const active = uniqueStrings(asStringArray(raw.active)).filter((name) =>
    registered.includes(name),
  );
  const degraded = uniqueStrings(asStringArray(raw.degraded));
  const readiness: Record<string, ProviderReadiness> = {
    ...defaults.readiness,
  };
  if (isPlainObject(raw.readiness)) {
    for (const [name, value] of Object.entries(raw.readiness)) {
      if (!registered.includes(name) || !isPlainObject(value)) continue;
      const status = parseReadinessStatus(value.status);
      readiness[name] = {
        status,
        capability:
          typeof value.capability === "string" && value.capability.trim() !== ""
            ? value.capability
            : "unknown",
        evidence: safeEvidenceReferenceV1(value.evidence),
      };
    }
  }
  return {
    schema_version: STAGE6_SCHEMA_VERSION,
    source: STAGE6_SOURCE,
    registered,
    required: required.length > 0 ? required : [...defaults.required],
    active,
    degraded,
    readiness,
  };
}

export function normalizeCapabilityRouter(raw: unknown): CapabilityRouter {
  if (raw === undefined || raw === null) return defaultCapabilityRouter();
  if (!isPlainObject(raw)) {
    throw new KernelError(
      "INVALID_REQUEST",
      "capability_router must be a JSON object",
    );
  }
  const allowed = new Set(["schema_version", "source", ...RETRIEVAL_INTENTS]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new KernelError(
        "INVALID_REQUEST",
        "capability_router must contain only retrieval intent keys",
      );
    }
  }
  const next: CapabilityRouter = {
    schema_version: STAGE6_SCHEMA_VERSION,
    source: STAGE6_SOURCE,
  };
  for (const intent of RETRIEVAL_INTENTS) {
    if (raw[intent] !== false) {
      next[intent] = true;
    }
  }
  return next;
}

export function readEventBridge(
  extras: Record<string, unknown>,
): EventBridgeState {
  return normalizeEventBridge(extras.event_bridge);
}

export function readMiddlewareProviders(
  extras: Record<string, unknown>,
): MiddlewareProviders {
  return normalizeMiddlewareProviders(extras.middleware_providers);
}

export function readCapabilityRouter(
  extras: Record<string, unknown>,
): CapabilityRouter {
  return normalizeCapabilityRouter(extras.capability_router);
}

export function requiredCapabilities(
  extras: Record<string, unknown>,
): string[] {
  return uniqueStrings(asStringArray(extras.required_capabilities));
}

export function externalKnowledgeReady(
  providers: MiddlewareProviders,
): boolean {
  return providers.registered.some((providerId) => {
    const readiness = providers.readiness[providerId];
    return (
      readiness?.status === "ready" &&
      readiness.capability === EXTERNAL_KNOWLEDGE_CAPABILITY
    );
  });
}

export function normalizeStage6InExtras(extras: Record<string, unknown>): void {
  extras.event_bridge = normalizeEventBridge(extras.event_bridge);
  extras.capability_router = normalizeCapabilityRouter(
    extras.capability_router,
  );
  const incoming = extras.hook_event;
  if (isPlainObject(incoming) && typeof incoming.event === "string") {
    recordHookEvent(extras, {
      event: incoming.event,
      source: typeof incoming.source === "string" ? incoming.source : undefined,
      at: typeof incoming.at === "string" ? incoming.at : undefined,
    });
    delete extras.hook_event;
  }
  extras.middleware_providers = normalizeMiddlewareProviders(
    extras.middleware_providers,
  );
  if (isPlainObject(extras.middleware_probes)) {
    applyMiddlewareProbes(extras, extras.middleware_probes);
    delete extras.middleware_probes;
  }
  if ("smart_search_probe" in extras) {
    // Retired compatibility input. Provider facts are caller-supplied through
    // the generic, project-authorized middleware projection.
    delete extras.smart_search_probe;
  }
  extras.middleware_providers = applyProviderHealth(
    extras.middleware_providers as MiddlewareProviders,
    extras,
  );
}

export function assertStage6ForPhase(
  extras: Record<string, unknown>,
  phase: Stage6CommandPhase,
): void {
  if (phase === "create" || phase === "patch") return;
  const providers = readMiddlewareProviders(extras);
  const needsExternal = requiredCapabilities(extras).includes(
    EXTERNAL_KNOWLEDGE_CAPABILITY,
  );
  if (!needsExternal) return;
  if (externalKnowledgeReady(providers)) return;
  if (extras.external_knowledge_policy === "degrade") {
    extras.profile_health = "degraded";
    return;
  }
  throw new KernelError(
    "INVALID_TRANSITION",
    "required external capability has no ready authorized Provider",
  );
}

export function normalizeStage6InExtrasAndAssert(
  extras: Record<string, unknown>,
  phase: Stage6CommandPhase,
): void {
  normalizeStage6InExtras(extras);
  assertStage6ForPhase(extras, phase);
}

function applyMiddlewareProbes(
  extras: Record<string, unknown>,
  probes: Record<string, unknown>,
): void {
  const current = readMiddlewareProviders(extras);
  for (const [id, value] of Object.entries(probes)) {
    if (!current.registered.includes(id)) continue;
    if (!isPlainObject(value)) continue;
    applyShippedProviderReadiness(
      extras,
      id,
      probeShippedProviderReadiness(id, {
        available:
          value.available === true
            ? true
            : value.available === false
              ? false
              : undefined,
        present:
          value.present === true
            ? true
            : value.present === false
              ? false
              : undefined,
        reachable:
          value.reachable === true
            ? true
            : value.reachable === false
              ? false
              : undefined,
        status:
          value.status === "ready" ||
          value.status === "missing" ||
          value.status === "failed" ||
          value.status === "unknown"
            ? value.status
            : undefined,
        evidence: typeof value.evidence === "string" ? value.evidence : null,
        capability:
          typeof value.capability === "string" ? value.capability : undefined,
      }),
    );
  }
}

function applyProviderHealth(
  providers: MiddlewareProviders,
  extras: Record<string, unknown>,
): MiddlewareProviders {
  const degraded = uniqueStrings([...providers.degraded]);
  for (const id of providers.required) {
    const row = providers.readiness[id];
    if (row && row.status !== "ready" && row.status !== "unknown") {
      if (!degraded.includes(id)) degraded.push(id);
      extras.profile_health = "degraded";
    }
  }
  const missing = uniqueStrings(
    asStringArray(extras.ondemand_required_missing),
  );
  if (missing.includes(EXTERNAL_KNOWLEDGE_CAPABILITY)) {
    extras.profile_health = "degraded";
  }
  return { ...providers, degraded };
}

function parseReadinessStatus(value: unknown): ProviderReadinessStatus {
  if (
    value === "ready" ||
    value === "missing" ||
    value === "failed" ||
    value === "unknown"
  ) {
    return value;
  }
  return "unknown";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function uniqueStrings(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new KernelError(
      "INVALID_REQUEST",
      `${field} must be a non-empty string`,
    );
  }
  return value.trim();
}
