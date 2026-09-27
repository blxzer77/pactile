import fs from "node:fs";
import path from "node:path";
import { fingerprintPactileContractV1 } from "../../core/index.js";
import { buildEvidenceEnvelope } from "./envelope.js";
import { buildRetrievalRequestV3, createRetrievalPlanV3, planRetrievalV3 } from "./planner.js";

type Row = Record<string, unknown>;
type Source = "task-artifacts" | "artifact-search" | "session-memory" | "smart-search" | "codebase-evidence";
interface Scored {
  version: number; source: Source; kind: string; reference: string; title: string;
  status: string; trust: string; confidence: string; relevance: number; freshness: number;
  sourceAuthority: number; validationState: string; score: number; reasons: string[]; warnings: string[];
  effectiveAuthority?: number; conflictFlags?: string[]; arbitrationReasons?: string[];
}

const sources: Source[] = ["task-artifacts", "artifact-search", "session-memory", "smart-search", "codebase-evidence"];
const authority: Record<Source, number> = { "task-artifacts": 95, "artifact-search": 90, "session-memory": 55, "smart-search": 85, "codebase-evidence": 60 };
const kind: Record<Source, string> = { "task-artifacts": "local-artifact", "artifact-search": "local-artifact", "session-memory": "historical-context", "smart-search": "external-evidence", "codebase-evidence": "candidate-evidence" };
const trustBySource: Record<Source, string> = { "task-artifacts": "high", "artifact-search": "high", "session-memory": "medium", "smart-search": "high", "codebase-evidence": "medium" };
const trustScore: Record<string, number> = { high: 100, medium: 70, low: 40 };
const smartProviders = new Set(["smart-search", "smart_search", "external-knowledge"]);
const memoryProviders = new Set(["session-memory", "personal-memory", "journal"]);
const codeProviders = new Set(["codebase", "codegraph", "rg", "grep", "exact", "semantic", "structural"]);

const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const array = (value: unknown): Row[] => Array.isArray(value) ? value.filter((item): item is Row => !!item && typeof item === "object" && !Array.isArray(item)) : [];
const string = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const number = (value: unknown, fallback = 0): number => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const clamp = (value: number): number => Math.max(0, Math.min(100, value));

function dateFreshness(value: unknown, iso = false): number {
  const parsed = Date.parse(string(value));
  if (!Number.isFinite(parsed)) return iso ? 60 : 50;
  const days = Math.floor((Date.now() - parsed) / 86_400_000);
  if (iso) return days <= 0 ? 90 : days <= 3 ? 85 : days <= 14 ? 75 : days <= 60 ? 60 : 40;
  return days <= 0 ? 95 : days <= 7 ? 85 : days <= 30 ? 70 : days <= 90 ? 55 : 35;
}

function evidence(source: Source, input: Row, recommendation: Row = {}): Scored {
  const reference = string(input.reference) || string(input.path) || string(input.manifestPath) || string(input.evidenceDir) || string(recommendation.reference) || source;
  const taskArtifactsPresent = ["prd", "design", "implement", "verify", "research"].some((key) => input[key] === true);
  const status = source === "task-artifacts" && !taskArtifactsPresent ? "missing" : source === "smart-search" ? string(input.status) || "failed" : string(input.status) || "ok";
  const unavailable = ["failed", "not_configured", "missing"].includes(status);
  const degraded = status === "degraded";
  const trust = unavailable ? "low" : degraded && source === "smart-search" ? "medium" : trustBySource[source];
  const confidence = unavailable ? "low" : string(input.confidence) || string(recommendation.confidence) || (source === "task-artifacts" || source === "artifact-search" ? "high" : "medium");
  const upstream = number(input.score);
  let relevance = upstream > 0 ? clamp(upstream) : source === "task-artifacts" ? 100 : source === "smart-search" ? 70 : source === "codebase-evidence" ? 50 : 40;
  const priority = number(recommendation.priority);
  if (priority > 0) relevance = Math.max(relevance, clamp(priority));
  if (source === "smart-search") relevance = unavailable ? Math.min(relevance, status === "not_configured" ? 20 : 15) : Math.max(relevance, degraded ? 55 : 75);
  const freshness = source === "task-artifacts" ? 95 : source === "artifact-search" ? 80 : source === "session-memory" ? dateFreshness(input.date ?? input.freshness) : source === "smart-search" ? dateFreshness(input.createdAt ?? input.freshness, true) : clamp(number(input.freshness, 50));
  const sourceAuthority = source === "smart-search" ? unavailable ? status === "not_configured" ? 20 : 15 : degraded ? 70 : 85 : authority[source];
  const validationState = unavailable ? status === "failed" ? "failed" : "unavailable" : source === "codebase-evidence" ? "candidate" : source === "smart-search" || source === "session-memory" ? "unverified" : "verified";
  const penalty = degraded && source === "smart-search" ? 15 : status !== "ok" && source === "codebase-evidence" ? 10 : 0;
  let score = clamp(Math.round(relevance * .45 + sourceAuthority * .25 + freshness * .15 + (trustScore[trust] ?? 70) * .15 - penalty));
  if (unavailable) score = Math.min(score, status === "failed" ? 8 : status === "not_configured" ? 12 : 18);
  const reasons = source === "task-artifacts" ? ["durable selected-task artifacts are present"]
    : source === "artifact-search" ? ["durable Pactile markdown artifact match"]
    : source === "session-memory" ? ["local session memory is historical context, not authoritative proof"]
    : source === "smart-search" ? unavailable ? [`Smart Search ${status} is an availability signal only`] : degraded ? ["source-backed external evidence with gaps"] : ["source-backed external evidence; current validation still required"]
    : [string(input.reason) || "codebase retrieval is candidate evidence until validated"];
  const warnings = source === "session-memory" ? ["confirm against durable task artifacts and current source"]
    : source === "codebase-evidence" ? ["candidate evidence requires current source, Git, or validation confirmation"]
    : unavailable ? [`${status} evidence must not be treated as positive evidence`] : degraded ? ["degraded evidence; review gap explanation"] : [];
  const title = string(input.title) || string(input.query) || (source === "task-artifacts" ? "Selected task artifacts" : source === "session-memory" ? "Session memory" : source === "smart-search" ? "Smart Search evidence" : source === "codebase-evidence" ? "Codebase candidate evidence" : reference);
  return { version: 1, source, kind: kind[source], reference, title, status, trust, confidence, relevance, freshness, sourceAuthority, validationState, score, reasons, warnings };
}

function legacyItems(payload: Row): Row[] {
  return [
    ...array(payload.artifactSearchResults).map((item) => ({ ...item, provider: item.provider ?? "artifact-search" })),
    ...array(payload.sessionMemoryResults).map((item) => ({ ...item, provider: item.provider ?? "session-memory" })),
    ...array(payload.smartSearchManifests).map((item) => ({ ...item, path: item.manifestPath ?? item.evidenceDir ?? item.path, provider: item.provider ?? "smart-search" })),
    ...(Array.isArray(payload.smartSearchManifestPaths) ? payload.smartSearchManifestPaths.map((item) => ({ path: item, provider: "smart-search" })) : []),
    ...array(payload.codebaseCandidates).map((item) => ({ ...item, provider: item.provider ?? "codebase" })),
  ];
}

function collectedItems(payload: Row): Row[] {
  const raw = Array.isArray(payload.items) ? payload.items : Array.isArray(payload.collectedEvidence) ? payload.collectedEvidence : legacyItems(payload);
  const seen = new Set<string>();
  return array(raw).flatMap((item) => {
    const reference = string(item.path) || string(item.reference) || string(item.manifestPath) || string(item.evidenceDir);
    const provider = string(item.provider) || string(item.source);
    if (!reference || !provider) return [];
    const key = `${provider}\0${reference}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...item, path: reference, provider }];
  });
}

function safeManifest(root: string, reference: string, warnings: string[]): Row | null {
  const file = path.resolve(root, reference);
  const resolvedRoot = fs.realpathSync(root);
  let real: string;
  try { real = fs.realpathSync(file); }
  catch { warnings.push(`could not read Smart Search manifest: ${reference}`); return null; }
  if (real !== resolvedRoot && !real.startsWith(`${resolvedRoot}${path.sep}`)) { warnings.push(`Smart Search manifest outside repo_root ignored: ${reference}`); return null; }
  try {
    const value: unknown = JSON.parse(fs.readFileSync(real, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("manifest must be an object");
    return { ...object(value), manifestPath: reference };
  } catch { warnings.push(`invalid Smart Search manifest: ${reference}`); return null; }
}

function discoverTaskManifests(root: string, taskPath: string, warnings: string[]): Row[] {
  if (!taskPath) return [];
  const candidate = path.resolve(root, taskPath);
  const resolvedRoot = fs.realpathSync(root);
  let taskRoot: string;
  try { taskRoot = fs.realpathSync(candidate); }
  catch { return []; }
  if (taskRoot !== resolvedRoot && !taskRoot.startsWith(`${resolvedRoot}${path.sep}`)) { warnings.push(`selected task path outside repo_root ignored: ${taskPath}`); return []; }
  const evidenceRoot = path.join(taskRoot, "research", "smart-search");
  if (!fs.existsSync(evidenceRoot)) return [];
  return fs.readdirSync(evidenceRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const file = path.join(evidenceRoot, entry.name, "manifest.json");
      if (!fs.existsSync(file)) return [];
      const loaded = safeManifest(root, path.relative(root, file).replaceAll("\\", "/"), warnings);
      return loaded ? [loaded] : [];
    });
}

function arbitrate(items: Scored[], intent: string): { version: number; total: number; items: Scored[]; conflicts: Row[]; metrics: Row } {
  const adjustments: Record<string, Partial<Record<Source, number>>> = { exact: { "artifact-search": 10, "codebase-evidence": -5 }, semantic: { "smart-search": 10, "codebase-evidence": -5 }, structural: { "codebase-evidence": 20 }, external: { "smart-search": 10 } };
  const ranked = items.map((item) => ({ ...item, effectiveAuthority: clamp(item.sourceAuthority + (adjustments[intent]?.[item.source] ?? 0) - (item.source === "session-memory" && item.freshness < 50 ? 10 : 0)), conflictFlags: item.source === "session-memory" && item.freshness < 50 ? ["stale_warning"] : [], arbitrationReasons: [] as string[] }));
  const conflicts: Row[] = [];
  for (let i = 0; i < ranked.length; i++) for (let j = i + 1; j < ranked.length; j++) {
    const a = ranked[i], b = ranked[j];
    if (a.source === b.source) continue;
    const wordsA = new Set(a.title.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.title.toLowerCase().split(/\s+/));
    const overlap = [...wordsA].filter((word) => wordsB.has(word)).length / new Set([...wordsA, ...wordsB]).size;
    if (overlap < .5) continue;
    const aVerified = a.validationState === "verified", bVerified = b.validationState === "verified";
    if (!aVerified && !bVerified) continue;
    const type = aVerified && bVerified ? "blocking" : "downgrade";
    conflicts.push({ sourceA: a.source, referenceA: a.reference, sourceB: b.source, referenceB: b.reference, type, resolution: type === "blocking" ? "both sources verified; requires human resolution" : "verified source outranks unverified or candidate source" });
    if (type === "blocking") { a.conflictFlags.push("blocking_conflict"); b.conflictFlags.push("blocking_conflict"); }
    else { const weaker = aVerified ? b : a; weaker.effectiveAuthority = clamp(weaker.effectiveAuthority - 5); weaker.conflictFlags.push("conflict_flagged"); }
    a.arbitrationReasons.push(`${type} with ${b.source}: ${b.reference}`);
    b.arbitrationReasons.push(`${type} with ${a.source}: ${a.reference}`);
  }
  ranked.sort((a, b) => b.effectiveAuthority - a.effectiveAuthority || b.score - a.score || sources.indexOf(a.source) - sources.indexOf(b.source));
  return { version: 1, total: ranked.length, items: ranked, conflicts, metrics: { totalItems: ranked.length, conflictCount: conflicts.length, blockingConflictCount: conflicts.filter((item) => item.type === "blocking").length, downgradeCount: ranked.filter((item) => item.conflictFlags.includes("conflict_flagged")).length } };
}

function contextPack(items: Scored[], maxItems: number | null, maxEstimatedTokens: number | null, includeDiagnostics: boolean): Row {
  const selected: Row[] = [], omitted: Row[] = [], warnings: string[] = [];
  let estimatedTokens = 0, budgetExceeded = false;
  for (const item of items) {
    const diagnostic = ["failed", "not_configured", "missing"].includes(item.status) || ["failed", "unavailable"].includes(item.validationState);
    const base = { source: item.source, reference: item.reference, title: item.title, score: item.score, status: item.status, validationState: item.validationState };
    if (diagnostic && !includeDiagnostics) { omitted.push({ ...base, reason: `unavailable evidence excluded from pack body: status ${item.status}`, warnings: item.warnings }); warnings.push(...item.warnings); continue; }
    const estimate = 80; // Scored evidence contains metadata only; source content is never silently imported.
    if ((maxItems !== null && selected.length >= maxItems) || (maxEstimatedTokens !== null && estimatedTokens + estimate > maxEstimatedTokens)) {
      omitted.push({ ...base, reason: item.validationState === "candidate" ? "candidate evidence skipped due to budget" : "outside budget after higher-ranked evidence" }); budgetExceeded = true; continue;
    }
    selected.push({ ...base, estimatedTokens: estimate, metadataOnly: true, reason: item.reasons[0] || "selected as highest-ranked usable evidence" });
    estimatedTokens += estimate;
  }
  if (budgetExceeded) warnings.push("budget limits caused evidence omission");
  return { version: 1, source: "retrieval-context-pack", budget: { maxItems, maxEstimatedTokens, estimatedTokens, itemsUsed: selected.length }, selected, omitted, warnings: [...new Set(warnings)], summary: { totalInput: items.length, selectedCount: selected.length, omittedCount: omitted.length, budgetExceeded } };
}

function routerEnvelope(payload: Row): Row {
  const explicit = object(payload.routerEnvelope);
  if (Object.keys(explicit).length) {
    if (Array.isArray(explicit.steps) && Array.isArray(explicit.intents) && typeof explicit.fingerprint === "string") {
      const { fingerprint, ...unsigned } = explicit;
      if (fingerprintPactileContractV1(unsigned) === fingerprint) return explicit;
    }
    const planned = planRetrievalV3(explicit);
    if (planned.success) return planned.data as unknown as Row;
    if (string(explicit.query)) return createRetrievalPlanV3(buildRetrievalRequestV3({ query: string(explicit.query) })) as unknown as Row;
  }
  const query = string(payload.query);
  return query ? createRetrievalPlanV3(buildRetrievalRequestV3({ query })) as unknown as Row : {};
}

/** Quality-layer pack of already collected evidence. It never performs retrieval or supplies AC/Close evidence. */
export function buildRetrievalPack(payload: Row, root: string, options: { maxItems?: number; maxEstimatedTokens?: number; includeDiagnostics?: boolean } = {}): Row {
  const warnings: string[] = [];
  const collected = collectedItems(payload);
  const guide = object(payload.retrievalGuide);
  const recommendations = array(guide.recommendations);
  const recommendation = new Map(recommendations.map((item) => [string(item.source), item]));
  const selectedTaskArtifacts = object(guide.selectedTaskArtifacts);
  const bundle: Row = {};
  if (recommendations.length) bundle.recommendations = recommendations;
  if (Object.keys(selectedTaskArtifacts).length) bundle.selectedTaskArtifacts = selectedTaskArtifacts;
  const artifacts: Row[] = [], memory: Row[] = [], codebase: Row[] = [], manifests: Row[] = [];
  for (const item of collected) {
    const provider = string(item.provider);
    if (smartProviders.has(provider)) {
      if (item.status || item.query || item.citations) manifests.push(item);
      else { const loaded = safeManifest(root, string(item.path), warnings); if (loaded) manifests.push(loaded); }
    } else if (memoryProviders.has(provider)) memory.push(item);
    else if (codeProviders.has(provider)) codebase.push(item);
    else artifacts.push(item);
  }
  manifests.push(...discoverTaskManifests(root, string(selectedTaskArtifacts.taskPath), warnings));
  const uniqueManifests = [...new Map(manifests.map((item) => [string(item.manifestPath) || string(item.evidenceDir) || JSON.stringify(item), item])).values()];
  if (artifacts.length) bundle.artifactSearchResults = artifacts;
  if (memory.length) bundle.sessionMemoryResults = memory;
  if (uniqueManifests.length) bundle.smartSearchManifests = uniqueManifests;
  if (codebase.length) bundle.codebaseCandidates = codebase;
  const collection = { recommendations: recommendations.length, artifactSearchResults: artifacts.length, sessionMemoryResults: memory.length, smartSearchManifests: uniqueManifests.length, codebaseCandidates: codebase.length };
  const scored: Scored[] = [];
  if (string(selectedTaskArtifacts.taskPath)) scored.push(evidence("task-artifacts", { ...selectedTaskArtifacts, path: selectedTaskArtifacts.taskPath }, recommendation.get("task-artifacts")));
  for (const item of artifacts) scored.push(evidence("artifact-search", item, recommendation.get("artifact-search")));
  for (const item of memory) scored.push(evidence("session-memory", item, recommendation.get("session-memory")));
  for (const item of uniqueManifests) scored.push(evidence("smart-search", item, recommendation.get("smart-search")));
  for (const item of codebase) scored.push(evidence("codebase-evidence", item, recommendation.get("codebase-evidence")));
  for (const source of sources) {
    const rec = recommendation.get(source);
    if (!rec || scored.some((item) => item.source === source) || source === "task-artifacts") continue;
    const missing = evidence(source, { reference: string(rec.reference) || source, status: "missing", title: `Missing ${source} evidence` }, rec);
    missing.validationState = "unavailable";
    scored.push(missing);
  }
  scored.sort((a, b) => b.score - a.score || sources.indexOf(a.source) - sources.indexOf(b.source) || a.reference.localeCompare(b.reference));
  const router = routerEnvelope(payload);
  const intent = string(router.intent) || string((Array.isArray(router.intents) ? router.intents as unknown[] : [])[0]);
  const arbitrated = arbitrate(scored, intent);
  const pack = contextPack(arbitrated.items, options.maxItems ?? null, options.maxEstimatedTokens ?? null, options.includeDiagnostics ?? false);
  const taskArtifactsCollected = string(selectedTaskArtifacts.taskPath) && ["prd", "design", "implement", "verify", "research"].some((key) => selectedTaskArtifacts[key] === true);
  const status = collected.length === 0 && !taskArtifactsCollected && !uniqueManifests.length ? "missing" : artifacts.length + memory.length + uniqueManifests.length + codebase.length === 0 && !taskArtifactsCollected ? "empty" : "collected";
  if (status === "missing") warnings.unshift("missing-collected-evidence");
  const evidenceEnvelope = buildEvidenceEnvelope({
    bundle, scored, collection, warnings, router,
    hints: array(payload.adapterHints), conflictMetrics: arbitrated.metrics,
  });
  return {
    version: 1, source: "retrieval-pack-orchestrator", bundle,
    scoredEvidence: { version: 1, total: scored.length, items: scored }, arbitratedEvidence: arbitrated, contextPack: pack,
    collection, warnings,
    evidenceEnvelope,
    inputRole: "collected-evidence", outputRole: "retrieval-pack", abiLayer: "quality", abiOwner: "retrieval-extended",
    abiIntentOwner: "context-progressive", abiProviderOwner: "middleware", collectionStatus: status,
    closeEvidenceEligible: false, notAcEvidence: true,
    reason: status === "missing" ? "pack requires collected-evidence (path + provider label); missing collection is not AC Evidence" : status === "empty" ? "collected-evidence items were present but none mapped to pack sources; empty retrieval-pack is not AC Evidence" : "quality-layer retrieval-pack of collected-evidence; not AC Evidence and not Close Evidence",
  };
}
