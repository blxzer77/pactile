import { snapshotPlainOwnDataRecordV3 } from "../retrieval/boundary.js";
import { JEV_ORIGIN_V1, MODEL_PATTERN } from "./contracts.js";
import type {
  JevDecisionRequestV1,
  JevFallbackCodeV1,
  JevQuestionV1,
} from "./contracts.js";

const QUESTION_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const LABEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const LOGICAL_REF = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/u;
const UNSAFE_CONTROL =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/u;
const MAX_REQUEST_BYTES = 12 * 1024;
const MAX_SNIPPETS = 3;
const MAX_SNIPPET_CHARS = 3_500;
const MAX_SUMMARY_CHARS = 2_000;

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/iu,
  /\b(?:gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|glpat-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bsk-(?:live|test|proj)?[_-]?[A-Za-z0-9_-]{20,}\b/u,
  /\bsk_(?:live|test)_[A-Za-z0-9_-]{12,}\b/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /\b[A-Z0-9_.-]*(?:API[_-]?KEY|ACCESS[_-]?(?:KEY|TOKEN)|AUTH(?:ORIZATION)?|TOKEN|SECRET|PASS(?:WORD|WD)?|CREDENTIALS?|PRIVATE[_-]?(?:KEY|TOKEN)|DATABASE[_-]?(?:URL|URI)|DB[_-]?(?:URL|URI)|CONNECTION[_-]?(?:STRING|URI|URL)|DSN)[A-Z0-9_.-]*\b["']?\s*(?:=|:)\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/iu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}\b/iu,
  /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/iu,
  /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s@?#]+@[^/\s?#]+/u,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
];
const EXPLICIT_SENSITIVE_MARKERS: readonly RegExp[] = [
  /\bCONFIDENTIAL\b/iu,
  /\b(?:SENSITIVE|SECRET)\b/iu,
  /\bSENSITIVE[ _-]?(?:CONTENT|INFORMATION|DATA)\b/iu,
  /\b(?:PERSONAL DATA|PII|PROPRIETARY|RESTRICTED|INTERNAL ONLY|INTERNAL USE ONLY|FOR INTERNAL USE ONLY|DO NOT SHARE EXTERNALLY|DO NOT SEND EXTERNALLY|DO NOT SEND OUTSIDE|NOT FOR EXTERNAL USE)\b/iu,
  /\bPRIVATE\s+(?:KEY|CONTENT|DATA|INFORMATION)\b/iu,
  /\bSECRET\s+(?:KEY|TOKEN|CREDENTIALS?|INFORMATION|CONTENT|DATA)\b/iu,
  /(?:机密|敏感|不得对外(?:发送|提供|披露)|禁止对外(?:发送|提供|披露)|禁止(?:外发|外传)|请勿(?:对外发送|外发|外传)|仅限内部|内部使用|不可外发|不得分享给外部)/u,
];

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
  return (
    CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text)) ||
    EXPLICIT_SENSITIVE_MARKERS.some((pattern) => pattern.test(text))
  );
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
export function validateInput(
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
    !MODEL_PATTERN.test(model) ||
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
export function egressFailure(
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
    p.destination !== JEV_ORIGIN_V1 ||
    !Array.isArray(p.egressDestinations) ||
    !p.egressDestinations.every((v) => typeof v === "string") ||
    !p.egressDestinations.includes(JEV_ORIGIN_V1)
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
