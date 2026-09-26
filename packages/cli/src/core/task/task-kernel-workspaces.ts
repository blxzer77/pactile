import path from "node:path";

import { KernelError, requireNonEmptyString } from "./kernel-contract.js";
import { appendDomainEvent, appendMutation, mutateTaskKernel } from "./task-kernel-store-v2.js";
import {
  fingerprintTaskValue,
  parseWorkspaceBinding,
  parseWorkspaceCleanupLease,
  parseWorkspaceIntegrationReceipt,
} from "./task-kernel-schema.js";
import { canonicalProjectRoot } from "./task-kernel-paths.js";
import type {
  AcquireTaskRunWorkspaceCleanupLeaseRequest,
  BindTaskRunWorkspaceRequest,
  FinishTaskRunWorkspaceCleanupRequest,
  RecordTaskRunWorkspaceIntegrationRequest,
  RecordTaskRunWorkspaceClaimRefusalRequest,
  RecordTaskRunWorkspaceCleanupRefusalRequest,
  TaskKernelMutationResult,
  TaskKernelSnapshotV2,
  TaskRunV2,
  TaskRunWorkspaceBinding,
  TaskRunWorkspaceClaimErrorCode,
} from "./task-kernel-types.js";
import { TASK_RUN_WORKSPACE_CLEANUP_RISK_DISCLOSURE, TASK_RUN_WORKSPACE_CLAIM_ERROR_CODES } from "./task-kernel-types.js";

function runAt(current: TaskKernelSnapshotV2, runId: string): { run: TaskRunV2; index: number } {
  const index = current.runs.findIndex((item) => item.id === runId);
  if (index < 0) throw new KernelError("NOT_FOUND", `Run not found: ${runId}`);
  const run = current.runs[index];
  if (!run) throw new KernelError("CORRUPT_STATE", `Run is missing: ${runId}`);
  return { run, index };
}

function replaceRun(current: TaskKernelSnapshotV2, index: number, run: TaskRunV2): TaskKernelSnapshotV2 {
  return { ...current, runs: current.runs.map((item, i) => i === index ? run : item) };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function sameWriteSet(left: readonly string[], right: readonly string[]): boolean {
  const normalize = (values: readonly string[]): string[] => values
    .map((value) => value.replaceAll("\\", "/").replace(/\/$/, ""))
    .map((value) => process.platform === "win32" ? value.toLowerCase() : value)
    .sort();
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

export function bindTaskRunWorkspace(request: BindTaskRunWorkspaceRequest): TaskKernelMutationResult {
  const actor = requireNonEmptyString(request.actor, "actor");
  const runId = requireNonEmptyString(request.runId, "runId");
  const workspace = parseWorkspaceBinding(request.workspace, runId, "workspace");
  if (!workspace.manager) throw new KernelError("INVALID_REQUEST", "Workspace binding requires manager-owned provenance");
  if (workspace.integrationState !== "not-integrated" || workspace.integrationReceipt || workspace.cleanupLease) {
    throw new KernelError("INVALID_REQUEST", "A new manager workspace cannot contain integration or cleanup state");
  }
  const fingerprint = fingerprintTaskValue({ runId, workspace });
  return mutateTaskKernel(request.root, request.taskDir, request.expectedRevision, actor, request.idempotencyKey, fingerprint, request.cwd, (current) => {
    const { run, index } = runAt(current, runId);
    if (current.runs.at(-1)?.id !== runId || (run.state !== "running" && run.state !== "waiting")) {
      throw new KernelError("INVALID_TRANSITION", "Managed workspace can only bind to the latest active or waiting Run");
    }
    if (run.workspace) throw new KernelError("INVALID_TRANSITION", "Run workspace cannot be replaced after it has been bound");
    const root = canonicalProjectRoot(request.root, request.cwd);
    const manager = workspace.manager;
    if (!manager || path.resolve(manager.projectRoot) !== path.resolve(root)) {
      throw new KernelError("INVALID_REQUEST", "Manager provenance project root does not match this Task Kernel");
    }
    const runWriteSet = [...run.writeSetSnapshot].sort();
    if (!sameWriteSet(workspace.writeSet, runWriteSet)) throw new KernelError("INVALID_REQUEST", "Workspace write set must match the Run write-set snapshot");
    if (
      run.candidateBaseSha &&
      run.candidateBaseSha.toLowerCase() !== workspace.baseSha.toLowerCase()
    ) {
      throw new KernelError(
        "CANDIDATE_MISMATCH",
        "Managed workspace base must match the Git commit captured when the Run started.",
      );
    }
    const next = replaceRun(current, index, {
      ...run,
      candidateBaseSha: workspace.baseSha,
      candidateBaseBranch: workspace.branch,
      workspace,
    });
    return appendDomainEvent(next, actor, request.idempotencyKey, "run.workspace-bound", runId, fingerprint);
  });
}

export function recordTaskRunWorkspaceIntegration(request: RecordTaskRunWorkspaceIntegrationRequest): TaskKernelMutationResult {
  const actor = requireNonEmptyString(request.actor, "actor");
  const runId = requireNonEmptyString(request.runId, "runId");
  const receipt = parseWorkspaceIntegrationReceipt(request.receipt, "workspaceIntegrationReceipt");
  const fingerprint = fingerprintTaskValue({ runId, receipt });
  return mutateTaskKernel(request.root, request.taskDir, request.expectedRevision, actor, request.idempotencyKey, fingerprint, request.cwd, (current) => {
    const { run, index } = runAt(current, runId);
    const workspace = run.workspace;
    if (!workspace?.manager) throw new KernelError("INVALID_TRANSITION", "Only a manager-owned Run workspace can record integration");
    if (run.state !== "completed" || !run.result || !run.candidateSnapshot) {
      throw new KernelError("INVALID_TRANSITION", "Only a completed Run with preserved result and candidate can be integrated");
    }
    if (workspace.integrationState !== "not-integrated" || workspace.integrationReceipt) {
      throw new KernelError("INVALID_TRANSITION", "Run workspace integration receipt is immutable once recorded");
    }
    if (receipt.runId !== run.id || receipt.candidateSnapshotId !== run.candidateSnapshot.id
      || receipt.candidateFingerprint !== run.candidateSnapshot.fingerprint
      || !receipt.contentFingerprint
      || !sameStrings(receipt.resultEvidenceRefs, run.result.evidenceRefs) || receipt.resultEvidenceRefs.length === 0) {
      throw new KernelError("INVALID_REQUEST", "Integration receipt does not match the completed Run result and candidate");
    }
    const nextWorkspace = { ...workspace, integrationState: "integrated" as const, reclamationState: "pending" as const, integrationReceipt: receipt };
    const next = replaceRun(current, index, { ...run, workspace: nextWorkspace });
    return appendDomainEvent(next, actor, request.idempotencyKey, "run.workspace-integrated", runId, fingerprint);
  });
}

export function acquireTaskRunWorkspaceCleanupLease(request: AcquireTaskRunWorkspaceCleanupLeaseRequest): TaskKernelMutationResult {
  const actor = requireNonEmptyString(request.actor, "actor");
  const runId = requireNonEmptyString(request.runId, "runId");
  const lease = parseWorkspaceCleanupLease({ ...request.lease, state: "held", reason: null }, "workspaceCleanupLease");
  if (lease.riskDisclosure !== TASK_RUN_WORKSPACE_CLEANUP_RISK_DISCLOSURE) {
    throw new KernelError("INVALID_REQUEST", "Workspace cleanup lease must persist the accepted Git removal race disclosure");
  }
  const fingerprint = fingerprintTaskValue({ runId, lease });
  return mutateTaskKernel(request.root, request.taskDir, request.expectedRevision, actor, request.idempotencyKey, fingerprint, request.cwd, (current) => {
    const { run, index } = runAt(current, runId);
    const workspace = run.workspace;
    if (!workspace?.manager || !workspace.integrationReceipt?.contentFingerprint || workspace.integrationState !== "integrated") {
      throw new KernelError("INVALID_TRANSITION", "Workspace cleanup requires manager ownership and a persisted integration receipt");
    }
    if (run.state !== "completed" || !run.result?.summary.trim() || !run.result.evidenceRefs.length || !run.candidateSnapshot) {
      throw new KernelError("INVALID_TRANSITION", "Workspace cleanup requires a completed Run with preserved result and candidate evidence");
    }
    const closure = current.closure;
    if (current.phase !== "close" || closure?.runId !== run.id
      || closure.candidateSnapshotId !== run.candidateSnapshot.id
      || closure.candidateFingerprint !== run.candidateSnapshot.fingerprint
      || closure.deliveryEvidence.reference.trim() === "") {
      throw new KernelError("INVALID_TRANSITION", "Workspace cleanup is allowed only after the same candidate is closed with delivery evidence");
    }
    const terminal = run.host?.stopReceipt;
    if (terminal?.runId !== run.id || terminal.taskId !== current.identity.taskId || terminal.contractStale) {
      throw new KernelError("INVALID_TRANSITION", "Workspace cleanup requires a verified, persisted host terminal receipt");
    }
    const eligibleHost = run.host?.host === "codex-desktop"
      ? terminal.terminalStatus === "completed" && terminal.source === "codex-desktop-bridge" && terminal.evidenceLevel === "desktop-native"
      : run.host?.host === "pi"
        ? terminal.terminalStatus === "exited" && terminal.source === "pactile-pi-rpc"
        : false;
    if (!eligibleHost) throw new KernelError("INVALID_TRANSITION", "This host terminal receipt does not authorize automatic worktree cleanup");
    const integration = workspace.integrationReceipt;
    if (lease.expectedHeadSha.toLowerCase() !== integration.worktreeHeadSha.toLowerCase()
      || lease.targetBranch !== integration.targetBranch || lease.targetHeadSha.toLowerCase() !== integration.targetHeadSha.toLowerCase()
      || lease.receiptRef !== terminal.receiptRef) {
      throw new KernelError("INVALID_REQUEST", "Cleanup lease does not match the persisted integration and host receipts");
    }
    const priorLease = workspace.cleanupLease;
    if (priorLease?.state === "held" || priorLease?.state === "partial-removal" || priorLease?.state === "recovery-required") {
      throw new KernelError("INVALID_TRANSITION", "An existing cleanup lease or recovery state must be reconciled before retry");
    }
    const nextWorkspace = { ...workspace, cleanupLease: lease, reclamationState: "pending" as const };
    const next = replaceRun(current, index, { ...run, workspace: nextWorkspace });
    return appendDomainEvent(next, actor, request.idempotencyKey, "run.workspace-cleanup-acquired", runId, fingerprint);
  });
}

export function finishTaskRunWorkspaceCleanup(request: FinishTaskRunWorkspaceCleanupRequest): TaskKernelMutationResult {
  const actor = requireNonEmptyString(request.actor, "actor");
  const runId = requireNonEmptyString(request.runId, "runId");
  const leaseId = requireNonEmptyString(request.leaseId, "leaseId");
  if (request.result !== "reclaimed" && !request.reason?.trim()) throw new KernelError("INVALID_REQUEST", "A retained cleanup result requires a reason");
  const reason = request.result === "reclaimed" ? null : request.reason?.trim() ?? null;
  const fingerprint = fingerprintTaskValue({ runId, leaseId, result: request.result, reason, updatedManagerBinding: request.updatedManagerBinding ?? null });
  return mutateTaskKernel(request.root, request.taskDir, request.expectedRevision, actor, request.idempotencyKey, fingerprint, request.cwd, (current) => {
    const { run, index } = runAt(current, runId);
    const workspace = run.workspace;
    const manager = workspace?.manager;
    const lease = workspace?.cleanupLease;
    if (!manager || lease?.state !== "held" || lease.leaseId !== leaseId) {
      throw new KernelError("INVALID_TRANSITION", "Cleanup result does not match the currently held Run workspace lease");
    }
    if (request.updatedManagerBinding) {
      const update = request.updatedManagerBinding;
      if (update.version !== 1 || update.credentialId !== manager.credentialId
        || update.projectRoot !== manager.projectRoot || update.commonDir !== manager.commonDir
        || update.source !== manager.source || !path.isAbsolute(update.gitDir)) {
        throw new KernelError("INVALID_REQUEST", "Workspace recovery manager binding does not preserve the original owner credential and Git common directory");
      }
    }
    const reclamationState: TaskRunWorkspaceBinding["reclamationState"] = request.result === "reclaimed" ? "reclaimed"
      : request.result === "retained" ? "failed" : "recovery-required";
    const nextLease = { ...lease, state: request.result, reason };
    const nextWorkspace = { ...workspace, ...(request.updatedManagerBinding ? { manager: request.updatedManagerBinding } : {}), cleanupLease: nextLease, reclamationState };
    const next = replaceRun(current, index, { ...run, workspace: nextWorkspace });
    const type = request.result === "reclaimed" ? "run.workspace-reclaimed"
      : request.result === "retained" ? "run.workspace-retained" : "run.workspace-recovery-required";
    return appendDomainEvent(next, actor, request.idempotencyKey, type, runId, fingerprint);
  });
}

/** Persist a fail-closed cleanup refusal even when no cleanup lease can be acquired. */
export function recordTaskRunWorkspaceCleanupRefusal(request: RecordTaskRunWorkspaceCleanupRefusalRequest): TaskKernelMutationResult {
  const actor = requireNonEmptyString(request.actor, "actor");
  const runId = requireNonEmptyString(request.runId, "runId");
  const reason = requireNonEmptyString(request.reason, "reason")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  if (!reason) throw new KernelError("INVALID_REQUEST", "Cleanup refusal reason must not be empty");
  const fingerprint = fingerprintTaskValue({ runId, result: "retained", reason });
  return mutateTaskKernel(request.root, request.taskDir, request.expectedRevision, actor, request.idempotencyKey, fingerprint, request.cwd, (current) => {
    const { run } = runAt(current, runId);
    return appendMutation(current, actor, request.idempotencyKey, "run.workspace-cleanup-refused", run.id,
      fingerprint, {}, `Workspace cleanup refused: ${reason}`);
  });
}

const WORKSPACE_CLAIM_REFUSAL_REASONS: Readonly<Record<TaskRunWorkspaceClaimErrorCode, string>> = {
  "owner-conflict": "Existing Run ownership prevents this workspace claim.",
  "path-exists": "The requested workspace location already exists.",
  "invalid-run-id": "The Run identifier failed workspace ownership validation.",
  "invalid-write-set": "The Run write set failed workspace validation.",
  "invalid-ref": "The Git reference could not be verified for this workspace claim.",
  "path-anomaly": "The workspace path failed canonical location checks.",
  "invalid-repository": "The repository identity could not be verified.",
  "adoption-not-authorized": "Recorded adoption authorization is missing or invalid.",
  "adoption-not-safe": "The existing checkout failed adoption safety checks.",
  "git-command-failed": "Git could not complete the workspace claim checks.",
  "git-path-unrepresentable": "The Git path could not be verified safely.",
  "gitdir-mismatch": "The Git registration did not match the workspace path.",
  "manager-provenance-invalid": "Existing manager ownership evidence is invalid.",
  "manager-provenance-write-failed": "Manager ownership evidence could not be recorded.",
  "worktree-create-failed": "Git could not create and register the requested checkout.",
  "post-create-verification-failed": "The created checkout failed verification; preserve it for recovery.",
  "claim-failed": "The workspace claim did not pass manager validation or persistence.",
};

/** Persist a redacted create/adopt refusal without changing Run or workspace ownership. */
export function recordTaskRunWorkspaceClaimRefusal(request: RecordTaskRunWorkspaceClaimRefusalRequest): TaskKernelMutationResult {
  const actor = requireNonEmptyString(request.actor, "actor");
  const runId = requireNonEmptyString(request.runId, "runId");
  if (request.operation !== "create" && request.operation !== "adopt") {
    throw new KernelError("INVALID_REQUEST", "Workspace claim operation is invalid");
  }
  if (!(TASK_RUN_WORKSPACE_CLAIM_ERROR_CODES as readonly string[]).includes(request.errorCode)) {
    throw new KernelError("INVALID_REQUEST", "Workspace claim refusal code is invalid");
  }
  const reason = WORKSPACE_CLAIM_REFUSAL_REASONS[request.errorCode];
  if (!reason) throw new KernelError("INVALID_REQUEST", "Workspace claim refusal code is invalid");
  const fingerprint = fingerprintTaskValue({ runId, operation: request.operation, errorCode: request.errorCode, reason });
  return mutateTaskKernel(request.root, request.taskDir, request.expectedRevision, actor, request.idempotencyKey, fingerprint, request.cwd, (current) => {
    const { run } = runAt(current, runId);
    return appendMutation(
      current,
      actor,
      request.idempotencyKey,
      "run.workspace-claim-refused",
      run.id,
      fingerprint,
      {},
      `Workspace ${request.operation} claim refused [${request.errorCode}]: ${reason}`,
    );
  });
}
