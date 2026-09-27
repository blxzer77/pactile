import { describe, expect, it } from "vitest";

import {
  parseCompositionTraceEventV1,
  parseMigrationJournalV1,
  parseMigrationPlanV1,
} from "../../../src/core/pactile/index.js";

import {
  HASH_A,
  validMigrationJournal,
  validMigrationPlan,
  validTraceEvent,
} from "./samples.js";

function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined)
    throw new Error(`missing test item at index ${index}`);
  return item;
}

describe("MigrationPlanV1", () => {
  it("freezes a read-only legacy source and an explicit canonical commit point", () => {
    const parsed = parseMigrationPlanV1(validMigrationPlan());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.source).toMatchObject({
        kind: "legacy",
        root: ".cstl",
        access: "read-only",
      });
      expect(parsed.data.target.root).toBe(".pactile");
      expect(parsed.data.canonicalCommitPointActionId).toBe("migration.commit");
      expect(parsed.data.recovery.preserveNewerData).toBe(true);
      expect(parseMigrationPlanV1(parsed.data)).toEqual(parsed);
    }
  });

  it("rejects writable legacy sources", () => {
    const invalid = validMigrationPlan();
    invalid.source.access = "read-write";
    const parsed = parseMigrationPlanV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toContainEqual(
        expect.objectContaining({ path: "$.source", code: "policy-violation" }),
      );
    }
  });

  it("rejects an ambiguous commit point and pre-commit Adapter reconcile", () => {
    const invalidCommit = validMigrationPlan();
    invalidCommit.canonicalCommitPointActionId = "migration.validate";
    const commitResult = parseMigrationPlanV1(invalidCommit);
    expect(commitResult.success).toBe(false);
    if (!commitResult.success) {
      expect(commitResult.issues).toContainEqual(
        expect.objectContaining({
          path: "$.canonicalCommitPointActionId",
          code: "conflict",
        }),
      );
    }

    const earlyReconcile = validMigrationPlan();
    const reconcileIndex = earlyReconcile.actions.findIndex(
      (action) => action.kind === "reconcile-projection",
    );
    const reconcile = earlyReconcile.actions.splice(reconcileIndex, 1)[0];
    if (reconcile === undefined)
      throw new Error("missing reconcile action fixture");
    earlyReconcile.actions.splice(2, 0, reconcile);
    const reconcileResult = parseMigrationPlanV1(earlyReconcile);
    expect(reconcileResult.success).toBe(false);
    if (!reconcileResult.success) {
      expect(reconcileResult.issues).toContainEqual(
        expect.objectContaining({
          message: expect.stringMatching(/cannot precede/),
        }),
      );
    }
  });

  it("keeps byte-preserved history disjoint from active schema transforms", () => {
    const invalid = validMigrationPlan();
    invalid.preservation.transformedRefs.push(".cstl/archive");
    const parsed = parseMigrationPlanV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toContainEqual(
        expect.objectContaining({
          path: "$.preservation.transformedRefs",
          code: "conflict",
        }),
      );
    }
  });
});

describe("MigrationJournalV1", () => {
  it("keeps canonical commit successful while one Adapter is independently degraded", () => {
    const parsed = parseMigrationJournalV1(validMigrationJournal());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.canonicalCommit.status).toBe("committed");
      expect(parsed.data.state).toBe("degraded");
      expect(parsed.data.adapterReconciliations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ adapterId: "cursor", status: "succeeded" }),
          expect.objectContaining({ adapterId: "codex", status: "failed" }),
        ]),
      );
    }
  });

  it("allows retrying only the failed Adapter record", () => {
    const retried = validMigrationJournal();
    const codex = retried.adapterReconciliations.find(
      (entry) => entry.adapterId === "codex",
    );
    if (codex === undefined) throw new Error("missing codex reconcile fixture");

    retried.state = "reconciling";
    codex.status = "in-progress";
    codex.attempts = 2;
    codex.lastAttemptAt = "2026-09-09T10:15:00Z";
    codex.lastError = null;
    retried.events.push({
      sequence: 10,
      at: "2026-09-09T10:15:00Z",
      event: "adapter-reconcile-started",
      actionId: "migration.reconcile.codex",
      adapterId: "codex",
      evidenceRefs: [],
    });
    expect(parseMigrationJournalV1(retried).success).toBe(true);
    expect(retried.canonicalCommit.status).toBe("committed");

    retried.state = "completed";
    codex.status = "succeeded";
    codex.lastAttemptAt = "2026-09-09T10:16:00Z";
    retried.events.push({
      sequence: 11,
      at: "2026-09-09T10:16:00Z",
      event: "adapter-reconcile-succeeded",
      actionId: "migration.reconcile.codex",
      adapterId: "codex",
      evidenceRefs: ["evidence://projection/codex/retry"],
    });
    expect(parseMigrationJournalV1(retried).success).toBe(true);
    expect(codex.status).toBe("succeeded");
  });

  it("allows an applied Adapter to be rechecked after a completed doctor cycle", () => {
    const journal = validMigrationJournal();
    const cursor = journal.adapterReconciliations.find(
      (entry) => entry.adapterId === "cursor",
    );
    const codex = journal.adapterReconciliations.find(
      (entry) => entry.adapterId === "codex",
    );
    if (cursor === undefined || codex === undefined)
      throw new Error("missing Adapter reconcile fixture");

    codex.status = "succeeded";
    codex.attempts = 2;
    codex.lastAttemptAt = "2026-09-09T10:16:00Z";
    codex.lastError = null;
    journal.events.push(
      {
        sequence: 10,
        at: "2026-09-09T10:15:00Z",
        event: "adapter-reconcile-started",
        actionId: "migration.reconcile.codex",
        adapterId: "codex",
        evidenceRefs: [],
      },
      {
        sequence: 11,
        at: "2026-09-09T10:16:00Z",
        event: "adapter-reconcile-succeeded",
        actionId: "migration.reconcile.codex",
        adapterId: "codex",
        evidenceRefs: ["evidence://projection/codex/retry"],
      },
      {
        sequence: 12,
        at: "2026-09-09T10:17:00Z",
        event: "doctor-completed",
        actionId: "migration.doctor",
        adapterId: null,
        evidenceRefs: ["evidence://doctor/first"],
      },
    );

    cursor.status = "succeeded";
    cursor.attempts = 2;
    cursor.lastAttemptAt = "2026-09-09T10:19:00Z";
    cursor.lastError = null;
    journal.state = "completed";
    journal.events.push(
      {
        sequence: 13,
        at: "2026-09-09T10:18:00Z",
        event: "adapter-reconcile-started",
        actionId: "migration.reconcile.cursor",
        adapterId: "cursor",
        evidenceRefs: [],
      },
      {
        sequence: 14,
        at: "2026-09-09T10:19:00Z",
        event: "adapter-reconcile-succeeded",
        actionId: "migration.reconcile.cursor",
        adapterId: "cursor",
        evidenceRefs: ["evidence://projection/cursor/recheck"],
      },
      {
        sequence: 15,
        at: "2026-09-09T10:20:00Z",
        event: "doctor-completed",
        actionId: "migration.doctor",
        adapterId: null,
        evidenceRefs: ["evidence://doctor/recheck"],
      },
    );

    expect(parseMigrationJournalV1(journal).success).toBe(true);
  });

  it("rejects retry counters that are not backed by journal events", () => {
    const invalid = validMigrationJournal();
    const codex = invalid.adapterReconciliations.find(
      (entry) => entry.adapterId === "codex",
    );
    if (codex === undefined) throw new Error("missing codex reconcile fixture");
    codex.attempts = 2;

    const parsed = parseMigrationJournalV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toContainEqual(
        expect.objectContaining({
          path: "$.adapterReconciliations",
          code: "conflict",
          message: expect.stringMatching(/persisted retry history/),
        }),
      );
    }
  });

  it("rejects terminal reconcile events without a matching started attempt", () => {
    const invalid = validMigrationJournal();
    const codex = invalid.adapterReconciliations.find(
      (entry) => entry.adapterId === "codex",
    );
    if (codex === undefined) throw new Error("missing codex reconcile fixture");

    invalid.state = "completed";
    codex.status = "succeeded";
    codex.lastAttemptAt = "2026-09-09T10:13:00Z";
    codex.lastError = null;
    invalid.events.push({
      sequence: 10,
      at: "2026-09-09T10:13:00Z",
      event: "adapter-reconcile-succeeded",
      actionId: "migration.reconcile.codex",
      adapterId: "codex",
      evidenceRefs: ["evidence://projection/codex/forged-retry"],
    });

    const parsed = parseMigrationJournalV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toContainEqual(
        expect.objectContaining({
          path: "$.events[9].event",
          code: "conflict",
          message: expect.stringMatching(/preceding unmatched started/),
        }),
      );
    }
  });

  it("rejects reconcile state or events before canonical commit", () => {
    const invalid = validMigrationJournal();
    invalid.state = "planned";
    invalid.canonicalCommit = {
      status: "pending",
      actionId: "migration.commit",
      generationId: null,
      committedAt: null,
    };
    invalid.events = [itemAt(invalid.events, 0), itemAt(invalid.events, 2)];
    const parsed = parseMigrationJournalV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "policy-violation" }),
          expect.objectContaining({ code: "conflict" }),
        ]),
      );
    }
  });

  it("rejects duplicate Adapter journal records and non-contiguous events", () => {
    const invalid = validMigrationJournal();
    invalid.adapterReconciliations.push({
      ...itemAt(invalid.adapterReconciliations, 0),
    });
    itemAt(invalid.events, 2).sequence = 8;
    const parsed = parseMigrationJournalV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(["duplicate", "conflict"]),
      );
    }
  });
});

describe("CompositionTraceEventV1", () => {
  it("parses an append-only observable Tile event", () => {
    const parsed = parseCompositionTraceEventV1(validTraceEvent());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.previousEventFingerprint).toBeNull();
      expect(parsed.data.artifactRefs).toEqual([
        "artifact://composition/order",
      ]);
      expect(parseCompositionTraceEventV1(parsed.data)).toEqual(parsed);
    }
  });

  it("links Provider resolution by fingerprint without conflating origin and assurance", () => {
    const event = {
      ...validTraceEvent(),
      eventId: "event.2",
      sequence: 2,
      previousEventFingerprint: HASH_A,
      event: "provider.resolved",
      outcome: "accepted",
      tileId: null,
      intent: "semantic",
      provider: {
        id: "host.search",
        origin: "native",
        assurance: "best-effort",
        resolutionFingerprint: HASH_A,
      },
      position: null,
    };
    expect(parseCompositionTraceEventV1(event).success).toBe(true);
  });

  it("accepts symbolic failure codes and scheme-scoped observable references", () => {
    const event = {
      ...validTraceEvent(),
      event: "tile.failed",
      outcome: "failed",
      position: null,
      durationMs: 12,
      errorCode: "PACTILE_TILE_EXECUTION_FAILED",
      artifactRefs: ["artifact://composition/failure"],
      evidenceRefs: ["evidence://tile/failure/1"],
    };
    expect(parseCompositionTraceEventV1(event).success).toBe(true);
  });

  it("rejects prompt, rationale, and chain-of-thought fields", () => {
    const invalid = {
      ...validTraceEvent(),
      prompt: "private prompt",
      rationale: "hidden reasoning",
      chainOfThought: ["private"],
    };
    const parsed = parseCompositionTraceEventV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "$.prompt", code: "unknown-field" }),
          expect.objectContaining({
            path: "$.rationale",
            code: "unknown-field",
          }),
          expect.objectContaining({
            path: "$.chainOfThought",
            code: "unknown-field",
          }),
        ]),
      );
    }
  });

  it("rejects prose errors and credential-bearing Trace references", () => {
    const invalid = {
      ...validTraceEvent(),
      event: "tile.failed",
      outcome: "failed",
      position: null,
      durationMs: 12,
      errorCode: "failed because token=sk-secret and private reasoning follows",
      artifactRefs: ["artifact://composition/order?token=sk-secret"],
      evidenceRefs: ["https://user:secret@example.invalid/private-thought"],
    };
    const parsed = parseCompositionTraceEventV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "$.errorCode",
            code: "invalid-value",
          }),
          expect.objectContaining({
            path: "$.artifactRefs[0]",
            code: "invalid-value",
          }),
          expect.objectContaining({
            path: "$.evidenceRefs[0]",
            code: "invalid-value",
          }),
        ]),
      );
    }
  });

  it("rejects credential-looking logical handles in Trace references", () => {
    const invalid = {
      ...validTraceEvent(),
      artifactRefs: ["artifact://token:sk-secret"],
      evidenceRefs: ["evidence://password:secret123"],
    };
    const parsed = parseCompositionTraceEventV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "$.artifactRefs[0]",
            code: "invalid-value",
          }),
          expect.objectContaining({
            path: "$.evidenceRefs[0]",
            code: "invalid-value",
          }),
        ]),
      );
    }
  });

  it("requires fallback target and event-chain fingerprint", () => {
    const invalid = {
      ...validTraceEvent(),
      eventId: "event.2",
      sequence: 2,
      event: "tile.fallback",
      relatedTileId: null,
      previousEventFingerprint: null,
      position: null,
    };
    const parsed = parseCompositionTraceEventV1(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "$.previousEventFingerprint",
            code: "required",
          }),
          expect.objectContaining({
            path: "$.relatedTileId",
            code: "required",
          }),
        ]),
      );
    }
  });
});
