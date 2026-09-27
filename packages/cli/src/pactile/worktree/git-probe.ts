import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { sameGitRoot } from "../../utils/git-root.js";
import { WorktreeManagerError, type GitIdentity, type GitWorktreeRegistration, type WorkspaceOwnerRef } from "./manager-types.js";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export interface GitTreePathEntry {
  path: string;
  mode: string;
  type: "blob" | "commit";
  objectId: string;
}

export function git(cwd: string, args: string[]): string {
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

export function pathKey(value: string): string {
  const resolved = path.resolve(value).replaceAll("\\", "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function pathWithin(parent: string, candidate: string, allowEqual = false): boolean {
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

function gitBuffer(cwd: string, args: string[]): Buffer {
  try {
    return execFileSync("git", args, {
      cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    throw new WorktreeManagerError("git-command-failed", `git ${args[0] ?? "command"} failed`);
  }
}

function nulSeparatedRecords(value: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) continue;
    if (index > start) records.push(value.subarray(start, index));
    start = index + 1;
  }
  if (start < value.length) records.push(value.subarray(start));
  return records;
}

function decodeGitPath(value: Buffer): string {
  try { return UTF8.decode(value); }
  catch { throw new WorktreeManagerError("git-path-unrepresentable", "Git path is not valid UTF-8; refusing to verify its tree content"); }
}

export function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId) || runId === "." || runId === "..") {
    throw new WorktreeManagerError("invalid-run-id", "Run id is not a safe path component");
  }
}


export function repoIdentity(repoRoot: string): GitIdentity {
  const requestedRoot = assertAbsolute(repoRoot, "Repository root");
  let root: string;
  try { root = fs.realpathSync(requestedRoot); }
  catch { throw new WorktreeManagerError("invalid-repository", "Repository root does not exist"); }
  if (!fs.statSync(root).isDirectory()) throw new WorktreeManagerError("invalid-repository", "Repository root is not a directory");
  const topLevel = path.resolve(git(root, ["rev-parse", "--show-toplevel"]));
  if (!sameGitRoot(topLevel, root)) throw new WorktreeManagerError("invalid-repository", "Repository root must be the Git project root");
  // Git for Windows may expand an 8.3 temp path. Once identity is verified,
  // use Git's spelling for managed paths and registration comparisons.
  root = fs.realpathSync(topLevel);
  const commonRaw = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonPath = path.resolve(root, commonRaw);
  let commonDir: string;
  try { commonDir = fs.realpathSync(commonPath); }
  catch { throw new WorktreeManagerError("invalid-repository", "Git common directory is unavailable"); }
  return { root, commonDir };
}

export function allowedWorktreeRoot(root: string): string {
  return path.resolve(root, ".pactile", "worktrees");
}

export function assertNoSymlinkBetween(root: string, target: string): void {
  if (!pathWithin(root, target, true)) throw new WorktreeManagerError("path-anomaly", "Worktree path is outside the project root");
  const relative = path.relative(root, target);
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new WorktreeManagerError("path-anomaly", `Worktree path crosses a symlink: ${cursor}`, target);
  }
}

export function ensureAllowedRoot(identity: GitIdentity): string {
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

export function assertAllowedPath(identity: GitIdentity, candidateValue: string): string {
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

export function verifyLinkedGitDirectory(candidate: string, commonDir: string): string {
  let gitDir: string;
  try { gitDir = fs.realpathSync(git(candidate, ["rev-parse", "--absolute-git-dir"])); }
  catch { throw new WorktreeManagerError("gitdir-mismatch", "Worktree Git directory cannot be resolved", candidate); }
  if (!pathWithin(commonDir, gitDir) || pathKey(gitDir) === pathKey(commonDir)) {
    throw new WorktreeManagerError("gitdir-mismatch", "Worktree Git directory is outside its common directory", candidate);
  }
  const gitFile = path.join(candidate, ".git");
  const gitFileStat = fs.lstatSync(gitFile, { throwIfNoEntry: false });
  if (!gitFileStat?.isFile() || gitFileStat.isSymbolicLink()) {
    throw new WorktreeManagerError("gitdir-mismatch", "Linked worktree .git pointer is not a regular file", candidate);
  }
  const pointer = fs.readFileSync(gitFile, "utf8").match(/^gitdir: ([^\r\n]+)\r?\n?$/);
  if (!pointer) throw new WorktreeManagerError("gitdir-mismatch", "Linked worktree .git pointer is malformed", candidate);
  const pointerTarget = fs.realpathSync(path.resolve(candidate, pointer[1] ?? ""));
  if (pathKey(pointerTarget) !== pathKey(gitDir)) {
    throw new WorktreeManagerError("gitdir-mismatch", "Linked worktree .git pointer does not match its resolved Git directory", candidate);
  }
  const reverseFile = path.join(gitDir, "gitdir");
  const reverseStat = fs.lstatSync(reverseFile, { throwIfNoEntry: false });
  if (!reverseStat?.isFile() || reverseStat.isSymbolicLink()) {
    throw new WorktreeManagerError("gitdir-mismatch", "Worktree registration reverse link is unavailable", candidate);
  }
  const reverseTarget = fs.realpathSync(path.resolve(gitDir, fs.readFileSync(reverseFile, "utf8").trim()));
  if (pathKey(reverseTarget) !== pathKey(fs.realpathSync(gitFile))) {
    throw new WorktreeManagerError("gitdir-mismatch", "Worktree registration does not point back to this checkout", candidate);
  }
  return gitDir;
}

export function resolveCommit(cwd: string, reference: string): string {
  if (!reference || reference.startsWith("-") || /[\r\n\0]/.test(reference)) {
    throw new WorktreeManagerError("invalid-ref", "Git reference is invalid");
  }
  const resolved = git(cwd, ["rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`]);
  if (!SHA.test(resolved)) throw new WorktreeManagerError("invalid-ref", "Git reference did not resolve to a commit SHA");
  return resolved.toLowerCase();
}

export function resolveLocalBranchTarget(cwd: string, reference: string): { ref: string; branch: string; headSha: string } {
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

export function validateSha(sha: string): string {
  if (!SHA.test(sha)) throw new WorktreeManagerError("invalid-sha", "Base SHA must be a full commit SHA");
  return sha.toLowerCase();
}

export function branchRef(cwd: string, branch: string): string {
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

export function registrations(identity: GitIdentity): GitWorktreeRegistration[] {
  return parseWorktreeRegistrations(git(identity.root, ["worktree", "list", "--porcelain", "-z"]));
}

export function worktreeStatus(cwd: string): string[] {
  const output = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]);
  return output.split("\0").filter(Boolean);
}

export function changedPaths(cwd: string, baseSha: string, headSha: string): string[] {
  const output = gitBuffer(cwd, ["diff", "--name-only", "--no-renames", "-z", baseSha, headSha]);
  return [...new Set(nulSeparatedRecords(output).map(decodeGitPath))].sort();
}

export function treePathEntries(cwd: string, treeish: string, paths: readonly string[]): GitTreePathEntry[] {
  if (!paths.length) return [];
  const requested = new Set(paths);
  const entries: GitTreePathEntry[] = [];
  for (let offset = 0; offset < paths.length; offset += 48) {
    const chunk = paths.slice(offset, offset + 48);
    const output = gitBuffer(cwd, [
      "ls-tree", "-r", "-z", "--full-tree", treeish, "--", ...chunk.map((item) => `:(literal)${item}`),
    ]);
    for (const record of nulSeparatedRecords(output)) {
      const separator = record.indexOf(9);
      if (separator <= 0 || separator === record.length - 1) {
        throw new WorktreeManagerError("git-tree-query-invalid", "Git returned a malformed tree entry");
      }
      const [mode, type, objectId] = record.subarray(0, separator).toString("ascii").split(" ");
      const relativePath = decodeGitPath(record.subarray(separator + 1));
      if (!mode || !/^\d{6}$/.test(mode) || (type !== "blob" && type !== "commit")
        || !objectId || !SHA.test(objectId) || !requested.has(relativePath)) {
        throw new WorktreeManagerError("git-tree-query-invalid", "Git returned an unexpected tree entry for the requested path set");
      }
      entries.push({ path: relativePath, mode, type, objectId: objectId.toLowerCase() });
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path)
    || left.mode.localeCompare(right.mode) || left.type.localeCompare(right.type) || left.objectId.localeCompare(right.objectId));
}

export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
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

export function ownerConflict(canonicalPath: string, ownerRunId: string, knownOwners: readonly WorkspaceOwnerRef[]): boolean {
  return knownOwners.some((owner) => pathKey(owner.canonicalPath) === pathKey(canonicalPath) && owner.ownerRunId !== ownerRunId);
}
