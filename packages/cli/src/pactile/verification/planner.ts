import {
  BEHAVIOR_CHECK_MODES,
  VERIFICATION_RISKS,
  VERIFICATION_SCOPES,
  type BehaviorCheckMode,
  type BehaviorVerificationCheck,
  type RequiredPolicyCheck,
  type SelectedVerificationCheck,
  type SkippedVerificationCheck,
  type UncoveredVerificationGoal,
  type VerificationCheck,
  type VerificationGoal,
  type VerificationImpact,
  type VerificationPlan,
  type VerificationRisk,
} from "./types.js";

export interface CreateVerificationPlanInput {
  readonly impact: VerificationImpact;
  readonly checks: readonly VerificationCheck[];
}

export class VerificationPlanInputError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Invalid verification plan input: ${issues.join("; ")}`);
    this.name = "VerificationPlanInputError";
    this.issues = issues;
  }
}

interface InternalGoal extends VerificationGoal {
  readonly weight: number;
}

interface BehaviorCandidate {
  readonly check: BehaviorVerificationCheck;
  readonly relevantGoals: readonly InternalGoal[];
  readonly valuePerCost: number;
  readonly value: number;
}

const CHECK_COST: Readonly<Record<BehaviorCheckMode, number>> = Object.freeze({
  focused: 1,
  integration: 2,
  migration: 2,
  release: 2,
  "full-suite": 5,
});

const RISK_WEIGHT: Readonly<Record<VerificationRisk, number>> = Object.freeze({
  "public-contract": 90,
  migration: 80,
  release: 80,
  "permission-boundary": 100,
  "data-egress": 100,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function requireStringList(
  value: unknown,
  field: string,
  issues: string[],
  allowEmpty = true,
): string[] {
  if (!Array.isArray(value)) {
    issues.push(`${field} must be an array`);
    return [];
  }

  if (!allowEmpty && value.length === 0)
    issues.push(`${field} must not be empty`);
  const result: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (
      !isString(entry) ||
      entry.trim().length === 0 ||
      entry !== entry.trim()
    ) {
      issues.push(`${field}[${index}] must be a non-empty trimmed string`);
      continue;
    }
    if (result.includes(entry))
      issues.push(`${field} must not contain duplicate values`);
    result.push(entry);
  }
  return result;
}

function requireRiskList(
  value: unknown,
  field: string,
  issues: string[],
): VerificationRisk[] {
  if (!Array.isArray(value)) {
    issues.push(`${field} must be an array`);
    return [];
  }

  const risks: VerificationRisk[] = [];
  for (const [index, entry] of value.entries()) {
    if (
      !isString(entry) ||
      !VERIFICATION_RISKS.includes(entry as VerificationRisk)
    ) {
      issues.push(`${field}[${index}] is not a supported verification risk`);
      continue;
    }
    const risk = entry as VerificationRisk;
    if (risks.includes(risk))
      issues.push(`${field} must not contain duplicate values`);
    risks.push(risk);
  }
  return risks;
}

function validateInput(input: CreateVerificationPlanInput): void {
  const issues: string[] = [];
  if (
    !isRecord(input) ||
    !isRecord(input.impact) ||
    !Array.isArray(input.checks)
  ) {
    throw new VerificationPlanInputError([
      "input must include impact and a checks array",
    ]);
  }

  const impact = input.impact as unknown as Record<string, unknown>;
  const validScope =
    isString(impact.scope) &&
    VERIFICATION_SCOPES.includes(
      impact.scope as (typeof VERIFICATION_SCOPES)[number],
    );
  if (!validScope) issues.push("impact.scope is not supported");
  const surfaces = requireStringList(
    impact.changedSurfaces,
    "impact.changedSurfaces",
    issues,
  );
  const risks = requireRiskList(impact.risks, "impact.risks", issues);
  if (
    validScope &&
    impact.scope === "single-area" &&
    surfaces.length === 0 &&
    risks.length === 0
  ) {
    issues.push("single-area impact must identify a changed surface or risk");
  }

  const ids = new Set<string>();
  for (const [index, check] of input.checks.entries()) {
    const field = `checks[${index}]`;
    if (!isRecord(check)) {
      issues.push(`${field} must be an object`);
      continue;
    }
    if (
      !isString(check.id) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(check.id)
    ) {
      issues.push(`${field}.id must be a stable identifier`);
    } else if (ids.has(check.id)) {
      issues.push(`${field}.id duplicates another check`);
    } else {
      ids.add(check.id);
    }
    if (
      !isString(check.title) ||
      check.title.trim().length === 0 ||
      check.title !== check.title.trim()
    ) {
      issues.push(`${field}.title must be a non-empty trimmed string`);
    }
    if (check.kind === "behavior") {
      if (
        !isString(check.mode) ||
        !BEHAVIOR_CHECK_MODES.includes(check.mode as BehaviorCheckMode)
      ) {
        issues.push(`${field}.mode is not supported`);
      }
      if (
        check.evidence !== "independent-public-behavior" &&
        check.evidence !== "implementation-mirror"
      ) {
        issues.push(`${field}.evidence is not supported`);
      }
      requireRiskList(check.coversRisks, `${field}.coversRisks`, issues);
      requireStringList(
        check.coversSurfaces,
        `${field}.coversSurfaces`,
        issues,
      );
      if (Object.hasOwn(check, "requiredBy"))
        issues.push(`${field}.requiredBy is only valid for policy-ci checks`);
    } else if (check.kind === "policy-ci") {
      requireStringList(check.requiredBy, `${field}.requiredBy`, issues);
    } else {
      issues.push(`${field}.kind is not supported`);
    }
  }

  if (issues.length > 0) throw new VerificationPlanInputError(issues);
}

function buildGoals(impact: VerificationImpact): InternalGoal[] {
  const goals: InternalGoal[] = [];
  for (const surface of impact.changedSurfaces) {
    goals.push({
      id: `surface:${surface}`,
      kind: "surface",
      label: surface,
      weight: 50,
    });
  }
  for (const risk of impact.risks) {
    goals.push({
      id: `risk:${risk}`,
      kind: "risk",
      label: risk,
      weight: RISK_WEIGHT[risk],
    });
  }
  if (impact.scope === "cross-module") {
    goals.push({
      id: "scope:cross-module",
      kind: "scope",
      label: "cross-module behavior",
      weight: 55,
    });
  } else if (impact.scope === "repository-wide") {
    goals.push({
      id: "scope:repository-wide",
      kind: "scope",
      label: "repository-wide behavior",
      weight: 70,
    });
  }
  return goals.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

function modeSupportsGoal(
  mode: BehaviorCheckMode,
  goal: InternalGoal,
): boolean {
  if (goal.kind !== "risk" && goal.kind !== "scope") return true;
  if (goal.id === "risk:migration")
    return mode === "migration" || mode === "full-suite";
  if (goal.id === "risk:release")
    return mode === "release" || mode === "full-suite";
  if (goal.id === "scope:cross-module")
    return mode === "integration" || mode === "full-suite";
  if (goal.id === "scope:repository-wide") return mode === "full-suite";
  return true;
}

function checkDeclaresGoal(
  check: BehaviorVerificationCheck,
  goal: InternalGoal,
  impact: VerificationImpact,
): boolean {
  if (!modeSupportsGoal(check.mode, goal)) return false;
  if (goal.kind === "surface") return check.coversSurfaces.includes(goal.label);
  if (goal.kind === "risk")
    return check.coversRisks.includes(goal.label as VerificationRisk);
  if (goal.id === "scope:cross-module") {
    return impact.changedSurfaces.some((surface) =>
      check.coversSurfaces.includes(surface),
    );
  }
  return true;
}

function checkCoversGoal(
  check: BehaviorVerificationCheck,
  goal: InternalGoal,
  impact: VerificationImpact,
): boolean {
  if (!checkDeclaresGoal(check, goal, impact)) return false;
  return !(
    check.mode === "full-suite" &&
    impact.scope === "single-area" &&
    impact.risks.length === 0
  );
}

function score(
  check: BehaviorVerificationCheck,
  uncoveredGoals: readonly InternalGoal[],
  impact: VerificationImpact,
): BehaviorCandidate | undefined {
  const relevantGoals = uncoveredGoals.filter((goal) =>
    checkCoversGoal(check, goal, impact),
  );
  if (relevantGoals.length === 0) return undefined;
  const value = relevantGoals.reduce((total, goal) => total + goal.weight, 0);
  return {
    check,
    relevantGoals,
    value,
    valuePerCost: value / CHECK_COST[check.mode],
  };
}

function compareCandidates(
  left: BehaviorCandidate,
  right: BehaviorCandidate,
): number {
  if (left.valuePerCost !== right.valuePerCost)
    return right.valuePerCost - left.valuePerCost;
  if (left.value !== right.value) return right.value - left.value;
  return left.check.id < right.check.id
    ? -1
    : left.check.id > right.check.id
      ? 1
      : 0;
}

function cloneImpact(impact: VerificationImpact): VerificationImpact {
  return {
    changedSurfaces: [...impact.changedSurfaces].sort(),
    risks: [...impact.risks].sort(),
    scope: impact.scope,
  };
}

function clonePublicGoal(goal: InternalGoal): VerificationGoal {
  return { id: goal.id, kind: goal.kind, label: goal.label };
}

function uncoveredReason(
  goal: InternalGoal,
  checks: readonly VerificationCheck[],
  impact: VerificationImpact,
): UncoveredVerificationGoal | undefined {
  const independentIds: string[] = [];
  const mirrorIds: string[] = [];
  const broadIds: string[] = [];
  for (const candidate of checks) {
    if (
      candidate.kind !== "behavior" ||
      !checkDeclaresGoal(candidate, goal, impact)
    )
      continue;
    if (
      candidate.mode === "full-suite" &&
      impact.scope === "single-area" &&
      impact.risks.length === 0
    ) {
      if (candidate.evidence === "independent-public-behavior")
        broadIds.push(candidate.id);
      continue;
    }
    if (candidate.evidence === "independent-public-behavior")
      independentIds.push(candidate.id);
    else mirrorIds.push(candidate.id);
  }
  if (independentIds.length > 0) return undefined;
  if (broadIds.length > 0) {
    return {
      goal: clonePublicGoal(goal),
      reason: "only-broader-check-not-warranted",
      checkIds: broadIds,
    };
  }
  if (mirrorIds.length > 0) {
    return {
      goal: clonePublicGoal(goal),
      reason: "only-implementation-mirror",
      checkIds: mirrorIds,
    };
  }
  return {
    goal: clonePublicGoal(goal),
    reason: "no-registered-public-behavior-check",
    checkIds: [],
  };
}

function skippedBehavior(
  check: BehaviorVerificationCheck,
  goals: readonly InternalGoal[],
  selectedIds: ReadonlySet<string>,
  impact: VerificationImpact,
): SkippedVerificationCheck {
  const declaredGoalIds = goals
    .filter((goal) => checkDeclaresGoal(check, goal, impact))
    .map((goal) => goal.id);
  const relevantGoalIds = goals
    .filter((goal) => checkCoversGoal(check, goal, impact))
    .map((goal) => goal.id);
  if (check.evidence === "implementation-mirror") {
    return {
      checkId: check.id,
      title: check.title,
      reason: "implementation-mirror",
      relevantGoalIds,
      detail:
        "Implementation-coupled checks cannot establish independent public behavior evidence.",
    };
  }
  if (
    check.mode === "full-suite" &&
    impact.scope === "single-area" &&
    impact.risks.length === 0 &&
    declaredGoalIds.length > 0
  ) {
    return {
      checkId: check.id,
      title: check.title,
      reason: "broad-check-not-warranted",
      relevantGoalIds: declaredGoalIds,
      detail:
        "A routine single-area change has no declared risk signal; surface a focused check instead of adding the full suite.",
    };
  }
  if (relevantGoalIds.length === 0) {
    return {
      checkId: check.id,
      title: check.title,
      reason: "no-relevant-goal",
      relevantGoalIds,
      detail:
        "The check does not declare coverage for an impacted behavior surface, risk, or scope.",
    };
  }
  return {
    checkId: check.id,
    title: check.title,
    reason: "already-covered",
    relevantGoalIds: relevantGoalIds.filter((goalId) =>
      selectedIds.has(goalId),
    ),
    detail:
      "Independent checks already selected cover the behavior goals this check contributes.",
  };
}

/**
 * Build a deterministic verification choice from semantic change impact and a
 * trusted inventory of checks. The function never executes checks or mutates input.
 */
export function createVerificationPlan(
  input: CreateVerificationPlanInput,
): VerificationPlan {
  validateInput(input);
  const impact = cloneImpact(input.impact);
  const goals = buildGoals(impact);
  const selected: SelectedVerificationCheck[] = [];
  const skipped: SkippedVerificationCheck[] = [];
  const coveredGoalIds = new Set<string>();
  const requiredPolicyChecks = input.checks
    .filter(
      (check): check is RequiredPolicyCheck =>
        check.kind === "policy-ci" && check.requiredBy.length > 0,
    )
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );

  for (const check of requiredPolicyChecks) {
    selected.push({
      checkId: check.id,
      title: check.title,
      reason: "required-by-policy",
      coversGoalIds: [],
      requiredBy: [...check.requiredBy],
    });
  }

  const remaining = [...goals];
  while (true) {
    const candidates = input.checks
      .filter(
        (check): check is BehaviorVerificationCheck =>
          check.kind === "behavior" &&
          check.evidence === "independent-public-behavior",
      )
      .map((check) => score(check, remaining, impact))
      .filter(
        (candidate): candidate is BehaviorCandidate => candidate !== undefined,
      )
      .sort(compareCandidates);
    const choice = candidates[0];
    if (choice === undefined) break;

    const selectedGoalIds = choice.relevantGoals.map((goal) => goal.id);
    selected.push({
      checkId: choice.check.id,
      title: choice.check.title,
      reason: "highest-value-uncovered-behavior",
      coversGoalIds: selectedGoalIds,
    });
    for (const id of selectedGoalIds) coveredGoalIds.add(id);
    const selectedGoals = new Set(selectedGoalIds);
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      const goal = remaining[index];
      if (goal !== undefined && selectedGoals.has(goal.id))
        remaining.splice(index, 1);
    }
  }

  const selectedIds = new Set(coveredGoalIds);
  for (const check of input.checks) {
    if (check.kind === "policy-ci") {
      if (check.requiredBy.length === 0) {
        skipped.push({
          checkId: check.id,
          title: check.title,
          reason: "optional-policy-ci",
          relevantGoalIds: [],
          detail:
            "Optional CI is not added to ordinary verification plans unless a project policy requires it.",
        });
      }
      continue;
    }
    if (selected.some((entry) => entry.checkId === check.id)) continue;
    skipped.push(skippedBehavior(check, goals, selectedIds, impact));
  }
  skipped.sort((left, right) =>
    left.checkId < right.checkId ? -1 : left.checkId > right.checkId ? 1 : 0,
  );

  const uncoveredGoals = goals
    .filter((goal) => !coveredGoalIds.has(goal.id))
    .map((goal) => uncoveredReason(goal, input.checks, impact))
    .filter((entry): entry is UncoveredVerificationGoal => entry !== undefined);

  return {
    schemaVersion: 1,
    algorithm: "risk-weighted-independent-behavior-v1",
    impact,
    goals: goals.map(clonePublicGoal),
    selected,
    skipped,
    uncoveredGoals,
    coverageStatus:
      uncoveredGoals.length === 0
        ? "covered"
        : "missing-public-behavior-evidence",
  };
}
