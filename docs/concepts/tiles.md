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

The real Agent host path is `pactile context --mode session --json`. For a selected Task it calls the current-Task preparation API and returns only the compiler-checked `tileSelection.offer`; it never sends `plan.audit` or filtered Tile details to the Agent. Use `pactile tile-selection prepare --intent structural --output task.design` to request the same safe default profile directly, then decide with the returned offer fingerprint:

```sh
pactile tile-selection decide --offer-fingerprint <offer-fingerprint> --kind adopt --intent structural --output task.design
pactile tile-selection replay --snapshot-fingerprint <snapshot-fingerprint>
```

`decide` writes a bounded, write-once snapshot under `.pactile/runtime/receipts/`. It contains the normalized request, hashed project/Task identity, Kernel facts, immutable bundled manifest and Skill content, compiler ABI, decision, and receipt, but not local paths or `plan.audit`. Provider evidence references are hashed before persistence. Historical replay reads only that snapshot, recomputes and returns the original offer and receipt, and does not depend on mutable Task state. A selection decision does not activate a Tile, start a Kernel Run, or authorize execution; those gates remain independent.

`loadBatch2TileSelectionSurface(lifecycleByRef)` returns the checked bundled catalog and the explicitly supplied baseline/on-demand/lifecycle facts. `prepareBatch2TileSelection(request, lifecycleByRef)` is the pure entry point when the caller already owns those facts. The candidate builder then:

1. checks intent and caller channel;
2. resolves the dependency closure and requires every Tile in it to pass its tier's lifecycle rule;
3. removes Tiles whose declared permission ceiling exceeds the task ceiling;
4. rejects dependency conflicts or any selection the Tile compiler cannot validate;
5. returns only eligible summaries in `offer.candidates`, with deterministic output-coverage suggestions.

The separate `plan.audit` carries bounded symbolic filter codes for inspection. Do not forward it as the model's candidate list. A Task with a blocked or waiting condition, or a terminal outcome, yields no Agent-facing candidates.

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
