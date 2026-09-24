import type {
  AssuranceLevelV1,
  ProviderRuntimeFactV1,
} from "../../core/index.js";

export const PACTILE_PROVIDER_PROBE_IDS = [
  "rg",
  "codex-explorer",
  "codegraph",
  "fast-context",
  "smart-search",
] as const;
export type PactileProviderProbeId =
  (typeof PACTILE_PROVIDER_PROBE_IDS)[number];

export interface ProviderProbeInvocation {
  readonly providerId: PactileProviderProbeId;
}

export interface ProviderProbeRunnerResult {
  readonly exitCode: number | null;
  readonly observedAt: string;
  /** A public capability bit only; no discovered command, path, or account data. */
  readonly capabilityAvailable?: boolean;
  /** Accepted for process adapters but intentionally never returned or logged. */
  readonly stdout?: string;
  /** Accepted for process adapters but intentionally never returned or logged. */
  readonly stderr?: string;
}

export interface ProviderProbePorts {
  readonly now: () => string;
  readonly run: (
    invocation: ProviderProbeInvocation,
  ) => ProviderProbeRunnerResult | Promise<ProviderProbeRunnerResult>;
}

export interface ProviderProbeRequest {
  readonly providerIds: readonly PactileProviderProbeId[];
}

export type ProviderProbeStatus =
  | "ready"
  | "degraded"
  | "unavailable"
  | "stale";

export interface ProviderProbeEvidence {
  readonly reference: string;
  readonly result: "passed" | "failed";
  readonly summary:
    | "probe-capability-ready"
    | "probe-capability-degraded"
    | "probe-unavailable"
    | "probe-stale";
}

export interface ProviderProbeRecord {
  readonly providerId: PactileProviderProbeId;
  readonly status: ProviderProbeStatus;
  readonly assurance: AssuranceLevelV1 | null;
  readonly observedAt: string;
  readonly freshUntil: string;
  readonly evidence: ProviderProbeEvidence;
  readonly remediation:
    | "none"
    | "install-or-enable-provider"
    | "refresh-provider-probe";
  readonly runtimeFact: ProviderRuntimeFactV1;
}

export interface ProviderProbeMatrixResult {
  readonly ok: boolean;
  readonly probes: readonly ProviderProbeRecord[];
  readonly runtimeFacts: readonly ProviderRuntimeFactV1[];
  readonly diagnostics: readonly {
    readonly code: "invalid-request" | "probe-result-invalid";
    readonly providerId: PactileProviderProbeId | "matrix";
  }[];
}

interface ProviderProbeDefinition {
  readonly providerId: PactileProviderProbeId;
  readonly assurance: AssuranceLevelV1;
  readonly maxAgeSeconds: number;
}

const DEFINITIONS: Readonly<Record<PactileProviderProbeId, ProviderProbeDefinition>> = {
  rg: {
    providerId: "rg",
    assurance: "evidence-backed",
    maxAgeSeconds: 86_400,
  },
  "codex-explorer": {
    providerId: "codex-explorer",
    assurance: "best-effort",
    maxAgeSeconds: 900,
  },
  codegraph: {
    providerId: "codegraph",
    assurance: "evidence-backed",
    maxAgeSeconds: 3_600,
  },
  "fast-context": {
    providerId: "fast-context",
    assurance: "best-effort",
    maxAgeSeconds: 3_600,
  },
  "smart-search": {
    providerId: "smart-search",
    assurance: "evidence-backed",
    maxAgeSeconds: 3_600,
  },
};

function epoch(value: string): number | null {
  if (typeof value !== "string" || value.length > 32) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : null;
}

function invalid(
  code: "invalid-request" | "probe-result-invalid",
  providerId: PactileProviderProbeId | "matrix",
): ProviderProbeMatrixResult {
  return {
    ok: false,
    probes: [],
    runtimeFacts: [],
    diagnostics: [{ code, providerId }],
  };
}

/**
 * Run explicit probe definitions through injected ports. Raw runner output is
 * bounded by the port contract and discarded at the boundary; only fixed
 * evidence codes and safe logical references leave this function.
 */
export async function runProviderProbeMatrix(
  request: ProviderProbeRequest,
  ports: ProviderProbePorts,
): Promise<ProviderProbeMatrixResult> {
  try {
    return await runProviderProbeMatrixUnsafe(request, ports);
  } catch {
    return invalid("invalid-request", "matrix");
  }
}

async function runProviderProbeMatrixUnsafe(
  request: ProviderProbeRequest,
  ports: ProviderProbePorts,
): Promise<ProviderProbeMatrixResult> {
  if (
    !Array.isArray(request.providerIds) ||
    request.providerIds.length === 0 ||
    new Set(request.providerIds).size !== request.providerIds.length ||
    request.providerIds.some(
      (id) => !PACTILE_PROVIDER_PROBE_IDS.includes(id),
    )
  )
    return invalid("invalid-request", "matrix");
  const now = epoch(ports.now());
  if (now === null) return invalid("invalid-request", "matrix");

  const probes: ProviderProbeRecord[] = [];
  const providerIds: PactileProviderProbeId[] = [...request.providerIds].sort();
  for (const providerId of providerIds) {
    const definition = DEFINITIONS[providerId];
    let raw: ProviderProbeRunnerResult;
    try {
      raw = await ports.run({
        providerId,
      });
    } catch {
      return invalid("probe-result-invalid", providerId);
    }
    const observedAt = epoch(raw.observedAt);
    if (
      observedAt === null ||
      observedAt > now ||
      (raw.exitCode !== null &&
        (!Number.isInteger(raw.exitCode) || raw.exitCode < 0)) ||
      (raw.capabilityAvailable !== undefined &&
        typeof raw.capabilityAvailable !== "boolean") ||
      (raw.stdout !== undefined &&
        (typeof raw.stdout !== "string" || raw.stdout.length > 65_536)) ||
      (raw.stderr !== undefined &&
        (typeof raw.stderr !== "string" || raw.stderr.length > 65_536))
    )
      return invalid("probe-result-invalid", providerId);

    const freshUntilEpoch = observedAt + definition.maxAgeSeconds * 1_000;
    const stale = now > freshUntilEpoch;
    const passed = raw.exitCode === 0;
    const available = passed && raw.capabilityAvailable !== false;
    const status: ProviderProbeStatus = stale
      ? "stale"
      : available
        ? "ready"
        : passed
          ? "degraded"
          : "unavailable";
    const readiness: ProviderRuntimeFactV1["readiness"] =
      status === "ready"
        ? "ready"
        : status === "unavailable"
          ? "unavailable"
          : "degraded";
    const assurance = passed ? definition.assurance : null;
    const evidenceRef = `evidence://probe/${providerId}/${passed ? "passed" : "failed"}`;
    const runtimeFact: ProviderRuntimeFactV1 = {
      providerId,
      providerVersion: "1.0.0",
      readiness,
      assurance,
      freshness: stale ? "stale" : "fresh",
      probedAt: raw.observedAt,
      probeResult: passed ? "passed" : "failed",
      evidenceRefs: [evidenceRef],
    };
    probes.push({
      providerId,
      status,
      assurance,
      observedAt: raw.observedAt,
      freshUntil: new Date(freshUntilEpoch).toISOString(),
      evidence: {
        reference: evidenceRef,
        result: passed ? "passed" : "failed",
        summary:
          status === "ready"
            ? "probe-capability-ready"
            : status === "degraded"
              ? "probe-capability-degraded"
              : status === "stale"
                ? "probe-stale"
                : "probe-unavailable",
      },
      remediation:
        status === "ready"
          ? "none"
          : status === "stale"
            ? "refresh-provider-probe"
            : "install-or-enable-provider",
      runtimeFact,
    });
  }
  return {
    ok: true,
    probes,
    runtimeFacts: probes.map(({ runtimeFact }) => runtimeFact),
    diagnostics: [],
  };
}
