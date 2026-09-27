import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TaskRunV2, TaskSnapshotEntry } from "./task-kernel-types.js";
import {
  captureProjectFileBaseline,
  hasGitMetadataAtProjectRoot,
  isExcludedProjectPath,
  observeProjectFileCandidate,
  PROJECT_FILE_CANDIDATE_ENTRY_REF,
  verifyProjectFileCandidateObservation,
  type ProjectFileCandidateObservation,
} from "./project-file-observer.js";

export const GIT_CANDIDATE_OBSERVER_VERSION = "git-working-tree-v1" as const;
export const VERIFICATION_CANDIDATE_ENTRY_REF =
  "pactile:verification:git-working-tree-v1";
export const RUN_CANDIDATE_ENTRY_REFS = [
  VERIFICATION_CANDIDATE_ENTRY_REF,
  PROJECT_FILE_CANDIDATE_ENTRY_REF,
] as const;

const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_CHANGED_PATHS = 1_000;
const MAX_CURRENT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_CURRENT_BYTES = 32 * 1024 * 1024;
const UNTRUSTED_GIT_ENVIRONMENT = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
]);

export interface GitWriteSet {
  /** Exact repository-relative files. */
  readonly exactPaths: readonly string[];
  /** Repository-relative directories whose descendants are allowed. */
  readonly directoryPrefixes: readonly string[];
}

export type GitCandidateScopeStatus =
  | "within-write-set"
  | "out-of-scope"
  | "conflicted"
  | "workspace-mismatch";

export interface GitRepositoryBaseline {
  readonly headSha: string;
  readonly branch: string | null;
}

export interface TaskRunRepositoryBaseline {
  readonly candidateBaseSha: string | null;
  readonly candidateBaseBranch: string | null;
  readonly candidateFileBaseline: TaskRunV2["candidateFileBaseline"];
}

export interface GitCandidateFileFingerprint {
  readonly path: string;
  readonly kind: "regular-file" | "symlink" | "directory" | "missing";
  readonly sizeBytes: number;
  /** Hash of current file bytes or symlink target; null for missing paths/directories. */
  readonly sha256: string | null;
}

export interface GitTreeFileFingerprint {
  readonly commitSha: string;
  readonly path: string;
  readonly mode: "100644" | "100755";
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface GitCandidateObservation {
  readonly schemaVersion: 1;
  readonly source: typeof GIT_CANDIDATE_OBSERVER_VERSION;
  readonly repositoryRoot: string;
  /** One-way workspace identity used to detect otherwise identical observations from a different checkout. */
  readonly repositoryIdentitySha256: string;
  readonly observedAt: string;
  readonly expectedBaseSha: string | null;
  readonly expectedBranch: string | null;
  /** True when the caller bound a branch, including an explicit detached-HEAD expectation. */
  readonly expectedBranchBound: boolean;
  readonly head: string;
  readonly branch: string | null;
  readonly allowedWriteSet: GitWriteSet;
  readonly stagedPaths: readonly string[];
  readonly unstagedPaths: readonly string[];
  readonly untrackedPaths: readonly string[];
  readonly conflictPaths: readonly string[];
  /** Paths changed between the Run workspace base commit and the frozen HEAD. */
  readonly committedPaths: readonly string[];
  readonly affectedPaths: readonly string[];
  readonly inScopePaths: readonly string[];
  readonly outOfScopePaths: readonly string[];
  readonly currentFiles: readonly GitCandidateFileFingerprint[];
  readonly indexDiffSha256: string;
  readonly worktreeDiffSha256: string;
  readonly statusSha256: string;
  readonly scopeStatus: GitCandidateScopeStatus;
  /** Stable across repeated observations of the same candidate; excludes observedAt and local root path. */
  readonly fingerprint: string;
}

export interface ObserveGitCandidateInput {
  readonly repositoryRoot: string;
  readonly allowedWriteSet: GitWriteSet;
  readonly expectedBaseSha?: string | null;
  readonly expectedBranch?: string | null;
}

export type TaskRunObservationSource = Pick<
  TaskRunV2,
  "id" | "writeSetSnapshot" | "workspace"
> &
  Partial<
    Pick<
      TaskRunV2,
      "candidateBaseSha" | "candidateBaseBranch" | "candidateFileBaseline"
    >
  >;

export interface ObserveTaskRunCandidateInput {
  readonly run: TaskRunObservationSource;
  /** Required for Runs without a workspace binding. Must resolve to the Git top-level root. */
  readonly repositoryRoot?: string;
}

export type TaskRunCandidateObservation =
  | GitCandidateObservation
  | ProjectFileCandidateObservation;

export type GitCandidateObservationErrorCode =
  | "invalid-root"
  | "invalid-write-set"
  | "write-set-mismatch"
  | "workspace-root-mismatch"
  | "git-command-failed"
  | "observation-limit-exceeded"
  | "current-file-unreadable"
  | "candidate-not-eligible";

export class GitCandidateObservationError extends Error {
  public readonly code: GitCandidateObservationErrorCode;

  public constructor(code: GitCandidateObservationErrorCode, message: string) {
    super(message);
    this.name = "GitCandidateObservationError";
    this.code = code;
  }
}

interface GitState {
  readonly head: string;
  readonly branch: string | null;
  readonly stagedPaths: readonly string[];
  readonly unstagedPaths: readonly string[];
  readonly untrackedPaths: readonly string[];
  readonly conflictPaths: readonly string[];
  readonly committedPaths: readonly string[];
  readonly indexDiffSha256: string;
  readonly worktreeDiffSha256: string;
  readonly statusSha256: string;
  readonly stateSha256: string;
}

interface CurrentFileBudget {
  totalBytes: number;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableObjectFingerprint(value: unknown): string {
  return sha256(JSON.stringify(value));
}

interface GitCommandResult {
  readonly status: number;
  readonly stdout: Buffer;
}

function runGitResult(
  repositoryRoot: string,
  args: readonly string[],
  acceptedStatuses: readonly number[] = [0],
): GitCommandResult {
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !UNTRUSTED_GIT_ENVIRONMENT.has(key),
    ),
  );
  const environment: NodeJS.ProcessEnv = {
    ...inheritedEnvironment,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  const result = spawnSync(
    "git",
    ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
    {
      cwd: repositoryRoot,
      env: environment,
      encoding: "buffer",
      windowsHide: true,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      stdio: "pipe",
    },
  );
  if (result.error !== undefined) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOBUFS") {
      throw new GitCandidateObservationError(
        "observation-limit-exceeded",
        `Git output exceeded the ${MAX_GIT_OUTPUT_BYTES}-byte observation limit.`,
      );
    }
    throw new GitCandidateObservationError(
      "git-command-failed",
      `Git ${args[0] ?? "command"} could not be started.`,
    );
  }
  if (result.status === null || !acceptedStatuses.includes(result.status)) {
    throw new GitCandidateObservationError(
      "git-command-failed",
      `Git ${args[0] ?? "command"} exited with status ${String(result.status)}.`,
    );
  }
  return { status: result.status, stdout: result.stdout ?? Buffer.alloc(0) };
}

function runGit(
  repositoryRoot: string,
  args: readonly string[],
  acceptedStatuses: readonly number[] = [0],
): Buffer {
  return runGitResult(repositoryRoot, args, acceptedStatuses).stdout;
}

function decodeGitText(bytes: Buffer, label: string): string {
  const value = bytes.toString("utf8").replace(/[\r\n]+$/, "");
  if (
    !value ||
    !Buffer.from(value, "utf8").equals(
      bytes.subarray(0, Buffer.byteLength(value)),
    )
  ) {
    throw new GitCandidateObservationError(
      "git-command-failed",
      `Git returned invalid ${label}.`,
    );
  }
  return value;
}

function decodeNulPaths(bytes: Buffer, label: string): string[] {
  const paths: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    const end = bytes.indexOf(0, start);
    if (end < 0) {
      throw new GitCandidateObservationError(
        "git-command-failed",
        `Git returned malformed ${label}.`,
      );
    }
    const encoded = bytes.subarray(start, end);
    if (encoded.length > 0) {
      const value = encoded.toString("utf8");
      if (!Buffer.from(value, "utf8").equals(encoded)) {
        throw new GitCandidateObservationError(
          "git-command-failed",
          `Git returned a ${label} path that is not valid UTF-8.`,
        );
      }
      paths.push(normalizeRepositoryPath(value, label));
      if (paths.length > MAX_CHANGED_PATHS) {
        throw new GitCandidateObservationError(
          "observation-limit-exceeded",
          `Changed path count exceeded the ${MAX_CHANGED_PATHS}-path observation limit.`,
        );
      }
    }
    start = end + 1;
  }
  return [...new Set(paths)].sort();
}

function normalizeRepositoryPath(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new GitCandidateObservationError(
      "invalid-write-set",
      `${label} must be a non-empty relative path.`,
    );
  }
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new GitCandidateObservationError(
      "invalid-write-set",
      `${label} must be repository-relative.`,
    );
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new GitCandidateObservationError(
      "invalid-write-set",
      `${label} contains an unsafe path segment.`,
    );
  }
  return segments.join("/");
}

function normalizeWriteSet(input: GitWriteSet): GitWriteSet {
  if (
    !input ||
    !Array.isArray(input.exactPaths) ||
    !Array.isArray(input.directoryPrefixes)
  ) {
    throw new GitCandidateObservationError(
      "invalid-write-set",
      "Write set must contain exactPaths and directoryPrefixes arrays.",
    );
  }
  const exactPaths = input.exactPaths.map((entry) =>
    normalizeRepositoryPath(entry, "write-set file"),
  );
  const directoryPrefixes = input.directoryPrefixes.map((entry) =>
    normalizeRepositoryPath(entry, "write-set directory"),
  );
  if (
    new Set([...exactPaths, ...directoryPrefixes]).size !==
    exactPaths.length + directoryPrefixes.length
  ) {
    throw new GitCandidateObservationError(
      "invalid-write-set",
      "Write-set paths must be unique across files and directories.",
    );
  }
  if (exactPaths.length + directoryPrefixes.length > MAX_CHANGED_PATHS) {
    throw new GitCandidateObservationError(
      "observation-limit-exceeded",
      `Run write set exceeded the ${MAX_CHANGED_PATHS}-path observation limit.`,
    );
  }
  return {
    exactPaths: [...exactPaths].sort(),
    directoryPrefixes: [...directoryPrefixes].sort(),
  };
}

function pathIsAllowed(repositoryPath: string, writeSet: GitWriteSet): boolean {
  return (
    writeSet.exactPaths.includes(repositoryPath) ||
    writeSet.directoryPrefixes.some((directory) =>
      repositoryPath.startsWith(`${directory}/`),
    )
  );
}

function collectGitState(
  repositoryRoot: string,
  expectedBaseSha: string | null,
): GitState {
  const head = decodeGitText(
    runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
    "HEAD",
  ).toLowerCase();
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(head)) {
    throw new GitCandidateObservationError(
      "git-command-failed",
      "Git HEAD is not a supported commit SHA.",
    );
  }

  const branchBytes = runGit(
    repositoryRoot,
    ["symbolic-ref", "--short", "-q", "HEAD"],
    [0, 1],
  );
  const branch =
    branchBytes.length === 0 ? null : decodeGitText(branchBytes, "branch");
  const stagedPaths = decodeNulPaths(
    runGit(repositoryRoot, [
      "diff",
      "--cached",
      "--name-only",
      "--no-renames",
      "-z",
      "--",
    ]),
    "staged paths",
  );
  const unstagedPaths = decodeNulPaths(
    runGit(repositoryRoot, ["diff", "--name-only", "--no-renames", "-z", "--"]),
    "unstaged paths",
  );
  const untrackedPaths = decodeNulPaths(
    runGit(repositoryRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
    "untracked paths",
  );
  const conflictPaths = decodeNulPaths(
    runGit(repositoryRoot, [
      "diff",
      "--name-only",
      "--diff-filter=U",
      "--no-renames",
      "-z",
      "--",
    ]),
    "conflict paths",
  );
  const committedPaths =
    expectedBaseSha === null
      ? []
      : decodeNulPaths(
          runGit(repositoryRoot, [
            "diff",
            "--name-only",
            "--no-renames",
            "-z",
            expectedBaseSha,
            head,
            "--",
          ]),
          "committed paths",
        );
  const indexDiffSha256 = sha256(
    runGit(repositoryRoot, [
      "diff",
      "--cached",
      "--raw",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "-z",
      "--",
    ]),
  );
  const worktreeDiffSha256 = sha256(
    runGit(repositoryRoot, [
      "diff",
      "--raw",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "-z",
      "--",
    ]),
  );
  const statusSha256 = sha256(
    runGit(repositoryRoot, [
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
    ]),
  );
  const state = {
    head,
    branch,
    stagedPaths,
    unstagedPaths,
    untrackedPaths,
    conflictPaths,
    committedPaths,
    indexDiffSha256,
    worktreeDiffSha256,
    statusSha256,
  };
  return { ...state, stateSha256: stableObjectFingerprint(state) };
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function samePhysicalDirectory(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    const a = fs.statSync(left, { bigint: true });
    const b = fs.statSync(right, { bigint: true });
    return (
      a.isDirectory() &&
      b.isDirectory() &&
      a.ino !== 0n &&
      a.dev === b.dev &&
      a.ino === b.ino
    );
  } catch {
    return false;
  }
}

function realRepositoryRoot(repositoryRoot: string): string {
  let requestedRoot: string;
  try {
    requestedRoot = fs.realpathSync(path.resolve(repositoryRoot));
  } catch {
    throw new GitCandidateObservationError(
      "invalid-root",
      "Repository root does not exist or cannot be resolved.",
    );
  }
  const gitRoot = decodeGitText(
    runGit(requestedRoot, ["rev-parse", "--show-toplevel"]),
    "repository root",
  );
  let resolvedGitRoot: string;
  try {
    resolvedGitRoot = fs.realpathSync(gitRoot);
  } catch {
    throw new GitCandidateObservationError(
      "invalid-root",
      "Git repository root cannot be resolved.",
    );
  }
  // Git for Windows can expand an 8.3 temp path while Node preserves its short
  // spelling. Require directory identity so the alias is accepted without
  // accepting a nested directory or a different repository.
  if (!samePhysicalDirectory(requestedRoot, resolvedGitRoot)) {
    throw new GitCandidateObservationError(
      "invalid-root",
      "Repository root must be the Git top-level directory.",
    );
  }
  return resolvedGitRoot;
}

/** Capture a stable current HEAD/branch baseline for a standalone Run. */
export function observeGitRepositoryBaseline(
  repositoryRoot: string,
): GitRepositoryBaseline {
  const root = realRepositoryRoot(repositoryRoot);
  const read = (): GitRepositoryBaseline => {
    const headSha = decodeGitText(
      runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]),
      "HEAD",
    ).toLowerCase();
    if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(headSha)) {
      throw new GitCandidateObservationError(
        "git-command-failed",
        "Git HEAD is not a supported commit SHA.",
      );
    }
    const branchBytes = runGit(
      root,
      ["symbolic-ref", "--short", "-q", "HEAD"],
      [0, 1],
    );
    return {
      headSha,
      branch:
        branchBytes.length === 0 ? null : decodeGitText(branchBytes, "branch"),
    };
  };
  const first = read();
  const second = read();
  if (first.headSha !== second.headSha || first.branch !== second.branch) {
    throw new GitCandidateObservationError(
      "current-file-unreadable",
      "Git HEAD or branch changed while capturing the Run baseline; retry with a stable repository.",
    );
  }
  return first;
}

/** Select a Git commit baseline or bounded regular-file baseline for a standalone Run. */
export function observeTaskRunRepositoryBaseline(
  repositoryRoot: string,
  writeSetSnapshot: readonly string[],
): TaskRunRepositoryBaseline {
  if (hasGitMetadataAtProjectRoot(repositoryRoot)) {
    const baseline = observeGitRepositoryBaseline(repositoryRoot);
    return {
      candidateBaseSha: baseline.headSha,
      candidateBaseBranch: baseline.branch,
      candidateFileBaseline: null,
    };
  }
  const candidateFileBaseline = captureProjectFileBaseline(
    repositoryRoot,
    writeSetSnapshot,
  );
  return {
    candidateBaseSha: null,
    candidateBaseBranch: null,
    candidateFileBaseline,
  };
}

function readCurrentFile(
  repositoryRoot: string,
  repositoryPath: string,
  budget: CurrentFileBudget,
): GitCandidateFileFingerprint {
  const absolutePath = path.join(repositoryRoot, ...repositoryPath.split("/"));
  let before: fs.Stats;
  try {
    before = fs.lstatSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        path: repositoryPath,
        kind: "missing",
        sizeBytes: 0,
        sha256: null,
      };
    }
    throw new GitCandidateObservationError(
      "current-file-unreadable",
      `Cannot inspect changed path ${repositoryPath}.`,
    );
  }

  const parentPath = path.dirname(absolutePath);
  let resolvedParent: string;
  try {
    resolvedParent = fs.realpathSync(parentPath);
  } catch {
    throw new GitCandidateObservationError(
      "current-file-unreadable",
      `Cannot resolve the parent of changed path ${repositoryPath}.`,
    );
  }
  if (!isWithin(repositoryRoot, resolvedParent)) {
    throw new GitCandidateObservationError(
      "current-file-unreadable",
      `Changed path ${repositoryPath} resolves outside the Git repository.`,
    );
  }

  if (before.isDirectory()) {
    return {
      path: repositoryPath,
      kind: "directory",
      sizeBytes: 0,
      sha256: null,
    };
  }
  let bytes: Buffer;
  let kind: GitCandidateFileFingerprint["kind"];
  if (before.isSymbolicLink()) {
    kind = "symlink";
    try {
      bytes = Buffer.from(fs.readlinkSync(absolutePath), "utf8");
    } catch {
      throw new GitCandidateObservationError(
        "current-file-unreadable",
        `Cannot read symlink ${repositoryPath}.`,
      );
    }
  } else if (before.isFile()) {
    kind = "regular-file";
    let resolvedFile: string;
    try {
      resolvedFile = fs.realpathSync(absolutePath);
    } catch {
      throw new GitCandidateObservationError(
        "current-file-unreadable",
        `Cannot resolve changed file ${repositoryPath}.`,
      );
    }
    if (!isWithin(repositoryRoot, resolvedFile)) {
      throw new GitCandidateObservationError(
        "current-file-unreadable",
        `Changed file ${repositoryPath} resolves outside the Git repository.`,
      );
    }
    if (
      before.size > MAX_CURRENT_FILE_BYTES ||
      budget.totalBytes + before.size > MAX_TOTAL_CURRENT_BYTES
    ) {
      throw new GitCandidateObservationError(
        "observation-limit-exceeded",
        `Current bytes exceeded the ${MAX_CURRENT_FILE_BYTES}-byte per-file or ${MAX_TOTAL_CURRENT_BYTES}-byte total limit.`,
      );
    }
    try {
      bytes = fs.readFileSync(absolutePath);
    } catch {
      throw new GitCandidateObservationError(
        "current-file-unreadable",
        `Cannot read changed file ${repositoryPath}.`,
      );
    }
  } else {
    throw new GitCandidateObservationError(
      "current-file-unreadable",
      `Changed path ${repositoryPath} is not a regular file, symlink, or directory.`,
    );
  }

  const after = fs.lstatSync(absolutePath);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new GitCandidateObservationError(
      "current-file-unreadable",
      `Changed path ${repositoryPath} changed during observation.`,
    );
  }
  if (kind === "regular-file" && bytes.length > MAX_CURRENT_FILE_BYTES) {
    throw new GitCandidateObservationError(
      "observation-limit-exceeded",
      `Current file ${repositoryPath} exceeded the per-file byte limit.`,
    );
  }
  if (budget.totalBytes + bytes.length > MAX_TOTAL_CURRENT_BYTES) {
    throw new GitCandidateObservationError(
      "observation-limit-exceeded",
      "Current files exceeded the total byte limit.",
    );
  }
  budget.totalBytes += bytes.length;
  return {
    path: repositoryPath,
    kind,
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
  };
}

function isWriteSetPath(
  repositoryPath: string,
  writeSet: GitWriteSet,
): boolean {
  return pathIsAllowed(repositoryPath, writeSet);
}

function stableSnapshotFingerprint(input: {
  repositoryIdentitySha256: string;
  expectedBaseSha: string | null;
  expectedBranch: string | null;
  expectedBranchBound: boolean;
  head: string;
  branch: string | null;
  allowedWriteSet: GitWriteSet;
  stagedPaths: readonly string[];
  unstagedPaths: readonly string[];
  untrackedPaths: readonly string[];
  conflictPaths: readonly string[];
  committedPaths: readonly string[];
  affectedPaths: readonly string[];
  inScopePaths: readonly string[];
  outOfScopePaths: readonly string[];
  currentFiles: readonly GitCandidateFileFingerprint[];
  indexDiffSha256: string;
  worktreeDiffSha256: string;
  statusSha256: string;
  scopeStatus: GitCandidateScopeStatus;
}): string {
  return stableObjectFingerprint({
    source: GIT_CANDIDATE_OBSERVER_VERSION,
    ...input,
  });
}

/** Read a bounded Git candidate snapshot without changing the repository. */
export function observeGitCandidate(
  input: ObserveGitCandidateInput,
): GitCandidateObservation {
  const repositoryRoot = realRepositoryRoot(input.repositoryRoot);
  const allowedWriteSet = normalizeWriteSet(input.allowedWriteSet);
  const expectedBaseSha = input.expectedBaseSha ?? null;
  const expectedBranch = input.expectedBranch ?? null;
  const expectedBranchBound = input.expectedBranch !== undefined;
  if (
    expectedBranch !== null &&
    (expectedBranch.trim().length === 0 ||
      expectedBranch !== expectedBranch.trim())
  ) {
    throw new GitCandidateObservationError(
      "invalid-write-set",
      "Expected branch must be a non-empty trimmed string.",
    );
  }
  if (
    expectedBaseSha !== null &&
    (expectedBaseSha.trim().length === 0 ||
      expectedBaseSha !== expectedBaseSha.trim())
  ) {
    throw new GitCandidateObservationError(
      "invalid-write-set",
      "Expected base SHA must be a non-empty trimmed string.",
    );
  }
  if (
    expectedBaseSha !== null &&
    !/^[a-f0-9]{40}([a-f0-9]{24})?$/i.test(expectedBaseSha)
  ) {
    throw new GitCandidateObservationError(
      "invalid-write-set",
      "Expected base SHA must be a full Git commit identifier.",
    );
  }

  const normalizedExpectedBaseSha = expectedBaseSha?.toLowerCase() ?? null;
  const initial = collectGitState(repositoryRoot, normalizedExpectedBaseSha);
  const repositoryIdentitySha256 = sha256(
    process.platform === "win32"
      ? repositoryRoot.toLowerCase()
      : repositoryRoot,
  );
  const affectedPaths = [
    ...new Set([
      ...initial.stagedPaths,
      ...initial.unstagedPaths,
      ...initial.untrackedPaths,
      ...initial.conflictPaths,
      ...initial.committedPaths,
    ]),
  ].sort();
  if (affectedPaths.length > MAX_CHANGED_PATHS) {
    throw new GitCandidateObservationError(
      "observation-limit-exceeded",
      `Affected path count exceeded the ${MAX_CHANGED_PATHS}-path limit.`,
    );
  }
  const inScopePaths = affectedPaths.filter((entry) =>
    isWriteSetPath(entry, allowedWriteSet),
  );
  const outOfScopePaths = affectedPaths.filter(
    (entry) => !isWriteSetPath(entry, allowedWriteSet),
  );
  const observationPaths = [
    ...new Set([...inScopePaths, ...allowedWriteSet.exactPaths]),
  ].sort();
  const currentFiles: GitCandidateFileFingerprint[] = [];
  const budget: CurrentFileBudget = { totalBytes: 0 };
  for (const repositoryPath of observationPaths) {
    currentFiles.push(readCurrentFile(repositoryRoot, repositoryPath, budget));
  }
  const currentAfterRead = currentFiles.map((entry) =>
    readCurrentFile(repositoryRoot, entry.path, { totalBytes: 0 }),
  );
  const after = collectGitState(repositoryRoot, normalizedExpectedBaseSha);
  if (
    initial.stateSha256 !== after.stateSha256 ||
    stableObjectFingerprint(currentFiles) !==
      stableObjectFingerprint(currentAfterRead)
  ) {
    throw new GitCandidateObservationError(
      "current-file-unreadable",
      "Git or allowed file state changed during candidate observation; retry with a stable worktree.",
    );
  }

  const workspaceMismatch =
    expectedBranchBound && expectedBranch !== initial.branch;
  const scopeStatus: GitCandidateScopeStatus =
    initial.conflictPaths.length > 0
      ? "conflicted"
      : workspaceMismatch
        ? "workspace-mismatch"
        : outOfScopePaths.length > 0
          ? "out-of-scope"
          : "within-write-set";
  const fingerprintInput = {
    repositoryIdentitySha256,
    expectedBaseSha: expectedBaseSha?.toLowerCase() ?? null,
    expectedBranch,
    expectedBranchBound,
    head: initial.head,
    branch: initial.branch,
    allowedWriteSet,
    stagedPaths: initial.stagedPaths,
    unstagedPaths: initial.unstagedPaths,
    untrackedPaths: initial.untrackedPaths,
    conflictPaths: initial.conflictPaths,
    committedPaths: initial.committedPaths,
    affectedPaths,
    inScopePaths,
    outOfScopePaths,
    currentFiles,
    indexDiffSha256: initial.indexDiffSha256,
    worktreeDiffSha256: initial.worktreeDiffSha256,
    statusSha256: initial.statusSha256,
    scopeStatus,
  };
  return {
    schemaVersion: 1,
    source: GIT_CANDIDATE_OBSERVER_VERSION,
    repositoryRoot,
    observedAt: new Date().toISOString(),
    ...fingerprintInput,
    fingerprint: stableSnapshotFingerprint(fingerprintInput),
  };
}

/** Detect edits to a serialized observation before using it as candidate evidence. */
export function verifyGitCandidateObservation(
  observation: GitCandidateObservation,
): boolean {
  try {
    const {
      repositoryIdentitySha256,
      expectedBaseSha,
      expectedBranch,
      expectedBranchBound,
      head,
      branch,
      allowedWriteSet,
      stagedPaths,
      unstagedPaths,
      untrackedPaths,
      conflictPaths,
      committedPaths,
      affectedPaths,
      inScopePaths,
      outOfScopePaths,
      currentFiles,
      indexDiffSha256,
      worktreeDiffSha256,
      statusSha256,
      scopeStatus,
    } = observation;
    return (
      observation.schemaVersion === 1 &&
      observation.source === GIT_CANDIDATE_OBSERVER_VERSION &&
      stableSnapshotFingerprint({
        repositoryIdentitySha256,
        expectedBaseSha,
        expectedBranch,
        expectedBranchBound,
        head,
        branch,
        allowedWriteSet,
        stagedPaths,
        unstagedPaths,
        untrackedPaths,
        conflictPaths,
        committedPaths,
        affectedPaths,
        inScopePaths,
        outOfScopePaths,
        currentFiles,
        indexDiffSha256,
        worktreeDiffSha256,
        statusSha256,
        scopeStatus,
      }) === observation.fingerprint
    );
  } catch {
    return false;
  }
}

function writeSetFromTaskPaths(paths: readonly string[]): GitWriteSet {
  const exactPaths: string[] = [];
  const directoryPrefixes: string[] = [];
  for (const entry of paths) {
    if (typeof entry !== "string") {
      throw new GitCandidateObservationError(
        "invalid-write-set",
        "P35 Run write-set entries must be strings.",
      );
    }
    if (entry.endsWith("/") || entry.endsWith("\\")) {
      directoryPrefixes.push(
        normalizeRepositoryPath(
          entry.replace(/[\\/]$/, ""),
          "Run write-set directory",
        ),
      );
    } else {
      exactPaths.push(normalizeRepositoryPath(entry, "Run write-set file"));
    }
  }
  return normalizeWriteSet({ exactPaths, directoryPrefixes });
}

function sameWriteSet(left: GitWriteSet, right: GitWriteSet): boolean {
  const keys = (writeSet: GitWriteSet): string[] =>
    [...new Set([...writeSet.exactPaths, ...writeSet.directoryPrefixes])]
      .map((entry) =>
        process.platform === "win32" ? entry.toLowerCase() : entry,
      )
      .sort();
  return stableObjectFingerprint(keys(left)) === stableObjectFingerprint(keys(right));
}

function sameResolvedPath(left: string, right: string): boolean {
  let leftReal: string;
  let rightReal: string;
  try {
    leftReal = fs.realpathSync(path.resolve(left));
    rightReal = fs.realpathSync(path.resolve(right));
  } catch {
    return false;
  }
  return (
    path.relative(leftReal, rightReal) === "" &&
    path.relative(rightReal, leftReal) === ""
  );
}

/** Adapt the frozen P35 Run write-set/workspace fields to the read-only observer. */
export function observeTaskRunCandidate(
  input: ObserveTaskRunCandidateInput,
): TaskRunCandidateObservation {
  const run = input.run;
  if (run.workspace !== null && run.workspace.ownerRunId !== run.id) {
    throw new GitCandidateObservationError(
      "workspace-root-mismatch",
      "P35 Run workspace owner does not match the selected Run.",
    );
  }
  if (
    run.workspace?.reclamationState === "reclaimed" ||
    run.workspace?.reclamationState === "failed"
  ) {
    throw new GitCandidateObservationError(
      "workspace-root-mismatch",
      `P35 Run workspace is ${run.workspace.reclamationState}; candidate bytes cannot be re-observed.`,
    );
  }
  const runWriteSet = writeSetFromTaskPaths(run.writeSetSnapshot);
  const workspaceWriteSet =
    run.workspace === null
      ? null
      : writeSetFromTaskPaths(run.workspace.writeSet);
  if (
    workspaceWriteSet !== null &&
    !sameWriteSet(runWriteSet, workspaceWriteSet)
  ) {
    throw new GitCandidateObservationError(
      "write-set-mismatch",
      "P35 Run writeSetSnapshot and workspace.writeSet disagree.",
    );
  }

  const workspaceRoot = run.workspace?.canonicalPath;
  if (
    workspaceRoot &&
    input.repositoryRoot &&
    !sameResolvedPath(workspaceRoot, input.repositoryRoot)
  ) {
    throw new GitCandidateObservationError(
      "workspace-root-mismatch",
      "Explicit repository root does not match the P35 Run workspace.",
    );
  }
  const repositoryRoot = workspaceRoot ?? input.repositoryRoot;
  if (!repositoryRoot) {
    throw new GitCandidateObservationError(
      "invalid-root",
      "A repository root is required for a Run without a workspace binding.",
    );
  }
  const candidateFileBaseline = run.candidateFileBaseline ?? null;
  if (candidateFileBaseline !== null) {
    if (
      run.workspace !== null ||
      (run.candidateBaseSha ?? null) !== null ||
      (run.candidateBaseBranch ?? null) !== null
    ) {
      throw new GitCandidateObservationError(
        "candidate-not-eligible",
        "Non-Git file baseline cannot be combined with a Git or managed-worktree baseline.",
      );
    }
    return observeProjectFileCandidate({
      root: repositoryRoot,
      baseline: candidateFileBaseline,
      writeSetSnapshot: run.writeSetSnapshot,
    });
  }
  const expectedBaseSha =
    run.candidateBaseSha ?? run.workspace?.baseSha ?? null;
  if (expectedBaseSha === null) {
    throw new GitCandidateObservationError(
      "candidate-not-eligible",
      "P35 Run has no Core-observed Git base SHA; committed candidate scope cannot be verified.",
    );
  }
  return observeGitCandidate({
    repositoryRoot,
    allowedWriteSet: runWriteSet,
    expectedBaseSha,
    expectedBranch: run.workspace?.branch ?? run.candidateBaseBranch ?? null,
  });
}

/** Check whether a repository-relative delivery path is inside the Run write set. */
export function isTaskRunPathInWriteSet(
  run: TaskRunObservationSource,
  repositoryPath: string,
): boolean {
  const writeSet = writeSetFromTaskPaths(run.writeSetSnapshot);
  if (run.workspace !== null) {
    if (run.workspace.ownerRunId !== run.id) return false;
    const workspaceWriteSet = writeSetFromTaskPaths(run.workspace.writeSet);
    if (!sameWriteSet(writeSet, workspaceWriteSet)) return false;
  }
  const normalizedPath = normalizeRepositoryPath(repositoryPath, "delivery file");
  if (run.candidateFileBaseline && isExcludedProjectPath(normalizedPath)) {
    return false;
  }
  return pathIsAllowed(normalizedPath, writeSet);
}

/** Hash a current regular file while rejecting symlinks, escapes, and concurrent writes. */
export function fingerprintCurrentRepositoryFile(
  repositoryRoot: string,
  repositoryPath: string,
): GitCandidateFileFingerprint {
  const root = realRepositoryRoot(repositoryRoot);
  const filePath = normalizeRepositoryPath(repositoryPath, "delivery file");
  const first = readCurrentFile(root, filePath, { totalBytes: 0 });
  if (first.kind !== "regular-file" || first.sha256 === null) {
    throw new GitCandidateObservationError(
      "current-file-unreadable",
      `Delivery path ${filePath} must be a regular file inside the repository.`,
    );
  }
  const second = readCurrentFile(root, filePath, { totalBytes: 0 });
  if (
    second.kind !== "regular-file" ||
    second.sizeBytes !== first.sizeBytes ||
    second.sha256 !== first.sha256
  ) {
    throw new GitCandidateObservationError(
      "current-file-unreadable",
      `Delivery file ${filePath} changed during observation.`,
    );
  }
  return first;
}

function requireCommitSha(value: string, field: string): string {
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/i.test(value)) {
    throw new GitCandidateObservationError(
      "git-command-failed",
      `${field} must be a full Git commit identifier.`,
    );
  }
  return value.toLowerCase();
}

/** Resolve a local branch name to its current commit without updating refs. */
export function resolveGitLocalBranchSha(
  repositoryRoot: string,
  branch: string,
): string {
  if (
    typeof branch !== "string" ||
    branch.length === 0 ||
    branch !== branch.trim() ||
    branch.startsWith("-") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("\\")
  ) {
    throw new GitCandidateObservationError(
      "git-command-failed",
      "Target must be a local branch name.",
    );
  }
  const root = realRepositoryRoot(repositoryRoot);
  const ref = `refs/heads/${branch}`;
  runGit(root, ["check-ref-format", ref]);
  return requireCommitSha(
    decodeGitText(
      runGit(root, ["rev-parse", "--verify", `${ref}^{commit}`]),
      "target branch SHA",
    ),
    "Target branch SHA",
  );
}

/** Read a configured remote URL without printing it or updating repository state. */
export function readGitRemoteUrl(
  repositoryRoot: string,
  remoteName = "origin",
): string {
  if (!/^[A-Za-z0-9._-]+$/.test(remoteName) || remoteName.startsWith("-")) {
    throw new GitCandidateObservationError(
      "git-command-failed",
      "Git remote name is invalid.",
    );
  }
  const root = realRepositoryRoot(repositoryRoot);
  return decodeGitText(
    runGit(root, ["remote", "get-url", remoteName]),
    "remote URL",
  );
}

/** Read only the commit graph; no fetch, checkout, or ref update is performed. */
export function isGitCommitAncestor(
  repositoryRoot: string,
  ancestorSha: string,
  descendantSha: string,
): boolean {
  const ancestor = requireCommitSha(ancestorSha, "Ancestor SHA");
  const descendant = requireCommitSha(descendantSha, "Descendant SHA");
  const root = realRepositoryRoot(repositoryRoot);
  const result = runGitResult(
    root,
    ["merge-base", "--is-ancestor", ancestor, descendant],
    [0, 1],
  );
  return result.status === 0;
}

/** Hash a regular file from a commit tree without writing or emitting its bytes. */
export function fingerprintGitTreeFile(
  repositoryRoot: string,
  commitSha: string,
  repositoryPath: string,
): GitTreeFileFingerprint | null {
  const root = realRepositoryRoot(repositoryRoot);
  const commit = requireCommitSha(commitSha, "File tree commit SHA");
  const filePath = normalizeRepositoryPath(repositoryPath, "delivery file");
  const treeOutput = runGit(root, [
    "ls-tree",
    "-z",
    commit,
    "--",
    `:(literal)${filePath}`,
  ]);
  const entries = treeOutput.toString("utf8").split("\0").filter(Boolean);
  const matching = entries.filter((entry) => {
    const tab = entry.indexOf("\t");
    return tab >= 0 && entry.slice(tab + 1) === filePath;
  });
  if (matching.length === 0) return null;
  if (matching.length !== 1) {
    throw new GitCandidateObservationError(
      "git-command-failed",
      `Git returned an ambiguous tree entry for ${filePath}.`,
    );
  }
  const [metadata, entryPath] = matching[0]?.split("\t", 2) ?? [];
  const [mode, type, objectSha] = (metadata ?? "").split(" ");
  if (
    entryPath !== filePath ||
    type !== "blob" ||
    !/^[a-f0-9]{40}([a-f0-9]{24})?$/i.test(objectSha ?? "")
  ) {
    throw new GitCandidateObservationError(
      "current-file-unreadable",
      `Delivery path ${filePath} is not a regular Git file.`,
    );
  }
  if (mode !== "100644" && mode !== "100755") {
    throw new GitCandidateObservationError(
      "current-file-unreadable",
      `Delivery path ${filePath} has unsupported Git mode ${mode ?? "unknown"}.`,
    );
  }
  const bytes = runGit(root, ["cat-file", "blob", objectSha]);
  if (bytes.length > MAX_CURRENT_FILE_BYTES) {
    throw new GitCandidateObservationError(
      "observation-limit-exceeded",
      `Delivery file ${filePath} exceeded the ${MAX_CURRENT_FILE_BYTES}-byte limit.`,
    );
  }
  return {
    commitSha: commit,
    path: filePath,
    mode,
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
  };
}

/** Add this entry to P35 `candidateEntries` before `run-result` freezes the Run candidate. */
export function createTaskCandidateEntry(
  observation: TaskRunCandidateObservation,
): TaskSnapshotEntry {
  const isGit = observation.source === GIT_CANDIDATE_OBSERVER_VERSION;
  const intact = isGit
    ? verifyGitCandidateObservation(observation)
    : verifyProjectFileCandidateObservation(observation);
  if (!intact) {
    throw new GitCandidateObservationError(
      "candidate-not-eligible",
      "Candidate observation fingerprint does not match its contents.",
    );
  }
  if (observation.scopeStatus !== "within-write-set") {
    throw new GitCandidateObservationError(
      "candidate-not-eligible",
      `Candidate observation is ${observation.scopeStatus}; it cannot be attached to a P35 candidate snapshot.`,
    );
  }
  return {
    ref: taskCandidateObservationEntryRef(observation),
    fingerprint: observation.fingerprint,
  };
}

export function taskCandidateObservationEntryRef(
  observation: TaskRunCandidateObservation,
): (typeof RUN_CANDIDATE_ENTRY_REFS)[number] {
  return observation.source === GIT_CANDIDATE_OBSERVER_VERSION
    ? VERIFICATION_CANDIDATE_ENTRY_REF
    : PROJECT_FILE_CANDIDATE_ENTRY_REF;
}

export function isRunCandidateObservationEntry(ref: string): boolean {
  return (RUN_CANDIDATE_ENTRY_REFS as readonly string[]).includes(ref);
}
