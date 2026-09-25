# Run worktree lifecycle core

`packages/cli/src/pactile/worktree/manager.ts` is the public facade for a local Run workspace. A binding records the owner Run ID, canonical absolute path, branch, base commit SHA, write set, integration state, and reclamation state. It also carries a manager credential, an integration receipt, and a persistent cleanup lease. The caller must persist a newly created or adopted manager binding to the Task Kernel before dispatching work and read it back before later lifecycle operations.

## Create and adopt

`createRunWorktree` resolves the requested base to a full commit SHA, validates the branch with Git, and creates a new branch under `.pactile/worktrees/<runId>`. Before returning a binding it writes a manager ownership record under the Git common directory at `pactile-run-workspaces-v1/<runId>.json`. That record binds the Run ID, canonical path, common directory, per-worktree Git directory, branch, base SHA, and write set. A caller-provided binding or empty `knownOwners` list is not proof of ownership. If post-create verification or record persistence fails, the worktree is left in place for recovery.

`adoptRunWorktree` accepts only an existing, registered checkout under `.pactile/worktrees`, in the same Git common directory, at the recorded branch and base SHA, with a clean tree. Adoption needs a recorded approver and evidence reference, which are stored in the manager ownership record. A path already recorded for another Run is refused. Reopening the same Run should use `inspectRunWorktree` with its stored binding instead of claiming the path again.

## Verify, integrate, and reclaim

`inspectRunWorktree` reports owner, manager provenance, path, Git directory, reverse registration, symbolic branch, common-directory, baseline, write-set, interruption, integration, and dirty-state findings. It checks both the linked worktree `.git` pointer and the admin directory's reverse `gitdir` link against Git's worktree registration. Dirty status includes ignored and untracked files so cleanup preserves them.

`verifyWorktreeIntegration` does not run a merge. It verifies that a completed Run has preserved result evidence, its clean worktree changes stay within the Run write set, and the requested target commit contains the worktree HEAD. It also compares each changed path's Git tree entry (mode, object type, and object ID) between the Run HEAD and target HEAD, then fingerprints those entries together with the Run base/head, result references, and candidate identity. An ancestry-only merge that discarded Run content is rejected.

`integrateTaskRunWorktree` verifies and persists the integration receipt against the completed Run's result evidence and candidate. It does not run the merge; the target branch must already contain the clean worktree HEAD.

`reclaimRunWorktree` performs automatic cleanup only after the same candidate is reviewed and the Task is closed with delivery evidence. It also requires the durable integration receipt, a host stop receipt verified from the associated Codex desktop or Pactile Pi bridge, exact ownership and Git registration, the expected integrated HEAD, and a clean worktree. A persisted lease prevents concurrent Pactile cleaners. The manager repeats these checks before invoking non-force `git worktree remove`, then rechecks branch ancestry and the changed-path content fingerprint after removal. If target content changed during removal, it restores the checkout from the preserved Run branch and records `recovery-required`; the manager delegates removal to Git rather than performing its own recursive filesystem deletion.

If a user edit, ignored or untracked file, unintegrated commit, host-receipt mismatch, stale lease, or path anomaly is found, the worktree is retained with a reason. If Git removes its registration but leaves ignored contents, the state is recorded as `partial-removal`; the residue is preserved and is not treated as a valid checkout. If a clean commit or target content change arrives in the final race window, the manager restores the checkout at the preserved Run branch head and records `recovery-required`. If restoration cannot be verified, Git refs and any remaining path are left for manual reconciliation. `planRunWorktreeCleanup` remains a manual fallback for cases that fail an automatic cleanup gate.

The final inspection narrows but cannot eliminate the interval before Git recursively deletes the checkout. An external writer can create an ignored file after the inspection callback and before deletion; non-force `git worktree remove` can delete that file because Git's clean check does not include ignored files. The cleanup lease records this exact residual risk in `riskDisclosure`. Automatic cleanup is therefore not an absolute guarantee that no external write can be lost.

## Parallel write sets

`decideParallelWriteSets` treats empty or undeclared write sets as `*`. Overlapping paths are denied by default. An exception requires a receipt naming the exact Run pair and overlap paths, approver, evidence, and integration plan. Persist this authorization with the scheduling decision; the helper itself does not dispatch work.

The manager's Run Kernel mutations use revision checks for host binding, settlement refs, result persistence, workspace integration, cleanup lease acquisition, and cleanup outcome. The generic worktree manager remains separate from `commands/task.ts`; CLI lifecycle wiring is a later integration step. Failed, blocked, cancelled, interrupted, dirty, or unintegrated worktrees remain available for recovery.
