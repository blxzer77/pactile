# Change Local Workflow

When the user wants to change Pactile phases, next-action hints, whether to create tasks, whether to use sub-agents, or when to check/wrap up, edit `.pactile/workflow.md` first.

## Read These Files First

1. `.pactile/workflow.md`
2. Entry files for the current platform, such as skills/commands/prompts/workflows
3. The selected task's `task.json` and `prd.md`

## Common Needs And Edit Points

| Need | Edit point |
| --- | --- |
| Change phase names or phase order | `Phase Index` and the corresponding Phase sections. |
| Change whether to create a task when there is no task | `[workflow-state:no_task]` state block. |
| Change the next step during planning | Phase 1 and `[workflow-state:planning]`. |
| Change whether an agent is required during in_progress | Phase 2 and `[workflow-state:in_progress]`. |
| Change wrap-up after completion | Phase 3 and `[workflow-state:completed]`. |
| Change which skill a user intent triggers | `Skill Routing` table. |

## Modification Steps

1. Find the relevant section in `.pactile/workflow.md`.
2. When changing rules, keep explicit trigger conditions and next actions.
3. If adding or renaming a skill/agent, synchronize the corresponding files in platform directories.
4. Workflow-state changes only need an edit to the `[workflow-state:STATUS]` block in `.pactile/workflow.md`. The hook is parser-only — it reads whatever you put in the block. Keep the opening and closing tags' STATUS strings identical (`[workflow-state:foo]…[/workflow-state:foo]`); mismatched STATUS pairs are silently dropped.
5. Make the AI reread `.pactile/workflow.md`; do not keep using rules from the old conversation.

## Example: Relax Task Creation Requirements

To change when task creation can be skipped, usually edit `[workflow-state:no_task]`:

```md
[workflow-state:no_task]
Task is not required when the answer is a one-reply explanation, no files are changed, and no research is needed.
[/workflow-state:no_task]
```

If the formal Phase 1 flow also needs to change, synchronize the Phase 1 section.

## Example: One Platform Does Not Use Sub-Agents

If the user wants only one platform to avoid sub-agents, first confirm whether that platform has a separate group in the workflow. Then change Phase 2 routing for that platform group instead of deleting all `pactile-implement` / `pactile-check` instructions across platforms.

## `pactile-continue` Route Table

`pactile-continue` (the continue skill; legacy projects may still invoke it as the `/pactile:continue` slash command) resumes a task by deciding which phase step to load next. The decision combines `task.json.status` with the presence of artifacts inside the task directory. The mapping is fixed in the skill itself; forks that add custom statuses must extend both the workflow.md tag block and this table.

| `status` | Artifact state | Resume at |
| --- | --- | --- |
| `planning` | `prd.md` missing | Phase 1.1 (load `pactile-brainstorm`) |
| `planning` | lightweight task with `prd.md` complete | run `task.py start-execution <task> --check`, ask for explicit execution approval, then run `--approved` |
| `planning` | complex task missing `design.md` or `implement.md` | complete missing planning artifacts |
| `planning` | complex task has `prd.md`, `design.md`, and `implement.md` | run `task.py start-execution <task> --check`, ask for explicit execution approval, then run `--approved` |
| `in_progress` | no implementation in conversation history | Phase 2.1 (`pactile-implement`) |
| `in_progress` | implementation done, no `pactile-check` run | Phase 2.2 (`pactile-check`) |
| `in_progress` | check passed | Phase 3.1 (verify quality + spec update) |
| `completed` | task is still in active tree | Phase 3.5 (run `pactile-finish-work` to archive) |

When you add a custom status (e.g. `in-review`), add a `[workflow-state:in-review]` block in `.pactile/workflow.md` for the per-turn breadcrumb AND extend the project-local `pactile-continue` entry under `.agents/skills/` if one exists. Without a route entry, the resume flow may fall through to a default branch.

## Notes

`.pactile/workflow.md` is the local project workflow, not an immutable template. The user can adapt it to team habits. After editing it, platform entry files may still contain old descriptions, so inspect them too.
