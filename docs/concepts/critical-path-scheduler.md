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
  case-sensitive Windows directory. On Windows, ASCII colons in any write-set
  path segment are rejected to prevent NTFS alternate data stream aliases;
  POSIX filenames may retain colons. Empty legacy write sets are treated as
  unknown and conflict with every writer. A parent path overlaps each
  descendant. NFKC is not applied, so compatibility characters remain distinct.
- Overlapping writers are serial by default. A new parallel-overlap
  authorization requires an exact Task pair, approver, authorization evidence
  reference, a named integration owner, and a non-empty integration plan. The
  decision and active leases retain these references. The caller remains
  responsible for verifying the authority behind the recorded evidence.
  Historical authorization records without an integration owner remain
  readable, but cannot authorize a newly planned or revalidated overlapping
  dispatch; renew the authorization with an owner first.
- There is no fixed numeric concurrency cap in the scheduler or active Parent
  dispatch path. The scheduler dispatches a compatible group together only
  when its estimate finishes sooner than the serial equivalent. Integration
  and review remain serial costs in the model, and Parent integration remains
  manual and serial (`merge_limit: 1`). Review cost is a weight, not a hard
  prohibition on parallel execution.
- Optional Jev advice requires an evidence reference and only breaks ties
  between equal critical-path costs. It cannot make a blocked Task ready,
  satisfy a dependency, or permit a write-set conflict.
- A persisted receipt fixes the task-to-wave assignment. Dispatch rechecks
  Kernel state, hard dependencies, leases, and host-stop evidence before
  progressing, but it does not adaptively reorder remaining work between
  waves. Jev remains limited to its eligible first-wave tie-break.

## Jev scheduling advice and P37 boundary

`scheduleParentTaskGraphWithJevV1` is the public asynchronous Parent scheduler
entry point for an optional Jev tie-break. It first computes the deterministic
preview and selects only the first-wave candidates that share the highest
critical-path value. Before asking Jev, it verifies each candidate's current
Execute approval with `approvedTask`, its configured execution location with
`piWorkdir`, and the active Parent/V2 write leases under the P37 project
mutex. Hard dependencies, candidate state, and write-set compatibility remain
the deterministic planner's responsibility.

The request contains at most 16 anonymous labels and numeric critical-path /
estimated-cost values. The bounded synthetic summary omits Task IDs, project
paths, Child write sets, user-authored task text, and source snippets because
none is needed to break this tie. Egress still requires the explicit Jev
facade options and project authorization accepted by the Jev transport. The
16-candidate bound limits one advice request; it is not a dispatch or
concurrency limit.

After Jev responds, the API rebuilds the planning snapshot and repeats the
approval, worktree, and active-lease checks. It uses the advice only when the
hard-gate snapshot and eligible tie group still match. It then writes one
content-addressed final schedule receipt with `jevAdviceAudit`. The audit keeps
`preparedRequestSnapshot` for the candidate IDs and digest given to the Jev
facade, `sentRequestSnapshot` only when transport reports an HTTP attempt, and
`finalEligibleCandidates` for the approval, worktree, and lease recheck used by
the final receipt. A fallback or superseded answer therefore retains the
request-time candidates and digest even when the final eligible set changed.
The audit also records suggested/adopted/overridden order, the change flag,
reason code, and available latency/transport metrics. It does not store the
provider-reported `first_task` confidence, marked unavailable when omitted or
invalid. It does not infer confidence from the selected order, request text,
provider key, raw errors, or request ID. If approval, worktree,
dependencies, conflicts, leases, or the candidate group changes during the
request, the answer is marked superseded and the final receipt uses the
deterministic plan.

Missing/disabled configuration, denied egress, detected sensitive content,
cancellation, deadline, provider failure, invalid response, or low confidence
leaves the deterministic plan in force with an explained audit status. This
advice API does not create a writer lease. P37 admission must still validate
the final receipt and re-read the Kernel, hard dependencies, approvals, and
active leases immediately before dispatch. A persisted receipt or lease is
never rewritten after that point.

## Standalone V2 Task scheduling advice

`scheduleTaskKernelGraphWithJevV1` applies the existing Jev tie-break to a
standalone Task Kernel v2 plan. It builds the deterministic plan first, then
offers Jev only the eligible Run candidates in the first wave that share the
highest critical-path value. A candidate must still be the current Task Kernel
revision, have its latest Run waiting with valid authorization evidence, pass
the Run-start lifecycle gate, carry a known Run write set, have a clean manager-owned
Run worktree at its recorded base, and have no active project write-lease
conflict. The planner remains authoritative for hard dependencies, write-set
conflicts, and wave placement; Jev can only suggest an order within that
eligible first-wave tie. Tasks assigned to later waves, including tasks held
behind dependencies or overlapping writers, are outside the Jev candidate set
even when their modeled critical paths tie.

The V2 request uses the shared Jev `task-scheduling` node with at most 16
anonymous labels and numeric cost values. Task IDs, paths, Run evidence, and
Task-authored text are not sent. The request digest and candidate binding are
kept in the V2 receipt, together with prepared/sent snapshots, final eligibility,
the suggestion, adopted or overridden order, and bounded transport metrics.
The receipt envelope fingerprint binds this audit to the plan. Project
`.pactile/config.yaml` `jev.egress: deny`, invalid YAML, or an invalid `jev`
egress setting is checked by the public scheduler API before advice is requested
and again after its asynchronous response. A denied or invalid policy before a
request short-circuits before transport; a policy that changes to denied or
invalid while Jev is responding rejects the answer and retains the deterministic
plan. The receipt keeps the bounded policy states at schedule start, before the
advice request, and after the response. A missing `jev.egress` setting keeps the
existing project-policy default. Missing/disabled Jev configuration, timeout,
provider failure, invalid response, or low confidence likewise leaves the local
deterministic order in force.

The asynchronous V2 plan entry point is `runTaskSchedulePlanCliAsync(args,
root)` from the task-schedule command module. The synchronous
`scheduleTaskKernelGraph` and `runTaskScheduleCli` interfaces remain available
for existing callers. Jev advice does not start a Run, weaken approval or
dispatch eligibility, authorize a write-set overlap, or perform Review or Close;
P37 admission must still re-read current Task Kernels, dependencies,
authorizations, and leases immediately before dispatch.

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

The optional Jev-aware entry point is asynchronous and writes only the final
receipt after its second gate check:

```ts
import {
  createJevDecisionFacadeV1,
  scheduleParentTaskGraphWithJevV1,
} from "@blxzer/pactile";

const result = await scheduleParentTaskGraphWithJevV1(
  projectRoot,
  parentTaskRef,
  { estimatedCosts },
  { facade: createJevDecisionFacadeV1(approvedJevConfig), egress: approvedEgress },
);
console.log(result.receipt.plan.waves, result.receipt.jevAdviceAudit);
```

The existing synchronous `scheduleParentTaskGraph` remains deterministic.
Jev can suggest only an ordering among equal critical-path candidates; it does
not choose or grant an execution role, authorize a Task, alter Kernel gates,
change conflict policy, or impose a concurrency ceiling.

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

### P34 coverage status

| P34 surface | Status in this slice |
| --- | --- |
| Parent V1 async API, same-critical-path tie-break, immutable final receipt and audit | Implemented and covered by focused tests. |
| Parent V1 approval, configured worktree, active lease, and post-response eligibility recheck | Implemented with existing validators and covered by positive/negative tests. |
| Standalone V2 waiting-Run, authorization, manager-owned worktree, write-set, active lease, and post-response snapshot recheck | Implemented in `scheduleTaskKernelGraphWithJevV1`; covered by focused positive/negative tests. |
| Project `jev.egress` deny/invalid zero-transport fallback, post-response drift rejection, and bounded fingerprint-bound V2 receipts | Implemented and covered by direct-library and CLI/scheduler tests; no live Jev service call was made. |
| No-key, timeout, service error, low-confidence, and privacy-safe input fallback | Parent V1 is covered with facade/transport stubs; the shared V2 advice API uses the same transport and bounded summary contract. |
| `parallel run` / Pi / Codex Host dispatch wiring before P37 admission | Not connected. The current CLI batch path still calls synchronous `scheduleParentTaskGraph`; Host wiring remains a separate P34 node and was intentionally kept outside this slice. |
| Jev execution-role recommendation | Not implemented here. This slice only breaks equal critical-path ordering ties. |

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
including approver, evidence reference, named integration owner, and integration
plan. A historically fingerprint-valid receipt without an owner remains readable
as history, but cannot authorize a new overlapping V2 admission or direct Parent
lease; V2 admission reports
`project-write-set-conflict-integration-owner-missing` for this rejection.

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

`compareTaskKernelWaveDispatchV1` accepts a paired serial-control and scheduled
wave result for the same Task/worktree workload. It rejects mismatched task
sets, dependencies, write sets, estimates, conflict authorizations, wave
placement, worktree base commit, Run input/write-set/authorization digest,
actual prompt digest, or provider configuration digest. Both provider dispatches
and every scheduled Run must be complete. Set `serialControl: true` only for
the control measurement. It runs eligible Tasks sequentially inside each
already-planned wave. Normal dispatch has no numeric concurrency cap and
continues to execute each planned wave together.

The comparison keeps three evidence classes separate:

- `estimates` sums the scheduler's candidate serial and planned wave estimates.
- `measured` records actual dispatch wall time and the caller-measured end-to-end
  wall time. The end-to-end interval should begin just before plan creation and
  end after the same Review, rework, and integration observation steps for both
  scenarios.
- `observedLifecycleCosts` measures waiting from the Kernel `run.queued` event
  to dispatch runner start, execution from per-Run wall time through verified
  host stop, Review from Task Kernel completion to the latest Review, and rework
  / integration from Parent task-map events. Each field reports coverage and
  evidence references; a partial field remains `null`. Review time is
  completion-to-latest-Review and may include time spent in rework, so the
  observed cost fields are not additive components of total elapsed time.

The paired test uses the checked-in fake Pi RPC process and simulated Review /
Parent lifecycle events. Its provider label and test report explicitly say
simulation; it is a reproducible scheduler comparison, not a real Pi-provider
speedup, production measurement, or provider-acceptance result.

The local report at
`packages/cli/test/evidence/p37-v2-paired-fake-pi.json` retains both scenarios'
Run inputs, prompts, provider fixture hashes, identical worktree base SHAs,
schedule and admission receipts, dispatch-to-Run IDs, Kernel / Pi stop proof /
provider-start evidence, Parent task-map ledger, observed cost values, and the
comparison with SHA-256 checksums. Wall-clock end-to-end measurements cover
planning through fake-Pi stop and the same simulated Review / rework / integration
steps in both scenarios. Lifecycle values come from the fixture's recorded
Kernel and Parent events; they are observed ledger values for this controlled
simulation, not claims about a live project's duration. Negative dispatch or
end-to-end savings are retained as measured.

To repeat the controlled sample from a clean source worktree without overwriting
the checked-in report, choose a new output path:

```powershell
$env:PACTILE_RECORD_P37_V2_MEASUREMENT = "1"
$env:PACTILE_P37_MEASUREMENT_OUTPUT = "$env:TEMP\p37-v2-paired-fake-pi-rerun.json"
pnpm --filter @blxzer/pactile exec vitest run test/pactile/scheduler/task-kernel-wave-dispatch.test.ts -t "compares measured serial control"
Remove-Item Env:PACTILE_RECORD_P37_V2_MEASUREMENT
Remove-Item Env:PACTILE_P37_MEASUREMENT_OUTPUT
```

The writer refuses to overwrite an existing report and requires a clean source
worktree so it can bind the result to a source commit and tree. The emitted
report checksum covers the serialized JSON, while `reportSha256` in the file
covers the report body without that field; `comparisonSha256` covers the
comparison object. The runner compares same-workload measurements and does not
assert that V2 waves must be faster.
