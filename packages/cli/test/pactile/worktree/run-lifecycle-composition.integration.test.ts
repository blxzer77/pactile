import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTaskKernel,
  readTaskKernel,
  recordTaskReview,
  recordTaskRunResult,
  startTaskRun,
} from "../../../src/core/task/index.js";
import { observeTaskRunCandidate } from "../../../src/core/task/task-candidate-observer.js";
import { runTaskCliWithWorkspaceReclaim } from "../../../src/commands/task-worktree-close.js";
import { runWorktreeCli } from "../../../src/commands/worktree.js";
import { PiTaskBridge, readPiHostStopReceipt } from "../../../src/pactile/pi/bridge.js";
import {
  createTaskRunWorktree,
  reclaimRunWorktree,
} from "../../../src/pactile/worktree/index.js";
import { readAllManagerProvenance } from "../../../src/pactile/worktree/manager-provenance.js";
import { repoIdentity } from "../../../src/pactile/worktree/git-probe.js";
import * as gitRemoval from "../../../src/pactile/worktree/git-removal.js";

const roots: string[] = [];
const fixturePrefix = "pactile-p38-lifecycle-composition-";
const actor = "p38-test-worker";
const approver = "p38-test-approver";
const reviewer = "p38-test-reviewer";
const closer = "p38-test-closer";
const fakePiProvider = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.tmp/p31-script-build/fixtures/fake-pi-provider.js",
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/\r?\n$/u, "");
}

function fixture(): { root: string; baseSha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), fixturePrefix));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Pactile Test");
  git(root, "config", "user.email", "pactile@example.invalid");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "P38 lifecycle composition fixture\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(root, "src", "base.ts"), "export const base = true;\n");
  git(root, "add", "README.md", ".gitignore", "src/base.ts");
  git(root, "commit", "-q", "-m", "fixture base");
  return { root, baseSha: git(root, "rev-parse", "HEAD") };
}

function removeFixtures(): void {
  const tempRoot = path.resolve(os.tmpdir());
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    const relative = path.relative(tempRoot, resolved);
    if (path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)
      || path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith(fixturePrefix)) {
      throw new Error(`Refusing to recursively remove a non-fixture path: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  removeFixtures();
});

function createTask(root: string, taskId: string): { taskDir: string; runId: string } {
  const taskDir = path.join(root, ".pactile", "tasks", taskId);
  const created = createTaskKernel({
    root,
    taskDir,
    actor: "p38-test-author",
    idempotencyKey: `create:${taskId}`,
    definition: {
      taskId,
      title: "P38 lifecycle composition",
      description: "Exercise Pi V2 stop receipts with managed Run worktrees.",
      deliverable: "A reviewed feature integrated into main",
      deliveryLevel: "local-result",
      acceptanceCriteria: [{ id: "AC-1", description: "The feature is integrated." }],
      dependencies: [],
    },
  });
  const started = startTaskRun({
    root,
    taskDir,
    expectedRevision: created.kernel.revision,
    actor,
    idempotencyKey: `start:${taskId}:1`,
    input: { summary: "Implement the accepted feature", references: [] },
    authorization: {
      approvedBy: approver,
      approvedAt: "2026-09-27T00:00:00.000Z",
      scope: "src",
      evidenceRef: `approval:${taskId}`,
    },
    writeSetSnapshot: ["src/"],
  });
  const runId = started.kernel.runs.at(-1)?.id;
  if (!runId) throw new Error("Started Run is missing");
  return { taskDir, runId };
}

function startRetry(root: string, taskDir: string, taskId: string, attempt: "cancelled" | "success"): string {
  const read = readTaskKernel({ root, taskDir, cwd: root });
  if (read.kind !== "task-kernel-v2") throw new Error("Expected Task Kernel v2");
  const started = startTaskRun({
    root,
    taskDir,
    expectedRevision: read.kernel.revision,
    actor,
    idempotencyKey: `start:${taskId}:${attempt}`,
    input: { summary: "Retry the implementation after the prior failure", references: [] },
    authorization: {
      approvedBy: approver,
      approvedAt: "2026-09-27T00:01:00.000Z",
      scope: "src",
      evidenceRef: `approval:${taskId}:retry`,
    },
    writeSetSnapshot: ["src/"],
  });
  const runId = started.kernel.runs.at(-1)?.id;
  if (!runId) throw new Error("Retried Run is missing");
  return runId;
}

function attachManagedWorktree(root: string, taskDir: string, runId: string, taskId: string, baseSha: string) {
  return createTaskRunWorktree({
    repoRoot: root,
    taskDir,
    runId,
    branch: `feat/${taskId}-${runId.slice(0, 8)}`,
    baseRef: baseSha,
    actor,
    idempotencyKey: `worktree:${taskId}:${runId}`,
  }).binding;
}

function piBridge(root: string, marker: string, options: { hang?: boolean; sessionId: string }): PiTaskBridge {
  return new PiTaskBridge(root, {
    command: process.execPath,
    args: [
      fakePiProvider,
      "--marker", marker,
      "--session-name", "p38-session.jsonl",
      "--session-id", options.sessionId,
      "--result-text", "The fake provider recorded the Run result.",
      "--response-delay-ms", "10",
      ...(options.hang ? ["--hang"] : []),
    ],
  });
}

function hasRegisteredWorktree(root: string, target: string): boolean {
  const expected = path.resolve(target).replaceAll("\\", "/").toLowerCase();
  return git(root, "worktree", "list", "--porcelain")
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .some((line) => path.resolve(line.slice("worktree ".length)).replaceAll("\\", "/").toLowerCase() === expected);
}

function closeArgs(input: { root: string; taskDir: string; taskId: string; runId: string }, deliveryRef = "src/feature.ts"): string[] {
  const read = readTaskKernel({ root: input.root, taskDir: input.taskDir, cwd: input.root });
  if (read.kind !== "task-kernel-v2") throw new Error("Expected Task Kernel v2");
  const run = read.kernel.runs.find((item) => item.id === input.runId);
  const review = read.kernel.reviews.at(-1);
  if (!run?.candidateSnapshot || !review) throw new Error("Close needs a candidate and passing Review");
  return [
    "close", input.taskId,
    "--run", input.runId,
    "--review", review.id,
    "--candidate-id", run.candidateSnapshot.id,
    "--candidate-fingerprint", run.candidateSnapshot.fingerprint,
    "--candidate-observed-by", closer,
    "--candidate-observed-at", "2026-09-27T00:03:00.000Z",
    "--candidate-observation-source", "p38-composition-test",
    "--candidate-observation-ref", `candidate:${input.taskId}`,
    "--delivery-level", "local-result",
    "--delivery-ref", deliveryRef,
    "--delivery-summary", "The reviewed Run feature is integrated.",
    "--actor", closer,
    "--idempotency-key", `close:${input.taskId}`,
  ];
}

describe("P38 managed Run lifecycle composition with Pi V2 receipts", () => {
  it("reads the real fake-provider stop receipt through completion, integration, Review, Close, and cleanup", async () => {
    const { root, baseSha } = fixture();
    const taskId = "p38-receipt-close-cleanup";
    const task = createTask(root, taskId);
    const workspace = attachManagedWorktree(root, task.taskDir, task.runId, taskId, baseSha);
    const marker = path.join(root, "fake-pi-started.txt");
    const bridge = piBridge(root, marker, { sessionId: `pi-session-${taskId}` });
    let dispatch: Awaited<ReturnType<PiTaskBridge["run"]>> | null = null;
    try {
      dispatch = await bridge.run({
        root,
        task: taskId,
        runId: task.runId,
        role: "implement",
        prompt: "Implement the approved fixture feature.",
        timeoutMs: 5_000,
      });
    } finally {
      await bridge.close();
    }

    if (!dispatch) throw new Error("Pi V2 dispatch did not return a Run record");
    expect(fs.existsSync(marker)).toBe(true);
    expect(dispatch.outcome).toBe("settled");
    expect(dispatch.process_stop_receipt?.processExit.terminationVerified).toBe(true);
    const stopReceipt = readPiHostStopReceipt(root, taskId, task.runId);
    expect(stopReceipt).toMatchObject({
      taskId,
      taskRunId: task.runId,
      piRunId: dispatch.run_id,
      terminal: "exited",
      assurance: "manager-owned-child-exit",
      processExit: { terminationVerified: true },
    });
    if (!stopReceipt) throw new Error("Real Pi V2 stop receipt was not readable");
    expect(fs.existsSync(path.join(task.taskDir, stopReceipt.evidenceRef))).toBe(true);

    const featurePath = path.join(workspace.canonicalPath, "src", "feature.ts");
    const featureBytes = Buffer.from("export const p38Feature = true;\n");
    fs.writeFileSync(featurePath, featureBytes);
    git(workspace.canonicalPath, "add", "--", "src/feature.ts");
    git(workspace.canonicalPath, "commit", "-q", "-m", "implement reviewed feature");
    git(root, "merge", "--no-ff", "--no-edit", workspace.branch);

    const resultRef = stopReceipt.evidenceRef;
    fs.writeFileSync(path.join(task.taskDir, "run-result.json"), `${JSON.stringify({ taskId, runId: task.runId, resultRef })}\n`);
    const current = readTaskKernel({ root, taskDir: task.taskDir, cwd: root });
    if (current.kind !== "task-kernel-v2") throw new Error("Expected Task Kernel v2");
    const runBeforeCompletion = current.kernel.runs.find((item) => item.id === task.runId);
    if (!runBeforeCompletion) throw new Error("Run disappeared before completion");
    const candidateObservation = observeTaskRunCandidate({ run: runBeforeCompletion });
    if (!("outOfScopePaths" in candidateObservation)) throw new Error("Managed Run must use Git candidate observation");
    expect(candidateObservation.scopeStatus, JSON.stringify({
      branch: candidateObservation.branch,
      expectedBranch: candidateObservation.expectedBranch,
      committedPaths: candidateObservation.committedPaths,
      untrackedPaths: candidateObservation.untrackedPaths,
      outOfScopePaths: candidateObservation.outOfScopePaths,
    })).toBe("within-write-set");
    const completed = recordTaskRunResult({
      root,
      taskDir: task.taskDir,
      expectedRevision: current.kernel.revision,
      runId: task.runId,
      outcome: "completed",
      summary: "The feature was implemented by the Pi V2 Run.",
      candidateEntries: [{ ref: "src/feature.ts", fingerprint: createHash("sha256").update(featureBytes).digest("hex") }],
      evidenceRefs: ["run-result.json", resultRef],
      actor,
      idempotencyKey: `result:${taskId}`,
    });
    const candidate = completed.kernel.runs.find((item) => item.id === task.runId)?.candidateSnapshot;
    if (!candidate) throw new Error("Completed candidate snapshot is missing");

    const integrateLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runWorktreeCli(["integrate", taskId, task.runId, "--target", "main"], root)).toBe(0);
    expect(String(integrateLog.mock.lastCall?.[0])).toContain("contentFingerprint");
    fs.writeFileSync(path.join(task.taskDir, "review.json"), `${JSON.stringify({ taskId, runId: task.runId, candidate: candidate.fingerprint })}\n`);
    const reviewKernel = readTaskKernel({ root, taskDir: task.taskDir, cwd: root });
    if (reviewKernel.kind !== "task-kernel-v2") throw new Error("Expected Task Kernel v2");
    recordTaskReview({
      root,
      taskDir: task.taskDir,
      expectedRevision: reviewKernel.kernel.revision,
      runId: task.runId,
      candidateSnapshotId: candidate.id,
      candidateFingerprint: candidate.fingerprint,
      reviewer,
      decision: "pass",
      evidenceRefs: ["review.json"],
      acceptanceEvidence: { "AC-1": ["src/feature.ts"] },
      actor: reviewer,
      idempotencyKey: `review:${taskId}`,
    });

    const closeLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const closeError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const removal = vi.spyOn(gitRemoval, "removeManagedGitWorktree");
    expect(await runTaskCliWithWorkspaceReclaim(closeArgs({ ...task, root, taskId }), root)).toBe(0);
    const cleanupOutput = closeLog.mock.calls.map(([line]) => String(line)).find((line) => line.includes("task-close-worktree-cleanup"));
    expect(cleanupOutput).toContain('"state": "reclaimed"');
    expect(closeError).not.toHaveBeenCalled();
    expect(removal).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(workspace.canonicalPath)).toBe(false);
    expect(hasRegisteredWorktree(root, workspace.canonicalPath)).toBe(false);
    const closed = readTaskKernel({ root, taskDir: task.taskDir, cwd: root });
    if (closed.kind !== "task-kernel-v2") throw new Error("Expected Task Kernel v2");
    expect(closed.kernel.phase).toBe("close");
    expect(closed.kernel.runs.find((item) => item.id === task.runId)?.workspace?.cleanupLease?.state).toBe("reclaimed");
    expect(readPiHostStopReceipt(root, taskId, task.runId)?.terminal).toBe("exited");
  }, 60_000);

  it("reclaims only a successful retry while failed and cancelled Run checkouts remain owned", async () => {
    const { root, baseSha } = fixture();
    const taskId = "p38-failed-run-retry-preserves-checkouts";
    const first = createTask(root, taskId);
    const oldWorkspace = attachManagedWorktree(root, first.taskDir, first.runId, taskId, baseSha);
    expect(oldWorkspace.ownerRunId).toBe(first.runId);
    const failedMarker = path.join(root, "failed-pi-started.txt");
    const failedBridge = piBridge(root, failedMarker, { sessionId: `pi-session-${taskId}-failed` });
    let failedDispatch: Awaited<ReturnType<PiTaskBridge["run"]>> | null = null;
    try {
      failedDispatch = await failedBridge.run({
        root,
        task: taskId,
        runId: first.runId,
        role: "implement",
        prompt: "MODEL_ERROR: exercise a real Pi V2 failed result.",
        timeoutMs: 5_000,
      });
    } finally {
      await failedBridge.close();
    }
    if (!failedDispatch) throw new Error("Failed Pi V2 dispatch did not return a Run record");
    expect(failedDispatch.outcome).toBe("needs_review");
    expect(failedDispatch.process_stop_receipt?.processExit.terminationVerified).toBe(true);
    expect(readPiHostStopReceipt(root, taskId, first.runId)).toMatchObject({
      taskRunId: first.runId,
      terminal: "exited",
      processExit: { terminationVerified: true },
    });
    const beforeFailure = readTaskKernel({ root, taskDir: first.taskDir, cwd: root });
    if (beforeFailure.kind !== "task-kernel-v2") throw new Error("Expected Task Kernel v2");
    const failed = recordTaskRunResult({
      root,
      taskDir: first.taskDir,
      expectedRevision: beforeFailure.kernel.revision,
      runId: first.runId,
      outcome: "failed",
      summary: "Provider rejected this attempt.",
      failure: { category: "provider-error", message: "Simulated provider rejection.", evidenceRef: null },
      evidenceRefs: [],
      actor,
      idempotencyKey: `failed:${taskId}`,
    });
    expect(failed.kernel.runs.find((item) => item.id === first.runId)?.state).toBe("failed");

    const retryRunId = startRetry(root, first.taskDir, taskId, "cancelled");
    const retryWorkspace = attachManagedWorktree(root, first.taskDir, retryRunId, taskId, baseSha);
    expect(retryWorkspace.ownerRunId).toBe(retryRunId);
    expect(retryRunId).not.toBe(first.runId);
    expect(retryWorkspace.canonicalPath).not.toBe(oldWorkspace.canonicalPath);
    expect(retryWorkspace.manager?.credentialId).not.toBe(oldWorkspace.manager?.credentialId);
    expect(hasRegisteredWorktree(root, oldWorkspace.canonicalPath)).toBe(true);
    expect(hasRegisteredWorktree(root, retryWorkspace.canonicalPath)).toBe(true);

    const removal = vi.spyOn(gitRemoval, "removeManagedGitWorktree");
    const failedCleanup = await reclaimRunWorktree({
      repoRoot: root,
      taskDir: first.taskDir,
      runId: first.runId,
      actor: closer,
      idempotencyKey: `cleanup-failed:${taskId}`,
    });
    expect(failedCleanup.state).toBe("retained");
    expect(failedCleanup.reason).toContain("persisted integration receipt");
    const afterFailedRefusal = readTaskKernel({ root, taskDir: first.taskDir, cwd: root });
    if (afterFailedRefusal.kind !== "task-kernel-v2") throw new Error("Expected Task Kernel v2");
    const failedRefusal = afterFailedRefusal.kernel.events.find(
      (event) => event.type === "run.workspace-cleanup-refused" && event.entityId === first.runId,
    );
    expect(failedRefusal).toMatchObject({ type: "run.workspace-cleanup-refused", entityId: first.runId });
    expect(afterFailedRefusal.kernel.audit.find((entry) => entry.idempotencyKey === failedRefusal?.idempotencyKey)?.evidence)
      .toContain(failedCleanup.reason);
    expect(fs.existsSync(oldWorkspace.canonicalPath)).toBe(true);
    expect(hasRegisteredWorktree(root, oldWorkspace.canonicalPath)).toBe(true);
    expect(hasRegisteredWorktree(root, retryWorkspace.canonicalPath)).toBe(true);
    expect(removal).not.toHaveBeenCalled();

    const cancelMarker = path.join(root, "cancelled-pi-started.txt");
    const cancelBridge = piBridge(root, cancelMarker, { hang: true, sessionId: `pi-session-${taskId}-cancelled` });
    const controller = new AbortController();
    const cancelPromise = cancelBridge.run({
      root,
      task: taskId,
      runId: retryRunId,
      role: "implement",
      prompt: "Cancellation must stop the managed fake Pi process.",
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    const deadline = Date.now() + 3_000;
    while (!fs.existsSync(cancelMarker) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fs.existsSync(cancelMarker)).toBe(true);
    controller.abort();
    let cancelledDispatch: Awaited<ReturnType<PiTaskBridge["run"]>> | null = null;
    try {
      cancelledDispatch = await cancelPromise;
    } finally {
      await cancelBridge.close();
    }
    if (!cancelledDispatch) throw new Error("Cancelled Pi V2 dispatch did not return a Run record");
    expect(cancelledDispatch.outcome).toBe("cancelled");
    expect(cancelledDispatch.process_stop_receipt).toMatchObject({
      terminal: "cancelled",
      processExit: { terminationVerified: true },
    });
    expect(cancelledDispatch.dispatch_lease_released, cancelledDispatch.dispatch_lease_release_reason ?? "").toBe(true);
    expect(readPiHostStopReceipt(root, taskId, retryRunId)).toMatchObject({
      taskRunId: retryRunId,
      terminal: "cancelled",
      processExit: { terminationVerified: true },
    });
    const beforeCancelResult = readTaskKernel({ root, taskDir: first.taskDir, cwd: root });
    if (beforeCancelResult.kind !== "task-kernel-v2") throw new Error("Expected Task Kernel v2");
    const cancelledResult = recordTaskRunResult({
      root,
      taskDir: first.taskDir,
      expectedRevision: beforeCancelResult.kernel.revision,
      runId: retryRunId,
      outcome: "cancelled",
      summary: "The retry was cancelled by the caller.",
      failure: { category: "cancelled", message: "Caller requested cancellation.", evidenceRef: null },
      evidenceRefs: [],
      actor,
      idempotencyKey: `cancelled:${taskId}`,
    });
    expect(cancelledResult.kernel.runs.find((item) => item.id === retryRunId)?.state).toBe("cancelled");
    const cancelledCleanup = await reclaimRunWorktree({
      repoRoot: root,
      taskDir: first.taskDir,
      runId: retryRunId,
      actor: closer,
      idempotencyKey: `cleanup-cancelled:${taskId}`,
    });
    expect(cancelledCleanup.state).toBe("retained");
    expect(cancelledCleanup.reason).toContain("persisted integration receipt");
    const afterCancelledRefusal = readTaskKernel({ root, taskDir: first.taskDir, cwd: root });
    if (afterCancelledRefusal.kind !== "task-kernel-v2") throw new Error("Expected Task Kernel v2");
    const cancelledRefusal = afterCancelledRefusal.kernel.events.find(
      (event) => event.type === "run.workspace-cleanup-refused" && event.entityId === retryRunId,
    );
    expect(cancelledRefusal).toMatchObject({ type: "run.workspace-cleanup-refused", entityId: retryRunId });
    expect(afterCancelledRefusal.kernel.audit.find((entry) => entry.idempotencyKey === cancelledRefusal?.idempotencyKey)?.evidence)
      .toContain(cancelledCleanup.reason);
    expect(fs.existsSync(oldWorkspace.canonicalPath)).toBe(true);
    expect(fs.existsSync(retryWorkspace.canonicalPath)).toBe(true);
    expect(hasRegisteredWorktree(root, oldWorkspace.canonicalPath)).toBe(true);
    expect(hasRegisteredWorktree(root, retryWorkspace.canonicalPath)).toBe(true);
    expect(removal).not.toHaveBeenCalled();

    const protectedRunIds = new Set([first.runId, retryRunId]);
    const runRecordsBeforeSuccess = afterCancelledRefusal.kernel.runs
      .filter((item) => protectedRunIds.has(item.id))
      .map((item) => structuredClone(item));
    expect(runRecordsBeforeSuccess).toHaveLength(2);
    const preservedOwnerRecords = readAllManagerProvenance(repoIdentity(root))
      .filter((item) => protectedRunIds.has(item.ownerRunId));
    expect(preservedOwnerRecords).toHaveLength(2);
    expect(preservedOwnerRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ownerRunId: first.runId,
        credentialId: oldWorkspace.manager?.credentialId,
        canonicalPath: oldWorkspace.canonicalPath,
      }),
      expect.objectContaining({
        ownerRunId: retryRunId,
        credentialId: retryWorkspace.manager?.credentialId,
        canonicalPath: retryWorkspace.canonicalPath,
      }),
    ]));

    const successRunId = startRetry(root, first.taskDir, taskId, "success");
    const successWorkspace = attachManagedWorktree(root, first.taskDir, successRunId, taskId, baseSha);
    expect(successWorkspace.ownerRunId).toBe(successRunId);
    expect(successWorkspace.canonicalPath).not.toBe(oldWorkspace.canonicalPath);
    expect(successWorkspace.canonicalPath).not.toBe(retryWorkspace.canonicalPath);
    expect(successWorkspace.manager?.credentialId).not.toBe(oldWorkspace.manager?.credentialId);
    expect(successWorkspace.manager?.credentialId).not.toBe(retryWorkspace.manager?.credentialId);
    expect(hasRegisteredWorktree(root, successWorkspace.canonicalPath)).toBe(true);

    const successMarker = path.join(root, "successful-retry-pi-started.txt");
    const successBridge = piBridge(root, successMarker, { sessionId: `pi-session-${taskId}-success` });
    let successDispatch: Awaited<ReturnType<PiTaskBridge["run"]>> | null = null;
    try {
      successDispatch = await successBridge.run({
        root,
        task: taskId,
        runId: successRunId,
        role: "implement",
        prompt: "Complete the successful retry after the cancelled attempt.",
        timeoutMs: 5_000,
      });
    } finally {
      await successBridge.close();
    }
    if (!successDispatch) throw new Error("Successful retry Pi V2 dispatch did not return a Run record");
    expect(fs.existsSync(successMarker)).toBe(true);
    expect(successDispatch.outcome).toBe("settled");
    const successStopReceipt = readPiHostStopReceipt(root, taskId, successRunId);
    expect(successStopReceipt).toMatchObject({
      taskRunId: successRunId,
      terminal: "exited",
      processExit: { terminationVerified: true },
    });
    if (!successStopReceipt) throw new Error("Successful retry stop receipt was not readable");

    const successFeaturePath = path.join(successWorkspace.canonicalPath, "src", "retry-feature.ts");
    const successFeatureBytes = Buffer.from("export const retryFeature = true;\n");
    fs.writeFileSync(successFeaturePath, successFeatureBytes);
    git(successWorkspace.canonicalPath, "add", "--", "src/retry-feature.ts");
    git(successWorkspace.canonicalPath, "commit", "-q", "-m", "complete successful retry");
    git(root, "merge", "--no-ff", "--no-edit", successWorkspace.branch);

    const successResultRef = successStopReceipt.evidenceRef;
    fs.writeFileSync(path.join(first.taskDir, "successful-run-result.json"), `${JSON.stringify({ taskId, runId: successRunId, resultRef: successResultRef })}\n`);
    const beforeSuccessResult = readTaskKernel({ root, taskDir: first.taskDir, cwd: root });
    if (beforeSuccessResult.kind !== "task-kernel-v2") throw new Error("Expected Task Kernel v2");
    const completedSuccess = recordTaskRunResult({
      root,
      taskDir: first.taskDir,
      expectedRevision: beforeSuccessResult.kernel.revision,
      runId: successRunId,
      outcome: "completed",
      summary: "The successful retry implemented the feature.",
      candidateEntries: [{ ref: "src/retry-feature.ts", fingerprint: createHash("sha256").update(successFeatureBytes).digest("hex") }],
      evidenceRefs: ["successful-run-result.json", successResultRef],
      actor,
      idempotencyKey: `result:${taskId}:success`,
    });
    const successCandidate = completedSuccess.kernel.runs.find((item) => item.id === successRunId)?.candidateSnapshot;
    if (!successCandidate) throw new Error("Successful retry candidate snapshot is missing");

    const successIntegrateLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runWorktreeCli(["integrate", taskId, successRunId, "--target", "main"], root)).toBe(0);
    expect(String(successIntegrateLog.mock.lastCall?.[0])).toContain("contentFingerprint");
    fs.writeFileSync(path.join(first.taskDir, "successful-review.json"), `${JSON.stringify({ taskId, runId: successRunId, candidate: successCandidate.fingerprint })}\n`);
    const beforeSuccessReview = readTaskKernel({ root, taskDir: first.taskDir, cwd: root });
    if (beforeSuccessReview.kind !== "task-kernel-v2") throw new Error("Expected Task Kernel v2");
    recordTaskReview({
      root,
      taskDir: first.taskDir,
      expectedRevision: beforeSuccessReview.kernel.revision,
      runId: successRunId,
      candidateSnapshotId: successCandidate.id,
      candidateFingerprint: successCandidate.fingerprint,
      reviewer,
      decision: "pass",
      evidenceRefs: ["successful-review.json"],
      acceptanceEvidence: { "AC-1": ["src/retry-feature.ts"] },
      actor: reviewer,
      idempotencyKey: `review:${taskId}:success`,
    });

    successIntegrateLog.mockClear();
    const closeError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const closeCode = await runTaskCliWithWorkspaceReclaim(
      closeArgs({ root, taskDir: first.taskDir, taskId, runId: successRunId }, "src/retry-feature.ts"),
      root,
    );
    const closeOutput = successIntegrateLog.mock.calls.map(([line]) => String(line))
      .find((line) => line.includes("task-close-worktree-cleanup"));
    expect(closeCode).toBe(0);
    expect(closeOutput).toContain('"state": "reclaimed"');
    expect(closeError).not.toHaveBeenCalled();
    expect(removal).toHaveBeenCalledTimes(1);
    expect(path.resolve(String(removal.mock.calls[0]?.[1]))).toBe(path.resolve(successWorkspace.canonicalPath));

    const finalKernel = readTaskKernel({ root, taskDir: first.taskDir, cwd: root });
    if (finalKernel.kind !== "task-kernel-v2") throw new Error("Expected Task Kernel v2");
    expect(finalKernel.kernel.phase).toBe("close");
    expect(finalKernel.kernel.runs.filter((item) => protectedRunIds.has(item.id))).toEqual(runRecordsBeforeSuccess);
    expect(finalKernel.kernel.runs.find((item) => item.id === successRunId)?.workspace?.cleanupLease?.state).toBe("reclaimed");
    expect(fs.existsSync(successWorkspace.canonicalPath)).toBe(false);
    expect(hasRegisteredWorktree(root, successWorkspace.canonicalPath)).toBe(false);
    expect(fs.readFileSync(path.join(root, "src", "retry-feature.ts"), "utf8")).toContain("retryFeature");
    for (const protectedWorkspace of [oldWorkspace, retryWorkspace]) {
      expect(fs.existsSync(protectedWorkspace.canonicalPath)).toBe(true);
      expect(hasRegisteredWorktree(root, protectedWorkspace.canonicalPath)).toBe(true);
    }
    const preservedOwnersAfterCleanup = readAllManagerProvenance(repoIdentity(root))
      .filter((item) => protectedRunIds.has(item.ownerRunId));
    expect(preservedOwnersAfterCleanup).toEqual(preservedOwnerRecords);
  }, 60_000);
});
