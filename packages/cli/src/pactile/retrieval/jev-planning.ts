import { type PactileIntentV1 } from "../../core/index.js";
import type { JevCallOptionsV1 } from "../jev/index.js";
import {
  type JevDecisionFacadeV1,
  type JevDecisionResultV1,
} from "../jev/index.js";
import { JEV_ORIGIN_V1 } from "../jev/contracts.js";
import {
  buildRetrievalRequestV3,
  createRetrievalPlanV3,
  type BuildRetrievalRequestV3Input,
} from "./planner.js";
import {
  RETRIEVAL_INTENT_ORDER,
  type RetrievalPlanV3,
  type RetrievalPlanningContextV3,
} from "./types.js";

const MIN_RETRIEVAL_DECISION_CONFIDENCE = 0.75;

function retrievalPolicyAllowsJev(
  request: ReturnType<typeof buildRetrievalRequestV3>,
): boolean {
  const policy = request.requestedPolicy;
  return (
    policy.network === "project-authorized" &&
    policy.credentials === "project-authorized" &&
    policy.privacy === "project-approved-egress" &&
    policy.egressDestinations.includes(JEV_ORIGIN_V1) &&
    ["low", "medium", "high"].includes(policy.cost)
  );
}

const RETRIEVAL_INTENT_QUESTIONS = {
  semantic: {
    type: "choice",
    instructions:
      "Should conceptual, behavioral, or paraphrased retrieval be added alongside exact search?",
    criteria: {
      include: "Include semantic retrieval as an additional candidate route.",
      exclude: "Do not add semantic retrieval.",
    },
  },
  structural: {
    type: "choice",
    instructions:
      "Should call-graph, dependency, or architecture retrieval be added alongside exact search?",
    criteria: {
      include: "Include structural retrieval as an additional candidate route.",
      exclude: "Do not add structural retrieval.",
    },
  },
} as const;

export interface RetrievalJevPlanningOptionsV1 {
  readonly facade: JevDecisionFacadeV1;
  readonly callOptions: JevCallOptionsV1;
}

export interface PlanRetrievalWithJevInputV1 {
  readonly request: BuildRetrievalRequestV3Input;
  readonly context?: RetrievalPlanningContextV3;
  /** Omit to keep the synchronous deterministic V3 plan only. */
  readonly jev?: RetrievalJevPlanningOptionsV1;
}

export interface RetrievalJevPlanResultV1 {
  readonly plan: RetrievalPlanV3;
  readonly source: "deterministic" | "jev-advised";
  readonly decision: JevDecisionResultV1 | null;
}

function answerIncludes(
  decision: JevDecisionResultV1,
  name: "semantic" | "structural",
): boolean {
  if (decision.status !== "answered") return false;
  const answer = decision.answers[name];
  return (
    answer?.type === "choice" &&
    answer.choice === "include" &&
    answer.confidence >= MIN_RETRIEVAL_DECISION_CONFIDENCE
  );
}

/**
 * Optionally asks Jev to supplement an exact-only deterministic retrieval
 * classification. Exact intent and project policy are kept; Jev cannot add
 * external intent, remove local intent, resolve a Provider, or prove evidence.
 */
export async function planRetrievalWithJevV1(
  input: PlanRetrievalWithJevInputV1,
): Promise<RetrievalJevPlanResultV1> {
  const request = buildRetrievalRequestV3(input.request);
  const deterministicPlan = createRetrievalPlanV3(request, input.context);
  if (
    input.jev === undefined ||
    input.request.intents !== undefined ||
    request.intents.length !== 1 ||
    request.intents[0] !== "exact"
  ) {
    return {
      plan: deterministicPlan,
      source: "deterministic",
      decision: null,
    };
  }

  const callOptions = retrievalPolicyAllowsJev(request)
    ? input.jev.callOptions
    : {
        ...input.jev.callOptions,
        egress: {
          ...input.jev.callOptions.egress,
          egressDestinations: [],
        },
      };

  const decision = await input.jev.facade.decide({
    node: "retrieval-planning",
    request: {
      taskSummary: request.query,
      questions: RETRIEVAL_INTENT_QUESTIONS,
    },
    options: {
      ...callOptions,
      minimumDecisionConfidence: Math.max(
        callOptions.minimumDecisionConfidence ??
          MIN_RETRIEVAL_DECISION_CONFIDENCE,
        MIN_RETRIEVAL_DECISION_CONFIDENCE,
      ),
    },
  });
  const intents = new Set<PactileIntentV1>(request.intents);
  if (answerIncludes(decision, "semantic")) intents.add("semantic");
  if (answerIncludes(decision, "structural")) intents.add("structural");
  const augmentedIntents = RETRIEVAL_INTENT_ORDER.filter((intent) =>
    intents.has(intent),
  );
  const plan = augmentedIntents.some(
    (intent) => !request.intents.includes(intent),
  )
    ? createRetrievalPlanV3(
        { ...request, intents: augmentedIntents },
        input.context,
      )
    : deterministicPlan;
  return {
    plan,
    source: plan === deterministicPlan ? "deterministic" : "jev-advised",
    decision,
  };
}
