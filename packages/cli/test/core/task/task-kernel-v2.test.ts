import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  type TaskKernelSnapshotV2,
} from "../../../src/core/task/index.js";
import { compileSessionPack } from "../../../src/pactile/task/session-pack.js";

const roots: string[] = [];
function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} is missing`);
  return value;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-task-kernel-v2-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=alice\n");
  return root;
}

function readV2(root: string, taskDir: string): TaskKernelSnapshotV2 {
  const result = readTaskKernel({ root, taskDir, cwd: root });
  if (result.kind !== "task-kernel-v2") throw new Error("expected Task Kernel v2");
  return result.kernel;
}

function createKernelTask(
  root: string,
  taskId: string,
  dependencies: string[] = [],
  acceptanceCriteria = [{ id: "AC-1", description: "produces the required result" }],
): { dir: string; kernel: TaskKernelSnapshotV2 } {
  const dir = path.join(root, ".pactile", "tasks", taskId);
  const result = createTaskKernel({
    root, taskDir: dir, actor: "author", idempotencyKey: `create:${taskId}`,
    definition: {
      taskId, title: taskId, description: "test task", deliverable: "a reviewable local result",
      deliveryLevel: "local-result", acceptanceCriteria,
      dependencies,
    },
  });
  return { dir, kernel: result.kernel };
}

function completeTask(root: string, taskDir: string, taskId: string): TaskKernelSnapshotV2 {
  const prepared = prepareReviewableTask(root, taskDir, taskId);
  closeTaskKernel({
    root, taskDir, expectedRevision: prepared.kernel.revision, runId: prepared.run.id, reviewId: prepared.review.id,
    candidateObservation: {
      snapshotId: prepared.candidate.id, fingerprint: prepared.candidate.fingerprint,
      observedBy: "closer", observedAt: "2026-09-25T00:05:00.000Z", source: "caller-attested", evidenceRef: "candidate-observation.json",
    },
    deliveryEvidence: { level: "local-result", reference: "result.txt", summary: "The deliverable is present" },
    actor: "closer", idempotencyKey: `close:${taskId}`,
  });
  return readV2(root, taskDir);
}

function prepareReviewableTask(root: string, taskDir: string, taskId: string) {
  let kernel = readV2(root, taskDir);
  const started = startTaskRun({
    root, taskDir, expectedRevision: kernel.revision, actor: "implementer", idempotencyKey: `run:${taskId}`,
    input: { summary: "Implement the bounded deliverable", references: ["task contract"] },
    authorization: { approvedBy: "approver", approvedAt: "2026-09-25T00:00:00.000Z", scope: "one result", evidenceRef: "approval.json" },
  });
  const runId = must(started.kernel.runs.at(-1), "started Run").id;
  kernel = readV2(root, taskDir);
  recordTaskRunResult({
    root, taskDir, expectedRevision: kernel.revision, runId, outcome: "completed", summary: "Result produced",
    candidateEntries: [{ ref: "result.txt", fingerprint: "a".repeat(64) }], evidenceRefs: ["test-output.txt"],
    actor: "implementer", idempotencyKey: `result:${taskId}`,
  });
  kernel = readV2(root, taskDir);
  const run = must(kernel.runs.at(-1), "completed Run");
  const candidate = must(run.candidateSnapshot, "Run candidate snapshot");
  recordTaskReview({
    root, taskDir, expectedRevision: kernel.revision, runId, candidateSnapshotId: candidate.id,
    candidateFingerprint: candidate.fingerprint, reviewer: "reviewer", decision: "pass",
    evidenceRefs: ["review.md"], acceptanceEvidence: { "AC-1": ["result.txt"] }, actor: "reviewer", idempotencyKey: `review:${taskId}`,
  });
  kernel = readV2(root, taskDir);
  const review = must(kernel.reviews.at(-1), "Review");
  return { kernel, run, candidate, review };
}

describe("Task Kernel v2", () => {
  it("creates a deliverable Task without task.json presets and carries it through CLI, selection, context, Run, Review, and Close", () => {
    const root = makeRoot();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("PACTILE_CONTEXT_ID", "codex_p35_v2");

    expect(runTaskCli([
      "create", "Example deliverable", "--slug", "example-deliverable", "--description", "A focused change",
      "--deliverable", "A tested local result", "--delivery-level", "local-result", "--accept", "AC-1=The result is testable",
    ], root)).toBe(0);
    const dirName = must(fs.readdirSync(path.join(root, ".pactile", "tasks")).find((name) => name.endsWith("-example-deliverable")), "created V2 Task directory");
    const taskDir = path.join(root, ".pactile", "tasks", dirName);
    expect(fs.existsSync(path.join(taskDir, "task.json"))).toBe(false);
    let kernel = readV2(root, taskDir);
    expect(kernel).toMatchObject({ schemaVersion: 2, phase: "define", definition: { taskId: "example-deliverable", deliveryLevel: "local-result" } });
    expect(projectTaskKernelLifecycle(kernel)).toMatchObject({
      approvalSnapshot: { recorded: false, runId: null },
      gateSnapshot: {
        kernelRevision: kernel.revision,
        runStart: { phaseAllowsRun: true, activeRunId: null, dependencyKernelCheckRequired: false },
        review: { phaseAllowsReview: false, runId: null },
        close: { phaseAllowsClose: false, currentCandidateObservationRequired: true, deliveryEvidenceRequired: true },
      },
    });

    expect(runTaskCli(["list"], root)).toBe(0);
    expect(log.mock.calls.map(([line]) => String(line)).join("\n")).toContain(`${dirName}/ (define; Kernel v2)`);
    expect(runTaskCli(["show", "example-deliverable"], root)).toBe(0);
    expect(String(log.mock.lastCall?.[0])).toContain("The result is testable");
    expect(runTaskCli(["select", "example-deliverable"], root)).toBe(0);
    expect(runTaskCli(["selected", "--json"], root)).toBe(0);
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({ taskId: "example-deliverable", phase: "define", kernelVersion: 2 });
    expect(runContextCli(["--mode", "record", "--json"], root)).toBe(0);
    expect(JSON.parse(String(log.mock.lastCall?.[0])).selectedTask).toMatchObject({ name: "Example deliverable", phase: "define", kernelVersion: 2 });
    const sessionPack = compileSessionPack(root);
    expect(sessionPack.kernel).toMatchObject({ taskId: "example-deliverable", schemaVersion: 2, phase: "define", deliveryLevel: "local-result" });
    expect(JSON.stringify(sessionPack)).not.toContain("Rigor=lite");

    const runStartArgs = [
      "run-start", "example-deliverable", "--actor", "alice", "--input-summary", "Implement AC-1", "--input-ref", "definition",
      "--approved-by", "approver", "--authorization-scope", "src/result.txt", "--authorization-evidence", "approval.json",
      "--workspace-path", root, "--branch", "feat/example", "--base-sha", "e".repeat(40), "--write-set", "src/result.txt",
      "--host", "local-codex", "--role", "implementer", "--session-id", "session-1", "--thread-id", "thread-1", "--request-ref", "request.json",
      "--estimate-execution-ms", "30000", "--estimate-waiting-ms", "5000", "--estimate-review-ms", "8000",
    ];
    expect(runTaskCli(runStartArgs, root)).toBe(0);
    kernel = readV2(root, taskDir);
    const run = must(kernel.runs.at(-1), "started Run");
    expect(run).toMatchObject({ attempt: 1, state: "running", writeSetSnapshot: ["src/result.txt"], estimatedDurations: { executionMs: 30000, waitingMs: 5000, reviewMs: 8000 } });
    expect(projectTaskKernelLifecycle(kernel)).toMatchObject({
      approvalSnapshot: { recorded: true, runId: run.id, approvedBy: "approver", evidenceRef: "approval.json" },
      gateSnapshot: { kernelRevision: kernel.revision, runStart: { phaseAllowsRun: true, activeRunId: run.id } },
    });
    expect(run.workspace).toMatchObject({ ownerRunId: run.id, canonicalPath: root, branch: "feat/example", writeSet: ["src/result.txt"] });
    expect(run.host).toMatchObject({ host: "local-codex", role: "implementer", sessionId: "session-1", threadId: "thread-1", requestRefs: ["request.json"] });
    expect(runTaskCli(runStartArgs, root)).toBe(0);
    expect(readV2(root, taskDir).runs).toHaveLength(1);

    const entryFingerprint = "b".repeat(64);
    expect(runTaskCli(["run-result", "example-deliverable", run.id, "--outcome", "completed", "--summary", "Result ready", "--evidence", "tests.txt", "--candidate", `src/result.txt=${entryFingerprint}`], root)).toBe(0);
    kernel = readV2(root, taskDir);
    const candidate = must(must(kernel.runs.at(-1), "completed Run").candidateSnapshot, "candidate snapshot");
    expect(candidate.id).toBeTruthy();
    expect(candidate.fingerprint).toBe(fingerprintTaskValue(candidate.entries));
    const reviewArgs = [
      "review", "example-deliverable", "--actor", "reviewer", "--run", run.id, "--candidate-id", candidate.id,
      "--candidate-fingerprint", candidate.fingerprint, "--reviewer", "reviewer", "--decision", "pass",
      "--evidence", "review.md", "--criterion", "AC-1=src/result.txt", "--review-measurement-ref", "review-metrics.json",
    ];
    expect(runTaskCli(reviewArgs, root)).toBe(0);
    kernel = readV2(root, taskDir);
    const review = must(kernel.reviews.at(-1), "Review");
    expect(review).toMatchObject({ candidateSnapshotId: candidate.id, candidateFingerprint: candidate.fingerprint, decision: "pass", unresolvedBlockers: [] });
    expect(kernel.runs.at(-1)?.measurementRefs.review).toBe("review-metrics.json");
    expect(runTaskCli(reviewArgs, root)).toBe(0);
    expect(readV2(root, taskDir).reviews).toHaveLength(1);
    expect(projectTaskKernelLifecycle(kernel).gateSnapshot).toMatchObject({
      kernelRevision: kernel.revision,
      review: { phaseAllowsReview: true, runId: run.id, candidateSnapshotId: candidate.id, latestReviewId: review.id, latestDecision: "pass" },
      close: { phaseAllowsClose: true, runId: run.id, reviewId: review.id, candidateSnapshotId: candidate.id, missingAcceptanceCriteria: [] },
    });

    const closeArgs = [
      "close", "example-deliverable", "--run", run.id, "--review", review.id, "--candidate-id", candidate.id,
      "--candidate-fingerprint", candidate.fingerprint, "--candidate-observed-by", "closer", "--candidate-observation-source", "caller-attested",
      "--candidate-observation-ref", "snapshot-observation.json", "--delivery-level", "local-result", "--delivery-ref", "src/result.txt",
      "--delivery-summary", "The reviewed result is present",
    ];
    expect(runTaskCli([...closeArgs, "--check"], root)).toBe(0);
    expect(String(log.mock.lastCall?.[0])).toContain("does not recompute current Git or filesystem bytes");
    expect(runTaskCli(closeArgs, root)).toBe(0);
    kernel = readV2(root, taskDir);
    expect(projectTaskKernelLifecycle(kernel)).toMatchObject({ taskId: "example-deliverable", phase: "close", closed: true, deliveryLevel: "local-result" });
    expect(kernel.closure?.candidateObservation).toMatchObject({ snapshotId: candidate.id, fingerprint: candidate.fingerprint, source: "caller-attested" });
    expect(runTaskCli(["list", "--status", "completed"], root)).toBe(0);
    expect(log.mock.calls.map(([line]) => String(line)).join("\n")).toContain("example-deliverable/ (closed; Kernel v2)");
  });

  it("keeps 0.5.x Tasks readable through the unified reader without migrating them", () => {
    const root = makeRoot();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runTaskCli(["create", "Legacy task", "--slug", "legacy-task"], root)).toBe(1);
    expect(runTaskCli(["legacy-create", "Legacy task", "--slug", "legacy-task"], root)).toBe(0);
    const taskDirName = must(fs.readdirSync(path.join(root, ".pactile", "tasks")).find((name) => name.endsWith("-legacy-task")), "created legacy Task directory");
    const taskDir = path.join(root, ".pactile", "tasks", taskDirName);
    const before = fs.readFileSync(path.join(taskDir, "kernel.json"), "utf8");
    const read = readTaskKernel({ root, taskDir, cwd: root });
    expect(read.kind).toBe("legacy-task-kernel-v1");
    expect(fs.readFileSync(path.join(taskDir, "kernel.json"), "utf8")).toBe(before);
    expect(runTaskCli(["show", "legacy-task"], root)).toBe(0);
    expect(String(log.mock.calls.map(([line]) => line).join("\n"))).toContain("legacy-task");
  });

  it("requires a current candidate observation, the latest Run, a distinct Reviewer, complete evidence, and no blockers", () => {
    const root = makeRoot();
    const { dir } = createKernelTask(root, "freshness-check");
    let kernel = readV2(root, dir);
    const started = startTaskRun({
      root, taskDir: dir, expectedRevision: kernel.revision, actor: "implementer", idempotencyKey: "fresh-run",
      input: { summary: "work", references: [] }, authorization: { approvedBy: "approver", approvedAt: "2026-09-25", scope: "scope", evidenceRef: "approval" },
    });
    const runId = must(started.kernel.runs.at(-1), "started Run").id;
    kernel = readV2(root, dir);
    recordTaskRunResult({ root, taskDir: dir, expectedRevision: kernel.revision, runId, outcome: "completed", summary: "done", candidateEntries: [{ ref: "result", fingerprint: "c".repeat(64) }], actor: "implementer", idempotencyKey: "fresh-result" });
    kernel = readV2(root, dir);
    const run = must(kernel.runs.at(-1), "completed Run");
    const candidate = must(run.candidateSnapshot, "candidate snapshot");
    expect(() => recordTaskReview({
      root, taskDir: dir, expectedRevision: kernel.revision, runId, candidateSnapshotId: candidate.id,
      candidateFingerprint: candidate.fingerprint, reviewer: "reviewer", decision: "pass",
      evidenceRefs: ["review"], acceptanceEvidence: { "AC-1": ["result"] }, actor: "implementer", idempotencyKey: "forged-review-actor",
    })).toThrow(/actor must match the recorded reviewer/);
    expect(() => recordTaskReview({
      root, taskDir: dir, expectedRevision: kernel.revision, runId, candidateSnapshotId: candidate.id,
      candidateFingerprint: candidate.fingerprint, reviewer: "implementer", decision: "pass",
      evidenceRefs: ["review"], acceptanceEvidence: { "AC-1": ["result"] }, actor: "implementer", idempotencyKey: "self-review",
    })).toThrow(/other than the Run executor/);
    expect(() => recordTaskReview({
      root, taskDir: dir, expectedRevision: kernel.revision, runId, candidateSnapshotId: candidate.id,
      candidateFingerprint: candidate.fingerprint, reviewer: "reviewer", decision: "pass",
      evidenceRefs: ["review"], acceptanceEvidence: { "AC-1": ["result"] }, unresolvedBlockers: ["open issue"],
      actor: "reviewer", idempotencyKey: "blocked-review",
    })).toThrow(/unresolved blockers/);
    recordTaskReview({
      root, taskDir: dir, expectedRevision: kernel.revision, runId, candidateSnapshotId: candidate.id,
      candidateFingerprint: candidate.fingerprint, reviewer: "reviewer", decision: "pass",
      evidenceRefs: ["review"], acceptanceEvidence: { "AC-1": ["result"] }, actor: "reviewer", idempotencyKey: "valid-review",
    });
    kernel = readV2(root, dir);
    const review = must(kernel.reviews.at(-1), "Review");
    const observation = { snapshotId: candidate.id, fingerprint: candidate.fingerprint, observedBy: "closer", observedAt: "now", source: "caller-attested", evidenceRef: "observation.json" };
    const deliveryEvidence = { level: "local-result" as const, reference: "result", summary: "present" };
    expect(checkTaskClose({ root, taskDir: dir, expectedRevision: kernel.revision, runId, reviewId: review.id, candidateObservation: { ...observation, fingerprint: "d".repeat(64) }, deliveryEvidence }).join("\n")).toContain("current candidate observation");
    expect(checkTaskClose({ root, taskDir: dir, expectedRevision: kernel.revision, runId, reviewId: review.id, candidateObservation: observation, deliveryEvidence })).toEqual([]);
  });

  it("binds reads and every lifecycle mutation to the canonical project root", () => {
    const rootA = makeRoot();
    const rootB = makeRoot();
    const prerequisiteA = createKernelTask(rootA, "shared-dependency");
    const dependentA = createKernelTask(rootA, "dependent-a", ["shared-dependency"]);
    const prerequisiteB = createKernelTask(rootB, "shared-dependency");
    completeTask(rootB, prerequisiteB.dir, "shared-dependency");

    expect(() => readTaskKernel({ root: rootB, taskDir: dependentA.dir, cwd: rootB })).toThrow(/supplied project's .pactile\/tasks tree/);
    expect(() => startTaskRun({
      root: rootB, taskDir: dependentA.dir, expectedRevision: dependentA.kernel.revision, actor: "implementer", idempotencyKey: "cross-root-start",
      input: { summary: "work", references: [] }, authorization: { approvedBy: "approver", approvedAt: "now", scope: "scope", evidenceRef: "approval" },
    })).toThrow(/supplied project's .pactile\/tasks tree/);

    const targetA = createKernelTask(rootA, "target-a");
    const prepared = prepareReviewableTask(rootA, targetA.dir, "target-a");
    expect(() => closeTaskKernel({
      root: rootB, taskDir: targetA.dir, expectedRevision: prepared.kernel.revision, runId: prepared.run.id, reviewId: prepared.review.id,
      candidateObservation: { snapshotId: prepared.candidate.id, fingerprint: prepared.candidate.fingerprint, observedBy: "closer", observedAt: "now", source: "caller", evidenceRef: "observation" },
      deliveryEvidence: { level: "local-result", reference: "result.txt", summary: "present" }, actor: "closer", idempotencyKey: "cross-root-close",
    })).toThrow(/supplied project's .pactile\/tasks tree/);
    expect(readV2(rootA, targetA.dir).phase).toBe("verify");
    expect(prerequisiteA.kernel.phase).toBe("define");
  });

  it("normalizes relative roots once across project lookup, dependency gates, Run, and Close", () => {
    const rootA = makeRoot();
    const rootB = makeRoot();
    createKernelTask(rootA, "scope-dependency");
    completeTask(rootB, createKernelTask(rootB, "scope-dependency").dir, "scope-dependency");
    createKernelTask(rootB, "b-only-dependency");
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(rootB);
    try {
      const relativeTargetDir = path.join(".pactile", "tasks", "relative-target");
      const relativeTarget = createTaskKernel({
        root: ".", taskDir: relativeTargetDir, cwd: rootA, actor: "author", idempotencyKey: "relative-target-create",
        definition: {
          taskId: "relative-target", title: "Relative target", description: "", deliverable: "target result", deliveryLevel: "local-result",
          acceptanceCriteria: [{ id: "AC-1", description: "result exists" }], dependencies: ["scope-dependency"],
        },
      });
      expect(readTaskKernel({ root: ".", taskDir: relativeTargetDir, cwd: rootA })).toMatchObject({
        kind: "task-kernel-v2", kernel: { identity: { taskId: "relative-target" }, definition: { dependencies: ["scope-dependency"] } },
      });
      expect(handleKernelRequest({ op: "task-read", taskDir: relativeTargetDir, cwd: rootA }, { cwd: rootB })).toMatchObject({
        ok: true, op: "task-read", result: { kind: "task-kernel-v2", kernel: { identity: { taskId: "relative-target" } } },
      });
      expect(() => startTaskRun({
        root: ".", taskDir: relativeTargetDir, cwd: rootA, expectedRevision: relativeTarget.kernel.revision,
        actor: "implementer", idempotencyKey: "relative-start", input: { summary: "work", references: [] },
        authorization: { approvedBy: "approver", approvedAt: "now", scope: "scope", evidenceRef: "approval" },
      })).toThrow(/hard dependencies must be closed successfully/);

      const lifecycleDir = path.join(".pactile", "tasks", "relative-lifecycle");
      const lifecycle = createTaskKernel({
        root: ".", taskDir: lifecycleDir, cwd: rootA, actor: "author", idempotencyKey: "relative-lifecycle-create",
        definition: {
          taskId: "relative-lifecycle", title: "Relative lifecycle", description: "", deliverable: "lifecycle result", deliveryLevel: "local-result",
          acceptanceCriteria: [{ id: "AC-1", description: "result exists" }], dependencies: [],
        },
      });
      const queued = startTaskRun({
        root: ".", taskDir: lifecycleDir, cwd: rootA, expectedRevision: lifecycle.kernel.revision, actor: "implementer", idempotencyKey: "relative-lifecycle-run",
        input: { summary: "work", references: [] }, authorization: { approvedBy: "approver", approvedAt: "now", scope: "scope", evidenceRef: "approval" }, initialState: "waiting",
      });
      const lifecycleRunId = must(queued.kernel.runs.at(-1), "relative waiting Run").id;
      const resumed = resumeTaskRun({
        root: ".", taskDir: lifecycleDir, cwd: rootA, expectedRevision: queued.kernel.revision, runId: lifecycleRunId,
        actor: "scheduler", idempotencyKey: "relative-lifecycle-resume",
      });
      const result = recordTaskRunResult({
        root: ".", taskDir: lifecycleDir, cwd: rootA, expectedRevision: resumed.kernel.revision, runId: lifecycleRunId,
        outcome: "completed", summary: "done", candidateEntries: [{ ref: "result.txt", fingerprint: "b".repeat(64) }],
        actor: "implementer", idempotencyKey: "relative-lifecycle-result",
      });
      const candidate = must(must(result.kernel.runs.at(-1), "relative completed Run").candidateSnapshot, "relative candidate snapshot");
      const reviewed = recordTaskReview({
        root: ".", taskDir: lifecycleDir, cwd: rootA, expectedRevision: result.kernel.revision, runId: lifecycleRunId,
        candidateSnapshotId: candidate.id, candidateFingerprint: candidate.fingerprint, reviewer: "reviewer", decision: "pass",
        evidenceRefs: ["review.md"], acceptanceEvidence: { "AC-1": ["result.txt"] }, actor: "reviewer", idempotencyKey: "relative-lifecycle-review",
      });
      const review = must(reviewed.kernel.reviews.at(-1), "relative Review");
      const observation = { snapshotId: candidate.id, fingerprint: candidate.fingerprint, observedBy: "closer", observedAt: "now", source: "caller", evidenceRef: "observation" };
      const deliveryEvidence = { level: "local-result" as const, reference: "result.txt", summary: "present" };
      expect(checkTaskClose({
        root: ".", taskDir: lifecycleDir, cwd: rootA, expectedRevision: reviewed.kernel.revision,
        runId: lifecycleRunId, reviewId: review.id, candidateObservation: observation, deliveryEvidence,
      })).toEqual([]);
      const closed = closeTaskKernel({
        root: ".", taskDir: lifecycleDir, cwd: rootA, expectedRevision: reviewed.kernel.revision,
        runId: lifecycleRunId, reviewId: review.id, candidateObservation: observation, deliveryEvidence,
        actor: "closer", idempotencyKey: "relative-lifecycle-close",
      });
      expect(closed.kernel.phase).toBe("close");

      const duplicateTask = createKernelTask(rootA, "duplicate-in-a");
      expect(() => createTaskKernel({
        root: ".", taskDir: path.join(".pactile", "tasks", "duplicate-copy"), cwd: rootA, actor: "author", idempotencyKey: "relative-duplicate-create",
        definition: {
          taskId: "duplicate-in-a", title: "Duplicate", description: "", deliverable: "duplicate", deliveryLevel: "local-result",
          acceptanceCriteria: [{ id: "AC-1", description: "result exists" }], dependencies: [],
        },
      })).toThrow(/Task ID already exists/);
      expect(duplicateTask.kernel.identity.taskId).toBe("duplicate-in-a");
      expect(() => createTaskKernel({
        root: ".", taskDir: path.join(".pactile", "tasks", "missing-dependency"), cwd: rootA, actor: "author", idempotencyKey: "relative-missing-dependency",
        definition: {
          taskId: "missing-dependency", title: "Missing dependency", description: "", deliverable: "result", deliveryLevel: "local-result",
          acceptanceCriteria: [{ id: "AC-1", description: "result exists" }], dependencies: ["b-only-dependency"],
        },
      })).toThrow(/hard dependency not found/);

      const cycleTarget = createKernelTask(rootA, "cycle-target");
      const cycleDependency = createKernelTask(rootA, "cycle-dependency");
      createKernelTask(rootB, "cycle-dependency");
      addTaskDependency({
        root: rootA, taskDir: cycleDependency.dir, expectedRevision: cycleDependency.kernel.revision,
        dependencyId: "cycle-target", actor: "author", idempotencyKey: "cycle-first-edge",
      });
      expect(() => addTaskDependency({
        root: ".", taskDir: path.join(".pactile", "tasks", "cycle-target"), cwd: rootA,
        expectedRevision: cycleTarget.kernel.revision, dependencyId: "cycle-dependency", actor: "author", idempotencyKey: "cycle-second-edge",
      })).toThrow(/hard dependency cycle/);

      const closeTask = createKernelTask(rootA, "relative-close");
      const prepared = prepareReviewableTask(rootA, closeTask.dir, "relative-close");
      // Model a stored Task contract that has an unmet hard dependency while a
      // previously produced candidate awaits Close. Close must resolve that
      // dependency against rootA, even though process.cwd() points at rootB.
      const kernelPath = path.join(closeTask.dir, "kernel.json");
      const document = JSON.parse(fs.readFileSync(kernelPath, "utf8")) as { definition: { dependencies: string[] } };
      document.definition.dependencies = ["scope-dependency"];
      fs.writeFileSync(kernelPath, `${JSON.stringify(document, null, 2)}\n`);
      const closeObservation = {
        snapshotId: prepared.candidate.id, fingerprint: prepared.candidate.fingerprint,
        observedBy: "closer", observedAt: "now", source: "caller", evidenceRef: "observation",
      };
      const closeDelivery = { level: "local-result" as const, reference: "result.txt", summary: "present" };
      expect(checkTaskClose({
        root: ".", taskDir: path.join(".pactile", "tasks", "relative-close"), cwd: rootA,
        expectedRevision: prepared.kernel.revision, runId: prepared.run.id, reviewId: prepared.review.id,
        candidateObservation: closeObservation, deliveryEvidence: closeDelivery,
      }).join("\n")).toContain("hard dependencies must be closed successfully");
      expect(() => closeTaskKernel({
        root: ".", taskDir: path.join(".pactile", "tasks", "relative-close"), cwd: rootA,
        expectedRevision: prepared.kernel.revision, runId: prepared.run.id, reviewId: prepared.review.id,
        candidateObservation: closeObservation, deliveryEvidence: closeDelivery, actor: "closer", idempotencyKey: "relative-close-attempt",
      })).toThrow(/hard dependencies must be closed successfully/);
      expect(readV2(rootA, closeTask.dir).phase).toBe("verify");
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("does not treat inherited prototype properties as acceptance evidence", () => {
    const root = makeRoot();
    const criteria = [
      { id: "hasOwnProperty", description: "requires explicit evidence" },
      { id: "__proto__", description: "supports a literal prototype-named criterion" },
    ];
    const task = createKernelTask(root, "prototype-evidence", [], criteria);
    const started = startTaskRun({
      root, taskDir: task.dir, expectedRevision: task.kernel.revision, actor: "implementer", idempotencyKey: "prototype-run",
      input: { summary: "work", references: [] }, authorization: { approvedBy: "approver", approvedAt: "now", scope: "scope", evidenceRef: "approval" },
    });
    const runId = must(started.kernel.runs.at(-1), "started Run").id;
    const result = recordTaskRunResult({
      root, taskDir: task.dir, expectedRevision: started.kernel.revision, runId, outcome: "completed", summary: "done",
      candidateEntries: [{ ref: "result.txt", fingerprint: "f".repeat(64) }], actor: "implementer", idempotencyKey: "prototype-result",
    });
    const candidate = must(must(result.kernel.runs.at(-1), "completed Run").candidateSnapshot, "candidate snapshot");
    const missingEvidence: Record<string, string[]> = {};
    expect(() => recordTaskReview({
      root, taskDir: task.dir, expectedRevision: result.kernel.revision, runId, candidateSnapshotId: candidate.id,
      candidateFingerprint: candidate.fingerprint, reviewer: "reviewer", decision: "pass", evidenceRefs: ["review.md"],
      acceptanceEvidence: missingEvidence, actor: "reviewer", idempotencyKey: "prototype-missing-evidence",
    })).toThrow(/hasOwnProperty/);

    const validEvidence = JSON.parse('{"hasOwnProperty":["result.txt"],"__proto__":["result.txt"]}') as Record<string, string[]>;
    const reviewed = recordTaskReview({
      root, taskDir: task.dir, expectedRevision: result.kernel.revision, runId, candidateSnapshotId: candidate.id,
      candidateFingerprint: candidate.fingerprint, reviewer: "reviewer", decision: "pass", evidenceRefs: ["review.md"],
      acceptanceEvidence: validEvidence, actor: "reviewer", idempotencyKey: "prototype-valid-evidence",
    });
    const review = must(reviewed.kernel.reviews.at(-1), "Review");
    expect(Object.prototype.hasOwnProperty.call(review.acceptanceEvidence, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(review.acceptanceEvidence)).toBe(Object.prototype);
    expect(projectTaskKernelLifecycle(reviewed.kernel).gateSnapshot.close.missingAcceptanceCriteria).toEqual([]);
    closeTaskKernel({
      root, taskDir: task.dir, expectedRevision: reviewed.kernel.revision, runId, reviewId: review.id,
      candidateObservation: { snapshotId: candidate.id, fingerprint: candidate.fingerprint, observedBy: "closer", observedAt: "now", source: "caller", evidenceRef: "observation" },
      deliveryEvidence: { level: "local-result", reference: "result.txt", summary: "present" }, actor: "closer", idempotencyKey: "prototype-close",
    });
  });

  it("records a standalone CLI --write-set and retains workspace write-set fallback", () => {
    const root = makeRoot();
    const task = createKernelTask(root, "write-set-cli");
    const args = [
      "run-start", "write-set-cli", "--actor", "implementer", "--input-summary", "Implement the result",
      "--approved-by", "approver", "--authorization-scope", "one file", "--authorization-evidence", "approval.md", "--write-set", "src/a.ts",
    ];
    expect(runTaskCli(args, root)).toBe(0);
    let kernel = readV2(root, task.dir);
    expect(kernel.runs[0]).toMatchObject({ workspace: null, writeSetSnapshot: ["src/a.ts"] });
    expect(runTaskCli(args, root)).toBe(0);
    expect(readV2(root, task.dir).runs).toHaveLength(1);
    const firstRunId = must(kernel.runs[0], "first CLI Run").id;
    expect(runTaskCli(["run-result", "write-set-cli", firstRunId, "--outcome", "failed", "--failure-category", "test", "--failure-message", "retry this attempt"], root)).toBe(0);
    expect(runTaskCli(args, root)).toBe(0);
    kernel = readV2(root, task.dir);
    expect(kernel.runs).toHaveLength(2);
    expect(kernel.runs.at(-1)).toMatchObject({ attempt: 2, state: "running" });

    const other = createKernelTask(root, "workspace-write-set");
    const queued = startTaskRun({
      root, taskDir: other.dir, expectedRevision: other.kernel.revision, actor: "implementer", idempotencyKey: "workspace-write-set-run",
      input: { summary: "work", references: [] }, authorization: { approvedBy: "approver", approvedAt: "now", scope: "scope", evidenceRef: "approval" },
      workspace: { canonicalPath: root, branch: "feat/workspace", baseSha: "a".repeat(40), writeSet: ["src/workspace.ts"], integrationState: "not-integrated", reclamationState: "not-requested" },
    });
    expect(queued.kernel.runs[0]?.writeSetSnapshot).toEqual(["src/workspace.ts"]);
  });

  it("preserves blocked/waiting retries and prevents hard dependencies from being bypassed", () => {
    const root = makeRoot();
    const prerequisite = createKernelTask(root, "prerequisite");
    const dependent = createKernelTask(root, "dependent", ["prerequisite"]);
    expect(() => startTaskRun({
      root, taskDir: dependent.dir, expectedRevision: dependent.kernel.revision, actor: "implementer", idempotencyKey: "blocked-on-dependency",
      input: { summary: "work", references: [] }, authorization: { approvedBy: "approver", approvedAt: "now", scope: "scope", evidenceRef: "approval" },
    })).toThrow(/hard dependencies must be closed successfully/);

    const closedPrerequisite = completeTask(root, prerequisite.dir, "prerequisite");
    expect(closedPrerequisite.phase).toBe("close");
    let kernel = readV2(root, dependent.dir);
    const queued = startTaskRun({
      root, taskDir: dependent.dir, expectedRevision: kernel.revision, actor: "implementer", idempotencyKey: "queue-attempt-1",
      input: { summary: "work", references: [] }, authorization: { approvedBy: "approver", approvedAt: "now", scope: "scope", evidenceRef: "approval" },
      initialState: "waiting", writeSetSnapshot: ["src/a.ts"], estimatedDurations: { waitingMs: 90_000 },
    });
    const firstRun = must(queued.kernel.runs.at(-1), "queued Run");
    expect(firstRun).toMatchObject({ attempt: 1, sequence: 1, state: "waiting", writeSetSnapshot: ["src/a.ts"], estimatedDurations: { waitingMs: 90_000 } });
    const resumed = resumeTaskRun({ root, taskDir: dependent.dir, expectedRevision: queued.kernel.revision, runId: firstRun.id, actor: "scheduler", idempotencyKey: "resume-attempt-1" });
    expect(resumed.kernel.runs.at(-1)?.state).toBe("running");
    recordTaskRunResult({
      root, taskDir: dependent.dir, expectedRevision: resumed.kernel.revision, runId: firstRun.id, outcome: "blocked",
      failure: { category: "environment", message: "workspace unavailable", evidenceRef: "worker.log" },
      actor: "implementer", idempotencyKey: "block-attempt-1",
    });
    kernel = readV2(root, dependent.dir);
    expect(kernel.runs).toHaveLength(1);
    expect(kernel.runs[0]).toMatchObject({ state: "blocked", attempt: 1, failure: { category: "environment" } });
    const retry = startTaskRun({
      root, taskDir: dependent.dir, expectedRevision: kernel.revision, actor: "implementer", idempotencyKey: "retry-attempt-2",
      input: { summary: "retry", references: [] }, authorization: { approvedBy: "approver", approvedAt: "now", scope: "scope", evidenceRef: "approval-2" },
    });
    expect(retry.kernel.runs).toHaveLength(2);
    expect(retry.kernel.runs.at(-1)).toMatchObject({ attempt: 2, sequence: 2, state: "running" });
    expect(retry.kernel.events.map((event) => event.type)).toEqual(expect.arrayContaining(["run.queued", "run.resumed", "run.blocked", "run.started"]));
  });
});
