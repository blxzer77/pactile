# Pactile

<p>
  <a href="https://github.com/blxzer77/pactile/actions/workflows/ci.yml">
    <img src="https://github.com/blxzer77/pactile/actions/workflows/ci.yml/badge.svg" alt="CI">
  </a>
  <a href="https://www.npmjs.com/package/@blxzer/pactile">
    <img src="https://img.shields.io/npm/v/@blxzer/pactile?label=npm" alt="npm version">
  </a>
</p>

English | [简体中文](README.zh-CN.md)

Pactile turns governed capability tiles into an evidence-backed workspace for Codex.

It gives an AI coding project one source of truth for instructions, tasks, ownership, and lifecycle state. The Codex integration receives a projection from that canonical state.

## Five-minute path

Prerequisites: Node.js 18.17 or newer. Pactile task, context, and session commands run on Node.js; Python is not required.

```bash
npm install -g @blxzer/pactile
pactile --version

mkdir my-pactile-project
cd my-pactile-project
pactile init --codex -y
pactile capability-smoke --json
```

`init` creates canonical state under `.pactile/`, then reconciles the Codex adapter. The final command reports actual capability readiness; a degraded provider remains visible instead of being presented as native support.

After initialization, ask the agent to work normally. For durable work it will use the generated workflow and task tools; you do not need to memorize an extra prompt language.

## What appears in your project

```text
my-pactile-project/
  .pactile/        canonical workflow, tasks, Tiles, runtime state, and Evidence
  .agents/         projected Skills for Codex
  .codex/          Optional Codex project configuration when native support is ready
  AGENTS.md        shared managed instructions plus preserved user content
```

Pactile owns only the managed content recorded in its ownership ledger. Existing host-native Skills, MCP configuration, plugins, and user-authored files remain external or borrowed unless a reviewed plan says otherwise.

Existing Cursor files from earlier versions are left untouched by the active install path. Use `pactile detach cursor --dry-run` to review legacy cleanup.

## Mental model

| Concept        | What it does                                                                                  | What it does not do                                                     |
| -------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Tile**       | Declares a small capability, its inputs, policy ceiling, Evidence needs, and stop conditions. | It is not a prompt dump, host script, or central workflow.              |
| **Kernel**     | Validates lifecycle transitions and durable contracts against canonical state.                | It does not plan the model's work or write host projections.            |
| **Trace**      | Records observable composition events and Evidence references in order.                       | It never stores private reasoning or credentials.                       |
| **Projection** | Turns one canonical generation into host-specific files and bindings.                         | It is rebuildable, not a second source of truth.                        |
| **Ownership**  | Tracks who owns and still claims each projected or borrowed resource.                         | A claim does not grant deletion rights over user or third-party assets. |

Start with [Core concepts](docs/concepts/index.md), then read the focused pages on [Tiles](docs/concepts/tiles.md), [Kernel, Evidence, and Trace](docs/concepts/kernel-evidence-trace.md), and [Projection and Ownership](docs/concepts/projection-and-ownership.md).

## Hosts and capabilities

| Host  | Project surface                                                  | Pactile behavior                                                    |
| ----- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| Codex | Managed `AGENTS.md` and `.agents/skills/`; optional project config | Reconciled from canonical state; unavailable native bindings degrade. |

Pactile reports capability origin (`native`, `provider`, `heuristic`, or `unsupported`) separately from assurance. An optional provider can improve a capability, but its presence never makes a claim verified without Evidence and a passing freshness-bounded probe.

See [Hosts](docs/hosts/index.md) and [Capabilities](docs/capabilities/index.md) for the detailed support boundaries.

## Lifecycle and safety

- `pactile update --dry-run` previews official-file and projection changes before applying them.
- `pactile detach codex` removes the active adapter's claims while preserving borrowed resources. `pactile detach cursor` remains available to clean up an older installation after preview.
- `pactile uninstall --dry-run` previews detaching every adapter while retaining canonical `.pactile/` state.
- `pactile rollback <generation> --dry-run` verifies a sealed generation before switching.
- `pactile purge --dry-run` only produces a target fingerprint. Destructive cleanup requires a second, explicit confirmation using that exact fingerprint.

Migration inputs are read-only. Modified, foreign, unknown, or borrowed resources fail safe and remain available for review. See [Lifecycle](docs/lifecycle/index.md) and [Troubleshooting](docs/troubleshooting/index.md).

## Packages

`@blxzer/pactile` is the single release package. It includes the CLI, templates,
adapters, lifecycle, and host-neutral Core contracts. Import those contracts
from `@blxzer/pactile/core` or `@blxzer/pactile/core/task`. The separate Core
and legacy bridge packages remain only as previously published 0.5.x history;
v0.6.0 does not publish them. Historical release facts remain in the changelog.

## Documentation

| Area                                       | Start here                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| Concepts and architecture                  | [docs/concepts/index.md](docs/concepts/index.md)                             |
| Host adapters                              | [docs/hosts/index.md](docs/hosts/index.md)                                   |
| Skills, MCP, retrieval, providers, privacy | [docs/capabilities/index.md](docs/capabilities/index.md)                     |
| Install, update, migration, exit, recovery | [docs/lifecycle/index.md](docs/lifecycle/index.md)                           |
| Troubleshooting                            | [docs/troubleshooting/index.md](docs/troubleshooting/index.md)               |
| CLI reference                              | [packages/cli/README.md](packages/cli/README.md)                             |
| Minimal example                            | [examples/minimal-agent-app/README.md](examples/minimal-agent-app/README.md) |
| Contributing and security                  | [docs/governance/index.md](docs/governance/index.md)                         |

## Developing Pactile

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
```

The complete Core and CLI test suite is the final release gate. Focused changes should also run the closest package and conformance tests. Contributor workflow, security reporting, and compatibility policy live under [Governance](docs/governance/index.md).

## Scope

Pactile is local project tooling. It does not promise cloud orchestration, a plugin marketplace, automatic installation of host-native assets, or ownership of credentials and OAuth state. Optional middleware providers remain independently installed and explicitly probed.

Lineage, copyright, and license notices are preserved in [COPYRIGHT](COPYRIGHT) and [LICENSE](LICENSE).

## License

Pactile is distributed under the GNU Affero General Public License v3.0-only
(`AGPL-3.0-only`). See [LICENSE](LICENSE) for the complete license text and
[COPYRIGHT](COPYRIGHT) for Pactile's project and upstream attribution.
