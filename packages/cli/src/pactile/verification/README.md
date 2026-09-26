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

The planner is available from the public `@blxzer/pactile` SDK entry. Callers
provide the semantic change impact and check inventory:

```ts
import { createVerificationPlan } from "@blxzer/pactile";

const plan = createVerificationPlan({
  impact: {
    changedSurfaces: ["task.create"],
    risks: [],
    scope: "single-area",
  },
  checks: [
    {
      kind: "behavior",
      id: "task.create.public",
      title: "Task creation public behavior",
      mode: "focused",
      evidence: "independent-public-behavior",
      coversSurfaces: ["task.create"],
      coversRisks: [],
    },
    {
      kind: "policy-ci",
      id: "typecheck.required",
      title: "Project typecheck",
      requiredBy: ["project CI"],
    },
  ],
});

if (plan.coverageStatus !== "covered") {
  throw new Error("Add an independent check for each uncovered goal");
}
```

For a migration or release change, add the matching risk and checks with
`migration` or `release` mode. For a cross-module change, declare
`scope: "cross-module"` and include a check that covers the affected seams or
integration behavior. The planner returns uncovered goals when the inventory
cannot support the declared impact.

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

## Standalone non-Git Runs

A standalone V2 Run keeps working in a project without Git metadata at its
project root. Start records a `project-files-bounded-v1` baseline containing
only relative path, byte size, and SHA-256 for ordinary regular files. The fixed
limits are 4,096 files, 2 MiB per file, 32 MiB total file content, 4,096
entries per directory, 4,096 directories, 8,192 total entries, 1,000 affected
paths, and 4,096 characters per path. These limits are deliberately conservative
and are not user-configurable.

The scan excludes `.git`, `.pactile`, `.tmp`, `.tools`, `.codegraph`, dependency
and cache directories (`node_modules`, `vendor`, `.venv`, `venv`, `.cache`,
`.pnpm-store`, and common language/tool caches), plus build outputs such as
`dist`, `build`, `out`, `coverage`, `.next`, `.nuxt`, `.turbo`, and `target`.
It also excludes `.env` files, private-key file suffixes (`.pem`, `.key`,
`.p12`, `.pfx`), and `id_rsa*` / `id_ed25519*` names. The exact directory and
file rules are exported as `PROJECT_FILE_SNAPSHOT_EXCLUDED_DIRECTORIES` and
`PROJECT_FILE_SNAPSHOT_EXCLUDED_FILE_RULES` in `project-file-observer.ts`.

At completion, Review, and Close, Pactile scans the same bounded project tree
again and compares every included file with the Start baseline. Added files are
classified against the frozen Run write set, including files outside that set;
changed or deleted files are checked the same way. A declared write set that
names or overlaps an excluded path is rejected. Symlinks, special files,
root escapes, unreadable paths, limit overruns, Git metadata appearing after
Start, or a tree that changes during either scan fail closed. A failed Start
does not record a Run, so it can be retried after the project tree is safe and
within budget.

This baseline supports `local-result` and `documentation` Close delivery. The
Git observer and Git-bound execution receipts described below stay Git-only;
PR and merged-result delivery and managed worktrees always require Git.

## Candidate observation and execution receipt

`observeGitCandidate` takes an explicit repository-relative write set and
performs a bounded, read-only Git/filesystem observation. It records HEAD and
branch, separate staged/unstaged/untracked/conflict paths, Git diff/status
digests, and SHA-256 digests of current bytes for changed paths inside the
allowed write set plus every exact file declared in the Run write set. This
also binds unchanged deliverables at candidate freeze. Out-of-scope paths are
listed but their current bytes are
never read; a conflict, branch mismatch, or out-of-scope change makes the
observation ineligible for a candidate. Symlinks are fingerprinted by their
link-target text without reading through the link. The observer fails closed
when Git output exceeds 16 MiB, changed paths exceed 1,000, one current file
exceeds 8 MiB, total current bytes exceed 32 MiB, or the observed state changes
during collection.

For a Git-backed P35 Run, call `observeTaskRunCandidate({ run })` against its frozen
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

The planner and receipt APIs do not run commands or persist receipts. The V2
`run-result --outcome completed` CLI path adds the reserved Git or project-file
observer entry only after a real bounded observation succeeds; it rejects a
caller attempt to write either reserved ref. Failed and blocked Run results do
not produce candidate entries. A completed Run without the matching observer
entry cannot be closed.

Close re-observes the same Run workspace or standalone project and requires
exactly one matching observer entry, matching candidate fingerprint, and all
current changes inside the frozen write set. It stores a separate
`pactile-task-delivery-observer-v1` receipt with the candidate source, optional
Git HEAD, and current delivery-file SHA-256. `local-result` and `documentation`
paths must be safe project-relative files inside the Run write set, regular
files, and bound to current candidate bytes or (for Git Runs) the frozen Git
HEAD. Symlinks, outside paths, stale candidates, and caller-only URLs fail
closed.

`pull-request` and `merged-result` also require a clean candidate worktree,
delivery bytes present at candidate HEAD, and provider facts from the built-in
read-only GitHub REST adapter (`gh api -X GET`). PR ownership must match the
local GitHub `origin`; the provider head SHA must equal the candidate HEAD and
draft/closed-unmerged states are rejected. `merged-result` additionally needs
`--target-branch`, provider-confirmed merged state, the merge commit as an
ancestor of the local target branch, and identical delivery-file bytes at that
branch. Missing `gh` authentication/provider facts, unsupported providers,
unavailable local merge objects, or unknown target branches fail closed. The
adapter performs no fetch, checkout, ref update, or remote write; its command
runner is replaceable only at the internal unit-test seam.

Schema V2 readers continue to load older closures that predate the optional
delivery verification receipt. Every new Close writes the receipt and replaces
the caller's descriptive candidate observation with the Core re-observation;
the caller's candidate ID/fingerprint remains only a selector that must match
the actual Run snapshot. Serialized candidate receipts remain local task-state
evidence, not signatures against a caller that can rewrite the Kernel itself.
