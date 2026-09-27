import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeTaskKernel,
  createTaskKernel,
  readTaskKernel,
  recordTaskReview,
  recordTaskRunResult,
  startTaskRun,
  type TaskKernelSnapshotV2,
} from "../../../src/core/task/index.js";
import {
  createTaskCandidateEntry,
  observeTaskRunCandidate,
} from "../../../src/core/task/task-candidate-observer.js";
import {
  captureProjectFileBaseline,
  observeProjectFileCandidate,
  PROJECT_FILE_SNAPSHOT_MAX_DIRECTORY_ENTRIES,
  PROJECT_FILE_SNAPSHOT_MAX_FILE_BYTES,
} from "../../../src/core/task/project-file-observer.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-task-nongit-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "Project documentation.\n");
  return root;
}

function kernelFor(
  root: string,
  taskId: string,
  deliveryLevel: "documentation" | "local-result" = "documentation",
): { dir: string; kernel: TaskKernelSnapshotV2 } {
  const dir = path.join(root, ".pactile", "tasks", taskId);
  const result = createTaskKernel({
    root,
    taskDir: dir,
    actor: "author",
    idempotencyKey: `create:${taskId}`,
    definition: {
      taskId,
      title: taskId,
      description: "Non-Git documentation Run",
      deliverable: "A reviewed local document",
      deliveryLevel,
      acceptanceCriteria: [{ id: "AC-1", description: "Document is present" }],
      dependencies: [],
    },
  });
  fs.writeFileSync(path.join(dir, "review.md"), "Independent Review evidence.\n");
  return { dir, kernel: result.kernel };
}

function latestKernel(root: string, taskDir: string): TaskKernelSnapshotV2 {
  const result = readTaskKernel({ root, taskDir, cwd: root });
  if (result.kind !== "task-kernel-v2") throw new Error("expected Task Kernel V2");
  return result.kernel;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function beginRun(
  root: string,
  taskDir: string,
  taskId: string,
  writeSet = ["docs/result.md"],
) {
  const current = latestKernel(root, taskDir);
  const started = startTaskRun({
    root,
    taskDir,
    expectedRevision: current.revision,
    actor: "implementer",
    idempotencyKey: `run:${taskId}`,
    input: { summary: "Write a local document", references: [] },
    authorization: {
      approvedBy: "approver",
      approvedAt: "2026-09-26T00:00:00.000Z",
      scope: "one local result",
      evidenceRef: "approval.json",
    },
    writeSetSnapshot: writeSet,
  });
  const run = started.kernel.runs.at(-1);
  if (!run) throw new Error("started Run is missing");
  return { kernel: started.kernel, run };
}

describe("non-Git Task Kernel Runs", () => {
  it.each([
    {
      taskId: "nongit-documentation",
      deliveryLevel: "documentation" as const,
      deliveryPath: "docs/result.md",
    },
    {
      taskId: "nongit-local-result",
      deliveryLevel: "local-result" as const,
      deliveryPath: "result.md",
    },
  ])(
    "completes, reviews, and closes a $deliveryLevel Run using the bounded project snapshot",
    ({ taskId, deliveryLevel, deliveryPath }) => {
      const root = makeRoot();
      const task = kernelFor(root, taskId, deliveryLevel);
      const started = beginRun(root, task.dir, taskId, [deliveryPath]);

      expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
      expect(started.run.candidateBaseSha).toBeNull();
      expect(started.run.candidateFileBaseline).toMatchObject({
        source: "pactile-project-file-baseline-v1",
        policy: "project-files-bounded-v1",
      });
      expect(
        started.run.candidateFileBaseline?.files.map((file) => file.path),
      ).toEqual(["README.md"]);

      const document = "Local Task result.\n";
      fs.writeFileSync(path.join(root, ...deliveryPath.split("/")), document);
      const observation = observeTaskRunCandidate({
        run: started.run,
        repositoryRoot: root,
      });
      expect(observation).toMatchObject({
        source: "project-files-v1",
        scopeStatus: "within-write-set",
        affectedPaths: [deliveryPath],
      });

      const completed = recordTaskRunResult({
        root,
        taskDir: task.dir,
        expectedRevision: started.kernel.revision,
        runId: started.run.id,
        outcome: "completed",
        summary: `${deliveryLevel} result written`,
        evidenceRefs: [deliveryPath],
        candidateEntries: [
          { ref: deliveryPath, fingerprint: hash(document) },
          createTaskCandidateEntry(observation),
        ],
        actor: "implementer",
        idempotencyKey: `result:${taskId}`,
      });
      const run = completed.kernel.runs.at(-1);
      const candidate = run?.candidateSnapshot;
      if (!run || !candidate)
        throw new Error("completed Run candidate is missing");

      const reviewed = recordTaskReview({
        root,
        taskDir: task.dir,
        expectedRevision: completed.kernel.revision,
        runId: run.id,
        candidateSnapshotId: candidate.id,
        candidateFingerprint: candidate.fingerprint,
        reviewer: "independent-reviewer",
        decision: "pass",
        evidenceRefs: [deliveryPath],
        acceptanceEvidence: { "AC-1": [deliveryPath] },
        actor: "independent-reviewer",
        idempotencyKey: `review:${taskId}`,
      });
      const review = reviewed.kernel.reviews.at(-1);
      if (!review) throw new Error("Review is missing");

      const closed = closeTaskKernel({
        root,
        taskDir: task.dir,
        expectedRevision: reviewed.kernel.revision,
        runId: run.id,
        reviewId: review.id,
        candidateObservation: {
          snapshotId: candidate.id,
          fingerprint: candidate.fingerprint,
          observedBy: "closer",
          observedAt: "2026-09-26T00:03:00.000Z",
          source: observation.source,
          evidenceRef: createTaskCandidateEntry(observation).ref,
        },
        deliveryEvidence: {
          level: deliveryLevel,
          reference: deliveryPath,
          path: deliveryPath,
          summary: `Reviewed ${deliveryLevel} result`,
        },
        actor: "closer",
        idempotencyKey: `close:${taskId}`,
      });

      expect(closed.kernel.closure?.deliveryVerification).toMatchObject({
        candidateSource: "project-files-v1",
        candidateHead: null,
        level: deliveryLevel,
        path: deliveryPath,
        fileSha256: hash(document),
        gitBlobSha256: null,
      });
    },
  );

  it("classifies a new file outside the Run write set as ineligible", () => {
    const root = makeRoot();
    const task = kernelFor(root, "nongit-out-of-scope");
    const started = beginRun(root, task.dir, "nongit-out-of-scope");
    fs.writeFileSync(path.join(root, "docs", "result.md"), "allowed\n");
    fs.writeFileSync(path.join(root, "outside.txt"), "new out-of-scope file\n");

    const observation = observeTaskRunCandidate({
      run: started.run,
      repositoryRoot: root,
    });
    expect(observation.scopeStatus).toBe("out-of-scope");
    expect(observation.outOfScopePaths).toContain("outside.txt");
    expect(() =>
      recordTaskRunResult({
        root,
        taskDir: task.dir,
        expectedRevision: started.kernel.revision,
        runId: started.run.id,
        outcome: "completed",
        summary: "Must not accept out-of-scope file",
        actor: "implementer",
        idempotencyKey: "result:nongit-out-of-scope",
      }),
    ).toThrow(/out-of-scope/);
  });

  it("rejects excluded write paths and over-budget files, then permits a safe retry", () => {
    const root = makeRoot();
    const task = kernelFor(root, "nongit-budget-retry");
    fs.writeFileSync(
      path.join(root, "large.bin"),
      Buffer.alloc(PROJECT_FILE_SNAPSHOT_MAX_FILE_BYTES + 1),
    );
    expect(() => captureProjectFileBaseline(root, ["docs/result.md"])).toThrow(
      /exceeds the 2097152-byte limit/,
    );
    expect(() => captureProjectFileBaseline(root, ["node_modules/result.md"])).toThrow(
      /excluded project path/,
    );

    const current = latestKernel(root, task.dir);
    expect(() =>
      startTaskRun({
        root,
        taskDir: task.dir,
        expectedRevision: current.revision,
        actor: "implementer",
        idempotencyKey: "run:nongit-budget-fails",
        input: { summary: "Write a document", references: [] },
        authorization: {
          approvedBy: "approver",
          approvedAt: "2026-09-26T00:00:00.000Z",
          scope: "one documentation result",
          evidenceRef: "approval.json",
        },
        writeSetSnapshot: ["docs/result.md"],
      }),
    ).toThrow(/exceeds the 2097152-byte limit/);
    expect(latestKernel(root, task.dir).runs).toHaveLength(0);

    fs.rmSync(path.join(root, "large.bin"));
    const manyEntries = path.join(root, "many-entries");
    fs.mkdirSync(manyEntries);
    for (
      let index = 0;
      index <= PROJECT_FILE_SNAPSHOT_MAX_DIRECTORY_ENTRIES;
      index += 1
    ) {
      fs.writeFileSync(
        path.join(manyEntries, `entry-${String(index).padStart(4, "0")}.txt`),
        "x",
      );
    }
    expect(() => captureProjectFileBaseline(root, ["docs/result.md"])).toThrow(
      /exceeds the 4096-entry limit/,
    );
    fs.rmSync(manyEntries, { recursive: true, force: true });
    const retried = beginRun(root, task.dir, "nongit-budget-retry");
    expect(retried.run.candidateFileBaseline).toBeTruthy();
  });

  it("fails closed on symbolic links when the platform permits creating one", () => {
    const root = makeRoot();
    const task = kernelFor(root, "nongit-symlink-recovery");
    const outside = path.join(os.tmpdir(), `pactile-outside-${Date.now()}.txt`);
    roots.push(outside);
    fs.writeFileSync(outside, "outside project\n");
    const link = path.join(root, "linked.txt");
    try {
      fs.symlinkSync(outside, link, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) return;
      throw error;
    }
    expect(() => captureProjectFileBaseline(root, ["docs/result.md"])).toThrow(
      /symbolic link/,
    );
    expect(() => beginRun(root, task.dir, "nongit-symlink-recovery")).toThrow(
      /symbolic link/,
    );
    expect(latestKernel(root, task.dir).runs).toHaveLength(0);

    fs.rmSync(link);
    const retried = beginRun(root, task.dir, "nongit-symlink-recovery");
    expect(retried.run.candidateFileBaseline).toBeTruthy();
  });

  it("detects ordinary new files while keeping documented generated paths excluded", () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
    fs.writeFileSync(path.join(root, ".tmp", "generated.txt"), "ignored\n");
    const baseline = captureProjectFileBaseline(root, ["docs/"]);
    fs.writeFileSync(path.join(root, "docs", "new.md"), "new\n");
    const observation = observeProjectFileCandidate({
      root,
      baseline,
      writeSetSnapshot: ["docs/"],
    });
    expect(baseline.files.map((file) => file.path)).not.toContain(".tmp/generated.txt");
    expect(observation.affectedPaths).toEqual(["docs/new.md"]);
    expect(observation.scopeStatus).toBe("within-write-set");
  });
});
