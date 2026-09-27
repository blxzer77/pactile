import { StringDecoder } from "node:string_decoder";
import type { BoundedCapabilityRequestV1 } from "../../core/index.js";
import {
  jsonBytes,
  operationDataBudget,
  stopReason,
  stopResult,
  truncateUtf8,
  type OperationResult,
} from "./shared.js";
import { openVerifiedFile, realFile } from "./workspace.js";

export async function readFileCapability(
  root: string,
  request: Extract<BoundedCapabilityRequestV1, { operation: "read" }>,
  signal: AbortSignal,
): Promise<OperationResult> {
  const stopped = stopReason(signal);
  if (stopped) return stopResult(stopped, null);
  const { full, stat } = await realFile(root, request.path);
  const beforeOpenStop = stopReason(signal);
  if (beforeOpenStop) return stopResult(beforeOpenStop, null);
  const reserve = jsonBytes({
    path: request.path,
    content: "",
    bytesRead: 0,
    totalBytes: stat.size,
    truncated: false,
  });
  const contentBudget = Math.max(0, operationDataBudget(request) - reserve);
  const byteBudget = Math.min(
    request.limits.maxFileBytes,
    request.limits.maxBytesRead,
    contentBudget,
    stat.size,
  );
  const handle = await openVerifiedFile(root, full, stat);
  let buffer: Buffer;
  try {
    const beforeReadStop = stopReason(signal);
    if (beforeReadStop) return stopResult(beforeReadStop, null);
    buffer = Buffer.alloc(byteBudget);
    if (byteBudget > 0) {
      const read = await handle.read(buffer, 0, byteBudget, 0);
      buffer = buffer.subarray(0, read.bytesRead);
    }
  } finally {
    await handle.close();
  }
  const afterReadStop = stopReason(signal);
  if (afterReadStop) return stopResult(afterReadStop, null);
  const content = new StringDecoder("utf8").end(buffer);
  const truncated = stat.size > byteBudget;
  const data = {
    path: request.path,
    content,
    bytesRead: buffer.length,
    totalBytes: stat.size,
    truncated,
  };
  const dataBudget = operationDataBudget(request);
  if (jsonBytes(data) > dataBudget) {
    let fit = content;
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const fitted = { ...data, content: fit, truncated: true };
      if (jsonBytes(fitted) <= dataBudget) {
        return {
          data: fitted,
          outcome: "partial",
          partial: true,
          error: {
            code: "OUTPUT_LIMIT",
            message: "The response reached its output-byte limit.",
          },
        };
      }
      fit = truncateUtf8(
        fit,
        Math.floor(Buffer.byteLength(fit, "utf8") * 0.75),
      );
    }
    return {
      data: null,
      outcome: "partial",
      partial: true,
      error: {
        code: "OUTPUT_LIMIT",
        message: "The response reached its output-byte limit.",
      },
    };
  }
  if (truncated) {
    const code =
      stat.size > request.limits.maxFileBytes ||
      stat.size > request.limits.maxBytesRead
        ? "FILE_TOO_LARGE"
        : "OUTPUT_LIMIT";
    return {
      data,
      outcome: "partial",
      partial: true,
      error: {
        code,
        message:
          code === "FILE_TOO_LARGE"
            ? "The file exceeded the request read limit."
            : "The response reached its output-byte limit.",
      },
    };
  }
  return {
    data,
    outcome: content.length === 0 ? "empty" : "complete",
    partial: false,
    error: null,
  };
}
