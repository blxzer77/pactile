import { createHash } from "node:crypto";

import type { TaskKernelSnapshotV2 } from "../../core/task/index.js";
import { taskArtifactEnvelopeV1Schema } from "./schema.js";
import type {
  TaskArtifactEnvelopeV1,
  TaskArtifactFactV1,
  TaskArtifactStageV1,
} from "./types.js";

export interface TaskArtifactSourceDetailV1 {
  readonly factId: string;
  readonly source: TaskArtifactFactV1["source"];
  readonly ref: TaskArtifactFactV1["ref"];
  /** The canonical Task Kernel value selected by the fact's JSON pointer. */
  readonly value: unknown;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function sourceTaskSegment(taskId: string): string {
  const sensitiveTerms = new Set([
    "credential",
    "credentials",
    "passwd",
    "password",
    "secret",
    "token",
  ]);
  const parts = taskId.split(/[._-]/u);
  return parts.some((part) => sensitiveTerms.has(part))
    ? `task-${digest(taskId)}`
    : taskId;
}

function artifactRef(taskId: string, ...segments: string[]): string {
  return `artifact://tasks/${sourceTaskSegment(taskId)}/kernel/${segments.join("/")}`;
}

function oneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/[\s\r\n]+/gu, " ").trim() || "(empty)";
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}…`;
}

function timestamp(value: string, path: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    ) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`Task Kernel ${path} is not an RFC 3339 timestamp`);
  }
  return value;
}

function pointerEscape(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function factId(prefix: string, identity: string, label?: string): string {
  const readable = label
    ? `${
        label
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, "-")
          .replace(/^-|-$/gu, "")
          .slice(0, 32) || "item"
      }-`
    : "";
  return `${prefix}:${readable}${digest(identity)}`;
}

function eventFor(
  kernel: TaskKernelSnapshotV2,
  entityId: string,
  types?: readonly string[],
): TaskKernelSnapshotV2["events"][number] | undefined {
  return [...kernel.events]
    .reverse()
    .find(
      (event) =>
        event.entityId === entityId &&
        (types === undefined || types.includes(event.type)),
    );
}

function parseEnvelope(value: TaskArtifactEnvelopeV1): TaskArtifactEnvelopeV1 {
  const parsed = taskArtifactEnvelopeV1Schema.parse(value);
  if (!parsed.success) {
    const issues = parsed.issues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("; ");
    throw new Error(`Task artifact projection is invalid: ${issues}`);
  }
  return parsed.data;
}

/**
 * Derive the shared PRD/Design/Implement/Review/Verify fact envelope from the
 * current Task Kernel. The Kernel remains the only persisted lifecycle source;
 * this adapter never writes an artifacts file.
 */
export function projectTaskKernelArtifactsV1(
  kernel: TaskKernelSnapshotV2,
): TaskArtifactEnvelopeV1 {
  const taskId = kernel.identity.taskId;
  const definitionEvent = eventFor(kernel, taskId, ["task.created"]);
  const createdAt = timestamp(
    definitionEvent?.at ?? kernel.definition.createdAt,
    "definition.createdAt",
  );
  const createdBy = definitionEvent?.actor ?? kernel.definition.createdBy;
  const facts: TaskArtifactFactV1[] = [];
  const stages: Partial<Record<TaskArtifactStageV1, string[]>> = {};
  const factById = new Map<string, TaskArtifactFactV1>();

  const add = (
    fact: TaskArtifactFactV1,
    ...factStages: TaskArtifactStageV1[]
  ): void => {
    const previous = factById.get(fact.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(fact)) {
      throw new Error(`Task artifact fact ID changed meaning: ${fact.id}`);
    }
    if (!previous) {
      factById.set(fact.id, fact);
      facts.push(fact);
    }
    for (const stage of factStages) {
      const ids = (stages[stage] ??= []);
      if (!ids.includes(fact.id)) ids.push(fact.id);
    }
  };

  const taskFactId = "context:task";
  const taskSummary = [
    kernel.definition.title,
    kernel.definition.deliverable,
    kernel.definition.description,
  ]
    .filter(Boolean)
    .join(" — ");
  const taskProvenance = kernel.closure
    ? {
        recordedAt: timestamp(kernel.closure.closedAt, "closure.closedAt"),
        actor: oneLine(kernel.closure.closedBy, 120),
        method: "verified" as const,
        basedOn: [
          ...kernel.definition.acceptanceCriteria.map((criterion) =>
            factId("requirement", criterion.id, criterion.id),
          ),
          "evidence:closure-acceptance",
          "evidence:delivery",
        ],
      }
    : {
        recordedAt: createdAt,
        actor: oneLine(createdBy, 120),
        method: "imported" as const,
      };
  add(
    {
      id: taskFactId,
      kind: "context",
      status:
        kernel.phase === "close"
          ? "accepted"
          : kernel.condition === "blocked"
            ? "blocked"
            : "active",
      title: oneLine(kernel.definition.title, 120),
      summary: oneLine(taskSummary, 280),
      source: { kind: "artifact", ref: artifactRef(taskId, "definition") },
      provenance: taskProvenance,
      ref: { path: "kernel.json", selector: "/definition" },
    },
    "prd",
  );

  const latestReviews = new Map<
    string,
    TaskKernelSnapshotV2["reviews"][number]
  >();
  for (const review of kernel.reviews)
    latestReviews.set(review.candidateSnapshotId, review);

  for (const [
    index,
    criterion,
  ] of kernel.definition.acceptanceCriteria.entries()) {
    const id = factId("requirement", criterion.id, criterion.id);
    const closureEvidenceId = kernel.closure
      ? "evidence:closure-acceptance"
      : undefined;
    const latestReview = kernel.closure
      ? kernel.reviews.find((review) => review.id === kernel.closure?.reviewId)
      : kernel.reviews.at(-1);
    const reviewEvidenceIds = latestReview
      ? (latestReview.acceptanceEvidence[criterion.id] ?? []).map((reference) =>
          factId(
            "evidence",
            `${latestReview.id}\u0000${criterion.id}\u0000${reference}`,
          ),
        )
      : [];
    const recordedReview = latestReview?.acceptanceEvidence[criterion.id]
      ?.length
      ? latestReview
      : undefined;
    const status: TaskArtifactFactV1["status"] = kernel.closure
      ? "verified"
      : recordedReview?.decision === "pass"
        ? "accepted"
        : recordedReview?.decision === "fail"
          ? "rejected"
          : recordedReview?.decision === "needs-changes"
            ? "blocked"
            : "active";
    const provenance = kernel.closure
      ? {
          recordedAt: timestamp(kernel.closure.closedAt, "closure.closedAt"),
          actor: oneLine(kernel.closure.closedBy, 120),
          method: "verified" as const,
          basedOn: [
            factId("review", kernel.closure.reviewId),
            ...reviewEvidenceIds,
            ...(closureEvidenceId ? [closureEvidenceId] : []),
          ],
        }
      : recordedReview
        ? {
            recordedAt: timestamp(
              recordedReview.reviewedAt,
              "review.reviewedAt",
            ),
            actor: oneLine(recordedReview.reviewer, 120),
            method:
              recordedReview.decision === "pass"
                ? ("verified" as const)
                : ("derived" as const),
            basedOn: [
              factId("review", recordedReview.id),
              ...reviewEvidenceIds,
            ],
          }
        : {
            recordedAt: createdAt,
            actor: oneLine(createdBy, 120),
            method: "imported" as const,
          };
    add(
      {
        id,
        kind: "requirement",
        status,
        title: oneLine(`Acceptance ${criterion.id}`, 120),
        summary: oneLine(criterion.description, 280),
        source: {
          kind: "artifact",
          ref: artifactRef(
            taskId,
            "definition",
            "acceptance-criteria",
            `criterion-${digest(criterion.id)}`,
          ),
        },
        provenance,
        ref: {
          path: "kernel.json",
          selector: `/definition/acceptanceCriteria/${index}`,
        },
      },
      "prd",
      ...(recordedReview || kernel.closure ? ["verify" as const] : []),
    );
  }

  for (const [index, dependency] of kernel.definition.dependencies.entries()) {
    const event = eventFor(kernel, dependency, ["task.dependency-added"]);
    add(
      {
        id: factId("constraint", dependency, dependency),
        kind: "constraint",
        status: kernel.closure ? "accepted" : "active",
        title: "Hard dependency",
        summary: oneLine(`Task depends on ${dependency}.`, 280),
        source: {
          kind: "artifact",
          ref: artifactRef(
            taskId,
            "definition",
            "dependencies",
            `dependency-${digest(dependency)}`,
          ),
        },
        provenance: {
          recordedAt: timestamp(event?.at ?? createdAt, "dependency event.at"),
          actor: oneLine(event?.actor ?? createdBy, 120),
          method: "imported",
        },
        ref: {
          path: "kernel.json",
          selector: `/definition/dependencies/${index}`,
        },
      },
      "prd",
    );
  }

  const runFactIds = new Map<string, string>();
  const candidateFacts = new Map<string, string>();
  for (const [index, run] of kernel.runs.entries()) {
    const runId = factId("implement", `run\u0000${run.id}`);
    runFactIds.set(run.id, runId);
    const event = eventFor(kernel, run.id);
    const runRecordedAt = timestamp(event?.at ?? run.startedAt, "run event.at");
    const runActor = oneLine(event?.actor ?? run.startedBy, 120);
    const runStatus: TaskArtifactFactV1["status"] =
      run.state === "failed"
        ? "rejected"
        : run.state === "blocked"
          ? "blocked"
          : run.state === "completed"
            ? "accepted"
            : "active";
    const runSummary = run.result?.summary
      ? `Completed: ${run.result.summary}`
      : run.failure
        ? `Run ${run.state}: ${run.failure.category}`
        : `Run ${run.state}; input captured.`;
    add(
      {
        id: runId,
        kind: run.failure ? "finding" : "context",
        status: runStatus,
        title: oneLine(`Run ${run.attempt}`, 120),
        summary: oneLine(runSummary, 280),
        source: { kind: "artifact", ref: artifactRef(taskId, "runs", run.id) },
        provenance: {
          recordedAt: runRecordedAt,
          actor: runActor,
          method: "imported",
        },
        ref: { path: "kernel.json", selector: `/runs/${index}` },
      },
      "implement",
    );

    for (const [evidenceIndex] of (run.result?.evidenceRefs ?? []).entries()) {
      const evidenceRef = run.result?.evidenceRefs[evidenceIndex];
      if (!evidenceRef) continue;
      const evidenceId = factId(
        "evidence",
        `run\u0000${run.id}\u0000${evidenceRef}`,
      );
      add(
        {
          id: evidenceId,
          kind: "evidence",
          status: run.state === "completed" ? "accepted" : "active",
          title: "Run evidence",
          summary: `Evidence reference recorded by Run ${run.attempt}.`,
          source: {
            kind: "artifact",
            ref: artifactRef(
              taskId,
              "runs",
              run.id,
              "result-evidence",
              digest(evidenceRef),
            ),
          },
          provenance: {
            recordedAt: runRecordedAt,
            actor: runActor,
            method: "imported",
          },
          ref: {
            path: "kernel.json",
            selector: `/runs/${index}/result/evidenceRefs/${evidenceIndex}`,
          },
        },
        "implement",
        "verify",
      );
    }

    const snapshot = run.candidateSnapshot;
    if (!snapshot) continue;
    const snapshotFactId = factId("candidate", snapshot.id);
    candidateFacts.set(snapshot.id, snapshotFactId);
    const review = latestReviews.get(snapshot.id);
    const isCurrentClosedCandidate =
      kernel.closure?.candidateSnapshotId === snapshot.id;
    const isOlderThanClosedCandidate =
      kernel.closure !== null && !isCurrentClosedCandidate;
    const observationId = isCurrentClosedCandidate
      ? "evidence:candidate-observation"
      : undefined;
    const basedOn = [runId, ...(observationId ? [observationId] : [])];
    const candidateStatus: TaskArtifactFactV1["status"] =
      isOlderThanClosedCandidate
        ? "superseded"
        : isCurrentClosedCandidate
          ? "accepted"
          : "active";
    const recordedAt = timestamp(
      isCurrentClosedCandidate
        ? (kernel.closure?.closedAt ?? runRecordedAt)
        : runRecordedAt,
      "candidate recordedAt",
    );
    const provenanceActor = oneLine(
      isCurrentClosedCandidate
        ? (kernel.closure?.closedBy ?? runActor)
        : runActor,
      120,
    );
    const candidateFreshness = kernel.closure
      ? {
          freshness: isCurrentClosedCandidate
            ? ("fresh" as const)
            : ("stale" as const),
          checkedAt: timestamp(
            kernel.closure.candidateObservation.observedAt,
            "candidateObservation.observedAt",
          ),
          evidenceRef: artifactRef(taskId, "closure", "candidate-observation"),
        }
      : { freshness: "unknown" as const };
    add(
      {
        id: snapshotFactId,
        kind: "candidate",
        status: candidateStatus,
        title: `Candidate snapshot ${oneLine(snapshot.id, 64)}`,
        summary: `${snapshot.entries.length} candidate reference(s); fingerprint ${snapshot.fingerprint.slice(0, 15)}…`,
        source: {
          kind: "artifact",
          ref: artifactRef(taskId, "runs", run.id, "candidate-snapshot"),
        },
        provenance: {
          recordedAt,
          actor: provenanceActor,
          method: "derived",
          basedOn,
        },
        ref: {
          path: "kernel.json",
          selector: `/runs/${index}/candidateSnapshot`,
        },
        candidateFreshness,
      },
      "implement",
      ...(review ? ["review" as const] : []),
    );
  }

  for (const [index, review] of kernel.reviews.entries()) {
    const id = factId("review", review.id);
    const runId = runFactIds.get(review.runId);
    const candidateId = candidateFacts.get(review.candidateSnapshotId);
    const reviewStatus: TaskArtifactFactV1["status"] =
      review.decision === "pass"
        ? "accepted"
        : review.decision === "fail"
          ? "rejected"
          : "blocked";
    const basedOn = [runId, candidateId].filter(
      (value): value is string => value !== undefined,
    );
    const run = kernel.runs.find((candidate) => candidate.id === review.runId);
    add(
      {
        id,
        kind: "finding",
        status: reviewStatus,
        title: `Independent review of Run ${run?.attempt ?? review.runId}`,
        summary: `Decision: ${review.decision}; ${review.evidenceRefs.length} review evidence reference(s); ${review.unresolvedBlockers.length} unresolved blocker(s).`,
        source: {
          kind: "artifact",
          ref: artifactRef(taskId, "reviews", review.id),
        },
        provenance: {
          recordedAt: timestamp(review.reviewedAt, "review.reviewedAt"),
          actor: oneLine(review.reviewer, 120),
          method: "derived",
          basedOn: basedOn.length ? basedOn : [taskFactId],
        },
        ref: { path: "kernel.json", selector: `/reviews/${index}` },
      },
      "review",
    );

    for (const [evidenceIndex, evidenceRef] of review.evidenceRefs.entries()) {
      const evidenceId = factId(
        "evidence",
        `review-general\u0000${review.id}\u0000${evidenceRef}`,
      );
      add(
        {
          id: evidenceId,
          kind: "evidence",
          status: reviewStatus,
          title: "Review evidence",
          summary: `Review evidence reference recorded for ${review.decision}.`,
          source: {
            kind: "artifact",
            ref: artifactRef(
              taskId,
              "reviews",
              review.id,
              "evidence",
              digest(evidenceRef),
            ),
          },
          provenance: {
            recordedAt: timestamp(review.reviewedAt, "review.reviewedAt"),
            actor: oneLine(review.reviewer, 120),
            method: "imported",
          },
          ref: {
            path: "kernel.json",
            selector: `/reviews/${index}/evidenceRefs/${evidenceIndex}`,
          },
        },
        "review",
      );
    }

    for (const [criterionId, references] of Object.entries(
      review.acceptanceEvidence,
    )) {
      for (const [evidenceIndex, reference] of references.entries()) {
        const evidenceId = factId(
          "evidence",
          `${review.id}\u0000${criterionId}\u0000${reference}`,
        );
        add(
          {
            id: evidenceId,
            kind: "evidence",
            status: reviewStatus,
            title: `Acceptance evidence ${oneLine(criterionId, 64)}`,
            summary: `Evidence reference recorded for acceptance criterion ${oneLine(criterionId, 64)}.`,
            source: {
              kind: "artifact",
              ref: artifactRef(
                taskId,
                "reviews",
                review.id,
                "acceptance-evidence",
                `criterion-${digest(criterionId)}`,
                digest(reference),
              ),
            },
            provenance: {
              recordedAt: timestamp(review.reviewedAt, "review.reviewedAt"),
              actor: oneLine(review.reviewer, 120),
              method: "imported",
            },
            ref: {
              path: "kernel.json",
              selector: `/reviews/${index}/acceptanceEvidence/${pointerEscape(criterionId)}/${evidenceIndex}`,
            },
          },
          "verify",
        );
      }
    }
  }

  if (kernel.closure) {
    add(
      {
        id: "evidence:candidate-observation",
        kind: "evidence",
        status: "accepted",
        title: "Closed candidate observation",
        summary:
          "Candidate snapshot was observed at close; the Kernel records the observation as caller-attested.",
        source: {
          kind: "artifact",
          ref: artifactRef(taskId, "closure", "candidate-observation"),
        },
        provenance: {
          recordedAt: timestamp(
            kernel.closure.candidateObservation.observedAt,
            "candidateObservation.observedAt",
          ),
          actor: oneLine(kernel.closure.candidateObservation.observedBy, 120),
          method: "imported",
        },
        ref: { path: "kernel.json", selector: "/closure/candidateObservation" },
      },
      "verify",
    );
    add(
      {
        id: "evidence:closure-acceptance",
        kind: "evidence",
        status: "accepted",
        title: "Closed acceptance evidence",
        summary: "Acceptance evidence was recorded in the Task closure.",
        source: {
          kind: "artifact",
          ref: artifactRef(taskId, "closure", "acceptance-evidence"),
        },
        provenance: {
          recordedAt: timestamp(kernel.closure.closedAt, "closure.closedAt"),
          actor: oneLine(kernel.closure.closedBy, 120),
          method: "imported",
        },
        ref: { path: "kernel.json", selector: "/closure/acceptanceEvidence" },
      },
      "verify",
    );
    add(
      {
        id: "evidence:delivery",
        kind: "evidence",
        status: "accepted",
        title: "Delivery evidence",
        summary: oneLine(
          `${kernel.closure.deliveryEvidence.level}: ${kernel.closure.deliveryEvidence.summary}`,
          280,
        ),
        source: {
          kind: "artifact",
          ref: artifactRef(taskId, "closure", "delivery-evidence"),
        },
        provenance: {
          recordedAt: timestamp(kernel.closure.closedAt, "closure.closedAt"),
          actor: oneLine(kernel.closure.closedBy, 120),
          method: "imported",
        },
        ref: { path: "kernel.json", selector: "/closure/deliveryEvidence" },
      },
      "verify",
    );
  }

  const stageRefs = Object.fromEntries(
    Object.entries(stages).filter(([, ids]) => ids?.length),
  ) as TaskArtifactEnvelopeV1["stageRefs"];
  return parseEnvelope({ schemaVersion: 1, taskId, facts, stageRefs });
}

function pointerValue(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/")) {
    throw new Error(`Task artifact locator is not a JSON pointer: ${pointer}`);
  }
  let current: unknown = root;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = rawSegment.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(current) && /^\d+$/u.test(segment)) {
      current = current[Number(segment)];
    } else if (
      current !== null &&
      typeof current === "object" &&
      Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      throw new Error(`Task artifact locator does not resolve: ${pointer}`);
    }
  }
  if (current === undefined) {
    throw new Error(`Task artifact locator does not resolve: ${pointer}`);
  }
  return current;
}

/** Resolve only explicitly selected fact IDs for progressive Agent reading. */
export function readSelectedTaskArtifactSourcesV1(
  kernel: TaskKernelSnapshotV2,
  envelope: TaskArtifactEnvelopeV1,
  factIds: readonly string[],
): TaskArtifactSourceDetailV1[] {
  const facts = new Map(envelope.facts.map((fact) => [fact.id, fact]));
  const seen = new Set<string>();
  return factIds.flatMap((id) => {
    if (seen.has(id)) return [];
    seen.add(id);
    const fact = facts.get(id);
    if (!fact) throw new Error(`Unknown task artifact fact ID: ${id}`);
    return [
      {
        factId: id,
        source: fact.source,
        ref: fact.ref,
        value: pointerValue(kernel, fact.ref.selector),
      },
    ];
  });
}

/** Creation-time PRD view; it is written only when no user file exists. */
export function renderTaskPrdScaffoldV1(kernel: TaskKernelSnapshotV2): string {
  const envelope = projectTaskKernelArtifactsV1(kernel);
  const lines = [
    `# Task \`${kernel.identity.taskId}\``,
    "",
    "The live structured fact view is derived from `kernel.json`; this file is for human-authored narrative and will not be regenerated after Task creation.",
    "",
    `Live view: \`pactile task artifacts ${kernel.identity.taskId} --stage prd\` (add \`--agent\` for the compact index).`,
    "",
    "## PRD fact references",
    "",
  ];
  for (const id of envelope.stageRefs.prd ?? []) {
    const fact = envelope.facts.find((item) => item.id === id);
    if (!fact) continue;
    lines.push(
      `### \`${fact.id}\``,
      `- Source: \`${fact.source.ref}\``,
      `- Ref: \`${fact.ref.path}#${fact.ref.selector}\``,
      "",
    );
  }
  lines.push(
    "",
    "## Human-authored narrative",
    "",
    "<!-- Add PRD narrative below. Pactile preserves this content on later Task updates. -->",
    "",
  );
  return lines.join("\n");
}
