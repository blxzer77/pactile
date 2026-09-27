import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ValidatedIndependentPiReview } from "./contract.js";

export interface PreparedPiReviewEscalationV1 {
  schemaVersion: 1;
  source: "pactile-pi-review-escalation-v1";
  status: "prepared";
  requestId: string;
  target: "codex";
  taskId: string;
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeArtifactFile(taskDir: string, ref: string): string {
  const task = fs.realpathSync(taskDir);
  const file = path.resolve(task, ref);
  const relative = path.relative(task, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Pi Review artifact path escapes the Task directory");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const parent = fs.realpathSync(path.dirname(file));
  const parentRelative = path.relative(task, parent);
  if (
    !parentRelative ||
    parentRelative.startsWith("..") ||
    path.isAbsolute(parentRelative)
  ) {
    throw new Error(
      "Pi Review artifact directory resolves outside the Task directory",
    );
  }
  return file;
}

/** Persist a Codex escalation request bound to the immutable Review artifact; never dispatch it. */
export function preparePiReviewEscalationV1(input: {
  taskDir: string;
  reviewId: string;
  taskId: string;
  review: ValidatedIndependentPiReview;
  reviewArtifactRef: string;
  reviewArtifactSha256: string;
  reviewContentFingerprint: string;
}): { ref: string; request: PreparedPiReviewEscalationV1 } {
  if (
    !input.review.escalation.required ||
    input.review.escalation.target !== "codex"
  ) {
    throw new Error("Pi Review does not require Codex escalation");
  }
  const summaryParts = [
    `Review verdict: ${input.review.verdict}`,
    `Run: ${input.review.runId}`,
    `Candidate: ${input.review.candidateSnapshotId} (${input.review.candidateFingerprint})`,
    `Escalation reasons: ${input.review.escalation.reasons.join(", ")}`,
    ...input.review.findings.map(
      (finding) =>
        `Finding ${finding.id} [${finding.severity}]: ${finding.summary}`,
    ),
    ...input.review.unresolvedQuestions.map(
      (question) => `Question ${question.id}: ${question.question}`,
    ),
  ];
  const requestCore = {
    schemaVersion: 1 as const,
    source: "pactile-pi-review-escalation-v1" as const,
    status: "prepared" as const,
    requestId: randomUUID(),
    target: "codex" as const,
    taskId: input.taskId,
    runId: input.review.runId,
    candidateSnapshotId: input.review.candidateSnapshotId,
    candidateFingerprint: input.review.candidateFingerprint,
    reviewArtifactRef: input.reviewArtifactRef,
    reviewArtifactSha256: input.reviewArtifactSha256,
    reviewContentFingerprint: input.reviewContentFingerprint,
    reasons: [...input.review.escalation.reasons],
    summary: summaryParts.join("\n"),
    preparedAt: new Date().toISOString(),
    sentAt: null,
    responseRef: null,
  };
  const request: PreparedPiReviewEscalationV1 = {
    ...requestCore,
    preparedFingerprint: sha256(JSON.stringify(requestCore)),
  };
  const ref = `pi-bridge/escalations/${input.reviewId}.json`;
  const file = safeArtifactFile(input.taskDir, ref);
  fs.writeFileSync(file, `${JSON.stringify(request, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return { ref, request };
}

export function fingerprintPiReviewArtifact(value: unknown): string {
  return sha256(JSON.stringify(value));
}

export function writePiReviewArtifact(
  taskDir: string,
  reviewId: string,
  artifact: Record<string, unknown>,
): { ref: string; file: string; sha256: string; contentFingerprint: string } {
  const contentFingerprint = fingerprintPiReviewArtifact(artifact);
  const value = { ...artifact, contentFingerprint };
  const ref = `pi-bridge/reviews/${reviewId}-${contentFingerprint}.json`;
  const file = safeArtifactFile(taskDir, ref);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  return { ref, file, sha256: sha256(bytes), contentFingerprint };
}
