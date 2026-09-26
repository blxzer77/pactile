# Pi dispatch for Task Kernel V2 Runs

`pactile pi run` accepts `--run-id` for an existing active or waiting Task Kernel V2 Run. The Task ID and Run ID must match the latest Run. The dispatch role is `implement`; V2 Check and Research remain outside this writer lease path.

```sh
pactile task run-start search-result --actor alice \
  --input-summary "Implement AC-1" --approved-by alice \
  --authorization-scope "the declared deliverable" --authorization-evidence approval.md \
  --write-set src/result.ts
pactile pi run search-result --role implement --run-id <run-id> \
  --prompt-file .pactile/tasks/09-26-search-result/implement.md
```

Pi resolves the actual Task directory from the Task ID, including date-prefixed directories. V2 dispatch requires a P38 manager-created or explicitly approved adopted worktree bound to the active Run. Project-root execution, an absent/unverified workspace, an unregistered or foreign Git checkout, a changed branch/base/HEAD, a dirty checkout, or manager-provenance mismatch fails closed. Non-Git local Runs are not enabled by this path.

After verifying the clean worktree, it saves a Task Kernel schedule receipt and obtains the project writer lease before creating Pi run files or starting the Pi RPC process. It rechecks the Run and manager-owned worktree after admission and immediately before spawning Pi. An open hard dependency, stale or mismatched Run, existing host binding, or overlapping active writer lease rejects dispatch before process start.

After the RPC process starts and Pi returns a session identity, the bridge writes a start receipt, binds the Pi host to the Run, then binds the observed process/session owner to the admission lease. The Run write set and verified manager-owned worktree are passed to Pi as its execution boundary.

The V2 bridge closes its Pi child after the single prompt. A completed prompt is not proof that the process stopped. The bridge releases the dispatch lease only after it has observed the child `close` event, persisted the Pi process stop receipt and content-addressed stop proof, appended the settlement refs to the Task Run, and passed the scheduler's stop-proof validator. If process start, identity binding, receipt persistence, close observation, or validation is uncertain, the lease stays active for reconciliation.

This path records Pi execution and host-stop evidence only. It leaves the Task Run active with no candidate or completed result; the later Run-result observer, independent Review, and Kernel Close steps remain separate.
