# Tiles

English | [简体中文](tiles.zh-CN.md)

## Definition

A Tile is a small, versioned capability contract that the model or user can select and compose for one task. It states what the capability needs and permits; it does not prescribe private reasoning or embed a host-specific script.

## Responsibilities

A Tile declares:

- stable identity and semantic version;
- trigger and supported intent;
- logical inputs, outputs, dependencies, and conflicts;
- filesystem, process, network, credential, privacy, telemetry, destination, and cost ceilings;
- minimum assurance and required Evidence kinds;
- bounded fallback policy, stop conditions, and attempt limit.

The compiler checks dependencies, conflicts, policy ceilings, deterministic ordering, and fallback bounds before execution. The model still chooses the useful Tiles and interprets the task; the Kernel is not a central planner.

## Boundaries

A Tile contains no steps DSL, tool or MCP server name, Cursor/Codex path, prompt transcript, arbitrary URL, credential value, or private chain of thought. An intent such as `structural` or `external` is resolved later through Middleware. MCP is one possible Provider integration, not a Tile.

Fallback cannot broaden permission, destination, egress, credential, telemetry, cost, or assurance policy. Network-forbidden Tiles cannot smuggle remote behavior through a fallback.

## User scenario

A repository investigation needs exact symbol lookup and a structural dependency view. The model selects two Tiles with compatible outputs. The compiler orders them, verifies that neither requests network access, and records the selection. If the structural Provider is unavailable, the declared fallback can use local exact search only when it remains within the original ceiling and still meets the minimum assurance; otherwise the result is degraded with an explicit action.

## Selection flow

The bundled registry distinguishes **baseline** Tiles from **on-demand** Tiles. Both are available to the selection service, but every choice is made for one request. Classification and lifecycle are registry facts, separate from the frozen v1 Tile manifest. The pure selection API requires one lifecycle fact for every catalog ref. A baseline Tile must be `active`; an on-demand Tile may be `active` or `registered`. Deprecated, disabled, retired, and degraded Tiles are removed before an Agent-facing offer is built.

For a real selected Task, `prepareSelectedTaskBatch2TileSelection(root, request)` reads the current Task's Kernel phase, condition, outcome, revision, and available activation facts. Legacy Kernel Tasks fail closed when module lifecycle facts are missing or unknown. Task Kernel v2 currently treats bundled baseline Tiles as active and bundled on-demand Tiles as registered because v2 does not store Tile activation state. The same reader is called again by `decideSelectedTaskBatch2TileSelection`; a changed Task snapshot makes the old offer stale.

The Task's approved, active Run scope may carry a versioned Tile grant: `pactile-tile-selection/v1:` followed by canonical JSON with `schemaVersion`, `policyCeiling`, `capabilities`, and `providerFacts`. The grant is an upper bound. The caller's request is intersected with it, so caller-supplied limits can only make the offer narrower. Without a valid recorded grant, the Task API uses a read-only, local-only, low-cost ceiling and no capabilities or Providers. A Kernel approval scope is caller-declared evidence; the selection receipt records that assurance without claiming to authenticate the person who made it.

The real Agent host path is `pactile context --mode session --json`. For a selected Task it derives a request from the current Kernel phase and returns only the compiler-checked `tileSelection.offer`; it never sends `plan.audit` or filtered Tile details to the Agent. During an approved, active V2 Run, the session request is capped by that Run's recorded Tile grant. Without that grant, before a Run, or after a Run completes, the session request stays at its read-only safe default. The returned `tileSelection.decisionCommand` is directly executable and uses `--session`: the CLI rebuilds the request from the current selected Task/Run facts, recompiles the Offer, and compares its fingerprint before recording a decision. If the phase, revision, selected Task, or active Run changed, the old fingerprint is stale. The CLI `pactile tile-selection prepare` takes an explicit request; its Task-scoped policy, capabilities, and Provider facts are intersected with the recorded grant, so the caller can narrow but not widen the grant.

```sh
pactile tile-selection prepare --intent structural --output task.design
pactile tile-selection decide --offer-fingerprint <offer-fingerprint> --kind adopt --intent structural --output task.design
pactile tile-selection decide --session --offer-fingerprint <session-offer-fingerprint> --kind adopt
pactile tile-selection replay --snapshot-fingerprint <snapshot-fingerprint>
```

`decide` writes a bounded, write-once v2 snapshot under `.pactile/runtime/receipts/`. It contains the normalized request, hashed project/Task identity, the filtered Offer, facts only for offered candidates and their dependency closures, catalog fingerprint, compiler ABI, normalized decision, and receipt. It does not store the full catalog, Skill bodies, filtered Tile details, local paths, or `plan.audit`. Provider evidence references are hashed before persistence. Historical replay requires the matching catalog version to be available; if its fingerprint differs, replay fails with `tile-selection-snapshot-historical-catalog-unavailable` instead of embedding hidden catalog data in the snapshot. Replay revalidates the Offer and reruns the compiler to reproduce the receipt without reading mutable Task state. A selection decision does not activate a Tile, start a Kernel Run, or authorize execution; those gates remain independent.

`loadBatch2TileSelectionSurface(lifecycleByRef)` returns the checked bundled catalog and the explicitly supplied baseline/on-demand/lifecycle facts. `prepareBatch2TileSelection(request, lifecycleByRef)` is the pure entry point when the caller already owns those facts. The candidate builder then:

1. checks intent and caller channel;
2. resolves the dependency closure and requires every Tile in it to pass its tier's lifecycle rule;
3. removes Tiles whose declared permission ceiling exceeds the task ceiling;
4. rejects dependency conflicts or any selection the Tile compiler cannot validate;
5. returns only eligible summaries in `offer.candidates`, with deterministic output-coverage suggestions.

The separate `plan.audit` carries bounded symbolic filter codes for inspection. Do not forward it as the model's candidate list. A Task with a blocked or waiting condition, or a terminal outcome, yields no Agent-facing candidates.

P33 also exposes an optional Jev advice seam: `prepareBatch2TileSelectionWithJevV1(request, lifecycleByRef, jev?)` and the selected-Task Agent entry point `prepareSelectedTaskAgentTileSelectionWithJevV1(root, jev?, expectedLifecycle?, env?)`. Omitting `jev` returns the deterministic offer only. The selected-Task entry point rereads the Kernel, Task grant, and lifecycle facts before computing the offer; its default read-only local profile does not authorize Jev egress. A call is made only when the effective policy ceiling permits network, credentials, approved egress privacy, the exact Jev origin, and a non-free cost ceiling. The caller must also authorize `task-summary-and-snippets-approved`. Missing keys, rejected content, cancellation, timeout, provider failure, or invalid answers produce an explained fallback and retain the deterministic result.

The actual `pactile context --mode session --json` CLI optionally uses this seam when `PACTILE_JEV_API_KEY` is present. The key is read from the process environment and is never written to Pactile state or receipts. Project `jev.egress` defaults to allow when omitted from a valid or absent config; an explicit project denial or invalid config blocks Jev before HTTP. Project allow never widens authority: the current active selected-Task Run grant must independently permit network and credentials, `project-approved-egress`, `https://api.typesafe.ai`, and a non-free cost ceiling. The key alone cannot authorize egress. Unset `PACTILE_JEV_ENABLED` does not require another opt-in; setting it to `false` disables Jev. The session path allows at most one decision, with a 2.5-second deadline and one bounded retry. No key, explicit disablement, denied egress, recognized sensitive content, provider failure, or invalid answer keeps the local deterministic session and adds a bounded explanation.

The session route sends only the P34 request: a short intent/output summary and at most eight hard-filtered Tile candidates as logical refs, summaries, outputs, and dependency closures. It does not send the Task artifacts or arbitrary project source files. The returned `tileSelection.jevAdvice` records the offer and input fingerprints, bounded candidate/suggestion refs, model, latency, usage/cost estimate, and fallback reason; it contains no key or request text. If the Task selection, active Run, lifecycle revision, or offer fingerprint changes while the request is in flight, the response is discarded and the current deterministic offer is returned. A Jev proposal is not applied automatically: the returned advice command still passes through the selected-Task Tile decision path, which recompiles the current offer. The public facade itself remains explicit and does not read environment variables.

Jev sees at most eight hard-filtered candidates that contribute at least one requested output, with their refs, summaries, outputs, and dependency closures, plus the task intent and requested outputs. It never receives `plan.audit`, filtered candidates, output-irrelevant candidates, or local paths. The P34 content boundary blocks recognized credentials and explicit sensitive markers before HTTP; heuristic checks cannot prove that arbitrary secrets are absent, so source content still requires project approval. Low-confidence answers are not suggestions. `suggestedDecision` is a proposal: this seam first checks it with the Tile Compiler but does not persist it. Callers that want to record a selection must submit the proposal through the existing selected-Task decision API, which rechecks current Kernel state and the offer fingerprint before writing. Jev does not authorize Tile activation, execution, Review, CI, or Kernel transitions. The caller constructs `createJevDecisionFacadeV1` from its approved configuration; this API does not automatically read environment variables or force Jev to be enabled.

The pure bundled API takes explicit lifecycle facts: `decideBatch2TileSelection(request, decision, lifecycleByRef)`. The selected-Task API reads current facts itself: `decideSelectedTaskBatch2TileSelection(root, request, decision)`. `adopt` accepts the complete suggestion; `override` accepts another eligible selection. Both are compiled again. An incomplete override is recorded as `mis-selection`; malformed, filtered, or compiler-rejected choices receive an invalid or rejected outcome. A `no-match` decision can retain a prior attempted selection so a correction leaves both results. The deterministic decision receipt includes the chosen and expanded refs, output coverage, diagnostics, compiler fingerprint, and its own fingerprint. `replayBatch2TileSelectionDecision(request, decision, lifecycleByRef)` recomputes a receipt from the same current inputs; `replayStoredSelectedTaskBatch2TileSelectionDecision(root, fingerprint)` verifies a persisted historical decision.

```ts
import {
  decideSelectedTaskBatch2TileSelection,
  prepareSelectedTaskBatch2TileSelection,
  taskTileSelectionRequest,
} from "@blxzer/pactile";

const request = taskTileSelectionRequest("define");
const plan = prepareSelectedTaskBatch2TileSelection(projectRoot, request);
if (plan.success) {
  const result = decideSelectedTaskBatch2TileSelection(projectRoot, request, {
    kind: "adopt",
    offerFingerprint: plan.data.offer.fingerprint,
  });
  if (result.success) console.log(result.data, result.snapshot);
}
```

Suggestions rank possible output coverage; they do not authorize execution or write task state. The Kernel remains the authority for durable task transitions, and the Tile compiler remains the authority for composition validation.

## What to inspect

- The Tile manifest tells you the maximum authority requested.
- The resolved Provider tells you the actual origin, assurance, readiness, and Evidence.
- Trace tells you whether the Tile was selected, invoked, skipped, failed, or completed.
- A policy denial is a valid outcome, not a reason to silently run a broader tool.

See [Kernel, Evidence, and Trace](kernel-evidence-trace.md) and [Capabilities](../capabilities/index.md).
