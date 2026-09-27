import fs from "node:fs";
import path from "node:path";
import { readTaskKernel, recordTaskReview } from "../../core/task/index.js";
import { resolveTaskDir } from "../task/session.js";
import { resolvePiReviewEvidenceV1 } from "./evidence.js";
import { assertCurrentPiReviewEscalationV1, readPiReviewEscalationV1 } from "./escalation-artifacts.js";
import { exactKeys, objectValue, parseJsonObject, requireStringField, safeExistingArtifactFile, sameStrings, sha256, type CodexEscalationReviewResolutionV1 } from "./escalation-contract.js";
import { safeArtifactFile } from "./escalation-artifacts.js";
import { assertBoundCodexReviewThread, readCodexBridgeEvidence, readCodexEscalationSendV1, writeImmutableEvidenceCopy } from "./escalation-transport.js";
import { validateCodexReplyEnvelope } from "./escalation-reply.js";
import type { ReviewDecision } from "./contract.js";
import { withProjectSchedulerMutex } from "../scheduler/project-lease-store.js";

/** Consume the bound native Codex send/read receipts and record a new Kernel Review. */
export function recordCodexEscalationReviewV1(input: {
  root: string;
  sourceTask: string;
  escalationId: string;
  sendRequestId: string;
  readRequestId: string;
}): { reviewId: string; decision: ReviewDecision; resolutionRef: string } {
  return withProjectSchedulerMutex(input.root, () =>
    recordCodexEscalationReviewUnlocked(input),
  );
}

function recordCodexEscalationReviewUnlocked(input: {
  root: string;
  sourceTask: string;
  escalationId: string;
  sendRequestId: string;
  readRequestId: string;
}): { reviewId: string; decision: ReviewDecision; resolutionRef: string } {
  const prepared = readPiReviewEscalationV1(
    input.root,
    input.sourceTask,
    input.escalationId,
  );
  const current = assertCurrentPiReviewEscalationV1(
    input.root,
    input.sourceTask,
    prepared,
  );
  const request = prepared.request;
  const send = readCodexBridgeEvidence(current.taskDir, input.sendRequestId, "Codex escalation send");
  const sendRequest = send.request;
  const sendReceipt = send.receipt;
  const sourceTaskRef = path.relative(input.root, current.taskDir).replaceAll("\\", "/");
  const latestSend = readCodexEscalationSendV1({
    root: input.root,
    sourceTask: input.sourceTask,
    escalationId: input.escalationId,
    sendRequestId: input.sendRequestId,
  });
  const codexReviewId = `codex-review-${request.piRunId}`;
  const priorCodexReview = current.kernel.reviews.find(
    (item) => item.id === codexReviewId,
  );
  if (
    sendRequest["task"] !== sourceTaskRef ||
    sendRequest["task_id"] !== request.taskId ||
    sendRequest["task_kernel_kind"] !== "task-kernel-v2" ||
    (sendRequest["kernel_revision"] !== current.kernel.revision &&
      !(priorCodexReview && current.kernel.revision === Number(sendRequest["kernel_revision"]) + 1)) ||
    sendRequest["run_id"] !== request.runId ||
    sendRequest["candidate_snapshot_id"] !== request.candidateSnapshotId ||
    sendRequest["candidate_fingerprint"] !== request.candidateFingerprint ||
    sendRequest["tool"] !== "send_message_to_thread" ||
    sendRequest["role"] !== "review" ||
    sendRequest["escalation_id"] !== input.escalationId ||
    sendRequest["escalation_source_task"] !== sourceTaskRef ||
    sendRequest["escalation_source_task_id"] !== request.taskId ||
    sendRequest["escalation_prepared_request_ref"] !== prepared.ref ||
    sendRequest["escalation_prepared_fingerprint"] !== request.preparedFingerprint ||
    typeof sendRequest["to_task"] !== "string" ||
    typeof sendRequest["to_task_id"] !== "string" ||
    typeof sendRequest["thread_id"] !== "string" ||
    typeof sendRequest["host_id"] !== "string" ||
    sendReceipt["request_id"] !== input.sendRequestId ||
    latestSend.requestFingerprint !== sendRequest["request_fingerprint"] ||
    latestSend.receiptSha256 !== sha256(send.receiptBytes) ||
    sendReceipt["task_id"] !== request.taskId ||
    sendReceipt["run_id"] !== request.runId ||
    sendReceipt["candidate_snapshot_id"] !== request.candidateSnapshotId ||
    sendReceipt["candidate_fingerprint"] !== request.candidateFingerprint ||
    sendReceipt["to_task_id"] !== sendRequest["to_task_id"] ||
    sendReceipt["escalation_id"] !== input.escalationId ||
    sendReceipt["evidence_level"] !== "desktop-native" ||
    sendReceipt["outcome"] !== "ok" ||
    sendReceipt["tool"] !== "send_message_to_thread" ||
    sendReceipt["thread_id"] !== sendRequest["thread_id"] ||
    sendReceipt["host_id"] !== sendRequest["host_id"] ||
    sendReceipt["contract_stale"] !== false ||
    sendReceipt["kernel_revision_at_receipt"] !== sendRequest["kernel_revision"] ||
    sendReceipt["destination_kernel_revision_at_receipt"] !== sendRequest["to_kernel_revision"]
  ) {
    throw new Error("Codex escalation send request or native receipt is stale or misbound");
  }
  const replyTask = String(sendRequest["to_task"]);
  const replyTaskDir = resolveTaskDir(input.root, replyTask);
  if (!fs.statSync(replyTaskDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Codex escalation reply Task is missing");
  }
  const replyTaskPath = fs.realpathSync(replyTaskDir);
  const read = readCodexBridgeEvidence(replyTaskPath, input.readRequestId, "Codex escalation reply read");
  const readRequest = read.request;
  const readReceipt = read.receipt;
  const replyTaskRef = path.relative(input.root, replyTaskPath).replaceAll("\\", "/");
  const targetRead = readTaskKernel({ root: input.root, taskDir: replyTaskPath, cwd: input.root });
  if (targetRead.kind !== "task-kernel-v2") {
    throw new Error("Codex escalation reply requires its bound V2 Review Task");
  }
  const targetKernel = targetRead.kernel;
  const targetRun = targetKernel.runs.at(-1);
  const targetCandidate = targetRun?.candidateSnapshot;
  if (
    targetKernel.identity.taskId !== sendRequest["to_task_id"] ||
    !["verify", "integrate"].includes(targetKernel.phase) ||
    targetKernel.revision !== sendRequest["to_kernel_revision"] ||
    targetRun?.state !== "completed" ||
    !targetCandidate ||
    targetRun.id !== sendRequest["to_run_id"] ||
    targetCandidate.id !== sendRequest["to_candidate_snapshot_id"] ||
    targetCandidate.fingerprint !== sendRequest["to_candidate_fingerprint"]
  ) {
    throw new Error("Codex escalation reply Task Run or candidate is stale");
  }
  const threadId = requireStringField(sendRequest, "thread_id", "Codex escalation send request");
  const hostId = requireStringField(sendRequest, "host_id", "Codex escalation send request");
  assertBoundCodexReviewThread(
    replyTaskPath,
    replyTaskRef,
    targetKernel.identity.taskId,
    threadId,
    hostId,
  );
  if (
    readRequest["task"] !== replyTaskRef ||
    readRequest["task_id"] !== targetKernel.identity.taskId ||
    readRequest["task_kernel_kind"] !== "task-kernel-v2" ||
    readRequest["kernel_revision"] !== targetKernel.revision ||
    readRequest["run_id"] !== targetRun.id ||
    readRequest["candidate_snapshot_id"] !== targetCandidate.id ||
    readRequest["candidate_fingerprint"] !== targetCandidate.fingerprint ||
    readRequest["tool"] !== "read_thread" ||
    readRequest["role"] !== "review" ||
    readRequest["thread_id"] !== threadId ||
    readRequest["host_id"] !== hostId ||
    readRequest["reply_to_escalation_id"] !== input.escalationId ||
    readRequest["escalation_source_task"] !== sourceTaskRef ||
    readRequest["escalation_source_task_id"] !== request.taskId ||
    readRequest["escalation_prepared_request_ref"] !== prepared.ref ||
    readRequest["escalation_prepared_fingerprint"] !== request.preparedFingerprint ||
    readRequest["escalation_send_request_id"] !== input.sendRequestId ||
    readRequest["escalation_send_request_fingerprint"] !== latestSend.requestFingerprint ||
    readRequest["escalation_send_receipt_sha256"] !== latestSend.receiptSha256 ||
    readRequest["escalation_send_receipt_recorded_at"] !== latestSend.receiptRecordedAt ||
    readReceipt["request_id"] !== input.readRequestId ||
    readReceipt["task_id"] !== targetKernel.identity.taskId ||
    readReceipt["run_id"] !== targetRun.id ||
    readReceipt["candidate_snapshot_id"] !== targetCandidate.id ||
    readReceipt["candidate_fingerprint"] !== targetCandidate.fingerprint ||
    readReceipt["reply_to_escalation_id"] !== input.escalationId ||
    readReceipt["escalation_send_request_id"] !== input.sendRequestId ||
    readReceipt["escalation_send_request_fingerprint"] !== latestSend.requestFingerprint ||
    readReceipt["escalation_send_receipt_sha256"] !== latestSend.receiptSha256 ||
    readReceipt["escalation_send_receipt_recorded_at"] !== latestSend.receiptRecordedAt ||
    readReceipt["evidence_level"] !== "desktop-native" ||
    readReceipt["outcome"] !== "ok" ||
    readReceipt["tool"] !== "read_thread" ||
    readReceipt["status"] !== "completed" ||
    readReceipt["thread_id"] !== threadId ||
    readReceipt["host_id"] !== hostId ||
    readReceipt["contract_stale"] !== false ||
    readReceipt["kernel_revision_at_receipt"] !== readRequest["kernel_revision"] ||
    !Number.isFinite(Date.parse(String(readRequest["created_at"]))) ||
    !Number.isFinite(Date.parse(String(readReceipt["recorded_at"]))) ||
    Date.parse(String(readRequest["created_at"])) < Date.parse(latestSend.receiptRecordedAt) ||
    Date.parse(String(readReceipt["recorded_at"])) < Date.parse(latestSend.receiptRecordedAt) ||
    readReceipt["reply_evidence"] === null ||
    typeof readReceipt["reply_evidence"] !== "object"
  ) {
    throw new Error("Codex escalation reply request or native receipt is stale or misbound");
  }
  const replyEvidence = objectValue(readReceipt["reply_evidence"], "Codex native read reply evidence");
  exactKeys(replyEvidence, ["reply_to_escalation_id", "response_turn_id", "body", "body_sha256"], "Codex native read reply evidence");
  const responseTurnId = requireStringField(replyEvidence, "response_turn_id", "Codex native read reply evidence");
  const responseBody = requireStringField(replyEvidence, "body", "Codex native read reply evidence");
  const responseBodySha256 = requireStringField(replyEvidence, "body_sha256", "Codex native read reply evidence");
  if (
    replyEvidence["reply_to_escalation_id"] !== input.escalationId ||
    sha256(responseBody) !== responseBodySha256
  ) {
    throw new Error("Codex native read reply evidence hash or escalation correlation is invalid");
  }
  const parsedReply = validateCodexReplyEnvelope(
    responseBody,
    request,
    prepared.reviewArtifact,
    { hostId, threadId },
    current.kernel.definition.acceptanceCriteria.map((item) => item.id),
  );
  const reviewerId = `codex-reviewer:${sha256(`${hostId}\0${threadId}`).slice(0, 32)}`;
  const runHost = current.run.host;
  if (
    reviewerId === current.run.startedBy ||
    reviewerId === current.run.authorization.approvedBy ||
    (runHost?.hostId === hostId && runHost.threadId === threadId) ||
    runHost?.sessionId === threadId
  ) {
    throw new Error("Codex escalation reviewer is not independent from the Run executor or approver");
  }
  const evidenceRefs = parsedReply.content.allEvidenceRefs;
  if (!evidenceRefs.length) {
    throw new Error("Codex escalation Review must report byte-verifiable evidence references");
  }
  const candidateRoot = current.run.workspace?.canonicalPath ?? input.root;
  const evidenceVerification = resolvePiReviewEvidenceV1({
    root: input.root,
    taskDir: current.taskDir,
    candidateRoot,
    run: current.run,
    references: evidenceRefs,
  });
  const verifiedRefs = evidenceVerification.items.map((item) => item.ref);
  if (!sameStrings(evidenceRefs, verifiedRefs)) {
    throw new Error("Codex escalation Review evidence references do not match byte-verified candidate and Run evidence");
  }

  const sourceCopies = {
    sendRequestRef: `pi-bridge/escalations/transport/send-request-${input.sendRequestId}.json`,
    sendReceiptRef: `pi-bridge/escalations/transport/send-receipt-${input.sendRequestId}.json`,
    readRequestRef: `pi-bridge/escalations/transport/read-request-${input.readRequestId}.json`,
    readReceiptRef: `pi-bridge/escalations/transport/read-receipt-${input.readRequestId}.json`,
  };
  writeImmutableEvidenceCopy(current.taskDir, send.requestBytes, sourceCopies.sendRequestRef);
  writeImmutableEvidenceCopy(current.taskDir, send.receiptBytes, sourceCopies.sendReceiptRef);
  writeImmutableEvidenceCopy(current.taskDir, read.requestBytes, sourceCopies.readRequestRef);
  writeImmutableEvidenceCopy(current.taskDir, read.receiptBytes, sourceCopies.readReceiptRef);

  const resolutionCore = {
    schemaVersion: 1 as const,
    source: "pactile-codex-escalation-review-resolution-v1" as const,
    escalationId: request.escalationId,
    preparedRequestRef: prepared.ref,
    preparedFingerprint: request.preparedFingerprint,
    piReviewArtifactRef: request.reviewArtifactRef,
    piReviewArtifactSha256: request.reviewArtifactSha256,
    piReviewContentFingerprint: request.reviewContentFingerprint,
    sourceTaskId: request.taskId,
    runId: request.runId,
    candidateSnapshotId: request.candidateSnapshotId,
    candidateFingerprint: request.candidateFingerprint,
    sendRequestId: input.sendRequestId,
    sendRequestFingerprint: String(sendRequest["request_fingerprint"]),
    ...sourceCopies,
    replyTaskId: targetKernel.identity.taskId,
    readRequestId: input.readRequestId,
    readRequestFingerprint: String(readRequest["request_fingerprint"]),
    responseTurnId,
    responseBodySha256,
    codexReviewer: reviewerId,
    codexReviewId,
    decision: parsedReply.content.verdict,
    review: parsedReply.rawReview,
    evidenceVerification,
  };
  const resolution: CodexEscalationReviewResolutionV1 = {
    ...resolutionCore,
    contentFingerprint: sha256(JSON.stringify(resolutionCore)),
  };
  const resolutionRef = `pi-bridge/escalations/replies/${codexReviewId}.json`;
  const resolutionFile = safeArtifactFile(current.taskDir, resolutionRef);
  if (fs.existsSync(resolutionFile)) {
    const existingBytes = fs.readFileSync(safeExistingArtifactFile(current.taskDir, resolutionRef));
    const existing = parseJsonObject(existingBytes, "Codex escalation Review resolution") as unknown as CodexEscalationReviewResolutionV1;
    const existingCore = { ...existing } as Record<string, unknown>;
    delete existingCore["contentFingerprint"];
    const existingVerification = objectValue(existingCore["evidenceVerification"], "stored Codex escalation evidence verification");
    const freshVerification = objectValue(evidenceVerification, "current Codex escalation evidence verification");
    if (
      existing.contentFingerprint !== sha256(JSON.stringify(existingCore)) ||
      JSON.stringify({ ...existingCore, evidenceVerification: { ...existingVerification, observedAt: null } }) !==
        JSON.stringify({ ...resolutionCore, evidenceVerification: { ...freshVerification, observedAt: null } })
    ) {
      throw new Error("A different Codex escalation Review resolution is already stored");
    }
  } else {
    fs.writeFileSync(resolutionFile, `${JSON.stringify(resolution, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }
  const reviewEvidenceRefs = [
    ...new Set([
      ...evidenceRefs,
      ...current.review.evidenceRefs,
      ...Object.values(current.review.acceptanceEvidence).flat(),
      request.reviewArtifactRef,
      prepared.ref,
      ...Object.values(sourceCopies),
      resolutionRef,
    ]),
  ];
  const unresolvedBlockers = [
    ...parsedReply.content.blockers.map((blocker) => `${blocker.id}: ${blocker.summary}`),
    ...parsedReply.content.unresolvedQuestions.map((question) => `${question.id}: ${question.question}`),
    ...parsedReply.content.concernResolutions
      .filter((resolution) => resolution.disposition === "still-blocking")
      .map((resolution) => `${resolution.concernId}: ${resolution.rationale}`),
  ];
  if (priorCodexReview) {
    if (
      priorCodexReview.runId !== request.runId ||
      priorCodexReview.candidateSnapshotId !== request.candidateSnapshotId ||
      priorCodexReview.candidateFingerprint !== request.candidateFingerprint ||
      priorCodexReview.reviewer !== reviewerId ||
      priorCodexReview.decision !== parsedReply.content.verdict ||
      JSON.stringify(priorCodexReview.evidenceRefs) !== JSON.stringify(reviewEvidenceRefs) ||
      JSON.stringify(priorCodexReview.acceptanceEvidence) !== JSON.stringify(parsedReply.content.acceptanceEvidence) ||
      JSON.stringify(priorCodexReview.unresolvedBlockers) !== JSON.stringify(unresolvedBlockers)
    ) {
      throw new Error("A different Codex escalation Kernel Review already exists");
    }
    if (current.kernel.reviews.at(-1)?.id !== codexReviewId) {
      throw new Error("Codex escalation Kernel Review is no longer the latest Review");
    }
    const finalGuard = assertCurrentPiReviewEscalationV1(
      input.root,
      input.sourceTask,
      prepared,
    );
    if (
      finalGuard.kernel.revision !== current.kernel.revision ||
      finalGuard.run.id !== current.run.id ||
      finalGuard.review.id !== current.review.id
    ) {
      throw new Error("Pi Review changed before the Codex escalation Review readback");
    }
    return { reviewId: codexReviewId, decision: parsedReply.content.verdict, resolutionRef };
  }
  const finalGuard = assertCurrentPiReviewEscalationV1(
    input.root,
    input.sourceTask,
    prepared,
  );
  if (
    finalGuard.kernel.revision !== current.kernel.revision ||
    finalGuard.run.id !== current.run.id ||
    finalGuard.review.id !== current.review.id
  ) {
    throw new Error("Pi Review changed before the Codex escalation Kernel Review write");
  }
  const mutation = recordTaskReview({
    root: input.root,
    taskDir: current.taskDir,
    expectedRevision: finalGuard.kernel.revision,
    reviewId: codexReviewId,
    runId: request.runId,
    candidateSnapshotId: request.candidateSnapshotId,
    candidateFingerprint: request.candidateFingerprint,
    reviewer: reviewerId,
    decision: parsedReply.content.verdict,
    evidenceRefs: reviewEvidenceRefs,
    acceptanceEvidence: parsedReply.content.acceptanceEvidence,
    unresolvedBlockers,
    measurementRef: resolutionRef,
    actor: reviewerId,
    idempotencyKey: `codex-escalation-review:${request.piRunId}`,
    cwd: input.root,
  });
  const persisted = mutation.kernel.reviews.find((item) => item.id === codexReviewId);
  if (!persisted || mutation.kernel.reviews.at(-1)?.id !== codexReviewId) {
    throw new Error("Kernel did not read back the new Codex escalation Review as latest");
  }
  const readback = readTaskKernel({ root: input.root, taskDir: current.taskDir, cwd: input.root });
  if (
    readback.kind !== "task-kernel-v2" ||
    readback.kernel.reviews.at(-1)?.id !== codexReviewId ||
    readback.kernel.reviews.at(-1)?.decision !== parsedReply.content.verdict
  ) {
    throw new Error("Kernel Codex Review is not readable after atomic persistence");
  }
  return { reviewId: codexReviewId, decision: parsedReply.content.verdict, resolutionRef };
}
