# Run worktree lifecycle core

`packages/cli/src/pactile/worktree/manager.ts` owns the Git checks for a local Run workspace. Its `RunWorkspaceBinding` is a structural mirror of P35 `TaskRunWorkspaceBinding`: owner Run ID, canonical absolute path, branch, base commit SHA, write set, integration state, and reclamation state. The caller must persist the returned binding to the Task Kernel before dispatching work and must read it back before later lifecycle operations.

## Create and adopt

`createRunWorktree` resolves the requested base to a full commit SHA, validates the branch with Git, and creates a new branch under `.pactile/worktrees/<runId>`. It verifies the Git worktree registration and common directory before returning a binding. It never reuses an existing branch or path. If post-create verification fails, it reports the path for recovery and leaves it in place.

`adoptRunWorktree` accepts only an existing, registered checkout under `.pactile/worktrees`, in the same Git common directory, at the recorded branch and base SHA, with a clean tree. Adoption needs a recorded approver and evidence reference. A path already bound to another Run is refused. Reopening the same Run should use `inspectRunWorktree` with its stored binding instead of claiming the path again.

## Verify, integrate, and reclaim

`inspectRunWorktree` reports owner, path, registration, common-directory, branch, baseline, write-set, interruption, integration, and dirty-state findings. Dirty status includes ignored and untracked files so cleanup preserves them.

`verifyWorktreeIntegration` does not run a merge. It verifies that a completed Run has preserved result evidence, its clean worktree changes stay within the Run write set, and the requested target commit contains the worktree HEAD. The returned binding records `integrated` and `pending` reclamation; the caller must persist that transition before cleanup.

`reclaimRunWorktree` only considers a completed Run with matching ownership, persisted result evidence, integrated state, pending reclamation, and a clean registered checkout under the allowed absolute path. It repeats verification immediately before removal and calls `git worktree remove` without force. A failed precondition or Git refusal retains the path for handling; the manager never calls recursive filesystem deletion.

## Parallel write sets

`decideParallelWriteSets` treats empty or undeclared write sets as `*`. Overlapping paths are denied by default. An exception requires a receipt naming the exact Run pair and overlap paths, approver, evidence, and integration plan. Persist this authorization with the scheduling decision; the helper itself does not dispatch work.

The module does not wire Run Kernel transitions or CLI commands. The eventual caller must make Run state changes with the Kernel revision check, preserve result evidence before integration or cleanup, and keep failed, blocked, cancelled, interrupted, dirty, or unintegrated worktrees available for recovery.
