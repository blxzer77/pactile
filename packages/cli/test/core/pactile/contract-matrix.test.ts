import { describe, expect, it } from "vitest";

import {
  DEFAULT_CANONICAL_PATHS_V1,
  type PactileContractParseResultV1,
  parseCanonicalPathsV1,
  parseCapabilityBindingV1,
  parseCompositionTraceEventV1,
  parseExternalAssetRefV1,
  parseInstallHintV1,
  parseInstallStateV1,
  parseMigrationJournalV1,
  parseMigrationPlanV1,
  parseOwnershipLedgerV1,
  parseProjectionPlanV1,
  parseProviderManifestV1,
  parseResolvedProviderV1,
  parseTileManifestV1,
} from "../../../src/core/pactile/index.js";

import {
  HASH_A,
  validCapabilityBinding,
  validMigrationJournal,
  validMigrationPlan,
  validOwnershipLedger,
  validProjectionPlan,
  validProviderManifest,
  validResolvedProvider,
  validTile,
  validTraceEvent,
} from "./samples.js";

type UnknownParser = (input: unknown) => PactileContractParseResultV1<unknown>;

function installStateSample(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    product: "pactile",
    canonicalRoot: ".pactile",
    runtimeVersion: "0.5.0",
    contractVersion: 1,
    generationId: "generation.stable",
    status: "active",
    installedAdapters: [
      {
        id: "cursor",
        version: "0.5.0",
        status: "active",
        lastProjectionFingerprint: HASH_A,
        reconciledAt: "2026-09-09T11:00:00Z",
      },
    ],
    lastMigrationJournalId: "journal.beta5",
    createdAt: "2026-09-09T10:00:00Z",
    updatedAt: "2026-09-09T11:00:00Z",
  };
}

function installHintSample(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    mechanism: "host-native",
    label: "install.in-host",
    reference: "docs://host/install",
    requiresAuthentication: false,
  };
}

const binding = validCapabilityBinding();

const contractCases: readonly [string, UnknownParser, unknown][] = [
  ["CanonicalPathsV1", parseCanonicalPathsV1, DEFAULT_CANONICAL_PATHS_V1],
  ["InstallStateV1", parseInstallStateV1, installStateSample()],
  ["TileManifestV1", parseTileManifestV1, validTile()],
  ["ProviderManifestV1", parseProviderManifestV1, validProviderManifest()],
  ["ResolvedProviderV1", parseResolvedProviderV1, validResolvedProvider()],
  ["InstallHintV1", parseInstallHintV1, installHintSample()],
  ["ExternalAssetRefV1", parseExternalAssetRefV1, binding.asset],
  ["CapabilityBindingV1", parseCapabilityBindingV1, binding],
  ["ProjectionPlanV1", parseProjectionPlanV1, validProjectionPlan()],
  ["OwnershipLedgerV1", parseOwnershipLedgerV1, validOwnershipLedger()],
  ["MigrationPlanV1", parseMigrationPlanV1, validMigrationPlan()],
  ["MigrationJournalV1", parseMigrationJournalV1, validMigrationJournal()],
  ["CompositionTraceEventV1", parseCompositionTraceEventV1, validTraceEvent()],
];

describe("Pactile v1 contract matrix", () => {
  it.each(contractCases)(
    "%s round-trips with a deterministic fingerprint",
    (_name, parse, sample) => {
      const first = parse(sample);
      expect(first.success).toBe(true);
      if (!first.success) return;
      expect(first.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

      const serialized = JSON.stringify(first.data);
      const second = parse(JSON.parse(serialized) as unknown);
      expect(second).toEqual(first);
    },
  );

  it.each(contractCases)("%s rejects unknown schema versions", (_name, parse, sample) => {
    const invalid = {
      ...(sample as Record<string, unknown>),
      schemaVersion: 2,
    };
    const result = parse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: "$.schemaVersion" }),
      );
    }
  });
});
