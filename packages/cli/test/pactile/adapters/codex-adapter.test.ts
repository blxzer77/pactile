import { describe, expect, it } from "vitest";
import type { CapabilityBindingV1 } from "../../../src/core/index.js";
import { buildCodexProjectionPlan } from "../../../src/pactile/adapters/codex/index.js";
import { planBinding } from "../../../src/pactile/adoption/bindings.js";
import { discoverSnapshot } from "../../../src/pactile/adoption/inventory.js";
import { fingerprintBytes, planProjection } from "../../../src/pactile/projection/planner.js";
import { buildSharedProjectionPlan } from "../../../src/pactile/projection/shared/index.js";
import { loadBaselineTileContent } from "../../../src/pactile/tiles/content/baseline/index.js";

function ownedSkill(): CapabilityBindingV1 {
  const asset = discoverSnapshot({
    context: {
      hostId: "codex",
      rootId: "project",
      source: "pactile-bundled",
      scope: "project",
      owner: { kind: "pactile", id: "pactile" },
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
  const proposal = planBinding({
    asset,
    capabilityId: "intake-basic",
    intents: ["exact"],
  });
  if (!proposal.binding) throw new Error(JSON.stringify(proposal));
  return proposal.binding;
}

function shared(action: "attach" | "detach" = "attach") {
  const loaded = loadBaselineTileContent();
  if (!loaded.success) throw new Error(JSON.stringify(loaded.diagnostics));
  const tile = loaded.data.find(
    ({ manifest }) => manifest.identity.id === "intake-basic",
  );
  if (!tile) throw new Error("missing fixture Tile");
  const result = buildSharedProjectionPlan({
    adapterId: "adapter.codex",
    claimantId: "adapter.codex",
    generationId: "generation-b2",
    canonicalFingerprint: fingerprintBytes("canonical"),
    updatedAt: "2026-09-10T00:00:00.000Z",
    action,
    ledger: null,
    claims: [
      {
        tile: tile.manifest,
        binding: ownedSkill(),
        ...(action === "attach" ? { skillBody: tile.skillText } : {}),
      },
    ],
    surfaces: [{ targetPath: "AGENTS.md", content: null }],
  });
  if (result.status !== "ready") throw new Error(JSON.stringify(result));
  return result.inputs;
}

describe("Codex ChatGPT desktop App projection seam", () => {
  it("uses shared-first plus explicit project fragments and native provider binding", () => {
    const built = buildCodexProjectionPlan({
      shared: shared(),
      appReadiness: "ready",
      supportsProjectConfig: true,
      supportsHooks: true,
      composition: ["project-config", "hooks", "mcp"],
      providerIds: ["provider.local"],
      projectConfig: {
        content: "project_timeout = 15\n",
        ownedTomlKeys: [{ table: [], key: "project_timeout" }],
      },
      projectHooks: {
        content: '{"hooks":{"UserPromptSubmit":[]}}',
        ownedJsonPointers: ["/hooks"],
      },
      surfaces: [
        {
          targetPath: ".codex/config.toml",
          content: 'model = "user-choice"\n[user]\nkeep = true\n',
        },
        { targetPath: ".codex/hooks.json", content: '{"unknown":{"keep":true}}' },
      ],
    });
    expect(built.status).toBe("ready");
    if (built.status !== "ready") throw new Error(JSON.stringify(built));
    expect(built.probeHints).toEqual([
      { channel: "app", readiness: "ready", code: "available" },
    ]);
    const preview = planProjection(built.inputs);
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error(JSON.stringify(preview));
    const config = Buffer.from(
      preview.mutations.find(({ targetPath }) => targetPath === ".codex/config.toml")
        ?.bytes ?? [],
    ).toString();
    expect(config).toContain('model = "user-choice"');
    expect(config).toContain("[user]\nkeep = true");
    expect(config).toContain("project_timeout = 15");
    const hooks = JSON.parse(
      Buffer.from(
        preview.mutations.find(({ targetPath }) => targetPath === ".codex/hooks.json")
          ?.bytes ?? [],
      ).toString(),
    ) as { unknown: { keep: boolean } };
    expect(hooks.unknown.keep).toBe(true);
    expect(preview.externalClaims).toEqual([
      {
        resourceId: "codex.native.mcp.provider.local",
        externalAssetId: "provider.local",
        claimants: ["adapter.codex"],
      },
    ]);
    const serialized = JSON.stringify({ plan: built.inputs.plan, hints: built.probeHints });
    expect(serialized).not.toMatch(
      /\.codex\/(?:channel|global)|\[pactile\]|provider_ids|[a-z]:[\\/]|secret|token|oauth|probeChannels/i,
    );
  });

  it("keeps the default overlay empty and reports App-only degradation", () => {
    const minimal = buildCodexProjectionPlan({
      shared: shared(),
      appReadiness: "degraded",
      composition: [],
    });
    expect(minimal.status).toBe("degraded");
    if (minimal.status !== "degraded") throw new Error(JSON.stringify(minimal));
    expect(minimal.probeHints).toEqual([
      { channel: "app", readiness: "degraded", code: "host-degraded" },
    ]);
    const preview = planProjection(minimal.inputs);
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error(JSON.stringify(preview));
    expect(preview.mutations.map(({ targetPath }) => targetPath)).toEqual([
      "AGENTS.md",
      ".agents/skills/intake-basic/SKILL.md",
    ]);

    const missing = buildCodexProjectionPlan({
      shared: shared(),
      appReadiness: "ready",
      supportsProjectConfig: true,
      composition: ["project-config"],
    });
    expect(missing.status).toBe("degraded");
    if (missing.status !== "degraded") throw new Error(JSON.stringify(missing));
    expect(missing.diagnostics).toEqual([
      { code: "native-binding-required", capability: "project-config" },
    ]);
  });

  it("represents native hook ids as borrowed attach and detach claims", () => {
    for (const action of ["attach", "detach"] as const) {
      const built = buildCodexProjectionPlan({
        shared: shared(action),
        appReadiness: "ready",
        supportsHooks: true,
        composition: ["hooks"],
        nativeBindings: { hooks: ["codex-hook"] },
      });
      expect(built.status).toBe("ready");
      if (built.status !== "ready") throw new Error(JSON.stringify(built));
      expect(
        built.inputs.plan.operations.find(
          ({ resourceId }) =>
            resourceId === "codex.native.hooks.codex-hook",
        ),
      ).toMatchObject({
        action: action === "attach" ? "bind" : "detach",
        control: "borrowed",
        format: "external-ref",
        externalAssetId: "codex-hook",
      });
    }
  });
});
