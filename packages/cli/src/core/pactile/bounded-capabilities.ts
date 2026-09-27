import {
  ContractDecoderV1,
  childPathV1,
  decodeSchemaVersionV1,
  decodeRelativePosixPathV1,
  definePactileContractSchemaV1,
  isPlainRecordV1,
  type PactileContractIssueV1,
  type PactileContractParseResultV1,
} from "./validation.js";

export const BOUNDED_CAPABILITY_SCHEMA_VERSION_V1 = 1 as const;

export const BOUNDED_CAPABILITY_OPERATIONS_V1 = [
  "discover",
  "read",
  "search",
  "run",
] as const;
export type BoundedCapabilityOperationV1 =
  (typeof BOUNDED_CAPABILITY_OPERATIONS_V1)[number];

export const BOUNDED_CAPABILITY_OUTCOMES_V1 = [
  "complete",
  "empty",
  "partial",
  "out_of_scope",
  "timed_out",
  "cancelled",
  "failed",
] as const;
export type BoundedCapabilityOutcomeV1 =
  (typeof BOUNDED_CAPABILITY_OUTCOMES_V1)[number];

export const BOUNDED_CAPABILITY_ERROR_CODES_V1 = [
  "OUT_OF_SCOPE",
  "NOT_FOUND",
  "PERMISSION_DENIED",
  "TIMEOUT",
  "CANCELLED",
  "OUTPUT_LIMIT",
  "SCAN_LIMIT",
  "FILE_TOO_LARGE",
  "EXECUTION_FAILED",
  "ADAPTER_UNAVAILABLE",
  "REQUEST_ID_REUSED",
  "REQUEST_CLAIM_RETAINED",
  "REQUEST_CLAIM_LIMIT",
  "RECEIPT_UNAVAILABLE",
] as const;
export type BoundedCapabilityErrorCodeV1 =
  (typeof BOUNDED_CAPABILITY_ERROR_CODES_V1)[number];

export interface BoundedCapabilityLimitsV1 {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxFilesScanned: number;
  readonly maxResults: number;
  readonly maxFileBytes: number;
  readonly maxBytesRead: number;
}

interface BoundedCapabilityRequestBaseV1 {
  readonly schemaVersion: typeof BOUNDED_CAPABILITY_SCHEMA_VERSION_V1;
  readonly requestId: string;
  readonly limits: BoundedCapabilityLimitsV1;
}

export interface DiscoverCapabilityRequestV1 extends BoundedCapabilityRequestBaseV1 {
  readonly operation: "discover";
  readonly directory: string | null;
  /** Zero-based page offset from the adapter's stable path ordering. */
  readonly offset: number;
}

export interface ReadCapabilityRequestV1 extends BoundedCapabilityRequestBaseV1 {
  readonly operation: "read";
  readonly path: string;
}

export interface SearchCapabilityRequestV1 extends BoundedCapabilityRequestBaseV1 {
  readonly operation: "search";
  readonly query: string;
  readonly directory: string | null;
  readonly caseSensitive: boolean;
  /** Zero-based match offset; continue with the prior result's nextPage. */
  readonly offset: number;
}

export interface RunCapabilityRequestV1 extends BoundedCapabilityRequestBaseV1 {
  readonly operation: "run";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | null;
}

export type BoundedCapabilityRequestV1 =
  | DiscoverCapabilityRequestV1
  | ReadCapabilityRequestV1
  | SearchCapabilityRequestV1
  | RunCapabilityRequestV1;

export interface BoundedCapabilityPolicyV1 {
  readonly allowedOperations: readonly BoundedCapabilityOperationV1[];
  readonly allowedCommands: readonly string[];
}

export interface CapabilityPolicyDecisionV1 {
  readonly allowed: boolean;
  readonly code: "OUT_OF_SCOPE" | null;
  readonly message: string | null;
}

export interface BoundedCapabilityFailureV1 {
  readonly code: BoundedCapabilityErrorCodeV1;
  readonly message: string;
}

export interface DiscoverCapabilityDataV1 {
  readonly files: readonly string[];
  readonly entriesScanned: number;
}

export interface ReadCapabilityDataV1 {
  readonly path: string;
  readonly content: string;
  readonly bytesRead: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

export interface SearchCapabilityMatchV1 {
  readonly path: string;
  readonly line: number;
  readonly preview: string;
}

export interface SearchCapabilityDataV1 {
  readonly matches: readonly SearchCapabilityMatchV1[];
  readonly filesScanned: number;
  readonly bytesRead: number;
}

export interface RunCapabilityDataV1 {
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly bytesCaptured: number;
  readonly truncated: boolean;
}

export type BoundedCapabilityDataV1 =
  | DiscoverCapabilityDataV1
  | ReadCapabilityDataV1
  | SearchCapabilityDataV1
  | RunCapabilityDataV1;

export interface BoundedCapabilityReceiptV1 {
  readonly schemaVersion: typeof BOUNDED_CAPABILITY_SCHEMA_VERSION_V1;
  readonly requestId: string;
  readonly operation: BoundedCapabilityOperationV1;
  readonly adapterId: string;
  readonly requestFingerprint: string;
  readonly resultFingerprint: string | null;
  readonly outcome: BoundedCapabilityOutcomeV1;
  readonly errorCode: BoundedCapabilityErrorCodeV1 | null;
  readonly entriesReturned: number;
  readonly bytesReturned: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly receiptRef: string;
}

export interface BoundedCapabilityResultV1 {
  readonly schemaVersion: typeof BOUNDED_CAPABILITY_SCHEMA_VERSION_V1;
  readonly requestId: string;
  readonly operation: BoundedCapabilityOperationV1;
  readonly outcome: BoundedCapabilityOutcomeV1;
  readonly partial: boolean;
  /** Offset for the next discover/search page, or null when exhausted. */
  readonly nextPage: number | null;
  readonly data: BoundedCapabilityDataV1 | null;
  readonly error: BoundedCapabilityFailureV1 | null;
  readonly receipt: BoundedCapabilityReceiptV1 | null;
}

export class BoundedCapabilityRequestValidationError extends Error {
  readonly issues: readonly PactileContractIssueV1[];

  constructor(issues: readonly PactileContractIssueV1[]) {
    super("PACTILE_BOUNDED_CAPABILITY_REQUEST_INVALID");
    this.name = "BoundedCapabilityRequestValidationError";
    this.issues = issues;
  }
}

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const MAX_QUERY_BYTES = 4096;
const WINDOWS_RESERVED_FILE_NAME =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function decodeLimits(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): BoundedCapabilityLimitsV1 {
  const record = decoder.object(value, path, [
    "timeoutMs",
    "maxOutputBytes",
    "maxFilesScanned",
    "maxResults",
    "maxFileBytes",
    "maxBytesRead",
  ]);
  return {
    timeoutMs: decoder.integer(
      decoder.required(record, "timeoutMs", path),
      childPathV1(path, "timeoutMs"),
      { min: 1, max: 120_000 },
    ),
    maxOutputBytes: decoder.integer(
      decoder.required(record, "maxOutputBytes", path),
      childPathV1(path, "maxOutputBytes"),
      { min: 2_048, max: 1_048_576 },
    ),
    maxFilesScanned: decoder.integer(
      decoder.required(record, "maxFilesScanned", path),
      childPathV1(path, "maxFilesScanned"),
      { min: 1, max: 10_000 },
    ),
    maxResults: decoder.integer(
      decoder.required(record, "maxResults", path),
      childPathV1(path, "maxResults"),
      { min: 1, max: 1_000 },
    ),
    maxFileBytes: decoder.integer(
      decoder.required(record, "maxFileBytes", path),
      childPathV1(path, "maxFileBytes"),
      { min: 1, max: 1_048_576 },
    ),
    maxBytesRead: decoder.integer(
      decoder.required(record, "maxBytesRead", path),
      childPathV1(path, "maxBytesRead"),
      { min: 1, max: 33_554_432 },
    ),
  };
}

function decodeOptionalPath(
  record: Record<string, unknown>,
  key: string,
  decoder: ContractDecoderV1,
  path: string,
): string | null {
  const value = decoder.optional(record, key);
  if (value === undefined || value === null) return null;
  return decodeWorkspacePath(value, decoder, childPathV1(path, key));
}

function decodePageOffset(
  record: Record<string, unknown>,
  decoder: ContractDecoderV1,
  path: string,
): number {
  return decoder.integer(
    decoder.optional(record, "offset") ?? 0,
    childPathV1(path, "offset"),
    { min: 0, max: 1_000_000 },
  );
}

function decodeWorkspacePath(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): string {
  const relative = decodeRelativePosixPathV1(value, decoder, path);
  if (!relative) return relative;
  const segments = relative.split("/");
  if (
    segments.some(
      (segment) =>
        segment.includes(":") ||
        segment.endsWith(".") ||
        WINDOWS_RESERVED_FILE_NAME.test(segment.replace(/[ .]+$/u, "")),
    )
  ) {
    decoder.issue(
      "invalid-value",
      path,
      "must not contain Windows alternate streams or reserved device names",
    );
  }
  return relative;
}

function decodeBoundedCapabilityRequestV1(
  input: unknown,
  decoder: ContractDecoderV1,
  path: string,
): BoundedCapabilityRequestV1 {
  const operation = decoder.enumValue(
    isPlainRecordV1(input) ? input.operation : undefined,
    BOUNDED_CAPABILITY_OPERATIONS_V1,
    childPathV1(path, "operation"),
  );
  const fields: Record<BoundedCapabilityOperationV1, readonly string[]> = {
    discover: ["directory", "offset"],
    read: ["path"],
    search: ["query", "directory", "caseSensitive", "offset"],
    run: ["command", "args", "cwd"],
  };
  const record = decoder.object(input, path, [
    "schemaVersion",
    "requestId",
    "operation",
    "limits",
    ...(fields[operation] ?? []),
  ]);
  const requestId = decoder.string(
    decoder.required(record, "requestId", path),
    childPathV1(path, "requestId"),
    {
      nonEmpty: true,
      pattern: REQUEST_ID,
      patternDescription: "a safe request id",
    },
  );
  if (WINDOWS_RESERVED_FILE_NAME.test(requestId) || requestId.endsWith(".")) {
    decoder.issue(
      "invalid-value",
      childPathV1(path, "requestId"),
      "must be safe as a receipt filename on Windows",
    );
  }
  const base = {
    schemaVersion: decodeSchemaVersionV1(record, decoder, path),
    requestId,
    limits: decodeLimits(
      decoder.required(record, "limits", path),
      decoder,
      childPathV1(path, "limits"),
    ),
  };
  switch (operation) {
    case "discover":
      return {
        ...base,
        operation,
        directory: decodeOptionalPath(record, "directory", decoder, path),
        offset: decodePageOffset(record, decoder, path),
      };
    case "read":
      return {
        ...base,
        operation,
        path: decodeWorkspacePath(
          decoder.required(record, "path", path),
          decoder,
          childPathV1(path, "path"),
        ),
      };
    case "search": {
      const query = decoder.string(
        decoder.required(record, "query", path),
        childPathV1(path, "query"),
        { nonEmpty: true },
      );
      if (Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES) {
        decoder.issue(
          "invalid-value",
          childPathV1(path, "query"),
          `must be at most ${MAX_QUERY_BYTES} UTF-8 bytes`,
        );
      }
      return {
        ...base,
        operation,
        query,
        directory: decodeOptionalPath(record, "directory", decoder, path),
        offset: decodePageOffset(record, decoder, path),
        caseSensitive: decoder.boolean(
          decoder.required(record, "caseSensitive", path),
          childPathV1(path, "caseSensitive"),
        ),
      };
    }
    case "run": {
      const args = decoder.stringArray(
        decoder.required(record, "args", path),
        childPathV1(path, "args"),
      );
      if (args.length > 64)
        decoder.issue(
          "invalid-value",
          childPathV1(path, "args"),
          "must contain at most 64 arguments",
        );
      if (
        args.some(
          (arg) => arg.includes("\0") || Buffer.byteLength(arg, "utf8") > 4096,
        )
      ) {
        decoder.issue(
          "invalid-value",
          childPathV1(path, "args"),
          "arguments must be NUL-free and at most 4096 UTF-8 bytes each",
        );
      }
      if (
        args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8"), 0) >
        16_384
      ) {
        decoder.issue(
          "invalid-value",
          childPathV1(path, "args"),
          "combined argument data must be at most 16384 UTF-8 bytes",
        );
      }
      return {
        ...base,
        operation,
        command: decoder.string(
          decoder.required(record, "command", path),
          childPathV1(path, "command"),
          {
            nonEmpty: true,
            pattern: COMMAND_ID,
            patternDescription: "a command id, not a path or shell expression",
          },
        ),
        args,
        cwd: decodeOptionalPath(record, "cwd", decoder, path),
      };
    }
  }
}

export const boundedCapabilityRequestV1Schema =
  definePactileContractSchemaV1<BoundedCapabilityRequestV1>(
    "bounded-capability-request",
    decodeBoundedCapabilityRequestV1,
  );

export function parseBoundedCapabilityRequestV1(
  input: unknown,
): PactileContractParseResultV1<BoundedCapabilityRequestV1> {
  return boundedCapabilityRequestV1Schema.parse(input);
}

export function authorizeBoundedCapabilityRequestV1(
  request: BoundedCapabilityRequestV1,
  policy: BoundedCapabilityPolicyV1,
): CapabilityPolicyDecisionV1 {
  if (!policy.allowedOperations.includes(request.operation)) {
    return {
      allowed: false,
      code: "OUT_OF_SCOPE",
      message: "The requested capability is outside the caller policy.",
    };
  }
  if (
    request.operation === "run" &&
    !policy.allowedCommands.includes(request.command)
  ) {
    return {
      allowed: false,
      code: "OUT_OF_SCOPE",
      message: "The requested command is outside the caller allowlist.",
    };
  }
  return { allowed: true, code: null, message: null };
}
