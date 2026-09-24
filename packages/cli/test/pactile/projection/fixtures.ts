import type {
  ProjectionOperationV1,
  ProjectionPlanV1,
} from "../../../src/core/index.js";
import {
  fingerprintBytes,
  type ProjectionContent,
  type ProjectionPreview,
  type ProjectionPreviewResult,
} from "../../../src/pactile/projection/planner.js";
export const canonical = fingerprintBytes("canonical");
export const timestamp = "2026-09-09T00:00:00.000Z";
export const artifacts = new Map<string, ProjectionContent>([
  ["text-v1", { bytes: Buffer.from("generated\n") }],
  ["text-v2", { bytes: Buffer.from("generated two\n") }],
  [
    "json-v1",
    { bytes: Buffer.from('{"owned":1}'), ownedJsonPointers: ["/owned"] },
  ],
  [
    "json-v2",
    { bytes: Buffer.from('{"owned":2}'), ownedJsonPointers: ["/owned"] },
  ],
]);
export const resolveContent = (ref: string): ProjectionContent => {
  const item = artifacts.get(ref);
  if (!item) throw new Error("missing-fixture");
  return item;
};
export function operation(
  patch: Partial<ProjectionOperationV1> = {},
): ProjectionOperationV1 {
  return {
    id: "operation-a",
    resourceId: "shared-resource",
    claimantId: "adapter-a",
    action: "ensure",
    control: "pactile-owned",
    targetPath: "AGENTS.md",
    format: "text",
    contentRef: "text-v1",
    desiredFingerprint: fingerprintBytes(resolveContent("text-v1").bytes),
    expectedCurrentFingerprint: null,
    externalAssetId: null,
    ...patch,
  };
}
export function plan(
  op: ProjectionOperationV1,
  expectedLedgerFingerprint: string | null = null,
  adapterId = "adapter-a",
): ProjectionPlanV1 {
  return {
    schemaVersion: 1,
    id: "plan-a",
    adapterId,
    generationId: "generation-a",
    canonicalFingerprint: canonical,
    expectedLedgerFingerprint,
    operations: [op],
  };
}
export function ready(result: ProjectionPreviewResult): ProjectionPreview {
  if (result.status !== "ready") throw new Error(JSON.stringify(result));
  return result;
}
