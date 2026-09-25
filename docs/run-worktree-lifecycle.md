# Run worktree lifecycle core

`packages/cli/src/pactile/worktree/manager.ts` owns the Git checks for a local Run workspace. Its `RunWorkspaceBinding` is a structural mirror of P35 `TaskRunWorkspaceBinding`: owner Run ID, canonical absolute path, branch, base commit SHA, write set, integration state, and reclamation state. The caller must persist the returned binding to the Task Kernel before dispatching work and must read it back before later lifecycle operations.

## Create and adopt

`createRunWorktree` resolves the requested base to a full commit SHA, validates the branch with Git, and creates a new branch under `.pactile/worktrees/<runId>`. Before returning a binding it writes a manager ownership record under the Git common directory at `pactile-run-workspaces-v1/<runId>.json`. That record binds the Run ID, canonical path, common directory, per-worktree Git directory, branch, base SHA, and write set. A caller-provided binding or empty `knownOwners` list is not proof of ownership. If post-create verification or record persistence fails, the worktree is left in place for recovery.

`adoptRunWorktree` accepts only an existing, registered checkout under `.pactile/worktrees`, in the same Git common directory, at the recorded branch and base SHA, with a clean tree. Adoption needs a recorded approver and evidence reference, which are stored in the manager ownership record. A path already recorded for another Run is refused. Reopening the same Run should use `inspectRunWorktree` with its stored binding instead of claiming the path again.

## Verify, integrate, and reclaim

`inspectRunWorktree` reports owner, manager provenance, path, Git directory, reverse registration, symbolic branch, common-directory, baseline, write-set, interruption, integration, and dirty-state findings. It checks both the linked worktree `.git` pointer and the admin directory's reverse `gitdir` link against Git's worktree registration. Dirty status includes ignored and untracked files so cleanup preserves them.

`verifyWorktreeIntegration` does not run a merge. It verifies that a completed Run has preserved result evidence, its clean worktree changes stay within the Run write set, and the requested target commit contains the worktree HEAD. The returned binding records `integrated` and `pending` reclamation; the caller must persist that transition before cleanup.

`planRunWorktreeCleanup` only produces a manual cleanup plan for a completed Run with verified manager ownership, persisted result evidence, integrated state, pending reclamation, and a clean registered checkout under the allowed absolute path. The plan records the expected HEAD, branch, common and per-worktree Git directories, target branch/head, and a non-force `git worktree remove` argument vector. Automatic deletion is disabled because a clean commit can arrive between preflight and removal; the branch ref remaining would not preserve the worktree contents. A human must re-inspect all recorded values immediately before executing the plan and retain the checkout on any mismatch. `reclaimRunWorktree` remains a deprecated compatibility alias that also only returns this plan. No manager path recursively deletes a worktree.

## Parallel write sets

`decideParallelWriteSets` treats empty or undeclared write sets as `*`. Overlapping paths are denied by default. An exception requires a receipt naming the exact Run pair and overlap paths, approver, evidence, and integration plan. Persist this authorization with the scheduling decision; the helper itself does not dispatch work.

The module does not wire Run Kernel transitions or CLI commands. The eventual caller must make Run state changes with the Kernel revision check, preserve result evidence before integration or cleanup, and keep failed, blocked, cancelled, interrupted, dirty, or unintegrated worktrees available for recovery.
