import {
  PACTILE_INTENTS_V1,
  type PactileIntentV1,
} from "./provider.js";
import {
  PACTILE_CONTRACT_SCHEMA_VERSION,
  type ContractDecoderV1,
  type PactileContractParseResultV1,
  childPathV1,
  decodeLogicalIdV1,
  decodeNullableFingerprintV1,
  decodeOpaqueReferenceV1,
  decodeSchemaVersionV1,
  definePactileContractSchemaV1,
} from "./validation.js";

export const INSTALL_HINT_MECHANISMS_V1 = [
  "host-native",
  "package-manager",
  "manual",
] as const;
export type InstallHintMechanismV1 =
  (typeof INSTALL_HINT_MECHANISMS_V1)[number];

export interface InstallHintV1 {
  readonly schemaVersion: typeof PACTILE_CONTRACT_SCHEMA_VERSION;
  readonly mechanism: InstallHintMechanismV1;
  /** Symbolic localization key, never user-authored prose or credential data. */
  readonly label: string;
  /** Optional non-network logical reference; never a credential-bearing URL. */
  readonly reference: string | null;
  readonly requiresAuthentication: boolean;
}

export const EXTERNAL_ASSET_KINDS_V1 = [
  "skill",
  "mcp",
  "plugin",
  "executable",
  "service",
] as const;
export type ExternalAssetKindV1 = (typeof EXTERNAL_ASSET_KINDS_V1)[number];

export const EXTERNAL_ASSET_SOURCES_V1 = [
  "host-native",
  "user-installed",
  "pactile-bundled",
  "project-vendored",
] as const;
export type ExternalAssetSourceV1 =
  (typeof EXTERNAL_ASSET_SOURCES_V1)[number];

export const EXTERNAL_ASSET_SCOPES_V1 = ["project", "user", "host"] as const;
export type ExternalAssetScopeV1 = (typeof EXTERNAL_ASSET_SCOPES_V1)[number];

export const EXTERNAL_ASSET_OWNER_KINDS_V1 = [
  "user",
  "host",
  "pactile",
  "third-party",
] as const;
export type ExternalAssetOwnerKindV1 =
  (typeof EXTERNAL_ASSET_OWNER_KINDS_V1)[number];

export interface ExternalAssetOwnerV1 {
  readonly kind: ExternalAssetOwnerKindV1;
  readonly id: string | null;
}

export const CAPABILITY_READINESS_V1 = [
  "ready",
  "degraded",
  "missing",
  "unknown",
] as const;
export type CapabilityReadinessV1 = (typeof CAPABILITY_READINESS_V1)[number];

export interface ExternalAssetRefV1 {
  readonly schemaVersion: typeof PACTILE_CONTRACT_SCHEMA_VERSION;
  readonly id: string;
  readonly kind: ExternalAssetKindV1;
  readonly source: ExternalAssetSourceV1;
  readonly scope: ExternalAssetScopeV1;
  readonly owner: ExternalAssetOwnerV1;
  /** Source-scoped logical locator. It is never a URL or copied asset content. */
  readonly locator: string;
  readonly fingerprint: string | null;
  readonly readiness: CapabilityReadinessV1;
  readonly installHint: InstallHintV1 | null;
}

export const CAPABILITY_BINDING_MODES_V1 = [
  "native",
  "adopted",
  "composed",
] as const;
export type CapabilityBindingModeV1 =
  (typeof CAPABILITY_BINDING_MODES_V1)[number];

export const CAPABILITY_CONTROL_V1 = ["borrowed", "pactile-owned"] as const;
export type CapabilityControlV1 = (typeof CAPABILITY_CONTROL_V1)[number];

export const CAPABILITY_DELETE_BOUNDARIES_V1 = [
  "preserve",
  "remove-when-unclaimed",
] as const;
export type CapabilityDeleteBoundaryV1 =
  (typeof CAPABILITY_DELETE_BOUNDARIES_V1)[number];

export interface CapabilityBindingV1 {
  readonly schemaVersion: typeof PACTILE_CONTRACT_SCHEMA_VERSION;
  readonly id: string;
  readonly capabilityId: string;
  readonly mode: CapabilityBindingModeV1;
  readonly control: CapabilityControlV1;
  readonly deleteBoundary: CapabilityDeleteBoundaryV1;
  readonly asset: ExternalAssetRefV1;
  readonly intents: readonly PactileIntentV1[];
  /** MCP and other middleware-backed assets bind through a logical Provider. */
  readonly providerId: string | null;
}

function decodeInstallHintV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): InstallHintV1 {
  const record = decoder.object(value, path, [
    "schemaVersion",
    "mechanism",
    "label",
    "reference",
    "requiresAuthentication",
  ]);
  const mechanism = decoder.enumValue(
    decoder.required(record, "mechanism", path),
    INSTALL_HINT_MECHANISMS_V1,
    childPathV1(path, "mechanism"),
  );
  const label = decodeLogicalIdV1(
    decoder.required(record, "label", path),
    decoder,
    childPathV1(path, "label"),
  );
  if (label.length > 128) {
    decoder.issue(
      "invalid-value",
      childPathV1(path, "label"),
      "symbolic install-hint labels must be at most 128 characters",
    );
  }
  const referenceValue = decoder.required(record, "reference", path);
  const reference =
    referenceValue === null
      ? null
      : decodeOpaqueReferenceV1(
          referenceValue,
          decoder,
          childPathV1(path, "reference"),
          ["docs", "host-native", "package-manager"],
        );
  return {
    schemaVersion: decodeSchemaVersionV1(record, decoder, path),
    mechanism,
    label,
    reference,
    requiresAuthentication: decoder.boolean(
      decoder.required(record, "requiresAuthentication", path),
      childPathV1(path, "requiresAuthentication"),
    ),
  };
}

function decodeExternalAssetOwnerV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): ExternalAssetOwnerV1 {
  const record = decoder.object(value, path, ["kind", "id"]);
  const kind = decoder.enumValue(
    decoder.required(record, "kind", path),
    EXTERNAL_ASSET_OWNER_KINDS_V1,
    childPathV1(path, "kind"),
  );
  const id = decoder.nullableString(
    decoder.required(record, "id", path),
    childPathV1(path, "id"),
    { nonEmpty: true },
  );
  if ((kind === "pactile" || kind === "third-party") && id === null) {
    decoder.issue(
      "required",
      childPathV1(path, "id"),
      `is required for owner kind '${kind}'`,
    );
  }
  return { kind, id };
}

function decodeExternalAssetRefV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): ExternalAssetRefV1 {
  const record = decoder.object(value, path, [
    "schemaVersion",
    "id",
    "kind",
    "source",
    "scope",
    "owner",
    "locator",
    "fingerprint",
    "readiness",
    "installHint",
  ]);
  const source = decoder.enumValue(
    decoder.required(record, "source", path),
    EXTERNAL_ASSET_SOURCES_V1,
    childPathV1(path, "source"),
  );
  const owner = decodeExternalAssetOwnerV1(
    decoder.required(record, "owner", path),
    decoder,
    childPathV1(path, "owner"),
  );
  const readiness = decoder.enumValue(
    decoder.required(record, "readiness", path),
    CAPABILITY_READINESS_V1,
    childPathV1(path, "readiness"),
  );
  const hintValue = decoder.required(record, "installHint", path);
  const installHint =
    hintValue === null
      ? null
      : decodeInstallHintV1(hintValue, decoder, childPathV1(path, "installHint"));
  if (source === "pactile-bundled" && owner.kind !== "pactile") {
    decoder.issue(
      "conflict",
      `${childPathV1(path, "owner")}.kind`,
      "pactile-bundled assets must be owned by Pactile",
    );
  }
  if (source === "host-native" && owner.kind !== "host") {
    decoder.issue(
      "conflict",
      `${childPathV1(path, "owner")}.kind`,
      "host-native assets must retain host ownership",
    );
  }
  if (readiness === "missing" && installHint === null) {
    decoder.issue(
      "required",
      childPathV1(path, "installHint"),
      "is required when an external asset is missing",
    );
  }
  const locator = decodeOpaqueReferenceV1(
    decoder.required(record, "locator", path),
    decoder,
    childPathV1(path, "locator"),
    [source],
  );
  return {
    schemaVersion: decodeSchemaVersionV1(record, decoder, path),
    id: decodeLogicalIdV1(
      decoder.required(record, "id", path),
      decoder,
      childPathV1(path, "id"),
    ),
    kind: decoder.enumValue(
      decoder.required(record, "kind", path),
      EXTERNAL_ASSET_KINDS_V1,
      childPathV1(path, "kind"),
    ),
    source,
    scope: decoder.enumValue(
      decoder.required(record, "scope", path),
      EXTERNAL_ASSET_SCOPES_V1,
      childPathV1(path, "scope"),
    ),
    owner,
    locator,
    fingerprint: decodeNullableFingerprintV1(
      decoder.required(record, "fingerprint", path),
      decoder,
      childPathV1(path, "fingerprint"),
    ),
    readiness,
    installHint,
  };
}

function decodeCapabilityBindingV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): CapabilityBindingV1 {
  const record = decoder.object(value, path, [
    "schemaVersion",
    "id",
    "capabilityId",
    "mode",
    "control",
    "deleteBoundary",
    "asset",
    "intents",
    "providerId",
  ]);
  const mode = decoder.enumValue(
    decoder.required(record, "mode", path),
    CAPABILITY_BINDING_MODES_V1,
    childPathV1(path, "mode"),
  );
  const control = decoder.enumValue(
    decoder.required(record, "control", path),
    CAPABILITY_CONTROL_V1,
    childPathV1(path, "control"),
  );
  const deleteBoundary = decoder.enumValue(
    decoder.required(record, "deleteBoundary", path),
    CAPABILITY_DELETE_BOUNDARIES_V1,
    childPathV1(path, "deleteBoundary"),
  );
  const asset = decodeExternalAssetRefV1(
    decoder.required(record, "asset", path),
    decoder,
    childPathV1(path, "asset"),
  );
  const intents = decoder.array(
    decoder.required(record, "intents", path),
    childPathV1(path, "intents"),
    (item, itemPath) => decoder.enumValue(item, PACTILE_INTENTS_V1, itemPath),
  );
  decoder.unique(intents, (intent) => intent, childPathV1(path, "intents"), "intent");
  const providerValue = decoder.required(record, "providerId", path);
  const providerId =
    providerValue === null
      ? null
      : decodeLogicalIdV1(providerValue, decoder, childPathV1(path, "providerId"));

  if (control === "borrowed" && deleteBoundary !== "preserve") {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "deleteBoundary"),
      "borrowed capabilities are non-owning and must be preserved",
    );
  }
  if ((mode === "native" || mode === "adopted") && control !== "borrowed") {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "control"),
      `${mode} bindings must remain borrowed/non-owning`,
    );
  }
  if (
    mode === "native" &&
    asset.source !== "host-native" &&
    asset.source !== "user-installed"
  ) {
    decoder.issue(
      "conflict",
      childPathV1(path, "asset"),
      "native bindings must reference an existing host-native or user-installed asset",
    );
  }
  if (mode === "adopted" && asset.source === "pactile-bundled") {
    decoder.issue(
      "conflict",
      `${childPathV1(path, "asset")}.source`,
      "adoption is reserved for externally owned assets",
    );
  }
  if (control === "pactile-owned") {
    if (asset.owner.kind !== "pactile") {
      decoder.issue(
        "conflict",
        `${childPathV1(path, "asset")}.owner.kind`,
        "pactile-owned bindings require a Pactile-owned asset",
      );
    }
    if (deleteBoundary !== "remove-when-unclaimed") {
      decoder.issue(
        "conflict",
        childPathV1(path, "deleteBoundary"),
        "pactile-owned bindings use remove-when-unclaimed deletion",
      );
    }
    if (mode !== "composed") {
      decoder.issue(
        "conflict",
        childPathV1(path, "mode"),
        "Pactile-owned assets are introduced only through composed bindings",
      );
    }
    if (
      asset.source !== "pactile-bundled" &&
      asset.source !== "project-vendored"
    ) {
      decoder.issue(
        "conflict",
        `${childPathV1(path, "asset")}.source`,
        "Pactile-owned bindings require a bundled or explicitly vendored asset",
      );
    }
  }
  if (asset.kind === "mcp" && providerId === null) {
    decoder.issue(
      "required",
      childPathV1(path, "providerId"),
      "MCP assets bind through a logical Provider id",
    );
  }

  return {
    schemaVersion: decodeSchemaVersionV1(record, decoder, path),
    id: decodeLogicalIdV1(
      decoder.required(record, "id", path),
      decoder,
      childPathV1(path, "id"),
    ),
    capabilityId: decodeLogicalIdV1(
      decoder.required(record, "capabilityId", path),
      decoder,
      childPathV1(path, "capabilityId"),
    ),
    mode,
    control,
    deleteBoundary,
    asset,
    intents,
    providerId,
  };
}

export const installHintV1Schema = definePactileContractSchemaV1(
  "InstallHintV1",
  decodeInstallHintV1,
);

export const externalAssetRefV1Schema = definePactileContractSchemaV1(
  "ExternalAssetRefV1",
  decodeExternalAssetRefV1,
);

export const capabilityBindingV1Schema = definePactileContractSchemaV1(
  "CapabilityBindingV1",
  decodeCapabilityBindingV1,
);

export function parseInstallHintV1(
  input: unknown,
): PactileContractParseResultV1<InstallHintV1> {
  return installHintV1Schema.parse(input);
}

export function parseExternalAssetRefV1(
  input: unknown,
): PactileContractParseResultV1<ExternalAssetRefV1> {
  return externalAssetRefV1Schema.parse(input);
}

export function parseCapabilityBindingV1(
  input: unknown,
): PactileContractParseResultV1<CapabilityBindingV1> {
  return capabilityBindingV1Schema.parse(input);
}
