import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSnapshot } from "../../../src/pactile/adoption/inventory.js";
import { planBinding } from "../../../src/pactile/adoption/bindings.js";
import {
  BASELINE_TILE_IDS,
  loadBaselineTileContent,
} from "../../../src/pactile/tiles/content/baseline/index.js";
import {
  createDefaultLifecycleAdapters,
  runLifecycleCommand,
} from "../../../src/pactile/lifecycle/index.js";
import { buildSharedProjectionPlan } from "../../../src/pactile/projection/shared/index.js";
import { ProjectionStore } from "../../../src/pactile/projection/store.js";

const runtimeVersion = "0.6.3-beta.0";
const occurredAt = "2026-09-28T04:00:00.000Z";
const roots: string[] = [];

function temporaryRoot(): string {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-host-skills-"));
  roots.push(result);
  return result;
}

afterEach(() => {
  for (const target of roots.splice(0))
    fs.rmSync(target, { recursive: true, force: true });
});

async function initialize(
  projectRoot: string,
  platforms: readonly "codex"[] = ["codex"],
) {
  const result = await runLifecycleCommand({
    projectRoot,
    operation: "init",
    runtimeVersion,
    files: [
      { path: ".version", bytes: Buffer.from(`${runtimeVersion}\n`) },
      { path: "workflow.md", bytes: Buffer.from("# Pactile\n") },
    ],
    platforms,
    occurredAt,
  });
  expect(result.status).toBe("completed");
  if (result.status !== "completed") throw new Error(JSON.stringify(result));
  return result;
}

describe("default lifecycle host skill rendering", () => {
  it("projects all baseline skills with Agent Skills metadata under ledger ownership", async () => {
    const projectRoot = temporaryRoot();
    const result = await initialize(projectRoot);
    const catalog = loadBaselineTileContent();
    if (!catalog.success) throw new Error(JSON.stringify(catalog.diagnostics));
    const byId = new Map(
      catalog.data.map((entry) => [entry.manifest.identity.id, entry]),
    );

    for (const id of BASELINE_TILE_IDS) {
      const entry = byId.get(id);
      if (!entry) throw new Error(`missing baseline tile: ${id}`);
      const pathToSkill = path.join(
        projectRoot,
        ".agents",
        "skills",
        id,
        "SKILL.md",
      );
      const body = fs.readFileSync(pathToSkill, "utf8");
      const frontmatter = `---\nname: ${JSON.stringify(id)}\ndescription: ${JSON.stringify(entry.manifest.summary)}\n---\n\n`;
      expect(body.startsWith(frontmatter)).toBe(true);
      expect(body.slice(frontmatter.length)).toBe(entry.skillText);
    }

    const ledger = new ProjectionStore(projectRoot).readLedger();
    expect(ledger).not.toBeNull();
    for (const id of BASELINE_TILE_IDS) {
      expect(ledger?.ledger.entries).toContainEqual(
        expect.objectContaining({
          resourceId: `shared.skill.${id}`,
          claimants: [expect.objectContaining({ id: "adapter.codex" })],
        }),
      );
    }
    expect(result.installState.state.installedAdapters).toContainEqual(
      expect.objectContaining({ id: "adapter.codex", status: "active" }),
    );
  });

  it("keeps a user-modified skill intact and makes the host projection require review", async () => {
    const projectRoot = temporaryRoot();
    const result = await initialize(projectRoot);
    const projectionStore = new ProjectionStore(projectRoot);
    const ledger = projectionStore.readLedger();
    if (!ledger) throw new Error("missing ownership ledger");

    const id = "approval-personal";
    const skillPath = path.join(
      projectRoot,
      ".agents",
      "skills",
      id,
      "SKILL.md",
    );
    const userBytes = Buffer.from("# User-edited skill\nKeep these changes.\n");
    fs.writeFileSync(skillPath, userBytes);

    const adapter = createDefaultLifecycleAdapters(
      projectRoot,
      result.installState.state.generationId,
      runtimeVersion,
      ["codex"],
    )[0];
    if (!adapter) throw new Error("missing Codex adapter");
    const inputs = await adapter.buildProjection({
      generationId: result.installState.state.generationId,
      canonicalFingerprint: result.generationFingerprint,
      ledger: ledger.ledger,
      ledgerFingerprint: ledger.fingerprint,
      occurredAt,
    });

    expect(projectionStore.inspect(inputs)).toMatchObject({ status: "review" });
    expect(fs.readFileSync(skillPath)).toEqual(userBytes);
  });

  it("upgrades owned bare skill bodies to frontmatter through the existing ledger", async () => {
    const projectRoot = temporaryRoot();
    const result = await initialize(projectRoot, []);
    const loaded = loadBaselineTileContent();
    if (!loaded.success) throw new Error(JSON.stringify(loaded.diagnostics));
    const store = new ProjectionStore(projectRoot);
    const assets = discoverSnapshot({
      context: {
        hostId: "codex",
        rootId: "project",
        source: "pactile-bundled",
        scope: "project",
        owner: { kind: "pactile", id: "pactile" },
      },
      assets: loaded.data.map(({ manifest }) => ({
        id: manifest.identity.id,
        kind: "skill" as const,
        locatorToken: manifest.identity.id,
        present: true,
        enabled: true,
      })),
    }).assets;
    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
    const claims = loaded.data
      .filter(({ manifest }) =>
        BASELINE_TILE_IDS.includes(
          manifest.identity.id as (typeof BASELINE_TILE_IDS)[number],
        ),
      )
      .map((entry) => {
        const asset = assetsById.get(entry.manifest.identity.id);
        if (!asset) throw new Error("missing bundled skill asset");
        const proposal = planBinding({
          asset,
          capabilityId: entry.manifest.identity.id,
          intents: ["exact"],
        });
        if (!proposal.binding) throw new Error("missing owned skill binding");
        return {
          tile: entry.manifest,
          binding: proposal.binding,
          skillBody: entry.skillText,
        };
      });
    const legacy = buildSharedProjectionPlan({
      adapterId: "adapter.codex",
      claimantId: "adapter.codex",
      generationId: result.installState.state.generationId,
      canonicalFingerprint: result.generationFingerprint,
      updatedAt: occurredAt,
      action: "attach",
      ledger: null,
      claims,
      surfaces: [{ targetPath: "AGENTS.md", content: null }],
    });
    if (legacy.status !== "ready")
      throw new Error(JSON.stringify(legacy.diagnostics));
    const legacyPreview = store.inspect(legacy.inputs);
    if (legacyPreview.status !== "ready")
      throw new Error(JSON.stringify(legacyPreview));
    expect(store.apply(legacyPreview).status).toBe("applied");

    const oldLedger = store.readLedger();
    if (!oldLedger) throw new Error("missing legacy ownership ledger");
    const adapter = createDefaultLifecycleAdapters(
      projectRoot,
      result.installState.state.generationId,
      runtimeVersion,
      ["codex"],
    )[0];
    if (!adapter) throw new Error("missing Codex adapter");
    const updatedInputs = await adapter.buildProjection({
      generationId: result.installState.state.generationId,
      canonicalFingerprint: result.generationFingerprint,
      ledger: oldLedger.ledger,
      ledgerFingerprint: oldLedger.fingerprint,
      occurredAt,
    });
    const updatePreview = store.inspect(updatedInputs);
    if (updatePreview.status !== "ready")
      throw new Error(JSON.stringify(updatePreview));
    expect(updatePreview.mutations.map(({ targetPath }) => targetPath)).toEqual(
      expect.arrayContaining(
        BASELINE_TILE_IDS.map((id) => `.agents/skills/${id}/SKILL.md`),
      ),
    );
    expect(store.apply(updatePreview).status).toBe("applied");

    for (const id of BASELINE_TILE_IDS) {
      expect(
        fs.readFileSync(
          path.join(projectRoot, ".agents", "skills", id, "SKILL.md"),
          "utf8",
        ),
      ).toMatch(new RegExp(`^---\\nname: "${id}"\\ndescription: `));
    }
  });
});
