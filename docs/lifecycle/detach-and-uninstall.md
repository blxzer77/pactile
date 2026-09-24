# Detach and uninstall

English | [简体中文](detach-and-uninstall.zh-CN.md)

Detach releases one host Adapter. Uninstall releases every installed Adapter.
Both are non-destructive to canonical state; destructive cleanup is a separate
`purge` operation.

| Operation         | Preview                           | Apply                                | Preserved                                                  |
| ----------------- | --------------------------------- | ------------------------------------ | ---------------------------------------------------------- |
| Current host      | `pactile detach codex --dry-run`  | `pactile detach codex`             | `.pactile/`, borrowed and modified files.                 |
| Legacy Cursor     | `pactile detach cursor --dry-run` | `pactile detach cursor`            | User files and other claimants from older installations.   |
| All hosts         | `pactile uninstall --dry-run`     | `pactile uninstall --yes`            | Full `.pactile/` state and receipts.                       |
| Canonical cleanup | [Purge](rollback-and-purge.md)    | Separate fingerprint + confirmation  | Nothing inside the confirmed canonical target set.         |

The preview is bound to current install state, generation, ownership ledger,
and current bytes. If a file changes between preview and apply, the operation
stops safely. A generated file is removable only when its final claimant leaves
and the current bytes still match the safe managed fingerprint; a borrowed
resource is never deleted.
