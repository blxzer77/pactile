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
`implement.md`. All roles inherit Pi's configured MCP servers, skills, tools,
model and thinking settings. The default RPC launcher adds only `--mode rpc`;
it does not add tool allowlists, resource-disabling flags or model overrides.
Check and research are read-only behavioral roles: they may investigate with
configured tools and run necessary targeted validation, but must not modify
project implementation, reviewed files, existing evidence or Kernel state, or
commit, merge, publish or perform production writes. Keep validation artifacts
in a separate temporary directory outside the project/candidate workspace.
This is not an operating-system sandbox. Independent Review still requires
the fixed candidate and verified bound evidence; missing new evidence results
in `needs-changes`. Static evidence-only review and format correction must
declare their scope and limitations. Report unavailable capabilities explicitly.
Repeating
`--prompt-file` runs sequential prompts in one warm Pi process; a later CLI
invocation can use `--resume` to reopen the recorded Pi session. The bridge
records session identity, event summaries, final text, failure outcome, and
cold/warm latency under the task's `pi-bridge/` directory. It never changes the
Kernel phase to Close. `settled` means Pi stopped normally; acceptance and
verification remain separate.

## Scheduler-driven Parent dispatch

Set concrete project-relative `touches` for each Child in the Parent's
`task-map.md`. V2 Task dependencies and Run state are read through the public
Task Kernel API; legacy `depends_on` and Child lifecycle state remain read-only
compatibility inputs. Unclosed or failed hard dependencies block dispatch.
`merge_limit` remains 1. Each Child needs its own approved Execute contract
with `execution_mode: worker`.

Create a local manifest and run one bounded batch:

```json
{
  "schema_version": 1,
  "children": [
    { "task": "child-a", "prompt_file": "prompts/a.md", "review_cost": "low",
      "estimated_costs": { "executionMs": 180000, "integrationMs": 30000, "reviewMs": 20000 } },
    { "task": "child-b", "prompt_file": "prompts/b.md", "review_cost": "medium",
      "estimated_costs": { "executionMs": 120000, "reviewMs": 45000 } }
  ]
}
```

```text
pactile parallel run <parent> --manifest parallel.json
pactile parallel status <parent>
```

The batch runs the deterministic critical-path waves and persists a
content-addressed schedule receipt under the Parent task. There is no fixed
numeric concurrency cap and no manifest child-count ceiling. The scheduler
requires a modeled completion-time gain before grouping compatible Tasks;
review cost affects the schedule weight but never blocks parallel execution by
itself. V2 Run write-set snapshots and workspace write sets are unioned with
Child `touches`; unknown scope conflicts with every writer. Overlapping paths
run in separate waves by default. Parallel overlap requires exact Child IDs,
an approver, an authorization evidence reference, and a non-empty integration
plan in the manifest; the receipt and active leases retain that authorization.

The old `parallel_limit` task-map field and manifest `limit` remain readable
for compatibility but do not constrain the active path. Old batch result files
with `concurrency_limit` remain readable as history. New results record the
actual `max_active` and schedule receipt reference. If an approved Child
contract specifies `git-worktree`, prepare its worktree with `pactile task
prepare-child-worktree` first; Pi runs with that checkout as its actual working
directory. A missing or invalid worktree blocks dispatch. Direct `pactile pi
run` and Codex Execute requests have no count cap; Task and write-conflict gates
still apply, and active collisions remain rejected unless the same verified
schedule receipt authorizes the pair. The batch records queue wait, Pi outcomes,
cost provenance, scheduler waves, and decision evidence. The Parent reviews
actual diffs, verifies Child evidence, then calls `integrate-child` one at a
time. `touches` is a declaration and dispatch guard, so review must still
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
