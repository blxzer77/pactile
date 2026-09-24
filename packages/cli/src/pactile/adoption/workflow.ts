import { createHash } from "node:crypto";
import {
  PACTILE_INTENTS_V1,
  resolveProviderV1,
  type CapabilityBindingV1,
  type ProjectionOperationV1,
  type ProviderResolutionResultV1,
} from "../../core/index.js";
import {
  reduceExternalBindingClaims,
  type ExternalBindingClaim,
} from "../projection/planner.js";
import { planBinding } from "./bindings.js";
import { discoverSnapshot, type InventoryResult } from "./inventory.js";
import { field, items, logicalId, member } from "./safety.js";

export type AdoptionWorkflowPhase =
  | "discover"
  | "adopt"
  | "bind"
  | "doctor"
  | "detach";

export interface AdoptionWorkflowStep {
  readonly sequence: number;
  readonly phase: AdoptionWorkflowPhase;
  readonly outcome: "accepted" | "degraded" | "rejected";
  readonly evidenceRefs: readonly string[];
}

export type AdoptionWorkflowDiagnosticCode =
  | "invalid-input"
  | "inventory-conflict"
  | "asset-not-found"
  | "adoption-unavailable"
  | "owned-projection-required"
  | "provider-unsupported"
  | "foreign-conflict";

export interface AdoptionWorkflowResult {
  readonly status: "complete" | "degraded" | "conflict" | "invalid";
  readonly workflowId: string | null;
  readonly inventory: InventoryResult;
  readonly binding: CapabilityBindingV1 | null;
  readonly provider: ProviderResolutionResultV1 | null;
  readonly operations: readonly ProjectionOperationV1[];
  readonly claims: readonly ExternalBindingClaim[];
  readonly preserveExternalAsset: boolean;
  readonly remediation: readonly string[];
  readonly steps: readonly AdoptionWorkflowStep[];
  readonly diagnostics: readonly AdoptionWorkflowDiagnosticCode[];
}

const EMPTY_INVENTORY: InventoryResult = { assets: [], diagnostics: [] };

function failed(
  status: AdoptionWorkflowResult["status"],
  code: AdoptionWorkflowDiagnosticCode,
  partial: Partial<AdoptionWorkflowResult> = {},
): AdoptionWorkflowResult {
  return {
    status,
    workflowId: null,
    inventory: EMPTY_INVENTORY,
    binding: null,
    provider: null,
    operations: [],
    claims: [],
    preserveExternalAsset: true,
    remediation: [],
    steps: [],
    diagnostics: [code],
    ...partial,
  };
}

function resolutionInput(value: unknown, binding: CapabilityBindingV1): unknown {
  return {
    schemaVersion: field(value, "schemaVersion"),
    intent: field(value, "intent"),
    capabilityId: field(value, "capabilityId"),
    minimumAssurance: field(value, "minimumAssurance"),
    requestedPolicy: field(value, "requestedPolicy"),
    authorizedProviderIds: field(value, "authorizedProviderIds"),
    activeProviderIds: field(value, "activeProviderIds"),
    standbyProviderIds: field(value, "standbyProviderIds"),
    fallbackAllowed: field(value, "fallbackAllowed"),
    manifests: field(value, "manifests"),
    bindings: [binding],
    runtimeFacts: field(value, "runtimeFacts"),
    now: field(value, "now"),
  };
}

function sanitizeClaims(value: unknown): ExternalBindingClaim[] {
  return items(value).map((claim) => ({
    resourceId: logicalId(field(claim, "resourceId")),
    externalAssetId: logicalId(field(claim, "externalAssetId")),
    claimants: items(field(claim, "claimants")).map(logicalId),
  }));
}

function operation(
  action: "bind" | "detach",
  resourceId: string,
  claimantId: string,
  externalAssetId: string,
): ProjectionOperationV1 {
  return {
    id: `${resourceId}.${action}`,
    resourceId,
    claimantId,
    action,
    control: "borrowed",
    targetPath: null,
    format: "external-ref",
    contentRef: null,
    desiredFingerprint: null,
    expectedCurrentFingerprint: null,
    externalAssetId,
  };
}

/**
 * Pure discover -> adopt -> bind -> doctor -> optional detach workflow. It
 * consumes sanitized public facts and emits declarative external-ref claims;
 * it has no filesystem, installation, authentication, or deletion port.
 */
export function runAdoptionWorkflow(value: unknown): AdoptionWorkflowResult {
  try {
    const discovery = discoverSnapshot(field(value, "discovery"));
    const assetId = logicalId(field(value, "assetId"));
    const capabilityId = logicalId(field(value, "capabilityId"));
    const claimantId = logicalId(field(value, "claimantId"));
    const providerValue = field(value, "providerId");
    const providerId =
      providerValue === null ? null : logicalId(providerValue);
    const intents = [
      ...new Set(
        items(field(value, "intents")).map((item) =>
          member(item, PACTILE_INTENTS_V1),
        ),
      ),
    ].sort();
    const detach = field(value, "detach");
    if (typeof detach !== "boolean" || intents.length === 0)
      return failed("invalid", "invalid-input");
    const existingClaims = sanitizeClaims(field(value, "claims"));
    const discoverEvidence = discovery.assets
      .map(({ fingerprint }) => fingerprint)
      .filter((item): item is string => item !== null)
      .map((item) => `evidence://inventory/${item.slice(7, 23)}`);
    const steps: AdoptionWorkflowStep[] = [
      {
        sequence: 1,
        phase: "discover",
        outcome: discovery.diagnostics.length ? "degraded" : "accepted",
        evidenceRefs: discoverEvidence,
      },
    ];
    if (discovery.diagnostics.length)
      return failed("conflict", "inventory-conflict", {
        inventory: discovery,
        steps,
      });
    const matches = discovery.assets.filter(({ id }) => id === assetId);
    if (matches.length !== 1)
      return failed("conflict", "asset-not-found", {
        inventory: discovery,
        steps,
      });

    const proposal = planBinding({
      asset: matches[0],
      capabilityId,
      providerId,
      intents,
    });
    if (!proposal.binding) {
      steps.push({
        sequence: 2,
        phase: "adopt",
        outcome: "degraded",
        evidenceRefs: [],
      });
      steps.push({
        sequence: 3,
        phase: "doctor",
        outcome: "degraded",
        evidenceRefs: [],
      });
      return failed("degraded", "adoption-unavailable", {
        inventory: discovery,
        remediation: proposal.installHint
          ? [proposal.installHint.label]
          : ["inspect-capability-readiness"],
        steps,
      });
    }
    const binding = proposal.binding;
    steps.push({
      sequence: 2,
      phase: "adopt",
      outcome: "accepted",
      evidenceRefs: [],
    });

    if (binding.control === "pactile-owned") {
      steps.push({
        sequence: 3,
        phase: "bind",
        outcome: "degraded",
        evidenceRefs: [],
      });
      steps.push({
        sequence: 4,
        phase: "doctor",
        outcome: "degraded",
        evidenceRefs: [],
      });
      return failed("degraded", "owned-projection-required", {
        inventory: discovery,
        binding,
        claims: existingClaims,
        preserveExternalAsset: false,
        remediation: ["route-owned-asset-through-shared-projection"],
        steps,
      });
    }

    const provider =
      providerId === null
        ? null
        : resolveProviderV1(
            resolutionInput(field(value, "providerResolution"), binding),
          );
    if (providerId !== null && provider?.status !== "supported") {
      steps.push({
        sequence: 3,
        phase: "bind",
        outcome: "rejected",
        evidenceRefs: [],
      });
      steps.push({
        sequence: 4,
        phase: "doctor",
        outcome: "degraded",
        evidenceRefs: provider?.explain.evidenceRefs ?? [],
      });
      return failed("degraded", "provider-unsupported", {
        inventory: discovery,
        binding,
        provider,
        claims: existingClaims,
        remediation: ["refresh-or-authorize-provider"],
        steps,
      });
    }

    const resourceId = `adoption.${binding.asset.id}`;
    const bind = operation("bind", resourceId, claimantId, binding.asset.id);
    let claims: readonly ExternalBindingClaim[];
    try {
      claims = reduceExternalBindingClaims(existingClaims, [bind]);
    } catch {
      return failed("conflict", "foreign-conflict", {
        inventory: discovery,
        binding,
        provider,
        claims: existingClaims,
        steps,
      });
    }
    const providerEvidence = provider?.resolution?.evidenceRefs ?? [];
    steps.push({
      sequence: 3,
      phase: "bind",
      outcome: "accepted",
      evidenceRefs: providerEvidence,
    });
    steps.push({
      sequence: 4,
      phase: "doctor",
      outcome:
        provider?.resolution?.readiness === "degraded" ? "degraded" : "accepted",
      evidenceRefs: providerEvidence,
    });
    const operations: ProjectionOperationV1[] = [bind];
    if (detach) {
      const release = operation(
        "detach",
        resourceId,
        claimantId,
        binding.asset.id,
      );
      claims = reduceExternalBindingClaims(claims, [release]);
      operations.push(release);
      steps.push({
        sequence: 5,
        phase: "detach",
        outcome: "accepted",
        evidenceRefs: [],
      });
    }
    const workflowId = `workflow.${createHash("sha256")
      .update(
        JSON.stringify({
          asset: binding.asset.id,
          binding: binding.id,
          claimantId,
          detach,
          provider: provider?.fingerprint ?? null,
        }),
      )
      .digest("hex")
      .slice(0, 24)}`;
    return {
      status:
        provider?.resolution?.readiness === "degraded"
          ? "degraded"
          : "complete",
      workflowId,
      inventory: discovery,
      binding,
      provider,
      operations,
      claims,
      preserveExternalAsset: binding.control === "borrowed",
      remediation:
        provider?.resolution?.readiness === "degraded"
          ? ["refresh-or-authorize-provider"]
          : [],
      steps,
      diagnostics: [],
    };
  } catch {
    return failed("invalid", "invalid-input");
  }
}
