import fs from "node:fs";
import path from "node:path";
import { fingerprintTaskValue } from "../../core/task/index.js";
import { assertCurrentPiReviewEscalationV1, buildCodexEscalationPromptV1, readPiReviewEscalationV1, safeArtifactFile } from "./escalation-artifacts.js";
import { exactKeys, objectValue, parseJsonObject, requireStringField, safeExistingArtifactFile, sha256, uuidPattern, type ReadPiReviewEscalationV1 } from "./escalation-contract.js";

interface StoredCodexBridgeEvidenceV1 {
  request: Record<string, unknown>;
  receipt: Record<string, unknown>;
  requestBytes: Buffer;
  receiptBytes: Buffer;
  requestRef: string;
  receiptRef: string;
}

export function readCodexBridgeEvidence(
  taskDir: string,
  requestId: string,
  label: string,
): StoredCodexBridgeEvidenceV1 {
  if (!uuidPattern.test(requestId)) throw new Error(`${label} request ID is invalid`);
  const requestRef = `codex-bridge/requests/${requestId}.json`;
  const receiptRef = `codex-bridge/receipts/${requestId}.json`;
  const requestBytes = fs.readFileSync(safeExistingArtifactFile(taskDir, requestRef));
  const receiptBytes = fs.readFileSync(safeExistingArtifactFile(taskDir, receiptRef));
  const request = parseJsonObject(requestBytes, `${label} request`);
  const receipt = parseJsonObject(receiptBytes, `${label} receipt`);
  const requestFingerprint = request["request_fingerprint"];
  const requestPayload = { ...request };
  delete requestPayload["request_fingerprint"];
  if (
    request["request_id"] !== requestId ||
    typeof requestFingerprint !== "string" ||
    requestFingerprint !== fingerprintTaskValue(requestPayload) ||
    receipt["request_id"] !== requestId ||
    receipt["request_fingerprint"] !== requestFingerprint
  ) {
    throw new Error(`${label} request or receipt fingerprint is invalid`);
  }
  return {
    request,
    receipt,
    requestBytes,
    receiptBytes,
    requestRef,
    receiptRef,
  };
}

export interface CodexEscalationSendV1 {
  request: Record<string, unknown>;
  receipt: Record<string, unknown>;
  requestFingerprint: string;
  receiptSha256: string;
  receiptRecordedAt: string;
  requestRef: string;
  receiptRef: string;
}

/** Reject a self-rehashed send unless its actual prompt is rebuilt from the frozen Pi artifact. */
export function assertCodexEscalationSendPromptV1(
  prepared: ReadPiReviewEscalationV1,
  request: Record<string, unknown>,
): void {
  const hostId = requireStringField(request, "host_id", "Codex escalation send request");
  const threadId = requireStringField(request, "thread_id", "Codex escalation send request");
  const args = objectValue(request["arguments"], "Codex escalation send arguments");
  exactKeys(args, ["threadId", "hostId", "prompt"], "Codex escalation send arguments");
  const expectedPrompt = buildCodexEscalationPromptV1({ prepared, hostId, threadId });
  if (
    args["threadId"] !== threadId ||
    args["hostId"] !== hostId ||
    args["prompt"] !== expectedPrompt ||
    request["prompt_sha256"] !== sha256(expectedPrompt)
  ) {
    throw new Error("Codex escalation send prompt or prompt digest does not match the frozen Pi Review");
  }
}

/** Read the latest successful native send for one prepared Pi escalation. */
export function readCodexEscalationSendV1(input: {
  root: string;
  sourceTask: string;
  escalationId: string;
  sendRequestId: string;
}): CodexEscalationSendV1 {
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
  const sourceTaskRef = path.relative(input.root, current.taskDir).replaceAll("\\", "/");
  const latestReview = current.kernel.reviews
    .filter(
      (review) =>
        review.runId === prepared.request.runId &&
        review.candidateSnapshotId === prepared.request.candidateSnapshotId &&
        review.candidateFingerprint === prepared.request.candidateFingerprint,
    )
    .at(-1);
  const expectedKernelRevision =
    latestReview?.id === `codex-review-${prepared.request.piRunId}`
      ? current.kernel.revision - 1
      : current.kernel.revision;
  const requestsDir = path.join(current.taskDir, "codex-bridge", "requests");
  if (!fs.statSync(requestsDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Pi escalation has no Codex send request store");
  }

  const validate = (evidence: StoredCodexBridgeEvidenceV1): CodexEscalationSendV1 => {
    const { request, receipt } = evidence;
    assertCodexEscalationSendPromptV1(prepared, request);
    const requestFingerprint = request["request_fingerprint"];
    const requestCreatedAt = Date.parse(String(request["created_at"]));
    const receiptRecordedAt = receipt["recorded_at"];
    const receiptRecordedAtMs = Date.parse(String(receiptRecordedAt));
    if (
      request["task"] !== sourceTaskRef ||
      request["task_id"] !== prepared.request.taskId ||
      request["task_kernel_kind"] !== "task-kernel-v2" ||
      request["kernel_revision"] !== expectedKernelRevision ||
      request["run_id"] !== prepared.request.runId ||
      request["candidate_snapshot_id"] !== prepared.request.candidateSnapshotId ||
      request["candidate_fingerprint"] !== prepared.request.candidateFingerprint ||
      request["tool"] !== "send_message_to_thread" ||
      request["role"] !== "review" ||
      request["escalation_id"] !== input.escalationId ||
      request["escalation_source_task"] !== sourceTaskRef ||
      request["escalation_source_task_id"] !== prepared.request.taskId ||
      request["escalation_prepared_request_ref"] !== prepared.ref ||
      request["escalation_prepared_fingerprint"] !== prepared.request.preparedFingerprint ||
      typeof request["to_task"] !== "string" ||
      typeof request["to_task_id"] !== "string" ||
      typeof request["to_kernel_revision"] !== "number" ||
      typeof request["to_run_id"] !== "string" ||
      typeof request["to_candidate_snapshot_id"] !== "string" ||
      typeof request["to_candidate_fingerprint"] !== "string" ||
      typeof request["thread_id"] !== "string" ||
      typeof request["host_id"] !== "string" ||
      typeof requestFingerprint !== "string" ||
      receipt["task_id"] !== prepared.request.taskId ||
      receipt["run_id"] !== prepared.request.runId ||
      receipt["candidate_snapshot_id"] !== prepared.request.candidateSnapshotId ||
      receipt["candidate_fingerprint"] !== prepared.request.candidateFingerprint ||
      receipt["to_task_id"] !== request["to_task_id"] ||
      receipt["escalation_id"] !== input.escalationId ||
      receipt["escalation_source_task"] !== sourceTaskRef ||
      receipt["escalation_source_task_id"] !== prepared.request.taskId ||
      receipt["escalation_prepared_request_ref"] !== prepared.ref ||
      receipt["escalation_prepared_fingerprint"] !== prepared.request.preparedFingerprint ||
      receipt["evidence_level"] !== "desktop-native" ||
      receipt["outcome"] !== "ok" ||
      receipt["tool"] !== "send_message_to_thread" ||
      receipt["thread_id"] !== request["thread_id"] ||
      receipt["host_id"] !== request["host_id"] ||
      receipt["contract_stale"] !== false ||
      receipt["kernel_revision_at_receipt"] !== request["kernel_revision"] ||
      receipt["destination_kernel_revision_at_receipt"] !== request["to_kernel_revision"] ||
      !Number.isFinite(requestCreatedAt) ||
      !Number.isFinite(receiptRecordedAtMs) ||
      receiptRecordedAtMs < requestCreatedAt
    ) {
      throw new Error("Codex escalation send is stale, unsuccessful, or misbound");
    }
    return {
      request,
      receipt,
      requestFingerprint,
      receiptSha256: sha256(evidence.receiptBytes),
      receiptRecordedAt: String(receiptRecordedAt),
      requestRef: evidence.requestRef,
      receiptRef: evidence.receiptRef,
    };
  };

  const matching = fs.readdirSync(requestsDir).flatMap((name) => {
    if (!name.endsWith(".json") || !uuidPattern.test(name.slice(0, -5))) return [];
    const id = name.slice(0, -5);
    const requestRef = `codex-bridge/requests/${id}.json`;
    const request = parseJsonObject(
      fs.readFileSync(safeExistingArtifactFile(current.taskDir, requestRef)),
      "Codex escalation send request",
    );
    if (
      request["escalation_id"] !== input.escalationId ||
      request["task"] !== sourceTaskRef ||
      request["tool"] !== "send_message_to_thread"
    ) return [];
    const receiptFile = path.join(current.taskDir, "codex-bridge", "receipts", `${id}.json`);
    if (!fs.statSync(receiptFile, { throwIfNoEntry: false })?.isFile()) return [];
    const evidence = readCodexBridgeEvidence(current.taskDir, id, "Codex escalation send");
    if (evidence.receipt["outcome"] !== "ok") return [];
    return [validate(evidence)];
  });
  const selected = matching.find((item) => item.request["request_id"] === input.sendRequestId);
  if (!selected) {
    throw new Error("Codex escalation requires a successful native send receipt");
  }
  const latestAt = Math.max(...matching.map((item) => Date.parse(item.receiptRecordedAt)));
  const latest = matching.filter((item) => Date.parse(item.receiptRecordedAt) === latestAt);
  if (latest.length !== 1 || latest[0]?.request["request_id"] !== input.sendRequestId) {
    throw new Error("Codex escalation send is no longer the latest successful native send");
  }
  return selected;
}

export function writeImmutableEvidenceCopy(
  taskDir: string,
  sourceBytes: Buffer,
  reference: string,
): void {
  const file = safeArtifactFile(taskDir, reference);
  try {
    fs.writeFileSync(file, sourceBytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
    if (!fs.readFileSync(safeExistingArtifactFile(taskDir, reference)).equals(sourceBytes)) {
      throw new Error("A copied Codex transport evidence file changed");
    }
  }
}

export function assertBoundCodexReviewThread(
  taskDir: string,
  taskRef: string,
  taskId: string,
  threadId: string,
  hostId: string,
): void {
  const requestDir = path.join(taskDir, "codex-bridge", "requests");
  if (!fs.statSync(requestDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Codex escalation Review thread has no bound creation request");
  }
  for (const name of fs.readdirSync(requestDir)) {
    if (!name.endsWith(".json") || !uuidPattern.test(name.slice(0, -5))) continue;
    const id = name.slice(0, -5);
    const ref = `codex-bridge/requests/${id}.json`;
    const requestBytes = fs.readFileSync(safeExistingArtifactFile(taskDir, ref));
    const request = parseJsonObject(requestBytes, "Codex Review thread request");
    if (
      request["tool"] !== "create_thread" ||
      request["role"] !== "review" ||
      request["task_id"] !== taskId ||
      request["task"] !== taskRef ||
      request["task_kernel_kind"] !== "task-kernel-v2"
    ) {
      continue;
    }
    const fingerprint = request["request_fingerprint"];
    const payload = { ...request };
    delete payload["request_fingerprint"];
    if (typeof fingerprint !== "string" || fingerprint !== fingerprintTaskValue(payload)) continue;
    const receiptRef = `codex-bridge/receipts/${id}.json`;
    if (!fs.statSync(path.join(taskDir, receiptRef), { throwIfNoEntry: false })?.isFile()) continue;
    const receipt = parseJsonObject(
      fs.readFileSync(safeExistingArtifactFile(taskDir, receiptRef)),
      "Codex Review thread receipt",
    );
    if (
      receipt["request_id"] === id &&
      receipt["request_fingerprint"] === fingerprint &&
      receipt["task_id"] === taskId &&
      receipt["tool"] === "create_thread" &&
      receipt["outcome"] === "ok" &&
      receipt["contract_stale"] === false &&
      receipt["evidence_level"] === "desktop-native" &&
      receipt["thread_id"] === threadId &&
      receipt["host_id"] === hostId
    ) {
      return;
    }
  }
  throw new Error("Codex escalation Review thread is not bound to a fresh native Review receipt");
}
