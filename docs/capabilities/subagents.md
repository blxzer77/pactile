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
