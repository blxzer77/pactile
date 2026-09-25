import process from "node:process";
import { fail, MAX_DEADLINE_MS } from "./contracts.js";
import type {
  JevCallOptionsV1,
  JevReceiptV1,
  JevTransportConfigV1,
  JevTransportResultV1,
} from "./contracts.js";
import { egressFailure, validateInput } from "./outbound.js";
import { requestJevHttpV1 } from "./http.js";
import { costEstimate, decisionConfidence, parseSuccess } from "./response.js";

export { JEV_ENDPOINT_V1 } from "./contracts.js";
export type {
  JevAnswerV1,
  JevCallOptionsV1,
  JevDecisionRequestV1,
  JevEgressAuthorizationV1,
  JevFallbackCodeV1,
  JevQuestionV1,
  JevReceiptV1,
  JevTransportConfigV1,
  JevTransportResultV1,
} from "./contracts.js";

/** The response is a suggestion only, never Kernel, Review, CI, or authorization authority. */
export function createJevTransportV1(config: JevTransportConfigV1 = {}) {
  return async function requestJevDecisionV1(
    raw: unknown,
    options?: JevCallOptionsV1,
  ): Promise<JevTransportResultV1> {
    if (Number(process.versions.node.split(".")[0]) < 20)
      return fail("runtime-unsupported");
    const key = config.apiKey;
    if (typeof key !== "string" || key.length === 0)
      return fail("configuration-missing");
    if (key.length < 8 || key.length > 512 || !/^[\x21-\x7E]+$/u.test(key))
      return fail("configuration-invalid");
    const deadlineMs = config.deadlineMs ?? 2_500;
    const maxRetries = config.maxRetries ?? 1;
    if (
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 1 ||
      deadlineMs > MAX_DEADLINE_MS ||
      !Number.isSafeInteger(maxRetries) ||
      maxRetries < 0 ||
      maxRetries > 1
    )
      return fail("configuration-invalid");
    const input = validateInput(raw, key);
    if (!input.ok) return fail(input.code);
    if (options === undefined) return fail("egress-denied");
    const policyError = egressFailure(
      options.egress,
      (input.request.sourceSnippets?.length ?? 0) > 0,
    );
    if (policyError !== null) return fail(policyError);
    const minConfidence = options.minimumDecisionConfidence ?? 0.65;
    if (
      !Number.isFinite(minConfidence) ||
      minConfidence < 0 ||
      minConfidence > 1
    )
      return fail("configuration-invalid");
    if (options.signal?.aborted) return fail("cancelled");
    const fetchImpl = config.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") return fail("runtime-unsupported");

    const http = await requestJevHttpV1({
      apiKey: key,
      body: input.body,
      deadlineMs,
      maxRetries,
      fetchImpl,
      signal: options.signal,
    });
    if (!http.ok) return fail(http.reasonCode, http.metrics);
    const result = parseSuccess(http.payload, input.request.questions);
    if (result === null || result.model.includes(key))
      return fail("invalid-response", http.metrics);
    const receiptData = {
      ...http.metrics,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedInputCostMicrousd: costEstimate(result.inputTokens),
    };
    if (
      Object.values(result.answers).some(
        (answer) => decisionConfidence(answer) < minConfidence,
      )
    )
      return fail("low-confidence", receiptData);
    const receipt: JevReceiptV1 = Object.freeze({
      provider: "typesafe-jev",
      outcome: "answered",
      reasonCode: null,
      ...receiptData,
    });
    return Object.freeze({
      status: "answered",
      answers: result.answers,
      fallback: null,
      receipt,
    });
  };
}
