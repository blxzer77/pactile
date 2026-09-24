import {
  PACTILE_CONTRACT_SCHEMA_VERSION,
  type ContractDecoderV1,
  type PactileContractParseResultV1,
  childPathV1,
  decodeLogicalIdV1,
  decodeNullableFingerprintV1,
  decodeNullableTimestampV1,
  decodeRelativePosixPathV1,
  decodeSchemaVersionV1,
  decodeSemverV1,
  decodeTimestampV1,
  definePactileContractSchemaV1,
} from "./validation.js";

export const PACTILE_CANONICAL_ROOT_V1 = ".pactile" as const;
export const PACTILE_CANONICAL_WRITE_POLICY_V1 = "canonical-only" as const;

export const PACTILE_LEGACY_ROOTS_V1 = [".cstl", ".trellis"] as const;
export type PactileLegacyRootV1 = (typeof PACTILE_LEGACY_ROOTS_V1)[number];
export type PactileLegacySourceKindV1 = "cstl" | "trellis";

export interface LegacyReadSourceV1 {
  readonly kind: PactileLegacySourceKindV1;
  readonly root: PactileLegacyRootV1;
  readonly access: "read-only";
}

export interface CanonicalPathsV1 {
  readonly schemaVersion: typeof PACTILE_CONTRACT_SCHEMA_VERSION;
  readonly canonicalRoot: typeof PACTILE_CANONICAL_ROOT_V1;
  readonly writePolicy: typeof PACTILE_CANONICAL_WRITE_POLICY_V1;
  readonly installStatePath: string;
  readonly generationsPath: string;
  readonly tilesPath: string;
  readonly tasksPath: string;
  readonly archivePath: string;
  readonly workspacePath: string;
  readonly ownershipLedgerPath: string;
  readonly migrationJournalsPath: string;
  readonly receiptsPath: string;
  readonly legacySources: readonly LegacyReadSourceV1[];
}

export const DEFAULT_CANONICAL_PATHS_V1: CanonicalPathsV1 = {
  schemaVersion: PACTILE_CONTRACT_SCHEMA_VERSION,
  canonicalRoot: PACTILE_CANONICAL_ROOT_V1,
  writePolicy: PACTILE_CANONICAL_WRITE_POLICY_V1,
  installStatePath: ".pactile/runtime/install-state.json",
  generationsPath: ".pactile/runtime/generations",
  tilesPath: ".pactile/tiles",
  tasksPath: ".pactile/tasks",
  archivePath: ".pactile/archive",
  workspacePath: ".pactile/workspace",
  ownershipLedgerPath: ".pactile/runtime/ownership-ledger.json",
  migrationJournalsPath: ".pactile/runtime/migrations",
  receiptsPath: ".pactile/runtime/receipts",
  legacySources: [
    { kind: "cstl", root: ".cstl", access: "read-only" },
    { kind: "trellis", root: ".trellis", access: "read-only" },
  ],
};

export const INSTALL_STATES_V1 = ["active", "degraded", "inactive"] as const;
export type InstallStatusV1 = (typeof INSTALL_STATES_V1)[number];

export const ADAPTER_INSTALL_STATES_V1 = [
  "active",
  "degraded",
  "detached",
] as const;
export type AdapterInstallStatusV1 =
  (typeof ADAPTER_INSTALL_STATES_V1)[number];

export interface InstalledAdapterV1 {
  readonly id: string;
  readonly version: string;
  readonly status: AdapterInstallStatusV1;
  readonly lastProjectionFingerprint: string | null;
  readonly reconciledAt: string | null;
}

export interface InstallStateV1 {
  readonly schemaVersion: typeof PACTILE_CONTRACT_SCHEMA_VERSION;
  readonly product: "pactile";
  readonly canonicalRoot: typeof PACTILE_CANONICAL_ROOT_V1;
  readonly runtimeVersion: string;
  readonly contractVersion: typeof PACTILE_CONTRACT_SCHEMA_VERSION;
  readonly generationId: string;
  readonly status: InstallStatusV1;
  readonly installedAdapters: readonly InstalledAdapterV1[];
  readonly lastMigrationJournalId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const canonicalPathsKeys = [
  "schemaVersion",
  "canonicalRoot",
  "writePolicy",
  "installStatePath",
  "generationsPath",
  "tilesPath",
  "tasksPath",
  "archivePath",
  "workspacePath",
  "ownershipLedgerPath",
  "migrationJournalsPath",
  "receiptsPath",
  "legacySources",
] as const;

const canonicalPathFieldNames = [
  "installStatePath",
  "generationsPath",
  "tilesPath",
  "tasksPath",
  "archivePath",
  "workspacePath",
  "ownershipLedgerPath",
  "migrationJournalsPath",
  "receiptsPath",
] as const;

function decodeLegacySourceV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): LegacyReadSourceV1 {
  const record = decoder.object(value, path, ["kind", "root", "access"]);
  const kind = decoder.enumValue(
    decoder.required(record, "kind", path),
    ["cstl", "trellis"] as const,
    childPathV1(path, "kind"),
  );
  const root = decoder.enumValue(
    decoder.required(record, "root", path),
    PACTILE_LEGACY_ROOTS_V1,
    childPathV1(path, "root"),
  );
  const access = decoder.literal(
    decoder.required(record, "access", path),
    "read-only",
    childPathV1(path, "access"),
  );
  const expectedRoot = kind === "cstl" ? ".cstl" : ".trellis";
  if (root !== expectedRoot) {
    decoder.issue(
      "conflict",
      childPathV1(path, "root"),
      `legacy kind '${kind}' must use root '${expectedRoot}'`,
    );
  }
  return { kind, root, access };
}

function decodeCanonicalPathsV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): CanonicalPathsV1 {
  const record = decoder.object(value, path, canonicalPathsKeys);
  const schemaVersion = decodeSchemaVersionV1(record, decoder, path);
  const canonicalRoot = decoder.literal(
    decoder.required(record, "canonicalRoot", path),
    PACTILE_CANONICAL_ROOT_V1,
    childPathV1(path, "canonicalRoot"),
  );
  const writePolicy = decoder.literal(
    decoder.required(record, "writePolicy", path),
    PACTILE_CANONICAL_WRITE_POLICY_V1,
    childPathV1(path, "writePolicy"),
  );

  const decodedPaths: Record<(typeof canonicalPathFieldNames)[number], string> =
    {} as Record<(typeof canonicalPathFieldNames)[number], string>;
  for (const field of canonicalPathFieldNames) {
    const fieldPath = childPathV1(path, field);
    const decoded = decodeRelativePosixPathV1(
      decoder.required(record, field, path),
      decoder,
      fieldPath,
    );
    if (
      decoded !== canonicalRoot &&
      !decoded.startsWith(`${canonicalRoot}/`)
    ) {
      decoder.issue(
        "policy-violation",
        fieldPath,
        `must remain inside canonical root '${canonicalRoot}'`,
      );
    }
    decodedPaths[field] = decoded;
  }
  decoder.unique(
    canonicalPathFieldNames.map((field) => ({ field, path: decodedPaths[field] })),
    (entry) => entry.path,
    path,
    "canonical path",
  );

  const legacySources = decoder.array(
    decoder.required(record, "legacySources", path),
    childPathV1(path, "legacySources"),
    (item, itemPath) => decodeLegacySourceV1(item, decoder, itemPath),
  );
  decoder.unique(
    legacySources,
    (source) => source.root,
    childPathV1(path, "legacySources"),
    "legacy root",
  );
  const requiredLegacyRoots = new Set<string>(PACTILE_LEGACY_ROOTS_V1);
  if (
    legacySources.length !== PACTILE_LEGACY_ROOTS_V1.length ||
    legacySources.some((source) => !requiredLegacyRoots.has(source.root))
  ) {
    decoder.issue(
      "required",
      childPathV1(path, "legacySources"),
      "v1 must enumerate exactly the read-only '.cstl' and '.trellis' legacy sources",
    );
  }

  return {
    schemaVersion,
    canonicalRoot,
    writePolicy,
    ...decodedPaths,
    legacySources,
  };
}

function decodeInstalledAdapterV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): InstalledAdapterV1 {
  const record = decoder.object(value, path, [
    "id",
    "version",
    "status",
    "lastProjectionFingerprint",
    "reconciledAt",
  ]);
  const lastProjectionFingerprint = decodeNullableFingerprintV1(
    decoder.required(record, "lastProjectionFingerprint", path),
    decoder,
    childPathV1(path, "lastProjectionFingerprint"),
  );
  const reconciledAt = decodeNullableTimestampV1(
    decoder.required(record, "reconciledAt", path),
    decoder,
    childPathV1(path, "reconciledAt"),
  );
  if ((lastProjectionFingerprint === null) !== (reconciledAt === null)) {
    decoder.issue(
      "conflict",
      path,
      "lastProjectionFingerprint and reconciledAt must either both be present or both be null",
    );
  }
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
    status: decoder.enumValue(
      decoder.required(record, "status", path),
      ADAPTER_INSTALL_STATES_V1,
      childPathV1(path, "status"),
    ),
    lastProjectionFingerprint,
    reconciledAt,
  };
}

function decodeInstallStateV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): InstallStateV1 {
  const record = decoder.object(value, path, [
    "schemaVersion",
    "product",
    "canonicalRoot",
    "runtimeVersion",
    "contractVersion",
    "generationId",
    "status",
    "installedAdapters",
    "lastMigrationJournalId",
    "createdAt",
    "updatedAt",
  ]);
  const installedAdapters = decoder.array(
    decoder.required(record, "installedAdapters", path),
    childPathV1(path, "installedAdapters"),
    (item, itemPath) => decodeInstalledAdapterV1(item, decoder, itemPath),
  );
  decoder.unique(
    installedAdapters,
    (adapter) => adapter.id,
    childPathV1(path, "installedAdapters"),
    "adapter id",
  );

  const createdAt = decodeTimestampV1(
    decoder.required(record, "createdAt", path),
    decoder,
    childPathV1(path, "createdAt"),
  );
  const updatedAt = decodeTimestampV1(
    decoder.required(record, "updatedAt", path),
    decoder,
    childPathV1(path, "updatedAt"),
  );
  const status = decoder.enumValue(
    decoder.required(record, "status", path),
    INSTALL_STATES_V1,
    childPathV1(path, "status"),
  );
  if (
    createdAt.length > 0 &&
    updatedAt.length > 0 &&
    Date.parse(updatedAt) < Date.parse(createdAt)
  ) {
    decoder.issue(
      "conflict",
      childPathV1(path, "updatedAt"),
      "must not be earlier than createdAt",
    );
  }
  if (
    status === "active" &&
    installedAdapters.some((adapter) => adapter.status === "degraded")
  ) {
    decoder.issue(
      "conflict",
      childPathV1(path, "status"),
      "active install state cannot hide a degraded Adapter",
    );
  }
  if (
    status === "inactive" &&
    installedAdapters.some((adapter) => adapter.status === "active")
  ) {
    decoder.issue(
      "conflict",
      childPathV1(path, "status"),
      "inactive install state cannot contain an active Adapter",
    );
  }
  const lastMigrationValue = decoder.required(
    record,
    "lastMigrationJournalId",
    path,
  );
  const lastMigrationJournalId =
    lastMigrationValue === null
      ? null
      : decodeLogicalIdV1(
          lastMigrationValue,
          decoder,
          childPathV1(path, "lastMigrationJournalId"),
        );

  return {
    schemaVersion: decodeSchemaVersionV1(record, decoder, path),
    product: decoder.literal(
      decoder.required(record, "product", path),
      "pactile",
      childPathV1(path, "product"),
    ),
    canonicalRoot: decoder.literal(
      decoder.required(record, "canonicalRoot", path),
      PACTILE_CANONICAL_ROOT_V1,
      childPathV1(path, "canonicalRoot"),
    ),
    runtimeVersion: decodeSemverV1(
      decoder.required(record, "runtimeVersion", path),
      decoder,
      childPathV1(path, "runtimeVersion"),
    ),
    contractVersion: decoder.literal(
      decoder.required(record, "contractVersion", path),
      PACTILE_CONTRACT_SCHEMA_VERSION,
      childPathV1(path, "contractVersion"),
    ),
    generationId: decodeLogicalIdV1(
      decoder.required(record, "generationId", path),
      decoder,
      childPathV1(path, "generationId"),
    ),
    status,
    installedAdapters,
    lastMigrationJournalId,
    createdAt,
    updatedAt,
  };
}

export const canonicalPathsV1Schema = definePactileContractSchemaV1(
  "CanonicalPathsV1",
  decodeCanonicalPathsV1,
);

export const installStateV1Schema = definePactileContractSchemaV1(
  "InstallStateV1",
  decodeInstallStateV1,
);

export function parseCanonicalPathsV1(
  input: unknown,
): PactileContractParseResultV1<CanonicalPathsV1> {
  return canonicalPathsV1Schema.parse(input);
}

export function parseInstallStateV1(
  input: unknown,
): PactileContractParseResultV1<InstallStateV1> {
  return installStateV1Schema.parse(input);
}
