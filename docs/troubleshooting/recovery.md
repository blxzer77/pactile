# Recovery runbooks

English | [简体中文](recovery.zh-CN.md)

Use the symptom, evidence, recovery, and escalation sequence below. Recovery is
local and reversible until a user explicitly confirms a destructive purge.

| Symptom                  | Evidence                                             | Recovery                                                                                                 | Escalate when                                       |
| ------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Adapter is `degraded`    | Capability JSON, projection receipt, ownership entry | Resolve the host dependency or conflict, then retry that Adapter; do not rebuild siblings.               | Receipt says interrupted or ownership is ambiguous. |
| Ownership conflict       | Preimage and current-byte fingerprint                | Preserve the file; choose explicit reuse, rename, or skip.                                               | The owner or claimant cannot be established.        |
| Stale purge preview      | New target fingerprint differs                       | Stop; run a fresh dry-run and review the changed target set.                                             | Active claims or unsafe target remain.              |
| Unsealed rollback target | Generation verification error                        | Select a sealed generation from install state/receipts.                                                  | No sealed generation is available.                  |
| Bin conflict             | Command resolves to an unexpected executable         | Inspect PATH and package bins; use the canonical `pactile` bin and do not remove a user's alias blindly. | The package manifest or installed bin is ambiguous. |

## Legacy Task migration recovery

The migration authority pointer is the only switch that makes a sealed V2
generation visible. If `authority.json` is missing while any migration backup,
journal, generation, or overlay artifact remains, readers and `pactile update`
fail closed and preserve those bytes; they do not fall back to the legacy
`task.json` or silently re-import it.

An update retry may resume only a verified journal in a pre-commit stage
(`planned`, `backed-up`, `staged`, or `validated`) for the exact same source,
target, and plan fingerprints, with its required verified backup and sealed
generation, and with no overlay mutation evidence. A committed or
ambiguous journal, fingerprint mismatch, corrupt or missing backup/generation,
or any overlay journal/override evidence requires reconciliation from the
preserved migration store. Do not delete that store or rerun against changed
legacy inputs to clear the error.

Never repair by deleting `.pactile/`, rewriting a legacy source, or copying a
secret into a template. Capture the minimal command output and open a governed
issue using [Support](../governance/index.md).
