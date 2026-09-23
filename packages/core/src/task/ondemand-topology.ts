/**
 * Stage 5 Topology + typed Dependency Graph + On-demand activation
 * (P28 Topology, P29 On-demand, P30 Stage 5, P18 Prefer native parallel).
 *
 * Pure helpers persisted through existing create extras / patch. Does not
 * write Kernel store or task.json. Field names here are an implementation
 * choice — not a frozen Manifest schema. Does not schedule workers.
 */

import { KernelError } from "./kernel-contract.js";
import { isPlainObject } from "./schema.js";

export const STAGE5_SOURCE = "stage5-ondemand-topology";
export const STAGE5_SCHEMA_VERSION = 1 as const;

export const TOPOLOGY_KINDS = ["single", "parent-child"] as const;
export type TopologyKind = (typeof TOPOLOGY_KINDS)[number];

export const DEPENDENCY_EDGE_TYPES = ["requires", "advisory"] as const;
export type DependencyEdgeType = (typeof DEPENDENCY_EDGE_TYPES)[number];

export type Stage5CommandPhase = "create" | "start" | "archive" | "patch";

export const LIFECYCLE_SLOTS = [
  "define",
  "approve",
  "execute",
  "verify",
  "close",
] as const;

export const STAGE5_ONDEMAND_MODULES = [
  "define-extended",
  "independent-check",
  "worker-orchestration",
  "parent-child",
  "debug-recovery",
  "session-transfer",
  "spec-learning",
  "vcs-integration",
  "personal-memory",
  "retention-storage",
  "retrieval-extended",
] as const;

export const PROFILE_BASELINE_MODULES = [
  "intake-basic",
  "define-basic",
  "approval-personal",
  "execute-agent",
  "verify-basic",
  "close-basic",
  "context-progressive",
  "observability-local",
] as const;

export type Stage5OndemandModule = (typeof STAGE5_ONDEMAND_MODULES)[number];

export const ONDEMAND_OWNERS: Readonly<Record<string, string>> = {
  "integration-handoff": "parent-child",
  "session-transfer": "session-transfer",
};

export const LITE_DORMANT_ONDEMAND = [
  "parent-child",
  "vcs-integration",
  "personal-memory",
  "retention-storage",
] as const;

export interface TopologyState {
  schema_version: typeof STAGE5_SCHEMA_VERSION;
  kind: TopologyKind;
  parent_id: string | null;
  children: string[];
}

export interface DependencyEdge {
  from: string;
  to: string;
  type: DependencyEdgeType;
}

export interface DependencyGraph {
  schema_version: typeof STAGE5_SCHEMA_VERSION;
  edges: DependencyEdge[];
}

export interface OndemandTrigger {
  module: string;
  at: string;
  reason: string;
}

export interface OndemandModules {
  schema_version: typeof STAGE5_SCHEMA_VERSION;
  source: typeof STAGE5_SOURCE;
  registered: string[];
  active: string[];
  triggers: OndemandTrigger[];
  owners: Record<string, string>;
  degraded: string[];
}

export interface BaselineModules {
  schema_version: typeof STAGE5_SCHEMA_VERSION;
  source: "profile-runtime";
  active: string[];
}

export interface DecomposeProposal {
  parent_id: string;
  slices: string[];
  confirmed: boolean;
  children_created: string[];
}

export interface CaptureCandidate {
  kind: "candidate";
  summary: string;
  task_created: false;
}

export interface TaskMapGraphProjection {
  graph_authority: "kernel-extras";
  topology_kind: TopologyKind;
  parent_id: string | null;
  children: { id: string; depends_on: string[] }[];
}

export interface Stage5RecordHint {
  id?: string;
  parent?: string | null;
  children?: string[];
}

export function topologyKindFromChildren(
  children: readonly string[],
): TopologyKind {
  return uniqueStrings(children).length > 0 ? "parent-child" : "single";
}

export function defaultTopology(record?: Stage5RecordHint): TopologyState {
  const parent =
    typeof record?.parent === "string" && record.parent.trim() !== ""
      ? record.parent
      : null;
  const children = uniqueStrings(record?.children ?? []);
  return {
    schema_version: STAGE5_SCHEMA_VERSION,
    kind: topologyKindFromChildren(children),
    parent_id: parent,
    children,
  };
}

export function defaultOndemandModules(): OndemandModules {
  return {
    schema_version: STAGE5_SCHEMA_VERSION,
    source: STAGE5_SOURCE,
    registered: [...STAGE5_ONDEMAND_MODULES],
    active: [],
    triggers: [],
    owners: { ...ONDEMAND_OWNERS },
    degraded: [],
  };
}

export function defaultBaselineModules(): BaselineModules {
  return {
    schema_version: STAGE5_SCHEMA_VERSION,
    source: "profile-runtime",
    active: [...PROFILE_BASELINE_MODULES],
  };
}

export function defaultDependencyGraph(): DependencyGraph {
  return { schema_version: STAGE5_SCHEMA_VERSION, edges: [] };
}

export function captureCandidate(summary: string): CaptureCandidate {
  return {
    kind: "candidate",
    summary: summary.trim(),
    task_created: false,
  };
}

export function proposeDecompose(
  parentId: string,
  slices: readonly string[],
): DecomposeProposal {
  return {
    parent_id: parentId,
    slices: uniqueStrings(slices),
    confirmed: false,
    children_created: [],
  };
}

export function confirmDecompose(proposal: DecomposeProposal): DecomposeProposal {
  return {
    ...proposal,
    confirmed: true,
    children_created: [...proposal.slices],
  };
}

export function applyRetention(outcome: string): string {
  return outcome;
}

export function assignParent(
  topology: TopologyState,
  parentId: string,
): TopologyState {
  const next = parentId.trim();
  if (!next) {
    throw new KernelError("INVALID_REQUEST", "parent_id must be a non-empty string");
  }
  if (topology.parent_id && topology.parent_id !== next) {
    throw new KernelError(
      "INVALID_REQUEST",
      `single-parent tree: second parent rejected (${topology.parent_id} vs ${next})`,
    );
  }
  return {
    schema_version: STAGE5_SCHEMA_VERSION,
    kind: topologyKindFromChildren(topology.children),
    parent_id: next,
    children: [...topology.children],
  };
}

export function assertIntegrationAuthority(actorRole: string): void {
  if (actorRole === "parent") return;
  throw new KernelError(
    "INVALID_REQUEST",
    "Integration authority stays with Parent; Child cannot integrate-child",
  );
}

export function expandDependsOnToRequires(
  graph: DependencyGraph,
  fromId: string,
  dependsOn: readonly string[],
): DependencyGraph {
  const edges = [...graph.edges];
  for (const dep of uniqueStrings(dependsOn)) {
    if (hasEdge(edges, fromId, dep, "requires")) continue;
    edges.push({ from: fromId, to: dep, type: "requires" });
  }
  return { schema_version: STAGE5_SCHEMA_VERSION, edges };
}

export function unmetRequires(
  graph: DependencyGraph,
  satisfied: readonly string[],
  fromId?: string,
): string[] {
  const done = new Set(satisfied);
  const missing: string[] = [];
  for (const edge of graph.edges) {
    if (edge.type !== "requires") continue;
    if (fromId && edge.from !== fromId) continue;
    if (done.has(edge.to)) continue;
    if (!missing.includes(edge.to)) missing.push(edge.to);
  }
  return missing;
}

export function projectTaskMapGraph(
  topology: TopologyState,
  graph: DependencyGraph,
): TaskMapGraphProjection {
  const children = topology.children.map((id) => ({
    id,
    depends_on: graph.edges
      .filter((edge) => edge.type === "requires" && edge.from === id)
      .map((edge) => edge.to),
  }));
  return {
    graph_authority: "kernel-extras",
    topology_kind: topology.kind,
    parent_id: topology.parent_id,
    children,
  };
}

export function renderTaskMapProjection(projection: TaskMapGraphProjection): string {
  const lines = [
    "graph_authority: kernel-extras",
    `topology_kind: ${projection.topology_kind}`,
    `parent_id: ${projection.parent_id ?? "null"}`,
    "children:",
  ];
  if (projection.children.length === 0) {
    lines.push("  []");
  } else {
    for (const child of projection.children) {
      const deps =
        child.depends_on.length === 0
          ? "[]"
          : `[${child.depends_on.join(", ")}]`;
      lines.push(`  - id: ${child.id}`);
      lines.push(`    depends_on: ${deps}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function residentOnDemandModules(
  extras: Record<string, unknown>,
): string[] {
  return readOndemandModules(extras).active;
}

export function activateOnDemand(
  extras: Record<string, unknown>,
  moduleName: string,
  reason: string,
  at = new Date().toISOString(),
): OndemandModules {
  const current = readOndemandModules(extras);
  if (!current.registered.includes(moduleName)) {
    throw new KernelError(
      "INVALID_REQUEST",
      `On-demand module is not registered: ${moduleName}`,
    );
  }
  const triggers = [
    ...current.triggers,
    { module: moduleName, at, reason: reason.trim() || "trigger" },
  ];
  const active = current.active.includes(moduleName)
    ? [...current.active]
    : [...current.active, moduleName];
  const next: OndemandModules = { ...current, active, triggers };
  extras.ondemand_modules = next;
  return next;
}

export function normalizeTopology(raw: unknown, record?: Stage5RecordHint): TopologyState {
  if (raw === undefined || raw === null) return defaultTopology(record);
  if (!isPlainObject(raw)) {
    throw new KernelError("INVALID_REQUEST", "topology must be a JSON object");
  }
  const kind = raw.kind === "parent-child" ? "parent-child" : raw.kind === "single" ? "single" : null;
  if (kind === null) {
    throw new KernelError(
      "INVALID_REQUEST",
      "topology.kind must be single or parent-child",
    );
  }
  const parentId =
    raw.parent_id === null || raw.parent_id === undefined
      ? null
      : requireId(raw.parent_id, "topology.parent_id");
  const children = uniqueStrings(asStringArray(raw.children));
  const seeded = defaultTopology(record);
  if (parentId && seeded.parent_id && parentId !== seeded.parent_id) {
    throw new KernelError(
      "INVALID_REQUEST",
      `single-parent tree: second parent rejected (${parentId} vs ${seeded.parent_id})`,
    );
  }
  const resolvedParent = parentId ?? seeded.parent_id;
  const resolvedChildren = uniqueStrings([...children, ...seeded.children]);
  return {
    schema_version: STAGE5_SCHEMA_VERSION,
    kind: topologyKindFromChildren(resolvedChildren),
    parent_id: resolvedParent,
    children: resolvedChildren,
  };
}

export function normalizeDependencyGraph(raw: unknown): DependencyGraph {
  if (raw === undefined || raw === null) return defaultDependencyGraph();
  if (!isPlainObject(raw)) {
    throw new KernelError("INVALID_REQUEST", "dependency_graph must be a JSON object");
  }
  const edgesIn = raw.edges;
  if (edgesIn === undefined || edgesIn === null) return defaultDependencyGraph();
  if (!Array.isArray(edgesIn)) {
    throw new KernelError("INVALID_REQUEST", "dependency_graph.edges must be an array");
  }
  const edges: DependencyEdge[] = [];
  for (const item of edgesIn) {
    if (!isPlainObject(item)) {
      throw new KernelError("INVALID_REQUEST", "dependency_graph.edges[] must be objects");
    }
    if (item.type !== "requires" && item.type !== "advisory") {
      throw new KernelError(
        "INVALID_REQUEST",
        "dependency_graph.edges[].type must be requires or advisory",
      );
    }
    const edge: DependencyEdge = {
      from: requireId(item.from, "dependency_graph.edges[].from"),
      to: requireId(item.to, "dependency_graph.edges[].to"),
      type: item.type,
    };
    if (!hasEdge(edges, edge.from, edge.to, edge.type)) edges.push(edge);
  }
  return { schema_version: STAGE5_SCHEMA_VERSION, edges };
}

export function normalizeBaselineModules(raw: unknown): BaselineModules {
  const defaults = defaultBaselineModules();
  if (raw === undefined || raw === null) return defaults;
  if (!isPlainObject(raw)) {
    throw new KernelError("INVALID_REQUEST", "baseline_modules must be a JSON object");
  }
  if (!("active" in raw)) return defaults;
  const allowed = new Set<string>(PROFILE_BASELINE_MODULES);
  return {
    schema_version: STAGE5_SCHEMA_VERSION,
    source: "profile-runtime",
    active: uniqueStrings(asStringArray(raw.active)).filter((name) => allowed.has(name)),
  };
}

export function normalizeOndemandModules(raw: unknown): OndemandModules {
  if (raw === undefined || raw === null) return defaultOndemandModules();
  if (!isPlainObject(raw)) {
    throw new KernelError("INVALID_REQUEST", "ondemand_modules must be a JSON object");
  }
  const defaults = defaultOndemandModules();
  const registered = uniqueStrings([
    ...defaults.registered,
    ...asStringArray(raw.registered),
  ]);
  const active = uniqueStrings(asStringArray(raw.active)).filter((name) =>
    registered.includes(name),
  );
  const degraded = uniqueStrings(asStringArray(raw.degraded));
  const triggers = Array.isArray(raw.triggers)
    ? raw.triggers.filter(isPlainObject).map((item) => ({
        module: typeof item.module === "string" ? item.module : "",
        at: typeof item.at === "string" ? item.at : "",
        reason: typeof item.reason === "string" ? item.reason : "",
      }))
    : [];
  const owners = isPlainObject(raw.owners)
    ? {
        ...defaults.owners,
        ...Object.fromEntries(
          Object.entries(raw.owners).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
      }
    : { ...defaults.owners };
  return {
    schema_version: STAGE5_SCHEMA_VERSION,
    source: STAGE5_SOURCE,
    registered,
    active,
    triggers,
    owners,
    degraded,
  };
}

export function readTopology(extras: Record<string, unknown>): TopologyState {
  return normalizeTopology(extras.topology);
}

export function readDependencyGraph(extras: Record<string, unknown>): DependencyGraph {
  return normalizeDependencyGraph(extras.dependency_graph);
}

export function readOndemandModules(extras: Record<string, unknown>): OndemandModules {
  return normalizeOndemandModules(extras.ondemand_modules);
}

export function normalizeStage5InExtras(
  extras: Record<string, unknown>,
  record?: Stage5RecordHint,
): void {
  assertUnconfirmedChildCreation(extras, existingTopologyChildren(extras), record);
  extras.topology = normalizeTopology(extras.topology, record);
  let graph = normalizeDependencyGraph(extras.dependency_graph);
  const selfId = typeof record?.id === "string" ? record.id : "";
  const dependsOn = asStringArray(extras.depends_on);
  if (selfId && dependsOn.length > 0) {
    graph = expandDependsOnToRequires(graph, selfId, dependsOn);
  }
  extras.dependency_graph = graph;
  extras.ondemand_modules = normalizeOndemandModules(extras.ondemand_modules);
  extras.baseline_modules = normalizeBaselineModules(extras.baseline_modules);

  const missing = uniqueStrings(asStringArray(extras.ondemand_required_missing));
  if (missing.length > 0) {
    const modules = extras.ondemand_modules as OndemandModules;
    extras.ondemand_modules = {
      ...modules,
      degraded: uniqueStrings([...modules.degraded, ...missing]),
    };
    extras.profile_health = "degraded";
  }

  const topology = extras.topology as TopologyState;
  if (
    topology.kind === "parent-child" &&
    !residentOnDemandModules(extras).includes("parent-child")
  ) {
    activateOnDemand(extras, "parent-child", "topology:parent-child");
  }
}

export function assertStage5ForPhase(
  extras: Record<string, unknown>,
  record: Stage5RecordHint,
  phase: Stage5CommandPhase,
): void {
  if (extras.intake_outcome === "capture-candidate") {
    throw new KernelError(
      "INVALID_REQUEST",
      "Capture Candidate must not create a Task",
    );
  }
  if (isPlainObject(extras.capture_candidate) && extras.capture_candidate.task_created === true) {
    throw new KernelError(
      "INVALID_REQUEST",
      "Capture Candidate must not create a Task",
    );
  }

  assertUnconfirmedChildCreation(extras, existingTopologyChildren(extras), record);
  const topology = normalizeTopology(extras.topology, record);
  extras.topology = topology;
  assertSingleParent(topology, record);

  if (extras.integration_action === "integrate-child") {
    const actor =
      extras.integration_actor === "parent" ? "parent" : "child";
    assertIntegrationAuthority(actor);
  }

  if (phase === "create" || phase === "patch") return;

  assertLifecycleSlots(extras);
  const graph = readDependencyGraph(extras);
  const missing = unmetRequires(
    graph,
    asStringArray(extras.dependency_satisfied),
    typeof record.id === "string" ? record.id : undefined,
  );
  if (missing.length > 0) {
    throw new KernelError(
      "INVALID_TRANSITION",
      `requires unmet: ${missing.join(", ")}`,
    );
  }

  if (phase === "archive") {
    const outcome =
      typeof extras.close_outcome === "string" ? extras.close_outcome : "completed";
    extras.close_outcome = applyRetention(outcome);
  }
}

export function normalizeStage5InExtrasAndAssert(
  extras: Record<string, unknown>,
  record: Stage5RecordHint,
  phase: Stage5CommandPhase,
): void {
  normalizeStage5InExtras(extras, record);
  assertStage5ForPhase(extras, record, phase);
}

function assertSingleParent(topology: TopologyState, record: Stage5RecordHint): void {
  const incoming =
    typeof record.parent === "string" && record.parent.trim() !== ""
      ? record.parent
      : null;
  if (topology.parent_id && incoming && topology.parent_id !== incoming) {
    throw new KernelError(
      "INVALID_REQUEST",
      `single-parent tree: second parent rejected (${topology.parent_id} vs ${incoming})`,
    );
  }
}

function existingTopologyChildren(extras: Record<string, unknown>): string[] {
  if (!isPlainObject(extras.topology)) return [];
  return uniqueStrings(asStringArray(extras.topology.children));
}

function assertUnconfirmedChildCreation(
  extras: Record<string, unknown>,
  existingChildren: readonly string[],
  record?: Stage5RecordHint,
): void {
  const proposal = extras.decompose_proposal;
  if (!isPlainObject(proposal) || proposal.confirmed === true) return;
  const slices = uniqueStrings(asStringArray(proposal.slices ?? proposal.children));
  const incoming = uniqueStrings(record?.children ?? []);
  for (const id of incoming) {
    if (slices.includes(id) && !existingChildren.includes(id)) {
      throw new KernelError(
        "INVALID_REQUEST",
        "Decompose must not create Child before confirmation",
      );
    }
  }
}

function assertLifecycleSlots(extras: Record<string, unknown>): void {
  if (extras.lifecycle_slots === undefined || extras.lifecycle_slots === null) {
    return;
  }
  const present = new Set(asStringArray(extras.lifecycle_slots));
  const missing = LIFECYCLE_SLOTS.filter((slot) => !present.has(slot));
  if (missing.length > 0) {
    throw new KernelError(
      "INVALID_REQUEST",
      `lifecycle required slot missing: ${missing.join(", ")}`,
    );
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function uniqueStrings(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new KernelError("INVALID_REQUEST", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function hasEdge(
  edges: readonly DependencyEdge[],
  from: string,
  to: string,
  type: DependencyEdgeType,
): boolean {
  return edges.some(
    (edge) => edge.from === from && edge.to === to && edge.type === type,
  );
}
