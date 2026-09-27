import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PactileExitManager } from "../../../../src/pactile/exit/service.js";
import {
  createDefaultLifecycleAdapters,
  runLifecycleCommand,
  runLifecycleTransaction,
  type LifecycleGenerationFile,
  type LifecycleRequest,
} from "../../../../src/pactile/lifecycle/index.js";
import {
  fingerprintBytes,
  type ProjectionInputs,
} from "../../../../src/pactile/projection/planner.js";
import { ProjectionStore } from "../../../../src/pactile/projection/store.js";
import {
  GenerationStore,
  InstallStateStore,
} from "../../../../src/pactile/runtime/stores.js";
import {
  lifecycleConformanceCases,
  type LifecycleConformanceCase,
} from "./cases.js";

const runtimeVersion = "0.5.0-beta.5";
const occurredAt = "2026-09-11T02:00:00.000Z";
const roots: string[] = [];
const versionOne: readonly LifecycleGenerationFile[] = [
  { path: ".version", bytes: Buffer.from(`${runtimeVersion}\n`) },
  { path: "workflow.md", bytes: Buffer.from("# Pactile v1\n") },
];
const versionTwo: readonly LifecycleGenerationFile[] = [
  { path: ".version", bytes: Buffer.from(`${runtimeVersion}\n`) },
  { path: "workflow.md", bytes: Buffer.from("# Pactile v2\n") },
];

function temporaryRoot(label: string): string {
  const result = fs.mkdtempSync(
    path.join(os.tmpdir(), `pactile-lifecycle-conformance-${label}-`),
  );
  roots.push(result);
  return result;
}

afterEach(() => {
  for (const target of roots.splice(0))
    fs.rmSync(target, { recursive: true, force: true });
});

async function initialize(
  projectRoot: string,
  platforms: readonly "codex"[] = [],
  files: readonly LifecycleGenerationFile[] = versionOne,
) {
  const result = await runLifecycleCommand({
    projectRoot,
    operation: "init",
    runtimeVersion,
    files,
    platforms,
    occurredAt,
  });
  expect(result.status).toBe("completed");
  if (result.status !== "completed") throw new Error(JSON.stringify(result));
  return result;
}

function readInstall(projectRoot: string) {
  const snapshot = new InstallStateStore(projectRoot).read();
  if (!snapshot) throw new Error("missing install state");
  return snapshot;
}

async function executeCase(testCase: LifecycleConformanceCase): Promise<void> {
  const projectRoot = temporaryRoot(testCase.id.replaceAll(".", "-"));

  switch (testCase.id) {
    case "fresh.init": {
      const result = await initialize(projectRoot);
      expect(result.installState.state.canonicalRoot).toBe(".pactile");
      expect(
        new GenerationStore(projectRoot).readFile(
          result.installState.state.generationId,
          "workflow.md",
        ),
      ).toEqual(Buffer.from("# Pactile v1\n"));
      return;
    }

    case "legacy.import": {
      const legacyPath = path.join(projectRoot, ".cstl/workflow.md");
      const legacyBytes = Buffer.from("# legacy workflow\r\n");
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      fs.writeFileSync(legacyPath, legacyBytes);
      const result = await runLifecycleCommand({
        projectRoot,
        operation: "import",
        runtimeVersion,
        files: versionOne,
        platforms: [],
        occurredAt,
        legacy: {
          runtimeVersion: "0.4.3",
          schemaVersion: 1,
          files: [
            {
              sourceRef: "legacy://cstl/workflow.md",
              path: "workflow.md",
              classification: "active",
              sourceBytes: legacyBytes,
              bytes: Buffer.from("# Pactile v1\n"),
              expectedSourceFingerprint: fingerprintBytes(legacyBytes),
            },
          ],
        },
      });
      expect(result.status).toBe("completed");
      expect(fs.readFileSync(legacyPath)).toEqual(legacyBytes);
      if (result.status !== "completed")
        throw new Error(JSON.stringify(result));
      expect(
        new GenerationStore(projectRoot).readFile(
          result.installState.state.generationId,
          "workflow.md",
        ),
      ).toEqual(Buffer.from("# Pactile v1\n"));
      return;
    }

    case "mixed.update": {
      await initialize(projectRoot);
      const legacyPath = path.join(projectRoot, ".cstl/user-owned.md");
      const legacyBytes = Buffer.from("keep legacy bytes\r\n");
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      fs.writeFileSync(legacyPath, legacyBytes);
      const beforeGeneration = readInstall(projectRoot).state.generationId;
      const result = await runLifecycleCommand({
        projectRoot,
        operation: "update",
        runtimeVersion,
        files: versionTwo,
        platforms: [],
        occurredAt,
      });
      expect(result.status).toBe("completed");
      if (result.status !== "completed")
        throw new Error(JSON.stringify(result));
      expect(result.installState.state.generationId).not.toBe(beforeGeneration);
      expect(fs.readFileSync(legacyPath)).toEqual(legacyBytes);
      return;
    }

    case "repeat.reconcile": {
      const initialized = await initialize(projectRoot);
      const first = await runLifecycleCommand({
        projectRoot,
        operation: "reconcile",
        runtimeVersion,
        files: versionOne,
        platforms: [],
        occurredAt,
      });
      const second = await runLifecycleCommand({
        projectRoot,
        operation: "reconcile",
        runtimeVersion,
        files: versionOne,
        platforms: [],
        occurredAt,
      });
      expect(first.status).toBe("completed");
      expect(second.status).toBe("completed");
      if (first.status !== "completed" || second.status !== "completed")
        throw new Error("reconcile did not complete");
      expect(first.installState.state.generationId).toBe(
        initialized.installState.state.generationId,
      );
      expect(second.installState.fingerprint).toBe(
        first.installState.fingerprint,
      );
      expect(second.resumed).toBe(true);
      return;
    }

    case "modified.detach": {
      await initialize(projectRoot, ["codex"]);
      const agentsPath = path.join(projectRoot, "AGENTS.md");
      fs.appendFileSync(agentsPath, "user-owned-tail\n");
      const manager = new PactileExitManager(projectRoot, {
        now: () => occurredAt,
      });
      const plan = manager.planDetach("adapter.codex");
      expect(plan.status).toBe("ready");
      if (plan.status !== "ready") throw new Error(plan.reason);
      expect(plan.preview.decisions).toContainEqual(
        expect.objectContaining({ disposition: "preserve-modified" }),
      );
      expect(manager.applyDetach(plan).status).toBe("applied");
      expect(fs.readFileSync(agentsPath, "utf8")).toContain("user-owned-tail");
      return;
    }

    case "borrowed.detach": {
      const initialized = await initialize(projectRoot, ["codex"]);
      const assetPath = path.join(projectRoot, "native-skill.txt");
      fs.writeFileSync(assetPath, "external body must stay\n");
      const store = new ProjectionStore(projectRoot);
      const ledger = store.readLedger();
      const input: ProjectionInputs = {
        plan: {
          schemaVersion: 1,
          id: "conformance.borrowed.bind",
          adapterId: "adapter.codex",
          generationId: initialized.installState.state.generationId,
          canonicalFingerprint: initialized.generationFingerprint,
          expectedLedgerFingerprint: ledger?.fingerprint ?? null,
          operations: [
            {
              id: "conformance.borrowed.bind.operation",
              resourceId: "conformance.native-skill",
              claimantId: "adapter.codex",
              action: "bind",
              control: "borrowed",
              targetPath: null,
              format: "external-ref",
              contentRef: null,
              desiredFingerprint: null,
              expectedCurrentFingerprint: null,
              externalAssetId: "native-skill-id",
            },
          ],
        },
        ledger: ledger?.ledger ?? null,
        canonicalFingerprint: initialized.generationFingerprint,
        updatedAt: occurredAt,
        observe: () => null,
        resolveContent: () => {
          throw new Error("borrowed bodies must not be resolved");
        },
      };
      const preview = store.inspect(input);
      expect(preview.status).toBe("ready");
      if (preview.status !== "ready") throw new Error(preview.reason);
      expect(store.apply(preview).status).toBe("applied");
      const manager = new PactileExitManager(projectRoot, {
        now: () => occurredAt,
        projectionStore: store,
      });
      const plan = manager.planDetach("adapter.codex");
      expect(plan.status).toBe("ready");
      if (plan.status !== "ready") throw new Error(plan.reason);
      expect(manager.applyDetach(plan).status).toBe("applied");
      expect(fs.readFileSync(assetPath, "utf8")).toBe(
        "external body must stay\n",
      );
      expect(store.readExternalClaims().claims).toContainEqual({
        resourceId: "conformance.native-skill",
        externalAssetId: "native-skill-id",
        claimants: [],
      });
      return;
    }

    case "safe.uninstall": {
      await initialize(projectRoot, ["codex"]);
      const userPath = path.join(projectRoot, ".pactile/spec/user-owned.md");
      fs.mkdirSync(path.dirname(userPath), { recursive: true });
      fs.writeFileSync(userPath, "keep me\n");
      const result = new PactileExitManager(projectRoot, {
        now: () => occurredAt,
      }).uninstall();
      expect(result.status, JSON.stringify(result)).toBe("applied");
      expect(readInstall(projectRoot).state.status).toBe("inactive");
      expect(fs.readFileSync(userPath, "utf8")).toBe("keep me\n");
      return;
    }

    case "sealed.rollback": {
      const initial = await initialize(projectRoot);
      const updated = await runLifecycleCommand({
        projectRoot,
        operation: "update",
        runtimeVersion,
        files: versionTwo,
        platforms: [],
        occurredAt,
      });
      expect(updated.status).toBe("completed");
      if (updated.status !== "completed")
        throw new Error(JSON.stringify(updated));
      const manager = new PactileExitManager(projectRoot, {
        now: () => occurredAt,
      });
      const plan = manager.planRollback(
        initial.installState.state.generationId,
      );
      expect(plan.status).toBe("ready");
      if (plan.status !== "ready") throw new Error(plan.reason);
      expect((await manager.applyRollback(plan)).status).toBe("applied");
      expect(readInstall(projectRoot).state.generationId).toBe(
        initial.installState.state.generationId,
      );
      expect(
        fs.readFileSync(path.join(projectRoot, ".pactile/workflow.md"), "utf8"),
      ).toBe("# Pactile v1\n");
      expect(
        new GenerationStore(projectRoot).verify(
          updated.installState.state.generationId,
        ).generationId,
      ).toBe(updated.installState.state.generationId);
      return;
    }

    case "detached.reinstall": {
      await initialize(projectRoot, ["codex"]);
      const manager = new PactileExitManager(projectRoot, {
        now: () => occurredAt,
      });
      const uninstall = manager.uninstall();
      expect(uninstall.status, JSON.stringify(uninstall)).toBe("applied");
      expect(readInstall(projectRoot).state.status).toBe("inactive");
      const result = await runLifecycleCommand({
        projectRoot,
        operation: "reconcile",
        runtimeVersion,
        files: versionOne,
        platforms: ["codex"],
        occurredAt,
      });
      expect(result.status).toBe("completed");
      expect(readInstall(projectRoot).state).toMatchObject({
        status: "active",
        installedAdapters: [
          { id: "adapter.codex", status: "active" },
        ],
      });
      expect(fs.existsSync(path.join(projectRoot, "AGENTS.md"))).toBe(true);
      return;
    }

    case "stale.purge-preview": {
      await initialize(projectRoot, ["codex"]);
      const manager = new PactileExitManager(projectRoot, {
        now: () => occurredAt,
      });
      expect(manager.uninstall().status).toBe("applied");
      const userPath = path.join(projectRoot, ".pactile/tasks/user.md");
      fs.mkdirSync(path.dirname(userPath), { recursive: true });
      fs.writeFileSync(userPath, "before\n");
      const plan = manager.planPurge();
      expect(plan.status).toBe("ready");
      if (plan.status !== "ready") throw new Error(plan.reason);
      fs.writeFileSync(userPath, "after\n");
      expect(manager.applyPurge(plan, plan.manifestFingerprint)).toEqual({
        status: "conflict",
        reason: "purge-target-set-changed",
      });
      expect(fs.readFileSync(userPath, "utf8")).toBe("after\n");
      return;
    }

    case "fault.before-canonical-commit": {
      const request: LifecycleRequest = {
        projectRoot,
        id: "conformance.before-canonical-commit",
        generationId: "generation.before-canonical-commit",
        runtimeVersion,
        expectedInstallStateFingerprint: null,
        occurredAt,
        source: { kind: "fresh", files: versionOne },
        adapters: createDefaultLifecycleAdapters(
          projectRoot,
          "generation.before-canonical-commit",
          runtimeVersion,
          ["codex"],
        ),
      };
      const calls: string[] = [];
      const interrupted = await runLifecycleTransaction(request, {
        fault: (phase, adapterId) => {
          calls.push(adapterId ? `${phase}:${adapterId}` : phase);
          if (phase === "before-canonical-commit") throw new Error("injected");
        },
      });
      expect(interrupted).toMatchObject({
        status: "interrupted",
        reason: "canonical-commit-not-completed",
      });
      expect(new InstallStateStore(projectRoot).read()).toBeNull();
      expect(calls.some((value) => value.startsWith("before-adapter"))).toBe(
        false,
      );
      expect((await runLifecycleTransaction(request)).status).toBe("completed");
      return;
    }

    case "fault.adapter-retry": {
      const generationId = "generation.adapter-retry";
      const request: LifecycleRequest = {
        projectRoot,
        id: "conformance.adapter-retry",
        generationId,
        runtimeVersion,
        expectedInstallStateFingerprint: null,
        occurredAt,
        source: { kind: "fresh", files: versionOne },
        adapters: createDefaultLifecycleAdapters(
          projectRoot,
          generationId,
          runtimeVersion,
          ["codex"],
        ),
      };
      let injected = false;
      const degraded = await runLifecycleTransaction(request, {
        fault: (phase, adapterId) => {
          if (
            phase === "before-adapter" &&
            adapterId === "adapter.codex" &&
            !injected
          ) {
            injected = true;
            throw new Error("injected-adapter-failure");
          }
        },
      });
      expect(degraded.status).toBe("degraded");
      if (degraded.status !== "degraded")
        throw new Error(JSON.stringify(degraded));
      expect(degraded.adapters).toEqual([
        expect.objectContaining({
          adapterId: "adapter.codex",
          status: "failed",
          attempts: 1,
          retryable: true,
        }),
      ]);
      const recovered = await runLifecycleTransaction(request);
      expect(recovered.status).toBe("completed");
      if (recovered.status !== "completed")
        throw new Error(JSON.stringify(recovered));
      expect(recovered.adapters).toEqual([
        expect.objectContaining({
          adapterId: "adapter.codex",
          status: "succeeded",
          attempts: 2,
        }),
      ]);
      return;
    }
  }
}

describe("Pactile lifecycle conformance matrix", () => {
  it("covers every required origin, operation, ownership class, and recovery phase", () => {
    expect(
      new Set(lifecycleConformanceCases.map(({ origin }) => origin)),
    ).toEqual(new Set(["fresh", "legacy", "mixed", "canonical"]));
    expect(
      new Set(lifecycleConformanceCases.map(({ operation }) => operation)),
    ).toEqual(
      new Set([
        "init",
        "import",
        "update",
        "reconcile",
        "detach",
        "uninstall",
        "rollback",
        "reinstall",
        "purge",
      ]),
    );
    const ownership = new Set(
      lifecycleConformanceCases.map(({ ownership }) => ownership),
    );
    for (const required of [
      "pactile-owned",
      "foreign",
      "modified",
      "borrowed",
      "user-state",
      "sealed-generation",
    ])
      expect(ownership, `missing ownership row: ${required}`).toContain(
        required,
      );
    expect(
      new Set(lifecycleConformanceCases.map(({ faultPhase }) => faultPhase)),
    ).toEqual(
      new Set([
        "none",
        "after-preview",
        "before-canonical-commit",
        "before-adapter",
      ]),
    );
  });

  it.each(lifecycleConformanceCases)("$id => $expected", executeCase);
});
