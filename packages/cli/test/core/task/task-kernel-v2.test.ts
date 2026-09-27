import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runContextCli } from "../../../src/commands/context.js";
import { runTaskCli } from "../../../src/commands/task.js";
import { handleKernelRequest } from "../../../src/core/task/kernel-cli.js";
import {
  addTaskDependency,
  checkTaskClose,
  closeTaskKernel,
  createTaskKernel,
  fingerprintTaskValue,
  projectTaskKernelLifecycle,
  readTaskKernel,
  recordTaskReview,
  recordTaskRunResult,
  resumeTaskRun,
  startTaskRun,
  type TaskDeliveryLevel,
  type TaskKernelSnapshotV2,
} from "../../../src/core/task/index.js";
import { compileSessionPack } from "../../../src/pactile/task/session-pack.js";
import {
  createTaskCandidateEntry,
  observeTaskRunCandidate,
  VERIFICATION_CANDIDATE_ENTRY_REF,
} from "../../../src/core/task/task-candidate-observer.js";
import { parseDeliveryEvidence } from "../../../src/core/task/task-kernel-schema.js";

const roots: string[] = [];
function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined)
    throw new Error(`${label} is missing`);
  return value;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pactile-task-kernel-v2-"),
  );
  roots.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync(
    "git",
    ["config", "user.email", "pactile-tests@example.invalid"],
    { cwd: root, stdio: "ignore" },
  );
  execFileSync("git", ["config", "user.name", "Pactile Tests"], {
    cwd: root,
    stdio: "ignore",
  });
  fs.writeFileSync(path.join(root, ".gitignore"), ".pactile/\n");
  execFileSync("git", ["add", ".gitignore"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "test repository baseline"], {
    cwd: root,
    stdio: "ignore",
  });
  fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=alice\n");
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function bytesFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readV2(root: string, taskDir: string): TaskKernelSnapshotV2 {
  const result = readTaskKernel({ root, taskDir, cwd: root });
  if (result.kind !== "task-kernel-v2")
    throw new Error("expected Task Kernel v2");
  return result.kernel;
}

function createKernelTask(
  root: string,
  taskId: string,
  dependencies: string[] = [],
  acceptanceCriteria = [{ id: "AC-1", description: "produces the required result" }],
  deliveryLevel: TaskDeliveryLevel = "local-result",
): { dir: string; kernel: TaskKernelSnapshotV2 } {
  const dir = path.join(root, ".pactile", "tasks", taskId);
  const result = createTaskKernel({
    root,
    taskDir: dir,
    actor: "author",
    idempotencyKey: `create:${taskId}`,
    definition: {
      taskId, title: taskId, description: "test task", deliverable: "a reviewable local result",
      deliveryLevel, acceptanceCriteria,
      dependencies,
    },
  });
  fs.writeFileSync(path.join(dir, "review.md"), "Independent Review report\n");
  return { dir, kernel: result.kernel };
}

function completeTask(
  root: string,
  taskDir: string,
  taskId: string,
): TaskKernelSnapshotV2 {
  const prepared = prepareReviewableTask(root, taskDir, taskId);
  closeTaskKernel({
    root,
    taskDir,
    expectedRevision: prepared.kernel.revision,
    runId: prepared.run.id,
    reviewId: prepared.review.id,
    candidateObservation: {
      snapshotId: prepared.candidate.id,
      fingerprint: prepared.candidate.fingerprint,
      observedBy: "closer",
      observedAt: "2026-09-25T00:05:00.000Z",
      source: "caller-attested",
      evidenceRef: "candidate-observation.json",
    },
    deliveryEvidence: {
      level: "local-result",
      reference: "result.txt",
      summary: "The deliverable is present",
    },
    actor: "closer",
    idempotencyKey: `close:${taskId}`,
  });
  return readV2(root, taskDir);
}

function prepareReviewableTask(
  root: string,
  taskDir: string,
  taskId: string,
  includeObserverEntry = true,
) {
  let kernel = readV2(root, taskDir);
  const started = startTaskRun({
    root,
    taskDir,
    expectedRevision: kernel.revision,
    actor: "implementer",
    idempotencyKey: `run:${taskId}`,
    input: {
      summary: "Implement the bounded deliverable",
      references: ["task contract"],
    },
    authorization: {
      approvedBy: "approver",
      approvedAt: "2026-09-25T00:00:00.000Z",
      scope: "one result",
      evidenceRef: "approval.json",
    },
    writeSetSnapshot: ["result.txt"],
  });
  const runId = must(started.kernel.runs.at(-1), "started Run").id;
  const startedRun = must(started.kernel.runs.at(-1), "started Run");
  const resultBytes = "reviewable deliverable\n";
  fs.writeFileSync(path.join(root, "result.txt"), resultBytes);
  const candidateObservation = observeTaskRunCandidate({
    run: startedRun,
    repositoryRoot: root,
  });
  kernel = readV2(root, taskDir);
  recordTaskRunResult({
    root,
    taskDir,
    expectedRevision: kernel.revision,
    runId,
    outcome: "completed",
    summary: "Result produced",
    candidateEntries: [
      { ref: "result.txt", fingerprint: bytesFingerprint(resultBytes) },
      ...(includeObserverEntry
        ? [createTaskCandidateEntry(candidateObservation)]
        : []),
    ],
    evidenceRefs: ["result.txt"],
    actor: "implementer",
    idempotencyKey: `result:${taskId}`,
  });
  kernel = readV2(root, taskDir);
  const run = must(kernel.runs.at(-1), "completed Run");
  const candidate = must(run.candidateSnapshot, "Run candidate snapshot");
  recordTaskReview({
    root,
    taskDir,
    expectedRevision: kernel.revision,
    runId,
    candidateSnapshotId: candidate.id,
    candidateFingerprint: candidate.fingerprint,
    reviewer: "reviewer",
    decision: "pass",
    evidenceRefs: ["review.md"],
    acceptanceEvidence: { "AC-1": ["result.txt"] },
    actor: "reviewer",
    idempotencyKey: `review:${taskId}`,
  });
  kernel = readV2(root, taskDir);
  const review = must(kernel.reviews.at(-1), "Review");
  expect(review.evidenceVerification?.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        ref: "result.txt",
        source: "candidate-snapshot",
        sha256: bytesFingerprint(resultBytes),
      }),
      expect.objectContaining({ ref: "review.md", source: "task-evidence" }),
    ]),
  );
  return { kernel, run, candidate, review };
}

describe("Task Kernel v2", () => {
  it("creates a deliverable Task without task.json presets and carries it through CLI, selection, context, Run, Review, and Close", () => {
    const root = makeRoot();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("PACTILE_CONTEXT_ID", "codex_p35_v2");

    expect(
      runTaskCli(
        [
          "create",
          "Example deliverable",
          "--slug",
          "example-deliverable",
          "--description",
          "A focused change",
          "--deliverable",
          "A tested local result",
          "--delivery-level",
          "local-result",
          "--accept",
          "AC-1=The result is testable",
        ],
        root,
      ),
    ).toBe(0);
    const dirName = must(
      fs
        .readdirSync(path.join(root, ".pactile", "tasks"))
        .find((name) => name.endsWith("-example-deliverable")),
      "created V2 Task directory",
    );
    const taskDir = path.join(root, ".pactile", "tasks", dirName);
    fs.writeFileSync(path.join(taskDir, "review.md"), "Review report\n");
    expect(fs.existsSync(path.join(taskDir, "task.json"))).toBe(false);
    let kernel = readV2(root, taskDir);
    expect(kernel).toMatchObject({
      schemaVersion: 2,
      phase: "define",
      definition: {
        taskId: "example-deliverable",
        deliveryLevel: "local-result",
      },
    });
    expect(projectTaskKernelLifecycle(kernel)).toMatchObject({
      approvalSnapshot: { recorded: false, runId: null },
      gateSnapshot: {
        kernelRevision: kernel.revision,
        runStart: {
          phaseAllowsRun: true,
          activeRunId: null,
          dependencyKernelCheckRequired: false,
        },
        review: { phaseAllowsReview: false, runId: null },
        close: {
          phaseAllowsClose: false,
          currentCandidateObservationRequired: true,
          deliveryEvidenceRequired: true,
        },
      },
    });

    expect(runTaskCli(["list"], root)).toBe(0);
    expect(log.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
      `${dirName}/ (define; Kernel v2)`,
    );
    expect(runTaskCli(["show", "example-deliverable"], root)).toBe(0);
    expect(String(log.mock.lastCall?.[0])).toContain("The result is testable");
    expect(runTaskCli(["select", "example-deliverable"], root)).toBe(0);
    expect(runTaskCli(["selected", "--json"], root)).toBe(0);
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
      taskId: "example-deliverable",
      phase: "define",
      kernelVersion: 2,
    });
    expect(runContextCli(["--mode", "record", "--json"], root)).toBe(0);
    expect(
      JSON.parse(String(log.mock.lastCall?.[0])).selectedTask,
    ).toMatchObject({
      name: "Example deliverable",
      phase: "define",
      kernelVersion: 2,
    });
    const sessionPack = compileSessionPack(root);
    expect(sessionPack.kernel).toMatchObject({
      taskId: "example-deliverable",
      schemaVersion: 2,
      phase: "define",
      deliveryLevel: "local-result",
    });
    expect(JSON.stringify(sessionPack)).not.toContain("Rigor=lite");

    git(root, "switch", "-c", "feat/example");
    const baseSha = git(root, "rev-parse", "HEAD");
    const runStartArgs = [
      "run-start",
      "example-deliverable",
      "--actor",
      "alice",
      "--input-summary",
      "Implement AC-1",
      "--input-ref",
      "definition",
      "--approved-by",
      "approver",
      "--authorization-scope",
      "src/result.txt",
      "--authorization-evidence",
      "approval.json",
      "--workspace-path",
      root,
      "--branch",
      "feat/example",
      "--base-sha",
      baseSha,
      "--write-set",
      "src/result.txt",
      "--host",
      "local-codex",
      "--role",
      "implementer",
      "--session-id",
      "session-1",
      "--thread-id",
      "thread-1",
      "--request-ref",
      "request.json",
      "--estimate-execution-ms",
      "30000",
      "--estimate-waiting-ms",
      "5000",
      "--estimate-review-ms",
      "8000",
    ];
    expect(runTaskCli(runStartArgs, root)).toBe(0);
    kernel = readV2(root, taskDir);
    const run = must(kernel.runs.at(-1), "started Run");
    expect(run).toMatchObject({
      attempt: 1,
      state: "running",
      writeSetSnapshot: ["src/result.txt"],
      estimatedDurations: {
        executionMs: 30000,
        waitingMs: 5000,
        reviewMs: 8000,
      },
    });
    expect(projectTaskKernelLifecycle(kernel)).toMatchObject({
      approvalSnapshot: {
        recorded: true,
        runId: run.id,
        approvedBy: "approver",
        evidenceRef: "approval.json",
      },
      gateSnapshot: {
        kernelRevision: kernel.revision,
        runStart: { phaseAllowsRun: true, activeRunId: run.id },
      },
    });
    expect(run.workspace).toMatchObject({
      ownerRunId: run.id,
      canonicalPath: root,
      branch: "feat/example",
      writeSet: ["src/result.txt"],
    });
    expect(run.host).toMatchObject({
      host: "local-codex",
      role: "implementer",
      sessionId: "session-1",
      threadId: "thread-1",
      requestRefs: ["request.json"],
    });
    expect(runTaskCli(runStartArgs, root)).toBe(0);
    expect(readV2(root, taskDir).runs).toHaveLength(1);

    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "result.txt"), "CLI result\n");
    fs.writeFileSync(path.join(taskDir, "tests.txt"), "verification passed\n");
    const entryFingerprint = bytesFingerprint("CLI result\n");
    expect(
      runTaskCli(
        [
          "run-result",
          "example-deliverable",
          run.id,
          "--outcome",
          "completed",
          "--summary",
          "Result ready",
          "--evidence",
          "tests.txt",
          "--candidate",
          `src/result.txt=${entryFingerprint}`,
        ],
        root,
      ),
    ).toBe(0);
    kernel = readV2(root, taskDir);
    const candidate = must(
      must(kernel.runs.at(-1), "completed Run").candidateSnapshot,
      "candidate snapshot",
    );
    expect(candidate.id).toBeTruthy();
    expect(candidate.fingerprint).toBe(fingerprintTaskValue(candidate.entries));
    const reviewArgs = [
      "review",
      "example-deliverable",
      "--actor",
      "reviewer",
      "--run",
      run.id,
      "--candidate-id",
      candidate.id,
      "--candidate-fingerprint",
      candidate.fingerprint,
      "--reviewer",
      "reviewer",
      "--decision",
      "pass",
      "--evidence",
      "review.md",
      "--criterion",
      "AC-1=src/result.txt",
      "--review-measurement-ref",
      "review-metrics.json",
    ];
    expect(runTaskCli(reviewArgs, root)).toBe(0);
    kernel = readV2(root, taskDir);
    const review = must(kernel.reviews.at(-1), "Review");
    expect(review).toMatchObject({
      candidateSnapshotId: candidate.id,
      candidateFingerprint: candidate.fingerprint,
      decision: "pass",
      unresolvedBlockers: [],
    });
    expect(kernel.runs.at(-1)?.measurementRefs.review).toBe(
      "review-metrics.json",
    );
    expect(runTaskCli(reviewArgs, root)).toBe(0);
    expect(readV2(root, taskDir).reviews).toHaveLength(1);
    expect(projectTaskKernelLifecycle(kernel).gateSnapshot).toMatchObject({
      kernelRevision: kernel.revision,
      review: {
        phaseAllowsReview: true,
        runId: run.id,
        candidateSnapshotId: candidate.id,
        latestReviewId: review.id,
        latestDecision: "pass",
      },
      close: {
        phaseAllowsClose: true,
        runId: run.id,
        reviewId: review.id,
        candidateSnapshotId: candidate.id,
        missingAcceptanceCriteria: [],
      },
    });

    const closeArgs = [
      "close",
      "example-deliverable",
      "--run",
      run.id,
      "--review",
      review.id,
      "--candidate-id",
      candidate.id,
      "--candidate-fingerprint",
      candidate.fingerprint,
      "--candidate-observed-by",
      "closer",
      "--candidate-observation-source",
      "caller-attested",
      "--candidate-observation-ref",
      "snapshot-observation.json",
      "--delivery-level",
      "local-result",
      "--delivery-ref",
      "src/result.txt",
      "--delivery-summary",
      "The reviewed result is present",
    ];
    expect(runTaskCli([...closeArgs, "--check"], root)).toBe(0);
    expect(String(log.mock.lastCall?.[0])).toContain(
      "re-observes current project state against the frozen Run candidate",
    );
    expect(runTaskCli(closeArgs, root)).toBe(0);
    kernel = readV2(root, taskDir);
    expect(projectTaskKernelLifecycle(kernel)).toMatchObject({
      taskId: "example-deliverable",
      phase: "close",
      closed: true,
      deliveryLevel: "local-result",
    });
    expect(kernel.closure?.candidateObservation).toMatchObject({
      snapshotId: candidate.id,
      fingerprint: candidate.fingerprint,
      source: "git-working-tree-v1",
      evidenceRef: "pactile:verification:git-working-tree-v1",
    });
    expect(kernel.closure?.deliveryVerification).toMatchObject({
      source: "pactile-task-delivery-observer-v1",
      candidateFingerprint: candidate.fingerprint,
      candidateHead: baseSha,
      path: "src/result.txt",
    });
    expect(runTaskCli(["list", "--status", "completed"], root)).toBe(0);
    expect(log.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
      "example-deliverable/ (closed; Kernel v2)",
    );
  });

  it("keeps 0.5.x Tasks readable through the unified reader without migrating them", () => {
    const root = makeRoot();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      runTaskCli(["create", "Legacy task", "--slug", "legacy-task"], root),
    ).toBe(1);
    expect(
      runTaskCli(
        ["legacy-create", "Legacy task", "--slug", "legacy-task"],
        root,
      ),
    ).toBe(0);
    const taskDirName = must(
      fs
        .readdirSync(path.join(root, ".pactile", "tasks"))
        .find((name) => name.endsWith("-legacy-task")),
      "created legacy Task directory",
    );
    const taskDir = path.join(root, ".pactile", "tasks", taskDirName);
    const before = fs.readFileSync(path.join(taskDir, "kernel.json"), "utf8");
    const read = readTaskKernel({ root, taskDir, cwd: root });
    expect(read.kind).toBe("legacy-task-kernel-v1");
    expect(fs.readFileSync(path.join(taskDir, "kernel.json"), "utf8")).toBe(
      before,
    );
    expect(runTaskCli(["show", "legacy-task"], root)).toBe(0);
    expect(String(log.mock.calls.map(([line]) => line).join("\n"))).toContain(
      "legacy-task",
    );
  });

  it("requires a current candidate observation, the latest Run, a distinct Reviewer, complete evidence, and no blockers", () => {
    const root = makeRoot();
    const { dir } = createKernelTask(root, "freshness-check");
    let kernel = readV2(root, dir);
    const started = startTaskRun({
      root,
      taskDir: dir,
      expectedRevision: kernel.revision,
      actor: "implementer",
      idempotencyKey: "fresh-run",
      input: { summary: "work", references: [] },
      authorization: {
        approvedBy: "approver",
        approvedAt: "2026-09-25",
        scope: "scope",
        evidenceRef: "approval",
      },
      writeSetSnapshot: ["result"],
    });
    const runId = must(started.kernel.runs.at(-1), "started Run").id;
    const startedRun = must(started.kernel.runs.at(-1), "started Run");
    fs.writeFileSync(path.join(root, "result"), "fresh result\n");
    const observerEntry = createTaskCandidateEntry(
      observeTaskRunCandidate({ run: startedRun, repositoryRoot: root }),
    );
    kernel = readV2(root, dir);
    recordTaskRunResult({
      root,
      taskDir: dir,
      expectedRevision: kernel.revision,
      runId,
      outcome: "completed",
      summary: "done",
      candidateEntries: [
        { ref: "result", fingerprint: bytesFingerprint("fresh result\n") },
        observerEntry,
      ],
      evidenceRefs: [],
      actor: "implementer",
      idempotencyKey: "fresh-result",
    });
    kernel = readV2(root, dir);
    const run = must(kernel.runs.at(-1), "completed Run");
    const candidate = must(run.candidateSnapshot, "candidate snapshot");
    expect(() =>
      recordTaskReview({
        root,
        taskDir: dir,
        expectedRevision: kernel.revision,
        runId,
        candidateSnapshotId: candidate.id,
        candidateFingerprint: candidate.fingerprint,
        reviewer: "reviewer",
        decision: "pass",
        evidenceRefs: ["tests/verify.txt"],
        acceptanceEvidence: { "AC-1": ["result"] },
        actor: "reviewer",
        idempotencyKey: "missing-file-review",
      }),
    ).toThrow(/does not exist/);
    expect(() =>
      recordTaskReview({
        root,
        taskDir: dir,
        expectedRevision: kernel.revision,
        runId,
        candidateSnapshotId: candidate.id,
        candidateFingerprint: candidate.fingerprint,
        reviewer: "reviewer",
        decision: "pass",
        evidenceRefs: ["result"],
        acceptanceEvidence: { "AC-1": ["result"] },
        actor: "implementer",
        idempotencyKey: "forged-review-actor",
      }),
    ).toThrow(/actor must match the recorded reviewer/);
    expect(() =>
      recordTaskReview({
        root,
        taskDir: dir,
        expectedRevision: kernel.revision,
        runId,
        candidateSnapshotId: candidate.id,
        candidateFingerprint: candidate.fingerprint,
        reviewer: "implementer",
        decision: "pass",
        evidenceRefs: ["result"],
        acceptanceEvidence: { "AC-1": ["result"] },
        actor: "implementer",
        idempotencyKey: "self-review",
      }),
    ).toThrow(/other than the Run executor/);
    expect(() =>
      recordTaskReview({
        root,
        taskDir: dir,
        expectedRevision: kernel.revision,
        runId,
        candidateSnapshotId: candidate.id,
        candidateFingerprint: candidate.fingerprint,
        reviewer: "reviewer",
        decision: "pass",
        evidenceRefs: ["result"],
        acceptanceEvidence: { "AC-1": ["result"] },
        unresolvedBlockers: ["open issue"],
        actor: "reviewer",
        idempotencyKey: "blocked-review",
      }),
    ).toThrow(/unresolved blockers/);
    recordTaskReview({
      root,
      taskDir: dir,
      expectedRevision: kernel.revision,
      runId,
      candidateSnapshotId: candidate.id,
      candidateFingerprint: candidate.fingerprint,
      reviewer: "reviewer",
      decision: "pass",
      evidenceRefs: ["result"],
      acceptanceEvidence: { "AC-1": ["result"] },
      actor: "reviewer",
      idempotencyKey: "valid-review",
    });
    kernel = readV2(root, dir);
    const review = must(kernel.reviews.at(-1), "Review");
    const observation = {
      snapshotId: candidate.id,
      fingerprint: candidate.fingerprint,
      observedBy: "closer",
      observedAt: "now",
      source: "caller-attested",
      evidenceRef: "observation.json",
    };
    const deliveryEvidence = {
      level: "local-result" as const,
      reference: "result",
      summary: "present",
    };
    expect(
      checkTaskClose({
        root,
        taskDir: dir,
        expectedRevision: kernel.revision,
        runId,
        reviewId: review.id,
        candidateObservation: { ...observation, fingerprint: "d".repeat(64) },
        deliveryEvidence,
      }).join("\n"),
    ).toContain("Close request must name");
    expect(
      checkTaskClose({
        root,
        taskDir: dir,
        expectedRevision: kernel.revision,
        runId,
        reviewId: review.id,
        candidateObservation: observation,
        deliveryEvidence,
      }),
    ).toEqual([]);
  });

  it("Core adds its observed candidate entry when callers omit it and rejects files edited after Run completion", () => {
    const root = makeRoot();
    const firstTask = createKernelTask(root, "missing-observer");
    const withoutObserver = prepareReviewableTask(
      root,
      firstTask.dir,
      "missing-observer",
      false,
    );
    const callerObservation = {
      snapshotId: withoutObserver.candidate.id,
      fingerprint: withoutObserver.candidate.fingerprint,
      observedBy: "closer",
      observedAt: "now",
      source: "caller-attested",
      evidenceRef: "candidate.json",
    };
    const deliveryEvidence = {
      level: "local-result" as const,
      reference: "result.txt",
      summary: "present",
    };
    const missingEntryErrors = checkTaskClose({
      root,
      taskDir: firstTask.dir,
      expectedRevision: withoutObserver.kernel.revision,
      runId: withoutObserver.run.id,
      reviewId: withoutObserver.review.id,
      candidateObservation: callerObservation,
      deliveryEvidence,
    });
    expect(missingEntryErrors).toEqual([]);
    expect(
      withoutObserver.candidate.entries.find(
        (entry) => entry.ref === VERIFICATION_CANDIDATE_ENTRY_REF,
      )?.fingerprint,
    ).toBeTruthy();

    const secondTask = createKernelTask(root, "stale-after-run");
    const prepared = prepareReviewableTask(
      root,
      secondTask.dir,
      "stale-after-run",
    );
    fs.writeFileSync(
      path.join(root, "result.txt"),
      "edited after Run completion\n",
    );
    const staleErrors = checkTaskClose({
      root,
      taskDir: secondTask.dir,
      expectedRevision: prepared.kernel.revision,
      runId: prepared.run.id,
      reviewId: prepared.review.id,
      candidateObservation: {
        snapshotId: prepared.candidate.id,
        fingerprint: prepared.candidate.fingerprint,
        observedBy: "closer",
        observedAt: "now",
        source: "caller-attested",
        evidenceRef: "candidate.json",
      },
      deliveryEvidence,
    });
    expect(staleErrors.join("\n")).toContain("Run candidate is stale");
    expect(() =>
      closeTaskKernel({
        root,
        taskDir: secondTask.dir,
        expectedRevision: prepared.kernel.revision,
        runId: prepared.run.id,
        reviewId: prepared.review.id,
        candidateObservation: callerObservation,
        deliveryEvidence,
        actor: "closer",
        idempotencyKey: "stale-after-run-close",
      }),
    ).toThrow(/Run candidate is stale/);
  });

  it("rejects caller-supplied candidate hashes that do not match current Run files", () => {
    const root = makeRoot();
    const task = createKernelTask(root, "forged-candidate-entry");
    const started = startTaskRun({
      root,
      taskDir: task.dir,
      expectedRevision: task.kernel.revision,
      actor: "implementer",
      idempotencyKey: "forged-candidate-start",
      input: { summary: "work", references: [] },
      authorization: {
        approvedBy: "approver",
        approvedAt: "now",
        scope: "result.txt",
        evidenceRef: "approval",
      },
      writeSetSnapshot: ["result.txt"],
    });
    const run = must(started.kernel.runs.at(-1), "started Run");
    fs.writeFileSync(path.join(root, "result.txt"), "actual result\n");

    expect(() =>
      recordTaskRunResult({
        root,
        taskDir: task.dir,
        expectedRevision: started.kernel.revision,
        runId: run.id,
        outcome: "completed",
        summary: "done",
        candidateEntries: [
          { ref: "result.txt", fingerprint: "0".repeat(64) },
        ],
        actor: "implementer",
        idempotencyKey: "forged-candidate-result",
      }),
    ).toThrow(/does not match a regular file in the Run write set/);

    const after = readV2(root, task.dir);
    expect(after.revision).toBe(started.kernel.revision);
    expect(after.runs.at(-1)?.state).toBe("running");
  });

  it("freezes Run evidence bytes at completion and rejects later drift", () => {
    const root = makeRoot();
    const task = createKernelTask(root, "run-evidence-drift");
    const evidencePath = path.join(task.dir, "run-evidence.txt");
    fs.writeFileSync(evidencePath, "captured at Run completion\n");
    const started = startTaskRun({
      root,
      taskDir: task.dir,
      expectedRevision: task.kernel.revision,
      actor: "implementer",
      idempotencyKey: "run-evidence-start",
      input: { summary: "work", references: [] },
      authorization: {
        approvedBy: "approver",
        approvedAt: "now",
        scope: "task evidence",
        evidenceRef: "approval",
      },
    });
    const run = must(started.kernel.runs.at(-1), "started Run");
    const completed = recordTaskRunResult({
      root,
      taskDir: task.dir,
      expectedRevision: started.kernel.revision,
      runId: run.id,
      outcome: "completed",
      summary: "done",
      evidenceRefs: ["run-evidence.txt"],
      actor: "implementer",
      idempotencyKey: "run-evidence-result",
    });
    const completedRun = must(completed.kernel.runs.at(-1), "completed Run");
    const verification = completedRun.result?.evidenceVerification;
    expect(verification?.items).toEqual([
      expect.objectContaining({
        ref: "run-evidence.txt",
        source: "task-evidence",
        sha256: bytesFingerprint("captured at Run completion\n"),
      }),
    ]);
    const candidate = must(completedRun.candidateSnapshot, "candidate snapshot");

    fs.writeFileSync(evidencePath, "changed after Run completion\n");
    expect(() =>
      recordTaskReview({
        root,
        taskDir: task.dir,
        expectedRevision: completed.kernel.revision,
        runId: run.id,
        candidateSnapshotId: candidate.id,
        candidateFingerprint: candidate.fingerprint,
        reviewer: "reviewer",
        decision: "pass",
        evidenceRefs: ["run-evidence.txt"],
        acceptanceEvidence: { "AC-1": ["run-evidence.txt"] },
        actor: "reviewer",
        idempotencyKey: "run-evidence-drift-review",
      }),
    ).toThrow(/completion-time digest/);

    fs.writeFileSync(evidencePath, "captured at Run completion\n");
    const reviewed = recordTaskReview({
      root,
      taskDir: task.dir,
      expectedRevision: completed.kernel.revision,
      reviewId: "stable-p40-review-artifact-id",
      runId: run.id,
      candidateSnapshotId: candidate.id,
      candidateFingerprint: candidate.fingerprint,
      reviewer: "reviewer",
      decision: "pass",
      evidenceRefs: ["run-evidence.txt"],
      acceptanceEvidence: { "AC-1": ["run-evidence.txt"] },
      actor: "reviewer",
      idempotencyKey: "run-evidence-restored-review",
    });
    expect(reviewed.kernel.reviews.at(-1)?.id).toBe(
      "stable-p40-review-artifact-id",
    );
    expect(reviewed.kernel.reviews.at(-1)?.evidenceVerification?.items).toEqual(
      [
        expect.objectContaining({
          ref: "run-evidence.txt",
          source: "run-evidence",
          sha256: bytesFingerprint("captured at Run completion\n"),
        }),
      ],
    );
  });

  it("rejects unsafe delivery paths even when the caller supplies a valid candidate ID", () => {
    const root = makeRoot();
    const task = createKernelTask(root, "unsafe-delivery-path");
    const prepared = prepareReviewableTask(
      root,
      task.dir,
      "unsafe-delivery-path",
    );
    const errors = checkTaskClose({
      root,
      taskDir: task.dir,
      expectedRevision: prepared.kernel.revision,
      runId: prepared.run.id,
      reviewId: prepared.review.id,
      candidateObservation: {
        snapshotId: prepared.candidate.id,
        fingerprint: prepared.candidate.fingerprint,
        observedBy: "closer",
        observedAt: "now",
        source: "caller-attested",
        evidenceRef: "candidate.json",
      },
      deliveryEvidence: {
        level: "local-result",
        reference: "result.txt",
        path: "../outside.txt",
        summary: "forged path",
      },
    });
    expect(errors.join("\n")).toContain("safe repository-relative path");
  });

  it("requires the latest Review verdict for the exact candidate before Close", () => {
    const root = makeRoot();
    const task = createKernelTask(root, "latest-review-only");
    const started = startTaskRun({
      root, taskDir: task.dir, expectedRevision: task.kernel.revision, actor: "implementer", idempotencyKey: "latest-review-run",
      input: { summary: "work", references: [] }, authorization: { approvedBy: "approver", approvedAt: "now", scope: "scope", evidenceRef: "approval" },
      writeSetSnapshot: ["result.txt"],
    });
    const runId = must(started.kernel.runs.at(-1), "Run").id;
    const startedRun = must(started.kernel.runs.at(-1), "started Run");
    const resultBytes = "result.txt result\n";
    fs.writeFileSync(path.join(root, "result.txt"), resultBytes);
    const observerEntry = createTaskCandidateEntry(
      observeTaskRunCandidate({ run: startedRun, repositoryRoot: root }),
    );
    const result = recordTaskRunResult({
      root, taskDir: task.dir, expectedRevision: started.kernel.revision, runId, outcome: "completed", summary: "done",
      candidateEntries: [
        { ref: "result.txt", fingerprint: bytesFingerprint(resultBytes) },
        observerEntry,
      ], actor: "implementer", idempotencyKey: "latest-review-result",
    });
    const candidate = must(must(result.kernel.runs.at(-1), "completed Run").candidateSnapshot, "candidate");
    const first = recordTaskReview({
      root, taskDir: task.dir, expectedRevision: result.kernel.revision, runId, candidateSnapshotId: candidate.id,
      candidateFingerprint: candidate.fingerprint, reviewer: "reviewer", decision: "needs-changes", evidenceRefs: ["result.txt"],
      acceptanceEvidence: {}, actor: "reviewer", idempotencyKey: "latest-review-first",
    });
    const later = recordTaskReview({
      root, taskDir: task.dir, expectedRevision: first.kernel.revision, runId, candidateSnapshotId: candidate.id,
      candidateFingerprint: candidate.fingerprint, reviewer: "reviewer", decision: "pass", evidenceRefs: ["result.txt"],
      acceptanceEvidence: { "AC-1": ["result.txt"] }, actor: "reviewer", idempotencyKey: "latest-review-second",
    });
    const earlierReview = must(first.kernel.reviews.at(-1), "earlier Review");
    const latestReview = must(later.kernel.reviews.at(-1), "latest Review");
    const observation = { snapshotId: candidate.id, fingerprint: candidate.fingerprint, observedBy: "closer", observedAt: "now", source: "caller", evidenceRef: "observation.json" };
    const deliveryEvidence = { level: "local-result" as const, reference: "result.txt", summary: "present" };

    expect(checkTaskClose({
      root, taskDir: task.dir, expectedRevision: later.kernel.revision, runId, reviewId: earlierReview.id,
      candidateObservation: observation, deliveryEvidence,
    }).join("\n")).toContain("the latest Review for the selected candidate must be used");
    expect(checkTaskClose({
      root, taskDir: task.dir, expectedRevision: later.kernel.revision, runId, reviewId: latestReview.id,
      candidateObservation: observation, deliveryEvidence,
    })).toEqual([]);
    expect(closeTaskKernel({
      root, taskDir: task.dir, expectedRevision: later.kernel.revision, runId, reviewId: latestReview.id,
      candidateObservation: observation, deliveryEvidence, actor: "closer", idempotencyKey: "latest-review-close",
    }).kernel.closure?.reviewId).toBe(latestReview.id);
  });

  it("persists empty acceptance refs for non-passing Reviews while keeping pass and Close blocked", () => {
    for (const decision of ["fail", "needs-changes"] as const) {
      const root = makeRoot();
      const taskId = `empty-acceptance-${decision}`;
      const task = createKernelTask(root, taskId);
      const prepared = prepareReviewableTask(root, task.dir, taskId);
      const current = readV2(root, task.dir);

      expect(() =>
        recordTaskReview({
          root,
          taskDir: task.dir,
          expectedRevision: current.revision,
          runId: prepared.run.id,
          candidateSnapshotId: prepared.candidate.id,
          candidateFingerprint: prepared.candidate.fingerprint,
          reviewer: "reviewer",
          decision: "pass",
          evidenceRefs: ["review.md"],
          acceptanceEvidence: { "AC-1": [] },
          actor: "reviewer",
          idempotencyKey: `empty-acceptance-pass-${decision}`,
        }),
      ).toThrow(/must contain at least one reference/);

      const recorded = recordTaskReview({
        root,
        taskDir: task.dir,
        expectedRevision: current.revision,
        runId: prepared.run.id,
        candidateSnapshotId: prepared.candidate.id,
        candidateFingerprint: prepared.candidate.fingerprint,
        reviewer: "reviewer",
        decision,
        evidenceRefs: ["review.md"],
        acceptanceEvidence: { "AC-1": [] },
        actor: "reviewer",
        idempotencyKey: `empty-acceptance-${decision}`,
      });
      const readBack = readV2(root, task.dir);
      const review = must(readBack.reviews.at(-1), "non-passing Review");

      expect(review.decision).toBe(decision);
      expect(review.acceptanceEvidence).toEqual({ "AC-1": [] });
      expect(review.evidenceRefs).toEqual(["review.md"]);
      expect(review.evidenceVerification?.items).toEqual([
        expect.objectContaining({
          ref: "review.md",
          sha256: bytesFingerprint("Independent Review report\n"),
          source: "task-evidence",
        }),
      ]);
      expect(recorded.kernel.revision).toBe(readBack.revision);

      const closeErrors = checkTaskClose({
        root,
        taskDir: task.dir,
        expectedRevision: readBack.revision,
        runId: prepared.run.id,
        reviewId: review.id,
        candidateObservation: {
          snapshotId: prepared.candidate.id,
          fingerprint: prepared.candidate.fingerprint,
          observedBy: "closer",
          observedAt: "now",
          source: "caller",
          evidenceRef: "candidate-observation.json",
        },
        deliveryEvidence: {
          level: "local-result",
          reference: "result.txt",
          summary: "present",
        },
      });
      expect(closeErrors).toContain(
        "the latest Review for the selected candidate must pass",
      );
      expect(closeErrors).toContain("acceptance evidence missing for AC-1");
    }
  });

  it("continues to reject empty acceptance refs in stored Closure state", () => {
    const root = makeRoot();
    const taskId = "closure-empty-acceptance";
    const task = createKernelTask(root, taskId);
    const prepared = prepareReviewableTask(root, task.dir, taskId);
    const closed = closeTaskKernel({
      root,
      taskDir: task.dir,
      expectedRevision: prepared.kernel.revision,
      runId: prepared.run.id,
      reviewId: prepared.review.id,
      candidateObservation: {
        snapshotId: prepared.candidate.id,
        fingerprint: prepared.candidate.fingerprint,
        observedBy: "closer",
        observedAt: "now",
        source: "caller",
        evidenceRef: "candidate-observation.json",
      },
      deliveryEvidence: {
        level: "local-result",
        reference: "result.txt",
        summary: "present",
      },
      actor: "closer",
      idempotencyKey: "close-with-complete-acceptance",
    });
    expect(closed.kernel.closure?.acceptanceEvidence).toEqual({
      "AC-1": ["result.txt"],
    });

    const kernelPath = path.join(task.dir, "kernel.json");
    const persisted = JSON.parse(fs.readFileSync(kernelPath, "utf8")) as {
      closure: { acceptanceEvidence: Record<string, string[]> };
    };
    persisted.closure.acceptanceEvidence = { "AC-1": [] };
    fs.writeFileSync(kernelPath, JSON.stringify(persisted) + "\n", "utf8");

    expect(() =>
      readTaskKernel({ root, taskDir: task.dir, cwd: root }),
    ).toThrow(
      /closure.acceptanceEvidence.AC-1 must contain at least one reference/,
    );
  });

  it("accepts only delivery evidence matching each of the four Task delivery levels", () => {
    const cases: { level: TaskDeliveryLevel; reference: string; mismatch: TaskDeliveryLevel }[] = [
      { level: "local-result", reference: "dist/result.txt", mismatch: "documentation" },
      { level: "pull-request", reference: "https://example.test/review/17", mismatch: "local-result" },
      { level: "merged-result", reference: "https://example.test/commit/abc123", mismatch: "pull-request" },
      { level: "documentation", reference: "docs/guide.md", mismatch: "merged-result" },
    ];

    for (const { level, reference, mismatch } of cases) {
      const matching = { level, reference, summary: "required deliverable is present" };
      const wrong = { ...matching, level: mismatch };

      expect(() => parseDeliveryEvidence(wrong, level)).toThrow(
        `Task requires delivery level ${level}, got ${mismatch}`,
      );
      expect(parseDeliveryEvidence(matching, level)).toEqual(matching);
    }
  });

  it("binds reads and every lifecycle mutation to the canonical project root", () => {
    const rootA = makeRoot();
    const rootB = makeRoot();
    const prerequisiteA = createKernelTask(rootA, "shared-dependency");
    const dependentA = createKernelTask(rootA, "dependent-a", [
      "shared-dependency",
    ]);
    const prerequisiteB = createKernelTask(rootB, "shared-dependency");
    completeTask(rootB, prerequisiteB.dir, "shared-dependency");

    expect(() =>
      readTaskKernel({ root: rootB, taskDir: dependentA.dir, cwd: rootB }),
    ).toThrow(/supplied project's .pactile\/tasks tree/);
    expect(() =>
      startTaskRun({
        root: rootB,
        taskDir: dependentA.dir,
        expectedRevision: dependentA.kernel.revision,
        actor: "implementer",
        idempotencyKey: "cross-root-start",
        input: { summary: "work", references: [] },
        authorization: {
          approvedBy: "approver",
          approvedAt: "now",
          scope: "scope",
          evidenceRef: "approval",
        },
      }),
    ).toThrow(/supplied project's .pactile\/tasks tree/);

    const targetA = createKernelTask(rootA, "target-a");
    const prepared = prepareReviewableTask(rootA, targetA.dir, "target-a");
    expect(() =>
      closeTaskKernel({
        root: rootB,
        taskDir: targetA.dir,
        expectedRevision: prepared.kernel.revision,
        runId: prepared.run.id,
        reviewId: prepared.review.id,
        candidateObservation: {
          snapshotId: prepared.candidate.id,
          fingerprint: prepared.candidate.fingerprint,
          observedBy: "closer",
          observedAt: "now",
          source: "caller",
          evidenceRef: "observation",
        },
        deliveryEvidence: {
          level: "local-result",
          reference: "result.txt",
          summary: "present",
        },
        actor: "closer",
        idempotencyKey: "cross-root-close",
      }),
    ).toThrow(/supplied project's .pactile\/tasks tree/);
    expect(readV2(rootA, targetA.dir).phase).toBe("verify");
    expect(prerequisiteA.kernel.phase).toBe("define");
  });

  it("normalizes relative roots once across project lookup, dependency gates, Run, and Close", () => {
    const rootA = makeRoot();
    const rootB = makeRoot();
    createKernelTask(rootA, "scope-dependency");
    completeTask(
      rootB,
      createKernelTask(rootB, "scope-dependency").dir,
      "scope-dependency",
    );
    createKernelTask(rootB, "b-only-dependency");
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(rootB);
    try {
      const relativeTargetDir = path.join(
        ".pactile",
        "tasks",
        "relative-target",
      );
      const relativeTarget = createTaskKernel({
        root: ".",
        taskDir: relativeTargetDir,
        cwd: rootA,
        actor: "author",
        idempotencyKey: "relative-target-create",
        definition: {
          taskId: "relative-target",
          title: "Relative target",
          description: "",
          deliverable: "target result",
          deliveryLevel: "local-result",
          acceptanceCriteria: [{ id: "AC-1", description: "result exists" }],
          dependencies: ["scope-dependency"],
        },
      });
      expect(
        readTaskKernel({ root: ".", taskDir: relativeTargetDir, cwd: rootA }),
      ).toMatchObject({
        kind: "task-kernel-v2",
        kernel: {
          identity: { taskId: "relative-target" },
          definition: { dependencies: ["scope-dependency"] },
        },
      });
      expect(
        handleKernelRequest(
          { op: "task-read", taskDir: relativeTargetDir, cwd: rootA },
          { cwd: rootB },
        ),
      ).toMatchObject({
        ok: true,
        op: "task-read",
        result: {
          kind: "task-kernel-v2",
          kernel: { identity: { taskId: "relative-target" } },
        },
      });
      expect(() =>
        startTaskRun({
          root: ".",
          taskDir: relativeTargetDir,
          cwd: rootA,
          expectedRevision: relativeTarget.kernel.revision,
          actor: "implementer",
          idempotencyKey: "relative-start",
          input: { summary: "work", references: [] },
          authorization: {
            approvedBy: "approver",
            approvedAt: "now",
            scope: "scope",
            evidenceRef: "approval",
          },
        }),
      ).toThrow(/hard dependencies must be closed successfully/);

      const lifecycleDir = path.join(".pactile", "tasks", "relative-lifecycle");
      const lifecycle = createTaskKernel({
        root: ".",
        taskDir: lifecycleDir,
        cwd: rootA,
        actor: "author",
        idempotencyKey: "relative-lifecycle-create",
        definition: {
          taskId: "relative-lifecycle",
          title: "Relative lifecycle",
          description: "",
          deliverable: "lifecycle result",
          deliveryLevel: "local-result",
          acceptanceCriteria: [{ id: "AC-1", description: "result exists" }],
          dependencies: [],
        },
      });
      fs.writeFileSync(
        path.join(rootA, lifecycleDir, "review.md"),
        "Review report\n",
      );
      const queued = startTaskRun({
        root: ".",
        taskDir: lifecycleDir,
        cwd: rootA,
        expectedRevision: lifecycle.kernel.revision,
        actor: "implementer",
        idempotencyKey: "relative-lifecycle-run",
        input: { summary: "work", references: [] },
        authorization: {
          approvedBy: "approver",
          approvedAt: "now",
          scope: "scope",
          evidenceRef: "approval",
        },
        initialState: "waiting",
        writeSetSnapshot: ["result.txt"],
      });
      const lifecycleRunId = must(
        queued.kernel.runs.at(-1),
        "relative waiting Run",
      ).id;
      const resumed = resumeTaskRun({
        root: ".",
        taskDir: lifecycleDir,
        cwd: rootA,
        expectedRevision: queued.kernel.revision,
        runId: lifecycleRunId,
        actor: "scheduler",
        idempotencyKey: "relative-lifecycle-resume",
      });
      fs.writeFileSync(
        path.join(rootA, "result.txt"),
        "relative lifecycle result\n",
      );
      const resumedRun = must(
        resumed.kernel.runs.at(-1),
        "resumed relative Run",
      );
      const relativeCandidateObservation = observeTaskRunCandidate({
        run: resumedRun,
        repositoryRoot: rootA,
      });
      const result = recordTaskRunResult({
        root: ".",
        taskDir: lifecycleDir,
        cwd: rootA,
        expectedRevision: resumed.kernel.revision,
        runId: lifecycleRunId,
        outcome: "completed",
        summary: "done",
        candidateEntries: [
          {
            ref: "result.txt",
            fingerprint: bytesFingerprint("relative lifecycle result\n"),
          },
          createTaskCandidateEntry(relativeCandidateObservation),
        ],
        actor: "implementer",
        idempotencyKey: "relative-lifecycle-result",
      });
      const candidate = must(
        must(result.kernel.runs.at(-1), "relative completed Run")
          .candidateSnapshot,
        "relative candidate snapshot",
      );
      const reviewed = recordTaskReview({
        root: ".",
        taskDir: lifecycleDir,
        cwd: rootA,
        expectedRevision: result.kernel.revision,
        runId: lifecycleRunId,
        candidateSnapshotId: candidate.id,
        candidateFingerprint: candidate.fingerprint,
        reviewer: "reviewer",
        decision: "pass",
        evidenceRefs: ["review.md"],
        acceptanceEvidence: { "AC-1": ["result.txt"] },
        actor: "reviewer",
        idempotencyKey: "relative-lifecycle-review",
      });
      const review = must(reviewed.kernel.reviews.at(-1), "relative Review");
      const observation = {
        snapshotId: candidate.id,
        fingerprint: candidate.fingerprint,
        observedBy: "closer",
        observedAt: "now",
        source: "caller",
        evidenceRef: "observation",
      };
      const deliveryEvidence = {
        level: "local-result" as const,
        reference: "result.txt",
        summary: "present",
      };
      expect(
        checkTaskClose({
          root: ".",
          taskDir: lifecycleDir,
          cwd: rootA,
          expectedRevision: reviewed.kernel.revision,
          runId: lifecycleRunId,
          reviewId: review.id,
          candidateObservation: observation,
          deliveryEvidence,
        }),
      ).toEqual([]);
      const closed = closeTaskKernel({
        root: ".",
        taskDir: lifecycleDir,
        cwd: rootA,
        expectedRevision: reviewed.kernel.revision,
        runId: lifecycleRunId,
        reviewId: review.id,
        candidateObservation: observation,
        deliveryEvidence,
        actor: "closer",
        idempotencyKey: "relative-lifecycle-close",
      });
      expect(closed.kernel.phase).toBe("close");

      const duplicateTask = createKernelTask(rootA, "duplicate-in-a");
      expect(() =>
        createTaskKernel({
          root: ".",
          taskDir: path.join(".pactile", "tasks", "duplicate-copy"),
          cwd: rootA,
          actor: "author",
          idempotencyKey: "relative-duplicate-create",
          definition: {
            taskId: "duplicate-in-a",
            title: "Duplicate",
            description: "",
            deliverable: "duplicate",
            deliveryLevel: "local-result",
            acceptanceCriteria: [{ id: "AC-1", description: "result exists" }],
            dependencies: [],
          },
        }),
      ).toThrow(/Task ID already exists/);
      expect(duplicateTask.kernel.identity.taskId).toBe("duplicate-in-a");
      expect(() =>
        createTaskKernel({
          root: ".",
          taskDir: path.join(".pactile", "tasks", "missing-dependency"),
          cwd: rootA,
          actor: "author",
          idempotencyKey: "relative-missing-dependency",
          definition: {
            taskId: "missing-dependency",
            title: "Missing dependency",
            description: "",
            deliverable: "result",
            deliveryLevel: "local-result",
            acceptanceCriteria: [{ id: "AC-1", description: "result exists" }],
            dependencies: ["b-only-dependency"],
          },
        }),
      ).toThrow(/hard dependency not found/);

      const cycleTarget = createKernelTask(rootA, "cycle-target");
      const cycleDependency = createKernelTask(rootA, "cycle-dependency");
      createKernelTask(rootB, "cycle-dependency");
      addTaskDependency({
        root: rootA,
        taskDir: cycleDependency.dir,
        expectedRevision: cycleDependency.kernel.revision,
        dependencyId: "cycle-target",
        actor: "author",
        idempotencyKey: "cycle-first-edge",
      });
      expect(() =>
        addTaskDependency({
          root: ".",
          taskDir: path.join(".pactile", "tasks", "cycle-target"),
          cwd: rootA,
          expectedRevision: cycleTarget.kernel.revision,
          dependencyId: "cycle-dependency",
          actor: "author",
          idempotencyKey: "cycle-second-edge",
        }),
      ).toThrow(/hard dependency cycle/);

      const closeTask = createKernelTask(rootA, "relative-close");
      const prepared = prepareReviewableTask(
        rootA,
        closeTask.dir,
        "relative-close",
      );
      // Model a stored Task contract that has an unmet hard dependency while a
      // previously produced candidate awaits Close. Close must resolve that
      // dependency against rootA, even though process.cwd() points at rootB.
      const kernelPath = path.join(closeTask.dir, "kernel.json");
      const document = JSON.parse(fs.readFileSync(kernelPath, "utf8")) as {
        definition: { dependencies: string[] };
      };
      document.definition.dependencies = ["scope-dependency"];
      fs.writeFileSync(kernelPath, `${JSON.stringify(document, null, 2)}\n`);
      const closeObservation = {
        snapshotId: prepared.candidate.id,
        fingerprint: prepared.candidate.fingerprint,
        observedBy: "closer",
        observedAt: "now",
        source: "caller",
        evidenceRef: "observation",
      };
      const closeDelivery = {
        level: "local-result" as const,
        reference: "result.txt",
        summary: "present",
      };
      expect(
        checkTaskClose({
          root: ".",
          taskDir: path.join(".pactile", "tasks", "relative-close"),
          cwd: rootA,
          expectedRevision: prepared.kernel.revision,
          runId: prepared.run.id,
          reviewId: prepared.review.id,
          candidateObservation: closeObservation,
          deliveryEvidence: closeDelivery,
        }).join("\n"),
      ).toContain("hard dependencies must be closed successfully");
      expect(() =>
        closeTaskKernel({
          root: ".",
          taskDir: path.join(".pactile", "tasks", "relative-close"),
          cwd: rootA,
          expectedRevision: prepared.kernel.revision,
          runId: prepared.run.id,
          reviewId: prepared.review.id,
          candidateObservation: closeObservation,
          deliveryEvidence: closeDelivery,
          actor: "closer",
          idempotencyKey: "relative-close-attempt",
        }),
      ).toThrow(/hard dependencies must be closed successfully/);
      expect(readV2(rootA, closeTask.dir).phase).toBe("verify");
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("does not treat inherited prototype properties as acceptance evidence", () => {
    const root = makeRoot();
    const criteria = [
      { id: "hasOwnProperty", description: "requires explicit evidence" },
      {
        id: "__proto__",
        description: "supports a literal prototype-named criterion",
      },
    ];
    const task = createKernelTask(root, "prototype-evidence", [], criteria);
    const started = startTaskRun({
      root,
      taskDir: task.dir,
      expectedRevision: task.kernel.revision,
      actor: "implementer",
      idempotencyKey: "prototype-run",
      input: { summary: "work", references: [] },
      authorization: {
        approvedBy: "approver",
        approvedAt: "now",
        scope: "scope",
        evidenceRef: "approval",
      },
      writeSetSnapshot: ["result.txt"],
    });
    const runId = must(started.kernel.runs.at(-1), "started Run").id;
    const startedRun = must(started.kernel.runs.at(-1), "started Run");
    fs.writeFileSync(path.join(root, "result.txt"), "prototype result\n");
    const observerEntry = createTaskCandidateEntry(
      observeTaskRunCandidate({ run: startedRun, repositoryRoot: root }),
    );
    const result = recordTaskRunResult({
      root,
      taskDir: task.dir,
      expectedRevision: started.kernel.revision,
      runId,
      outcome: "completed",
      summary: "done",
      candidateEntries: [
        {
          ref: "result.txt",
          fingerprint: bytesFingerprint("prototype result\n"),
        },
        observerEntry,
      ],
      actor: "implementer",
      idempotencyKey: "prototype-result",
    });
    const candidate = must(
      must(result.kernel.runs.at(-1), "completed Run").candidateSnapshot,
      "candidate snapshot",
    );
    const missingEvidence: Record<string, string[]> = {};
    expect(() =>
      recordTaskReview({
        root,
        taskDir: task.dir,
        expectedRevision: result.kernel.revision,
        runId,
        candidateSnapshotId: candidate.id,
        candidateFingerprint: candidate.fingerprint,
        reviewer: "reviewer",
        decision: "pass",
        evidenceRefs: ["review.md"],
        acceptanceEvidence: missingEvidence,
        actor: "reviewer",
        idempotencyKey: "prototype-missing-evidence",
      }),
    ).toThrow(/hasOwnProperty/);

    const validEvidence = JSON.parse(
      '{"hasOwnProperty":["result.txt"],"__proto__":["result.txt"]}',
    ) as Record<string, string[]>;
    const reviewed = recordTaskReview({
      root,
      taskDir: task.dir,
      expectedRevision: result.kernel.revision,
      runId,
      candidateSnapshotId: candidate.id,
      candidateFingerprint: candidate.fingerprint,
      reviewer: "reviewer",
      decision: "pass",
      evidenceRefs: ["review.md"],
      acceptanceEvidence: validEvidence,
      actor: "reviewer",
      idempotencyKey: "prototype-valid-evidence",
    });
    const review = must(reviewed.kernel.reviews.at(-1), "Review");
    expect(
      Object.prototype.hasOwnProperty.call(
        review.acceptanceEvidence,
        "__proto__",
      ),
    ).toBe(true);
    expect(Object.getPrototypeOf(review.acceptanceEvidence)).toBe(
      Object.prototype,
    );
    expect(
      projectTaskKernelLifecycle(reviewed.kernel).gateSnapshot.close
        .missingAcceptanceCriteria,
    ).toEqual([]);
    closeTaskKernel({
      root,
      taskDir: task.dir,
      expectedRevision: reviewed.kernel.revision,
      runId,
      reviewId: review.id,
      candidateObservation: {
        snapshotId: candidate.id,
        fingerprint: candidate.fingerprint,
        observedBy: "closer",
        observedAt: "now",
        source: "caller",
        evidenceRef: "observation",
      },
      deliveryEvidence: {
        level: "local-result",
        reference: "result.txt",
        summary: "present",
      },
      actor: "closer",
      idempotencyKey: "prototype-close",
    });
  });

  it("records a standalone CLI --write-set and retains workspace write-set fallback", () => {
    const root = makeRoot();
    const task = createKernelTask(root, "write-set-cli");
    const args = [
      "run-start",
      "write-set-cli",
      "--actor",
      "implementer",
      "--input-summary",
      "Implement the result",
      "--approved-by",
      "approver",
      "--authorization-scope",
      "one file",
      "--authorization-evidence",
      "approval.md",
      "--write-set",
      "src/a.ts",
    ];
    expect(runTaskCli(args, root)).toBe(0);
    let kernel = readV2(root, task.dir);
    expect(kernel.runs[0]).toMatchObject({
      workspace: null,
      writeSetSnapshot: ["src/a.ts"],
    });
    expect(runTaskCli(args, root)).toBe(0);
    expect(readV2(root, task.dir).runs).toHaveLength(1);
    const firstRunId = must(kernel.runs[0], "first CLI Run").id;
    expect(
      runTaskCli(
        [
          "run-result",
          "write-set-cli",
          firstRunId,
          "--outcome",
          "failed",
          "--failure-category",
          "test",
          "--failure-message",
          "retry this attempt",
        ],
        root,
      ),
    ).toBe(0);
    expect(runTaskCli(args, root)).toBe(0);
    kernel = readV2(root, task.dir);
    expect(kernel.runs).toHaveLength(2);
    expect(kernel.runs.at(-1)).toMatchObject({ attempt: 2, state: "running" });

    const other = createKernelTask(root, "workspace-write-set");
    const queued = startTaskRun({
      root,
      taskDir: other.dir,
      expectedRevision: other.kernel.revision,
      actor: "implementer",
      idempotencyKey: "workspace-write-set-run",
      input: { summary: "work", references: [] },
      authorization: {
        approvedBy: "approver",
        approvedAt: "now",
        scope: "scope",
        evidenceRef: "approval",
      },
      workspace: {
        canonicalPath: root,
        branch: "feat/workspace",
        baseSha: "a".repeat(40),
        writeSet: ["src/workspace.ts"],
        integrationState: "not-integrated",
        reclamationState: "not-requested",
      },
    });
    expect(queued.kernel.runs[0]?.writeSetSnapshot).toEqual([
      "src/workspace.ts",
    ]);
  });

  it("preserves blocked/waiting retries and prevents hard dependencies from being bypassed", () => {
    const root = makeRoot();
    const prerequisite = createKernelTask(root, "prerequisite");
    const dependent = createKernelTask(root, "dependent", ["prerequisite"]);
    expect(() =>
      startTaskRun({
        root,
        taskDir: dependent.dir,
        expectedRevision: dependent.kernel.revision,
        actor: "implementer",
        idempotencyKey: "blocked-on-dependency",
        input: { summary: "work", references: [] },
        authorization: {
          approvedBy: "approver",
          approvedAt: "now",
          scope: "scope",
          evidenceRef: "approval",
        },
      }),
    ).toThrow(/hard dependencies must be closed successfully/);

    const closedPrerequisite = completeTask(
      root,
      prerequisite.dir,
      "prerequisite",
    );
    expect(closedPrerequisite.phase).toBe("close");
    let kernel = readV2(root, dependent.dir);
    const queued = startTaskRun({
      root,
      taskDir: dependent.dir,
      expectedRevision: kernel.revision,
      actor: "implementer",
      idempotencyKey: "queue-attempt-1",
      input: { summary: "work", references: [] },
      authorization: {
        approvedBy: "approver",
        approvedAt: "now",
        scope: "scope",
        evidenceRef: "approval",
      },
      initialState: "waiting",
      writeSetSnapshot: ["src/a.ts"],
      estimatedDurations: { waitingMs: 90_000 },
    });
    const firstRun = must(queued.kernel.runs.at(-1), "queued Run");
    expect(firstRun).toMatchObject({
      attempt: 1,
      sequence: 1,
      state: "waiting",
      writeSetSnapshot: ["src/a.ts"],
      estimatedDurations: { waitingMs: 90_000 },
    });
    const resumed = resumeTaskRun({
      root,
      taskDir: dependent.dir,
      expectedRevision: queued.kernel.revision,
      runId: firstRun.id,
      actor: "scheduler",
      idempotencyKey: "resume-attempt-1",
    });
    expect(resumed.kernel.runs.at(-1)?.state).toBe("running");
    recordTaskRunResult({
      root,
      taskDir: dependent.dir,
      expectedRevision: resumed.kernel.revision,
      runId: firstRun.id,
      outcome: "blocked",
      failure: {
        category: "environment",
        message: "workspace unavailable",
        evidenceRef: "worker.log",
      },
      actor: "implementer",
      idempotencyKey: "block-attempt-1",
    });
    kernel = readV2(root, dependent.dir);
    expect(kernel.runs).toHaveLength(1);
    expect(kernel.runs[0]).toMatchObject({
      state: "blocked",
      attempt: 1,
      failure: { category: "environment" },
    });
    const retry = startTaskRun({
      root,
      taskDir: dependent.dir,
      expectedRevision: kernel.revision,
      actor: "implementer",
      idempotencyKey: "retry-attempt-2",
      input: { summary: "retry", references: [] },
      authorization: {
        approvedBy: "approver",
        approvedAt: "now",
        scope: "scope",
        evidenceRef: "approval-2",
      },
    });
    expect(retry.kernel.runs).toHaveLength(2);
    expect(retry.kernel.runs.at(-1)).toMatchObject({
      attempt: 2,
      sequence: 2,
      state: "running",
    });
    expect(retry.kernel.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "run.queued",
        "run.resumed",
        "run.blocked",
        "run.started",
      ]),
    );
  });
});
