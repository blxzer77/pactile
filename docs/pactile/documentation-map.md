# Pactile documentation information architecture

Status: Batch 0 source-to-target map. No existing page is moved or rewritten by this batch.

The machine-readable source of truth is [`documentation-map.json`](./documentation-map.json). This page explains how later documentation lanes should consume it. Discovery excludes only this narrative and `brand-contract.md`; other tracked Markdown under `docs/pactile/`—including `contracts-v1.md` when it lands—must receive an explicit source mapping.

## Organizing principle

The documentation follows a user journey, not the source tree:

1. Understand Pactile and complete a five-minute start.
2. Choose Cursor, Codex, or both.
3. Discover and bind Skills, MCP servers, retrieval, and Middleware Providers.
4. Operate the workflow and its evidence-backed lifecycle.
5. Upgrade, detach, uninstall, roll back, or purge without losing user-owned state.
6. Troubleshoot, contribute, audit security, and release.

## Target tree

```text
README.md
README.zh-CN.md
docs/
  concepts/
    index.md
    architecture.md
    tiles.md
    kernel-evidence-trace.md
    projection-and-ownership.md
    spec-system.md
    task-system.md
  hosts/
    index.md
    cursor.md
    cursor-limitations.md
    codex.md
    coexistence.md
  capabilities/
    index.md
    skills.md
    mcp.md
    native-adoption.md
    retrieval.md
    providers.md
    privacy-and-permissions.md
    subagents.md
  lifecycle/
    index.md
    install.md
    workflow.md
    upgrade-and-migrate.md
    detach-and-uninstall.md
    rollback-and-purge.md
  troubleshooting/
    index.md
    doctor.md
    recovery.md
    known-limitations.md
  governance/
    index.md
    contributing.md
    security.md
    compatibility.md
    releasing.md
  history/
    index.md
    cursor-plus-plus.md
    campaign-ui.md
    community/
    research/
```

Except where the JSON map explicitly declares an original-language historical snapshot, each `.md` page above has a peer `.zh-CN.md`. English and Chinese share the same page id, navigation position, conceptual outline, command tables, warnings, and link destinations. Wording is localized; sentence-by-sentence mirroring is not required.

## Four documentation lanes

| Owner lane | Write set | Responsibility |
| --- | --- | --- |
| `batch-4-docs-entry-concepts` | Root/package/example entry pages and `docs/concepts/**` | Value, five-minute start, Tiles, Kernel, Evidence, Trace, Projection, Ownership, spec/task concepts. |
| `batch-4-docs-hosts-capabilities` | `docs/hosts/**` and `docs/capabilities/**` | Cursor/Codex/coexistence, Skills, MCP, install→adopt→bind, retrieval, Providers, privacy, subagents. |
| `batch-4-docs-lifecycle-support` | `docs/lifecycle/**` and `docs/troubleshooting/**` | Install, workflow, upgrades, user reconsideration, detach/uninstall, rollback/purge, doctor and recovery. |
| `batch-4-docs-governance-history` | `docs/governance/**`, `docs/history/**`, community and GitHub prose templates | Contribution, security, compatibility, release, immutable history, redirects and link integrity. |

`batch-3-brand-runtime` owns machine surfaces such as `AGENTS.md`, package/bin/runtime identifiers, and GitHub workflow commands. Documentation lanes must consume those frozen names rather than inventing replacements.

## Mapping actions

- `rewrite` — keep the source path and replace its current live narrative with the target Pactile narrative.
- `redirect` — publish the full replacement under the target IA and leave the old URL as a concise compatibility pointer during 0.5.x.
- `merge` — consolidate the source into the named target page; the source then becomes a pointer or is archived according to the governance lane.
- `archive` — preserve historical facts and original language; add navigation context, but do not rewrite history as current Pactile behavior.

Every discovered source has exactly one primary action. Section-level historical material may additionally route to a single history page, but that does not create a second primary action.

## Current source map

| Existing source | Class | Action | Target page | Owner |
| --- | --- | --- | --- | --- |
| `.github/workflows/ci.yml` | live | rewrite | `github.ci` | Batch 3 runtime |
| `.github/workflows/publish.yml` | live | rewrite | `github.publish` | Batch 3 runtime |
| `AGENTS.md` | live | rewrite | `repo.agents` | Batch 3 runtime |
| `README.md` / `README.zh-CN.md` | live | rewrite | `entry.repo` | Entry/concepts |
| `packages/cli/README.md` / `README.zh-CN.md` | live | rewrite | `entry.cli-package` | Entry/concepts |
| `examples/minimal-agent-app/README.md` | live | rewrite | `entry.example-minimal` | Entry/concepts |
| `docs/architecture*.md` | live | redirect | `concepts.architecture` | Entry/concepts |
| `docs/spec-system*.md` | live | redirect | `concepts.spec-system` | Entry/concepts |
| `docs/task-system*.md` | live | redirect | `concepts.task-system` | Entry/concepts |
| `docs/cursor.md` / `docs/cursor.zh-CN.md` | live | redirect | `hosts.cursor` | Hosts/capabilities |
| `docs/cursor-platform-limitations-and-trellis-adaptation*.md` | compat | redirect | `hosts.cursor-limitations` | Hosts/capabilities |
| `docs/pactile/compatibility-inputs*.md` | compat | merge | `governance.compatibility` | Batch 3 runtime |
| `docs/retrieval*.md` | live | redirect | `capabilities.retrieval` | Hosts/capabilities |
| `docs/skills*.md` | live | redirect | `capabilities.skills` | Hosts/capabilities |
| `docs/subagents*.md` | live | redirect | `capabilities.subagents` | Hosts/capabilities |
| `docs/agent-tooling-narrative.zh-CN.md` | live | merge | `capabilities.native-adoption` | Hosts/capabilities |
| `docs/workflow*.md` | live | redirect | `lifecycle.workflow` | Lifecycle/support |
| `docs/cursor-trellis-release-coexistence-guide.md` | compat | redirect | `governance.releasing` | Governance/history |
| `packages/cli/CHANGELOG.md` | history | archive | `history.release-changelog` | Governance/history |
| `docs/campaign-ui.md` | history | archive | `history.campaign-ui` | Governance/history |
| `docs/community/linux-do-release.md` | history | archive | `history.community-linux-do` | Governance/history |
| `PERSONAL_SKILLS_TRELLIS_INTEGRATION_RESEARCH.md` | history | archive | `history.research-personal-skills` | Governance/history |

The grouped rows above are presentation shorthand only. The JSON inventory contains one explicit record per source path and is what the checker validates.

The three old-brand URL leaves are finite 0.5.x compatibility pointers; their
maintained destinations remain live. The English and Chinese compatibility
input references name exact legacy roots, the import option, and bridges with
retirement conditions. They remain included in discovery and inventory.
`contracts-v1.md` stays live and links to those exact compatibility facts.

## Cursor++ documentation tail

P23 already owns runtime residue cleanup. This batch does not reimplement that cleanup.

Every **live** mapped source that still mentions Cursor++, `cursor2plus`, `ccursor`, or its retired model files has one section route to the page id `history.cursor-plus-plus`. Later lanes must remove the operational instructions from live prose and link to that history page when historical context is useful. The frozen changelog and archived community post remain history and are not rewritten.

The checker derives the current live-source set from tracked bytes and compares it with `p23CursorPlusPlus.routes`; adding a new live Cursor++ mention without an explicit route fails the inventory gate.

## Native install → adopt → bind narrative

The capabilities lane owns one shared explanation, `capabilities.native-adoption`, and links to it from both host pages:

1. Detect the native resource and its current owner.
2. If an external/native dependency is absent, emit an `install-hint`; the user or host installs it, and Pactile later adopts it as borrowed.
3. `install` only a Pactile-composed/generated projection and record its managed ownership.
4. `adopt` a compatible pre-existing resource as borrowed state without rewriting it.
5. `bind` a Pactile capability to the installed or adopted resource through a projection plan.
6. Surface conflicts, malformed configuration, host trust, and locked files as host-local degraded states.
7. On detach, remove the binding and claimant; preserve borrowed and still-shared resources.

Skills and MCP pages apply the same model. External services are Providers resolved through project Middleware configuration, not special cases embedded in Cursor or Codex instructions. Retrieval guidance states the minimum host assurance and carries Provider origin/readiness instead of promising symmetric host behavior.

## Required new surfaces

Batch 4 has materialized the required 0.5.0 pages and GitHub community surfaces. The JSON map remains the machine-readable inventory and records the owner lane for each source:

- Codex host guide and Cursor+Codex coexistence guide.
- MCP, Provider, privacy/permissions, and native adoption guides.
- Upgrade/migrate, detach/uninstall, rollback/purge, capability-smoke diagnostics, recovery, and known-limitations guides.
- Contribution, security, compatibility, and release governance.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`.
- GitHub issue forms and pull-request template with bilingual routing.

## Redirect and link policy

- Keep legacy public documentation URLs as pointer pages for the 0.5.x compatibility window.
- A pointer names Pactile, states why the page moved, links to both locale targets, and contains no obsolete operational procedure.
- Target pages use relative repository links. Every logical target page id must resolve before a source redirect is shipped.
- Historical snapshots may retain dead historical outbound links, but their archive header must identify them as unverified history.
- The final documentation lane runs relative-link checks and command smoke after target files exist.

## Command smoke

The following commands are the documented CLI smoke contract and use the current Commander interface:

```powershell
pactile --version
pactile init --cursor
pactile init --codex
pactile capability-smoke --json
pactile update
pactile detach cursor
pactile detach codex
pactile uninstall
```

Smoke must run on Windows and POSIX from a clean project, an upgraded legacy project, and a project with both host Adapters. `capability-smoke --json` is the supported Pactile diagnostic; there is no separate `pactile doctor` command.

## Batch 0 checks

Run from the repository root:

```powershell
node packages/cli/scripts/check-pactile-brand-surface.js
pnpm --filter @blxzer/cursor-trellis exec vitest run test/docs/pactile-brand-surface.test.ts
```

Stable release conformance additionally runs the same checker with `--release`, after Batch 3 and all documentation lanes have removed live legacy-name debt.
