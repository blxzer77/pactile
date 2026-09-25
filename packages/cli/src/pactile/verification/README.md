# Verification choice

`createVerificationPlan` is a pure, deterministic selector. The caller supplies
semantic impact (`changedSurfaces`, scope, and explicit risk signals) and a
trusted inventory of available checks. It picks a low-cost set of independent
public-behavior checks that covers those goals, records every omitted check and
why it was omitted, and always retains checks marked as required by project or
policy CI.

The inventory is deliberately explicit. A test is not considered relevant just
because its file path resembles a changed source file. A suite must declare the
public surfaces and risk signals it checks. Implementation-mirroring tests are
reported as skipped and never count as behavior evidence. A missing independent
check leaves an uncovered goal in the plan instead of silently passing.

Routine single-area changes do not receive an automatic full-suite check. If a
routine change has no focused independent check, the plan reports missing
behavior evidence instead of silently falling back to the full suite. A full
suite becomes eligible only for a cross-module or repository-wide scope, or
when an explicit risk signal makes broader verification appropriate. Among
eligible checks, the selector chooses those that add coverage for a declared
goal and provide the best remaining value for their cost. Cross-module,
migration, release, permission-boundary, data-egress, and repository-wide
signals create explicit coverage goals that can select matching checks.

The planner only proposes a plan; it does not run commands or authorize task
Close. Recompute from the current impact and check inventory at each caller
decision. The observer and receipt APIs below bind later execution results to
the frozen P35 candidate, but Close still needs to re-observe real state and
enforce the delivery-level integration rules.

## Candidate observation and execution receipt

`observeGitCandidate` takes an explicit repository-relative write set and
performs a bounded, read-only Git/filesystem observation. It records HEAD and
branch, separate staged/unstaged/untracked/conflict paths, Git diff/status
digests, and SHA-256 digests of current bytes for changed paths inside the
allowed write set. Out-of-scope paths are listed but their current bytes are
never read; a conflict, branch mismatch, or out-of-scope change makes the
observation ineligible for a candidate. Symlinks are fingerprinted by their
link-target text without reading through the link. The observer fails closed
when Git output exceeds 16 MiB, changed paths exceed 1,000, one current file
exceeds 8 MiB, total current bytes exceed 32 MiB, or the observed state changes
during collection.

For a P35 Run, call `observeTaskRunCandidate({ run })` against its frozen
`writeSetSnapshot` and workspace binding, then add
`createTaskCandidateEntry(observation)` to P35 `candidateEntries` before
`run-result` freezes the candidate ID and fingerprint. After that Run is
completed, build `createVerificationReceipt` from the Run, observation, plan,
and one result per selected or skipped check. Selected checks need a stable
evidence reference when executed; required CI declarations are retained in the
plan and `listRequiredCiReceiptResults` is only a derived view. The receipt
fingerprint binds the plan/results to the Run ID, candidate ID/fingerprint,
and Git observation fingerprint. Re-observe before consuming it and use
`assessVerificationReceiptFreshness`; a changed Run, candidate, checkout, Git
state, or allowed current bytes makes the receipt stale.

This package slice does not run commands, persist receipts, validate evidence
references, inspect integration ancestry, or wire the Close gate. Receipt
hashes detect accidental or later content changes; they are not signatures or
proof against a caller that can fabricate both the P35 snapshot and receipt.
Keep serialized receipts in trusted local task state because they include
repository-relative changed paths. A later Close integration must re-read Git
and file state itself and check integration/delivery facts at the level being
claimed; caller-provided references alone are not acceptance evidence.
