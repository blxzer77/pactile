import {
  projectTaskKernelLifecycle,
  readTaskKernel,
  type KernelPhase,
} from "../../core/task/index.js";
import type { PactileIntentV1, PolicyCeilingV1 } from "../../core/index.js";
import {
  createJevDecisionFacadeV1,
  type JevEgressAuthorizationV1,
} from "../jev/index.js";
import { JEV_ORIGIN_V1 } from "../jev/contracts.js";
import { resolveJevProjectEgressPolicyV1 } from "../jev/project-policy.js";
import { planRetrievalWithJevV1 } from "../retrieval/index.js";
import { RETRIEVAL_INTENT_ORDER } from "../retrieval/types.js";
import { resolveSelectedTask, resolveTaskDir } from "./session.js";

const SESSION_RETRIEVAL_JEV_DEADLINE_MS = 2_500;
const SESSION_RETRIEVAL_JEV_MAX_RETRIES = 1;
const MAX_SESSION_TASK_SUMMARY_BYTES = 8 * 1024;
const MAX_SESSION_TASK_SUMMARY_CHARS = 1_800;
const FALLBACK_EXPLANATION =
  "Jev retrieval advice was unavailable; the deterministic retrieval plan was kept.";
const SESSION_RETRIEVAL_JEV_POLICY: PolicyCeilingV1 = {
  filesystem: "read",
  process: "none",
  network: "project-authorized",
  credentials: "project-authorized",
  privacy: "project-approved-egress",
  egressDestinations: [JEV_ORIGIN_V1],
  telemetry: "local-only",
  cost: "low",
};

interface SessionStampV1 {
  readonly taskPath: string;
  readonly contextKey: string | null;
  readonly taskId: string;
  readonly revision: number;
  readonly phase: KernelPhase;
}

interface CurrentV2SessionV1 {
  readonly stamp: SessionStampV1;
  readonly summary: string;
}

export interface SessionRetrievalIntentOptionsV1 {
  /** A caller-specified intent set is passed through without Jev advice. */
  readonly intents?: readonly PactileIntentV1[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedSummary(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  let result = "";
  for (const character of normalized) {
    if (
      result.length + character.length > MAX_SESSION_TASK_SUMMARY_CHARS ||
      Buffer.byteLength(result, "utf8") + Buffer.byteLength(character, "utf8") >
        MAX_SESSION_TASK_SUMMARY_BYTES
    )
      break;
    result += character;
  }
  return result || "Selected V2 Task";
}

function readCurrentV2Session(root: string): CurrentV2SessionV1 | null {
  const selected = resolveSelectedTask(root);
  if (!selected.taskPath || selected.stale) return null;
  const taskDir = resolveTaskDir(root, selected.taskPath);
  const read = readTaskKernel({ root, taskDir, cwd: root });
  if (read.kind !== "task-kernel-v2") return null;
  const lifecycle = projectTaskKernelLifecycle(read.kernel);
  return {
    stamp: {
      taskPath: selected.taskPath,
      contextKey: selected.contextKey,
      taskId: lifecycle.taskId,
      revision: lifecycle.revision,
      phase: lifecycle.phase,
    },
    summary: boundedSummary(
      read.kernel.definition.title + "\n" + read.kernel.definition.deliverable,
    ),
  };
}

function sameStamp(
  left: SessionStampV1 | null,
  right: SessionStampV1 | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.taskPath === right.taskPath &&
    left.contextKey === right.contextKey &&
    left.taskId === right.taskId &&
    left.revision === right.revision &&
    left.phase === right.phase
  );
}

function packedStamp(pack: Record<string, unknown>): SessionStampV1 | null {
  const kernel = record(pack.kernel);
  if (
    kernel?.schemaVersion !== 2 ||
    kernel.selected !== true ||
    typeof kernel.taskId !== "string" ||
    typeof kernel.phase !== "string" ||
    typeof kernel.revision !== "number" ||
    !Number.isSafeInteger(kernel.revision) ||
    kernel.revision < 0
  )
    return null;
  return {
    taskPath: "",
    contextKey: null,
    taskId: kernel.taskId,
    revision: kernel.revision,
    phase: kernel.phase as KernelPhase,
  };
}

function packHasFactGap(pack: Record<string, unknown>): boolean {
  return (
    Array.isArray(pack.layers) &&
    pack.layers.some((value) => {
      const layer = record(value);
      return layer?.n === 4 && layer.present === true;
    })
  );
}

function attachPlanningReceipt(
  pack: Record<string, unknown>,
  input: {
    readonly source: "deterministic" | "jev-advised";
    readonly intents: readonly PactileIntentV1[];
    readonly fallbackReasonCode?: string;
  },
): Record<string, unknown> {
  const intents = [...input.intents];
  const layers = Array.isArray(pack.layers)
    ? pack.layers.map((value) => {
        const layer = record(value);
        if (layer?.n !== 4 || layer.present !== true) return value;
        return {
          ...layer,
          intents,
          text: [
            "Fact gap: route with intents " + intents.join(" / ") + ".",
            "Keep exact search. Jev may only suggest semantic or structural local routes; it cannot add external intent or authorize a Provider.",
            "Kernel remains authoritative. Do not bind Agent tool names. Ranking and retrieval-pack stay with retrieval-extended.",
          ].join(" "),
        };
      })
    : pack.layers;
  const fallback = input.fallbackReasonCode
    ? {
        reasonCode: input.fallbackReasonCode,
        explanation: FALLBACK_EXPLANATION,
      }
    : null;
  return {
    ...pack,
    retrievalPlanning: {
      schemaVersion: 1,
      source: input.source,
      intents,
      fallback,
    },
    ...(Array.isArray(layers) ? { layers } : {}),
  };
}

function jevEgressAuthorization(): JevEgressAuthorizationV1 {
  return {
    network: "project-authorized",
    privacy: "project-approved-egress",
    credentials: "project-authorized",
    destination: JEV_ORIGIN_V1,
    egressDestinations: [JEV_ORIGIN_V1],
    contentDecision: "task-summary-approved",
  };
}

function createSessionRetrievalFacade(): ReturnType<
  typeof createJevDecisionFacadeV1
> {
  const enabledValue = process.env.PACTILE_JEV_ENABLED?.trim().toLowerCase();
  return createJevDecisionFacadeV1({
    ...(enabledValue === "false" ? { enabled: false } : {}),
    maxDecisions: 1,
    maxDeadlineMs: SESSION_RETRIEVAL_JEV_DEADLINE_MS,
    transport: {
      apiKey: process.env.PACTILE_JEV_API_KEY,
      deadlineMs: SESSION_RETRIEVAL_JEV_DEADLINE_MS,
      maxRetries: SESSION_RETRIEVAL_JEV_MAX_RETRIES,
    },
  });
}

function suggestedLocalIntents(
  intents: readonly PactileIntentV1[],
): PactileIntentV1[] {
  const selected = new Set<PactileIntentV1>(["exact"]);
  for (const intent of intents)
    if (intent === "semantic" || intent === "structural") selected.add(intent);
  return RETRIEVAL_INTENT_ORDER.filter((intent) => selected.has(intent));
}

/** Add optional local-route suggestions to a V2 Session fact-gap plan. */
export async function compileSessionRetrievalPlanWithJevV1(
  root: string,
  pack: Record<string, unknown>,
  options: SessionRetrievalIntentOptionsV1 = {},
): Promise<Record<string, unknown>> {
  if (!packHasFactGap(pack)) return pack;
  const expected = packedStamp(pack);
  if (!expected) return pack;

  let initial: CurrentV2SessionV1 | null = null;
  try {
    initial = readCurrentV2Session(root);
  } catch {
    initial = null;
  }
  const matchedSession =
    initial !== null &&
    initial.stamp.taskId === expected.taskId &&
    initial.stamp.revision === expected.revision &&
    initial.stamp.phase === expected.phase
      ? initial
      : null;
  const summary = matchedSession?.summary ?? boundedSummary(expected.taskId);
  const request = {
    query: summary,
    ...(options.intents === undefined ? {} : { intents: [...options.intents] }),
  };
  const defaultToExactForUnspecifiedIntents = options.intents === undefined;
  const fallbackInput = {
    request,
    defaultToExactForUnspecifiedIntents,
  };

  const deterministic = async (
    fallbackReasonCode?: string,
  ): Promise<Record<string, unknown>> => {
    try {
      const result = await planRetrievalWithJevV1(fallbackInput);
      return attachPlanningReceipt(pack, {
        source: "deterministic",
        intents: result.plan.intents,
        ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
      });
    } catch {
      return attachPlanningReceipt(pack, {
        source: "deterministic",
        intents: options.intents ?? ["exact"],
        fallbackReasonCode: fallbackReasonCode ?? "planner-unavailable",
      });
    }
  };

  if (!matchedSession) return deterministic("session-changed");
  if (options.intents !== undefined) return deterministic();

  const projectEgress = resolveJevProjectEgressPolicyV1(root);
  if (!projectEgress.allowed) return deterministic(projectEgress.reasonCode);
  if (process.env.PACTILE_JEV_ENABLED?.trim().toLowerCase() === "false")
    return deterministic("disabled");
  const apiKey = process.env.PACTILE_JEV_API_KEY;
  if (typeof apiKey !== "string" || apiKey.length === 0)
    return deterministic("configuration-missing");

  try {
    const advised = await planRetrievalWithJevV1({
      request: {
        ...request,
        // This ceiling authorizes only the bounded Jev advice call below.
        // The receipt exposes intents only; Kernel still controls retrieval.
        requestedPolicy: SESSION_RETRIEVAL_JEV_POLICY,
      },
      defaultToExactForUnspecifiedIntents: true,
      jev: {
        facade: createSessionRetrievalFacade(),
        callOptions: { egress: jevEgressAuthorization() },
      },
    });
    let current: CurrentV2SessionV1 | null = null;
    try {
      current = readCurrentV2Session(root);
    } catch {
      current = null;
    }
    if (!sameStamp(matchedSession.stamp, current?.stamp ?? null))
      return deterministic("session-changed");

    const intents = suggestedLocalIntents(advised.plan.intents);
    return attachPlanningReceipt(pack, {
      source:
        advised.source === "jev-advised" && intents.length > 1
          ? "jev-advised"
          : "deterministic",
      intents,
      ...(advised.decision?.status === "fallback"
        ? { fallbackReasonCode: advised.decision.fallback.reasonCode }
        : {}),
    });
  } catch {
    return deterministic("advisor-error");
  }
}
