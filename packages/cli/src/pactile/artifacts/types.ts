/**
 * Structured task facts shared by PRD, Design, Implement, Review, and Verify.
 * Stage indexes point at fact IDs; they never own a second copy of a fact.
 */
export const TASK_ARTIFACT_STAGES_V1 = [
  "prd",
  "design",
  "implement",
  "review",
  "verify",
] as const;

export type TaskArtifactStageV1 = (typeof TASK_ARTIFACT_STAGES_V1)[number];

export const TASK_ARTIFACT_FACT_KINDS_V1 = [
  "requirement",
  "decision",
  "constraint",
  "finding",
  "evidence",
  "candidate",
  "context",
] as const;

export type TaskArtifactFactKindV1 =
  (typeof TASK_ARTIFACT_FACT_KINDS_V1)[number];

export const TASK_ARTIFACT_FACT_STATUSES_V1 = [
  "active",
  "accepted",
  "blocked",
  "rejected",
  "superseded",
  "verified",
] as const;

export type TaskArtifactFactStatusV1 =
  (typeof TASK_ARTIFACT_FACT_STATUSES_V1)[number];

export const TASK_ARTIFACT_SOURCE_KINDS_V1 = [
  "user",
  "plane",
  "repository",
  "agent",
  "tool",
  "test",
  "artifact",
  "runtime",
] as const;

export type TaskArtifactSourceKindV1 =
  (typeof TASK_ARTIFACT_SOURCE_KINDS_V1)[number];

export const TASK_ARTIFACT_PROVENANCE_METHODS_V1 = [
  "direct",
  "derived",
  "verified",
  "imported",
] as const;

export type TaskArtifactProvenanceMethodV1 =
  (typeof TASK_ARTIFACT_PROVENANCE_METHODS_V1)[number];

export interface TaskArtifactSourceV1 {
  readonly kind: TaskArtifactSourceKindV1;
  /** Safe opaque source reference, such as `plane://tasks/pactile-42`. */
  readonly ref: string;
}

export interface TaskArtifactProvenanceV1 {
  readonly recordedAt: string;
  readonly actor: string;
  readonly method: TaskArtifactProvenanceMethodV1;
  /** Stable IDs of facts used to derive this fact. */
  readonly basedOn?: readonly string[];
}

export interface TaskArtifactLocatorV1 {
  /** Logical Kernel resource resolved through the active Task reader. */
  readonly uri: string;
  /** JSON pointer into the current Kernel snapshot returned by that reader. */
  readonly selector: string;
}

export type TaskArtifactCandidateFreshnessV1 =
  | {
      readonly freshness: "fresh" | "stale";
      readonly checkedAt: string;
      readonly evidenceRef: string;
    }
  | { readonly freshness: "unknown" };

interface TaskArtifactFactBaseV1 {
  /** Caller-assigned logical ID. Keep it when the fact changes status. */
  readonly id: string;
  readonly status: TaskArtifactFactStatusV1;
  readonly title: string;
  /** One-line index text; fuller context stays at `ref`. */
  readonly summary: string;
  readonly source: TaskArtifactSourceV1;
  readonly provenance: TaskArtifactProvenanceV1;
  readonly ref: TaskArtifactLocatorV1;
}

export type TaskArtifactFactV1 =
  | (TaskArtifactFactBaseV1 & {
      readonly kind: Exclude<TaskArtifactFactKindV1, "candidate">;
      readonly candidateFreshness?: never;
    })
  | (TaskArtifactFactBaseV1 & {
      readonly kind: "candidate";
      readonly candidateFreshness: TaskArtifactCandidateFreshnessV1;
    });

export interface TaskArtifactEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly facts: readonly TaskArtifactFactV1[];
  /** Sparse index: only stages with facts are present; values are fact IDs. */
  readonly stageRefs: Readonly<
    Partial<Record<TaskArtifactStageV1, readonly string[]>>
  >;
}
