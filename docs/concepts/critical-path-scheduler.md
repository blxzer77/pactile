# Pactile Task scheduler V1

`packages/cli/src/pactile/scheduler/` contains a deterministic planning kernel
for a Task dependency graph. `planTaskScheduleV1` returns an explanatory
receipt. It does not start a Run, approve work, create a worktree, integrate a
branch, or perform review.

## Scheduling rules

- Every dependency must name a task in the graph. Missing dependencies and
  cycles reject the whole request.
- A `waiting` task can be scheduled only after every dependency is already
  `completed` or appeared in an earlier planned wave. A `blocked` or `failed`
  task blocks its waiting descendants. A `running` task remains in flight and
  never becomes a dispatch decision in this plan.
- The critical-path cost for a task is its cost plus the largest remaining
  dependent path. Costs include dispatch latency, scheduler waiting, execution,
  rework, integration, and review, all in non-negative milliseconds.
- Ready tasks are grouped only when every pair is write-compatible. A null
  write set is unknown and conflicts with every writer. An empty write set is
  a known read-only scope. Concrete paths are project-relative, normalized to
  `/`, NFC, and case-insensitive for conservative conflict detection; a parent
  path overlaps each descendant.
- Overlapping writers are serial by default. A conflict authorization names
  the exact task pair, approver, authorization evidence reference, and a
  non-empty integration plan. The kernel validates and returns this record; a
  future caller remains responsible for validating the authority behind it
  and following the integration plan.
- There is no numeric concurrency limit in this kernel. A compatible group is
  dispatched together only when the estimated wave finishes sooner than its
  serial equivalent. The parallel wave estimate is the longest concurrent
  latency/wait/execution/rework path plus serial integration and review costs.
- Optional Jev task-order advice is consulted only when critical-path costs
  tie. It cannot make a blocked task ready, satisfy a dependency, or permit a
  write-set conflict. The receipt records the advice reference, applied
  tie-breaks, and hints ignored by hard gates.

The receipt separates estimated costs from optional measured costs. It keeps
latency, waiting, execution, integration, rework, and review measurements on
each task decision so a caller can persist them with Run/audit records. This
module itself does not write those records or adapt estimates automatically.
The serial and planned completion totals cover tasks scheduled by this receipt;
blocked, failed, completed, in-flight, and deferred tasks remain visible in the
decision list. For an in-flight task, provide its remaining-cost estimate in
the cost vector.

## Integration points still required

This is an independent foundation slice. It is not wired into a command, Task
Kernel, or the existing bounded `parallel-batch` path. A later integration
should:

1. Map current Task dependencies and P35 Run states into this request without
   treating an unintegrated candidate as completed.
2. Map Run write-set snapshots and P38 worktree ownership into the conflict
   inputs without assuming those candidate changes have integrated.
3. Verify explicit conflict authorization against the active approval
   contract, then persist the deterministic schedule receipt and observed
   duration vector in the Run/audit lifecycle.
4. Add a caller only after its own lifecycle, authorization, and integration
   tests are in scope.
