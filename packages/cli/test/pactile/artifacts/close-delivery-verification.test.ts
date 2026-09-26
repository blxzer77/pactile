import { createHash } from "node:crypto";
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
  projectTaskArtifactsForAgentV1,
  projectTaskArtifactsForHumanV1,
  projectTaskKernelArtifactsV1,
  readSelectedTaskArtifactSourcesV1,
  type TaskArtifactEnvelopeV1,
} from "../../../src/pactile/artifacts/index.js";

const roots: string[] = [];
const DELIVERY_VERIFICATION_FACT_ID = "evidence:delivery-verification";

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pactile-close-delivery-verification-"),
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

function createTask(root: string, taskId: string): string {
  const status = runTaskCli(
    [
      "create",
      "Close receipt test",
      "--slug",
      taskId,
      "--description",
      "Expose the machine-observed Close delivery receipt.",
      "--deliverable",
      "A progressive Close receipt locator.",
      "--delivery-level",
      "local-result",
      "--accept",
      "AC-1=The Close delivery receipt can be resolved from its fact locator",
    ],
    root,
  );
  if (status !== 0) throw new Error(`Task creation failed with ${status}`);
  const taskDirName = must(
    fs
      .readdirSync(path.join(root, ".pactile", "tasks"))
      .find((name) => name.endsWith(`-${taskId}`)),
    "created Task directory",
  );
  return path.join(root, ".pactile", "tasks", taskDirName);
}

function closeTask(root: string, taskDir: string): TaskKernelSnapshotV2 {
  let kernel = readKernel(root, taskDir);
  const started = startTaskRun({
    root,
    taskDir,
    expectedRevision: kernel.revision,
    actor: "implementer",
    idempotencyKey: "run-start:close-receipt",
    input: {
      summary: "Implement the reviewed behavior",
      references: ["prd.md"],
    },
    authorization: {
      approvedBy: "requester",
      approvedAt: new Date().toISOString(),
      scope: "the reviewed behavior",
      evidenceRef: "approval.json",
    },
    writeSetSnapshot: ["src/behavior.ts"],
  });
  const runId = must(started.kernel.runs.at(-1), "started Run").id;
  const behaviorPath = path.join(root, "src", "behavior.ts");
  fs.mkdirSync(path.dirname(behaviorPath), { recursive: true });
  const behaviorSource = "export const behavior = true;\n";
  fs.writeFileSync(behaviorPath, behaviorSource, "utf8");
  fs.writeFileSync(
    path.join(taskDir, "review.md"),
    "The candidate and acceptance evidence were reviewed.\n",
    "utf8",
  );
  recordTaskRunResult({
    root,
    taskDir,
    expectedRevision: started.kernel.revision,
    runId,
    outcome: "completed",
    summary: "The reviewed behavior is implemented",
    candidateEntries: [
      {
        ref: "src/behavior.ts",
        fingerprint: createHash("sha256").update(behaviorSource).digest("hex"),
      },
    ],
    evidenceRefs: ["review.md"],
    actor: "implementer",
    idempotencyKey: "run-result:close-receipt",
  });

  kernel = readKernel(root, taskDir);
  const candidateSnapshot = must(
    kernel.runs.at(-1)?.candidateSnapshot,
    "Run candidate snapshot",
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
    idempotencyKey: "review:close-receipt",
  });

  kernel = readKernel(root, taskDir);
  closeTaskKernel({
    root,
    taskDir,
    expectedRevision: kernel.revision,
    runId,
    reviewId: must(kernel.reviews.at(-1), "latest Review").id,
    candidateObservation: {
      snapshotId: candidateSnapshot.id,
      fingerprint: candidateSnapshot.fingerprint,
      observedBy: "caller",
      observedAt: new Date().toISOString(),
      source: "caller-attested",
      evidenceRef: "candidate-observation.json",
    },
    deliveryEvidence: {
      level: "local-result",
      reference: "src/behavior.ts",
      summary: "The reviewed result is present",
    },
    actor: "closer",
    idempotencyKey: "close:close-receipt",
  });
  return readKernel(root, taskDir);
}

describe("Close delivery verification artifact fact", () => {
  it("lists the real receipt compactly and resolves it by ID or URI selector", () => {
    const root = makeRoot();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const taskDir = createTask(root, "close-receipt");
    const prdPath = path.join(taskDir, "prd.md");
    const originalPrd = fs.readFileSync(prdPath, "utf8");
    const kernel = closeTask(root, taskDir);
    const receipt = must(
      kernel.closure?.deliveryVerification,
      "machine-observed Close delivery verification",
    );
    const envelope = projectTaskKernelArtifactsV1(kernel);
    const receiptFact = must(
      envelope.facts.find(({ id }) => id === DELIVERY_VERIFICATION_FACT_ID),
      "Close delivery verification fact",
    );
    const candidateObservationFact = must(
      envelope.facts.find(({ id }) => id === "evidence:candidate-observation"),
      "Close candidate observation fact",
    );
    const candidateObservationSummary =
      "Candidate snapshot observed at Close by pactile-core-task-close from project-files-v1.";

    expect(receiptFact).toMatchObject({
      kind: "evidence",
      status: "verified",
      title: "Close delivery verification",
      summary: "Core verified local-result delivery at src/behavior.ts.",
      source: {
        kind: "artifact",
        ref: "artifact://tasks/close-receipt/kernel/closure/delivery-verification",
      },
      provenance: {
        recordedAt: receipt.observedAt,
        actor: receipt.source,
        method: "verified",
        basedOn: ["evidence:candidate-observation", "evidence:delivery"],
      },
      ref: {
        uri: "artifact://tasks/close-receipt/kernel",
        selector: "/closure/deliveryVerification",
      },
    });
    expect(candidateObservationFact.summary).toBe(candidateObservationSummary);
    expect(envelope.stageRefs.verify).toContain(receiptFact.id);

    expect(
      runTaskCli(
        ["artifacts", "close-receipt", "--agent", "--stage", "verify"],
        root,
      ),
    ).toBe(0);
    const agentIndex = JSON.parse(String(log.mock.lastCall?.[0])) as ReturnType<
      typeof projectTaskArtifactsForAgentV1
    >;
    expect(
      agentIndex.facts.find(({ id }) => id === receiptFact.id),
    ).toMatchObject({
      summary: "Core verified local-result delivery at src/behavior.ts.",
      ref: receiptFact.ref,
    });
    expect(
      agentIndex.facts.find(({ id }) => id === candidateObservationFact.id)
        ?.summary,
    ).toBe(candidateObservationSummary);
    expect(JSON.stringify(agentIndex)).not.toContain(receipt.fileSha256);

    for (const reference of [
      receiptFact.id,
      `${receiptFact.ref.uri}#${receiptFact.ref.selector}`,
    ]) {
      expect(
        runTaskCli(
          ["artifacts", "close-receipt", "--agent", "--fact", reference],
          root,
        ),
        String(error.mock.lastCall?.[0]),
      ).toBe(0);
      const selected = JSON.parse(String(log.mock.lastCall?.[0])) as {
        selectedSources: { factId: string; value: unknown }[];
      };
      expect(selected.selectedSources).toEqual([
        {
          factId: receiptFact.id,
          source: receiptFact.source,
          ref: receiptFact.ref,
          value: receipt,
        },
      ]);
    }

    const staleLocator = `${receiptFact.ref.uri}#/closure/deliveryVerification/stale`;
    expect(
      runTaskCli(
        ["artifacts", "close-receipt", "--agent", "--fact", staleLocator],
        root,
      ),
    ).toBe(1);
    expect(String(error.mock.lastCall?.[0])).toContain(
      "Unknown task artifact fact ID or locator",
    );

    const corruptedEnvelope: TaskArtifactEnvelopeV1 = {
      ...envelope,
      facts: envelope.facts.map((fact) =>
        fact.id === receiptFact.id
          ? {
              ...fact,
              ref: { ...fact.ref, selector: "/closure/deliveryEvidence" },
            }
          : fact,
      ),
    };
    expect(() =>
      readSelectedTaskArtifactSourcesV1(kernel, corruptedEnvelope, [
        receiptFact.id,
      ]),
    ).toThrow("has a stale or invalid Close verification locator");

    expect(
      runTaskCli(["artifacts", "close-receipt", "--stage", "verify"], root),
    ).toBe(0);
    const humanSummary = String(log.mock.lastCall?.[0]);
    expect(humanSummary).toContain(DELIVERY_VERIFICATION_FACT_ID);
    expect(humanSummary).toContain("/closure/deliveryVerification");
    expect(humanSummary).toContain(candidateObservationSummary);
    expect(humanSummary).not.toContain("fileSha256");
    expect(humanSummary).not.toContain(receipt.fileSha256);
    expect(fs.readFileSync(prdPath, "utf8")).toBe(originalPrd);
  });

  it("does not invent a receipt for an open Task or a legacy Close without one", () => {
    const root = makeRoot();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const taskDir = createTask(root, "open-receipt");
    const openKernel = readKernel(root, taskDir);
    expect(openKernel.closure).toBeNull();
    const openEnvelope = projectTaskKernelArtifactsV1(openKernel);
    expect(
      openEnvelope.facts.some(({ id }) => id === DELIVERY_VERIFICATION_FACT_ID),
    ).toBe(false);
    expect(
      runTaskCli(
        [
          "artifacts",
          "open-receipt",
          "--agent",
          "--fact",
          DELIVERY_VERIFICATION_FACT_ID,
        ],
        root,
      ),
    ).toBe(1);
    expect(String(error.mock.lastCall?.[0])).toContain(
      "Unknown task artifact fact ID or locator",
    );

    const closedKernel = closeTask(root, taskDir);
    const legacyClose = structuredClone(closedKernel);
    const closure = must(legacyClose.closure, "closed Task closure");
    delete closure.deliveryVerification;
    const legacyEnvelope = projectTaskKernelArtifactsV1(legacyClose);
    expect(
      legacyEnvelope.facts.some(
        ({ id }) => id === DELIVERY_VERIFICATION_FACT_ID,
      ),
    ).toBe(false);
    expect(legacyEnvelope.stageRefs.verify).not.toContain(
      DELIVERY_VERIFICATION_FACT_ID,
    );
    expect(() =>
      readSelectedTaskArtifactSourcesV1(legacyClose, legacyEnvelope, [
        DELIVERY_VERIFICATION_FACT_ID,
      ]),
    ).toThrow(
      `Unknown task artifact fact ID: ${DELIVERY_VERIFICATION_FACT_ID}`,
    );
    const legacyHumanSummary = projectTaskArtifactsForHumanV1(legacyEnvelope);
    expect(legacyHumanSummary).toContain("evidence:delivery");
    expect(legacyHumanSummary).not.toContain(DELIVERY_VERIFICATION_FACT_ID);
  });
});
