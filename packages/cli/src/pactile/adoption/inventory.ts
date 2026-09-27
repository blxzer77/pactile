import {
  EXTERNAL_ASSET_KINDS_V1,
  EXTERNAL_ASSET_OWNER_KINDS_V1,
  EXTERNAL_ASSET_SCOPES_V1,
  EXTERNAL_ASSET_SOURCES_V1,
  parseExternalAssetRefV1,
  type ExternalAssetRefV1,
  type ExternalAssetOwnerV1,
  type ExternalAssetSourceV1,
  type ExternalAssetScopeV1,
  type InstallHintV1,
} from "../../core/index.js";
import {
  diagnostic,
  diagnostics,
  digest,
  fail,
  field,
  items,
  logicalId,
  member,
  optionalBoolean,
  order,
  type AdoptionDiagnostic,
} from "./safety.js";

/** Caller grants one named namespace; this is not an implicit HOME/host scan. */
export interface DiscoveryContext {
  readonly hostId: string;
  readonly rootId: string;
  readonly source: ExternalAssetSourceV1;
  readonly scope: ExternalAssetScopeV1;
  readonly owner: ExternalAssetOwnerV1;
}

export interface InventoryResult {
  readonly assets: readonly ExternalAssetRefV1[];
  readonly diagnostics: readonly AdoptionDiagnostic[];
}

export function parseContext(value: unknown): DiscoveryContext {
  const rawOwner = field(value, "owner");
  const ownerId = field(rawOwner, "id");
  const context: DiscoveryContext = {
    hostId: logicalId(field(value, "hostId")),
    rootId: logicalId(field(value, "rootId")),
    source: member(field(value, "source"), EXTERNAL_ASSET_SOURCES_V1),
    scope: member(field(value, "scope"), EXTERNAL_ASSET_SCOPES_V1),
    owner: {
      kind: member(field(rawOwner, "kind"), EXTERNAL_ASSET_OWNER_KINDS_V1),
      id: ownerId === null ? null : logicalId(ownerId),
    },
  };
  // M0 validates source/owner relationships, including required Pactile owner ids.
  const probe = parseExternalAssetRefV1({
    schemaVersion: 1,
    id: "context",
    kind: "skill",
    source: context.source,
    scope: context.scope,
    owner: context.owner,
    locator: `${context.source}://context`,
    fingerprint: null,
    readiness: "unknown",
    installHint: null,
  });
  if (!probe.success) fail("invalid-context", "context");
  return context;
}

function missingHint(
  kind: ExternalAssetRefV1["kind"],
  source: ExternalAssetSourceV1,
  requiresAuthentication: boolean,
): InstallHintV1 {
  const mechanism =
    source === "host-native"
      ? "host-native"
      : kind === "executable" || kind === "plugin"
        ? "package-manager"
        : "manual";
  return {
    schemaVersion: 1,
    mechanism,
    label: `install.${kind}`,
    reference:
      mechanism === "manual"
        ? `docs://install/${kind}`
        : `${mechanism}://install/${kind}`,
    requiresAuthentication,
  };
}

/** A metadata snapshot is NOT a parsed Skill document or a host config dump.
 * Known fields: id, kind, locatorToken, present, enabled, transport, tools,
 * publicFingerprint, requiresAuthentication. Body/env/headers/commands are never read.
 * MCP transport/tools affect the public metadata fingerprint only, not M0 shape.
 */
export function sanitizeCandidate(
  context: DiscoveryContext,
  value: unknown,
): ExternalAssetRefV1 {
  const id = logicalId(field(value, "id"));
  const kind = member(field(value, "kind"), EXTERNAL_ASSET_KINDS_V1);
  const locatorToken = logicalId(field(value, "locatorToken"));
  const present = optionalBoolean(field(value, "present"));
  const enabled = optionalBoolean(field(value, "enabled"));
  const requiresAuthentication =
    optionalBoolean(field(value, "requiresAuthentication")) ?? false;
  const publicFingerprint = field(value, "publicFingerprint");
  if (
    publicFingerprint !== undefined &&
    publicFingerprint !== null &&
    (typeof publicFingerprint !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(publicFingerprint))
  )
    fail("invalid-asset", "assets");
  const transportValue = kind === "mcp" ? field(value, "transport") : undefined;
  const transport =
    transportValue === undefined
      ? null
      : member(transportValue, ["stdio", "http", "sse"] as const);
  const toolsValue = kind === "mcp" ? field(value, "tools") : undefined;
  const tools =
    toolsValue === undefined
      ? []
      : [...new Set(items(toolsValue).map(logicalId))].sort(order);
  const readiness =
    present === false
      ? "missing"
      : enabled === false
        ? "degraded"
        : present === true && enabled === true
          ? "ready"
          : "unknown";
  const asset = {
    schemaVersion: 1,
    id,
    kind,
    source: context.source,
    scope: context.scope,
    owner: context.owner,
    locator: `${context.source}://inventory/h${digest(context.hostId)}/r${digest([context.rootId, locatorToken])}`,
    fingerprint: `sha256:${digest({ id, kind, publicFingerprint: publicFingerprint ?? null, transport, tools })}`,
    readiness,
    installHint:
      readiness === "missing"
        ? missingHint(kind, context.source, requiresAuthentication)
        : null,
  };
  const parsed = parseExternalAssetRefV1(asset);
  if (!parsed.success) fail("invalid-asset", "assets");
  return parsed.data;
}

export function assetIdentity(asset: ExternalAssetRefV1): string {
  return JSON.stringify([
    asset.id,
    asset.kind,
    asset.source,
    asset.scope,
    asset.owner.kind,
    asset.owner.id,
    asset.locator,
  ]);
}

/** Caller supplied M0 refs also cross the sanitizer; never pass raw records to errors. */
export function sanitizeAssetRef(value: unknown): ExternalAssetRefV1 {
  const owner = field(value, "owner");
  const ownerId = field(owner, "id");
  const rawHint = field(value, "installHint");
  const hint =
    rawHint === null
      ? null
      : {
          schemaVersion: field(rawHint, "schemaVersion"),
          mechanism: field(rawHint, "mechanism"),
          label: logicalId(field(rawHint, "label")),
          reference: field(rawHint, "reference"),
          requiresAuthentication: field(rawHint, "requiresAuthentication"),
        };
  const clean = {
    schemaVersion: field(value, "schemaVersion"),
    id: logicalId(field(value, "id")),
    kind: field(value, "kind"),
    source: field(value, "source"),
    scope: field(value, "scope"),
    owner: {
      kind: field(owner, "kind"),
      id: ownerId === null ? null : logicalId(ownerId),
    },
    locator: field(value, "locator"),
    fingerprint: field(value, "fingerprint"),
    readiness: field(value, "readiness"),
    installHint: hint,
  };
  // Decoder inputs must be scalar data. Reject objects before their conversion hooks
  // can reach a contract diagnostic. No decoder issues are exposed publicly.
  for (const scalar of [
    clean.schemaVersion,
    clean.kind,
    clean.source,
    clean.scope,
    clean.owner.kind,
    clean.locator,
    clean.fingerprint,
    clean.readiness,
    ...(hint
      ? [
          hint.schemaVersion,
          hint.mechanism,
          hint.reference,
          hint.requiresAuthentication,
        ]
      : []),
  ]) {
    if (
      (scalar !== null && typeof scalar === "object") ||
      typeof scalar === "function" ||
      typeof scalar === "symbol"
    )
      fail("invalid-asset", "assets");
    if (typeof scalar === "string" && scalar.length > 256)
      fail("invalid-asset", "assets");
  }
  const parsed = parseExternalAssetRefV1(clean);
  if (!parsed.success) fail("invalid-asset", "assets");
  return parsed.data;
}

function assemble(
  assets: readonly ExternalAssetRefV1[],
  problems: readonly AdoptionDiagnostic[],
): InventoryResult {
  const groups = new Map<string, ExternalAssetRefV1[]>();
  for (const asset of assets) {
    const key = assetIdentity(asset);
    groups.set(key, [...(groups.get(key) ?? []), asset]);
  }
  const result: ExternalAssetRefV1[] = [];
  const issues = [...problems];
  for (const [, group] of [...groups].sort(([a], [b]) => order(a, b))) {
    const first = group[0];
    const fingerprints = new Set(group.map((asset) => asset.fingerprint));
    const readiness = new Set(group.map((asset) => asset.readiness));
    const hints = new Set(
      group.map((asset) => JSON.stringify(asset.installHint)),
    );
    if (fingerprints.size > 1 || readiness.size > 1 || hints.size > 1) {
      issues.push({ code: "identity-conflict", path: "assets" });
      // Disagreement never promotes availability or picks scan-order evidence.
      result.push({
        ...first,
        fingerprint: fingerprints.size === 1 ? first.fingerprint : null,
        readiness: "unknown",
        installHint: null,
      });
    } else result.push(first);
  }
  const names = new Set<string>();
  for (const asset of result) {
    const key = JSON.stringify([asset.id, asset.kind]);
    if (names.has(key)) issues.push({ code: "ambiguous-id", path: "assets" });
    names.add(key);
  }
  return { assets: result, diagnostics: diagnostics(issues) };
}

/** Pure merge for independently granted snapshots. Keeps scope and multi-host identity. */
export function buildInventory(value: unknown): InventoryResult {
  try {
    const assets: ExternalAssetRefV1[] = [];
    const problems: AdoptionDiagnostic[] = [];
    for (const item of items(value)) {
      try {
        assets.push(sanitizeAssetRef(item));
      } catch {
        problems.push({ code: "invalid-asset", path: "assets" });
      }
    }
    return assemble(assets, problems);
  } catch {
    return {
      assets: [],
      diagnostics: [{ code: "invalid-input", path: "input" }],
    };
  }
}

export function discoverSnapshot(input: unknown): InventoryResult {
  let context: DiscoveryContext;
  try {
    context = parseContext(field(input, "context"));
  } catch {
    return {
      assets: [],
      diagnostics: [{ code: "invalid-context", path: "context" }],
    };
  }
  try {
    const assets: ExternalAssetRefV1[] = [];
    const problems: AdoptionDiagnostic[] = [];
    for (const candidate of items(field(input, "assets"))) {
      try {
        assets.push(sanitizeCandidate(context, candidate));
      } catch {
        problems.push({ code: "invalid-asset", path: "assets" });
      }
    }
    return assemble(assets, problems);
  } catch (error) {
    return {
      assets: [],
      diagnostics: [diagnostic(error, "invalid-input", "input")],
    };
  }
}
