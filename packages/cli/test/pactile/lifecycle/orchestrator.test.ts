import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  OwnershipLedgerV1,
  ProjectionOperationV1,
  ProjectionPlanV1,
} from "../../../src/core/index.js";
import {
  runLifecycleTransaction,
  type LifecycleAdapter,
  type LifecycleProjectionContext,
  type LifecycleRequest,
} from "../../../src/pactile/lifecycle/orchestrator.js";
import {
  fingerprintBytes,
  type ProjectionInputs,
} from "../../../src/pactile/projection/planner.js";
import {
  GenerationStore,
  InstallStateStore,
} from "../../../src/pactile/runtime/stores.js";

const roots: string[] = [];
const occurredAt = "2026-09-10T04:00:00.000Z";
const runtimeVersion = "0.5.0-beta.5";
const sharedBody = Buffer.from(
  "<!-- PACTILE:START -->\nPactile\n<!-- PACTILE:END -->\n",
);

function root(): string {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-lifecycle-"));
  roots.push(result);
  return result;
}

afterEach(() => {
  for (const target of roots.splice(0))
    fs.rmSync(target, { recursive: true, force: true });
});

function currentFingerprint(
  ledger: OwnershipLedgerV1 | null,
  resourceId: string,
): string | null {
  return (
    ledger?.entries.find((entry) => entry.resourceId === resourceId)?.current
      .fingerprint ?? null
  );
}

function projection(
  adapterId: string,
  planId: string,
  context: LifecycleProjectionContext,
): ProjectionInputs {
  const resourceId = "shared.agents.block";
  const operation: ProjectionOperationV1 = {
    id: `${planId}.ensure`,
    resourceId,
    claimantId: adapterId,
    action: "ensure",
    control: "pactile-owned",
    targetPath: "AGENTS.md",
    format: "text",
    contentRef: "shared.agents.v1",
    desiredFingerprint: fingerprintBytes(sharedBody),
    expectedCurrentFingerprint: currentFingerprint(context.ledger, resourceId),
    externalAssetId: null,
  };
  const plan: ProjectionPlanV1 = {
    schemaVersion: 1,
    id: planId,
    adapterId,
    generationId: context.generationId,
    canonicalFingerprint: context.canonicalFingerprint,
    expectedLedgerFingerprint: context.ledgerFingerprint,
    operations: [operation],
  };
  return {
    plan,
    ledger: context.ledger,
    canonicalFingerprint: context.canonicalFingerprint,
    updatedAt: context.occurredAt,
    observe: () => null,
    resolveContent: (contentRef) => {
      if (contentRef !== "shared.agents.v1") throw new Error("unknown-content");
      return { bytes: sharedBody };
    },
  };
}

function adapter(
  name: "cursor" | "codex",
  calls: string[],
  projectRoot: string,
  fail: { value: boolean } = { value: false },
): LifecycleAdapter {
  const adapterId = `adapter.${name}`;
  const projectionPlanId = `projection.${name}`;
  return {
    adapterId,
    adapterVersion: runtimeVersion,
    projectionPlanId,
    buildProjection: (context) => {
      calls.push(adapterId);
      const installed = new InstallStateStore(projectRoot).read();
      if (
        installed?.state.generationId !== context.generationId ||
        installed.state.lastMigrationJournalId === null
      )
        throw new Error("projection-before-canonical-commit");
      if (fail.value) throw new Error("injected-adapter-failure");
      return projection(adapterId, projectionPlanId, context);
    },
  };
}

function freshRequest(
  projectRoot: string,
  adapters: readonly LifecycleAdapter[],
  id = "lifecycle.fresh",
): LifecycleRequest {
  return {
    projectRoot,
    id,
    generationId: "generation.fresh",
    runtimeVersion,
    expectedInstallStateFingerprint: null,
    occurredAt,
    source: {
      kind: "fresh",
      files: [{ path: "workflow.md", bytes: Buffer.from("# Pactile\n") }],
    },
    adapters,
  };
}

describe("Pactile lifecycle coordinator", () => {
  it("accepts distinct generation paths that intentionally share bytes", async () => {
    const projectRoot = root();
    const request: LifecycleRequest = {
      ...freshRequest(projectRoot, []),
      id: "lifecycle.duplicate-bytes",
      source: {
        kind: "fresh",
        files: [
          { path: "spec/api/index.md", bytes: Buffer.from("# Guidelines\n") },
          { path: "spec/web/index.md", bytes: Buffer.from("# Guidelines\n") },
        ],
      },
    };

    const result = await runLifecycleTransaction(request);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error(JSON.stringify(result));
    expect(result.plan.preservation.transformedRefs).toHaveLength(2);
    expect(new Set(result.plan.preservation.transformedRefs).size).toBe(2);
  });

  it("commits canonical state before sorted Adapter writes and repeats without churn", async () => {
    const projectRoot = root();
    const calls: string[] = [];
    const request = freshRequest(projectRoot, [
      adapter("cursor", calls, projectRoot),
      adapter("codex", calls, projectRoot),
    ]);

    const first = await runLifecycleTransaction(request);
    expect(first.status).toBe("completed");
    if (first.status !== "completed") throw new Error(JSON.stringify(first));
    expect(calls).toEqual(["adapter.codex", "adapter.cursor"]);
    expect(
      first.journal.events.findIndex(
        (event) => event.event === "canonical-committed",
      ),
    ).toBeLessThan(
      first.journal.events.findIndex(
        (event) => event.event === "adapter-reconcile-started",
      ),
    );
    expect(first.installState.state.status).toBe("active");
    expect(first.installState.state.installedAdapters).toMatchObject([
      { id: "adapter.codex", status: "active" },
      { id: "adapter.cursor", status: "active" },
    ]);
    const ledger = JSON.parse(
      fs.readFileSync(
        path.join(projectRoot, ".pactile/runtime/ownership-ledger.json"),
        "utf8",
      ),
    ) as OwnershipLedgerV1;
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]?.claimants.map(({ id }) => id)).toEqual([
      "adapter.codex",
      "adapter.cursor",
    ]);
    expect(fs.readFileSync(path.join(projectRoot, "AGENTS.md"))).toEqual(
      sharedBody,
    );

    const before = {
      journal: fs.readFileSync(
        path.join(
          projectRoot,
          ".pactile/runtime/migrations/lifecycle.fresh.json",
        ),
      ),
      install: fs.readFileSync(
        path.join(projectRoot, ".pactile/runtime/install-state.json"),
      ),
      ledger: fs.readFileSync(
        path.join(projectRoot, ".pactile/runtime/ownership-ledger.json"),
      ),
    };
    calls.length = 0;
    const repeated = await runLifecycleTransaction(request);
    expect(repeated.status).toBe("completed");
    expect(repeated.resumed).toBe(true);
    expect(calls).toEqual([]);
    expect(
      fs.readFileSync(
        path.join(
          projectRoot,
          ".pactile/runtime/migrations/lifecycle.fresh.json",
        ),
      ),
    ).toEqual(before.journal);
    expect(
      fs.readFileSync(
        path.join(projectRoot, ".pactile/runtime/install-state.json"),
      ),
    ).toEqual(before.install);
    expect(
      fs.readFileSync(
        path.join(projectRoot, ".pactile/runtime/ownership-ledger.json"),
      ),
    ).toEqual(before.ledger);
  });

  it("reopens a completed journal when a previously applied host surface drifts", async () => {
    const projectRoot = root();
    const calls: string[] = [];
    const request = freshRequest(
      projectRoot,
      [adapter("cursor", calls, projectRoot)],
      "lifecycle.completed-drift",
    );
    const first = await runLifecycleTransaction(request);
    expect(first.status).toBe("completed");
    fs.appendFileSync(path.join(projectRoot, "AGENTS.md"), "user edit\n");

    calls.length = 0;
    const repeated = await runLifecycleTransaction(request);
    expect(repeated.status).toBe("degraded");
    if (repeated.status !== "degraded")
      throw new Error(JSON.stringify(repeated));
    expect(calls).toEqual(["adapter.cursor"]);
    expect(repeated.adapters).toMatchObject([
      {
        adapterId: "adapter.cursor",
        status: "failed",
        attempts: 2,
        reason: "target-cas-mismatch",
      },
    ]);
    expect(
      fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8"),
    ).toContain("user edit");
  });

  it("never removes a lifecycle journal lock it did not acquire", async () => {
    const projectRoot = root();
    const directory = path.join(projectRoot, ".pactile/runtime/migrations");
    fs.mkdirSync(directory, { recursive: true });
    const lock = path.join(directory, "lifecycle.lock-owned.json.lock");
    fs.writeFileSync(lock, "other-process\n");

    const result = await runLifecycleTransaction(
      freshRequest(projectRoot, [], "lifecycle.lock-owned"),
    );
    expect(result).toMatchObject({
      status: "interrupted",
      reason: "canonical-commit-not-completed",
    });
    expect(fs.readFileSync(lock, "utf8")).toBe("other-process\n");
  });

  it("keeps a successful Adapter active when its sibling fails and retries only the failure", async () => {
    const projectRoot = root();
    const calls: string[] = [];
    const codexFailure = { value: true };
    const request = freshRequest(
      projectRoot,
      [
        adapter("cursor", calls, projectRoot),
        adapter("codex", calls, projectRoot, codexFailure),
      ],
      "lifecycle.retry",
    );

    const degraded = await runLifecycleTransaction(request);
    expect(degraded.status).toBe("degraded");
    if (degraded.status !== "degraded")
      throw new Error(JSON.stringify(degraded));
    expect(degraded.adapters).toMatchObject([
      {
        adapterId: "adapter.codex",
        status: "failed",
        attempts: 1,
        reason: "projection-apply-not-completed",
        retryable: true,
      },
      { adapterId: "adapter.cursor", status: "succeeded", attempts: 1 },
    ]);
    expect(degraded.installState.state.status).toBe("degraded");
    expect(
      degraded.installState.state.installedAdapters.find(
        ({ id }) => id === "adapter.cursor",
      )?.status,
    ).toBe("active");

    calls.length = 0;
    codexFailure.value = false;
    const recovered = await runLifecycleTransaction(request);
    expect(recovered.status).toBe("completed");
    if (recovered.status !== "completed")
      throw new Error(JSON.stringify(recovered));
    expect(calls).toEqual(["adapter.codex"]);
    expect(recovered.adapters).toMatchObject([
      { adapterId: "adapter.codex", status: "succeeded", attempts: 2 },
      { adapterId: "adapter.cursor", status: "succeeded", attempts: 1 },
    ]);
    expect(recovered.installState.state.status).toBe("active");
  });

  it("never invokes an Adapter when canonical activation is interrupted and resumes a sealed generation", async () => {
    const projectRoot = root();
    const calls: string[] = [];
    const request = freshRequest(projectRoot, [
      adapter("cursor", calls, projectRoot),
    ]);
    let injected = false;
    const interrupted = await runLifecycleTransaction(request, {
      fault: (phase) => {
        if (phase === "after-stage" && !injected) {
          injected = true;
          throw new Error("injected");
        }
      },
    });
    expect(interrupted.status).toBe("interrupted");
    expect(calls).toEqual([]);
    expect(new InstallStateStore(projectRoot).read()).toBeNull();
    expect(
      new GenerationStore(projectRoot).verify("generation.fresh"),
    ).toMatchObject({
      generationId: "generation.fresh",
    });

    const resumed = await runLifecycleTransaction(request);
    expect(resumed.status).toBe("completed");
    expect(calls).toEqual(["adapter.cursor"]);
  });

  it("updates from the exact active generation and preserves the previous verified generation", async () => {
    const projectRoot = root();
    const first = await runLifecycleTransaction(freshRequest(projectRoot, []));
    expect(first.status).toBe("completed");
    if (first.status !== "completed") throw new Error(JSON.stringify(first));
    const calls: string[] = [];
    const update: LifecycleRequest = {
      projectRoot,
      id: "lifecycle.update",
      generationId: "generation.update",
      runtimeVersion,
      expectedInstallStateFingerprint: first.installState.fingerprint,
      occurredAt,
      source: {
        kind: "canonical",
        generationId: "generation.fresh",
        runtimeVersion,
        schemaVersion: 1,
        files: [{ path: "workflow.md", bytes: Buffer.from("# Pactile v2\n") }],
      },
      adapters: [adapter("cursor", calls, projectRoot)],
    };
    const result = await runLifecycleTransaction(update);
    expect(result.status).toBe("completed");
    expect(
      new GenerationStore(projectRoot).verify("generation.fresh"),
    ).toMatchObject({
      generationId: "generation.fresh",
    });
    expect(
      new GenerationStore(projectRoot).verify("generation.update"),
    ).toMatchObject({
      generationId: "generation.update",
    });
  });

  it("reconciles the already-active generation without restaging or pointer churn", async () => {
    const projectRoot = root();
    const first = await runLifecycleTransaction(freshRequest(projectRoot, []));
    expect(first.status).toBe("completed");
    if (first.status !== "completed") throw new Error(JSON.stringify(first));
    const files = [{ path: "workflow.md", bytes: Buffer.from("# Pactile\n") }];
    const calls: string[] = [];
    const reconcile: LifecycleRequest = {
      projectRoot,
      id: "lifecycle.reconcile",
      generationId: "generation.fresh",
      runtimeVersion,
      expectedInstallStateFingerprint: first.installState.fingerprint,
      occurredAt,
      source: {
        kind: "canonical",
        generationId: "generation.fresh",
        runtimeVersion,
        schemaVersion: 1,
        files,
      },
      adapters: [adapter("cursor", calls, projectRoot)],
    };
    const result = await runLifecycleTransaction(reconcile);
    expect(result.status).toBe("completed");
    expect(calls).toEqual(["adapter.cursor"]);
    expect(
      fs.readdirSync(path.join(projectRoot, ".pactile/runtime/generations")),
    ).toEqual(["g-generation.fresh"]);
  });

  it("delegates explicit cstl import to the legacy transaction without modifying source bytes", async () => {
    const projectRoot = root();
    fs.mkdirSync(path.join(projectRoot, ".cstl"));
    const sourceBytes = Buffer.from("# old workflow\r\n");
    fs.writeFileSync(path.join(projectRoot, ".cstl/workflow.md"), sourceBytes);
    const request: LifecycleRequest = {
      projectRoot,
      id: "lifecycle.import",
      generationId: "generation.import",
      runtimeVersion,
      expectedInstallStateFingerprint: null,
      occurredAt,
      source: {
        kind: "legacy",
        root: ".cstl",
        runtimeVersion: "0.4.3",
        schemaVersion: 1,
        files: [
          {
            sourceRef: "legacy://cstl/workflow.md",
            path: "workflow.md",
            classification: "active",
            sourceBytes,
            bytes: Buffer.from("# Pactile workflow\n"),
            expectedSourceFingerprint: fingerprintBytes(sourceBytes),
          },
        ],
      },
      adapters: [],
    };
    const result = await runLifecycleTransaction(request);
    expect(result.status).toBe("completed");
    expect(
      fs.readFileSync(path.join(projectRoot, ".cstl/workflow.md")),
    ).toEqual(sourceBytes);
    expect(
      fs.existsSync(
        path.join(
          projectRoot,
          ".pactile/runtime/migrations/lifecycle.import.canonical.json",
        ),
      ),
    ).toBe(true);
    expect(
      new GenerationStore(projectRoot).readFile(
        "generation.import",
        "workflow.md",
      ),
    ).toEqual(Buffer.from("# Pactile workflow\n"));
  });

  it("fails closed on trellis takeover and conflicting transaction identity", async () => {
    const projectRoot = root();
    const firstRequest = freshRequest(projectRoot, [], "lifecycle.identity");
    expect((await runLifecycleTransaction(firstRequest)).status).toBe(
      "completed",
    );
    const conflict: LifecycleRequest = {
      ...firstRequest,
      source: {
        kind: "fresh",
        files: [{ path: "workflow.md", bytes: Buffer.from("changed\n") }],
      },
    };
    expect(await runLifecycleTransaction(conflict)).toMatchObject({
      status: "review",
      reason: "lifecycle-plan-conflict",
    });

    const trellis = {
      ...freshRequest(root(), [], "lifecycle.trellis"),
      source: {
        kind: "legacy",
        root: ".trellis",
        runtimeVersion: "0.4.3",
        schemaVersion: 1,
        files: [],
      },
    } as unknown as LifecycleRequest;
    expect(await runLifecycleTransaction(trellis)).toMatchObject({
      status: "review",
      reason: "invalid-lifecycle-request",
    });
  });
});
