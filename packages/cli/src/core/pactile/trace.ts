import {
  ASSURANCE_LEVELS_V1,
  PACTILE_INTENTS_V1,
  PROVIDER_ORIGINS_V1,
  type AssuranceLevelV1,
  type PactileIntentV1,
  type ProviderOriginV1,
} from "./provider.js";
import {
  PACTILE_CONTRACT_SCHEMA_VERSION,
  type ContractDecoderV1,
  type PactileContractParseResultV1,
  childPathV1,
  decodeFingerprintV1,
  decodeLogicalIdV1,
  decodeNullableFingerprintV1,
  decodeOpaqueReferenceV1,
  decodeSchemaVersionV1,
  decodeTimestampV1,
  definePactileContractSchemaV1,
} from "./validation.js";

export const COMPOSITION_TRACE_EVENTS_V1 = [
  "tile.discovered",
  "tile.eligible",
  "tile.selected",
  "tile.ordered",
  "tile.invoked",
  "tile.completed",
  "tile.failed",
  "tile.skipped",
  "tile.fallback",
  "provider.resolved",
  "evidence.recorded",
] as const;
export type CompositionTraceEventKindV1 =
  (typeof COMPOSITION_TRACE_EVENTS_V1)[number];

export const COMPOSITION_TRACE_OUTCOMES_V1 = [
  "observed",
  "accepted",
  "started",
  "succeeded",
  "failed",
  "degraded",
  "skipped",
  "unsupported",
] as const;
export type CompositionTraceOutcomeV1 =
  (typeof COMPOSITION_TRACE_OUTCOMES_V1)[number];

export interface CompositionTraceProviderRefV1 {
  readonly id: string | null;
  readonly origin: ProviderOriginV1;
  readonly assurance: AssuranceLevelV1 | null;
  readonly resolutionFingerprint: string;
}

/**
 * One append-only, observable composition fact.
 *
 * Deliberately has no prompt, rationale, reasoning, scratchpad, or arbitrary
 * metadata field. Callers link artifacts and Evidence instead of serializing
 * hidden model reasoning.
 */
export interface CompositionTraceEventV1 {
  readonly schemaVersion: typeof PACTILE_CONTRACT_SCHEMA_VERSION;
  readonly traceId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly previousEventFingerprint: string | null;
  readonly at: string;
  readonly event: CompositionTraceEventKindV1;
  readonly outcome: CompositionTraceOutcomeV1;
  readonly taskId: string | null;
  readonly tileId: string | null;
  readonly relatedTileId: string | null;
  readonly intent: PactileIntentV1 | null;
  readonly provider: CompositionTraceProviderRefV1 | null;
  readonly position: number | null;
  readonly durationMs: number | null;
  readonly errorCode: string | null;
  readonly artifactRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
}

const PACTILE_TRACE_ERROR_CODE_PATTERN =
  /^PACTILE_[A-Z0-9]+(?:_[A-Z0-9]+)*$/;

function decodeNullableLogicalIdV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): string | null {
  if (value === null) return null;
  return decodeLogicalIdV1(value, decoder, path);
}

function decodeNullableIntentV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): PactileIntentV1 | null {
  if (value === null) return null;
  return decoder.enumValue(value, PACTILE_INTENTS_V1, path);
}

function decodeNullableIntegerV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
  min: number,
): number | null {
  if (value === null) return null;
  return decoder.integer(value, path, { min });
}

function decodeNullableTraceErrorCodeV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): string | null {
  if (value === null) return null;
  const errorCode = decoder.string(value, path, {
    nonEmpty: true,
    pattern: PACTILE_TRACE_ERROR_CODE_PATTERN,
    patternDescription:
      "a symbolic PACTILE_<CODE> value, not prose or sensitive content",
  });
  if (errorCode.length > 96) {
    decoder.issue(
      "invalid-value",
      path,
      "symbolic Trace error codes must be at most 96 characters",
    );
  }
  return errorCode;
}

function decodeTraceReferencesV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
  scheme: "artifact" | "evidence",
): string[] {
  const references = decoder.array(value, path, (item, itemPath) =>
    decodeOpaqueReferenceV1(item, decoder, itemPath, [scheme]),
  );
  decoder.unique(references, (reference) => reference, path, `${scheme} reference`);
  return references;
}

function decodeTraceProviderRefV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): CompositionTraceProviderRefV1 {
  const record = decoder.object(value, path, [
    "id",
    "origin",
    "assurance",
    "resolutionFingerprint",
  ]);
  const origin = decoder.enumValue(
    decoder.required(record, "origin", path),
    PROVIDER_ORIGINS_V1,
    childPathV1(path, "origin"),
  );
  const id = decodeNullableLogicalIdV1(
    decoder.required(record, "id", path),
    decoder,
    childPathV1(path, "id"),
  );
  const assuranceValue = decoder.required(record, "assurance", path);
  const assurance =
    assuranceValue === null
      ? null
      : decoder.enumValue(
          assuranceValue,
          ASSURANCE_LEVELS_V1,
          childPathV1(path, "assurance"),
        );
  if (origin === "unsupported" && (id !== null || assurance !== null)) {
    decoder.issue(
      "conflict",
      path,
      "unsupported Provider trace references cannot claim an id or assurance",
    );
  }
  if (origin !== "unsupported" && (id === null || assurance === null)) {
    decoder.issue(
      "required",
      path,
      "supported Provider trace references require id and assurance",
    );
  }
  return {
    id,
    origin,
    assurance,
    resolutionFingerprint: decodeFingerprintV1(
      decoder.required(record, "resolutionFingerprint", path),
      decoder,
      childPathV1(path, "resolutionFingerprint"),
    ),
  };
}

function decodeCompositionTraceEventV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): CompositionTraceEventV1 {
  const record = decoder.object(value, path, [
    "schemaVersion",
    "traceId",
    "eventId",
    "sequence",
    "previousEventFingerprint",
    "at",
    "event",
    "outcome",
    "taskId",
    "tileId",
    "relatedTileId",
    "intent",
    "provider",
    "position",
    "durationMs",
    "errorCode",
    "artifactRefs",
    "evidenceRefs",
  ]);
  const sequence = decoder.integer(
    decoder.required(record, "sequence", path),
    childPathV1(path, "sequence"),
    { min: 1 },
  );
  const previousEventFingerprint = decodeNullableFingerprintV1(
    decoder.required(record, "previousEventFingerprint", path),
    decoder,
    childPathV1(path, "previousEventFingerprint"),
  );
  if (sequence === 1 && previousEventFingerprint !== null) {
    decoder.issue(
      "conflict",
      childPathV1(path, "previousEventFingerprint"),
      "the first event must not claim a previous event",
    );
  }
  if (sequence > 1 && previousEventFingerprint === null) {
    decoder.issue(
      "required",
      childPathV1(path, "previousEventFingerprint"),
      "is required after the first append-only event",
    );
  }
  const event = decoder.enumValue(
    decoder.required(record, "event", path),
    COMPOSITION_TRACE_EVENTS_V1,
    childPathV1(path, "event"),
  );
  const outcome = decoder.enumValue(
    decoder.required(record, "outcome", path),
    COMPOSITION_TRACE_OUTCOMES_V1,
    childPathV1(path, "outcome"),
  );
  const tileId = decodeNullableLogicalIdV1(
    decoder.required(record, "tileId", path),
    decoder,
    childPathV1(path, "tileId"),
  );
  const relatedTileId = decodeNullableLogicalIdV1(
    decoder.required(record, "relatedTileId", path),
    decoder,
    childPathV1(path, "relatedTileId"),
  );
  const intent = decodeNullableIntentV1(
    decoder.required(record, "intent", path),
    decoder,
    childPathV1(path, "intent"),
  );
  const providerValue = decoder.required(record, "provider", path);
  const provider =
    providerValue === null
      ? null
      : decodeTraceProviderRefV1(providerValue, decoder, childPathV1(path, "provider"));
  const position = decodeNullableIntegerV1(
    decoder.required(record, "position", path),
    decoder,
    childPathV1(path, "position"),
    0,
  );
  const durationMs = decodeNullableIntegerV1(
    decoder.required(record, "durationMs", path),
    decoder,
    childPathV1(path, "durationMs"),
    0,
  );
  const errorCode = decodeNullableTraceErrorCodeV1(
    decoder.required(record, "errorCode", path),
    decoder,
    childPathV1(path, "errorCode"),
  );
  const artifactRefs = decodeTraceReferencesV1(
    decoder.required(record, "artifactRefs", path),
    decoder,
    childPathV1(path, "artifactRefs"),
    "artifact",
  );
  const evidenceRefs = decodeTraceReferencesV1(
    decoder.required(record, "evidenceRefs", path),
    decoder,
    childPathV1(path, "evidenceRefs"),
    "evidence",
  );

  if (event.startsWith("tile.") && tileId === null) {
    decoder.issue(
      "required",
      childPathV1(path, "tileId"),
      "is required for Tile events",
    );
  }
  const allowedOutcomes: Record<
    CompositionTraceEventKindV1,
    readonly CompositionTraceOutcomeV1[]
  > = {
    "tile.discovered": ["observed"],
    "tile.eligible": ["observed", "accepted"],
    "tile.selected": ["accepted"],
    "tile.ordered": ["accepted"],
    "tile.invoked": ["started"],
    "tile.completed": ["succeeded", "degraded"],
    "tile.failed": ["failed"],
    "tile.skipped": ["skipped"],
    "tile.fallback": ["accepted", "degraded"],
    "provider.resolved": ["accepted", "degraded", "unsupported"],
    "evidence.recorded": ["observed", "succeeded"],
  };
  if (!allowedOutcomes[event].includes(outcome)) {
    decoder.issue(
      "conflict",
      childPathV1(path, "outcome"),
      `outcome '${outcome}' is not valid for event '${event}'`,
    );
  }
  if (event === "tile.fallback") {
    if (relatedTileId === null) {
      decoder.issue(
        "required",
        childPathV1(path, "relatedTileId"),
        "is required for fallback events",
      );
    } else if (relatedTileId === tileId) {
      decoder.issue(
        "conflict",
        childPathV1(path, "relatedTileId"),
        "fallback target must differ from the original Tile",
      );
    }
  } else if (relatedTileId !== null) {
    decoder.issue(
      "conflict",
      childPathV1(path, "relatedTileId"),
      "is only valid for tile.fallback",
    );
  }
  if (event === "provider.resolved" && (provider === null || intent === null)) {
    decoder.issue(
      "required",
      path,
      "provider.resolved requires Provider and intent references",
    );
  }
  if (
    event === "provider.resolved" &&
    provider?.origin === "unsupported" &&
    outcome !== "unsupported"
  ) {
    decoder.issue(
      "conflict",
      childPathV1(path, "outcome"),
      "unsupported Provider resolution must use outcome 'unsupported'",
    );
  }
  if (
    event === "provider.resolved" &&
    provider !== null &&
    provider.origin !== "unsupported" &&
    outcome === "unsupported"
  ) {
    decoder.issue(
      "conflict",
      childPathV1(path, "outcome"),
      "supported Provider resolution cannot use outcome 'unsupported'",
    );
  }
  if (event !== "provider.resolved" && provider !== null) {
    decoder.issue(
      "conflict",
      childPathV1(path, "provider"),
      "is only valid for provider.resolved events",
    );
  }
  if (event === "tile.ordered" && position === null) {
    decoder.issue(
      "required",
      childPathV1(path, "position"),
      "is required for tile.ordered",
    );
  }
  if (event !== "tile.ordered" && position !== null) {
    decoder.issue(
      "conflict",
      childPathV1(path, "position"),
      "is only valid for tile.ordered",
    );
  }
  if (
    event !== "tile.completed" &&
    event !== "tile.failed" &&
    durationMs !== null
  ) {
    decoder.issue(
      "conflict",
      childPathV1(path, "durationMs"),
      "is only valid for completed or failed Tile invocations",
    );
  }
  if (event === "tile.failed" && errorCode === null) {
    decoder.issue(
      "required",
      childPathV1(path, "errorCode"),
      "is required for tile.failed",
    );
  }
  if (event !== "tile.failed" && errorCode !== null) {
    decoder.issue(
      "conflict",
      childPathV1(path, "errorCode"),
      "is only valid for tile.failed",
    );
  }
  if (event === "evidence.recorded" && evidenceRefs.length === 0) {
    decoder.issue(
      "required",
      childPathV1(path, "evidenceRefs"),
      "must contain at least one Evidence reference",
    );
  }

  return {
    schemaVersion: decodeSchemaVersionV1(record, decoder, path),
    traceId: decodeLogicalIdV1(
      decoder.required(record, "traceId", path),
      decoder,
      childPathV1(path, "traceId"),
    ),
    eventId: decodeLogicalIdV1(
      decoder.required(record, "eventId", path),
      decoder,
      childPathV1(path, "eventId"),
    ),
    sequence,
    previousEventFingerprint,
    at: decodeTimestampV1(
      decoder.required(record, "at", path),
      decoder,
      childPathV1(path, "at"),
    ),
    event,
    outcome,
    taskId: decodeNullableLogicalIdV1(
      decoder.required(record, "taskId", path),
      decoder,
      childPathV1(path, "taskId"),
    ),
    tileId,
    relatedTileId,
    intent,
    provider,
    position,
    durationMs,
    errorCode,
    artifactRefs,
    evidenceRefs,
  };
}

export const compositionTraceEventV1Schema = definePactileContractSchemaV1(
  "CompositionTraceEventV1",
  decodeCompositionTraceEventV1,
);

export function parseCompositionTraceEventV1(
  input: unknown,
): PactileContractParseResultV1<CompositionTraceEventV1> {
  return compositionTraceEventV1Schema.parse(input);
}
