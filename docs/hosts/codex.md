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

Cross-task message bodies are limited to 4096 UTF-8 bytes. By default, a cross-task message is coordination only: a waiting or blocked Task may receive it, but it does not change a Run, clear a block, or grant write permission. Its prompt tells the recipient to preserve the blocked state. This slice fails closed for Task Kernel v2 Execute creates and `--resume-execute` sends because P37 admission, lease, Resume, and block validation are not yet connected. After those gates are integrated, a write dispatch will still require an explicit Kernel Resume and a P37 admission; the send receipt itself will not grant dispatch permission. Only a non-stale successful send receipt can support a message-linked block. A message-linked unblock requires successful `desktop-native` resolution evidence; a simulated send is insufficient. `sent` means the Host accepted the send request; it does not confirm that the recipient read it. Each unblock has its own journal event. A user can also unblock manually with a reason.

### Pi Review escalation to Codex Review

A prepared P40 escalation can ask a separately bound Codex `review` thread to
return an independent, read-only Review. The Pi Review artifact remains
immutable. Start the send from the source Task's current V2 Verify Run and
non-passing Pi Review, targeting a V2 Verify/Integrate Task with its current
completed candidate and a bound Review thread:

```text
pactile codex prepare <source-task> --tool message --thread-id <review-thread> --to-task <review-task> --run-id <source-run> --to-run-id <review-run> --escalation-id pi-escalation:<pi-run-uuid>
pactile codex receipt <source-task> <send-request-id> --result-file send-result.json --evidence-level desktop-native
pactile codex prepare <review-task> --tool read --thread-id <review-thread> --reply-to-escalation-id pi-escalation:<pi-run-uuid> --source-task <source-task> --send-request-id <send-request-id>
pactile codex receipt <review-task> <read-request-id> --result-file read-result.json --evidence-level desktop-native
pactile codex review-escalation <source-task> --escalation-id pi-escalation:<pi-run-uuid> --send-request-id <send-request-id> --read-request-id <read-request-id>
```

The send preparation reads and verifies the actual Pi escalation artifact and
Pi Review evidence, then creates a fixed P40 prompt for the bound Review
thread. The native read result must carry a completed, correlated
`reply_evidence` whose body is one JSON object with the exact escalation,
Task/Run/candidate and Pi artifact bindings; reviewer `hostId`, `threadId`,
`role: review`, and `independent: true`; a `pass`, `fail`, or `needs-changes`
verdict; coverage, findings, blockers, questions, one evidence-backed
`concernResolutions` disposition for every original Pi finding, blocker, and
question, acceptance evidence, and evidence references. Concern IDs are opaque
stable identifiers; the cross-task prompt does not forward Pi free-text
summaries. The body cannot contain extra fields or Markdown fences. A PASS must
resolve every original Pi concern with evidence. Every reported reference must
equal the current byte-verified candidate/Run evidence set, and the reviewer
identity derived from the native thread must differ from the Run executor and
approver.

`pactile codex review-escalation` re-reads both prepared/native transport
request and receipt pairs, copies their bytes into the source Task's evidence
tree, validates the complete reply, and calls the existing public Kernel Review
mutation. A PASS makes the Kernel Review condition ready; it does not Close the
Task or authorize a new Run. The prior Pi Review stays in Kernel history and its
artifact is not rewritten. Before dispatch and again before recording, the
route rechecks the original Pi Kernel Review's Core evidence digest; the new
Review retains the original Pi evidence references so public Close checks the
Check start/stop/result evidence again. Reply reads bind the selected successful
send request and receipt digests, must follow that send, and must still match
the latest successful send at settlement. Stale source or reply Tasks, simulated receipts,
wrong IDs or thread, mismatched candidate, missing evidence, non-JSON text, and
missing or unresolved Pi concern dispositions, invalid review contracts, and
credential-shaped Pi text fail closed before external send or a new Kernel
Review is recorded. A repeated identical finalization is idempotent; a different
reply cannot replace the recorded Review.
`desktop-native` remains a host-reported assurance label, not a signed desktop
identity; only mark it when the result was copied from the current Codex desktop
tool call. The structured reply contract and Kernel independence checks remain
required even for native results.

Worktree creation may first return only `clientThreadId`. Record `outcome: queued` with `client_thread_id`; this ID cannot be messaged or waited on. Once the App reports a ready `threadId` and `hostId`, record a final `outcome: ok` receipt containing the same `client_thread_id` and the ready IDs. `pactile codex status` shows queued requests until then.

Receipts have `host-reported` assurance: Node records the native tool result supplied by the caller; it is not a product-authenticated desktop signature. A hash chain or receipt cannot upgrade simulated evidence to desktop evidence, and a simulated test does not establish native desktop acceptance. Receipts do not replace code review, Pi result checks, acceptance criteria evidence, or Kernel gates. A changed Kernel revision or Run candidate marks a receipt `contract_stale`; recheck the task contract. Planning requests require Open/Define/Approve; review requests require Verify/Integrate. The Node CLI cannot call desktop tools directly. Do not substitute a Codex CLI/App Server/ACP session or Codex subagent for a desktop task. This bridge needs no resident background service. If native coordination is unavailable, continue serially and record why.

For an independent implementation task, use `--role execute` after its Execute approval. Creation requires `--target project --environment worktree`. The request carries the canonical absolute Pactile task path, because an App worktree may not contain ignored task state. If the approved task has `base_branch`, the request starts from that branch. A Parent Child reserves one shared parallel slot before the desktop create request; failed creation or a completed `wait_threads` receipt releases it. The native task remains user-owned. A receipt does not prove its changes were accepted; Parent review and `integrate-child` remain separate.

After Pactile archives the task, `pactile codex status <task>` remains read-only available and shows the archived receipts. New requests and receipts require an active task; a late Host response is rejected and does not append to the archived Task.

## Detach

```bash
pactile detach codex --dry-run
pactile detach codex
```

The dry run shows claimants and preserved resources. Applying the detach
removes Codex-specific bindings and leaves shared or borrowed resources alone.
