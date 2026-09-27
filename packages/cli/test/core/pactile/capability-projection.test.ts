import { describe, expect, it } from "vitest";

import {
  parseCapabilityBindingV1,
  parseExternalAssetRefV1,
  parseInstallHintV1,
  parseOwnershipLedgerV1,
  parseProjectionPlanV1,
} from "../../../src/core/pactile/index.js";

import {
  HASH_A,
  HASH_B,
  HASH_C,
  validCapabilityBinding,
  validOwnershipLedger,
  validProjectionPlan,
} from "./samples.js";

function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined)
    throw new Error(`missing test item at index ${index}`);
  return item;
}

describe("Capability adoption contracts", () => {
  it("parses native install hints and borrowed MCP adoption", () => {
    expect(
      parseInstallHintV1({
        schemaVersion: 1,
        mechanism: "host-native",
        label: "install.host-capability-manager",
        reference: "docs://host/install",
        requiresAuthentication: true,
      }).success,
    ).toBe(true);

    const parsed = parseCapabilityBindingV1(validCapabilityBinding());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.mode).toBe("adopted");
      expect(parsed.data.control).toBe("borrowed");
      expect(parsed.data.deleteBoundary).toBe("preserve");
      expect(parsed.data.asset.owner.kind).toBe("user");
    }
  });

  it("requires an install hint for missing assets", () => {
    const asset = validCapabilityBinding().asset;
    const parsed = parseExternalAssetRefV1({
      ...asset,
      readiness: "missing",
      installHint: null,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toContainEqual(
        expect.objectContaining({ path: "$.installHint", code: "required" }),
      );
    }
  });

  it("rejects ownership takeover and deletion of borrowed assets", () => {
    const invalid = {
      ...validCapabilityBinding(),
      mode: "native",
      control: "pactile-owned",
      deleteBoundary: "remove-when-unclaimed",
    };
    const parsed = parseCapabilityBindingV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "$.control",
            code: "policy-violation",
          }),
          expect.objectContaining({
            path: "$.asset.owner.kind",
            code: "conflict",
          }),
        ]),
      );
    }

    const borrowedDelete = {
      ...validCapabilityBinding(),
      deleteBoundary: "remove-when-unclaimed",
    };
    const deleted = parseCapabilityBindingV1(borrowedDelete);
    expect(deleted.success).toBe(false);
    if (!deleted.success) {
      expect(deleted.issues).toContainEqual(
        expect.objectContaining({
          path: "$.deleteBoundary",
          message: expect.stringMatching(/non-owning/),
        }),
      );
    }
  });

  it("treats MCP as a Provider reference and rejects secret-bearing extensions", () => {
    const invalid = {
      ...validCapabilityBinding(),
      providerId: null,
      asset: {
        ...validCapabilityBinding().asset,
        credential: "do-not-copy-me",
      },
    };
    const parsed = parseCapabilityBindingV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "$.providerId", code: "required" }),
          expect.objectContaining({
            path: "$.asset.credential",
            code: "unknown-field",
          }),
        ]),
      );
    }
  });

  it("rejects inline credentials and prose in capability reference fields", () => {
    const unsafeHint = parseInstallHintV1({
      schemaVersion: 1,
      mechanism: "manual",
      label: "Paste token sk-secret here",
      reference: "https://user:secret@example.invalid/install?token=secret",
      requiresAuthentication: true,
    });
    expect(unsafeHint.success).toBe(false);
    if (!unsafeHint.success) {
      expect(unsafeHint.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "$.label", code: "invalid-value" }),
          expect.objectContaining({
            path: "$.reference",
            code: "invalid-value",
          }),
        ]),
      );
    }

    const unsafeLocator = {
      ...validCapabilityBinding().asset,
      locator: "https://user:secret@example.invalid/mcp?access_token=secret",
    };
    const assetResult = parseExternalAssetRefV1(unsafeLocator);
    expect(assetResult.success).toBe(false);
    if (!assetResult.success) {
      expect(assetResult.issues).toContainEqual(
        expect.objectContaining({ path: "$.locator", code: "invalid-value" }),
      );
    }
  });

  it("rejects credential-looking logical handles at every capability reference boundary", () => {
    const unsafeHint = parseInstallHintV1({
      schemaVersion: 1,
      mechanism: "manual",
      label: "install.in-host",
      reference: "docs://user:secret",
      requiresAuthentication: true,
    });
    expect(unsafeHint.success).toBe(false);

    const unsafeLocator = {
      ...validCapabilityBinding().asset,
      locator: "user-installed://token:secret123",
    };
    expect(parseExternalAssetRefV1(unsafeLocator).success).toBe(false);

    const credentialTermLocator = {
      ...validCapabilityBinding().asset,
      locator: "user-installed://registry/token/value",
    };
    expect(parseExternalAssetRefV1(credentialTermLocator).success).toBe(false);
  });
});

describe("ProjectionPlanV1", () => {
  it("accepts Adapter-produced file plans and non-owning external binds", () => {
    const parsed = parseProjectionPlanV1(validProjectionPlan());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(
        parsed.data.operations.map((operation) => operation.action),
      ).toEqual(["ensure", "bind"]);
      expect(parseProjectionPlanV1(parsed.data)).toEqual(parsed);
    }
  });

  it("rejects an Adapter plan that writes a borrowed resource", () => {
    const invalid = validProjectionPlan();
    invalid.operations = [
      {
        ...itemAt(invalid.operations, 0),
        control: "borrowed",
      },
    ];
    const parsed = parseProjectionPlanV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toContainEqual(
        expect.objectContaining({
          path: "$.operations[0].action",
          code: "policy-violation",
        }),
      );
    }
  });

  it("rejects canonical and read-only legacy runtime targets", () => {
    for (const targetPath of [
      ".pactile/runtime/install-state.json",
      ".cstl/workflow.md",
      ".trellis/tasks/legacy.json",
      ".PACTILE/runtime/install-state.json",
      ".CSTL/workflow.md",
      ".TRELLIS/tasks/legacy.json",
    ]) {
      const invalidPlan = validProjectionPlan();
      invalidPlan.operations = [
        {
          ...itemAt(invalidPlan.operations, 0),
          targetPath,
        },
      ];
      const planResult = parseProjectionPlanV1(invalidPlan);
      expect(planResult.success).toBe(false);
      if (!planResult.success) {
        expect(planResult.issues).toContainEqual(
          expect.objectContaining({
            path: "$.operations[0].targetPath",
            code: "policy-violation",
          }),
        );
      }

      const invalidLedger = validOwnershipLedger();
      itemAt(invalidLedger.entries, 0).targetPath = targetPath;
      const ledgerResult = parseOwnershipLedgerV1(invalidLedger);
      expect(ledgerResult.success).toBe(false);
      if (!ledgerResult.success) {
        expect(ledgerResult.issues).toContainEqual(
          expect.objectContaining({
            path: "$.entries[0].targetPath",
            code: "policy-violation",
          }),
        );
      }
    }
  });

  it("accepts an explicit absent-target removal expectation", () => {
    const invalid = validProjectionPlan();
    const operation = {
      ...itemAt(invalid.operations, 0),
      action: "remove",
      contentRef: null,
      desiredFingerprint: null,
      expectedCurrentFingerprint: null,
    };
    invalid.operations = [operation];
    const parsed = parseProjectionPlanV1(invalid);
    expect(parsed.success).toBe(true);
  });

  it("rejects two resource ids writing the same physical target", () => {
    const invalid = validProjectionPlan();
    const operation = itemAt(invalid.operations, 0);
    invalid.operations.push({
      ...operation,
      id: "operation.skill.shadow",
      resourceId: "skill.retrieval.compose.shadow",
      targetPath: ".agents/skills/retrieval-compose/skill.md",
    });

    const parsed = parseProjectionPlanV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toContainEqual(
        expect.objectContaining({
          path: "$.operations[2]",
          code: "duplicate",
          message: expect.stringMatching(/physical projection target/),
        }),
      );
    }
  });
});

describe("OwnershipLedgerV1", () => {
  it("accepts multiple unique Adapter claimants on one generated resource", () => {
    const parsed = parseOwnershipLedgerV1(validOwnershipLedger());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(
        parsed.data.entries[0]?.claimants.map((claimant) => claimant.adapterId),
      ).toEqual(["cursor", "codex"]);
    }
  });

  it("rejects duplicate claimants and destructive disposition while claimed", () => {
    const invalid = validOwnershipLedger();
    const entry = itemAt(invalid.entries, 0);
    const claimant = itemAt(entry.claimants, 0);
    entry.claimants = [claimant, claimant];
    entry.disposition = "remove-generated";
    const parsed = parseOwnershipLedgerV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(["duplicate", "policy-violation"]),
      );
    }
  });

  it("rejects split resource identities for one physical target", () => {
    const invalid = validOwnershipLedger();
    const claimed = itemAt(invalid.entries, 0);
    invalid.entries.push({
      ...claimed,
      resourceId: "skill.retrieval.compose.shadow",
      claimants: [],
      disposition: "remove-generated",
    });

    const parsed = parseOwnershipLedgerV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toContainEqual(
        expect.objectContaining({
          path: "$.entries[1]",
          code: "duplicate",
          message: expect.stringMatching(/physical target/),
        }),
      );
    }
  });

  it("permits safe three-way removal or preimage restoration only when unclaimed", () => {
    const remove = validOwnershipLedger();
    itemAt(remove.entries, 0).claimants = [];
    itemAt(remove.entries, 0).disposition = "remove-generated";
    expect(parseOwnershipLedgerV1(remove).success).toBe(true);

    const restore = validOwnershipLedger();
    const entry = itemAt(restore.entries, 0);
    entry.origin = "adopted";
    entry.claimants = [];
    entry.preimage = {
      state: "present",
      fingerprint: HASH_A,
      contentRef: "backup://preimage/skill",
    };
    entry.generated = {
      state: "present",
      fingerprint: HASH_B,
      contentRef: "pactile://tiles/retrieval.compose/SKILL.md",
    };
    entry.current = { state: "present", fingerprint: HASH_B, contentRef: null };
    entry.disposition = "restore-preimage";
    expect(parseOwnershipLedgerV1(restore).success).toBe(true);

    entry.preimage = {
      state: "present",
      fingerprint: HASH_A,
      contentRef: null,
    };
    const missingPreimageContent = parseOwnershipLedgerV1(restore);
    expect(missingPreimageContent.success).toBe(false);
    if (!missingPreimageContent.success) {
      expect(missingPreimageContent.issues).toContainEqual(
        expect.objectContaining({
          path: "$.entries[0].disposition",
          code: "policy-violation",
        }),
      );
    }
  });

  it("preserves modified or unknown ownership instead of deleting it", () => {
    const modified = validOwnershipLedger();
    itemAt(modified.entries, 0).claimants = [];
    itemAt(modified.entries, 0).current = {
      state: "present",
      fingerprint: HASH_C,
      contentRef: null,
    };
    itemAt(modified.entries, 0).conflict = "modified";
    itemAt(modified.entries, 0).disposition = "remove-generated";
    expect(parseOwnershipLedgerV1(modified).success).toBe(false);
    itemAt(modified.entries, 0).disposition = "preserve-modified";
    expect(parseOwnershipLedgerV1(modified).success).toBe(true);

    const unknown = validOwnershipLedger();
    const entry = itemAt(unknown.entries, 0);
    entry.origin = "unknown";
    entry.control = "unknown";
    entry.owner = { kind: "unknown", id: null };
    entry.claimants = [];
    entry.preimage = { state: "unknown", fingerprint: null, contentRef: null };
    entry.conflict = "ownership-unknown";
    entry.disposition = "remove-generated";
    const parsed = parseOwnershipLedgerV1(unknown);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toContainEqual(
        expect.objectContaining({
          path: "$.entries[0].disposition",
          code: "policy-violation",
        }),
      );
    }
  });
});
