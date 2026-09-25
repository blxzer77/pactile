import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyKernelTransition,
  applyKernelCreate,
  emptyTaskRecord,
  neutralKernelExtrasBoundary,
} from "../../../src/core/task/index.js";
import type { PolicyCeilingV1 } from "../../../src/core/index.js";
import {
  decideBatch2TileSelection,
  decideSelectedTaskBatch2TileSelection,
  loadBatch2TileCatalog,
  loadBatch2TileSelectionSurface,
  prepareBatch2TileSelection,
  prepareSelectedTaskBatch2TileSelection,
  replayStoredSelectedTaskBatch2TileSelectionDecision,
  replaySelectedTaskBatch2TileSelectionDecision,
  replayBatch2TileSelectionDecision,
} from "../../../src/pactile/registry.js";
import { selectTask } from "../../../src/pactile/task/session.js";
import { buildTileCatalog, type TileCatalog } from "../../../src/pactile/tiles/catalog.js";
import { loadTileUnit, type TileCatalogEntry } from "../../../src/pactile/tiles/loader.js";
import {
  decideTileSelection,
  prepareTileSelection,
  type TileSelectionFact,
  type TileSelectionRequest,
} from "../../../src/pactile/tiles/selection.js";
import { BASELINE_TILE_IDS } from "../../../src/pactile/tiles/content/baseline/index.js";
import { ONDEMAND_TILE_IDS } from "../../../src/pactile/tiles/content/ondemand/index.js";

const POLICY: PolicyCeilingV1 = {
  filesystem: "write",
  process: "execute",
  network: "forbidden",
  credentials: "forbidden",
  privacy: "local-only",
  egressDestinations: [],
  telemetry: "local-only",
  cost: "medium",
};

const LOCAL_POLICY: PolicyCeilingV1 = {
  filesystem: "read",
  process: "none",
  network: "forbidden",
  credentials: "forbidden",
  privacy: "local-only",
  egressDestinations: [],
  telemetry: "local-only",
  cost: "free",
};

const TASK_SAFE_POLICY: PolicyCeilingV1 = {
  ...LOCAL_POLICY,
  cost: "low",
};

const request: TileSelectionRequest = {
  intent: "structural",
  requiredOutputs: ["worker.handoff"],
  policyCeiling: POLICY,
  capabilities: [{ id: "agent.dispatch", assurance: "evidence-backed" }],
};

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function explicitFacts(catalog: TileCatalog): Record<string, "active" | "registered"> {
  return Object.fromEntries(catalog.entries.map((entry) => {
    const id = entry.manifest.identity.id;
    return [entry.ref, (BASELINE_TILE_IDS as readonly string[]).includes(id) ? "active" : "registered"];
  })) as Record<string, "active" | "registered">;
}

function mustCatalog(): TileCatalog {
  const loaded = loadBatch2TileCatalog();
  if (!loaded.success) throw new Error(JSON.stringify(loaded.diagnostics));
  return loaded.data;
}

function tileFacts(catalog: TileCatalog, statuses: Readonly<Record<string, TileSelectionFact["lifecycle"]>>): TileSelectionFact[] {
  return catalog.entries.map((entry) => ({
    ref: entry.ref,
    tier: (BASELINE_TILE_IDS as readonly string[]).includes(entry.manifest.identity.id) ? "baseline" : "on-demand",
    lifecycle: statuses[entry.ref] ?? "disabled",
  }));
}

describe("Tile candidate selection and decision receipts", () => {
  it("offers eligible baseline and registered on-demand Tiles with deterministic output coverage", () => {
    const catalog = mustCatalog();
    const lifecycleByRef = explicitFacts(catalog);
    const surface = loadBatch2TileSelectionSurface(lifecycleByRef);
    expect(surface.success).toBe(true);
    if (!surface.success) throw new Error(JSON.stringify(surface.diagnostics));

    const plan = prepareBatch2TileSelection(request, lifecycleByRef);
    expect(plan.success).toBe(true);
    if (!plan.success) throw new Error(JSON.stringify(plan.diagnostics));
    const worker = plan.data.offer.candidates.find((candidate) => candidate.ref === "worker-orchestration@1.0.0");
    expect(worker).toMatchObject({ tier: "on-demand", lifecycle: "registered", outputScore: 1 });
    expect(worker?.dependencyClosure).toContain("execute-agent@1.0.0");
    expect(plan.data.offer.suggestion).toMatchObject({
      selectedRefs: ["worker-orchestration@1.0.0"],
      complete: true,
      coveredOutputs: ["worker.handoff"],
      missingOutputs: [],
    });
    expect(plan.data.offer.candidates).not.toContainEqual(
      expect.objectContaining({ ref: "retrieval-extended@1.0.0" }),
    );
    const reversed = prepareTileSelection(catalog, request, [...surface.data.facts].reverse());
    expect(reversed.success).toBe(true);
    if (!reversed.success) throw new Error(JSON.stringify(reversed.diagnostics));
    expect(reversed.data.offer.fingerprint).toBe(plan.data.offer.fingerprint);

    const blocked = prepareTileSelection(catalog, {
      ...request,
      taskLifecycle: {
        taskId: "task-blocked",
        projectFingerprint: `sha256:${"b".repeat(64)}`,
        scopeFingerprint: `sha256:${"a".repeat(64)}`,
        selectionGrant: {
          source: "safe-default",
          assurance: "no-grant",
          fingerprint: `sha256:${"e".repeat(64)}`,
        },
        revision: 8,
        phase: "execute",
        condition: "blocked",
        outcome: null,
      },
    }, surface.data.facts);
    expect(blocked.success).toBe(true);
    if (!blocked.success) throw new Error(JSON.stringify(blocked.diagnostics));
    expect(blocked.data.offer.candidates).toHaveLength(0);
    expect(blocked.data.audit.every((item) =>
      item.filterCodes.includes("tile-selection-task-lifecycle-inactive"),
    )).toBe(true);

    const definePhase = prepareTileSelection(catalog, {
      ...request,
      taskLifecycle: {
        taskId: "task-define",
        projectFingerprint: `sha256:${"c".repeat(64)}`,
        scopeFingerprint: `sha256:${"d".repeat(64)}`,
        selectionGrant: {
          source: "safe-default",
          assurance: "no-grant",
          fingerprint: `sha256:${"f".repeat(64)}`,
        },
        revision: 1,
        phase: "define",
        condition: "ready",
        outcome: null,
      },
    }, surface.data.facts);
    expect(definePhase.success).toBe(true);
    if (!definePhase.success) throw new Error(JSON.stringify(definePhase.diagnostics));
    expect(definePhase.data.offer.candidates.some((candidate) => candidate.ref === "worker-orchestration@1.0.0"))
      .toBe(false);
    expect(definePhase.data.audit.find((item) => item.ref === "worker-orchestration@1.0.0")?.filterCodes)
      .toContain("tile-selection-phase-ineligible");
  });

  it("filters permissions and inactive lifecycle facts before candidates reach the offer", () => {
    const catalog = mustCatalog();
    const facts = tileFacts(catalog, explicitFacts(catalog));
    const externalRequest: TileSelectionRequest = {
      intent: "external",
      requiredOutputs: ["retrieval.evidence"],
      policyCeiling: LOCAL_POLICY,
      capabilities: [
        { id: "retrieval.provider", assurance: "evidence-backed" },
        { id: "context.pack", assurance: "evidence-backed" },
      ],
    };
    const permissionPlan = prepareTileSelection(catalog, externalRequest, facts);
    expect(permissionPlan.success).toBe(true);
    if (!permissionPlan.success) throw new Error(JSON.stringify(permissionPlan.diagnostics));
    expect(permissionPlan.data.offer.candidates.some((candidate) => candidate.ref === "retrieval-extended@1.0.0")).toBe(false);
    expect(permissionPlan.data.audit.find((item) => item.ref === "retrieval-extended@1.0.0")?.filterCodes)
      .toContain("tile-selection-permission-exceeded");

    const disabled = Object.fromEntries(catalog.entries.map((entry) => [
      entry.ref,
      entry.ref === "worker-orchestration@1.0.0" ? "retired" : facts.find((fact) => fact.ref === entry.ref)?.lifecycle ?? "disabled",
    ])) as Record<string, TileSelectionFact["lifecycle"]>;
    const retiredPlan = prepareTileSelection(catalog, request, tileFacts(catalog, disabled));
    expect(retiredPlan.success).toBe(true);
    if (!retiredPlan.success) throw new Error(JSON.stringify(retiredPlan.diagnostics));
    expect(retiredPlan.data.offer.candidates.some((candidate) => candidate.ref === "worker-orchestration@1.0.0")).toBe(false);
    expect(retiredPlan.data.audit.find((item) => item.ref === "worker-orchestration@1.0.0")?.filterCodes)
      .toContain("tile-selection-lifecycle-ineligible");
  });

  it("records adopt, mis-selection, override, no-match, invalid choice, and replay results", () => {
    const lifecycleByRef = explicitFacts(mustCatalog());
    const plan = prepareBatch2TileSelection(request, lifecycleByRef);
    if (!plan.success) throw new Error(JSON.stringify(plan.diagnostics));
    const adoptDecision = { kind: "adopt" as const, offerFingerprint: plan.data.offer.fingerprint };
    const adopted = decideBatch2TileSelection(request, adoptDecision, lifecycleByRef);
    expect(adopted.success).toBe(true);
    if (!adopted.success) throw new Error(JSON.stringify(adopted.diagnostics));
    expect(adopted.data).toMatchObject({ outcome: "selected", compilerPassed: true, missingOutputs: [] });
    const replay = replayBatch2TileSelectionDecision(request, adoptDecision, lifecycleByRef);
    expect(replay).toEqual(adopted);

    const corrected = decideBatch2TileSelection(request, {
      kind: "override",
      offerFingerprint: plan.data.offer.fingerprint,
      selectedRefs: ["worker-orchestration"],
      priorAttemptRefs: ["debug-recovery"],
    }, lifecycleByRef);
    expect(corrected.success).toBe(true);
    if (!corrected.success) throw new Error(JSON.stringify(corrected.diagnostics));
    expect(corrected.data).toMatchObject({
      outcome: "overridden",
      compilerPassed: true,
      selectedRefs: ["worker-orchestration@1.0.0"],
      priorAttempt: { outcome: "mis-selection", missingOutputs: ["worker.handoff"] },
    });

    const noMatch = decideBatch2TileSelection(request, {
      kind: "no-match",
      offerFingerprint: plan.data.offer.fingerprint,
      priorAttemptRefs: ["debug-recovery"],
    }, lifecycleByRef);
    expect(noMatch.success).toBe(true);
    if (!noMatch.success) throw new Error(JSON.stringify(noMatch.diagnostics));
    expect(noMatch.data).toMatchObject({ outcome: "no-match", priorAttempt: { outcome: "mis-selection" } });

    const staleNoMatch = decideBatch2TileSelection(request, {
      kind: "no-match",
      offerFingerprint: "stale-offer",
      priorAttemptRefs: ["debug-recovery"],
    }, lifecycleByRef);
    expect(staleNoMatch.success).toBe(true);
    if (!staleNoMatch.success) throw new Error(JSON.stringify(staleNoMatch.diagnostics));
    expect(staleNoMatch.data.outcome).toBe("stale-offer");

    const malformed = decideBatch2TileSelection(request, {
      kind: "unsupported",
      offerFingerprint: plan.data.offer.fingerprint,
    } as never, lifecycleByRef);
    expect(malformed.success).toBe(true);
    if (!malformed.success) throw new Error(JSON.stringify(malformed.diagnostics));
    expect(malformed.data).toMatchObject({ decision: "invalid", outcome: "invalid-selection" });

    const illegal = "ghp_p33-selection-secret-like-value";
    const rejected = decideBatch2TileSelection(request, {
      kind: "override",
      offerFingerprint: plan.data.offer.fingerprint,
      selectedRefs: [illegal],
    }, lifecycleByRef);
    expect(rejected.success).toBe(true);
    if (!rejected.success) throw new Error(JSON.stringify(rejected.diagnostics));
    expect(rejected.data).toMatchObject({ outcome: "invalid-selection", invalidReferenceCount: 1 });
    expect(JSON.stringify(rejected.data)).not.toContain(illegal);
  });

  it("rechecks conflicting overrides with the compiler and records rejection", () => {
    const first = tinyTile("choice.first", ["choice.first"], ["choice.second"]);
    const second = tinyTile("choice.second", ["choice.second"], []);
    const catalogResult = buildTileCatalog([first, second]);
    if (!catalogResult.success) throw new Error(JSON.stringify(catalogResult.diagnostics));
    const facts: TileSelectionFact[] = [first, second].map((entry) => ({
      ref: entry.ref,
      tier: "on-demand",
      lifecycle: "registered",
    }));
    const conflictRequest: TileSelectionRequest = {
      intent: "exact",
      requiredOutputs: ["choice.first", "choice.second"],
      policyCeiling: LOCAL_POLICY,
      capabilities: [],
    };
    const plan = prepareTileSelection(catalogResult.data, conflictRequest, facts);
    expect(plan.success).toBe(true);
    if (!plan.success) throw new Error(JSON.stringify(plan.diagnostics));
    expect(plan.data.offer.candidates).toHaveLength(2);
    expect(plan.data.offer.suggestion.complete).toBe(false);
    const result = decideTileSelection(catalogResult.data, conflictRequest, facts, {
      kind: "override",
      offerFingerprint: plan.data.offer.fingerprint,
      selectedRefs: [first.ref, second.ref],
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.data).toMatchObject({ outcome: "compile-rejected", compilerPassed: false });
    expect(result.data.diagnostics.map((item) => item.code)).toContain("tile-conflict");
  });

  it("backtracks past a high-coverage conflict and adopts another complete compiler-valid set", () => {
    const tileA = tinyTile("tile.a", ["output.a", "output.b"], ["tile.d"]);
    const tileB = tinyTile("tile.b", ["output.a"], []);
    const tileC = tinyTile("tile.c", ["output.b"], []);
    const tileD = tinyTile("tile.d", ["output.c"], []);
    const catalogResult = buildTileCatalog([tileA, tileB, tileC, tileD]);
    if (!catalogResult.success) throw new Error(JSON.stringify(catalogResult.diagnostics));
    const facts: TileSelectionFact[] = catalogResult.data.entries.map((entry) => ({
      ref: entry.ref,
      tier: "on-demand",
      lifecycle: "registered",
    }));
    const request: TileSelectionRequest = {
      intent: "exact",
      requiredOutputs: ["output.a", "output.b", "output.c"],
      policyCeiling: LOCAL_POLICY,
      capabilities: [],
    };

    const plan = prepareTileSelection(catalogResult.data, request, facts);
    expect(plan.success).toBe(true);
    if (!plan.success) throw new Error(JSON.stringify(plan.diagnostics));
    expect(plan.data.offer.suggestion).toMatchObject({
      selectedRefs: ["tile.b@1.0.0", "tile.c@1.0.0", "tile.d@1.0.0"],
      coveredOutputs: ["output.a", "output.b", "output.c"],
      missingOutputs: [],
      complete: true,
      searchStatus: "solution-found",
    });

    const adopted = decideTileSelection(catalogResult.data, request, facts, {
      kind: "adopt",
      offerFingerprint: plan.data.offer.fingerprint,
    });
    expect(adopted.success).toBe(true);
    if (!adopted.success) throw new Error(JSON.stringify(adopted.diagnostics));
    expect(adopted.data).toMatchObject({
      outcome: "selected",
      selectedRefs: ["tile.b@1.0.0", "tile.c@1.0.0", "tile.d@1.0.0"],
      compilerPassed: true,
      missingOutputs: [],
    });
  });

  it("reads the selected Task Kernel lifecycle and fails closed with a receipt when absent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-tile-selection-task-"));
    tempRoots.push(root);
    const taskDir = path.join(root, ".pactile", "tasks", "p33-selection");
    const env = { PACTILE_CONTEXT_ID: "tile-selection-test" } as NodeJS.ProcessEnv;
    applyKernelCreate({
      taskDir,
      cwd: root,
      actor: "test",
      idempotencyKey: "create-p33-selection",
      record: emptyTaskRecord({ id: "p33-selection", name: "p33-selection", title: "P33 selection" }),
      extras: {
        baseline_modules: { active: [...BASELINE_TILE_IDS] },
        ondemand_modules: {
          registered: [...ONDEMAND_TILE_IDS],
          active: ["worker-orchestration"],
          degraded: [],
        },
      },
      extrasBoundary: neutralKernelExtrasBoundary,
    });
    selectTask(root, ".pactile/tasks/p33-selection", env);

    const taskRequest: TileSelectionRequest = {
      intent: "structural",
      requiredOutputs: ["task.design"],
      policyCeiling: TASK_SAFE_POLICY,
      capabilities: [],
    };
    const plan = prepareSelectedTaskBatch2TileSelection(root, taskRequest, env);
    if (!plan.success) throw new Error(JSON.stringify(plan));
    expect(plan.success).toBe(true);
    expect(plan.data.offer.taskLifecycle).toMatchObject({
      taskId: "p33-selection",
      phase: "define",
      condition: "ready",
      outcome: null,
      revision: 1,
    });
    expect(plan.data.offer.candidates.some((candidate) => candidate.ref === "define-extended@1.0.0")).toBe(true);
    expect(plan.data.offer.candidates.some((candidate) => candidate.ref === "worker-orchestration@1.0.0")).toBe(false);
    expect(plan.data.offer.taskLifecycle?.selectionGrant).toMatchObject({
      source: "safe-default",
      assurance: "no-grant",
    });
    const stricterPlan = prepareSelectedTaskBatch2TileSelection(root, {
      ...taskRequest,
      policyCeiling: LOCAL_POLICY,
    }, env);
    expect(stricterPlan.success).toBe(true);
    if (!stricterPlan.success) throw new Error(JSON.stringify(stricterPlan));
    expect(stricterPlan.data.offer.candidates.some((candidate) => candidate.ref === "define-extended@1.0.0")).toBe(false);
    const result = decideSelectedTaskBatch2TileSelection(root, taskRequest, {
      kind: "adopt",
      offerFingerprint: plan.data.offer.fingerprint,
    }, env);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.data.compilerPassed).toBe(true);
    expect(result.snapshot.fileName).toBe(`tile-selection-${result.snapshot.fingerprint.slice(7)}.json`);
    expect(replaySelectedTaskBatch2TileSelectionDecision(root, taskRequest, {
      kind: "adopt",
      offerFingerprint: plan.data.offer.fingerprint,
    }, env)).toMatchObject({ success: true, data: result.data });
    const persisted = replayStoredSelectedTaskBatch2TileSelectionDecision(root, result.snapshot.fingerprint);
    expect(persisted).toMatchObject({
      success: true,
      data: {
        snapshotFingerprint: result.snapshot.fingerprint,
        offerFingerprint: plan.data.offer.fingerprint,
        receipt: result.data,
      },
    });

    const repeated = decideSelectedTaskBatch2TileSelection(root, taskRequest, {
      kind: "adopt",
      offerFingerprint: plan.data.offer.fingerprint,
    }, env);
    expect(repeated.success).toBe(true);
    if (!repeated.success) throw new Error(JSON.stringify(repeated.diagnostics));
    expect(repeated.snapshot).toEqual(result.snapshot);

    const secretRef = "C:\\private\\selection-secret-token";
    const invalidChoice = decideSelectedTaskBatch2TileSelection(root, taskRequest, {
      kind: "override",
      offerFingerprint: plan.data.offer.fingerprint,
      selectedRefs: [secretRef],
      priorAttemptRefs: ["debug-recovery"],
    }, env);
    expect(invalidChoice.success).toBe(true);
    if (!invalidChoice.success) throw new Error(JSON.stringify(invalidChoice.diagnostics));
    expect(invalidChoice.data.outcome).toBe("invalid-selection");
    const receiptPath = path.join(root, ".pactile", "runtime", "receipts", invalidChoice.snapshot.fileName);
    const receiptText = fs.readFileSync(receiptPath, "utf8");
    expect(receiptText).not.toContain(secretRef);
    expect(receiptText).not.toContain(root);
    expect(replayStoredSelectedTaskBatch2TileSelectionDecision(root, invalidChoice.snapshot.fingerprint))
      .toMatchObject({ success: true, data: { receipt: invalidChoice.data } });

    for (const hiddenRef of ["worker-orchestration@1.0.0", "worker-orchestration"]) {
      const hiddenChoice = decideSelectedTaskBatch2TileSelection(root, taskRequest, {
        kind: "override",
        offerFingerprint: plan.data.offer.fingerprint,
        selectedRefs: [hiddenRef],
      }, env);
      expect(hiddenChoice.success).toBe(true);
      if (!hiddenChoice.success) throw new Error(JSON.stringify(hiddenChoice.diagnostics));
      expect(hiddenChoice.data).toMatchObject({
        outcome: "invalid-selection",
        selectedRefs: [],
        invalidReferenceCount: 1,
        diagnostics: [{ code: "tile-missing-reference", tileRef: null, relatedRef: null }],
      });
      expect(JSON.stringify(hiddenChoice.data)).not.toContain("worker-orchestration");
      const hiddenSnapshotPath = path.join(root, ".pactile", "runtime", "receipts", hiddenChoice.snapshot.fileName);
      const hiddenSnapshot = fs.readFileSync(hiddenSnapshotPath, "utf8");
      expect(hiddenSnapshot).not.toContain("worker-orchestration");
      expect(hiddenSnapshot).not.toContain("catalogEntries");
      expect(hiddenSnapshot).not.toContain("skillText");
      expect(replayStoredSelectedTaskBatch2TileSelectionDecision(root, hiddenChoice.snapshot.fingerprint))
        .toMatchObject({ success: true, data: { receipt: hiddenChoice.data } });
    }

    const twinRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-tile-selection-twin-"));
    tempRoots.push(twinRoot);
    const twinTaskDir = path.join(twinRoot, ".pactile", "tasks", "p33-selection");
    applyKernelCreate({
      taskDir: twinTaskDir,
      cwd: twinRoot,
      actor: "test",
      idempotencyKey: "create-p33-selection-twin",
      record: emptyTaskRecord({ id: "p33-selection", name: "p33-selection", title: "P33 selection" }),
      extras: {
        baseline_modules: { active: [...BASELINE_TILE_IDS] },
        ondemand_modules: {
          registered: [...ONDEMAND_TILE_IDS],
          active: ["worker-orchestration"],
          degraded: [],
        },
      },
      extrasBoundary: neutralKernelExtrasBoundary,
    });
    selectTask(twinRoot, ".pactile/tasks/p33-selection", env);
    const twinPlan = prepareSelectedTaskBatch2TileSelection(twinRoot, taskRequest, env);
    expect(twinPlan.success).toBe(true);
    if (!twinPlan.success) throw new Error(JSON.stringify(twinPlan));
    expect(twinPlan.data.offer.taskLifecycle).toMatchObject({
      taskId: "p33-selection",
      revision: 1,
      phase: "define",
    });
    expect(twinPlan.data.offer.fingerprint).not.toBe(plan.data.offer.fingerprint);
    const crossProjectDecision = decideSelectedTaskBatch2TileSelection(twinRoot, taskRequest, {
      kind: "adopt",
      offerFingerprint: plan.data.offer.fingerprint,
    }, env);
    expect(crossProjectDecision.success).toBe(true);
    if (!crossProjectDecision.success) throw new Error(JSON.stringify(crossProjectDecision.diagnostics));
    expect(crossProjectDecision.data.outcome).toBe("stale-offer");
    expect(JSON.stringify(crossProjectDecision.data)).not.toContain(twinRoot);
    expect(replayStoredSelectedTaskBatch2TileSelectionDecision(twinRoot, result.snapshot.fingerprint).success)
      .toBe(false);

    applyKernelTransition({
      taskDir,
      cwd: root,
      expectedRevision: 1,
      targetPhase: "approve",
      actor: "test",
      idempotencyKey: "advance-p33-selection",
      evidence: "selection-lifecycle-test",
    });
    const staleTaskDecision = decideSelectedTaskBatch2TileSelection(root, taskRequest, {
      kind: "adopt",
      offerFingerprint: plan.data.offer.fingerprint,
    }, env);
    expect(staleTaskDecision.success).toBe(true);
    if (!staleTaskDecision.success) throw new Error(JSON.stringify(staleTaskDecision.diagnostics));
    expect(staleTaskDecision.data.outcome).toBe("stale-offer");
    expect(replayStoredSelectedTaskBatch2TileSelectionDecision(root, result.snapshot.fingerprint))
      .toMatchObject({ success: true, data: { receipt: result.data } });

    applyKernelTransition({
      taskDir,
      cwd: root,
      expectedRevision: 2,
      targetPhase: "execute",
      actor: "test",
      idempotencyKey: "enter-p33-selection-execute-without-approval",
      evidence: "selection-execute-gate-test",
    });
    const unapprovedExecution = prepareSelectedTaskBatch2TileSelection(root, {
      intent: "structural",
      requiredOutputs: ["worker.handoff"],
      policyCeiling: POLICY,
      capabilities: [{ id: "agent.dispatch", assurance: "evidence-backed" }],
    }, env);
    expect(unapprovedExecution.success).toBe(true);
    if (!unapprovedExecution.success) throw new Error(JSON.stringify(unapprovedExecution));
    expect(unapprovedExecution.data.offer.taskLifecycle).toMatchObject({ phase: "execute", selectionGrant: { source: "safe-default" } });
    expect(unapprovedExecution.data.offer.candidates.some((candidate) => candidate.ref === "worker-orchestration@1.0.0")).toBe(false);

    const missingLifecycleDir = path.join(root, ".pactile", "tasks", "p33-selection-missing-lifecycle");
    applyKernelCreate({
      taskDir: missingLifecycleDir,
      cwd: root,
      actor: "test",
      idempotencyKey: "create-p33-selection-missing-lifecycle",
      record: emptyTaskRecord({
        id: "p33-selection-missing-lifecycle",
        name: "p33-selection-missing-lifecycle",
        title: "P33 selection without lifecycle facts",
      }),
      extrasBoundary: neutralKernelExtrasBoundary,
    });
    selectTask(root, ".pactile/tasks/p33-selection-missing-lifecycle", env);
    const missingLifecycle = prepareSelectedTaskBatch2TileSelection(root, taskRequest, env);
    expect(missingLifecycle.success).toBe(false);
    if (missingLifecycle.success) throw new Error("expected Kernel lifecycle facts to be required");
    expect("receipt" in missingLifecycle ? missingLifecycle.receipt.reasonCode : "")
      .toBe("tile-selection-task-lifecycle-missing");

    const noTask = prepareSelectedTaskBatch2TileSelection(root, taskRequest, {} as NodeJS.ProcessEnv);
    expect(noTask.success).toBe(false);
    if (noTask.success) throw new Error("expected current Task failure");
    expect("receipt" in noTask ? noTask.receipt.reasonCode : "").toBe("tile-selection-no-current-task");
  });
});

function tinyTile(id: string, outputs: readonly string[], conflicts: readonly string[]): TileCatalogEntry {
  const conflictLines = conflicts.length
    ? ["conflicts:", ...conflicts.map((value) => `  - ${value}`)]
    : ["conflicts: []"];
  const yaml = [
    "schemaVersion: 1",
    "identity:",
    `  id: ${id}`,
    '  version: "1.0.0"',
    `summary: ${id}`,
    "trigger:",
    "  mode: both",
    "  intents:",
    "    - exact",
    `  description: ${id}`,
    "inputs: []",
    "outputs:",
    ...outputs.map((output) => `  - ${output}`),
    "dependencies: []",
    ...conflictLines,
    "permissions:",
    "  filesystem: read",
    "  process: none",
    "  credentials: forbidden",
    "egress:",
    "  network: forbidden",
    "  privacy: local-only",
    "  telemetry: local-only",
    "  destinations: []",
    "cost:",
    "  ceiling: free",
    "fallback:",
    "  allowed: false",
    "  minimumAssurance: null",
    "  policy: null",
    "stop:",
    "  conditions:",
    "    - success",
    "  maxAttempts: 1",
    "minimumAssurance: evidence-backed",
    "evidence:",
    "  - kind: artifact",
    "    required: true",
    "    description: Record the result.",
  ].join("\n");
  const loaded = loadTileUnit([
    { name: "tile.yaml", text: yaml },
    { name: "SKILL.md", text: `# ${id}\n` },
  ]);
  if (!loaded.success) throw new Error(JSON.stringify(loaded.diagnostics));
  return loaded.data;
}
