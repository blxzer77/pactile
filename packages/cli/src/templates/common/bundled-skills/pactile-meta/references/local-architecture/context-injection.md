# Local Context Injection System

Pactile context injection aims to make AI read the right files at the right time instead of relying on model memory. The Node CLI compiles context from `.pactile/` artifacts for the host and worker bridge.

## Injected Context Types

| Type | Source | Purpose |
| --- | --- | --- |
| session context | `pactile context` | Current developer, git status, selected task, Task Dashboard, active tasks, journal, packages. |
| workflow context | `.pactile/workflow.md` | Current Pactile flow and next action. |
| spec context | `.pactile/spec/` + task JSONL | Specs that must be followed during implementation/checking. |
| task context | `.pactile/tasks/<task>/prd.md`, `design.md`, `implement.md`, `research/` | Selected task requirements, design, execution plan, and research. |
| platform context | Platform hooks/settings/agents | Lets different AI tools read the files above through their own mechanisms. |

## session-start

Platforms with session-start support inject a Pactile overview when a session starts, clears, compacts, or receives a similar event. Injected content usually includes:

- workflow summary.
- selected task status.
- active tasks.
- spec index paths.
- developer identity and git status.

If the user feels the AI does not know the selected task in a new session, first check whether the platform's session-start hook or equivalent mechanism is installed and running.

## workflow-state

workflow-state is a lightweight hint injected around each user turn. Based on selected task status, it selects a block from `.pactile/workflow.md`, such as `no_task`, `planning`, `in_progress`, or `completed`.

If the user wants to change "what the AI should do next in a given state," edit the corresponding state block in `.pactile/workflow.md` first.

## sub-agent context

Implement and check agents need task context. Pactile has two loading modes:

1. **hook push**: a platform hook injects jsonl-referenced files plus `prd.md`, `design.md` if present, and `implement.md` if present before the agent starts.
2. **agent pull**: the agent definition instructs the agent to read the selected task, jsonl context, and task artifacts after startup.

In both modes, JSONL files in the task directory are the manifest for spec/research context. Task artifacts are read separately in this order: `prd.md` -> `design.md if present` -> `implement.md if present`.

## JSONL Reading Rules

`implement.jsonl` and `check.jsonl` contain one JSON object per line:

```jsonl
{"file": ".pactile/spec/backend/index.md", "reason": "Backend rules"}
```

Readers should skip seed rows without a `file` field. When configuring JSONL, the AI should include only spec/research files, not pre-register code files that will be modified.

## Selected Task And Context Key

Selected task state lives in `.pactile/.runtime/sessions/` and is isolated per session. Hooks try to resolve the context key from platform events, environment variables, transcript paths, or `PACTILE_CONTEXT_ID`.

If shell commands cannot see the same context key, `pactile task selected --source` may report no selected task. In that case, check whether the platform passes session identity into the shell instead of hand-writing a global current-task file.

## Local Customization Points

| Need | Edit location |
| --- | --- |
| Change session-start injected content | The platform's `session-start` hook or plugin file. |
| Change per-turn workflow-state rules | `[workflow-state:STATUS]` block in `.pactile/workflow.md`. The platform workflow-state hook parses these blocks verbatim and embeds no fallback text. |
| Change how sub-agents read context | Platform agent definitions, the `inject-subagent-context` hook, or agent preludes. |
| Change JSONL validation/display | Pactile CLI Node implementation. |
| Change selected task resolution | Pactile CLI Node implementation and platform session bridge. |

When modifying context injection, verify two things: new sessions can see the correct task, and sub-agents can see the correct task artifacts/spec/research.
