# Lifecycle and safe change

English | [简体中文](index.zh-CN.md)

Pactile lifecycle commands operate on a canonical `.pactile/` generation and
then reconcile host projections. Pick the path that matches the project state:

| State                                 | Entry                                           | First action                                                      |
| ------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| Fresh project                         | [Install](install.md)                           | `pactile init --codex`.                                           |
| Existing legacy project               | [Upgrade and migrate](upgrade-and-migrate.md)   | Preview first; use explicit legacy import only.                   |
| Mixed or partially configured project | [Troubleshooting](../troubleshooting/index.md)  | Inspect ownership and readiness before update.                    |
| Normal day-to-day work                | [Workflow](workflow.md)                         | Follow the canonical Task and Evidence gates.                     |
| Remove one or all hosts               | [Detach and uninstall](detach-and-uninstall.md) | Dry-run, then apply a non-destructive exit.                       |
| Recover a known generation            | [Rollback and purge](rollback-and-purge.md)     | Verify a sealed generation; purge is a separate destructive step. |

## Safety rules

- `--dry-run` previews; it does not authorize the write that follows.
- Canonical state is preserved by detach and uninstall.
- Modified, foreign, unknown, borrowed, or locked resources stop at review.
- Rollback accepts only a sealed generation and may leave an adapter degraded
  while the canonical target is restored.
- Purge requires an inactive install, no ownership claims, a fresh target
  fingerprint, and an exact explicit confirmation.

The complete Core and CLI suite is intentionally a final release preflight,
not a routine lifecycle command. Read the [capability modes](../capabilities/index.md)
and [recovery runbooks](../troubleshooting/recovery.md) for diagnostic evidence.
