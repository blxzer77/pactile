import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fingerprintBytes } from "../projection/planner.js";
import type {
  LifecycleGenerationFile,
  LifecycleLegacyFile,
} from "./orchestrator.js";

const CONTROL_METADATA = new Set([
  ".template-hashes.json",
  ".version",
  ".p36-wave-c.json",
]);
const GENERATION_EXCLUDED = [
  "runtime/",
  "tasks/",
  "workspace/",
  "spec/",
  "middleware/",
];

function relativePosix(root: string, target: string): string {
  const relative = path.relative(root, target).split(path.sep).join("/");
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith("../") ||
    path.isAbsolute(relative)
  )
    throw new Error("legacy-import-path-escape");
  return relative;
}

function assertSafeEntry(target: string): fs.Stats {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
    throw new Error("legacy-import-source-unsafe");
  if (stat.isFile() && stat.nlink !== 1)
    throw new Error("legacy-import-source-unsafe");
  return stat;
}

function skippedControlPath(relativePath: string): boolean {
  return (
    CONTROL_METADATA.has(relativePath) ||
    relativePath === "runtime" ||
    relativePath.startsWith("runtime/") ||
    relativePath === "local" ||
    relativePath.startsWith("local/") ||
    relativePath.split("/").some((part) => part.startsWith(".backup-"))
  );
}

/**
 * Copy an explicitly selected `.cstl` tree into a new canonical root without
 * mutating the source or following links. Runtime/control metadata is rebuilt
 * by Pactile and machine-local payloads stay only in the read-only source.
 */
export function prepareLegacyCstlImport(
  projectRoot: string,
  destinationProjectRoot: string = projectRoot,
): readonly string[] {
  const sourceRoot = path.join(projectRoot, ".cstl");
  const targetRoot = path.join(destinationProjectRoot, ".pactile");
  if (!fs.existsSync(sourceRoot) || !assertSafeEntry(sourceRoot).isDirectory())
    throw new Error("legacy-cstl-source-required");
  if (fs.existsSync(targetRoot))
    throw new Error("canonical-root-already-present");
  if (!fs.statSync(destinationProjectRoot).isDirectory())
    throw new Error("legacy-import-destination-required");
  const directories: string[] = [];
  const files: { readonly source: string; readonly relativePath: string }[] =
    [];
  const inspect = (sourceDirectory: string): void => {
    for (const name of fs.readdirSync(sourceDirectory).sort()) {
      const source = path.join(sourceDirectory, name);
      const relativePath = relativePosix(sourceRoot, source);
      const stat = assertSafeEntry(source);
      if (skippedControlPath(relativePath)) continue;
      if (stat.isDirectory()) {
        directories.push(relativePath);
        inspect(source);
        continue;
      }
      files.push({ source, relativePath });
    }
  };
  inspect(sourceRoot);
  fs.mkdirSync(targetRoot);
  try {
    for (const relativePath of directories.sort())
      fs.mkdirSync(path.join(targetRoot, ...relativePath.split("/")), {
        recursive: true,
      });
    for (const file of files.sort((left, right) =>
      left.relativePath < right.relativePath
        ? -1
        : left.relativePath > right.relativePath
          ? 1
          : 0,
    )) {
      const target = path.join(targetRoot, ...file.relativePath.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file.source, target, fs.constants.COPYFILE_EXCL);
    }
    return files.map((file) => file.relativePath);
  } catch (error) {
    fs.rmSync(targetRoot, { recursive: true, force: true });
    throw error;
  }
}

function generationEligible(relativePath: string): boolean {
  return (
    relativePath !== ".developer" &&
    relativePath !== ".current-task" &&
    !GENERATION_EXCLUDED.some(
      (prefix) =>
        relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix),
    )
  );
}

/** Build the strict B2 legacy migration payload from the still-read-only source. */
export function collectLegacyCstlLifecycleFiles(
  projectRoot: string,
  candidateProjectRoot: string = projectRoot,
  candidateFiles: readonly LifecycleGenerationFile[] = [],
): readonly LifecycleLegacyFile[] {
  const sourceRoot = path.join(projectRoot, ".cstl");
  const targetRoot = path.join(candidateProjectRoot, ".pactile");
  const result: LifecycleLegacyFile[] = [];
  const visit = (sourceDirectory: string): void => {
    for (const name of fs.readdirSync(sourceDirectory).sort()) {
      const source = path.join(sourceDirectory, name);
      const relativePath = relativePosix(sourceRoot, source);
      const stat = assertSafeEntry(source);
      if (skippedControlPath(relativePath)) continue;
      if (stat.isDirectory()) {
        visit(source);
        continue;
      }
      if (!generationEligible(relativePath)) continue;
      const target = path.join(targetRoot, ...relativePath.split("/"));
      const sourceBytes = fs.readFileSync(source);
      const targetBytes = fs.existsSync(target)
        ? fs.readFileSync(target)
        : sourceBytes;
      const sourceRef = `legacy://cstl/${relativePath
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
      if (sourceRef.length > 512) throw new Error("legacy-import-ref-too-long");
      result.push({
        sourceRef,
        path: relativePath,
        classification: "active",
        sourceBytes,
        bytes: targetBytes,
        expectedSourceFingerprint: fingerprintBytes(sourceBytes),
      });
    }
  };
  visit(sourceRoot);
  const legacyPaths = new Set(result.map((file) => file.path));
  for (const file of candidateFiles) {
    const targetPath = file.path.replace(/\\/g, "/");
    if (legacyPaths.has(targetPath)) continue;
    const bytes = Buffer.from(file.bytes);
    const sourceRef = `generated://pactile/${targetPath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    if (sourceRef.length > 512) throw new Error("legacy-import-ref-too-long");
    result.push({
      sourceRef,
      path: targetPath,
      classification: "generated",
      sourceBytes: bytes,
      bytes,
      expectedSourceFingerprint: fingerprintBytes(bytes),
    });
  }
  if (result.length === 0) throw new Error("legacy-import-source-empty");
  return result.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/**
 * Publish imported user-owned namespaces after canonical commit. Writes are
 * idempotent and conflict-closed so an interrupted import can safely resume.
 */
export function materializePreparedLegacyUserState(
  preparedProjectRoot: string,
  projectRoot: string,
): readonly string[] {
  const sourceRoot = path.join(preparedProjectRoot, ".pactile");
  const targetRoot = path.join(projectRoot, ".pactile");
  const files: { readonly path: string; readonly bytes: Buffer }[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const source = path.join(directory, name);
      const relativePath = relativePosix(sourceRoot, source);
      const stat = assertSafeEntry(source);
      if (stat.isDirectory()) {
        visit(source);
        continue;
      }
      if (generationEligible(relativePath)) continue;
      files.push({ path: relativePath, bytes: fs.readFileSync(source) });
    }
  };
  visit(sourceRoot);

  for (const file of files) {
    const target = path.join(targetRoot, ...file.path.split("/"));
    try {
      if (fs.readFileSync(target).equals(file.bytes)) continue;
      throw new Error("legacy-import-user-state-conflict");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${randomUUID()}`;
    try {
      fs.writeFileSync(temporary, file.bytes, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, target);
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch {
        /* Successful rename consumes the temporary file. */
      }
    }
  }
  return files.map((file) => file.path);
}

export function readLegacyCstlVersion(projectRoot: string): string | null {
  try {
    const value = fs
      .readFileSync(path.join(projectRoot, ".cstl", ".version"), "utf8")
      .trim();
    return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) ? value : null;
  } catch {
    return null;
  }
}
