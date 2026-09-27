import type {
  AssuranceLevelV1,
  PactileIntentV1,
} from "../core/index.js";

import type { CodebaseRetrievalPlanEnvelope } from "./codebase-retrieval-router.js";
import {
  classifyToolCalls,
  observedIntentCount,
  type ClassifiedToolCalls,
} from "./retrieval-tool-classification.js";

export const RETRIEVAL_TELEMETRY_SCHEMA_VERSION = 3 as const;

export interface RetrievalPlanFacts {
  readonly plan_fingerprint: string;
  readonly planned_intents: readonly PactileIntentV1[];
  readonly minimum_assurance: AssuranceLevelV1;
  readonly provider_request_intents: readonly PactileIntentV1[];
  readonly blocking_reason_codes: readonly string[];
}

export interface RetrievalQueryTelemetry extends RetrievalPlanFacts {
  readonly schema_version: typeof RETRIEVAL_TELEMETRY_SCHEMA_VERSION;
  readonly query_id: string;
  readonly observations: ClassifiedToolCalls;
  readonly corroboration_kinds: readonly string[];
  readonly accepted: boolean;
  readonly achieved_assurance: AssuranceLevelV1 | null;
  readonly compliance_score: number;
}

export interface RetrievalTelemetryMetrics {
  readonly total_queries: number;
  readonly accepted_queries: number;
  readonly intent_plan_counts: Readonly<Record<PactileIntentV1, number>>;
  readonly intent_execution_counts: Readonly<Record<PactileIntentV1, number>>;
  readonly corroborated_queries: number;
  readonly average_compliance_score: number;
}

function emptyIntentCounts(): Record<PactileIntentV1, number> {
  return { exact: 0, semantic: 0, structural: 0, external: 0 };
}

export function planFactsFromEnvelope(
  plan: CodebaseRetrievalPlanEnvelope,
): RetrievalPlanFacts {
  return {
    plan_fingerprint: plan.fingerprint,
    planned_intents: [...plan.intents],
    minimum_assurance: plan.minimumAssurance,
    provider_request_intents: plan.steps
      .filter((step) => step.kind === "provider-request")
      .map((step) => step.intent),
    blocking_reason_codes: plan.stopReasons
      .filter((reason) => reason.blocking)
      .map((reason) => reason.code),
  };
}

export function computeComplianceScore(
  plan: CodebaseRetrievalPlanEnvelope,
  observations: ClassifiedToolCalls,
  corroborationKinds: readonly string[],
): number {
  if (plan.intents.length === 0) return 0;
  const executed = plan.intents.filter(
    (intent) => observedIntentCount(observations, intent) > 0,
  ).length;
  const intentScore = executed / plan.intents.length;
  const corroborated = corroborationKinds.some((kind) =>
    ["source-reference", "git-evidence", "repeatable-test"].includes(kind),
  );
  const evidenceScore = corroborated ? 1 : 0;
  return Number((intentScore * 0.7 + evidenceScore * 0.3).toFixed(6));
}

export function createRetrievalTelemetry(input: {
  readonly queryId: string;
  readonly plan: CodebaseRetrievalPlanEnvelope;
  readonly toolsCalled?: readonly string[];
  readonly corroborationKinds?: readonly string[];
  readonly accepted?: boolean;
  readonly achievedAssurance?: AssuranceLevelV1 | null;
}): RetrievalQueryTelemetry {
  const observations = classifyToolCalls(input.toolsCalled ?? []);
  const corroborationKinds = [
    ...new Set(input.corroborationKinds ?? []),
  ].sort();
  return {
    schema_version: RETRIEVAL_TELEMETRY_SCHEMA_VERSION,
    query_id: input.queryId,
    ...planFactsFromEnvelope(input.plan),
    observations,
    corroboration_kinds: corroborationKinds,
    accepted: input.accepted ?? false,
    achieved_assurance: input.achievedAssurance ?? null,
    compliance_score: computeComplianceScore(
      input.plan,
      observations,
      corroborationKinds,
    ),
  };
}

export function applyToolClassification(
  record: Omit<RetrievalQueryTelemetry, "observations" | "compliance_score">,
  plan: CodebaseRetrievalPlanEnvelope,
  toolsCalled: readonly string[],
): RetrievalQueryTelemetry {
  const observations = classifyToolCalls(toolsCalled);
  return {
    ...record,
    observations,
    compliance_score: computeComplianceScore(
      plan,
      observations,
      record.corroboration_kinds,
    ),
  };
}

export function withDerivedComplianceScore(
  record: Omit<RetrievalQueryTelemetry, "compliance_score">,
  plan: CodebaseRetrievalPlanEnvelope,
): RetrievalQueryTelemetry {
  return {
    ...record,
    compliance_score: computeComplianceScore(
      plan,
      record.observations,
      record.corroboration_kinds,
    ),
  };
}

export function deriveRetrievalTelemetryMetrics(
  records: readonly RetrievalQueryTelemetry[],
): RetrievalTelemetryMetrics {
  const planCounts = emptyIntentCounts();
  const executionCounts = emptyIntentCounts();
  let accepted = 0;
  let corroborated = 0;
  let complianceTotal = 0;
  for (const record of records) {
    if (record.accepted) accepted += 1;
    if (
      record.corroboration_kinds.some((kind) =>
        ["source-reference", "git-evidence", "repeatable-test"].includes(kind),
      )
    ) {
      corroborated += 1;
    }
    for (const intent of record.planned_intents) planCounts[intent] += 1;
    for (const intent of [
      "exact",
      "semantic",
      "structural",
      "external",
    ] as const) {
      if (observedIntentCount(record.observations, intent) > 0) {
        executionCounts[intent] += 1;
      }
    }
    complianceTotal += record.compliance_score;
  }
  return {
    total_queries: records.length,
    accepted_queries: accepted,
    intent_plan_counts: planCounts,
    intent_execution_counts: executionCounts,
    corroborated_queries: corroborated,
    average_compliance_score:
      records.length === 0
        ? 0
        : Number((complianceTotal / records.length).toFixed(6)),
  };
}

export function migrateTelemetryRecord(
  record: Partial<RetrievalQueryTelemetry>,
  plan: CodebaseRetrievalPlanEnvelope,
): RetrievalQueryTelemetry {
  return createRetrievalTelemetry({
    queryId:
      typeof record.query_id === "string" ? record.query_id : "unknown-query",
    plan,
    corroborationKinds: Array.isArray(record.corroboration_kinds)
      ? record.corroboration_kinds.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    accepted: record.accepted === true,
    achievedAssurance: record.achieved_assurance ?? null,
  });
}

export const RETRIEVAL_TELEMETRY_EXAMPLES = Object.freeze({
  exact: {
    planned_intents: ["exact"],
    corroboration_kinds: ["source-reference"],
  },
  multiIntent: {
    planned_intents: ["semantic", "structural"],
    corroboration_kinds: ["source-reference", "repeatable-test"],
  },
});
