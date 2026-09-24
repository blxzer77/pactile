# Subagents and worktrees

English | [简体中文](subagents.zh-CN.md)

Pactile tasks can be assigned to independent agent sessions. The parent task
owns integration and the Kernel owns durable transitions. Pi Agent can run an
approved Execute task through its native RPC protocol. Codex desktop task
coordination uses native App tools with Pactile Node request/receipt records.

## Pi Agent bridge

Install and configure `pi` separately, including its provider and model. Pactile
does not need a Python runtime or an ACP intermediary. After the user has
approved `pactile task start-execution <task> --approved`, prepare a bounded
prompt file and dispatch it:

```text
pactile pi run <task> --role implement --prompt-file worker-prompt.md
pactile pi status <task>
pactile pi cancel <task>
```

An implement worker requires `execution_mode: worker` in the approved
`implement.md`. Check and research roles use read-only Pi tools. Repeating
`--prompt-file` runs sequential prompts in one warm Pi process; a later CLI
invocation can use `--resume` to reopen the recorded Pi session. The bridge
records session identity, event summaries, final text, failure outcome, and
cold/warm latency under the task's `pi-bridge/` directory. It never changes the
Kernel phase to Close. `settled` means Pi stopped normally; acceptance and
verification remain separate.

## Bounded Parent parallel batch

Set concrete project-relative `touches` for each Child in the Parent's
`task-map.md`. Dependencies must already be `integrated`; a cancelled dependency
does not satisfy a hard requirement. The optional `parallel_limit` defaults to 2
and may be 1 through 4. `merge_limit` remains 1. Each Child needs its own
approved Execute contract with `execution_mode: worker`.

Create a local manifest and run one bounded batch:

```json
{
  "schema_version": 1,
  "limit": 2,
  "children": [
    { "task": "child-a", "prompt_file": "prompts/a.md", "review_cost": "low" },
    { "task": "child-b", "prompt_file": "prompts/b.md", "review_cost": "medium" }
  ]
}
```

```text
pactile parallel run <parent> --manifest parallel.json
pactile parallel status <parent>
```

The batch starts disjoint write sets concurrently up to the Parent cap.
If an approved Child contract specifies `git-worktree`, prepare its worktree
with `pactile task prepare-child-worktree` first; Pi runs with that checkout as
its actual working directory. A missing or invalid worktree blocks dispatch.
Overlapping or undeclared paths and high review cost run serially. An unmet
dependency blocks the entire batch before a Pi process starts. Direct `pactile
pi run` and Codex Execute requests share the Parent's conflict and concurrency
slots. The batch records wall time, queue wait, Pi outcomes and event counts;
`status` adds current integration states and recorded rework events. The Parent
reviews actual diffs, verifies Child evidence, then calls `integrate-child` one
at a time. `touches` is a declaration and dispatch guard, so review must still
detect edits outside the declared scope.

## Safe dispatch

1. Select or create a Task with a bounded write set.
2. Provide the child with the PRD, design, implementation contract, and
   evidence requirements.
3. Let the child report `working`, `review`, or `blocked`; it cannot self-claim
   Parent integration.
4. Review the change set and Evidence in a fresh context when independence is
   required.
5. Parent integrates one reviewed ref at a time and records the decision.

Do not ask a child task to commit, publish, mutate a remote, or broaden its write
set without an explicit change to the task contract.
