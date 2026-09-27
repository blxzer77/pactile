/**
 * Compatibility entrypoint for the host-neutral Pactile retrieval planner.
 *
 * The V3 plan describes intent, assurance, policy, evidence, and stop
 * requirements. It never chooses a concrete Provider or host capability.
 */

import type {
  AssuranceLevelV1,
  PactileIntentV1,
  PolicyCeilingV1,
} from "../core/index.js";

import {
  RETRIEVAL_ABI_VERSION,
  buildRetrievalRequestV3,
  createRetrievalPlanV3,
  RetrievalRequestValidationError,
  type RetrievalBudgetV3,
  type RetrievalPlanV3,
  type RetrievalProviderAvailabilityV3,
} from "../pactile/retrieval/index.js";
import { snapshotPlainOwnDataRecordV3 } from "../pactile/retrieval/boundary.js";

export const CODEBASE_RETRIEVAL_ROUTER_VERSION = RETRIEVAL_ABI_VERSION;

export type CodebaseRetrievalIntentId = PactileIntentV1;
export type CodebaseRetrievalPlanEnvelope = RetrievalPlanV3;

export interface RouteCodebaseRetrievalInput {
  readonly query: string;
  readonly intents?: readonly PactileIntentV1[];
  readonly scopeHints?: readonly string[];
  readonly minimumAssurance?: AssuranceLevelV1;
  readonly requestedPolicy?: PolicyCeilingV1;
  readonly requiredEvidenceKinds?: readonly string[];
  readonly budget?: RetrievalBudgetV3;
  readonly providerAvailability?: readonly RetrievalProviderAvailabilityV3[];
  /** Compatibility metadata is accepted but deliberately excluded from V3. */
  readonly platformLabel?: string;
  readonly projectFileCount?: number | null;
  readonly codebaseRetrievalSelected?: boolean;
}

export function emptyCodebaseRetrievalPlan(
  query = "retrieval",
): CodebaseRetrievalPlanEnvelope {
  return routeCodebaseRetrieval({
    query,
    intents: ["exact"],
    minimumAssurance: "best-effort",
    requiredEvidenceKinds: [],
  });
}

/** Build a deterministic, Provider-neutral V3 plan. */
export function routeCodebaseRetrieval(
  input: RouteCodebaseRetrievalInput | string,
): CodebaseRetrievalPlanEnvelope {
  const normalized =
    typeof input === "string"
      ? (Object.assign(Object.create(null) as Record<string, unknown>, {
          query: input,
        }) as Readonly<Record<string, unknown>>)
      : snapshotPlainOwnDataRecordV3(input);
  if (normalized === null) {
    throw new RetrievalRequestValidationError([
      {
        code: "invalid-type",
        path: "$",
        message: "must be a plain data value",
      },
    ]);
  }
  const allowed = new Set([
    "query",
    "intents",
    "scopeHints",
    "minimumAssurance",
    "requestedPolicy",
    "requiredEvidenceKinds",
    "budget",
    "providerAvailability",
    "platformLabel",
    "projectFileCount",
    "codebaseRetrievalSelected",
  ]);
  if (Object.keys(normalized).some((key) => !allowed.has(key))) {
    throw new RetrievalRequestValidationError([
      {
        code: "unknown-field",
        path: "$",
        message: "contains an unknown field",
      },
    ]);
  }
  const request = buildRetrievalRequestV3({
    query: normalized.query as string,
    ...(normalized.intents === undefined
      ? {}
      : { intents: normalized.intents as readonly PactileIntentV1[] }),
    ...(normalized.scopeHints === undefined
      ? {}
      : { scopeHints: normalized.scopeHints as readonly string[] }),
    ...(normalized.minimumAssurance === undefined
      ? {}
      : {
          minimumAssurance: normalized.minimumAssurance as AssuranceLevelV1,
        }),
    ...(normalized.requestedPolicy === undefined
      ? {}
      : { requestedPolicy: normalized.requestedPolicy as PolicyCeilingV1 }),
    ...(normalized.requiredEvidenceKinds === undefined
      ? {}
      : {
          requiredEvidenceKinds:
            normalized.requiredEvidenceKinds as readonly string[],
        }),
    ...(normalized.budget === undefined
      ? {}
      : { budget: normalized.budget as RetrievalBudgetV3 }),
  });
  return createRetrievalPlanV3(
    request,
    normalized.providerAvailability === undefined
      ? {}
      : {
          providerAvailability:
            normalized.providerAvailability as readonly RetrievalProviderAvailabilityV3[],
        },
  );
}

export {
  DEFAULT_RETRIEVAL_BUDGET_V3,
  DEFAULT_RETRIEVAL_POLICY_V3,
  RETRIEVAL_ABI_VERSION,
  assessRetrievalClaimV3,
  buildRetrievalRequestV3,
  classifyRetrievalIntentsV3,
  createRetrievalPlanV3,
  parseRetrievalRequestV3,
  planRetrievalV3,
} from "../pactile/retrieval/index.js";

export type {
  RetrievalClaimAssessmentInputV3,
  RetrievalClaimAssessmentV3,
  RetrievalPlanV3,
  RetrievalProviderAvailabilityV3,
  RetrievalRequestV3,
} from "../pactile/retrieval/index.js";
