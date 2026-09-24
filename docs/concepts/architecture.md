# Architecture and authority

English | [简体中文](architecture.zh-CN.md)

Pactile has one canonical runtime and a rebuildable Codex host projection. Adapters can describe and reconcile what a host needs, but they cannot redefine durable project truth.

## Components

| Component           | Reads                                                                 | Writes                                             | Primary output                                 |
| ------------------- | --------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------- |
| Runtime             | project inputs and explicit read-only migration sources               | `.pactile/` canonical state                        | sealed generations and install state           |
| Tile compiler       | Tile catalog and model/explicit selection                             | no filesystem state                                | ordered composition and diagnostics            |
| Kernel              | canonical records and transition requests                             | validated canonical task/lifecycle records         | accepted transition or typed rejection         |
| Middleware resolver | capability intent, policy ceiling, Provider manifests, probe Evidence | readiness records only through the owning workflow | resolved Provider with origin and assurance    |
| Adapter             | canonical generation and host observations                            | no files directly                                  | Projection Plan                                |
| Reconciler          | Projection Plan, Ownership ledger, current host bytes                 | approved projection targets and receipts           | applied, retryable, degraded, or review result |

The strict JSON schemas are documented in the [v1 contract reference](../pactile/contracts-v1.md). The concept pages explain how users should reason about those contracts.

## End-to-end flow

```text
Tile catalog + task intent
        |
        v
model selection -> compiler diagnostics -> Kernel/lifecycle validation
        |                                      |
        +---------------- canonical commit ----+
                                               v
                                 sealed .pactile generation
                                               |
                                         Codex Adapter
                                               |
                                         Projection Plan
                                               |
                                   Ownership-aware Reconciler
                                              |
                                  host files + bindings + receipts
                                              |
                                      Evidence + Trace
```

The adapter has its own result and retry count. A committed generation may remain healthy while its host projection is degraded.

## Authority rules

1. `.pactile/` is the only writable canonical root.
2. Declared migration roots are read-only inputs; current code never writes them.
3. A Projection Plan expresses intent and carries no direct filesystem authority.
4. The Reconciler is the only host projection writer.
5. Ownership and current-byte checks constrain every overwrite, restore, and removal.
6. External assets and providers keep their original owner, installation, authentication, and deletion boundary.

## Failure isolation

| Failure                                             | Required behavior                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Invalid Tile or policy escalation                   | Reject before invocation; emit diagnostics.                                         |
| Provider absent or stale                            | Report the actual lower assurance or degraded/unsupported state with a user action. |
| Canonical commit fails                              | Do not start adapter reconciliation.                                                |
| Adapter fails after commit                          | Preserve canonical truth; retain a retryable receipt.                               |
| Current host bytes differ from the managed snapshot | Preserve and route to review; do not overwrite or delete.                           |
| Interrupted migration                               | Recover from the journal and retained backup without writing legacy sources.        |

## User scenario

A project starts with Codex and has a user-owned Skill. Pactile reads the active generation, builds a Codex Projection Plan, and records a borrowed binding for the Skill. Detaching Codex removes its claim while preserving the user-owned asset.

## Boundaries

Pactile is not a remote orchestrator, secret manager, plugin marketplace, or substitute for host authorization. It can describe installation hints and bind to discovered native assets, but it cannot silently install them or turn a logical reference into ownership.

See [Tiles](tiles.md), [Kernel, Evidence, and Trace](kernel-evidence-trace.md), and [Projection and Ownership](projection-and-ownership.md).
