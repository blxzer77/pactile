type Row = Record<string, unknown>;
interface ScoredItem { source: string; status: string; freshness: number; validationState: string }
interface State { adapter: string; role: string; state: string; required: boolean; invoked: boolean; reason: string; source?: string; detail?: Row }

const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter((item): item is Row => !!item && typeof item === "object" && !Array.isArray(item)) : [];
const string = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const roles: Record<string, string> = {
  rg: "exact", codegraph: "ast", "language-server": "lsp", "fast-context-mcp": "semantic", "platform-semantic": "semantic",
  "smart-search": "external", "artifact-search": "local-artifact", "session-memory": "historical-context", "task-artifacts": "local-artifact",
  "codebase-evidence": "candidate-evidence", mcp: "integration", browser: "integration", network: "integration", "source-git-tests": "verification",
};
const adapters = ["rg", "task-artifacts", "artifact-search", "session-memory", "smart-search", "codebase-evidence", "codegraph", "language-server", "mcp", "browser", "network", "platform-semantic", "fast-context-mcp", "source-git-tests"];
const optional = new Set(["codegraph", "language-server", "mcp", "browser", "network"]);

/** Describes provider availability from supplied evidence and hints; never probes providers. */
export function buildEvidenceEnvelope(input: {
  bundle: Row; scored: ScoredItem[]; collection: Row; warnings: string[]; router: Row; hints: Row[]; conflictMetrics: Row;
}): Row {
  const { bundle, scored, collection, warnings, router, conflictMetrics } = input;
  const hints = new Map(input.hints.map((item) => [string(item.adapter), item]));
  const recommended = new Set(rows(bundle.recommendations).map((item) => string(item.source)));
  const counts: Record<string, number> = {
    "artifact-search": Number(collection.artifactSearchResults) || 0,
    "session-memory": Number(collection.sessionMemoryResults) || 0,
    "smart-search": Number(collection.smartSearchManifests) || 0,
    "codebase-evidence": Number(collection.codebaseCandidates) || 0,
    "task-artifacts": Object.keys(object(bundle.selectedTaskArtifacts)).length ? 1 : 0,
  };
  const manifests = rows(bundle.smartSearchManifests);
  const state: State[] = adapters.map((adapter) => {
    const hint = hints.get(adapter);
    const required = adapter === "rg" || adapter === "source-git-tests";
    let value = required ? "available" : "skipped";
    let invoked = false;
    let reason = required ? adapter === "rg" ? "baseline exact search; optional adapters never replace rg" : "source/Git/test validation is required before final technical claims" : `${adapter} was not invoked for this retrieval pack`;
    if (adapter === "platform-semantic" && Object.keys(router).length) { value = "unverified"; reason = "provider-request is resolver-owned; no adapter hint supplied"; }
    if (adapter === "fast-context-mcp") reason = "concrete adapter selection is resolver-owned; no adapter hint supplied";
    if (counts[adapter] > 0) {
      invoked = true;
      value = adapter === "smart-search" || adapter === "codebase-evidence" ? "unverified" : "available";
      reason = `${adapter} evidence payload was supplied to the retrieval pack`;
    } else if (recommended.has(adapter)) { value = "unavailable"; reason = `${adapter} recommended but no evidence payload was collected`; }
    if (adapter === "smart-search" && manifests.length) {
      const statuses = manifests.map((item) => string(item.status) || "failed");
      value = statuses.includes("failed") ? "failed" : statuses.includes("not_configured") ? "unavailable" : "unverified";
      reason = value === "failed" ? "one or more Smart Search manifests report failed status" : value === "unavailable" ? "Smart Search is not configured for this project" : "external evidence still requires source validation";
    }
    if (hint && (adapter !== "smart-search" || !manifests.length)) {
      const supplied = string(hint.state);
      if (["available", "unavailable", "unverified", "stale", "failed", "skipped"].includes(supplied)) value = supplied;
      invoked = hint.invoked === true;
      reason = string(hint.reason) || `${adapter} adapter hint`;
    }
    return { adapter, role: roles[adapter] ?? "adapter", state: value, required, invoked, reason, ...(counts[adapter] ? { source: adapter } : {}) };
  });
  const byAdapter = new Map(state.map((item) => [item.adapter, item]));
  const checkedAt = new Date().toISOString();
  const freshness = state.map((item) => {
    const matching = scored.find((entry) => entry.source === item.adapter);
    const usable = !["unavailable", "failed", "skipped"].includes(item.state);
    const freshnessScore = !usable ? 0 : item.adapter === "rg" ? 100 : item.adapter === "source-git-tests" ? 90 : matching ? matching.freshness : item.state === "stale" ? 25 : item.state === "unverified" ? 45 : 60;
    return { adapter: item.adapter, role: item.role, freshnessScore, stale: item.state === "stale" || freshnessScore > 0 && freshnessScore < 40, checkedAt, state: item.state, note: matching ? `derived from scored evidence validationState=${matching.validationState}` : "adapter state only; no provider probe" };
  });
  const fallback: Row[] = rows(router.stopReasons);
  const addFallback = (fromAdapter: string, toAdapter: string, reason: string): void => { fallback.push({ fromAdapter, toAdapter, reason }); };
  for (const adapter of ["codegraph", "language-server", "fast-context-mcp", "smart-search", "codebase-evidence", "mcp", "browser", "network"]) {
    const entry = byAdapter.get(adapter);
    if (!entry) continue;
    if (adapter === "smart-search" && ["failed", "unavailable", "unverified"].includes(entry.state)) {
      addFallback(adapter, "task-artifacts", "prefer durable task artifacts");
      addFallback(adapter, "rg", "Smart Search gaps require exact search and source reads");
    } else if (adapter === "codebase-evidence" && entry.state === "unverified") addFallback(adapter, "rg", "codebase candidates require rg and file-range confirmation");
    else if (entry.state === "skipped" && optional.has(adapter)) addFallback(adapter, "rg", `${adapter} skipped; continue with rg and direct source reads`);
    else if (["failed", "unavailable", "stale"].includes(entry.state)) addFallback(adapter, "rg", `${adapter} ${entry.state}; label evidence unverified`);
  }
  for (const [adapter, hint] of hints) for (const explicit of rows(hint.fallback)) fallback.push({ fromAdapter: string(explicit.fromAdapter) || adapter, toAdapter: string(explicit.toAdapter) || "rg", reason: string(explicit.reason) || "caller-provided fallback" });
  const verification: Row[] = [
    ...rows(router.verificationChain),
    { adapter: "source-git-tests", requirement: "confirm final claims with current source reads and focused validation", blocking: true },
    { adapter: "rg", requirement: "corroborate identifiers and literals with rg before relying on semantic recall", blocking: false },
  ];
  if (byAdapter.get("smart-search")?.state === "failed") verification.push({ adapter: "smart-search", requirement: "do not treat Smart Search output as confirmed without durable validation", blocking: true });
  if (byAdapter.get("codegraph")?.state === "stale") verification.push({ adapter: "codegraph", requirement: "confirm CodeGraph structural output against current source before impact claims", blocking: false });
  if (scored.some((item) => item.validationState === "candidate")) verification.push({ adapter: "codebase-evidence", requirement: "candidate scored evidence requires explicit validation", blocking: false });
  const allWarnings = [...warnings];
  for (const item of state) {
    if (item.state === "failed") allWarnings.push(`adapter ${item.adapter} failed; do not treat its output as evidence`);
    if (item.state === "stale") allWarnings.push(`adapter ${item.adapter} evidence is stale; confirm with current source`);
    if (item.required && ["failed", "unavailable"].includes(item.state)) allWarnings.push(`required adapter ${item.adapter} is ${item.state}`);
  }
  return {
    version: 1,
    intents: Array.isArray(router.intents) ? router.intents : [], routes: rows(router.steps),
    adapterState: state, freshness, fallback: [...new Map(fallback.map((item) => [JSON.stringify(item), item])).values()],
    warnings: [...new Set(allWarnings)], verification: [...new Map(verification.map((item) => [JSON.stringify(item), item])).values()],
    conflictMetrics,
  };
}
