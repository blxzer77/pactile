# `@blxzer/pactile`

English | [简体中文](README.zh-CN.md)

The Pactile CLI creates and maintains an evidence-backed capability workspace for Cursor, Codex, or both. Canonical state lives in `.pactile/`; host files are rebuildable projections governed by explicit ownership.

## Install

```bash
npm install -g @blxzer/pactile
pactile --version
```

Node.js 18.17 or newer is required. Generated Python scripts and host hooks require Python 3.9 or newer. Smart Search and other middleware providers are optional, independently probed capabilities; Pactile does not silently install host-native assets or copy credentials.

## First project

```bash
mkdir my-pactile-project
cd my-pactile-project
pactile init --cursor --codex -y
pactile capability-smoke --json
```

Choose `--cursor`, `--codex`, or both. Existing user files and native assets are inspected before projection. A compatible external asset may be adopted as borrowed; a conflict or malformed host file remains untouched and produces a recovery action.

## Command reference

| Command                                              | Contract                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `pactile init --cursor [--codex]`                    | Create canonical state and reconcile the selected adapters.                       |
| `pactile capability-smoke [--json] [--write-status]` | Probe selected capabilities and optionally persist readiness.                     |
| `pactile update --dry-run`                           | Preview official-file, migration, and projection changes.                         |
| `pactile update`                                     | Apply one confirmed transaction, then reconcile adapters independently.           |
| `pactile migrate`                                    | Produce the optional migration preview; actual writes remain in `update`.         |
| `pactile rollout`                                    | Run `update` across explicit project paths and aggregate evidence.                |
| `pactile upgrade`                                    | Upgrade the globally installed canonical CLI package.                             |
| `pactile detach cursor`                              | Remove one adapter's bindings and claims; preserve shared and borrowed resources. |
| `pactile detach codex`                               | Apply the same single-adapter contract to Codex.                                  |
| `pactile uninstall --dry-run`                        | Preview detaching all adapters while retaining `.pactile/`.                       |
| `pactile rollback <generation> --dry-run`            | Verify and preview a sealed generation switch.                                    |
| `pactile purge --dry-run`                            | Produce the exact inactive-root target fingerprint; does not delete.              |
| `pactile workflow`                                   | List or select a canonical workflow template.                                     |
| `pactile validate-rules`                             | Validate supported Cursor rule projections.                                       |
| `pactile kernel --json`                              | Run the machine JSON lifecycle boundary used by generated project scripts.        |

Run `pactile <command> --help` for current flags. `detach` takes the adapter as a positional argument. `purge` is intentionally two-step: a destructive run requires `--yes` plus the exact fingerprint returned by the preview.

## Init options that affect ownership

- [Explicit legacy import](../../docs/pactile/compatibility-inputs.md#explicit-import) declares an existing tree as a read-only migration source. It never becomes a write target.
- `--capability <id>` enables an optional project capability; use the flag repeatedly or pass `all`.
- `--with-optional <name>` installs a packaged optional Skill into the project Skill directory. It does not install host-native plugins or services.
- `--skip-readiness` records framework readiness as unverified instead of inventing a provider result.
- `--force` and `--skip-existing` control file conflicts, but do not transfer ownership of user assets.

## Update, recovery, and exit

Always preview uncertain changes:

```bash
pactile update --dry-run --json
pactile detach cursor --dry-run
pactile uninstall --dry-run
pactile rollback <generation> --dry-run
pactile purge --dry-run
```

Canonical generation commit happens before host reconciliation. If one adapter fails, canonical state and successful sibling adapters remain intact; the failed adapter keeps a retryable receipt. Update and exit decisions consult the ownership ledger, so modified, foreign, unknown, shared, and borrowed resources fail safe.

See the repository guides for [Lifecycle](../../docs/lifecycle/index.md), [Recovery](../../docs/troubleshooting/recovery.md), and [Projection and Ownership](../../docs/concepts/projection-and-ownership.md).

## Package graph

| Package                | Role                                                                    |
| ---------------------- | ----------------------------------------------------------------------- |
| `@blxzer/pactile`      | Canonical CLI, adapters, templates, lifecycle, and project integration. |
| `@blxzer/pactile-core` | Canonical strict contracts and host-neutral primitives.                 |
| Legacy CLI bridge      | Deprecated 0.5.x compatibility package delegating to this CLI.          |
| Legacy core bridge     | Deprecated 0.5.x compatibility package re-exporting canonical Core.     |

Packed internal dependencies are exact release versions and never retain a workspace protocol. The published CLI exposes `pactile`; compatibility executables are not the preferred interface.

## Programmatic exports

```js
import { VERSION, listPactilePlatforms } from "@blxzer/pactile";

console.log(VERSION, listPactilePlatforms());
```

The root export contains the supported library surface. `./cli` is the executable entry used by the package bridge, `./compat` is reserved for that temporary bridge, and `./package.json` is exported for tooling. For host-neutral contracts, import from `@blxzer/pactile-core` and its documented subpaths.

## Security boundary

Pactile stores logical provider references and Evidence links, not secret values, OAuth state, private model reasoning, or copied external asset bodies. Adapters cannot write canonical `.pactile/` state; the reconciler is the only projection writer. Borrowed assets retain `preserve` deletion policy.

## More documentation

- [Repository overview](../../README.md)
- [Five-minute example](../../examples/minimal-agent-app/README.md)
- [Core concepts](../../docs/concepts/index.md)
- [Hosts](../../docs/hosts/index.md)
- [Capabilities and providers](../../docs/capabilities/index.md)
- [Lifecycle](../../docs/lifecycle/index.md)
- [Troubleshooting](../../docs/troubleshooting/index.md)

Release and registry mutation procedures are intentionally absent from this public package README.

## License

Pactile is distributed under the GNU Affero General Public License v3.0-only
(`AGPL-3.0-only`). The complete license text is included in this package as
[`LICENSE`](LICENSE); project and upstream attribution is documented in the
repository's [`COPYRIGHT`](https://github.com/blxzer77/pactile/blob/main/COPYRIGHT).
