# Pactile documentation information architecture

Status: Historical source-to-target map for the 0.5 documentation migration. Its actions record the completed migration plan, not current host support. The Cursor adapter ended with the 0.5.x line; consult [current host support](../hosts/index.md).

The machine-readable source of truth is [`documentation-map.json`](./documentation-map.json). This page explains how later documentation lanes should consume it. Discovery excludes only this narrative and `brand-contract.md`; other tracked Markdown under `docs/pactile/`—including `contracts-v1.md` when it lands—must receive an explicit source mapping.

## Organizing principle

The documentation follows a user journey, not the source tree:

1. Understand Pactile and complete a five-minute start.
2. Use the supported host integration.
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
    codex.md
  capabilities/
    index.md
    skills.md
    mcp.md
    native-adoption.md
    retrieval.md
    providers.md
    privacy-and-permissions.md
    subagents.md
    structured-task-artifacts.zh-CN.md
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
| `batch-4-docs-hosts-capabilities` | `docs/hosts/**` and `docs/capabilities/**` | Codex and shared capability support, Skills, MCP, install→adopt→bind, retrieval, Providers, privacy, subagents, structured task artifacts. |
| `batch-4-docs-lifecycle-support` | `docs/lifecycle/**` and `docs/troubleshooting/**` | Install, workflow, upgrades, user reconsideration, detach/uninstall, rollback/purge, doctor and recovery. |
| `batch-4-docs-governance-history` | `docs/governance/**`, `docs/history/**`, community and GitHub prose templates | Contribution, security, compatibility, release, immutable history, redirects and link integrity. |

`batch-3-brand-runtime` owns machine surfaces such as `AGENTS.md`, package/bin/runtime identifiers, and GitHub workflow commands. Documentation lanes must consume those frozen names rather than inventing replacements.

## Mapping actions

- `rewrite` — keep the source path and replace its current live narrative with the target Pactile narrative.
- `redirect` — publish the full replacement under the target IA and leave any retained old URL as a concise pointer without obsolete procedures.
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
| `docs/pactile/internal-skill-audit.md` | live | merge | `capabilities.skills` | Hosts/capabilities |
| `docs/pactile/pi-role-policy.md` | live | merge | `capabilities.subagents` | Hosts/capabilities |
| `docs/retrieval*.md` | live | redirect | `capabilities.retrieval` | Hosts/capabilities |
| `docs/skills*.md` | live | redirect | `capabilities.skills` | Hosts/capabilities |
| `docs/subagents*.md` | live | redirect | `capabilities.subagents` | Hosts/capabilities |
| `docs/agent-tooling-narrative.zh-CN.md` | live | merge | `capabilities.native-adoption` | Hosts/capabilities |
| `docs/workflow*.md` | live | redirect | `lifecycle.workflow` | Lifecycle/support |
| `docs/cursor-trellis-release-coexistence-guide.md` | compat | redirect | `governance.releasing` | Governance/history |
| `packages/cli/CHANGELOG.md` | history | archive | `history.release-changelog` | Governance/history |
| `docs/campaign-ui.md` | history | archive | `history.campaign-ui` | Governance/history |

The grouped rows above are presentation shorthand only. The JSON inventory contains one explicit record per source path and is what the checker validates.

The English and Chinese compatibility-input references name exact legacy roots
and import behavior. They remain separate from the retired IDE integration.
`contracts-v1.md` stays live and links to those exact compatibility facts.

## Cursor++ documentation tail

P23 already owns runtime residue cleanup. This batch does not reimplement that cleanup.

Every **live** mapped source that still mentions Cursor++, `cursor2plus`, `ccursor`, or its retired model files has one section route to the page id `history.cursor-plus-plus`. Later lanes must remove the operational instructions from live prose and link to that history page when historical context is useful. The frozen changelog and archived community post remain history and are not rewritten.

The checker derives the current live-source set from tracked bytes and compares it with `p23CursorPlusPlus.routes`; adding a new live Cursor++ mention without an explicit route fails the inventory gate.

## Native install → adopt → bind narrative

The capabilities lane owns one shared explanation, `capabilities.native-adoption`, and links to it from the supported host page:

1. Detect the native resource and its current owner.
2. If an external/native dependency is absent, emit an `install-hint`; the user or host installs it, and Pactile later adopts it as borrowed.
3. `install` only a Pactile-composed/generated projection and record its managed ownership.
4. `adopt` a compatible pre-existing resource as borrowed state without rewriting it.
5. `bind` a Pactile capability to the installed or adopted resource through a projection plan.
6. Surface conflicts, malformed configuration, host trust, and locked files as host-local degraded states.
7. On detach, remove the binding and claimant; preserve borrowed and still-shared resources.

Skills and MCP pages apply the same model. External services are Providers resolved through project Middleware configuration, not special cases embedded in host instructions. Retrieval guidance states the minimum host assurance and carries Provider origin/readiness.

## Required new surfaces

Batch 4 has materialized the required 0.5.0 pages and GitHub community surfaces. The JSON map remains the machine-readable inventory and records the owner lane for each source:

- Codex host guide.
- MCP, Provider, privacy/permissions, and native adoption guides.
- Upgrade/migrate, detach/uninstall, rollback/purge, capability-smoke diagnostics, recovery, and known-limitations guides.
- Contribution, security, compatibility, and release governance.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`.
- GitHub issue forms and pull-request template with bilingual routing.

## Redirect and link policy

- Keep retained old documentation URLs as brief historical pointers without operational procedures.
- A pointer names Pactile, states why the page moved, links to both locale targets, and contains no obsolete operational procedure.
- Target pages use relative repository links. Every logical target page id must resolve before a source redirect is shipped.
- Historical snapshots may retain dead historical outbound links, but their archive header must identify them as unverified history.
- The final documentation lane runs relative-link checks and command smoke after target files exist.

## Command smoke

The following commands are the documented CLI smoke contract and use the current Commander interface:

```powershell
pactile --version
pactile init --codex
pactile capability-smoke --json
pactile update
pactile detach codex
pactile uninstall
```

Smoke must run on Windows and POSIX from a clean project, an upgraded legacy project, and a project with its selected Adapter. `capability-smoke --json` is the supported Pactile diagnostic; there is no separate `pactile doctor` command.

## Batch 0 checks

Run from the repository root:

```powershell
pnpm --filter @blxzer/pactile exec tsx scripts/check-pactile-brand-surface.ts
pnpm --filter @blxzer/pactile exec vitest run test/docs/pactile-brand-surface.test.ts
```

Stable release conformance additionally runs the same checker with `--release`, after Batch 3 and all documentation lanes have removed live legacy-name debt.
