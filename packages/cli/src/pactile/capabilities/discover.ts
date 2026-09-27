import type {
  BoundedCapabilityRequestV1,
  DiscoverCapabilityDataV1,
} from "../../core/index.js";
import {
  jsonBytes,
  operationDataBudget,
  stopResult,
  type OperationResult,
} from "./shared.js";
import { collectFiles } from "./workspace.js";

export async function discover(
  root: string,
  request: Extract<BoundedCapabilityRequestV1, { operation: "discover" }>,
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
  const stopped = scan.stopped;
  if (stopped) {
    const data: DiscoverCapabilityDataV1 | null = scan.files.length
      ? { files: scan.files, entriesScanned: scan.entriesScanned }
      : null;
    return stopResult(stopped, data);
  }
  const orderedFiles = [...scan.files].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const pageFiles = orderedFiles.slice(
    request.offset,
    request.offset + request.limits.maxResults,
  );
  const hasMore =
    !scan.partial && request.offset + pageFiles.length < orderedFiles.length;
  const files: string[] = [];
  let outputLimited = false;
  const dataBudget = operationDataBudget(request);
  for (const file of pageFiles) {
    const candidate = {
      files: [...files, file],
      entriesScanned: scan.entriesScanned,
    };
    if (jsonBytes(candidate) > dataBudget) {
      outputLimited = true;
      break;
    }
    files.push(file);
  }
  const partial =
    scan.partial || outputLimited || pageFiles.length > files.length || hasMore;
  const data: DiscoverCapabilityDataV1 = {
    files,
    entriesScanned: scan.entriesScanned,
  };
  const error = outputLimited
    ? {
        code: "OUTPUT_LIMIT" as const,
        message: "The response reached its output-byte limit.",
      }
    : scan.error;
  return {
    data,
    outcome: partial ? "partial" : files.length === 0 ? "empty" : "complete",
    partial,
    error,
    nextPage: hasMore && !outputLimited ? request.offset + files.length : null,
  };
}
