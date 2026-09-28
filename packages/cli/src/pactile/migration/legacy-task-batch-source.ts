import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  scanLegacyTaskMigration,
  type LegacyTaskMigrationPlan,
} from "../../core/task/legacy-task-migration.js";
import {
  assertCanonicalWriteTarget,
  normalizeRuntimeRelativePath,
} from "../runtime/paths.js";
import {
  FINGERPRINT,
  bytesForSource,
  digest,
  fingerprintSources,
  jsonBytes,
  type NormalizedRequest,
} from "./legacy-task-batch-types.js";
import {
  ensureDirectory,
  readRegularFile,
  storagePath,
  writeExclusive,
} from "./legacy-task-batch-io.js";
export function validatePlanAtRoot(
  projectRoot: string,
  plan: LegacyTaskMigrationPlan,
): boolean {
  return (
    path.resolve(plan.projectRoot) === path.resolve(projectRoot) &&
    plan.tasksRoot ===
      path.join(path.resolve(projectRoot), ".pactile", "tasks") &&
    plan.readOnly === true &&
    plan.wrote === false &&
    plan.preflight.status === "clear-to-review" &&
    plan.preflight.blockerCount === 0 &&
    plan.scannedTaskCount === plan.tasks.length &&
    plan.scannedFileCount ===
      plan.tasks.reduce((count, task) => count + task.files.length, 0) &&
    fingerprintSources(plan) === plan.sourceFingerprint
  );
}

/** Finish the full scan before returning scalar evidence to an async caller. */
export function sourceMatchesPlan(request: NormalizedRequest): boolean {
  const current = scanLegacyTaskMigration({ projectRoot: request.projectRoot });
  return (
    current.preflight.status === "clear-to-review" &&
    current.sourceFingerprint === request.sourceFingerprint
  );
}

export function assertSourceUnchanged(request: NormalizedRequest): void {
  if (!sourceMatchesPlan(request)) throw new Error("migration-source-changed");
}

function backupManifest(plan: LegacyTaskMigrationPlan): Buffer {
  const files = plan.tasks
    .flatMap((task) => task.files)
    .map((file) => ({
      path: file.path,
      role: file.role,
      byteLength: file.byteLength,
      fingerprint: file.sha256,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return jsonBytes({
    schemaVersion: 1,
    kind: "legacy-task-source-snapshot",
    sourceFingerprint: plan.sourceFingerprint,
    files,
  });
}

export function writeSourceBackup(request: NormalizedRequest): void {
  const root = storagePath(
    request.projectRoot,
    "sources",
    request.sourceFingerprint.slice("sha256:".length),
  );
  ensureDirectory(request.projectRoot, root);
  const manifestPath = path.join(root, "manifest.json");
  const existingManifest = readRegularFile(request.projectRoot, manifestPath);
  if (existingManifest) {
    // A crash may leave the complete immutable snapshot before the journal
    // advances. Verify it once; replaying every exclusive write adds no proof.
    if (!existingManifest.equals(backupManifest(request.plan)))
      throw new Error("migration-immutable-collision");
    verifySourceBackup(request.projectRoot, request.sourceFingerprint);
    return;
  }
  const preparedDirectories = new Set<string>();
  for (const file of request.plan.tasks.flatMap((task) => task.files)) {
    const bytes = bytesForSource(file);
    if (digest(bytes) !== file.sha256 || bytes.byteLength !== file.byteLength)
      throw new Error("migration-source-plan-invalid");
    const target = path.join(root, "files", file.path);
    const parent = path.dirname(target);
    if (!preparedDirectories.has(parent)) {
      ensureDirectory(request.projectRoot, parent);
      preparedDirectories.add(parent);
    }
    // writeExclusive rechecks the full path for every file, including parents
    // already prepared above, so an external directory replacement fails closed.
    writeExclusive(request.projectRoot, target, bytes);
  }
  const manifest = backupManifest(request.plan);
  writeExclusive(
    request.projectRoot,
    manifestPath,
    manifest,
  );
  verifySourceBackup(request.projectRoot, request.sourceFingerprint);
}

export function verifySourceBackup(
  projectRoot: string,
  sourceFingerprint: string,
): void {
  const directory = storagePath(
    projectRoot,
    "sources",
    sourceFingerprint.slice("sha256:".length),
  );
  const manifestPath = path.join(directory, "manifest.json");
  const bytes = readRegularFile(projectRoot, manifestPath);
  if (!bytes) throw new Error("migration-source-backup-invalid");
  let manifest: unknown;
  try {
    manifest = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("migration-source-backup-invalid");
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    (manifest as { sourceFingerprint?: unknown }).sourceFingerprint !==
      sourceFingerprint ||
    (manifest as { kind?: unknown }).kind !== "legacy-task-source-snapshot"
  )
    throw new Error("migration-source-backup-invalid");
  const files = (manifest as { files?: unknown }).files;
  if (!Array.isArray(files)) throw new Error("migration-source-backup-invalid");
  const found = new Set<string>();
  const ordered: { path: string; byteLength: number; fingerprint: string }[] = [];
  for (const item of files) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("migration-source-backup-invalid");
    const entry = item as {
      path?: unknown;
      byteLength?: unknown;
      fingerprint?: unknown;
    };
    if (
      typeof entry.path !== "string" ||
      typeof entry.byteLength !== "number" ||
      !FINGERPRINT.test(
        typeof entry.fingerprint === "string" ? entry.fingerprint : "",
      )
    )
      throw new Error("migration-source-backup-invalid");
    const relative = normalizeRuntimeRelativePath(entry.path);
    if (relative !== entry.path || found.has(relative))
      throw new Error("migration-source-backup-invalid");
    found.add(relative);
    ordered.push({
      path: relative,
      byteLength: entry.byteLength,
      fingerprint: entry.fingerprint as string,
    });
  }
  ordered.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const sourceHash = createHash("sha256");
  for (const entry of ordered) {
    const filePath = path.join(directory, "files", entry.path);
    // readRegularFile performs the path/link checks. Keep only the current
    // file's bytes instead of retaining a second full source tree in memory.
    const fileBytes = readRegularFile(projectRoot, filePath);
    if (!fileBytes) throw new Error("migration-source-backup-invalid");
    if (
      fileBytes.byteLength !== entry.byteLength ||
      digest(fileBytes) !== entry.fingerprint
    )
      throw new Error("migration-source-backup-invalid");
    sourceHash.update(entry.path, "utf8");
    sourceHash.update("\0", "utf8");
    sourceHash.update(String(fileBytes.byteLength), "utf8");
    sourceHash.update("\0", "utf8");
    sourceHash.update(fileBytes);
  }
  const actualFiles = listFiles(projectRoot, path.join(directory, "files"))
    .map((target) =>
      path
        .relative(path.join(directory, "files"), target)
        .split(path.sep)
        .join("/"),
    )
    .sort();
  const expectedFiles = ordered.map((entry) => entry.path);
  if (
    `sha256:${sourceHash.digest("hex")}` !== sourceFingerprint ||
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((file, index) => file !== expectedFiles[index])
  )
    throw new Error("migration-source-backup-invalid");
}

export function listFiles(projectRoot: string, root: string): string[] {
  const output: string[] = [];
  const visit = (directory: string): void => {
    assertCanonicalWriteTarget(projectRoot, directory);
    for (const name of fs.readdirSync(directory).sort()) {
      const target = assertCanonicalWriteTarget(
        projectRoot,
        path.join(directory, name),
      );
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink())
        throw new Error("migration-store-link-invalid");
      if (stat.isDirectory()) visit(target);
      else if (stat.isFile() && stat.nlink === 1) output.push(target);
      else throw new Error("migration-store-file-invalid");
    }
  };
  visit(root);
  return output;
}
