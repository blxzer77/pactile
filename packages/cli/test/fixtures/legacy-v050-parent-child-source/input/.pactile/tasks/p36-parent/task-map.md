---
parent_id: p36-parent
contract_epoch: 1
execution_topology: parallel
merge_limit: 1
graph_authority: kernel-extras
topology_kind: parent-child
children:
  - id: p36-child
    state: open
    depends_on: []
    touches: []
    isolation: git-worktree
    ref: null
integration_queue: []
---
# Task Map

## Orchestration notes

- **parallel-first:** Prefer Cursor Multitask / Build in Parallel / Agent `Task` / native worktree. Pactile does not schedule workers or replace Multitask.
- `execution_topology: parallel` — default when ≥2 children have empty `depends_on`. Parent `integrate-child`, HITL, `start-execution --approved`, and reviewer gates stay serial (`merge_limit`).
- `serial_reason` — required when topology is `serial`. One of: shared write-set / HITL or reviewer gate / `depends_on` unmet / user asked serial / conflict surface cannot isolate.
- `stages:` (or `parallel_groups`) — concurrently runnable child id groups.
- `merge_points` — where serial join happens (usually `integrate-child` + gates). Default `merge_limit: 1`.
- `touches` (or `conflict_surface`) — write-sets that can collide; declare before dispatch.
- Child-reported states: `open` → `working` → `blocked` | `review`.
- Parent-controlled states: `review` → `changes` | `accepted` → `integrating` → `integrated` | `cancelled`.
- `isolation: git-worktree` — run `prepare-child-worktree` from the **git package root** (not a non-git harness root).

## Event Log

- 2026-09-26T13:44:18Z - Linked Child `p36-child`.
