import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  assessRetrievalClaimV3,
  buildRetrievalRequestV3,
  createRetrievalPlanV3,
  type RetrievalPlanV3,
} from "../../../src/pactile/retrieval/index.js";

const cliRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

interface EvidenceParityCase {
  readonly name: string;
  readonly planIntent: "exact" | "semantic" | "structural" | "external";
  readonly inputIntent?: string;
  readonly minimumAssurance: "best-effort" | "evidence-backed" | "verified";
  readonly requiredEvidenceKinds: readonly string[];
  readonly candidateRefs: readonly string[];
  readonly corroboration: readonly {
    readonly kind: string;
    readonly ref: string;
  }[];
  readonly resolution: "valid" | null;
  readonly resolutionOverrides?: Readonly<Record<string, unknown>>;
  readonly resolutionExtra?: Readonly<Record<string, unknown>>;
  readonly inputExtra?: Readonly<Record<string, unknown>>;
  readonly expected: {
    readonly accepted: boolean;
    readonly achievedAssurance: string | null;
    readonly reasonCodes: readonly string[];
  };
  readonly outputMustNotContain?: readonly string[];
}

const evidenceCases = JSON.parse(
  readFileSync(
    path.join(cliRoot, "test/fixtures/retrieval-v3/evidence-cases.json"),
    "utf8",
  ),
) as EvidenceParityCase[];

function validResolution(
  plan: RetrievalPlanV3,
  intent: Exclude<EvidenceParityCase["planIntent"], "exact">,
  overrides: Readonly<Record<string, unknown>> = {},
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const verified = plan.minimumAssurance === "verified";
  return {
    schemaVersion: 1,
    intent,
    minimumAssurance: plan.minimumAssurance,
    origin: "provider",
    providerId: "fixture.provider",
    providerVersion: "1.0.0",
    assurance: plan.minimumAssurance,
    readiness: "ready",
    requestedPolicy: plan.requestedPolicy,
    effectivePolicy: plan.requestedPolicy,
    evidenceRefs: ["evidence://provider/probe"],
    freshness: verified ? "fresh" : "unknown",
    probedAt: verified ? "2026-09-09T01:00:00.000Z" : null,
    probeResult: verified ? "passed" : "not-run",
    fallbackFromProviderId: null,
    ...overrides,
    ...extra,
  };
}

function evidenceInput(fixture: EvidenceParityCase): Record<string, unknown> {
  const plan = createRetrievalPlanV3(
    buildRetrievalRequestV3({
      query: `shared evidence fixture ${fixture.planIntent}`,
      intents: [fixture.planIntent],
      minimumAssurance: fixture.minimumAssurance,
      requiredEvidenceKinds: fixture.requiredEvidenceKinds,
    }),
    fixture.planIntent === "exact"
      ? {}
      : {
          providerAvailability: [
            {
              intent: fixture.planIntent,
              status: "ready",
              readiness: "ready",
            },
          ],
        },
  );
  const input: Record<string, unknown> = {
    plan,
    intent: fixture.inputIntent ?? fixture.planIntent,
    candidateRefs: fixture.candidateRefs,
    corroboration: fixture.corroboration,
  };
  if (fixture.resolution === "valid" && fixture.planIntent !== "exact") {
    input.resolution = validResolution(
      plan,
      fixture.planIntent,
      fixture.resolutionOverrides,
      fixture.resolutionExtra,
    );
  }
  return { ...input, ...fixture.inputExtra };
}

describe("Pactile retrieval V3 evidence fixtures", () => {
  it.each(evidenceCases)(
    "matches the evidence contract for $name",
    (fixture) => {
      const input = evidenceInput(fixture);
      const typescript = assessRetrievalClaimV3(input as never);
      expect(typescript).toMatchObject(fixture.expected);
      for (const canary of fixture.outputMustNotContain ?? []) {
        expect(JSON.stringify(typescript)).not.toContain(canary);
      }
    },
  );
});
