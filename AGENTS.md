# Pactile developer guide

This repository contains the Pactile product. Node.js is its only required
runtime. Generated host state and personal task data stay outside Git.

The public repository contains product source, fixtures, release tooling and
developer documentation. Root host configuration, agent skills, project tasks,
retrieval indexes and personal drafts stay local. `pnpm repo:check` verifies
this boundary. This file is the product developer guide, not generated host state.

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

Pactile is a pnpm TypeScript workspace with one publishable package:

```text
packages/
  cli/                  @blxzer/pactile
    src/core/           host-neutral task and contract primitives
```

Bundled Core owns task, channel, lifecycle, runtime, generation, and
compatibility primitives. The CLI also owns commands, host adapters,
projection, migrations, templates, and release validation.

Canonical project state is under `.pactile/`. Host projections are receipts-
and-ledger governed: preserve foreign, borrowed, shared, and user-modified
resources. The active host projection targets Codex. Retired host files in
existing user projects remain untouched and require manual cleanup.

Compatibility rules for the 0.5.x line:

- old project roots and environment names are read-only inputs;
- new writes use only canonical Pactile paths, markers, and environment names;
- the legacy CLI spelling is a warning alias for the canonical `pactile` bin;
- previously published legacy npm packages remain historical releases and are
  not part of the v0.6.0 build or publish graph;
- host-specific migration manifests from before v0.6.0 no longer execute or
  ship; the current Node and task migration path remains active;
- upstream-owned project state is never auto-claimed or rewritten;
- compatibility readers are centralized and must have focused tests and a
  documented removal condition.

## Development

Use Node.js 20 or newer and pnpm.

| Command | Purpose |
| --- | --- |
| `pnpm build` | Build the single package, including Core |
| `pnpm typecheck` | Type-check the CLI and bundled Core |
| `pnpm lint` | Lint source and tests |
| `pnpm test` | Run CLI and Core tests |
| `pnpm release:check` | Validate the single-package release graph |
| `pnpm --filter @blxzer/pactile check:release-pack` | Check tarball file contents |
| `node packages/cli/.tmp/p31-script-build/release-conformance.js` (after `pnpm build`) | Install and smoke-test the tarball |

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
- When changing package identity, validate the one package's bins, Core
  exports, packed dependencies, absence of workspace protocols, and tag source.
- Prefer focused tests while iterating, then run type-check, lint, build,
  package validation, documentation smoke, and the broad suite in proportion to risk.
- Report pre-existing baseline failures separately from failures caused by the
  current change. Do not weaken a guard to make a check pass.

## Historical maintenance exception

`packages/cli/scripts/migrate-features-to-tasks.sh` is retained only because the
archived 0.2.0 migration manifest mentions it. It has no current CLI, package
script, or workflow caller, and the npm package excludes `scripts/`. The old
project mutator requires Bash and `jq`; it is not part of the current Node-only
install, build, release, or runtime path. Remove it only when the archived
manifest no longer carries that historical reference.

## Tooling configuration exception

`packages/cli/eslint.config.js` remains a small, declarative JavaScript flat
configuration. ESLint loads it before the repository's TypeScript maintenance
scripts are compiled, so keeping the bootstrap configuration directly
executable avoids adding another TypeScript loader to the lint startup path.
Keep product and maintenance behavior out of this file. Revisit the exception
when ESLint can load a TypeScript flat configuration on the supported Node 20
floor without a separate runtime loader or additional bootstrap dependency.

## Release conformance probe

The sealed-install Python and Pi PATH check is maintained in
`packages/cli/scripts/assert-no-python-on-path.ts`. It is included in
`tsconfig.scripts.json` and compiled with the release-conformance runner; do not
replace it with inline `node -e` JavaScript. The default npm lifecycle install
uses an absolute `npm-cli.js` path and exposes Node from a private PATH directory
that contains only `node.exe` on Windows (or `node` on other platforms), along
with operating-system support paths. The check runs against that same restricted
PATH and environment.

Simulated Pi and Jev providers and the trace-store concurrency child are
maintained as TypeScript under `packages/cli/scripts/fixtures/`. They are covered
by `tsconfig.scripts.json` and compiled with the checked script artifacts before
tests and release acceptance. Invoke their compiled JavaScript with Node; do not
generate JavaScript source strings or pass inline logic to `node -e`. These are
local test fixtures, not real provider acceptance claims.
