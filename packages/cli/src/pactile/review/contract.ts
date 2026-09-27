import type { TaskRunV2 } from "../../core/task/index.js";
import type { PiReviewEvidenceVerificationV1 } from "./evidence.js";

/**
 * Structured Pi Check Review contract.
 *
 * This module is deliberately adapter-independent: callers must supply trusted
 * Run/reviewer facts from the current Task Kernel/host receipt. A Pi transport
 * outcome is never treated as a Review verdict.
 */

export const INDEPENDENT_REVIEW_AREAS = [
  "task-drift",
  "write-set",
  "standards-maintainability",
  "security",
  "required-validation",
  "open-questions",
] as const;

export type IndependentReviewArea = (typeof INDEPENDENT_REVIEW_AREAS)[number];
export type ReviewDecision = "pass" | "fail" | "needs-changes";
export type ReviewConfidence = "high" | "medium" | "low";
export type EscalationReason = "uncertainty" | "high-impact" | "dispute";

const MAX_TEXT_LENGTH = 1_000;
const MAX_EVIDENCE_REF_LENGTH = 512;
const MAX_ITEMS = 128;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SECRET_PATTERN =
  /\b(?:bearer\s+[a-z0-9._~+/-]{12,}|(?:sk[-_]|gh[pousr]_|glpat-|plane_api_)[a-z0-9_-]{12,}|(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+)/iu;

export type PiTransportOutcome =
  | "settled"
  | "needs_review"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted"
  | "running";

export interface ReviewCandidate {
  snapshotId: string;
  fingerprint: string;
}

export interface PiCheckReviewReceipt {
  piRunId: string;
  role: "check";
  outcome: PiTransportOutcome;
  taskRunId: string;
  candidateSnapshotId: string;
  candidateFingerprint: string;
  sessionId: string | null;
  reviewerId: string | null;
  reviewerIdentityAssurance: "caller-declared" | null;
  kernelRevisionAtDispatch: number;
  startupMs: number | null;
  firstEventMs: number | null;
  elapsedMs: number | null;
  eventCount: number;
  toolErrors: number;
}

const PI_CHECK_RECEIPT_KEYS = [
  "piRunId", "role", "outcome", "taskRunId", "candidateSnapshotId", "candidateFingerprint",
  "sessionId", "reviewerId", "reviewerIdentityAssurance", "kernelRevisionAtDispatch",
  "startupMs", "firstEventMs", "elapsedMs", "eventCount", "toolErrors",
] as const;

/**
 * These facts must come from the current Kernel read and persisted Pi run
 * receipt, not from the model-generated Pi report. Candidate freshness at
 * Close remains a separate P35 caller-observation gate.
 */
export interface IndependentPiReviewContext {
  transportOutcome: PiTransportOutcome;
  reviewerId: string;
  reviewerAuthority: "pi-check" | "jev-advisor";
  latestCompletedRunId: string;
  kernelRevision: number;
  piReceipt: PiCheckReviewReceipt;
  run: Pick<TaskRunV2, "id" | "state" | "startedBy" | "authorization" | "candidateSnapshot" | "host">;
  /** The exact candidate snapshot bound to this Kernel Run and Pi receipt. */
  boundCandidate: ReviewCandidate;
  acceptanceCriterionIds: readonly string[];
  evidenceVerification: PiReviewEvidenceVerificationV1;
}

export interface ReviewCoverage {
  status: "clear" | "finding" | "not-applicable";
  confidence: ReviewConfidence;
  evidenceRefs: string[];
  note: string | null;
}

export interface ReviewFinding {
  id: string;
  area: Exclude<IndependentReviewArea, "open-questions">;
  severity: "warning" | "blocker";
  confidence: ReviewConfidence;
  impact: "low" | "high";
  disputed: boolean;
  summary: string;
  evidenceRefs: string[];
}

export interface ReviewBlocker {
  id: string;
  findingId: string;
  summary: string;
  evidenceRefs: string[];
}

export interface UnresolvedReviewQuestion {
  id: string;
  question: string;
  evidenceRefs: string[];
}

export interface ReviewTelemetry {
  startupMs: number | null;
  firstEventMs: number | null;
  elapsedMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostMicros: number | null;
  timingAssurance: "pi-bridge-local";
  usageAssurance: "caller-declared";
}

export interface PiReviewPromptBinding {
  kernelRevision: number;
  taskId: string;
  runId: string;
  candidateSnapshotId: string;
  candidateFingerprint: string;
  taskTitle: string;
  taskDescription: string;
  deliverable: string;
  runSummary: string;
  runReferences: string[];
  authorizationScope: string;
  writeSetSnapshot: string[];
  candidateEntries: { ref: string; fingerprint: string }[];
  acceptanceCriteria: { id: string; description: string }[];
}

export interface KernelReviewSubmission {
  actor: string;
  runId: string;
  candidateSnapshotId: string;
  candidateFingerprint: string;
  reviewer: string;
  decision: ReviewDecision;
  evidenceRefs: string[];
  acceptanceEvidence: Record<string, string[]>;
  unresolvedBlockers: string[];
}

export interface ValidatedIndependentPiReview {
  contractVersion: 1;
  runId: string;
  candidateSnapshotId: string;
  candidateFingerprint: string;
  reviewer: string;
  reviewerIdentityAssurance: "caller-declared";
  piReceipt: PiCheckReviewReceipt;
  independent: true;
  verdict: ReviewDecision;
  coverage: Record<IndependentReviewArea, ReviewCoverage>;
  findings: ReviewFinding[];
  blockers: ReviewBlocker[];
  unresolvedQuestions: UnresolvedReviewQuestion[];
  evidenceRefs: string[];
  evidenceVerification: PiReviewEvidenceVerificationV1;
  acceptanceEvidence: Record<string, string[]>;
  escalation: {
    required: boolean;
    target: "none" | "codex";
    reasons: EscalationReason[];
  };
  telemetry: ReviewTelemetry;
  /** Directly mappable to P35 RecordTaskReviewRequest fields. */
  kernelReview: KernelReviewSubmission;
}

export type IndependentReviewParseResult =
  | { ok: true; value: ValidatedIndependentPiReview }
  | { ok: false; errors: string[] };

class ReviewValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReviewValidationError";
  }
}

type PlainRecord = Record<string, unknown>;

function invalid(message: string): never {
  throw new ReviewValidationError(message);
}

export function buildIndependentPiReviewPrompt(binding: PiReviewPromptBinding): string {
  const coverage = Object.fromEntries(INDEPENDENT_REVIEW_AREAS.map((area) => [
    area,
    { status: "clear", confidence: "high", evidenceRefs: ["replace-with-evidence-reference"], note: null },
  ]));
  const acceptanceEvidence = Object.fromEntries(
    binding.acceptanceCriteria.map((criterion) => [criterion.id, ["replace-with-criterion-evidence"]]),
  );
  const template = {
    contractVersion: 1,
    runId: binding.runId,
    candidateSnapshotId: binding.candidateSnapshotId,
    candidateFingerprint: binding.candidateFingerprint,
    verdict: "pass",
    coverage,
    findings: [],
    blockers: [],
    unresolvedQuestions: [],
    evidenceRefs: ["replace-with-review-evidence"],
    acceptanceEvidence,
    escalation: { required: false, target: "none", reasons: [] },
    usage: { inputTokens: null, outputTokens: null, estimatedCostMicros: null },
  };
  const context = {
    kernelRevision: binding.kernelRevision,
    taskId: binding.taskId,
    runId: binding.runId,
    candidateSnapshotId: binding.candidateSnapshotId,
    candidateFingerprint: binding.candidateFingerprint,
    task: {
      title: binding.taskTitle,
      description: binding.taskDescription,
      deliverable: binding.deliverable,
      acceptanceCriteria: binding.acceptanceCriteria,
    },
    Run: {
      summary: binding.runSummary,
      references: binding.runReferences,
      authorizedScope: binding.authorizationScope,
      writeSetSnapshot: binding.writeSetSnapshot,
      candidateEntries: binding.candidateEntries,
    },
  };
  return [
    "Perform a read-only independent Pi Check of the fixed candidate shown below. Compare task scope, write-set boundaries, standards and maintainability, obvious security risks, required validation, and unresolved questions. Inspect the cited candidate and verification evidence; do not modify files.",
    "The Run, candidate snapshot ID, fingerprint, and acceptance-criterion IDs are fixed. Do not review a different candidate or infer PASS from this process having settled.",
    "Return exactly one JSON object matching the following shape, without Markdown fences or additional keys. Replace every example evidence reference with a concrete path, test output, or other stable reference. Every coverage area needs evidence. PASS requires evidence for every acceptance criterion, no blockers or unresolved questions, and no Codex escalation.",
    "For each coverage area, status is clear, finding, or not-applicable; use a non-empty note only for not-applicable. Findings must cite evidence. Every blocker must reference a finding. Escalate to Codex when confidence is not high, impact is high, or a finding is disputed. Jev/advisor suggestions are not an independent Review.",
    "Provider token and cost values are unverified caller declarations. Use null when unavailable. The bridge will attach locally measured timing from its Pi run receipt.",
    "Fixed review context:",
    JSON.stringify(context, null, 2),
    "Required JSON shape:",
    JSON.stringify(template, null, 2),
  ].join("\n\n");
}

function record(value: unknown, field: string): PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(field + " must be an object");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalid(field + " must be a plain object");
  return value as PlainRecord;
}

function exactKeys(value: PlainRecord, keys: readonly string[], field: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key)) || keys.some((key) => !Object.hasOwn(value, key))) {
    invalid(field + " has missing or unsupported fields");
  }
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function boundedText(value: unknown, field: string, maxLength = MAX_TEXT_LENGTH): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    hasControlCharacters(value) ||
    SECRET_PATTERN.test(value)
  ) {
    invalid(field + " must be bounded safe text");
  }
  return value;
}

function identifier(value: unknown, field: string): string {
  const parsed = boundedText(value, field, 128);
  if (!IDENTIFIER_PATTERN.test(parsed)) invalid(field + " is invalid");
  return parsed;
}

function fingerprint(value: unknown, field: string): string {
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) {
    invalid(field + " must be a lowercase SHA-256 fingerprint");
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) invalid(field + " is invalid");
  return value as T[number];
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(field + " must be a boolean");
  return value;
}

function integer(
  value: unknown,
  field: string,
  maximum: number,
  nullable = false,
): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    invalid(field + " must be a bounded non-negative integer" + (nullable ? " or null" : ""));
  }
  return value;
}

function textArray(
  value: unknown,
  field: string,
  options: { min?: number; max?: number; evidence?: boolean } = {},
): string[] {
  if (!Array.isArray(value) || value.length > (options.max ?? MAX_ITEMS) || value.length < (options.min ?? 0)) {
    invalid(field + " must be a bounded array");
  }
  const parsed = value.map((item, index) =>
    boundedText(item, field + "[" + index + "]", options.evidence ? MAX_EVIDENCE_REF_LENGTH : MAX_TEXT_LENGTH),
  );
  if (new Set(parsed).size !== parsed.length) invalid(field + " cannot contain duplicates");
  return parsed;
}

function uniqueIdentifiers(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) invalid(field + " must be a bounded array");
  const parsed = value.map((item, index) => identifier(item, field + "[" + index + "]"));
  if (new Set(parsed).size !== parsed.length) invalid(field + " cannot contain duplicates");
  return parsed;
}

function evidenceRefs(value: unknown, field: string): string[] {
  return textArray(value, field, { min: 1, max: MAX_ITEMS, evidence: true });
}

function parseCoverage(value: unknown): Record<IndependentReviewArea, ReviewCoverage> {
  const input = record(value, "coverage");
  exactKeys(input, INDEPENDENT_REVIEW_AREAS, "coverage");
  const parsed = {} as Record<IndependentReviewArea, ReviewCoverage>;
  for (const area of INDEPENDENT_REVIEW_AREAS) {
    const cell = record(input[area], "coverage." + area);
    exactKeys(cell, ["status", "confidence", "evidenceRefs", "note"], "coverage." + area);
    const status = enumValue(cell["status"], ["clear", "finding", "not-applicable"] as const, "coverage." + area + ".status");
    const confidence = enumValue(cell["confidence"], ["high", "medium", "low"] as const, "coverage." + area + ".confidence");
    const refs = evidenceRefs(cell["evidenceRefs"], "coverage." + area + ".evidenceRefs");
    const note = cell["note"] === null ? null : boundedText(cell["note"], "coverage." + area + ".note");
    if (status === "not-applicable" && note === null) invalid("coverage." + area + ".note is required when not applicable");
    if (status !== "not-applicable" && note !== null) invalid("coverage." + area + ".note must be null unless not applicable");
    parsed[area] = { status, confidence, evidenceRefs: refs, note };
  }
  return parsed;
}

function parseFindings(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) invalid("findings must be a bounded array");
  const parsed = value.map((item, index): ReviewFinding => {
    const field = "findings[" + index + "]";
    const input = record(item, field);
    exactKeys(input, ["id", "area", "severity", "confidence", "impact", "disputed", "summary", "evidenceRefs"], field);
    const area = enumValue(
      input["area"],
      ["task-drift", "write-set", "standards-maintainability", "security", "required-validation"] as const,
      field + ".area",
    );
    return {
      id: identifier(input["id"], field + ".id"),
      area,
      severity: enumValue(input["severity"], ["warning", "blocker"] as const, field + ".severity"),
      confidence: enumValue(input["confidence"], ["high", "medium", "low"] as const, field + ".confidence"),
      impact: enumValue(input["impact"], ["low", "high"] as const, field + ".impact"),
      disputed: booleanValue(input["disputed"], field + ".disputed"),
      summary: boundedText(input["summary"], field + ".summary"),
      evidenceRefs: evidenceRefs(input["evidenceRefs"], field + ".evidenceRefs"),
    };
  });
  if (new Set(parsed.map((finding) => finding.id)).size !== parsed.length) invalid("finding IDs must be unique");
  return parsed;
}

function parseBlockers(value: unknown): ReviewBlocker[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) invalid("blockers must be a bounded array");
  const parsed = value.map((item, index): ReviewBlocker => {
    const field = "blockers[" + index + "]";
    const input = record(item, field);
    exactKeys(input, ["id", "findingId", "summary", "evidenceRefs"], field);
    return {
      id: identifier(input["id"], field + ".id"),
      findingId: identifier(input["findingId"], field + ".findingId"),
      summary: boundedText(input["summary"], field + ".summary"),
      evidenceRefs: evidenceRefs(input["evidenceRefs"], field + ".evidenceRefs"),
    };
  });
  if (new Set(parsed.map((blocker) => blocker.id)).size !== parsed.length) invalid("blocker IDs must be unique");
  if (new Set(parsed.map((blocker) => blocker.findingId)).size !== parsed.length) invalid("a finding cannot be listed as multiple blockers");
  return parsed;
}

function parseQuestions(value: unknown): UnresolvedReviewQuestion[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) invalid("unresolvedQuestions must be a bounded array");
  const parsed = value.map((item, index): UnresolvedReviewQuestion => {
    const field = "unresolvedQuestions[" + index + "]";
    const input = record(item, field);
    exactKeys(input, ["id", "question", "evidenceRefs"], field);
    return {
      id: identifier(input["id"], field + ".id"),
      question: boundedText(input["question"], field + ".question"),
      evidenceRefs: evidenceRefs(input["evidenceRefs"], field + ".evidenceRefs"),
    };
  });
  if (new Set(parsed.map((question) => question.id)).size !== parsed.length) invalid("question IDs must be unique");
  return parsed;
}

function parseAcceptanceEvidence(
  value: unknown,
  criteria: readonly string[],
  decision: ReviewDecision,
): Record<string, string[]> {
  const input = record(value, "acceptanceEvidence");
  exactKeys(input, criteria, "acceptanceEvidence");
  const result: Record<string, string[]> = {};
  for (const criterion of criteria) {
    const refs = textArray(input[criterion], "acceptanceEvidence." + criterion, {
      min: decision === "pass" ? 1 : 0,
      max: MAX_ITEMS,
      evidence: true,
    });
    Object.defineProperty(result, criterion, { value: refs, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function parseUsage(value: unknown): Pick<ReviewTelemetry, "inputTokens" | "outputTokens" | "estimatedCostMicros"> {
  const input = record(value, "usage");
  exactKeys(input, ["inputTokens", "outputTokens", "estimatedCostMicros"], "usage");
  return {
    inputTokens: integer(input["inputTokens"], "usage.inputTokens", Number.MAX_SAFE_INTEGER, true),
    outputTokens: integer(input["outputTokens"], "usage.outputTokens", Number.MAX_SAFE_INTEGER, true),
    estimatedCostMicros: integer(input["estimatedCostMicros"], "usage.estimatedCostMicros", Number.MAX_SAFE_INTEGER, true),
  };
}

function parseEscalation(
  value: unknown,
  expectedReasons: EscalationReason[],
  verdict: ReviewDecision,
): ValidatedIndependentPiReview["escalation"] {
  const input = record(value, "escalation");
  exactKeys(input, ["required", "target", "reasons"], "escalation");
  const required = booleanValue(input["required"], "escalation.required");
  const target = enumValue(input["target"], ["none", "codex"] as const, "escalation.target");
  const reasons = textArray(input["reasons"], "escalation.reasons", { max: 3 });
  if (reasons.some((reason) => !["uncertainty", "high-impact", "dispute"].includes(reason))) {
    invalid("escalation.reasons contains an unsupported value");
  }
  if (new Set(reasons).size !== reasons.length) invalid("escalation.reasons cannot contain duplicates");
  if (required !== (expectedReasons.length > 0) || target !== (required ? "codex" : "none")) {
    invalid("escalation marker does not match the review risk signals");
  }
  if (reasons.length !== expectedReasons.length || reasons.some((reason, index) => reason !== expectedReasons[index])) {
    invalid("escalation reasons do not match the review risk signals");
  }
  if (required && verdict === "pass") invalid("a Review requiring Codex escalation cannot pass");
  return { required, target, reasons: expectedReasons };
}

function deriveEscalationReasons(
  coverage: Record<IndependentReviewArea, ReviewCoverage>,
  findings: readonly ReviewFinding[],
  questions: readonly UnresolvedReviewQuestion[],
): EscalationReason[] {
  const reasons: EscalationReason[] = [];
  if (
    questions.length > 0 ||
    INDEPENDENT_REVIEW_AREAS.some((area) => coverage[area].confidence !== "high") ||
    findings.some((finding) => finding.confidence !== "high")
  ) reasons.push("uncertainty");
  if (findings.some((finding) => finding.impact === "high")) reasons.push("high-impact");
  if (findings.some((finding) => finding.disputed)) reasons.push("dispute");
  return reasons;
}

function parsePayload(value: unknown, acceptanceCriteria: readonly string[]): {
  runId: string;
  candidateSnapshotId: string;
  candidateFingerprint: string;
  verdict: ReviewDecision;
  coverage: Record<IndependentReviewArea, ReviewCoverage>;
  findings: ReviewFinding[];
  blockers: ReviewBlocker[];
  unresolvedQuestions: UnresolvedReviewQuestion[];
  evidenceRefs: string[];
  acceptanceEvidence: Record<string, string[]>;
  escalation: unknown;
  usage: Pick<ReviewTelemetry, "inputTokens" | "outputTokens" | "estimatedCostMicros">;
} {
  const input = record(value, "review");
  exactKeys(
    input,
    [
      "contractVersion", "runId", "candidateSnapshotId", "candidateFingerprint", "verdict",
      "coverage", "findings", "blockers", "unresolvedQuestions", "evidenceRefs",
      "acceptanceEvidence", "escalation", "usage",
    ],
    "review",
  );
  if (input["contractVersion"] !== 1) invalid("review.contractVersion must be 1");
  const verdict = enumValue(input["verdict"], ["pass", "fail", "needs-changes"] as const, "review.verdict");
  return {
    runId: identifier(input["runId"], "review.runId"),
    candidateSnapshotId: identifier(input["candidateSnapshotId"], "review.candidateSnapshotId"),
    candidateFingerprint: fingerprint(input["candidateFingerprint"], "review.candidateFingerprint"),
    verdict,
    coverage: parseCoverage(input["coverage"]),
    findings: parseFindings(input["findings"]),
    blockers: parseBlockers(input["blockers"]),
    unresolvedQuestions: parseQuestions(input["unresolvedQuestions"]),
    evidenceRefs: evidenceRefs(input["evidenceRefs"], "review.evidenceRefs"),
    acceptanceEvidence: parseAcceptanceEvidence(input["acceptanceEvidence"], acceptanceCriteria, verdict),
    escalation: input["escalation"],
    usage: parseUsage(input["usage"]),
  };
}

function allReportedEvidenceRefs(parsed: ReturnType<typeof parsePayload>): string[] {
  const references = [
    ...parsed.evidenceRefs,
    ...Object.values(parsed.coverage).flatMap((coverage) => coverage.evidenceRefs),
    ...parsed.findings.flatMap((finding) => finding.evidenceRefs),
    ...parsed.blockers.flatMap((blocker) => blocker.evidenceRefs),
    ...parsed.unresolvedQuestions.flatMap((question) => question.evidenceRefs),
    ...Object.values(parsed.acceptanceEvidence).flat(),
  ];
  return [...new Set(references)].sort();
}

export function collectIndependentPiReviewEvidenceRefs(
  input: unknown,
  acceptanceCriterionIds: readonly string[],
): { ok: true; references: string[] } | { ok: false; errors: string[] } {
  try {
    const criteria = uniqueIdentifiers(acceptanceCriterionIds, "acceptanceCriterionIds");
    const parsed = parsePayload(input, criteria);
    return { ok: true, references: allReportedEvidenceRefs(parsed) };
  } catch (error) {
    const message = error instanceof ReviewValidationError ? error.message : "review evidence references could not be safely collected";
    return { ok: false, errors: [message] };
  }
}

function validateCoverageConsistency(
  coverage: Record<IndependentReviewArea, ReviewCoverage>,
  findings: readonly ReviewFinding[],
  questions: readonly UnresolvedReviewQuestion[],
): void {
  for (const area of INDEPENDENT_REVIEW_AREAS) {
    const count = area === "open-questions"
      ? questions.length
      : findings.filter((finding) => finding.area === area).length;
    if ((coverage[area].status === "finding") !== (count > 0)) {
      invalid("coverage." + area + ".status does not match reported findings");
    }
  }
}

function validateBlockers(findings: readonly ReviewFinding[], blockers: readonly ReviewBlocker[]): void {
  const blockerFindingIds = new Set(findings.filter((finding) => finding.severity === "blocker").map((finding) => finding.id));
  const listedFindingIds = new Set(blockers.map((blocker) => blocker.findingId));
  if (blockerFindingIds.size !== listedFindingIds.size || [...blockerFindingIds].some((id) => !listedFindingIds.has(id))) {
    invalid("every blocking finding must have exactly one unresolved blocker record");
  }
}

function parsePiCheckReceipt(value: unknown): PiCheckReviewReceipt {
  const input = record(value, "context.piReceipt");
  exactKeys(input, PI_CHECK_RECEIPT_KEYS, "context.piReceipt");
  const sessionId = input["sessionId"] === null ? null : identifier(input["sessionId"], "context.piReceipt.sessionId");
  const reviewerId = input["reviewerId"] === null ? null : identifier(input["reviewerId"], "context.piReceipt.reviewerId");
  const assurance = input["reviewerIdentityAssurance"];
  if (assurance !== "caller-declared" && assurance !== null) invalid("context.piReceipt.reviewerIdentityAssurance is invalid");
  return {
    piRunId: identifier(input["piRunId"], "context.piReceipt.piRunId"),
    role: enumValue(input["role"], ["check"] as const, "context.piReceipt.role"),
    outcome: enumValue(input["outcome"], ["settled", "needs_review", "failed", "cancelled", "timed_out", "interrupted", "running"] as const, "context.piReceipt.outcome"),
    taskRunId: identifier(input["taskRunId"], "context.piReceipt.taskRunId"),
    candidateSnapshotId: identifier(input["candidateSnapshotId"], "context.piReceipt.candidateSnapshotId"),
    candidateFingerprint: fingerprint(input["candidateFingerprint"], "context.piReceipt.candidateFingerprint"),
    sessionId,
    reviewerId,
    reviewerIdentityAssurance: assurance,
    kernelRevisionAtDispatch: integer(input["kernelRevisionAtDispatch"], "context.piReceipt.kernelRevisionAtDispatch", Number.MAX_SAFE_INTEGER) as number,
    startupMs: integer(input["startupMs"], "context.piReceipt.startupMs", Number.MAX_SAFE_INTEGER, true),
    firstEventMs: integer(input["firstEventMs"], "context.piReceipt.firstEventMs", Number.MAX_SAFE_INTEGER, true),
    elapsedMs: integer(input["elapsedMs"], "context.piReceipt.elapsedMs", Number.MAX_SAFE_INTEGER, true),
    eventCount: integer(input["eventCount"], "context.piReceipt.eventCount", Number.MAX_SAFE_INTEGER) as number,
    toolErrors: integer(input["toolErrors"], "context.piReceipt.toolErrors", Number.MAX_SAFE_INTEGER) as number,
  };
}

function parseEvidenceVerification(
  value: unknown,
  expected: { runId: string; candidateSnapshotId: string; candidateFingerprint: string },
): PiReviewEvidenceVerificationV1 {
  const input = record(value, "context.evidenceVerification");
  exactKeys(input, ["schemaVersion", "source", "observedAt", "runId", "candidateSnapshotId", "candidateFingerprint", "items"], "context.evidenceVerification");
  if (input["schemaVersion"] !== 1 || input["source"] !== "pactile-task-review-evidence-v1") {
    invalid("context.evidenceVerification schema is unsupported");
  }
  const observedAt = boundedText(input["observedAt"], "context.evidenceVerification.observedAt", 64);
  if (!Number.isFinite(Date.parse(observedAt))) invalid("context.evidenceVerification.observedAt is invalid");
  const runId = identifier(input["runId"], "context.evidenceVerification.runId");
  const candidateSnapshotId = identifier(input["candidateSnapshotId"], "context.evidenceVerification.candidateSnapshotId");
  const candidateFingerprint = fingerprint(input["candidateFingerprint"], "context.evidenceVerification.candidateFingerprint");
  if (runId !== expected.runId || candidateSnapshotId !== expected.candidateSnapshotId || candidateFingerprint !== expected.candidateFingerprint) {
    invalid("Review evidence verification is stale or bound to another candidate");
  }
  if (!Array.isArray(input["items"]) || input["items"].length === 0 || input["items"].length > MAX_ITEMS) {
    invalid("context.evidenceVerification.items must be a bounded non-empty array");
  }
  const items = input["items"].map((item, index) => {
    const field = `context.evidenceVerification.items[${index}]`;
    const fact = record(item, field);
    exactKeys(fact, ["ref", "sha256", "sizeBytes", "source"], field);
    const ref = boundedText(fact["ref"], field + ".ref", MAX_EVIDENCE_REF_LENGTH);
    const sha256 = fingerprint(fact["sha256"], field + ".sha256");
    const sizeBytes = integer(fact["sizeBytes"], field + ".sizeBytes", Number.MAX_SAFE_INTEGER) as number;
    const source = enumValue(fact["source"], ["candidate-snapshot", "run-evidence"] as const, field + ".source");
    return { ref, sha256, sizeBytes, source };
  });
  if (new Set(items.map((item) => item.ref)).size !== items.length) invalid("context.evidenceVerification contains duplicate references");
  return { schemaVersion: 1, source: "pactile-task-review-evidence-v1", observedAt, runId, candidateSnapshotId, candidateFingerprint, items };
}

function parseContext(context: IndependentPiReviewContext): {
  reviewerId: string;
  runId: string;
  candidateSnapshotId: string;
  candidateFingerprint: string;
  acceptanceCriterionIds: string[];
  piReceipt: PiCheckReviewReceipt;
  evidenceVerification: PiReviewEvidenceVerificationV1;
} {
  const kernelRevision = integer(context.kernelRevision, "context.kernelRevision", Number.MAX_SAFE_INTEGER) as number;
  if (context.transportOutcome !== "settled") invalid("Pi transport did not settle; no Review may be recorded");
  if (context.reviewerAuthority !== "pi-check") invalid("Jev/advisor output cannot be recorded as an independent Review");
  const reviewerId = identifier(context.reviewerId, "context.reviewerId");
  const runId = identifier(context.run.id, "context.run.id");
  if (context.run.state !== "completed") invalid("Review requires a completed Run");
  if (identifier(context.latestCompletedRunId, "context.latestCompletedRunId") !== runId) invalid("Review does not target the latest completed Run");
  const executorId = identifier(context.run.startedBy, "context.run.startedBy");
  const approverId = identifier(context.run.authorization.approvedBy, "context.run.authorization.approvedBy");
  if (reviewerId === executorId || reviewerId === approverId) {
    invalid("Review must be performed by someone other than the Run executor and approver");
  }
  if (context.run.candidateSnapshot === null) invalid("completed Run has no candidate snapshot");
  const runCandidateId = identifier(context.run.candidateSnapshot.id, "context.run.candidateSnapshot.id");
  const runCandidateFingerprint = fingerprint(context.run.candidateSnapshot.fingerprint, "context.run.candidateSnapshot.fingerprint");
  const boundCandidateId = identifier(context.boundCandidate.snapshotId, "context.boundCandidate.snapshotId");
  const boundCandidateFingerprint = fingerprint(context.boundCandidate.fingerprint, "context.boundCandidate.fingerprint");
  if (runCandidateId !== boundCandidateId || runCandidateFingerprint !== boundCandidateFingerprint) {
    invalid("bound candidate does not match the latest completed Run snapshot");
  }
  const piReceipt = parsePiCheckReceipt(context.piReceipt);
  if (piReceipt.role !== "check" || piReceipt.outcome !== "settled" || piReceipt.outcome !== context.transportOutcome) {
    invalid("Pi Check receipt is not a settled check run");
  }
  if (identifier(piReceipt.taskRunId, "context.piReceipt.taskRunId") !== runId) {
    invalid("Pi Check receipt targets another Task Run");
  }
  if (
    identifier(piReceipt.candidateSnapshotId, "context.piReceipt.candidateSnapshotId") !== runCandidateId ||
    fingerprint(piReceipt.candidateFingerprint, "context.piReceipt.candidateFingerprint") !== runCandidateFingerprint
  ) invalid("Pi Check receipt candidate is stale or mismatched");
  if (piReceipt.kernelRevisionAtDispatch !== kernelRevision) {
    invalid("Task Kernel revision changed during Pi Check");
  }
  if (piReceipt.sessionId === null) invalid("Pi Check receipt has no session identity");
  const sessionId = identifier(piReceipt.sessionId, "context.piReceipt.sessionId");
  if (context.run.host?.sessionId === sessionId) {
    invalid("Pi Check session matches the implementation Run host session");
  }
  const receiptReviewerId = identifier(piReceipt.reviewerId, "context.piReceipt.reviewerId");
  if (piReceipt.reviewerIdentityAssurance !== "caller-declared" || receiptReviewerId !== `pi-session:${sessionId}` || reviewerId !== receiptReviewerId) {
    invalid("Pi reviewer identity is not bound to its declared session receipt");
  }
  const startupMs = integer(piReceipt.startupMs, "context.piReceipt.startupMs", Number.MAX_SAFE_INTEGER, true);
  const firstEventMs = integer(piReceipt.firstEventMs, "context.piReceipt.firstEventMs", Number.MAX_SAFE_INTEGER, true);
  const elapsedMs = integer(piReceipt.elapsedMs, "context.piReceipt.elapsedMs", Number.MAX_SAFE_INTEGER, true);
  if ((startupMs !== null && elapsedMs !== null && startupMs > elapsedMs) || (firstEventMs !== null && elapsedMs !== null && firstEventMs > elapsedMs)) {
    invalid("Pi Check receipt latency values are inconsistent");
  }
  if (integer(piReceipt.eventCount, "context.piReceipt.eventCount", Number.MAX_SAFE_INTEGER) === 0) {
    invalid("Pi Check receipt contains no RPC events");
  }
  if (integer(piReceipt.toolErrors, "context.piReceipt.toolErrors", Number.MAX_SAFE_INTEGER) !== 0) {
    invalid("Pi Check receipt contains tool errors");
  }
  const acceptanceCriterionIds = uniqueIdentifiers(context.acceptanceCriterionIds, "context.acceptanceCriterionIds");
  const evidenceVerification = parseEvidenceVerification(context.evidenceVerification, {
    runId,
    candidateSnapshotId: runCandidateId,
    candidateFingerprint: runCandidateFingerprint,
  });
  return {
    reviewerId,
    runId,
    candidateSnapshotId: runCandidateId,
    candidateFingerprint: runCandidateFingerprint,
    acceptanceCriterionIds,
    piReceipt,
    evidenceVerification,
  };
}

/**
 * Parse an untrusted structured Pi response and bind it to trusted current Run,
 * candidate, and reviewer facts. Returns safe field-level errors without
 * returning or echoing untrusted input values.
 */
export function safeParseIndependentPiReview(
  input: unknown,
  context: IndependentPiReviewContext,
): IndependentReviewParseResult {
  try {
    const trusted = parseContext(context);
    const parsed = parsePayload(input, trusted.acceptanceCriterionIds);
    if (parsed.runId !== trusted.runId) invalid("review.runId does not match the latest completed Run");
    if (
      parsed.candidateSnapshotId !== trusted.candidateSnapshotId ||
      parsed.candidateFingerprint !== trusted.candidateFingerprint
    ) invalid("Review candidate snapshot is stale or mismatched");
    const reportedEvidenceRefs = allReportedEvidenceRefs(parsed);
    const verifiedEvidenceRefs = trusted.evidenceVerification.items.map((item) => item.ref).sort();
    if (JSON.stringify(reportedEvidenceRefs) !== JSON.stringify(verifiedEvidenceRefs)) {
      invalid("Review evidence references do not match the byte-verified evidence receipt");
    }
    validateCoverageConsistency(parsed.coverage, parsed.findings, parsed.unresolvedQuestions);
    validateBlockers(parsed.findings, parsed.blockers);
    if (parsed.verdict === "pass" && (parsed.blockers.length > 0 || parsed.unresolvedQuestions.length > 0)) {
      invalid("a passing Review cannot contain unresolved blockers or questions");
    }
    const escalationReasons = deriveEscalationReasons(parsed.coverage, parsed.findings, parsed.unresolvedQuestions);
    const escalation = parseEscalation(parsed.escalation, escalationReasons, parsed.verdict);
    const unresolvedBlockers = [
      ...parsed.blockers.map((blocker) => blocker.id + ": " + blocker.summary),
      ...parsed.unresolvedQuestions.map((question) => question.id + ": " + question.question),
    ];
    const kernelReview: KernelReviewSubmission = {
      actor: trusted.reviewerId,
      runId: trusted.runId,
      candidateSnapshotId: trusted.candidateSnapshotId,
      candidateFingerprint: trusted.candidateFingerprint,
      reviewer: trusted.reviewerId,
      decision: parsed.verdict,
      evidenceRefs: trusted.evidenceVerification.items.map((item) => item.ref),
      acceptanceEvidence: parsed.acceptanceEvidence,
      unresolvedBlockers,
    };
    return {
      ok: true,
      value: {
        contractVersion: 1,
        runId: trusted.runId,
        candidateSnapshotId: trusted.candidateSnapshotId,
        candidateFingerprint: trusted.candidateFingerprint,
        reviewer: trusted.reviewerId,
        reviewerIdentityAssurance: "caller-declared",
        piReceipt: trusted.piReceipt,
        independent: true,
        verdict: parsed.verdict,
        coverage: parsed.coverage,
        findings: parsed.findings,
        blockers: parsed.blockers,
        unresolvedQuestions: parsed.unresolvedQuestions,
        evidenceRefs: parsed.evidenceRefs,
        evidenceVerification: trusted.evidenceVerification,
        acceptanceEvidence: parsed.acceptanceEvidence,
        escalation,
        telemetry: {
          startupMs: trusted.piReceipt.startupMs,
          firstEventMs: trusted.piReceipt.firstEventMs,
          elapsedMs: trusted.piReceipt.elapsedMs,
          ...parsed.usage,
          timingAssurance: "pi-bridge-local",
          usageAssurance: "caller-declared",
        },
        kernelReview,
      },
    };
  } catch (error) {
    const message = error instanceof ReviewValidationError ? error.message : "review input could not be safely parsed";
    return { ok: false, errors: [message] };
  }
}
