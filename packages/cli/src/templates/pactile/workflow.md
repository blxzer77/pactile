# Development Workflow

> **Human overview — not runtime SSOT.** Gates, Rigor, Topology, and Task state are Kernel / `task.json` projections. Do not parse this document as the runtime program of record.

## Interfaces

Constraints live in artifacts and Kernel records:

| Interface | Role |
| --- | --- |
| `prd.md` | Definition and acceptance |
| `implement.md` | Execution / verification contract (when present) |
| `verify.md` | Evidence (when recorded) |
| `task.json` | Status and metadata (accounting) |
| `kernel.json` | Audit chain |
| `pactile task archive` | Close: `status=completed`, Kernel audit, notes projection |

## User commands

- `pactile-continue` — resume the selected task. Details: `.pactile/framework/index.md`.
- `pactile-finish-work` — closeout / archive path. Details: `.pactile/framework/index.md`.
- `pactile-handoff` — session handoff (reports a temp path). Details: `.pactile/framework/index.md`.
- `pactile-start` — only when the framework needs a refresh and no task is selected.

## Gates

- **Execute:** `pactile task start-execution <task> --approved` (`--check` is preflight only; it does not impersonate approval).
- **Close:** `pactile task archive <task>` — writes `completed`, Kernel audit, and notes projection.

## Pointers

Start at `.pactile/framework/index.md`. Do not expand methodology here.

- Parallel first → `.pactile/framework/parallel-first-execution.md`
- Full Quality / graded verify → `.pactile/framework/verification-strength-guide.md`
- Retrieval → `.pactile/framework/retrieval-daily-guide.md`
- Codex task dispatch → `.pactile/framework/codex-worker-dispatch.md` (manual until its desktop bridge is implemented)
- Pi Agent dispatch → `pactile pi run <task> --role implement --prompt-file <file>` (requires recorded Execute approval)

<!--
  Codex/Claude UserPromptSubmit parses [workflow-state:STATUS] blocks.
  Bodies are status facts (1–2 sentences), not process teaching.
  STATUS charset: [A-Za-z0-9_-]+
-->

[workflow-state:no_task]
No task is selected.
This status is an accounting fact, not a step list.
[/workflow-state:no_task]

[workflow-state:planning]
Selected task status is `planning`.
Constraints are `prd.md` and optional `design.md`/`implement.md`; Execute starts only after `pactile task start-execution --approved`.
[/workflow-state:planning]

[workflow-state:in_progress]
Selected task status is `in_progress`.
Implement against the approved artifacts; Close is `pactile task archive` (Kernel audit plus notes projection).
[/workflow-state:in_progress]

[workflow-state:completed]
Task status is `completed`.
`pactile task archive` writes this status in the same call that moves the directory.
[/workflow-state:completed]
