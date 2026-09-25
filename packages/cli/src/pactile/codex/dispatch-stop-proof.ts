import fs from "node:fs";
import path from "node:path";
import { fingerprintTaskValue } from "../../core/task/index.js";
import type { CodexBridgeReceipt, CodexBridgeRequest } from "./bridge.js";

export interface CodexDispatchStopProofV1 {
  schema_version: 1;
  scope: "task-kernel-v2-run-dispatch-stop";
  source: "codex-bridge";
  proof_fingerprint: string;
  lease_id: string;
  task_id: string;
  run_id: string;
  schedule_receipt_fingerprint: string;
  admission_receipt_fingerprint: string;
  disposition: "native-terminal" | "not-created";
  writer_exited: true;
  owner: {
    host: "codex-desktop";
    role: "execute";
    session_id: null;
    thread_id: string | null;
    host_id: string | null;
    start_request_id: null;
    process_id: null;
  };
  request_ref: string;
  request_fingerprint: string;
  native_receipt_ref: string;
  native_receipt_fingerprint: string;
}

export interface BuildCodexDispatchStopProofInput {
  request: CodexBridgeRequest;
  receipt: CodexBridgeReceipt;
  disposition: CodexDispatchStopProofV1["disposition"];
  requestRef: string;
  nativeReceiptRef: string;
}

const fingerprintPattern = /^[a-f0-9]{64}$/;

function projectRelativeRef(value: string, field: string): string {
  if (
    !value ||
    value.includes("\0") ||
    path.isAbsolute(value) ||
    /^[a-zA-Z]:/.test(value)
  ) {
    throw new Error(`${field} must be a project-relative file reference`);
  }
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    segments.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${field} must remain within the project root`);
  }
  return normalized;
}

function requestFingerprint(request: CodexBridgeRequest): string {
  const { request_fingerprint: _stored, ...payload } = request;
  return fingerprintTaskValue(payload);
}

function ensureDispatchProofDirectory(root: string): string {
  const projectRoot = fs.realpathSync(root);
  let current = projectRoot;
  for (const segment of [".pactile", "codex-bridge", "dispatch-proofs"]) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        "Dispatch proof directory must be a real project directory",
      );
    }
    const real = fs.realpathSync(current);
    const relative = path.relative(projectRoot, real);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Dispatch proof directory escapes the project root");
    }
    current = real;
  }
  return current;
}

/**
 * Constructs the exact P37 release-proof payload from a verified native bridge
 * request and its normalized, persisted receipt. It does not claim that a
 * simulated host stopped writing.
 */
export function buildCodexDispatchStopProof(
  input: BuildCodexDispatchStopProofInput,
): CodexDispatchStopProofV1 {
  const { request, receipt, disposition } = input;
  const persistedRequestFingerprint = requestFingerprint(request);
  if (
    request.request_fingerprint !== persistedRequestFingerprint ||
    receipt.request_fingerprint !== persistedRequestFingerprint
  ) {
    throw new Error("Dispatch proof request fingerprint does not match");
  }
  if (
    request.task_kernel_kind !== "task-kernel-v2" ||
    request.role !== "execute" ||
    !request.task_id ||
    !request.run_id ||
    request.dispatch_task_id !== request.task_id ||
    request.dispatch_run_id !== request.run_id ||
    !request.dispatch_lease_id ||
    !request.schedule_receipt_fingerprint ||
    !request.dispatch_admission_receipt_fingerprint
  ) {
    throw new Error(
      "Dispatch proof requires an admitted Task Kernel v2 Execute request",
    );
  }
  if (
    !fingerprintPattern.test(request.schedule_receipt_fingerprint) ||
    !fingerprintPattern.test(request.dispatch_admission_receipt_fingerprint)
  ) {
    throw new Error(
      "Dispatch proof requires valid schedule and admission fingerprints",
    );
  }
  if (
    receipt.request_id !== request.request_id ||
    receipt.tool !== request.tool ||
    receipt.task_id !== request.task_id ||
    receipt.run_id !== request.run_id ||
    receipt.evidence_level !== "desktop-native" ||
    receipt.contract_stale
  ) {
    throw new Error(
      "Dispatch proof receipt is not a current native receipt for this Run",
    );
  }

  const requestCandidateId = request.candidate_snapshot_id ?? null;
  const requestCandidateFingerprint = request.candidate_fingerprint ?? null;
  const receiptCandidateId = receipt.candidate_snapshot_id ?? null;
  const receiptCandidateFingerprint = receipt.candidate_fingerprint ?? null;
  if (
    (requestCandidateId === null) !== (requestCandidateFingerprint === null) ||
    (receiptCandidateId === null) !== (receiptCandidateFingerprint === null) ||
    requestCandidateId !== receiptCandidateId ||
    requestCandidateFingerprint !== receiptCandidateFingerprint
  ) {
    throw new Error(
      "Dispatch proof receipt candidate does not match the request",
    );
  }

  let threadId: string | null;
  let hostId: string | null;
  if (disposition === "not-created") {
    if (
      request.tool !== "create_thread" ||
      request.thread_id !== null ||
      request.host_id !== null ||
      receipt.outcome !== "failed" ||
      receipt.thread_creation_state !== "not_created" ||
      receipt.thread_id !== null ||
      receipt.client_thread_id !== null ||
      receipt.host_id !== null ||
      requestCandidateId !== null
    ) {
      throw new Error(
        "not-created proof requires an explicit native create failure without a thread or candidate",
      );
    }
    threadId = null;
    hostId = null;
  } else {
    if (
      request.tool !== "wait_threads" ||
      receipt.outcome !== "ok" ||
      receipt.status !== "completed" ||
      !request.thread_id ||
      !request.host_id ||
      receipt.thread_id !== request.thread_id ||
      receipt.host_id !== request.host_id
    ) {
      throw new Error(
        "native-terminal proof requires a completed wait for the bound thread",
      );
    }
    threadId = request.thread_id;
    hostId = request.host_id;
  }

  const proofPayload = {
    schema_version: 1 as const,
    scope: "task-kernel-v2-run-dispatch-stop" as const,
    source: "codex-bridge" as const,
    lease_id: request.dispatch_lease_id,
    task_id: request.task_id,
    run_id: request.run_id,
    schedule_receipt_fingerprint: request.schedule_receipt_fingerprint,
    admission_receipt_fingerprint:
      request.dispatch_admission_receipt_fingerprint,
    disposition,
    writer_exited: true as const,
    owner: {
      host: "codex-desktop" as const,
      role: "execute" as const,
      session_id: null,
      thread_id: threadId,
      host_id: hostId,
      start_request_id: null,
      process_id: null,
    },
    request_ref: projectRelativeRef(input.requestRef, "request_ref"),
    request_fingerprint: persistedRequestFingerprint,
    native_receipt_ref: projectRelativeRef(
      input.nativeReceiptRef,
      "native_receipt_ref",
    ),
    native_receipt_fingerprint: fingerprintTaskValue(receipt),
  };
  const proof: CodexDispatchStopProofV1 = {
    ...proofPayload,
    proof_fingerprint: fingerprintTaskValue(proofPayload),
  };
  return proof;
}

/** Persist a content-addressed proof with exclusive creation and root checks. */
export function writeCodexDispatchStopProof(
  root: string,
  proof: CodexDispatchStopProofV1,
): string {
  const { proof_fingerprint: storedFingerprint, ...payload } = proof;
  if (
    !fingerprintPattern.test(storedFingerprint) ||
    fingerprintTaskValue(payload) !== storedFingerprint
  ) {
    throw new Error("Dispatch proof fingerprint does not match its content");
  }
  const directory = ensureDispatchProofDirectory(root);
  const file = path.join(directory, `${storedFingerprint}.json`);
  const contents = `${JSON.stringify(proof, null, 2)}\n`;
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") !== contents) {
      throw new Error("Dispatch proof content-address collision");
    }
  } else {
    const descriptor = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, contents, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }
  return path.relative(fs.realpathSync(root), file).replaceAll("\\", "/");
}
