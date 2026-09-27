# Local Task System

The Pactile task system is stored entirely under `.pactile/tasks/` in the user project. Each task is a directory containing requirements, context, research, state, and relationship information.

## Task Directory Structure

```text
.pactile/tasks/
├── 04-28-example-task/
│   ├── task.json
│   ├── prd.md
│   ├── design.md
│   ├── implement.md
│   ├── implement.jsonl
│   ├── check.jsonl
│   └── research/
└── archive/
    └── 2026-04/
```

| File | Purpose |
| --- | --- |
| `task.json` | Task metadata: status, assignee, priority, branch, parent/child tasks, and similar fields. |
| `prd.md` | Requirements, constraints, and acceptance criteria. Lightweight tasks may be PRD-only. |
| `design.md` | Technical design for complex tasks: boundaries, contracts, data flow, compatibility, tradeoffs. |
| `implement.md` | Execution plan for complex tasks: ordered checklist, validation commands, review gates, rollback points. |
| `implement.jsonl` | List of spec/research files the implement agent must read first. |
| `check.jsonl` | List of spec/research files the check agent must read first. |
| `research/` | Research artifacts. Complex findings should not live only in chat. |

## `task.json`

`task.json` records task status and metadata. Common fields:

| Field | Meaning |
| --- | --- |
| `id` / `name` / `title` | Task identity and title. |
| `status` | Status such as `planning`, `in_progress`, `review`, or `completed`. |
| `priority` | `P0`, `P1`, `P2`, `P3`. |
| `creator` / `assignee` | Creator and assignee. |
| `package` | Target package in a monorepo; may be empty. |
| `branch` / `base_branch` | Working branch and PR target branch. |
| `children` / `parent` | Parent/child task relationships. |
| `commit` / `pr_url` | Commit and PR information after completion. |
| `meta` | Extension fields. |

## Parent / Child Task Trees

Parent/child task relationships describe work structure. A parent groups related deliverables under one requirement set and does not replace each child's planning artifacts. Ordering is declared separately with Kernel `requires` dependencies.

Use a parent task when a request has multiple independently verifiable deliverables. The parent owns:

- Source requirements and user-facing scope.
- The map of child tasks and their responsibility boundaries.
- Cross-child acceptance criteria and final integration review.

Use child tasks for deliverables that can move through planning, implementation, check, and archive independently. If one child depends on another, declare it with `pactile task set-deps <child> <dependency>` and explain it in the child plan. Tree position does not imply ordering. `depends_on` becomes a Kernel hard `requires` edge and blocks execution by default until satisfied. `--ignore-deps` on `start-execution --approved` records an explicit user-approved override; it does not mark the dependency satisfied.

Create new children with:

```bash
pactile task create "<child title>" --slug <child-slug> --parent <parent-dir>
```

Link or unlink existing tasks with:

```bash
pactile task add-subtask <parent-dir> <child-dir>
pactile task remove-subtask <parent-dir> <child-dir>
```

`children` on the parent is a historical list. When a child is archived, Pactile keeps that child name in the parent so progress like `[2/3 done]` remains meaningful after completed children move to `archive/`.

The AI should not treat phase numbers as task status. Task progress is mainly determined by `status`, artifact presence (`prd.md`, optional `design.md` / `implement.md`), whether JSONL context is configured for sub-agent mode, and the phase descriptions in `workflow.md`.

## Selected Task

The user sees a "selected task," and Pactile stores that selection per live session.

```text
.pactile/.runtime/sessions/<context-key>.json
```

`pactile task select <task>` writes the task path into the runtime session file for the current session. `pactile task selected --source` shows the selected task and where it came from. Different AI windows can point to different tasks without overwriting each other.

If the platform or shell environment has no stable session identity, `pactile task select` may be unable to set the selected task. The AI should read the error, inspect the platform hook/session environment, and not fall back to a shared global pointer.

## JSONL Context

`implement.jsonl` and `check.jsonl` are context manifests for the executing and checking agent to read first. They do not replace `implement.md`; `implement.md` is the human-readable execution plan.

Format:

```jsonl
{"file": ".pactile/spec/cli/backend/index.md", "reason": "Backend conventions"}
{"file": ".pactile/tasks/04-28-example/research/api.md", "reason": "API research"}
```

Rules:

- Include spec and research files.
- Do not include code files that are about to be modified.
- Do not treat temporary conclusions in chat as the only context.
- Default seed rows point to existing guides; curate them for the task.

## Common Commands

```bash
pactile task create "<title>" --slug <slug>
pactile task dashboard
pactile task select <task>
pactile task selected --source
pactile task start-execution <task> --check
pactile task start-execution <task> --approved
pactile task set-deps <task> <required-task-id>
pactile task create "<full title>" --slug <slug> --rigor full
pactile task record-ac-evidence <task> --map AC-1=verify.md#evidence --code-ref <tested-code-ref>
pactile task record-independent-check <task> --mode self-review --result PASS --evidence verify.md#check --code-ref <tested-code-ref>
pactile task record-gate <task> --transition full-task-complete --gate code-review --result PASS --reviewer <id> --evidence verify.md#review
pactile task add-context <task> implement <file> <reason>
pactile task validate <task>
pactile task exit
pactile task archive <task>
```

When modifying the task system, use Pactile CLI commands to maintain structure. Edit JSON/Markdown directly only when the CLI does not cover the need.

## Local Customization Points

| Need | Edit location |
| --- | --- |
| Change the default task template | `.pactile/tasks/locale/` templates and Pactile CLI Node implementation. |
| Change status semantics | `.pactile/workflow.md`, workflow-state hook logic, and task usage conventions. |
| Add task lifecycle actions | `hooks.after_*` in `.pactile/config.yaml`. |
| Change context rules | Planning artifact guidance in `.pactile/workflow.md` and related platform agent/hook instructions. |
| Change archive policy | Pactile CLI Node implementation. |

These are local files in the user project. Do not default to editing Pactile CLI source code unless the user wants to contribute upstream.
