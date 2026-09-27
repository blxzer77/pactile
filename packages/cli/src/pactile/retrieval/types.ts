import type {
  AssuranceLevelV1,
  PactileIntentV1,
  PolicyCeilingV1,
  ProviderReadinessV1,
} from "../../core/index.js";

export const RETRIEVAL_ABI_VERSION = 3 as const;

export const RETRIEVAL_INTENT_ORDER = [
  "exact",
  "semantic",
  "structural",
  "external",
] as const satisfies readonly PactileIntentV1[];

export const RETRIEVAL_PROVIDER_STATUSES_V3 = [
  "resolution-required",
  "ready",
  "degraded",
  "unavailable",
  "unsupported",
] as const;

export type RetrievalProviderStatusV3 =
  (typeof RETRIEVAL_PROVIDER_STATUSES_V3)[number];

export const RETRIEVAL_REASON_CODES_V3 = [
  "invalid-plan",
  "invalid-evidence",
  "query-empty",
  "provider-resolution-required",
  "provider-degraded",
  "provider-unavailable",
  "provider-unsupported",
  "candidate-missing",
  "corroboration-required",
  "required-evidence-missing",
  "minimum-assurance-not-met",
  "verified-provider-proof-required",
  "repeatable-verification-required",
  "budget-exhausted",
] as const;

export type RetrievalReasonCodeV3 = (typeof RETRIEVAL_REASON_CODES_V3)[number];

export const RETRIEVAL_CORROBORATION_KINDS_V3 = [
  "source-reference",
  "git-evidence",
  "repeatable-test",
] as const;

export type RetrievalCorroborationKindV3 =
  (typeof RETRIEVAL_CORROBORATION_KINDS_V3)[number];

export interface RetrievalBudgetV3 {
  readonly maxSteps: number;
  readonly maxCandidatesPerStep: number;
}

export interface RetrievalRequestV3 {
  readonly schemaVersion: typeof RETRIEVAL_ABI_VERSION;
  readonly query: string;
  readonly intents: readonly PactileIntentV1[];
  readonly scopeHints: readonly string[];
  readonly minimumAssurance: AssuranceLevelV1;
  readonly requestedPolicy: PolicyCeilingV1;
  readonly requiredEvidenceKinds: readonly string[];
  readonly budget: RetrievalBudgetV3;
}

export interface RetrievalProviderRequirementV3 {
  readonly intent: Exclude<PactileIntentV1, "exact">;
  readonly minimumAssurance: AssuranceLevelV1;
  readonly requestedPolicy: PolicyCeilingV1;
  readonly requiredEvidenceKinds: readonly string[];
  readonly status: RetrievalProviderStatusV3;
}

export interface RetrievalStepV3 {
  readonly order: number;
  readonly intent: PactileIntentV1;
  readonly kind: "local-exact" | "provider-request";
  readonly localToolHint: "rg" | null;
  readonly providerRequirement: RetrievalProviderRequirementV3 | null;
  readonly outputRole: "candidate";
}

export interface RetrievalVerificationStageV3 {
  readonly order: number;
  readonly stage:
    | "candidate"
    | "corroborate"
    | "classify-evidence"
    | "check-assurance"
    | "accept-or-stop";
  readonly required: true;
  readonly acceptableEvidenceKinds: readonly RetrievalCorroborationKindV3[];
}

export interface RetrievalStopReasonV3 {
  readonly code: RetrievalReasonCodeV3;
  readonly intent: PactileIntentV1 | null;
  readonly blocking: boolean;
}

export interface RetrievalPlanV3 {
  readonly schemaVersion: typeof RETRIEVAL_ABI_VERSION;
  readonly query: string;
  readonly intents: readonly PactileIntentV1[];
  readonly scopeHints: readonly string[];
  readonly minimumAssurance: AssuranceLevelV1;
  readonly requestedPolicy: PolicyCeilingV1;
  readonly requiredEvidenceKinds: readonly string[];
  readonly budget: RetrievalBudgetV3;
  readonly steps: readonly RetrievalStepV3[];
  readonly verificationChain: readonly RetrievalVerificationStageV3[];
  readonly stopReasons: readonly RetrievalStopReasonV3[];
  readonly fingerprint: string;
}

export interface RetrievalProviderAvailabilityV3 {
  readonly intent: Exclude<PactileIntentV1, "exact">;
  readonly status: Exclude<RetrievalProviderStatusV3, "resolution-required">;
  /** B0 readiness may be supplied by Middleware without exposing an identity. */
  readonly readiness?: ProviderReadinessV1;
}

export interface RetrievalPlanningContextV3 {
  readonly providerAvailability?: readonly RetrievalProviderAvailabilityV3[];
}

export type RetrievalValidationIssueCodeV3 =
  | "invalid-type"
  | "invalid-value"
  | "unknown-field"
  | "missing-field"
  | "duplicate-value"
  | "limit-exceeded"
  | "policy-violation";

export interface RetrievalValidationIssueV3 {
  readonly code: RetrievalValidationIssueCodeV3;
  readonly path: string;
  readonly message: string;
}

export type RetrievalParseResultV3<T> =
  | {
      readonly success: true;
      readonly data: T;
    }
  | {
      readonly success: false;
      readonly issues: readonly RetrievalValidationIssueV3[];
    };

export interface RetrievalEvidenceFactV3 {
  readonly kind: string;
  readonly ref: string;
}

export interface RetrievalClaimAssessmentInputV3 {
  readonly plan: RetrievalPlanV3;
  readonly intent: PactileIntentV1;
  readonly candidateRefs: readonly string[];
  readonly corroboration: readonly RetrievalEvidenceFactV3[];
  /** Parsed against the frozen M0 ResolvedProviderV1 contract when required. */
  readonly resolution?: unknown;
  /** Accepted for compatibility but never contributes to assurance. */
  readonly providerScore?: number;
}

export interface RetrievalClaimAssessmentV3 {
  readonly schemaVersion: typeof RETRIEVAL_ABI_VERSION;
  readonly intent: PactileIntentV1;
  readonly accepted: boolean;
  readonly achievedAssurance: AssuranceLevelV1 | null;
  readonly evidenceRefs: readonly string[];
  readonly reasonCodes: readonly RetrievalReasonCodeV3[];
}
