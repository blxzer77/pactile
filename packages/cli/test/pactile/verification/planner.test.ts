import { describe, expect, it } from "vitest";
import {
  createVerificationPlan,
  VerificationPlanInputError,
  type VerificationCheck,
  type VerificationImpact,
} from "../../../src/pactile/index.js";

const routineImpact: VerificationImpact = {
  changedSurfaces: ["task.create"],
  risks: [],
  scope: "single-area",
};

const routineChecks: readonly VerificationCheck[] = [
  {
    kind: "behavior",
    id: "task.create.public",
    title: "Task creation public contract",
    mode: "focused",
    evidence: "independent-public-behavior",
    coversSurfaces: ["task.create"],
    coversRisks: [],
  },
  {
    kind: "behavior",
    id: "all.tests",
    title: "Full test suite",
    mode: "full-suite",
    evidence: "independent-public-behavior",
    coversSurfaces: ["task.create"],
    coversRisks: [],
  },
  {
    kind: "policy-ci",
    id: "typecheck.required",
    title: "Project typecheck",
    requiredBy: ["project CI: typecheck"],
  },
  {
    kind: "policy-ci",
    id: "optional.coverage",
    title: "Optional coverage report",
    requiredBy: [],
  },
];

describe("verification plan selection", () => {
  it("chooses focused public behavior and preserves required CI without routine full-suite expansion", () => {
    const plan = createVerificationPlan({
      impact: routineImpact,
      checks: routineChecks,
    });

    expect(plan.schemaVersion).toBe(1);
    expect(plan.coverageStatus).toBe("covered");
    expect(plan.selected.map(({ checkId }) => checkId)).toEqual([
      "typecheck.required",
      "task.create.public",
    ]);
    expect(plan.skipped).toContainEqual(
      expect.objectContaining({
        checkId: "all.tests",
        reason: "broad-check-not-warranted",
      }),
    );
    expect(plan.skipped).toContainEqual(
      expect.objectContaining({
        checkId: "optional.coverage",
        reason: "optional-policy-ci",
      }),
    );
  });

  it("leaves routine coverage visibly incomplete instead of falling back to a full suite", () => {
    const plan = createVerificationPlan({
      impact: routineImpact,
      checks: routineChecks.filter((check) => check.id === "all.tests"),
    });

    expect(plan.selected).toEqual([]);
    expect(plan.coverageStatus).toBe("missing-public-behavior-evidence");
    expect(plan.uncoveredGoals).toEqual([
      expect.objectContaining({
        goal: expect.objectContaining({ id: "surface:task.create" }),
        reason: "only-broader-check-not-warranted",
        checkIds: ["all.tests"],
      }),
    ]);
    expect(plan.skipped).toContainEqual(
      expect.objectContaining({
        checkId: "all.tests",
        reason: "broad-check-not-warranted",
      }),
    );
  });

  it("selects the matching integration, migration, release, permission, and data-egress checks", () => {
    const impact: VerificationImpact = {
      changedSurfaces: ["provider.resolve"],
      risks: ["migration", "release", "permission-boundary", "data-egress"],
      scope: "cross-module",
    };
    const checks: readonly VerificationCheck[] = [
      {
        kind: "behavior",
        id: "provider.integration",
        title: "Provider integration public behavior",
        mode: "integration",
        evidence: "independent-public-behavior",
        coversSurfaces: ["provider.resolve"],
        coversRisks: [],
      },
      {
        kind: "behavior",
        id: "migration.compat",
        title: "Migration compatibility outcomes",
        mode: "migration",
        evidence: "independent-public-behavior",
        coversSurfaces: [],
        coversRisks: ["migration"],
      },
      {
        kind: "behavior",
        id: "release.pack",
        title: "Packaged release smoke behavior",
        mode: "release",
        evidence: "independent-public-behavior",
        coversSurfaces: [],
        coversRisks: ["release"],
      },
      {
        kind: "behavior",
        id: "permission.egress.boundary",
        title: "Permission and outbound-data boundary behavior",
        mode: "focused",
        evidence: "independent-public-behavior",
        coversSurfaces: [],
        coversRisks: ["permission-boundary", "data-egress"],
      },
    ];

    const plan = createVerificationPlan({ impact, checks });

    expect(plan.coverageStatus).toBe("covered");
    expect(plan.selected.map(({ checkId }) => checkId)).toEqual([
      "permission.egress.boundary",
      "provider.integration",
      "migration.compat",
      "release.pack",
    ]);
    expect(
      plan.selected.flatMap(({ coversGoalIds }) => coversGoalIds),
    ).toContain("scope:cross-module");
  });

  it("keeps a cross-module goal uncovered when only a focused seam check is available", () => {
    const plan = createVerificationPlan({
      impact: {
        changedSurfaces: ["task.create"],
        risks: [],
        scope: "cross-module",
      },
      checks: routineChecks.filter(
        (check) => check.id === "task.create.public",
      ),
    });

    expect(plan.selected.map(({ checkId }) => checkId)).toEqual([
      "task.create.public",
    ]);
    expect(plan.uncoveredGoals).toEqual([
      expect.objectContaining({
        goal: expect.objectContaining({ id: "scope:cross-module" }),
        reason: "no-registered-public-behavior-check",
      }),
    ]);
    expect(plan.coverageStatus).toBe("missing-public-behavior-evidence");
  });

  it("does not let an unrelated integration check cover a cross-module auth change", () => {
    const plan = createVerificationPlan({
      impact: {
        changedSurfaces: ["auth.authorize"],
        risks: ["permission-boundary"],
        scope: "cross-module",
      },
      checks: [
        {
          kind: "behavior",
          id: "auth.authorize.focused",
          title: "Authorization boundary behavior",
          mode: "focused",
          evidence: "independent-public-behavior",
          coversSurfaces: ["auth.authorize"],
          coversRisks: ["permission-boundary"],
        },
        {
          kind: "behavior",
          id: "image.render.integration",
          title: "Image rendering integration behavior",
          mode: "integration",
          evidence: "independent-public-behavior",
          coversSurfaces: ["image.render"],
          coversRisks: [],
        },
      ],
    });

    expect(plan.selected.map(({ checkId }) => checkId)).toEqual([
      "auth.authorize.focused",
    ]);
    expect(plan.uncoveredGoals).toEqual([
      expect.objectContaining({
        goal: expect.objectContaining({ id: "scope:cross-module" }),
        reason: "no-registered-public-behavior-check",
        checkIds: [],
      }),
    ]);
    expect(plan.skipped).toContainEqual(
      expect.objectContaining({
        checkId: "image.render.integration",
        reason: "no-relevant-goal",
        relevantGoalIds: [],
      }),
    );
    expect(plan.coverageStatus).toBe("missing-public-behavior-evidence");
  });

  it("exposes missing or mirror-only public evidence while still selecting required CI", () => {
    const plan = createVerificationPlan({
      impact: {
        changedSurfaces: ["auth.authorize"],
        risks: ["permission-boundary"],
        scope: "single-area",
      },
      checks: [
        {
          kind: "behavior",
          id: "auth.internal.mirror",
          title: "Internal auth helper assertion",
          mode: "focused",
          evidence: "implementation-mirror",
          coversSurfaces: ["auth.authorize"],
          coversRisks: ["permission-boundary"],
        },
        {
          kind: "policy-ci",
          id: "required.lint",
          title: "Required lint",
          requiredBy: ["project CI"],
        },
      ],
    });

    expect(plan.selected.map(({ checkId }) => checkId)).toEqual([
      "required.lint",
    ]);
    expect(plan.coverageStatus).toBe("missing-public-behavior-evidence");
    expect(plan.uncoveredGoals).toEqual([
      expect.objectContaining({
        goal: expect.objectContaining({ id: "risk:permission-boundary" }),
        reason: "only-implementation-mirror",
      }),
      expect.objectContaining({
        goal: expect.objectContaining({ id: "surface:auth.authorize" }),
        reason: "only-implementation-mirror",
      }),
    ]);
    expect(plan.skipped).toContainEqual(
      expect.objectContaining({
        checkId: "auth.internal.mirror",
        reason: "implementation-mirror",
      }),
    );
  });

  it("uses a broad suite for repository-wide scope only when it covers that goal", () => {
    const plan = createVerificationPlan({
      impact: { changedSurfaces: [], risks: [], scope: "repository-wide" },
      checks: [
        {
          kind: "behavior",
          id: "repo.public.full",
          title: "Repository-wide public behavior regression",
          mode: "full-suite",
          evidence: "independent-public-behavior",
          coversSurfaces: [],
          coversRisks: [],
        },
      ],
    });

    expect(plan.selected).toEqual([
      expect.objectContaining({
        checkId: "repo.public.full",
        coversGoalIds: ["scope:repository-wide"],
      }),
    ]);
    expect(plan.coverageStatus).toBe("covered");
  });

  it("returns the same plan without mutating or depending on inventory order", () => {
    const reversed = [...routineChecks].reverse();
    const originalPlan = createVerificationPlan({
      impact: routineImpact,
      checks: routineChecks,
    });
    const reversedPlan = createVerificationPlan({
      impact: routineImpact,
      checks: reversed,
    });

    expect(reversedPlan).toEqual(originalPlan);
    expect(routineImpact).toEqual({
      changedSurfaces: ["task.create"],
      risks: [],
      scope: "single-area",
    });
    expect(routineChecks[0]).toMatchObject({
      id: "task.create.public",
      coversSurfaces: ["task.create"],
    });
  });

  it("rejects ambiguous inventories and incomplete single-area change descriptions", () => {
    const taskCreationChecks = routineChecks.filter(
      (check) => check.id === "task.create.public",
    );
    expect(() =>
      createVerificationPlan({
        impact: { changedSurfaces: [], risks: [], scope: "single-area" },
        checks: [],
      }),
    ).toThrow(VerificationPlanInputError);
    expect(() =>
      createVerificationPlan({
        impact: routineImpact,
        checks: [...taskCreationChecks, ...taskCreationChecks],
      }),
    ).toThrow(/duplicates another check/);
  });
});
