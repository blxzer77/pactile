import fs from "node:fs";
import path from "node:path";
import { KernelError, readTaskKernel, type KernelPhase } from "../../core/task/index.js";
import { readLegacyTaskImportRecord } from "../../core/task/legacy-task-migration-reader.js";
import { projectTaskKernelArtifactsV1 } from "../artifacts/index.js";
import { prepareSelectedTaskAgentTileSelection } from "../registry.js";
import { resolveSelectedTask, resolveTaskDir } from "./session.js";

const BASELINE = ["intake-basic", "define-basic", "approval-personal", "execute-agent", "verify-basic", "close-basic", "context-progressive", "observability-local"];
const NEVER_LAYER2 = new Set(["context-progressive", "observability-local", "debug-recovery", "retention-storage", "retrieval-extended", "personal-memory"]);
const LITE_BLOCKED = new Set(["parent-child", "vcs-integration", "personal-memory", "retention-storage", "retrieval-extended", "worker-orchestration"]);
const PHASE_BASELINE: Record<KernelPhase, string[]> = { open: [], define: ["define-basic"], approve: ["approval-personal"], execute: ["execute-agent"], verify: ["verify-basic"], integrate: [], close: ["close-basic"] };
const ONDEMAND_PHASE: Record<string, KernelPhase[]> = {
  "define-extended": ["define"], "independent-check": ["verify"], "worker-orchestration": ["execute"],
  "parent-child": ["define", "execute", "integrate", "verify"], "spec-learning": ["close"], "vcs-integration": ["close"],
};
const PHASE_ARTIFACTS: Record<KernelPhase, [string, string][]> = {
  open: [], define: [["prd.md", "definition"]], approve: [["prd.md", "definition"]], execute: [["prd.md", "definition"]],
  verify: [["prd.md", "definition"], ["verify.md", "evidence"]],
  integrate: [["prd.md", "definition"], ["handoff.md", "integration-handoff"]], close: [["verify.md", "evidence"]],
};
const HUMAN: Record<KernelPhase, string> = { open: "Open", define: "Define", approve: "Approve", execute: "Execute", verify: "Verify", integrate: "Integrate", close: "Close" };
const NEXT: Record<KernelPhase, string> = {
  open: "Task exists. Move into Define: measurable Acceptance Criteria before Execute.",
  define: "Finish Definition + measurable AC. Do not implement; do not `--approved`.",
  approve: "Request the Execute gate. `--check` PASS is a preflight, not human approval.",
  execute: "Implement inside the approved contract. Contract change → Return-to-Define.",
  verify: "Map every AC to locatable evidence. Placeholder or fake-green cannot Close.",
  integrate: "Parent integrates children. Child must not `integrate-child`.",
  close: "Write Outcome + learning disposition. Git commit is not Close.",
};

interface PackItem { id: string; kind: "contract" | "artifact"; text: string; estimatedTokens: number; path?: string; reference?: string; role?: string; freshness?: string }
const estimatedTokens = (text: string): number => Math.max(40, Math.floor(text.length / 4) + 20);
function readJson(file: string): Record<string, unknown> {
  try { const data: unknown = JSON.parse(fs.readFileSync(file, "utf8")); return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {}; }
  catch { return {}; }
}
function activeModules(extras: Record<string, unknown>, key: string, fallback: string[] = []): string[] {
  const block = extras[key];
  if (!block || typeof block !== "object") return fallback;
  const active = (block as Record<string, unknown>).active;
  return Array.isArray(active) ? active.filter((item): item is string => typeof item === "string") : fallback;
}

function taskTileOffer(
  root: string,
  taskId: string,
  phase: KernelPhase,
  revision: number,
): Record<string, unknown> {
  try {
    const prepared = prepareSelectedTaskAgentTileSelection(root, { taskId, phase, revision });
    if (!prepared.success) {
      const receipt = "receipt" in prepared ? prepared.receipt : undefined;
      return {
        status: "unavailable",
        ...(receipt ? { receipt } : {}),
      };
    }
    return {
      status: "offered",
      offer: prepared.data.offer,
      decisionCommand: `pactile tile-selection decide --session --offer-fingerprint ${prepared.data.offer.fingerprint} --kind adopt`,
      replayCommand: "pactile tile-selection replay --snapshot-fingerprint <snapshot-fingerprint>",
      boundary: "A Tile decision is a receipt only. It does not activate a Tile or authorize a Kernel Run or execution.",
    };
  } catch {
    return { status: "unavailable" };
  }
}

/** Five-layer session context; no workflow dump or unactivated contract bodies. */
export function compileSessionPack(root: string, factGap = false): Record<string, unknown> {
  const selection = resolveSelectedTask(root);
  const selected = Boolean(selection.taskPath) && !selection.stale;
  const stale = selection.stale;
  const dir = selection.taskPath && !stale ? resolveTaskDir(root, selection.taskPath) : null;
  const migrationRecord = selected && dir
    ? readLegacyTaskImportRecord(root, dir)
    : null;
  const migrationNeedsReconciliation =
    migrationRecord !== null && migrationRecord.status !== "imported";
  let kernelRead: ReturnType<typeof readTaskKernel> | null = null;
  let kernelReadFailed = false;
  if (selected && dir && !migrationNeedsReconciliation) {
    try {
      kernelRead = readTaskKernel({ root, taskDir: dir, cwd: root });
    } catch (error) {
      if (
        migrationRecord?.status === "imported" &&
        error instanceof KernelError &&
        error.code === "CORRUPT_STATE"
      ) {
        throw error;
      }
      // An unreadable or unknown selected Task must not fall through to V1 guidance.
      kernelReadFailed = true;
    }
  }
  const snapshot = kernelRead?.kind === "legacy-task-kernel-v1" ? kernelRead.kernel.kernel : null;
  const v2 = kernelRead?.kind === "task-kernel-v2" ? kernelRead.kernel : null;
  const selectedLegacy = selected && kernelRead?.kind === "legacy-task-kernel-v1" && kernelRead.kernel.persisted === true;
  const unresolvedSelection = selected && !v2 && !selectedLegacy && !migrationNeedsReconciliation;
  const resolvedSelection = selected && !unresolvedSelection;
  const phase: KernelPhase = migrationNeedsReconciliation
    ? "define"
    : v2?.phase ?? snapshot?.phase ?? "open";
  const condition = migrationNeedsReconciliation
    ? "blocked"
    : v2?.condition ?? snapshot?.condition ?? "ready";
  const outcome = migrationNeedsReconciliation
    ? null
    : v2?.outcome ?? snapshot?.outcome ?? null;
  const extras = snapshot?.projection?.extras ?? {};
  const baselineActive = activeModules(extras, "baseline_modules", BASELINE).filter((id) => BASELINE.includes(id));
  const ondemandActive = activeModules(extras, "ondemand_modules");
  const rigor = v2 ? "delivery-defined" : selectedLegacy ? ((extras.required_controls as Record<string, unknown> | undefined)?.rigor === "full") ? "full" : "lite" : null;
  const topologyKind = v2 ? "hard-dependencies" : selectedLegacy ? ((extras.topology as Record<string, unknown> | undefined)?.kind === "parent-child") ? "parent-child" : "single" : null;
  const layer2Ids: string[] = [];
  if (!selected) {
    if (baselineActive.includes("intake-basic")) layer2Ids.push("intake-basic");
  } else if (resolvedSelection && !migrationNeedsReconciliation) {
    for (const id of PHASE_BASELINE[phase]) if (baselineActive.includes(id)) layer2Ids.push(id);
    for (const id of ondemandActive) {
      if (NEVER_LAYER2.has(id) || !ONDEMAND_PHASE[id]?.includes(phase)) continue;
      if (selectedLegacy && rigor === "lite" && topologyKind === "single" && LITE_BLOCKED.has(id)) continue;
      if (!layer2Ids.includes(id)) layer2Ids.push(id);
    }
  }
  const catalog = readJson(path.join(root, ".pactile", "modules", "index.json"));
  const modules = Array.isArray(catalog.modules) ? catalog.modules as Record<string, unknown>[] : [];
  const candidates: PackItem[] = [];
  for (const id of layer2Ids) {
    const entry = modules.find((item) => item.id === id);
    const relative = typeof entry?.contract === "string" ? entry.contract : `${id}/contract.md`;
    const file = path.resolve(root, ".pactile", "modules", relative);
    const modulesRoot = path.resolve(root, ".pactile", "modules");
    if (!file.startsWith(`${modulesRoot}${path.sep}`) || !fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8").slice(0, 2200).trim();
    if (text) candidates.push({ id, kind: "contract", text, estimatedTokens: estimatedTokens(text) });
  }
  if (v2 && dir) {
    const definition = v2.definition;
    const text = [`Task: ${definition.title} (${definition.taskId})`, `Deliverable: ${definition.deliverable}`, `Delivery level: ${definition.deliveryLevel}`,
      `Dependencies: ${definition.dependencies.join(", ") || "none"}`, "Acceptance criteria:", ...definition.acceptanceCriteria.map((criterion) => `- ${criterion.id}: ${criterion.description}`)].join("\n");
    const definitionFact = projectTaskKernelArtifactsV1(v2).facts.find((fact) => fact.id === "context:task");
    if (definitionFact) candidates.push({ id: "kernel-definition", kind: "artifact", reference: `${definitionFact.ref.uri}#${definitionFact.ref.selector}`, role: "definition", text, estimatedTokens: estimatedTokens(text) });
  }
  if (dir && selectedLegacy) for (const [name, role] of PHASE_ARTIFACTS[phase]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8").slice(0, 1200).trim();
    if (!text) continue;
    candidates.push({ id: name, kind: "artifact", path: path.relative(root, file).replaceAll("\\", "/"), role, text, freshness: fs.statSync(file).mtime.toISOString().replace(/\.\d{3}Z$/, "Z"), estimatedTokens: estimatedTokens(text) });
  }
  const kept: PackItem[] = [];
  const omitted: { id: string; reason: string }[] = [];
  let tokens = 0;
  for (const item of candidates) {
    if (kept.length >= 8 || tokens + item.estimatedTokens > 4000) omitted.push({ id: item.id, reason: "outside session pack budget" });
    else { kept.push(item); tokens += item.estimatedTokens; }
  }
  const contracts = kept.filter((item) => item.kind === "contract");
  const artifacts = kept.filter((item) => item.kind === "artifact");
  const taskId = resolvedSelection
    ? v2?.identity.taskId ?? snapshot?.identity.taskId ??
      (migrationNeedsReconciliation ? migrationRecord?.legacyTaskId ?? null : null)
    : null;
  const revision = v2?.revision ?? snapshot?.revision ?? 0;
  const tileSelection = dir && selected && !stale && taskId &&
    !migrationNeedsReconciliation && !unresolvedSelection
    ? taskTileOffer(root, taskId, phase, revision)
    : null;
  const stuck = stale || condition === "blocked";
  const v2Next: Record<KernelPhase, string> = {
    open: "Create a deliverable Task with acceptance criteria and a delivery level.",
    define: "Complete the contract and hard dependencies, then start an authorized Run.",
    approve: "Record Run authorization and start the Run with `pactile task run-start`.",
    execute: "Record Run outcome and candidate entries with `pactile task run-result`; preserve failed attempts.",
    verify: "Record an independent candidate-bound Review, then Close with matching candidate observation and delivery evidence.",
    integrate: "Use the delivery-level evidence required by the Task contract.",
    close: "Task is closed in the Kernel; keep its Run and Review history readable.",
  };
  const migrationNext = migrationRecord?.status === "needs-definition"
    ? "Migration needs-definition: complete the missing Task contract fields before any V2 Run."
    : migrationRecord?.status === "needs-coordination"
      ? "Migration needs-coordination: resolve the blocking legacy dependency references before any V2 Run."
      : null;
  const next = stale
    ? "Clear the stale selection with `pactile task exit`, then ask what to work on next."
    : !selected
      ? "Intake: answer directly, clarify whether there is work, or draft a V2 Task Proposal with a deliverable, measurable ACs, a delivery level, and known hard dependency Task IDs. Create the Task only after the user agrees; its lifecycle starts at Define."
      : unresolvedSelection
        ? kernelReadFailed
          ? "Stop. The selected Task format is not identified because its canonical Task Kernel could not be read; inspect it before continuing."
          : "Stop. The selected Task format is not identified as a valid persisted V1 or V2 Kernel; inspect it before continuing."
        : migrationNeedsReconciliation
          ? migrationNext ?? "Stop. Reconcile the legacy migration before any V2 Run."
          : stuck
            ? "Stop. Classify the stall before retrying the same hypothesis."
            : v2 ? v2Next[phase] : NEXT[phase];
  const constraints = ["Do not treat `.pactile/workflow.md` or AGENTS longform as runtime SSOT.", "Modules absent from this pack are not installed."];
  if (v2) constraints.push("Task model=V2 deliverable with hard dependencies.");
  else if (selectedLegacy) constraints.push(`V1 legacy Task: Rigor=${rigor}; topology=${topologyKind}.`);
  else if (migrationNeedsReconciliation && migrationRecord) {
    constraints.push(`Legacy migration status=${migrationRecord.status}; this is not a runnable V2 Task.`);
    if (migrationRecord.missingDefinitionFields.length > 0)
      constraints.push(`Missing definition fields: ${migrationRecord.missingDefinitionFields.join(", ")}.`);
    if (migrationRecord.coordinationReasons.length > 0)
      constraints.push(`Coordination reasons: ${migrationRecord.coordinationReasons.join(", ")}.`);
  } else if (unresolvedSelection) {
    constraints.push("The selected Task schema is unresolved; do not infer lifecycle gates.");
    if (kernelReadFailed)
      constraints.push("The canonical Task Kernel could not be read; do not fall back to legacy files.");
  }
  else constraints.push("No Task selected: prepare a V2 Task Proposal only; no Task is created or execution authorized.");
  if (resolvedSelection && !migrationNeedsReconciliation) constraints.push("Stay inside the selected task contract.");
  else if (unresolvedSelection) constraints.push("Do not read artifacts or proceed until the selected Task format is identified.");
  else if (!selected) constraints.push("No selected task: do not dump task-specific artifacts or add execution instructions.");
  if (condition === "blocked") constraints.push("Condition=blocked: do not silently retry.");
  const layer1 = [
    unresolvedSelection ? "Phase: Unknown (selected Task format needs inspection)"
      : selected ? `Phase: ${HUMAN[phase]} (${phase})`
        : stale ? "Phase: Intake (clear stale selection first)" : "Phase: Intake (no Task selected)",
    ...(resolvedSelection ? [`Condition: ${condition}`, `Outcome: ${outcome ?? "(none)"}`] : []),
    "Constraints:", ...constraints, `Next: ${next}`,
  ].join("\n");
  const layer4 = factGap ? "Fact gap: route with intents exact / semantic / structural / external. Do not bind Agent tool names. Ranking and retrieval-pack stay with `retrieval-extended`." : "";
  const layer5 = stuck ? "Deep diagnosis pointer only (not a layer-2 contract): `debug-recovery`. Stop homogeneous retries. Classify implementation / contract / environment / platform / process-loop. First failure is not break-loop." : "";
  return {
    version: 1, source: "context-progressive",
    activationSource: { kind: "profile-runtime", filter: "phase-intersect-active", baselineActive, ondemandActive, note: "Layer 2 is phase-needed intersect still-active. Unactivated modules are not installed." },
    kernel: { taskId: resolvedSelection ? taskId : null,
      schemaVersion: resolvedSelection ? v2?.schemaVersion ?? (snapshot ? 1 : migrationNeedsReconciliation ? 0 : null) : null,
      revision: resolvedSelection ? v2?.revision ?? snapshot?.revision ?? 0 : null,
      deliveryLevel: v2?.definition.deliveryLevel ?? null, phase: resolvedSelection ? phase : null,
      condition: resolvedSelection ? condition : null, outcome: resolvedSelection ? outcome : null,
      humanPhase: resolvedSelection ? HUMAN[phase] : null, selected,
      ...(migrationNeedsReconciliation && migrationRecord ? { migrationStatus: migrationRecord.status, runnable: false,
        missingDefinitionFields: migrationRecord.missingDefinitionFields,
        coordinationReasons: migrationRecord.coordinationReasons } : {}) },
    ...(v2 || selectedLegacy ? { rigor, topologyKind } : {}),
    ...(!selected && !stale ? { proposalModel: "task-kernel-v2" } : {}),
    ...(tileSelection ? { tileSelection } : {}),
    layers: [
      { n: 1, name: "resident-min", text: layer1 },
      { n: 2, name: "activated-contracts", moduleIds: contracts.map((item) => item.id), text: contracts.map((item) => `### \`${item.id}\`\n${item.text}`).join("\n\n") },
      { n: 3, name: "artifact-snippets", items: artifacts.map((item) => ({ ...(item.path ? { path: item.path } : {}), ...(item.reference ? { reference: item.reference } : {}), role: item.role, freshness: item.freshness, excerpt: item.text })), text: artifacts.map((item) => `${item.reference ?? item.path ?? item.id}\n${item.text}`).join("\n\n") },
      { n: 4, name: "retrieval-pointer", present: factGap, intents: factGap ? ["exact", "semantic", "structural", "external"] : [], text: layer4 },
      { n: 5, name: "deep-diagnosis", present: stuck, moduleIds: stuck ? ["debug-recovery"] : [], text: layer5 },
    ],
    budget: { maxItems: 8, maxEstimatedTokens: 4000, estimatedTokens: tokens, itemsUsed: kept.length },
    omitted, illegalInputsRejected: ["workflow.md", "AGENTS.md", "[workflow-state:*]", "unactivated-module-bodies"],
    catalogSize: modules.length, retrievalIntents: ["exact", "semantic", "structural", "external"],
  };
}
