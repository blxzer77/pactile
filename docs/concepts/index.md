# Pactile concepts

English | [简体中文](index.zh-CN.md)

Pactile separates durable project truth from the way each AI host consumes it. The model composes small governed capabilities; the Kernel validates durable boundaries; Adapters build projections; Evidence, Trace, and Ownership make the result inspectable and reversible.

## The five concepts

| Concept                                              | Definition                                                                  | Responsibility                                                                               | Boundary                                                                                     | Typical user scenario                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [Tile](tiles.md)                                     | A small, versioned capability contract.                                     | Declare inputs, outputs, policy ceiling, assurance, Evidence, fallback, and stop conditions. | Contains no host path, tool script, prompt transcript, or central plan.                      | Add structural code retrieval without loading an entire research playbook.                     |
| [Kernel](kernel-evidence-trace.md#kernel)            | The host-neutral validator for durable state and transitions.               | Check task, lifecycle, gate, archive, and record contracts.                                  | Does not choose Tiles, reason for the model, or write host files.                            | Refuse task execution until required definition and approval evidence exists.                  |
| [Trace](kernel-evidence-trace.md#trace)              | An ordered log of observable composition events.                            | Link selection, invocation, outcome, Provider resolution, artifacts, and Evidence.           | Excludes private reasoning, prompts, secrets, and arbitrary inline output.                   | Explain which capability ran and which Evidence supports its result.                           |
| [Projection](projection-and-ownership.md#projection) | A rebuildable host-specific view of one canonical generation.               | Express Codex files, managed blocks, and external bindings.                                  | Cannot become canonical state or write inside `.pactile/`.                                   | Reconcile Codex project files without reauthoring project truth. |
| [Ownership](projection-and-ownership.md#ownership)   | The ledger of resource owner, control, snapshots, claimants, and conflicts. | Decide whether reconcile, detach, restore, or remove is safe.                                | A claimant never gains deletion rights over borrowed, foreign, unknown, or modified content. | Detach Codex while preserving a borrowed Skill.                |

Evidence is the connective tissue: a stable reference to an artifact, check, receipt, or Provider result that supports a claim. It is not a sixth planner and it does not contain hidden reasoning.

## How they work together

```text
user intent
  -> model selects and orders Tiles
  -> Kernel validates contracts and lifecycle gates
  -> canonical generation is sealed in .pactile/
  -> each Adapter emits a Projection Plan
  -> Reconciler applies safe operations using Ownership
  -> receipts, Evidence, and Trace describe what happened
```

Failure stays local to the boundary that failed. A bad Tile contract is rejected before composition. A failed host projection does not roll back an already sealed canonical generation or a successful sibling adapter. A modified or borrowed resource is preserved for review.

## Authority map

| State                                                                   | Authority                  | Rebuildable?                                                      |
| ----------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------- |
| `.pactile/` generation, workflow, tasks, Tiles, ledger, receipts        | Pactile canonical state    | No; this is the durable source.                                   |
| Optional `.codex/`, managed `AGENTS.md`, Pactile-owned shared Skills | Adapter projections | Yes, subject to ownership checks; Codex leaves are conditional on native support. |
| Host-native Skills, plugins, MCP installation, credentials, user files  | User, host, or third party | No; Pactile may only discover, adopt, or bind them within policy. |

## Read next

- [Architecture](architecture.md) — components, authority, and failure isolation.
- [Tiles](tiles.md) — capability composition and policy ceilings.
- [Kernel, Evidence, and Trace](kernel-evidence-trace.md) — durable validation and observability.
- [Projection and Ownership](projection-and-ownership.md) — host reconciliation and safe exit.
- [Spec system](spec-system.md) — progressive project knowledge.
- [Task system](task-system.md) — durable work, gates, Parent/Child topology, and close evidence.
- [Repository quick start](../../README.md) — install and first readiness check.
