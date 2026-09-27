import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createJevDecisionFacadeV1,
  type JevDecisionResultV1,
} from "../jev/decision.js";
import {
  JEV_ORIGIN_V1,
  type JevConfidenceReceiptV1,
  type JevEgressAuthorizationV1,
  type JevFallbackCodeV1,
} from "../jev/contracts.js";
import { projectJevConfidenceReceiptV1 } from "../jev/response.js";
import { resolveJevProjectEgressPolicyV1 } from "../jev/project-policy.js";

export const PI_REVIEW_ROUTING_QUESTION_ID_V1 = "append_codex_review";
export const PI_REVIEW_ROUTING_CONFIDENCE_THRESHOLD_V1 = 0.65;

const ROUTING_REQUEST = Object.freeze({
  taskSummary:
    "A completed implementation candidate has a non-passing independent review. Decide whether to add a separate read-only review.",
  questions: Object.freeze({
    [PI_REVIEW_ROUTING_QUESTION_ID_V1]: Object.freeze({
      type: "choice" as const,
      instructions:
        "Should an optional independent Codex read-only review be added?",
      criteria: Object.freeze({
        "append-codex-review": "Add the optional independent review.",
        "keep-pi-review": "Keep the current Pi Review only.",
      }),
    }),
  }),
});
const ROUTING_PROVIDER_PAYLOAD = Object.freeze({
  state: Object.freeze({
    taskSummary: ROUTING_REQUEST.taskSummary,
    sourceSnippets: Object.freeze([]),
  }),
  model: "jev-latest",
  questions: ROUTING_REQUEST.questions,
});

export type PiReviewRoutingAdviceBasisV1 =
  | "hard-rule-required"
  | "passing-review"
  | "jev-recommended"
  | "jev-declined"
  | "jev-unavailable"
  | "egress-policy-changed"
  | "review-binding-changed";

export interface PiReviewRoutingAdviceReceiptV1 {
  readonly schemaVersion: 1;
  readonly source: "pactile-pi-review-routing-advice-v1";
  readonly status: "skipped" | "answered" | "fallback" | "superseded";
  readonly binding: {
    readonly taskId: string;
    readonly reviewId: string;
    readonly piRunId: string;
    readonly runId: string;
    readonly candidateSnapshotId: string;
    readonly candidateFingerprint: string;
    readonly reviewArtifactRef: string;
    readonly reviewArtifactSha256: string;
    readonly reviewContentFingerprint: string;
  };
  readonly request: {
    readonly inputSha256: string;
    readonly inputBytes: number;
    readonly sentInputSha256: string | null;
  };
  readonly recommendationDisposition:
    | "skipped"
    | "adopted"
    | "unavailable"
    | "superseded";
  readonly escalationAction:
    | "append-codex-review"
    | "keep-pi-review"
    | "not-applicable";
  readonly basis: PiReviewRoutingAdviceBasisV1;
  readonly recommendation: "append-codex-review" | "keep-pi-review" | null;
  readonly confidence: JevConfidenceReceiptV1;
  readonly projectEgressPolicy: {
    readonly before:
      | "default"
      | "configured"
      | "egress-denied"
      | "configuration-invalid";
    readonly after:
      | "default"
      | "configured"
      | "egress-denied"
      | "configuration-invalid";
    readonly changed: boolean;
  };
  readonly transport: {
    readonly outcome: "skipped" | "answered" | "fallback";
    readonly reasonCode: JevFallbackCodeV1 | null;
    readonly attempts: number | null;
    readonly latencyMs: number;
    readonly httpStatus: number | null;
    readonly requestId: string | null;
    readonly model: string | null;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly estimatedInputCostMicrousd: number | null;
  };
  readonly recordedAt: string;
  readonly contentFingerprint: string;
}

export interface CreatedPiReviewRoutingAdviceV1 {
  readonly ref: string;
  readonly sha256: string;
  readonly receipt: PiReviewRoutingAdviceReceiptV1;
  readonly prepareOptionalEscalation: boolean;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function policyStatus(
  policy: ReturnType<typeof resolveJevProjectEgressPolicyV1>,
): PiReviewRoutingAdviceReceiptV1["projectEgressPolicy"]["before"] {
  return policy.allowed ? policy.source : policy.reasonCode;
}

function unavailableConfidence(): JevConfidenceReceiptV1 {
  return projectJevConfidenceReceiptV1({}, [PI_REVIEW_ROUTING_QUESTION_ID_V1]);
}

function receiptPath(taskDir: string, ref: string): string {
  const task = fs.realpathSync(taskDir);
  if (path.isAbsolute(ref) || ref.includes("\0"))
    throw new Error("Pi Review Jev advice reference is invalid");
  const file = path.resolve(task, ref);
  const relative = path.relative(task, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(
      "Pi Review Jev advice reference escapes the Task directory",
    );
  return file;
}

function persistReceipt(
  taskDir: string,
  fields: Omit<PiReviewRoutingAdviceReceiptV1, "contentFingerprint">,
): CreatedPiReviewRoutingAdviceV1 {
  const core = { ...fields };
  const contentFingerprint = sha256(JSON.stringify(core));
  const receipt = { ...core, contentFingerprint };
  const ref = `pi-bridge/jev-review-advice/${fields.binding.piRunId}.json`;
  const file = receiptPath(taskDir, ref);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const task = fs.realpathSync(taskDir);
  const directory = fs.realpathSync(path.dirname(file));
  const relative = path.relative(task, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(
      "Pi Review Jev advice directory escapes the Task directory",
    );
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  fs.writeFileSync(file, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return {
    ref,
    sha256: sha256(bytes),
    receipt,
    prepareOptionalEscalation:
      receipt.recommendationDisposition === "adopted" &&
      receipt.escalationAction === "append-codex-review",
  };
}

function requestEgress(allowed: boolean): JevEgressAuthorizationV1 {
  return {
    network: "project-authorized",
    privacy: "project-approved-egress",
    credentials: "project-authorized",
    destination: JEV_ORIGIN_V1,
    egressDestinations: allowed ? [JEV_ORIGIN_V1] : [],
    contentDecision: "task-summary-approved",
  };
}

function transportAudit(
  result: JevDecisionResultV1 | null,
): PiReviewRoutingAdviceReceiptV1["transport"] {
  const transport = result?.receipt.transport;
  return {
    outcome: transport?.outcome ?? "skipped",
    reasonCode: transport?.reasonCode ?? null,
    attempts: transport?.attempts ?? 0,
    latencyMs: transport?.latencyMs ?? 0,
    httpStatus: transport?.httpStatus ?? null,
    requestId: transport?.requestId ?? null,
    model: transport?.model ?? null,
    inputTokens: transport?.inputTokens ?? null,
    outputTokens: transport?.outputTokens ?? null,
    estimatedInputCostMicrousd: transport?.estimatedInputCostMicrousd ?? null,
  };
}

function unexpectedFallback(): JevDecisionResultV1 {
  const confidence = unavailableConfidence();
  return {
    node: "review-routing",
    status: "fallback",
    answers: null,
    fallback: {
      reasonCode: "transport-error",
      explanation: "Jev advice failed locally; the Pi Review route was kept.",
    },
    receipt: {
      schemaVersion: 1,
      node: "review-routing",
      transport: {
        provider: "typesafe-jev",
        outcome: "fallback",
        reasonCode: "transport-error",
        attempts: 0,
        latencyMs: 0,
        httpStatus: null,
        requestId: null,
        model: null,
        inputTokens: null,
        outputTokens: null,
        estimatedInputCostMicrousd: null,
        confidence,
      },
      budget: {
        maxDecisions: 1,
        decisionsUsed: 0,
        decisionsRemaining: 1,
        maximumHttpAttempts: 1,
        observedEstimatedInputCostMicrousd: 0,
      },
    },
  };
}

/**
 * Suggest an optional second review using only a static, non-sensitive prompt.
 * Hard-rule and PASS cases are persisted as local skip receipts without calling Jev.
 */
export async function createPiReviewRoutingAdviceV1(input: {
  readonly root: string;
  readonly taskDir: string;
  readonly binding: PiReviewRoutingAdviceReceiptV1["binding"];
  readonly skipReason?: "hard-rule-required" | "passing-review";
  readonly isStillCurrent?: () => boolean;
}): Promise<CreatedPiReviewRoutingAdviceV1> {
  const providerPayload = JSON.stringify(ROUTING_PROVIDER_PAYLOAD);
  const inputBytes = Buffer.byteLength(providerPayload, "utf8");
  const inputSha256 = sha256(providerPayload);
  const before = resolveJevProjectEgressPolicyV1(input.root);
  if (input.skipReason) {
    const reason = input.skipReason;
    return persistReceipt(input.taskDir, {
      schemaVersion: 1,
      source: "pactile-pi-review-routing-advice-v1",
      status: "skipped",
      binding: input.binding,
      request: { inputSha256, inputBytes, sentInputSha256: null },
      recommendationDisposition: "skipped",
      escalationAction: "not-applicable",
      basis: reason,
      recommendation: null,
      confidence: unavailableConfidence(),
      projectEgressPolicy: {
        before: policyStatus(before),
        after: policyStatus(before),
        changed: false,
      },
      transport: transportAudit(null),
      recordedAt: new Date().toISOString(),
    });
  }

  const explicitlyDisabled =
    process.env.PACTILE_JEV_ENABLED?.trim().toLowerCase() === "false";
  const facade = createJevDecisionFacadeV1({
    ...(explicitlyDisabled ? { enabled: false } : {}),
    maxDecisions: 1,
    maxDeadlineMs: 2_500,
    transport: {
      apiKey: process.env.PACTILE_JEV_API_KEY,
      deadlineMs: 2_500,
      maxRetries: 0,
    },
  });
  let result: JevDecisionResultV1;
  try {
    result = await facade.decide({
      node: "review-routing",
      request: ROUTING_REQUEST,
      options: {
        egress: requestEgress(before.allowed),
        minimumDecisionConfidence: PI_REVIEW_ROUTING_CONFIDENCE_THRESHOLD_V1,
      },
    });
  } catch {
    result = unexpectedFallback();
  }
  const after = resolveJevProjectEgressPolicyV1(input.root);
  const policyChanged =
    JSON.stringify(policyStatus(before)) !==
    JSON.stringify(policyStatus(after));
  let stillCurrent = true;
  try {
    stillCurrent = input.isStillCurrent?.() ?? true;
  } catch {
    stillCurrent = false;
  }

  const answer =
    result.status === "answered"
      ? result.answers[PI_REVIEW_ROUTING_QUESTION_ID_V1]
      : undefined;
  const recommendation =
    answer?.type === "choice" &&
    (answer.choice === "append-codex-review" ||
      answer.choice === "keep-pi-review")
      ? answer.choice
      : null;
  const confidence = projectJevConfidenceReceiptV1(
    result.receipt.transport.confidence,
    [PI_REVIEW_ROUTING_QUESTION_ID_V1],
  );
  const reportedConfidence = confidence[PI_REVIEW_ROUTING_QUESTION_ID_V1];
  const confident =
    reportedConfidence?.status === "available" &&
    reportedConfidence.value >= PI_REVIEW_ROUTING_CONFIDENCE_THRESHOLD_V1;
  const answeredWithSupportedChoice =
    result.status === "answered" && recommendation !== null && confident;
  const superseded = policyChanged || !stillCurrent;
  const basis: PiReviewRoutingAdviceBasisV1 = superseded
    ? policyChanged
      ? "egress-policy-changed"
      : "review-binding-changed"
    : result.status === "fallback" || !answeredWithSupportedChoice
      ? "jev-unavailable"
      : recommendation === "append-codex-review"
        ? "jev-recommended"
        : "jev-declined";
  return persistReceipt(input.taskDir, {
    schemaVersion: 1,
    source: "pactile-pi-review-routing-advice-v1",
    status: superseded
      ? "superseded"
      : result.status === "answered" && answeredWithSupportedChoice
        ? "answered"
        : "fallback",
    binding: input.binding,
    request: {
      inputSha256,
      inputBytes,
      sentInputSha256:
        result.receipt.transport.attempts > 0 ? inputSha256 : null,
    },
    recommendationDisposition: superseded
      ? "superseded"
      : answeredWithSupportedChoice
        ? "adopted"
        : "unavailable",
    escalationAction: superseded
      ? "not-applicable"
      : answeredWithSupportedChoice && recommendation === "append-codex-review"
        ? "append-codex-review"
        : "keep-pi-review",
    basis,
    recommendation,
    confidence,
    projectEgressPolicy: {
      before: policyStatus(before),
      after: policyStatus(after),
      changed: policyChanged,
    },
    transport: transportAudit(result),
    recordedAt: new Date().toISOString(),
  });
}

const RECEIPT_KEYS = [
  "schemaVersion",
  "source",
  "status",
  "binding",
  "request",
  "recommendationDisposition",
  "escalationAction",
  "basis",
  "recommendation",
  "confidence",
  "projectEgressPolicy",
  "transport",
  "recordedAt",
  "contentFingerprint",
].sort();

/** Read back and verify the exact local Jev advice bytes referenced by P40. */
export function readPiReviewRoutingAdviceV1(input: {
  readonly taskDir: string;
  readonly ref: string;
  readonly expectedSha256: string;
  readonly expectedBinding: PiReviewRoutingAdviceReceiptV1["binding"];
}): PiReviewRoutingAdviceReceiptV1 {
  const file = receiptPath(input.taskDir, input.ref);
  const task = fs.realpathSync(input.taskDir);
  const realFile = fs.realpathSync(file);
  const relative = path.relative(task, realFile);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !fs.statSync(realFile).isFile()
  )
    throw new Error("Pi Review Jev advice does not resolve to a Task file");
  const bytes = fs.readFileSync(realFile);
  if (sha256(bytes) !== input.expectedSha256)
    throw new Error(
      "Pi Review Jev advice hash does not match the escalation request",
    );
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Pi Review Jev advice is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Pi Review Jev advice must be a JSON object");
  const receipt = value as PiReviewRoutingAdviceReceiptV1;
  if (
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(RECEIPT_KEYS)
  )
    throw new Error("Pi Review Jev advice has an unsupported shape");
  const { contentFingerprint, ...core } = receipt;
  const reportedConfidence =
    receipt.confidence?.[PI_REVIEW_ROUTING_QUESTION_ID_V1];
  const expectedInputBody = JSON.stringify(ROUTING_PROVIDER_PAYLOAD);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.source !== "pactile-pi-review-routing-advice-v1" ||
    receipt.status !== "answered" ||
    receipt.recommendationDisposition !== "adopted" ||
    receipt.escalationAction !== "append-codex-review" ||
    receipt.basis !== "jev-recommended" ||
    receipt.recommendation !== "append-codex-review" ||
    JSON.stringify(receipt.binding) !== JSON.stringify(input.expectedBinding) ||
    receipt.request.inputSha256 !== sha256(expectedInputBody) ||
    receipt.request.inputBytes !==
      Buffer.byteLength(expectedInputBody, "utf8") ||
    receipt.request.sentInputSha256 !== receipt.request.inputSha256 ||
    !["default", "configured"].includes(receipt.projectEgressPolicy.before) ||
    receipt.projectEgressPolicy.after !== receipt.projectEgressPolicy.before ||
    receipt.projectEgressPolicy.changed ||
    receipt.transport.outcome !== "answered" ||
    receipt.transport.reasonCode !== null ||
    receipt.transport.attempts !== 1 ||
    reportedConfidence?.status !== "available" ||
    !Number.isFinite(reportedConfidence.value) ||
    reportedConfidence.value < PI_REVIEW_ROUTING_CONFIDENCE_THRESHOLD_V1 ||
    reportedConfidence.value > 1 ||
    sha256(JSON.stringify(core)) !== contentFingerprint
  ) {
    throw new Error(
      "Pi Review Jev advice does not authorize this optional escalation",
    );
  }
  return receipt;
}
