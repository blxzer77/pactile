import fs from "node:fs";
import path from "node:path";
import { sameGitRoot } from "../../utils/git-root.js";
import {
  allowedWorktreeRoot, assertAllowedPath, assertRunId, branchRef, changedPaths, ensureAllowedRoot,
  git, isAncestor, ownerConflict, pathKey, pathWithin, registrations, repoIdentity, resolveCommit,
  validateSha, verifyLinkedGitDirectory, worktreeStatus,
} from "./git-probe.js";
import { persistManagerProvenance, provenanceFor, readAllManagerProvenance, taskKernelManagerBinding } from "./manager-provenance.js";
import {
  type ParallelWriteSetAuthorization, type ParallelWriteSetDecision,
  type RunWorkspaceBinding, type WorkspaceOwnerRef, type WorkspaceRunState,
  type WorktreeInspection, type WorktreeIssueCode, WorktreeManagerError,
} from "./manager-types.js";

function normalizeWriteSet(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.some((item: string) => typeof item !== "string")) {
    throw new WorktreeManagerError("invalid-write-set", "Write set must be an array of project-relative paths");
  }
  if (!value.length) return ["*"];
  const paths = value.map((raw: string) => {
    const item = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (item === "*") return item;
    if (!item || item === "." || item.startsWith("/") || /^[A-Za-z]:/.test(item)
      || item.includes(":") || item.includes("?") || item.includes("[") || item.includes("]")
      || item.split("/").some((part: string) => !part || part === "." || part === "..")) {
      throw new WorktreeManagerError("invalid-write-set", `Write set path is not a concrete relative path: ${raw}`);
    }
    return item;
  });
  return paths.includes("*") ? ["*"] : [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

function comparable(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathCoveredByWriteSet(file: string, writeSet: readonly string[]): boolean {
  const changed = comparable(file);
  return writeSet.some((raw) => {
    if (raw === "*") return true;
    const allowed = comparable(raw);
    return changed === allowed || changed.startsWith(`${allowed}/`);
  });
}

export function findWriteSetOverlaps(left: readonly string[], right: readonly string[]): string[] {
  const a = normalizeWriteSet(left);
  const b = normalizeWriteSet(right);
  const overlaps = new Set<string>();
  for (const leftPath of a) for (const rightPath of b) {
    if (leftPath === "*") overlaps.add(rightPath);
    else if (rightPath === "*") overlaps.add(leftPath);
    else {
      const leftKey = comparable(leftPath);
      const rightKey = comparable(rightPath);
      if (leftKey === rightKey) overlaps.add(leftPath);
      else if (leftKey.startsWith(`${rightKey}/`)) overlaps.add(leftPath);
      else if (rightKey.startsWith(`${leftKey}/`)) overlaps.add(rightPath);
    }
  }
  return [...overlaps].sort((x, y) => comparable(x).localeCompare(comparable(y)));
}

export function decideParallelWriteSets(input: {
  leftRunId: string;
  left: readonly string[];
  rightRunId: string;
  right: readonly string[];
  authorization?: ParallelWriteSetAuthorization | null;
}): ParallelWriteSetDecision {
  const overlapPaths = findWriteSetOverlaps(input.left, input.right);
  if (!overlapPaths.length) return { allowed: true, overlapPaths, authorization: null };
  if (input.leftRunId === input.rightRunId) return { allowed: false, overlapPaths, reason: "invalid-authorization" };
  const authorization = input.authorization;
  if (!authorization) return { allowed: false, overlapPaths, reason: "write-set-conflict" };
  if (!Array.isArray(authorization.runIds) || authorization.runIds.length !== 2
    || authorization.runIds.some((runId) => typeof runId !== "string")
    || !Array.isArray(authorization.overlapPaths)) {
    return { allowed: false, overlapPaths, reason: "invalid-authorization" };
  }
  const expectedRunIds = [input.leftRunId, input.rightRunId].sort();
  const actualRunIds = [...authorization.runIds].sort();
  let actualPaths: string[];
  try { actualPaths = normalizeWriteSet(authorization.overlapPaths); }
  catch { return { allowed: false, overlapPaths, reason: "invalid-authorization" }; }
  const samePaths = actualPaths.length === overlapPaths.length
    && actualPaths.every((candidate, index) => comparable(candidate) === comparable(overlapPaths[index] ?? ""));
  if (actualRunIds[0] !== expectedRunIds[0] || actualRunIds[1] !== expectedRunIds[1] || !samePaths
    || !authorization.approvedBy.trim() || !authorization.approvedAt.trim()
    || !authorization.evidenceRef.trim() || !authorization.integrationPlan.trim()) {
    return { allowed: false, overlapPaths, reason: "invalid-authorization" };
  }
  return { allowed: true, overlapPaths, authorization };
}


export function createRunWorktree(input: {
  repoRoot: string;
  runId: string;
  branch: string;
  baseRef: string;
  writeSet: readonly string[];
  knownOwners?: readonly WorkspaceOwnerRef[];
}): RunWorkspaceBinding {
  assertRunId(input.runId);
  const identity = repoIdentity(input.repoRoot);
  const worktreeRoot = allowedWorktreeRoot(identity.root);
  const canonicalPath = path.resolve(worktreeRoot, input.runId);
  if (!pathWithin(worktreeRoot, canonicalPath) || ownerConflict(canonicalPath, input.runId, input.knownOwners ?? [])) {
    throw new WorktreeManagerError("owner-conflict", "Run worktree path is already owned", canonicalPath);
  }
  branchRef(identity.root, input.branch);
  const baseSha = resolveCommit(identity.root, input.baseRef);
  const writeSet = normalizeWriteSet(input.writeSet);
  ensureAllowedRoot(identity);
  if (fs.existsSync(canonicalPath)) throw new WorktreeManagerError("path-exists", "Run worktree destination already exists", canonicalPath);
  try {
    git(identity.root, ["worktree", "add", "--no-track", "-b", input.branch, canonicalPath, baseSha]);
  } catch (error) {
    throw new WorktreeManagerError("worktree-create-failed", error instanceof Error ? error.message : "Worktree creation failed", canonicalPath);
  }
  try {
    const binding: RunWorkspaceBinding = {
      ownerRunId: input.runId,
      canonicalPath: fs.realpathSync(canonicalPath),
      branch: input.branch,
      baseSha,
      writeSet,
      integrationState: "not-integrated",
      reclamationState: "not-requested",
      manager: null,
      integrationReceipt: null,
      cleanupLease: null,
    };
    const candidateInspection = inspectRunWorktreeInternal({ repoRoot: identity.root, runId: input.runId, runState: "running", binding }, false);
    if (candidateInspection.issues.some((issue) => issue !== "unintegrated") || candidateInspection.headSha !== baseSha
      || !candidateInspection.gitDir || !sameGitRoot(candidateInspection.commonDir ?? "", identity.commonDir)) {
      throw new WorktreeManagerError("post-create-verification-failed", `Created worktree failed verification (${candidateInspection.state})`, canonicalPath);
    }
    const provenance = provenanceFor({ identity, binding, gitDir: candidateInspection.gitDir, source: "created" });
    persistManagerProvenance(identity, provenance);
    const ownedBinding = { ...binding, manager: taskKernelManagerBinding(provenance) };
    const inspection = inspectRunWorktree({ repoRoot: identity.root, runId: input.runId, runState: "running", binding: ownedBinding });
    if (inspection.issues.some((issue) => issue !== "unintegrated") || inspection.headSha !== baseSha || !sameGitRoot(inspection.commonDir ?? "", identity.commonDir)) {
      throw new WorktreeManagerError("post-create-verification-failed", `Created worktree failed verification (${inspection.state})`, canonicalPath);
    }
    return ownedBinding;
  } catch (error) {
    if (error instanceof WorktreeManagerError && error.worktreePath) throw error;
    throw new WorktreeManagerError("post-create-verification-failed", "Created worktree could not be verified; preserve it for recovery", canonicalPath);
  }
}

export function adoptRunWorktree(input: {
  repoRoot: string;
  runId: string;
  runState: "waiting" | "running";
  canonicalPath: string;
  branch: string;
  baseSha: string;
  writeSet: readonly string[];
  knownOwners?: readonly WorkspaceOwnerRef[];
  authorization: { approvedBy: string; approvedAt: string; evidenceRef: string };
}): RunWorkspaceBinding {
  assertRunId(input.runId);
  if (!input.authorization.approvedBy.trim() || !input.authorization.approvedAt.trim() || !input.authorization.evidenceRef.trim()) {
    throw new WorktreeManagerError("adoption-not-authorized", "Adoption requires an explicit recorded authorization");
  }
  const identity = repoIdentity(input.repoRoot);
  const canonicalPath = assertAllowedPath(identity, input.canonicalPath);
  if (ownerConflict(canonicalPath, input.runId, input.knownOwners ?? [])) {
    throw new WorktreeManagerError("owner-conflict", "Worktree is already owned by another Run", canonicalPath);
  }
  const baseSha = validateSha(input.baseSha);
  const writeSet = normalizeWriteSet(input.writeSet);
  const binding: RunWorkspaceBinding = {
    ownerRunId: input.runId,
    canonicalPath,
    branch: input.branch,
    baseSha,
    writeSet,
    integrationState: "not-integrated",
    reclamationState: "not-requested",
    manager: null,
    integrationReceipt: null,
    cleanupLease: null,
  };
  const inspection = inspectRunWorktreeInternal({ repoRoot: identity.root, runId: input.runId, runState: input.runState, binding, knownOwners: input.knownOwners }, false);
  if (inspection.issues.some((issue) => issue !== "unintegrated") || inspection.headSha !== baseSha || inspection.dirty) {
    throw new WorktreeManagerError("adoption-not-safe", `Only a clean, unmodified worktree at its recorded base can be adopted (${inspection.state})`, canonicalPath);
  }
  if (!inspection.gitDir) throw new WorktreeManagerError("adoption-not-safe", "Adopted worktree has no verified linked Git directory", canonicalPath);
  let ownedBinding: RunWorkspaceBinding;
  try {
    const provenance = provenanceFor({ identity, binding, gitDir: inspection.gitDir, source: "adopted", adoption: input.authorization });
    persistManagerProvenance(identity, provenance);
    ownedBinding = { ...binding, manager: taskKernelManagerBinding(provenance) };
  } catch (error) {
    if (error instanceof WorktreeManagerError && error.code === "owner-conflict") throw error;
    throw new WorktreeManagerError("adoption-not-safe", error instanceof Error ? error.message : "Could not persist adoption evidence", canonicalPath);
  }
  const verified = inspectRunWorktree({ repoRoot: identity.root, runId: input.runId, runState: input.runState, binding: ownedBinding, knownOwners: input.knownOwners });
  if (verified.issues.some((issue) => issue !== "unintegrated") || verified.headSha !== baseSha) {
    throw new WorktreeManagerError("adoption-not-safe", `Adopted worktree failed provenance verification (${verified.state})`, canonicalPath);
  }
  return ownedBinding;
}

function inspectRunWorktreeInternal(input: {
  repoRoot: string;
  runId: string;
  runState: WorkspaceRunState;
  binding: RunWorkspaceBinding;
  knownOwners?: readonly WorkspaceOwnerRef[];
}, requireManagerProvenance: boolean): WorktreeInspection {
  const blank: WorktreeInspection = {
    state: "path-anomaly", ownerRunId: input.binding.ownerRunId,
    canonicalPath: input.binding.canonicalPath, actualPath: null, commonDir: null,
    gitDir: null, branch: null, baseSha: input.binding.baseSha, headSha: null, dirty: false,
    dirtyEntryCount: 0, changedPaths: [], scopeViolations: [], issues: [],
  };
  const add = (issue: WorktreeIssueCode): void => { if (!blank.issues.includes(issue)) blank.issues.push(issue); };
  try {
    assertRunId(input.runId);
    if (input.binding.ownerRunId !== input.runId || ownerConflict(input.binding.canonicalPath, input.runId, input.knownOwners ?? [])) add("owner-mismatch");
    const identity = repoIdentity(input.repoRoot);
    const candidate = assertAllowedPath(identity, input.binding.canonicalPath);
    blank.actualPath = candidate;
    blank.commonDir = identity.commonDir;
    const registration = registrations(identity).find((item) => pathKey(item.path) === pathKey(candidate));
    if (!registration) add("not-registered");
    else {
      if (registration.head) blank.headSha = registration.head;
      let actualBranch: string | null = null;
      try { actualBranch = git(candidate, ["symbolic-ref", "--quiet", "HEAD"]); }
      catch { add("branch-mismatch"); }
      blank.branch = actualBranch?.startsWith("refs/heads/") ? actualBranch.slice("refs/heads/".length) : null;
      if (!sameGitRoot(git(candidate, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), identity.commonDir)) add("common-dir-mismatch");
      const expectedBranch = branchRef(identity.root, input.binding.branch);
      if (registration.branch !== expectedBranch || actualBranch !== expectedBranch || registration.branch !== actualBranch || registration.detached) add("branch-mismatch");
      try { blank.gitDir = verifyLinkedGitDirectory(candidate, identity.commonDir); }
      catch { add("gitdir-mismatch"); }
      const headSha = resolveCommit(candidate, "HEAD");
      blank.headSha = headSha;
      if (registration.head?.toLowerCase() !== headSha) add("registered-head-mismatch");
      const baseSha = validateSha(input.binding.baseSha);
      resolveCommit(identity.root, baseSha);
      if (!isAncestor(candidate, baseSha, headSha)) add("baseline-mismatch");
      blank.changedPaths = changedPaths(candidate, baseSha, headSha);
      blank.scopeViolations = blank.changedPaths.filter((file) => !pathCoveredByWriteSet(file, normalizeWriteSet(input.binding.writeSet)));
      if (blank.scopeViolations.length) add("write-set-violation");
      const dirtyEntries = worktreeStatus(candidate);
      blank.dirtyEntryCount = dirtyEntries.length;
      blank.dirty = dirtyEntries.length > 0;
      if (blank.dirty) add("dirty");
      if (requireManagerProvenance) {
        try {
          const provenanceRecords = readAllManagerProvenance(identity);
          const pathOwners = provenanceRecords.filter((item) => pathKey(item.canonicalPath) === pathKey(candidate));
          const runOwners = provenanceRecords.filter((item) => item.ownerRunId === input.runId);
          const provenance = runOwners[0];
          const manager = input.binding.manager;
          if (pathOwners.length !== 1 || pathOwners[0]?.ownerRunId !== input.runId
            || runOwners.length !== 1
            || !manager || provenance?.ownerRunId !== input.binding.ownerRunId
            || provenance.credentialId !== manager.credentialId
            || pathKey(provenance.canonicalPath) !== pathKey(candidate)
            || pathKey(provenance.projectRoot) !== pathKey(identity.root)
            || pathKey(provenance.commonDir) !== pathKey(identity.commonDir)
            || pathKey(manager.projectRoot) !== pathKey(provenance.projectRoot)
            || pathKey(manager.commonDir) !== pathKey(provenance.commonDir)
            || pathKey(manager.gitDir) !== pathKey(provenance.gitDir)
            || manager.source !== provenance.source
            || manager.recordedAt !== provenance.recordedAt
            || provenance.branch !== input.binding.branch
            || provenance.baseSha.toLowerCase() !== validateSha(input.binding.baseSha)
            || provenance.writeSet.map(comparable).join("\0") !== normalizeWriteSet(input.binding.writeSet).map(comparable).join("\0")
            || !blank.gitDir || pathKey(provenance.gitDir) !== pathKey(blank.gitDir)) add("manager-provenance-mismatch");
        } catch { add("manager-provenance-mismatch"); }
      }
    }
    if (input.runState === "interrupted") add("interrupted");
    if (input.binding.integrationState !== "integrated") add("unintegrated");
  } catch (error) {
    const issue: WorktreeIssueCode = error instanceof WorktreeManagerError && error.code === "owner-conflict"
      ? "owner-mismatch"
      : error instanceof WorktreeManagerError && (error.code.startsWith("manager-provenance") || error.code === "gitdir-mismatch")
        ? error.code === "gitdir-mismatch" ? "gitdir-mismatch" : "manager-provenance-mismatch"
        : "path-anomaly";
    add(issue);
  }
  const priority: WorktreeIssueCode[] = [
    "path-anomaly", "owner-mismatch", "manager-provenance-mismatch", "gitdir-mismatch", "not-registered", "common-dir-mismatch", "branch-mismatch",
    "registered-head-mismatch", "baseline-mismatch", "write-set-violation", "interrupted", "unintegrated", "dirty",
  ];
  blank.state = priority.find((issue) => blank.issues.includes(issue)) ?? "clean";
  return blank;
}

export function inspectRunWorktree(input: {
  repoRoot: string;
  runId: string;
  runState: WorkspaceRunState;
  binding: RunWorkspaceBinding;
  knownOwners?: readonly WorkspaceOwnerRef[];
}): WorktreeInspection {
  return inspectRunWorktreeInternal(input, true);
}

/** Rebuild a binding only from a fully verified provenance pair owned by this Run. */
export function reconcileRunWorktree(input: {
  repoRoot: string;
  runId: string;
  runState: "waiting" | "running";
  baseSha: string;
  writeSet: readonly string[];
  branch?: string;
  knownOwners?: readonly WorkspaceOwnerRef[];
}): RunWorkspaceBinding {
  assertRunId(input.runId);
  const identity = repoIdentity(input.repoRoot);
  const baseSha = validateSha(input.baseSha);
  resolveCommit(identity.root, baseSha);
  const writeSet = normalizeWriteSet(input.writeSet);
  const owners = readAllManagerProvenance(identity);
  const matches = owners.filter((item) => item.ownerRunId === input.runId);
  const provenance = matches[0];
  if (matches.length !== 1 || !provenance) {
    throw new WorktreeManagerError("manager-provenance-invalid", "No unique manager provenance is available to reconcile this Run");
  }
  if (pathKey(provenance.projectRoot) !== pathKey(identity.root)
    || pathKey(provenance.commonDir) !== pathKey(identity.commonDir)
    || provenance.baseSha.toLowerCase() !== baseSha.toLowerCase()
    || (input.branch !== undefined && provenance.branch !== input.branch)
    || provenance.writeSet.map(comparable).join("\0") !== writeSet.map(comparable).join("\0")) {
    throw new WorktreeManagerError("manager-provenance-invalid", "Persisted manager provenance does not match this Run's frozen baseline, branch, or write set", provenance.canonicalPath);
  }
  const canonicalPath = assertAllowedPath(identity, provenance.canonicalPath);
  const binding: RunWorkspaceBinding = {
    ownerRunId: provenance.ownerRunId,
    canonicalPath,
    branch: provenance.branch,
    baseSha: provenance.baseSha,
    writeSet: [...provenance.writeSet],
    integrationState: "not-integrated",
    reclamationState: "not-requested",
    manager: taskKernelManagerBinding(provenance),
    integrationReceipt: null,
    cleanupLease: null,
  };
  const inspection = inspectRunWorktree({
    repoRoot: identity.root,
    runId: input.runId,
    runState: input.runState,
    binding,
    knownOwners: input.knownOwners,
  });
  if (inspection.issues.some((issue) => issue !== "unintegrated") || !inspection.headSha || inspection.dirty) {
    throw new WorktreeManagerError("post-create-verification-failed", `Persisted Run checkout is not safe to reconcile (${inspection.state})`, canonicalPath);
  }
  return binding;
}
