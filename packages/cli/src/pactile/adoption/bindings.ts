import {
  CAPABILITY_BINDING_MODES_V1,
  EXTERNAL_ASSET_KINDS_V1,
  INSTALL_HINT_MECHANISMS_V1,
  PACTILE_INTENTS_V1,
  parseCapabilityBindingV1,
  parseInstallHintV1,
  type CapabilityBindingV1,
  type InstallHintV1,
} from "../../core/index.js";
import { assetIdentity, sanitizeAssetRef } from "./inventory.js";
import {
  digest,
  field,
  items,
  logicalId,
  member,
  optionalBoolean,
  order,
  type AdoptionDiagnostic,
} from "./safety.js";

export interface InstallHintResult {
  readonly hint: InstallHintV1 | null;
  readonly diagnostics: readonly AdoptionDiagnostic[];
}

/** Symbolic factory: no package names, commands, URLs, or authentication actions. */
export function createInstallHint(input: unknown): InstallHintResult {
  try {
    const kind = member(field(input, "kind"), EXTERNAL_ASSET_KINDS_V1);
    const mechanism = member(
      field(input, "mechanism"),
      INSTALL_HINT_MECHANISMS_V1,
    );
    const requiresAuthentication =
      optionalBoolean(field(input, "requiresAuthentication")) ?? false;
    const parsed = parseInstallHintV1({
      schemaVersion: 1,
      mechanism,
      label: `install.${kind}`,
      reference: `${mechanism === "manual" ? "docs" : mechanism}://install/${kind}`,
      requiresAuthentication,
    });
    if (parsed.success) return { hint: parsed.data, diagnostics: [] };
  } catch {
    /* All boundary errors become fixed diagnostics, never raw exceptions. */
  }
  return { hint: null, diagnostics: [{ code: "invalid-input", path: "hint" }] };
}

export interface BindingProposal {
  readonly binding: CapabilityBindingV1 | null;
  readonly installHint: InstallHintV1 | null;
  readonly diagnostics: readonly AdoptionDiagnostic[];
}

/** Caller explicitly selects a complete asset reference, not an ambiguous name.
 * Unknown/degraded assets are not probed or made ready by adoption. Control and
 * deletion are derived here; callers cannot acquire external ownership via flags.
 * This function returns a proposal only; it does not persist a binding or claim.
 */
export function planBinding(input: unknown): BindingProposal {
  try {
    const asset = sanitizeAssetRef(field(input, "asset"));
    const capabilityId = logicalId(field(input, "capabilityId"));
    const rawProvider = field(input, "providerId");
    const providerId =
      rawProvider === undefined || rawProvider === null
        ? null
        : logicalId(rawProvider);
    const intents = [
      ...new Set(
        items(field(input, "intents")).map((value) =>
          member(value, PACTILE_INTENTS_V1),
        ),
      ),
    ].sort(order);
    const rawMode = field(input, "mode");
    const mode =
      rawMode === undefined
        ? asset.source === "pactile-bundled"
          ? "composed"
          : asset.source === "host-native"
            ? "native"
            : "adopted"
        : member(rawMode, CAPABILITY_BINDING_MODES_V1);
    const owned =
      mode === "composed" &&
      asset.owner.kind === "pactile" &&
      (asset.source === "pactile-bundled" ||
        asset.source === "project-vendored");
    const parsed = parseCapabilityBindingV1({
      schemaVersion: 1,
      id: `binding.${digest([assetIdentity(asset), capabilityId, providerId, intents, mode])}`,
      capabilityId,
      mode,
      control: owned ? "pactile-owned" : "borrowed",
      deleteBoundary: owned ? "remove-when-unclaimed" : "preserve",
      asset,
      intents,
      providerId,
    });
    // A missing-only proposal is not a CapabilityBindingV1. Retain every M0
    // validation rule except its sole missing MCP provider requirement: no
    // binding or placeholder provider is returned before installation exists.
    if (
      asset.readiness === "missing" &&
      intents.length > 0 &&
      (parsed.success ||
        (asset.kind === "mcp" &&
          providerId === null &&
          parsed.issues.length === 1 &&
          parsed.issues[0].code === "required" &&
          parsed.issues[0].path === "$.providerId"))
    )
      return {
        binding: null,
        installHint: asset.installHint,
        diagnostics: [],
      };
    if (parsed.success && intents.length > 0) {
      if (asset.readiness !== "ready")
        return {
          binding: null,
          installHint: null,
          diagnostics: [{ code: "unavailable", path: "binding" }],
        };
      return { binding: parsed.data, installHint: null, diagnostics: [] };
    }
  } catch {
    /* Never echo the rejected asset, caller id, or decoder diagnostic. */
  }
  return {
    binding: null,
    installHint: null,
    diagnostics: [{ code: "invalid-binding", path: "binding" }],
  };
}
