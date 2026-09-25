import process from "node:process";
import { performance } from "node:perf_hooks";
import {
  isPlainOwnDataJsonTreeV3,
  snapshotPlainOwnDataRecordV3,
} from "../retrieval/boundary.js";

export const JEV_ENDPOINT_V1 = "https://api.typesafe.ai/v1/systemone";
const ORIGIN = "https://api.typesafe.ai";
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const QUESTION_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const LABEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const LOGICAL_REF = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/u;
const SAFE_HEADER_ID = /^req_[A-Za-z0-9_-]{1,76}$/u;
const UNSAFE_CONTROL =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/u;
const MAX_REQUEST_BYTES = 12 * 1024;
const MAX_RESPONSE_BYTES = 24 * 1024;
const MAX_SNIPPETS = 3;
const MAX_SNIPPET_CHARS = 3_500;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_DEADLINE_MS = 5_000;
const COST_MICRO_USD_PER_INPUT_TOKEN = 0.042;

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
  readonly destination: typeof ORIGIN;
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
const SENSITIVE: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/iu,
  /\b(?:gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|glpat-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bsk-(?:live|test|proj)?[_-]?[A-Za-z0-9_-]{20,}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /\b(?:[A-Z0-9_-]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|REFRESH[_-]?TOKEN|CLIENT[_-]?SECRET|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_-]*)\b\s*(?:=|:)\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/iu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}\b/iu,
  /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/iu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /\b(?:CONFIDENTIAL|SENSITIVE(?: CONTENT)?|SECRET|PRIVATE|PERSONAL DATA|PII|PROPRIETARY|RESTRICTED|DO NOT SHARE EXTERNALLY|DO NOT SEND EXTERNALLY|INTERNAL ONLY)\b/iu,
];

function fail(
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
function exactFields(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const names = new Set(allowed);
  return Object.keys(record).every((key) => names.has(key));
}
function safeText(text: string): boolean {
  return text.length > 0 && !UNSAFE_CONTROL.test(text);
}
function hasSensitive(text: string): boolean {
  return SENSITIVE.some((pattern) => pattern.test(text));
}
function validateQuestion(name: string, raw: unknown): JevQuestionV1 | null {
  if (!QUESTION_ID.test(name)) return null;
  const q = snapshotPlainOwnDataRecordV3(raw);
  if (q === null || typeof q.type !== "string") return null;
  if (q.type === "noul") {
    if (
      !exactFields(q, ["type", "instructions", "criteria"]) ||
      typeof q.instructions !== "string" ||
      !safeText(q.instructions)
    )
      return null;
    if (q.criteria === undefined || q.criteria === null)
      return {
        type: "noul",
        instructions: q.instructions,
        criteria: q.criteria as null | undefined,
      };
    const c = snapshotPlainOwnDataRecordV3(q.criteria);
    if (c === null || !exactFields(c, ["true", "false"])) return null;
    if (
      Object.values(c).some(
        (v) => v !== null && (typeof v !== "string" || !safeText(v)),
      )
    )
      return null;
    return {
      type: "noul",
      instructions: q.instructions,
      criteria: c as {
        readonly true?: string | null;
        readonly false?: string | null;
      },
    };
  }
  if (q.type === "choice") {
    if (
      !exactFields(q, ["type", "instructions", "criteria"]) ||
      typeof q.instructions !== "string" ||
      !safeText(q.instructions)
    )
      return null;
    const c = snapshotPlainOwnDataRecordV3(q.criteria);
    if (c === null) return null;
    const labels = Object.keys(c);
    if (labels.length < 2 || labels.length > 16) return null;
    for (const [label, value] of Object.entries(c)) {
      if (
        !LABEL_ID.test(label) ||
        (value !== null && typeof value !== "string") ||
        (typeof value === "string" && !safeText(value))
      )
        return null;
    }
    return {
      type: "choice",
      instructions: q.instructions,
      criteria: c as Readonly<Record<string, string | null>>,
    };
  }
  if (q.type === "score") {
    if (
      !exactFields(q, ["type", "instructions", "criteria"]) ||
      typeof q.instructions !== "string" ||
      !safeText(q.instructions)
    )
      return null;
    if (
      !Array.isArray(q.criteria) ||
      q.criteria.length < 2 ||
      q.criteria.length > 10 ||
      !q.criteria.every(
        (v) => v === null || (typeof v === "string" && safeText(v)),
      )
    )
      return null;
    return {
      type: "score",
      instructions: q.instructions,
      criteria: q.criteria as readonly (string | null)[],
    };
  }
  return null;
}
function validateInput(
  raw: unknown,
  apiKey: string,
):
  | { ok: true; request: JevDecisionRequestV1; body: string }
  | { ok: false; code: JevFallbackCodeV1 } {
  const input = snapshotPlainOwnDataRecordV3(raw);
  if (
    input === null ||
    !exactFields(input, [
      "taskSummary",
      "sourceSnippets",
      "questions",
      "model",
    ]) ||
    typeof input.taskSummary !== "string" ||
    !safeText(input.taskSummary)
  )
    return { ok: false, code: "input-invalid" };
  if (input.taskSummary.length > MAX_SUMMARY_CHARS)
    return { ok: false, code: "input-too-large" };
  const model = input.model === undefined ? "jev-latest" : input.model;
  if (
    typeof model !== "string" ||
    !MODEL.test(model) ||
    hasSensitive(model) ||
    model.includes(apiKey)
  )
    return { ok: false, code: "input-invalid" };
  const snippets: { ref: string; text: string }[] = [];
  let totalSnippetChars = 0;
  if (input.sourceSnippets !== undefined) {
    if (
      !Array.isArray(input.sourceSnippets) ||
      input.sourceSnippets.length > MAX_SNIPPETS
    )
      return { ok: false, code: "input-too-large" };
    for (const rawSnippet of input.sourceSnippets) {
      const s = snapshotPlainOwnDataRecordV3(rawSnippet);
      if (
        s === null ||
        !exactFields(s, ["ref", "text"]) ||
        typeof s.ref !== "string" ||
        !LOGICAL_REF.test(s.ref) ||
        s.ref.includes("..") ||
        s.ref.includes("/") ||
        s.ref.includes("\\") ||
        typeof s.text !== "string" ||
        !safeText(s.text)
      ) {
        return { ok: false, code: "input-invalid" };
      }
      if (s.text.length > MAX_SNIPPET_CHARS)
        return { ok: false, code: "input-too-large" };
      totalSnippetChars += s.text.length;
      if (totalSnippetChars > 8_000)
        return { ok: false, code: "input-too-large" };
      snippets.push({ ref: s.ref, text: s.text });
    }
  }
  const rawQs = snapshotPlainOwnDataRecordV3(input.questions);
  if (rawQs === null) return { ok: false, code: "input-invalid" };
  const entries = Object.entries(rawQs);
  if (entries.length === 0 || entries.length > 8)
    return { ok: false, code: "input-invalid" };
  const questions: Record<string, JevQuestionV1> = Object.create(
    null,
  ) as Record<string, JevQuestionV1>;
  for (const [name, rawQ] of entries) {
    const q = validateQuestion(name, rawQ);
    if (q === null) return { ok: false, code: "input-invalid" };
    questions[name] = q;
  }
  const strings = [
    input.taskSummary,
    ...snippets.flatMap((s) => [s.ref, s.text]),
  ];
  for (const [name, q] of Object.entries(questions)) {
    strings.push(name, q.instructions);
    if (q.type === "noul" && q.criteria) {
      for (const v of [q.criteria.true, q.criteria.false])
        if (typeof v === "string") strings.push(v);
    } else if (q.type === "choice") {
      for (const [label, v] of Object.entries(q.criteria)) {
        strings.push(label);
        if (typeof v === "string") strings.push(v);
      }
    } else if (q.type === "score") {
      for (const v of q.criteria) if (typeof v === "string") strings.push(v);
    }
  }
  if (strings.some((value) => hasSensitive(value) || value.includes(apiKey)))
    return { ok: false, code: "sensitive-content" };
  const payload = {
    state: { taskSummary: input.taskSummary, sourceSnippets: snippets },
    model,
    questions,
  };
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES)
    return { ok: false, code: "input-too-large" };
  return {
    ok: true,
    request: {
      taskSummary: input.taskSummary,
      sourceSnippets: snippets,
      questions,
      model,
    },
    body,
  };
}
function egressFailure(
  raw: unknown,
  snippetsPresent: boolean,
): JevFallbackCodeV1 | null {
  const p = snapshotPlainOwnDataRecordV3(raw);
  if (
    p === null ||
    !exactFields(p, [
      "network",
      "privacy",
      "credentials",
      "destination",
      "egressDestinations",
      "contentDecision",
    ])
  )
    return "egress-denied";
  if (
    p.network !== "project-authorized" ||
    p.privacy !== "project-approved-egress" ||
    p.credentials !== "project-authorized" ||
    p.destination !== ORIGIN ||
    !Array.isArray(p.egressDestinations) ||
    !p.egressDestinations.every((v) => typeof v === "string") ||
    !p.egressDestinations.includes(ORIGIN)
  )
    return "egress-denied";
  if (snippetsPresent) {
    if (p.contentDecision !== "task-summary-and-snippets-approved")
      return "content-not-approved";
  } else if (
    p.contentDecision !== "task-summary-approved" &&
    p.contentDecision !== "task-summary-and-snippets-approved"
  ) {
    return "content-not-approved";
  }
  return null;
}
function getRequestId(response: Response, apiKey: string): string | null {
  const value = response.headers.get("x-typesafe-request-id");
  return value !== null && SAFE_HEADER_ID.test(value) && !value.includes(apiKey)
    ? value
    : null;
}
function probabilities(
  raw: unknown,
  keys: readonly string[],
): Readonly<Record<string, number>> | null {
  const value = snapshotPlainOwnDataRecordV3(raw);
  if (value === null) return null;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((v, i) => v !== expected[i])
  )
    return null;
  const result: Record<string, number> = Object.create(null) as Record<
    string,
    number
  >;
  for (const key of keys) {
    const v = value[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)
      return null;
    result[key] = v;
  }
  return Object.freeze(result);
}
function parseAnswers(
  raw: unknown,
  questions: Readonly<Record<string, JevQuestionV1>>,
): Readonly<Record<string, JevAnswerV1>> | null {
  const source = snapshotPlainOwnDataRecordV3(raw);
  if (source === null) return null;
  const names = Object.keys(questions).sort();
  const actual = Object.keys(source).sort();
  if (names.length !== actual.length || names.some((v, i) => v !== actual[i]))
    return null;
  const out: Record<string, JevAnswerV1> = Object.create(null) as Record<
    string,
    JevAnswerV1
  >;
  for (const name of names) {
    const q = questions[name];
    const a = snapshotPlainOwnDataRecordV3(source[name]);
    if (q === undefined || a === null) return null;
    if (q.type === "noul") {
      if (
        a.type !== "noul" ||
        !exactFields(a, ["type", "noul"]) ||
        typeof a.noul !== "number" ||
        !Number.isFinite(a.noul) ||
        a.noul < 0 ||
        a.noul > 1
      )
        return null;
      out[name] = Object.freeze({ type: "noul", noul: a.noul });
    } else if (q.type === "choice") {
      const labels = Object.keys(q.criteria);
      if (
        a.type !== "choice" ||
        !exactFields(a, ["type", "choice", "confidence", "probabilities"]) ||
        typeof a.choice !== "string" ||
        !labels.includes(a.choice) ||
        typeof a.confidence !== "number" ||
        !Number.isFinite(a.confidence) ||
        a.confidence < 0 ||
        a.confidence > 1
      )
        return null;
      const p = probabilities(a.probabilities, labels);
      if (p === null) return null;
      out[name] = Object.freeze({
        type: "choice",
        choice: a.choice,
        confidence: a.confidence,
        probabilities: p,
      });
    } else {
      const scoreKeys = q.criteria.map((_v, i) => String(i));
      if (
        a.type !== "score" ||
        !exactFields(a, [
          "type",
          "score",
          "confidence",
          "probabilities",
          "legend",
        ]) ||
        typeof a.score !== "number" ||
        !Number.isFinite(a.score) ||
        a.score < 0 ||
        a.score > q.criteria.length - 1 ||
        typeof a.confidence !== "number" ||
        !Number.isFinite(a.confidence) ||
        a.confidence < 0 ||
        a.confidence > 1
      )
        return null;
      const p = probabilities(a.probabilities, scoreKeys);
      if (p === null) return null;
      out[name] = Object.freeze({
        type: "score",
        score: a.score,
        confidence: a.confidence,
        probabilities: p,
      });
    }
  }
  return Object.freeze(out);
}
function parseSuccess(
  raw: unknown,
  questions: Readonly<Record<string, JevQuestionV1>>,
): {
  readonly answers: Readonly<Record<string, JevAnswerV1>>;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
} | null {
  const value = snapshotPlainOwnDataRecordV3(raw);
  if (
    value === null ||
    !exactFields(value, ["model", "answers", "usage"]) ||
    typeof value.model !== "string" ||
    !MODEL.test(value.model)
  )
    return null;
  const answers = parseAnswers(value.answers, questions);
  const usage = snapshotPlainOwnDataRecordV3(value.usage);
  if (
    answers === null ||
    usage === null ||
    !exactFields(usage, ["input_tokens", "output_tokens"])
  )
    return null;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 0 ||
    input > 1_000_000 ||
    typeof output !== "number" ||
    !Number.isSafeInteger(output) ||
    output < 0 ||
    output > 1_000_000
  )
    return null;
  return {
    answers,
    model: value.model,
    inputTokens: input,
    outputTokens: output,
  };
}
function costEstimate(inputTokens: number): number {
  // Published 2026-09-25: USD 0.042 / 1M input tokens; output tokens free.
  return Math.round(inputTokens * COST_MICRO_USD_PER_INPUT_TOKEN);
}
function decisionConfidence(a: JevAnswerV1): number {
  return a.type === "noul" ? Math.max(a.noul, 1 - a.noul) : a.confidence;
}
function retryDelay(response: Response): number {
  const ms = response.headers.get("retry-after-ms");
  if (ms !== null && /^\d{1,6}$/u.test(ms.trim()))
    return Math.min(500, Number(ms.trim()));
  const s = response.headers.get("retry-after");
  if (s !== null && /^\d{1,3}(?:\.\d+)?$/u.test(s.trim()))
    return Math.min(500, Math.max(0, Math.round(Number(s.trim()) * 1_000)));
  return 100;
}
function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T | null> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (value: T | null): void => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish(null);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(value),
      () => finish(null),
    );
  });
}
function cancelBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation !== undefined) void cancellation.catch(() => undefined);
  } catch {
    /* Never retain raw transport errors. */
  }
}
function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    /* Never retain raw transport errors. */
  }
}
async function retryWait(ms: number, signal: AbortSignal): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => finish(true), ms);
    const finish = (complete: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(complete);
    };
    const abort = (): void => finish(false);
    if (signal.aborted) finish(false);
    else signal.addEventListener("abort", abort, { once: true });
  });
}
async function readBoundedText(
  response: Response,
  signal: AbortSignal,
): Promise<{ text: string } | "too-large" | "aborted" | "failed"> {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    /^\d{1,10}$/u.test(length) &&
    Number(length) > MAX_RESPONSE_BYTES
  ) {
    cancelBody(response);
    return "too-large";
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return "failed";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await raceAbort(reader.read(), signal);
      if (item === null) {
        cancelReader(reader);
        return signal.aborted ? "aborted" : "failed";
      }
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        cancelReader(reader);
        return "too-large";
      }
      chunks.push(item.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* The reader may already be closed. */
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return "failed";
  }
}

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

    const started = performance.now();
    let attempts = 0;
    let status: number | null = null;
    let requestId: string | null = null;
    let callerCancelled = false;
    let expired = false;
    const controller = new AbortController();
    const abortCaller = (): void => {
      callerCancelled = true;
      controller.abort();
    };
    options.signal?.addEventListener("abort", abortCaller, { once: true });
    const deadlineTimer = setTimeout(() => {
      expired = true;
      controller.abort();
    }, deadlineMs);
    const latency = (): number =>
      Math.max(
        0,
        Math.min(MAX_DEADLINE_MS, Math.round(performance.now() - started)),
      );
    const error = (code: JevFallbackCodeV1): JevTransportResultV1 =>
      fail(code, {
        attempts,
        latencyMs: latency(),
        httpStatus: status,
        requestId,
      });

    try {
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (controller.signal.aborted)
          return error(callerCancelled ? "cancelled" : "deadline-exceeded");
        attempts += 1;
        let response: Response | null;
        try {
          response = await raceAbort(
            fetchImpl(JEV_ENDPOINT_V1, {
              method: "POST",
              redirect: "error",
              headers: {
                authorization: "Bearer " + key,
                "content-type": "application/json",
                accept: "application/json",
              },
              body: input.body,
              signal: controller.signal,
            }),
            controller.signal,
          );
        } catch {
          response = null;
        }
        if (response === null)
          return error(
            callerCancelled
              ? "cancelled"
              : expired
                ? "deadline-exceeded"
                : "transport-error",
          );
        status = response.status;
        requestId = getRequestId(response, key);

        if (!response.ok) {
          cancelBody(response);
          if (status === 401 || status === 403) return error("authentication");
          if (status === 422) return error("invalid-request");
          if (status === 408) return error("deadline-exceeded");
          if (status === 429 || (status >= 500 && status <= 599)) {
            const code =
              status === 429 ? "rate-limited" : "service-unavailable";
            if (attempt < maxRetries) {
              const delay = retryDelay(response);
              if (latency() + delay >= deadlineMs) return error(code);
              const completed = await retryWait(delay, controller.signal);
              if (completed !== true)
                return error(
                  callerCancelled ? "cancelled" : "deadline-exceeded",
                );
              continue;
            }
            return error(code);
          }
          return error("http-error");
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (
          !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/iu.test(contentType)
        )
          return error("invalid-response");
        const bodyResult = await readBoundedText(response, controller.signal);
        if (bodyResult === "too-large") return error("response-too-large");
        if (bodyResult === "aborted")
          return error(callerCancelled ? "cancelled" : "deadline-exceeded");
        if (bodyResult === "failed") return error("transport-error");
        let decoded: unknown;
        try {
          decoded = JSON.parse(bodyResult.text);
        } catch {
          return error("invalid-response");
        }
        if (!isPlainOwnDataJsonTreeV3(decoded))
          return error("invalid-response");
        const result = parseSuccess(decoded, input.request.questions);
        if (result === null || result.model.includes(key))
          return error("invalid-response");
        const receiptData = {
          attempts,
          latencyMs: latency(),
          httpStatus: status,
          requestId,
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          estimatedInputCostMicrousd: costEstimate(result.inputTokens),
        };
        if (
          Object.values(result.answers).some(
            (answer) => decisionConfidence(answer) < minConfidence,
          )
        ) {
          return fail("low-confidence", receiptData);
        }
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
      }
      return error("transport-error");
    } finally {
      clearTimeout(deadlineTimer);
      options.signal?.removeEventListener("abort", abortCaller);
    }
  };
}
