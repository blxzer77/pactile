import { describe, expect, it } from "vitest";

import {
  projectTaskArtifactsForAgentV1,
  projectTaskArtifactsForHumanV1,
  taskArtifactEnvelopeV1Schema,
} from "../../../src/pactile/artifacts/index.js";

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    taskId: "p42-sample",
    facts: [
      {
        id: "fact-req-1",
        kind: "requirement",
        status: "accepted",
        title: "Keep one source of truth",
        summary: "Later stages refer to the same fact ID.",
        source: { kind: "plane", ref: "plane://tasks/pactile-42" },
        provenance: {
          recordedAt: "2026-09-25T04:00:00.000Z",
          actor: "planner",
          method: "direct",
        },
        ref: { path: "prd.md", selector: "requirements#single-source" },
      },
      {
        id: "fact-candidate-1",
        kind: "candidate",
        status: "active",
        title: "Candidate source file",
        summary: "A location proposed by structural search.",
        source: {
          kind: "repository",
          ref: "source://packages/cli/src/index-ts",
        },
        provenance: {
          recordedAt: "2026-09-25T04:05:00.000Z",
          actor: "search-adapter",
          method: "derived",
          basedOn: ["fact-req-1"],
        },
        ref: { path: "research/candidates.md", selector: "candidate-file" },
        candidateFreshness: {
          freshness: "stale",
          checkedAt: "2026-09-24T04:05:00.000Z",
          evidenceRef: "git://commits/9dcd0f35",
        },
      },
    ],
    stageRefs: {
      prd: ["fact-req-1"],
      implement: ["fact-req-1", "fact-candidate-1"],
      verify: ["fact-req-1"],
    },
    ...overrides,
  };
}

function parse(input = envelope()) {
  const result = taskArtifactEnvelopeV1Schema.parse(input);
  if (!result.success) {
    throw new Error(result.issues.map((issue) => issue.message).join("; "));
  }
  return result.data;
}

describe("structured task artifact projections", () => {
  it("keeps stage maps as IDs and projects each canonical fact once", () => {
    const data = parse();
    const agent = projectTaskArtifactsForAgentV1(data);
    const human = projectTaskArtifactsForHumanV1(data);

    expect(agent.stages).toEqual([
      { stage: "prd", factIds: ["fact-req-1"] },
      { stage: "implement", factIds: ["fact-req-1", "fact-candidate-1"] },
      { stage: "verify", factIds: ["fact-req-1"] },
    ]);
    expect(agent.facts.map((fact) => fact.id)).toEqual([
      "fact-req-1",
      "fact-candidate-1",
    ]);
    expect(human.match(/### `fact-req-1`/gu)).toHaveLength(1);
    expect(human.match(/### `fact-candidate-1`/gu)).toHaveLength(1);
  });

  it("uses a sparse phase view and omits candidate-only fields from ordinary facts", () => {
    const full = envelope();
    const data = parse(
      envelope({
        facts: [full.facts[0]],
        stageRefs: { prd: ["fact-req-1"] },
      }),
    );
    const agent = projectTaskArtifactsForAgentV1(data, {
      stages: ["prd", "review"],
    });
    const human = projectTaskArtifactsForHumanV1(data, {
      stages: ["prd", "review"],
    });

    expect(agent.stages).toEqual([{ stage: "prd", factIds: ["fact-req-1"] }]);
    expect(agent.facts[0]).not.toHaveProperty("candidateFreshness");
    expect(human).toContain("## PRD");
    expect(human).not.toContain("## Review");
    expect(human).not.toContain("Candidate freshness");
  });

  it("keeps a stale candidate explicitly stale with its freshness evidence", () => {
    const candidate = projectTaskArtifactsForAgentV1(parse()).facts[1];
    expect(candidate).toMatchObject({
      id: "fact-candidate-1",
      candidateFreshness: {
        freshness: "stale",
        checkedAt: "2026-09-24T04:05:00.000Z",
        evidenceRef: "git://commits/9dcd0f35",
      },
    });
  });

  it("keeps unknown candidate freshness free of implied verification", () => {
    const raw = envelope();
    raw.facts[1].candidateFreshness = { freshness: "unknown" };
    const candidate = projectTaskArtifactsForAgentV1(parse(raw)).facts[1];

    expect(candidate.candidateFreshness).toEqual({ freshness: "unknown" });
    raw.facts[1].candidateFreshness = {
      freshness: "unknown",
      checkedAt: "2026-09-25T04:05:00.000Z",
    };
    expect(taskArtifactEnvelopeV1Schema.parse(raw)).toMatchObject({
      success: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          message:
            "unknown freshness must not claim a check time or evidence reference",
        }),
      ]),
    });
  });

  it("rejects orphaned facts and stale stage IDs before projection", () => {
    const orphaned = envelope({ stageRefs: { prd: ["fact-req-1"] } });
    const staleReference = envelope({
      stageRefs: { prd: ["fact-req-1", "fact-missing"] },
    });

    expect(taskArtifactEnvelopeV1Schema.parse(orphaned)).toMatchObject({
      success: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          message: "fact must be referenced by at least one stage",
        }),
      ]),
    });
    expect(taskArtifactEnvelopeV1Schema.parse(staleReference)).toMatchObject({
      success: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          message: "references unknown fact 'fact-missing'",
        }),
      ]),
    });
  });

  it("rejects freshness claims without evidence and candidate fields on other facts", () => {
    const missingEvidence = envelope();
    (missingEvidence.facts[1] as Record<string, unknown>).candidateFreshness = {
      freshness: "fresh",
      checkedAt: "2026-09-25T04:05:00.000Z",
    };
    const inapplicableFreshness = envelope();
    (
      inapplicableFreshness.facts[0] as Record<string, unknown>
    ).candidateFreshness = {
      freshness: "unknown",
    };

    expect(taskArtifactEnvelopeV1Schema.parse(missingEvidence)).toMatchObject({
      success: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: "$.facts[1].candidateFreshness.evidenceRef",
        }),
      ]),
    });
    expect(
      taskArtifactEnvelopeV1Schema.parse(inapplicableFreshness),
    ).toMatchObject({
      success: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          message: "candidate freshness is only valid for candidate facts",
        }),
      ]),
    });
  });

  it("returns only the agent index metadata and stable locators, not unbounded prose", () => {
    const data = parse();
    const index = projectTaskArtifactsForAgentV1(data, {
      stages: ["implement"],
    });

    expect(index.facts[0]).toMatchObject({
      id: "fact-req-1",
      summary: "Later stages refer to the same fact ID.",
      ref: { path: "prd.md", selector: "requirements#single-source" },
      source: { kind: "plane", ref: "plane://tasks/pactile-42" },
      provenance: { method: "direct", actor: "planner" },
    });
    expect(index.facts[0]).not.toHaveProperty("body");
    expect(index.facts[0]).not.toHaveProperty("fullText");
  });

  it("keeps fact text from becoming Markdown structure in the human view", () => {
    const raw = envelope();
    raw.facts[0].title = "[external link](https://example.invalid)";
    raw.facts[0].summary = "**bold** stays literal";

    const human = projectTaskArtifactsForHumanV1(parse(raw));

    expect(human).toContain("\\[external link\\](https://example.invalid)");
    expect(human).toContain("\\*\\*bold\\*\\* stays literal");
  });
});
