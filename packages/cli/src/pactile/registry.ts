import fs from "node:fs";
import path from "node:path";
import {
  ASSURANCE_LEVELS_V1,
  canonicalizePactileJsonV1,
  fingerprintPactileContractV1,
  parseCapabilityBindingV1,
  parseTileManifestV1,
  type AssuranceLevelV1,
  type PolicyCeilingV1,
} from "../core/index.js";
import * as taskKernelApi from "../core/task/index.js";
import { approvedExecuteTask } from "./task/authorization.js";
import { resolveSelectedTask, resolveTaskDir } from "./task/session.js";
import type { SessionJevRunIdentityV1 } from "./task/session-jev-receipt.js";
import type {
  TileCapabilityFact,
  CompiledComposition,
  TileCompositionRequest,
  TileProviderFact,
} from "./tiles/compiler.js";
import { compileTileComposition, intersectTilePolicies } from "./tiles/compiler.js";
import {
  buildTileCatalog,
  type TileCatalog,
} from "./tiles/catalog.js";
import {
  loadBaselineTileContent,
  BASELINE_TILE_IDS,
} from "./tiles/content/baseline/index.js";
import {
  loadOndemandTileContent,
  ONDEMAND_TILE_IDS,
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
import {
  decideTileSelection,
  normalizeTileSelectionReplayInput,
  prepareTileSelection,
  replayTileSelectionDecision,
  taskTileSelectionRequest,
  type TileLifecycleState,
  type TileSelectionDecision,
  type TileSelectionDecisionReceipt,
  type TileSelectionFact,
  type TileTaskLifecycleFact,
  type TileSelectionPlan,
  type TileSelectionRequest,
  type TileSelectionGrantFact,
  type TileSelectionLifecycleFailureCode,
  type TileSelectionLifecycleFailureReceipt,
  createTileSelectionLifecycleFailureReceipt,
} from "./tiles/selection.js";
import {
  adviseTileSelectionWithJevV1,
  type TileSelectionJevAdviceV1,
  type TileSelectionJevOptionsV1,
} from "./tiles/jev-selection.js";
import { resolveJevProjectEgressPolicyV1 } from "./jev/project-policy.js";
import type { TileDiagnostic } from "./tiles/loader.js";
import {
  replayTileSelectionSnapshot,
  writeTileSelectionSnapshot,
  type ReplayedTileSelectionSnapshot,
  type TileSelectionSnapshotResult,
  type WrittenTileSelectionSnapshot,
} from "./tiles/selection-receipts.js";

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

export interface Batch2TileSelectionSurface {
  readonly catalog: TileCatalog;
  readonly facts: readonly TileSelectionFact[];
}

/** Build the bundled baseline/on-demand registry facts without changing M0 Tile manifests. */
export function loadBatch2TileSelectionSurface(
  lifecycleByRef: Readonly<Record<string, TileLifecycleState>>,
): TileResult<Batch2TileSelectionSurface> {
  if (!isRecord(lifecycleByRef))
    return {
      success: false,
      diagnostics: [{ code: "tile-selection-lifecycle-incomplete", tileRef: null, relatedRef: null, path: "$.lifecycleByRef" }],
    };
  const loaded = loadBatch2TileCatalog();
  if (!loaded.success) return loaded;
  const baseline = new Set<string>(BASELINE_TILE_IDS);
  const ondemand = new Set<string>(ONDEMAND_TILE_IDS);
  const refs = new Set(loaded.data.entries.map((entry) => entry.ref));
  for (const [ref, lifecycle] of Object.entries(lifecycleByRef)) {
    if (!refs.has(ref))
      return {
        success: false,
        diagnostics: [{ code: "tile-selection-unknown-lifecycle-ref", tileRef: null, relatedRef: null, path: "$.lifecycleByRef" }],
      };
    if (!["active", "registered", "deprecated", "disabled", "retired", "degraded"].includes(lifecycle))
      return {
        success: false,
        diagnostics: [{ code: "tile-selection-invalid-lifecycle", tileRef: ref, relatedRef: null, path: "$.lifecycleByRef" }],
      };
  }
  if (Object.keys(lifecycleByRef).length !== refs.size)
    return {
      success: false,
      diagnostics: [{ code: "tile-selection-lifecycle-incomplete", tileRef: null, relatedRef: null, path: "$.lifecycleByRef" }],
    };
  const facts: TileSelectionFact[] = [];
  for (const entry of loaded.data.entries) {
    const id = entry.manifest.identity.id;
    const tier = baseline.has(id)
      ? "baseline"
      : ondemand.has(id)
        ? "on-demand"
        : null;
    if (!tier)
      return {
        success: false,
        diagnostics: [{ code: "tile-selection-unclassified", tileRef: entry.ref, relatedRef: null, path: "$.catalog" }],
      };
    facts.push({
      ref: entry.ref,
      tier,
      lifecycle: lifecycleByRef[entry.ref],
    });
  }
  return { success: true, data: { catalog: loaded.data, facts } };
}

/** Bundled product entry point from candidate offer through hard validation. */
export function prepareBatch2TileSelection(
  request: TileSelectionRequest,
  lifecycleByRef: Readonly<Record<string, TileLifecycleState>>,
): TileResult<TileSelectionPlan> {
  const surface = loadBatch2TileSelectionSurface(lifecycleByRef);
  if (!surface.success) return surface;
  return prepareTileSelection(surface.data.catalog, request, surface.data.facts);
}

/** Optional Jev advisory over the same checked bundled Tile selection surface. */
export async function prepareBatch2TileSelectionWithJevV1(
  request: TileSelectionRequest,
  lifecycleByRef: Readonly<Record<string, TileLifecycleState>>,
  jev?: TileSelectionJevOptionsV1,
): Promise<TileResult<TileSelectionJevAdviceV1>> {
  const surface = loadBatch2TileSelectionSurface(lifecycleByRef);
  if (!surface.success) return surface;
  return adviseTileSelectionWithJevV1({
    catalog: surface.data.catalog,
    request,
    facts: surface.data.facts,
    jev,
  });
}

export function decideBatch2TileSelection(
  request: TileSelectionRequest,
  decision: TileSelectionDecision,
  lifecycleByRef: Readonly<Record<string, TileLifecycleState>>,
): TileResult<TileSelectionDecisionReceipt> {
  const surface = loadBatch2TileSelectionSurface(lifecycleByRef);
  if (!surface.success) return surface;
  return decideTileSelection(surface.data.catalog, request, surface.data.facts, decision);
}

export function replayBatch2TileSelectionDecision(
  request: TileSelectionRequest,
  decision: TileSelectionDecision,
  lifecycleByRef: Readonly<Record<string, TileLifecycleState>>,
): TileResult<TileSelectionDecisionReceipt> {
  const surface = loadBatch2TileSelectionSurface(lifecycleByRef);
  if (!surface.success) return surface;
  return replayTileSelectionDecision(surface.data.catalog, request, surface.data.facts, decision);
}

export type SelectedTaskTileSelectionResult<T> = TileResult<T> | {
  readonly success: false;
  readonly diagnostics: readonly TileDiagnostic[];
  readonly receipt: TileSelectionLifecycleFailureReceipt;
};

export type SelectedTaskTileSelectionDecisionResult =
  | {
      readonly success: true;
      readonly data: TileSelectionDecisionReceipt;
      readonly snapshot: WrittenTileSelectionSnapshot;
    }
  | {
      readonly success: false;
      readonly diagnostics: readonly TileDiagnostic[];
      readonly receipt?: TileSelectionDecisionReceipt | TileSelectionLifecycleFailureReceipt;
    };

export const TILE_SELECTION_AUTHORIZATION_SCOPE_PREFIX = "pactile-tile-selection/v1:";

export interface TileSelectionAuthorizationGrantV1 {
  readonly schemaVersion: 1;
  readonly policyCeiling: PolicyCeilingV1;
  readonly capabilities: readonly TileCapabilityFact[];
  readonly providerFacts: readonly TileProviderFact[];
}

interface DerivedTaskSelectionAuthority {
  readonly policyCeiling: PolicyCeilingV1;
  readonly capabilities: readonly TileCapabilityFact[];
  readonly providerFacts: readonly TileProviderFact[];
  readonly fact: TileSelectionGrantFact;
}

interface SelectedTaskTileSelectionSurface extends Batch2TileSelectionSurface {
  readonly taskLifecycle: TileTaskLifecycleFact;
  readonly authority: DerivedTaskSelectionAuthority;
  readonly hasTaskKernelV2: boolean;
  readonly activeRunId: string | null;
  readonly approvalRunId: string | null;
}

interface TaskKernelLifecycleProjectionCompat {
  readonly taskId: string;
  readonly revision: number;
  readonly phase: TileTaskLifecycleFact["phase"];
  readonly condition: TileTaskLifecycleFact["condition"];
  readonly outcome: TileTaskLifecycleFact["outcome"];
  readonly approvalSnapshot: {
    readonly recorded: boolean;
    readonly runId: string | null;
    readonly approvedBy: string | null;
    readonly scope: string | null;
  };
  readonly gateSnapshot: {
    readonly runStart: { readonly phaseAllowsRun: boolean; readonly activeRunId: string | null };
  };
}

interface TaskKernelApiCompat {
  readonly readKernel: typeof taskKernelApi.readKernel;
  readonly readTaskKernel?: (request: { readonly root: string; readonly taskDir: string; readonly cwd?: string }) => unknown;
  readonly projectTaskKernelLifecycle?: (kernel: unknown) => TaskKernelLifecycleProjectionCompat;
}

const taskKernelCompat = taskKernelApi as unknown as TaskKernelApiCompat;

const DEFAULT_TILE_SELECTION_POLICY: PolicyCeilingV1 = {
  filesystem: "read",
  process: "none",
  network: "forbidden",
  credentials: "forbidden",
  privacy: "local-only",
  egressDestinations: [],
  telemetry: "local-only",
  cost: "low",
};

function safeDefaultTaskAuthority(): DerivedTaskSelectionAuthority {
  const body = {
    policyCeiling: DEFAULT_TILE_SELECTION_POLICY,
    capabilities: [] as readonly TileCapabilityFact[],
    providerFacts: [] as readonly TileProviderFact[],
  };
  return {
    ...body,
    fact: {
      source: "safe-default",
      assurance: "no-grant",
      fingerprint: fingerprintPactileContractV1(body),
    },
  };
}

function parseTaskSelectionGrant(
  scope: unknown,
  approved: boolean,
  catalog: TileCatalog,
  facts: readonly TileSelectionFact[],
): DerivedTaskSelectionAuthority {
  const fallback = safeDefaultTaskAuthority();
  if (
    !approved ||
    typeof scope !== "string" ||
    !scope.startsWith(TILE_SELECTION_AUTHORIZATION_SCOPE_PREFIX)
  )
    return fallback;
  try {
    const serialized = scope.slice(TILE_SELECTION_AUTHORIZATION_SCOPE_PREFIX.length);
    const parsed: unknown = JSON.parse(serialized);
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== 1 ||
      Object.keys(parsed).some((key) => !["schemaVersion", "policyCeiling", "capabilities", "providerFacts"].includes(key)) ||
      canonicalizePactileJsonV1(parsed) !== serialized
    )
      return fallback;
    const candidate = normalizeTileSelectionReplayInput(catalog, {
      intent: "exact",
      requiredOutputs: ["context.pack"],
      policyCeiling: parsed.policyCeiling as PolicyCeilingV1,
      capabilities: parsed.capabilities as TileCapabilityFact[],
      providerFacts: parsed.providerFacts as TileProviderFact[],
    }, facts);
    if (!candidate.success) return fallback;
    const request = candidate.data.request;
    const body = {
      policyCeiling: request.policyCeiling,
      capabilities: request.capabilities,
      providerFacts: request.providerFacts ?? [],
    };
    return {
      ...body,
      fact: {
        source: "task-kernel-approval-snapshot",
        assurance: "recorded-user-assertion",
        fingerprint: fingerprintPactileContractV1({ source: "task-kernel-approval-snapshot", body }),
      },
    };
  } catch {
    return fallback;
  }
}

function intersectRequestedCapabilities(
  requested: readonly TileCapabilityFact[],
  granted: readonly TileCapabilityFact[],
): TileCapabilityFact[] {
  const grantById = new Map(granted.map((fact) => [fact.id, fact]));
  return requested.flatMap((fact) => {
    const authorized = grantById.get(fact.id);
    if (!authorized) return [];
    const requestedRank = ASSURANCE_LEVELS_V1.indexOf(fact.assurance as AssuranceLevelV1);
    const authorizedRank = ASSURANCE_LEVELS_V1.indexOf(authorized.assurance);
    return [{
      id: fact.id,
      assurance: ASSURANCE_LEVELS_V1[Math.min(requestedRank, authorizedRank)],
    }];
  });
}

function intersectRequestedProviders(
  requested: readonly TileProviderFact[],
  granted: readonly TileProviderFact[],
): TileProviderFact[] {
  const grantedFacts = new Map(granted.map((fact) => [fingerprintPactileContractV1(fact), fact]));
  return requested.flatMap((fact) => {
    const exactGrant = grantedFacts.get(fingerprintPactileContractV1(fact));
    return exactGrant ? [exactGrant] : [];
  });
}

function applyTaskSelectionAuthority(
  surface: SelectedTaskTileSelectionSurface,
  request: Omit<TileSelectionRequest, "taskLifecycle">,
): TileResult<TileSelectionRequest> {
  const normalized = normalizeTileSelectionReplayInput(
    surface.catalog,
    request,
    surface.facts,
  );
  if (!normalized.success) return normalized;
  return {
    success: true,
    data: {
      ...normalized.data.request,
      policyCeiling: intersectTilePolicies(
        normalized.data.request.policyCeiling,
        surface.authority.policyCeiling,
      ),
      capabilities: intersectRequestedCapabilities(
        normalized.data.request.capabilities,
        surface.authority.capabilities,
      ),
      providerFacts: intersectRequestedProviders(
        normalized.data.request.providerFacts ?? [],
        surface.authority.providerFacts,
      ),
      taskLifecycle: surface.taskLifecycle,
    },
  };
}

function taskLifecycleFailure(
  reasonCode: TileSelectionLifecycleFailureCode,
  taskLifecycle: TileTaskLifecycleFact | null = null,
): SelectedTaskTileSelectionResult<never> {
  return {
    success: false,
    diagnostics: [{ code: reasonCode, tileRef: null, relatedRef: null, path: "$.taskLifecycle" }],
    receipt: createTileSelectionLifecycleFailureReceipt(reasonCode, taskLifecycle),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readStringList(value: unknown, maximum: number): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some((item) => typeof item !== "string")
  )
    return null;
  return [...new Set(value as string[])].sort();
}

function stableFilesystemPath(value: string): string {
  const resolved = fs.realpathSync.native(path.resolve(value)).replaceAll("\\", "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function selectedTaskProjectFingerprint(root: string): string {
  return fingerprintPactileContractV1({
    schemaVersion: 1,
    kind: "pactile.tile-selection.project-scope",
    root: stableFilesystemPath(root),
  });
}

function selectedTaskScopeFingerprint(
  projectFingerprint: string,
  taskDir: string,
): string {
  return fingerprintPactileContractV1({
    schemaVersion: 1,
    kind: "pactile.tile-selection.task-scope",
    projectFingerprint,
    taskDir: stableFilesystemPath(taskDir),
  });
}

interface SelectedTaskKernelFacts {
  readonly taskId: string;
  readonly revision: number;
  readonly phase: TileTaskLifecycleFact["phase"];
  readonly condition: TileTaskLifecycleFact["condition"];
  readonly outcome: TileTaskLifecycleFact["outcome"];
  readonly extras: Record<string, unknown> | null;
  readonly approvalScope: string | null;
  readonly executeApproved: boolean;
  readonly hasTaskKernelV2: boolean;
  readonly activeRunId: string | null;
  readonly approvalRunId: string | null;
}

function legacyApprovalScope(
  root: string,
  taskReference: string,
  taskId: string,
  phase: TileTaskLifecycleFact["phase"],
  extras: Record<string, unknown> | null,
): { readonly scope: string | null; readonly approved: boolean } {
  const value = extras?.execution_approval;
  if (!isRecord(value)) return { scope: null, approved: false };
  const structurallyApproved =
    phase === "execute" &&
    value.transition === "start-execution" &&
    value.approved_by === "user" &&
    value.task_id === taskId &&
    typeof value.scope === "string";
  if (!structurallyApproved) return { scope: typeof value.scope === "string" ? value.scope : null, approved: false };
  try {
    approvedExecuteTask(root, taskReference);
    return { scope: value.scope as string, approved: true };
  } catch {
    return { scope: value.scope as string, approved: false };
  }
}

function readSelectedTaskKernelFacts(
  root: string,
  taskDir: string,
  taskReference: string,
): SelectedTaskKernelFacts {
  if (taskKernelCompat.readTaskKernel && taskKernelCompat.projectTaskKernelLifecycle) {
    const document: unknown = taskKernelCompat.readTaskKernel({ root, taskDir, cwd: root });
    if (!isRecord(document)) throw new Error("kernel-read-failed");
    if (document.kind === "task-kernel-v2") {
      const projection = taskKernelCompat.projectTaskKernelLifecycle(document.kernel);
      const approved =
        projection.phase === "execute" &&
        (projection.condition === "ready" || projection.condition === "active") &&
        projection.outcome === null &&
        projection.approvalSnapshot.recorded &&
        projection.approvalSnapshot.runId !== null &&
        projection.approvalSnapshot.runId === projection.gateSnapshot.runStart.activeRunId &&
        projection.approvalSnapshot.approvedBy === "user" &&
        projection.gateSnapshot.runStart.phaseAllowsRun;
      return {
        taskId: projection.taskId,
        revision: projection.revision,
        phase: projection.phase,
        condition: projection.condition,
        outcome: projection.outcome,
        extras: null,
        approvalScope: projection.approvalSnapshot.scope,
        executeApproved: approved,
        hasTaskKernelV2: true,
        activeRunId: projection.gateSnapshot.runStart.activeRunId,
        approvalRunId: projection.approvalSnapshot.runId,
      };
    }
    if (document.kind === "legacy-task-kernel-v1" && isRecord(document.kernel) && isRecord(document.kernel.kernel)) {
      const kernel = document.kernel.kernel as unknown as ReturnType<typeof taskKernelCompat.readKernel>["kernel"];
      const extras = kernel.projection?.extras && isRecord(kernel.projection.extras)
        ? kernel.projection.extras
        : null;
      const approval = legacyApprovalScope(root, taskReference, kernel.identity.taskId, kernel.phase, extras);
      return {
        taskId: kernel.identity.taskId,
        revision: kernel.revision,
        phase: kernel.phase,
        condition: kernel.condition,
        outcome: kernel.outcome,
        extras,
        approvalScope: approval.scope,
        executeApproved: approval.approved,
        hasTaskKernelV2: false,
        activeRunId: null,
        approvalRunId: null,
      };
    }
    throw new Error("kernel-kind-unsupported");
  }

  const kernel = taskKernelCompat.readKernel({ taskDir, cwd: root }).kernel;
  const extras = kernel.projection?.extras && isRecord(kernel.projection.extras)
    ? kernel.projection.extras
    : null;
  const approval = legacyApprovalScope(root, taskReference, kernel.identity.taskId, kernel.phase, extras);
  return {
    taskId: kernel.identity.taskId,
    revision: kernel.revision,
    phase: kernel.phase,
    condition: kernel.condition,
    outcome: kernel.outcome,
    extras,
    approvalScope: approval.scope,
    executeApproved: approval.approved,
    hasTaskKernelV2: false,
    activeRunId: null,
    approvalRunId: null,
  };
}

/** Read the currently selected Task and derive explicit Tile activation facts from Kernel state. */
function loadSelectedTaskTileSelectionSurface(
  root: string,
  env: NodeJS.ProcessEnv,
): SelectedTaskTileSelectionResult<SelectedTaskTileSelectionSurface> {
  let selected: ReturnType<typeof resolveSelectedTask>;
  try {
    selected = resolveSelectedTask(root, env);
  } catch {
    return taskLifecycleFailure("tile-selection-task-read-failed");
  }
  if (!selected.taskPath) return taskLifecycleFailure("tile-selection-no-current-task");
  if (selected.stale) return taskLifecycleFailure("tile-selection-task-stale");

  let taskDir: string;
  let kernelFacts: SelectedTaskKernelFacts;
  try {
    taskDir = resolveTaskDir(root, selected.taskPath);
    kernelFacts = readSelectedTaskKernelFacts(root, taskDir, selected.taskPath);
  } catch {
    return taskLifecycleFailure("tile-selection-task-read-failed");
  }
  let projectFingerprint: string;
  let scopeFingerprint: string;
  try {
    projectFingerprint = selectedTaskProjectFingerprint(root);
    scopeFingerprint = selectedTaskScopeFingerprint(projectFingerprint, taskDir);
  } catch {
    return taskLifecycleFailure("tile-selection-task-read-failed");
  }
  const taskLifecycle: TileTaskLifecycleFact = {
    taskId: kernelFacts.taskId,
    projectFingerprint,
    scopeFingerprint,
    selectionGrant: safeDefaultTaskAuthority().fact,
    revision: kernelFacts.revision,
    phase: kernelFacts.phase,
    condition: kernelFacts.condition,
    outcome: kernelFacts.outcome,
  };
  const extras = kernelFacts.extras;
  let baselineActive: string[];
  let registered: string[];
  let ondemandActive: string[];
  let degraded: string[];
  if (kernelFacts.hasTaskKernelV2) {
    baselineActive = [...BASELINE_TILE_IDS];
    registered = [...ONDEMAND_TILE_IDS];
    ondemandActive = [];
    degraded = [];
  } else {
    if (!extras)
      return taskLifecycleFailure("tile-selection-task-lifecycle-missing", taskLifecycle);
    const baselineBlock = extras.baseline_modules;
    const ondemandBlock = extras.ondemand_modules;
    if (!isRecord(baselineBlock) || !isRecord(ondemandBlock))
      return taskLifecycleFailure("tile-selection-task-lifecycle-missing", taskLifecycle);
    const parsedBaselineActive = readStringList(baselineBlock.active, BASELINE_TILE_IDS.length);
    const parsedRegistered = readStringList(ondemandBlock.registered, ONDEMAND_TILE_IDS.length);
    const parsedOndemandActive = readStringList(ondemandBlock.active, ONDEMAND_TILE_IDS.length);
    const parsedDegraded = readStringList(ondemandBlock.degraded, ONDEMAND_TILE_IDS.length);
    if (!parsedBaselineActive || !parsedRegistered || !parsedOndemandActive || !parsedDegraded)
      return taskLifecycleFailure("tile-selection-task-lifecycle-missing", taskLifecycle);
    baselineActive = parsedBaselineActive;
    registered = parsedRegistered;
    ondemandActive = parsedOndemandActive;
    degraded = parsedDegraded;
  }

  const baselineIds = new Set<string>(BASELINE_TILE_IDS);
  const knownOnDemand = new Set<string>(ONDEMAND_TILE_IDS);
  if (
    baselineActive.some((id) => !baselineIds.has(id)) ||
    registered.some((id) => !knownOnDemand.has(id)) ||
    ondemandActive.some((id) => !knownOnDemand.has(id) || !registered.includes(id)) ||
    degraded.some((id) => !knownOnDemand.has(id) || !registered.includes(id))
  )
    return taskLifecycleFailure("tile-selection-task-lifecycle-invalid", taskLifecycle);

  const catalog = loadBatch2TileCatalog();
  if (!catalog.success) return catalog;
  const degradedSet = new Set(degraded);
  const registeredSet = new Set(registered);
  const activeOnDemandSet = new Set(ondemandActive);
  const activeBaselineSet = new Set(baselineActive);
  const lifecycleByRef: Record<string, TileLifecycleState> = {};
  const baseline = new Set<string>(BASELINE_TILE_IDS);
  const ondemand = new Set<string>(ONDEMAND_TILE_IDS);
  for (const entry of catalog.data.entries) {
    const id = entry.manifest.identity.id;
    const tier = baseline.has(id)
      ? "baseline"
      : ondemand.has(id)
        ? "on-demand"
        : null;
    if (!tier)
      return {
        success: false,
        diagnostics: [{ code: "tile-selection-unclassified", tileRef: entry.ref, relatedRef: null, path: "$.catalog" }],
      };
    lifecycleByRef[entry.ref] = tier === "baseline"
      ? (activeBaselineSet.has(id) ? "active" : "disabled")
      : !registeredSet.has(id)
        ? "retired"
        : degradedSet.has(id)
          ? "degraded"
          : activeOnDemandSet.has(id)
            ? "active"
            : "registered";
  }
  const surface = loadBatch2TileSelectionSurface(lifecycleByRef);
  if (!surface.success) return surface;
  const authority = parseTaskSelectionGrant(
    kernelFacts.approvalScope,
    kernelFacts.executeApproved,
    surface.data.catalog,
    surface.data.facts,
  );
  const lifecycleWithGrant: TileTaskLifecycleFact = {
    ...taskLifecycle,
    selectionGrant: authority.fact,
  };
  return {
    success: true,
    data: {
      ...surface.data,
      taskLifecycle: lifecycleWithGrant,
      authority,
      hasTaskKernelV2: kernelFacts.hasTaskKernelV2,
      activeRunId: kernelFacts.activeRunId,
      approvalRunId: kernelFacts.approvalRunId,
    },
  };
}

function trustedSessionJevRunIdentity(
  surface: SelectedTaskTileSelectionSurface,
): SessionJevRunIdentityV1 | null {
  if (
    !surface.hasTaskKernelV2 ||
    typeof surface.activeRunId !== "string" ||
    surface.activeRunId.length === 0 ||
    typeof surface.approvalRunId !== "string" ||
    surface.approvalRunId.length === 0
  )
    return null;
  return {
    activeRunId: surface.activeRunId,
    approvalRunId: surface.approvalRunId,
  };
}

/** Current-task product entry point; missing or unreadable Kernel facts fail closed with a receipt. */
export function prepareSelectedTaskBatch2TileSelection(
  root: string,
  request: Omit<TileSelectionRequest, "taskLifecycle">,
  env: NodeJS.ProcessEnv = process.env,
): SelectedTaskTileSelectionResult<TileSelectionPlan> {
  const surface = loadSelectedTaskTileSelectionSurface(root, env);
  if (!surface.success) return surface;
  const effective = applyTaskSelectionAuthority(surface.data, request);
  if (!effective.success) return effective;
  return prepareTileSelection(
    surface.data.catalog,
    effective.data,
    surface.data.facts,
  );
}

function applySelectedTaskAgentTileProfile(
  surface: SelectedTaskTileSelectionSurface,
): TileResult<TileSelectionRequest> {
  const base = taskTileSelectionRequest(surface.taskLifecycle.phase);
  const authority = surface.authority;
  const request = authority.fact.source === "task-kernel-approval-snapshot"
    ? {
        ...base,
        policyCeiling: authority.policyCeiling,
        capabilities: authority.capabilities,
        providerFacts: authority.providerFacts,
      }
    : base;
  return applyTaskSelectionAuthority(surface, request);
}

/** Agent session profile: read-only default, widened only by a recorded active Run grant. */
export function prepareSelectedTaskAgentTileSelection(
  root: string,
  expectedLifecycle?: {
    readonly taskId: string;
    readonly phase: TileTaskLifecycleFact["phase"];
    readonly revision: number;
    readonly activeRunId?: string | null;
    readonly approvalRunId?: string | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): SelectedTaskTileSelectionResult<TileSelectionPlan> {
  const surface = loadSelectedTaskTileSelectionSurface(root, env);
  if (!surface.success) return surface;
  // Session context is compiled from a Kernel read immediately before this
  // call. If the selection, phase, or revision changed in between, avoid
  // mixing facts from two Tasks or Kernel snapshots.
  if (
    expectedLifecycle && (
      surface.data.taskLifecycle.taskId !== expectedLifecycle.taskId ||
      surface.data.taskLifecycle.phase !== expectedLifecycle.phase ||
      surface.data.taskLifecycle.revision !== expectedLifecycle.revision ||
      (expectedLifecycle.activeRunId !== undefined &&
        surface.data.activeRunId !== expectedLifecycle.activeRunId) ||
      (expectedLifecycle.approvalRunId !== undefined &&
        surface.data.approvalRunId !== expectedLifecycle.approvalRunId)
    )
  )
    return taskLifecycleFailure("tile-selection-task-read-failed", surface.data.taskLifecycle);
  const effective = applySelectedTaskAgentTileProfile(surface.data);
  if (!effective.success) return effective;
  return prepareTileSelection(surface.data.catalog, effective.data, surface.data.facts);
}

/** Optional Jev advice after rebuilding the current Kernel-bound Agent profile. */
export async function prepareSelectedTaskAgentTileSelectionWithJevV1(
  root: string,
  jev?: TileSelectionJevOptionsV1,
  expectedLifecycle?: {
    readonly taskId: string;
    readonly phase: TileTaskLifecycleFact["phase"];
    readonly revision: number;
    readonly activeRunId?: string | null;
    readonly approvalRunId?: string | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<SelectedTaskTileSelectionResult<TileSelectionJevAdviceV1>> {
  const surface = loadSelectedTaskTileSelectionSurface(root, env);
  if (!surface.success) return surface;
  if (
    expectedLifecycle && (
      surface.data.taskLifecycle.taskId !== expectedLifecycle.taskId ||
      surface.data.taskLifecycle.phase !== expectedLifecycle.phase ||
      surface.data.taskLifecycle.revision !== expectedLifecycle.revision ||
      (expectedLifecycle.activeRunId !== undefined &&
        surface.data.activeRunId !== expectedLifecycle.activeRunId) ||
      (expectedLifecycle.approvalRunId !== undefined &&
        surface.data.approvalRunId !== expectedLifecycle.approvalRunId)
    )
  )
    return taskLifecycleFailure("tile-selection-task-read-failed", surface.data.taskLifecycle);
  if (jev && !trustedSessionJevRunIdentity(surface.data))
    return taskLifecycleFailure("tile-selection-task-read-failed", surface.data.taskLifecycle);
  const effective = applySelectedTaskAgentTileProfile(surface.data);
  if (!effective.success) return effective;
  return adviseTileSelectionWithJevV1({
    catalog: surface.data.catalog,
    request: effective.data,
    facts: surface.data.facts,
    jev: jev
      ? {
          ...jev,
          projectEgressPolicy: resolveJevProjectEgressPolicyV1(root),
        }
      : undefined,
  });
}

/** Rebuild the current Agent profile from Kernel facts, then recompile a session offer decision. */
export function decideSelectedTaskAgentTileSelection(
  root: string,
  decision: TileSelectionDecision,
  env: NodeJS.ProcessEnv = process.env,
  sessionJevAdviceFingerprint?: string,
): SelectedTaskTileSelectionDecisionResult {
  const surface = loadSelectedTaskTileSelectionSurface(root, env);
  if (!surface.success) return surface;
  const effective = applySelectedTaskAgentTileProfile(surface.data);
  if (!effective.success) return effective;
  const decisionRunIdentity = sessionJevAdviceFingerprint !== undefined
    ? trustedSessionJevRunIdentity(surface.data)
    : null;
  if (sessionJevAdviceFingerprint !== undefined && !decisionRunIdentity)
    return {
      success: false,
      diagnostics: [{ code: "tile-selection-session-jev-advice-stale", tileRef: null, relatedRef: null, path: "$.sessionJev" }],
    };
  if (sessionJevAdviceFingerprint !== undefined) {
    const currentOffer = prepareTileSelection(
      surface.data.catalog,
      effective.data,
      surface.data.facts,
    );
    if (!currentOffer.success || currentOffer.data.offer.fingerprint !== decision.offerFingerprint)
      return {
        success: false,
        diagnostics: [{ code: "tile-selection-session-jev-advice-stale", tileRef: null, relatedRef: null, path: "$.sessionJev" }],
      };
  }
  const result = decideTileSelection(
    surface.data.catalog,
    effective.data,
    surface.data.facts,
    decision,
  );
  if (!result.success) return result;
  if (sessionJevAdviceFingerprint !== undefined) {
    const latestSurface = loadSelectedTaskTileSelectionSurface(root, env);
    if (!latestSurface.success)
      return { success: false, diagnostics: latestSurface.diagnostics };
    const latestRunIdentity = trustedSessionJevRunIdentity(latestSurface.data);
    if (
      !latestRunIdentity ||
      latestRunIdentity.activeRunId !== decisionRunIdentity?.activeRunId ||
      latestRunIdentity.approvalRunId !== decisionRunIdentity?.approvalRunId
    )
      return {
        success: false,
        diagnostics: [{ code: "tile-selection-session-jev-advice-stale", tileRef: null, relatedRef: null, path: "$.sessionJev" }],
      };
    const latestEffective = applySelectedTaskAgentTileProfile(latestSurface.data);
    if (!latestEffective.success)
      return { success: false, diagnostics: latestEffective.diagnostics };
    const latestOffer = prepareTileSelection(
      latestSurface.data.catalog,
      latestEffective.data,
      latestSurface.data.facts,
    );
    if (!latestOffer.success || latestOffer.data.offer.fingerprint !== result.data.offerFingerprint)
      return {
        success: false,
        diagnostics: [{ code: "tile-selection-session-jev-advice-stale", tileRef: null, relatedRef: null, path: "$.sessionJev" }],
      };
  }
  const stored = writeTileSelectionSnapshot(
    root,
    surface.data.catalog,
    effective.data,
    surface.data.facts,
    decision,
    result.data,
    sessionJevAdviceFingerprint,
    decisionRunIdentity ?? undefined,
  );
  if (!stored.success)
    return {
      success: false,
      diagnostics: stored.diagnostics,
      receipt: result.data,
    };
  return { success: true, data: result.data, snapshot: stored.data };
}

export function decideSelectedTaskBatch2TileSelection(
  root: string,
  request: Omit<TileSelectionRequest, "taskLifecycle">,
  decision: TileSelectionDecision,
  env: NodeJS.ProcessEnv = process.env,
): SelectedTaskTileSelectionDecisionResult {
  const surface = loadSelectedTaskTileSelectionSurface(root, env);
  if (!surface.success) return surface;
  const effective = applyTaskSelectionAuthority(surface.data, request);
  if (!effective.success) return effective;
  const result = decideTileSelection(
    surface.data.catalog,
    effective.data,
    surface.data.facts,
    decision,
  );
  if (!result.success) return result;
  const stored = writeTileSelectionSnapshot(
    root,
    surface.data.catalog,
    effective.data,
    surface.data.facts,
    decision,
    result.data,
  );
  if (!stored.success)
    return {
      success: false,
      diagnostics: stored.diagnostics,
      receipt: result.data,
    };
  return { success: true, data: result.data, snapshot: stored.data };
}

export function replaySelectedTaskBatch2TileSelectionDecision(
  root: string,
  request: Omit<TileSelectionRequest, "taskLifecycle">,
  decision: TileSelectionDecision,
  env: NodeJS.ProcessEnv = process.env,
): SelectedTaskTileSelectionResult<TileSelectionDecisionReceipt> {
  const surface = loadSelectedTaskTileSelectionSurface(root, env);
  if (!surface.success) return surface;
  const effective = applyTaskSelectionAuthority(surface.data, request);
  if (!effective.success) return effective;
  return replayTileSelectionDecision(
    surface.data.catalog,
    effective.data,
    surface.data.facts,
    decision,
  );
}

/** Replay a previously stored Task decision without reading mutable Task state. */
export function replayStoredSelectedTaskBatch2TileSelectionDecision(
  root: string,
  snapshotFingerprint: string,
): TileSelectionSnapshotResult<ReplayedTileSelectionSnapshot> {
  const catalog = loadBatch2TileCatalog();
  if (!catalog.success) return catalog;
  return replayTileSelectionSnapshot(root, snapshotFingerprint, catalog.data);
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
