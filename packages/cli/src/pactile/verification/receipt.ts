import { createHash } from "node:crypto";
import type {
  TaskCandidateSnapshot,
  TaskRunV2,
} from "../../core/task/index.js";
import {
  GIT_CANDIDATE_OBSERVER_VERSION,
  VERIFICATION_CANDIDATE_ENTRY_REF,
  verifyGitCandidateObservation,
  type GitCandidateFileFingerprint,
  type GitCandidateObservation,
  type GitCandidateScopeStatus,
  type GitWriteSet,
} from "./git-observer.js";
import type {
  SelectedVerificationCheck,
  SkippedVerificationCheck,
  VerificationPlan,
} from "./types.js";

export const VERIFICATION_RECEIPT_SOURCE =
  "pactile-verification-receipt-v1" as const;

const SHA256_RE = /^[a-f0-9]{64}$/;
const CHECK_RESULT_OUTCOMES = [
  "passed",
  "failed",
  "blocked",
  "not-run",
  "skipped",
] as const;

export type VerificationCheckOutcome = (typeof CHECK_RESULT_OUTCOMES)[number];
export type VerificationReceiptOutcome =
  | "passed"
  | "failed"
  | "blocked"
  | "incomplete";
export type VerificationReceiptRun = Pick<
  TaskRunV2,
  "id" | "taskId" | "state" | "candidateSnapshot"
>;

export interface VerificationCheckResult {
  readonly checkId: string;
  readonly outcome: VerificationCheckOutcome;
  /** Stable path/URI to captured output. Never store raw command output in this field. */
  readonly evidenceRef?: string;
  readonly summary?: string;
}

export interface VerificationReceiptBinding {
  readonly taskId: string;
  readonly runId: string;
  readonly candidateSnapshotId: string;
  /** P35 candidate snapshot fingerprint. */
  readonly candidateFingerprint: string;
  /** Fingerprint of the observed Git and allowed current-file state. */
  readonly observationFingerprint: string;
}

export interface VerificationReceiptObservation {
  readonly source: typeof GIT_CANDIDATE_OBSERVER_VERSION;
  readonly observedAt: string;
  readonly repositoryIdentitySha256: string;
  readonly expectedBaseSha: string | null;
  readonly expectedBranch: string | null;
  readonly expectedBranchBound: boolean;
  readonly head: string;
  readonly branch: string | null;
  readonly allowedWriteSet: GitWriteSet;
  readonly stagedPaths: readonly string[];
  readonly unstagedPaths: readonly string[];
  readonly untrackedPaths: readonly string[];
  readonly conflictPaths: readonly string[];
  readonly committedPaths: readonly string[];
  readonly affectedPaths: readonly string[];
  readonly inScopePaths: readonly string[];
  readonly outOfScopePaths: readonly string[];
  readonly currentFiles: readonly GitCandidateFileFingerprint[];
  readonly indexDiffSha256: string;
  readonly worktreeDiffSha256: string;
  readonly statusSha256: string;
  readonly scopeStatus: GitCandidateScopeStatus;
  readonly fingerprint: string;
}

export interface VerificationReceipt {
  readonly schemaVersion: 1;
  readonly source: typeof VERIFICATION_RECEIPT_SOURCE;
  readonly recordedAt: string;
  readonly binding: VerificationReceiptBinding;
  readonly observation: VerificationReceiptObservation;
  readonly plan: VerificationPlan;
  /** Exactly one result for every selected and skipped plan entry. */
  readonly results: readonly VerificationCheckResult[];
  readonly outcome: VerificationReceiptOutcome;
  readonly fingerprint: string;
}

export interface CreateVerificationReceiptInput {
  readonly run: VerificationReceiptRun;
  readonly observation: GitCandidateObservation;
  readonly plan: VerificationPlan;
  readonly results: readonly VerificationCheckResult[];
  readonly recordedAt: string;
}

export type VerificationFreshnessReason =
  | "receipt-integrity-mismatch"
  | "run-not-completed"
  | "task-id-mismatch"
  | "run-id-mismatch"
  | "candidate-snapshot-missing"
  | "candidate-snapshot-id-mismatch"
  | "candidate-fingerprint-mismatch"
  | "candidate-observer-entry-mismatch"
  | "current-observation-invalid"
  | "current-observation-not-eligible"
  | "repository-identity-mismatch"
  | "observation-fingerprint-mismatch";

export interface VerificationReceiptFreshness {
  readonly status: "current" | "stale" | "invalid-receipt";
  readonly reasonCodes: readonly VerificationFreshnessReason[];
  readonly receiptFingerprint: string;
  readonly currentCandidateFingerprint: string | null;
  readonly currentObservationFingerprint: string | null;
}

export interface RequiredCiReceiptResult {
  readonly checkId: string;
  readonly requiredBy: readonly string[];
  readonly outcome: VerificationCheckOutcome;
  readonly evidenceRef: string | null;
}

export class VerificationReceiptError extends Error {
  public readonly code:
    | "invalid-plan"
    | "run-incomplete"
    | "candidate-not-bound"
    | "invalid-observation"
    | "invalid-recorded-at"
    | "result-set-mismatch"
    | "invalid-result"
    | "receipt-integrity-mismatch";

  public constructor(code: VerificationReceiptError["code"], message: string) {
    super(message);
    this.name = "VerificationReceiptError";
    this.code = code;
  }
}

function stableJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
      throw new VerificationReceiptError(
        "invalid-result",
        "Receipt contains an unserializable value.",
      );
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  throw new VerificationReceiptError(
    "invalid-result",
    "Receipt contains a value that cannot be serialized as stable JSON.",
  );
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function requireText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new VerificationReceiptError(
      "invalid-plan",
      `${field} must be a non-empty trimmed string.`,
    );
  }
  return value;
}

function copyPlan(plan: VerificationPlan): VerificationPlan {
  if (
    plan?.schemaVersion !== 1 ||
    plan.algorithm !== "risk-weighted-independent-behavior-v1" ||
    !plan.impact ||
    !Array.isArray(plan.impact.changedSurfaces) ||
    !Array.isArray(plan.impact.risks) ||
    !Array.isArray(plan.goals) ||
    !Array.isArray(plan.selected) ||
    !Array.isArray(plan.skipped) ||
    !Array.isArray(plan.uncoveredGoals) ||
    (plan.coverageStatus !== "covered" &&
      plan.coverageStatus !== "missing-public-behavior-evidence")
  ) {
    throw new VerificationReceiptError(
      "invalid-plan",
      "Verification plan has an unsupported or incomplete schema.",
    );
  }
  const expectedCoverage =
    plan.uncoveredGoals.length === 0
      ? "covered"
      : "missing-public-behavior-evidence";
  if (plan.coverageStatus !== expectedCoverage) {
    throw new VerificationReceiptError(
      "invalid-plan",
      "Verification plan coverage status does not match its uncovered goals.",
    );
  }
  const ids = new Set<string>();
  const selected: SelectedVerificationCheck[] = plan.selected.map((entry) => {
    const checkId = requireText(entry.checkId, "selected.checkId");
    const title = requireText(entry.title, `selected.${checkId}.title`);
    if (!Array.isArray(entry.coversGoalIds)) {
      throw new VerificationReceiptError(
        "invalid-plan",
        `Selected check ${checkId} has invalid goal references.`,
      );
    }
    const coversGoalIds = entry.coversGoalIds.map((goalId: string) =>
      requireText(goalId, `selected.${checkId}.coversGoalIds`),
    );
    if (ids.has(checkId))
      throw new VerificationReceiptError(
        "invalid-plan",
        `Duplicate check in plan: ${checkId}.`,
      );
    ids.add(checkId);
    if (entry.reason === "required-by-policy") {
      if (!Array.isArray(entry.requiredBy) || entry.requiredBy.length === 0) {
        throw new VerificationReceiptError(
          "invalid-plan",
          `Required check ${checkId} has no policy declaration.`,
        );
      }
      return {
        checkId,
        title,
        reason: "required-by-policy",
        requiredBy: entry.requiredBy.map((source: string) =>
          requireText(source, `selected.${checkId}.requiredBy`),
        ),
        coversGoalIds,
      };
    }
    if (entry.reason !== "highest-value-uncovered-behavior") {
      throw new VerificationReceiptError(
        "invalid-plan",
        `Selected check ${checkId} has an invalid reason.`,
      );
    }
    if (entry.requiredBy !== undefined) {
      throw new VerificationReceiptError(
        "invalid-plan",
        `Behavior check ${checkId} cannot declare required CI sources.`,
      );
    }
    return {
      checkId,
      title,
      reason: "highest-value-uncovered-behavior",
      coversGoalIds,
    };
  });
  const skipped: SkippedVerificationCheck[] = plan.skipped.map((entry) => {
    const checkId = requireText(entry.checkId, "skipped.checkId");
    const title = requireText(entry.title, `skipped.${checkId}.title`);
    const detail = requireText(entry.detail, `skipped.${checkId}.detail`);
    if (!Array.isArray(entry.relevantGoalIds)) {
      throw new VerificationReceiptError(
        "invalid-plan",
        `Skipped check ${checkId} has invalid goal references.`,
      );
    }
    if (ids.has(checkId))
      throw new VerificationReceiptError(
        "invalid-plan",
        `Duplicate check in plan: ${checkId}.`,
      );
    ids.add(checkId);
    return {
      checkId,
      title,
      reason: entry.reason,
      relevantGoalIds: entry.relevantGoalIds.map((goalId: string) =>
        requireText(goalId, `skipped.${checkId}.relevantGoalIds`),
      ),
      detail,
    };
  });
  const goals = plan.goals.map((goal) => ({
    id: requireText(goal.id, "goal.id"),
    kind: goal.kind,
    label: requireText(goal.label, "goal.label"),
  }));
  const uncoveredGoals = plan.uncoveredGoals.map((entry) => {
    if (!Array.isArray(entry.checkIds))
      throw new VerificationReceiptError(
        "invalid-plan",
        "Uncovered goal has invalid check references.",
      );
    return {
      goal: {
        id: requireText(entry.goal.id, "uncoveredGoal.goal.id"),
        kind: entry.goal.kind,
        label: requireText(entry.goal.label, "uncoveredGoal.goal.label"),
      },
      reason: entry.reason,
      checkIds: entry.checkIds.map((checkId: string) =>
        requireText(checkId, "uncoveredGoal.checkIds"),
      ),
    };
  });
  return {
    schemaVersion: 1,
    algorithm: plan.algorithm,
    impact: {
      changedSurfaces: plan.impact.changedSurfaces.map((surface) =>
        requireText(surface, "impact.changedSurfaces"),
      ),
      risks: [...plan.impact.risks],
      scope: plan.impact.scope,
    },
    goals,
    selected,
    skipped,
    uncoveredGoals,
    coverageStatus: plan.coverageStatus,
  };
}

function copyObservation(
  observation: GitCandidateObservation,
): VerificationReceiptObservation {
  return {
    source: observation.source,
    observedAt: observation.observedAt,
    repositoryIdentitySha256: observation.repositoryIdentitySha256,
    expectedBaseSha: observation.expectedBaseSha,
    expectedBranch: observation.expectedBranch,
    expectedBranchBound: observation.expectedBranchBound,
    head: observation.head,
    branch: observation.branch,
    allowedWriteSet: {
      exactPaths: [...observation.allowedWriteSet.exactPaths],
      directoryPrefixes: [...observation.allowedWriteSet.directoryPrefixes],
    },
    stagedPaths: [...observation.stagedPaths],
    unstagedPaths: [...observation.unstagedPaths],
    untrackedPaths: [...observation.untrackedPaths],
    conflictPaths: [...observation.conflictPaths],
    committedPaths: [...observation.committedPaths],
    affectedPaths: [...observation.affectedPaths],
    inScopePaths: [...observation.inScopePaths],
    outOfScopePaths: [...observation.outOfScopePaths],
    currentFiles: observation.currentFiles.map((entry) => ({ ...entry })),
    indexDiffSha256: observation.indexDiffSha256,
    worktreeDiffSha256: observation.worktreeDiffSha256,
    statusSha256: observation.statusSha256,
    scopeStatus: observation.scopeStatus,
    fingerprint: observation.fingerprint,
  };
}

function verifyP35CandidateBinding(
  run: VerificationReceiptRun,
  observation: GitCandidateObservation,
): TaskCandidateSnapshot {
  if (run.state !== "completed" || run.candidateSnapshot === null) {
    throw new VerificationReceiptError(
      "run-incomplete",
      "A verification receipt requires a completed P35 Run with a frozen candidate snapshot.",
    );
  }
  const candidate = run.candidateSnapshot;
  if (!SHA256_RE.test(candidate.fingerprint)) {
    throw new VerificationReceiptError(
      "candidate-not-bound",
      "P35 candidate snapshot fingerprint is invalid.",
    );
  }
  const matchingEntries = candidate.entries.filter(
    (entry) => entry.ref === VERIFICATION_CANDIDATE_ENTRY_REF,
  );
  if (
    matchingEntries.length !== 1 ||
    matchingEntries[0]?.fingerprint !== observation.fingerprint
  ) {
    throw new VerificationReceiptError(
      "candidate-not-bound",
      "P35 candidate snapshot must include exactly one matching Git observation entry.",
    );
  }
  return candidate;
}

function normalizeResults(
  plan: VerificationPlan,
  inputResults: readonly VerificationCheckResult[],
): VerificationCheckResult[] {
  const expected = new Map<string, "selected" | "skipped">();
  for (const entry of plan.selected) expected.set(entry.checkId, "selected");
  for (const entry of plan.skipped) expected.set(entry.checkId, "skipped");
  const provided = new Map<string, VerificationCheckResult>();
  for (const result of inputResults) {
    const checkId = requireText(result.checkId, "result.checkId");
    if (provided.has(checkId) || !expected.has(checkId)) {
      throw new VerificationReceiptError(
        "result-set-mismatch",
        `Unexpected or duplicate verification result: ${checkId}.`,
      );
    }
    if (!CHECK_RESULT_OUTCOMES.includes(result.outcome)) {
      throw new VerificationReceiptError(
        "invalid-result",
        `Unsupported result outcome for ${checkId}.`,
      );
    }
    const kind = expected.get(checkId);
    if (kind === "selected" && result.outcome === "skipped") {
      throw new VerificationReceiptError(
        "invalid-result",
        `Selected check ${checkId} cannot be recorded as skipped.`,
      );
    }
    if (kind === "skipped" && result.outcome !== "skipped") {
      throw new VerificationReceiptError(
        "invalid-result",
        `Unselected check ${checkId} must retain its plan skip decision.`,
      );
    }
    if (["passed", "failed", "blocked"].includes(result.outcome)) {
      if (
        typeof result.evidenceRef !== "string" ||
        result.evidenceRef.trim().length === 0 ||
        result.evidenceRef !== result.evidenceRef.trim()
      ) {
        throw new VerificationReceiptError(
          "invalid-result",
          `Executed check ${checkId} requires a stable evidence reference.`,
        );
      }
    } else if (result.evidenceRef !== undefined) {
      throw new VerificationReceiptError(
        "invalid-result",
        `Check ${checkId} cannot attach execution evidence to ${result.outcome}.`,
      );
    }
    if (
      result.summary !== undefined &&
      (result.summary.trim().length === 0 ||
        result.summary !== result.summary.trim() ||
        result.summary.length > 1_000)
    ) {
      throw new VerificationReceiptError(
        "invalid-result",
        `Summary for ${checkId} must be trimmed and at most 1000 characters.`,
      );
    }
    provided.set(checkId, {
      checkId,
      outcome: result.outcome,
      ...(result.evidenceRef === undefined
        ? {}
        : { evidenceRef: result.evidenceRef }),
      ...(result.summary === undefined ? {} : { summary: result.summary }),
    });
  }
  if (provided.size !== expected.size) {
    const missing = [...expected.keys()].filter(
      (checkId) => !provided.has(checkId),
    );
    throw new VerificationReceiptError(
      "result-set-mismatch",
      `Missing results for: ${missing.join(", ")}.`,
    );
  }
  return [...plan.selected, ...plan.skipped].map((entry) => {
    const result = provided.get(entry.checkId);
    if (result === undefined)
      throw new VerificationReceiptError(
        "result-set-mismatch",
        `Missing result for ${entry.checkId}.`,
      );
    return result;
  });
}

function receiptOutcome(
  plan: VerificationPlan,
  results: readonly VerificationCheckResult[],
): VerificationReceiptOutcome {
  if (results.some((result) => result.outcome === "failed")) return "failed";
  if (results.some((result) => result.outcome === "blocked")) return "blocked";
  if (
    plan.coverageStatus !== "covered" ||
    results.some((result) => result.outcome === "not-run")
  ) {
    return "incomplete";
  }
  return "passed";
}

function receiptBody(
  receipt: Omit<VerificationReceipt, "fingerprint">,
): Omit<VerificationReceipt, "fingerprint"> {
  return receipt;
}

/** Build a P35-bound receipt only after its candidate snapshot includes the observer entry. */
export function createVerificationReceipt(
  input: CreateVerificationReceiptInput,
): VerificationReceipt {
  if (
    !verifyGitCandidateObservation(input.observation) ||
    input.observation.scopeStatus !== "within-write-set"
  ) {
    throw new VerificationReceiptError(
      "invalid-observation",
      "Only an intact, in-write-set Git observation can back a verification receipt.",
    );
  }
  const plan = copyPlan(input.plan);
  const recordedAt = requireText(input.recordedAt, "recordedAt");
  const parsedRecordedAt = new Date(recordedAt);
  if (
    Number.isNaN(parsedRecordedAt.valueOf()) ||
    parsedRecordedAt.toISOString() !== recordedAt
  ) {
    throw new VerificationReceiptError(
      "invalid-recorded-at",
      "recordedAt must be an ISO timestamp with milliseconds and a Z suffix.",
    );
  }
  const candidate = verifyP35CandidateBinding(input.run, input.observation);
  const results = normalizeResults(plan, input.results);
  const body = {
    schemaVersion: 1 as const,
    source: VERIFICATION_RECEIPT_SOURCE,
    recordedAt,
    binding: {
      taskId: requireText(input.run.taskId, "run.taskId"),
      runId: requireText(input.run.id, "run.id"),
      candidateSnapshotId: requireText(candidate.id, "candidateSnapshot.id"),
      candidateFingerprint: candidate.fingerprint,
      observationFingerprint: input.observation.fingerprint,
    },
    observation: copyObservation(input.observation),
    plan,
    results,
    outcome: receiptOutcome(plan, results),
  };
  return { ...body, fingerprint: fingerprint(receiptBody(body)) };
}

function requiredCiEntries(
  plan: VerificationPlan,
): readonly SelectedVerificationCheck[] {
  return plan.selected.filter((entry) => entry.reason === "required-by-policy");
}

/** Derived view: policy declarations remain sourced from plan.selected. */
export function listRequiredCiReceiptResults(
  receipt: VerificationReceipt,
): RequiredCiReceiptResult[] {
  return requiredCiEntries(receipt.plan).map((entry) => {
    const result = receipt.results.find(
      (candidate) => candidate.checkId === entry.checkId,
    );
    if (result === undefined || entry.requiredBy === undefined) {
      throw new VerificationReceiptError(
        "receipt-integrity-mismatch",
        `Required CI result is missing for ${entry.checkId}.`,
      );
    }
    return {
      checkId: entry.checkId,
      requiredBy: [...entry.requiredBy],
      outcome: result.outcome,
      evidenceRef: result.evidenceRef ?? null,
    };
  });
}

/** Stable JSON bytes for persistence by a later task/CLI integration. */
export function serializeVerificationReceipt(
  receipt: VerificationReceipt,
): string {
  if (!verifyVerificationReceiptIntegrity(receipt)) {
    throw new VerificationReceiptError(
      "receipt-integrity-mismatch",
      "Verification receipt fingerprint does not match its contents.",
    );
  }
  return stableJson(receipt);
}

export function verifyVerificationReceiptIntegrity(
  receipt: VerificationReceipt,
): boolean {
  try {
    if (
      receipt.schemaVersion !== 1 ||
      receipt.source !== VERIFICATION_RECEIPT_SOURCE ||
      !SHA256_RE.test(receipt.fingerprint)
    )
      return false;
    const { fingerprint: storedFingerprint, ...body } = receipt;
    return fingerprint(receiptBody(body)) === storedFingerprint;
  } catch {
    return false;
  }
}

/** Compare both the P35 snapshot identity and current Git/file observation. */
export function assessVerificationReceiptFreshness(input: {
  readonly receipt: VerificationReceipt;
  readonly currentRun: VerificationReceiptRun;
  readonly currentObservation: GitCandidateObservation;
}): VerificationReceiptFreshness {
  const { receipt, currentRun, currentObservation } = input;
  const currentCandidate = currentRun.candidateSnapshot;
  const reasonCodes: VerificationFreshnessReason[] = [];
  if (!verifyVerificationReceiptIntegrity(receipt)) {
    return {
      status: "invalid-receipt",
      reasonCodes: ["receipt-integrity-mismatch"],
      receiptFingerprint: receipt.fingerprint,
      currentCandidateFingerprint: currentCandidate?.fingerprint ?? null,
      currentObservationFingerprint: currentObservation.fingerprint,
    };
  }
  if (currentRun.state !== "completed") reasonCodes.push("run-not-completed");
  if (currentRun.taskId !== receipt.binding.taskId)
    reasonCodes.push("task-id-mismatch");
  if (currentRun.id !== receipt.binding.runId)
    reasonCodes.push("run-id-mismatch");
  if (currentCandidate === null) {
    reasonCodes.push("candidate-snapshot-missing");
  } else {
    if (currentCandidate.id !== receipt.binding.candidateSnapshotId)
      reasonCodes.push("candidate-snapshot-id-mismatch");
    if (currentCandidate.fingerprint !== receipt.binding.candidateFingerprint)
      reasonCodes.push("candidate-fingerprint-mismatch");
    const observerEntries = currentCandidate.entries.filter(
      (entry) => entry.ref === VERIFICATION_CANDIDATE_ENTRY_REF,
    );
    if (
      observerEntries.length !== 1 ||
      observerEntries[0]?.fingerprint !== receipt.binding.observationFingerprint
    ) {
      reasonCodes.push("candidate-observer-entry-mismatch");
    }
  }
  if (!verifyGitCandidateObservation(currentObservation))
    reasonCodes.push("current-observation-invalid");
  if (currentObservation.scopeStatus !== "within-write-set")
    reasonCodes.push("current-observation-not-eligible");
  if (
    currentObservation.repositoryIdentitySha256 !==
    receipt.observation.repositoryIdentitySha256
  ) {
    reasonCodes.push("repository-identity-mismatch");
  }
  if (
    currentObservation.fingerprint !== receipt.binding.observationFingerprint
  ) {
    reasonCodes.push("observation-fingerprint-mismatch");
  }
  return {
    status: reasonCodes.length === 0 ? "current" : "stale",
    reasonCodes,
    receiptFingerprint: receipt.fingerprint,
    currentCandidateFingerprint: currentCandidate?.fingerprint ?? null,
    currentObservationFingerprint: currentObservation.fingerprint,
  };
}
