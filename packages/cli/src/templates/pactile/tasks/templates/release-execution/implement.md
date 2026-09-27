# Implementation Plan — Release execution

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

1. Read linked readiness `handoff.md` and confirm **ready to publish**.
2. Ask user for explicit approval; record in `verify.md` **Publish approval evidence**.
3. Run preflight checks (no publish yet).
4. On approval only, run approved release commands.
5. Run post-publish smoke and registry verification.
6. Write `handoff.md` (**Published** / **Not published** / residual risks).
7. `pactile task validate` and archive when complete.

## Validation

- Preflight must pass or be explicitly waived before publish.
- If user denies approval, end with **not published** and no remote mutations.