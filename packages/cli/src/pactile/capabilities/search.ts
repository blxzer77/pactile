import fs from "node:fs";
import type {
  BoundedCapabilityRequestV1,
  SearchCapabilityDataV1,
  SearchCapabilityMatchV1,
} from "../../core/index.js";
import {
  CapabilityNodeError,
  jsonBytes,
  mapFilesystemError,
  operationDataBudget,
  stopReason,
  stopResult,
  truncateUtf8,
  type OperationResult,
} from "./shared.js";
import {
  collectFiles,
  containsBinaryBytes,
  openVerifiedFile,
  realFile,
} from "./workspace.js";

export async function search(
  root: string,
  request: Extract<BoundedCapabilityRequestV1, { operation: "search" }>,
  signal: AbortSignal,
  excludedPaths: readonly string[],
): Promise<OperationResult> {
  const scan = await collectFiles(
    root,
    request.directory,
    request.limits,
    signal,
    request.limits.maxFilesScanned + 1,
    excludedPaths,
  );
  const files = [...scan.files]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, request.limits.maxFilesScanned);
  const matches: SearchCapabilityMatchV1[] = [];
  const needle = request.caseSensitive
    ? request.query
    : request.query.toLocaleLowerCase();
  let filesScanned = 0;
  let bytesRead = 0;
  let outputLimited = false;
  let readLimited = false;
  let fileTooLarge = false;
  let matchingCount = 0;
  let hasMore = false;
  const dataBudget = operationDataBudget(request);
  const maxPreviewBytes = Math.min(512, Math.floor(dataBudget / 4));
  const data = (): SearchCapabilityDataV1 => ({
    matches: [...matches],
    filesScanned,
    bytesRead,
  });
  if (scan.stopped) return stopResult(scan.stopped, null);
  for (const relative of files) {
    const stopped = stopReason(signal);
    if (stopped)
      return stopResult(
        stopped,
        filesScanned || matches.length ? data() : null,
      );
    let file: { full: string; stat: fs.Stats };
    try {
      file = await realFile(root, relative);
    } catch (cause) {
      const mapped =
        cause instanceof CapabilityNodeError
          ? cause
          : mapFilesystemError(cause);
      if (["PERMISSION_DENIED", "NOT_FOUND"].includes(mapped.code)) {
        scan.error ??= { code: mapped.code, message: mapped.message };
        continue;
      }
      throw mapped;
    }
    const { full, stat } = file;
    if (stat.size > request.limits.maxFileBytes) {
      fileTooLarge = true;
      continue;
    }
    if (bytesRead + stat.size > request.limits.maxBytesRead) {
      readLimited = true;
      break;
    }
    let contents: Buffer;
    let fileChangedWhileReading = false;
    try {
      const handle = await openVerifiedFile(root, full, stat);
      try {
        const currentStat = await handle.stat();
        if (currentStat.size > request.limits.maxFileBytes) {
          fileTooLarge = true;
          continue;
        }
        if (currentStat.size > request.limits.maxBytesRead - bytesRead) {
          readLimited = true;
          break;
        }
        const buffer = Buffer.alloc(currentStat.size);
        const read = await handle.read(buffer, 0, buffer.length, 0);
        contents = buffer.subarray(0, read.bytesRead);
        const afterReadStat = await handle.stat();
        fileChangedWhileReading =
          read.bytesRead !== currentStat.size ||
          afterReadStat.size !== currentStat.size;
      } finally {
        await handle.close();
      }
    } catch (error) {
      const mapped =
        error instanceof CapabilityNodeError
          ? error
          : mapFilesystemError(error);
      if (mapped.code === "PERMISSION_DENIED" || mapped.code === "NOT_FOUND") {
        scan.error ??= { code: mapped.code, message: mapped.message };
        continue;
      }
      throw mapped;
    }
    if (fileChangedWhileReading) readLimited = true;
    bytesRead += contents.length;
    filesScanned += 1;
    if (containsBinaryBytes(contents)) continue;
    const text = contents.toString("utf8");
    let lineStart = 0;
    let lineNumber = 1;
    while (lineStart <= text.length) {
      const nextBreak = text.indexOf("\n", lineStart);
      const lineEnd = nextBreak === -1 ? text.length : nextBreak;
      let line = text.slice(lineStart, lineEnd);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const haystack = request.caseSensitive ? line : line.toLocaleLowerCase();
      if (haystack.includes(needle)) {
        if (matchingCount < request.offset) {
          matchingCount += 1;
          if (nextBreak === -1) break;
          lineStart = nextBreak + 1;
          lineNumber += 1;
          continue;
        }
        if (matches.length >= request.limits.maxResults) {
          hasMore = true;
          break;
        }
        const match: SearchCapabilityMatchV1 = {
          path: relative,
          line: lineNumber,
          preview: truncateUtf8(line, maxPreviewBytes),
        };
        const candidate = {
          matches: [...matches, match],
          filesScanned,
          bytesRead,
        };
        if (jsonBytes(candidate) > dataBudget) {
          outputLimited = true;
          break;
        }
        matches.push(match);
        matchingCount += 1;
      }
      if (nextBreak === -1) break;
      lineStart = nextBreak + 1;
      lineNumber += 1;
    }
    if (outputLimited || hasMore) break;
  }
  const partial =
    scan.partial ||
    Boolean(scan.error) ||
    outputLimited ||
    hasMore ||
    readLimited ||
    fileTooLarge;
  const error = outputLimited
    ? {
        code: "OUTPUT_LIMIT" as const,
        message: "The response reached its output or result-count limit.",
      }
    : readLimited
      ? {
          code: "SCAN_LIMIT" as const,
          message: "The request reached its total file-read limit.",
        }
      : fileTooLarge
        ? {
            code: "FILE_TOO_LARGE" as const,
            message: "One or more files exceeded the per-file scan limit.",
          }
        : scan.error;
  return {
    data: data(),
    outcome: partial ? "partial" : matches.length === 0 ? "empty" : "complete",
    partial,
    error,
    nextPage:
      hasMore &&
      !scan.partial &&
      !readLimited &&
      !fileTooLarge &&
      !outputLimited
        ? request.offset + matches.length
        : null,
  };
}
