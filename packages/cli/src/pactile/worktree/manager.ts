import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sameGitRoot } from "../../utils/git-root.js";

/** Structural mirror of the P35 TaskRunWorkspaceBinding; keep this module Core-neutral. */
export interface RunWorkspaceBinding {
  ownerRunId: string;
  canonicalPath: string;
  branch: string;
  baseSha: string;
  writeSet: string[];
  integrationState: "not-integrated" | "integrated";
  reclamationState: "not-requested" | "pending" | "reclaimed" | "failed";
}

export type WorkspaceRunState = "waiting" | "running" | "completed" | "failed" | "blocked" | "cancelled" | "interrupted";

export interface WorkspaceOwnerRef {
  ownerRunId: string;
  canonicalPath: string;
}

export interface RunResultEvidence {
  runId: string;
  summary: string;
  evidenceRefs: string[];
}

function preservedResultMatches(result: RunResultEvidence | null, runId: string): result is RunResultEvidence {
  return !!result && result.runId === runId && !!result.summary.trim()
    && Array.isArray(result.evidenceRefs) && result.evidenceRefs.length > 0
    && result.evidenceRefs.every((reference) => typeof reference === "string" && !!reference.trim());
}

export type WorktreeIssueCode =
  | "path-anomaly"
  | "owner-mismatch"
  | "not-registered"
  | "common-dir-mismatch"
  | "branch-mismatch"
  | "registered-head-mismatch"
  | "baseline-mismatch"
  | "write-set-violation"
  | "interrupted"
  | "unintegrated"
  | "dirty";

export interface WorktreeInspection {
  state: "clean" | WorktreeIssueCode;
  ownerRunId: string;
  canonicalPath: string;
  actualPath: string | null;
  commonDir: string | null;
  branch: string | null;
  baseSha: string;
  headSha: string | null;
  dirty: boolean;
  dirtyEntryCount: number;
  changedPaths: string[];
  scopeViolations: string[];
  issues: WorktreeIssueCode[];
}

export interface ParallelWriteSetAuthorization {
  runIds: [string, string];
  overlapPaths: string[];
  approvedBy: string;
  approvedAt: string;
  evidenceRef: string;
  integrationPlan: string;
}

export type ParallelWriteSetDecision =
  | { allowed: true; overlapPaths: string[]; authorization: ParallelWriteSetAuthorization | null }
  | { allowed: false; overlapPaths: string[]; reason: "write-set-conflict" | "invalid-authorization" };

export class WorktreeManagerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly worktreePath: string | null = null,
  ) {
    super(message);
    this.name = "WorktreeManagerError";
  }
}

interface GitIdentity {
  root: string;
  commonDir: string;
}

interface GitWorktreeRegistration {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function git(cwd: string, args: string[]): string {
  const execOptions: ExecFileSyncOptionsWithStringEncoding = {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  };
  try {
    return execFileSync("git", args, execOptions).replace(/\r?\n$/, "");
  } catch {
    throw new WorktreeManagerError("git-command-failed", `git ${args[0] ?? "command"} failed`);
  }
}

function pathKey(value: string): string {
  const resolved = path.resolve(value).replaceAll("\\", "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathWithin(parent: string, candidate: string, allowEqual = false): boolean {
  const relative = path.relative(parent, candidate);
  if (!relative) return allowEqual;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertAbsolute(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new WorktreeManagerError("path-anomaly", `${label} must be absolute`);
  if (value.replaceAll("\\", "/").split("/").some((segment) => segment === "." || segment === "..")) {
    throw new WorktreeManagerError("path-anomaly", `${label} must not contain dot segments`);
  }
  return path.resolve(value);
}

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId) || runId === "." || runId === "..") {
    throw new WorktreeManagerError("invalid-run-id", "Run id is not a safe path component");
  }
}

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

function repoIdentity(repoRoot: string): GitIdentity {
  const requestedRoot = assertAbsolute(repoRoot, "Repository root");
  let root: string;
  try { root = fs.realpathSync(requestedRoot); }
  catch { throw new WorktreeManagerError("invalid-repository", "Repository root does not exist"); }
  if (!fs.statSync(root).isDirectory()) throw new WorktreeManagerError("invalid-repository", "Repository root is not a directory");
  const topLevel = path.resolve(git(root, ["rev-parse", "--show-toplevel"]));
  if (!sameGitRoot(topLevel, root)) throw new WorktreeManagerError("invalid-repository", "Repository root must be the Git project root");
  const commonRaw = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonPath = path.resolve(root, commonRaw);
  let commonDir: string;
  try { commonDir = fs.realpathSync(commonPath); }
  catch { throw new WorktreeManagerError("invalid-repository", "Git common directory is unavailable"); }
  return { root, commonDir };
}

function allowedWorktreeRoot(root: string): string {
  return path.resolve(root, ".pactile", "worktrees");
}

function assertNoSymlinkBetween(root: string, target: string): void {
  if (!pathWithin(root, target, true)) throw new WorktreeManagerError("path-anomaly", "Worktree path is outside the project root");
  const relative = path.relative(root, target);
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new WorktreeManagerError("path-anomaly", `Worktree path crosses a symlink: ${cursor}`, target);
  }
}

function ensureAllowedRoot(identity: GitIdentity): string {
  const root = allowedWorktreeRoot(identity.root);
  assertNoSymlinkBetween(identity.root, root);
  fs.mkdirSync(root, { recursive: true });
  assertNoSymlinkBetween(identity.root, root);
  let real: string;
  try { real = fs.realpathSync(root); }
  catch { throw new WorktreeManagerError("path-anomaly", "Worktree root could not be resolved", root); }
  if (pathKey(real) !== pathKey(root)) throw new WorktreeManagerError("path-anomaly", "Worktree root resolves through an alias", root);
  return root;
}

function assertAllowedPath(identity: GitIdentity, candidateValue: string): string {
  const candidate = assertAbsolute(candidateValue, "Canonical worktree path");
  const root = allowedWorktreeRoot(identity.root);
  if (!pathWithin(root, candidate)) throw new WorktreeManagerError("path-anomaly", "Worktree path must be inside .pactile/worktrees", candidate);
  assertNoSymlinkBetween(identity.root, candidate);
  let real: string;
  try { real = fs.realpathSync(candidate); }
  catch { throw new WorktreeManagerError("path-anomaly", "Worktree path does not exist", candidate); }
  if (pathKey(real) !== pathKey(candidate) || !pathWithin(root, real)) {
    throw new WorktreeManagerError("path-anomaly", "Worktree path resolves outside its canonical location", candidate);
  }
  return real;
}

function resolveCommit(cwd: string, reference: string): string {
  if (!reference || reference.startsWith("-") || /[\r\n\0]/.test(reference)) {
    throw new WorktreeManagerError("invalid-ref", "Git reference is invalid");
  }
  const resolved = git(cwd, ["rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`]);
  if (!SHA.test(resolved)) throw new WorktreeManagerError("invalid-ref", "Git reference did not resolve to a commit SHA");
  return resolved.toLowerCase();
}

function resolveLocalBranchTarget(cwd: string, reference: string): { ref: string; branch: string; headSha: string } {
  let ref: string;
  if (reference === "HEAD") {
    try { ref = git(cwd, ["symbolic-ref", "--quiet", "HEAD"]); }
    catch { throw new WorktreeManagerError("integration-target-invalid", "Integration target HEAD must be attached to a local branch"); }
    if (!ref.startsWith("refs/heads/")) throw new WorktreeManagerError("integration-target-invalid", "Integration target must be a local branch");
  } else {
    const branch = reference.startsWith("refs/heads/") ? reference.slice("refs/heads/".length) : reference;
    ref = branchRef(cwd, branch);
    try { git(cwd, ["show-ref", "--verify", "--quiet", ref]); }
    catch { throw new WorktreeManagerError("integration-target-invalid", "Integration target branch does not exist"); }
  }
  const branch = ref.slice("refs/heads/".length);
  return { ref, branch, headSha: resolveCommit(cwd, ref) };
}

function validateSha(sha: string): string {
  if (!SHA.test(sha)) throw new WorktreeManagerError("invalid-sha", "Base SHA must be a full commit SHA");
  return sha.toLowerCase();
}

function branchRef(cwd: string, branch: string): string {
  if (!branch || branch.startsWith("-") || /[\r\n\0]/.test(branch)) throw new WorktreeManagerError("invalid-branch", "Branch name is invalid");
  const ref = `refs/heads/${branch}`;
  try { git(cwd, ["check-ref-format", ref]); }
  catch { throw new WorktreeManagerError("invalid-branch", "Branch name is invalid"); }
  return ref;
}

function parseWorktreeRegistrations(value: string): GitWorktreeRegistration[] {
  const output: GitWorktreeRegistration[] = [];
  let current: GitWorktreeRegistration | null = null;
  for (const field of value.split("\0").filter(Boolean)) {
    if (field.startsWith("worktree ")) {
      if (current) output.push(current);
      current = { path: field.slice("worktree ".length), head: null, branch: null, detached: false };
    } else if (!current) continue;
    else if (field.startsWith("HEAD ")) current.head = field.slice("HEAD ".length).toLowerCase();
    else if (field.startsWith("branch ")) current.branch = field.slice("branch ".length);
    else if (field === "detached") current.detached = true;
  }
  if (current) output.push(current);
  return output;
}

function registrations(identity: GitIdentity): GitWorktreeRegistration[] {
  return parseWorktreeRegistrations(git(identity.root, ["worktree", "list", "--porcelain", "-z"]));
}

function worktreeStatus(cwd: string): string[] {
  const output = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]);
  return output.split("\0").filter(Boolean);
}

function changedPaths(cwd: string, baseSha: string, headSha: string): string[] {
  const output = git(cwd, ["diff", "--name-only", "--no-renames", "-z", baseSha, headSha]);
  return [...new Set(output.split("\0").filter(Boolean).map((item) => item.replaceAll("\\", "/")))].sort();
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd, stdio: ["ignore", "ignore", "pipe"],
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException & { status?: number }).status === 1) return false;
    throw new WorktreeManagerError("git-command-failed", "git merge-base failed");
  }
}

function ownerConflict(canonicalPath: string, ownerRunId: string, knownOwners: readonly WorkspaceOwnerRef[]): boolean {
  return knownOwners.some((owner) => pathKey(owner.canonicalPath) === pathKey(canonicalPath) && owner.ownerRunId !== ownerRunId);
}

export function createRunWorktree(input: {
  repoRoot: string;
  runId: string;
  branch: string;
  baseRef: string;
  writeSet: readonly string[];
  knownOwners: readonly WorkspaceOwnerRef[];
}): RunWorkspaceBinding {
  assertRunId(input.runId);
  const identity = repoIdentity(input.repoRoot);
  const worktreeRoot = allowedWorktreeRoot(identity.root);
  const canonicalPath = path.resolve(worktreeRoot, input.runId);
  if (!pathWithin(worktreeRoot, canonicalPath) || ownerConflict(canonicalPath, input.runId, input.knownOwners)) {
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
    };
    const inspection = inspectRunWorktree({ repoRoot: identity.root, runId: input.runId, runState: "running", binding, knownOwners: [] });
    if (inspection.issues.some((issue) => issue !== "unintegrated") || inspection.headSha !== baseSha || !sameGitRoot(inspection.commonDir ?? "", identity.commonDir)) {
      throw new WorktreeManagerError("post-create-verification-failed", `Created worktree failed verification (${inspection.state})`, canonicalPath);
    }
    return binding;
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
  knownOwners: readonly WorkspaceOwnerRef[];
  authorization: { approvedBy: string; approvedAt: string; evidenceRef: string };
}): RunWorkspaceBinding {
  assertRunId(input.runId);
  if (!input.authorization.approvedBy.trim() || !input.authorization.approvedAt.trim() || !input.authorization.evidenceRef.trim()) {
    throw new WorktreeManagerError("adoption-not-authorized", "Adoption requires an explicit recorded authorization");
  }
  const identity = repoIdentity(input.repoRoot);
  const canonicalPath = assertAllowedPath(identity, input.canonicalPath);
  if (ownerConflict(canonicalPath, input.runId, input.knownOwners)) {
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
  };
  const inspection = inspectRunWorktree({ repoRoot: identity.root, runId: input.runId, runState: input.runState, binding, knownOwners: input.knownOwners });
  if (inspection.issues.some((issue) => issue !== "unintegrated") || inspection.headSha !== baseSha || inspection.dirty) {
    throw new WorktreeManagerError("adoption-not-safe", `Only a clean, unmodified worktree at its recorded base can be adopted (${inspection.state})`, canonicalPath);
  }
  return binding;
}

export function inspectRunWorktree(input: {
  repoRoot: string;
  runId: string;
  runState: WorkspaceRunState;
  binding: RunWorkspaceBinding;
  knownOwners: readonly WorkspaceOwnerRef[];
}): WorktreeInspection {
  const blank: WorktreeInspection = {
    state: "path-anomaly", ownerRunId: input.binding.ownerRunId,
    canonicalPath: input.binding.canonicalPath, actualPath: null, commonDir: null,
    branch: null, baseSha: input.binding.baseSha, headSha: null, dirty: false,
    dirtyEntryCount: 0, changedPaths: [], scopeViolations: [], issues: [],
  };
  const add = (issue: WorktreeIssueCode): void => { if (!blank.issues.includes(issue)) blank.issues.push(issue); };
  try {
    assertRunId(input.runId);
    if (input.binding.ownerRunId !== input.runId || ownerConflict(input.binding.canonicalPath, input.runId, input.knownOwners)) add("owner-mismatch");
    const identity = repoIdentity(input.repoRoot);
    const candidate = assertAllowedPath(identity, input.binding.canonicalPath);
    blank.actualPath = candidate;
    blank.commonDir = identity.commonDir;
    const registration = registrations(identity).find((item) => pathKey(item.path) === pathKey(candidate));
    if (!registration) add("not-registered");
    else {
      if (registration.head) blank.headSha = registration.head;
      if (registration.branch) blank.branch = registration.branch.startsWith("refs/heads/") ? registration.branch.slice("refs/heads/".length) : registration.branch;
      if (!sameGitRoot(git(candidate, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), identity.commonDir)) add("common-dir-mismatch");
      if (registration.branch !== branchRef(identity.root, input.binding.branch) || registration.detached) add("branch-mismatch");
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
    }
    if (input.runState === "interrupted") add("interrupted");
    if (input.binding.integrationState !== "integrated") add("unintegrated");
  } catch (error) {
    const issue = error instanceof WorktreeManagerError && error.code === "owner-conflict" ? "owner-mismatch" : "path-anomaly";
    add(issue);
  }
  const priority: WorktreeIssueCode[] = [
    "path-anomaly", "owner-mismatch", "not-registered", "common-dir-mismatch", "branch-mismatch",
    "registered-head-mismatch", "baseline-mismatch", "write-set-violation", "interrupted", "unintegrated", "dirty",
  ];
  blank.state = priority.find((issue) => blank.issues.includes(issue)) ?? "clean";
  return blank;
}

export interface WorktreeIntegrationReceipt {
  runId: string;
  worktreeHeadSha: string;
  targetRef: string;
  targetBranch: string;
  targetHeadSha: string;
  verifiedAt: string;
  resultEvidenceRefs: string[];
}

export function verifyWorktreeIntegration(input: {
  repoRoot: string;
  runId: string;
  runState: WorkspaceRunState;
  binding: RunWorkspaceBinding;
  knownOwners: readonly WorkspaceOwnerRef[];
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
  return {
    binding: { ...input.binding, integrationState: "integrated", reclamationState: "pending" },
    receipt: {
      runId: input.runId,
      worktreeHeadSha: inspection.headSha,
      targetRef: input.targetRef,
      targetBranch: target.branch,
      targetHeadSha,
      verifiedAt: new Date().toISOString(),
      resultEvidenceRefs: [...input.result.evidenceRefs],
    },
  };
}

export type WorktreeCleanupResult =
  | { state: "reclaimed"; binding: RunWorkspaceBinding; path: string }
  | { state: "retained"; binding: RunWorkspaceBinding; path: string; reason: string };

export function reclaimRunWorktree(input: {
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
  if (!preservedResultMatches(input.result, input.runId)) {
    return retain("Run result evidence is not preserved");
  }
  let integration: ReturnType<typeof verifyWorktreeIntegration>;
  let identity: GitIdentity;
  let canonicalPath: string;
  try {
    integration = verifyWorktreeIntegration(input);
    identity = repoIdentity(input.repoRoot);
    canonicalPath = assertAllowedPath(identity, input.binding.canonicalPath);
    if (pathKey(canonicalPath) !== pathKey(pathForReport)) return retain("Canonical worktree path changed during cleanup preflight");
    if (!sameGitRoot(git(canonicalPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), identity.commonDir)) return retain("Worktree common directory changed");
    const finalInspection = inspectRunWorktree(input);
    if (finalInspection.state !== "clean" || finalInspection.headSha !== integration.receipt.worktreeHeadSha) {
      return retain(`Worktree changed or needs preservation (${finalInspection.state})`);
    }
  } catch (error) {
    return retain(error instanceof Error ? error.message : "Worktree cleanup preflight failed");
  }
  try {
    // Git owns checkout removal and refuses dirty worktrees; never force it and never fall back to recursive deletion.
    git(identity.root, ["worktree", "remove", canonicalPath]);
    const remainsRegistered = registrations(identity).some((item) => pathKey(item.path) === pathKey(canonicalPath));
    if (fs.existsSync(canonicalPath) || remainsRegistered) return retain("Git did not fully remove the registered worktree");
    return {
      state: "reclaimed",
      binding: { ...input.binding, reclamationState: "reclaimed" },
      path: canonicalPath,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Worktree cleanup failed";
    return retain(reason, true);
  }
}
