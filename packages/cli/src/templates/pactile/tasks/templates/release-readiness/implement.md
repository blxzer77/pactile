# Implementation Plan — Release readiness

## Development Strategy Contract

execution_mode: lite-task
isolation: none
verification_profile: standard
retrieval_profile: structure
optional_capabilities: []
quality_gates:
  mode: profile
  profile: standard
  enabled: []
  disabled: []

## Steps

1. Read product release spec (e.g. `.pactile/spec/**/release*.md`) and recent integrated task handoffs.
2. Record current versions from `package.json` (and lockstep packages).
3. Draft version recommendation and changelog.
4. Run non-mutating guards and validation (manifest, build, focused tests, typecheck, pack dry-run).
5. Fill `verify.md` using the evidence contract in `design.md`.
6. Write `handoff.md` with **Ready to publish**, **Not published**, and **Blockers** tables.
7. Run `pactile task validate <this-task>` and `archive --check` when finishing.

## Validation

- Dry-run and `--check` commands only.
- No version bump, tag, push, or publish.