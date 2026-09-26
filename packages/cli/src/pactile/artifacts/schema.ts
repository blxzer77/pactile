import {
  ContractDecoderV1,
  decodeLogicalIdV1,
  decodeOpaqueReferenceV1,
  decodeTimestampV1,
  definePactileContractSchemaV1,
} from "../../core/pactile/validation.js";

import {
  TASK_ARTIFACT_FACT_KINDS_V1,
  TASK_ARTIFACT_FACT_STATUSES_V1,
  TASK_ARTIFACT_PROVENANCE_METHODS_V1,
  TASK_ARTIFACT_SOURCE_KINDS_V1,
  TASK_ARTIFACT_STAGES_V1,
  type TaskArtifactCandidateFreshnessV1,
  type TaskArtifactEnvelopeV1,
  type TaskArtifactFactKindV1,
  type TaskArtifactFactStatusV1,
  type TaskArtifactFactV1,
  type TaskArtifactProvenanceMethodV1,
  type TaskArtifactSourceKindV1,
  type TaskArtifactStageV1,
} from "./types.js";

const SOURCE_SCHEMES = [
  "user",
  "plane",
  "source",
  "git",
  "agent",
  "tool",
  "test",
  "artifact",
  "runtime",
] as const;

const FRESHNESS_EVIDENCE_SCHEMES = [
  "source",
  "git",
  "test",
  "tool",
  "artifact",
] as const;

const FACT_FIELDS = [
  "id",
  "kind",
  "status",
  "title",
  "summary",
  "source",
  "provenance",
  "ref",
  "candidateFreshness",
] as const;

const SOURCE_SCHEME_BY_KIND: Readonly<
  Record<TaskArtifactSourceKindV1, readonly string[]>
> = {
  user: ["user"],
  plane: ["plane"],
  repository: ["source", "git"],
  agent: ["agent"],
  tool: ["tool"],
  test: ["test"],
  artifact: ["artifact"],
  runtime: ["runtime"],
};

function decodeOneLine(
  decoder: ContractDecoderV1,
  value: unknown,
  path: string,
  maxLength: number,
): string {
  const result = decoder.string(value, path, { nonEmpty: true });
  if (result.length > maxLength) {
    decoder.issue(
      "invalid-value",
      path,
      `must be at most ${maxLength} characters`,
    );
  }
  if (/[\r\n]/u.test(result)) {
    decoder.issue("invalid-value", path, "must be a single line");
  }
  return result;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function decodeSource(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): TaskArtifactFactV1["source"] {
  const record = decoder.object(value, path, ["kind", "ref"]);
  const kind = decoder.enumValue(
    decoder.required(record, "kind", path),
    TASK_ARTIFACT_SOURCE_KINDS_V1,
    `${path}.kind`,
  );
  const ref = decodeOpaqueReferenceV1(
    decoder.required(record, "ref", path),
    decoder,
    `${path}.ref`,
    SOURCE_SCHEMES,
  );
  const scheme = ref.slice(0, ref.indexOf("://"));
  if (!SOURCE_SCHEME_BY_KIND[kind].includes(scheme)) {
    decoder.issue(
      "invalid-value",
      `${path}.ref`,
      `scheme must match source kind '${kind}'`,
    );
  }
  return { kind, ref };
}

function decodeProvenance(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): TaskArtifactFactV1["provenance"] {
  const record = decoder.object(value, path, [
    "recordedAt",
    "actor",
    "method",
    "basedOn",
  ]);
  const recordedAt = decodeTimestampV1(
    decoder.required(record, "recordedAt", path),
    decoder,
    `${path}.recordedAt`,
  );
  const actor = decodeOneLine(
    decoder,
    decoder.required(record, "actor", path),
    `${path}.actor`,
    120,
  );
  const method = decoder.enumValue(
    decoder.required(record, "method", path),
    TASK_ARTIFACT_PROVENANCE_METHODS_V1,
    `${path}.method`,
  );
  const rawBasedOn = decoder.optional(record, "basedOn");
  let basedOn: string[] | undefined;
  if (rawBasedOn !== undefined) {
    basedOn = decoder.stringArray(rawBasedOn, `${path}.basedOn`, {
      nonEmptyItems: true,
      unique: true,
      pattern: /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u,
      patternDescription: "stable lowercase fact IDs",
    });
  }
  if (method === "derived" && (!basedOn || basedOn.length === 0)) {
    decoder.issue(
      "required",
      `${path}.basedOn`,
      "is required and non-empty when method is 'derived'",
    );
  }

  return {
    recordedAt,
    actor,
    method,
    ...(basedOn === undefined ? {} : { basedOn }),
  };
}

function decodeLocator(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): TaskArtifactFactV1["ref"] {
  const record = decoder.object(value, path, ["uri", "selector"]);
  const uri = decodeOpaqueReferenceV1(
    decoder.required(record, "uri", path),
    decoder,
    `${path}.uri`,
    ["artifact"],
  );
  const selector = decodeOneLine(
    decoder,
    decoder.required(record, "selector", path),
    `${path}.selector`,
    256,
  );
  return { uri, selector };
}

function decodeCandidateFreshness(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): TaskArtifactCandidateFreshnessV1 {
  const record = decoder.object(value, path, [
    "freshness",
    "checkedAt",
    "evidenceRef",
  ]);
  const freshness = decoder.enumValue(
    decoder.required(record, "freshness", path),
    ["fresh", "stale", "unknown"] as const,
    `${path}.freshness`,
  );
  const hasCheckedAt = hasOwn(record, "checkedAt");
  const hasEvidenceRef = hasOwn(record, "evidenceRef");
  if (freshness === "unknown") {
    if (hasCheckedAt || hasEvidenceRef) {
      decoder.issue(
        "policy-violation",
        path,
        "unknown freshness must not claim a check time or evidence reference",
      );
    }
    return { freshness };
  }
  if (!hasCheckedAt) {
    decoder.issue(
      "required",
      `${path}.checkedAt`,
      "is required for a freshness claim",
    );
  }
  if (!hasEvidenceRef) {
    decoder.issue(
      "required",
      `${path}.evidenceRef`,
      "is required for a freshness claim",
    );
  }
  const checkedAt = decodeTimestampV1(
    decoder.required(record, "checkedAt", path),
    decoder,
    `${path}.checkedAt`,
  );
  const evidenceRef = decodeOpaqueReferenceV1(
    decoder.required(record, "evidenceRef", path),
    decoder,
    `${path}.evidenceRef`,
    FRESHNESS_EVIDENCE_SCHEMES,
  );
  return { freshness, checkedAt, evidenceRef };
}

function decodeFact(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): TaskArtifactFactV1 {
  const record = decoder.object(value, path, FACT_FIELDS);
  const id = decodeLogicalIdV1(
    decoder.required(record, "id", path),
    decoder,
    `${path}.id`,
  );
  const kind = decoder.enumValue(
    decoder.required(record, "kind", path),
    TASK_ARTIFACT_FACT_KINDS_V1,
    `${path}.kind`,
  );
  const status = decoder.enumValue(
    decoder.required(record, "status", path),
    TASK_ARTIFACT_FACT_STATUSES_V1,
    `${path}.status`,
  );
  const title = decodeOneLine(
    decoder,
    decoder.required(record, "title", path),
    `${path}.title`,
    120,
  );
  const summary = decodeOneLine(
    decoder,
    decoder.required(record, "summary", path),
    `${path}.summary`,
    280,
  );
  const source = decodeSource(
    decoder.required(record, "source", path),
    decoder,
    `${path}.source`,
  );
  const provenance = decodeProvenance(
    decoder.required(record, "provenance", path),
    decoder,
    `${path}.provenance`,
  );
  const ref = decodeLocator(
    decoder.required(record, "ref", path),
    decoder,
    `${path}.ref`,
  );
  const hasFreshness = hasOwn(record, "candidateFreshness");
  if (kind === "candidate") {
    if (!hasFreshness) {
      decoder.issue(
        "required",
        `${path}.candidateFreshness`,
        "is required for candidate facts",
      );
    }
    return {
      id,
      kind,
      status,
      title,
      summary,
      source,
      provenance,
      ref,
      candidateFreshness: decodeCandidateFreshness(
        decoder.required(record, "candidateFreshness", path),
        decoder,
        `${path}.candidateFreshness`,
      ),
    };
  }
  if (hasFreshness) {
    decoder.issue(
      "policy-violation",
      `${path}.candidateFreshness`,
      "candidate freshness is only valid for candidate facts",
    );
  }
  return { id, kind, status, title, summary, source, provenance, ref };
}

function decodeEnvelope(
  value: unknown,
  decoder: ContractDecoderV1,
  path: string,
): TaskArtifactEnvelopeV1 {
  const record = decoder.object(value, path, [
    "schemaVersion",
    "taskId",
    "facts",
    "stageRefs",
  ]);
  const schemaVersion = decoder.literal(
    decoder.required(record, "schemaVersion", path),
    1,
    `${path}.schemaVersion`,
  );
  const taskId = decodeLogicalIdV1(
    decoder.required(record, "taskId", path),
    decoder,
    `${path}.taskId`,
  );
  const facts = decoder.array(
    decoder.required(record, "facts", path),
    `${path}.facts`,
    (fact, factPath) => decodeFact(fact, decoder, factPath),
  );
  if (facts.length === 0) {
    decoder.issue(
      "invalid-value",
      `${path}.facts`,
      "must include at least one fact",
    );
  }
  decoder.unique(facts, (fact) => fact.id, `${path}.facts`, "fact ID");

  const rawStages = decoder.object(
    decoder.required(record, "stageRefs", path),
    `${path}.stageRefs`,
    TASK_ARTIFACT_STAGES_V1,
  );
  const stageRefs: Partial<Record<TaskArtifactStageV1, string[]>> = {};
  for (const stage of TASK_ARTIFACT_STAGES_V1) {
    if (!hasOwn(rawStages, stage)) continue;
    const ids = decoder.stringArray(
      rawStages[stage],
      `${path}.stageRefs.${stage}`,
      {
        nonEmptyItems: true,
        unique: true,
        pattern: /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u,
        patternDescription: "stable lowercase fact IDs",
      },
    );
    if (ids.length === 0) {
      decoder.issue(
        "invalid-value",
        `${path}.stageRefs.${stage}`,
        "empty stage entries must be omitted",
      );
    }
    stageRefs[stage] = ids;
  }
  if (Object.keys(stageRefs).length === 0) {
    decoder.issue(
      "invalid-value",
      `${path}.stageRefs`,
      "must include at least one non-empty stage",
    );
  }

  const factIds = new Set(facts.map((fact) => fact.id));
  const reachableIds = new Set<string>();
  for (const stage of TASK_ARTIFACT_STAGES_V1) {
    for (const [index, factId] of (stageRefs[stage] ?? []).entries()) {
      if (!factIds.has(factId)) {
        decoder.issue(
          "invalid-value",
          `${path}.stageRefs.${stage}[${index}]`,
          `references unknown fact '${factId}'`,
        );
      }
      reachableIds.add(factId);
    }
  }
  for (const [index, fact] of facts.entries()) {
    if (!reachableIds.has(fact.id)) {
      decoder.issue(
        "invalid-value",
        `${path}.facts[${index}].id`,
        "fact must be referenced by at least one stage",
      );
    }
    for (const basedOnId of fact.provenance.basedOn ?? []) {
      if (basedOnId === fact.id) {
        decoder.issue(
          "policy-violation",
          `${path}.facts[${index}].provenance.basedOn`,
          "a fact cannot derive from itself",
        );
      }
      if (!factIds.has(basedOnId)) {
        decoder.issue(
          "invalid-value",
          `${path}.facts[${index}].provenance.basedOn`,
          `references unknown fact '${basedOnId}'`,
        );
      }
    }
  }

  return { schemaVersion, taskId, facts, stageRefs };
}

export const taskArtifactEnvelopeV1Schema =
  definePactileContractSchemaV1<TaskArtifactEnvelopeV1>(
    "pactile.task-artifacts",
    decodeEnvelope,
  );

export type {
  TaskArtifactFactKindV1,
  TaskArtifactFactStatusV1,
  TaskArtifactProvenanceMethodV1,
};
