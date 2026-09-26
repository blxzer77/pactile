# Task Workflow

> Human overview only, not runtime SSOT. The unified Task Kernel reader determines the stored schema. For a V2 Task, `kernel.json` is the source of lifecycle state, definition, Runs, candidate snapshots, Reviews, dependencies, and Close history.

## V2 Task contract

A V2 Task is one reviewable deliverable. Its Kernel definition records:

- the deliverable;
- measurable acceptance criteria (ACs);
- one delivery level: `local-result`, `pull-request`, `merged-result`, or `documentation`;
- hard dependency Task IDs. Every dependency must close successfully before this Task may start or close.

Create a Task only after the user agrees to its proposal. Kernel V2 begins at Define; do not project V1 `task.json` phases onto a V2 Task.

## Runs, scheduling, and Review

A Task may have multiple Runs. Each attempt preserves its authorization, write-set snapshot, estimates and measurements, outcome, and (on completion) candidate snapshot. Retrying creates a new Run; it does not overwrite earlier evidence. The latest recorded Run must be completed and is the only one eligible for Review and Close.

Reviews are independent records bound to one Run and exact candidate ID/fingerprint. Close must use the latest Review for that candidate, and that verdict must pass with no blockers and evidence for every AC. If a new Run produces a new candidate, review that candidate separately.

Schedule work for completion-time benefit, subject to hard dependencies, authorization, and write conflicts. There is no fixed numeric concurrency cap. Overlapping write sets are sequential by default; explicit overlap needs recorded authorization and an integration plan. A scheduler suggestion cannot override Kernel gates or write-conflict admission.

## V2 command surface

Use the current Task commands for the stored V2 Kernel: `pactile task create`, `add-dependency`, `run-start`, `run-resume`, `run-result`, `review`, and `close`. Run `pactile task --help` for current arguments. The V2 flow does not use the V1 `start-execution` or directory-archive command.

At Close, the delivery evidence level must equal the definition. `pull-request` and `merged-result` require an HTTPS reference; the other levels still require a nonempty evidence reference and summary. A mismatched level, unmet hard dependency, stale candidate, incomplete AC evidence, or a non-passing latest Review keeps the Task open.

## Compatibility boundary: explicit V1 legacy Tasks

The unified reader preserves existing legacy state and identifies it as V1; do not migrate it by merely editing this overview. Only when the reader identifies a V1 legacy Task should its V1-specific artifacts and commands be considered. For that legacy path, `pactile task start-execution <task> --approved` records the caller's approval declaration, and `pactile task archive <task>` performs the legacy close/archive operation. These commands and the `--approved` flag are not V2 instructions. A CLI flag does not authenticate the caller; human authorization must come from the actual authorized interaction and its evidence.

## Session status hints

The following blocks are compatibility hints for legacy V1 `task.json` status injection. They are not V2 Kernel phase instructions. V2 session guidance comes from the selected Task's compiled Session Pack and Kernel snapshot.

[workflow-state:no_task]
No task is selected. This is a legacy status hint only; the V2 Session Pack determines whether a V2 Task is selected.
[/workflow-state:no_task]

[workflow-state:planning]
Legacy V1 only: the task is in planning. Use its V1 artifacts and compatibility flow; do not apply this hint to a V2 Kernel Task.
[/workflow-state:planning]

[workflow-state:in_progress]
Legacy V1 only: the task is in progress. Its V1 artifacts remain the execution boundary; do not apply this hint to a V2 Kernel Task.
[/workflow-state:in_progress]

[workflow-state:review]
Legacy V1 only: verification is pending under that task's legacy contract. V2 Review must bind to the exact candidate recorded in its Kernel.
[/workflow-state:review]

[workflow-state:completed]
Legacy V1 only: the task is complete under its recorded legacy lifecycle. A directory move is not a V2 Close.
[/workflow-state:completed]
