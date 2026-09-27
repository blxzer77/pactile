import { Buffer } from "node:buffer";

import {
  ASSURANCE_LEVELS_V1,
  COST_CEILINGS_V1,
  CREDENTIAL_CEILINGS_V1,
  FILESYSTEM_CEILINGS_V1,
  NETWORK_CEILINGS_V1,
  PACTILE_INTENTS_V1,
  PRIVACY_CEILINGS_V1,
  PROCESS_CEILINGS_V1,
  PROVIDER_READINESS_V1,
  TELEMETRY_CEILINGS_V1,
  fingerprintPactileContractV1,
  type AssuranceLevelV1,
  type PactileIntentV1,
  type PolicyCeilingV1,
} from "../../core/index.js";

import {
  RETRIEVAL_ABI_VERSION,
  RETRIEVAL_CORROBORATION_KINDS_V3,
  RETRIEVAL_INTENT_ORDER,
  RETRIEVAL_PROVIDER_STATUSES_V3,
  type RetrievalBudgetV3,
  type RetrievalParseResultV3,
  type RetrievalPlanV3,
  type RetrievalPlanningContextV3,
  type RetrievalProviderAvailabilityV3,
  type RetrievalProviderStatusV3,
  type RetrievalRequestV3,
  type RetrievalStopReasonV3,
  type RetrievalValidationIssueV3,
  type RetrievalValidationIssueCodeV3,
} from "./types.js";
import { isPlainOwnDataJsonTreeV3 } from "./boundary.js";

const MAX_QUERY_BYTES = 16 * 1024;
const MAX_SCOPE_HINTS = 128;
const MAX_SCOPE_HINT_BYTES = 512;
const MAX_EVIDENCE_KINDS = 64;
const MAX_LOGICAL_ID_BYTES = 128;
const LOGICAL_ID = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;

export const DEFAULT_RETRIEVAL_BUDGET_V3: RetrievalBudgetV3 = Object.freeze({
  maxSteps: 16,
  maxCandidatesPerStep: 50,
});

export const DEFAULT_RETRIEVAL_POLICY_V3: PolicyCeilingV1 = Object.freeze({
  filesystem: "read",
  process: "execute",
  network: "forbidden",
  credentials: "forbidden",
  privacy: "local-only",
  egressDestinations: Object.freeze([]) as readonly string[],
  telemetry: "local-only",
  cost: "free",
});

export interface BuildRetrievalRequestV3Input {
  readonly query: string;
  readonly intents?: readonly PactileIntentV1[];
  readonly scopeHints?: readonly string[];
  readonly minimumAssurance?: AssuranceLevelV1;
  readonly requestedPolicy?: PolicyCeilingV1;
  readonly requiredEvidenceKinds?: readonly string[];
  readonly budget?: RetrievalBudgetV3;
}

export class RetrievalRequestValidationError extends Error {
  readonly issues: readonly RetrievalValidationIssueV3[];

  constructor(issues: readonly RetrievalValidationIssueV3[]) {
    super("PACTILE_RETRIEVAL_REQUEST_INVALID");
    this.name = "RetrievalRequestValidationError";
    this.issues = issues;
  }
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function issue(
  issues: RetrievalValidationIssueV3[],
  code: RetrievalValidationIssueCodeV3,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function normalizeText(
  value: unknown,
  path: string,
  issues: RetrievalValidationIssueV3[],
  options: {
    maxBytes: number;
    collapseWhitespace?: boolean;
    logicalId?: boolean;
  },
): string {
  if (typeof value !== "string") {
    issue(issues, "invalid-type", path, "must be a string");
    return "";
  }
  if (hasLoneSurrogate(value)) {
    issue(
      issues,
      "invalid-value",
      path,
      "must contain valid Unicode scalar values",
    );
    return "";
  }
  const normalized = (
    options.collapseWhitespace
      ? value.replace(/\s+/gu, " ").trim()
      : value.trim()
  ).normalize("NFC");
  if (!normalized) {
    issue(issues, "invalid-value", path, "must not be empty");
  }
  if (/\p{Cc}/u.test(normalized)) {
    issue(issues, "invalid-value", path, "must not contain control characters");
  }
  if (Buffer.byteLength(normalized, "utf8") > options.maxBytes) {
    issue(
      issues,
      "limit-exceeded",
      path,
      `must be at most ${options.maxBytes} UTF-8 bytes`,
    );
  }
  if (options.logicalId && normalized && !LOGICAL_ID.test(normalized)) {
    issue(issues, "invalid-value", path, "must be a lowercase logical id");
  }
  return normalized;
}

function readRecord(
  value: unknown,
  path: string,
  allowed: readonly string[],
  issues: RetrievalValidationIssueV3[],
): Readonly<Record<string, unknown>> | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !isPlainOwnDataJsonTreeV3(value)
  ) {
    issue(issues, "invalid-type", path, "must be an object");
    return null;
  }
  let prototype: object | null;
  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  let ownKeys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value) as Readonly<
      Record<string, PropertyDescriptor>
    >;
    ownKeys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError(`${path} must be a plain data object`);
  }
  if (prototype !== Object.prototype) {
    issue(issues, "invalid-type", path, "must be a plain data object");
    return null;
  }
  if (ownKeys.some((key) => typeof key === "symbol")) {
    issue(issues, "unknown-field", path, "must not contain symbol fields");
  }
  const allowedSet = new Set(allowed);
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(descriptors).sort(utf8Compare)) {
    if (!allowedSet.has(key)) {
      issue(issues, "unknown-field", path, "contains an unknown field");
      continue;
    }
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      issue(
        issues,
        "invalid-type",
        `${path}.${key}`,
        "must be an own data field",
      );
      continue;
    }
    result[key] = descriptor.value;
  }
  return result;
}

function required(
  record: Readonly<Record<string, unknown>> | null,
  key: string,
  path: string,
  issues: RetrievalValidationIssueV3[],
): unknown {
  if (!record || !Object.prototype.hasOwnProperty.call(record, key)) {
    issue(issues, "missing-field", `${path}.${key}`, "is required");
    return undefined;
  }
  return record[key];
}

function readArray(
  value: unknown,
  path: string,
  issues: RetrievalValidationIssueV3[],
  maxItems: number,
): readonly unknown[] {
  if (!Array.isArray(value) || !isPlainOwnDataJsonTreeV3(value)) {
    issue(issues, "invalid-type", path, "must be an array");
    return [];
  }
  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  let ownKeys: readonly PropertyKey[];
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as Readonly<
      Record<string, PropertyDescriptor>
    >;
    ownKeys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError(`${path} must be a plain data array`);
  }
  const lengthDescriptor = descriptors.length;
  const length =
    lengthDescriptor &&
    "value" in lengthDescriptor &&
    typeof lengthDescriptor.value === "number"
      ? lengthDescriptor.value
      : 0;
  if (length > maxItems) {
    issue(
      issues,
      "limit-exceeded",
      path,
      `must contain at most ${maxItems} items`,
    );
  }
  if (ownKeys.some((key) => typeof key === "symbol")) {
    issue(issues, "unknown-field", path, "must not contain symbol fields");
  }
  const output: unknown[] = [];
  const safeLength = Math.min(length, maxItems);
  for (let index = 0; index < safeLength; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) {
      issue(
        issues,
        "invalid-type",
        `${path}[${index}]`,
        "must be an own data item",
      );
      output.push(undefined);
    } else {
      output.push(descriptor.value);
    }
  }
  for (const key of Object.keys(descriptors)) {
    if (key === "length" || /^(?:0|[1-9]\d*)$/.test(key)) continue;
    issue(issues, "unknown-field", path, "contains unknown array metadata");
  }
  return output;
}

function normalizeStringSet(
  value: unknown,
  path: string,
  issues: RetrievalValidationIssueV3[],
  options: {
    maxItems: number;
    maxBytes: number;
    logicalId?: boolean;
  },
): readonly string[] {
  const items = readArray(value, path, issues, options.maxItems);
  const normalized = items.map((item, index) =>
    normalizeText(item, `${path}[${index}]`, issues, {
      maxBytes: options.maxBytes,
      logicalId: options.logicalId,
    }),
  );
  const seen = new Set<string>();
  for (let index = 0; index < normalized.length; index += 1) {
    const item = normalized[index];
    if (seen.has(item)) {
      issue(
        issues,
        "duplicate-value",
        `${path}[${index}]`,
        "must be unique after normalization",
      );
    }
    seen.add(item);
  }
  return [...normalized].sort(utf8Compare);
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
  issues: RetrievalValidationIssueV3[],
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    issue(
      issues,
      "invalid-value",
      path,
      `must be one of: ${values.join(", ")}`,
    );
    return values[0];
  }
  return value as T;
}

function integer(
  value: unknown,
  path: string,
  issues: RetrievalValidationIssueV3[],
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    issue(
      issues,
      "invalid-value",
      path,
      `must be a safe integer from ${min} through ${max}`,
    );
    return min;
  }
  return value as number;
}

function parsePolicy(
  value: unknown,
  path: string,
  issues: RetrievalValidationIssueV3[],
): PolicyCeilingV1 {
  const record = readRecord(
    value,
    path,
    [
      "filesystem",
      "process",
      "network",
      "credentials",
      "privacy",
      "egressDestinations",
      "telemetry",
      "cost",
    ],
    issues,
  );
  const policy: PolicyCeilingV1 = {
    filesystem: enumValue(
      required(record, "filesystem", path, issues),
      FILESYSTEM_CEILINGS_V1,
      `${path}.filesystem`,
      issues,
    ),
    process: enumValue(
      required(record, "process", path, issues),
      PROCESS_CEILINGS_V1,
      `${path}.process`,
      issues,
    ),
    network: enumValue(
      required(record, "network", path, issues),
      NETWORK_CEILINGS_V1,
      `${path}.network`,
      issues,
    ),
    credentials: enumValue(
      required(record, "credentials", path, issues),
      CREDENTIAL_CEILINGS_V1,
      `${path}.credentials`,
      issues,
    ),
    privacy: enumValue(
      required(record, "privacy", path, issues),
      PRIVACY_CEILINGS_V1,
      `${path}.privacy`,
      issues,
    ),
    egressDestinations: normalizeStringSet(
      required(record, "egressDestinations", path, issues),
      `${path}.egressDestinations`,
      issues,
      { maxItems: 64, maxBytes: 256 },
    ),
    telemetry: enumValue(
      required(record, "telemetry", path, issues),
      TELEMETRY_CEILINGS_V1,
      `${path}.telemetry`,
      issues,
    ),
    cost: enumValue(
      required(record, "cost", path, issues),
      COST_CEILINGS_V1,
      `${path}.cost`,
      issues,
    ),
  };
  if (
    policy.network === "forbidden" &&
    (policy.privacy !== "local-only" || policy.egressDestinations.length > 0)
  ) {
    issue(
      issues,
      "policy-violation",
      `${path}.privacy`,
      "network-forbidden policy cannot permit egress",
    );
  }
  if (
    policy.network === "project-authorized" &&
    policy.privacy !== "local-only" &&
    policy.egressDestinations.length === 0
  ) {
    issue(
      issues,
      "policy-violation",
      `${path}.egressDestinations`,
      "external egress requires at least one destination",
    );
  }
  if (
    policy.network === "forbidden" &&
    policy.telemetry === "project-authorized"
  ) {
    issue(
      issues,
      "policy-violation",
      `${path}.telemetry`,
      "network-forbidden policy cannot permit remote telemetry",
    );
  }
  return policy;
}

function parseBudget(
  value: unknown,
  path: string,
  issues: RetrievalValidationIssueV3[],
): RetrievalBudgetV3 {
  const record = readRecord(
    value,
    path,
    ["maxSteps", "maxCandidatesPerStep"],
    issues,
  );
  return {
    maxSteps: integer(
      required(record, "maxSteps", path, issues),
      `${path}.maxSteps`,
      issues,
      1,
      32,
    ),
    maxCandidatesPerStep: integer(
      required(record, "maxCandidatesPerStep", path, issues),
      `${path}.maxCandidatesPerStep`,
      issues,
      1,
      1000,
    ),
  };
}

function parseIntents(
  value: unknown,
  path: string,
  issues: RetrievalValidationIssueV3[],
): readonly PactileIntentV1[] {
  const items = readArray(value, path, issues, RETRIEVAL_INTENT_ORDER.length);
  if (items.length === 0) {
    issue(issues, "invalid-value", path, "must contain at least one intent");
  }
  const intents = items.map((item, index) =>
    enumValue(item, PACTILE_INTENTS_V1, `${path}[${index}]`, issues),
  );
  const seen = new Set<PactileIntentV1>();
  for (let index = 0; index < intents.length; index += 1) {
    if (seen.has(intents[index])) {
      issue(issues, "duplicate-value", `${path}[${index}]`, "must be unique");
    }
    seen.add(intents[index]);
  }
  return RETRIEVAL_INTENT_ORDER.filter((intent) => seen.has(intent));
}

function sortIssues(
  issues: readonly RetrievalValidationIssueV3[],
): readonly RetrievalValidationIssueV3[] {
  return [...issues].sort((left, right) => {
    const byPath = utf8Compare(left.path, right.path);
    return byPath !== 0 ? byPath : utf8Compare(left.code, right.code);
  });
}

export function parseRetrievalRequestV3(
  input: unknown,
): RetrievalParseResultV3<RetrievalRequestV3> {
  if (
    !isPlainOwnDataJsonTreeV3(input) ||
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  ) {
    return {
      success: false,
      issues: [
        {
          code: "invalid-type",
          path: "$",
          message: "must be a plain data value",
        },
      ],
    };
  }
  const issues: RetrievalValidationIssueV3[] = [];
  try {
    const record = readRecord(
      input,
      "$",
      [
        "schemaVersion",
        "query",
        "intents",
        "scopeHints",
        "minimumAssurance",
        "requestedPolicy",
        "requiredEvidenceKinds",
        "budget",
      ],
      issues,
    );
    const schemaVersion = required(record, "schemaVersion", "$", issues);
    if (schemaVersion !== RETRIEVAL_ABI_VERSION) {
      issue(issues, "invalid-value", "$.schemaVersion", "must equal 3");
    }
    const query = normalizeText(
      required(record, "query", "$", issues),
      "$.query",
      issues,
      {
        maxBytes: MAX_QUERY_BYTES,
        collapseWhitespace: true,
      },
    );
    const intents = parseIntents(
      required(record, "intents", "$", issues),
      "$.intents",
      issues,
    );
    const scopeHints = normalizeStringSet(
      required(record, "scopeHints", "$", issues),
      "$.scopeHints",
      issues,
      { maxItems: MAX_SCOPE_HINTS, maxBytes: MAX_SCOPE_HINT_BYTES },
    );
    const minimumAssurance = enumValue(
      required(record, "minimumAssurance", "$", issues),
      ASSURANCE_LEVELS_V1,
      "$.minimumAssurance",
      issues,
    );
    const requestedPolicy = parsePolicy(
      required(record, "requestedPolicy", "$", issues),
      "$.requestedPolicy",
      issues,
    );
    const requiredEvidenceKinds = normalizeStringSet(
      required(record, "requiredEvidenceKinds", "$", issues),
      "$.requiredEvidenceKinds",
      issues,
      {
        maxItems: MAX_EVIDENCE_KINDS,
        maxBytes: MAX_LOGICAL_ID_BYTES,
        logicalId: true,
      },
    );
    if (
      minimumAssurance !== "best-effort" &&
      requiredEvidenceKinds.length === 0
    ) {
      issue(
        issues,
        "policy-violation",
        "$.requiredEvidenceKinds",
        "evidence-backed and verified requests require evidence kinds",
      );
    }
    const budget = parseBudget(
      required(record, "budget", "$", issues),
      "$.budget",
      issues,
    );
    if (issues.length > 0)
      return { success: false, issues: sortIssues(issues) };
    return {
      success: true,
      data: {
        schemaVersion: RETRIEVAL_ABI_VERSION,
        query,
        intents,
        scopeHints,
        minimumAssurance,
        requestedPolicy,
        requiredEvidenceKinds,
        budget,
      },
    };
  } catch {
    return {
      success: false,
      issues: [
        {
          code: "invalid-type",
          path: "$",
          message: "must be a plain data value",
        },
      ],
    };
  }
}

const EXACT_SIGNALS = [
  "where is",
  "defined",
  "definition",
  "symbol",
  "path",
  "file",
  "literal",
  "identifier",
  "exact",
  "grep",
  "rg ",
  "在哪里",
  "定义",
  "路径",
  "文件",
  "字面量",
] as const;

const SEMANTIC_SIGNALS = [
  "concept",
  "conceptual",
  "semantic",
  "behavior",
  "behaviour",
  "how does",
  "unknown name",
  "概念",
  "语义",
  "行为",
  "如何工作",
] as const;

const STRUCTURAL_SIGNALS = [
  "caller",
  "callee",
  "call graph",
  "dependency",
  "dependencies",
  "impact",
  "blast radius",
  "structural",
  "architecture",
  "调用者",
  "调用链",
  "依赖",
  "影响面",
  "结构",
  "架构",
] as const;

const EXTERNAL_SIGNALS = [
  "latest",
  "current version",
  "release note",
  "official docs",
  "web",
  "cve",
  "external",
  "remote system",
  "最新",
  "当前版本",
  "发布说明",
  "官方文档",
  "外部",
  "远端系统",
] as const;

function containsAny(query: string, signals: readonly string[]): boolean {
  return signals.some((signal) => query.includes(signal));
}

export function classifyRetrievalIntentsV3(
  query: string,
): readonly PactileIntentV1[] {
  if (typeof query !== "string") {
    throw new RetrievalRequestValidationError([
      {
        code: "invalid-type",
        path: "$.query",
        message: "must be a string",
      },
    ]);
  }
  const normalized = query
    .replace(/\s+/gu, " ")
    .trim()
    .normalize("NFC")
    .toLowerCase();
  const matched = new Set<PactileIntentV1>();
  if (containsAny(normalized, EXACT_SIGNALS)) matched.add("exact");
  if (containsAny(normalized, SEMANTIC_SIGNALS)) matched.add("semantic");
  if (containsAny(normalized, STRUCTURAL_SIGNALS)) matched.add("structural");
  if (containsAny(normalized, EXTERNAL_SIGNALS)) matched.add("external");
  if (matched.size === 0) matched.add("exact");
  return RETRIEVAL_INTENT_ORDER.filter((intent) => matched.has(intent));
}

function clonePolicy(policy: PolicyCeilingV1): PolicyCeilingV1 {
  return {
    ...policy,
    egressDestinations: [...policy.egressDestinations],
  };
}

export function buildRetrievalRequestV3(
  input: BuildRetrievalRequestV3Input,
): RetrievalRequestV3 {
  if (!isPlainOwnDataJsonTreeV3(input)) {
    throw new RetrievalRequestValidationError([
      {
        code: "invalid-type",
        path: "$",
        message: "must be a plain data value",
      },
    ]);
  }
  const buildIssues: RetrievalValidationIssueV3[] = [];
  const record = readRecord(
    input,
    "$",
    [
      "query",
      "intents",
      "scopeHints",
      "minimumAssurance",
      "requestedPolicy",
      "requiredEvidenceKinds",
      "budget",
    ],
    buildIssues,
  );
  if (buildIssues.length > 0 || record === null) {
    throw new RetrievalRequestValidationError(sortIssues(buildIssues));
  }
  const query = required(record, "query", "$", buildIssues);
  if (buildIssues.length > 0 || typeof query !== "string") {
    if (typeof query !== "string") {
      issue(buildIssues, "invalid-type", "$.query", "must be a string");
    }
    throw new RetrievalRequestValidationError(sortIssues(buildIssues));
  }
  const candidate = {
    schemaVersion: RETRIEVAL_ABI_VERSION,
    query,
    intents: record.intents ?? classifyRetrievalIntentsV3(query),
    scopeHints: record.scopeHints ?? [],
    minimumAssurance: record.minimumAssurance ?? "evidence-backed",
    requestedPolicy: clonePolicy(
      (record.requestedPolicy as PolicyCeilingV1 | undefined) ??
        DEFAULT_RETRIEVAL_POLICY_V3,
    ),
    requiredEvidenceKinds: record.requiredEvidenceKinds ?? ["source-reference"],
    budget: {
      ...((record.budget as RetrievalBudgetV3 | undefined) ??
        DEFAULT_RETRIEVAL_BUDGET_V3),
    },
  };
  const parsed = parseRetrievalRequestV3(candidate);
  if (!parsed.success) throw new RetrievalRequestValidationError(parsed.issues);
  return parsed.data;
}

function parsePlanningContext(
  input: unknown,
): RetrievalParseResultV3<readonly RetrievalProviderAvailabilityV3[]> {
  if (
    !isPlainOwnDataJsonTreeV3(input) ||
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  ) {
    return {
      success: false,
      issues: [
        {
          code: "invalid-type",
          path: "$context",
          message: "must be a plain data value",
        },
      ],
    };
  }
  const issues: RetrievalValidationIssueV3[] = [];
  try {
    const context = readRecord(
      input,
      "$context",
      ["providerAvailability"],
      issues,
    );
    const raw =
      context &&
      Object.prototype.hasOwnProperty.call(context, "providerAvailability")
        ? context.providerAvailability
        : [];
    const entries = readArray(raw, "$context.providerAvailability", issues, 3);
    const result: RetrievalProviderAvailabilityV3[] = [];
    const seen = new Set<PactileIntentV1>();
    for (let index = 0; index < entries.length; index += 1) {
      const path = `$context.providerAvailability[${index}]`;
      const record = readRecord(
        entries[index],
        path,
        ["intent", "status", "readiness"],
        issues,
      );
      const intent = enumValue(
        required(record, "intent", path, issues),
        ["semantic", "structural", "external"] as const,
        `${path}.intent`,
        issues,
      );
      const status = enumValue(
        required(record, "status", path, issues),
        RETRIEVAL_PROVIDER_STATUSES_V3.filter(
          (
            value,
          ): value is Exclude<
            RetrievalProviderStatusV3,
            "resolution-required"
          > => value !== "resolution-required",
        ),
        `${path}.status`,
        issues,
      );
      const readinessRaw = record?.readiness;
      const readiness =
        readinessRaw === undefined
          ? undefined
          : enumValue(
              readinessRaw,
              PROVIDER_READINESS_V1,
              `${path}.readiness`,
              issues,
            );
      if (seen.has(intent)) {
        issue(issues, "duplicate-value", `${path}.intent`, "must be unique");
      }
      seen.add(intent);
      if (
        readiness !== undefined &&
        status !== "unsupported" &&
        status !== readiness
      ) {
        issue(
          issues,
          "policy-violation",
          `${path}.readiness`,
          "must agree with the neutral provider status",
        );
      }
      if (
        status === "unsupported" &&
        readiness !== undefined &&
        readiness !== "unavailable"
      ) {
        issue(
          issues,
          "policy-violation",
          `${path}.readiness`,
          "unsupported intent may only report unavailable readiness",
        );
      }
      result.push({ intent, status, ...(readiness ? { readiness } : {}) });
    }
    if (issues.length > 0)
      return { success: false, issues: sortIssues(issues) };
    return {
      success: true,
      data: RETRIEVAL_INTENT_ORDER.flatMap((intent) =>
        intent === "exact"
          ? []
          : result.filter((entry) => entry.intent === intent),
      ),
    };
  } catch {
    return {
      success: false,
      issues: [
        {
          code: "invalid-type",
          path: "$context",
          message: "must be a plain data value",
        },
      ],
    };
  }
}

function stopReasonForStatus(
  intent: Exclude<PactileIntentV1, "exact">,
  status: RetrievalProviderStatusV3,
): RetrievalStopReasonV3 | null {
  switch (status) {
    case "resolution-required":
      return { code: "provider-resolution-required", intent, blocking: true };
    case "degraded":
      return { code: "provider-degraded", intent, blocking: true };
    case "unavailable":
      return { code: "provider-unavailable", intent, blocking: true };
    case "unsupported":
      return { code: "provider-unsupported", intent, blocking: true };
    case "ready":
      return null;
  }
}

function buildPlan(
  request: RetrievalRequestV3,
  availability: readonly RetrievalProviderAvailabilityV3[],
): RetrievalPlanV3 {
  const statuses = new Map<
    Exclude<PactileIntentV1, "exact">,
    RetrievalProviderStatusV3
  >();
  for (const entry of availability) statuses.set(entry.intent, entry.status);

  const allSteps = request.intents.map((intent, index) => {
    if (intent === "exact") {
      return {
        order: index + 1,
        intent,
        kind: "local-exact" as const,
        localToolHint: "rg" as const,
        providerRequirement: null,
        outputRole: "candidate" as const,
      };
    }
    const status = statuses.get(intent) ?? "resolution-required";
    return {
      order: index + 1,
      intent,
      kind: "provider-request" as const,
      localToolHint: null,
      providerRequirement: {
        intent,
        minimumAssurance: request.minimumAssurance,
        requestedPolicy: clonePolicy(request.requestedPolicy),
        requiredEvidenceKinds: [...request.requiredEvidenceKinds],
        status,
      },
      outputRole: "candidate" as const,
    };
  });
  const steps = allSteps
    .slice(0, request.budget.maxSteps)
    .map((step, index) => ({
      ...step,
      order: index + 1,
    }));
  const stopReasons: RetrievalStopReasonV3[] = [];
  if (steps.length < allSteps.length) {
    stopReasons.push({
      code: "budget-exhausted",
      intent: null,
      blocking: true,
    });
  }
  for (const step of steps) {
    if (step.providerRequirement) {
      const stop = stopReasonForStatus(
        step.providerRequirement.intent,
        step.providerRequirement.status,
      );
      if (stop) stopReasons.push(stop);
    }
  }
  const planWithoutFingerprint = {
    schemaVersion: RETRIEVAL_ABI_VERSION,
    query: request.query,
    intents: [...request.intents],
    scopeHints: [...request.scopeHints],
    minimumAssurance: request.minimumAssurance,
    requestedPolicy: clonePolicy(request.requestedPolicy),
    requiredEvidenceKinds: [...request.requiredEvidenceKinds],
    budget: { ...request.budget },
    steps,
    verificationChain: [
      {
        order: 1,
        stage: "candidate" as const,
        required: true as const,
        acceptableEvidenceKinds: [],
      },
      {
        order: 2,
        stage: "corroborate" as const,
        required: true as const,
        acceptableEvidenceKinds: [...RETRIEVAL_CORROBORATION_KINDS_V3],
      },
      {
        order: 3,
        stage: "classify-evidence" as const,
        required: true as const,
        acceptableEvidenceKinds: [...RETRIEVAL_CORROBORATION_KINDS_V3],
      },
      {
        order: 4,
        stage: "check-assurance" as const,
        required: true as const,
        acceptableEvidenceKinds: [...RETRIEVAL_CORROBORATION_KINDS_V3],
      },
      {
        order: 5,
        stage: "accept-or-stop" as const,
        required: true as const,
        acceptableEvidenceKinds: [...RETRIEVAL_CORROBORATION_KINDS_V3],
      },
    ],
    stopReasons,
  };
  return {
    ...planWithoutFingerprint,
    fingerprint: fingerprintPactileContractV1(planWithoutFingerprint),
  };
}

export function planRetrievalV3(
  input: unknown,
  context: RetrievalPlanningContextV3 = {},
): RetrievalParseResultV3<RetrievalPlanV3> {
  const request = parseRetrievalRequestV3(input);
  if (!request.success) return request;
  const availability = parsePlanningContext(context);
  if (!availability.success) return availability;
  return { success: true, data: buildPlan(request.data, availability.data) };
}

export function createRetrievalPlanV3(
  request: RetrievalRequestV3,
  context: RetrievalPlanningContextV3 = {},
): RetrievalPlanV3 {
  const planned = planRetrievalV3(request, context);
  if (!planned.success)
    throw new RetrievalRequestValidationError(planned.issues);
  return planned.data;
}
