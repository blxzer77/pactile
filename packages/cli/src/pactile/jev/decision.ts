import process from "node:process";

import { fail, MAX_DEADLINE_MS } from "./contracts.js";
import type {
  JevCallOptionsV1,
  JevDecisionRequestV1,
  JevFallbackCodeV1,
  JevReceiptV1,
  JevTransportConfigV1,
  JevTransportResultV1,
} from "./contracts.js";
import { egressFailure, validateInput } from "./outbound.js";
import { createJevTransportV1 } from "./transport.js";

export const JEV_DECISION_NODES_V1 = [
  "tile-selection",
  "task-scheduling",
  "execution-routing",
  "review-routing",
  "verification-planning",
  "retrieval-planning",
] as const;

export type JevDecisionNodeV1 = (typeof JEV_DECISION_NODES_V1)[number];

const DEFAULT_MAX_DECISIONS = 1;
const MAX_DECISIONS = 32;

export interface JevDecisionFacadeConfigV1 {
  /** Explicit opt-in. False keeps every decision on the local path. */
  readonly enabled?: boolean;
  /** Maximum provider decisions for this facade instance, excluding retries. */
  readonly maxDecisions?: number;
  /** Hard cap applied to each request deadline. */
  readonly maxDeadlineMs?: number;
  readonly transport?: JevTransportConfigV1;
}

export interface JevDecisionInvocationV1 {
  readonly node: JevDecisionNodeV1;
  readonly request: JevDecisionRequestV1;
  readonly options: JevCallOptionsV1;
}

export interface JevDecisionBudgetV1 {
  readonly maxDecisions: number;
  readonly decisionsUsed: number;
  readonly decisionsRemaining: number;
  readonly maximumHttpAttempts: number;
  /** Sum of the provider's reported-input-token cost estimates for this instance. */
  readonly observedEstimatedInputCostMicrousd: number;
}

export interface JevDecisionReceiptV1 {
  readonly schemaVersion: 1;
  readonly node: JevDecisionNodeV1;
  readonly transport: JevReceiptV1;
  readonly budget: JevDecisionBudgetV1;
}

export type JevDecisionResultV1 =
  | {
      readonly node: JevDecisionNodeV1;
      readonly status: "answered";
      readonly answers: Extract<
        JevTransportResultV1,
        { status: "answered" }
      >["answers"];
      readonly fallback: null;
      readonly receipt: JevDecisionReceiptV1;
    }
  | {
      readonly node: JevDecisionNodeV1;
      readonly status: "fallback";
      readonly answers: null;
      readonly fallback: {
        readonly reasonCode: JevFallbackCodeV1;
        readonly explanation: string;
      };
      readonly receipt: JevDecisionReceiptV1;
    };

export interface JevDecisionFacadeV1 {
  decide(input: JevDecisionInvocationV1): Promise<JevDecisionResultV1>;
}

function validNode(value: unknown): value is JevDecisionNodeV1 {
  return (
    typeof value === "string" &&
    (JEV_DECISION_NODES_V1 as readonly string[]).includes(value)
  );
}

function receiptBudget(
  maxDecisions: number,
  decisionsUsed: number,
  maximumHttpAttempts: number,
  observedEstimatedInputCostMicrousd: number,
): JevDecisionBudgetV1 {
  return Object.freeze({
    maxDecisions,
    decisionsUsed,
    decisionsRemaining: Math.max(0, maxDecisions - decisionsUsed),
    maximumHttpAttempts,
    observedEstimatedInputCostMicrousd,
  });
}

function withReceipt(
  node: JevDecisionNodeV1,
  result: JevTransportResultV1,
  budget: JevDecisionBudgetV1,
): JevDecisionResultV1 {
  const receipt: JevDecisionReceiptV1 = Object.freeze({
    schemaVersion: 1,
    node,
    transport: result.receipt,
    budget,
  });
  if (result.status === "answered") {
    return Object.freeze({
      node,
      status: "answered",
      answers: result.answers,
      fallback: null,
      receipt,
    });
  }
  return Object.freeze({
    node,
    status: "fallback",
    answers: null,
    fallback: result.fallback,
    receipt,
  });
}

function fallback(
  node: JevDecisionNodeV1,
  code: JevFallbackCodeV1,
  budget: JevDecisionBudgetV1,
): JevDecisionResultV1 {
  return withReceipt(node, fail(code), budget);
}

/**
 * Build an optional, bounded decision facade. It returns suggestions and
 * receipts only; callers retain deterministic validation and authority.
 */
export function createJevDecisionFacadeV1(
  config: JevDecisionFacadeConfigV1 = {},
): JevDecisionFacadeV1 {
  const requestedMaxDecisions = config.maxDecisions ?? DEFAULT_MAX_DECISIONS;
  const maxDecisionsValid =
    Number.isSafeInteger(requestedMaxDecisions) &&
    requestedMaxDecisions >= 1 &&
    requestedMaxDecisions <= MAX_DECISIONS;
  const maxDecisions = maxDecisionsValid
    ? requestedMaxDecisions
    : DEFAULT_MAX_DECISIONS;
  const requestedMaxDeadlineMs = config.maxDeadlineMs ?? MAX_DEADLINE_MS;
  const maxDeadlineValid =
    Number.isSafeInteger(requestedMaxDeadlineMs) &&
    requestedMaxDeadlineMs >= 1 &&
    requestedMaxDeadlineMs <= MAX_DEADLINE_MS;
  const maxDeadlineMs = maxDeadlineValid
    ? requestedMaxDeadlineMs
    : MAX_DEADLINE_MS;
  const requestedDeadlineMs = config.transport?.deadlineMs ?? 2_500;
  const deadlineValid =
    Number.isSafeInteger(requestedDeadlineMs) &&
    requestedDeadlineMs >= 1 &&
    requestedDeadlineMs <= MAX_DEADLINE_MS;
  const deadlineMs = deadlineValid
    ? Math.min(requestedDeadlineMs, maxDeadlineMs)
    : 2_500;
  const requestedMaxRetries = config.transport?.maxRetries ?? 1;
  const retriesValid =
    Number.isSafeInteger(requestedMaxRetries) &&
    requestedMaxRetries >= 0 &&
    requestedMaxRetries <= 1;
  const maxRetries = retriesValid ? requestedMaxRetries : 1;
  const enabledValid =
    config.enabled === undefined || typeof config.enabled === "boolean";
  const configValid =
    enabledValid &&
    maxDecisionsValid &&
    maxDeadlineValid &&
    deadlineValid &&
    retriesValid;
  const maximumHttpAttempts = maxDecisions * (maxRetries + 1);
  const transportConfig: JevTransportConfigV1 = {
    ...config.transport,
    deadlineMs,
  };
  const requestTransport = createJevTransportV1(transportConfig);
  let decisionsUsed = 0;
  let observedEstimatedInputCostMicrousd = 0;

  return Object.freeze({
    async decide(input: JevDecisionInvocationV1): Promise<JevDecisionResultV1> {
      const node = validNode(input?.node) ? input.node : "retrieval-planning";
      const budget = (): JevDecisionBudgetV1 =>
        receiptBudget(
          maxDecisions,
          decisionsUsed,
          maximumHttpAttempts,
          observedEstimatedInputCostMicrousd,
        );
      if (!configValid)
        return fallback(node, "configuration-invalid", budget());
      if (config.enabled === false) return fallback(node, "disabled", budget());
      if (Number(process.versions.node.split(".")[0]) < 20)
        return fallback(node, "runtime-unsupported", budget());
      const apiKey = config.transport?.apiKey;
      if (typeof apiKey !== "string" || apiKey.length === 0)
        return fallback(node, "configuration-missing", budget());
      if (
        apiKey.length < 8 ||
        apiKey.length > 512 ||
        !/^[\x21-\x7E]+$/u.test(apiKey)
      )
        return fallback(node, "configuration-invalid", budget());
      if (
        !validNode(input?.node) ||
        input.request === undefined ||
        input.options === undefined ||
        input.options === null
      )
        return fallback(node, "input-invalid", budget());
      const checked = validateInput(input.request, apiKey);
      if (!checked.ok) return fallback(node, checked.code, budget());
      const egressError = egressFailure(
        input.options.egress,
        (checked.request.sourceSnippets?.length ?? 0) > 0,
      );
      if (egressError !== null) return fallback(node, egressError, budget());
      const minimumDecisionConfidence =
        input.options.minimumDecisionConfidence ?? 0.65;
      if (
        !Number.isFinite(minimumDecisionConfidence) ||
        minimumDecisionConfidence < 0 ||
        minimumDecisionConfidence > 1
      )
        return fallback(node, "configuration-invalid", budget());
      if (input.options.signal?.aborted)
        return fallback(node, "cancelled", budget());
      const fetchImpl = config.transport?.fetchImpl ?? globalThis.fetch;
      if (typeof fetchImpl !== "function")
        return fallback(node, "runtime-unsupported", budget());
      if (decisionsUsed >= maxDecisions)
        return fallback(node, "budget-exhausted", budget());

      decisionsUsed += 1;
      const result = await requestTransport(input.request, input.options);
      const callCost = result.receipt.estimatedInputCostMicrousd;
      if (callCost !== null) observedEstimatedInputCostMicrousd += callCost;
      return withReceipt(node, result, budget());
    },
  });
}
