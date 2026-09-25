import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTaskCandidateEntry,
  createVerificationPlan,
  createVerificationReceipt,
  listRequiredCiReceiptResults,
  observeGitCandidate,
  assessVerificationReceiptFreshness,
  serializeVerificationReceipt,
  VerificationReceiptError,
  verifyVerificationReceiptIntegrity,
} from "../../../src/pactile/verification/index.js";
import {
  createTaskCandidateSnapshot,
  type TaskCandidateSnapshot,
} from "../../../src/core/task/index.js";
import type {
  VerificationPlan,
  VerificationReceiptRun,
} from "../../../src/pactile/verification/index.js";
import {
  createTemporaryGitRepository,
  removeTemporaryGitRepository,
} from "./git-fixture.js";

const recordedAt = "2026-09-26T00:00:00.000Z";

function verificationPlan(): VerificationPlan {
  return createVerificationPlan({
    impact: {
      changedSurfaces: ["task.create"],
      risks: [],
      scope: "single-area",
    },
    checks: [
      {
        kind: "policy-ci",
        id: "ci.required.typecheck",
        title: "Required typecheck",
        requiredBy: ["project CI: typecheck"],
      },
      {
        kind: "behavior",
        id: "task.create.public",
        title: "Task creation public behavior",
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
    ],
  });
}

function runForObservation(
  observation: ReturnType<typeof observeGitCandidate>,
): VerificationReceiptRun {
  const candidateSnapshot: TaskCandidateSnapshot = createTaskCandidateSnapshot([
    { ref: "pactile:task-definition", fingerprint: "a".repeat(64) },
    createTaskCandidateEntry(observation),
  ]);
  return {
    id: "run-1",
    taskId: "task-1",
    state: "completed",
    candidateSnapshot,
  };
}

function passingResults() {
  return [
    {
      checkId: "ci.required.typecheck",
      outcome: "passed" as const,
      evidenceRef: "file:verification/typecheck.log",
    },
    {
      checkId: "task.create.public",
      outcome: "passed" as const,
      evidenceRef: "file:verification/task-create.json",
    },
    { checkId: "all.tests", outcome: "skipped" as const },
  ];
}

describe("candidate-bound verification receipts", () => {
  it("binds selected and skipped checks to the P35 Run/candidate and exposes required CI from one source", () => {
    const repository = createTemporaryGitRepository();
    try {
      fs.writeFileSync(
        path.join(repository.root, "src", "task.ts"),
        "export const task = 'candidate';\n",
      );
      const observation = observeGitCandidate({
        repositoryRoot: repository.root,
        allowedWriteSet: { exactPaths: ["src/task.ts"], directoryPrefixes: [] },
      });
      const run = runForObservation(observation);
      const plan = verificationPlan();
      const receipt = createVerificationReceipt({
        run,
        observation,
        plan,
        results: passingResults(),
        recordedAt,
      });

      expect(receipt.binding).toEqual({
        taskId: run.taskId,
        runId: run.id,
        candidateSnapshotId: run.candidateSnapshot?.id,
        candidateFingerprint: run.candidateSnapshot?.fingerprint,
        observationFingerprint: observation.fingerprint,
      });
      expect(receipt.observation.expectedBranchBound).toBe(false);
      expect(receipt.observation.committedPaths).toEqual([]);
      expect(
        receipt.results.map(({ checkId, outcome }) => [checkId, outcome]),
      ).toEqual([
        ["ci.required.typecheck", "passed"],
        ["task.create.public", "passed"],
        ["all.tests", "skipped"],
      ]);
      expect(listRequiredCiReceiptResults(receipt)).toEqual([
        {
          checkId: "ci.required.typecheck",
          requiredBy: ["project CI: typecheck"],
          outcome: "passed",
          evidenceRef: "file:verification/typecheck.log",
        },
      ]);
      expect(receipt.outcome).toBe("passed");
      expect(verifyVerificationReceiptIntegrity(receipt)).toBe(true);
      expect(serializeVerificationReceipt(receipt)).toBe(
        serializeVerificationReceipt(receipt),
      );
    } finally {
      removeTemporaryGitRepository(repository);
    }
  });

  it("marks a receipt stale when allowed candidate bytes change after the Run", () => {
    const repository = createTemporaryGitRepository();
    try {
      const allowedWriteSet = {
        exactPaths: ["src/task.ts"],
        directoryPrefixes: [],
      };
      fs.writeFileSync(
        path.join(repository.root, "src", "task.ts"),
        "export const task = 'candidate';\n",
      );
      const observation = observeGitCandidate({
        repositoryRoot: repository.root,
        allowedWriteSet,
      });
      const run = runForObservation(observation);
      const receipt = createVerificationReceipt({
        run,
        observation,
        plan: verificationPlan(),
        results: passingResults(),
        recordedAt,
      });

      expect(
        assessVerificationReceiptFreshness({
          receipt,
          currentRun: run,
          currentObservation: observation,
        }),
      ).toMatchObject({
        status: "current",
        reasonCodes: [],
      });

      fs.writeFileSync(
        path.join(repository.root, "src", "task.ts"),
        "export const task = 'changed after run';\n",
      );
      const currentObservation = observeGitCandidate({
        repositoryRoot: repository.root,
        allowedWriteSet,
      });
      const freshness = assessVerificationReceiptFreshness({
        receipt,
        currentRun: run,
        currentObservation,
      });
      expect(freshness.status).toBe("stale");
      expect(freshness.reasonCodes).toContain(
        "observation-fingerprint-mismatch",
      );
    } finally {
      removeTemporaryGitRepository(repository);
    }
  });

  it("fails closed when the candidate omits the observer entry or check results", () => {
    const repository = createTemporaryGitRepository();
    try {
      const observation = observeGitCandidate({
        repositoryRoot: repository.root,
        allowedWriteSet: { exactPaths: ["src/task.ts"], directoryPrefixes: [] },
      });
      const candidateSnapshot = createTaskCandidateSnapshot([
        { ref: "pactile:task-definition", fingerprint: "b".repeat(64) },
      ]);
      const run = { ...runForObservation(observation), candidateSnapshot };
      const input = {
        run,
        observation,
        plan: verificationPlan(),
        results: passingResults(),
        recordedAt,
      };
      expect(() => createVerificationReceipt(input)).toThrow(
        /matching Git observation entry/,
      );

      expect(() =>
        createVerificationReceipt({
          ...input,
          run: runForObservation(observation),
          results: passingResults().slice(1),
        }),
      ).toThrow(VerificationReceiptError);
    } finally {
      removeTemporaryGitRepository(repository);
    }
  });

  it("records selected checks that were not run as incomplete and detects receipt tampering", () => {
    const repository = createTemporaryGitRepository();
    try {
      const observation = observeGitCandidate({
        repositoryRoot: repository.root,
        allowedWriteSet: { exactPaths: ["src/task.ts"], directoryPrefixes: [] },
      });
      const receipt = createVerificationReceipt({
        run: runForObservation(observation),
        observation,
        plan: verificationPlan(),
        results: [
          { checkId: "ci.required.typecheck", outcome: "not-run" },
          {
            checkId: "task.create.public",
            outcome: "passed",
            evidenceRef: "file:verification/task-create.json",
          },
          { checkId: "all.tests", outcome: "skipped" },
        ],
        recordedAt,
      });
      expect(receipt.outcome).toBe("incomplete");

      const tampered = {
        ...receipt,
        results: receipt.results.map((result) =>
          result.checkId === "task.create.public"
            ? { ...result, summary: "changed" }
            : result,
        ),
      };
      expect(verifyVerificationReceiptIntegrity(tampered)).toBe(false);
      expect(() => serializeVerificationReceipt(tampered)).toThrow(
        VerificationReceiptError,
      );
    } finally {
      removeTemporaryGitRepository(repository);
    }
  });
});
