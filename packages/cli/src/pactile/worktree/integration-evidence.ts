import path from "node:path";
import { fingerprintTaskValue } from "../../core/task/task-kernel.js";
import { sameGitRoot } from "../../utils/git-root.js";
import {
  inspectRunWorktree,
} from "./manager-core.js";
import {
  assertAllowedPath,
  branchRef,
  git,
  isAncestor,
  ownerConflict,
  pathKey,
  changedPaths,
  repoIdentity,
  resolveLocalBranchTarget,
  treePathEntries,
  validateSha,
} from "./git-probe.js";
import {
  WorktreeManagerError,
  type RunResultEvidence,
  type RunWorkspaceBinding,
  type WorkspaceOwnerRef,
  type WorkspaceRunState,
} from "./manager-types.js";

function preservedResultMatches(result: RunResultEvidence | null, runId: string): result is RunResultEvidence {
  return !!result && result.runId === runId && !!result.summary.trim()
    && Array.isArray(result.evidenceRefs) && result.evidenceRefs.length > 0
    && result.evidenceRefs.every((reference) => typeof reference === "string" && !!reference.trim());
}

export interface WorktreeIntegrationReceipt {
  runId: string;
  worktreeHeadSha: string;
  targetRef: string;
  targetBranch: string;
  targetHeadSha: string;
  verifiedAt: string;
  resultEvidenceRefs: string[];
  candidateSnapshotId: string | null;
  candidateFingerprint: string | null;
  contentFingerprint: string;
}

export interface RunContentFingerprintInput {
  repoRoot: string;
  runId: string;
  baseSha: string;
  worktreeHeadSha: string;
  targetHeadSha: string;
  candidateSnapshotId: string | null;
  candidateFingerprint: string | null;
  resultEvidenceRefs: readonly string[];
}

export function fingerprintRunContentAtTarget(input: RunContentFingerprintInput): string {
  const identity = repoIdentity(input.repoRoot);
  const baseSha = validateSha(input.baseSha);
  const worktreeHeadSha = validateSha(input.worktreeHeadSha);
  const targetHeadSha = validateSha(input.targetHeadSha);
  const paths = changedPaths(identity.root, baseSha, worktreeHeadSha);
  const runEntries = treePathEntries(identity.root, worktreeHeadSha, paths);
  const targetEntries = treePathEntries(identity.root, targetHeadSha, paths);
  const runEntriesByPath = new Map<string, typeof runEntries>();
  const targetEntriesByPath = new Map<string, typeof targetEntries>();
  for (const entry of runEntries) runEntriesByPath.set(entry.path, [...(runEntriesByPath.get(entry.path) ?? []), entry]);
  for (const entry of targetEntries) targetEntriesByPath.set(entry.path, [...(targetEntriesByPath.get(entry.path) ?? []), entry]);
  const contentPaths = paths.map((relativePath) => {
    const runPathEntries = runEntriesByPath.get(relativePath) ?? [];
    const targetPathEntries = targetEntriesByPath.get(relativePath) ?? [];
    if (JSON.stringify(runPathEntries) !== JSON.stringify(targetPathEntries)) {
      throw new WorktreeManagerError("integration-content-not-preserved", `Target tree does not preserve Run changes at ${relativePath}`);
    }
    return { path: relativePath, entries: runPathEntries };
  });
  return fingerprintTaskValue({
    schemaVersion: 1,
    runId: input.runId,
    baseSha,
    worktreeHeadSha,
    candidateSnapshotId: input.candidateSnapshotId,
    candidateFingerprint: input.candidateFingerprint,
    resultEvidenceRefs: [...input.resultEvidenceRefs],
    changedPaths: contentPaths,
  });
}

export function verifyWorktreeIntegration(input: {
  repoRoot: string;
  runId: string;
  runState: WorkspaceRunState;
  binding: RunWorkspaceBinding;
  knownOwners?: readonly WorkspaceOwnerRef[];
  targetRef: string;
  result: RunResultEvidence | null;
}): { binding: RunWorkspaceBinding; receipt: WorktreeIntegrationReceipt } {
  if (input.runState !== "completed") throw new WorktreeManagerError("run-not-completed", "Only a completed Run can be marked integrated");
  if (!preservedResultMatches(input.result, input.runId)) {
    throw new WorktreeManagerError("result-not-preserved", "Persist the Run result and at least one evidence reference before integration");
  }
  const inspection = inspectRunWorktree({ ...input, runState: input.runState });
  const blockers = inspection.issues.filter((issue) => !["unintegrated"].includes(issue));
  if (blockers.length || inspection.dirty || inspection.scopeViolations.length || !inspection.headSha) {
    throw new WorktreeManagerError("worktree-not-integrable", `Run worktree cannot be integrated (${blockers[0] ?? inspection.state})`, input.binding.canonicalPath);
  }
  const identity = repoIdentity(input.repoRoot);
  const target = resolveLocalBranchTarget(identity.root, input.targetRef);
  if (target.ref === branchRef(identity.root, input.binding.branch)) {
    throw new WorktreeManagerError("integration-not-proven", "Integration target must be a different local branch", input.binding.canonicalPath);
  }
  const targetHeadSha = target.headSha;
  if (!isAncestor(identity.root, inspection.headSha, targetHeadSha)) {
    throw new WorktreeManagerError("integration-not-proven", "Target ref does not contain the Run worktree HEAD", input.binding.canonicalPath);
  }
  const candidateSnapshotId = input.result.candidateSnapshotId ?? null;
  const candidateFingerprint = input.result.candidateFingerprint ?? null;
  const contentFingerprint = fingerprintRunContentAtTarget({
    repoRoot: identity.root,
    runId: input.runId,
    baseSha: input.binding.baseSha,
    worktreeHeadSha: inspection.headSha,
    targetHeadSha,
    candidateSnapshotId,
    candidateFingerprint,
    resultEvidenceRefs: input.result.evidenceRefs,
  });
  const receipt: WorktreeIntegrationReceipt = {
    runId: input.runId,
    worktreeHeadSha: inspection.headSha,
    targetRef: input.targetRef,
    targetBranch: target.branch,
    targetHeadSha,
    verifiedAt: new Date().toISOString(),
    resultEvidenceRefs: [...input.result.evidenceRefs],
    candidateSnapshotId,
    candidateFingerprint,
    contentFingerprint,
  };
  const kernelReceipt = receipt.candidateSnapshotId && receipt.candidateFingerprint
    ? {
      runId: receipt.runId,
      worktreeHeadSha: receipt.worktreeHeadSha,
      targetRef: receipt.targetRef,
      targetBranch: receipt.targetBranch,
      targetHeadSha: receipt.targetHeadSha,
      verifiedAt: receipt.verifiedAt,
      resultEvidenceRefs: receipt.resultEvidenceRefs,
      candidateSnapshotId: receipt.candidateSnapshotId,
      candidateFingerprint: receipt.candidateFingerprint,
      contentFingerprint: receipt.contentFingerprint,
    }
    : null;
  return {
    binding: { ...input.binding, integrationState: "integrated", reclamationState: "pending", integrationReceipt: kernelReceipt },
    receipt,
  };
}

export type WorktreeCleanupResult =
  | { state: "reclaimed"; binding: RunWorkspaceBinding; path: string; expectedHeadSha: string; receiptRef: string }
  | {
      state: "manual-action-required";
      binding: RunWorkspaceBinding;
      path: string;
      plan: {
        ownerRunId: string;
        canonicalPath: string;
        commonDir: string;
        gitDir: string;
        branch: string;
        expectedHeadSha: string;
        targetBranch: string;
        targetHeadSha: string;
        resultEvidenceRefs: string[];
        generatedAt: string;
        command: { executable: "git"; args: ["worktree", "remove", string]; cwd: string };
        reviewBeforeExecution: string[];
      };
    }
  | { state: "retained" | "partial-removal" | "recovery-required"; binding: RunWorkspaceBinding | null; path: string | null; reason: string };

export function planRunWorktreeCleanup(input: {
  repoRoot: string;
  runId: string;
  runState: WorkspaceRunState;
  binding: RunWorkspaceBinding;
  knownOwners: readonly WorkspaceOwnerRef[];
  targetRef: string;
  result: RunResultEvidence | null;
}): WorktreeCleanupResult {
  const pathForReport = path.resolve(input.binding.canonicalPath);
  const retain = (reason: string, failed = false): WorktreeCleanupResult => ({
    state: "retained", binding: failed ? { ...input.binding, reclamationState: "failed" } : input.binding, path: pathForReport, reason,
  });
  if (input.runState !== "completed") return retain(`Run state ${input.runState} is not eligible for cleanup`);
  if (input.binding.ownerRunId !== input.runId || ownerConflict(pathForReport, input.runId, input.knownOwners)) return retain("Worktree is not exclusively owned by this Run");
  if (input.binding.integrationState !== "integrated") return retain("Run result is not integrated");
  if (input.binding.reclamationState !== "pending") return retain("Run cleanup was not recorded as pending");
  if (!preservedResultMatches(input.result, input.runId)) return retain("Run result evidence is not preserved");
  let integration: ReturnType<typeof verifyWorktreeIntegration>;
  let identity: ReturnType<typeof repoIdentity>;
  let canonicalPath: string;
  try {
    integration = verifyWorktreeIntegration(input);
    identity = repoIdentity(input.repoRoot);
    canonicalPath = assertAllowedPath(identity, input.binding.canonicalPath);
    if (pathKey(canonicalPath) !== pathKey(pathForReport)) return retain("Canonical worktree path changed during cleanup preflight");
    if (!sameGitRoot(git(canonicalPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), identity.commonDir)) return retain("Worktree common directory changed");
    const finalInspection = inspectRunWorktree(input);
    if (finalInspection.state !== "clean" || finalInspection.headSha !== integration.receipt.worktreeHeadSha || !finalInspection.gitDir) {
      return retain(`Worktree changed or needs preservation (${finalInspection.state})`);
    }
    return {
      state: "manual-action-required",
      binding: input.binding,
      path: canonicalPath,
      plan: {
        ownerRunId: input.runId,
        canonicalPath,
        commonDir: identity.commonDir,
        gitDir: finalInspection.gitDir,
        branch: input.binding.branch,
        expectedHeadSha: integration.receipt.worktreeHeadSha,
        targetBranch: integration.receipt.targetBranch,
        targetHeadSha: integration.receipt.targetHeadSha,
        resultEvidenceRefs: [...integration.receipt.resultEvidenceRefs],
        generatedAt: new Date().toISOString(),
        command: { executable: "git", args: ["worktree", "remove", canonicalPath], cwd: identity.root },
        reviewBeforeExecution: [
          "Re-run inspectRunWorktree for this Run and compare the HEAD SHA, symbolic branch, Git directory, common directory, and registration.",
          "Confirm the Run result and evidence remain preserved and integrated into the recorded target branch.",
          "Stop and retain the worktree if any user edit, untracked or ignored file, new commit, ownership change, or path anomaly appears.",
        ],
      },
    };
  } catch (error) {
    return retain(error instanceof Error ? error.message : "Worktree cleanup preflight failed");
  }
}
