import type {
  CapabilityBindingV1,
  CompositionTraceEventV1,
  MigrationJournalV1,
  MigrationPlanV1,
  OwnershipLedgerV1,
  PolicyCeilingV1,
  ProjectionPlanV1,
  ProviderManifestV1,
  ResolvedProviderV1,
  TileManifestV1,
} from "../../../src/core/pactile/index.js";

export const HASH_A = `sha256:${"a".repeat(64)}`;
export const HASH_B = `sha256:${"b".repeat(64)}`;
export const HASH_C = `sha256:${"c".repeat(64)}`;

export const LOCAL_POLICY: PolicyCeilingV1 = {
  filesystem: "read",
  process: "none",
  network: "forbidden",
  credentials: "forbidden",
  privacy: "local-only",
  egressDestinations: [],
  telemetry: "local-only",
  cost: "free",
};

export function validTile(): TileManifestV1 {
  return {
    schemaVersion: 1,
    identity: { id: "retrieval.compose", version: "1.0.0" },
    summary: "Compose retrieval evidence without choosing a concrete tool.",
    trigger: {
      mode: "both",
      intents: ["exact", "semantic"],
      description: "Use when project context must be retrieved.",
    },
    inputs: ["query"],
    outputs: ["evidence.pack"],
    dependencies: ["context.progressive"],
    conflicts: [],
    permissions: {
      filesystem: "read",
      process: "none",
      credentials: "forbidden",
    },
    egress: {
      network: "forbidden",
      privacy: "local-only",
      telemetry: "local-only",
      destinations: [],
    },
    cost: { ceiling: "free" },
    fallback: {
      allowed: true,
      minimumAssurance: "evidence-backed",
      policy: {
        permissions: {
          filesystem: "read",
          process: "none",
          credentials: "forbidden",
        },
        egress: {
          network: "forbidden",
          privacy: "local-only",
          telemetry: "local-only",
          destinations: [],
        },
        cost: { ceiling: "free" },
      },
    },
    stop: {
      conditions: ["success", "blocked", "attempt-limit"],
      maxAttempts: 2,
    },
    minimumAssurance: "evidence-backed",
    evidence: [
      {
        kind: "source-reference",
        required: true,
        description: "Reference the retrieved source.",
      },
    ],
  };
}

export function validProviderManifest(): ProviderManifestV1 {
  return {
    schemaVersion: 1,
    id: "project.search",
    version: "1.2.0",
    origin: "provider",
    intents: ["exact", "semantic"],
    capabilityIds: ["project.search"],
    maximumAssurance: "verified",
    policyCeiling: LOCAL_POLICY,
    evidenceKinds: ["source-reference", "probe-result"],
    probe: { supported: true, maxAgeSeconds: 300 },
  };
}

export function validResolvedProvider(): ResolvedProviderV1 {
  return {
    schemaVersion: 1,
    intent: "semantic",
    minimumAssurance: "evidence-backed",
    origin: "provider",
    providerId: "project.search",
    providerVersion: "1.2.0",
    assurance: "verified",
    readiness: "ready",
    requestedPolicy: LOCAL_POLICY,
    effectivePolicy: LOCAL_POLICY,
    evidenceRefs: ["evidence://probe/project.search/1"],
    freshness: "fresh",
    probedAt: "2026-09-09T10:00:00Z",
    probeResult: "passed",
    fallbackFromProviderId: null,
  };
}

export function validCapabilityBinding(): CapabilityBindingV1 {
  return {
    schemaVersion: 1,
    id: "binding.project.search",
    capabilityId: "project.search",
    mode: "adopted",
    control: "borrowed",
    deleteBoundary: "preserve",
    asset: {
      schemaVersion: 1,
      id: "asset.project.search",
      kind: "mcp",
      source: "user-installed",
      scope: "user",
      owner: { kind: "user", id: null },
      locator: "user-installed://project.search",
      fingerprint: HASH_A,
      readiness: "ready",
      installHint: null,
    },
    intents: ["semantic"],
    providerId: "project.search",
  };
}

export function validProjectionPlan(): ProjectionPlanV1 {
  return {
    schemaVersion: 1,
    id: "projection.cursor",
    adapterId: "cursor",
    generationId: "generation.beta5",
    canonicalFingerprint: HASH_A,
    expectedLedgerFingerprint: null,
    operations: [
      {
        id: "operation.skill",
        resourceId: "skill.retrieval.compose",
        claimantId: "adapter.cursor",
        action: "ensure",
        control: "pactile-owned",
        targetPath: ".agents/skills/retrieval-compose/SKILL.md",
        format: "text",
        contentRef: "pactile://tiles/retrieval.compose/SKILL.md",
        desiredFingerprint: HASH_B,
        expectedCurrentFingerprint: null,
        externalAssetId: null,
      },
      {
        id: "operation.binding",
        resourceId: "binding.project.search",
        claimantId: "adapter.cursor",
        action: "bind",
        control: "borrowed",
        targetPath: null,
        format: "external-ref",
        contentRef: null,
        desiredFingerprint: null,
        expectedCurrentFingerprint: null,
        externalAssetId: "asset.project.search",
      },
    ],
  };
}

export function validOwnershipLedger(): OwnershipLedgerV1 {
  return {
    schemaVersion: 1,
    generationId: "generation.beta5",
    updatedAt: "2026-09-09T10:05:00Z",
    entries: [
      {
        resourceId: "skill.retrieval.compose",
        targetPath: ".agents/skills/retrieval-compose/SKILL.md",
        format: "text",
        origin: "created",
        control: "pactile-owned",
        owner: { kind: "pactile", id: "pactile" },
        claimants: [
          { id: "adapter.cursor", kind: "adapter", adapterId: "cursor" },
          { id: "adapter.codex", kind: "adapter", adapterId: "codex" },
        ],
        preimage: { state: "absent", fingerprint: null, contentRef: null },
        generated: {
          state: "present",
          fingerprint: HASH_B,
          contentRef: "pactile://tiles/retrieval.compose/SKILL.md",
        },
        current: { state: "present", fingerprint: HASH_B, contentRef: null },
        conflict: "none",
        disposition: "no-op",
      },
    ],
  };
}

export function validMigrationPlan(): MigrationPlanV1 {
  return {
    schemaVersion: 1,
    id: "migration.beta5",
    source: {
      kind: "legacy",
      root: ".cstl",
      access: "read-only",
      runtimeVersion: "0.5.0-beta.5",
      schemaVersion: 2,
    },
    target: {
      root: ".pactile",
      runtimeVersion: "0.5.0",
      schemaVersion: 1,
      generationId: "generation.stable",
    },
    actions: [
      {
        id: "migration.detect",
        phase: "detect",
        kind: "capture-facts",
        domain: "canonical",
        sourceRef: ".cstl",
        targetRef: null,
        adapterId: null,
        reversible: true,
      },
      {
        id: "migration.backup",
        phase: "backup",
        kind: "snapshot",
        domain: "canonical",
        sourceRef: ".cstl",
        targetRef: "backup://migration.beta5",
        adapterId: null,
        reversible: true,
      },
      {
        id: "migration.stage",
        phase: "stage",
        kind: "copy-byte-preserved",
        domain: "canonical",
        sourceRef: ".cstl/archive",
        targetRef: "stage://.pactile/archive",
        adapterId: null,
        reversible: true,
      },
      {
        id: "migration.validate",
        phase: "validate",
        kind: "validate-generation",
        domain: "canonical",
        sourceRef: "stage://generation.stable",
        targetRef: null,
        adapterId: null,
        reversible: true,
      },
      {
        id: "migration.commit",
        phase: "commit",
        kind: "activate-generation",
        domain: "canonical",
        sourceRef: "stage://generation.stable",
        targetRef: ".pactile/runtime/active.json",
        adapterId: null,
        reversible: true,
      },
      {
        id: "migration.reconcile.cursor",
        phase: "reconcile",
        kind: "reconcile-projection",
        domain: "projection",
        sourceRef: "projection://projection.cursor",
        targetRef: null,
        adapterId: "cursor",
        reversible: true,
      },
      {
        id: "migration.doctor",
        phase: "doctor",
        kind: "doctor",
        domain: "canonical",
        sourceRef: ".pactile",
        targetRef: "evidence://doctor/migration.beta5",
        adapterId: null,
        reversible: true,
      },
    ],
    canonicalCommitPointActionId: "migration.commit",
    preservation: {
      bytePreservedRefs: [".cstl/archive", ".cstl/tasks/closed/evidence.md"],
      transformedRefs: [".cstl/tasks/active/task.json"],
    },
    recovery: {
      backupRef: "backup://migration.beta5",
      preserveNewerData: true,
    },
    projectionPlanIds: ["projection.cursor"],
  };
}

export function validMigrationJournal(): MigrationJournalV1 {
  return {
    schemaVersion: 1,
    id: "journal.beta5",
    planId: "migration.beta5",
    planFingerprint: HASH_C,
    state: "degraded",
    canonicalCommit: {
      status: "committed",
      actionId: "migration.commit",
      generationId: "generation.stable",
      committedAt: "2026-09-09T10:10:00Z",
    },
    recovery: {
      status: "available",
      backupRef: "backup://migration.beta5",
      updatedAt: "2026-09-09T10:10:00Z",
      error: null,
    },
    adapterReconciliations: [
      {
        adapterId: "cursor",
        projectionPlanId: "projection.cursor",
        status: "succeeded",
        attempts: 1,
        lastAttemptAt: "2026-09-09T10:11:00Z",
        lastError: null,
      },
      {
        adapterId: "codex",
        projectionPlanId: "projection.codex",
        status: "failed",
        attempts: 1,
        lastAttemptAt: "2026-09-09T10:12:00Z",
        lastError: "host config is locked",
      },
    ],
    events: [
      {
        sequence: 1,
        at: "2026-09-09T10:00:00Z",
        event: "planned",
        actionId: null,
        adapterId: null,
        evidenceRefs: [],
      },
      {
        sequence: 2,
        at: "2026-09-09T10:03:00Z",
        event: "backup-completed",
        actionId: "migration.backup",
        adapterId: null,
        evidenceRefs: ["evidence://backup/migration.beta5"],
      },
      {
        sequence: 3,
        at: "2026-09-09T10:06:00Z",
        event: "stage-completed",
        actionId: "migration.stage",
        adapterId: null,
        evidenceRefs: ["evidence://stage/migration.beta5"],
      },
      {
        sequence: 4,
        at: "2026-09-09T10:08:00Z",
        event: "validation-completed",
        actionId: "migration.validate",
        adapterId: null,
        evidenceRefs: ["evidence://validation/migration.beta5"],
      },
      {
        sequence: 5,
        at: "2026-09-09T10:10:00Z",
        event: "canonical-committed",
        actionId: "migration.commit",
        adapterId: null,
        evidenceRefs: ["evidence://canonical/commit"],
      },
      {
        sequence: 6,
        at: "2026-09-09T10:10:30Z",
        event: "adapter-reconcile-started",
        actionId: "migration.reconcile.cursor",
        adapterId: "cursor",
        evidenceRefs: [],
      },
      {
        sequence: 7,
        at: "2026-09-09T10:11:00Z",
        event: "adapter-reconcile-succeeded",
        actionId: "migration.reconcile.cursor",
        adapterId: "cursor",
        evidenceRefs: ["evidence://projection/cursor"],
      },
      {
        sequence: 8,
        at: "2026-09-09T10:11:30Z",
        event: "adapter-reconcile-started",
        actionId: "migration.reconcile.codex",
        adapterId: "codex",
        evidenceRefs: [],
      },
      {
        sequence: 9,
        at: "2026-09-09T10:12:00Z",
        event: "adapter-reconcile-failed",
        actionId: "migration.reconcile.codex",
        adapterId: "codex",
        evidenceRefs: ["evidence://projection/codex/error"],
      },
    ],
  };
}

export function validTraceEvent(): CompositionTraceEventV1 {
  return {
    schemaVersion: 1,
    traceId: "trace.task1",
    eventId: "event.1",
    sequence: 1,
    previousEventFingerprint: null,
    at: "2026-09-09T10:20:00Z",
    event: "tile.ordered",
    outcome: "accepted",
    taskId: "task.1",
    tileId: "retrieval.compose",
    relatedTileId: null,
    intent: "semantic",
    provider: null,
    position: 0,
    durationMs: null,
    errorCode: null,
    artifactRefs: ["artifact://composition/order"],
    evidenceRefs: [],
  };
}
