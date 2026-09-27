import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  ProjectFileBaselineEntryV1,
  ProjectFileBaselineV1,
} from "./task-kernel-types.js";
import type {
  GitCandidateFileFingerprint,
  GitCandidateScopeStatus,
  GitWriteSet,
} from "./task-candidate-observer.js";

export const PROJECT_FILE_BASELINE_SOURCE =
  "pactile-project-file-baseline-v1" as const;
export const PROJECT_FILE_SNAPSHOT_POLICY = "project-files-bounded-v1" as const;
export const PROJECT_FILE_CANDIDATE_OBSERVER_VERSION =
  "project-files-v1" as const;
export const PROJECT_FILE_CANDIDATE_ENTRY_REF =
  "pactile:verification:project-files-v1";

export const PROJECT_FILE_SNAPSHOT_MAX_FILES = 4_096;
export const PROJECT_FILE_SNAPSHOT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const PROJECT_FILE_SNAPSHOT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const PROJECT_FILE_SNAPSHOT_MAX_DIRECTORY_ENTRIES = 4_096;
export const PROJECT_FILE_SNAPSHOT_MAX_DIRECTORIES = 4_096;
export const PROJECT_FILE_SNAPSHOT_MAX_ENTRIES = 8_192;
const MAX_AFFECTED_PATHS = 1_000;
const MAX_PATH_LENGTH = 4_096;

export const PROJECT_FILE_SNAPSHOT_EXCLUDED_DIRECTORIES = [
  ".git",
  ".pactile",
  ".tmp",
  ".tools",
  ".codegraph",
  ".cache",
  ".pnpm-store",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  ".venv",
  ".next",
  ".nuxt",
  ".turbo",
  ".svelte-kit",
  ".ssh",
  ".aws",
  ".azure",
  ".kube",
  ".gnupg",
  "node_modules",
  "vendor",
  "venv",
  "dist",
  "build",
  "out",
  "coverage",
  "__pycache__",
  "target",
] as const;

export const PROJECT_FILE_SNAPSHOT_EXCLUDED_FILE_RULES = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_ed25519*",
] as const;

const EXCLUDED_DIRECTORY_NAMES = new Set(
  PROJECT_FILE_SNAPSHOT_EXCLUDED_DIRECTORIES.map((name) => name.toLowerCase()),
);
const SECRET_FILE_SUFFIXES = [".pem", ".key", ".p12", ".pfx"] as const;

function compareProjectPaths(left: string, right: string): number {
  const normalize = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const a = normalize(left);
  const b = normalize(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export class ProjectFileObservationError extends Error {
  public readonly code:
    | "invalid-root"
    | "invalid-write-set"
    | "observation-limit-exceeded"
    | "unsafe-path"
    | "candidate-mismatch";

  public constructor(
    code: ProjectFileObservationError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ProjectFileObservationError";
    this.code = code;
  }
}

export interface ProjectFileCandidateObservation {
  readonly schemaVersion: 1;
  readonly source: typeof PROJECT_FILE_CANDIDATE_OBSERVER_VERSION;
  readonly repositoryRoot: string;
  readonly rootIdentitySha256: string;
  readonly baselineFingerprint: string;
  readonly observedAt: string;
  readonly allowedWriteSet: GitWriteSet;
  readonly affectedPaths: readonly string[];
  readonly inScopePaths: readonly string[];
  readonly outOfScopePaths: readonly string[];
  readonly currentFiles: readonly GitCandidateFileFingerprint[];
  readonly scopeStatus: GitCandidateScopeStatus;
  readonly fingerprint: string;
}

interface ProjectFileScan {
  readonly root: string;
  readonly rootIdentitySha256: string;
  readonly files: readonly ProjectFileBaselineEntryV1[];
  readonly directoryStates: readonly string[];
  readonly excludedPaths: readonly string[];
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableFingerprint(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  return normalize(path.resolve(left)) === normalize(path.resolve(right));
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function statFingerprint(stat: fs.Stats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
  ].join(":");
}

function readDirectoryNames(
  absoluteDirectory: string,
  relativeDirectory: string,
): string[] {
  let directory: fs.Dir;
  try {
    directory = fs.opendirSync(absoluteDirectory);
  } catch {
    throw new ProjectFileObservationError(
      "candidate-mismatch",
      `Project directory ${relativeDirectory || "."} cannot be scanned.`,
    );
  }

  const names: string[] = [];
  let failure: unknown;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > PROJECT_FILE_SNAPSHOT_MAX_DIRECTORY_ENTRIES) {
        throw new ProjectFileObservationError(
          "observation-limit-exceeded",
          `Project directory ${relativeDirectory || "."} exceeds the ${PROJECT_FILE_SNAPSHOT_MAX_DIRECTORY_ENTRIES}-entry limit.`,
        );
      }
    }
  } catch (error) {
    failure = error;
  }
  try {
    directory.closeSync();
  } catch (error) {
    failure ??= error;
  }
  if (failure instanceof ProjectFileObservationError) throw failure;
  if (failure !== undefined) {
    throw new ProjectFileObservationError(
      "candidate-mismatch",
      `Project directory ${relativeDirectory || "."} cannot be scanned.`,
    );
  }
  return names.sort();
}

function sameStat(left: fs.Stats, right: fs.Stats): boolean {
  return statFingerprint(left) === statFingerprint(right);
}

function safeRelativePath(value: string, label: string): string {
  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.length > MAX_PATH_LENGTH ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        [...segment].some((character) => {
          const code = character.charCodeAt(0);
          return code <= 0x1f || code === 0x7f;
        }),
    )
  ) {
    throw new ProjectFileObservationError(
      "invalid-write-set",
      `${label} must be a safe project-relative path.`,
    );
  }
  return segments.join("/");
}

function excludedFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === ".env" ||
    lower.startsWith(".env.") ||
    SECRET_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix)) ||
    lower.startsWith("id_rsa") ||
    lower.startsWith("id_ed25519")
  );
}

export function isExcludedProjectPath(repositoryPath: string): boolean {
  let normalized: string;
  try {
    normalized = safeRelativePath(repositoryPath, "project path");
  } catch {
    return true;
  }
  const segments = normalized.split("/");
  return (
    segments.some((segment) =>
      EXCLUDED_DIRECTORY_NAMES.has(segment.toLowerCase()),
    ) || excludedFileName(segments.at(-1) ?? "")
  );
}

function normalizeWriteSet(paths: readonly string[]): GitWriteSet {
  const exactPaths: string[] = [];
  const directoryPrefixes: string[] = [];
  if (paths.length > MAX_AFFECTED_PATHS) {
    throw new ProjectFileObservationError(
      "observation-limit-exceeded",
      `Run write set exceeds the ${MAX_AFFECTED_PATHS}-path limit.`,
    );
  }
  for (const entry of paths) {
    if (typeof entry !== "string") {
      throw new ProjectFileObservationError(
        "invalid-write-set",
        "Run write-set entries must be strings.",
      );
    }
    const isDirectory = /[\\/]$/.test(entry);
    const repositoryPath = safeRelativePath(
      isDirectory ? entry.slice(0, -1) : entry,
      "Run write-set path",
    );
    if (isExcludedProjectPath(repositoryPath)) {
      throw new ProjectFileObservationError(
        "invalid-write-set",
        `Run write set includes excluded project path ${repositoryPath}.`,
      );
    }
    (isDirectory ? directoryPrefixes : exactPaths).push(repositoryPath);
  }
  if (
    new Set([...exactPaths, ...directoryPrefixes].map((value) =>
      process.platform === "win32" ? value.toLowerCase() : value,
    )).size !== exactPaths.length + directoryPrefixes.length
  ) {
    throw new ProjectFileObservationError(
      "invalid-write-set",
      "Run write-set paths must be unique after platform path normalization.",
    );
  }
  const normalize = (values: string[]): string[] =>
    [...values].sort(compareProjectPaths);
  return {
    exactPaths: normalize(exactPaths),
    directoryPrefixes: normalize(directoryPrefixes),
  };
}

function pathIsAllowed(repositoryPath: string, writeSet: GitWriteSet): boolean {
  const normalize = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const candidate = normalize(repositoryPath);
  return (
    writeSet.exactPaths.some((entry) => normalize(entry) === candidate) ||
    writeSet.directoryPrefixes.some((entry) => {
      const prefix = normalize(entry);
      return candidate === prefix || candidate.startsWith(`${prefix}/`);
    })
  );
}

function writeSetTouchesExcludedPath(
  repositoryPath: string,
  writeSet: GitWriteSet,
): boolean {
  const normalize = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const excluded = normalize(repositoryPath);
  return (
    pathIsAllowed(repositoryPath, writeSet) ||
    writeSet.exactPaths.some((entry) =>
      normalize(entry).startsWith(`${excluded}/`),
    ) ||
    writeSet.directoryPrefixes.some((entry) => {
      const prefix = normalize(entry);
      return (
        prefix === excluded ||
        prefix.startsWith(`${excluded}/`) ||
        excluded.startsWith(`${prefix}/`)
      );
    })
  );
}

function assertNoExcludedWriteSetOverlap(
  excludedPaths: readonly string[],
  writeSet: GitWriteSet,
): void {
  const overlap = excludedPaths.find((repositoryPath) =>
    writeSetTouchesExcludedPath(repositoryPath, writeSet),
  );
  if (overlap) {
    throw new ProjectFileObservationError(
      "invalid-write-set",
      `Run write set overlaps excluded project path ${overlap}.`,
    );
  }
}

function ensureNoGitMetadata(root: string): void {
  if (!hasGitMetadataAtProjectRoot(root)) return;
  throw new ProjectFileObservationError(
    "candidate-mismatch",
    "Project gained Git metadata after its non-Git Run baseline was captured.",
  );
}

export function hasGitMetadataAtProjectRoot(rootPath: string): boolean {
  const gitPath = path.join(rootPath, ".git");
  try {
    fs.lstatSync(gitPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ProjectFileObservationError(
      "invalid-root",
      "Cannot determine whether the project root contains Git metadata.",
    );
  }
}

function resolveProjectRoot(rootPath: string): {
  root: string;
  identity: string;
} {
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(rootPath);
  } catch {
    throw new ProjectFileObservationError(
      "invalid-root",
      "Project root cannot be inspected.",
    );
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ProjectFileObservationError(
      "invalid-root",
      "Non-Git project root must be a real directory, not a symlink.",
    );
  }
  let root: string;
  try {
    root = fs.realpathSync(rootPath);
  } catch {
    throw new ProjectFileObservationError(
      "invalid-root",
      "Project root cannot be resolved.",
    );
  }
  if (!samePath(rootPath, root)) {
    throw new ProjectFileObservationError(
      "invalid-root",
      "Project root must not resolve through a symlink.",
    );
  }
  ensureNoGitMetadata(root);
  return {
    root,
    identity: sha256(process.platform === "win32" ? root.toLowerCase() : root),
  };
}

function assertNoSymlinkSegments(root: string, repositoryPath: string): void {
  let current = root;
  const segments = repositoryPath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      throw new ProjectFileObservationError(
        "candidate-mismatch",
        `Project path ${repositoryPath} changed or disappeared during observation.`,
      );
    }
    if (stat.isSymbolicLink()) {
      throw new ProjectFileObservationError(
        "unsafe-path",
        `Project path ${repositoryPath} crosses a symbolic link.`,
      );
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new ProjectFileObservationError(
        "unsafe-path",
        `Project path ${repositoryPath} crosses a non-directory.`,
      );
    }
  }
  let realPath: string;
  try {
    realPath = fs.realpathSync(current);
  } catch {
    throw new ProjectFileObservationError(
      "candidate-mismatch",
      `Project path ${repositoryPath} changed during observation.`,
    );
  }
  if (!isWithinRoot(root, realPath)) {
    throw new ProjectFileObservationError(
      "unsafe-path",
      `Project path ${repositoryPath} escapes the project root.`,
    );
  }
}

function readRegularFile(
  root: string,
  repositoryPath: string,
  expectedStat: fs.Stats,
  totalBytes: { value: number },
): ProjectFileBaselineEntryV1 {
  const absolutePath = path.join(root, ...repositoryPath.split("/"));
  assertNoSymlinkSegments(root, repositoryPath);
  const before = fs.lstatSync(absolutePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new ProjectFileObservationError(
      "unsafe-path",
      `Project path ${repositoryPath} is not a regular file.`,
    );
  }
  if (!sameStat(expectedStat, before)) {
    throw new ProjectFileObservationError(
      "candidate-mismatch",
      `Project file ${repositoryPath} changed during traversal.`,
    );
  }
  if (before.size > PROJECT_FILE_SNAPSHOT_MAX_FILE_BYTES) {
    throw new ProjectFileObservationError(
      "observation-limit-exceeded",
      `Project file ${repositoryPath} exceeds the ${PROJECT_FILE_SNAPSHOT_MAX_FILE_BYTES}-byte limit.`,
    );
  }
  if (totalBytes.value + before.size > PROJECT_FILE_SNAPSHOT_MAX_TOTAL_BYTES) {
    throw new ProjectFileObservationError(
      "observation-limit-exceeded",
      `Project snapshot exceeds the ${PROJECT_FILE_SNAPSHOT_MAX_TOTAL_BYTES}-byte total limit.`,
    );
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(absolutePath, flags);
  } catch {
    throw new ProjectFileObservationError(
      "candidate-mismatch",
      `Project file ${repositoryPath} cannot be opened safely.`,
    );
  }
  let bytes: Buffer;
  try {
    const descriptorBefore = fs.fstatSync(fd);
    if (
      !descriptorBefore.isFile() ||
      descriptorBefore.isSymbolicLink() ||
      !sameStat(before, descriptorBefore)
    ) {
      throw new ProjectFileObservationError(
        "candidate-mismatch",
        `Project file ${repositoryPath} changed before it could be read.`,
      );
    }
    const first = fs.readFileSync(fd);
    const descriptorAfterFirst = fs.fstatSync(fd);
    const second = fs.readFileSync(absolutePath);
    const descriptorAfterSecond = fs.fstatSync(fd);
    if (
      !sameStat(descriptorBefore, descriptorAfterFirst) ||
      !sameStat(descriptorBefore, descriptorAfterSecond) ||
      !first.equals(second)
    ) {
      throw new ProjectFileObservationError(
        "candidate-mismatch",
        `Project file ${repositoryPath} changed while it was read.`,
      );
    }
    bytes = first;
  } finally {
    fs.closeSync(fd);
  }
  assertNoSymlinkSegments(root, repositoryPath);
  const after = fs.lstatSync(absolutePath);
  if (!sameStat(before, after) || bytes.byteLength !== after.size) {
    throw new ProjectFileObservationError(
      "candidate-mismatch",
      `Project file ${repositoryPath} changed after it was read.`,
    );
  }
  totalBytes.value += bytes.byteLength;
  return {
    path: repositoryPath,
    sizeBytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function scanProjectOnce(rootInput: string): ProjectFileScan {
  const { root, identity } = resolveProjectRoot(rootInput);
  const files: ProjectFileBaselineEntryV1[] = [];
  const directoryStates: string[] = [];
  const excludedPaths: string[] = [];
  const seenPaths = new Set<string>();
  const totalBytes = { value: 0 };
  let totalEntries = 0;
  let scannedDirectories = 0;

  const visit = (absoluteDirectory: string, relativeDirectory: string): void => {
    if (relativeDirectory) {
      scannedDirectories += 1;
      if (scannedDirectories > PROJECT_FILE_SNAPSHOT_MAX_DIRECTORIES) {
        throw new ProjectFileObservationError(
          "observation-limit-exceeded",
          `Project snapshot exceeds the ${PROJECT_FILE_SNAPSHOT_MAX_DIRECTORIES}-directory limit.`,
        );
      }
    }
    const before = fs.lstatSync(absoluteDirectory);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new ProjectFileObservationError(
        "unsafe-path",
        `Project directory ${relativeDirectory || "."} is not a real directory.`,
      );
    }
    const realDirectory = fs.realpathSync(absoluteDirectory);
    if (!isWithinRoot(root, realDirectory)) {
      throw new ProjectFileObservationError(
        "unsafe-path",
        `Project directory ${relativeDirectory || "."} escapes the project root.`,
      );
    }
    const names = readDirectoryNames(absoluteDirectory, relativeDirectory);
    const stateIndex = directoryStates.length;
    directoryStates.push(
      `${relativeDirectory}\0${statFingerprint(before)}\0${names.join("\0")}`,
    );
    for (const name of names) {
      totalEntries += 1;
      if (totalEntries > PROJECT_FILE_SNAPSHOT_MAX_ENTRIES) {
        throw new ProjectFileObservationError(
          "observation-limit-exceeded",
          `Project snapshot exceeds the ${PROJECT_FILE_SNAPSHOT_MAX_ENTRIES}-entry limit.`,
        );
      }
      if (
        name.length === 0 ||
        name === "." ||
        name === ".." ||
        name.includes("/") ||
        name.includes("\\") ||
        [...name].some((character) => {
          const code = character.charCodeAt(0);
          return code <= 0x1f || code === 0x7f;
        })
      ) {
        throw new ProjectFileObservationError(
          "unsafe-path",
          "Project contains a path name that cannot be represented safely.",
        );
      }
      const repositoryPath = safeRelativePath(
        relativeDirectory ? `${relativeDirectory}/${name}` : name,
        "scanned project path",
      );
      const pathKey =
        process.platform === "win32"
          ? repositoryPath.toLowerCase()
          : repositoryPath;
      if (seenPaths.has(pathKey)) {
        throw new ProjectFileObservationError(
          "unsafe-path",
          `Project path ${repositoryPath} collides after platform path normalization.`,
        );
      }
      seenPaths.add(pathKey);
      const absolutePath = path.join(absoluteDirectory, name);
      let entryStat: fs.Stats;
      try {
        entryStat = fs.lstatSync(absolutePath);
      } catch {
        throw new ProjectFileObservationError(
          "candidate-mismatch",
          `Project path ${repositoryPath} changed during scanning.`,
        );
      }
      if (entryStat.isSymbolicLink()) {
        throw new ProjectFileObservationError(
          "unsafe-path",
          `Project path ${repositoryPath} is a symbolic link.`,
        );
      }
      if (entryStat.isDirectory()) {
        if (EXCLUDED_DIRECTORY_NAMES.has(name.toLowerCase())) {
          excludedPaths.push(repositoryPath);
          continue;
        }
        visit(absolutePath, repositoryPath);
        continue;
      }
      if (!entryStat.isFile()) {
        throw new ProjectFileObservationError(
          "unsafe-path",
          `Project path ${repositoryPath} is not a regular file or directory.`,
        );
      }
      if (excludedFileName(name)) {
        excludedPaths.push(repositoryPath);
        continue;
      }
      if (files.length >= PROJECT_FILE_SNAPSHOT_MAX_FILES) {
        throw new ProjectFileObservationError(
          "observation-limit-exceeded",
          `Project snapshot exceeds the ${PROJECT_FILE_SNAPSHOT_MAX_FILES}-file limit.`,
        );
      }
      files.push(readRegularFile(root, repositoryPath, entryStat, totalBytes));
    }
    const after = fs.lstatSync(absoluteDirectory);
    const namesAfter = readDirectoryNames(
      absoluteDirectory,
      relativeDirectory,
    );
    if (!sameStat(before, after) || names.join("\0") !== namesAfter.join("\0")) {
      throw new ProjectFileObservationError(
        "candidate-mismatch",
        `Project directory ${relativeDirectory || "."} changed during scanning.`,
      );
    }
    directoryStates[stateIndex] =
      `${relativeDirectory}\0${statFingerprint(after)}\0${namesAfter.join("\0")}`;
  };

  visit(root, "");
  files.sort((a, b) => compareProjectPaths(a.path, b.path));
  excludedPaths.sort(compareProjectPaths);
  return { root, rootIdentitySha256: identity, files, directoryStates, excludedPaths };
}

function stableProjectScan(root: string): ProjectFileScan {
  const first = scanProjectOnce(root);
  const second = scanProjectOnce(root);
  const content = (scan: ProjectFileScan): unknown => ({
    rootIdentitySha256: scan.rootIdentitySha256,
    files: scan.files,
    directoryStates: scan.directoryStates,
    excludedPaths: scan.excludedPaths,
  });
  if (stableFingerprint(content(first)) !== stableFingerprint(content(second))) {
    throw new ProjectFileObservationError(
      "candidate-mismatch",
      "Project files changed between bounded snapshot passes; retry after the tree is stable.",
    );
  }
  return second;
}

function baselineBody(input: {
  readonly rootIdentitySha256: string;
  readonly files: readonly ProjectFileBaselineEntryV1[];
}): Omit<ProjectFileBaselineV1, "fingerprint"> {
  return {
    schemaVersion: 1,
    source: PROJECT_FILE_BASELINE_SOURCE,
    policy: PROJECT_FILE_SNAPSHOT_POLICY,
    rootIdentitySha256: input.rootIdentitySha256,
    files: input.files.map((file) => ({ ...file })),
  };
}

export function verifyProjectFileBaseline(
  baseline: ProjectFileBaselineV1,
): boolean {
  try {
    if (
      baseline.schemaVersion !== 1 ||
      baseline.source !== PROJECT_FILE_BASELINE_SOURCE ||
      baseline.policy !== PROJECT_FILE_SNAPSHOT_POLICY ||
      !/^[a-f0-9]{64}$/.test(baseline.rootIdentitySha256) ||
      !Array.isArray(baseline.files) ||
      baseline.files.length > PROJECT_FILE_SNAPSHOT_MAX_FILES
    ) {
      return false;
    }
    const seen = new Set<string>();
    let totalBytes = 0;
    let previous = "";
    for (const entry of baseline.files) {
      const repositoryPath = safeRelativePath(entry.path, "baseline path");
      const key = process.platform === "win32"
        ? repositoryPath.toLowerCase()
        : repositoryPath;
      if (
        isExcludedProjectPath(repositoryPath) ||
        seen.has(key) ||
        (previous && compareProjectPaths(previous, repositoryPath) > 0) ||
        !Number.isSafeInteger(entry.sizeBytes) ||
        entry.sizeBytes < 0 ||
        entry.sizeBytes > PROJECT_FILE_SNAPSHOT_MAX_FILE_BYTES ||
        !/^[a-f0-9]{64}$/.test(entry.sha256)
      ) {
        return false;
      }
      seen.add(key);
      previous = repositoryPath;
      totalBytes += entry.sizeBytes;
      if (totalBytes > PROJECT_FILE_SNAPSHOT_MAX_TOTAL_BYTES) return false;
    }
    return stableFingerprint(baselineBody(baseline)) === baseline.fingerprint;
  } catch {
    return false;
  }
}

/** Record a bounded, secret-safe regular-file baseline for a non-Git Run. */
export function captureProjectFileBaseline(
  root: string,
  writeSetSnapshot: readonly string[],
): ProjectFileBaselineV1 {
  const writeSet = normalizeWriteSet(writeSetSnapshot);
  const scan = stableProjectScan(root);
  assertNoExcludedWriteSetOverlap(scan.excludedPaths, writeSet);
  const body = baselineBody(scan);
  return { ...body, fingerprint: stableFingerprint(body) };
}

/** Re-scan a non-Git project and compare every included file with the Run baseline. */
export function observeProjectFileCandidate(input: {
  readonly root: string;
  readonly baseline: ProjectFileBaselineV1;
  readonly writeSetSnapshot: readonly string[];
}): ProjectFileCandidateObservation {
  const { root, baseline, writeSetSnapshot } = input;
  if (!verifyProjectFileBaseline(baseline)) {
    throw new ProjectFileObservationError(
      "candidate-mismatch",
      "Non-Git Run baseline is missing or has an invalid fingerprint.",
    );
  }
  const writeSet = normalizeWriteSet(writeSetSnapshot);
  const scan = stableProjectScan(root);
  if (scan.rootIdentitySha256 !== baseline.rootIdentitySha256) {
    throw new ProjectFileObservationError(
      "candidate-mismatch",
      "Project root identity changed after the Run baseline was captured.",
    );
  }
  assertNoExcludedWriteSetOverlap(scan.excludedPaths, writeSet);

  const baselineFiles = new Map(
    baseline.files.map((file) => [file.path, file] as const),
  );
  const currentFilesByPath = new Map(
    scan.files.map((file) => [file.path, file] as const),
  );
  const allPaths = [...new Set([...baselineFiles.keys(), ...currentFilesByPath.keys()])].sort(compareProjectPaths);
  const affectedPaths = allPaths.filter((repositoryPath) => {
    const before = baselineFiles.get(repositoryPath);
    const after = currentFilesByPath.get(repositoryPath);
    return (
      before?.sizeBytes !== after?.sizeBytes ||
      before?.sha256 !== after?.sha256
    );
  });
  if (affectedPaths.length > MAX_AFFECTED_PATHS) {
    throw new ProjectFileObservationError(
      "observation-limit-exceeded",
      `Affected path count exceeded the ${MAX_AFFECTED_PATHS}-path limit.`,
    );
  }
  const inScopePaths = affectedPaths.filter((repositoryPath) =>
    pathIsAllowed(repositoryPath, writeSet),
  );
  const outOfScopePaths = affectedPaths.filter(
    (repositoryPath) => !pathIsAllowed(repositoryPath, writeSet),
  );
  const observationPaths = [
    ...new Set([...inScopePaths, ...writeSet.exactPaths]),
  ].sort(compareProjectPaths);
  const candidateFiles: GitCandidateFileFingerprint[] = observationPaths.map(
    (repositoryPath) => {
      const current = currentFilesByPath.get(repositoryPath);
      return current
        ? {
            path: repositoryPath,
            kind: "regular-file",
            sizeBytes: current.sizeBytes,
            sha256: current.sha256,
          }
        : {
            path: repositoryPath,
            kind: "missing",
            sizeBytes: 0,
            sha256: null,
          };
    },
  );
  const scopeStatus: GitCandidateScopeStatus = outOfScopePaths.length
    ? "out-of-scope"
    : "within-write-set";
  const fingerprintInput = {
    rootIdentitySha256: scan.rootIdentitySha256,
    baselineFingerprint: baseline.fingerprint,
    allowedWriteSet: writeSet,
    affectedPaths,
    inScopePaths,
    outOfScopePaths,
    currentFiles: candidateFiles,
    scopeStatus,
  };
  return {
    schemaVersion: 1,
    source: PROJECT_FILE_CANDIDATE_OBSERVER_VERSION,
    repositoryRoot: scan.root,
    observedAt: new Date().toISOString(),
    ...fingerprintInput,
    fingerprint: stableFingerprint(fingerprintInput),
  };
}

export function verifyProjectFileCandidateObservation(
  observation: ProjectFileCandidateObservation,
): boolean {
  try {
    const {
      rootIdentitySha256,
      baselineFingerprint,
      allowedWriteSet,
      affectedPaths,
      inScopePaths,
      outOfScopePaths,
      currentFiles,
      scopeStatus,
    } = observation;
    return (
      observation.schemaVersion === 1 &&
      observation.source === PROJECT_FILE_CANDIDATE_OBSERVER_VERSION &&
      /^[a-f0-9]{64}$/.test(rootIdentitySha256) &&
      /^[a-f0-9]{64}$/.test(baselineFingerprint) &&
      stableFingerprint({
        rootIdentitySha256,
        baselineFingerprint,
        allowedWriteSet,
        affectedPaths,
        inScopePaths,
        outOfScopePaths,
        currentFiles,
        scopeStatus,
      }) === observation.fingerprint
    );
  } catch {
    return false;
  }
}
