import {
  PACTILE_CANONICAL_ROOT_V1,
  PACTILE_LEGACY_ROOTS_V1,
  type PactileLegacyRootV1,
} from "./runtime.js";
import {
  PACTILE_CONTRACT_SCHEMA_VERSION,
  type ContractDecoderV1,
  type PactileContractParseResultV1,
  childPathV1,
  decodeFingerprintV1,
  decodeLogicalIdV1,
  decodeNullableTimestampV1,
  decodeSchemaVersionV1,
  decodeSemverV1,
  decodeTimestampV1,
  definePactileContractSchemaV1,
} from "./validation.js";

export const MIGRATION_SOURCE_KINDS_V1 = [
  "fresh",
  "canonical",
  "legacy",
] as const;
export type MigrationSourceKindV1 = (typeof MIGRATION_SOURCE_KINDS_V1)[number];

export interface MigrationSourceV1 {
  readonly kind: MigrationSourceKindV1;
  readonly root: typeof PACTILE_CANONICAL_ROOT_V1 | PactileLegacyRootV1 | null;
  readonly access: "none" | "read-only" | "read-write";
  readonly runtimeVersion: string | null;
  readonly schemaVersion: number | null;
}

export interface MigrationTargetV1 {
  readonly root: typeof PACTILE_CANONICAL_ROOT_V1;
  readonly runtimeVersion: string;
  readonly schemaVersion: typeof PACTILE_CONTRACT_SCHEMA_VERSION;
  readonly generationId: string;
}

export const MIGRATION_PHASES_V1 = [
  "detect",
  "backup",
  "stage",
  "validate",
  "commit",
  "reconcile",
  "doctor",
] as const;
export type MigrationPhaseV1 = (typeof MIGRATION_PHASES_V1)[number];

export const MIGRATION_ACTION_KINDS_V1 = [
  "capture-facts",
  "snapshot",
  "copy-byte-preserved",
  "transform-schema",
  "write-generation",
  "validate-generation",
  "activate-generation",
  "reconcile-projection",
  "doctor",
] as const;
export type MigrationActionKindV1 = (typeof MIGRATION_ACTION_KINDS_V1)[number];

export const MIGRATION_ACTION_DOMAINS_V1 = ["canonical", "projection"] as const;
export type MigrationActionDomainV1 =
  (typeof MIGRATION_ACTION_DOMAINS_V1)[number];

export interface MigrationActionV1 {
  readonly id: string;
  readonly phase: MigrationPhaseV1;
  readonly kind: MigrationActionKindV1;
  readonly domain: MigrationActionDomainV1;
  readonly sourceRef: string | null;
  readonly targetRef: string | null;
  readonly adapterId: string | null;
  readonly reversible: boolean;
}

export interface MigrationPreservationV1 {
  readonly bytePreservedRefs: readonly string[];
  readonly transformedRefs: readonly string[];
}

export interface MigrationRecoveryV1 {
  readonly backupRef: string;
  readonly preserveNewerData: true;
}

export interface MigrationPlanV1 {
  readonly schemaVersion: typeof PACTILE_CONTRACT_SCHEMA_VERSION;
  readonly id: string;
  readonly source: MigrationSourceV1;
  readonly target: MigrationTargetV1;
  readonly actions: readonly MigrationActionV1[];
  readonly canonicalCommitPointActionId: string;
  readonly preservation: MigrationPreservationV1;
  readonly recovery: MigrationRecoveryV1;
  readonly projectionPlanIds: readonly string[];
}

export const MIGRATION_JOURNAL_STATES_V1 = [
  "planned",
  "backed-up",
  "staged",
  "validated",
  "committed",
  "reconciling",
  "completed",
  "degraded",
  "recovering",
  "rolled-back",
  "failed",
] as const;
export type MigrationJournalStateV1 =
  (typeof MIGRATION_JOURNAL_STATES_V1)[number];

export const CANONICAL_COMMIT_STATES_V1 = ["pending", "committed"] as const;
export type CanonicalCommitStateV1 =
  (typeof CANONICAL_COMMIT_STATES_V1)[number];

export interface CanonicalCommitV1 {
  readonly status: CanonicalCommitStateV1;
  readonly actionId: string;
  readonly generationId: string | null;
  readonly committedAt: string | null;
}

export const MIGRATION_RECOVERY_STATES_V1 = [
  "not-required",
  "available",
  "in-progress",
  "completed",
  "failed",
] as const;
export type MigrationRecoveryStateV1 =
  (typeof MIGRATION_RECOVERY_STATES_V1)[number];

export interface MigrationRecoveryStateRecordV1 {
  readonly status: MigrationRecoveryStateV1;
  readonly backupRef: string;
  readonly updatedAt: string;
  readonly error: string | null;
}

export const ADAPTER_RECONCILE_STATES_V1 = [
  "pending",
  "in-progress",
  "succeeded",
  "failed",
] as const;
export type AdapterReconcileStateV1 =
  (typeof ADAPTER_RECONCILE_STATES_V1)[number];

export interface AdapterReconcileJournalV1 {
  readonly adapterId: string;
  readonly projectionPlanId: string;
  readonly status: AdapterReconcileStateV1;
  readonly attempts: number;
  readonly lastAttemptAt: string | null;
  readonly lastError: string | null;
}

export const MIGRATION_JOURNAL_EVENTS_V1 = [
  "planned",
  "backup-completed",
  "stage-completed",
  "validation-completed",
  "canonical-committed",
  "adapter-reconcile-started",
  "adapter-reconcile-succeeded",
  "adapter-reconcile-failed",
  "doctor-completed",
  "recovery-started",
  "recovery-completed",
  "failed",
] as const;
export type MigrationJournalEventKindV1 =
  (typeof MIGRATION_JOURNAL_EVENTS_V1)[number];

export interface MigrationJournalEventV1 {
  readonly sequence: number;
  readonly at: string;
  readonly event: MigrationJournalEventKindV1;
  readonly actionId: string | null;
  readonly adapterId: string | null;
  readonly evidenceRefs: readonly string[];
}

export interface MigrationJournalV1 {
  readonly schemaVersion: typeof PACTILE_CONTRACT_SCHEMA_VERSION;
  readonly id: string;
  readonly planId: string;
  readonly planFingerprint: string;
  readonly state: MigrationJournalStateV1;
  readonly canonicalCommit: CanonicalCommitV1;
  readonly recovery: MigrationRecoveryStateRecordV1;
  readonly adapterReconciliations: readonly AdapterReconcileJournalV1[];
  readonly events: readonly MigrationJournalEventV1[];
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

function decodeNullableSemverV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): string | null {
  if (value === null) return null;
  return decodeSemverV1(value, decoder, path);
}

function decodeNullableIntegerV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): number | null {
  if (value === null) return null;
  return decoder.integer(value, path, { min: 0 });
}

function decodeMigrationSourceV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): MigrationSourceV1 {
  const record = decoder.object(value, path, [
    "kind",
    "root",
    "access",
    "runtimeVersion",
    "schemaVersion",
  ]);
  const kind = decoder.enumValue(
    decoder.required(record, "kind", path),
    MIGRATION_SOURCE_KINDS_V1,
    childPathV1(path, "kind"),
  );
  const rootValue = decoder.required(record, "root", path);
  const root =
    rootValue === null
      ? null
      : decoder.enumValue(
          rootValue,
          [PACTILE_CANONICAL_ROOT_V1, ...PACTILE_LEGACY_ROOTS_V1] as const,
          childPathV1(path, "root"),
        );
  const access = decoder.enumValue(
    decoder.required(record, "access", path),
    ["none", "read-only", "read-write"] as const,
    childPathV1(path, "access"),
  );
  const runtimeVersion = decodeNullableSemverV1(
    decoder.required(record, "runtimeVersion", path),
    decoder,
    childPathV1(path, "runtimeVersion"),
  );
  const schemaVersion = decodeNullableIntegerV1(
    decoder.required(record, "schemaVersion", path),
    decoder,
    childPathV1(path, "schemaVersion"),
  );
  if (
    kind === "fresh" &&
    (root !== null ||
      access !== "none" ||
      runtimeVersion !== null ||
      schemaVersion !== null)
  ) {
    decoder.issue(
      "conflict",
      path,
      "fresh source must have null root/version/schema and access 'none'",
    );
  }
  if (
    kind === "canonical" &&
    (root !== PACTILE_CANONICAL_ROOT_V1 || access !== "read-write")
  ) {
    decoder.issue(
      "conflict",
      path,
      "canonical source must use '.pactile' with read-write access",
    );
  }
  if (
    kind === "legacy" &&
    (root === null ||
      !PACTILE_LEGACY_ROOTS_V1.includes(root as PactileLegacyRootV1) ||
      access !== "read-only")
  ) {
    decoder.issue(
      "policy-violation",
      path,
      "legacy source must use '.cstl' or '.trellis' with read-only access",
    );
  }
  return { kind, root, access, runtimeVersion, schemaVersion };
}

function decodeMigrationTargetV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): MigrationTargetV1 {
  const record = decoder.object(value, path, [
    "root",
    "runtimeVersion",
    "schemaVersion",
    "generationId",
  ]);
  return {
    root: decoder.literal(
      decoder.required(record, "root", path),
      PACTILE_CANONICAL_ROOT_V1,
      childPathV1(path, "root"),
    ),
    runtimeVersion: decodeSemverV1(
      decoder.required(record, "runtimeVersion", path),
      decoder,
      childPathV1(path, "runtimeVersion"),
    ),
    schemaVersion: decoder.literal(
      decoder.required(record, "schemaVersion", path),
      PACTILE_CONTRACT_SCHEMA_VERSION,
      childPathV1(path, "schemaVersion"),
    ),
    generationId: decodeLogicalIdV1(
      decoder.required(record, "generationId", path),
      decoder,
      childPathV1(path, "generationId"),
    ),
  };
}

function decodeMigrationActionV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): MigrationActionV1 {
  const record = decoder.object(value, path, [
    "id",
    "phase",
    "kind",
    "domain",
    "sourceRef",
    "targetRef",
    "adapterId",
    "reversible",
  ]);
  const phase = decoder.enumValue(
    decoder.required(record, "phase", path),
    MIGRATION_PHASES_V1,
    childPathV1(path, "phase"),
  );
  const kind = decoder.enumValue(
    decoder.required(record, "kind", path),
    MIGRATION_ACTION_KINDS_V1,
    childPathV1(path, "kind"),
  );
  const domain = decoder.enumValue(
    decoder.required(record, "domain", path),
    MIGRATION_ACTION_DOMAINS_V1,
    childPathV1(path, "domain"),
  );
  const adapterId = decodeNullableLogicalIdV1(
    decoder.required(record, "adapterId", path),
    decoder,
    childPathV1(path, "adapterId"),
  );
  if (domain === "canonical" && adapterId !== null) {
    decoder.issue(
      "conflict",
      childPathV1(path, "adapterId"),
      "canonical actions cannot target an Adapter",
    );
  }
  if (kind === "reconcile-projection") {
    if (
      domain !== "projection" ||
      phase !== "reconcile" ||
      adapterId === null
    ) {
      decoder.issue(
        "conflict",
        path,
        "reconcile-projection must be an Adapter-specific projection action in reconcile phase",
      );
    }
  } else if (domain === "projection" && phase !== "doctor") {
    decoder.issue(
      "conflict",
      path,
      "projection domain is reserved for reconcile-projection and Adapter doctor actions",
    );
  }
  if (phase === "reconcile" && kind !== "reconcile-projection") {
    decoder.issue(
      "conflict",
      path,
      "reconcile phase is reserved for Adapter reconcile-projection actions",
    );
  }
  if (phase === "commit" && kind !== "activate-generation") {
    decoder.issue(
      "conflict",
      path,
      "commit phase is reserved for canonical generation activation",
    );
  }
  if (domain === "projection" && phase === "doctor" && adapterId === null) {
    decoder.issue(
      "required",
      childPathV1(path, "adapterId"),
      "Adapter projection doctor actions require adapterId",
    );
  }
  if (domain === "projection" && phase === "doctor" && kind !== "doctor") {
    decoder.issue(
      "conflict",
      path,
      "projection doctor actions must use kind 'doctor'",
    );
  }
  if (
    kind === "activate-generation" &&
    (phase !== "commit" || domain !== "canonical")
  ) {
    decoder.issue(
      "conflict",
      path,
      "activate-generation must be the canonical commit phase action",
    );
  }
  return {
    id: decodeLogicalIdV1(
      decoder.required(record, "id", path),
      decoder,
      childPathV1(path, "id"),
    ),
    phase,
    kind,
    domain,
    sourceRef: decodeNullableNonEmptyStringV1(
      decoder.required(record, "sourceRef", path),
      decoder,
      childPathV1(path, "sourceRef"),
    ),
    targetRef: decodeNullableNonEmptyStringV1(
      decoder.required(record, "targetRef", path),
      decoder,
      childPathV1(path, "targetRef"),
    ),
    adapterId,
    reversible: decoder.boolean(
      decoder.required(record, "reversible", path),
      childPathV1(path, "reversible"),
    ),
  };
}

function decodeMigrationPreservationV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): MigrationPreservationV1 {
  const record = decoder.object(value, path, [
    "bytePreservedRefs",
    "transformedRefs",
  ]);
  const bytePreservedRefs = decoder.stringArray(
    decoder.required(record, "bytePreservedRefs", path),
    childPathV1(path, "bytePreservedRefs"),
    { nonEmptyItems: true, unique: true },
  );
  const transformedRefs = decoder.stringArray(
    decoder.required(record, "transformedRefs", path),
    childPathV1(path, "transformedRefs"),
    { nonEmptyItems: true, unique: true },
  );
  for (const ref of transformedRefs) {
    if (bytePreservedRefs.includes(ref)) {
      decoder.issue(
        "conflict",
        childPathV1(path, "transformedRefs"),
        `artifact '${ref}' cannot be both byte-preserved and transformed`,
      );
    }
  }
  return { bytePreservedRefs, transformedRefs };
}

function decodeMigrationRecoveryV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): MigrationRecoveryV1 {
  const record = decoder.object(value, path, [
    "backupRef",
    "preserveNewerData",
  ]);
  return {
    backupRef: decoder.string(
      decoder.required(record, "backupRef", path),
      childPathV1(path, "backupRef"),
      { nonEmpty: true },
    ),
    preserveNewerData: decoder.literal(
      decoder.required(record, "preserveNewerData", path),
      true,
      childPathV1(path, "preserveNewerData"),
    ),
  };
}

function decodeMigrationPlanV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): MigrationPlanV1 {
  const record = decoder.object(value, path, [
    "schemaVersion",
    "id",
    "source",
    "target",
    "actions",
    "canonicalCommitPointActionId",
    "preservation",
    "recovery",
    "projectionPlanIds",
  ]);
  const actions = decoder.array(
    decoder.required(record, "actions", path),
    childPathV1(path, "actions"),
    (item, itemPath) => decodeMigrationActionV1(item, decoder, itemPath),
  );
  decoder.unique(
    actions,
    (action) => action.id,
    childPathV1(path, "actions"),
    "action id",
  );
  let previousPhaseRank = -1;
  actions.forEach((action, index) => {
    const phaseRank = MIGRATION_PHASES_V1.indexOf(action.phase);
    if (phaseRank < previousPhaseRank) {
      decoder.issue(
        "conflict",
        `${childPathV1(path, "actions")}[${index}].phase`,
        "migration phases must follow detect, backup, stage, validate, commit, reconcile, doctor order",
      );
    }
    previousPhaseRank = Math.max(previousPhaseRank, phaseRank);
  });
  for (const requiredPhase of [
    "detect",
    "backup",
    "stage",
    "validate",
    "commit",
    "doctor",
  ] as const) {
    if (!actions.some((action) => action.phase === requiredPhase)) {
      decoder.issue(
        "required",
        childPathV1(path, "actions"),
        `migration plan must include the '${requiredPhase}' phase`,
      );
    }
  }
  const commitPoint = decodeLogicalIdV1(
    decoder.required(record, "canonicalCommitPointActionId", path),
    decoder,
    childPathV1(path, "canonicalCommitPointActionId"),
  );
  const commitAction = actions.find((action) => action.id === commitPoint);
  if (!commitAction) {
    decoder.issue(
      "required",
      childPathV1(path, "canonicalCommitPointActionId"),
      "must reference an action in this plan",
    );
  } else if (
    commitAction.phase !== "commit" ||
    commitAction.kind !== "activate-generation" ||
    commitAction.domain !== "canonical"
  ) {
    decoder.issue(
      "conflict",
      childPathV1(path, "canonicalCommitPointActionId"),
      "must reference the canonical activate-generation commit action",
    );
  } else if (!commitAction.reversible) {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "canonicalCommitPointActionId"),
      "canonical activation must retain a recovery path",
    );
  }
  const commitIndex = actions.findIndex((action) => action.id === commitPoint);
  actions.forEach((action, index) => {
    if (action.phase === "reconcile" && index < commitIndex) {
      decoder.issue(
        "conflict",
        `${childPathV1(path, "actions")}[${index}].phase`,
        "projection reconcile cannot precede the canonical commit point",
      );
    }
  });
  const projectionPlanIds = decoder.stringArray(
    decoder.required(record, "projectionPlanIds", path),
    childPathV1(path, "projectionPlanIds"),
    {
      nonEmptyItems: true,
      unique: true,
      pattern: /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/,
      patternDescription: "a lowercase logical projection plan id",
    },
  );
  if (
    projectionPlanIds.length > 0 &&
    !actions.some((action) => action.kind === "reconcile-projection")
  ) {
    decoder.issue(
      "required",
      childPathV1(path, "actions"),
      "projection plans require at least one post-commit reconcile action",
    );
  }
  for (const projectionPlanId of projectionPlanIds) {
    const expectedRef = `projection://${projectionPlanId}`;
    if (
      !actions.some(
        (action) =>
          action.kind === "reconcile-projection" &&
          action.sourceRef === expectedRef,
      )
    ) {
      decoder.issue(
        "required",
        childPathV1(path, "actions"),
        `projection plan '${projectionPlanId}' requires reconcile sourceRef '${expectedRef}'`,
      );
    }
  }
  return {
    schemaVersion: decodeSchemaVersionV1(record, decoder, path),
    id: decodeLogicalIdV1(
      decoder.required(record, "id", path),
      decoder,
      childPathV1(path, "id"),
    ),
    source: decodeMigrationSourceV1(
      decoder.required(record, "source", path),
      decoder,
      childPathV1(path, "source"),
    ),
    target: decodeMigrationTargetV1(
      decoder.required(record, "target", path),
      decoder,
      childPathV1(path, "target"),
    ),
    actions,
    canonicalCommitPointActionId: commitPoint,
    preservation: decodeMigrationPreservationV1(
      decoder.required(record, "preservation", path),
      decoder,
      childPathV1(path, "preservation"),
    ),
    recovery: decodeMigrationRecoveryV1(
      decoder.required(record, "recovery", path),
      decoder,
      childPathV1(path, "recovery"),
    ),
    projectionPlanIds,
  };
}

function decodeCanonicalCommitV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): CanonicalCommitV1 {
  const record = decoder.object(value, path, [
    "status",
    "actionId",
    "generationId",
    "committedAt",
  ]);
  const status = decoder.enumValue(
    decoder.required(record, "status", path),
    CANONICAL_COMMIT_STATES_V1,
    childPathV1(path, "status"),
  );
  const generationId = decodeNullableLogicalIdV1(
    decoder.required(record, "generationId", path),
    decoder,
    childPathV1(path, "generationId"),
  );
  const committedAt = decodeNullableTimestampV1(
    decoder.required(record, "committedAt", path),
    decoder,
    childPathV1(path, "committedAt"),
  );
  if (status === "pending" && (generationId !== null || committedAt !== null)) {
    decoder.issue(
      "conflict",
      path,
      "pending canonical commit cannot claim a generation or commit timestamp",
    );
  }
  if (
    status === "committed" &&
    (generationId === null || committedAt === null)
  ) {
    decoder.issue(
      "required",
      path,
      "committed canonical state requires generationId and committedAt",
    );
  }
  return {
    status,
    actionId: decodeLogicalIdV1(
      decoder.required(record, "actionId", path),
      decoder,
      childPathV1(path, "actionId"),
    ),
    generationId,
    committedAt,
  };
}

function decodeMigrationRecoveryStateV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): MigrationRecoveryStateRecordV1 {
  const record = decoder.object(value, path, [
    "status",
    "backupRef",
    "updatedAt",
    "error",
  ]);
  const status = decoder.enumValue(
    decoder.required(record, "status", path),
    MIGRATION_RECOVERY_STATES_V1,
    childPathV1(path, "status"),
  );
  const error = decodeNullableNonEmptyStringV1(
    decoder.required(record, "error", path),
    decoder,
    childPathV1(path, "error"),
  );
  if (status === "failed" && error === null) {
    decoder.issue(
      "required",
      childPathV1(path, "error"),
      "is required after recovery failure",
    );
  }
  if (status !== "failed" && error !== null) {
    decoder.issue(
      "conflict",
      childPathV1(path, "error"),
      "is only valid after recovery failure",
    );
  }
  return {
    status,
    backupRef: decoder.string(
      decoder.required(record, "backupRef", path),
      childPathV1(path, "backupRef"),
      { nonEmpty: true },
    ),
    updatedAt: decodeTimestampV1(
      decoder.required(record, "updatedAt", path),
      decoder,
      childPathV1(path, "updatedAt"),
    ),
    error,
  };
}

function decodeAdapterReconcileJournalV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): AdapterReconcileJournalV1 {
  const record = decoder.object(value, path, [
    "adapterId",
    "projectionPlanId",
    "status",
    "attempts",
    "lastAttemptAt",
    "lastError",
  ]);
  const status = decoder.enumValue(
    decoder.required(record, "status", path),
    ADAPTER_RECONCILE_STATES_V1,
    childPathV1(path, "status"),
  );
  const attempts = decoder.integer(
    decoder.required(record, "attempts", path),
    childPathV1(path, "attempts"),
    { min: 0 },
  );
  const lastAttemptAt = decodeNullableTimestampV1(
    decoder.required(record, "lastAttemptAt", path),
    decoder,
    childPathV1(path, "lastAttemptAt"),
  );
  const lastError = decodeNullableNonEmptyStringV1(
    decoder.required(record, "lastError", path),
    decoder,
    childPathV1(path, "lastError"),
  );
  if (
    status === "pending" &&
    (attempts !== 0 || lastAttemptAt !== null || lastError !== null)
  ) {
    decoder.issue(
      "conflict",
      path,
      "pending reconcile must have zero attempts and no last attempt/error",
    );
  }
  if (status !== "pending" && (attempts < 1 || lastAttemptAt === null)) {
    decoder.issue(
      "required",
      path,
      "attempted reconcile requires attempts >= 1 and lastAttemptAt",
    );
  }
  if (status === "failed" && lastError === null) {
    decoder.issue(
      "required",
      childPathV1(path, "lastError"),
      "is required after reconcile failure",
    );
  }
  if (status !== "failed" && lastError !== null) {
    decoder.issue(
      "conflict",
      childPathV1(path, "lastError"),
      "is only valid after reconcile failure",
    );
  }
  return {
    adapterId: decodeLogicalIdV1(
      decoder.required(record, "adapterId", path),
      decoder,
      childPathV1(path, "adapterId"),
    ),
    projectionPlanId: decodeLogicalIdV1(
      decoder.required(record, "projectionPlanId", path),
      decoder,
      childPathV1(path, "projectionPlanId"),
    ),
    status,
    attempts,
    lastAttemptAt,
    lastError,
  };
}

function decodeMigrationJournalEventV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): MigrationJournalEventV1 {
  const record = decoder.object(value, path, [
    "sequence",
    "at",
    "event",
    "actionId",
    "adapterId",
    "evidenceRefs",
  ]);
  const event = decoder.enumValue(
    decoder.required(record, "event", path),
    MIGRATION_JOURNAL_EVENTS_V1,
    childPathV1(path, "event"),
  );
  const adapterId = decodeNullableLogicalIdV1(
    decoder.required(record, "adapterId", path),
    decoder,
    childPathV1(path, "adapterId"),
  );
  const actionId = decodeNullableLogicalIdV1(
    decoder.required(record, "actionId", path),
    decoder,
    childPathV1(path, "actionId"),
  );
  if (event.startsWith("adapter-reconcile-") && adapterId === null) {
    decoder.issue(
      "required",
      childPathV1(path, "adapterId"),
      "is required for Adapter reconcile events",
    );
  }
  if (event.startsWith("adapter-reconcile-") && actionId === null) {
    decoder.issue(
      "required",
      childPathV1(path, "actionId"),
      "is required to pair an Adapter reconcile attempt",
    );
  }
  if (!event.startsWith("adapter-reconcile-") && adapterId !== null) {
    decoder.issue(
      "conflict",
      childPathV1(path, "adapterId"),
      "is only valid for Adapter reconcile events",
    );
  }
  return {
    sequence: decoder.integer(
      decoder.required(record, "sequence", path),
      childPathV1(path, "sequence"),
      { min: 1 },
    ),
    at: decodeTimestampV1(
      decoder.required(record, "at", path),
      decoder,
      childPathV1(path, "at"),
    ),
    event,
    actionId,
    adapterId,
    evidenceRefs: decoder.stringArray(
      decoder.required(record, "evidenceRefs", path),
      childPathV1(path, "evidenceRefs"),
      { nonEmptyItems: true, unique: true },
    ),
  };
}

function decodeMigrationJournalV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): MigrationJournalV1 {
  const record = decoder.object(value, path, [
    "schemaVersion",
    "id",
    "planId",
    "planFingerprint",
    "state",
    "canonicalCommit",
    "recovery",
    "adapterReconciliations",
    "events",
  ]);
  const state = decoder.enumValue(
    decoder.required(record, "state", path),
    MIGRATION_JOURNAL_STATES_V1,
    childPathV1(path, "state"),
  );
  const canonicalCommit = decodeCanonicalCommitV1(
    decoder.required(record, "canonicalCommit", path),
    decoder,
    childPathV1(path, "canonicalCommit"),
  );
  const adapterReconciliations = decoder.array(
    decoder.required(record, "adapterReconciliations", path),
    childPathV1(path, "adapterReconciliations"),
    (item, itemPath) =>
      decodeAdapterReconcileJournalV1(item, decoder, itemPath),
  );
  decoder.unique(
    adapterReconciliations,
    (entry) => entry.adapterId,
    childPathV1(path, "adapterReconciliations"),
    "adapter id",
  );
  const events = decoder.array(
    decoder.required(record, "events", path),
    childPathV1(path, "events"),
    (item, itemPath) => decodeMigrationJournalEventV1(item, decoder, itemPath),
  );
  if (events[0]?.event !== "planned") {
    decoder.issue(
      "required",
      childPathV1(path, "events"),
      "append-only migration journals must begin with a planned event",
    );
  }
  events.forEach((event, index) => {
    if (event.sequence !== index + 1) {
      decoder.issue(
        "conflict",
        `${childPathV1(path, "events")}[${index}].sequence`,
        `must be contiguous and equal ${index + 1}`,
      );
    }
  });
  const forwardEventRank: Partial<Record<MigrationJournalEventKindV1, number>> =
    {
      planned: 0,
      "backup-completed": 1,
      "stage-completed": 2,
      "validation-completed": 3,
      "canonical-committed": 4,
      "adapter-reconcile-started": 5,
      "adapter-reconcile-succeeded": 5,
      "adapter-reconcile-failed": 5,
      "doctor-completed": 6,
    };
  let previousEventRank = -1;
  events.forEach((event, index) => {
    const eventRank = forwardEventRank[event.event];
    if (eventRank === undefined) return;
    // A committed generation may be reconciled and doctored more than once.
    // The immutable pre-commit prefix still stays strictly forward-only, but
    // Adapter/doctor cycles after the commit point are append-only retries,
    // not a second canonical migration.
    if (previousEventRank >= 4 && eventRank >= 5) {
      previousEventRank = Math.max(previousEventRank, eventRank);
      return;
    }
    if (eventRank < previousEventRank) {
      decoder.issue(
        "conflict",
        `${childPathV1(path, "events")}[${index}].event`,
        "forward migration events must follow backup, stage, validation, commit, reconcile, doctor order",
      );
    }
    previousEventRank = Math.max(previousEventRank, eventRank);
  });
  const commitEventIndex = events.findIndex(
    (event) => event.event === "canonical-committed",
  );
  const commitEvents = events.filter(
    (event) => event.event === "canonical-committed",
  );
  if (commitEvents.length > 1) {
    decoder.issue(
      "duplicate",
      childPathV1(path, "events"),
      "canonical commit may be recorded only once",
    );
  }
  if (canonicalCommit.status === "committed" && commitEventIndex < 0) {
    decoder.issue(
      "required",
      childPathV1(path, "events"),
      "committed canonical state requires a canonical-committed journal event",
    );
  }
  if (
    canonicalCommit.status === "committed" &&
    commitEvents[0]?.actionId !== canonicalCommit.actionId
  ) {
    decoder.issue(
      "conflict",
      `${childPathV1(path, "canonicalCommit")}.actionId`,
      "must match the canonical-committed journal event",
    );
  }
  if (canonicalCommit.status === "pending" && commitEventIndex >= 0) {
    decoder.issue(
      "conflict",
      `${childPathV1(path, "canonicalCommit")}.status`,
      "cannot be pending after a canonical-committed event",
    );
  }
  events.forEach((event, index) => {
    if (
      event.event.startsWith("adapter-reconcile-") &&
      (commitEventIndex < 0 || index < commitEventIndex)
    ) {
      decoder.issue(
        "policy-violation",
        `${childPathV1(path, "events")}[${index}]`,
        "Adapter reconcile cannot run before the canonical commit point",
      );
    }
  });
  if (canonicalCommit.status === "committed") {
    for (const requiredEvent of [
      "backup-completed",
      "stage-completed",
      "validation-completed",
      "canonical-committed",
    ] as const) {
      if (!events.some((event) => event.event === requiredEvent)) {
        decoder.issue(
          "required",
          childPathV1(path, "events"),
          `committed migration journal must retain '${requiredEvent}'`,
        );
      }
    }
  }
  if (
    canonicalCommit.status === "pending" &&
    adapterReconciliations.some((entry) => entry.status !== "pending")
  ) {
    decoder.issue(
      "policy-violation",
      childPathV1(path, "adapterReconciliations"),
      "Adapter reconcile cannot complete before the canonical commit point",
    );
  }
  for (const reconciliation of adapterReconciliations) {
    const adapterEvents = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.adapterId === reconciliation.adapterId);
    let attemptOpen = false;
    let startedAttempts = 0;
    let activeActionId: string | null = null;
    for (const { event, index } of adapterEvents) {
      if (event.event === "adapter-reconcile-started") {
        if (attemptOpen) {
          decoder.issue(
            "conflict",
            `${childPathV1(path, "events")}[${index}].event`,
            `Adapter '${reconciliation.adapterId}' cannot start a new attempt before the prior attempt terminates`,
          );
        }
        startedAttempts += 1;
        attemptOpen = true;
        activeActionId = event.actionId;
        continue;
      }
      if (!attemptOpen) {
        decoder.issue(
          "conflict",
          `${childPathV1(path, "events")}[${index}].event`,
          `Adapter '${reconciliation.adapterId}' terminal reconcile event requires a preceding unmatched started event`,
        );
      } else if (event.actionId !== activeActionId) {
        decoder.issue(
          "conflict",
          `${childPathV1(path, "events")}[${index}].actionId`,
          `Adapter '${reconciliation.adapterId}' terminal event must match its started action`,
        );
      }
      attemptOpen = false;
      activeActionId = null;
    }
    const lastAdapterEvent = adapterEvents[adapterEvents.length - 1]?.event;
    if (reconciliation.attempts !== startedAttempts) {
      decoder.issue(
        "conflict",
        childPathV1(path, "adapterReconciliations"),
        `Adapter '${reconciliation.adapterId}' attempts must match its persisted retry history (the started-event count)`,
      );
    }
    if (reconciliation.status === "pending") {
      if (adapterEvents.length > 0) {
        decoder.issue(
          "conflict",
          childPathV1(path, "adapterReconciliations"),
          `Pending Adapter '${reconciliation.adapterId}' cannot have reconcile events`,
        );
      }
      continue;
    }
    const expectedEvent =
      reconciliation.status === "in-progress"
        ? "adapter-reconcile-started"
        : reconciliation.status === "succeeded"
          ? "adapter-reconcile-succeeded"
          : "adapter-reconcile-failed";
    if (lastAdapterEvent?.event !== expectedEvent) {
      decoder.issue(
        "conflict",
        childPathV1(path, "adapterReconciliations"),
        `Adapter '${reconciliation.adapterId}' status must match its latest journal event`,
      );
    }
    if (lastAdapterEvent?.at !== reconciliation.lastAttemptAt) {
      decoder.issue(
        "conflict",
        childPathV1(path, "adapterReconciliations"),
        `Adapter '${reconciliation.adapterId}' lastAttemptAt must match its latest journal event`,
      );
    }
    if (reconciliation.status === "in-progress" && !attemptOpen) {
      decoder.issue(
        "conflict",
        childPathV1(path, "adapterReconciliations"),
        `In-progress Adapter '${reconciliation.adapterId}' requires one unmatched started event`,
      );
    }
    if (reconciliation.status !== "in-progress" && attemptOpen) {
      decoder.issue(
        "conflict",
        childPathV1(path, "adapterReconciliations"),
        `Terminal Adapter '${reconciliation.adapterId}' cannot retain an unmatched started event`,
      );
    }
  }
  const adapterIds = new Set(
    adapterReconciliations.map((reconciliation) => reconciliation.adapterId),
  );
  events.forEach((event, index) => {
    if (event.adapterId !== null && !adapterIds.has(event.adapterId)) {
      decoder.issue(
        "conflict",
        `${childPathV1(path, "events")}[${index}].adapterId`,
        `Adapter '${event.adapterId}' has no reconcile journal record`,
      );
    }
  });
  if (
    state === "completed" &&
    adapterReconciliations.some((entry) => entry.status !== "succeeded")
  ) {
    decoder.issue(
      "conflict",
      childPathV1(path, "state"),
      "completed migration requires every Adapter reconcile to succeed",
    );
  }
  if (
    state === "degraded" &&
    !adapterReconciliations.some((entry) => entry.status === "failed")
  ) {
    decoder.issue(
      "conflict",
      childPathV1(path, "state"),
      "degraded migration must identify at least one failed Adapter reconcile",
    );
  }
  if (
    state !== "degraded" &&
    state !== "reconciling" &&
    adapterReconciliations.some((entry) => entry.status === "failed")
  ) {
    decoder.issue(
      "conflict",
      childPathV1(path, "state"),
      "a failed Adapter requires degraded state unless another retry is in progress",
    );
  }
  if (
    state === "reconciling" &&
    !adapterReconciliations.some((entry) => entry.status === "in-progress")
  ) {
    decoder.issue(
      "conflict",
      childPathV1(path, "state"),
      "reconciling migration must identify at least one in-progress Adapter",
    );
  }
  if (
    state !== "reconciling" &&
    adapterReconciliations.some((entry) => entry.status === "in-progress")
  ) {
    decoder.issue(
      "conflict",
      childPathV1(path, "state"),
      "an in-progress Adapter requires the migration state to be reconciling",
    );
  }
  if (
    ["committed", "reconciling", "completed", "degraded"].includes(state) &&
    canonicalCommit.status !== "committed"
  ) {
    decoder.issue(
      "conflict",
      `${childPathV1(path, "canonicalCommit")}.status`,
      `journal state '${state}' requires a committed canonical generation`,
    );
  }

  return {
    schemaVersion: decodeSchemaVersionV1(record, decoder, path),
    id: decodeLogicalIdV1(
      decoder.required(record, "id", path),
      decoder,
      childPathV1(path, "id"),
    ),
    planId: decodeLogicalIdV1(
      decoder.required(record, "planId", path),
      decoder,
      childPathV1(path, "planId"),
    ),
    planFingerprint: decodeFingerprintV1(
      decoder.required(record, "planFingerprint", path),
      decoder,
      childPathV1(path, "planFingerprint"),
    ),
    state,
    canonicalCommit,
    recovery: decodeMigrationRecoveryStateV1(
      decoder.required(record, "recovery", path),
      decoder,
      childPathV1(path, "recovery"),
    ),
    adapterReconciliations,
    events,
  };
}

export const migrationPlanV1Schema = definePactileContractSchemaV1(
  "MigrationPlanV1",
  decodeMigrationPlanV1,
);

export const migrationJournalV1Schema = definePactileContractSchemaV1(
  "MigrationJournalV1",
  decodeMigrationJournalV1,
);

export function parseMigrationPlanV1(
  input: unknown,
): PactileContractParseResultV1<MigrationPlanV1> {
  return migrationPlanV1Schema.parse(input);
}

export function parseMigrationJournalV1(
  input: unknown,
): PactileContractParseResultV1<MigrationJournalV1> {
  return migrationJournalV1Schema.parse(input);
}
