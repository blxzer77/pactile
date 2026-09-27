# Projection and Ownership

English | [简体中文](projection-and-ownership.zh-CN.md)

Pactile keeps project truth in `.pactile/` and presents that truth to each host through a rebuildable Projection. Ownership records constrain how those host-facing resources may be changed or removed.

## Projection

### Definition

A Projection is a host-specific view of one canonical generation. An Adapter observes the target host and emits a Projection Plan; a later Reconciler is the only component allowed to apply that plan to host files or external bindings.

### Responsibilities

- translate canonical capabilities and instructions into Codex-supported surfaces;
- use stable operations such as `ensure`, `merge`, `remove`, `bind`, and `detach`;
- name desired content and fingerprints without writing files directly;
- give each Adapter an independent result, receipt, and retry boundary;
- remain reproducible from the same canonical generation and observed host state.

### Boundary

A Projection Plan cannot target canonical `.pactile/` state or read-only legacy roots. Borrowed assets can only be bound or detached, never rewritten. A failed Projection does not invalidate an already sealed generation or a successful sibling Adapter.

## Ownership

### Definition

Ownership is the canonical ledger that relates one logical resource id to one physical target and records its owner, control mode, claimants, snapshots, conflicts, and proposed disposition.

### Responsibilities

- distinguish Pactile-owned, borrowed, and unknown control;
- retain `preimage`, generated, and observed current snapshots;
- prevent two resource ids from claiming the same physical target;
- preserve shared resources while any Adapter or Tile still claims them;
- decide when a write, no-op, preservation, review, preimage restore, or generated-file removal is safe.

### Boundary

Ownership is not inferred from a filename, directory, package, or the fact that Pactile can read a resource. Adoption does not erase the external owner. A claimant states continued use; it does not acquire deletion authority. Unknown, borrowed, or modified resources fail safe to preservation or manual review.

## Resource classes

| Condition                                                   | Pactile may do                                                   | Pactile must not do                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| Pactile-created, unmodified, no claimants                   | remove the generated resource after the required lifecycle check | remove it while a claimant remains                       |
| Adopted, unmodified, retained preimage, no claimants        | restore the retained preimage                                    | invent a preimage or restore over modified bytes         |
| Borrowed native Skill, Plugin, MCP installation, or service | bind, inspect readiness, detach the binding                      | copy credentials/content or uninstall the external asset |
| Current bytes differ from the generated snapshot            | preserve and route to review                                     | overwrite or delete merely because the path is managed   |
| Owner or origin is unknown                                  | preserve and require manual review                               | guess ownership from location or naming                  |

## Shared claimant scenario

```text
shared Skill target
  claimant: Codex Adapter

detach Codex
  -> zero claimants
  -> remove only if Pactile-owned and current == generated
  -> otherwise preserve or restore under the ledger rules
```

This is why detach is not recursive deletion. It changes a claim and lets the Reconciler evaluate the resource from current bytes and recorded ownership.

## Three-way safety

For managed files, safe reconciliation compares three views:

1. the retained preimage, when an existing file was adopted;
2. the last generated snapshot;
3. the currently observed bytes.

If current still matches generated, Pactile can apply the next reviewed operation. If it differs, user or third-party edits may exist, so the resource is preserved. This rule applies during update, detach, uninstall, rollback, and recovery.

## User scenario

A Codex project already has a user-installed Skill. Pactile discovers and binds that external asset instead of copying it. The ledger keeps the user or host as owner and records borrowed control. Later `pactile uninstall --dry-run` can describe the binding it would detach, but it cannot claim or delete the installed Skill.

## What to inspect

- the active generation identifies the canonical source used by each Adapter;
- the Projection Plan shows desired operations, not completed writes;
- the receipt shows which operations actually applied, degraded, or need review;
- the Ownership ledger explains why a shared, borrowed, unknown, or modified target was preserved.

See [Architecture](architecture.md), [Kernel, Evidence, and Trace](kernel-evidence-trace.md), and the strict [v1 projection and ownership contracts](../pactile/contracts-v1.md#projection-and-ownership).
