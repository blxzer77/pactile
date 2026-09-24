# Subagents and worktrees

English | [简体中文](subagents.zh-CN.md)

Pactile tasks can be assigned to independent agent sessions. The parent task
owns integration and the Kernel owns durable transitions. Codex desktop task
coordination and a Pi Agent bridge are planned for a later work item; this
version does not provide that bridge.

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
