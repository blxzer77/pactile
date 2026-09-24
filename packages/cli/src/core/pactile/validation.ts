import { createHash } from "node:crypto";

export const PACTILE_CONTRACT_SCHEMA_VERSION = 1 as const;

export type PactileContractIssueCodeV1 =
  | "required"
  | "unknown-field"
  | "invalid-type"
  | "invalid-value"
  | "invalid-enum"
  | "duplicate"
  | "policy-violation"
  | "conflict";

export interface PactileContractIssueV1 {
  readonly code: PactileContractIssueCodeV1;
  readonly path: string;
  readonly message: string;
}

export interface PactileContractParseSuccessV1<T> {
  readonly success: true;
  readonly data: T;
  readonly fingerprint: string;
}

export interface PactileContractParseFailureV1 {
  readonly success: false;
  readonly issues: readonly PactileContractIssueV1[];
}

export type PactileContractParseResultV1<T> =
  | PactileContractParseSuccessV1<T>
  | PactileContractParseFailureV1;

export interface PactileContractSchemaV1<T> {
  readonly kind: string;
  readonly schemaVersion: typeof PACTILE_CONTRACT_SCHEMA_VERSION;
  parse(input: unknown): PactileContractParseResultV1<T>;
  fingerprint(value: T): string;
}

export type PactileJsonPrimitiveV1 = string | number | boolean | null;
export type PactileJsonValueV1 =
  | PactileJsonPrimitiveV1
  | readonly PactileJsonValueV1[]
  | { readonly [key: string]: PactileJsonValueV1 };

type DecoderV1<T> = (
  input: unknown,
  decoder: ContractDecoderV1,
  path: string,
) => T;

/**
 * Stable JSON used by every Pactile v1 contract fingerprint.
 *
 * Object keys are sorted recursively, array order is retained, and no
 * insignificant whitespace is emitted. Only finite JSON values are accepted.
 */
export function canonicalizePactileJsonV1(value: unknown): string {
  return canonicalJson(value, "$", new Set<object>());
}

/** Return `sha256:<lowercase hex>` for the stable Pactile JSON encoding. */
export function fingerprintPactileContractV1(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalizePactileJsonV1(value), "utf8")
    .digest("hex")}`;
}

export function definePactileContractSchemaV1<T>(
  kind: string,
  decode: DecoderV1<T>,
): PactileContractSchemaV1<T> {
  return {
    kind,
    schemaVersion: PACTILE_CONTRACT_SCHEMA_VERSION,
    parse(input: unknown): PactileContractParseResultV1<T> {
      const decoder = new ContractDecoderV1();
      const data = decode(input, decoder, "$");
      if (decoder.issues.length > 0) {
        return { success: false, issues: decoder.issues };
      }
      return {
        success: true,
        data,
        fingerprint: fingerprintPactileContractV1(data),
      };
    },
    fingerprint(value: T): string {
      return fingerprintPactileContractV1(value);
    },
  };
}

export class ContractDecoderV1 {
  readonly issues: PactileContractIssueV1[] = [];

  issue(code: PactileContractIssueCodeV1, path: string, message: string): void {
    this.issues.push({ code, path, message });
  }

  object(
    value: unknown,
    path: string,
    allowedKeys: readonly string[],
  ): Record<string, unknown> {
    if (!isPlainRecordV1(value)) {
      this.issue("invalid-type", path, "must be a JSON object");
      return {};
    }
    const allowed = new Set(allowedKeys);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        this.issue(
          "unknown-field",
          childPathV1(path, key),
          `field '${key}' is not part of the v1 contract`,
        );
      }
    }
    return value;
  }

  required(
    record: Record<string, unknown>,
    key: string,
    path: string,
  ): unknown {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      this.issue("required", childPathV1(path, key), "is required");
      return undefined;
    }
    return record[key];
  }

  optional(record: Record<string, unknown>, key: string): unknown {
    return Object.prototype.hasOwnProperty.call(record, key)
      ? record[key]
      : undefined;
  }

  literal<T extends string | number | boolean>(
    value: unknown,
    expected: T,
    path: string,
  ): T {
    if (value !== expected) {
      this.issue(
        "invalid-value",
        path,
        `must be the literal ${JSON.stringify(expected)}`,
      );
    }
    return expected;
  }

  string(
    value: unknown,
    path: string,
    options: {
      readonly nonEmpty?: boolean;
      readonly pattern?: RegExp;
      readonly patternDescription?: string;
    } = {},
  ): string {
    if (typeof value !== "string") {
      this.issue("invalid-type", path, "must be a string");
      return "";
    }
    if (options.nonEmpty === true && value.trim().length === 0) {
      this.issue("invalid-value", path, "must not be empty");
    }
    if (options.pattern && !options.pattern.test(value)) {
      this.issue(
        "invalid-value",
        path,
        `must be ${options.patternDescription ?? "in the required format"}`,
      );
    }
    return value;
  }

  nullableString(
    value: unknown,
    path: string,
    options: {
      readonly nonEmpty?: boolean;
      readonly pattern?: RegExp;
      readonly patternDescription?: string;
    } = {},
  ): string | null {
    if (value === null) return null;
    return this.string(value, path, options);
  }

  boolean(value: unknown, path: string): boolean {
    if (typeof value !== "boolean") {
      this.issue("invalid-type", path, "must be a boolean");
      return false;
    }
    return value;
  }

  integer(
    value: unknown,
    path: string,
    options: { readonly min?: number; readonly max?: number } = {},
  ): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      this.issue("invalid-type", path, "must be a safe integer");
      return 0;
    }
    if (options.min !== undefined && value < options.min) {
      this.issue("invalid-value", path, `must be at least ${options.min}`);
    }
    if (options.max !== undefined && value > options.max) {
      this.issue("invalid-value", path, `must be at most ${options.max}`);
    }
    return value;
  }

  enumValue<T extends string>(
    value: unknown,
    values: readonly T[],
    path: string,
  ): T {
    if (typeof value !== "string" || !values.includes(value as T)) {
      this.issue("invalid-enum", path, `must be one of: ${values.join(", ")}`);
      return values[0] as T;
    }
    return value as T;
  }

  array<T>(
    value: unknown,
    path: string,
    decodeItem: (value: unknown, path: string, index: number) => T,
  ): T[] {
    if (!Array.isArray(value)) {
      this.issue("invalid-type", path, "must be an array");
      return [];
    }
    return value.map((item, index) =>
      decodeItem(item, `${path}[${index}]`, index),
    );
  }

  stringArray(
    value: unknown,
    path: string,
    options: {
      readonly nonEmptyItems?: boolean;
      readonly unique?: boolean;
      readonly pattern?: RegExp;
      readonly patternDescription?: string;
    } = {},
  ): string[] {
    const values = this.array(value, path, (item, itemPath) =>
      this.string(item, itemPath, {
        nonEmpty: options.nonEmptyItems,
        pattern: options.pattern,
        patternDescription: options.patternDescription,
      }),
    );
    if (options.unique === true) {
      this.unique(values, (item) => item, path, "value");
    }
    return values;
  }

  unique<T>(
    values: readonly T[],
    keyOf: (value: T) => string,
    path: string,
    label: string,
  ): void {
    const seen = new Map<string, number>();
    values.forEach((value, index) => {
      const key = keyOf(value);
      const firstIndex = seen.get(key);
      if (firstIndex !== undefined) {
        this.issue(
          "duplicate",
          `${path}[${index}]`,
          `duplicate ${label} '${key}' (first declared at ${path}[${firstIndex}])`,
        );
        return;
      }
      seen.set(key, index);
    });
  }
}

export const PACTILE_LOGICAL_ID_PATTERN =
  /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;

export const PACTILE_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;

export const PACTILE_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

const PACTILE_OPAQUE_REFERENCE_PATTERN =
  /^([a-z][a-z0-9-]{0,31}):\/\/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)$/;
const PACTILE_OPAQUE_REFERENCE_MAX_LENGTH = 256;
const PACTILE_SENSITIVE_REFERENCE_TERMS = new Set([
  "credential",
  "credentials",
  "passwd",
  "password",
  "secret",
  "token",
]);

function containsSensitiveReferenceTermV1(payload: string): boolean {
  return payload
    .replaceAll("/", ".")
    .split(/[_.-]/u)
    .some((term) => PACTILE_SENSITIVE_REFERENCE_TERMS.has(term));
}

export function decodeSchemaVersionV1(
  record: Record<string, unknown>,
  decoder: ContractDecoderV1,
  path: string,
): typeof PACTILE_CONTRACT_SCHEMA_VERSION {
  return decoder.literal(
    decoder.required(record, "schemaVersion", path),
    PACTILE_CONTRACT_SCHEMA_VERSION,
    childPathV1(path, "schemaVersion"),
  );
}

export function decodeLogicalIdV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): string {
  return decoder.string(value, path, {
    nonEmpty: true,
    pattern: PACTILE_LOGICAL_ID_PATTERN,
    patternDescription:
      "a lowercase logical id using '.', '_', ':', or '-' separators",
  });
}

export function decodeSemverV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): string {
  return decoder.string(value, path, {
    nonEmpty: true,
    pattern: PACTILE_SEMVER_PATTERN,
    patternDescription: "a semantic version",
  });
}

export function decodeFingerprintV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): string {
  return decoder.string(value, path, {
    pattern: PACTILE_FINGERPRINT_PATTERN,
    patternDescription: "a sha256:<lowercase hex> fingerprint",
  });
}

export function decodeNullableFingerprintV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): string | null {
  if (value === null) return null;
  return decodeFingerprintV1(value, decoder, path);
}

/**
 * Decode a scheme-scoped logical reference, never a network URL or inline
 * payload. Query strings, fragments, user-info, percent encoding, whitespace,
 * and arbitrary prose are intentionally outside this grammar.
 */
export function decodeOpaqueReferenceV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
  allowedSchemes: readonly string[],
): string {
  const reference = decoder.string(value, path, { nonEmpty: true });
  if (reference.length > PACTILE_OPAQUE_REFERENCE_MAX_LENGTH) {
    decoder.issue(
      "invalid-value",
      path,
      `must be at most ${PACTILE_OPAQUE_REFERENCE_MAX_LENGTH} characters`,
    );
  }
  const match = PACTILE_OPAQUE_REFERENCE_PATTERN.exec(reference);
  if (match === null) {
    decoder.issue(
      "invalid-value",
      path,
      "must be a scheme-scoped logical reference without URL credentials, query, fragment, or inline content",
    );
    return reference;
  }
  const scheme = match[1] ?? "";
  const payload = match[2] ?? "";
  if (!allowedSchemes.includes(scheme)) {
    decoder.issue(
      "invalid-value",
      path,
      `must use one of these reference schemes: ${allowedSchemes.join(", ")}`,
    );
  }
  if (containsSensitiveReferenceTermV1(payload)) {
    decoder.issue(
      "invalid-value",
      path,
      "must be a non-secret registry handle without credential-bearing terms",
    );
  }
  return reference;
}

export function decodeTimestampV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): string {
  const timestamp = decoder.string(value, path, { nonEmpty: true });
  if (
    timestamp.length > 0 &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      timestamp,
    ) ||
      Number.isNaN(Date.parse(timestamp)))
  ) {
    decoder.issue("invalid-value", path, "must be an RFC 3339 timestamp");
  }
  return timestamp;
}

export function decodeNullableTimestampV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): string | null {
  if (value === null) return null;
  return decodeTimestampV1(value, decoder, path);
}

export function decodeRelativePosixPathV1(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): string {
  const candidate = decoder.string(value, path, { nonEmpty: true });
  if (candidate.length === 0) return candidate;
  const segments = candidate.split("/");
  if (
    candidate.includes("\\") ||
    candidate.startsWith("/") ||
    /^[A-Za-z]:/.test(candidate) ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    decoder.issue(
      "invalid-value",
      path,
      "must be a normalized project-relative POSIX path without traversal",
    );
  }
  return candidate;
}

export function childPathV1(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

export function isPlainRecordV1(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function canonicalJson(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must be a finite JSON number`);
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} must contain only JSON values`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} must not contain a circular reference`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((item, index) =>
          canonicalJson(item, `${path}[${index}]`, ancestors),
        )
        .join(",")}]`;
    }
    if (!isPlainRecordV1(value)) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }
    const members = Object.keys(value)
      .sort()
      .map((key) => {
        const child = value[key];
        return `${JSON.stringify(key)}:${canonicalJson(
          child,
          childPathV1(path, key),
          ancestors,
        )}`;
      });
    return `{${members.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
