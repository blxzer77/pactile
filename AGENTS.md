# Pactile developer guide

This repository contains the Pactile product. Node.js is its only required
runtime. Generated host state and personal task data stay outside Git.

## Repository policy

- The existing `private` Git remote is authoritative. Do not add or push to an
  upstream remote.
- `main` is the release line and `develop` is the development line. Feature
  work starts from `develop` on a short-lived `feat/*`, `fix/*`, or `chore/*`
  branch and integrates only into `develop`.
- Do not commit, push, tag, publish, merge, or create a release unless the user
  explicitly authorizes that action.
- The worktree may contain unrelated user changes. Preserve them; never reset,
  clean, or overwrite them to make a task easier.
- Published migration manifests, the changelog, archived fixtures, and legal
  attribution are historical evidence. Do not rewrite them as part of a live
  brand change.

## Architecture

Pactile is a pnpm TypeScript monorepo:

```text
packages/
  core/                 @blxzer/pactile-core
  cli/                  @blxzer/pactile
  <legacy bridges>/     0.5.x package and bin redirects
```

The core package has no runtime dependencies and owns task, channel, lifecycle,
runtime, generation, and compatibility primitives. The CLI owns commands,
host adapters, projection, migrations, templates, and release validation.

Canonical project state is under `.pactile/`. Host projections are receipts-
and-ledger governed: preserve foreign, borrowed, shared, and user-modified
resources. The active host projection targets Codex; older Cursor claims are
read only so `pactile detach cursor` can remove them safely.

Compatibility rules for the 0.5.x line:

- old project roots and environment names are read-only inputs;
- new writes use only canonical Pactile paths, markers, and environment names;
- the legacy CLI spelling is a warning alias for the canonical `pactile` bin;
- legacy npm packages are thin redirects and contain no second implementation;
- upstream-owned project state is never auto-claimed or rewritten;
- compatibility readers are centralized and must have focused tests and a
  documented removal condition.

## Development

Use Node.js 18.17 or newer and pnpm. Build order is core before CLI.

| Command | Purpose |
| --- | --- |
| `pnpm build` | Build core and CLI in dependency order |
| `pnpm typecheck` | Build core, then type-check the CLI |
| `pnpm lint` | Lint both canonical packages |
| `pnpm test` | Run core and CLI tests |
| `pnpm mirror-check` | Verify generated-template and dogfood parity |
| `pnpm release:check` | Validate the four-package release graph |
| `pnpm check:pack-files` | Validate packed artifact contents |

Source is strict ESM with NodeNext resolution and explicit `.js` specifiers.
Node.js is the only required runtime for generated Pactile projects.

## Change rules

- Treat `packages/cli/src/templates/` as the generated-project source of truth.
  Keep generated host files and personal task state out of this repository.
- A fresh project must expose only `.pactile`, `pactile-*`, `PACTILE:*`, and
  `PACTILE_*` identifiers.
- Never add host files through init/update directly. Route all host mutations
  through the projection store so adoption, claimant sharing, detach, recovery,
  and modified-file preservation remain auditable.
- Keep project tasks, workspace journals, spec content, middleware overlays,
  secrets, and host session data out of template hashes and generation payloads.
- Lifecycle commits canonical state before attempting host adapters. A partial
  adapter failure records degraded truth and retries only failed adapters.
- Uninstall means non-destructive detach. Purge requires an unchanged preview
  fingerprint and explicit confirmation. Rollback targets a verified sealed
  generation and never deletes the generation being left.
- When changing package identity, validate canonical and compatibility bins,
  exact packed dependency versions, absence of workspace protocols, and the
  release order: canonical core, canonical CLI, legacy core bridge, legacy CLI
  bridge.
- Prefer focused tests while iterating, then run type-check, lint, build,
  package validation, mirror checks, and the broad suite in proportion to risk.
- Report pre-existing baseline failures separately from failures caused by the
  current change. Do not weaken a guard to make a check pass.
