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
    expect(initialIndex.stages).toEqual([
      { stage: "prd", factIds: expect.any(Array) },
    ]);
    expect(initialIndex.stages.some(({ stage }) => stage === "design")).toBe(
      false,
    );
    expect(initialIndex.stages.some(({ stage }) => stage === "implement")).toBe(
      false,
    );
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
    expect(requirementAfterReview.status).toBe("accepted");
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
});
