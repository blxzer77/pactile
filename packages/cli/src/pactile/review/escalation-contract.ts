import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolvePiReviewEvidenceV1 } from "./evidence.js";
import type { ReviewDecision } from "./contract.js";

export interface PreparedPiReviewEscalationV1 {
  schemaVersion: 1;
  source: "pactile-pi-review-escalation-v1";
  status: "prepared";
  requestId: string;
  target: "codex";
  taskId: string;
  reviewId: string;
  piRunId: string;
  escalationId: string;
  runId: string;
  candidateSnapshotId: string;
  candidateFingerprint: string;
  reviewArtifactRef: string;
  reviewArtifactSha256: string;
  reviewContentFingerprint: string;
  reasons: string[];
  summary: string;
  preparedFingerprint: string;
  preparedAt: string;
  sentAt: null;
  responseRef: null;
}

export interface ReadPiReviewEscalationV1 {
  ref: string;
  request: PreparedPiReviewEscalationV1;
  reviewArtifact: Record<string, unknown>;
  taskDir: string;
}

export interface CodexEscalationReviewResolutionV1 {
  schemaVersion: 1;
  source: "pactile-codex-escalation-review-resolution-v1";
  escalationId: string;
  preparedRequestRef: string;
  preparedFingerprint: string;
  piReviewArtifactRef: string;
  piReviewArtifactSha256: string;
  piReviewContentFingerprint: string;
  sourceTaskId: string;
  runId: string;
  candidateSnapshotId: string;
  candidateFingerprint: string;
  sendRequestId: string;
  sendRequestFingerprint: string;
  sendRequestRef: string;
  sendReceiptRef: string;
  replyTaskId: string;
  readRequestId: string;
  readRequestFingerprint: string;
  readRequestRef: string;
  readReceiptRef: string;
  responseTurnId: string;
  responseBodySha256: string;
  codexReviewer: string;
  codexReviewId: string;
  decision: ReviewDecision;
  review: Record<string, unknown>;
  evidenceVerification: ReturnType<typeof resolvePiReviewEvidenceV1>;
  contentFingerprint: string;
}

export interface CodexEscalationReviewReplyV1 {
  contractVersion: 1;
  source: "pactile-codex-escalation-review-v1";
  binding: {
    taskId: string;
    runId: string;
    candidateSnapshotId: string;
    candidateFingerprint: string;
    escalationId: string;
    piRunId: string;
    reviewId: string;
    reviewArtifactRef: string;
    reviewArtifactSha256: string;
    reviewContentFingerprint: string;
  };
  reviewer: {
    hostId: string;
    threadId: string;
    role: "review";
    independent: true;
  };
  review: unknown;
}

export const PI_REVIEW_ESCALATION_REPLY_CONTRACT = {
  contractVersion: 1,
  source: "pactile-codex-escalation-review-v1",
  binding: [
    "taskId",
    "runId",
    "candidateSnapshotId",
    "candidateFingerprint",
    "escalationId",
    "piRunId",
    "reviewId",
    "reviewArtifactRef",
    "reviewArtifactSha256",
    "reviewContentFingerprint",
  ],
  reviewer: ["hostId", "threadId", "role", "independent"],
  review: [
    "contractVersion",
    "runId",
    "candidateSnapshotId",
    "candidateFingerprint",
    "verdict",
    "coverage",
    "findings",
    "blockers",
    "unresolvedQuestions",
    "concernResolutions",
    "evidenceRefs",
    "acceptanceEvidence",
  ],
} as const;

export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const escalationIdPattern =
  /^pi-escalation:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const fingerprintPattern = /^[a-f0-9]{64}$/;

export function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export function requireStringField(
  value: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const result = value[field];
  if (typeof result !== "string" || !result) {
    throw new Error(`${label} has no ${field}`);
  }
  return result;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} has an unsupported shape`);
  }
}

export function safeExistingArtifactFile(taskDir: string, ref: string): string {
  const task = fs.realpathSync(taskDir);
  if (!ref || path.isAbsolute(ref) || ref.includes("\0")) {
    throw new Error("Pi Review artifact path is invalid");
  }
  const file = path.resolve(task, ref);
  const relative = path.relative(task, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Pi Review artifact path escapes the Task directory");
  }
  const realFile = fs.realpathSync(file);
  const realRelative = path.relative(task, realFile);
  if (
    !realRelative ||
    realRelative.startsWith("..") ||
    path.isAbsolute(realRelative) ||
    !fs.statSync(realFile).isFile()
  ) {
    throw new Error("Pi Review artifact does not resolve to a Task file");
  }
  return realFile;
}

export function parseJsonObject(bytes: Buffer, label: string): Record<string, unknown> {
  try {
    return objectValue(JSON.parse(bytes.toString("utf8")), label);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function preparedKeys(): string[] {
  return [
    "schemaVersion", "source", "status", "requestId", "target", "taskId",
    "reviewId", "piRunId", "escalationId", "runId", "candidateSnapshotId",
    "candidateFingerprint", "reviewArtifactRef", "reviewArtifactSha256",
    "reviewContentFingerprint", "reasons", "summary", "preparedFingerprint",
    "preparedAt", "sentAt", "responseRef",
  ];
}

export function preparedSummaryFromPiReview(
  review: Record<string, unknown>,
  reasons: readonly string[],
): string {
  if (!Array.isArray(review["findings"]) || !Array.isArray(review["unresolvedQuestions"])) {
    throw new Error("Pi Review artifact has no bounded findings and questions");
  }
  return [
    `Review verdict: ${String(review["verdict"])}`,
    `Run: ${requireStringField(review, "runId", "Pi Review artifact")}`,
    `Candidate: ${requireStringField(review, "candidateSnapshotId", "Pi Review artifact")} (${requireStringField(review, "candidateFingerprint", "Pi Review artifact")})`,
    `Escalation reasons: ${reasons.join(", ")}`,
    ...review["findings"].map((value) => {
      const finding = objectValue(value, "Pi Review finding");
      return `Finding ${requireStringField(finding, "id", "Pi Review finding")} [${requireStringField(finding, "severity", "Pi Review finding")}]: ${requireStringField(finding, "summary", "Pi Review finding")}`;
    }),
    ...review["unresolvedQuestions"].map((value) => {
      const question = objectValue(value, "Pi Review question");
      return `Question ${requireStringField(question, "id", "Pi Review question")}: ${requireStringField(question, "question", "Pi Review question")}`;
    }),
  ].join("\n");
}

export interface PiReviewConcern {
  concernId: string;
  kind: "finding" | "blocker" | "question";
}

export function piReviewConcerns(
  review: Record<string, unknown>,
): PiReviewConcern[] {
  const concerns: PiReviewConcern[] = [];
  const add = (
    field: string,
    kind: "finding" | "blocker" | "question",
  ): void => {
    const values = review[field];
    if (!Array.isArray(values)) {
      throw new Error(`Pi Review artifact has no ${field} array`);
    }
    for (const value of values) {
      const item = objectValue(value, `Pi Review ${kind}`);
      const sourceId = requireStringField(item, "id", `Pi Review ${kind}`);
      concerns.push({
        concernId: `pi-${kind}-${sha256(sourceId).slice(0, 24)}`,
        kind,
      });
    }
  };
  add("findings", "finding");
  add("blockers", "blocker");
  add("unresolvedQuestions", "question");
  if (new Set(concerns.map((item) => item.concernId)).size !== concerns.length) {
    throw new Error("Pi Review concerns do not have unique stable identifiers");
  }
  return concerns;
}
