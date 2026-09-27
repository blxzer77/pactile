import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readTaskKernel, verifyTaskReviewEvidenceV1, type TaskKernelSnapshotV2, type TaskReviewV2, type TaskRunV2 } from "../../core/task/index.js";
import { resolveTaskDir } from "../task/session.js";
import { INDEPENDENT_REVIEW_AREAS, type ValidatedIndependentPiReview } from "./contract.js";
import { escalationIdPattern, exactKeys, fingerprintPattern, isRecord, objectValue, parseJsonObject, piReviewConcerns, preparedKeys, preparedSummaryFromPiReview, safeExistingArtifactFile, sha256, uuidPattern, type CodexEscalationReviewReplyV1, type PreparedPiReviewEscalationV1, type ReadPiReviewEscalationV1 } from "./escalation-contract.js";

/** Read the actual P40 prepared artifact and verify it against its immutable Review artifact. */
export function readPiReviewEscalationV1(
  root: string,
  taskReference: string,
  escalationId: string,
): ReadPiReviewEscalationV1 {
  const match = escalationIdPattern.exec(escalationId);
  if (!match) throw new Error("Invalid Pi Review escalation ID");
  const piRunId = match[1];
  if (!piRunId) throw new Error("Invalid Pi Review escalation ID");
  const taskDir = resolveTaskDir(root, taskReference);
  if (!fs.statSync(taskDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Task not found: ${taskReference}`);
  }
  const task = fs.realpathSync(taskDir);
  const requestRef = `pi-bridge/escalations/pi-review-${piRunId}.json`;
  const requestFile = safeExistingArtifactFile(task, requestRef);
  const requestBytes = fs.readFileSync(requestFile);
  const requestValue = parseJsonObject(requestBytes, "Pi Review escalation request");
  exactKeys(requestValue, preparedKeys(), "Pi Review escalation request");
  const request = requestValue as unknown as PreparedPiReviewEscalationV1;
  const requestCore = { ...requestValue };
  delete requestCore["preparedFingerprint"];
  if (
    request.schemaVersion !== 1 ||
    request.source !== "pactile-pi-review-escalation-v1" ||
    request.status !== "prepared" ||
    request.target !== "codex" ||
    request.piRunId !== piRunId ||
    request.reviewId !== `pi-review-${piRunId}` ||
    request.escalationId !== escalationId ||
    !uuidPattern.test(request.requestId) ||
    request.sentAt !== null ||
    request.responseRef !== null ||
    !fingerprintPattern.test(request.candidateFingerprint) ||
    !fingerprintPattern.test(request.reviewArtifactSha256) ||
    !fingerprintPattern.test(request.reviewContentFingerprint) ||
    !fingerprintPattern.test(request.preparedFingerprint) ||
    sha256(JSON.stringify(requestCore)) !== request.preparedFingerprint
  ) {
    throw new Error("Pi Review escalation request failed its prepared binding check");
  }

  const reviewFile = safeExistingArtifactFile(task, request.reviewArtifactRef);
  const reviewBytes = fs.readFileSync(reviewFile);
  if (sha256(reviewBytes) !== request.reviewArtifactSha256) {
    throw new Error("Stored Pi Review artifact hash does not match the escalation request");
  }
  const artifact = parseJsonObject(reviewBytes, "Pi Review artifact");
  const artifactContentFingerprint = artifact["contentFingerprint"];
  const artifactCore = { ...artifact };
  delete artifactCore["contentFingerprint"];
  if (
    artifact["schemaVersion"] !== 1 ||
    artifact["source"] !== "pactile-independent-pi-review-v1" ||
    artifact["reviewId"] !== request.reviewId ||
    artifact["taskId"] !== request.taskId ||
    artifact["taskRunId"] !== request.runId ||
    artifact["piRunId"] !== piRunId ||
    artifactContentFingerprint !== request.reviewContentFingerprint ||
    sha256(JSON.stringify(artifactCore)) !== request.reviewContentFingerprint
  ) {
    throw new Error("Pi Review artifact content does not match the escalation request");
  }
  const review = objectValue(artifact["review"], "Pi Review result");
  const escalation = objectValue(review["escalation"], "Pi Review escalation");
  const kernelReview = objectValue(review["kernelReview"], "Pi Kernel Review");
  if (
    review["runId"] !== request.runId ||
    review["candidateSnapshotId"] !== request.candidateSnapshotId ||
    review["candidateFingerprint"] !== request.candidateFingerprint ||
    request.reviewArtifactRef !== `pi-bridge/reviews/${request.reviewId}-${request.reviewContentFingerprint}.json` ||
    request.taskId !== artifact["taskId"] ||
    request.runId !== review["runId"] ||
    request.candidateSnapshotId !== review["candidateSnapshotId"] ||
    request.candidateFingerprint !== review["candidateFingerprint"] ||
    review["verdict"] === "pass" ||
    escalation["required"] !== true ||
    escalation["target"] !== "codex" ||
    !Array.isArray(escalation["reasons"]) ||
    JSON.stringify(escalation["reasons"]) !== JSON.stringify(request.reasons) ||
    request.summary !== preparedSummaryFromPiReview(review, request.reasons) ||
    kernelReview["decision"] !== review["verdict"] ||
    kernelReview["runId"] !== request.runId ||
    kernelReview["candidateSnapshotId"] !== request.candidateSnapshotId ||
    kernelReview["candidateFingerprint"] !== request.candidateFingerprint
  ) {
    throw new Error("Pi Review escalation does not match its prepared binding");
  }
  return { ref: requestRef, request, reviewArtifact: artifact, taskDir: task };
}

export function assertCurrentPiReviewEscalationV1(
  root: string,
  taskReference: string,
  prepared: ReadPiReviewEscalationV1,
): {
  kernel: TaskKernelSnapshotV2;
  run: TaskRunV2;
  review: TaskReviewV2;
  taskDir: string;
} {
  const read = readTaskKernel({
    root,
    taskDir: prepared.taskDir,
    cwd: root,
  });
  if (read.kind !== "task-kernel-v2") {
    throw new Error("Pi Review escalation requires a Task Kernel v2 task");
  }
  const kernel = read.kernel;
  const request = prepared.request;
  if (
    kernel.identity.taskId !== request.taskId ||
    kernel.phase !== "verify"
  ) {
    throw new Error("Pi Review escalation Task is no longer in its bound Verify state");
  }
  const run = kernel.runs.at(-1);
  if (
    run?.id !== request.runId ||
    run.state !== "completed" ||
    run.candidateSnapshot?.id !== request.candidateSnapshotId ||
    run.candidateSnapshot.fingerprint !== request.candidateFingerprint
  ) {
    throw new Error("Pi Review escalation Run or candidate is no longer current");
  }
  const review = kernel.reviews.find((item) => item.id === request.reviewId);
  const latestForCandidate = kernel.reviews
    .filter(
      (item) =>
        item.runId === request.runId &&
        item.candidateSnapshotId === request.candidateSnapshotId &&
        item.candidateFingerprint === request.candidateFingerprint,
    )
    .at(-1);
  const codexReviewId = `codex-review-${request.piRunId}`;
  if (
    !review ||
    (latestForCandidate?.id !== request.reviewId &&
      latestForCandidate?.id !== codexReviewId) ||
    review.decision === "pass" ||
    review.evidenceRefs.includes(request.reviewArtifactRef) !== true
  ) {
    throw new Error("Pi escalation requires its latest recorded non-PASS Kernel Review");
  }
  const piRunFile = safeExistingArtifactFile(
    prepared.taskDir,
    `pi-bridge/runs/${request.piRunId}.json`,
  );
  const piRun = parseJsonObject(fs.readFileSync(piRunFile), "Pi Check run receipt");
  if (
    piRun["run_id"] !== request.piRunId ||
    piRun["task_id"] !== request.taskId ||
    piRun["task_run_id"] !== request.runId ||
    piRun["role"] !== "check" ||
    piRun["outcome"] !== "settled" ||
    piRun["review_status"] !== "recorded" ||
    piRun["review_file"] !== request.reviewArtifactRef ||
    piRun["kernel_review_id"] !== request.reviewId ||
    piRun["codex_escalation_request_ref"] !== prepared.ref ||
    !["prepared", "review-recorded"].includes(
      String(piRun["codex_escalation_request_status"]),
    )
  ) {
    throw new Error("Pi Check receipt does not bind the prepared escalation and Kernel Review");
  }
  if (!review.evidenceVerification || !run.candidateSnapshot) {
    throw new Error("The original Pi Kernel Review has no frozen Core evidence digest");
  }
  verifyTaskReviewEvidenceV1({
    root,
    taskDir: prepared.taskDir,
    run,
    candidateSnapshotId: request.candidateSnapshotId,
    candidateFingerprint: request.candidateFingerprint,
    evidenceRefs: [
      ...new Set([
        ...review.evidenceRefs,
        ...Object.values(review.acceptanceEvidence).flat(),
      ]),
    ],
    expected: review.evidenceVerification,
  });
  return { kernel, run, review, taskDir: prepared.taskDir };
}

export function buildCodexEscalationPromptV1(input: {
  prepared: ReadPiReviewEscalationV1;
  hostId: string;
  threadId: string;
}): string {
  const request = input.prepared.request;
  const artifactReview = objectValue(
    input.prepared.reviewArtifact["review"],
    "Pi Review result",
  );
  const evidenceVerification = objectValue(
    artifactReview["evidenceVerification"],
    "Pi Review evidence verification",
  );
  const verifiedItems = Array.isArray(evidenceVerification["items"])
    ? evidenceVerification["items"]
    : [];
  const evidenceRefs = verifiedItems.flatMap((item) =>
    isRecord(item) && typeof item["ref"] === "string" ? [item["ref"]] : [],
  );
  if (!evidenceRefs.length) {
    throw new Error("Codex escalation Review requires byte-verified evidence");
  }
  const criteria = objectValue(
    artifactReview["acceptanceEvidence"],
    "Pi Review acceptance evidence",
  );
  const concerns = piReviewConcerns(artifactReview);
  const binding = {
    taskId: request.taskId,
    runId: request.runId,
    candidateSnapshotId: request.candidateSnapshotId,
    candidateFingerprint: request.candidateFingerprint,
    escalationId: request.escalationId,
    piRunId: request.piRunId,
    reviewId: request.reviewId,
    reviewArtifactRef: request.reviewArtifactRef,
    reviewArtifactSha256: request.reviewArtifactSha256,
    reviewContentFingerprint: request.reviewContentFingerprint,
  };
  const reviewTemplate = {
    contractVersion: 1,
    runId: request.runId,
    candidateSnapshotId: request.candidateSnapshotId,
    candidateFingerprint: request.candidateFingerprint,
    verdict: "needs-changes",
    coverage: Object.fromEntries(
      INDEPENDENT_REVIEW_AREAS.map((area) => [
        area,
        {
          status: area === "open-questions" ? "not-applicable" : "clear",
          confidence: "high",
          evidenceRefs: evidenceRefs.length ? [evidenceRefs[0]] : [],
          note: area === "open-questions" ? "No unresolved questions." : null,
        },
      ]),
    ),
    findings: [],
    blockers: [],
    unresolvedQuestions: [],
    concernResolutions: concerns.map((concern) => ({
      concernId: concern.concernId,
      disposition: "still-blocking",
      rationale: "",
      evidenceRefs: [],
    })),
    evidenceRefs,
    acceptanceEvidence: criteria,
  };
  const contractTemplate: CodexEscalationReviewReplyV1 = {
    contractVersion: 1,
    source: "pactile-codex-escalation-review-v1",
    binding,
    reviewer: {
      hostId: input.hostId,
      threadId: input.threadId,
      role: "review",
      independent: true,
    },
    review: reviewTemplate,
  };
  const prompt = [
    "Perform the requested read-only independent Codex Review for this Pi escalation.",
    "Do not edit files, run tools that mutate state, change approvals, resume execution, or close the Task.",
    "Return exactly one JSON object matching the provided P40 reply contract, without Markdown fences or extra keys.",
    "Copy every binding value exactly. Use only evidenceRefs that resolve to the bound candidate snapshot or completed Run evidence. Include every reported reference in the review evidenceRefs array. Address every listed Pi concern exactly once in concernResolutions. The template deliberately marks every concern still-blocking and leaves rationale/evidenceRefs blank; replace these fields with your evidence-based findings. A PASS requires every original Pi concern to be resolved with evidence, every acceptance criterion to have evidence, and no blockers or unresolved questions. Never use placeholder rationale.",
    `Pi concern identifiers (the bound artifact contains the read-only descriptions): ${JSON.stringify(concerns)}`,
    "The native read_thread receipt supplies the responseTurnId; do not invent one in this body.",
    `Source Task evidence directory: ${input.prepared.taskDir}`,
    `Pi Review artifact: ${request.reviewArtifactRef} (sha256 ${request.reviewArtifactSha256}; content ${request.reviewContentFingerprint})`,
    `Allowed verified candidate/Run evidence references: ${JSON.stringify(evidenceRefs)}`,
    `P40 reply contract template:\n${JSON.stringify(contractTemplate)}`,
  ].join("\n\n");
  if (Buffer.byteLength(prompt, "utf8") > 4_096) {
    throw new Error("Codex escalation Review prompt exceeds the cross-task message limit");
  }
  return prompt;
}

export function safeArtifactFile(taskDir: string, ref: string): string {
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
  const piRunId = input.review.piReceipt.piRunId;
  if (!uuidPattern.test(piRunId) || input.reviewId !== `pi-review-${piRunId}`) {
    throw new Error("Pi Review escalation ID is not bound to its Pi Check Run");
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
    reviewId: input.reviewId,
    piRunId,
    escalationId: `pi-escalation:${piRunId}`,
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
