import fs from "node:fs";
import path from "node:path";
import {
  parseProjectionPlanV1,
  type CapabilityBindingV1,
} from "../../core/index.js";
import { planBinding } from "../adoption/bindings.js";
import { discoverSnapshot } from "../adoption/inventory.js";
import {
  composeBatch2Plan,
  loadBatch2TileCatalog,
  type PactilePlatform,
} from "../registry.js";
import { BASELINE_TILE_IDS } from "../tiles/content/baseline/index.js";
import type { TileCatalogEntry } from "../tiles/loader.js";
import {
  canonicalOwnershipLedger,
  fingerprintBytes,
  type ProjectionInputs,
} from "../projection/planner.js";
import { renderHostSkill } from "./host-skill-renderer.js";
import type {
  LifecycleAdapter,
  LifecycleProjectionContext,
} from "./orchestrator.js";

function readUtf8(projectRoot: string, relativePath: string): string | null {
  const target = path.join(projectRoot, ...relativePath.split("/"));
  try {
    const bytes = fs.readFileSync(target);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes)) throw new Error("invalid-utf8");
    return text;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

function ownedBindings(
  platform: PactilePlatform,
): Map<string, CapabilityBindingV1> {
  const catalog = loadBatch2TileCatalog();
  if (!catalog.success) throw new Error("bundled-tile-catalog-invalid");
  const selected = catalog.data.entries.filter(({ manifest }) =>
    BASELINE_TILE_IDS.includes(
      manifest.identity.id as (typeof BASELINE_TILE_IDS)[number],
    ),
  );
  const assets = discoverSnapshot({
    context: {
      hostId: platform,
      rootId: "project",
      source: "pactile-bundled",
      scope: "project",
      owner: { kind: "pactile", id: "pactile" },
    },
    assets: selected.map(({ manifest }) => ({
      id: manifest.identity.id,
      kind: "skill" as const,
      locatorToken: manifest.identity.id,
      present: true,
      enabled: true,
    })),
  }).assets;
  const result = new Map<string, CapabilityBindingV1>();
  for (const asset of assets) {
    const proposal = planBinding({
      asset,
      capabilityId: asset.id,
      intents: ["exact"],
    });
    if (!proposal.binding) throw new Error("bundled-binding-invalid");
    result.set(asset.id, proposal.binding);
  }
  return result;
}

function buildProjection(
  projectRoot: string,
  platform: PactilePlatform,
  context: LifecycleProjectionContext,
): ProjectionInputs {
  const catalog = loadBatch2TileCatalog();
  if (!catalog.success) throw new Error("bundled-tile-catalog-invalid");
  const bindings = ownedBindings(platform);
  const selected = catalog.data.entries.filter(({ manifest }) =>
    BASELINE_TILE_IDS.includes(
      manifest.identity.id as (typeof BASELINE_TILE_IDS)[number],
    ),
  );
  const sharedSurfaces = [
    { targetPath: "AGENTS.md", content: readUtf8(projectRoot, "AGENTS.md") },
    ...selected.map(({ manifest }) => ({
      targetPath: `.agents/skills/${manifest.identity.id}/SKILL.md`,
      content: readUtf8(
        projectRoot,
        `.agents/skills/${manifest.identity.id}/SKILL.md`,
      ),
    })),
  ];
  const common = {
    platform,
    catalog: catalog.data,
    selection: {
      requestedSelection: [...BASELINE_TILE_IDS],
      capabilities: [],
    },
    shared: {
      generationId: context.generationId,
      canonicalFingerprint: context.canonicalFingerprint,
      updatedAt: context.occurredAt,
      action: "attach" as const,
      ledger: context.ledger,
      claims: selected.map(({ manifest, skillText }) => ({
        tile: manifest,
        binding: bindings.get(manifest.identity.id),
        skillBody: skillText,
      })),
      surfaces: sharedSurfaces,
    },
  };
  const composed = composeBatch2Plan({
    ...common,
    adapter: {
      appReadiness: "ready",
      composition: [],
      surfaces: [],
    },
  });
  if (
    (composed.status !== "ready" && composed.status !== "degraded") ||
    composed.projection === null
  )
    throw new Error(
      composed.diagnostics[0]?.code ?? "default-adapter-plan-unavailable",
    );
  return withHostSkillFrontmatter(composed.projection, selected);
}

function withHostSkillFrontmatter(
  projection: ProjectionInputs,
  selected: readonly TileCatalogEntry[],
): ProjectionInputs {
  const parsed = parseProjectionPlanV1(projection.plan);
  if (!parsed.success) throw new Error("default-adapter-projection-invalid");

  const byResourceId = new Map(
    selected.map((entry) => [
      `shared.skill.${entry.manifest.identity.id}`,
      entry,
    ]),
  );
  const rendered = new Map<string, Uint8Array>();
  const priorEntries = new Map(
    (projection.ledger === null
      ? []
      : canonicalOwnershipLedger(projection.ledger).ledger.entries
    ).map((entry) => [entry.resourceId, entry]),
  );
  let renderedCount = 0;
  const operations = parsed.data.operations.map((operation) => {
    if (
      !operation.resourceId.startsWith("shared.skill.") ||
      operation.action !== "ensure"
    )
      return operation;
    const tile = byResourceId.get(operation.resourceId);
    if (!tile || operation.contentRef === null)
      throw new Error("default-adapter-skill-operation-invalid");
    const bytes = Buffer.from(
      renderHostSkill(tile.manifest, tile.skillText),
      "utf8",
    );
    const desiredFingerprint = fingerprintBytes(bytes);
    const contentRef = `${operation.resourceId}.${desiredFingerprint.slice(7)}`;
    // Earlier releases do not ship their rendered bodies in the current catalog.
    // Recover only the exact unchanged whole-file bytes proved by the owned ledger.
    const prior = priorEntries.get(operation.resourceId);
    if (
      prior?.origin === "created" &&
      prior.control === "pactile-owned" &&
      prior.owner.kind === "pactile" &&
      prior.format === "text" &&
      prior.targetPath === operation.targetPath &&
      prior.generated.state === "present" &&
      prior.generated.fingerprint !== null &&
      prior.generated.contentRef ===
        `${operation.resourceId}.${prior.generated.fingerprint.slice(7)}`
    ) {
      const observed = projection.observe(prior.targetPath);
      if (
        observed !== null &&
        fingerprintBytes(observed) === prior.generated.fingerprint
      )
        rendered.set(prior.generated.contentRef, Buffer.from(observed));
    }
    rendered.set(contentRef, bytes);
    renderedCount += 1;
    return { ...operation, contentRef, desiredFingerprint };
  });
  if (renderedCount !== selected.length)
    throw new Error("default-adapter-skill-operation-incomplete");

  return {
    ...projection,
    plan: { ...parsed.data, operations },
    resolveContent: (contentRef) => {
      const bytes = rendered.get(contentRef);
      return bytes ? { bytes } : projection.resolveContent(contentRef);
    },
  };
}

/** Build the shipped baseline composition without touching a host surface. */
export function createDefaultLifecycleAdapters(
  projectRoot: string,
  generationId: string,
  runtimeVersion: string,
  platforms: readonly PactilePlatform[],
): readonly LifecycleAdapter[] {
  return [...new Set(platforms)].sort().map(
    (platform): LifecycleAdapter => ({
      adapterId: `adapter.${platform}`,
      adapterVersion: runtimeVersion,
      projectionPlanId: `${platform}.${generationId}`,
      buildProjection: (context) =>
        buildProjection(projectRoot, platform, context),
    }),
  );
}
