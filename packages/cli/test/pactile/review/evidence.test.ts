import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTaskCandidateSnapshot,
  type TaskRunV2,
} from "../../../src/core/task/index.js";
import {
  createTaskCandidateEntry,
  isTaskRunPathInWriteSet,
  observeTaskRunCandidate,
} from "../../../src/core/task/task-candidate-observer.js";
import { captureProjectFileBaseline } from "../../../src/core/task/project-file-observer.js";
import { resolvePiReviewEvidenceV1 } from "../../../src/pactile/review/evidence.js";

const roots: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(): { root: string; taskDir: string; run: TaskRunV2 } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-p40-review-evidence-"));
  roots.push(root);
  const taskDir = path.join(root, ".pactile", "tasks", "task-1");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "run.log"), "completed Run evidence\n");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  const writeSetSnapshot = ["src/", "src/reviewed.ts", "src/unreviewed.ts"];
  const candidateFileBaseline = captureProjectFileBaseline(root, writeSetSnapshot);
  fs.writeFileSync(path.join(root, "src", "reviewed.ts"), "reviewed candidate\n");
  fs.writeFileSync(path.join(root, "src", "unreviewed.ts"), "unreviewed candidate\n");

  const running: TaskRunV2 = {
    id: "run-1",
    taskId: "task-1",
    attempt: 1,
    sequence: 1,
    state: "running",
    startedAt: "2026-09-27T00:00:00.000Z",
    startedBy: "implementer",
    input: { summary: "Implement review evidence", references: [], fingerprint: "a".repeat(64) },
    authorization: {
      approvedBy: "approver",
      approvedAt: "2026-09-27T00:00:00.000Z",
      scope: "src",
      evidenceRef: "approval.md",
    },
    writeSetSnapshot,
    estimatedDurations: { executionMs: null, waitingMs: null, reviewMs: null },
    measurementRefs: { execution: null, waiting: null, review: null },
    candidateBaseSha: null,
    candidateBaseBranch: null,
    candidateFileBaseline,
    workspace: null,
    host: null,
    candidateSnapshot: null,
    result: null,
    failure: null,
    completedAt: null,
  };
  const observation = observeTaskRunCandidate({ run: running, repositoryRoot: root });
  const candidateEntries = observation.currentFiles
    .filter((file) => isTaskRunPathInWriteSet(running, file.path) && file.kind === "regular-file" && file.sha256 !== null)
    .map((file) => ({ ref: file.path, fingerprint: file.sha256 as string }));
  const candidateSnapshot = createTaskCandidateSnapshot([
    ...candidateEntries,
    createTaskCandidateEntry(observation),
  ]);
  return {
    root,
    taskDir,
    run: {
      ...running,
      state: "completed",
      candidateSnapshot,
      result: {
        summary: "Candidate and Run evidence captured",
        evidenceRefs: ["run.log"],
        evidenceVerification: {
          schemaVersion: 1,
          source: "pactile-task-run-evidence-v1",
          observedAt: "2026-09-27T00:01:00.000Z",
          runId: running.id,
          candidateSnapshotId: candidateSnapshot.id,
          candidateFingerprint: candidateSnapshot.fingerprint,
          items: [{
            ref: "run.log",
            sha256: sha256("completed Run evidence\n"),
            sizeBytes: Buffer.byteLength("completed Run evidence\n"),
            source: "task-evidence",
          }],
        },
      },
      completedAt: "2026-09-27T00:01:00.000Z",
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Pi Review evidence", () => {
  it("re-observes every candidate entry, including files the Review does not cite", () => {
    const state = fixture();
    fs.writeFileSync(path.join(state.root, "src", "unreviewed.ts"), "changed after Run completion\n");

    expect(() => resolvePiReviewEvidenceV1({
      root: state.root,
      taskDir: state.taskDir,
      candidateRoot: state.root,
      run: state.run,
      references: ["src/reviewed.ts"],
    })).toThrow();
  });

  it("rejects a candidate file added after Run completion, even when the Review does not cite it", () => {
    const state = fixture();
    fs.writeFileSync(path.join(state.root, "src", "added-after-run.ts"), "new candidate file\n");

    expect(() => resolvePiReviewEvidenceV1({
      root: state.root,
      taskDir: state.taskDir,
      candidateRoot: state.root,
      run: state.run,
      references: ["src/reviewed.ts"],
    })).toThrow();
  });

  it("rejects Run evidence whose bytes changed after completion", () => {
    const state = fixture();
    fs.writeFileSync(path.join(state.taskDir, "run.log"), "rewritten Run evidence\n");

    expect(() => resolvePiReviewEvidenceV1({
      root: state.root,
      taskDir: state.taskDir,
      candidateRoot: state.root,
      run: state.run,
      references: ["run.log"],
    })).toThrow();
  });
});
