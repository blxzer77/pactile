import fs from "node:fs";
import path from "node:path";
import type {
  BoundedCapabilityDataV1,
  BoundedCapabilityErrorCodeV1,
  BoundedCapabilityFailureV1,
  BoundedCapabilityOutcomeV1,
  BoundedCapabilityRequestV1,
} from "../../core/index.js";

export const RECEIPT_ROOT = ".pactile/runtime/receipts/capabilities";

export const RESPONSE_ENVELOPE_RESERVE_BYTES = 1_024;

export type StopReason = "TIMEOUT" | "CANCELLED";

export interface OperationResult {
  readonly data: BoundedCapabilityDataV1 | null;
  readonly outcome?: BoundedCapabilityOutcomeV1;
  readonly partial?: boolean;
  readonly error?: BoundedCapabilityFailureV1 | null;
  readonly nextPage?: number | null;
}

export class CapabilityNodeError extends Error {
  constructor(
    readonly code: BoundedCapabilityErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "CapabilityNodeError";
  }
}

export function safeChild(root: string, relative: string | null): string {
  const target =
    relative === null ? root : path.resolve(root, ...relative.split("/"));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new CapabilityNodeError(
      "OUT_OF_SCOPE",
      "Path is outside the workspace.",
    );
  }
  return target;
}

export function isInside(root: string, candidate: string): boolean {
  return relativeInside(root, candidate) !== null;
}

export function relativeInside(root: string, candidate: string): string | null {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
    return relative;
  }
  if (process.platform !== "win32") return null;
  try {
    const rootStat = fs.statSync(root, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.ino === 0n) return null;
    let current = path.resolve(candidate);
    const segments: string[] = [];
    while (true) {
      try {
        const stat = fs.statSync(current, { bigint: true });
        if (stat.isDirectory() && stat.dev === rootStat.dev && stat.ino === rootStat.ino) {
          return segments.reverse().join(path.sep);
        }
      } catch {
        // An absent leaf can still have a physically verified parent.
      }
      const parent = path.dirname(current);
      if (parent === current) return null;
      segments.push(path.basename(current));
      current = parent;
    }
  } catch {
    return null;
  }
}

export function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function operationDataBudget(
  request: BoundedCapabilityRequestV1,
): number {
  return Math.max(
    0,
    request.limits.maxOutputBytes - RESPONSE_ENVELOPE_RESERVE_BYTES,
  );
}

export function isReceiptControlPath(relative: string): boolean {
  const relativePath = relative.replaceAll("\\", "/");
  const normalized =
    process.platform === "win32"
      ? relativePath.toLocaleLowerCase()
      : relativePath;
  const receiptRoot =
    process.platform === "win32"
      ? RECEIPT_ROOT.toLocaleLowerCase()
      : RECEIPT_ROOT;
  return (
    normalized === ".pactile/runtime/receipts" ||
    normalized.startsWith(`${receiptRoot}/`)
  );
}

export function isExcludedPath(
  relative: string,
  excludedPaths: readonly string[],
): boolean {
  const normalized = relative.replaceAll("\\", "/");
  return excludedPaths.some((candidate) =>
    process.platform === "win32"
      ? candidate.replaceAll("\\", "/").toLocaleLowerCase() ===
        normalized.toLocaleLowerCase()
      : candidate.replaceAll("\\", "/") === normalized,
  );
}

export function mapFilesystemError(error: unknown): CapabilityNodeError {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new CapabilityNodeError(
      "NOT_FOUND",
      "Requested path was not found.",
    );
  }
  if (code === "ELOOP" || code === "EMLINK") {
    return new CapabilityNodeError(
      "OUT_OF_SCOPE",
      "The requested path changed into a symbolic link.",
    );
  }
  if (code === "EACCES" || code === "EPERM") {
    return new CapabilityNodeError(
      "PERMISSION_DENIED",
      "Access to the requested path was denied.",
    );
  }
  return new CapabilityNodeError(
    "EXECUTION_FAILED",
    "The filesystem operation failed.",
  );
}

export function stopReason(signal: AbortSignal): StopReason | null {
  if (!signal.aborted) return null;
  return signal.reason === "TIMEOUT" ? "TIMEOUT" : "CANCELLED";
}

export function stopResult(
  reason: StopReason,
  data: BoundedCapabilityDataV1 | null,
): OperationResult {
  const code = reason;
  return {
    data,
    outcome: reason === "TIMEOUT" ? "timed_out" : "cancelled",
    partial: data !== null,
    error: {
      code,
      message:
        reason === "TIMEOUT"
          ? "The request exceeded its time limit."
          : "The request was cancelled.",
    },
  };
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let output = "";
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}
