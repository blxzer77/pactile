# Task system

English | [简体中文](task-system.zh-CN.md)

Pactile tasks turn work that must survive a conversation into durable, reviewable project state under `.pactile/tasks/`. Artifacts explain the requirement and Evidence; Kernel records own the phase transitions and audit chain.

## Task Kernel v2: default for new Tasks

`pactile task create` creates a Task Kernel v2 record in `kernel.json`. The Task is a declared deliverable with acceptance criteria and one delivery level: `local-result`, `pull-request`, `merged-result`, or `documentation`. New Tasks do not get Lite/Full or Parent/Child kinds. A hard dependency is an explicit `--depends-on <task-id>` edge.

The v2 `kernel.json` is the only writable lifecycle authority. It contains the Task definition, revisioned events and audit, all Runs, all Reviews, and the Close record. V2 creation does not write a parallel `task.json` status. `task list`, `show`, `selected`, context, and session-pack readers accept both v2 and legacy records, so selection does not hide a newly created Task.

The command path is host-neutral and works without Codex, Pi, or a resident service:

```bash
pactile task create "Search result" --slug search-result \
  --deliverable "A tested local result" --delivery-level local-result \
  --accept AC-1="The result satisfies the requested behavior"
pactile task run-start search-result --actor alice \
  --input-summary "Implement AC-1" --approved-by alice \
  --authorization-scope "the declared deliverable" --authorization-evidence approval.md
pactile task run-result search-result <run-id> --outcome completed \
  --summary "Result produced" --candidate src/result.ts=<sha256>
pactile task review search-result --actor reviewer --run <run-id> \
  --candidate-id <snapshot-id> --candidate-fingerprint <sha256> \
  --reviewer reviewer --decision pass --evidence review.md \
  --criterion AC-1=src/result.ts
pactile task close search-result --run <run-id> --review <review-id> \
  --candidate-id <snapshot-id> --candidate-fingerprint <sha256> \
  --candidate-observed-by reviewer --candidate-observation-source declared \
  --candidate-observation-ref observation.md --delivery-level local-result \
  --delivery-ref src/result.ts --delivery-summary "Reviewed result is present"
```

A Run is one isolated attempt. Runs preserve their input, explicit authorization, attempt number, write-set snapshot, optional host/session receipts, optional worktree identity, candidate snapshot, result or failure, and optional timing evidence. A waiting or blocked Run is not Closed; a later retry adds another Run and keeps the earlier record. Host, worktree, and scheduler fields are optional data, not resident services.

A Review is tied to one completed Run and the candidate snapshot ID and fingerprint. A passing Review needs evidence references for the Review and every declared acceptance criterion, zero unresolved blockers, and a reviewer different from both the Run executor and approver. Multiple Reviews remain in history; Close must use the latest Review for the latest Run candidate. A bridge receipt such as `Pi settled` does not create a passing Review.

Close is committed through `closeTaskKernel`, the same Core API used by the CLI. It checks that the Task is in Verify, its latest Run completed, the latest Review passes and matches that candidate, every hard dependency is Closed successfully, acceptance evidence exists, and delivery evidence uses the Task's declared level. For `local-result` and `documentation`, Core re-observes a current regular file inside the Run write set and binds its bytes to the candidate. For `pull-request` and `merged-result`, Core requires a Git candidate and uses its read-only GitHub `gh api` observer; a caller-supplied HTTPS URL alone is not proof. `pull-request` requires provider-confirmed open, non-draft state at the candidate HEAD. `merged-result` additionally requires provider-confirmed merge state, the merge commit in the local target branch's ancestry, and matching delivery bytes on that branch. Unsupported or unavailable provider facts block Close.

The candidate ID and fingerprint supplied to Close must match the latest frozen Run snapshot, but caller-supplied observer details are not the freshness proof: Core re-observes current candidate state and records its own observation. For Git Runs, the observer checks HEAD, branch, Git-reported staged, unstaged, untracked, conflicted and committed paths, and bounded file fingerprints for changed write-set paths and exact write-set files. For non-Git Runs, it re-scans the bounded project-file snapshot. This is not a claim about every byte on disk: Git's untracked-path discovery uses `--exclude-standard`, and the non-Git observer omits its configured excluded paths and enforces file, path, and byte limits. Review and acceptance evidence is also reopened and fingerprinted at Close against the recorded Review verification. A pure `readTaskKernel` reader and `projectTaskKernelLifecycle` projection expose recorded state without triggering these observations; the projection is read-only guidance, while each mutation remains the final gate authority.

0.5.x Kernel v1 and `task.json` records remain readable and keep their legacy commands. V2 does not migrate them on read. `pactile task legacy-create` is the explicit compatibility path; automatic legacy migration is a separate P36 change.

The new `task create` contract requires `--deliverable`, `--delivery-level`, and at least one `--accept` criterion. The old `task create <title> --slug <slug>` form is intentionally not a V2 create path; use `task legacy-create` when an explicit 0.5.x Task is needed. This keeps new writes from silently receiving Lite/Full or Parent/Child presets.

Actor, approver, reviewer, and Run authorization fields are caller-declared: Core validates their shape and recorded relationships but does not authenticate identities or verify approval with an external host. The candidate ID/fingerprint in a Close request only binds the request to the selected Run; Core creates the current observation itself. Review and acceptance evidence references are resolved to bounded files and fingerprinted when the Review is recorded, then reopened and checked again at Close. PR state is checked only for supported GitHub repositories through the built-in read-only provider; this is not a generic PR-host integration.

## 0.5.x Kernel v1 records and commands

## Definition

A task is a directory of human-readable artifacts paired with a canonical machine record. The artifacts remain useful when a session is compacted or handed off, while the Kernel prevents an Agent or host integration from skipping approval, review, or close requirements.

## Responsibilities

- preserve definition, design, execution contract, and verification Evidence;
- record status and metadata in `task.json` as an accounting projection;
- validate phase transitions, gates, revisions, and idempotency through the Kernel;
- support lightweight work, full-quality work, and Parent/Child integration topology;
- close work into an archive without losing the final acceptance or audit trail.

## Boundary

A task is not a chat transcript, a replacement for project specs, or permission to execute merely because its directory exists. Creating or defining a task does not approve implementation. Selecting a task changes session focus, not canonical phase. `workflow.md` is a human interface card; the Kernel record and accepted artifacts remain authoritative.

## Durable surfaces

| Surface                           | Role                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `prd.md`                          | Definition, constraints, and acceptance criteria                                         |
| `design.md`                       | Technical boundaries and decisions when the task needs design depth                      |
| `implement.md`                    | Approved execution and verification contract when required                               |
| `verify.md`                       | Commands, outcomes, reviewed change set, final acceptance, and durable-learning decision |
| `implement.jsonl` / `check.jsonl` | Optional curated context manifests, not state authorities                                |
| `task.json`                       | User-facing status and task metadata accounting projection                               |
| `kernel.json`                     | Canonical phase, revision, gates, outcome, and atomic audit chain                        |
| `task-map.md`                     | Parent-owned Child dependency and integration ledger                                     |

Not every task needs every artifact. The active rigor and controls determine what is required; complex or public-contract work normally requires design, an execution contract, and independent review Evidence.

## Lifecycle

The Kernel models these host-neutral phases:

```text
Open -> Define -> Approve -> Execute -> Verify -> Integrate? -> Close
```

`Integrate` is optional for a single task and required when a Parent accepts Child work. Human-facing `task.json.status` remains a coarser projection such as `planning`, `in_progress`, or `completed`; consumers should not invent legal transitions from that field alone.

Two command boundaries are deliberately explicit:

```bash
pactile task start-execution <task> --check
pactile task start-execution <task> --approved
```

The first command is a read-only readiness preflight. With the second, the caller asserts that explicit approval was obtained; Pactile records the task ID, source, time, and current task and artifact fingerprints before starting Execute. The CLI does not verify the caller's identity, so `approved_by: user` is an assertion rather than authentication. The Kernel checks the approval and review evidence again at the final transition; a changed artifact or review blocks the start. Repeating the same approved start is safe. Likewise, `archive <task> --check` is a preflight, while `archive <task>` performs Close, writes completion and audit state, and moves the directory into the archive.

Bootstrap and onboarding tasks created by `pactile init` start in Planning. Init creates work lists; starting either task still follows the normal preflight and Execute approval path. Task creation publishes its directory only after the PRD and Kernel record are complete. A failed creation can be retried; an existing incomplete directory is reported for recovery rather than overwritten.

`pactile task set-deps <task> <required-task-id>` declares a Kernel hard `requires` edge. An unmet dependency blocks both preflight and execution by default. Only a completed task, checked from the Kernel in active or archived records, satisfies it; cancellation does not. `--ignore-deps` requires explicit user approval and records an override rather than claiming the dependency was satisfied. A valid override also applies to later Execute requests from optional hosts.

## Gates and Evidence

A gate result is accepted only for a known transition and reviewed Evidence. Its contract and artifact fingerprints prevent a stale review from being silently reused after the definition changes. Reviewer gates are recorded explicitly; they are not inferred from green tests or self-authored prose.

Before `start-execution --check` on a Full task, record the strategy's required `requirements-review` and, when applicable, `architecture-review` with `pactile task record-gate`. `--approved` consumes these results; it never writes a reviewer PASS. A FAIL, missing review, or stale fingerprint blocks the start.

Closeout Evidence normally identifies:

- validation commands and outcomes;
- acceptance-criteria results;
- manual or independent review notes;
- the exact reviewed change set or reference;
- a durable-learning decision: update a project spec, decline with a reason, or resolve one bounded uncertainty.

`pactile task prepare-archive-evidence <task>` drafts missing `verify.md` slots with `TODO` markers; those markers never pass the archive gate. `pactile task prepare-learning-scaffold <task>` prints a read-only spec decision checklist. For Child work, the Parent can inspect the handoff with `pactile task review-child <parent> <child> --check` before recording an acceptance or change decision.

## Parent and Child tasks

A Parent is an integration authority, not a container that automatically completes its Children. Each Child owns an independently definable and verifiable deliverable. The Parent owns cross-Child acceptance, dependency ordering, conflict decisions, and final integration Evidence.

```text
Parent
  +-- Child A: focused implementation -> Verify -> Parent review -> Integrated
  +-- Child B: focused documentation  -> Verify -> Parent review -> Integrated
  +-- Child C: integration smoke, depends on A and B
  `-- Parent: cross-slice review -> Close
```

Child-controlled states describe readiness for review. Only the Parent may accept, request changes, integrate, or cancel a Child. A filesystem move, shared worktree, or green test does not substitute for that integration decision.

## User scenario

A release candidate needs independent lifecycle, adapter, documentation, and dogfood slices. Each Child has a bounded write set and focused Evidence. The Parent integrates one reviewed slice at a time, then runs cross-slice checks. The final release suite remains a separate authorized gate; completing the release-candidate Parent cannot publish, tag, or merge by implication.

## What to inspect

- `prd.md`, `design.md`, and `implement.md` for the approved contract;
- `kernel.json` for canonical phase, gates, revision, and audit;
- `verify.md` for actual outcomes rather than planned checks;
- `task-map.md` and Parent review Evidence before treating Child output as integrated;
- archived task artifacts when reconstructing why a decision was accepted.

Continue with [Spec system](spec-system.md) and [Kernel, Evidence, and Trace](kernel-evidence-trace.md).
