import {
  CAPABILITY_CONTROL_V1,
  type CapabilityControlV1,
} from "./capability.js";
import {
  PACTILE_CANONICAL_ROOT_V1,
  PACTILE_LEGACY_ROOTS_V1,
} from "./runtime.js";
import {
  PACTILE_CONTRACT_SCHEMA_VERSION,
  type ContractDecoderV1,
  type PactileContractParseResultV1,
  childPathV1,
  decodeFingerprintV1,
  decodeLogicalIdV1,
  decodeNullableFingerprintV1,
  decodeRelativePosixPathV1,
  decodeSchemaVersionV1,
  decodeTimestampV1,
  definePactileContractSchemaV1,
} from "./validation.js";

export const PROJECTION_FORMATS_V1 = [
  "text",
  "json",
  "toml",
  "managed-block",
  "directory",
  "external-ref",
] as const;
export type ProjectionFormatV1 = (typeof PROJECTION_FORMATS_V1)[number];

export const PROJECTION_ACTIONS_V1 = [
  "ensure",
  "merge",
  "remove",
  "bind",
  "detach",
] as const;
export type ProjectionActionV1 = (typeof PROJECTION_ACTIONS_V1)[number];

export interface ProjectionOperationV1 {
  readonly id: string;
  readonly resourceId: string;
  readonly claimantId: string;
  readonly action: ProjectionActionV1;
  readonly control: CapabilityControlV1;
  readonly targetPath: string | null;
  readonly format: ProjectionFormatV1;
  readonly contentRef: string | null;
  readonly desiredFingerprint: string | null;
  readonly expectedCurrentFingerprint: string | null;
  readonly externalAssetId: string | null;
}

export interface ProjectionPlanV1 {
  readonly schemaVersion: typeof PACTILE_CONTRACT_SCHEMA_VERSION;
  readonly id: string;
  readonly adapterId: string;
  readonly generationId: string;
  readonly canonicalFingerprint: string;
  readonly expectedLedgerFingerprint: string | null;
  readonly operations: readonly ProjectionOperationV1[];
}

export const OWNERSHIP_ORIGINS_V1 = ["created", "adopted", "unknown"] as const;
export type OwnershipOriginV1 = (typeof OWNERSHIP_ORIGINS_V1)[number];

export const OWNERSHIP_CONTROLS_V1 = [
  "pactile-owned",
  "borrowed",
  "unknown",
] as const;
export type OwnershipControlV1 = (typeof OWNERSHIP_CONTROLS_V1)[number];

export const OWNERSHIP_OWNER_KINDS_V1 = [
  "pactile",
  "external",
  "unknown",
] as const;
export type OwnershipOwnerKindV1 = (typeof OWNERSHIP_OWNER_KINDS_V1)[number];

export interface OwnershipOwnerV1 {
  readonly kind: OwnershipOwnerKindV1;
  readonly id: string | null;
}

export const OWNERSHIP_CLAIMANT_KINDS_V1 = [
  "runtime",
  "adapter",
  "tile",
] as const;
export type OwnershipClaimantKindV1 =
  (typeof OWNERSHIP_CLAIMANT_KINDS_V1)[number];

export interface OwnershipClaimantV1 {
  readonly id: string;
  readonly kind: OwnershipClaimantKindV1;
  readonly adapterId: string | null;
}

export const OWNERSHIP_SNAPSHOT_STATES_V1 = [
  "absent",
  "present",
  "unknown",
] as const;
export type OwnershipSnapshotStateV1 =
  (typeof OWNERSHIP_SNAPSHOT_STATES_V1)[number];

export interface OwnershipSnapshotV1 {
  readonly state: OwnershipSnapshotStateV1;
  readonly fingerprint: string | null;
  readonly contentRef: string | null;
}

export const OWNERSHIP_CONFLICTS_V1 = [
  "none",
  "modified",
  "missing",
  "ownership-unknown",
  "claimant-conflict",
] as const;
export type OwnershipConflictV1 = (typeof OWNERSHIP_CONFLICTS_V1)[number];

export const OWNERSHIP_DISPOSITIONS_V1 = [
  "no-op",
  "write-generated",
  "restore-preimage",
  "remove-generated",
  "preserve-modified",
  "preserve-borrowed",
  "manual-review",
] as const;
export type OwnershipDispositionV1 = (typeof OWNERSHIP_DISPOSITIONS_V1)[number];

export interface OwnershipLedgerEntryV1 {
  readonly resourceId: string;
  readonly targetPath: string;
  readonly format: ProjectionFormatV1;
  readonly origin: OwnershipOriginV1;
  readonly control: OwnershipControlV1;
  readonly owner: OwnershipOwnerV1;
  readonly claimants: readonly OwnershipClaimantV1[];
  readonly preimage: OwnershipSnapshotV1;
  readonly generated: OwnershipSnapshotV1;
  readonly current: OwnershipSnapshotV1;
  readonly conflict: OwnershipConflictV1;
  readonly disposition: OwnershipDispositionV1;
}

export interface OwnershipLedgerV1 {
  readonly schemaVersion: typeof PACTILE_CONTRACT_SCHEMA_VERSION;
  readonly generationId: string;
  readonly updatedAt: string;
  readonly entries: readonly OwnershipLedgerEntryV1[];
}

const PROTECTED_RUNTIME_ROOTS_V1 = [
  PACTILE_CANONICAL_ROOT_V1,
  ...PACTILE_LEGACY_ROOTS_V1,
] as const;

function isProtectedRuntimeTargetV1(targetPath: string | null): boolean {
  if (targetPath === null) return false;
  const physicalTarget = physicalTargetIdentityV1(targetPath);
  return PROTECTED_RUNTIME_ROOTS_V1.some((root) => {
    const physicalRoot = physicalTargetIdentityV1(root);
    return (
      physicalTarget === physicalRoot ||
      physicalTarget.startsWith(`${physicalRoot}/`)
    );
  });
}

function physicalTargetIdentityV1(targetPath: string): string {
  // Portable identity must not change with host filesystem case semantics or
  // Unicode normalization. The original target spelling remains in the ABI.
  return targetPath.normalize("NFC").toLowerCase();
}

function decodeNullableLogicalIdV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): string | null {
  if (value === null) return null;
  return decodeLogicalIdV1(value, decoder, path);
}

function decodeNullableNonEmptyStringV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): string | null {
  if (value === null) return null;
  return decoder.string(value, path, { nonEmpty: true });
}

function decodeProjectionOperationV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): ProjectionOperationV1 {
  const record = decoder.object(value, path, [
    "id",
    "resourceId",
    "claimantId",
    "action",
    "control",
    "targetPath",
    "format",
    "contentRef",
    "desiredFingerprint",
    "expectedCurrentFingerprint",
    "externalAssetId",
  ]);
  const action = decoder.enumValue(
    decoder.required(record, "action", path),
    PROJECTION_ACTIONS_V1,
    childPathV1(path, "action"),
  );
  const control = decoder.enumValue(
    decoder.required(record, "control", path),
    CAPABILITY_CONTROL_V1,
    childPathV1(path, "control"),
  );
  const targetValue = decoder.required(record, "targetPath", path);
  const targetPath =
    targetValue === null
      ? null
      : decodeRelativePosixPathV1(
          targetValue,
          decoder,
          childPathV1(path, "targetPath"),
        );
  const format = decoder.enumValue(
    decoder.required(record, "format", path),
    PROJECTION_FORMATS_V1,
    childPathV1(path, "format"),
  );
  const contentRef = decodeNullableNonEmptyStringV1(
    decoder.required(record, "contentRef", path),
    decoder,
    childPathV1(path, "contentRef"),
  );
  const desiredFingerprint = decodeNullableFingerprintV1(
    decoder.required(record, "desiredFingerprint", path),
    decoder,
    childPathV1(path, "desiredFingerprint"),
  );
  const expectedCurrentFingerprint = decodeNullableFingerprintV1(
    decoder.required(record, "expectedCurrentFingerprint", path),
    decoder,
    childPathV1(path, "expectedCurrentFingerprint"),
  );
  const externalAssetId = decodeNullableLogicalIdV1(
    decoder.required(record, "externalAssetId", path),
    decoder,
    childPathV1(path, "externalAssetId"),
  );

  if (isProtectedRuntimeTargetV1(targetPath)) {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "targetPath"),
      "Adapter projections cannot target canonical or read-only legacy runtime roots",
    );
  }

  if (control === "borrowed" && action !== "bind" && action !== "detach") {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "action"),
      "borrowed resources may only be bound or detached, never written or removed",
    );
  }
  if (action === "bind" || action === "detach") {
    if (
      control !== "borrowed" ||
      format !== "external-ref" ||
      targetPath !== null ||
      contentRef !== null ||
      desiredFingerprint !== null ||
      expectedCurrentFingerprint !== null ||
      externalAssetId === null
    ) {
      decoder.issue(
        "conflict",
        path,
        "bind/detach operations must be borrowed external refs without a writable target or content",
      );
    }
  } else {
    if (
      format === "external-ref" ||
      targetPath === null ||
      externalAssetId !== null
    ) {
      decoder.issue(
        "conflict",
        path,
        "file projection operations require a target and cannot use external-ref metadata",
      );
    }
    if (
      (action === "ensure" || action === "merge") &&
      (contentRef === null || desiredFingerprint === null)
    ) {
      decoder.issue(
        "required",
        path,
        "ensure/merge operations require contentRef and desiredFingerprint",
      );
    }
    if (
      action === "remove" &&
      (contentRef !== null || desiredFingerprint !== null)
    ) {
      decoder.issue(
        "conflict",
        path,
        "remove operations do not carry desired content",
      );
    }
    // `null` is an explicit compare-and-swap expectation that the target is
    // absent.  This is important for an idempotent release after a user (or a
    // previous transaction) has already removed the generated file.  The
    // planner still compares the value against the observed fingerprint, so a
    // present target cannot be removed under an absent expectation.
    if (
      action === "merge" &&
      format !== "json" &&
      format !== "toml" &&
      format !== "managed-block"
    ) {
      decoder.issue(
        "conflict",
        childPathV1(path, "format"),
        "merge is only defined for json, toml, or managed-block projections",
      );
    }
  }

  return {
    id: decodeLogicalIdV1(
      decoder.required(record, "id", path),
      decoder,
      childPathV1(path, "id"),
    ),
    resourceId: decodeLogicalIdV1(
      decoder.required(record, "resourceId", path),
      decoder,
      childPathV1(path, "resourceId"),
    ),
    claimantId: decodeLogicalIdV1(
      decoder.required(record, "claimantId", path),
      decoder,
      childPathV1(path, "claimantId"),
    ),
    action,
    control,
    targetPath,
    format,
    contentRef,
    desiredFingerprint,
    expectedCurrentFingerprint,
    externalAssetId,
  };
}

function decodeProjectionPlanV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): ProjectionPlanV1 {
  const record = decoder.object(value, path, [
    "schemaVersion",
    "id",
    "adapterId",
    "generationId",
    "canonicalFingerprint",
    "expectedLedgerFingerprint",
    "operations",
  ]);
  const operations = decoder.array(
    decoder.required(record, "operations", path),
    childPathV1(path, "operations"),
    (item, itemPath) => decodeProjectionOperationV1(item, decoder, itemPath),
  );
  decoder.unique(
    operations,
    (operation) => operation.id,
    childPathV1(path, "operations"),
    "operation id",
  );
  decoder.unique(
    operations,
    (operation) =>
      `${operation.resourceId}\u0000${operation.claimantId}\u0000${operation.targetPath ?? operation.externalAssetId ?? ""}`,
    childPathV1(path, "operations"),
    "resource claim",
  );
  decoder.unique(
    operations,
    (operation) =>
      operation.targetPath === null
        ? `external-operation:${operation.id}`
        : `physical-target:${physicalTargetIdentityV1(operation.targetPath)}`,
    childPathV1(path, "operations"),
    "physical projection target",
  );
  return {
    schemaVersion: decodeSchemaVersionV1(record, decoder, path),
    id: decodeLogicalIdV1(
      decoder.required(record, "id", path),
      decoder,
      childPathV1(path, "id"),
    ),
    adapterId: decodeLogicalIdV1(
      decoder.required(record, "adapterId", path),
      decoder,
      childPathV1(path, "adapterId"),
    ),
    generationId: decodeLogicalIdV1(
      decoder.required(record, "generationId", path),
      decoder,
      childPathV1(path, "generationId"),
    ),
    canonicalFingerprint: decodeFingerprintV1(
      decoder.required(record, "canonicalFingerprint", path),
      decoder,
      childPathV1(path, "canonicalFingerprint"),
    ),
    expectedLedgerFingerprint: decodeNullableFingerprintV1(
      decoder.required(record, "expectedLedgerFingerprint", path),
      decoder,
      childPathV1(path, "expectedLedgerFingerprint"),
    ),
    operations,
  };
}

function decodeOwnershipOwnerV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): OwnershipOwnerV1 {
  const record = decoder.object(value, path, ["kind", "id"]);
  const kind = decoder.enumValue(
    decoder.required(record, "kind", path),
    OWNERSHIP_OWNER_KINDS_V1,
    childPathV1(path, "kind"),
  );
  const id = decoder.nullableString(
    decoder.required(record, "id", path),
    childPathV1(path, "id"),
    { nonEmpty: true },
  );
  if (kind !== "unknown" && id === null) {
    decoder.issue(
      "required",
      childPathV1(path, "id"),
      `is required for owner kind '${kind}'`,
    );
  }
  if (kind === "unknown" && id !== null) {
    decoder.issue(
      "conflict",
      childPathV1(path, "id"),
      "must be null for unknown ownership",
    );
  }
  return { kind, id };
}

function decodeOwnershipClaimantV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): OwnershipClaimantV1 {
  const record = decoder.object(value, path, ["id", "kind", "adapterId"]);
  const kind = decoder.enumValue(
    decoder.required(record, "kind", path),
    OWNERSHIP_CLAIMANT_KINDS_V1,
    childPathV1(path, "kind"),
  );
  const adapterId = decodeNullableLogicalIdV1(
    decoder.required(record, "adapterId", path),
    decoder,
    childPathV1(path, "adapterId"),
  );
  if (kind === "adapter" && adapterId === null) {
    decoder.issue(
      "required",
      childPathV1(path, "adapterId"),
      "is required for an adapter claimant",
    );
  }
  if (kind !== "adapter" && adapterId !== null) {
    decoder.issue(
      "conflict",
      childPathV1(path, "adapterId"),
      "is only valid for an adapter claimant",
    );
  }
  return {
    id: decodeLogicalIdV1(
      decoder.required(record, "id", path),
      decoder,
      childPathV1(path, "id"),
    ),
    kind,
    adapterId,
  };
}

function decodeOwnershipSnapshotV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): OwnershipSnapshotV1 {
  const record = decoder.object(value, path, [
    "state",
    "fingerprint",
    "contentRef",
  ]);
  const state = decoder.enumValue(
    decoder.required(record, "state", path),
    OWNERSHIP_SNAPSHOT_STATES_V1,
    childPathV1(path, "state"),
  );
  const fingerprint = decodeNullableFingerprintV1(
    decoder.required(record, "fingerprint", path),
    decoder,
    childPathV1(path, "fingerprint"),
  );
  const contentRef = decodeNullableNonEmptyStringV1(
    decoder.required(record, "contentRef", path),
    decoder,
    childPathV1(path, "contentRef"),
  );
  if (state === "present" && fingerprint === null) {
    decoder.issue(
      "required",
      childPathV1(path, "fingerprint"),
      "is required for present content",
    );
  }
  if (state !== "present" && (fingerprint !== null || contentRef !== null)) {
    decoder.issue(
      "conflict",
      path,
      `${state} content cannot claim a fingerprint or contentRef`,
    );
  }
  return { state, fingerprint, contentRef };
}

function decodeOwnershipLedgerEntryV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): OwnershipLedgerEntryV1 {
  const record = decoder.object(value, path, [
    "resourceId",
    "targetPath",
    "format",
    "origin",
    "control",
    "owner",
    "claimants",
    "preimage",
    "generated",
    "current",
    "conflict",
    "disposition",
  ]);
  const origin = decoder.enumValue(
    decoder.required(record, "origin", path),
    OWNERSHIP_ORIGINS_V1,
    childPathV1(path, "origin"),
  );
  const control = decoder.enumValue(
    decoder.required(record, "control", path),
    OWNERSHIP_CONTROLS_V1,
    childPathV1(path, "control"),
  );
  const owner = decodeOwnershipOwnerV1(
    decoder.required(record, "owner", path),
    decoder,
    childPathV1(path, "owner"),
  );
  const claimants = decoder.array(
    decoder.required(record, "claimants", path),
    childPathV1(path, "claimants"),
    (item, itemPath) => decodeOwnershipClaimantV1(item, decoder, itemPath),
  );
  decoder.unique(
    claimants,
    (claimant) => claimant.id,
    childPathV1(path, "claimants"),
    "claimant id",
  );
  const preimage = decodeOwnershipSnapshotV1(
    decoder.required(record, "preimage", path),
    decoder,
    childPathV1(path, "preimage"),
  );
  const generated = decodeOwnershipSnapshotV1(
    decoder.required(record, "generated", path),
    decoder,
    childPathV1(path, "generated"),
  );
  const current = decodeOwnershipSnapshotV1(
    decoder.required(record, "current", path),
    decoder,
    childPathV1(path, "current"),
  );
  const conflict = decoder.enumValue(
    decoder.required(record, "conflict", path),
    OWNERSHIP_CONFLICTS_V1,
    childPathV1(path, "conflict"),
  );
  const disposition = decoder.enumValue(
    decoder.required(record, "disposition", path),
    OWNERSHIP_DISPOSITIONS_V1,
    childPathV1(path, "disposition"),
  );

  const targetPath = decodeRelativePosixPathV1(
    decoder.required(record, "targetPath", path),
    decoder,
    childPathV1(path, "targetPath"),
  );
  if (isProtectedRuntimeTargetV1(targetPath)) {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "targetPath"),
      "projection ownership entries cannot target canonical or read-only legacy runtime roots",
    );
  }

  if (origin === "created" && preimage.state !== "absent") {
    decoder.issue(
      "conflict",
      childPathV1(path, "preimage"),
      "created resources must record an absent preimage",
    );
  }
  if (origin === "adopted" && preimage.state !== "present") {
    decoder.issue(
      "conflict",
      childPathV1(path, "preimage"),
      "adopted resources must retain a present preimage",
    );
  }
  if (origin === "unknown" && preimage.state !== "unknown") {
    decoder.issue(
      "conflict",
      childPathV1(path, "preimage"),
      "unknown resources must retain an unknown preimage",
    );
  }
  if (origin === "created" && control === "borrowed") {
    decoder.issue(
      "conflict",
      childPathV1(path, "control"),
      "Pactile cannot create an externally borrowed resource",
    );
  }
  if (origin === "unknown" && control !== "unknown") {
    decoder.issue(
      "conflict",
      childPathV1(path, "control"),
      "unknown origin requires unknown control",
    );
  }
  if (control === "unknown" && origin !== "unknown") {
    decoder.issue(
      "conflict",
      childPathV1(path, "origin"),
      "unknown control requires unknown origin",
    );
  }
  if (control === "pactile-owned" && owner.kind !== "pactile") {
    decoder.issue(
      "conflict",
      childPathV1(path, "owner"),
      "pactile-owned resources require a Pactile owner",
    );
  }
  if (control === "borrowed" && owner.kind !== "external") {
    decoder.issue(
      "conflict",
      childPathV1(path, "owner"),
      "borrowed resources retain an external owner",
    );
  }
  if (control === "unknown" && owner.kind !== "unknown") {
    decoder.issue(
      "conflict",
      childPathV1(path, "owner"),
      "unknown control requires unknown ownership",
    );
  }

  const destructiveDispositions: readonly OwnershipDispositionV1[] = [
    "restore-preimage",
    "remove-generated",
  ];
  if (claimants.length > 0 && destructiveDispositions.includes(disposition)) {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "disposition"),
      "a resource with active claimants cannot be restored or removed",
    );
  }
  if (
    control === "borrowed" &&
    !["no-op", "preserve-borrowed", "manual-review"].includes(disposition)
  ) {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "disposition"),
      "borrowed resources cannot be overwritten, restored, or removed",
    );
  }
  if (
    (control === "unknown" || origin === "unknown") &&
    !["no-op", "manual-review"].includes(disposition)
  ) {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "disposition"),
      "unknown ownership must be preserved for manual review",
    );
  }
  if (
    conflict === "modified" &&
    !["preserve-modified", "manual-review"].includes(disposition)
  ) {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "disposition"),
      "modified content must be preserved or sent to manual review",
    );
  }
  if (
    conflict === "missing" &&
    (current.state !== "absent" || generated.state !== "present")
  ) {
    decoder.issue(
      "conflict",
      childPathV1(path, "conflict"),
      "missing conflict requires absent current and present generated content",
    );
  }
  if (
    conflict === "ownership-unknown" &&
    (origin !== "unknown" || control !== "unknown")
  ) {
    decoder.issue(
      "conflict",
      childPathV1(path, "conflict"),
      "ownership-unknown requires unknown origin and control",
    );
  }
  if (
    conflict === "modified" &&
    (current.state !== "present" ||
      generated.state !== "present" ||
      current.fingerprint === generated.fingerprint)
  ) {
    decoder.issue(
      "conflict",
      childPathV1(path, "conflict"),
      "modified conflict requires distinct present current and generated fingerprints",
    );
  }
  if (
    disposition === "remove-generated" &&
    (conflict !== "none" ||
      control !== "pactile-owned" ||
      current.state !== "present" ||
      generated.state !== "present" ||
      current.fingerprint !== generated.fingerprint)
  ) {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "disposition"),
      "remove-generated requires unmodified Pactile-owned generated content",
    );
  }
  if (
    disposition === "restore-preimage" &&
    (conflict !== "none" ||
      control !== "pactile-owned" ||
      origin !== "adopted" ||
      preimage.state !== "present" ||
      preimage.contentRef === null ||
      generated.state !== "present" ||
      current.state !== "present" ||
      current.fingerprint !== generated.fingerprint)
  ) {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "disposition"),
      "restore-preimage requires an unclaimed adopted Pactile-managed resource with retained preimage content",
    );
  }
  if (
    disposition === "write-generated" &&
    (control !== "pactile-owned" || generated.state !== "present")
  ) {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "disposition"),
      "write-generated requires present Pactile-owned generated content",
    );
  }
  if (disposition === "preserve-borrowed" && control !== "borrowed") {
    decoder.issue(
      "conflict",
      childPathV1(path, "disposition"),
      "preserve-borrowed is only valid for borrowed resources",
    );
  }
  if (disposition === "preserve-modified" && conflict !== "modified") {
    decoder.issue(
      "conflict",
      childPathV1(path, "disposition"),
      "preserve-modified requires a modified conflict",
    );
  }
  if (conflict === "claimant-conflict" && disposition !== "manual-review") {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "disposition"),
      "claimant conflicts require manual review",
    );
  }

  return {
    resourceId: decodeLogicalIdV1(
      decoder.required(record, "resourceId", path),
      decoder,
      childPathV1(path, "resourceId"),
    ),
    targetPath,
    format: decoder.enumValue(
      decoder.required(record, "format", path),
      PROJECTION_FORMATS_V1.filter((format) => format !== "external-ref"),
      childPathV1(path, "format"),
    ),
    origin,
    control,
    owner,
    claimants,
    preimage,
    generated,
    current,
    conflict,
    disposition,
  };
}

function decodeOwnershipLedgerV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): OwnershipLedgerV1 {
  const record = decoder.object(value, path, [
    "schemaVersion",
    "generationId",
    "updatedAt",
    "entries",
  ]);
  const entries = decoder.array(
    decoder.required(record, "entries", path),
    childPathV1(path, "entries"),
    (item, itemPath) => decodeOwnershipLedgerEntryV1(item, decoder, itemPath),
  );
  decoder.unique(
    entries,
    (entry) => entry.resourceId,
    childPathV1(path, "entries"),
    "host-neutral resource id",
  );
  decoder.unique(
    entries,
    (entry) => physicalTargetIdentityV1(entry.targetPath),
    childPathV1(path, "entries"),
    "physical target",
  );
  return {
    schemaVersion: decodeSchemaVersionV1(record, decoder, path),
    generationId: decodeLogicalIdV1(
      decoder.required(record, "generationId", path),
      decoder,
      childPathV1(path, "generationId"),
    ),
    updatedAt: decodeTimestampV1(
      decoder.required(record, "updatedAt", path),
      decoder,
      childPathV1(path, "updatedAt"),
    ),
    entries,
  };
}

export const projectionPlanV1Schema = definePactileContractSchemaV1(
  "ProjectionPlanV1",
  decodeProjectionPlanV1,
);

export const ownershipLedgerV1Schema = definePactileContractSchemaV1(
  "OwnershipLedgerV1",
  decodeOwnershipLedgerV1,
);

export function parseProjectionPlanV1(
  input: unknown,
): PactileContractParseResultV1<ProjectionPlanV1> {
  return projectionPlanV1Schema.parse(input);
}

export function parseOwnershipLedgerV1(
  input: unknown,
): PactileContractParseResultV1<OwnershipLedgerV1> {
  return ownershipLedgerV1Schema.parse(input);
}
