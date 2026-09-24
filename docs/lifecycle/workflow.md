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

## Host-neutral checks

```bash
pactile task start-execution <task-dir> --check
pactile task record-gate <task-dir> --transition full-task-complete --gate code-review --result PASS --reviewer <reviewer-id> --evidence verify.md
```

The exact gate options depend on the generated Task contract. Keep host hooks
and context injection best-effort; if a hook is absent, read
`.pactile/workflow.md`, the Task artifacts, and the CLI-generated dispatch
prompt directly.

## Evidence and close

Verification should name commands, exit status, affected files, and any
skipped check with a reason. Independent review is read-only. Archive only
after the Parent/Child state, Evidence ledger, review gate, and durable-learning
decision are recorded. Keep the full Core and CLI suite for the final release
preflight when the release boundary says so.
