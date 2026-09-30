# Canonical workflow

English | [简体中文](workflow.zh-CN.md)

The workflow is a host-neutral sequence of intent, definition, approval,
execution, verification, integration, and close. Codex task conversations
consume this sequence; the canonical task record remains the authority.

```text
triage -> define -> approve -> execute -> verify -> integrate -> close
```

For a durable change, keep the Task PRD, implementation contract, Evidence,
review gate, and ownership decisions together. A successful shell command or
model response is not a close gate. The Kernel accepts a transition only when
the required facts and fingerprints are current.

## V2 lifecycle commands

The released Node runtime uses the Task Kernel V2 chain below. The command
names are intentionally explicit so a host adapter or an Agent can resume a
Task without relying on a legacy task directory state:

```bash
pactile task create "<title>" --slug <slug> \
  --deliverable "<independently acceptable result>" \
  --delivery-level local-result --accept AC-1="<criterion>"

pactile task run-start <task> \
  --input-summary "<bounded input>" \
  --approved-by <actor> \
  --authorization-scope "<approved scope>" \
  --authorization-evidence <evidence-ref> \
  --write-set-snapshot <repo-relative-path>

pactile task run-result <task> <run-id> --outcome completed
pactile task review <task> --actor <reviewer> --run <run-id> --candidate-id <candidate-id> \
  --candidate-fingerprint <sha256> --reviewer <reviewer> --decision pass \
  --evidence <review-ref> --criterion <criterion-id>=<evidence-ref>
pactile task close <task> --run <run-id> --review <review-id> \
  --candidate-id <candidate-id> --candidate-fingerprint <sha256> \
  --candidate-observed-by <actor> --candidate-observation-source <source> \
  --candidate-observation-ref <observation-ref> \
  --delivery-level local-result --delivery-ref <delivery-ref> \
  --delivery-summary "<accepted result>" --check
```

`run-result` records the candidate; `review` records an independent decision;
`close --check` reports whether all current evidence and fingerprints satisfy
the Task contract. Run the same `close` command without `--check` only after
the check passes. Legacy `start-execution`, `record-gate`, and `archive`
remain compatibility commands for imported V1 tasks; they are not part of a
new V2 Task.

These commands are a lifecycle outline, not a script with placeholder values.
Declare each permitted result path with `--write-set-snapshot`, implement the
approved change after `run-start`, then obtain the candidate ID and fingerprint
from `pactile task show <task> --json`. Keep Review evidence under the Task
directory so writing the Review does not alter the project candidate. The
reviewer must differ from the Run executor and approver. For a managed Git
workspace, queue the Run with `--wait`, create or adopt its worktree, and
resume the Run before writing; see [Run worktree lifecycle](../run-worktree-lifecycle.md).

Host hooks and context injection are best-effort. If a hook is absent, read
`.pactile/workflow.md`, the Task artifacts, and the CLI-generated dispatch
prompt directly.

## Evidence and close

Verification should name commands, exit status, affected files, and any
skipped check with a reason. Independent review is read-only. Close only after
the Task delivery level, Run result, candidate observation, Review decision,
Evidence ledger, and any durable-learning decision required by the Task
contract are recorded. Keep the full Core and CLI suite for the final release
preflight when the release boundary says so.
