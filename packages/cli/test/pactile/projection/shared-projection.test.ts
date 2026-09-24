import { describe, expect, it } from "vitest";
import type { CapabilityBindingV1 } from "../../../src/core/index.js";
import { discoverSnapshot } from "../../../src/pactile/adoption/inventory.js";
import { planBinding } from "../../../src/pactile/adoption/bindings.js";
import { fingerprintBytes, planProjection } from "../../../src/pactile/projection/planner.js";
import { buildSharedProjectionPlan } from "../../../src/pactile/projection/shared/index.js";
import { loadBaselineTileContent } from "../../../src/pactile/tiles/content/baseline/index.js";

const canonicalFingerprint = fingerprintBytes("canonical");
const updatedAt = "2026-09-10T00:00:00.000Z";

function binding(source: "pactile-bundled" | "host-native"): CapabilityBindingV1 {
  const asset = discoverSnapshot({
    context: {
      hostId: "test-host",
      rootId: "skills",
      source,
      scope: source === "host-native" ? "host" : "project",
      owner:
        source === "host-native"
          ? { kind: "host", id: "test-host" }
          : { kind: "pactile", id: "pactile" },
    },
    assets: [
      {
        id: "intake-basic",
        kind: "skill",
        locatorToken: "intake-basic",
        present: true,
        enabled: true,
      },
    ],
  }).assets[0];
  const proposed = planBinding({
    asset,
    capabilityId: "intake-basic",
    intents: ["exact"],
  });
  if (!proposed.binding) throw new Error(JSON.stringify(proposed));
  return proposed.binding;
}

function request(
  claimBinding: CapabilityBindingV1,
  overrides: Record<string, unknown> = {},
) {
  const loaded = loadBaselineTileContent();
  if (!loaded.success) throw new Error(JSON.stringify(loaded.diagnostics));
  const tile = loaded.data.find(
    ({ manifest }) => manifest.identity.id === "intake-basic",
  );
  if (!tile) throw new Error("missing fixture Tile");
  return {
    adapterId: "adapter.cursor",
    claimantId: "adapter.cursor",
    generationId: "generation-b2",
    canonicalFingerprint,
    updatedAt,
    action: "attach" as const,
    ledger: null,
    claims: [
      {
        tile: tile.manifest,
        binding: claimBinding,
        ...(claimBinding.control === "pactile-owned"
          ? { skillBody: tile.skillText }
          : {}),
      },
    ],
    surfaces: [{ targetPath: "AGENTS.md", content: "user heading\n" }],
    ...overrides,
  };
}

describe("shared projection public seam", () => {
  it("plans owned, borrowed, foreign, multi-claimant, and borrowed detach without taking foreign ownership", () => {
    const owned = binding("pactile-bundled");
    const borrowed = binding("host-native");

    const ownedBuild = buildSharedProjectionPlan(request(owned));
    expect(ownedBuild.status).toBe("ready");
    if (ownedBuild.status !== "ready") throw new Error(JSON.stringify(ownedBuild));
    const first = planProjection(ownedBuild.inputs);
    expect(first.status).toBe("ready");
    if (first.status !== "ready") throw new Error(JSON.stringify(first));
    expect(first.mutations).toHaveLength(2);
    const agents = first.mutations.find(({ targetPath }) => targetPath === "AGENTS.md");
    expect(Buffer.from(agents?.bytes ?? []).toString()).toMatch(
      /^user heading\n+<!-- PACTILE:START -->[\s\S]*<!-- PACTILE:END -->\n$/,
    );

    const foreignBuild = buildSharedProjectionPlan(
      request(owned, {
        surfaces: [
          { targetPath: "AGENTS.md", content: "user heading\n" },
          {
            targetPath: ".agents/skills/intake-basic/SKILL.md",
            content: "# User-owned skill\n",
          },
        ],
      }),
    );
    expect(foreignBuild.status).toBe("ready");
    if (foreignBuild.status !== "ready") throw new Error(JSON.stringify(foreignBuild));
    expect(planProjection(foreignBuild.inputs)).toEqual({
      status: "review",
      reason: "whole-file-not-owned",
    });

    const borrowedBuild = buildSharedProjectionPlan(request(borrowed));
    expect(borrowedBuild.status).toBe("ready");
    if (borrowedBuild.status !== "ready") throw new Error(JSON.stringify(borrowedBuild));
    const borrowedPreview = planProjection(borrowedBuild.inputs);
    expect(borrowedPreview.status).toBe("ready");
    if (borrowedPreview.status !== "ready")
      throw new Error(JSON.stringify(borrowedPreview));
    expect(borrowedPreview.mutations.map(({ targetPath }) => targetPath)).toEqual([
      "AGENTS.md",
    ]);
    expect(borrowedPreview.externalClaims).toEqual([
      {
        resourceId: "shared.skill.intake-basic",
        externalAssetId: "intake-basic",
        claimants: ["adapter.cursor"],
      },
    ]);

    const surfaces = first.mutations.map(({ targetPath, bytes }) => ({
      targetPath,
      content: bytes === null ? null : Buffer.from(bytes).toString(),
    }));
    const secondBuild = buildSharedProjectionPlan(
      request(owned, {
        adapterId: "adapter.codex",
        claimantId: "adapter.codex",
        ledger: first.ledger,
        surfaces,
      }),
    );
    expect(secondBuild.status).toBe("ready");
    if (secondBuild.status !== "ready") throw new Error(JSON.stringify(secondBuild));
    const second = planProjection(secondBuild.inputs);
    expect(second.status).toBe("ready");
    if (second.status !== "ready") throw new Error(JSON.stringify(second));
    expect(second.mutations).toEqual([]);
    expect(
      second.ledger.entries.every(({ claimants }) => claimants.length === 2),
    ).toBe(true);

    const detachBuild = buildSharedProjectionPlan(
      request(borrowed, {
        action: "detach",
        externalClaims: borrowedPreview.externalClaims,
        surfaces: [
          {
            targetPath: "AGENTS.md",
            content: Buffer.from(
              borrowedPreview.mutations.find(({ targetPath }) => targetPath === "AGENTS.md")
                ?.bytes ?? [],
            ).toString(),
          },
        ],
        ledger: borrowedPreview.ledger,
      }),
    );
    expect(detachBuild.status).toBe("ready");
    if (detachBuild.status !== "ready") throw new Error(JSON.stringify(detachBuild));
    const detached = planProjection(detachBuild.inputs);
    expect(detached.status).toBe("ready");
    if (detached.status !== "ready") throw new Error(JSON.stringify(detached));
    expect(detached.externalClaims).toEqual([
      {
        resourceId: "shared.skill.intake-basic",
        externalAssetId: "intake-basic",
        claimants: [],
      },
    ]);
    expect(
      detached.mutations.some(
        ({ targetPath }) => targetPath === ".agents/skills/intake-basic/SKILL.md",
      ),
    ).toBe(false);
  });
});
