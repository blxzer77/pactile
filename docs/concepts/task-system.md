# Task system

English | [简体中文](task-system.zh-CN.md)

Pactile tasks turn work that must survive a conversation into durable, reviewable project state under `.pactile/tasks/`. Artifacts explain the requirement and Evidence; Kernel records own the phase transitions and audit chain.

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

The first command is a read-only readiness preflight. The second records explicit approval and starts Execute. Likewise, `archive <task> --check` is a preflight, while `archive <task>` performs Close, writes completion and audit state, and moves the directory into the archive.

`pactile task set-deps <task> <required-task-id>` declares a Kernel hard `requires` edge. An unmet dependency blocks both preflight and execution by default. Only a completed task, checked from active or archived records, satisfies it; cancellation does not. `--ignore-deps` requires explicit user approval and records an override rather than claiming the dependency was satisfied.

## Gates and Evidence

A gate result is accepted only for a known transition and reviewed Evidence. Its contract and artifact fingerprints prevent a stale review from being silently reused after the definition changes. Reviewer gates are recorded explicitly; they are not inferred from green tests or self-authored prose.

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
