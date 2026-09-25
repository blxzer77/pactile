# Pactile Task scheduler V1

`packages/cli/src/pactile/scheduler/` contains a deterministic Task DAG planner.
Import it with `@blxzer/pactile/scheduler` or the package root. The low-level
`planTaskScheduleV1` function is pure; `planParentTaskScheduleV1` reads a
Parent `task-map.md` and active Task Kernel records; `scheduleParentTaskGraph`
also persists a content-addressed decision receipt. The independent
`planTaskKernelGraphV1` and `scheduleTaskKernelGraph` entry points use only V2
Task Kernel records and do not need or create a Parent / Child map.

## Scheduling rules

- Every hard dependency must resolve to an active Task. Missing dependencies
  and cycles reject the plan. A closed V2 Task satisfies its dependencies; an
  unclosed or failed dependency cannot be dispatched as a candidate.
- V2 dependencies, Run state, Run duration estimates, `writeSetSnapshot`, and
  optional Run workspace write sets come from the public Task Kernel reader
  and lifecycle projection. Legacy Tasks remain read-only: their Parent
  `depends_on`, Child state, and `touches` are used as compatibility inputs.
  An `integrated` Parent Child whose V2 Kernel is not closed is blocked.
- Direct V2 candidates may be Tasks that are Run-ready but do not have a Run
  yet. They are represented as waiting only when the V2 lifecycle projection's
  `runStart.phaseAllowsRun` is true and its condition is `ready`; the scheduler
  still never starts or authorizes a Run. An incomplete hard dependency outside
  the candidate set is blocked until a later plan observes successful closure.
- The critical-path cost includes latency, waiting, execution, rework,
  integration, and review, in non-negative milliseconds. Caller estimates
  override V2 Run estimates; unset fields remain explicit as
  `unmeasured-zero` in the receipt. A group with no modeled completion-time
  gain is scheduled serially.
- Run write-set snapshots, Run workspace write sets, and Child `touches` are
  conservatively unioned. An unknown write scope conflicts with every writer.
  Concrete paths are project-relative, normalized to `/`, NFC, and
  case-insensitive for conservative conflict detection; a parent path overlaps
  each descendant.
- Overlapping writers are serial by default. Parallel overlap requires an
  exact Task pair, approver, authorization evidence reference, and non-empty
  integration plan. The decision and active leases retain these references.
  The caller remains responsible for verifying the authority behind the
  recorded evidence.
- There is no fixed numeric concurrency cap in the scheduler or active Parent
  dispatch path. The scheduler dispatches a compatible group together only
  when its estimate finishes sooner than the serial equivalent. Integration
  and review remain serial costs in the model, and Parent integration remains
  manual and serial (`merge_limit: 1`). Review cost is a weight, not a hard
  prohibition on parallel execution.
- Optional Jev advice requires an evidence reference and only breaks ties
  between equal critical-path costs. It cannot make a blocked Task ready,
  satisfy a dependency, or permit a write-set conflict.

## Node API and decision receipts

```ts
import { scheduleParentTaskGraph } from "@blxzer/pactile/scheduler";

const result = scheduleParentTaskGraph(projectRoot, parentTaskRef, {
  estimatedCosts: {
    "task-a": { executionMs: 180_000, integrationMs: 30_000, reviewMs: 20_000 },
  },
});
console.log(result.receipt.plan.waves, result.receiptFile);
```

For a standalone V2 Task/Run graph, pass its candidate Task IDs directly:

```ts
import { scheduleTaskKernelGraph } from "@blxzer/pactile/scheduler";

const result = scheduleTaskKernelGraph(projectRoot, ["task-a", "task-b"], {
  estimatedCosts: { "task-a": { executionMs: 180_000 } },
});
console.log(result.receipt.plan.waves, result.receiptFile);
```

The receipt is stored under
`.pactile/tasks/<parent>/scheduler/receipts/<sha256>.json`. It includes the
projected Task and Run lifecycle, source revisions, effective write sets,
estimate provenance, observed cost evidence references, conflict
authorizations, Jev tie-break disposition, and the complete plan. Repeating an
identical request is idempotent. Dispatch verifies the receipt fingerprint,
Parent task-map fingerprint, and V2 Kernel revisions before accepting it.

Standalone V2 receipts are stored at
`.pactile/.runtime/scheduler/receipts/<sha256>.json`; their scope, candidate
IDs, V2 revision snapshot, cost inputs, and plan are fingerprinted together.
Replaying the same snapshot returns the original receipt. This is a planning
and evidence API; Task Kernel authorization and dependency gates remain the
only authority for starting or closing Runs.

The active `parallel run` path plans only manifest candidates while retaining
their Parent's dependency context. It runs each planned wave, stores its
receipt fingerprint with the batch result, and still requires each Child's
approved Execute contract and valid worktree where applicable. A conflict
authorization without a schedule receipt and integration plan is rejected.
Direct bridge reservations do not get a count cap; they still require an
eligible Task and reject active write collisions unless the same verified
receipt authorizes the pair.

Older `parallel_limit` and manifest `limit` values remain readable but no
longer constrain dispatch. Existing batch result files with
`concurrency_limit` remain readable as history; new results record the actual
`max_active`, schema version 2, and schedule receipt reference. The old
32-Child manifest ceiling is removed.

## Cost evidence

V2 Run estimates seed waiting, execution, and review estimates. Caller
`estimatedCosts` fill or override any component. Batch review buckets provide
coarse priors only when no Run review estimate or explicit `reviewMs` exists:
low = 60 seconds, medium = 5 minutes, high = 15 minutes. Supply numeric
`estimated_costs.reviewMs` for a project-specific value.

Observed waiting time comes from queued/start Kernel event timestamps,
execution time from Run start/completion events, and review time from Run
completion to review. Integration and rework times are derived from recorded
Parent task-map events. Missing or incomplete intervals remain `null`, with
evidence references retained alongside each snapshot.
