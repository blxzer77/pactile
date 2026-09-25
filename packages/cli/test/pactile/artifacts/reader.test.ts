import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runTaskCli } from "../../../src/commands/task.js";
import {
  closeTaskKernel,
  readTaskKernel,
  recordTaskReview,
  recordTaskRunResult,
  startTaskRun,
  type TaskKernelSnapshotV2,
} from "../../../src/core/task/index.js";
import {
  projectTaskArtifactsForHumanV1,
  projectTaskArtifactsForAgentV1,
  projectTaskKernelArtifactsV1,
  readSelectedTaskArtifactSourcesV1,
  readTaskArtifactDocumentIndexV1,
} from "../../../src/pactile/artifacts/index.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pactile-task-artifact-reader-"),
  );
  roots.push(root);
  fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
  return root;
}

function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined)
    throw new Error(`${label} is missing`);
  return value;
}

function readKernel(root: string, taskDir: string): TaskKernelSnapshotV2 {
  const result = readTaskKernel({ root, taskDir, cwd: root });
  if (result.kind !== "task-kernel-v2")
    throw new Error("expected Task Kernel v2");
  return result.kernel;
}

describe("Task Kernel structured artifact reader", () => {
  it("projects live lifecycle facts progressively and keeps the creation-time PRD user-owned", () => {
    const root = makeRoot();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(
      runTaskCli(
        [
          "create",
          "Small Fix",
          "--slug",
          "small-fix",
          "--description",
          "Keep the selected behavior",
          "--deliverable",
          "A tested local fix",
          "--delivery-level",
          "local-result",
          "--accept",
          "AC-1=The selected behavior remains available",
        ],
        root,
      ),
    ).toBe(0);

    const taskDirName = must(
      fs
        .readdirSync(path.join(root, ".pactile", "tasks"))
        .find((name) => name.endsWith("-small-fix")),
      "created Task directory",
    );
    const taskDir = path.join(root, ".pactile", "tasks", taskDirName);
    const prdPath = path.join(taskDir, "prd.md");
    expect(fs.existsSync(path.join(taskDir, "task.json"))).toBe(false);
    expect(fs.readFileSync(prdPath, "utf8")).toContain("requirement:");
    expect(fs.readFileSync(prdPath, "utf8")).toContain(
      "artifact://tasks/small-fix/kernel/definition",
    );
    expect(fs.readdirSync(taskDir).sort()).toEqual(["kernel.json", "prd.md"]);

    const authoredPrd = `${fs.readFileSync(prdPath, "utf8")}\n## Implementation notes\n\nKeep this user-authored text.\n`;
    fs.writeFileSync(prdPath, authoredPrd, "utf8");

    expect(runTaskCli(["artifacts", "small-fix", "--agent"], root)).toBe(0);
    const initialIndex = JSON.parse(
      String(log.mock.lastCall?.[0]),
    ) as ReturnType<typeof projectTaskArtifactsForAgentV1>;
    expect(initialIndex.stages.map(({ stage }) => stage)).toEqual([
      "prd",
      "design",
      "implement",
      "review",
      "verify",
    ]);
    expect(
      initialIndex.stages.find(({ stage }) => stage === "design"),
    ).toMatchObject({
      factIds: [],
      documentIds: ["document:design"],
    });
    expect(initialIndex.documents).toHaveLength(5);
    const initialDocuments = must(initialIndex.documents, "document index");
    const prdDocument = must(
      initialDocuments.find(({ id }) => id === "document:prd"),
      "PRD document reference",
    );
    expect(prdDocument).toMatchObject({
      status: "present",
      source: {
        kind: "task-document",
        ref: expect.stringMatching(
          /^artifact:\/\/tasks\/small-fix\/documents\/prd$/u,
        ),
      },
      provenance: { method: "read-only-content-fingerprint" },
      contentFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      ref: { paths: ["prd.md"], selector: "markdown-content" },
    });
    expect(
      initialDocuments
        .filter(({ stage }) => stage !== "prd")
        .every(
          ({ status, contentFingerprint }) =>
            status === "absent" && contentFingerprint === null,
        ),
    ).toBe(true);
    expect(JSON.stringify(initialIndex)).not.toContain(
      "Keep this user-authored text.",
    );
    expect(
      runTaskCli(
        ["artifacts", "small-fix", "--document", "document:design@absent"],
        root,
      ),
    ).toBe(0);
    const selectedAbsentDocument = JSON.parse(
      String(log.mock.lastCall?.[0]),
    ) as {
      selectedDocuments: {
        document: {
          id: string;
          status: string;
          contentFingerprint: string | null;
        };
        files: unknown[];
      }[];
    };
    expect(selectedAbsentDocument.selectedDocuments[0]).toMatchObject({
      document: {
        id: "document:design",
        status: "absent",
        contentFingerprint: null,
      },
      files: [],
    });

    expect(
      runTaskCli(
        [
          "artifacts",
          "small-fix",
          "--document",
          `${prdDocument.id}@${prdDocument.contentFingerprint}`,
        ],
        root,
      ),
    ).toBe(0);
    const selectedPrd = JSON.parse(String(log.mock.lastCall?.[0])) as {
      selectedDocuments: {
        document: { id: string; contentFingerprint: string | null };
        files: { path: string; content: string }[];
      }[];
    };
    expect(selectedPrd.selectedDocuments[0]).toMatchObject({
      document: { id: "document:prd", status: "present" },
      files: [{ path: "prd.md", content: authoredPrd }],
    });
    expect(initialIndex.facts.map(({ id }) => id)).toContain("context:task");
    const requirement = must(
      initialIndex.facts.find(({ kind }) => kind === "requirement"),
      "acceptance fact",
    );

    expect(runTaskCli(["artifacts", "small-fix", "--stage", "prd"], root)).toBe(
      0,
    );
    expect(String(log.mock.lastCall?.[0])).toContain("## PRD");
    expect(String(log.mock.lastCall?.[0])).toContain(
      `### \`${requirement.id}\``,
    );

    expect(
      runTaskCli(
        [
          "artifacts",
          "small-fix",
          "--agent",
          "--stage",
          "prd",
          "--fact",
          requirement.id,
        ],
        root,
      ),
    ).toBe(0);
    const selected = JSON.parse(String(log.mock.lastCall?.[0])) as {
      selectedSources: { factId: string; value: unknown }[];
    };
    expect(selected.selectedSources).toHaveLength(1);
    expect(selected.selectedSources[0]).toMatchObject({
      factId: requirement.id,
      value: {
        id: "AC-1",
        description: "The selected behavior remains available",
      },
    });

    let kernel = readKernel(root, taskDir);
    const started = startTaskRun({
      root,
      taskDir,
      expectedRevision: kernel.revision,
      actor: "implementer",
      idempotencyKey: "run-start:small-fix",
      input: { summary: "Implement the small fix", references: ["prd.md"] },
      authorization: {
        approvedBy: "requester",
        approvedAt: new Date().toISOString(),
        scope: "the selected behavior",
        evidenceRef: "approval.json",
      },
    });
    const runId = must(started.kernel.runs.at(-1), "started Run").id;
    recordTaskRunResult({
      root,
      taskDir,
      expectedRevision: started.kernel.revision,
      runId,
      outcome: "completed",
      summary: "The fix is implemented",
      candidateEntries: [
        { ref: "src/behavior.ts", fingerprint: "a".repeat(64) },
      ],
      evidenceRefs: ["test-output.txt"],
      actor: "implementer",
      idempotencyKey: "run-result:small-fix",
    });
    kernel = readKernel(root, taskDir);
    let envelope = projectTaskKernelArtifactsV1(kernel);
    const agentIndex = projectTaskArtifactsForAgentV1(envelope);
    expect(agentIndex.stages.map(({ stage }) => stage)).toEqual([
      "prd",
      "implement",
      "verify",
    ]);
    const candidate = must(
      agentIndex.facts.find(({ kind }) => kind === "candidate"),
      "candidate fact",
    );
    expect(candidate.candidateFreshness).toEqual({ freshness: "unknown" });

    const candidateSnapshot = must(
      kernel.runs.at(-1)?.candidateSnapshot,
      "candidate snapshot",
    );
    recordTaskReview({
      root,
      taskDir,
      expectedRevision: kernel.revision,
      runId,
      candidateSnapshotId: candidateSnapshot.id,
      candidateFingerprint: candidateSnapshot.fingerprint,
      reviewer: "independent-reviewer",
      decision: "pass",
      evidenceRefs: ["review.md"],
      acceptanceEvidence: { "AC-1": ["src/behavior.ts"] },
      actor: "independent-reviewer",
      idempotencyKey: "review:small-fix",
    });
    kernel = readKernel(root, taskDir);
    envelope = projectTaskKernelArtifactsV1(kernel);
    const requirementAfterReview = must(
      envelope.facts.find(({ id }) => id === requirement.id),
      "stable requirement fact",
    );
    expect(requirementAfterReview.status).toBe("active");
    expect(envelope.stageRefs.verify).toContain(requirement.id);
    const reviewFact = must(
      envelope.facts.find(({ kind }) => kind === "finding"),
      "review fact",
    );

    const closedAt = new Date().toISOString();
    closeTaskKernel({
      root,
      taskDir,
      expectedRevision: kernel.revision,
      runId,
      reviewId: must(kernel.reviews.at(-1), "Review").id,
      candidateObservation: {
        snapshotId: candidateSnapshot.id,
        fingerprint: candidateSnapshot.fingerprint,
        observedBy: "closer",
        observedAt: closedAt,
        source: "caller-attested",
        evidenceRef: "snapshot-observation.json",
      },
      deliveryEvidence: {
        level: "local-result",
        reference: "src/behavior.ts",
        summary: "The reviewed result is present",
      },
      actor: "closer",
      idempotencyKey: "close:small-fix",
    });
    kernel = readKernel(root, taskDir);
    envelope = projectTaskKernelArtifactsV1(kernel);
    const finalIndex = projectTaskArtifactsForAgentV1(envelope);
    expect(finalIndex.stages.map(({ stage }) => stage)).toEqual([
      "prd",
      "implement",
      "review",
      "verify",
    ]);
    const finalRequirement = must(
      envelope.facts.find(({ id }) => id === requirement.id),
      "final requirement fact",
    );
    expect(finalRequirement).toMatchObject({
      status: "verified",
      provenance: { method: "verified" },
    });
    const finalCandidate = must(
      envelope.facts.find(({ id }) => id === candidate.id),
      "final candidate fact",
    );
    expect(finalCandidate).toMatchObject({
      status: "accepted",
      candidateFreshness: {
        freshness: "fresh",
        checkedAt: closedAt,
        evidenceRef:
          "artifact://tasks/small-fix/kernel/closure/candidate-observation",
      },
    });
    expect(finalRequirement.provenance.basedOn).toContain(reviewFact.id);

    const selectedSource = readSelectedTaskArtifactSourcesV1(kernel, envelope, [
      requirement.id,
    ]);
    expect(selectedSource).toHaveLength(1);
    expect(selectedSource[0].value).toMatchObject({
      id: "AC-1",
      description: "The selected behavior remains available",
    });
    const human = projectTaskArtifactsForHumanV1(envelope);
    expect(
      human.match(new RegExp(`### \`${requirement.id}\``, "gu")),
    ).toHaveLength(1);
    expect(fs.readFileSync(prdPath, "utf8")).toBe(authoredPrd);
    expect(fs.readdirSync(taskDir).sort()).toEqual(["kernel.json", "prd.md"]);
  });

  it("indexes authored Design, Implement, Review, and Verify sources without copying their narrative", () => {
    const root = makeRoot();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(
      runTaskCli(
        [
          "create",
          "Heavy Feature",
          "--slug",
          "heavy-feature",
          "--description",
          "Add a deterministic artifact reader",
          "--deliverable",
          "A reviewed artifact index",
          "--delivery-level",
          "local-result",
          "--accept",
          "AC-1=Document sources remain user-owned and locatable",
          "--accept",
          "AC-2=Review and verification evidence can be followed",
        ],
        root,
      ),
    ).toBe(0);

    const taskDirName = must(
      fs
        .readdirSync(path.join(root, ".pactile", "tasks"))
        .find((name) => name.endsWith("-heavy-feature")),
      "created heavy Task directory",
    );
    const taskDir = path.join(root, ".pactile", "tasks", taskDirName);
    const authoredDocs = new Map([
      [
        "design.md",
        "# Design\n\n## Decision\n\nUse stable stage IDs and hash source files on demand.\n\n## Trade-off\n\nDo not store a second copy of authored narrative.\n",
      ],
      [
        "implement.md",
        "# Implement\n\n## Change\n\nExpose document locators with explicit selection.\n\n## Evidence\n\nThe reader rechecks hashes before returning a body.\n",
      ],
      [
        "review/decision.md",
        "# Review decision\n\nDecision: fail because the second criterion has no supplied acceptance evidence.\n",
      ],
      [
        "verify.md",
        "# Verify\n\n## Validation\n\nThe selected source body matches its indexed fingerprint.\n",
      ],
    ]);
    for (const [relative, content] of authoredDocs) {
      const filePath = path.join(taskDir, relative);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, "utf8");
    }

    let kernel = readKernel(root, taskDir);
    const started = startTaskRun({
      root,
      taskDir,
      expectedRevision: kernel.revision,
      actor: "implementer",
      idempotencyKey: "run-start:heavy-feature",
      input: {
        summary: "Implement the artifact reader based on the design",
        references: ["prd.md", "design.md", "implement.md"],
      },
      authorization: {
        approvedBy: "requester",
        approvedAt: new Date().toISOString(),
        scope: "structured document indexing",
        evidenceRef: "approval.json",
      },
    });
    const runId = must(started.kernel.runs.at(-1), "heavy Task Run").id;
    recordTaskRunResult({
      root,
      taskDir,
      expectedRevision: started.kernel.revision,
      runId,
      outcome: "completed",
      summary: "The document index and selected reader are implemented",
      candidateEntries: [
        {
          ref: "packages/cli/src/pactile/artifacts",
          fingerprint: "c".repeat(64),
        },
      ],
      evidenceRefs: ["verify.md#validation", "verify.md#validation"],
      actor: "implementer",
      idempotencyKey: "run-result:heavy-feature",
    });
    kernel = readKernel(root, taskDir);
    const candidateSnapshot = must(
      kernel.runs.at(-1)?.candidateSnapshot,
      "heavy candidate snapshot",
    );
    recordTaskReview({
      root,
      taskDir,
      expectedRevision: kernel.revision,
      runId,
      candidateSnapshotId: candidateSnapshot.id,
      candidateFingerprint: candidateSnapshot.fingerprint,
      reviewer: "independent-reviewer",
      decision: "fail",
      evidenceRefs: [
        "review/decision.md#decision",
        "review/decision.md#decision",
      ],
      acceptanceEvidence: {
        "AC-1": [
          "packages/cli/src/pactile/artifacts",
          "packages/cli/src/pactile/artifacts",
        ],
      },
      actor: "independent-reviewer",
      idempotencyKey: "review:heavy-feature",
    });
    kernel = readKernel(root, taskDir);

    const envelope = projectTaskKernelArtifactsV1(kernel);
    const requirementId = must(
      envelope.stageRefs.prd?.find((id) => id.startsWith("requirement:")),
      "PRD requirement locator",
    );
    expect(envelope.stageRefs.verify).toContain(requirementId);
    const requirementFacts = envelope.facts.filter(
      (fact) => fact.kind === "requirement",
    );
    expect(requirementFacts.map(({ status }) => status)).toEqual([
      "active",
      "active",
    ]);
    expect(envelope.stageRefs.verify).not.toContain(requirementFacts[1]?.id);
    const runFact = must(
      envelope.facts.find((fact) => fact.id.startsWith("implement:")),
      "Implement Run fact",
    );
    expect(envelope.stageRefs.implement).toContain(runFact.id);
    const selectedRun = readSelectedTaskArtifactSourcesV1(kernel, envelope, [
      runFact.id,
    ])[0];
    expect(selectedRun?.value).toMatchObject({
      input: {
        references: ["prd.md", "design.md", "implement.md"],
      },
    });
    const verifyEvidenceFacts = envelope.facts.filter(
      (fact) =>
        fact.kind === "evidence" &&
        fact.ref.selector.startsWith("/runs/0/result/evidenceRefs/"),
    );
    expect(verifyEvidenceFacts).toHaveLength(2);
    expect(new Set(verifyEvidenceFacts.map(({ id }) => id)).size).toBe(2);
    expect(verifyEvidenceFacts.map(({ ref }) => ref.selector)).toEqual([
      "/runs/0/result/evidenceRefs/0",
      "/runs/0/result/evidenceRefs/1",
    ]);
    expect(verifyEvidenceFacts.every(({ status }) => status === "active")).toBe(
      true,
    );
    const verifyEvidenceFact = must(
      verifyEvidenceFacts.find(
        (fact) => fact.ref.selector === "/runs/0/result/evidenceRefs/0",
      ),
      "Verify execution evidence fact",
    );
    expect(envelope.stageRefs.verify).toContain(verifyEvidenceFact.id);
    expect(
      readSelectedTaskArtifactSourcesV1(
        kernel,
        envelope,
        verifyEvidenceFacts.map(({ id }) => id),
      ).map(({ value }) => value),
    ).toEqual(["verify.md#validation", "verify.md#validation"]);
    const reviewFact = must(
      envelope.facts.find((fact) => fact.kind === "finding"),
      "Review decision fact",
    );
    expect(reviewFact).toMatchObject({
      status: "rejected",
      ref: { path: "kernel.json", selector: "/reviews/0" },
    });
    expect(envelope.stageRefs.review).toContain(reviewFact.id);
    const selectedReviewDecision = readSelectedTaskArtifactSourcesV1(
      kernel,
      envelope,
      [reviewFact.id],
    )[0];
    expect(selectedReviewDecision?.value).toMatchObject({
      decision: "fail",
      evidenceRefs: [
        "review/decision.md#decision",
        "review/decision.md#decision",
      ],
    });
    const reviewEvidenceFacts = envelope.facts.filter(
      (fact) =>
        fact.kind === "evidence" &&
        fact.ref.selector.startsWith("/reviews/0/evidenceRefs/"),
    );
    expect(reviewEvidenceFacts).toHaveLength(2);
    expect(new Set(reviewEvidenceFacts.map(({ id }) => id)).size).toBe(2);
    expect(reviewEvidenceFacts.map(({ ref }) => ref.selector)).toEqual([
      "/reviews/0/evidenceRefs/0",
      "/reviews/0/evidenceRefs/1",
    ]);
    expect(reviewEvidenceFacts.every(({ status }) => status === "active")).toBe(
      true,
    );
    const reviewEvidenceFact = must(
      reviewEvidenceFacts.find(
        (fact) => fact.ref.selector === "/reviews/0/evidenceRefs/0",
      ),
      "Review evidence fact",
    );
    expect(envelope.stageRefs.review).toContain(reviewEvidenceFact.id);
    expect(
      readSelectedTaskArtifactSourcesV1(
        kernel,
        envelope,
        reviewEvidenceFacts.map(({ id }) => id),
      ).map(({ value }) => value),
    ).toEqual(["review/decision.md#decision", "review/decision.md#decision"]);
    const acceptanceEvidenceFacts = envelope.facts.filter(
      (fact) =>
        fact.kind === "evidence" &&
        fact.ref.selector.startsWith("/reviews/0/acceptanceEvidence/AC-1/"),
    );
    expect(acceptanceEvidenceFacts).toHaveLength(2);
    expect(new Set(acceptanceEvidenceFacts.map(({ id }) => id)).size).toBe(2);
    expect(acceptanceEvidenceFacts.map(({ ref }) => ref.selector)).toEqual([
      "/reviews/0/acceptanceEvidence/AC-1/0",
      "/reviews/0/acceptanceEvidence/AC-1/1",
    ]);
    expect(
      acceptanceEvidenceFacts.every(({ status }) => status === "active"),
    ).toBe(true);
    expect(
      readSelectedTaskArtifactSourcesV1(
        kernel,
        envelope,
        acceptanceEvidenceFacts.map(({ id }) => id),
      ).map(({ value }) => value),
    ).toEqual([
      "packages/cli/src/pactile/artifacts",
      "packages/cli/src/pactile/artifacts",
    ]);

    const documents = readTaskArtifactDocumentIndexV1(
      taskDir,
      kernel.identity.taskId,
    );
    expect(documents.map(({ id, status }) => [id, status])).toEqual([
      ["document:prd", "present"],
      ["document:design", "present"],
      ["document:implement", "present"],
      ["document:review", "present"],
      ["document:verify", "present"],
    ]);
    const reviewDocument = must(
      documents.find(({ id }) => id === "document:review"),
      "Review document reference",
    );
    expect(reviewDocument).toMatchObject({
      source: {
        kind: "task-document",
        ref: `artifact://tasks/heavy-feature/documents/review`,
      },
      ref: {
        paths: ["review/decision.md"],
        selector: "markdown-files",
      },
    });
    expect(
      documents.every(({ contentFingerprint }) =>
        /^sha256:[a-f0-9]{64}$/u.test(contentFingerprint ?? ""),
      ),
    ).toBe(true);

    const human = projectTaskArtifactsForHumanV1(envelope, { documents });
    const agent = projectTaskArtifactsForAgentV1(envelope, { documents });
    expect(human).toContain("document:design");
    expect(human).toContain("review/decision.md#markdown-files");
    expect(human).not.toContain(
      "Use stable stage IDs and hash source files on demand.",
    );
    expect(agent.stages.find(({ stage }) => stage === "design")).toMatchObject({
      documentIds: ["document:design"],
    });
    expect(JSON.stringify(agent)).not.toContain(
      "Use stable stage IDs and hash source files on demand.",
    );

    expect(
      runTaskCli(
        ["artifacts", "heavy-feature", "--agent", "--stage", "design"],
        root,
      ),
    ).toBe(0);
    const designOnly = JSON.parse(String(log.mock.lastCall?.[0])) as {
      stages: { stage: string; factIds: string[]; documentIds?: string[] }[];
      documents: {
        id: string;
        status: string;
        contentFingerprint: string | null;
      }[];
    };
    expect(designOnly.stages).toEqual([
      { stage: "design", factIds: [], documentIds: ["document:design"] },
    ]);
    expect(designOnly.documents.map(({ id }) => id)).toEqual([
      "document:design",
    ]);

    const designBeforeRead = fs.readFileSync(
      path.join(taskDir, "design.md"),
      "utf8",
    );
    const designReference = must(
      designOnly.documents.find(({ id }) => id === "document:design"),
      "Design document fingerprint from CLI index",
    );
    const designFingerprint = must(
      designReference.contentFingerprint,
      "Design document content fingerprint",
    );
    const designSelection = `${designReference.id}@${designFingerprint}`;
    expect(
      runTaskCli(
        [
          "artifacts",
          "heavy-feature",
          "--agent",
          "--document",
          designSelection,
        ],
        root,
      ),
    ).toBe(0);
    const selectedDesign = JSON.parse(String(log.mock.lastCall?.[0])) as {
      selectedDocuments: {
        document: { id: string; contentFingerprint: string };
        files: { path: string; content: string }[];
      }[];
    };
    expect(selectedDesign.selectedDocuments[0]).toMatchObject({
      document: {
        id: "document:design",
        contentFingerprint: documents.find(({ id }) => id === "document:design")
          ?.contentFingerprint,
      },
      files: [{ path: "design.md", content: designBeforeRead }],
    });
    expect(fs.readFileSync(path.join(taskDir, "design.md"), "utf8")).toBe(
      designBeforeRead,
    );

    fs.writeFileSync(
      path.join(taskDir, "design.md"),
      `${designBeforeRead}\n## Follow-up\n\nThe authored rationale remains editable.\n`,
      "utf8",
    );
    expect(
      runTaskCli(
        [
          "artifacts",
          "heavy-feature",
          "--agent",
          "--document",
          designSelection,
        ],
        root,
      ),
    ).toBe(1);
    expect(String(error.mock.lastCall?.[0])).toContain("stale");

    expect(
      runTaskCli(
        ["artifacts", "heavy-feature", "--agent", "--stage", "design"],
        root,
      ),
    ).toBe(0);
    const refreshedIndex = JSON.parse(String(log.mock.lastCall?.[0])) as {
      documents: {
        id: string;
        status: string;
        contentFingerprint: string | null;
      }[];
    };
    const refreshedDesign = must(
      refreshedIndex.documents.find(({ id }) => id === "document:design"),
      "refreshed Design document reference",
    );
    const refreshedFingerprint = must(
      refreshedDesign.contentFingerprint,
      "refreshed Design document fingerprint",
    );
    expect(refreshedDesign.id).toBe(designReference.id);
    expect(refreshedFingerprint).not.toBe(designFingerprint);
    expect(
      runTaskCli(
        [
          "artifacts",
          "heavy-feature",
          "--agent",
          "--document",
          `${refreshedDesign.id}@${refreshedFingerprint}`,
        ],
        root,
      ),
    ).toBe(0);
    const refreshedSelection = JSON.parse(String(log.mock.lastCall?.[0])) as {
      selectedDocuments: { files: { path: string; content: string }[] }[];
    };
    expect(
      refreshedSelection.selectedDocuments[0]?.files[0]?.content,
    ).toContain("The authored rationale remains editable.");
  });
});
