import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalizePactileJsonV1,
  type InstallStateV1,
  type OwnershipControlV1,
  type OwnershipLedgerV1,
  type OwnershipOriginV1,
  type OwnershipSnapshotV1,
  type ProjectionPlanV1,
} from "@blxzer/pactile-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PactileExitManager } from "../../../src/pactile/exit/service.js";
import {
  fingerprintBytes,
  type ProjectionContent,
} from "../../../src/pactile/projection/planner.js";
import { ProjectionStore } from "../../../src/pactile/projection/store.js";
import {
  GenerationStore,
  InstallStateStore,
  type GenerationSeal,
} from "../../../src/pactile/runtime/stores.js";

const occurredAt = "2026-09-10T08:00:00.000Z";
const body = Buffer.from("generated\n");
let root: string;
let planCounter = 0;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "p45-exit-"));
  planCounter = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function generation(id: string, contents = `${id}\n`): GenerationSeal {
  const store = new GenerationStore(root);
  store.stage(id);
  const written = store.writeFile(id, "framework/index.md", contents);
  return store.seal(id, [written]);
}

function install(
  seal: GenerationSeal,
  adapters: readonly {
    id: string;
    status: "active" | "degraded" | "detached";
  }[],
  status: InstallStateV1["status"] = "active",
) {
  return new InstallStateStore(root).compareAndSwap(null, {
    schemaVersion: 1,
    product: "pactile",
    canonicalRoot: ".pactile",
    runtimeVersion: "0.5.0",
    contractVersion: 1,
    generationId: seal.generationId,
    status,
    installedAdapters: adapters.map((adapter) => ({
      ...adapter,
      version: "0.5.0",
      lastProjectionFingerprint: null,
      reconciledAt: null,
    })),
    lastMigrationJournalId: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

function applyClaim(
  seal: GenerationSeal,
  adapterId: string,
  targetPath = "host/generated.md",
): void {
  const target = path.join(root, ...targetPath.split("/"));
  const store = new ProjectionStore(root);
  const ledger = store.readLedger();
  const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
  const contentRef = `fixture.body.${fingerprintBytes(body).slice(7)}`;
  const plan: ProjectionPlanV1 = {
    schemaVersion: 1,
    id: `fixture.claim.${planCounter++}`,
    adapterId,
    generationId: seal.generationId,
    canonicalFingerprint: seal.fingerprint,
    expectedLedgerFingerprint: ledger?.fingerprint ?? null,
    operations: [
      {
        id: `fixture.operation.${planCounter}`,
        resourceId: "fixture.generated",
        claimantId: adapterId,
        action: "ensure",
        control: "pactile-owned",
        targetPath,
        format: "text",
        contentRef,
        desiredFingerprint: fingerprintBytes(body),
        expectedCurrentFingerprint:
          current === null ? null : fingerprintBytes(current),
        externalAssetId: null,
      },
    ],
  };
  const preview = store.inspect({
    plan,
    canonicalFingerprint: seal.fingerprint,
    updatedAt: occurredAt,
    resolveContent: (): ProjectionContent => ({ bytes: body }),
  });
  expect(preview.status).toBe("ready");
  if (preview.status !== "ready") throw new Error(preview.reason);
  expect(store.apply(preview).status).toBe("applied");
}

function snapshot(bytes: Buffer, contentRef: string): OwnershipSnapshotV1 {
  return {
    state: "present",
    fingerprint: fingerprintBytes(bytes),
    contentRef,
  };
}

function writeManualLedger(
  seal: GenerationSeal,
  control: OwnershipControlV1,
  origin: OwnershipOriginV1,
): void {
  const targetPath = "host/external.md";
  const target = path.join(root, ...targetPath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  const present = snapshot(body, "fixture.external.baseline");
  const ledger: OwnershipLedgerV1 = {
    schemaVersion: 1,
    generationId: seal.generationId,
    updatedAt: occurredAt,
    entries: [
      {
        resourceId: "fixture.external",
        targetPath,
        format: "text",
        origin,
        control,
        owner:
          control === "borrowed"
            ? { kind: "external", id: "external.owner" }
            : control === "unknown"
              ? { kind: "unknown", id: null }
              : { kind: "pactile", id: "pactile" },
        claimants: [
          {
            id: "adapter.cursor",
            kind: "adapter",
            adapterId: "adapter.cursor",
          },
        ],
        preimage:
          origin === "unknown"
            ? { state: "unknown", fingerprint: null, contentRef: null }
            : present,
        generated: present,
        current: present,
        conflict: origin === "unknown" ? "ownership-unknown" : "none",
        disposition: origin === "unknown" ? "manual-review" : "no-op",
      },
    ],
  };
  const ledgerPath = path.join(root, ".pactile/runtime/ownership-ledger.json");
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, canonicalizePactileJsonV1(ledger));
}

describe("Pactile exit public seam", () => {
  it("detaches one shared claimant without deleting the other claimant's file", () => {
    const seal = generation("generation.shared");
    install(seal, [
      { id: "adapter.cursor", status: "active" },
      { id: "adapter.codex", status: "active" },
    ]);
    applyClaim(seal, "adapter.cursor");
    applyClaim(seal, "adapter.codex");

    const manager = new PactileExitManager(root, { now: () => occurredAt });
    const planned = manager.planDetach("adapter.cursor");
    expect(planned.status).toBe("ready");
    if (planned.status !== "ready") throw new Error(planned.reason);
    expect(planned.preview.mutations).toEqual([]);
    const applied = manager.applyDetach(planned);
    expect(applied.status).toBe("applied");
    expect(fs.readFileSync(path.join(root, "host/generated.md"), "utf8")).toBe(
      "generated\n",
    );
    const ledger = new ProjectionStore(root).readLedger();
    expect(ledger?.ledger.entries[0].claimants.map(({ id }) => id)).toEqual([
      "adapter.codex",
    ]);
    const state = new InstallStateStore(root).read()?.state;
    expect(
      state?.installedAdapters.find(({ id }) => id === "adapter.cursor")
        ?.status,
    ).toBe("detached");
    expect(state?.status).toBe("active");
  });

  it("preserves a modified generated file while releasing its claimant", () => {
    const seal = generation("generation.modified");
    install(seal, [{ id: "adapter.cursor", status: "active" }]);
    applyClaim(seal, "adapter.cursor");
    const target = path.join(root, "host/generated.md");
    fs.appendFileSync(target, "user change\n");

    const manager = new PactileExitManager(root, { now: () => occurredAt });
    const planned = manager.planDetach("adapter.cursor");
    expect(planned.status).toBe("ready");
    if (planned.status !== "ready") throw new Error(planned.reason);
    expect(planned.preview.decisions[0]?.disposition).toBe("preserve-modified");
    const applied = manager.applyDetach(planned);
    expect(applied.status).toBe("applied");
    expect(fs.readFileSync(target, "utf8")).toContain("user change");
    expect(new InstallStateStore(root).read()?.state.status).toBe("inactive");
  });

  it("marks the adapter degraded before a projection failure and can retry", () => {
    const seal = generation("generation.detach-recovery");
    install(seal, [{ id: "adapter.cursor", status: "active" }]);
    applyClaim(seal, "adapter.cursor");
    const store = new ProjectionStore(root);
    const manager = new PactileExitManager(root, {
      now: () => occurredAt,
      projectionStore: store,
    });
    const planned = manager.planDetach("adapter.cursor");
    expect(planned.status).toBe("ready");
    if (planned.status !== "ready") throw new Error(planned.reason);
    vi.spyOn(store, "apply").mockReturnValueOnce({
      status: "busy",
      reason: "projection-busy",
    });

    expect(manager.applyDetach(planned)).toEqual({
      status: "busy",
      reason: "projection-busy",
    });
    expect(
      new InstallStateStore(root).read()?.state.installedAdapters[0]?.status,
    ).toBe("degraded");
    const retry = manager.planDetach("adapter.cursor");
    expect(retry.status).toBe("ready");
  });

  it("preserves borrowed content and blocks unknown ownership", () => {
    let seal = generation("generation.borrowed");
    install(seal, [{ id: "adapter.cursor", status: "active" }]);
    writeManualLedger(seal, "borrowed", "adopted");
    let manager = new PactileExitManager(root, { now: () => occurredAt });
    let planned = manager.planDetach("adapter.cursor");
    expect(planned.status).toBe("ready");
    if (planned.status !== "ready") throw new Error(planned.reason);
    expect(planned.preview.decisions[0]?.disposition).toBe("preserve-borrowed");
    expect(manager.applyDetach(planned).status).toBe("applied");
    expect(fs.readFileSync(path.join(root, "host/external.md"), "utf8")).toBe(
      "generated\n",
    );

    fs.rmSync(root, { recursive: true, force: true });
    root = fs.mkdtempSync(path.join(os.tmpdir(), "p45-exit-unknown-"));
    seal = generation("generation.unknown");
    install(seal, [{ id: "adapter.cursor", status: "active" }]);
    writeManualLedger(seal, "unknown", "unknown");
    manager = new PactileExitManager(root, { now: () => occurredAt });
    planned = manager.planDetach("adapter.cursor");
    expect(planned).toEqual({
      status: "review",
      reason: "ownership-review-required",
    });
    expect(fs.readFileSync(path.join(root, "host/external.md"), "utf8")).toBe(
      "generated\n",
    );
  });

  it("detaches a durably recorded borrowed external claim without touching the asset", () => {
    const seal = generation("generation.external-claim");
    install(seal, [{ id: "adapter.cursor", status: "active" }]);
    const asset = path.join(root, "external-skill.txt");
    fs.writeFileSync(asset, "SENSITIVE-EXTERNAL-BODY");
    const store = new ProjectionStore(root);
    const preview = store.inspect({
      plan: {
        schemaVersion: 1,
        id: "fixture.external.bind",
        adapterId: "adapter.cursor",
        generationId: seal.generationId,
        canonicalFingerprint: seal.fingerprint,
        expectedLedgerFingerprint: null,
        operations: [
          {
            id: "fixture.external.bind.operation",
            resourceId: "fixture.external.skill",
            claimantId: "adapter.cursor",
            action: "bind",
            control: "borrowed",
            targetPath: null,
            format: "external-ref",
            contentRef: null,
            desiredFingerprint: null,
            expectedCurrentFingerprint: null,
            externalAssetId: "external-skill-id",
          },
        ],
      },
      canonicalFingerprint: seal.fingerprint,
      updatedAt: occurredAt,
      resolveContent: () => {
        throw new Error("borrowed asset resolution forbidden");
      },
    });
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error(preview.reason);
    expect(store.apply(preview).status).toBe("applied");

    const manager = new PactileExitManager(root, {
      now: () => occurredAt,
      projectionStore: store,
    });
    const planned = manager.planDetach("adapter.cursor");
    expect(planned.status).toBe("ready");
    if (planned.status !== "ready") throw new Error(planned.reason);
    expect(planned.preview.decisions).toContainEqual(
      expect.objectContaining({
        resourceId: "fixture.external.skill",
        disposition: "preserve-borrowed",
      }),
    );
    expect(manager.applyDetach(planned).status).toBe("applied");
    expect(store.readExternalClaims().claims).toEqual([
      {
        resourceId: "fixture.external.skill",
        externalAssetId: "external-skill-id",
        claimants: [],
      },
    ]);
    expect(fs.readFileSync(asset, "utf8")).toBe("SENSITIVE-EXTERNAL-BODY");
  });

  it("uninstalls non-destructively and leaves canonical user state intact", () => {
    const seal = generation("generation.uninstall");
    install(seal, [
      { id: "adapter.cursor", status: "active" },
      { id: "adapter.codex", status: "active" },
    ]);
    applyClaim(seal, "adapter.cursor");
    applyClaim(seal, "adapter.codex");
    const task = path.join(root, ".pactile/tasks/user-task/notes.md");
    const workspace = path.join(root, ".pactile/workspace/user.txt");
    const spec = path.join(root, ".pactile/spec/product.md");
    for (const [target, contents] of [
      [task, "task"],
      [workspace, "workspace"],
      [spec, "spec"],
    ]) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }

    const result = new PactileExitManager(root, {
      now: () => occurredAt,
    }).uninstall();
    expect(result.status).toBe("applied");
    expect(fs.existsSync(path.join(root, "host/generated.md"))).toBe(false);
    expect(fs.readFileSync(task, "utf8")).toBe("task");
    expect(fs.readFileSync(workspace, "utf8")).toBe("workspace");
    expect(fs.readFileSync(spec, "utf8")).toBe("spec");
    expect(new GenerationStore(root).verify(seal.generationId)).toEqual(seal);
    expect(new InstallStateStore(root).read()?.state.status).toBe("inactive");
  });

  it("rolls back only to a sealed generation and preserves the newer one", async () => {
    const older = generation("generation.older", "older\n");
    const newer = generation("generation.newer", "newer\n");
    install(newer, [{ id: "adapter.cursor", status: "detached" }], "inactive");
    const live = path.join(root, ".pactile/framework/index.md");
    fs.mkdirSync(path.dirname(live), { recursive: true });
    fs.writeFileSync(live, "newer\n");
    const manager = new PactileExitManager(root, { now: () => occurredAt });
    expect(manager.planRollback("generation.missing")).toEqual({
      status: "review",
      reason: "target-generation-unverified",
    });
    const planned = manager.planRollback(older.generationId);
    expect(planned.status).toBe("ready");
    if (planned.status !== "ready") throw new Error(planned.reason);
    const result = await manager.applyRollback(planned);
    expect(result.status).toBe("applied");
    expect(new InstallStateStore(root).read()?.state.generationId).toBe(
      older.generationId,
    );
    expect(fs.readFileSync(live, "utf8")).toBe("older\n");
    expect(new GenerationStore(root).verify(newer.generationId)).toEqual(newer);
    expect(new GenerationStore(root).verify(older.generationId)).toEqual(older);
    if ("receipt" in result)
      expect(result.receipt.receipt.previousGenerationId).toBe(
        newer.generationId,
      );
  });

  it("repairs the live canonical view when rollback is already active", async () => {
    const older = generation("generation.already-active-older", "older\n");
    const newer = generation("generation.already-active-newer", "newer\n");
    install(older, [{ id: "adapter.unknown", status: "active" }]);
    const live = path.join(root, ".pactile/framework/index.md");
    fs.mkdirSync(path.dirname(live), { recursive: true });
    fs.writeFileSync(live, "newer\n");

    const manager = new PactileExitManager(root, { now: () => occurredAt });
    const planned = manager.planRollback(older.generationId);
    expect(planned.status).toBe("ready");
    if (planned.status !== "ready") throw new Error(planned.reason);
    expect(planned.alreadyActive).toBe(true);
    expect((await manager.applyRollback(planned)).status).toBe(
      "already-active",
    );
    expect(fs.readFileSync(live, "utf8")).toBe("older\n");
    expect(new GenerationStore(root).verify(newer.generationId)).toEqual(newer);
  });

  it("materializes the target before reconciling an active Adapter during rollback", async () => {
    const older = generation("generation.active-older", "older\n");
    const newer = generation("generation.active-newer", "newer\n");
    install(newer, [{ id: "adapter.codex", status: "active" }]);
    const live = path.join(root, ".pactile/framework/index.md");
    fs.mkdirSync(path.dirname(live), { recursive: true });
    fs.writeFileSync(live, "newer\n");

    const manager = new PactileExitManager(root, { now: () => occurredAt });
    const planned = manager.planRollback(older.generationId);
    expect(planned.status).toBe("ready");
    if (planned.status !== "ready") throw new Error(planned.reason);
    const result = await manager.applyRollback(planned);
    expect(result.status).toBe("applied");
    expect(fs.readFileSync(live, "utf8")).toBe("older\n");
  });

  it("purges only an unchanged, inactive preview and blocks lock residue", () => {
    const seal = generation("generation.purge");
    install(seal, [{ id: "adapter.cursor", status: "detached" }], "inactive");
    const userState = path.join(root, ".pactile/tasks/user.md");
    fs.mkdirSync(path.dirname(userState), { recursive: true });
    fs.writeFileSync(userState, "first\n");
    let manager = new PactileExitManager(root, { now: () => occurredAt });
    let planned = manager.planPurge();
    expect(planned.status).toBe("ready");
    if (planned.status !== "ready") throw new Error(planned.reason);
    fs.writeFileSync(userState, "changed\n");
    expect(manager.applyPurge(planned, planned.manifestFingerprint)).toEqual({
      status: "conflict",
      reason: "purge-target-set-changed",
    });
    expect(fs.existsSync(path.join(root, ".pactile"))).toBe(true);

    planned = manager.planPurge();
    expect(planned.status).toBe("ready");
    if (planned.status !== "ready") throw new Error(planned.reason);
    expect(manager.applyPurge(planned, "sha256:" + "0".repeat(64))).toEqual({
      status: "review",
      reason: "purge-confirmation-mismatch",
    });
    const applied = manager.applyPurge(planned, planned.manifestFingerprint);
    expect(applied.status).toBe("applied");
    expect(fs.existsSync(path.join(root, ".pactile"))).toBe(false);

    root = fs.mkdtempSync(path.join(os.tmpdir(), "p45-exit-lock-"));
    const lockedSeal = generation("generation.locked");
    install(
      lockedSeal,
      [{ id: "adapter.cursor", status: "detached" }],
      "inactive",
    );
    fs.writeFileSync(path.join(root, ".pactile/runtime/purge.lock"), "busy");
    manager = new PactileExitManager(root, { now: () => occurredAt });
    expect(manager.planPurge()).toEqual({
      status: "review",
      reason: "unsafe-locked-or-malformed-purge-state",
    });
    expect(fs.existsSync(path.join(root, ".pactile"))).toBe(true);
  });

  it("accepts ordinary POSIX-style directory link counts while inventorying purge", () => {
    const seal = generation("generation.posix-directories");
    install(seal, [{ id: "adapter.cursor", status: "detached" }], "inactive");
    const nativeLstat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike) => {
      const stat = nativeLstat(target);
      if (stat.isDirectory()) {
        Object.defineProperty(stat, "nlink", { value: 3 });
      }
      return stat;
    }) as typeof fs.lstatSync);

    expect(
      new PactileExitManager(root, { now: () => occurredAt }).planPurge(),
    ).toMatchObject({ status: "ready" });
  });
});
