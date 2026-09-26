import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assertAllowedPath,
  branchRef,
  ensureAllowedRoot,
  assertNoSymlinkBetween,
  git,
  isAncestor,
  pathKey,
  pathWithin,
  registrations,
  repoIdentity,
  resolveCommit,
  resolveLocalBranchTarget,
  verifyLinkedGitDirectory,
} from "./git-probe.js";
import { readAllManagerProvenance, synchronizeManagerProvenanceGitDir } from "./manager-provenance.js";
import { inspectRunWorktree } from "./manager-core.js";
import {
  WorktreeManagerError,
  type GitIdentity,
  type ManagerProvenance,
  type RunWorkspaceBinding,
} from "./manager-types.js";
import { fingerprintRunContentAtTarget, verifyWorktreeIntegration, type WorktreeCleanupResult } from "./integration-evidence.js";
import {
  acquireTaskRunWorkspaceCleanupLease,
  fingerprintTaskValue,
  recordTaskRunHostStopReceipt,
  recordTaskRunWorkspaceCleanupRefusal,
  finishTaskRunWorkspaceCleanup,
  type TaskKernelMutationResult,
  type TaskKernelSnapshotV2,
  type TaskRunHostStopReceipt,
  type TaskRunV2,
} from "../../core/task/task-kernel.js";
import type { TaskRunWorkspaceManagerBinding } from "../../core/task/task-kernel-types.js";
import { TASK_RUN_WORKSPACE_CLEANUP_RISK_DISCLOSURE } from "../../core/task/task-kernel-types.js";
import { readStoredTaskRun } from "./run-workspace-lifecycle.js";
import { removeManagedGitWorktree } from "./git-removal.js";
type UnknownRecord = Record<string, unknown>;

function recordValue(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function valueOf(record: UnknownRecord, ...names: string[]): unknown {
  for (const name of names) if (record[name] !== undefined) return record[name];
  return undefined;
}

function textOf(record: UnknownRecord, ...names: string[]): string | null {
  const value = valueOf(record, ...names);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOf(record: UnknownRecord, ...names: string[]): number | null {
  const value = valueOf(record, ...names);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function boolOf(record: UnknownRecord, ...names: string[]): boolean | null {
  const value = valueOf(record, ...names);
  return typeof value === "boolean" ? value : null;
}

function receiptRecords(value: unknown): UnknownRecord[] {
  if (Array.isArray(value)) return value.map(recordValue).filter((item): item is UnknownRecord => item !== null);
  const record = recordValue(value);
  if (!record) return [];
  const nested = valueOf(record, "receipts", "items");
  if (Array.isArray(nested)) return nested.map(recordValue).filter((item): item is UnknownRecord => item !== null);
  return [record];
}

async function readVerifiedHostStopReceipt(root: string, taskDir: string, kernel: TaskKernelSnapshotV2, run: TaskRunV2): Promise<TaskRunHostStopReceipt> {
  const host = run.host;
  const candidate = run.candidateSnapshot;
  if (!host || !candidate) throw new WorktreeManagerError("host-stop-unverified", "Run host binding and persisted candidate are required before cleanup");
  if (host.contractFingerprint !== fingerprintTaskValue(kernel.definition)) {
    throw new WorktreeManagerError("host-contract-stale", "Run host receipt is bound to an outdated Task contract");
  }
  if (host.host === "codex-desktop") {
    const module = await import("../codex/bridge.js") as unknown as UnknownRecord;
    const reader = module.readCodexHostStopReceipts;
    if (typeof reader !== "function") throw new WorktreeManagerError("host-stop-reader-unavailable", "Codex bridge does not expose its verified terminal receipt reader");
    const raw = await (reader as (root: string, taskDir: string, runId: string) => unknown)(root, taskDir, run.id);
    const records = receiptRecords(raw).filter((item) => textOf(item, "runId", "run_id", "taskRunId", "task_run_id") === run.id);
    if (records.length !== 1) throw new WorktreeManagerError("host-stop-unverified", "Codex must return exactly one verified terminal receipt for this Run");
    const item = records[0];
    if (!item) throw new WorktreeManagerError("host-stop-unverified", "Codex terminal receipt was empty");
    const createRequestId = textOf(item, "createRequestId", "create_request_id", "startRequestId", "start_request_id");
    const waitRequestId = textOf(item, "waitRequestId", "wait_request_id");
    const waitReceiptId = textOf(item, "waitReceiptId", "wait_receipt_id", "settleReceiptId", "settle_receipt_id");
    const evidenceRef = textOf(item, "evidenceRef", "evidence_ref");
    const candidateId = textOf(item, "candidateSnapshotId", "candidate_snapshot_id");
    const candidateFingerprint = textOf(item, "candidateFingerprint", "candidate_fingerprint");
    const candidateSource = textOf(item, "candidateSource", "candidate_source");
    const hostId = textOf(item, "hostId", "host_id");
    const threadId = textOf(item, "threadId", "thread_id");
    const status = textOf(item, "status", "terminalStatus", "terminal_status");
    const source = textOf(item, "source") ?? "codex-desktop-bridge";
    const assurance = textOf(item, "assurance") ?? "host-reported";
    const evidenceLevel = textOf(item, "evidenceLevel", "evidence_level");
    const contractFingerprint = textOf(item, "contractFingerprint", "contract_fingerprint");
    const stale = boolOf(item, "contractStale", "contract_stale");
    if (host.role !== "execute" || host.assuranceSource !== "codex-desktop-native"
      || hostId !== host.hostId || threadId !== host.threadId || source !== "codex-desktop-bridge"
      || assurance !== "host-reported" || evidenceLevel !== "desktop-native" || status !== "completed"
      || stale !== false || createRequestId === null || waitRequestId === null || waitReceiptId === null
      || evidenceRef === null || candidateId !== candidate.id || candidateFingerprint !== candidate.fingerprint
      || (candidateSource !== "captured" && candidateSource !== "derived")
      || contractFingerprint !== host.contractFingerprint
      || !host.requestRefs.includes(createRequestId) || !host.requestRefs.includes(waitRequestId)
      || !host.eventRefs.includes(waitReceiptId) || !host.resultRefs.includes(evidenceRef)) {
      throw new WorktreeManagerError("host-stop-unverified", "Codex terminal receipt does not match the bound thread, wait request, candidate, contract, or durable refs");
    }
    const requestKernelRevision = numberOf(item, "requestKernelRevision", "request_kernel_revision");
    const receiptKernelRevision = numberOf(item, "receiptKernelRevision", "receipt_kernel_revision", "currentKernelRevision", "current_kernel_revision");
    const receiptRef = textOf(item, "receiptRef", "receipt_ref") ?? waitReceiptId;
    const recordedAt = textOf(item, "recordedAt", "recorded_at");
    if (requestKernelRevision === null || receiptKernelRevision === null || recordedAt === null) {
      throw new WorktreeManagerError("host-stop-unverified", "Codex terminal receipt lacks durable revisions or timestamp");
    }
    return {
      source, assurance, evidenceLevel, taskId: kernel.identity.taskId, runId: run.id,
      sessionId: host.sessionId, threadId: host.threadId, startRequestId: createRequestId,
      settleReceiptId: waitReceiptId, terminalStatus: status, requestKernelRevision,
      receiptKernelRevision, contractFingerprint, contractStale: false,
      candidateSnapshotId: candidate.id, candidateFingerprint: candidate.fingerprint,
      candidateSource,
      receiptRef, evidenceRef, recordedAt,
    };
  }
  if (host.host === "pi") {
    const module = await import("../pi/bridge.js") as unknown as UnknownRecord;
    const reader = module.readPiHostStopReceipt;
    if (typeof reader !== "function") throw new WorktreeManagerError("host-stop-reader-unavailable", "Pi bridge does not expose its verified terminal receipt reader");
    const item = recordValue(await (reader as (root: string, taskDir: string, runId: string) => unknown)(root, taskDir, run.id));
    if (!item) throw new WorktreeManagerError("host-stop-unverified", "Pi has no persisted process exit receipt for this Run");
    const taskId = textOf(item, "taskId", "task_id");
    const itemRunId = textOf(item, "taskRunId", "task_run_id", "runId", "run_id");
    const sessionId = textOf(item, "sessionId", "session_id");
    const startRequestId = textOf(item, "startRequestId", "start_request_id");
    const settleReceiptId = textOf(item, "settleReceiptId", "settle_receipt_id");
    const evidenceRef = textOf(item, "evidenceRef", "evidence_ref");
    const piRunId = textOf(item, "piRunId", "pi_run_id");
    const terminalStatus = textOf(item, "terminal");
    const role = textOf(item, "role");
    const source = textOf(item, "source") ?? "pactile-pi-rpc";
    const assurance = textOf(item, "assurance") ?? "manager-owned-child-exit";
    const recordedAt = textOf(item, "recordedAt", "recorded_at");
    const processId = numberOf(item, "processId", "process_id");
    const receiptRef = piRunId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(piRunId) ? `pi-bridge/runs/${piRunId}.json` : null;
    if (taskId !== kernel.identity.taskId || itemRunId !== run.id || sessionId !== host.sessionId
      || host.role !== "implement" || host.assuranceSource !== "manager-owned-child-exit"
      || role !== host.role || source !== "pactile-pi-rpc" || assurance !== "manager-owned-child-exit"
      || (terminalStatus !== "exited" && terminalStatus !== "cancelled")
      || startRequestId === null || settleReceiptId === null || evidenceRef === null || piRunId === null
      || recordedAt === null || processId === null || processId === 0 || receiptRef === null || !host.requestRefs.includes(startRequestId)
      || !host.eventRefs.includes(settleReceiptId)
      || !host.resultRefs.includes(receiptRef)) {
      throw new WorktreeManagerError("host-stop-unverified", "Pi child exit receipt does not match this manager-bound process and durable refs");
    }
    return {
      source, assurance, evidenceLevel: "manager-owned-child-exit", taskId: kernel.identity.taskId, runId: run.id,
      sessionId: host.sessionId, threadId: host.threadId, startRequestId, settleReceiptId,
      terminalStatus, requestKernelRevision: host.kernelRevision,
      receiptKernelRevision: host.stopReceipt?.receiptKernelRevision ?? kernel.revision,
      contractFingerprint: host.contractFingerprint, contractStale: false,
      candidateSnapshotId: candidate.id, candidateFingerprint: candidate.fingerprint,
      candidateSource: "derived",
      receiptRef, evidenceRef, recordedAt,
    };
  }
  throw new WorktreeManagerError("host-stop-unverified", `No terminal receipt reader is configured for host ${host.host}`);
}

function restoreRemovedWorktree(identity: GitIdentity, binding: RunWorkspaceBinding): { binding: TaskRunWorkspaceManagerBinding | null; reason: string | null } {
  let stage = "checking the recorded Run owner";
  const failed = (reason: string): { binding: null; reason: string } => ({ binding: null, reason });
  try {
    if (!binding.manager) return failed("Run has no manager ownership credential");
    stage = "checking the canonical workspace parent";
    const allowedRoot = ensureAllowedRoot(identity);
    if (!path.isAbsolute(binding.canonicalPath)) return failed("Canonical workspace path is not absolute");
    const canonicalPath = path.resolve(binding.canonicalPath);
    if (!pathWithin(allowedRoot, canonicalPath) || pathKey(canonicalPath) !== pathKey(binding.canonicalPath)) return failed("Canonical workspace path is outside the allowed worktree root");
    assertNoSymlinkBetween(identity.root, canonicalPath);
    if (fs.existsSync(canonicalPath) || registrations(identity).some((item) => pathKey(item.path) === pathKey(canonicalPath))) return failed("Workspace path or Git registration is already occupied");
    stage = "checking the persisted manager provenance";
    const old = readAllManagerProvenance(identity).find((item) => item.ownerRunId === binding.ownerRunId);
    if (old?.credentialId !== binding.manager.credentialId
      || pathKey(old.canonicalPath) !== pathKey(canonicalPath)
      || pathKey(old.projectRoot) !== pathKey(identity.root)
      || pathKey(old.commonDir) !== pathKey(identity.commonDir)
      || old.branch !== binding.branch) return failed("Persisted manager provenance no longer matches this Run and repository");
    const expectedRef = branchRef(identity.root, binding.branch);
    stage = "checking the preserved Run branch";
    git(identity.root, ["show-ref", "--verify", "--quiet", expectedRef]);
    stage = "restoring the checkout from its preserved branch";
    try {
      execFileSync("git", ["worktree", "add", canonicalPath, binding.branch], {
        cwd: identity.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      const stderr = error && typeof error === "object" && "stderr" in error
        ? (error as { stderr?: string | Buffer }).stderr
        : undefined;
      const detail = typeof stderr === "string" ? stderr.trim().split(/\r?\n/).filter(Boolean).join(" | ").slice(0, 500)
        : Buffer.isBuffer(stderr) ? stderr.toString("utf8").trim().split(/\r?\n/).filter(Boolean).join(" | ").slice(0, 500) : null;
      return failed(`${stage} failed${detail ? `: ${detail}` : ""}`);
    }
    stage = "verifying the restored checkout registration";
    const gitDir = verifyLinkedGitDirectory(canonicalPath, identity.commonDir);
    const registration = registrations(identity).find((item) => pathKey(item.path) === pathKey(canonicalPath));
    const actualBranch = git(canonicalPath, ["symbolic-ref", "--quiet", "HEAD"]);
    const actualHead = resolveCommit(canonicalPath, "HEAD");
    if (registration?.branch !== expectedRef || registration.head !== actualHead
      || actualBranch !== expectedRef || actualHead !== resolveCommit(identity.root, expectedRef)) return failed("Restored checkout did not match the Run branch registration and HEAD");
    stage = "updating the trusted manager Git-directory record";
    synchronizeManagerProvenanceGitDir({
      identity,
      ownerRunId: old.ownerRunId,
      credentialId: old.credentialId,
      priorGitDir: binding.manager.gitDir,
      actualGitDir: gitDir,
    });
    return { binding: { ...binding.manager, gitDir }, reason: null };
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error
      ? (error as { stderr?: string | Buffer }).stderr
      : undefined;
    const detail = typeof stderr === "string" ? stderr.trim().split(/\r?\n/)[0] : Buffer.isBuffer(stderr) ? stderr.toString("utf8").trim().split(/\r?\n/)[0] : null;
    return failed(`${stage} failed${detail ? `: ${detail}` : error instanceof Error ? `: ${error.message}` : ""}`);
  }
}

function reconcileRestoredManagerBinding(input: {
  identity: GitIdentity;
  runId: string;
  runState: TaskRunV2["state"];
  binding: RunWorkspaceBinding;
}): { managerBinding: TaskRunWorkspaceManagerBinding; changed: boolean } | null {
  const manager = input.binding.manager;
  if (!manager) return null;
  try {
    const canonicalPath = assertAllowedPath(input.identity, input.binding.canonicalPath);
    const actualGitDir = verifyLinkedGitDirectory(canonicalPath, input.identity.commonDir);
    const proposedBinding = { ...input.binding, manager: { ...manager, gitDir: actualGitDir } };
    const before = inspectRunWorktree({
      repoRoot: input.identity.root,
      runId: input.runId,
      runState: input.runState,
      binding: proposedBinding,
    });
    if (before.issues.some((issue) => issue !== "manager-provenance-mismatch") || before.gitDir === null) return null;

    let priorRecord: ManagerProvenance | undefined;
    try {
      priorRecord = readAllManagerProvenance(input.identity).find((item) => item.ownerRunId === input.runId);
    } catch {
      // The synchronizer below accepts only a one-field Git-directory mismatch.
    }
    const changed = pathKey(manager.gitDir) !== pathKey(actualGitDir)
      || !priorRecord || pathKey(priorRecord.gitDir) !== pathKey(actualGitDir);
    const synchronized = synchronizeManagerProvenanceGitDir({
      identity: input.identity,
      ownerRunId: input.runId,
      credentialId: manager.credentialId,
      priorGitDir: manager.gitDir,
      actualGitDir,
    });
    const managerBinding = { ...manager, gitDir: synchronized.gitDir };
    const after = inspectRunWorktree({
      repoRoot: input.identity.root,
      runId: input.runId,
      runState: input.runState,
      binding: { ...input.binding, manager: managerBinding },
    });
    if (after.issues.length > 0 || after.state !== "clean") return null;
    return { managerBinding, changed };
  } catch {
    return null;
  }
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

function finishCleanupLease(input: {
  repoRoot: string; taskDir: string; runId: string; leaseId: string;
  result: "reclaimed" | "retained" | "partial-removal" | "recovery-required";
  reason?: string; actor: string; idempotencyKey: string;
  updatedManagerBinding?: TaskRunWorkspaceManagerBinding;
}): TaskKernelMutationResult {
  const stored = readStoredTaskRun(input.repoRoot, input.taskDir, input.runId);
  return finishTaskRunWorkspaceCleanup({
    root: input.repoRoot, taskDir: input.taskDir, expectedRevision: stored.kernel.revision,
    runId: input.runId, leaseId: input.leaseId, result: input.result,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.updatedManagerBinding ? { updatedManagerBinding: input.updatedManagerBinding } : {}),
    actor: input.actor, idempotencyKey: input.idempotencyKey,
  });
}

function cleanupResultFromKernel(input: {
  repoRoot: string; taskDir: string; runId: string; result: "reclaimed" | "retained" | "partial-removal" | "recovery-required";
  reason?: string; actor: string; idempotencyKey: string; updatedManagerBinding?: TaskRunWorkspaceManagerBinding;
  expectedHeadSha?: string; receiptRef?: string;
}): WorktreeCleanupResult {
  const stored = readStoredTaskRun(input.repoRoot, input.taskDir, input.runId);
  const binding = stored.run.workspace;
  if (!binding) throw new WorktreeManagerError("workspace-not-bound", "Run has no workspace binding to report");
  const leaseId = binding.cleanupLease?.leaseId;
  if (!leaseId) throw new WorktreeManagerError("cleanup-lease-missing", "Run has no persisted cleanup lease");
  const mutation = finishCleanupLease({ ...input, leaseId });
  const finished = mutation.kernel.runs.find((item) => item.id === input.runId)?.workspace;
  if (!finished) throw new WorktreeManagerError("cleanup-finalize-failed", "Cleanup state was not persisted to the Run");
  if (input.result === "reclaimed") return {
    state: "reclaimed", binding: finished, path: finished.canonicalPath,
    expectedHeadSha: input.expectedHeadSha ?? finished.integrationReceipt?.worktreeHeadSha ?? "",
    receiptRef: input.receiptRef ?? finished.cleanupLease?.receiptRef ?? "",
  };
  return { state: input.result, binding: finished, path: finished.canonicalPath, reason: input.reason ?? input.result };
}

export interface ReclaimTaskRunWorktreeInput {
  repoRoot: string;
  taskDir: string;
  runId: string;
  actor: string;
  idempotencyKey: string;
}

export async function reclaimRunWorktree(input: ReclaimTaskRunWorktreeInput): Promise<WorktreeCleanupResult> {
  let stored = readStoredTaskRun(input.repoRoot, input.taskDir, input.runId);
  let { kernel, run } = stored;
  let binding = run.workspace;
  const retain = (reason: string, state: "retained" | "partial-removal" | "recovery-required" = "retained"): WorktreeCleanupResult => {
    let persistedReason = state === "retained" ? reason : `${state}: ${reason}`;
    try {
      const latest = readStoredTaskRun(input.repoRoot, input.taskDir, input.runId);
      const refusalFingerprint = fingerprintTaskValue({
        runId: input.runId,
        requestIdempotencyKey: input.idempotencyKey,
        state,
        reason,
      });
      const mutation = recordTaskRunWorkspaceCleanupRefusal({
        root: input.repoRoot,
        taskDir: input.taskDir,
        expectedRevision: latest.kernel.revision,
        runId: input.runId,
        reason: persistedReason,
        actor: input.actor,
        idempotencyKey: `workspace-cleanup-refusal:${refusalFingerprint}`,
      });
      binding = mutation.kernel.runs.find((item) => item.id === input.runId)?.workspace ?? binding;
    } catch (error) {
      persistedReason = `${persistedReason} (refusal event could not be persisted${error instanceof Error ? `: ${error.message}` : ""})`;
    }
    if (!binding) return { state, binding: null, path: null, reason: persistedReason };
    return { state, binding, path: path.resolve(binding.canonicalPath), reason: persistedReason };
  };
  if (!binding?.manager || !binding.integrationReceipt) return retain("Run has no manager-owned workspace and persisted integration receipt");
  if (run.state !== "completed" || !run.result || !run.candidateSnapshot) return retain("Only a completed Run with preserved result and candidate can be reclaimed");
  const closure = kernel.closure;
  if (kernel.phase !== "close" || closure?.runId !== run.id
    || closure.candidateSnapshotId !== run.candidateSnapshot.id || closure.candidateFingerprint !== run.candidateSnapshot.fingerprint
    || !closure.deliveryEvidence.reference.trim()) return retain("Run candidate has not been accepted and closed with delivery evidence");
  try {
    const observedStop = await readVerifiedHostStopReceipt(input.repoRoot, input.taskDir, kernel, run);
    if (run.host?.stopReceipt) {
      if (fingerprintTaskValue(run.host.stopReceipt) !== fingerprintTaskValue(observedStop)) {
        return retain("Persisted host stop receipt differs from the source bridge receipt");
      }
    } else {
      recordTaskRunHostStopReceipt({
        root: input.repoRoot, taskDir: input.taskDir, expectedRevision: kernel.revision,
        runId: input.runId, receipt: observedStop, actor: input.actor,
        idempotencyKey: `${input.idempotencyKey}:host-stop:${observedStop.settleReceiptId}`,
      });
      stored = readStoredTaskRun(input.repoRoot, input.taskDir, input.runId);
      kernel = stored.kernel;
      run = stored.run;
      binding = run.workspace;
      if (run.state !== "completed" || !run.result || !run.candidateSnapshot) return retain("Run result or candidate changed while host stop was being persisted", "recovery-required");
      if (!binding?.manager || !binding.integrationReceipt || !run.host?.stopReceipt) return retain("Host stop receipt was not persisted");
    }
  } catch (error) {
    return retain(error instanceof Error ? error.message : "Host stop receipt verification failed");
  }
  if (run.host?.stopReceipt?.terminalStatus === "cancelled") return retain("Cancelled Runs are retained for diagnosis");
  if (binding.reclamationState === "reclaimed" || binding.cleanupLease?.state === "reclaimed") {
    try {
      const identity = repoIdentity(input.repoRoot);
      const allowedRoot = ensureAllowedRoot(identity);
      const canonicalPath = path.resolve(binding.canonicalPath);
      assertNoSymlinkBetween(identity.root, canonicalPath);
      if (!path.isAbsolute(binding.canonicalPath) || pathKey(canonicalPath) !== pathKey(binding.canonicalPath)
        || !pathWithin(allowedRoot, canonicalPath)
        || pathKey(binding.manager.projectRoot) !== pathKey(identity.root)
        || pathKey(binding.manager.commonDir) !== pathKey(identity.commonDir)) {
        return retain("Previously reclaimed workspace ownership or canonical path changed", "recovery-required");
      }
      const stillRegistered = registrations(identity).some((entry) => pathKey(entry.path) === pathKey(canonicalPath));
      if (fs.existsSync(canonicalPath) || stillRegistered) {
        return retain("Previously reclaimed path has reappeared or is registered again; it may belong to another checkout and was left untouched", "recovery-required");
      }
    } catch (error) {
      return retain(error instanceof Error ? error.message : "Previously reclaimed path could not be verified", "recovery-required");
    }
    if (binding.cleanupLease?.state === "reclaimed") {
      return { state: "reclaimed", binding, path: binding.canonicalPath,
        expectedHeadSha: binding.integrationReceipt.worktreeHeadSha, receiptRef: binding.cleanupLease.receiptRef };
    }
    if (binding.reclamationState === "reclaimed") {
      return { state: "reclaimed", binding, path: binding.canonicalPath,
        expectedHeadSha: binding.integrationReceipt.worktreeHeadSha, receiptRef: run.host?.stopReceipt?.receiptRef ?? "" };
    }
  }
  if (binding.cleanupLease?.state === "partial-removal" || binding.cleanupLease?.state === "recovery-required") {
    if (binding.cleanupLease.state === "recovery-required") {
      const reason = binding.cleanupLease.reason ?? "Worktree is in a persisted recovery state";
      try {
        const identity = repoIdentity(input.repoRoot);
        const reconciled = reconcileRestoredManagerBinding({ identity, runId: run.id, runState: run.state, binding });
        if (reconciled?.changed) {
          return cleanupResultFromKernel({
            ...input,
            result: "recovery-required",
            reason: `${reason}; manager provenance and canonical-path index were synchronized for inspection`,
            updatedManagerBinding: reconciled.managerBinding,
          });
        }
      } catch {
        // Keep the previously persisted recovery state authoritative when a repair cannot be proven.
      }
    }
    return retain(binding.cleanupLease.reason ?? "Worktree is in a persisted recovery state", "recovery-required");
  }

  let identity: GitIdentity;
  try {
    identity = repoIdentity(input.repoRoot);
  } catch (error) {
    return retain(error instanceof Error ? error.message : "Run worktree repository identity could not be verified", "recovery-required");
  }
  const heldLease = binding.cleanupLease;
  const absentCheckoutWithStaleLease = !fs.existsSync(binding.canonicalPath)
    && heldLease?.state === "held" && !processIsAlive(heldLease.processId);
  let canonicalPath: string;
  if (absentCheckoutWithStaleLease) {
    const allowedRoot = ensureAllowedRoot(identity);
    canonicalPath = path.resolve(binding.canonicalPath);
    if (!path.isAbsolute(binding.canonicalPath) || pathKey(canonicalPath) !== pathKey(binding.canonicalPath)
      || !pathWithin(allowedRoot, canonicalPath)) {
      return retain("Interrupted cleanup path is not a normalized child of the allowed worktree root", "recovery-required");
    }
    assertNoSymlinkBetween(identity.root, canonicalPath);
  } else {
    try {
      canonicalPath = assertAllowedPath(identity, binding.canonicalPath);
    } catch (error) {
      return retain(error instanceof Error ? error.message : "Run worktree path could not be verified", "recovery-required");
    }
  }
  if (pathKey(canonicalPath) !== pathKey(binding.canonicalPath)
    || pathKey(binding.manager.projectRoot) !== pathKey(identity.root)
    || pathKey(binding.manager.commonDir) !== pathKey(identity.commonDir)) {
    return retain("Run workspace project root, common directory, or canonical path changed", "recovery-required");
  }
  const integrationReceipt = binding.integrationReceipt;
  if (!integrationReceipt.contentFingerprint) return retain("Persisted integration receipt lacks target-tree content proof", "recovery-required");
  const expectedHeadSha = integrationReceipt.worktreeHeadSha.toLowerCase();
  if (integrationReceipt.runId !== run.id || integrationReceipt.candidateSnapshotId !== run.candidateSnapshot.id
    || integrationReceipt.candidateFingerprint !== run.candidateSnapshot.fingerprint
    || !sameStringArray(integrationReceipt.resultEvidenceRefs, run.result.evidenceRefs)) {
    return retain("Persisted integration receipt no longer matches the closed Run result", "recovery-required");
  }

  const activeLease = binding.cleanupLease;
  if (activeLease?.state === "held") {
    if (processIsAlive(activeLease.processId)) return retain("Another live Pactile process holds the persistent cleanup lease");
    const pathExists = fs.existsSync(canonicalPath);
    const registered = registrations(identity).some((entry) => pathKey(entry.path) === pathKey(canonicalPath));
    if (!pathExists && !registered) {
      if (!binding) return retain("Interrupted cleanup has no Run workspace binding to restore", "recovery-required");
      const recoveryBinding = binding;
      const restoreAndRequireRecovery = (reason: string): WorktreeCleanupResult => {
        const restoration = restoreRemovedWorktree(identity, recoveryBinding);
        return cleanupResultFromKernel({
          ...input,
          result: "recovery-required",
          reason: restoration.binding
            ? `${reason}; the checkout was restored at the preserved Run branch head`
            : `${reason}; Run refs were preserved for manual reconciliation${restoration.reason ? ` (${restoration.reason})` : ""}`,
          ...(restoration.binding ? { updatedManagerBinding: restoration.binding } : {}),
        });
      };
      try {
        if (activeLease.expectedHeadSha.toLowerCase() !== expectedHeadSha
          || activeLease.targetBranch !== integrationReceipt.targetBranch
          || activeLease.targetHeadSha.toLowerCase() !== integrationReceipt.targetHeadSha.toLowerCase()) {
          return restoreAndRequireRecovery("Interrupted cleanup lease no longer matches its integration receipt");
        }
        const branchHead = resolveCommit(identity.root, branchRef(identity.root, binding.branch));
        const target = resolveLocalBranchTarget(identity.root, integrationReceipt.targetBranch);
        if (branchHead !== expectedHeadSha || !isAncestor(identity.root, expectedHeadSha, target.headSha)) {
          return restoreAndRequireRecovery("The preserved Run branch head or target ancestry changed after removal");
        }
        const contentFingerprint = fingerprintRunContentAtTarget({
          repoRoot: identity.root,
          runId: run.id,
          baseSha: binding.baseSha,
          worktreeHeadSha: expectedHeadSha,
          targetHeadSha: target.headSha,
          candidateSnapshotId: run.candidateSnapshot.id,
          candidateFingerprint: run.candidateSnapshot.fingerprint,
          resultEvidenceRefs: run.result.evidenceRefs,
        });
        if (contentFingerprint !== integrationReceipt.contentFingerprint) {
          return restoreAndRequireRecovery("The target tree no longer preserves the Run deliverable content after interrupted removal");
        }
        return cleanupResultFromKernel({ ...input, result: "reclaimed", expectedHeadSha, receiptRef: activeLease.receiptRef });
      } catch (error) {
        return restoreAndRequireRecovery(`Interrupted removal could not be proven safe${error instanceof Error ? `: ${error.message}` : ""}`);
      }
    }
    if (pathExists && !registered) {
      return cleanupResultFromKernel({ ...input, result: "partial-removal", reason: "Git removed the worktree registration but left directory contents; preserved the residue without recursive deletion" });
    }
    if (!pathExists || !registered) {
      return cleanupResultFromKernel({ ...input, result: "recovery-required", reason: "Interrupted cleanup left an inconsistent Git registration/path state" });
    }
    const staleInspection = inspectRunWorktree({ repoRoot: identity.root, runId: run.id, runState: run.state, binding });
    if (staleInspection.state !== "clean" || staleInspection.headSha !== activeLease.expectedHeadSha) {
      return cleanupResultFromKernel({ ...input, result: "recovery-required", reason: `Interrupted cleanup checkout needs preservation (${staleInspection.state})` });
    }
    cleanupResultFromKernel({ ...input, result: "retained", reason: "Previous cleaner stopped before invoking Git; verified checkout retained for a fresh lease" });
    stored = readStoredTaskRun(input.repoRoot, input.taskDir, input.runId);
    kernel = stored.kernel;
    run = stored.run;
    binding = run.workspace;
    if (run.state !== "completed" || !run.result || !run.candidateSnapshot) return retain("Run result or candidate changed while stale cleanup was reconciled", "recovery-required");
    if (!binding?.manager || !binding.integrationReceipt) return retain("Workspace binding disappeared while reconciling a stale lease", "recovery-required");
  }

  const stopReceipt = run.host?.stopReceipt;
  if (!stopReceipt) return retain("Verified host stop receipt is not persisted");
  const leaseId = randomUUID();
  try {
    acquireTaskRunWorkspaceCleanupLease({
      root: input.repoRoot, taskDir: input.taskDir, expectedRevision: kernel.revision,
      runId: input.runId,
      lease: {
        leaseId, processId: process.pid, acquiredAt: new Date().toISOString(),
        expectedHeadSha, targetBranch: integrationReceipt.targetBranch,
        targetHeadSha: integrationReceipt.targetHeadSha, receiptRef: stopReceipt.receiptRef,
        riskDisclosure: TASK_RUN_WORKSPACE_CLEANUP_RISK_DISCLOSURE,
      },
      actor: input.actor, idempotencyKey: `${input.idempotencyKey}:cleanup-lease:${leaseId}`,
    });
  } catch (error) {
    return retain(error instanceof Error ? error.message : "Could not acquire the persistent cleanup lease");
  }
  stored = readStoredTaskRun(input.repoRoot, input.taskDir, input.runId);
  kernel = stored.kernel;
  run = stored.run;
  binding = run.workspace;
  if (!binding?.manager || binding.cleanupLease?.leaseId !== leaseId) return retain("Cleanup lease was not durably recorded", "recovery-required");
  if (run.state !== "completed" || !run.result || !run.candidateSnapshot) return retain("Run result or candidate changed after cleanup lease acquisition", "recovery-required");
  const keepLeaseResult = (reason: string, state: "reclaimed" | "retained" | "partial-removal" | "recovery-required" = "retained", updatedManagerBinding?: TaskRunWorkspaceManagerBinding): WorktreeCleanupResult =>
    cleanupResultFromKernel({ ...input, result: state, reason, updatedManagerBinding });

  const verifyBeforeRemoval = (): void => {
    const latest = readStoredTaskRun(input.repoRoot, input.taskDir, input.runId);
    const currentRun = latest.run;
    const currentWorkspace = currentRun.workspace;
    const currentCandidate = currentRun.candidateSnapshot;
    const currentResult = currentRun.result;
    const currentClosure = latest.kernel.closure;
    if (latest.kernel.phase !== "close" || currentClosure?.runId !== currentRun.id
      || currentClosure?.candidateSnapshotId !== currentCandidate?.id
      || currentClosure?.candidateFingerprint !== currentCandidate.fingerprint
      || !currentClosure?.deliveryEvidence.reference.trim() || currentRun.state !== "completed" || !currentResult
      || !currentWorkspace?.manager || !currentWorkspace.integrationReceipt
      || currentWorkspace.cleanupLease?.state !== "held" || currentWorkspace.cleanupLease.leaseId !== leaseId
      || !currentRun.host?.stopReceipt
      || fingerprintTaskValue(currentRun.host.stopReceipt) !== fingerprintTaskValue(stopReceipt)
      || fingerprintTaskValue(currentWorkspace.integrationReceipt) !== fingerprintTaskValue(integrationReceipt)
      || currentCandidate.id !== integrationReceipt.candidateSnapshotId
      || currentCandidate.fingerprint !== integrationReceipt.candidateFingerprint) {
      throw new WorktreeManagerError("cleanup-preflight-stale", "Run Close, host-stop, integration, or cleanup-lease evidence changed before Git removal", canonicalPath);
    }
    const freshIdentity = repoIdentity(input.repoRoot);
    const freshPath = assertAllowedPath(freshIdentity, currentWorkspace.canonicalPath);
    if (pathKey(freshPath) !== pathKey(canonicalPath)
      || pathKey(currentWorkspace.manager.projectRoot) !== pathKey(freshIdentity.root)
      || pathKey(currentWorkspace.manager.commonDir) !== pathKey(freshIdentity.commonDir)) {
      throw new WorktreeManagerError("cleanup-path-changed", "Run worktree path or Git repository identity changed before removal", canonicalPath);
    }
    const verified = verifyWorktreeIntegration({
      repoRoot: freshIdentity.root, runId: currentRun.id, runState: currentRun.state,
      binding: currentWorkspace, targetRef: integrationReceipt.targetBranch,
      result: { runId: currentRun.id, summary: currentResult.summary, evidenceRefs: currentResult.evidenceRefs,
        candidateSnapshotId: currentCandidate.id, candidateFingerprint: currentCandidate.fingerprint },
    });
    if (verified.receipt.worktreeHeadSha.toLowerCase() !== expectedHeadSha
      || verified.receipt.targetBranch !== integrationReceipt.targetBranch
      || verified.receipt.contentFingerprint !== integrationReceipt.contentFingerprint) {
      throw new WorktreeManagerError("cleanup-head-changed", "Worktree HEAD, integrated target branch, or preserved content changed before Git removal", canonicalPath);
    }
    const finalInspection = inspectRunWorktree({ repoRoot: freshIdentity.root, runId: currentRun.id, runState: currentRun.state, binding: currentWorkspace });
    if (finalInspection.state !== "clean" || finalInspection.headSha?.toLowerCase() !== expectedHeadSha
      || !finalInspection.gitDir || pathKey(finalInspection.gitDir) !== pathKey(currentWorkspace.manager.gitDir)) {
      throw new WorktreeManagerError("cleanup-worktree-changed", `Worktree changed or contains user/ignored files (${finalInspection.state})`, canonicalPath);
    }
  };
  try { verifyBeforeRemoval(); }
  catch (error) { return keepLeaseResult(error instanceof Error ? error.message : "Worktree cleanup preflight failed", "recovery-required"); }

  let removalError: string | null = null;
  let finalCheckRejected = false;
  try {
    removeManagedGitWorktree(identity.root, canonicalPath, () => {
      try { verifyBeforeRemoval(); }
      catch (error) {
        finalCheckRejected = true;
        throw error;
      }
    });
  } catch (error) {
    removalError = error instanceof Error ? error.message : "Git refused or could not finish non-force worktree removal";
  }

  const pathExistsAfter = fs.existsSync(canonicalPath);
  const registeredAfter = registrations(identity).some((entry) => pathKey(entry.path) === pathKey(canonicalPath));
  if (pathExistsAfter && !registeredAfter) {
    return keepLeaseResult("Git removed the worktree registration but left directory contents; residual files are preserved and are not treated as a checkout", "partial-removal");
  }
  if (pathExistsAfter && registeredAfter) {
    return keepLeaseResult(removalError ?? "Git removal left the registered checkout in place; it is retained for inspection", finalCheckRejected ? "recovery-required" : "retained");
  }
  if (!pathExistsAfter && registeredAfter) {
    return keepLeaseResult("Git registration remains although the worktree path disappeared", "recovery-required");
  }

  const restoreAndRetain = (reason: string): WorktreeCleanupResult => {
    const recoveryBinding = binding;
    if (!recoveryBinding) {
      return keepLeaseResult(`${reason}; the Run workspace binding is unavailable, preserve refs for manual reconciliation`, "recovery-required");
    }
    const restoration = restoreRemovedWorktree(identity, recoveryBinding);
    return keepLeaseResult(restoration.binding
      ? `${reason}; the checkout was restored at the preserved Run branch head`
      : `${reason}; preserve repository refs and reconcile manually${restoration.reason ? ` (${restoration.reason})` : ""}`,
    "recovery-required", restoration.binding ?? undefined);
  };
  let branchHead: string;
  let targetAfter: ReturnType<typeof resolveLocalBranchTarget>;
  try {
    branchHead = resolveCommit(identity.root, branchRef(identity.root, binding.branch));
    targetAfter = resolveLocalBranchTarget(identity.root, integrationReceipt.targetBranch);
  } catch (error) {
    return restoreAndRetain(`The worktree was removed but post-removal branch verification failed${error instanceof Error ? `: ${error.message}` : ""}`);
  }
  if (branchHead !== expectedHeadSha || !isAncestor(identity.root, expectedHeadSha, targetAfter.headSha)) {
    return restoreAndRetain("A Run branch or integration ancestry change raced with removal");
  }
  try {
    const contentFingerprint = fingerprintRunContentAtTarget({
      repoRoot: identity.root,
      runId: run.id,
      baseSha: binding.baseSha,
      worktreeHeadSha: expectedHeadSha,
      targetHeadSha: targetAfter.headSha,
      candidateSnapshotId: run.candidateSnapshot.id,
      candidateFingerprint: run.candidateSnapshot.fingerprint,
      resultEvidenceRefs: run.result.evidenceRefs,
    });
    if (contentFingerprint !== integrationReceipt.contentFingerprint) {
      return restoreAndRetain("The target tree changed Run deliverable content after Git removed the checkout");
    }
  } catch (error) {
    return restoreAndRetain(`Target content verification failed after Git removed the checkout${error instanceof Error ? `: ${error.message}` : ""}`);
  }
  return keepLeaseResult(removalError ?? "", "reclaimed");
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}
