import { createHash } from "node:crypto";
import {
  canonicalizePactileJsonV1,
  type InstallStateV1,
} from "../../core/index.js";
import { fingerprintBytes } from "../projection/planner.js";
import { GenerationStore, InstallStateStore } from "../runtime/stores.js";
import type { PactilePlatform } from "../registry.js";
import { createDefaultLifecycleAdapters } from "./default-adapters.js";
import {
  runLifecycleTransaction,
  type LifecycleGenerationFile,
  type LifecycleLegacyFile,
  type LifecycleRequest,
  type LifecycleResult,
  type LifecycleSource,
} from "./orchestrator.js";

export type LifecycleCommandOperation =
  | "init"
  | "update"
  | "import"
  | "reconcile";

export interface LifecycleCommandRequest {
  readonly projectRoot: string;
  readonly operation: LifecycleCommandOperation;
  readonly runtimeVersion: string;
  readonly files: readonly LifecycleGenerationFile[];
  readonly platforms: readonly PactilePlatform[];
  readonly occurredAt?: string;
  readonly materializeCanonical?: LifecycleRequest["materializeCanonical"];
  readonly legacy?: {
    readonly runtimeVersion: string | null;
    readonly schemaVersion: number | null;
    readonly files: readonly LifecycleLegacyFile[];
  };
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedFiles(
  files: readonly LifecycleGenerationFile[],
): readonly LifecycleGenerationFile[] {
  return [...files]
    .map((file) => ({
      path: file.path.replace(/\\/g, "/"),
      bytes: Buffer.from(file.bytes),
    }))
    .sort((left, right) => lexical(left.path, right.path));
}

function digestIdentity(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizePactileJsonV1(value))
    .digest("hex")
    .slice(0, 24);
}

function fileIdentity(files: readonly LifecycleGenerationFile[]): readonly {
  path: string;
  fingerprint: string;
}[] {
  return normalizedFiles(files).map((file) => ({
    path: file.path,
    fingerprint: fingerprintBytes(file.bytes),
  }));
}

function generationMatches(
  projectRoot: string,
  generationId: string,
  files: readonly LifecycleGenerationFile[],
): boolean {
  try {
    const seal = new GenerationStore(projectRoot).verify(generationId);
    return (
      canonicalizePactileJsonV1(seal.files) ===
      canonicalizePactileJsonV1(fileIdentity(files))
    );
  } catch {
    return false;
  }
}

function selectedPlatforms(
  platforms: readonly PactilePlatform[],
): readonly PactilePlatform[] {
  return [...new Set(platforms)].sort();
}

function sourceFor(
  request: LifecycleCommandRequest,
  install: ReturnType<InstallStateStore["read"]>,
  files: readonly LifecycleGenerationFile[],
): LifecycleSource {
  if (request.operation === "import") {
    if (!request.legacy) throw new Error("legacy-import-input-required");
    return {
      kind: "legacy",
      root: ".cstl",
      runtimeVersion: request.legacy.runtimeVersion,
      schemaVersion: request.legacy.schemaVersion,
      files: request.legacy.files,
    };
  }
  if (request.operation === "init") {
    if (install) throw new Error("canonical-install-already-present");
    return { kind: "fresh", files };
  }
  if (!install) throw new Error("canonical-install-state-required");
  return {
    kind: "canonical",
    generationId: install.state.generationId,
    runtimeVersion: install.state.runtimeVersion,
    schemaVersion: 1,
    files,
  };
}

/**
 * Command-facing lifecycle facade. IDs are derived from non-secret
 * fingerprints so a retry re-enters the same durable journal, while a changed
 * payload or Adapter set receives a distinct identity.
 */
export async function runLifecycleCommand(
  request: LifecycleCommandRequest,
): Promise<LifecycleResult> {
  const files = normalizedFiles(request.files);
  if (files.length === 0) throw new Error("canonical-generation-empty");
  const platforms = selectedPlatforms(request.platforms);
  const installs = new InstallStateStore(request.projectRoot);
  const install = installs.read();
  const source = sourceFor(request, install, files);
  const fileFacts = fileIdentity(files);
  const contentId = digestIdentity({
    runtimeVersion: request.runtimeVersion,
    files: fileFacts,
  });
  const generationId =
    source.kind === "canonical" &&
    generationMatches(request.projectRoot, source.generationId, files)
      ? source.generationId
      : `generation.${contentId}`;
  const transactionId = `lifecycle.${request.operation}.${digestIdentity({
    source:
      source.kind === "canonical"
        ? source.generationId
        : source.kind === "legacy"
          ? source.root
          : "fresh",
    generationId,
    runtimeVersion: request.runtimeVersion,
    platforms,
    files: fileFacts,
  })}`;
  return runLifecycleTransaction({
    projectRoot: request.projectRoot,
    id: transactionId,
    generationId,
    runtimeVersion: request.runtimeVersion,
    expectedInstallStateFingerprint: install?.fingerprint ?? null,
    occurredAt: request.occurredAt ?? new Date().toISOString(),
    source,
    adapters: createDefaultLifecycleAdapters(
      request.projectRoot,
      generationId,
      request.runtimeVersion,
      platforms,
    ),
    materializeCanonical: request.materializeCanonical,
  });
}

export function installedPactilePlatforms(
  state: InstallStateV1 | null,
): readonly PactilePlatform[] {
  if (!state) return [];
  const platforms: PactilePlatform[] = [];
  for (const adapter of state.installedAdapters) {
    if (adapter.status !== "active") continue;
    if (adapter.id === "adapter.codex") platforms.push("codex");
  }
  return selectedPlatforms(platforms);
}
