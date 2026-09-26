import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assertCanonicalWriteTarget } from "../runtime/paths.js";
import { STORAGE_RELATIVE } from "./legacy-task-batch-types.js";
export function storagePath(projectRoot: string, ...parts: string[]): string {
  return assertCanonicalWriteTarget(
    projectRoot,
    path.join(projectRoot, STORAGE_RELATIVE, ...parts),
  );
}

export function ensureDirectory(projectRoot: string, target: string): void {
  const safe = assertCanonicalWriteTarget(projectRoot, target);
  fs.mkdirSync(safe, { recursive: true });
  assertCanonicalWriteTarget(projectRoot, safe);
}

export function readRegularFile(
  projectRoot: string,
  target: string,
): Buffer | null {
  const safe = assertCanonicalWriteTarget(projectRoot, target);
  try {
    const stat = fs.lstatSync(safe);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error("migration-store-file-invalid");
    assertCanonicalWriteTarget(projectRoot, safe);
    return fs.readFileSync(safe);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

export function writeExclusive(
  projectRoot: string,
  target: string,
  bytes: Uint8Array,
): "written" | "already-matched" {
  const safe = assertCanonicalWriteTarget(projectRoot, target);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      safe,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("migration-store-file-invalid");
    assertCanonicalWriteTarget(projectRoot, safe);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    return "written";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      const existing = readRegularFile(projectRoot, safe);
      if (existing?.equals(Buffer.from(bytes))) return "already-matched";
      throw new Error("migration-immutable-collision");
    }
    throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function atomicReplace(
  projectRoot: string,
  target: string,
  bytes: Uint8Array,
): void {
  const safe = assertCanonicalWriteTarget(projectRoot, target);
  const temporary = assertCanonicalWriteTarget(
    projectRoot,
    `${safe}.tmp-${randomUUID()}`,
  );
  let created = false;
  try {
    writeExclusive(projectRoot, temporary, bytes);
    created = true;
    assertCanonicalWriteTarget(projectRoot, safe);
    assertCanonicalWriteTarget(projectRoot, temporary);
    fs.renameSync(temporary, safe);
    created = false;
  } finally {
    if (created) {
      try {
        assertCanonicalWriteTarget(projectRoot, temporary);
        fs.unlinkSync(temporary);
      } catch {
        /* A leftover unique temporary is reported by recovery inspection. */
      }
    }
  }
}

export function withLock<T>(
  projectRoot: string,
  lockPath: string,
  action: () => T,
): T {
  const safe = assertCanonicalWriteTarget(projectRoot, lockPath);
  const token = JSON.stringify({ pid: process.pid, token: randomUUID() });
  let descriptor: number | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      descriptor = fs.openSync(
        safe,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      break;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
      if (attempt === 0 && reclaimDeadProcessLock(projectRoot, safe)) continue;
      throw new Error("migration-lock-unavailable");
    }
  }
  if (descriptor === null) throw new Error("migration-lock-unavailable");
  try {
    fs.writeFileSync(descriptor, token, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    return action();
  } finally {
    try {
      assertCanonicalWriteTarget(projectRoot, safe);
      if (fs.readFileSync(safe, "utf8") === token) fs.unlinkSync(safe);
    } catch {
      /* Do not remove a lock whose ownership can no longer be proven. */
    }
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    return true;
  }
}

export function reclaimDeadProcessLock(
  projectRoot: string,
  target: string,
): boolean {
  const original = readRegularFile(projectRoot, target);
  if (!original) return false;
  let owner: unknown;
  try {
    owner = JSON.parse(original.toString("utf8")) as unknown;
  } catch {
    return false;
  }
  if (
    !owner ||
    typeof owner !== "object" ||
    Array.isArray(owner) ||
    typeof (owner as { pid?: unknown }).pid !== "number" ||
    typeof (owner as { token?: unknown }).token !== "string" ||
    (owner as { token: string }).token.length < 8 ||
    processIsAlive((owner as { pid: number }).pid)
  )
    return false;
  const current = readRegularFile(projectRoot, target);
  if (!current?.equals(original)) return false;
  assertCanonicalWriteTarget(projectRoot, target);
  fs.unlinkSync(target);
  return true;
}
