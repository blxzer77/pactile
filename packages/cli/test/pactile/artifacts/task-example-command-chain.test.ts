import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readTaskKernel } from "../../../src/core/task/task-kernel.js";
import { runTaskCli } from "../../../src/commands/task.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pactile-artifact-task-example-"),
  );
  roots.push(root);
  fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".pactile", ".developer"),
    "name=default-developer\n",
  );
  return root;
}

function readV2(root: string, taskDir: string) {
  const read = readTaskKernel({ root, taskDir, cwd: root });
  if (read.kind !== "task-kernel-v2")
    throw new Error("expected Task Kernel V2");
  return read.kernel;
}

function must<T>(value: T | undefined | null, label: string): T {
  if (value === undefined || value === null)
    throw new Error(`${label} is missing`);
  return value;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("structured artifact Task walkthrough", () => {
  it("runs the PASS command path with synthetic approval and review fixtures", () => {
    const root = makeRoot();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(
      runTaskCli(
        [
          "create",
          "Artifact walkthrough",
          "--slug",
          "artifact-walkthrough",
          "--description",
          "Exercise the structured artifact example",
          "--deliverable",
          "A reviewable local result",
          "--delivery-level",
          "local-result",
          "--accept",
          "AC-1=The reviewed result is recorded",
        ],
        root,
      ),
    ).toBe(0);
    const taskDirectory = fs
      .readdirSync(path.join(root, ".pactile", "tasks"))
      .find((name) => name.endsWith("artifact-walkthrough"));
    if (!taskDirectory) throw new Error("created Task directory is missing");
    const taskDir = path.join(root, ".pactile", "tasks", taskDirectory);
    const candidateContents = "reviewed result\n";
    const evidenceContents = "AC-1 passed\n";
    fs.mkdirSync(path.join(taskDir, "evidence"), { recursive: true });
    // Exercise the acceptance path with synthetic files, not real approval.
    fs.writeFileSync(
      path.join(taskDir, "evidence", "synthetic-approval-fixture.md"),
      "Synthetic test fixture only; no requester approval occurred.\n",
    );
    fs.mkdirSync(path.join(root, "tests"), { recursive: true });
    fs.writeFileSync(path.join(root, "tests", "result.txt"), "baseline test\n");

    expect(
      runTaskCli(
        [
          "run-start",
          "artifact-walkthrough",
          "--actor",
          "implementer",
          "--input-summary",
          "Implement AC-1",
          "--input-ref",
          "prd.md",
          "--approved-by",
          "requester",
          "--authorization-scope",
          "the walkthrough result",
          "--authorization-evidence",
          "evidence/synthetic-approval-fixture.md",
          "--write-set",
          "result.txt",
          "--write-set",
          "tests/result.txt",
        ],
        root,
      ),
    ).toBe(0);
    const started = must(readV2(root, taskDir).runs.at(-1), "started Run");
    expect(started.startedBy).toBe("implementer");
    fs.writeFileSync(path.join(root, "result.txt"), candidateContents);
    fs.writeFileSync(path.join(root, "tests", "result.txt"), evidenceContents);
    fs.mkdirSync(path.join(taskDir, "review"), { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, "review", "synthetic-review-fixture.md"),
      "Synthetic test fixture only; no independent review occurred.\n",
    );

    const runResult = runTaskCli(
      [
        "run-result",
        "artifact-walkthrough",
        started.id,
        "--actor",
        "implementer",
        "--outcome",
        "completed",
        "--summary",
        "The acceptance result is recorded",
        "--candidate",
        `result.txt=${createHash("sha256").update(candidateContents).digest("hex")}`,
        "--evidence",
        "tests/result.txt",
      ],
      root,
    );
    expect(
      runResult,
      error.mock.calls.map((call) => call.join(" ")).join("\n"),
    ).toBe(0);
    const completedRun = must(
      readV2(root, taskDir).runs.at(-1),
      "completed Run",
    );
    const candidate = must(
      completedRun.candidateSnapshot,
      "candidate snapshot",
    );
    expect(candidate.entries).toContainEqual({
      ref: "result.txt",
      fingerprint: createHash("sha256").update(candidateContents).digest("hex"),
    });
    expect(candidate.entries).toContainEqual(
      expect.objectContaining({
        ref: "pactile:verification:project-files-v1",
      }),
    );
    expect(completedRun.result?.evidenceVerification?.items).toContainEqual(
      expect.objectContaining({
        ref: "tests/result.txt",
        sha256: createHash("sha256").update(evidenceContents).digest("hex"),
        source: "candidate-snapshot",
      }),
    );

    expect(
      runTaskCli(
        [
          "review",
          "artifact-walkthrough",
          "--run",
          started.id,
          "--candidate-id",
          candidate.id,
          "--candidate-fingerprint",
          candidate.fingerprint,
          "--reviewer",
          "independent-reviewer",
          "--actor",
          "independent-reviewer",
          "--decision",
          "pass",
          "--evidence",
          "review/synthetic-review-fixture.md",
          "--criterion",
          "AC-1=tests/result.txt",
        ],
        root,
      ),
    ).toBe(0);

    const reviewedKernel = readV2(root, taskDir);
    const reviewed = must(reviewedKernel.reviews.at(-1), "Review");
    expect(reviewedKernel).toMatchObject({
      phase: "verify",
      closure: null,
      runs: [
        expect.objectContaining({
          state: "completed",
          startedBy: "implementer",
          candidateSnapshot: expect.objectContaining({
            id: candidate.id,
            fingerprint: candidate.fingerprint,
          }),
        }),
      ],
      reviews: [
        expect.objectContaining({
          reviewer: "independent-reviewer",
          decision: "pass",
          independent: true,
        }),
      ],
    });
    expect(reviewed).toMatchObject({
      reviewer: "independent-reviewer",
      decision: "pass",
      independent: true,
      candidateSnapshotId: candidate.id,
      candidateFingerprint: candidate.fingerprint,
    });

    fs.writeFileSync(
      path.join(taskDir, "evidence", "current-candidate.json"),
      JSON.stringify({
        snapshotId: candidate.id,
        fingerprint: candidate.fingerprint,
      }),
    );
    const closeArgs = [
      "close",
      "artifact-walkthrough",
      "--run",
      started.id,
      "--review",
      reviewed.id,
      "--candidate-id",
      candidate.id,
      "--candidate-fingerprint",
      candidate.fingerprint,
      "--candidate-observed-by",
      "closer",
      "--candidate-observation-source",
      "declared",
      "--candidate-observation-ref",
      "evidence/current-candidate.json",
      "--delivery-level",
      "local-result",
      "--delivery-ref",
      "result.txt",
      "--delivery-summary",
      "Reviewed result is present",
      "--actor",
      "closer",
    ];
    expect(runTaskCli([...closeArgs, "--check"], root)).toBe(0);
    expect(runTaskCli(closeArgs, root)).toBe(0);
    const closedKernel = readV2(root, taskDir);
    expect(closedKernel.phase).toBe("close");
    expect(closedKernel.closure).toMatchObject({
      candidateObservation: {
        observedBy: "pactile-core-task-close",
        source: "project-files-v1",
        evidenceRef: "pactile:verification:project-files-v1",
      },
      deliveryVerification: {
        source: "pactile-task-delivery-observer-v1",
        path: "result.txt",
        candidateSource: "project-files-v1",
      },
    });

    expect(
      runTaskCli(["artifacts", "artifact-walkthrough", "--agent"], root),
    ).toBe(0);
    const artifactIndex = JSON.parse(String(log.mock.lastCall?.[0])) as {
      taskId: string;
      facts: { kind: string; summary: string }[];
    };
    expect(artifactIndex.taskId).toBe("artifact-walkthrough");
    expect(artifactIndex.facts).toContainEqual(
      expect.objectContaining({
        kind: "finding",
        summary: expect.stringContaining("Decision: pass"),
      }),
    );
  });
});
