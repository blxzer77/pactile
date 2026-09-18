# Pactile brand contract

Status: Batch 0 frozen input for the 0.5.0 rebrand. This document is a control-plane contract, not the rebrand itself.

## Canonical identity

| Surface | Canonical form |
| --- | --- |
| Product | `Pactile` |
| Pronunciation | `PACK-tile` (`/ˈpæk.taɪl/`) |
| CLI and bin | `pactile` |
| Project runtime | `.pactile/` |
| Environment prefix | `PACTILE_` |
| Managed marker prefix | `PACTILE` |
| CLI npm package | `@blxzer/pactile` |
| Core npm package | `@blxzer/pactile-core` |
| Repository slug | `pactile` |
| Release tag prefix | `pactile-v` |

The spelling is always **Pactile** in prose. Use lowercase only for machine identifiers. Do not invent variants such as “PacTile”, “Pact Tile”, or host-qualified product names.

## Why this name

**Pact** names the explicit contract between a model, the workspace, and the user: gates are visible, ownership is declared, and claims are backed by evidence and trace.

**Tile** names the composable unit. A capability is not a monolithic playbook; it is a small, discoverable building block that a model can select and assemble for the task in front of it.

Together, Pactile describes the product direction:

> Governed capability tiles, assembled on demand and backed by evidence.

The name deliberately does not contain Cursor or Codex. Pactile owns the host-neutral Kernel, Tiles, Evidence, Trace, Projection, and Ownership contracts. Cursor and Codex are first-class host projections of that product.

## Product narrative

The one-sentence English description is:

> Pactile turns governed capability tiles into an evidence-backed workspace for Cursor and Codex.

The canonical Chinese description is:

> Pactile 把受契约约束的能力积木，按需拼成 Cursor 与 Codex 都能使用、且有证据可追溯的工作空间。

Every live introduction should preserve four ideas:

1. **Composable Tiles** — the model selects and assembles small capabilities instead of loading one large playbook.
2. **Kernel contracts** — lifecycle, ownership, gates, and state transitions have a host-neutral source of truth.
3. **Evidence and Trace** — important claims and transitions remain inspectable.
4. **Progressive disclosure** — only the pointers and capabilities needed for the current task enter context.

## Surface classification

All legacy-name occurrences must belong to exactly one class:

| Class | Meaning | 0.5.0 treatment |
| --- | --- | --- |
| `live` | Current product or user guidance | Rewrite to Pactile before stable release. |
| `compat` | A 0.5.x alias, shim, dual-read path, or migration input | Keep only with an owner, reason, and exit condition. Never emit it as the preferred form. |
| `history` | Changelog, released manifest, archived evidence, old tag, or frozen release narrative | Preserve facts. Do not mechanically rewrite. |
| `attribution` | License, copyright, fork provenance, or upstream name | Preserve permanently, while making clear it is not the current product name. |

The current inventory gate is intentionally a **baseline gate**: it detects any unclassified or newly added legacy occurrence while Batch 3 is still removing live debt. It scans both tracked file contents and tracked path names, including the names of binary files whose contents are intentionally skipped. Classification is path-scoped: a word such as “history”, “legacy”, “copyright”, or “migration” elsewhere on a live line cannot exempt a legacy token from the stable-release deny. Mixed live/history prose must move the historical material to an explicitly classified history path. The stable-release mode additionally rejects every `live` legacy occurrence.

The three machine contracts use fixed IDs and canonical invariants: `pactile.brand-inventory/v1`, `pactile.rename-map/v1`, and `pactile.documentation-map/v1`. The checker owns the required token sources, documentation sources, target pages/topics, P23 routes, locale/navigation/status rules, and Native adoption safety fields. Editing a JSON file to remove the very rule that should inspect it therefore fails closed instead of redefining the checker.

## Compatibility window

The compatibility window is the complete `0.5.x` line.

- Canonical output, examples, prompts, and newly written configuration use Pactile names only.
- The runtime may dual-read documented legacy names during 0.5.x.
- A legacy alias must warn or report its canonical replacement where doing so is safe and non-noisy.
- Removal is no earlier than `0.6.0`, and only after release notes, migration checks, and ownership data show that the alias is no longer required.
- History and attribution are not aliases and do not expire.

The exact entity-by-entity rules live in [`rename-map.json`](./rename-map.json).

## Native install, adopt, and bind

Pactile must not equate “the host already has a file” with “Pactile owns that file.” Cursor and Codex projections use the following state model:

| Observed state | Operation | Ownership result |
| --- | --- | --- |
| External/native dependency is absent | `install-hint` | Report the minimum installation hint. The user or host performs installation; when later detected, Pactile may only adopt it as borrowed. |
| Pactile-composed/generated projection is absent | `install` | Materialize that projection, record Pactile as its owner, and add the requesting Adapter as claimant. |
| Native asset is semantically compatible but pre-existing | `adopt` | Reuse it as a borrowed resource; record the preimage and never delete it on detach. |
| A capability must use an installed or adopted native asset | `bind` | Add only the host/capability binding and claimant; do not copy canonical content into the host config. |
| Same identity, different semantics | `conflict` | Leave the user asset untouched and require an explicit resolution. |
| Native config is malformed, locked, or awaiting host trust | `degraded` | Degrade only that host Adapter, preserve the retry plan, and keep the other host operational. |

Consequences:

- Installation order must not change the final projection.
- Shared-resource identity is host-neutral: `resource kind + stable logical id` within the workspace. Cursor and Codex are claimants/bindings, not part of the resource identity.
- Cursor and Codex can claim the same `.agents/skills/` Tile and the same managed `AGENTS.md` block.
- Detaching one host removes its claims and bindings, not shared resources still claimed by the other host.
- Uninstall deletes a generated resource only when its final claimant leaves and its current bytes still match a safe managed state.
- A borrowed native asset is never deleted automatically.
- MCP and other external Providers are bound through the Middleware Resolver, not hard-coded by a host Adapter.
- Retrieval reports the minimum assurance actually available on the active host and records each Provider's origin and readiness; it must not imply equal assurance merely because Cursor and Codex expose similarly named capabilities.

## Managed markers and blocks

New managed content uses `PACTILE` markers. A project has one Pactile `AGENTS.md` block, regardless of whether Cursor, Codex, or both are attached.

Legacy `CSTL` and `TRELLIS` markers are migration inputs only. During the compatibility window the reconciler may recognize them, record their preimage, and replace them through one reviewed plan. It must not create parallel old and new product blocks.

## History and attribution guardrails

- Do not rewrite old release notes, tags, published migration manifests, archived Evidence, or quoted historical commands as though Pactile existed at that time.
- Do not remove upstream project names from license, copyright, provenance, or fork-attribution text.
- A current page may link to preserved history, but historical operational steps must not appear as the recommended current workflow.
- Cursor++ is history/compatibility cleanup, not a current Pactile capability and not a BYOK promise.

## Name-availability snapshot

Checked at `2026-09-08T18:30:51Z`–`2026-09-08T18:31:10Z` (`2026-09-09 02:30` Asia/Shanghai) from this repository, without reserving or mutating any name.

| Check | Command | Observed result |
| --- | --- | --- |
| Unscoped npm name | `npm view pactile name version --json` | npm returned `E404`. |
| Scoped CLI package | `npm view @blxzer/pactile name version --json` | npm returned `E404`. |
| Scoped core package | `npm view @blxzer/pactile-core name version --json` | npm returned `E404`. |
| Target GitHub repository | `gh repo view blxzer77/pactile --json name,url,isPrivate` | GitHub could not resolve that repository. |
| GitHub name search | `gh api -X GET search/repositories -f q='pactile in:name' -f per_page=20` | Search returned at least `Pactile/Files`. |

This is a time-bounded discovery snapshot, not a permanent guarantee. npm `E404` can also mean the caller lacks access; GitHub search is not exhaustive; the string is not globally unique; no package, repository, domain, social handle, or trademark was reserved; and no legal clearance was performed. Re-run the checks immediately before reservation and release, then perform the appropriate legal/trademark review.

## Batch boundaries

Batch 0 owns this contract, the inventories, the IA map, and the focused checker. It does **not** rename packages, bins, paths, environment variables, markers, current documentation, or GitHub configuration.

- Batch 3 consumes [`rename-map.json`](./rename-map.json) for runtime and compatibility work.
- Batch 4 documentation lanes consume [`documentation-map.json`](./documentation-map.json) for rewrites, redirects, merges, and archives.
- Release conformance consumes the checker in stable-release mode after the live debt has been removed.

## Post-release strict enforcement

CI and stable preflight run `check-pactile-brand-surface.js --release`; live
legacy-name occurrences must be zero. The exact compatibility references,
old URL pointers, conformance runners, and legacy/negative regression files
remain inventoried with specific reasons and exit conditions. This does not
exempt whole docs, test, or workflow directories. Publish stays live and reads
its four-package identities from existing metadata.

Exact import spellings and read-only roots are documented in
[compatibility inputs](compatibility-inputs.md) and its
[Chinese peer](compatibility-inputs.zh-CN.md). Unreferenced old artwork is
archived byte-for-byte under `docs/history/assets/`, not used as current artwork.
