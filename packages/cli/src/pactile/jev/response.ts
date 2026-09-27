import { types as utilTypes } from "node:util";
import { snapshotPlainOwnDataRecordV3 } from "../retrieval/boundary.js";
import { MODEL_PATTERN } from "./contracts.js";
import type {
  JevAnswerV1,
  JevConfidenceReceiptV1,
  JevConfidenceUnavailableReasonV1,
  JevQuestionV1,
  JevConfidenceValueV1,
} from "./contracts.js";

const COST_MICRO_USD_PER_INPUT_TOKEN = 0.042;
const PROBABILITY_SUM_TOLERANCE = 0.01;
const SCORE_EXPECTATION_TOLERANCE = 0.01;
const QUESTION_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;

/** Snapshot either a provider JSON record or our null-prototype receipt map. */
function snapshotConfidenceRecord(
  raw: unknown,
): Readonly<Record<string, unknown>> | null {
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    utilTypes.isProxy(raw)
  )
    return null;
  try {
    const prototype = Object.getPrototypeOf(raw) as object | null;
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(raw);
    if (keys.some((key) => typeof key !== "string")) return null;
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      )
        return null;
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch {
    return null;
  }
}

function unavailableConfidence(
  reasonCode: JevConfidenceUnavailableReasonV1,
): JevConfidenceValueV1 {
  return Object.freeze({ status: "unavailable", reasonCode });
}

function availableConfidence(value: number): JevConfidenceValueV1 {
  return Object.freeze({ status: "available", value });
}

/** Build explicit unavailable entries for a bounded set of known question IDs. */
export function unavailableJevConfidenceReceiptV1(
  questionIds: readonly string[],
  reasonCode: JevConfidenceUnavailableReasonV1 = "not-returned",
): JevConfidenceReceiptV1 {
  const result: Record<string, JevConfidenceValueV1> = Object.create(null) as Record<
    string,
    JevConfidenceValueV1
  >;
  for (const questionId of questionIds) {
    if (QUESTION_ID.test(questionId))
      result[questionId] = unavailableConfidence(reasonCode);
  }
  return Object.freeze(result);
}

/** Keep only valid provider confidence values for the caller's known questions. */
export function projectJevConfidenceReceiptV1(
  raw: unknown,
  questionIds: readonly string[],
): JevConfidenceReceiptV1 {
  const source = snapshotConfidenceRecord(raw);
  const result: Record<string, JevConfidenceValueV1> = Object.create(null) as Record<
    string,
    JevConfidenceValueV1
  >;
  for (const questionId of questionIds) {
    if (!QUESTION_ID.test(questionId)) continue;
    const value = source ? snapshotPlainOwnDataRecordV3(source[questionId]) : null;
    if (
      value?.status === "available" &&
      typeof value.value === "number" &&
      Number.isFinite(value.value) &&
      value.value >= 0 &&
      value.value <= 1
    ) {
      result[questionId] = availableConfidence(value.value);
      continue;
    }
    if (
      value?.status === "unavailable" &&
      (value.reasonCode === "not-returned" ||
        value.reasonCode === "not-provided" ||
        value.reasonCode === "invalid")
    ) {
      result[questionId] = unavailableConfidence(value.reasonCode);
      continue;
    }
    result[questionId] = unavailableConfidence(
      source && Object.hasOwn(source, questionId) ? "invalid" : "not-returned",
    );
  }
  return Object.freeze(result);
}

/** Extract only finite provider-reported confidence; never derive it from an answer. */
export function readJevConfidenceReceiptV1(
  raw: unknown,
  questions: Readonly<Record<string, JevQuestionV1>>,
): JevConfidenceReceiptV1 {
  const payload = snapshotPlainOwnDataRecordV3(raw);
  const answers = snapshotPlainOwnDataRecordV3(payload?.answers);
  const result: Record<string, JevConfidenceValueV1> = Object.create(null) as Record<
    string,
    JevConfidenceValueV1
  >;
  for (const questionId of Object.keys(questions).sort()) {
    if (!answers || !Object.hasOwn(answers, questionId)) {
      result[questionId] = unavailableConfidence("not-returned");
      continue;
    }
    const answer = snapshotPlainOwnDataRecordV3(answers[questionId]);
    if (answer === null) {
      result[questionId] = unavailableConfidence("invalid");
      continue;
    }
    if (!Object.hasOwn(answer, "confidence")) {
      result[questionId] = unavailableConfidence("not-provided");
      continue;
    }
    const confidence = answer.confidence;
    result[questionId] =
      typeof confidence === "number" &&
      Number.isFinite(confidence) &&
      confidence >= 0 &&
      confidence <= 1
        ? availableConfidence(confidence)
        : unavailableConfidence("invalid");
  }
  return Object.freeze(result);
}

function exactFields(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const names = new Set(allowed);
  return Object.keys(record).every((key) => names.has(key));
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
  const sum = Object.values(result).reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) return null;
  return Object.freeze(result);
}

function scoreLegend(
  raw: unknown,
  criteria: readonly (string | null)[],
): Readonly<Record<string, string | null>> | null {
  const source = snapshotPlainOwnDataRecordV3(raw);
  if (source === null) return null;
  const keys = criteria.map((_value, index) => String(index));
  const actual = Object.keys(source).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    return null;
  const legend: Record<string, string | null> = Object.create(null) as Record<
    string,
    string | null
  >;
  for (const key of keys) {
    const value = source[key];
    const criterion = criteria[Number(key)];
    if (
      criterion === undefined ||
      (value !== null && typeof value !== "string") ||
      value !== criterion
    )
      return null;
    legend[key] = value;
  }
  return Object.freeze(legend);
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
      if (p[a.choice] !== Math.max(...Object.values(p))) return null;
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
      const legend = scoreLegend(a.legend, q.criteria);
      if (p === null || legend === null) return null;
      const expectedScore = scoreKeys.reduce(
        (total, key, index) => total + index * (p[key] ?? 0),
        0,
      );
      if (Math.abs(a.score - expectedScore) > SCORE_EXPECTATION_TOLERANCE)
        return null;
      out[name] = Object.freeze({
        type: "score",
        score: a.score,
        confidence: a.confidence,
        probabilities: p,
        legend,
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
    !MODEL_PATTERN.test(value.model)
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

export { costEstimate, decisionConfidence, parseSuccess };
