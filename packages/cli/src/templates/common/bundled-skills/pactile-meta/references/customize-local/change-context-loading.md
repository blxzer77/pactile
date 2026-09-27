# Change Local Context Loading

Context loading determines when AI reads workflow, task, spec, research, workspace, and git status. Read this page when the user says "AI does not know the selected task," "the agent did not read specs," or "there is too much/too little context."

## Read These Files First

1. `.pactile/workflow.md`
2. `pactile context --mode session --json`
3. `pactile task selected --source`
4. Current platform hooks or agent files
5. The selected task's `implement.jsonl` / `check.jsonl`

## Context Sources

| Source | Purpose |
| --- | --- |
| `.pactile/workflow.md` | Workflow and next-action hints. |
| `.pactile/tasks/<task>/prd.md` | Selected task requirements. |
| `.pactile/tasks/<task>/design.md` | Complex task technical design. |
| `.pactile/tasks/<task>/implement.md` | Complex task execution plan. |
| `.pactile/tasks/<task>/implement.jsonl` | Spec/research to read before implementation. |
| `.pactile/tasks/<task>/check.jsonl` | Spec/research to read during checking. |
| `.pactile/spec/` | Project specs. |
| `.pactile/workspace/` | Session records. |
| git status | Current working tree changes. |

## Common Needs And Edit Points

| Need | Edit point |
| --- | --- |
| Inject more/less information in new sessions | Project context manifests or the platform session entry. |
| Change hints on each user input | `[workflow-state:STATUS]` block in `.pactile/workflow.md`. The `inject-workflow-state` hook is parser-only and reads the block verbatim. |
| Agent did not read specs | Task JSONL, agent prelude, `inject-subagent-context` hook. |
| Selected task is lost | `pactile task selected --source` and platform session identity propagation. |
| Change JSONL validation rules | Pactile CLI Node implementation (product change). |

## JSONL Rules

`implement.jsonl` / `check.jsonl` are the key context loading interface:

```jsonl
{"file": ".pactile/spec/backend/index.md", "reason": "Backend conventions"}
{"file": ".pactile/tasks/04-28-x/research/api.md", "reason": "API research"}
```

Include only spec/research files. Do not put code files that will be modified into these manifests; agents read code files themselves during implementation.

## Change Session Context

If the user wants every new session to see more project state, curate the project context manifests and the platform session entry. Changes to the compiler itself belong in the Pactile product source.

Context cannot grow without bound. Prefer injecting indexes and paths so the AI can read detailed files on demand.

## Change Sub-Agent Context

For Pi Agent workers, determine which context loading mode the integration uses:

- hook push: edit the `inject-subagent-context` hook.
- agent pull: edit the read steps in the corresponding `pactile-implement` / `pactile-check` agent file.

In both modes, make sure the agent ultimately reads:

1. selected task
2. the corresponding JSONL
3. spec/research referenced by the JSONL
4. `prd.md`
5. `design.md` if present
6. `implement.md` if present

## Troubleshooting Order

```bash
pactile task selected --source
pactile task list-context <task>
pactile task validate <task>
pactile context --mode packages
```

Confirm the task and JSONL are correct before editing hooks/agents.
