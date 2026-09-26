import {
  adoptRunWorktree,
  createRunWorktree,
} from "./manager-core.js";
import { verifyWorktreeIntegration, type WorktreeIntegrationReceipt } from "./integration-evidence.js";
import { WorktreeManagerError, type RunWorkspaceBinding } from "./manager-types.js";
import {
  bindTaskRunWorkspace,
  fingerprintTaskValue,
  readTaskKernel,
  recordTaskRunWorkspaceClaimRefusal,
  recordTaskRunWorkspaceIntegration,
  TASK_RUN_WORKSPACE_CLAIM_ERROR_CODES,
  type TaskKernelMutationResult,
  type TaskKernelSnapshotV2,
  type TaskRunWorkspaceClaimErrorCode,
  type TaskRunWorkspaceClaimOperation,
  type TaskRunV2,
} from "../../core/task/task-kernel.js";
export interface StoredTaskRun {
  kernel: TaskKernelSnapshotV2;
  run: TaskRunV2;
}

export function readStoredTaskRun(root: string, taskDir: string, runId: string): StoredTaskRun {
  const read = readTaskKernel({ root, taskDir });
  if (read?.kind !== "task-kernel-v2") throw new WorktreeManagerError("task-kernel-unavailable", "A valid Task Kernel v2 is required for managed Run worktrees");
  const run = read.kernel.runs.find((item) => item.id === runId);
  if (!run) throw new WorktreeManagerError("run-not-found", `Task Kernel has no Run ${runId}`);
  return { kernel: read.kernel, run };
}

function rawErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function normalizeClaimErrorCode(error: unknown): TaskRunWorkspaceClaimErrorCode {
  const code = rawErrorCode(error)?.toLowerCase().replaceAll("_", "-");
  return code && (TASK_RUN_WORKSPACE_CLAIM_ERROR_CODES as readonly string[]).includes(code)
    ? code as TaskRunWorkspaceClaimErrorCode
    : "claim-failed";
}

function isRevisionConflict(error: unknown): boolean {
  return rawErrorCode(error)?.toUpperCase() === "REVISION_CONFLICT";
}

function recordWorkspaceClaimRefusal(
  input: CreateTaskRunWorktreeInput | AdoptTaskRunWorktreeInput,
  operation: TaskRunWorkspaceClaimOperation,
  claimError: unknown,
): void {
  const errorCode = normalizeClaimErrorCode(claimError);
  const requestKeyFingerprint = fingerprintTaskValue(input.idempotencyKey);
  const idempotencyKey = `workspace-claim-refused:${fingerprintTaskValue({
    runId: input.runId,
    operation,
    requestKeyFingerprint,
    errorCode,
  })}`;
  const unrecorded = (): WorktreeManagerError => new WorktreeManagerError(
    "workspace-claim-refusal-unrecorded",
    `The ${operation} claim was refused (${errorCode}), but its refusal could not be persisted; reconcile the Run before retrying.`,
  );

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const latest = readStoredTaskRun(input.repoRoot, input.taskDir, input.runId);
      recordTaskRunWorkspaceClaimRefusal({
        root: input.repoRoot,
        taskDir: input.taskDir,
        expectedRevision: latest.kernel.revision,
        runId: input.runId,
        operation,
        errorCode,
        actor: input.actor,
        idempotencyKey,
      });
      return;
    } catch (error) {
      if (attempt === 0 && isRevisionConflict(error)) continue;
      throw unrecorded();
    }
  }
  throw unrecorded();
}

export interface CreateTaskRunWorktreeInput {
  repoRoot: string;
  taskDir: string;
  runId: string;
  branch: string;
  baseRef: string;
  actor: string;
  idempotencyKey: string;
}

export function createTaskRunWorktree(input: CreateTaskRunWorktreeInput): {
  binding: RunWorkspaceBinding;
  mutation: TaskKernelMutationResult;
} {
  const stored = readStoredTaskRun(input.repoRoot, input.taskDir, input.runId);
  if (stored.kernel.runs.at(-1)?.id !== stored.run.id || (stored.run.state !== "waiting" && stored.run.state !== "running")) {
    throw new WorktreeManagerError("run-not-active", "Only the latest waiting or running Run can receive a managed worktree");
  }
  if (stored.run.workspace) throw new WorktreeManagerError("workspace-already-bound", "Run already has a workspace binding; inspect it instead of replacing it");
  let binding: RunWorkspaceBinding;
  try {
    binding = createRunWorktree({
      repoRoot: input.repoRoot,
      runId: input.runId,
      branch: input.branch,
      baseRef: input.baseRef,
      writeSet: stored.run.writeSetSnapshot,
    });
  } catch (error) {
    recordWorkspaceClaimRefusal(input, "create", error);
    throw error;
  }
  try {
    const mutation = bindTaskRunWorkspace({
      root: input.repoRoot,
      taskDir: input.taskDir,
      expectedRevision: stored.kernel.revision,
      runId: input.runId,
      workspace: binding,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
    });
    return { binding, mutation };
  } catch {
    throw new WorktreeManagerError("workspace-kernel-bind-failed", "The created checkout is preserved, but its Task Kernel bind failed; do not dispatch work until it is reconciled", binding.canonicalPath);
  }
}

export interface AdoptTaskRunWorktreeInput {
  repoRoot: string;
  taskDir: string;
  runId: string;
  canonicalPath: string;
  branch: string;
  baseSha: string;
  authorization: { approvedBy: string; approvedAt: string; evidenceRef: string };
  actor: string;
  idempotencyKey: string;
}

export function adoptTaskRunWorktree(input: AdoptTaskRunWorktreeInput): {
  binding: RunWorkspaceBinding;
  mutation: TaskKernelMutationResult;
} {
  const stored = readStoredTaskRun(input.repoRoot, input.taskDir, input.runId);
  if (stored.kernel.runs.at(-1)?.id !== stored.run.id || (stored.run.state !== "waiting" && stored.run.state !== "running")) {
    throw new WorktreeManagerError("run-not-active", "Only the latest waiting or running Run can adopt a managed worktree");
  }
  if (stored.run.workspace) throw new WorktreeManagerError("workspace-already-bound", "Run already has a workspace binding; inspect it instead of adopting another path");
  let binding: RunWorkspaceBinding;
  try {
    binding = adoptRunWorktree({
      repoRoot: input.repoRoot,
      runId: input.runId,
      runState: stored.run.state,
      canonicalPath: input.canonicalPath,
      branch: input.branch,
      baseSha: input.baseSha,
      writeSet: stored.run.writeSetSnapshot,
      authorization: input.authorization,
    });
  } catch (error) {
    recordWorkspaceClaimRefusal(input, "adopt", error);
    throw error;
  }
  try {
    const mutation = bindTaskRunWorkspace({
      root: input.repoRoot,
      taskDir: input.taskDir,
      expectedRevision: stored.kernel.revision,
      runId: input.runId,
      workspace: binding,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
    });
    return { binding, mutation };
  } catch {
    throw new WorktreeManagerError("workspace-kernel-bind-failed", "The adopted checkout is preserved, but its Task Kernel bind failed; do not dispatch work until it is reconciled", binding.canonicalPath);
  }
}

export interface IntegrateTaskRunWorktreeInput {
  repoRoot: string;
  taskDir: string;
  runId: string;
  targetRef: string;
  actor: string;
  idempotencyKey: string;
}

export function integrateTaskRunWorktree(input: IntegrateTaskRunWorktreeInput): {
  binding: RunWorkspaceBinding;
  receipt: WorktreeIntegrationReceipt;
  mutation: TaskKernelMutationResult;
} {
  const stored = readStoredTaskRun(input.repoRoot, input.taskDir, input.runId);
  const { workspace, result, candidateSnapshot } = stored.run;
  if (!workspace?.manager || !result || !candidateSnapshot) {
    throw new WorktreeManagerError("workspace-not-manager-owned", "Integration requires a manager-owned workspace and preserved Run candidate/result");
  }
  const verified = verifyWorktreeIntegration({
    repoRoot: input.repoRoot,
    runId: input.runId,
    runState: stored.run.state,
    binding: workspace,
    targetRef: input.targetRef,
    result: {
      runId: input.runId,
      summary: result.summary,
      evidenceRefs: result.evidenceRefs,
      candidateSnapshotId: candidateSnapshot.id,
      candidateFingerprint: candidateSnapshot.fingerprint,
    },
  });
  const receipt = { ...verified.receipt, candidateSnapshotId: candidateSnapshot.id, candidateFingerprint: candidateSnapshot.fingerprint };
  const mutation = recordTaskRunWorkspaceIntegration({
    root: input.repoRoot,
    taskDir: input.taskDir,
    expectedRevision: stored.kernel.revision,
    runId: input.runId,
    receipt,
    actor: input.actor,
    idempotencyKey: input.idempotencyKey,
  });
  const run = mutation.kernel.runs.find((item) => item.id === input.runId);
  if (!run?.workspace) throw new WorktreeManagerError("integration-persist-failed", "The verified integration receipt was not present in the returned Task Kernel");
  return { binding: run.workspace, receipt, mutation };
}
