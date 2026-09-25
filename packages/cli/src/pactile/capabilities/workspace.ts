import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type {
  BoundedCapabilityFailureV1,
  BoundedCapabilityRequestV1,
} from "../../core/index.js";
import {
  CapabilityNodeError,
  isExcludedPath,
  isInside,
  isReceiptControlPath,
  mapFilesystemError,
  safeChild,
  sameFileIdentity,
  stopReason,
  type StopReason,
} from "./shared.js";

const SKIP_DIRECTORIES = new Set([".git", "node_modules"]);

export async function realDirectory(
  root: string,
  relative: string | null,
): Promise<string> {
  const target = safeChild(root, relative);
  let resolved: string;
  try {
    resolved = await fsp.realpath(target);
  } catch (error) {
    throw mapFilesystemError(error);
  }
  if (!isInside(root, resolved)) {
    throw new CapabilityNodeError(
      "OUT_OF_SCOPE",
      "Directory resolves outside the workspace.",
    );
  }
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(resolved);
  } catch (error) {
    throw mapFilesystemError(error);
  }
  if (!stat.isDirectory()) {
    throw new CapabilityNodeError(
      "NOT_FOUND",
      "Requested directory was not found.",
    );
  }
  return resolved;
}

export async function realFile(
  root: string,
  relative: string,
): Promise<{ full: string; stat: fs.Stats }> {
  const target = safeChild(root, relative);
  let resolved: string;
  try {
    resolved = await fsp.realpath(target);
  } catch (error) {
    throw mapFilesystemError(error);
  }
  if (!isInside(root, resolved)) {
    throw new CapabilityNodeError(
      "OUT_OF_SCOPE",
      "File resolves outside the workspace.",
    );
  }
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(resolved);
  } catch (error) {
    throw mapFilesystemError(error);
  }
  if (!stat.isFile()) {
    throw new CapabilityNodeError("NOT_FOUND", "Requested file was not found.");
  }
  return { full: resolved, stat };
}

export async function openVerifiedFile(
  root: string,
  full: string,
  expected: fs.Stats,
): Promise<Awaited<ReturnType<typeof fsp.open>>> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
    handle = await fsp.open(full, fs.constants.O_RDONLY | noFollow);
    const [opened, link, resolved] = await Promise.all([
      handle.stat(),
      fsp.lstat(full),
      fsp.realpath(full),
    ]);
    if (
      !opened.isFile() ||
      link.isSymbolicLink() ||
      !isInside(root, resolved) ||
      !sameFileIdentity(expected, opened) ||
      !sameFileIdentity(opened, link)
    ) {
      throw new CapabilityNodeError(
        "OUT_OF_SCOPE",
        "The file changed while its workspace boundary was being checked.",
      );
    }
    return handle;
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if (error instanceof CapabilityNodeError) throw error;
    throw mapFilesystemError(error);
  }
}

export async function collectFiles(
  root: string,
  directory: string | null,
  limits: BoundedCapabilityRequestV1["limits"],
  signal: AbortSignal,
  maxStoredFiles: number,
  excludedPaths: readonly string[] = [],
): Promise<{
  files: string[];
  entriesScanned: number;
  partial: boolean;
  error: BoundedCapabilityFailureV1 | null;
  stopped: StopReason | null;
}> {
  const start = await realDirectory(root, directory);
  const queue = [start];
  const files: string[] = [];
  let queueIndex = 0;
  let entriesScanned = 0;
  let partial = false;
  let error: BoundedCapabilityFailureV1 | null = null;
  while (queueIndex < queue.length) {
    const stopped = stopReason(signal);
    if (stopped)
      return {
        files,
        entriesScanned,
        partial: files.length > 0,
        error: null,
        stopped,
      };
    let current = queue[queueIndex++];
    if (!current) continue;
    let directoryStat: fs.Stats | null = null;
    try {
      const linkStat = await fsp.lstat(current);
      if (linkStat.isSymbolicLink()) {
        partial = true;
        error ??= {
          code: "OUT_OF_SCOPE",
          message: "Symbolic-link directories are not traversed.",
        };
        continue;
      }
      current = await fsp.realpath(current);
      if (!isInside(root, current)) {
        partial = true;
        error ??= {
          code: "OUT_OF_SCOPE",
          message: "Directory resolves outside the workspace.",
        };
        continue;
      }
      directoryStat = await fsp.stat(current);
      if (!directoryStat.isDirectory()) {
        partial = true;
        error ??= {
          code: "NOT_FOUND",
          message: "A workspace directory changed during discovery.",
        };
        continue;
      }
      const stoppedAfterDirectoryCheck = stopReason(signal);
      if (stoppedAfterDirectoryCheck)
        return {
          files,
          entriesScanned,
          partial: files.length > 0,
          error: null,
          stopped: stoppedAfterDirectoryCheck,
        };
    } catch (cause) {
      const mapped =
        cause instanceof CapabilityNodeError
          ? cause
          : mapFilesystemError(cause);
      partial = true;
      error ??= { code: mapped.code, message: mapped.message };
      continue;
    }
    if (!directoryStat) continue;
    const entries: fs.Dirent[] = [];
    let directoryOverflow = false;
    try {
      const handle = await fsp.opendir(current);
      try {
        const [currentLink, currentRealPath, currentStat] = await Promise.all([
          fsp.lstat(current),
          fsp.realpath(current),
          fsp.stat(current),
        ]);
        if (
          currentLink.isSymbolicLink() ||
          !isInside(root, currentRealPath) ||
          !sameFileIdentity(directoryStat, currentStat)
        ) {
          partial = true;
          error ??= {
            code: "OUT_OF_SCOPE",
            message: "A workspace directory changed during discovery.",
          };
          await handle.close();
          continue;
        }
        const stoppedAfterOpen = stopReason(signal);
        if (stoppedAfterOpen)
          return {
            files,
            entriesScanned,
            partial: files.length > 0,
            error: null,
            stopped: stoppedAfterOpen,
          };
        const remaining = limits.maxFilesScanned - entriesScanned;
        for await (const entry of handle) {
          if (entries.length >= remaining) {
            directoryOverflow = true;
            break;
          }
          entries.push(entry);
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch (cause) {
      const mapped = mapFilesystemError(cause);
      if (mapped.code === "PERMISSION_DENIED") {
        partial = true;
        error ??= { code: mapped.code, message: mapped.message };
        continue;
      }
      throw mapped;
    }
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const stop = stopReason(signal);
      if (stop)
        return {
          files,
          entriesScanned,
          partial: files.length > 0,
          error: null,
          stopped: stop,
        };
      if (entriesScanned >= limits.maxFilesScanned) {
        partial = true;
        error ??= {
          code: "SCAN_LIMIT",
          message: "The directory scan reached its file-entry limit.",
        };
        return { files, entriesScanned, partial, error, stopped: null };
      }
      entriesScanned += 1;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const child = path.join(current, entry.name);
        const childRelative = path.relative(root, child).replaceAll("\\", "/");
        if (
          !SKIP_DIRECTORIES.has(entry.name) &&
          !isReceiptControlPath(childRelative)
        )
          queue.push(child);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path
        .relative(root, path.join(current, entry.name))
        .replaceAll("\\", "/");
      if (
        isReceiptControlPath(relative) ||
        isExcludedPath(relative, excludedPaths)
      )
        continue;
      files.push(relative);
      if (files.length >= maxStoredFiles) {
        partial = true;
        error ??= {
          code: "OUTPUT_LIMIT",
          message: "The request reached its result-count limit.",
        };
        return { files, entriesScanned, partial, error, stopped: null };
      }
    }
    if (directoryOverflow) {
      partial = true;
      error ??= {
        code: "SCAN_LIMIT",
        message: "The directory scan reached its file-entry limit.",
      };
      return { files, entriesScanned, partial, error, stopped: null };
    }
  }
  return { files, entriesScanned, partial, error, stopped: null };
}

export function containsBinaryBytes(bytes: Buffer): boolean {
  return bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0);
}
