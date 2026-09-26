# Handoff — Release readiness — `{task-id}`

## Ready to publish

**Materials are prepared; explicit user approval still required before any remote release.**

| Area | Status |
| --- | --- |
| Version recommendation | `{proposed-version}` via `{channel}` |
| Changelog / release notes | Draft in `verify.md` |
| Migration manifest | `{manifest-id or none}` |
| Build / test / pack dry-run | `{summary}` |

**Operator checklist before publish (not executed in readiness task):**

1. Resolve or waive each **blocking** row in Blockers below.
2. Create or select a **release-execution** task; obtain explicit publish approval.
3. Run `pnpm --filter @blxzer/pactile run release:check`, then use
   `pnpm --filter @blxzer/pactile run release:beta` or
   `pnpm --filter @blxzer/pactile run release:promote` to prepare a local plan.
   These commands do not tag or publish. After separate approval, create
   `pactile-vX.Y.Z-beta.N` at the exact `develop` HEAD or `pactile-vX.Y.Z` at the
   exact `main` HEAD and follow `docs/governance/releasing.md`; stable promotion
   uses a separate approved Publish workflow dispatch.

## Not published

- No npm publish, git tag, git push, or GitHub release in this task session.
- Workspace `package.json` versions unchanged unless a separate task already bumped them.

## Blockers

| Blocker | Severity | Disposition | Notes |
| --- | --- | --- | --- |
| Explicit user approval for publish | **Required gate** | blocking | Out of scope for readiness by design |
| `{example}` | blocking / fixed / waived / deferred | `{disposition}` | `{notes}` |

## Published

_Not applicable in a readiness task. Record publish evidence only in release-execution `handoff.md`._

## Integration notes

- Link execution task: `{path or pending}`
- Parent / dogfood notes: `{optional}`
