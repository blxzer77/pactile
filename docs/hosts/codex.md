# Codex host

English | [简体中文](codex.zh-CN.md)

The Codex adapter consumes the canonical `.pactile/` generation. When the
ChatGPT desktop app reports native project support, it may project supported
Codex files under `.codex/`; a baseline install with an unavailable app keeps
that native tree absent and reports the adapter as degraded. The adapter does
not copy the canonical Task database into a second authority. `AGENTS.md` and
shared Skills remain subject to ownership checks.

## Install and inspect

```bash
pactile init --codex -y
pactile capability-smoke --json
```

Inspect the generated project projection and the canonical receipts. A host
configuration entry can be user-owned, borrowed, Pactile-managed, or
ambiguous; the ownership ledger is the deciding evidence.

| Codex surface                       | Pactile contract                                                         |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `.codex/` project configuration     | Conditional rebuildable projection; absent when native project support is unavailable. |
| `AGENTS.md`                         | One shared managed block; user text outside the block is preserved.      |
| `.agents/skills/`                   | Shared Skill projection; a claimant does not become the owner. |
| External MCP/provider configuration | Resolved by Middleware and the host; never copied into canonical state.  |

Read each capability's origin and assurance before relying on it. Use
[capability readiness](../capabilities/index.md) for the mode matrix.

## Desktop task bridge

Codex desktop tasks can use `pactile task` and `pactile kernel --json` to read and update Pactile tasks. After recorded Execute approval, `pactile pi run` dispatches Pi. The Kernel and task artifacts remain the lifecycle and evidence source.

When the user explicitly requests a separate desktop task, get the project ID from the App's project list, then prepare a native request:

```text
pactile codex prepare <task> --tool create --role plan --project-id <Codex project ID> --environment worktree --prompt-file plan.md
```

Choose `worktree` for a Git project or `local` for a non-Git project, based on the App's project metadata. The CLI prints a request ID, Kernel revision, and exact native `create_thread` arguments. The current desktop task invokes that tool, then records a compact result:

If the checkout is not saved as an App project, use `--target projectless` with a prompt that names the absolute checkout and task paths; no project ID or environment is needed.

```text
pactile codex receipt <task> <request-id> --result-file create-result.json
pactile codex status <task>
```

For example, the result JSON is `{"request_id":"<request-id>","tool":"create_thread","outcome":"ok","thread_id":"<threadId>","host_id":"local"}`. Use `--tool message|wait|read --thread-id <threadId>` for the native `send_message_to_thread`, `wait_threads`, and `read_thread` tools, and record each result the same way. Wait results also need `status: completed|needs_attention|timeout`. Failed results use `outcome: failed` and a short `reason`.

Worktree creation may first return only `clientThreadId`. Record `outcome: queued` with `client_thread_id`; this ID cannot be messaged or waited on. Once the App reports a ready `threadId` and `hostId`, record a final `outcome: ok` receipt containing the same `client_thread_id` and the ready IDs. `pactile codex status` shows queued requests until then.

Receipts have `host-reported` assurance: they record the tool's reported identity and result, not implementation or acceptance. A changed Kernel revision marks a receipt `contract_stale`; recheck the task contract. Planning requests require Open/Define/Approve; review requests require Verify/Integrate. The Node CLI cannot call desktop tools directly. Do not substitute a Codex CLI/App Server/ACP session or Codex subagent for a desktop task. If native coordination is unavailable, continue serially and record why.

After Pactile archives the task, `pactile codex status <task>` remains read-only available and shows the archived receipts. New requests and receipts require an active task.

## Detach

```bash
pactile detach codex --dry-run
pactile detach codex
```

The dry run shows claimants and preserved resources. Applying the detach
removes Codex-specific bindings and leaves shared or borrowed resources alone.
