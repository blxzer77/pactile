import fs from "node:fs";
import path from "node:path";
import { readTaskKernel, type KernelPhase } from "../../core/task/index.js";
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

interface PackItem { id: string; kind: "contract" | "artifact"; text: string; estimatedTokens: number; path?: string; role?: string; freshness?: string }
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
    const decisionOutputs = prepared.data.offer.requiredOutputs
      .map((output) => `--output ${output}`)
      .join(" ");
    return {
      status: "offered",
      offer: prepared.data.offer,
      decisionCommand: `pactile tile-selection decide --offer-fingerprint ${prepared.data.offer.fingerprint} --kind <adopt|override|no-match> --intent ${prepared.data.offer.intent} ${decisionOutputs} [--tile <candidate-ref>]`,
      replayCommand: "pactile tile-selection replay --snapshot-fingerprint <snapshot-fingerprint>",
      boundary: "A Tile decision is a receipt only. It does not activate a Tile or authorize a Kernel Run or execution.",
    };
  } catch {
    return { status: "unavailable" };
  }
}

function phaseFromLegacyStatus(status: unknown): KernelPhase {
  if (status === "planning") return "define";
  if (status === "in_progress") return "execute";
  if (status === "review") return "verify";
  if (status === "completed") return "close";
  return "open";
}

/** Five-layer session context; no workflow dump or unactivated contract bodies. */
export function compileSessionPack(root: string, factGap = false): Record<string, unknown> {
  const selection = resolveSelectedTask(root);
  const selected = Boolean(selection.taskPath) && !selection.stale;
  const stale = selection.stale;
  const dir = selection.taskPath && !stale ? resolveTaskDir(root, selection.taskPath) : null;
  const kernelRead = dir && fs.existsSync(path.join(dir, "kernel.json")) ? readTaskKernel({ root, taskDir: dir, cwd: root }) : null;
  const snapshot = kernelRead?.kind === "legacy-task-kernel-v1" ? kernelRead.kernel.kernel : null;
  const v2 = kernelRead?.kind === "task-kernel-v2" ? kernelRead.kernel : null;
  const legacyRecord = dir && !kernelRead ? readJson(path.join(dir, "task.json")) : null;
  const phase: KernelPhase = v2?.phase ?? snapshot?.phase ?? (legacyRecord ? phaseFromLegacyStatus(legacyRecord.status) : "open");
  const condition = v2?.condition ?? snapshot?.condition ?? "ready";
  const outcome = v2?.outcome ?? snapshot?.outcome ?? null;
  const extras = snapshot?.projection?.extras ?? {};
  const baselineActive = activeModules(extras, "baseline_modules", BASELINE).filter((id) => BASELINE.includes(id));
  const ondemandActive = activeModules(extras, "ondemand_modules");
  const rigor = v2 ? "delivery-defined" : ((extras.required_controls as Record<string, unknown> | undefined)?.rigor === "full") ? "full" : "lite";
  const topologyKind = v2 ? "hard-dependencies" : ((extras.topology as Record<string, unknown> | undefined)?.kind === "parent-child") ? "parent-child" : "single";
  const layer2Ids: string[] = [];
  if (!selected) {
    if (baselineActive.includes("intake-basic")) layer2Ids.push("intake-basic");
  } else {
    for (const id of PHASE_BASELINE[phase]) if (baselineActive.includes(id)) layer2Ids.push(id);
    for (const id of ondemandActive) {
      if (NEVER_LAYER2.has(id) || !ONDEMAND_PHASE[id]?.includes(phase)) continue;
      if (!v2 && rigor === "lite" && topologyKind === "single" && LITE_BLOCKED.has(id)) continue;
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
    candidates.push({ id: "kernel-definition", kind: "artifact", path: path.relative(root, path.join(dir, "kernel.json")).replaceAll("\\", "/"), role: "definition", text, estimatedTokens: estimatedTokens(text) });
  }
  if (dir && !v2) for (const [name, role] of PHASE_ARTIFACTS[phase]) {
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
  const taskId = v2?.identity.taskId ?? snapshot?.identity.taskId ?? (typeof legacyRecord?.id === "string" ? legacyRecord.id : null);
  const revision = v2?.revision ?? snapshot?.revision ?? 0;
  const tileSelection = dir && selected && !stale && taskId
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
  const next = stale ? "Clear the stale selection with `pactile task exit`, then ask what to work on next." : !selected ? "Intake: answer directly, clarify whether there is work, or draft an Open Proposal. Do not create a task without Open approval." : stuck ? "Stop. Classify the stall before retrying the same hypothesis." : v2 ? v2Next[phase] : NEXT[phase];
  const constraints = ["Do not treat `.pactile/workflow.md` or AGENTS longform as runtime SSOT.", "Modules absent from this pack are not installed.", v2 ? "Task model=deliverable Task with hard dependencies; no Lite/Full or Parent/Child preset." : `Rigor=${rigor}; topology=${topologyKind}.`, selected ? "Stay inside the selected task contract." : "No selected task: no task-directory dump; no Parent/Worker/VCS teaching."];
  if (condition === "blocked") constraints.push("Condition=blocked: do not silently retry.");
  const layer1 = [`Phase: ${HUMAN[phase]} (${phase})`, `Condition: ${condition}`, `Outcome: ${outcome ?? "(none)"}`, "Constraints:", ...constraints, `Next: ${next}`].join("\n");
  const layer4 = factGap ? "Fact gap: route with intents exact / semantic / structural / external. Do not bind Agent tool names. Ranking and retrieval-pack stay with `retrieval-extended`." : "";
  const layer5 = stuck ? "Deep diagnosis pointer only (not a layer-2 contract): `debug-recovery`. Stop homogeneous retries. Classify implementation / contract / environment / platform / process-loop. First failure is not break-loop." : "";
  return {
    version: 1, source: "context-progressive",
    activationSource: { kind: "profile-runtime", filter: "phase-intersect-active", baselineActive, ondemandActive, note: "Layer 2 is phase-needed intersect still-active. Unactivated modules are not installed." },
    kernel: { taskId: v2?.identity.taskId ?? snapshot?.identity.taskId ?? legacyRecord?.id ?? null, schemaVersion: v2?.schemaVersion ?? (snapshot ? 1 : 0), revision: v2?.revision ?? snapshot?.revision ?? 0,
      deliveryLevel: v2?.definition.deliveryLevel ?? null, phase, condition, outcome, humanPhase: HUMAN[phase], selected }, rigor, topologyKind,
    ...(tileSelection ? { tileSelection } : {}),
    layers: [
      { n: 1, name: "resident-min", text: layer1 },
      { n: 2, name: "activated-contracts", moduleIds: contracts.map((item) => item.id), text: contracts.map((item) => `### \`${item.id}\`\n${item.text}`).join("\n\n") },
      { n: 3, name: "artifact-snippets", items: artifacts.map((item) => ({ path: item.path, role: item.role, freshness: item.freshness, excerpt: item.text })), text: artifacts.map((item) => `${item.path}\n${item.text}`).join("\n\n") },
      { n: 4, name: "retrieval-pointer", present: factGap, intents: factGap ? ["exact", "semantic", "structural", "external"] : [], text: layer4 },
      { n: 5, name: "deep-diagnosis", present: stuck, moduleIds: stuck ? ["debug-recovery"] : [], text: layer5 },
    ],
    budget: { maxItems: 8, maxEstimatedTokens: 4000, estimatedTokens: tokens, itemsUsed: kept.length },
    omitted, illegalInputsRejected: ["workflow.md", "AGENTS.md", "[workflow-state:*]", "unactivated-module-bodies"],
    catalogSize: modules.length, retrievalIntents: ["exact", "semantic", "structural", "external"],
  };
}
