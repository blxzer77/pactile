export const JEV_ENDPOINT_V1 = "https://api.typesafe.ai/v1/systemone";
export const JEV_ORIGIN_V1 = "https://api.typesafe.ai";
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
export const MAX_DEADLINE_MS = 5_000;

export type JevQuestionV1 =
  | {
      readonly type: "noul";
      readonly instructions: string;
      readonly criteria?: {
        readonly true?: string | null;
        readonly false?: string | null;
      } | null;
    }
  | {
      readonly type: "choice";
      readonly instructions: string;
      readonly criteria: Readonly<Record<string, string | null>>;
    }
  | {
      readonly type: "score";
      readonly instructions: string;
      readonly criteria: readonly (string | null)[];
    };
export interface JevDecisionRequestV1 {
  readonly taskSummary: string;
  readonly sourceSnippets?: readonly {
    readonly ref: string;
    readonly text: string;
  }[];
  readonly questions: Readonly<Record<string, JevQuestionV1>>;
  readonly model?: string;
}
export interface JevEgressAuthorizationV1 {
  readonly network: "project-authorized";
  readonly privacy: "project-approved-egress";
  readonly credentials: "project-authorized";
  readonly destination: typeof JEV_ORIGIN_V1;
  readonly egressDestinations: readonly string[];
  readonly contentDecision:
    | "task-summary-approved"
    | "task-summary-and-snippets-approved";
}
export interface JevTransportConfigV1 {
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly deadlineMs?: number;
  readonly maxRetries?: number;
}
export interface JevCallOptionsV1 {
  readonly egress: JevEgressAuthorizationV1;
  readonly signal?: AbortSignal;
  readonly minimumDecisionConfidence?: number;
}
export type JevFallbackCodeV1 =
  | "disabled"
  | "budget-exhausted"
  | "runtime-unsupported"
  | "configuration-missing"
  | "configuration-invalid"
  | "egress-denied"
  | "content-not-approved"
  | "sensitive-content"
  | "input-invalid"
  | "input-too-large"
  | "cancelled"
  | "deadline-exceeded"
  | "authentication"
  | "invalid-request"
  | "rate-limited"
  | "service-unavailable"
  | "http-error"
  | "transport-error"
  | "response-too-large"
  | "invalid-response"
  | "low-confidence";
export interface JevReceiptV1 {
  readonly provider: "typesafe-jev";
  readonly outcome: "answered" | "fallback";
  readonly reasonCode: JevFallbackCodeV1 | null;
  readonly attempts: number;
  readonly latencyMs: number;
  readonly httpStatus: number | null;
  readonly requestId: string | null;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedInputCostMicrousd: number | null;
}
export type JevAnswerV1 =
  | { readonly type: "noul"; readonly noul: number }
  | {
      readonly type: "choice";
      readonly choice: string;
      readonly confidence: number;
      readonly probabilities: Readonly<Record<string, number>>;
    }
  | {
      readonly type: "score";
      readonly score: number;
      readonly confidence: number;
      readonly probabilities: Readonly<Record<string, number>>;
    };
export type JevTransportResultV1 =
  | {
      readonly status: "answered";
      readonly answers: Readonly<Record<string, JevAnswerV1>>;
      readonly fallback: null;
      readonly receipt: JevReceiptV1;
    }
  | {
      readonly status: "fallback";
      readonly answers: null;
      readonly fallback: {
        readonly reasonCode: JevFallbackCodeV1;
        readonly explanation: string;
      };
      readonly receipt: JevReceiptV1;
    };

const EXPLANATION: Readonly<Record<JevFallbackCodeV1, string>> = {
  disabled:
    "Jev is not configured; continue with the local deterministic path.",
  "budget-exhausted":
    "The local Jev decision budget is exhausted; continue with the local deterministic path.",
  "runtime-unsupported": "Jev requires Node.js 20 or newer; continue locally.",
  "configuration-missing": "No Jev API key is configured; continue locally.",
  "configuration-invalid": "Jev configuration is invalid; continue locally.",
  "egress-denied":
    "Project policy does not authorize this Jev destination; continue locally.",
  "content-not-approved":
    "Outgoing content is not approved for this destination; continue locally.",
  "sensitive-content":
    "A credential or sensitive-content marker was found; nothing was sent.",
  "input-invalid":
    "The Jev request is not a supported plain-data request; continue locally.",
  "input-too-large":
    "The Jev request exceeds the configured content bound; continue locally.",
  cancelled: "The Jev request was cancelled; continue locally.",
  "deadline-exceeded":
    "The Jev request exceeded its total deadline; continue locally.",
  authentication:
    "Jev rejected authentication; check local configuration and continue locally.",
  "invalid-request": "Jev rejected the request shape; continue locally.",
  "rate-limited": "Jev rate-limited the request; continue locally.",
  "service-unavailable": "Jev is temporarily unavailable; continue locally.",
  "http-error": "Jev returned an unsupported HTTP status; continue locally.",
  "transport-error": "Jev could not be reached safely; continue locally.",
  "response-too-large":
    "Jev returned a response above the configured bound; continue locally.",
  "invalid-response":
    "Jev returned a response that failed local contract checks; continue locally.",
  "low-confidence":
    "Jev's decision did not meet the configured confidence threshold; continue locally.",
};

export function fail(
  code: JevFallbackCodeV1,
  info: Partial<Omit<JevReceiptV1, "provider" | "outcome" | "reasonCode">> = {},
): JevTransportResultV1 {
  const receipt = Object.freeze({
    provider: "typesafe-jev" as const,
    outcome: "fallback" as const,
    reasonCode: code,
    attempts: info.attempts ?? 0,
    latencyMs: info.latencyMs ?? 0,
    httpStatus: info.httpStatus ?? null,
    requestId: info.requestId ?? null,
    model: info.model ?? null,
    inputTokens: info.inputTokens ?? null,
    outputTokens: info.outputTokens ?? null,
    estimatedInputCostMicrousd: info.estimatedInputCostMicrousd ?? null,
  });
  return Object.freeze({
    status: "fallback" as const,
    answers: null,
    fallback: Object.freeze({
      reasonCode: code,
      explanation: EXPLANATION[code],
    }),
    receipt,
  });
}
