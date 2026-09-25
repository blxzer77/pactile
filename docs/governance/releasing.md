# Releasing Pactile

English | [简体中文](releasing.zh-CN.md)

v0.6.0 has one public npm package: `@blxzer/pactile`. Its tarball contains the
CLI and Core contracts. Previously published 0.5.x Core and legacy bridge
packages remain npm history; the new workflow never builds or publishes them.

## Branch and PR flow

Feature, fix, and chore branches target `develop`. Pushes and PRs run CI only.
A beta version is prepared on `develop` and tagged `pactile-vX.Y.Z-beta.N` only
after explicit authorization. The tag workflow requires the tag commit to be
the exact `develop` head, validates the single tarball, and publishes it under
the npm `beta` dist-tag.

After beta acceptance, update only the package version to `X.Y.Z` and the
release documentation/changelog, then open a `develop` → `main` release PR.
Its body must contain these exact fields:

```text
Beta tag: pactile-v0.6.0-beta.2
Beta validation: https://github.com/blxzer77/pactile/actions/runs/<successful-publish-run-id>
Beta acceptance: <actual beta install and behavior results>
Post-beta changes: packages/cli/package.json, packages/cli/CHANGELOG.md
```

The PR check verifies the beta tag, successful Publish run at that commit,
current `develop` head, stable package version, and every file changed since
beta. Product code, dependencies, lockfile, or workflows changed after beta
require a new beta and acceptance. Documentation and the version-only package
change may follow beta when listed. Use `Post-beta changes: none` if there are
no changes.

After the release PR is merged, an explicitly authorized stable
`pactile-vX.Y.Z` tag at the exact `main` head publishes the same single package
under `candidate`. The separate, confirmed Publish workflow dispatch checks
the candidate and promotes it to `latest` manually. Actual remote promotion
and release acceptance belong to the v0.6.0 release gate.

## Local preflight

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm release:check
pnpm --filter @blxzer/pactile check:pack-files
pnpm --filter @blxzer/pactile check:release-pack
pnpm docs:smoke
node packages/cli/scripts/check-pactile-brand-surface.js --release
node packages/cli/scripts/release-conformance.js
```

The conformance check runs the sealed package in a PATH with Node and no
Python or Pi executable. It exercises init, update preview/apply, task
start/archive, a simulated Codex desktop receipt, simulated Pi RPC, and a
two-child parallel batch. Its timing line is a local baseline, not a latency
promise. For an offline local rehearsal after `pnpm install --offline`, set
`PACTILE_CONFORMANCE_OFFLINE=1`; this unpacks the sealed tarball and links the
already locked local dependencies. The CI/default path performs a clean npm
install. Record real desktop-host and model-provider acceptance separately.

The tag workflow repeats these gates before it seals the tarball. Release
preparation runs in a job with read-only permissions and no publish credential.
The separate publish job receives GitHub OIDC permission for npm Trusted
Publisher and publishes only the sealed artifact. Configure npm Trusted
Publisher for `blxzer77/pactile`, workflow filename `publish.yml`, and allow
direct `npm publish`. The
manifest SHA-256 receipt travels outside the artifact directory. Failed
provenance, package graph, tarball, receipt, or npm readback checks stop
publication or promotion.

A plan, dry run, clean CI result, or local merge never grants permission to
push, merge to `main`, tag, publish, or promote. Historical changelog entries,
tags, migration manifests, and attribution remain intact.
