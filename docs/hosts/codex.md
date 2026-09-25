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

For example, the result JSON is `{"request_id":"<request-id>","tool":"create_thread","outcome":"ok","thread_id":"<threadId>","host_id":"local"}`. Use `--tool message|wait|read --thread-id <threadId>` for the native `send_message_to_thread`, `wait_threads`, and `read_thread` tools, and record each result the same way. `--evidence-level` defaults to `simulated`; use `desktop-native` only for a result copied from the current Codex desktop task's native tool call. Native create/wait receipts must echo the actual `thread_id` and `host_id`. Wait results also need `status: completed|needs_attention|timeout`. Failed results use `outcome: failed` and a short `reason`.

Task Kernel v2 requests can be associated with a Run using `--run-id <Task Run ID>` for create, message, and wait. When the desktop task ends after the Run candidate snapshot is recorded, prepare wait with the same Run ID. The request captures the candidate snapshot ID and fingerprint; a changed candidate or Kernel revision makes the receipt ineligible as current terminal evidence. Cross-task messages explicitly link the sender Task, the Task owning the destination thread, and optional Run IDs:

```text
pactile codex prepare <sender-task> --tool message --thread-id <receiver-thread> --to-task <receiver-task> --to-run-id <receiver-run> --prompt-file message.md
pactile codex receipt <sender-task> <request-id> --result-file message-result.json --evidence-level desktop-native
pactile codex block <receiver-task> --message-id <request-id> --blocked-by-task <sender-task> --reason "Waiting for input"
pactile codex unblock <receiver-task> <block-id> --resolution-message-id <request-id> --unblocked-by-task <sender-task> --reason "Input received and checked"
```

Cross-task message bodies are limited to 4096 UTF-8 bytes. By default, a cross-task message is coordination only: a waiting or blocked Task may receive it, but it does not change a Run, clear a block, or grant write permission. Its prompt tells the recipient to preserve the blocked state. Only after an explicit Task Kernel Resume of the destination V2 Run can a write dispatch be requested with `--resume-execute --to-run-id <run-id>`; the send receipt itself does not grant dispatch permission. Only a non-stale successful send receipt can support a message-linked block or unblock. `sent` means the Host accepted the send request; it does not confirm that the recipient read it. Each unblock has its own journal event. A user can also unblock manually with a reason.

Worktree creation may first return only `clientThreadId`. Record `outcome: queued` with `client_thread_id`; this ID cannot be messaged or waited on. Once the App reports a ready `threadId` and `hostId`, record a final `outcome: ok` receipt containing the same `client_thread_id` and the ready IDs. `pactile codex status` shows queued requests until then.

Receipts have `host-reported` assurance: Node records the native tool result supplied by the caller; it is not a product-authenticated desktop signature. A hash chain or receipt cannot upgrade simulated evidence to desktop evidence, and a simulated test does not establish native desktop acceptance. Receipts do not replace code review, Pi result checks, acceptance criteria evidence, or Kernel gates. A changed Kernel revision or Run candidate marks a receipt `contract_stale`; recheck the task contract. Planning requests require Open/Define/Approve; review requests require Verify/Integrate. The Node CLI cannot call desktop tools directly. Do not substitute a Codex CLI/App Server/ACP session or Codex subagent for a desktop task. This bridge needs no resident background service. If native coordination is unavailable, continue serially and record why.

For an independent implementation task, use `--role execute` after its Execute approval. Creation requires `--target project --environment worktree`. The request carries the canonical absolute Pactile task path, because an App worktree may not contain ignored task state. If the approved task has `base_branch`, the request starts from that branch. A Parent Child reserves one shared parallel slot before the desktop create request; failed creation or a completed `wait_threads` receipt releases it. The native task remains user-owned. A receipt does not prove its changes were accepted; Parent review and `integrate-child` remain separate.

After Pactile archives the task, `pactile codex status <task>` remains read-only available and shows the archived receipts. New requests and receipts require an active task.

## Detach

```bash
pactile detach codex --dry-run
pactile detach codex
```

The dry run shows claimants and preserved resources. Applying the detach
removes Codex-specific bindings and leaves shared or borrowed resources alone.
