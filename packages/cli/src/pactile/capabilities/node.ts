import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  authorizeBoundedCapabilityRequestV1,
  BoundedCapabilityRequestValidationError,
  fingerprintPactileContractV1,
  parseBoundedCapabilityRequestV1,
  type BoundedCapabilityDataV1,
  type BoundedCapabilityFailureV1,
  type BoundedCapabilityPolicyV1,
  type BoundedCapabilityReceiptV1,
  type BoundedCapabilityRequestV1,
  type BoundedCapabilityResultV1,
} from "../../core/index.js";
import {
  CapabilityNodeError,
  RECEIPT_ROOT,
  jsonBytes,
  stopResult,
  type OperationResult,
} from "./shared.js";
import { runCommand } from "./command.js";
import { discover } from "./discover.js";
import { readFileCapability } from "./read.js";
import { search } from "./search.js";
import { claimRequestId } from "./claim.js";
import {
  ensureReceiptDirectory,
  writeReceipt,
  type ReceiptClaim,
} from "./receipts.js";

function publicFailure(error: unknown): BoundedCapabilityFailureV1 {
  if (error instanceof CapabilityNodeError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "EXECUTION_FAILED",
    message: "The capability operation failed.",
  };
}

function failureResult(error: unknown): OperationResult {
  const failure = publicFailure(error);
  return {
    data: null,
    outcome: failure.code === "OUT_OF_SCOPE" ? "out_of_scope" : "failed",
    partial: false,
    error: failure,
  };
}

function resultEntries(data: BoundedCapabilityDataV1 | null): number {
  if (!data) return 0;
  if ("files" in data) return data.files.length;
  if ("matches" in data) return data.matches.length;
  return 1;
}

function makeResult(
  request: BoundedCapabilityRequestV1,
  operation: OperationResult,
  receipt: BoundedCapabilityReceiptV1 | null,
): BoundedCapabilityResultV1 {
  const fallbackError = operation.error ?? null;
  const outcome = operation.outcome ?? (operation.data ? "complete" : "empty");
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    operation: request.operation,
    outcome,
    partial: operation.partial ?? outcome === "partial",
    nextPage: operation.nextPage ?? null,
    data: operation.data,
    error: fallbackError,
    receipt,
  };
}

function requestIdConflict(
  request: BoundedCapabilityRequestV1,
): BoundedCapabilityResultV1 {
  return makeResult(
    request,
    {
      data: null,
      outcome: "failed",
      partial: false,
      error: {
        code: "REQUEST_ID_REUSED",
        message: "This request id is in progress or has already been used.",
      },
    },
    null,
  );
}

export interface ExecuteBoundedCapabilityOptionsV1 {
  readonly root: string;
  readonly policy: BoundedCapabilityPolicyV1;
  readonly signal?: AbortSignal;
  readonly adapterId?: string;
  /** Additional workspace-relative control files omitted from discover/search. */
  readonly excludedPaths?: readonly string[];
}

/** Execute a validated, workspace-relative request with the built-in Node adapter. */
export async function executeNodeCapabilityRequestV1(
  input: unknown,
  options: ExecuteBoundedCapabilityOptionsV1,
): Promise<BoundedCapabilityResultV1> {
  const parsed = parseBoundedCapabilityRequestV1(input);
  if (!parsed.success) {
    throw new BoundedCapabilityRequestValidationError(parsed.issues);
  }
  const request = parsed.data;
  const root = await fsp.realpath(path.resolve(options.root));
  const startedAt = new Date();
  const started = performance.now();
  // Establish the receipt boundary and claim this id before any capability can
  // run. A pre-existing symlinked receipt directory must never permit an
  // operation to execute before we discover that the audit write is unsafe.
  const receiptDirectory = await ensureReceiptDirectory(root);
  let receiptClaim: ReceiptClaim;
  try {
    receiptClaim = await claimRequestId(
      root,
      receiptDirectory,
      request.requestId,
    );
  } catch (error) {
    if (
      error instanceof CapabilityNodeError &&
      error.code === "REQUEST_ID_REUSED"
    ) {
      return requestIdConflict(request);
    }
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "EEXIST"
    ) {
      return requestIdConflict(request);
    }
    if (
      error instanceof CapabilityNodeError &&
      (error.code === "REQUEST_CLAIM_RETAINED" ||
        error.code === "REQUEST_CLAIM_LIMIT")
    ) {
      return makeResult(
        request,
        {
          data: null,
          outcome: "failed",
          partial: false,
          error: { code: error.code, message: error.message },
        },
        null,
      );
    }
    throw error;
  }
  let operation: OperationResult;
  const decision = authorizeBoundedCapabilityRequestV1(request, options.policy);
  if (!decision.allowed) {
    operation = {
      data: null,
      outcome: "out_of_scope",
      partial: false,
      error: {
        code: "OUT_OF_SCOPE",
        message:
          decision.message ?? "The request is outside the caller policy.",
      },
    };
  } else {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = (): void => controller.abort("CANCELLED");
    if (options.signal?.aborted) abortFromCaller();
    else
      options.signal?.addEventListener("abort", abortFromCaller, {
        once: true,
      });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort("TIMEOUT");
    }, request.limits.timeoutMs);
    try {
      if (controller.signal.aborted) {
        operation = stopResult(timedOut ? "TIMEOUT" : "CANCELLED", null);
      } else {
        switch (request.operation) {
          case "discover":
            operation = await discover(
              root,
              request,
              controller.signal,
              options.excludedPaths ?? [],
            );
            break;
          case "read":
            operation = await readFileCapability(
              root,
              request,
              controller.signal,
            );
            break;
          case "search":
            operation = await search(
              root,
              request,
              controller.signal,
              options.excludedPaths ?? [],
            );
            break;
          case "run":
            operation = await runCommand(root, request, controller.signal);
            break;
        }
      }
    } catch (error) {
      operation = failureResult(error);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
  const completedAt = new Date();
  const dataBytes = operation.data === null ? 0 : jsonBytes(operation.data);
  const receiptRef = path.posix.join(RECEIPT_ROOT, `${request.requestId}.json`);
  const receipt: BoundedCapabilityReceiptV1 = {
    schemaVersion: 1,
    requestId: request.requestId,
    operation: request.operation,
    adapterId:
      options.adapterId &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(options.adapterId)
        ? options.adapterId
        : "node",
    requestFingerprint: parsed.fingerprint,
    resultFingerprint:
      operation.data === null
        ? null
        : fingerprintPactileContractV1(operation.data),
    outcome: operation.outcome ?? (operation.data ? "complete" : "empty"),
    errorCode: operation.error?.code ?? null,
    entriesReturned: resultEntries(operation.data),
    bytesReturned: dataBytes,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    receiptRef,
  };
  let boundedReceipt = receipt;
  let result = makeResult(request, operation, boundedReceipt);
  if (jsonBytes(result) + 1 > request.limits.maxOutputBytes) {
    operation = {
      data: null,
      outcome: "partial",
      partial: true,
      nextPage: null,
      error: {
        code: "OUTPUT_LIMIT",
        message: "The complete response reached its output-byte limit.",
      },
    };
    boundedReceipt = {
      ...receipt,
      resultFingerprint: null,
      outcome: "partial",
      errorCode: "OUTPUT_LIMIT",
      entriesReturned: 0,
      bytesReturned: 0,
    };
    result = makeResult(request, operation, boundedReceipt);
  }
  if (jsonBytes(result) + 1 > request.limits.maxOutputBytes) {
    await receiptClaim.handle.close();
    throw new CapabilityNodeError(
      "OUTPUT_LIMIT",
      "The request output budget is too small for its bounded receipt envelope.",
    );
  }
  try {
    await writeReceipt(root, receiptDirectory, receiptClaim, boundedReceipt);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "EEXIST"
    ) {
      return requestIdConflict(request);
    }
    throw error;
  }
  return result;
}

export function createDefaultCapabilityPolicyV1(
  allowedCommands: readonly string[] = [],
): BoundedCapabilityPolicyV1 {
  return {
    allowedOperations: ["discover", "read", "search", "run"],
    allowedCommands: [...new Set(allowedCommands)],
  };
}

export function defaultCapabilityLimitsV1(): BoundedCapabilityRequestV1["limits"] {
  return {
    timeoutMs: 30_000,
    maxOutputBytes: 128 * 1024,
    maxFilesScanned: 1_000,
    maxResults: 100,
    maxFileBytes: 256 * 1024,
    maxBytesRead: 2 * 1024 * 1024,
  };
}

export function createCapabilityRequestIdV1(): string {
  return randomUUID();
}
