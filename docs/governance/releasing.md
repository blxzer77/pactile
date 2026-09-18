# Releasing

English | [简体中文](releasing.zh-CN.md)

Release work starts only after the candidate is reviewed and the release owner
has explicit authorization. A Batch 4 RC candidate is not a published release.

## Candidate preflight

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm release:check
pnpm --filter @blxzer/pactile check:pack-files
pnpm --filter @blxzer/pactile check:release-pack
pnpm mirror-check
node packages/cli/scripts/check-pactile-brand-surface.js --release
pnpm --filter @blxzer/pactile exec vitest run test/docs/documentation-parity.test.ts
pnpm docs:smoke
node packages/cli/scripts/release-conformance.js
```

Run the full Core and CLI suite exactly once immediately before an authorized
release. Record the commit, package versions, tarball manifest, conformance
matrix, docs gates, and the full-suite result together.

## Publication boundary

The four-package order is core → CLI → legacy core bridge → legacy CLI bridge.
Each tarball is sealed and checked before the next package is considered.
Publication requires an exact release tag, verified provenance, an ephemeral
registry credential, and a post-publish visibility check. A dry-run, plan, or
RC artifact never implies permission to tag, publish, merge to the release
branch, or create a GitHub Release.

Historical changelog entries, tags, manifests, and attribution remain intact.
