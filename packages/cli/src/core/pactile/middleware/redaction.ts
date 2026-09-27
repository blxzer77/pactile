const EVIDENCE_REFERENCE_PATTERN =
  /^evidence:\/\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const POLICY_DESTINATION_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?$/;
const SENSITIVE_REFERENCE_TERMS = new Set([
  "credential",
  "credentials",
  "passwd",
  "password",
  "secret",
  "token",
]);

function containsSensitiveTerm(value: string): boolean {
  return value
    .replaceAll("/", ".")
    .replaceAll(":", ".")
    .split(/[_.-]/u)
    .some((term) => SENSITIVE_REFERENCE_TERMS.has(term));
}

export function isSafeEvidenceReferenceV1(value: string): boolean {
  return (
    value.length <= 256 &&
    EVIDENCE_REFERENCE_PATTERN.test(value) &&
    !containsSensitiveTerm(value.slice("evidence://".length))
  );
}

export function isSafePolicyDestinationV1(value: string): boolean {
  return (
    value.length <= 253 &&
    POLICY_DESTINATION_PATTERN.test(value) &&
    !containsSensitiveTerm(value)
  );
}

export function safeEvidenceReferenceV1(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return isSafeEvidenceReferenceV1(normalized) ? normalized : null;
}
