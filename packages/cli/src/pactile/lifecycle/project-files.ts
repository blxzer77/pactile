import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalizePactileJsonV1 } from "../../core/index.js";
import type { PactilePlatform } from "../registry.js";
import { assertCanonicalWriteTarget } from "../runtime/paths.js";
import type {
  LifecycleGenerationFile,
  LifecycleMaterializationContext,
} from "./orchestrator.js";

const CANONICAL_PREFIX = ".pactile/";
const EXCLUDED_PREFIXES = [
  ".pactile/runtime/",
  ".pactile/tasks/",
  ".pactile/workspace/",
  ".pactile/spec/",
  ".pactile/middleware/",
  // Pre-Node installations can retain locally edited Python scripts. They are
  // compatibility residue, not files in a new active generation.
  ".pactile/scripts/",
  ".pactile/.backup-",
] as const;
const EXCLUDED_FILES = new Set([
  ".pactile/.developer",
  ".pactile/.current-task",
  ".pactile/.p36-wave-c.json",
]);

function isGeneratedCachePath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return (
    segments.includes("__pycache__") ||
    relativePath.endsWith(".pyc") ||
    relativePath.endsWith(".pyo")
  );
}

function excludedCanonicalPath(relativePath: string): boolean {
  return (
    EXCLUDED_FILES.has(relativePath) ||
    EXCLUDED_PREFIXES.some((prefix) => relativePath.startsWith(prefix)) ||
    isGeneratedCachePath(relativePath)
  );
}

function safeManagedPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return (
    normalized.startsWith(CANONICAL_PREFIX) &&
    !excludedCanonicalPath(normalized)
  );
}

/** True only for framework-managed files that belong in a sealed generation. */
export function isCanonicalGenerationPath(relativePath: string): boolean {
  return safeManagedPath(relativePath.replace(/\\/g, "/"));
}

/**
 * Enumerate the live canonical files that are eligible for an immutable
 * generation. Runtime state, tasks, workspaces, middleware and device-local
 * identity are intentionally outside the generation payload.
 */
export function discoverCanonicalGenerationPaths(
  projectRoot: string,
): readonly string[] {
  const canonicalRoot = path.join(projectRoot, ".pactile");
  if (!fs.existsSync(canonicalRoot)) return [];
  const paths: string[] = [];
  const visit = (directory: string): void => {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
      throw new Error("canonical-generation-source-unsafe");
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const relativePath = path
        .relative(projectRoot, target)
        .split(path.sep)
        .join("/");
      if (
        EXCLUDED_PREFIXES.some(
          (prefix) =>
            relativePath === prefix.slice(0, -1) ||
            relativePath.startsWith(prefix),
        ) ||
        EXCLUDED_FILES.has(relativePath) ||
        isGeneratedCachePath(relativePath)
      )
        continue;
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink())
        throw new Error("canonical-generation-source-unsafe");
      if (stat.isDirectory()) {
        visit(target);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error("canonical-generation-source-unsafe");
      if (safeManagedPath(relativePath)) paths.push(relativePath);
    }
  };
  visit(canonicalRoot);
  return paths.sort();
}

/**
 * Capture only caller-declared canonical managed files. User task/workspace,
 * middleware, identity, and Runtime state are deliberately excluded.
 */
export function collectCanonicalGenerationFiles(
  projectRoot: string,
  managedPaths: Iterable<string>,
  platforms: readonly PactilePlatform[],
  runtimeVersion: string,
): readonly LifecycleGenerationFile[] {
  const files = new Map<string, Uint8Array>();
  for (const candidate of managedPaths) {
    const relativePath = candidate.replace(/\\/g, "/");
    if (!safeManagedPath(relativePath)) continue;
    const target = path.resolve(projectRoot, ...relativePath.split("/"));
    const relative = path.relative(path.resolve(projectRoot), target);
    if (
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    )
      throw new Error("canonical-generation-path-escape");
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error("canonical-generation-source-unsafe");
    files.set(
      relativePath.slice(CANONICAL_PREFIX.length),
      fs.readFileSync(target),
    );
  }
  files.set(
    "runtime/composition.json",
    Buffer.from(
      canonicalizePactileJsonV1({
        schemaVersion: 1,
        product: "pactile",
        runtimeVersion,
        platforms: [...new Set(platforms)].sort(),
      }),
    ),
  );
  return [...files]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([filePath, bytes]) => ({ path: filePath, bytes }));
}

/** Copy the existing managed canonical view into an isolated build root. */
export function seedCanonicalBuildRoot(
  projectRoot: string,
  buildRoot: string,
): readonly string[] {
  const copied: string[] = [];
  for (const relativePath of discoverCanonicalGenerationPaths(projectRoot)) {
    const source = path.join(projectRoot, ...relativePath.split("/"));
    const target = path.join(buildRoot, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    copied.push(relativePath);
  }
  return copied;
}

/**
 * Materialize a sealed generation into the live canonical view. Every file is
 * replaced atomically in its own directory; runtime/user-owned namespaces are
 * absent from the generation by construction.
 */
export function materializeCanonicalGeneration(
  projectRoot: string,
  context: LifecycleMaterializationContext,
): void {
  const bytesByPath = context.readFiles
    ? context.readFiles(context.files.map((file) => file.path))
    : new Map(
        context.files.map((file) => [file.path, context.readFile(file.path)]),
      );
  applyCanonicalView(
    projectRoot,
    context.files.map((file) => {
      const bytes = bytesByPath.get(file.path);
      if (bytes === undefined)
        throw new Error("canonical-materialization-file-missing");
      return { path: file.path, bytes: Buffer.from(bytes) };
    }),
  );
}

/** Capture the live managed view so command-level staging can restore it. */
export function captureCanonicalView(
  projectRoot: string,
): readonly LifecycleGenerationFile[] {
  return discoverCanonicalGenerationPaths(projectRoot).map((relativePath) => ({
    path: relativePath.slice(CANONICAL_PREFIX.length),
    bytes: fs.readFileSync(path.join(projectRoot, ...relativePath.split("/"))),
  }));
}

/** Restore an exact managed view without touching Runtime or user namespaces. */
export function restoreCanonicalView(
  projectRoot: string,
  files: readonly LifecycleGenerationFile[],
): void {
  applyCanonicalView(projectRoot, files);
}

function applyCanonicalView(
  projectRoot: string,
  files: readonly LifecycleGenerationFile[],
): void {
  const normalized = new Map<string, Buffer>();
  for (const file of files) {
    const relativePath = normalizeMaterializedPath(file.path);
    // Generation-only composition metadata belongs beside the immutable seal,
    // not in the live Runtime namespace.
    if (relativePath === "runtime/composition.json") continue;
    if (normalized.has(relativePath))
      throw new Error("canonical-materialization-duplicate");
    normalized.set(relativePath, Buffer.from(file.bytes));
  }

  // Discover and validate the complete current managed view before touching a
  // byte. The old implementation discovered obsolete paths after replacing
  // candidate files, so a later symlink/link-count error could leave a mixed
  // live view. This preflight makes all known target failures fail closed.
  const currentPaths = discoverCanonicalGenerationPaths(projectRoot);
  const currentSnapshot = captureManagedSnapshot(projectRoot, currentPaths);
  const materialized = new Set(normalized.keys());
  for (const relativePath of normalized.keys()) {
    const target = assertCanonicalWriteTarget(
      projectRoot,
      `${CANONICAL_PREFIX}${relativePath}`,
    );
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1))
      throw new Error("canonical-materialization-target-unsafe");
  }
  for (const current of currentPaths)
    assertCanonicalWriteTarget(projectRoot, current);

  try {
    for (const [relativePath, bytes] of normalized) {
      const targetRelative = `${CANONICAL_PREFIX}${relativePath}`;
      const target = assertCanonicalWriteTarget(projectRoot, targetRelative);
      try {
        if (fs.readFileSync(target).equals(bytes)) continue;
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ENOENT")
        )
          throw error;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temporaryRelative = `${targetRelative}.tmp-${randomUUID()}`;
      const temporary = assertCanonicalWriteTarget(
        projectRoot,
        temporaryRelative,
      );
      try {
        fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
        fs.renameSync(temporary, target);
        if (/^scripts\/.*\.py$/u.test(relativePath))
          fs.chmodSync(target, 0o755);
      } finally {
        try {
          fs.unlinkSync(temporary);
        } catch {
          /* Successful rename consumes the temporary file. */
        }
      }
    }
    for (const current of currentPaths) {
      const relativePath = current.slice(CANONICAL_PREFIX.length);
      if (materialized.has(relativePath)) continue;
      fs.unlinkSync(assertCanonicalWriteTarget(projectRoot, current));
    }
  } catch (error) {
    // Per-file replacement is atomic, but the view spans multiple files. Keep
    // the all-or-nothing contract when a cooperative filesystem error occurs
    // after one or more replacements by restoring the preflight snapshot.
    try {
      restoreManagedSnapshot(projectRoot, currentSnapshot);
    } catch {
      // Preserve the original failure; recovery will surface any unsafe residue.
    }
    throw error;
  }
}

interface ManagedSnapshot {
  readonly relativePath: string;
  readonly bytes: Buffer;
  readonly mode: number;
}

function captureManagedSnapshot(
  projectRoot: string,
  currentPaths: readonly string[],
): readonly ManagedSnapshot[] {
  return currentPaths.map((current) => {
    const target = assertCanonicalWriteTarget(projectRoot, current);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error("canonical-materialization-source-unsafe");
    return {
      relativePath: current.slice(CANONICAL_PREFIX.length),
      bytes: fs.readFileSync(target),
      mode: stat.mode & 0o7777,
    };
  });
}

function restoreManagedSnapshot(
  projectRoot: string,
  snapshot: readonly ManagedSnapshot[],
): void {
  const expected = new Set(snapshot.map((entry) => entry.relativePath));
  for (const current of discoverCanonicalGenerationPaths(projectRoot)) {
    const relativePath = current.slice(CANONICAL_PREFIX.length);
    if (expected.has(relativePath)) continue;
    fs.unlinkSync(assertCanonicalWriteTarget(projectRoot, current));
  }
  for (const entry of snapshot) {
    const targetRelative = `${CANONICAL_PREFIX}${entry.relativePath}`;
    const target = assertCanonicalWriteTarget(projectRoot, targetRelative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = assertCanonicalWriteTarget(
      projectRoot,
      `${targetRelative}.tmp-${randomUUID()}`,
    );
    try {
      fs.writeFileSync(temporary, entry.bytes, { flag: "wx", mode: entry.mode });
      fs.renameSync(temporary, target);
      fs.chmodSync(target, entry.mode);
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch {
        /* Successful rename consumes the temporary file. */
      }
    }
  }
}

function normalizeMaterializedPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized === "runtime/composition.json") return normalized;
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized === ".." ||
    excludedCanonicalPath(`${CANONICAL_PREFIX}${normalized}`)
  )
    throw new Error("canonical-materialization-path-unsafe");
  return normalized;
}
