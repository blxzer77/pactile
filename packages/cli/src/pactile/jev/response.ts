import { snapshotPlainOwnDataRecordV3 } from "../retrieval/boundary.js";
import { MODEL_PATTERN } from "./contracts.js";
import type { JevAnswerV1, JevQuestionV1 } from "./contracts.js";

const COST_MICRO_USD_PER_INPUT_TOKEN = 0.042;
const PROBABILITY_SUM_TOLERANCE = 0.01;
const SCORE_EXPECTATION_TOLERANCE = 0.01;

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
