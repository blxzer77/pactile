import { Buffer } from "node:buffer";

import {
  PACTILE_INTENTS_V1,
  assuranceSatisfiesV1,
  fingerprintPactileContractV1,
  parseResolvedProviderV1,
  type AssuranceLevelV1,
  type PactileIntentV1,
  type ResolvedProviderV1,
} from "../../core/index.js";

import {
  RETRIEVAL_ABI_VERSION,
  RETRIEVAL_CORROBORATION_KINDS_V3,
  RETRIEVAL_PROVIDER_STATUSES_V3,
  RETRIEVAL_REASON_CODES_V3,
  type RetrievalClaimAssessmentInputV3,
  type RetrievalClaimAssessmentV3,
  type RetrievalEvidenceFactV3,
  type RetrievalPlanV3,
  type RetrievalProviderAvailabilityV3,
  type RetrievalProviderStatusV3,
  type RetrievalReasonCodeV3,
} from "./types.js";
import { snapshotPlainOwnDataRecordV3 } from "./boundary.js";
import { planRetrievalV3 } from "./planner.js";

const LOGICAL_REF =
  /^(artifact|evidence|source|git|test):\/\/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)$/;
const LOGICAL_KIND = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const SENSITIVE_REFERENCE_TERMS = new Set([
  "credential",
  "credentials",
  "passwd",
  "password",
  "secret",
  "token",
]);

function isSafeLogicalRef(value: string): boolean {
  if (value.length > 256) return false;
  const match = LOGICAL_REF.exec(value);
  if (!match) return false;
  return !match[2]
    .replaceAll("/", ".")
    .split(/[_.-]/u)
    .some((term) => SENSITIVE_REFERENCE_TERMS.has(term));
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function normalizeRefs(values: readonly unknown[]): readonly string[] | null {
  if (!Array.isArray(values) || values.length > 1024) return null;
  const output: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !isSafeLogicalRef(value)) return null;
    output.push(value);
  }
  return [...new Set(output)].sort(utf8Compare);
}

function normalizeFacts(
  values: readonly RetrievalEvidenceFactV3[],
): readonly RetrievalEvidenceFactV3[] | null {
  if (!Array.isArray(values) || values.length > 1024) return null;
  const output: RetrievalEvidenceFactV3[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort(utf8Compare);
    if (keys.length !== 2 || keys[0] !== "kind" || keys[1] !== "ref")
      return null;
    if (!("value" in descriptors.kind) || !("value" in descriptors.ref))
      return null;
    const kind = descriptors.kind.value;
    const ref = descriptors.ref.value;
    if (
      typeof kind !== "string" ||
      !LOGICAL_KIND.test(kind) ||
      typeof ref !== "string" ||
      !isSafeLogicalRef(ref)
    ) {
      return null;
    }
    const identity = `${kind}\0${ref}`;
    if (!seen.has(identity)) {
      seen.add(identity);
      output.push({ kind, ref });
    }
  }
  return output.sort((left, right) => {
    const byKind = utf8Compare(left.kind, right.kind);
    return byKind !== 0 ? byKind : utf8Compare(left.ref, right.ref);
  });
}

function validatedPlan(
  planInput: unknown,
  intent: PactileIntentV1,
): RetrievalPlanV3 | null {
  const record = snapshotPlainOwnDataRecordV3(planInput);
  if (!record) return null;
  const allowed = new Set([
    "schemaVersion",
    "query",
    "intents",
    "scopeHints",
    "minimumAssurance",
    "requestedPolicy",
    "requiredEvidenceKinds",
    "budget",
    "steps",
    "verificationChain",
    "stopReasons",
    "fingerprint",
  ]);
  if (
    Object.keys(record).length !== allowed.size ||
    Object.keys(record).some((key) => !allowed.has(key)) ||
    !Array.isArray(record.intents) ||
    !record.intents.includes(intent) ||
    !Array.isArray(record.steps) ||
    typeof record.fingerprint !== "string"
  ) {
    return null;
  }
  const request = {
    schemaVersion: record.schemaVersion,
    query: record.query,
    intents: record.intents,
    scopeHints: record.scopeHints,
    minimumAssurance: record.minimumAssurance,
    requestedPolicy: record.requestedPolicy,
    requiredEvidenceKinds: record.requiredEvidenceKinds,
    budget: record.budget,
  };
  const providerAvailability: RetrievalProviderAvailabilityV3[] = [];
  for (const candidate of record.steps) {
    const step = snapshotPlainOwnDataRecordV3(candidate);
    if (!step) return null;
    const requirement = step.providerRequirement;
    if (requirement === null) continue;
    const provider = snapshotPlainOwnDataRecordV3(requirement);
    if (!provider) return null;
    if (
      !["semantic", "structural", "external"].includes(
        provider.intent as string,
      ) ||
      !RETRIEVAL_PROVIDER_STATUSES_V3.includes(
        provider.status as (typeof RETRIEVAL_PROVIDER_STATUSES_V3)[number],
      )
    ) {
      return null;
    }
    if (provider.status !== "resolution-required") {
      const status = provider.status as Exclude<
        RetrievalProviderStatusV3,
        "resolution-required"
      >;
      providerAvailability.push({
        intent: provider.intent as Exclude<PactileIntentV1, "exact">,
        status,
        readiness: status === "unsupported" ? "unavailable" : status,
      });
    }
  }
  const replanned = planRetrievalV3(request, { providerAvailability });
  if (
    !replanned.success ||
    fingerprintPactileContractV1(replanned.data) !==
      fingerprintPactileContractV1(planInput)
  ) {
    return null;
  }
  return replanned.data;
}

const STRICT_RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|[+-](\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isStrictRfc3339Timestamp(value: string): boolean {
  const match = STRICT_RFC3339_TIMESTAMP.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day >= 1 && day <= daysInMonth[month - 1];
}

function resolutionForPlan(
  plan: RetrievalPlanV3,
  intent: Exclude<PactileIntentV1, "exact">,
  resolutionInput: unknown,
): ResolvedProviderV1 | null {
  const parsed = parseResolvedProviderV1(resolutionInput);
  if (!parsed.success) return null;
  const resolution = parsed.data;
  if (
    resolution.intent !== intent ||
    resolution.minimumAssurance !== plan.minimumAssurance ||
    resolution.origin === "unsupported" ||
    resolution.readiness !== "ready" ||
    resolution.assurance === null ||
    !assuranceSatisfiesV1(resolution.assurance, plan.minimumAssurance) ||
    fingerprintPactileContractV1(resolution.requestedPolicy) !==
      fingerprintPactileContractV1(plan.requestedPolicy) ||
    (resolution.probedAt !== null &&
      !isStrictRfc3339Timestamp(resolution.probedAt))
  ) {
    return null;
  }
  return resolution;
}

function sortedReasons(
  values: readonly RetrievalReasonCodeV3[],
): readonly RetrievalReasonCodeV3[] {
  const rank = new Map(
    RETRIEVAL_REASON_CODES_V3.map((value, index) => [value, index]),
  );
  return [...new Set(values)].sort(
    (left, right) => (rank.get(left) ?? 999) - (rank.get(right) ?? 999),
  );
}

function rejected(
  intent: PactileIntentV1,
  reasons: readonly RetrievalReasonCodeV3[],
  evidenceRefs: readonly string[] = [],
): RetrievalClaimAssessmentV3 {
  return {
    schemaVersion: RETRIEVAL_ABI_VERSION,
    intent,
    accepted: false,
    achievedAssurance: null,
    evidenceRefs,
    reasonCodes: sortedReasons(reasons),
  };
}

function providerStepBlocks(
  plan: RetrievalPlanV3,
  intent: PactileIntentV1,
): RetrievalReasonCodeV3 | null {
  const step = plan.steps.find((candidate) => candidate.intent === intent);
  const status = step?.providerRequirement?.status;
  if (status === "degraded") return "provider-degraded";
  if (status === "unavailable") return "provider-unavailable";
  if (status === "unsupported") return "provider-unsupported";
  return null;
}

function targetAssurance(
  requested: AssuranceLevelV1,
  hasCorroboration: boolean,
  hasRepeatableTest: boolean,
): AssuranceLevelV1 | null {
  if (requested === "best-effort") return "best-effort";
  if (!hasCorroboration) return null;
  if (requested === "evidence-backed") return "evidence-backed";
  return hasRepeatableTest ? "verified" : null;
}

/**
 * Assess whether collected facts satisfy a neutral V3 plan.
 *
 * `providerScore` is intentionally never read: ranking confidence is not
 * evidence and cannot upgrade assurance.
 */
export function assessRetrievalClaimV3(
  input: RetrievalClaimAssessmentInputV3,
): RetrievalClaimAssessmentV3 {
  let intent: PactileIntentV1 = "exact";
  try {
    const record = snapshotPlainOwnDataRecordV3(input);
    if (!record) {
      return rejected(intent, ["invalid-evidence"]);
    }
    const allowed = new Set([
      "plan",
      "intent",
      "candidateRefs",
      "corroboration",
      "resolution",
      "providerScore",
    ]);
    if (Object.keys(record).some((key) => !allowed.has(key))) {
      return rejected(intent, ["invalid-evidence"]);
    }
    if (!PACTILE_INTENTS_V1.includes(record.intent as PactileIntentV1)) {
      return rejected(intent, ["invalid-evidence"]);
    }
    intent = record.intent as PactileIntentV1;
    const plan = validatedPlan(record.plan, intent);
    if (!plan) return rejected(intent, ["invalid-plan"]);

    const candidateRefs = normalizeRefs(record.candidateRefs as never);
    const facts = normalizeFacts(record.corroboration as never);
    if (!candidateRefs || !facts) return rejected(intent, ["invalid-evidence"]);
    const evidenceRefs = [
      ...new Set([...candidateRefs, ...facts.map((fact) => fact.ref)]),
    ].sort(utf8Compare);
    const reasons: RetrievalReasonCodeV3[] = [];
    if (candidateRefs.length === 0) reasons.push("candidate-missing");

    const factKinds = new Set(facts.map((fact) => fact.kind));
    for (const requiredKind of plan.requiredEvidenceKinds) {
      if (!factKinds.has(requiredKind))
        reasons.push("required-evidence-missing");
    }
    const hasCorroboration = facts.some((fact) =>
      RETRIEVAL_CORROBORATION_KINDS_V3.includes(
        fact.kind as (typeof RETRIEVAL_CORROBORATION_KINDS_V3)[number],
      ),
    );
    const hasRepeatableTest = facts.some(
      (fact) => fact.kind === "repeatable-test",
    );
    if (intent !== "exact" && !hasCorroboration)
      reasons.push("corroboration-required");

    const blockingStatus = providerStepBlocks(plan, intent);
    if (blockingStatus) reasons.push(blockingStatus);

    let resolution: ResolvedProviderV1 | null = null;
    if (intent !== "exact") {
      resolution = resolutionForPlan(plan, intent, record.resolution);
      if (!resolution) reasons.push("minimum-assurance-not-met");
    }

    const achieved = targetAssurance(
      plan.minimumAssurance,
      hasCorroboration,
      hasRepeatableTest,
    );
    if (!achieved) {
      reasons.push(
        plan.minimumAssurance === "verified"
          ? "repeatable-verification-required"
          : "minimum-assurance-not-met",
      );
    }
    if (
      plan.minimumAssurance === "verified" &&
      intent !== "exact" &&
      resolution?.assurance !== "verified"
    ) {
      reasons.push("verified-provider-proof-required");
    }
    if (reasons.length > 0 || achieved === null) {
      return rejected(intent, reasons, evidenceRefs);
    }
    return {
      schemaVersion: RETRIEVAL_ABI_VERSION,
      intent,
      accepted: true,
      achievedAssurance: achieved,
      evidenceRefs,
      reasonCodes: [],
    };
  } catch {
    return rejected(intent, ["invalid-evidence"]);
  }
}
