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
  Concrete paths are project-relative, normalized to `/` and NFC. On Windows,
  case is folded for conflict checks to match the default case-insensitive
  filesystem behavior; this may conservatively serialize paths inside a
  case-sensitive Windows directory. Empty legacy write sets are treated as
  unknown and conflict with every writer. A parent path overlaps each
  descendant. NFKC is not applied, so compatibility characters remain distinct.
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
Replaying the same snapshot returns the original receipt. Planning never
mutates Task or Run state. The separate V2 admission gate below rechecks Kernel
authorization and hard dependencies before reserving a writer; Task Kernel
lifecycle remains the authority for Run result and closure.

The active `parallel run` path plans only manifest candidates while retaining
their Parent's dependency context. It runs each planned wave, stores its
receipt fingerprint with the batch result, and still requires each Child's
approved Execute contract and valid worktree where applicable. A conflict
authorization without a schedule receipt and integration plan is rejected.
Direct bridge reservations do not get a count cap; they still require an
eligible Task and reject active write collisions unless the same verified
receipt authorizes the pair.

### Standalone V2 dispatch admission and writer leases

Planning is not dispatch permission. A host adapter should create a schedule
receipt for the intended V2 candidates, then acquire one project-level lease
for the specific Task/Run immediately before starting a writer:

```ts
import {
  scheduleTaskKernelGraph,
  acquireTaskKernelRunDispatchV1,
  assertTaskKernelRunDispatchLeaseV1,
  bindTaskKernelRunDispatchOwnerV1,
  validateTaskKernelRunDispatchStopProofV1,
  releaseTaskKernelRunDispatchV1,
} from "@blxzer/pactile/scheduler";

const schedule = scheduleTaskKernelGraph(projectRoot, [taskId]);
const admission = acquireTaskKernelRunDispatchV1(projectRoot, {
  scheduleReceiptFingerprint: schedule.receipt.receiptFingerprint,
  taskId,
  runId,
  owner: { host: "pi", role: "implement", sessionId: null,
    threadId: null, hostId: null },
});
if (!admission.permitted) throw new Error(admission.receipt.reasonCodes.join(", "));
```

`[taskId]` includes its recursive V2 dependency closure in the plan. Admission
re-reads the Task Kernel and every hard dependency immediately before dispatch;
the scheduler's modeled later wave never counts as a prerequisite Run being
closed. The current Run must be waiting/running, authorized, present in the
fingerprinted plan, and retain the same write set. The project lease joins the
Run write set and optional workspace write set and reserves it across both V2
and legacy Parent lease folders. Every colliding active writer is checked;
each one must have an exact pair authorization in the same schedule receipt,
including approver, evidence reference, and integration plan.

An adapter should acquire with its stable owner identity before native create
(native session/thread/process identifiers may initially be null), then call
`bindTaskKernelRunDispatchOwnerV1` only after the Task Run has persisted its
`run.host-bound` event and references. `assertTaskKernelRunDispatchLeaseV1`
checks the still-active lease before follow-up sends. A native wait may use
`allowSettled: true` after the Task Run has settled; the writer lease remains
active until the adapter has verified the stop proof. Owner binding is
monotonic and content-addressed.

`validateTaskKernelRunDispatchStopProofV1(projectRoot, { leaseId, taskId,
runId, stopReceiptRef })` is a read-only gate. It verifies the content-addressed
proof and all referenced source records, the current latest Task/Run, the
schedule and admission receipts, the owner binding, and that the reserved
write set still covers the Run. `releaseTaskKernelRunDispatchV1` repeats that
validation under the project mutex before archiving the lease. It accepts only
these stop sources:

- `source: "codex-bridge"`: a self-fingerprinted Codex request and normalized
  receipt. A terminal proof requires `wait_threads`, `desktop-native`,
  `outcome: "ok"`, `status: "completed"`, and a non-stale contract. A
  `not-created` proof requires a failed native `create_thread` receipt with an
  explicit `thread_creation_state: "not_created"` and no created IDs.
- `source: "pi-host"`: `request_ref` points to the parsed
  `PiHostStartReceipt`; its `request_fingerprint` is
  `fingerprintTaskValue(startReceipt)`. `native_receipt_ref` points to the Pi
  Run JSON and `native_receipt_fingerprint` is
  `fingerprintTaskValue(run.process_stop_receipt)`. The validator checks the
  Task/Run/session/process/start request identity, Kernel Host request/event/
  result refs, `manager-owned-child-exit`, terminal `exited` or `cancelled`,
  and `processExit.terminationVerified === true` with an observed exit time.

Both proof variants use `proof_fingerprint = fingerprintTaskValue(proof minus
proof_fingerprint)`. Required proof fields include `source`, the exact owner
identity (`host`, `role`, `session_id`, `thread_id`, `host_id`,
`start_request_id`, `process_id`), schedule/admission fingerprints, request and
native receipt references plus fingerprints, disposition, and
`writer_exited: true`. `request_ref`, `native_receipt_ref`, and the proof ref
are project-root-relative paths; the proof filename must be
`<proof_fingerprint>.json`. Pi stop proofs use
`.pactile/tasks/<slug>/pi-bridge/dispatch-proofs/`; Codex proofs use
`.pactile/tasks/<slug>/codex-bridge/dispatch-proofs/`.

Unknown process exit or missing/invalid stop evidence keeps the lease active
for reconciliation. Task completion and Task closure remain separate lifecycle
gates; a verified failed/cancelled host stop proves only that the writer is no
longer active.

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
