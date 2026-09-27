import {
  parseProjectionPlanV1,
  type ProjectionOperationV1,
  type ProjectionPlanV1,
} from "../../../core/index.js";
import {
  fingerprintBytes,
  type ProjectionContent,
  type ProjectionInputs,
} from "../../projection/planner.js";
import type { TomlOwnedKey } from "../../projection/structured-merge.js";

/** Codex project leaves; the ChatGPT desktop App is the only supported host. */
export const CODEX_PROJECTION_CAPABILITIES = [
  "project-config",
  "hooks",
  "mcp",
] as const;
export type CodexProjectionCapability =
  (typeof CODEX_PROJECTION_CAPABILITIES)[number];

export const CODEX_PROBE_CHANNELS = ["app"] as const;
export type CodexProbeChannel = (typeof CODEX_PROBE_CHANNELS)[number];
export type CodexProbeReadiness = "ready" | "degraded" | "unavailable";

export interface CodexProjectConfigDescriptor {
  /** A caller-validated project fragment; no Pactile pseudo-table is added. */
  readonly content: string;
  readonly ownedTomlKeys: readonly TomlOwnedKey[];
}

export interface CodexProjectHooksDescriptor {
  /** A caller-validated official Codex hook fragment; no event is invented. */
  readonly content: string;
  readonly ownedJsonPointers: readonly string[];
}

export interface CodexNativeBindings {
  /** Native plugin/provider ids; registration bodies remain host-owned. */
  readonly mcp?: readonly string[];
  /** Native hook/plugin registration ids when no project fragment is needed. */
  readonly hooks?: readonly string[];
}

export interface CodexProjectionRequest {
  readonly shared: ProjectionInputs;
  readonly appReadiness: CodexProbeReadiness;
  readonly supportsProjectConfig?: boolean;
  readonly supportsHooks?: boolean;
  readonly composition?: readonly CodexProjectionCapability[];
  /** Compatibility spelling for callers that call the selection a leaf set. */
  readonly selectedCapabilities?: readonly CodexProjectionCapability[];
  readonly action?: "attach" | "detach";
  readonly providerIds?: readonly string[];
  readonly nativeBindings?: CodexNativeBindings;
  readonly projectConfig?: CodexProjectConfigDescriptor;
  readonly projectHooks?: CodexProjectHooksDescriptor;
  readonly surfaces?: readonly {
    readonly targetPath: string;
    readonly content: string | null;
  }[];
}

export interface CodexProbeHint {
  readonly channel: "app";
  readonly readiness: CodexProbeReadiness;
  readonly code: "available" | "install-or-auth-required" | "host-degraded";
}

export type CodexProjectionResult =
  | {
      readonly status: "ready";
      readonly inputs: ProjectionInputs;
      readonly probeHints: readonly [CodexProbeHint];
      readonly diagnostics: readonly [];
    }
  | {
      readonly status: "degraded";
      readonly inputs: ProjectionInputs;
      readonly probeHints: readonly [CodexProbeHint];
      readonly diagnostics: readonly {
        readonly code:
          | "native-binding-required"
          | "app-unavailable"
          | "detach-requires-native-owner";
        readonly capability: CodexProjectionCapability | "app";
      }[];
    }
  | {
      readonly status: "unsupported" | "review";
      readonly diagnostics: readonly {
        readonly code: "unsupported-capability" | "invalid-input";
        readonly capability: CodexProjectionCapability | "adapter";
      }[];
    };

const encoder = new TextEncoder();
const logicalId = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const safeRelativePath = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 256 &&
  !value.includes("\\") &&
  !value.startsWith("/") &&
  !value.split("/").includes("..") &&
  ![...value].some((character) => character.charCodeAt(0) < 32);
const unsafeDescriptor =
  /(?:\[\s*pactile\s*\]|provider[_-]?ids|(?:api[_-]?)?key|token|secret|password|oauth|bearer|BEGIN\s+(?:RSA\s+)?PRIVATE|(?:[A-Za-z]:[\\/]|\/(?:Users|home|private|var)\/))/iu;
const tomlPart = /^[A-Za-z0-9_-]+$/u;
const jsonPointer = /^\/(?:[^~]|~[01])*$/u;

function diagnostic(
  status: "unsupported" | "review",
  code: "unsupported-capability" | "invalid-input",
  capability: CodexProjectionCapability | "adapter",
): CodexProjectionResult {
  return { status, diagnostics: [{ code, capability }] };
}

function inferAction(
  shared: ProjectionPlanV1,
): "attach" | "detach" | "mixed" {
  const actions = new Set(
    shared.operations.map((operation) =>
      operation.action === "remove" || operation.action === "detach"
        ? "detach"
        : "attach",
    ),
  );
  return actions.size === 1 ? ([...actions][0] as "attach" | "detach") : "mixed";
}

function selectedCapabilities(
  request: CodexProjectionRequest,
): CodexProjectionCapability[] | null {
  const selected = request.composition ?? request.selectedCapabilities ?? [];
  if (
    !Array.isArray(selected) ||
    selected.length > CODEX_PROJECTION_CAPABILITIES.length
  )
    return null;
  const result = [...selected];
  if (
    new Set(result).size !== result.length ||
    result.some((value) => !CODEX_PROJECTION_CAPABILITIES.includes(value))
  )
    return null;
  return result.sort();
}

function validateIds(values: readonly string[]): boolean {
  return (
    values.length <= 1024 &&
    new Set(values).size === values.length &&
    values.every((value) => logicalId.test(value))
  );
}

function validateTomlKeys(values: readonly TomlOwnedKey[]): boolean {
  if (!Array.isArray(values) || values.length === 0 || values.length > 1024)
    return false;
  const identities = new Set<string>();
  for (const value of values) {
    if (
      typeof value !== "object" ||
      value === null ||
      !Array.isArray(value.table) ||
      value.table.length > 32 ||
      typeof value.key !== "string" ||
      !tomlPart.test(value.key) ||
      value.table.some(
        (part: unknown) =>
          typeof part !== "string" || !tomlPart.test(part),
      )
    )
      return false;
    const identity = JSON.stringify([value.table, value.key]);
    if (identities.has(identity)) return false;
    identities.add(identity);
  }
  return true;
}

function validateJsonPointers(values: readonly string[]): boolean {
  return (
    Array.isArray(values) &&
    values.length > 0 &&
    values.length <= 1024 &&
    new Set(values).size === values.length &&
    values.every(
      (value) => typeof value === "string" && jsonPointer.test(value),
    )
  );
}

function hint(readiness: CodexProbeReadiness): CodexProbeHint {
  return {
    channel: "app",
    readiness,
    code:
      readiness === "ready"
        ? "available"
        : readiness === "unavailable"
          ? "install-or-auth-required"
          : "host-degraded",
  };
}

/**
 * Build a Codex ChatGPT desktop App project transaction. Shared Skills and
 * AGENTS are always the first layer. Project config/hooks are conditional,
 * and only explicit caller descriptors are projected; provider/plugin state
 * is represented as a borrowed native binding rather than copied TOML/JSON.
 */
export function buildCodexProjectionPlan(
  request: CodexProjectionRequest,
): CodexProjectionResult {
  try {
    const parsedShared = parseProjectionPlanV1(request.shared.plan);
    if (
      !parsedShared.success ||
      parsedShared.data.adapterId !== "adapter.codex" ||
      !["ready", "degraded", "unavailable"].includes(request.appReadiness)
    )
      return diagnostic("review", "invalid-input", "adapter");

    const selected = selectedCapabilities(request);
    if (!selected) return diagnostic("review", "invalid-input", "adapter");
    const inferred = inferAction(parsedShared.data);
    if (inferred === "mixed")
      return diagnostic("review", "invalid-input", "adapter");
    if (request.action !== undefined && request.action !== inferred)
      return diagnostic("review", "invalid-input", "adapter");
    const action = request.action ?? inferred;
    if (action !== "attach" && action !== "detach")
      return diagnostic("review", "invalid-input", "adapter");

    if (
      selected.includes("project-config") &&
      request.supportsProjectConfig !== true
    )
      return diagnostic(
        "unsupported",
        "unsupported-capability",
        "project-config",
      );
    if (selected.includes("hooks") && request.supportsHooks !== true)
      return diagnostic("unsupported", "unsupported-capability", "hooks");

    const providerIds = [...(request.providerIds ?? [])];
    const nativeMcp = [...(request.nativeBindings?.mcp ?? [])];
    const nativeHooks = [...(request.nativeBindings?.hooks ?? [])];
    if (
      !validateIds(providerIds) ||
      !validateIds(nativeMcp) ||
      !validateIds(nativeHooks) ||
      (providerIds.length > 0 && !selected.includes("mcp"))
    )
      return diagnostic("review", "invalid-input", "adapter");
    const mcpBindings = providerIds.length > 0 ? providerIds : nativeMcp;
    const missingNative: CodexProjectionCapability[] = [];
    if (
      selected.includes("project-config") &&
      action === "attach" &&
      !request.projectConfig
    )
      missingNative.push("project-config");
    if (
      selected.includes("hooks") &&
      action === "attach" &&
      !request.projectHooks &&
      nativeHooks.length === 0
    )
      missingNative.push("hooks");
    if (selected.includes("mcp") && mcpBindings.length === 0)
      missingNative.push("mcp");

    if (
      request.projectConfig &&
      (typeof request.projectConfig.content !== "string" ||
        request.projectConfig.content.length > 16 * 1024 * 1024 ||
        unsafeDescriptor.test(request.projectConfig.content) ||
        !validateTomlKeys(request.projectConfig.ownedTomlKeys))
    )
      return diagnostic("review", "invalid-input", "project-config");
    if (
      request.projectHooks &&
      (typeof request.projectHooks.content !== "string" ||
        request.projectHooks.content.length > 16 * 1024 * 1024 ||
        unsafeDescriptor.test(request.projectHooks.content) ||
        !validateJsonPointers(request.projectHooks.ownedJsonPointers))
    )
      return diagnostic("review", "invalid-input", "hooks");

    const surfaces = new Map<string, Uint8Array | null>();
    for (const surface of request.surfaces ?? []) {
      if (
        typeof surface.targetPath !== "string" ||
        !safeRelativePath(surface.targetPath) ||
        surfaces.has(surface.targetPath) ||
        (surface.content !== null &&
          (typeof surface.content !== "string" ||
            surface.content.length > 16 * 1024 * 1024))
      )
        return diagnostic("review", "invalid-input", "adapter");
      surfaces.set(
        surface.targetPath,
        surface.content === null ? null : encoder.encode(surface.content),
      );
    }

    const content = new Map<string, ProjectionContent>();
    const operations: ProjectionOperationV1[] = [
      ...parsedShared.data.operations,
    ];
    const observe = (targetPath: string): Uint8Array | null =>
      surfaces.has(targetPath)
        ? (surfaces.get(targetPath) ?? null)
        : request.shared.observe(targetPath);
    const addDescriptor = (
      name: "config" | "hooks",
      targetPath: ".codex/config.toml" | ".codex/hooks.json",
      format: "toml" | "json",
      descriptor: CodexProjectConfigDescriptor | CodexProjectHooksDescriptor,
    ): void => {
      const bytes = encoder.encode(descriptor.content);
      const contentRef = `codex.${name}.${fingerprintBytes(bytes).slice(7)}`;
      content.set(contentRef, {
        bytes,
        ...(name === "config"
          ? { ownedTomlKeys: (descriptor as CodexProjectConfigDescriptor).ownedTomlKeys }
          : {
              ownedJsonPointers: (descriptor as CodexProjectHooksDescriptor)
                .ownedJsonPointers,
            }),
      });
      const current = observe(targetPath);
      operations.push({
        id: `codex.${name}`,
        resourceId: `codex.${name}`,
        claimantId: "adapter.codex",
        action: action === "attach" ? "merge" : "remove",
        control: "pactile-owned",
        targetPath,
        format,
        contentRef: action === "attach" ? contentRef : null,
        desiredFingerprint: action === "attach" ? fingerprintBytes(bytes) : null,
        expectedCurrentFingerprint:
          current === null ? null : fingerprintBytes(current),
        externalAssetId: null,
      });
    };
    if (missingNative.length === 0 && action === "attach") {
      if (selected.includes("project-config") && request.projectConfig)
        addDescriptor("config", ".codex/config.toml", "toml", request.projectConfig);
      if (selected.includes("hooks") && request.projectHooks)
        addDescriptor("hooks", ".codex/hooks.json", "json", request.projectHooks);
    }
    if (action === "detach" && selected.includes("project-config")) {
      // There is no safe keyed-delete operation in the M1 ABI. A native
      // plugin/host owner must perform its own unregister, so do not emit a
      // destructive whole-file remove for a potentially mixed user file.
      missingNative.push("project-config");
    }
    if (
      action === "detach" &&
      selected.includes("hooks") &&
      (request.projectHooks !== undefined || nativeHooks.length === 0)
    )
      missingNative.push("hooks");

    const addBinding = (
      kind: "hooks" | "mcp",
      externalAssetId: string,
    ): void => {
      operations.push({
        id: `codex.${kind}.${externalAssetId}.${action}`,
        resourceId: `codex.native.${kind}.${externalAssetId}`,
        claimantId: "adapter.codex",
        action: action === "attach" ? "bind" : "detach",
        control: "borrowed",
        targetPath: null,
        format: "external-ref",
        contentRef: null,
        desiredFingerprint: null,
        expectedCurrentFingerprint: null,
        externalAssetId,
      });
    };
    if (missingNative.length === 0) {
      if (selected.includes("hooks"))
        for (const id of nativeHooks) addBinding("hooks", id);
      if (selected.includes("mcp"))
        for (const id of mcpBindings) addBinding("mcp", id);
    }

    const plan: ProjectionPlanV1 = {
      ...parsedShared.data,
      id: `codex.${parsedShared.data.generationId}`,
      operations,
    };
    const inputs: ProjectionInputs = {
      ...request.shared,
      plan,
      observe,
      resolveContent: (contentRef) =>
        content.get(contentRef) ?? request.shared.resolveContent(contentRef),
    };
    const probeHint = hint(request.appReadiness);
    const diagnostics: {
      code:
        | "native-binding-required"
        | "app-unavailable"
        | "detach-requires-native-owner";
      capability: CodexProjectionCapability | "app";
    }[] = missingNative.map((capability) => ({
      code:
        action === "detach" &&
        (capability === "project-config" || capability === "hooks")
          ? "detach-requires-native-owner"
          : "native-binding-required",
      capability,
    }));
    if (request.appReadiness !== "ready")
      diagnostics.push({ code: "app-unavailable", capability: "app" });
    if (diagnostics.length > 0)
      return {
        status: "degraded",
        inputs,
        probeHints: [probeHint],
        diagnostics,
      };
    return {
      status: "ready",
      inputs,
      probeHints: [probeHint],
      diagnostics: [],
    };
  } catch {
    return diagnostic("review", "invalid-input", "adapter");
  }
}
