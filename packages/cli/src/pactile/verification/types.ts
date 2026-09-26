/** Semantic risk signals supplied by the change author or a trusted change analyzer. */
export const VERIFICATION_RISKS = [
  "public-contract",
  "migration",
  "release",
  "permission-boundary",
  "data-egress",
] as const;

export type VerificationRisk = (typeof VERIFICATION_RISKS)[number];

export const VERIFICATION_SCOPES = [
  "single-area",
  "cross-module",
  "repository-wide",
] as const;

export type VerificationScope = (typeof VERIFICATION_SCOPES)[number];

export interface VerificationImpact {
  /** Semantic product/API seams changed, not a mechanically derived file list. */
  readonly changedSurfaces: readonly string[];
  readonly risks: readonly VerificationRisk[];
  readonly scope: VerificationScope;
}

export const BEHAVIOR_CHECK_MODES = [
  "focused",
  "integration",
  "migration",
  "release",
  "full-suite",
] as const;

export type BehaviorCheckMode = (typeof BEHAVIOR_CHECK_MODES)[number];

export interface BehaviorVerificationCheck {
  readonly kind: "behavior";
  readonly id: string;
  readonly title: string;
  readonly mode: BehaviorCheckMode;
  /** Only independently asserted public outcomes can satisfy behavior goals. */
  readonly evidence: "independent-public-behavior" | "implementation-mirror";
  readonly coversRisks: readonly VerificationRisk[];
  readonly coversSurfaces: readonly string[];
}

export interface RequiredPolicyCheck {
  readonly kind: "policy-ci";
  readonly id: string;
  readonly title: string;
  readonly requiredBy: readonly string[];
}

export type VerificationCheck = BehaviorVerificationCheck | RequiredPolicyCheck;

export interface VerificationGoal {
  readonly id: string;
  readonly kind: "surface" | "risk" | "scope";
  readonly label: string;
}

export type VerificationDecisionReason =
  | "required-by-policy"
  | "highest-value-uncovered-behavior"
  | "implementation-mirror"
  | "optional-policy-ci"
  | "no-relevant-goal"
  | "broad-check-not-warranted"
  | "already-covered";

export interface SelectedVerificationCheck {
  readonly checkId: string;
  readonly title: string;
  readonly reason: "required-by-policy" | "highest-value-uncovered-behavior";
  /** Goals this check contributed when it was selected. */
  readonly coversGoalIds: readonly string[];
  readonly requiredBy?: readonly string[];
}

export interface SkippedVerificationCheck {
  readonly checkId: string;
  readonly title: string;
  readonly reason: Exclude<
    VerificationDecisionReason,
    "required-by-policy" | "highest-value-uncovered-behavior"
  >;
  readonly relevantGoalIds: readonly string[];
  readonly detail: string;
}

export interface UncoveredVerificationGoal {
  readonly goal: VerificationGoal;
  readonly reason:
    | "no-registered-public-behavior-check"
    | "only-implementation-mirror"
    | "only-broader-check-not-warranted";
  readonly checkIds: readonly string[];
}

/**
 * A deterministic selection proposal. It is not an execution receipt, candidate
 * fingerprint, freshness claim, or Close authorization.
 */
export interface VerificationPlan {
  readonly schemaVersion: 1;
  readonly algorithm: "risk-weighted-independent-behavior-v1";
  readonly impact: VerificationImpact;
  readonly goals: readonly VerificationGoal[];
  readonly selected: readonly SelectedVerificationCheck[];
  readonly skipped: readonly SkippedVerificationCheck[];
  readonly uncoveredGoals: readonly UncoveredVerificationGoal[];
  readonly coverageStatus: "covered" | "missing-public-behavior-evidence";
}
