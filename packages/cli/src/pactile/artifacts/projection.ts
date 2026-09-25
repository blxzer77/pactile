import { TASK_ARTIFACT_STAGES_V1 } from "./types.js";
import type {
  TaskArtifactCandidateFreshnessV1,
  TaskArtifactEnvelopeV1,
  TaskArtifactFactV1,
  TaskArtifactStageV1,
} from "./types.js";

const STAGE_TITLES: Readonly<Record<TaskArtifactStageV1, string>> = {
  prd: "PRD",
  design: "Design",
  implement: "Implement",
  review: "Review",
  verify: "Verify",
};

export interface TaskArtifactProjectionOptionsV1 {
  /** Restrict the index to these stages. Omitted stages are not emitted. */
  readonly stages?: readonly TaskArtifactStageV1[];
}

interface TaskArtifactAgentFactBaseV1 {
  readonly id: string;
  readonly kind: TaskArtifactFactV1["kind"];
  readonly status: TaskArtifactFactV1["status"];
  readonly title: string;
  readonly summary: string;
  readonly source: TaskArtifactFactV1["source"];
  readonly provenance: TaskArtifactFactV1["provenance"];
  readonly ref: TaskArtifactFactV1["ref"];
}

export type TaskArtifactAgentFactV1 =
  | (TaskArtifactAgentFactBaseV1 & {
      readonly kind: Exclude<TaskArtifactFactV1["kind"], "candidate">;
      readonly candidateFreshness?: never;
    })
  | (TaskArtifactAgentFactBaseV1 & {
      readonly kind: "candidate";
      readonly candidateFreshness: TaskArtifactCandidateFreshnessV1;
    });

export interface TaskArtifactAgentStageV1 {
  readonly stage: TaskArtifactStageV1;
  /** References only; the fact itself appears once in `facts`. */
  readonly factIds: readonly string[];
}

export interface TaskArtifactAgentProjectionV1 {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly stages: readonly TaskArtifactAgentStageV1[];
  /** Compact index. Follow `ref` only when a fact needs fuller context. */
  readonly facts: readonly TaskArtifactAgentFactV1[];
}

function selectedStages(
  envelope: TaskArtifactEnvelopeV1,
  requestedStages?: readonly TaskArtifactStageV1[],
): TaskArtifactStageV1[] {
  const requested = requestedStages ? new Set(requestedStages) : undefined;
  return TASK_ARTIFACT_STAGES_V1.filter(
    (stage) =>
      (requested === undefined || requested.has(stage)) &&
      (envelope.stageRefs[stage]?.length ?? 0) > 0,
  );
}

function factsForStages(
  envelope: TaskArtifactEnvelopeV1,
  stages: readonly TaskArtifactStageV1[],
): TaskArtifactFactV1[] {
  const selectedIds = new Set(
    stages.flatMap((stage) => envelope.stageRefs[stage] ?? []),
  );
  return envelope.facts.filter((fact) => selectedIds.has(fact.id));
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ");
}

function code(value: string): string {
  let longestRun = 0;
  for (const match of value.matchAll(/`+/gu)) {
    longestRun = Math.max(longestRun, match[0].length);
  }
  const delimiter = "`".repeat(longestRun + 1);
  return `${delimiter}${value}${delimiter}`;
}

function markdownText(value: string): string {
  const escaped = new Set(["\\", "`", "*", "_", "[", "]", "<", ">", "!", "|"]);
  return [...value]
    .map((char) => (escaped.has(char) ? `\\${char}` : char))
    .join("");
}

function freshnessText(value: TaskArtifactCandidateFreshnessV1): string {
  return value.freshness === "unknown"
    ? "unknown"
    : `${value.freshness} at ${value.checkedAt} (${value.evidenceRef})`;
}

/** Human-readable Markdown derived from the same canonical envelope. */
export function projectTaskArtifactsForHumanV1(
  envelope: TaskArtifactEnvelopeV1,
  options: TaskArtifactProjectionOptionsV1 = {},
): string {
  const stages = selectedStages(envelope, options.stages);
  if (stages.length === 0) {
    throw new Error(
      "no task artifact facts are mapped to the requested stages",
    );
  }
  const facts = factsForStages(envelope, stages);
  const lines = [`# Task ${code(envelope.taskId)}`, ""];
  for (const stage of stages) {
    lines.push(`## ${STAGE_TITLES[stage]}`);
    for (const id of envelope.stageRefs[stage] ?? []) {
      lines.push(`- ${code(id)}`);
    }
    lines.push("");
  }
  lines.push("## Facts", "");
  for (const fact of facts) {
    lines.push(`### ${code(fact.id)} — ${markdownText(oneLine(fact.title))}`);
    lines.push(`- Kind: ${fact.kind}`);
    lines.push(`- Status: ${fact.status}`);
    lines.push(`- Summary: ${markdownText(oneLine(fact.summary))}`);
    lines.push(`- Source: ${fact.source.kind} ${code(fact.source.ref)}`);
    lines.push(
      `- Provenance: ${fact.provenance.method} by ${markdownText(oneLine(fact.provenance.actor))} at ${fact.provenance.recordedAt}`,
    );
    if (fact.provenance.basedOn?.length) {
      lines.push(`- Based on: ${fact.provenance.basedOn.map(code).join(", ")}`);
    }
    lines.push(`- Ref: ${code(`${fact.ref.path}#${fact.ref.selector}`)}`);
    if (fact.kind === "candidate") {
      lines.push(
        `- Candidate freshness: ${freshnessText(fact.candidateFreshness)}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Agent-facing compact index. Each fact is included once even when multiple
 * stages refer to it; fuller source text remains behind its stable locator.
 */
export function projectTaskArtifactsForAgentV1(
  envelope: TaskArtifactEnvelopeV1,
  options: TaskArtifactProjectionOptionsV1 = {},
): TaskArtifactAgentProjectionV1 {
  const stages = selectedStages(envelope, options.stages).map((stage) => ({
    stage,
    factIds: [...(envelope.stageRefs[stage] ?? [])],
  }));
  if (stages.length === 0) {
    throw new Error(
      "no task artifact facts are mapped to the requested stages",
    );
  }
  const facts = factsForStages(
    envelope,
    stages.map(({ stage }) => stage),
  ).map((fact): TaskArtifactAgentFactV1 => {
    const shared = {
      id: fact.id,
      status: fact.status,
      title: fact.title,
      summary: fact.summary,
      source: fact.source,
      provenance: fact.provenance,
      ref: fact.ref,
    };
    return fact.kind === "candidate"
      ? {
          ...shared,
          kind: "candidate",
          candidateFreshness: fact.candidateFreshness,
        }
      : { ...shared, kind: fact.kind };
  });
  return {
    schemaVersion: 1,
    taskId: envelope.taskId,
    stages,
    facts,
  };
}
