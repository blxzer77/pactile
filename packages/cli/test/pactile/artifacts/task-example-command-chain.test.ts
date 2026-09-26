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
  it("runs a temporary Task through explicit implementer and independent reviewer actors", () => {
    const root = makeRoot();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

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
          "evidence/approval.md",
        ],
        root,
      ),
    ).toBe(0);
    const started = must(readV2(root, taskDir).runs.at(-1), "started Run");
    expect(started.startedBy).toBe("implementer");

    expect(
      runTaskCli(
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
          `result.txt=${"a".repeat(64)}`,
          "--evidence",
          "tests/result.txt",
        ],
        root,
      ),
    ).toBe(0);
    const completedRun = must(
      readV2(root, taskDir).runs.at(-1),
      "completed Run",
    );
    const candidate = must(
      completedRun.candidateSnapshot,
      "candidate snapshot",
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
          "review/artifact-walkthrough.md",
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
