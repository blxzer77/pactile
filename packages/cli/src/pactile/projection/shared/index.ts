import {
  parseCapabilityBindingV1,
  parseTileManifestV1,
  type CapabilityBindingV1,
  type ProjectionOperationV1,
  type ProjectionPlanV1,
  type TileManifestV1,
} from "../../../core/index.js";
import { buildPactileAgentsBlock } from "../../../configurators/shared.js";
import {
  canonicalOwnershipLedger,
  fingerprintBytes,
  type ExternalBindingClaim,
  type ProjectionContent,
  type ProjectionInputs,
} from "../planner.js";

export interface SharedProjectionClaim {
  readonly tile: unknown;
  readonly binding: unknown;
  /** Required only for Pactile-owned Skill assets. Borrowed bodies are rejected. */
  readonly skillBody?: unknown;
}

export interface SharedProjectionSurface {
  readonly targetPath: string;
  readonly content: string | null;
}

export interface SharedProjectionRequest {
  readonly adapterId: string;
  readonly claimantId: string;
  readonly generationId: string;
  readonly canonicalFingerprint: string;
  readonly updatedAt: string;
  readonly action: "attach" | "detach";
  readonly ledger: unknown | null;
  readonly claims: readonly SharedProjectionClaim[];
  readonly surfaces: readonly SharedProjectionSurface[];
  readonly externalClaims?: readonly ExternalBindingClaim[];
}

export type SharedProjectionDiagnosticCode =
  | "invalid-input"
  | "invalid-claim"
  | "duplicate-resource"
  | "owned-skill-body-required"
  | "borrowed-skill-body-forbidden"
  | "unsupported-binding";

export type SharedProjectionBuildResult =
  | { readonly status: "ready"; readonly inputs: ProjectionInputs }
  | {
      readonly status: "review";
      readonly diagnostics: readonly SharedProjectionDiagnosticCode[];
    };

interface ValidClaim {
  readonly tile: TileManifestV1;
  readonly binding: CapabilityBindingV1;
  readonly skillBody: string | null;
}

const text = new TextEncoder();
const logicalId = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const fingerprint = /^sha256:[0-9a-f]{64}$/;
const order = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function validateClaim(
  value: SharedProjectionClaim,
  action: SharedProjectionRequest["action"],
): ValidClaim | null {
  const tile = parseTileManifestV1(value.tile);
  const binding = parseCapabilityBindingV1(value.binding);
  if (!tile.success || !binding.success || binding.data.asset.kind !== "skill")
    return null;
  if (binding.data.control === "borrowed") {
    if (value.skillBody !== undefined) return null;
    return { tile: tile.data, binding: binding.data, skillBody: null };
  }
  // Detach only releases the claimant. It does not need to receive or retain
  // the private Skill body used for the original attach.
  if (action === "detach") {
    if (value.skillBody !== undefined) return null;
    return { tile: tile.data, binding: binding.data, skillBody: null };
  }
  if (typeof value.skillBody !== "string" || !value.skillBody.trim())
    return null;
  return { tile: tile.data, binding: binding.data, skillBody: value.skillBody };
}

function review(
  code: SharedProjectionDiagnosticCode,
): SharedProjectionBuildResult {
  return { status: "review", diagnostics: [code] };
}

/**
 * Compile shared Skills and the single PACTILE AGENTS block into M1 planning
 * inputs. This function observes only the caller's explicit surface snapshot;
 * ProjectionStore remains the sole writer.
 */
export function buildSharedProjectionPlan(
  request: SharedProjectionRequest,
): SharedProjectionBuildResult {
  try {
    if (
      !logicalId.test(request.adapterId) ||
      !logicalId.test(request.claimantId) ||
      !logicalId.test(request.generationId) ||
      !fingerprint.test(request.canonicalFingerprint) ||
      !timestamp.test(request.updatedAt) ||
      !["attach", "detach"].includes(request.action)
    )
      return review("invalid-input");

    const claims: ValidClaim[] = [];
    for (const value of request.claims) {
      const claim = validateClaim(value, request.action);
      if (!claim) {
        if (value.skillBody !== undefined) {
          const binding = parseCapabilityBindingV1(value.binding);
          if (binding.success && binding.data.control === "borrowed")
            return review("borrowed-skill-body-forbidden");
        }
        const binding = parseCapabilityBindingV1(value.binding);
        if (
          binding.success &&
          binding.data.control === "pactile-owned" &&
          (typeof value.skillBody !== "string" || !value.skillBody.trim())
        )
          return review("owned-skill-body-required");
        return review("invalid-claim");
      }
      claims.push(claim);
    }
    claims.sort((left, right) =>
      order(left.binding.asset.id, right.binding.asset.id),
    );
    if (new Set(claims.map(({ binding }) => binding.asset.id)).size !== claims.length)
      return review("duplicate-resource");

    const surfaceMap = new Map<string, Uint8Array | null>();
    for (const surface of request.surfaces) {
      if (
        typeof surface.targetPath !== "string" ||
        surfaceMap.has(surface.targetPath) ||
        (surface.content !== null && typeof surface.content !== "string")
      )
        return review("invalid-input");
      surfaceMap.set(
        surface.targetPath,
        surface.content === null ? null : text.encode(surface.content),
      );
    }

    const content = new Map<string, ProjectionContent>();
    const operations: ProjectionOperationV1[] = [];
    const agentsBytes = text.encode(
      buildPactileAgentsBlock(
        claims.map(({ tile }) => ({
          id: tile.identity.id,
          summary: tile.summary,
        })),
      ),
    );
    const agentsRef = `shared.agents.${fingerprintBytes(agentsBytes).slice(7)}`;
    content.set(agentsRef, { bytes: agentsBytes });
    const agentsCurrent = surfaceMap.get("AGENTS.md") ?? null;
    operations.push({
      id: `shared.agents.${request.action}`,
      resourceId: "shared.agents",
      claimantId: request.claimantId,
      action: request.action === "attach" ? "merge" : "remove",
      control: "pactile-owned",
      targetPath: "AGENTS.md",
      format: "managed-block",
      contentRef: request.action === "attach" ? agentsRef : null,
      desiredFingerprint:
        request.action === "attach" ? fingerprintBytes(agentsBytes) : null,
      expectedCurrentFingerprint:
        request.action === "attach"
          ? agentsCurrent === null
            ? null
            : fingerprintBytes(agentsCurrent)
          : agentsCurrent === null
            ? null
            : fingerprintBytes(agentsCurrent),
      externalAssetId: null,
    });

    for (const { binding, skillBody } of claims) {
      const resourceId = `shared.skill.${binding.asset.id}`;
      if (binding.control === "borrowed") {
        operations.push({
          id: `${resourceId}.${request.action === "attach" ? "bind" : "detach"}`,
          resourceId,
          claimantId: request.claimantId,
          action: request.action === "attach" ? "bind" : "detach",
          control: "borrowed",
          targetPath: null,
          format: "external-ref",
          contentRef: null,
          desiredFingerprint: null,
          expectedCurrentFingerprint: null,
          externalAssetId: binding.asset.id,
        });
        continue;
      }
      if (binding.deleteBoundary !== "remove-when-unclaimed")
        return review("unsupported-binding");
      const targetPath = `.agents/skills/${binding.asset.id}/SKILL.md`;
      const current = surfaceMap.get(targetPath) ?? null;
      const body = skillBody === null ? null : text.encode(skillBody);
      const contentRef =
        body === null ? null : `${resourceId}.${fingerprintBytes(body).slice(7)}`;
      if (body !== null && contentRef !== null) content.set(contentRef, { bytes: body });
      operations.push({
        id: `${resourceId}.${request.action === "attach" ? "ensure" : "remove"}`,
        resourceId,
        claimantId: request.claimantId,
        action: request.action === "attach" ? "ensure" : "remove",
        control: "pactile-owned",
        targetPath,
        format: "text",
        contentRef: request.action === "attach" ? contentRef : null,
        desiredFingerprint:
          request.action === "attach" && body !== null
            ? fingerprintBytes(body)
            : null,
        expectedCurrentFingerprint:
          request.action === "attach"
            ? current === null
              ? null
              : fingerprintBytes(current)
            : current === null
              ? null
              : fingerprintBytes(current),
        externalAssetId: null,
      });
    }

    const expectedLedgerFingerprint =
      request.ledger === null
        ? null
        : canonicalOwnershipLedger(request.ledger).fingerprint;
    const plan: ProjectionPlanV1 = {
      schemaVersion: 1,
      id: `shared.${request.generationId}.${request.action}`,
      adapterId: request.adapterId,
      generationId: request.generationId,
      canonicalFingerprint: request.canonicalFingerprint,
      expectedLedgerFingerprint,
      operations,
    };
    return {
      status: "ready",
      inputs: {
        plan,
        ledger: request.ledger,
        canonicalFingerprint: request.canonicalFingerprint,
        updatedAt: request.updatedAt,
        observe: (targetPath) => surfaceMap.get(targetPath) ?? null,
        resolveContent: (contentRef) => {
          const resolved = content.get(contentRef);
          if (!resolved) throw new Error("unknown-shared-content");
          return resolved;
        },
        externalClaims: request.externalClaims,
      },
    };
  } catch {
    return review("invalid-input");
  }
}
