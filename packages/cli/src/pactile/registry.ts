import {
  parseCapabilityBindingV1,
  parseTileManifestV1,
} from "@blxzer/pactile-core";
import type {
  CompiledComposition,
  TileCompositionRequest,
} from "./tiles/compiler.js";
import { compileTileComposition } from "./tiles/compiler.js";
import {
  buildTileCatalog,
  type TileCatalog,
} from "./tiles/catalog.js";
import {
  loadBaselineTileContent,
} from "./tiles/content/baseline/index.js";
import {
  loadOndemandTileContent,
} from "./tiles/content/ondemand/index.js";
import {
  buildSharedProjectionPlan,
  type SharedProjectionRequest,
} from "./projection/shared/index.js";
import {
  buildCodexProjectionPlan,
  type CodexProjectionRequest,
  type CodexProjectionResult,
} from "./adapters/codex/index.js";
import type {
  ProjectionInputs,
} from "./projection/planner.js";
import {
  tileFingerprint,
  type TileResult,
} from "./tiles/loader.js";

/** The adapters that Pactile can compose in this batch. */
export const PACTILE_PLATFORM_REGISTRY = {
  codex: {
    platform: "codex",
    adapterId: "adapter.codex",
    host: "chatgpt-desktop-app",
    capabilities: ["project-config", "hooks", "mcp"],
  },
} as const;

export type PactilePlatform = keyof typeof PACTILE_PLATFORM_REGISTRY;
export type PactilePlatformDescriptor =
  (typeof PACTILE_PLATFORM_REGISTRY)[PactilePlatform];

export function listPactilePlatforms(): readonly PactilePlatformDescriptor[] {
  return [PACTILE_PLATFORM_REGISTRY.codex];
}

export function getPactilePlatform(
  platform: string,
): PactilePlatformDescriptor | null {
  if (platform === "codex") return PACTILE_PLATFORM_REGISTRY.codex;
  return null;
}

/** Load and validate the twenty bundled B2 Tiles through the existing loader. */
export function loadBatch2TileCatalog(): TileResult<TileCatalog> {
  const baseline = loadBaselineTileContent();
  const ondemand = loadOndemandTileContent();
  if (!baseline.success || !ondemand.success)
    return {
      success: false,
      diagnostics: [
        ...(baseline.success ? [] : baseline.diagnostics),
        ...(ondemand.success ? [] : ondemand.diagnostics),
      ],
    };
  return buildTileCatalog([...baseline.data, ...ondemand.data]);
}

export interface Batch2ComposeRequest {
  readonly platform: PactilePlatform;
  readonly catalog: TileCatalog;
  readonly selection: TileCompositionRequest;
  /** Shared request without the platform-derived adapter/claimant ids. */
  readonly shared: Omit<SharedProjectionRequest, "adapterId" | "claimantId">;
  readonly adapter: Omit<CodexProjectionRequest, "shared">;
}

export type Batch2DiagnosticCode =
  | "invalid-platform"
  | "tile-selection-invalid"
  | "selection-claim-mismatch"
  | "shared-review"
  | "adapter-unsupported"
  | "adapter-review"
  | "adapter-degraded";

export interface Batch2Diagnostic {
  readonly code: Batch2DiagnosticCode;
  readonly detail?: string;
}

export type Batch2ComposeResult =
  | {
      readonly status: "ready" | "degraded";
      readonly platform: PactilePlatform;
      readonly adapterId: string;
      readonly composition: CompiledComposition;
      readonly projection: ProjectionInputs;
      readonly diagnostics: readonly Batch2Diagnostic[];
    }
  | {
      readonly status: "unsupported" | "review";
      readonly platform: PactilePlatform | null;
      readonly adapterId: string | null;
      readonly composition: CompiledComposition | null;
      readonly projection: null;
      readonly diagnostics: readonly Batch2Diagnostic[];
    };

function tileFailure(
  code: "tile-selection-invalid" | "shared-review",
  platform: PactilePlatform,
  adapterId: string,
  detail?: string,
): Batch2ComposeResult {
  return {
    status: "review",
    platform,
    adapterId,
    composition: null,
    projection: null,
    diagnostics: [{ code, ...(detail ? { detail } : {}) }],
  };
}

/**
 * Bind the model-owned composition to the exact shared claims that will be
 * projected. Borrowed Skills may have a different host asset id, but their
 * logical capability and Tile manifest must still match the composition.
 * Pactile-owned bodies additionally have to reproduce the catalog fingerprint.
 */
function claimsMatchComposition(
  composition: CompiledComposition,
  claims: SharedProjectionRequest["claims"],
): boolean {
  try {
    if (!Array.isArray(claims) || claims.length !== composition.tiles.length)
      return false;
    const expected = new Map(composition.tiles.map((tile) => [tile.ref, tile]));
    const seen = new Set<string>();
    for (const claim of claims) {
      const tile = parseTileManifestV1(claim.tile);
      const binding = parseCapabilityBindingV1(claim.binding);
      if (
        !tile.success ||
        !binding.success ||
        binding.data.asset.kind !== "skill" ||
        binding.data.capabilityId !== tile.data.identity.id
      )
        return false;
      const ref = `${tile.data.identity.id}@${tile.data.identity.version}`;
      const compiled = expected.get(ref);
      const compiledManifest = compiled
        ? parseTileManifestV1(compiled.manifest)
        : null;
      if (
        !compiled ||
        !compiledManifest?.success ||
        compiledManifest.fingerprint !== tile.fingerprint ||
        seen.has(ref)
      )
        return false;
      if (binding.data.control === "pactile-owned") {
        if (
          binding.data.asset.id !== tile.data.identity.id ||
          typeof claim.skillBody !== "string" ||
          tileFingerprint(tile.data, claim.skillBody) !== compiled.fingerprint
        )
          return false;
      } else if (claim.skillBody !== undefined) return false;
      seen.add(ref);
    }
    return seen.size === expected.size;
  } catch {
    return false;
  }
}

/**
 * Parent-owned composition glue. It compiles the model selection, builds one
 * shared projection, then lets exactly one platform adapter absorb that shared
 * plan into a single reconcile transaction. No writer or host transport runs
 * here.
 */
export function composeBatch2Plan(
  request: Batch2ComposeRequest,
): Batch2ComposeResult {
  const platform = getPactilePlatform(request.platform);
  if (!platform)
    return {
      status: "review",
      platform: null,
      adapterId: null,
      composition: null,
      projection: null,
      diagnostics: [{ code: "invalid-platform" }],
    };

  const composition = compileTileComposition(request.catalog, request.selection);
  if (!composition.success)
    return tileFailure(
      "tile-selection-invalid",
      request.platform,
      platform.adapterId,
      composition.diagnostics[0]?.code,
    );

  if (!claimsMatchComposition(composition.data, request.shared.claims))
    return {
      status: "review",
      platform: request.platform,
      adapterId: platform.adapterId,
      composition: composition.data,
      projection: null,
      diagnostics: [{ code: "selection-claim-mismatch" }],
    };

  const sharedRequest: SharedProjectionRequest = {
    ...request.shared,
    adapterId: platform.adapterId,
    claimantId: platform.adapterId,
  };
  const shared = buildSharedProjectionPlan(sharedRequest);
  if (shared.status !== "ready")
    return {
      status: "review",
      platform: request.platform,
      adapterId: platform.adapterId,
      composition: composition.data,
      projection: null,
      diagnostics: [
        { code: "shared-review", detail: shared.diagnostics[0] },
      ],
    };

  const adapter: CodexProjectionResult = buildCodexProjectionPlan({
    ...request.adapter,
    shared: shared.inputs,
  });

  if (adapter.status === "ready")
    return {
      status: "ready",
      platform: request.platform,
      adapterId: platform.adapterId,
      composition: composition.data,
      projection: adapter.inputs,
      diagnostics: [],
    };
  if (adapter.status === "degraded")
    return {
      status: "degraded",
      platform: request.platform,
      adapterId: platform.adapterId,
      composition: composition.data,
      projection: adapter.inputs,
      diagnostics: [{ code: "adapter-degraded" }],
    };
  return {
    status: adapter.status,
    platform: request.platform,
    adapterId: platform.adapterId,
    composition: composition.data,
    projection: null,
    diagnostics: [
      {
        code:
          adapter.status === "unsupported"
            ? "adapter-unsupported"
            : "adapter-review",
      },
    ],
  };
}
