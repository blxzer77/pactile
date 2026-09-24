# Changelog

All notable changes to **@blxzer/pactile** are documented in this file. Older
entries retain the package names used when they were published.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
SemVer: [semver.org](https://semver.org/spec/v2.0.0.html).

> Prior internal releases shipped as `@blxzer/trellis` (1.x) and later as
> `@blxzer/cursor-trellis`. They remain on npm for history. New installs use
> `@blxzer/pactile`.

---

## [Unreleased] - v0.6.0

- Node.js is the only required runtime. The task lifecycle, context and
  retrieval path, Codex desktop request/receipt bridge, Pi RPC bridge, and
  bounded parallel dispatch run in Node. Legacy generated Python entrypoints
  are retired; the update preview inventories modified and unclaimed files
  before any safe deletion.
- Codex is the supported host projection. Pi is the initial worker Agent;
  Pactile binds its runs to approved tasks and records bounded evidence.
  Codex desktop calls remain host native and require a recorded receipt.
- The unpublished `0.5.1-beta.0` pool cleanup is folded into the
  `0.6.0-beta.1` migration manifest, which is retained in stable `0.6.0`.
  It deletes only hash-matched pool skeleton files and never targets
  user-authored pool items.
- One npm package, `@blxzer/pactile`, includes CLI and Core. The release gate
  checks the sealed tarball, a Python-free Node path, installed task lifecycle,
  simulated Pi/Codex bridges, and bounded parallel dispatch. Live Pi provider
  and desktop-host acceptance are recorded separately.

This entry describes the development target. No stable v0.6.0 package or tag has
been published yet. Follow the [upgrade guide](../../docs/lifecycle/upgrade-and-migrate.md)
and [release procedure](../../docs/governance/releasing.md) for acceptance.

---

## [0.6.0-beta.1] - 2026-09-25

First beta of the Node-only Pactile workflow and single-package release path.
It includes the Codex desktop request/receipt bridge, the Pi RPC bridge,
bounded parallel dispatch, and the migration from generated Python task
entrypoints. The review-pool cleanup runs only for hash-matched skeleton files.
The simulated Pi and Codex checks in the release gate do not attest to a live
model provider or desktop-host run.

---

## [0.5.0] - 2026-09-11

Pactile 0.5.0 is the first stable release of the Pactile product line. The
canonical package and repository names are now Pactile; the legacy
`cursor-trellis` package names remain available as thin 0.5.x compatibility
bridges.

### Highlights

- Canonical npm packages: `@blxzer/pactile` (CLI) and
  `@blxzer/pactile-core` (Core SDK).
- Canonical project state under `.pactile/`, with `PACTILE` markers and
  host-neutral contracts shared by Cursor and Codex adapters.
- Ownership-aware projections preserve existing user and host resources while
  making Pactile-managed changes auditable and reversible.
- The release graph validates and publishes the Core, CLI, and both legacy
  bridges as one versioned set.

### Install

```sh
npm install -g @blxzer/pactile
```

Pactile is distributed under `AGPL-3.0-only`; see the repository
[`LICENSE`](../../LICENSE) and [`COPYRIGHT`](../../COPYRIGHT) files for the
complete license and project/upstream attribution.

### Compatibility

Existing `@blxzer/cursor-trellis` and `@blxzer/cursor-trellis-core` installs
remain supported during the 0.5.x compatibility window. New installations
should use the canonical Pactile package names.

---

## [0.5.0-beta.5] - 2026-09-08

P42/P43 Freestyle product mirrors + P44 E2E guide init registry. **Not** `@latest` — install with `@beta` or the exact version.

### Added

- **feat(templates)**: product `workflow.md` is the interface card (no Request Triage / `[Triage:` / MANDATORY TRIAGE); pointer `AGENTS.md`; thin `cstl-implement` / `cstl-check` / `cstl-research` agents; grill frontier optional-brick + AC 歧义面=0; test-discipline testing brick; E2E walkthrough guide template asset.
- **feat(memory)**: product `task_gates.py` template writes `notes_projection.points[]` with `source` / `confidence`.
- **feat(docs)**: framework injection / budget / reachability guides (and their `.md.txt` mirrors) no longer describe Request Triage as a live hard gate; prohibition sentences stay.
- **feat(init)**: `cstl init` installs `.cstl/spec/guides/e2e-walkthrough-guide.md` next to test-discipline (init-only seed; `cstl update` still does not overwrite user `spec/guides`).

### Notes for consumers

- Install **`npm i -g @blxzer/cursor-trellis@0.5.0-beta.5`** or **`@blxzer/cursor-trellis@beta`**. `@latest` stays **0.4.3**.
- In the **project root** run `cstl update` (do not re-run `init`). Existing projects migrate; `.cstl/middleware/` is never written. Existing `spec/guides` stay user-owned; new installs get the E2E guide.
- Core and CLI versions stay paired: `@blxzer/cursor-trellis-core@0.5.0-beta.5`.
- Maintainers: tag **`cstl-v0.5.0-beta.5`**. Do not promote this prerelease to `main` / `@latest` until an explicit official release.

## [0.5.0-beta.4] - 2026-09-07

Version bump only (rebuild of the beta-3 publish). No functional changes vs `0.5.0-beta.3`; this release carries the same P41 memory-cut feature set (notes_projection + spec-write audit + Lite archive relaxation). **Not** `@latest` — install with `@beta` or the exact version.

### Notes for consumers

- Install **`npm i -g @blxzer/cursor-trellis@0.5.0-beta.4`** or **`@blxzer/cursor-trellis@beta`**. `@latest` stays **0.4.3**.
- In the **project root** run `cstl update` (do not re-run `init`). Existing projects migrate; `.cstl/middleware/` is never written.
- Core and CLI versions stay paired: `@blxzer/cursor-trellis-core@0.5.0-beta.4`.
- Maintainers: tag **`cstl-v0.5.0-beta.4`**. Do not promote this prerelease to `main` / `@latest` until an explicit official release.

## [0.5.0-beta.3] - 2026-09-07

P41 memory cut: notes_projection slot + spec-write audit + Lite archive relaxation. **Not** `@latest` — install with `@beta` or the exact version.

### Added

- **feat(memory)**: `kernel.json` extras gains `notes_projection` — at archive, `cmd_archive` summarizes reusable points from `ac_evidence_ledger` / `independent_check` / `verify.md` (≤150 tokens via `session_memory`) plus artifact pointers. This is the Notes track of the 双轨记忆 (Notes + History) design: machine-recorded at Close, searchable later, never full-text injected.
- **feat(memory)**: `spec-write-audit.py` preToolUse hook records spec writes — when a write targets `.cstl/spec/`, `docs/adr/`, or Policy, it logs actor / timestamp / target / verification state to `.cstl/.runtime/hooks/spec-write.log`. It only records and always allows (never blocks a write). Contract updated in `spec-learning`; Event Bridge subscription registered; shipped in `shared-hooks`.
- **feat(contracts)**: `personal-memory` gains a Close Notes index-projection clause (≤N-token summary + path pointer, `context-progressive` layer-4 retrieval, not resident); `close-basic` learning disposition gains `note-projection` (missing slot only leaves a trace, never blocks Close).

### Changed

- **fix(templates)**: `_resolve_seed_spec_paths` now scans `.cstl/spec/guides/` for real guide files instead of only fixed seed paths, so `task.py create` jsonl seeds stay valid when guides live there.
- **fix(templates)**: `start-execution --ignore-deps` writes `depends_on` refs into `dependency_satisfied` so the Kernel `start` transition allows the override (previously the Kernel still rejected `requires unmet`).
- **fix(hooks)**: `spec-write-audit` moved to second in `preToolUse` so the `Task|Subagent` matcher stays first (documented `platforms.test.ts` contract).
- **fix(gates)**: Lite tasks no longer require a substantive `durable-learning` decision in `verify.md` — explicit `N/A` or a missing line archives cleanly (one-off bugfixes shouldn't be over-gated). Full / Parent still require a real decision.

### Notes for consumers

- Install **`npm i -g @blxzer/cursor-trellis@0.5.0-beta.3`** or **`@blxzer/cursor-trellis@beta`**. `@latest` stays **0.4.3**.
- In the **project root** run `cstl update` (do not re-run `init`). Existing projects migrate; `.cstl/middleware/` is never written.
- Core and CLI versions stay paired: `@blxzer/cursor-trellis-core@0.5.0-beta.3`.
- Maintainers: tag **`cstl-v0.5.0-beta.3`**. Do not promote this prerelease to `main` / `@latest` until an explicit official release.

## [0.5.0-beta.2] - 2026-09-01

P40 pool split at Open + default-script init hole. **Not** `@latest` — install with `@beta` or the exact version.

### Added

- **feat(pool)**: when the user starts implementing an accepted pool item, write `## 切片` on that item and Open isolatable Fulls (or a Parent only if integration authority is required). Check helper `evaluate_pool_slice` fails Full/Parent missing `touches`, unrelated module pairs without `serial_reason` / `oversized_accepted`, and multi-link tasks whose PRD lacks per-item `## 池义务`. `pool.py validate` does **not** fail when `## 切片` is missing.

### Fixed

- **fix(init)**: ship `common/artifact_search.py` and `common/injection_budget.py` in the default `getAllScripts()` set. 0.5.0-beta.1 omitted them even though `pool_store` / `pool_refs` / `subagent_dispatch` / `task_context` import them at top level, so a clean `cstl init` could not import pool or dispatch.

### Notes for consumers

- Install **`npm i -g @blxzer/cursor-trellis@0.5.0-beta.2`** or **`@blxzer/cursor-trellis@beta`**. `@latest` stays **0.4.3**.
- In the **project root** run `cstl update` (do not re-run `init`). Official `.cstl/pool/README.md`, `pool_slice.py`, and the two common modules refresh. `.cstl/middleware/` is never written.
- Core and CLI versions stay paired: `@blxzer/cursor-trellis-core@0.5.0-beta.2`.
- Maintainers: tag **`cstl-v0.5.0-beta.2`**. Do not promote this prerelease to `main` / `@latest` until an explicit official release.

## [0.5.0-beta.1] - 2026-09-01

P38 parallel-first runtime + P39 Cursor Adapter on the modular preview. **Not** `@latest` — install with `@beta` or the exact version.

### Added

- **feat(runtime)**: Full / Parent planning must declare isolatable groups (`parallel_groups` / `stages`) or a `serial_reason`. Check helper `evaluate_parallel_declaration` fails when the declaration is missing. Lite may skip. This is not a `start-execution --check` hard gate and not a scheduler.
- **feat(adapter)**: Cursor Q5 slot map and Q11–Q25 bindings live in the Adapter guide and escape hatches. Visible parallel fans out on **Execute** (ask to open Multitask, else `Task()` plus one sentence). **Integrate?** stays serial Parent `integrate-child` (`merge_limit: 1`).

### Changed

- **fix(modules)**: `worker-orchestration` / `intake-basic` contracts drop Cursor host nouns (`Multitask`, `SwitchMode`, `CreateGoal`, Cursor Task type names). Prefer host-native parallel in host-agnostic wording. Worker-orchestration activates only when isolatable groups are declared **and** a dispatch window is open.
- **fix(adapter)**: thin Bootstrap gains a Next native action pointer (no `SwitchMode`). `continue.md` / `finish-work.md` bind Plan / Goal / parallel without restoring `cstl-goal`. Build probe stays Adapter A′ (not a Kernel Event Bridge default).

### Notes for consumers

- Install **`npm i -g @blxzer/cursor-trellis@0.5.0-beta.1`** or **`@blxzer/cursor-trellis@beta`**. `@latest` stays **0.4.3**.
- In the **project root** run `cstl update` (do not re-run `init`). Official `.cstl/modules/worker-orchestration/contract.md` and `.cstl/framework/cursor-native-modes-guide.md` refresh. `.cstl/middleware/` is never written.
- Core and CLI versions stay paired: `@blxzer/cursor-trellis-core@0.5.0-beta.1`.
- Maintainers: tag **`cstl-v0.5.0-beta.1`**. Do not promote this prerelease to `main` / `@latest` until an explicit official release.

## [0.5.0-beta.0] - 2026-08-31

Modular runtime preview. Kernel stays thin; P29 short contracts ship under `.cstl/modules/`; SessionStart injects a compiled session pack instead of dumping `workflow.md` Phase Index. **Not** `@latest` — install with `@beta` or the exact version.

### Added

- **feat(modules)**: ship P29 short contracts (`index.json` + `<id>/contract.md`) on `cstl init` / `cstl update`. CLI source (`catalog.ts`) is not copied into the user tree.
- **feat(context)**: compile a five-layer Session pack (`compile_session_pack.py`); SessionStart injects that pack via Event Bridge.
- **feat(kernel)**: persist `baseline_modules` and the P29 on-demand list; Dashboard projects Open / Define / Close names.
- **feat(retrieval)**: freeze three-layer retrieval ABI ownership (exact / semantic / structural / external stay Baseline intents).
- **feat(adapter)**: bind Cursor Plan / Ask / Debug / Agent / Multitask honestly; user slash stays Continue / Finish-work / Handoff.
- **feat(pool)**: delivery axis on pool items (`open` / `in-slice` / `landed` / `standing` / `deferred`). `accepted` is adjudication, not completion. `pool:Pxx` refs resolve through `pool_refs`. Missing `.cstl/pool/` does not block Close.
- **feat(middleware)**: register seven shipped providers; `.cstl/middleware/` overlay is never written or hashed by `cstl update`.

### Changed

- **fix(hooks)**: SessionStart does not dump `workflow.md` Phase Index / Task Ladder; Event Bridge does not emit `permission` on `sessionStart`.
- **fix(profile)**: inactive modules are dropped from the session pack and hooks.
- **fix(cli)**: joiner onboarding uses `/cstl-continue` and Kernel/Dashboard; it no longer says continue loads Phase Index.
- **fix(update)**: unchanged templates with no stored hash (canary-copied `.cstl/modules/`) are hashed on a no-op update so the next real template edit auto-updates.
- **fix(retrieval)**: query-only `build_retrieval_pack` still stamps `evidenceEnvelope` intents when collected-evidence is missing. Empty `{}` input stays envelope-free and is not AC Evidence.
- **chore(release)**: prerelease `pnpm publish` uses the `beta` / `rc` / `alpha` dist-tag from `computeNpmTag`. GitHub Release on `cstl-v*` no longer sets **Latest** for prerelease tags.

### Notes for consumers

- Install **`npm i -g @blxzer/cursor-trellis@0.5.0-beta.0`** or **`@blxzer/cursor-trellis@beta`**. `@latest` stays **0.4.3**.
- In the **project root** run `cstl update` (do not re-run `init`). New files include `.cstl/modules/` and `compile_session_pack.py`. Unmodified official hooks auto-update.
- Core and CLI versions stay paired: `@blxzer/cursor-trellis-core@0.5.0-beta.0`.
- Maintainers: tag **`cstl-v0.5.0-beta.0`**. Do not promote this prerelease to `main` / `@latest` until an explicit official release.

## [0.4.3] - 2026-08-29

Cursor-native 0.4.3. Lands **Stage 0–7** (Kernel writer, Lite / Full Quality, Topology, Adapter / Middleware) and **Wave C** (stop-read only after you confirm). GitHub user docs and `cstl update` match Native Cursor. Pushing a `cstl-v*` tag now opens a GitHub Release so Latest is not stuck on 0.3.4.

### Added

- **feat(kernel / Stage 0–7)**: Kernel is the task-state writer. Personal Lite Open→Close (no Parent/Git required). Full Quality: `required_controls`, AC evidence ledger, graded Independent Check. Topology (single vs parent-child) and On-demand modules. Event Bridge + independent Middleware Providers; project overlay `.cstl/middleware/` is never written by `cstl update`. Stage 7 contract: dry-run migrate, stop treating retired task fields as the only truth after confirm, thin default Native install.
- **feat(p36 / Wave C)**: `cstl update` prints a plain-language summary (what will stop-read, what stays dual-read, whether anything is degraded). Stop-read of the old task shape happens only after you confirm **Proceed**. `--force` / `--skip-all` / `--create-new` refresh official files but do **not** count as that confirm and do not write the stop-read flag.
- **feat(upgrade)**: Official-file and in-progress-artifact upgrade path (dual-read until confirm).
- **ci**: `.github/workflows/publish.yml` creates a GitHub Release on `cstl-v*` (needs `contents: write`). npm publish is unchanged: core first, then cli, via `publish-packages.js`.

### Changed

- **fix(update)**: Capability / readiness smoke failure no longer aborts `cstl update` before confirm. Unverified smoke is labeled; you can still Proceed, decline, or `--force`.
- **fix(init)**: Same principle — capability / readiness smoke failure no longer aborts `cstl init`. Unverified smoke is labeled; official files still write and the install can finish.
- **docs**: GitHub README and user `docs/` match Native Cursor (bootstrap always-on rule, `/cstl-handoff`, skill paths under `.cstl/framework/`). Cursor++ / Method 2.5 is not a product path.
- **chore(product)**: Default install has no `cstl-goal`, no Cursor++ live surface, no SDK / Campaign / RPC-FULL CORE. Parallel-first is a product principle (convention + review, not a new scheduler). Authoring Trellis skills still requires `cstl-skill-creator`.

### Notes for consumers

- Install `@blxzer/cursor-trellis@0.4.3` (cli and `@blxzer/cursor-trellis-core` stay the same version). In the **project root** run `cstl update` and confirm once. Do not re-run `init`. Do not move task directories by hand.
- Default product is **Native Cursor**. This package does not embed BYOK.
- Maintainers: tag **`cstl-v0.4.3`** (not `v0.4.3` — legacy `@blxzer/trellis` tags occupy `v*`). The publish workflow publishes npm **and** creates the GitHub Release. Do not republish 0.4.2.

## [0.4.2] - 2026-08-10

Cursor reachability index: Goal = CLI, internal skills reachable on-demand (commands-only preserved). Framework docs relocation: versioned framework/platform docs move to a **framework-owned, update-managed** `.cstl/framework/`; `.cstl/spec/` stays fully user-owned.

### Added

- **feat(agents)**: AGENTS.md CSTL block gains **Goal runtime (not a task type)** section (Goal = `cstl goal` CLI subsystem, not Parent/Child, no default `/cstl-goal`), **Invocation map (short)** table, and **Internal skill reachability** pointers — mirrored to `templates/markdown/agents.md` (mirror-check green).
- **feat(guides)**: `prd-grill-frontier.md` — on-demand PRD Grill + Frontier discipline for Cursor (SSOT stays the bundled `brainstorm` skill; single source, pointer only). Workflow routes planning / PRD Grill to `Read .cstl/framework/prd-grill-frontier.md` instead of `Load cstl-brainstorm` (executable path, not a bare skill name).
- **feat(guides)**: `internal-skills-cursor-reachability.md` — skill × load-channel reachability matrix for every internal name in the AGENTS command surface (commands-only baseline; check→agent, smart-search→`run_smart_search.py`, brainstorm→P11 guide; package-body-only items documented honestly).
- **feat(guides)**: `dogfood-only-surfaces.md` — Dogfood-only vs default install inventory (`goal_*.py`, `/cstl-goal` + goal agents, `.claude/skills`, `.cstl/local/*`, private pool narrative) with the "missing in consumer repo ≠ removed from framework" rule.
- **feat(workflow)**: `workflow.md` gains a **Goal runtime** short section next to the Task Ladder (Goal ≠ Task Ladder type / Parent-Child).
- **feat(framework)**: New **framework-owned** directory `.cstl/framework/` (flat, sibling of `workflow.md`) — written by `cstl init`, refreshed by `cstl update` with the same hash-conflict flow as `workflow.md`. Contains `index.md` + the 12 docs relocated from `spec/guides/` (PRD grill frontier, internal-skills reachability, dogfood-only surfaces, cursor-subagent-policy, retrieval-daily-guide, cursor-native-modes-guide, cursor-context-injection-guide, cursor-semantic-compliance, injection-budget-guide, execution-strategy, verification-strength-guide, artifact-locale-guide). Single source of truth: `frameworkDocs` in `templates/markdown/index.ts` (init + update consume the same array).
- **feat(spec)**: `spec/guides/` seeds reduced to the 7 thinking guides + `index.md` (init-only; **`cstl update` never touches `.cstl/spec/`** — `PROTECTED_PATHS` unchanged). Framework/platform pointers from `spec/guides/index.md` now lead to `.cstl/framework/index.md`.

### Changed

- **docs**: All shipped references to the 12 relocated docs rewritten from `.cstl/spec/guides/<name>.md` to `.cstl/framework/<name>.md` (workflow.md, config.yaml, AGENTS.md block, cursor agents/rules/commands, common skills/commands, bundled skills, hooks, scripts, telemetry, CLI README).
- **docs**: Maintainer-only runbooks (`goal-release-regression-runbook.md`, `cursor-trellis-release-coexistence-guide.md`) stop shipping as templates — they live in the repo `docs/` and are removed from the `spec/guides/index.md` seed.
- **chore(release)**: No version bump (TBD section; publish pending main-session decision).

### Notes for consumers

- Existing projects keep their old copies under `.cstl/spec/guides/` after `cstl update` (`.cstl/spec/` is protected — by design, not a bug). Manual cleanup of stale guide copies is **optional**.
- New/upgraded projects get the relocated docs under `.cstl/framework/` (framework-owned — update will prompt before overwriting local edits, same as `workflow.md`).

## [0.4.1] - 2026-08-10

Approved-surface backfill (session handoff, check dual-axis, grilling frontier, PRD grain, CONTEXT/ADR stub).

### Added

- **feat(skills)**: Ship `cstl-handoff` bundled skill (portable session handoff to OS temp dir; `disable-model-invocation: true`) + Cursor slash command `/cstl-handoff`.
- **feat(workflow)**: Session boundary line (Continue → clear → handoff → subagent → compact) and the task-`handoff.md` ≠ session-handoff boundary.
- **feat(skills)**: `cstl-check` dual-axis — Standards / Spec reported in separate sections (no merged risk ranking), Full+ parallel read-only review sub-agents, Fowler 12 Smells asset, false-positive calibration, Terminology/ADR consistency line. Migrated from single-file `skills/check.md` to `bundled-skills/cstl-check/`.
- **feat(skills)**: Grilling frontier — `cstl-brainstorm` Frontier rounds (≤3 questions/round, facts = agent's job, decisions = user's job, empty frontier = tree exhausted) and `cstl-micro-grill` optional frontier batching.
- **feat(templates)**: PRD grain — `default-prd.md` (en/zh) gain User Stories / 用户故事 + Implementation Decisions / 实现决策 (no file paths) sections; workflow vertical-slice grain already aligned (zero diff).
- **feat(templates)**: Minimal root `CONTEXT.md` stub (on-demand read, never always-inject; optional framework-domain seed) + `docs/adr/README.md` (lazy-created; three-condition ADR rule; spec/ADR/knowledge-base boundary).

### Changed

- **chore(release)**: Migration manifest placeholder `0.4.1.json` (`migrations: []`).

## [0.4.0] - 2026-08-09

Minor release: dogfood backfill of **review pool** + **task depends_on Plan A/B** into shipped templates.

### Added

- **feat(pool)**: Review-pool skeleton under `.cstl/pool/` (README + empty `plan.md` + `items/`) and `pool.py` CLI (`validate` / `plan-check` / `link` / `unlink` / `show`, `--root`).
- **feat(deps)**: Task-level `depends_on` Plan A (warn) / Plan B (`depends_mode: block`) — `task.py set-deps`, `set-depends-mode`, `start-execution --ignore-deps`; dashboard dependency summary; `common/task_dependencies.py` + `pool_store.py`.
- **feat(verify)**: Ship `verify_evidence_probe.py` referenced by verification-strength / workflow guidance.
- **docs(spec)**: Guides — `artifact-locale-guide`, `debug-loop-guide`, `prototype-guide`, `test-discipline-guide`, `goal-release-regression-runbook` (0.3.6 changelog commitment), plus refreshed retrieval/verification/subagent/cross-platform index entries.

### Changed

- **workflow**: Review-pool boundary, next-item + fog hygiene, Task dependencies Plan A/B; Parent/child ordering is explicit `depends_on` (not “structure is not a dependency system” as sole doctrine).
- **docs**: README / task-system / workflow docs describe pool + depends for 0.4.0.
- **chore(release)**: Migration manifest placeholder `0.4.0.json` (`migrations: []`).

### Notes for consumers

- Run `cstl update` after install to receive scripts, pool skeleton, and workflow.
- `start-execution --check` still **never FAILs solely for unmet dependencies** (WARN only; block mode applies on `--approved` / `set-child-state working`).
- Pool ships **mechanism only** — no sample user items. RE reverse-engineering report remains out of default init pack.

## [0.3.6] - 2026-08-07

Root npm batch after channel/Goal hardening + next-wave orch/observable/resume Parents (`private/main` tip through `c5825fdd` + this release).

### Added

- **feat(goal)**: `cstl goal` MVP runtime — contract lifecycle, deterministic reviewer, walls, mock worker; real **SDK worker** adapter beside mock.
- **feat(locale)**: Switchable **zh/en** human-reviewed artifact locale (`artifact_locale`, `task.py artifact-locale`, SessionStart summary line, locale PRD/verify seeds).
- **feat(orchestration)**: After `integrate-child` → `integrated`, **default auto `publish-pack`** with `--no-publish-pack` escape; nested slash child-id resolution in task-map / prompts.
- **feat(observable)**: Default verify.md section headers; dashboard `[verify: …]` six-signal summary; real `.cstl/spec/` jsonl seeds (≥2 rows, no isolated `_example`).
- **feat(continue)**: `search_memory` step between `get_context` and phase index (O1 session memory).
- **feat(spec-health)**: S1 outcomes CLI for archive `verify.md` (`spec_health_outcomes.py`).
- **feat(context)**: Opt-in journal snippet in `get_context` (**default off**).
- **feat(injection)**: Matrix-aligned injection-budget guide + caps; Layer-2 dispatch / probe tooling.
- **feat(verify)**: Graded verification-strength guide (**non-TDD**).
- **feat(retrieval / modes)**: Prefer native Grep+Read definition jumps on Cursor Agent; Prefer native modes guide + `cstl-cursor-modes` rule; channel injection matrix synced to rules/guides.
- **docs(goal)**: `.cstl/spec/guides/goal-release-regression-runbook.md` — npm-gate mock/live checklist (no Goal semantic expansion).

### Changed

- **chore(brainstorm)**: PRD Grill row 9 links durable-learning guide.
- **fix(dispatch)**: Ship Layer-2 CLI script + research PRD context for subagent dispatch.

### Notes for consumers

- Run `cstl update` (or copy `shared-hooks/session-start.py`) so live SessionStart includes the **Artifact locale** line.
- Goal mid-run cancel / true overnight SLA remain **out of scope** for this release.
- BYOK channel short probe still deferred; Native-first matrix exceptions remain documented.

## [0.3.5] - 2026-08-05

### Added

- **feat(sdk)**: `cstl sdk run` injects an explicit `--task` binding into the agent prompt (BOUND contract).
- **feat(campaign)**: Campaign Canvas open-path guard — default write under `~/.cursor/projects/<slug>/canvases/`; auto-open via Cursor CLI after write; `--quiet` / `--no-open`; env overrides `TRELLIS_CAMPAIGN_CANVAS_DIR` / `CURSOR_CANVAS_DIR` / `TRELLIS_CURSOR_PROJECT_SLUG` / `CURSOR_BIN` / `TRELLIS_CAMPAIGN_CANVAS_OPEN`.
- **feat(cli)**: Adapt to **@blxzer/smart-search ^0.2.0**; External-knowledge gate in bundled agents/skills and retrieval docs (search when the world/API moved; skip when truth is in-repo).

### Fixed

- **fix(campaign)**: Campaign MCP stdio speaks **NDJSON** (Cursor / MCP SDK host), not LSP Content-Length framing.
- **fix(cli)**: Do not create an empty `.cursor/mcp.json` on Cursor init when no MCP capabilities are selected (uninstall / clean-project gate).

### Changed

- **docs(campaign)**: `docs/campaign-ui.md` — portable canvases path, open-by-default, `--out` anti-pattern (source-only outside canvases).

## [0.3.4] - 2026-07-04

### Added

- **feat(cursor)**: auto-rename the **main** Agent chat tab to the cstl task **directory name** after `task.py select` or `task.py start-execution --approved` (`rename-session-for-task.py` `afterShellExecution` hook + `cstl-session-rename.mdc` rule). Uses `cursor-app-control` `rename_chat` when available; skips silently when MCP is missing. Does not rename on `task.py create`. Native and BYOK share the same path.

## [0.3.3] - 2026-07-04

Follow-up polish after 0.3.2 coexistence release: closes known limitations from the runtime-isolation task.

### Added

- **feat(uninstall)**: `cstl uninstall` strips the `<!-- CSTL:START -->` managed block from `AGENTS.md` while preserving an upstream `<!-- TRELLIS:START -->` block and user content (`removeCstlManagedBlock`).
- **feat(hash)**: `.template-hashes.json` tracks **CSTL block hash only** for `AGENTS.md` — upstream TRELLIS block or out-of-block user edits no longer false-positive as "modified" on `cstl update` in coexistence repos.
- **docs(spec)**: `.cstl/spec/guides/cursor-trellis-release-coexistence-guide.md` — npm publish runbook (`publish-packages.js`), `cstl-v*` tag convention, coexistence scenario matrix.
- **ci**: `.github/workflows/publish.yml` — publish on `cstl-v*` tag push (requires `NPM_TOKEN` secret).

### Changed

- **docs(maintainers)**: release index points at the spec guide + `cstl-v*` / CI publish notes.

## [0.3.2] - 2026-07-04

> **0.3.1 was withdrawn** shortly after publish: the initial `npm publish` did not rewrite the `workspace:*` dependency on `@blxzer/cursor-trellis-core` (and core@0.3.1 was not published alongside), so 0.3.1 was uninstallable (`EUNSUPPORTEDPROTOCOL`). 0.3.2 reissues the same content via the proper `pnpm publish` orchestration (`publish-packages.js` publishes core first, then cli, rewriting `workspace:*` to the resolved version).

**Breaking (coexistence)**: cursor-trellis runtime directory moves from `.trellis/` to **`.cstl/`** so upstream [mindfold-ai/Trellis](https://github.com/mindfold-ai/Trellis) can keep `.trellis/` in the same repository while Cursor uses `cstl`.

### Breaking

- **feat(runtime)**: project runtime root `.trellis/` → **`.cstl/`** (`rename-dir` via `cstl update --migrate`; history preserved).
- **feat(agents)**: AGENTS.md managed block uses `<!-- CSTL:START -->` / `<!-- CSTL:END -->` (legacy `TRELLIS:START` upgraded on migrate).
- **chore(channel)**: `cstl channel` multi-agent CLI is **not registered** (Cursor-only product; upstream channel runtime out of scope).
- **chore(config)**: removed default `channel.worker_guard` from `config.yaml` template.

### Added

- **feat(init) coexistence mode**: when `cstl init` detects an upstream `.trellis/` (and no `.cstl/`), it creates `.cstl/` alongside, **takes over `.cursor/`** (force-writes cstl hooks/rules/commands even under `-y`), leaves `.trellis/` and other upstream platform dirs untouched, and adds a `<!-- CSTL:START -->` block to AGENTS.md **alongside** an existing `<!-- TRELLIS:START -->` block (dual-block). Prints a guidance banner warning not to run `cstl update --migrate` in coexistence repos.
- **feat(update) conservative migrate gate**: `cstl update --migrate` refuses the `.trellis/` → `.cstl/` rename unless a positive cursor-trellis fingerprint is present (`cstl-*` command, `cstl-triage.mdc`, or cstl-flavored `cli_adapter.py`). Mixed cursor-trellis + upstream Trellis layouts abort for manual split. New **`--force-cstl-migrate`** escape hatch overrides upstream-signal aborts (still gated on `.trellis/` existing and `.cstl/` absent).

### Migration

```bash
npm install -g @blxzer/cursor-trellis@0.3.1
cd /path/to/project
cstl update --migrate
```

## [0.3.1] — withdrawn (2026-07-04)

Withdrawn due to an npm publish defect (unresolvable `workspace:*` dep on `@blxzer/cursor-trellis-core` + missing core@0.3.1). Reissued as **0.3.2** with identical content. See [0.3.2] above.

## [0.3.0] - 2026-07-02

**Breaking**: rename CLI command from `trellis`/`tl` to `cstl`. The `trellis` and `tl` bin aliases are **removed**. All skill, command, agent, and rule name prefixes renamed `trellis-*` → `cstl-*` (hard cut, no compatibility aliases).

### Breaking

- **feat(cli)**: rename CLI command from `trellis`/`tl` to `cstl`. Update any aliases, CI scripts, or shell history that reference `trellis` or `tl`.
- **feat(templates)**: all skill, command, agent, and rule names renamed `trellis-*` → `cstl-*` (hard cut, no compatibility aliases):
  - `.cursor/commands/trellis-continue.md` → `cstl-continue.md`
  - `.cursor/commands/trellis-finish-work.md` → `cstl-finish-work.md`
  - `.cursor/commands/trellis-cursor2plus-setup.md` → `cstl-cursor2plus-setup.md`
  - `.cursor/rules/trellis-triage.mdc` → `cstl-triage.mdc`
  - `.cursor/rules/trellis-subagent-dispatch.mdc` → `cstl-subagent-dispatch.mdc`
  - `.cursor/agents/trellis-research.md` → `cstl-research.md`
  - `.cursor/agents/trellis-implement.md` → `cstl-implement.md`
  - `.cursor/agents/trellis-check.md` → `cstl-check.md`
  - `.cursor/skills/trellis-meta/` → `cstl-meta/` (and 4 other bundled skill dirs)
- **fix(hooks)**: `<!-- trellis-hook-injected -->` marker → `<!-- cstl-hook-injected -->`
- **fix(subagents)**: `subagent_type` identifiers `trellis-research/implement/check` → `cstl-research/implement/check` (affects Cursor++ BYOK `trellis-task-models.json5` keys)

### Added

- **feat(cli)**: `cstl capability-smoke` (`--json`, `--write-status`) probes selected project capabilities and can persist `ready` / `failed` in `.trellis/capabilities.json` without losing status on later template refreshes.
- Migration manifest `src/migrations/manifests/0.3.0.json` (13 rename entries for `trellis-*` → `cstl-*` under `.cursor/`).

### Changed

- `AUTO_PLANNING_REVIEWER` identifier `"trellis-cli"` → `"cstl-cli"`
- `<!-- trellis-research-end-pack -->` marker → `<!-- cstl-research-end-pack -->`
- `CURSOR_SKILL_RESIDUE_DIRS` in `update.ts` now checks both `cstl-*` (current) and `trellis-*` (legacy) skill directories for residue detection
- **feat(init/capabilities)**: selected capabilities default to `pending` in `capabilities.json` (schema v3); bootstrap/join PRDs prompt capability verification.
- **docs(spec)**: mirror Native OC-06/OC-15 live evidence into spec templates (`cursor-subagent-policy`, `cursor-semantic-compliance`).
- **docs(migration)**: README / CHANGELOG closed-loop for `npm install -g` + `cstl update --migrate`; remove stale `tl` bin alias from user docs.
- **docs(cursor)**: Native + BYOK **coexistence** (per-repo `--cursor2plus`, not either/or); Method 2.5 ops — run `--check-compat` after Cursor/Cursor++ upgrades (`cstl update` prints BYOK reminder when `cursor2plus/` exists).
- **fix(tasks)**: Parent `record-gate` / archive share the same `implement.md` contract fingerprint (fixes `stale contract fingerprint` on `parent-integrated`).

### Migration

**Manual npm install required** — the old `trellis upgrade` command no longer exists after install.

```bash
npm install -g @blxzer/cursor-trellis@latest
cstl update --migrate
```

The `--migrate` flag is REQUIRED to trigger the file renames in your project (`trellis-*` → `cstl-*`). Renames are hash-verified; locally modified files are preserved with a warning.

New migration manifest `src/migrations/manifests/0.3.0.json` ships 13 rename entries (3 commands, 2 rules, 3 agents, 5 skill directories). See **Added** above.

If you use Cursor++ BYOK (`.trellis/local/cursor2plus/`), the `trellis-task-models.json5` keys must be updated from `trellis-research/implement/check` to `cstl-research/implement/check`. Run the `cstl-cursor2plus-setup` skill or edit `~/.ccursor/trellis-task-models.json5` manually then re-run `patch_wpelc8.py --apply`.

The `.trellis/` directory name is UNCHANGED — only the CLI command and skill/command/agent/rule name prefixes changed.

### Notes

- npm package name `@blxzer/cursor-trellis` is unchanged.
- `trellis-task-models.json5` filename is unchanged (user data file).
- `trellis_task_models_config.py` module name is unchanged.
- `<!-- TRELLIS:START -->` / `<!-- TRELLIS:END -->` managed block markers are unchanged.

[0.3.0]: https://github.com/blxzer77/cursor-trellis/releases/tag/v0.3.0

## [0.2.9] - 2026-06-26

Adapt `@blxzer/cursor-trellis` to **@blxzer/smart-search 0.1.15** (research locale scope, dry-run/progress, structured citations, provider TTL cache). Cursor **commands-only** policy unchanged — internal `smart-search-cli` is not exposed under `.cursor/skills/`.

### Added

- `run_smart_search.py` passthrough for `--locale-scope`, `--dry-run`, and `--progress` on `--intent deep-research`
- Trellis evidence manifests preserve `outputSchemaVersion`, structured citation fields (`id`, `source_type`, `verified`, `content_len`), and `dryRun` when applicable

### Changed

- Dependency `@blxzer/smart-search` bumped to `^0.1.15`
- Bundled `smart-search-cli` skill synced from smart-search v0.1.15 (installed to `.agents/skills/` on Codex/Gemini; **not** `.cursor/skills/` on Cursor)
- `retrieval-daily-guide.md` documents smart-search 0.1.15 research flags and Cursor skill-surface policy

### Upgrade

```bash
npm install -g @blxzer/cursor-trellis@0.2.9
# In each project:
trellis update
```

[0.2.9]: https://github.com/blxzer77/cursor-trellis/releases/tag/v0.2.9

## [0.2.8] - 2026-06-26

Cursor platform adaptation Phase 0 + Phase 1+2 stabilization. Six feature commits landed since 0.2.7, all back-ported to public docs in this release.

### Added

- `trellis validate-rules` hard gate + `pnpm mirror-check` — enforce dogfood/template sync for `.cursor/rules/` and agents; `init`/`update` throw on regression via `assertCursorRulesValid()` (OC-02)
- Agent template standard sections **Entry points** + **Context source** — declare CLI Layer 2 dispatch as the primary and guaranteed context channel; `sessionStart.additional_context` / `preToolUse` hooks are best-effort only (Cursor #158452) (OC-01, OC-07)
- Cursor++ Method 2.5 safety gate — `patch_wpelc8.py` requires explicit `--approve`; `--check-compat` pre-flight; `smoke.py` health check (no secrets); `trellis init --cursor` prints a Native safe-to-ignore hint for the Cursor++ appendix (OC-05, OC-08, OC-13)
- Retrieval BYOK/Native compliance — `unknown` cursorEnv routes conservatively to BYOK + warning (no silent native); LSP overpromises softened to codegraph + Read; telemetry splits **planned** vs **executed** semantic backend (OC-03, OC-04, OC-10)
- Task path fallback — `task.py select` failure now prints a tip pointing to `generate_dispatch_prompt.py --task <path>` as the select-free dispatch path; dispatch prompt docstring marks `--task` as the primary fallback (OC-09)
- Evidence pack integration — `/trellis-finish-work` and `trellis-check` skill cite `retrieval-pack-latest.json` when present; `trellis-research` prompts include provider relevance caveats and query-refinement guidance (OC-12, OC-14)
- Automations spike decision — Cursor Automations assessed as `conditional-go`, non-defaulting; rationale recorded in `cursor-subagent-policy.md` (OC-11)

### Changed

- Agent templates (`trellis-research` / `trellis-implement` / `trellis-check`) now open with Entry points / Context source sections
- Retrieval router + agent-instruction builder: LSP / `GO_TO_DEFINITION` references replaced with codegraph + Read + caveat
- `patch_wpelc8.py` bare invocation (no subcommand) no longer implicitly writes; prints planned map and exits
- Docs synced (English + zh-CN pairs): `cursor.md`, `subagents.md`, `retrieval.md`, `task-system.md`, `README.md`

### Upgrade

```bash
npm install -g @blxzer/cursor-trellis@0.2.8
# In each project:
trellis update
```

**Behavior changes:**

- `trellis init` / `trellis update` now run `assertCursorRulesValid()` — a regression in the rules manifest aborts the operation. Run `trellis validate-rules` to re-check after hand-editing `.cursor/rules/`.
- Cursor++ operators: `python patch_wpelc8.py` without `--approve` no longer patches. Add `--approve` to apply.
- Retrieval: when `cursorEnv` is `unknown`, the router now warns and routes to BYOK behavior instead of silently using native `@codebase`.

[0.2.8]: https://github.com/blxzer77/cursor-trellis/releases/tag/v0.2.8

## [0.2.7] - 2026-06-25

Aligned **@blxzer/cursor-trellis** and **@blxzer/cursor-trellis-core** at `0.2.7`.

### Added

- `task.py suggest-execution-strategy` — deterministic `execution_mode` / `isolation` suggestions from `.trellis/config/execution-strategy-rules.json`
- `common/execution_strategy.py`, drift **WARN** on `start-execution --check` when contract differs from suggestion (advisory only)
- Spec guide `execution-strategy.md`; `brainstorm.md` step before freezing Development Strategy Contract
- Vitest: `execution-strategy.integration.test.ts`
- Backfilled migration manifests `0.2.2`–`0.2.6` for npm / `trellis update` continuity

### Changed

- `workflow.md` Phase 2.1 / 2.2 and `[workflow-state:in_progress]`: dispatch `trellis-implement` / `trellis-check` only when contract `execution_mode: worker` (not unconditional spawn)
- `trellis init` / `trellis update` ship `execution-strategy-rules.json` and `execution_strategy.py`
- `docs/task-system.md` (+ zh-CN): planning suggest + drift WARN

### Upgrade

```bash
npm install -g @blxzer/cursor-trellis@0.2.7
# In each project:
trellis update
```

**Behavior change:** Full tasks that touch code are **suggested** as `worker` + `main-worktree`; approved `implement.md` contract still authoritative. Run `task.py suggest-execution-strategy <task>` during planning.

[0.2.7]: https://github.com/blxzer77/cursor-trellis/releases/tag/v0.2.7

## [0.1.4] - 2026-06-24

Aligned **@blxzer/cursor-trellis** and **@blxzer/cursor-trellis-core** at `0.1.4` (fixes core/cli version drift since the in-repo `0.1.3` bump).

### Added

- Gate verify transition contract: stricter Parent archive, Full Child accept, `record-gate` placeholder rejection, integrate-through guards (7 CLI integration tests).
- `cursor-context-injection-guide.md` included in default `trellis init` spec guides.

### Changed

- `trellis init` writes `.trellis/scripts/` from `getAllScripts()` only (same source as `trellis update`) — maintainer probe/eval scripts no longer copied into user projects.
- User-facing spec guides and `workflow.md` cleaned of Trellis maintainer / harness paths; default workflow no longer documents npm release execution.
- Removed shipped `aggregate_retrieval_telemetry.py` and `batch_plan_envelope.py` (maintainer eval tooling).

### Upgrade

```bash
npm install -g @blxzer/cursor-trellis@0.1.4
# In each project:
trellis update
```

**Behavior change:** archive and gate checks may fail where placeholder evidence or incomplete Parent/Child handoff previously passed. Review `verify.md` and run `task.py archive <task> --check` after upgrade.

[0.1.4]: https://github.com/blxzer77/cursor-trellis/releases/tag/v0.1.4

## [0.1.3] - 2026-06-23

In-repo bump only (never published as an aligned core/cli pair). Included here for continuity.

### Added

- Cursor BYOK/native semantic routing, Experiment D retrieval probes, adapter metadata.
- Hook health fixes for Native Cursor and Cursor++ BYOK paths.

### Changed

- Smart-search wrapper status detection and timeout handling; clearer npm CLI resolver paths.

## [0.1.2] - 2026-06-22

### Added

- `task.py generate-dispatch-prompt` (Layer 2 subagent context assembly before `Task(...)`).
- Shared `common/subagent_dispatch.py` builder; slim `preToolUse` hook wrapper.

[0.1.2]: https://github.com/blxzer77/cursor-trellis/releases/tag/v0.1.2

## [0.1.1] - 2026-06-21

### Changed

- Cursor-only product trim: platform registry, init/update/uninstall, and retrieval router reduced to Cursor.
- Workflow, AGENTS, README, and guides aligned to Cursor-only surface.

[0.1.1]: https://github.com/blxzer77/cursor-trellis/releases/tag/v0.1.1

## [0.1.0] - 2026-06-20

First public release under `@blxzer/cursor-trellis` / `@blxzer/cursor-trellis-core`.

### Added

- Public GitHub repo: [blxzer77/cursor-trellis](https://github.com/blxzer77/cursor-trellis).
- Router v2 codebase retrieval (platform-adaptive routing, codegraph structural-first, token economy).
- Cursor `.cursor/rules/trellis-triage.mdc` (Request Triage hard gate via rules channel).
- Cursor commands-only default policy + `trellis-cursor2plus-setup` command.
- `release:publish` script (publishes core then cli in dependency order).
- Fresh migration manifest line starting at `0.1.0` (legacy `@blxzer/trellis` manifests archived in-repo).

### Changed

- Package rename from `@blxzer/trellis` → `@blxzer/cursor-trellis` (and matching `-core` SDK).
- `trellis update` non-interactive contexts fail fast instead of hanging on prompts.

### Install

```bash
npm install -g @blxzer/cursor-trellis
```

### Migrating from `@blxzer/trellis`

```bash
npm uninstall -g @blxzer/trellis
npm install -g @blxzer/cursor-trellis
# In each project:
trellis update
```

[0.1.0]: https://github.com/blxzer77/cursor-trellis/releases/tag/v0.1.0
