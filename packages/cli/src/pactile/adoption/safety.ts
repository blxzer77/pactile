import { createHash } from "node:crypto";
import { parseInstallHintV1 } from "../../core/index.js";

/** Deliberately no prose, exception text, caller keys, paths, or raw values. */
export interface AdoptionDiagnostic {
  readonly code:
    | "invalid-input"
    | "invalid-context"
    | "invalid-asset"
    | "identity-conflict"
    | "ambiguous-id"
    | "outside-allowlist"
    | "link-not-followed"
    | "unavailable"
    | "invalid-binding";
  readonly path:
    | "input"
    | "context"
    | "assets"
    | "roots"
    | "entries"
    | "binding"
    | "hint";
}

const boundaryFailures = new WeakMap<object, AdoptionDiagnostic>();

class BoundaryFailure extends Error {
  constructor(diagnostic: AdoptionDiagnostic) {
    super(diagnostic.code);
    boundaryFailures.set(this, diagnostic);
  }
}

export function fail(
  code: AdoptionDiagnostic["code"],
  path: AdoptionDiagnostic["path"],
): never {
  throw new BoundaryFailure({ code, path });
}

export function diagnostic(
  error: unknown,
  code: AdoptionDiagnostic["code"],
  path: AdoptionDiagnostic["path"],
): AdoptionDiagnostic {
  // Even instanceof could execute a thrown Proxy's getPrototypeOf trap. Only
  // recognize errors by identity; never inspect caller-controlled error objects.
  return (
    (typeof error === "object" && error !== null
      ? boundaryFailures.get(error)
      : undefined) ?? { code, path }
  );
}

/** Only own data descriptors: never invoke an untrusted getter or enumerate secret keys. */
export function field(value: unknown, key: string): unknown {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !("value" in descriptor)) fail("invalid-input", "input");
    return descriptor?.value;
  } catch {
    return fail("invalid-input", "input");
  }
}

export function items(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail("invalid-input", "input");
  const length: unknown = Object.getOwnPropertyDescriptor(
    value,
    "length",
  )?.value;
  if (typeof length !== "number" || length > 1024)
    fail("invalid-input", "input");
  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) fail("invalid-input", "input");
    return descriptor.value as unknown;
  });
}

/** Reuse the M0 logical-id decoder via its bounded symbolic label contract. */
export function logicalId(value: unknown): string {
  if (typeof value !== "string" || value.length > 128)
    fail("invalid-input", "input");
  const normalized = value.normalize("NFC").toLowerCase();
  const parsed = parseInstallHintV1({
    schemaVersion: 1,
    mechanism: "manual",
    label: normalized,
    reference: null,
    requiresAuthentication: false,
  });
  if (!parsed.success) fail("invalid-input", "input");
  return parsed.data.label;
}

export function member<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value))
    fail("invalid-input", "input");
  return value;
}

export function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") fail("invalid-input", "input");
  return value;
}

/** Only call with newly allocated whitelisted records, never caller objects. */
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function order(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function diagnostics(
  values: readonly AdoptionDiagnostic[],
): AdoptionDiagnostic[] {
  const unique = new Map(values.map((value) => [JSON.stringify(value), value]));
  return [...unique.entries()]
    .sort(([a], [b]) => order(a, b))
    .map(([, value]) => value);
}
