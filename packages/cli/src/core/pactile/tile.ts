import {
  ASSURANCE_LEVELS_V1,
  COST_CEILINGS_V1,
  CREDENTIAL_CEILINGS_V1,
  FILESYSTEM_CEILINGS_V1,
  NETWORK_CEILINGS_V1,
  PACTILE_INTENTS_V1,
  PRIVACY_CEILINGS_V1,
  PROCESS_CEILINGS_V1,
  TELEMETRY_CEILINGS_V1,
  type AssuranceLevelV1,
  type CostCeilingV1,
  type CredentialCeilingV1,
  type FilesystemCeilingV1,
  type NetworkCeilingV1,
  type PactileIntentV1,
  type PolicyCeilingV1,
  type PrivacyCeilingV1,
  type ProcessCeilingV1,
  type TelemetryCeilingV1,
  assuranceSatisfiesV1,
  policyWithinCeilingV1,
} from "./provider.js";
import {
  PACTILE_CONTRACT_SCHEMA_VERSION,
  PACTILE_LOGICAL_ID_PATTERN,
  type ContractDecoderV1,
  type PactileContractParseResultV1,
  childPathV1,
  decodeLogicalIdV1,
  decodeSchemaVersionV1,
  decodeSemverV1,
  definePactileContractSchemaV1,
} from "./validation.js";

export const TILE_TRIGGER_MODES_V1 = ["model", "explicit", "both"] as const;
export type TileTriggerModeV1 = (typeof TILE_TRIGGER_MODES_V1)[number];

export const TILE_STOP_CONDITIONS_V1 = [
  "success",
  "blocked",
  "policy-denied",
  "budget-exhausted",
  "provider-unavailable",
  "attempt-limit",
] as const;
export type TileStopConditionV1 = (typeof TILE_STOP_CONDITIONS_V1)[number];

export const TILE_EVIDENCE_KINDS_V1 = [
  "artifact",
  "command-result",
  "source-reference",
  "human-approval",
  "trace-event",
] as const;
export type TileEvidenceKindV1 = (typeof TILE_EVIDENCE_KINDS_V1)[number];

export interface TileIdentityV1 {
  readonly id: string;
  readonly version: string;
}

export interface TileTriggerV1 {
  readonly mode: TileTriggerModeV1;
  readonly intents: readonly PactileIntentV1[];
  readonly description: string;
}

export interface TilePermissionsV1 {
  readonly filesystem: FilesystemCeilingV1;
  readonly process: ProcessCeilingV1;
  readonly credentials: CredentialCeilingV1;
}

export interface TileEgressV1 {
  readonly network: NetworkCeilingV1;
  readonly privacy: PrivacyCeilingV1;
  readonly telemetry: TelemetryCeilingV1;
  readonly destinations: readonly string[];
}

export interface TileCostV1 {
  readonly ceiling: CostCeilingV1;
}

export interface TilePolicyV1 {
  readonly permissions: TilePermissionsV1;
  readonly egress: TileEgressV1;
  readonly cost: TileCostV1;
}

export interface TileFallbackV1 {
  readonly allowed: boolean;
  readonly minimumAssurance: AssuranceLevelV1 | null;
  readonly policy: TilePolicyV1 | null;
}

export interface TileStopV1 {
  readonly conditions: readonly TileStopConditionV1[];
  readonly maxAttempts: number;
}

export interface TileEvidenceRequirementV1 {
  readonly kind: TileEvidenceKindV1;
  readonly required: boolean;
  readonly description: string;
}

export interface TileManifestV1 {
  readonly schemaVersion: typeof PACTILE_CONTRACT_SCHEMA_VERSION;
  readonly identity: TileIdentityV1;
  readonly summary: string;
  readonly trigger: TileTriggerV1;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly dependencies: readonly string[];
  readonly conflicts: readonly string[];
  readonly permissions: TilePermissionsV1;
  readonly egress: TileEgressV1;
  readonly cost: TileCostV1;
  readonly fallback: TileFallbackV1;
  readonly stop: TileStopV1;
  readonly minimumAssurance: AssuranceLevelV1;
  readonly evidence: readonly TileEvidenceRequirementV1[];
}

export function tilePolicyCeilingV1(policy: TilePolicyV1): PolicyCeilingV1 {
  return {
    filesystem: policy.permissions.filesystem,
    process: policy.permissions.process,
    network: policy.egress.network,
    credentials: policy.permissions.credentials,
    privacy: policy.egress.privacy,
    egressDestinations: policy.egress.destinations,
    telemetry: policy.egress.telemetry,
    cost: policy.cost.ceiling,
  };
}

function decodeTileIdentityV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): TileIdentityV1 {
  const record = decoder.object(value, path, ["id", "version"]);
  return {
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
  };
}

function decodeTileTriggerV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): TileTriggerV1 {
  const record = decoder.object(value, path, ["mode", "intents", "description"]);
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
  return {
    mode: decoder.enumValue(
      decoder.required(record, "mode", path),
      TILE_TRIGGER_MODES_V1,
      childPathV1(path, "mode"),
    ),
    intents,
    description: decoder.string(
      decoder.required(record, "description", path),
      childPathV1(path, "description"),
      { nonEmpty: true },
    ),
  };
}

function decodeTilePermissionsV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): TilePermissionsV1 {
  const record = decoder.object(value, path, [
    "filesystem",
    "process",
    "credentials",
  ]);
  return {
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
    credentials: decoder.enumValue(
      decoder.required(record, "credentials", path),
      CREDENTIAL_CEILINGS_V1,
      childPathV1(path, "credentials"),
    ),
  };
}

function decodeTileEgressV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): TileEgressV1 {
  const record = decoder.object(value, path, [
    "network",
    "privacy",
    "telemetry",
    "destinations",
  ]);
  const egress: TileEgressV1 = {
    network: decoder.enumValue(
      decoder.required(record, "network", path),
      NETWORK_CEILINGS_V1,
      childPathV1(path, "network"),
    ),
    privacy: decoder.enumValue(
      decoder.required(record, "privacy", path),
      PRIVACY_CEILINGS_V1,
      childPathV1(path, "privacy"),
    ),
    telemetry: decoder.enumValue(
      decoder.required(record, "telemetry", path),
      TELEMETRY_CEILINGS_V1,
      childPathV1(path, "telemetry"),
    ),
    destinations: decoder.stringArray(
      decoder.required(record, "destinations", path),
      childPathV1(path, "destinations"),
      { nonEmptyItems: true, unique: true },
    ),
  };
  if (
    egress.network === "forbidden" &&
    (egress.privacy !== "local-only" ||
      egress.telemetry === "project-authorized" ||
      egress.destinations.length > 0)
  ) {
    decoder.issue(
      "policy-violation",
      path,
      "network-forbidden egress must be local-only, non-remote telemetry, and have no destinations",
    );
  }
  if (
    egress.network === "project-authorized" &&
    egress.privacy !== "local-only" &&
    egress.destinations.length === 0
  ) {
    decoder.issue(
      "required",
      childPathV1(path, "destinations"),
      "must declare destinations when egress is permitted",
    );
  }
  return egress;
}

function decodeTileCostV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): TileCostV1 {
  const record = decoder.object(value, path, ["ceiling"]);
  return {
    ceiling: decoder.enumValue(
      decoder.required(record, "ceiling", path),
      COST_CEILINGS_V1,
      childPathV1(path, "ceiling"),
    ),
  };
}

function decodeTilePolicyV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): TilePolicyV1 {
  const record = decoder.object(value, path, ["permissions", "egress", "cost"]);
  return {
    permissions: decodeTilePermissionsV1(
      decoder.required(record, "permissions", path),
      decoder,
      childPathV1(path, "permissions"),
    ),
    egress: decodeTileEgressV1(
      decoder.required(record, "egress", path),
      decoder,
      childPathV1(path, "egress"),
    ),
    cost: decodeTileCostV1(
      decoder.required(record, "cost", path),
      decoder,
      childPathV1(path, "cost"),
    ),
  };
}

function decodeTileFallbackV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): TileFallbackV1 {
  const record = decoder.object(value, path, [
    "allowed",
    "minimumAssurance",
    "policy",
  ]);
  const allowed = decoder.boolean(
    decoder.required(record, "allowed", path),
    childPathV1(path, "allowed"),
  );
  const assuranceValue = decoder.required(record, "minimumAssurance", path);
  const minimumAssurance =
    assuranceValue === null
      ? null
      : decoder.enumValue(
          assuranceValue,
          ASSURANCE_LEVELS_V1,
          childPathV1(path, "minimumAssurance"),
        );
  const policyValue = decoder.required(record, "policy", path);
  const policy =
    policyValue === null
      ? null
      : decodeTilePolicyV1(policyValue, decoder, childPathV1(path, "policy"));
  if (!allowed && (minimumAssurance !== null || policy !== null)) {
    decoder.issue(
      "conflict",
      path,
      "disabled fallback must use null minimumAssurance and policy",
    );
  }
  if (allowed && (minimumAssurance === null || policy === null)) {
    decoder.issue(
      "required",
      path,
      "enabled fallback requires minimumAssurance and policy",
    );
  }
  return { allowed, minimumAssurance, policy };
}

function decodeTileStopV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): TileStopV1 {
  const record = decoder.object(value, path, ["conditions", "maxAttempts"]);
  const conditions = decoder.array(
    decoder.required(record, "conditions", path),
    childPathV1(path, "conditions"),
    (item, itemPath) =>
      decoder.enumValue(item, TILE_STOP_CONDITIONS_V1, itemPath),
  );
  decoder.unique(
    conditions,
    (condition) => condition,
    childPathV1(path, "conditions"),
    "stop condition",
  );
  if (conditions.length === 0) {
    decoder.issue(
      "invalid-value",
      childPathV1(path, "conditions"),
      "must declare at least one stop condition",
    );
  }
  return {
    conditions,
    maxAttempts: decoder.integer(
      decoder.required(record, "maxAttempts", path),
      childPathV1(path, "maxAttempts"),
      { min: 1 },
    ),
  };
}

function decodeTileEvidenceV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): TileEvidenceRequirementV1 {
  const record = decoder.object(value, path, ["kind", "required", "description"]);
  return {
    kind: decoder.enumValue(
      decoder.required(record, "kind", path),
      TILE_EVIDENCE_KINDS_V1,
      childPathV1(path, "kind"),
    ),
    required: decoder.boolean(
      decoder.required(record, "required", path),
      childPathV1(path, "required"),
    ),
    description: decoder.string(
      decoder.required(record, "description", path),
      childPathV1(path, "description"),
      { nonEmpty: true },
    ),
  };
}

function decodeTileManifestV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): TileManifestV1 {
  const record = decoder.object(value, path, [
    "schemaVersion",
    "identity",
    "summary",
    "trigger",
    "inputs",
    "outputs",
    "dependencies",
    "conflicts",
    "permissions",
    "egress",
    "cost",
    "fallback",
    "stop",
    "minimumAssurance",
    "evidence",
  ]);
  const identity = decodeTileIdentityV1(
    decoder.required(record, "identity", path),
    decoder,
    childPathV1(path, "identity"),
  );
  const decodeIds = (
    field: "inputs" | "outputs" | "dependencies" | "conflicts",
  ): string[] =>
    decoder.stringArray(
      decoder.required(record, field, path),
      childPathV1(path, field),
      {
        nonEmptyItems: true,
        unique: true,
        pattern: PACTILE_LOGICAL_ID_PATTERN,
        patternDescription: "a lowercase logical id",
      },
    );
  const inputs = decodeIds("inputs");
  const outputs = decodeIds("outputs");
  const dependencies = decodeIds("dependencies");
  const conflicts = decodeIds("conflicts");
  if (dependencies.includes(identity.id)) {
    decoder.issue(
      "conflict",
      childPathV1(path, "dependencies"),
      "a Tile cannot depend on itself",
    );
  }
  if (conflicts.includes(identity.id)) {
    decoder.issue(
      "conflict",
      childPathV1(path, "conflicts"),
      "a Tile cannot conflict with itself",
    );
  }
  for (const dependency of dependencies) {
    if (conflicts.includes(dependency)) {
      decoder.issue(
        "conflict",
        childPathV1(path, "conflicts"),
        `Tile '${dependency}' cannot be both a dependency and a conflict`,
      );
    }
  }

  const permissions = decodeTilePermissionsV1(
    decoder.required(record, "permissions", path),
    decoder,
    childPathV1(path, "permissions"),
  );
  const egress = decodeTileEgressV1(
    decoder.required(record, "egress", path),
    decoder,
    childPathV1(path, "egress"),
  );
  const cost = decodeTileCostV1(
    decoder.required(record, "cost", path),
    decoder,
    childPathV1(path, "cost"),
  );
  const fallback = decodeTileFallbackV1(
    decoder.required(record, "fallback", path),
    decoder,
    childPathV1(path, "fallback"),
  );
  const minimumAssurance = decoder.enumValue(
    decoder.required(record, "minimumAssurance", path),
    ASSURANCE_LEVELS_V1,
    childPathV1(path, "minimumAssurance"),
  );
  const evidence = decoder.array(
    decoder.required(record, "evidence", path),
    childPathV1(path, "evidence"),
    (item, itemPath) => decodeTileEvidenceV1(item, decoder, itemPath),
  );
  decoder.unique(
    evidence,
    (requirement) => requirement.kind,
    childPathV1(path, "evidence"),
    "evidence kind",
  );
  if (
    assuranceSatisfiesV1(minimumAssurance, "evidence-backed") &&
    !evidence.some((requirement) => requirement.required)
  ) {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "evidence"),
      "evidence-backed or verified Tiles require at least one required Evidence kind",
    );
  }
  if (fallback.allowed && fallback.policy && fallback.minimumAssurance) {
    const requestedPolicy: TilePolicyV1 = { permissions, egress, cost };
    if (
      !policyWithinCeilingV1(
        tilePolicyCeilingV1(fallback.policy),
        tilePolicyCeilingV1(requestedPolicy),
      )
    ) {
      decoder.issue(
        "policy-violation",
        `${childPathV1(path, "fallback")}.policy`,
        "fallback must not exceed the Tile permission, egress, credential, telemetry, or cost ceiling",
      );
    }
    if (!assuranceSatisfiesV1(fallback.minimumAssurance, minimumAssurance)) {
      decoder.issue(
        "policy-violation",
        `${childPathV1(path, "fallback")}.minimumAssurance`,
        `fallback must still satisfy minimum assurance '${minimumAssurance}'`,
      );
    }
  }

  return {
    schemaVersion: decodeSchemaVersionV1(record, decoder, path),
    identity,
    summary: decoder.string(
      decoder.required(record, "summary", path),
      childPathV1(path, "summary"),
      { nonEmpty: true },
    ),
    trigger: decodeTileTriggerV1(
      decoder.required(record, "trigger", path),
      decoder,
      childPathV1(path, "trigger"),
    ),
    inputs,
    outputs,
    dependencies,
    conflicts,
    permissions,
    egress,
    cost,
    fallback,
    stop: decodeTileStopV1(
      decoder.required(record, "stop", path),
      decoder,
      childPathV1(path, "stop"),
    ),
    minimumAssurance,
    evidence,
  };
}

export const tileManifestV1Schema = definePactileContractSchemaV1(
  "TileManifestV1",
  decodeTileManifestV1,
);

export function parseTileManifestV1(
  input: unknown,
): PactileContractParseResultV1<TileManifestV1> {
  return tileManifestV1Schema.parse(input);
}
