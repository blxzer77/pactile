import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendTaskRunHostSettlementRefs,
  bindTaskRunHostReceipt,
  closeTaskKernel,
  createTaskKernel,
  readTaskKernel,
  recordTaskReview,
  recordTaskRunResult,
  startTaskRun,
} from "../../../src/core/task/index.js";
import { adoptTaskRunWorktree, createTaskRunWorktree, integrateTaskRunWorktree, reclaimRunWorktree } from "../../../src/pactile/worktree/index.js";
import * as gitRemoval from "../../../src/pactile/worktree/git-removal.js";

const { readPiHostStopReceiptMock } = vi.hoisted(() => ({ readPiHostStopReceiptMock: vi.fn() }));
vi.mock("../../../src/pactile/pi/bridge.js", () => ({ readPiHostStopReceipt: readPiHostStopReceiptMock }));

const roots: string[] = [];
const fixturePrefix = "pactile-p38-managed-lifecycle-";
const runActor = "worker";
const approver = "approver";
const reviewer = "independent-reviewer";
const closer = "closer";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(/\r?\n$/, "");
}

function fixture(): { root: string; baseSha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), fixturePrefix));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Pactile Test");
  git(root, "config", "user.email", "pactile@example.invalid");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  fs.writeFileSync(path.join(root, "src", "base.ts"), "export const base = true;\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  git(root, "add", "README.md", ".gitignore", "src/base.ts");
  git(root, "commit", "-q", "-m", "base");
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
  vi.clearAllMocks();
  vi.restoreAllMocks();
  removeFixtures();
});

function readKernel(root: string, taskDir: string) {
  const read = readTaskKernel({ root, taskDir, cwd: root });
  if (read.kind !== "task-kernel-v2") throw new Error("Expected Task Kernel v2");
  return read.kernel;
}

function prepareIntegratedRun(input: { root: string; baseSha: string; taskId: string; close: boolean }) {
  const { root, baseSha, taskId } = input;
  const taskDir = path.join(root, ".pactile", "tasks", taskId);
  const created = createTaskKernel({
    root, taskDir, actor: "author", idempotencyKey: `create:${taskId}`,
    definition: {
      taskId, title: "Worktree lifecycle test", description: "", deliverable: "closed result",
      deliveryLevel: "local-result", acceptanceCriteria: [{ id: "AC-1", description: "feature is present" }], dependencies: [],
    },
  });
  const started = startTaskRun({
    root, taskDir, expectedRevision: created.kernel.revision, actor: runActor, idempotencyKey: `start:${taskId}`,
    input: { summary: "Implement the feature", references: ["test task"] },
    authorization: { approvedBy: approver, approvedAt: "2026-09-26T00:00:00.000Z", scope: "src", evidenceRef: "approval:test" },
    writeSetSnapshot: ["src"],
  });
  const runId = started.kernel.runs.at(-1)?.id;
  if (!runId) throw new Error("Started Run is missing");
  const workspace = createTaskRunWorktree({
    repoRoot: root, taskDir, runId, branch: `feat/${taskId}`, baseRef: baseSha,
    actor: runActor, idempotencyKey: `workspace:${taskId}`,
  }).binding;

  let kernel = readKernel(root, taskDir);
  const piRunId = `pi-${taskId}`;
  const startRequestId = `pi-start:${taskId}`;
  const settleReceiptId = `pi-settle:${taskId}`;
  const receiptFile = `pi-bridge/runs/${piRunId}.json`;
  const evidenceRef = `${receiptFile}#process_stop_receipt`;
  bindTaskRunHostReceipt({
    root, taskDir, expectedRevision: kernel.revision, runId,
    host: {
      host: "pi", role: "implement", sessionId: `session-${taskId}`, hostId: null, threadId: null,
      requestRefs: [startRequestId], eventRefs: [`pi-bridge/events/${piRunId}.jsonl`], resultRefs: [],
      assuranceSource: "manager-owned-child-exit",
    },
    actor: runActor, idempotencyKey: `host-bind:${taskId}`,
  });
  kernel = readKernel(root, taskDir);
  appendTaskRunHostSettlementRefs({
    root, taskDir, expectedRevision: kernel.revision, runId,
    eventRefs: [settleReceiptId], resultRefs: [receiptFile],
    actor: runActor, idempotencyKey: `host-settle:${taskId}`,
  });

  const featurePath = path.join(workspace.canonicalPath, "src", "feature.ts");
  fs.writeFileSync(featurePath, "export const feature = true;\n");
  git(workspace.canonicalPath, "add", "--", "src/feature.ts");
  git(workspace.canonicalPath, "commit", "-q", "-m", "Run feature");
  git(root, "merge", "--no-ff", "--no-edit", workspace.branch);

  kernel = readKernel(root, taskDir);
  const completed = recordTaskRunResult({
    root, taskDir, expectedRevision: kernel.revision, runId, outcome: "completed", summary: "Feature implemented",
    candidateEntries: [{ ref: "src/feature.ts", fingerprint: "a".repeat(64) }], evidenceRefs: [`run-result:${taskId}`],
    actor: runActor, idempotencyKey: `run-result:${taskId}`,
  });
  const candidate = completed.kernel.runs.at(-1)?.candidateSnapshot;
  if (!candidate) throw new Error("Completed Run candidate is missing");
  integrateTaskRunWorktree({ repoRoot: root, taskDir, runId, targetRef: "main", actor: runActor, idempotencyKey: `integrate:${taskId}` });
  kernel = readKernel(root, taskDir);
  recordTaskReview({
    root, taskDir, expectedRevision: kernel.revision, runId, candidateSnapshotId: candidate.id,
    candidateFingerprint: candidate.fingerprint, reviewer, decision: "pass", evidenceRefs: [`review:${taskId}`],
    acceptanceEvidence: { "AC-1": ["src/feature.ts"] }, actor: reviewer, idempotencyKey: `review:${taskId}`,
  });
  if (input.close) {
    kernel = readKernel(root, taskDir);
    const review = kernel.reviews.at(-1);
    if (!review) throw new Error("Passing Review is missing");
    closeTaskKernel({
      root, taskDir, expectedRevision: kernel.revision, runId, reviewId: review.id,
      candidateObservation: {
        snapshotId: candidate.id, fingerprint: candidate.fingerprint, observedBy: closer,
        observedAt: "2026-09-26T00:01:00.000Z", source: "test-observer", evidenceRef: `candidate:${taskId}`,
      },
      deliveryEvidence: { level: "local-result", reference: "src/feature.ts", summary: "The accepted feature is present" },
      actor: closer, idempotencyKey: `close:${taskId}`,
    });
  }
  readPiHostStopReceiptMock.mockResolvedValue({
    schemaVersion: 1, source: "pactile-pi-rpc", assurance: "manager-owned-child-exit",
    taskId, taskRunId: runId, piRunId, role: "implement", sessionId: `session-${taskId}`, processId: 31415,
    startRequestId, settleReceiptId, terminal: "exited", exitCode: 0, signalCode: null,
    cancellationRequestId: null, evidenceRef, recordedAt: "2026-09-26T00:00:30.000Z",
  });
  return { root, taskDir, taskId, runId, workspace, piRunId, receiptFile };
}

function hasRegisteredWorktree(root: string, target: string): boolean {
  const expected = path.resolve(target).replaceAll("\\", "/").toLowerCase();
  return git(root, "worktree", "list", "--porcelain").split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .some((line) => path.resolve(line.slice("worktree ".length)).replaceAll("\\", "/").toLowerCase() === expected);
}

describe("managed Run worktree reclamation", () => {
  it("adopts only a clean registered checkout after explicit approval and binds its owner to the Task Run", () => {
    const { root, baseSha } = fixture();
    const taskId = "cleanup-adopted";
    const taskDir = path.join(root, ".pactile", "tasks", taskId);
    const created = createTaskKernel({
      root, taskDir, actor: "author", idempotencyKey: `create:${taskId}`,
      definition: {
        taskId, title: "Adopt a Run checkout", description: "", deliverable: "a verified workspace",
        deliveryLevel: "local-result", acceptanceCriteria: [{ id: "AC-1", description: "Workspace is bound" }], dependencies: [],
      },
    });
    const started = startTaskRun({
      root, taskDir, expectedRevision: created.kernel.revision, actor: runActor, idempotencyKey: `start:${taskId}`,
      input: { summary: "Use a pre-existing clean checkout", references: ["task contract"] },
      authorization: { approvedBy: approver, approvedAt: "2026-09-26T00:00:00.000Z", scope: "src", evidenceRef: "approval:adopt" },
      writeSetSnapshot: ["src"],
    });
    const runId = started.kernel.runs.at(-1)?.id;
    if (!runId) throw new Error("Started Run is missing");
    const canonicalPath = path.join(root, ".pactile", "worktrees", runId);
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    git(root, "worktree", "add", "--no-track", "-b", `feat/${taskId}`, canonicalPath, baseSha);

    const result = adoptTaskRunWorktree({
      repoRoot: root, taskDir, runId, canonicalPath, branch: `feat/${taskId}`, baseSha,
      authorization: { approvedBy: approver, approvedAt: "2026-09-26T00:01:00.000Z", evidenceRef: "adoption:approval" },
      actor: runActor, idempotencyKey: `adopt:${taskId}`,
    });

    expect(result.binding).toMatchObject({ ownerRunId: runId, integrationState: "not-integrated", manager: { source: "adopted" } });
    expect(readKernel(root, taskDir).runs.at(-1)?.workspace).toMatchObject({
      ownerRunId: runId, canonicalPath, manager: { credentialId: result.binding.manager?.credentialId, source: "adopted" },
    });
  });

  it("uses non-force Git removal only after candidate, host stop, integration, and Close are bound", async () => {
    const { root, baseSha } = fixture();
    const prepared = prepareIntegratedRun({ root, baseSha, taskId: "cleanup-success", close: true });
    expect(readKernel(root, prepared.taskDir).runs.at(-1)?.workspace?.integrationReceipt?.contentFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const removal = vi.spyOn(gitRemoval, "removeManagedGitWorktree");

    const result = await reclaimRunWorktree({
      repoRoot: root, taskDir: prepared.taskDir, runId: prepared.runId,
      actor: closer, idempotencyKey: "cleanup-success:reclaim",
    });

    expect(result.state, JSON.stringify(result)).toBe("reclaimed");
    expect(result.binding.cleanupLease?.riskDisclosure).toContain("ignored file");
    expect(removal).toHaveBeenCalledTimes(1);
    expect(removal.mock.calls[0]?.slice(0, 2)).toEqual([root, prepared.workspace.canonicalPath]);
    expect(fs.existsSync(prepared.workspace.canonicalPath)).toBe(false);
    expect(hasRegisteredWorktree(root, prepared.workspace.canonicalPath)).toBe(false);
    const kernel = readKernel(root, prepared.taskDir);
    const run = kernel.runs.find((item) => item.id === prepared.runId);
    expect(kernel.phase).toBe("close");
    expect(run?.workspace?.cleanupLease?.state).toBe("reclaimed");
    expect(run?.host?.stopReceipt).toMatchObject({
      source: "pactile-pi-rpc", assurance: "manager-owned-child-exit", terminalStatus: "exited",
      candidateSource: "derived", candidateSnapshotId: run.candidateSnapshot?.id,
    });

    const repeated = await reclaimRunWorktree({
      repoRoot: root, taskDir: prepared.taskDir, runId: prepared.runId,
      actor: closer, idempotencyKey: "cleanup-success:reclaim-again",
    });
    expect(repeated.state, JSON.stringify(repeated)).toBe("reclaimed");
    expect(removal).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(prepared.workspace.canonicalPath)).toBe(false);
  });

  it("retains a Run before Close without invoking Git removal", async () => {
    const { root, baseSha } = fixture();
    const prepared = prepareIntegratedRun({ root, baseSha, taskId: "cleanup-open", close: false });
    const removal = vi.spyOn(gitRemoval, "removeManagedGitWorktree");

    const result = await reclaimRunWorktree({
      repoRoot: root, taskDir: prepared.taskDir, runId: prepared.runId,
      actor: closer, idempotencyKey: "cleanup-open:reclaim",
    });

    expect(result.state).toBe("retained");
    expect(removal).not.toHaveBeenCalled();
    expect(fs.existsSync(prepared.workspace.canonicalPath)).toBe(true);
    expect(hasRegisteredWorktree(root, prepared.workspace.canonicalPath)).toBe(true);
  });

  it("rechecks ignored user data immediately before invoking Git and preserves it", async () => {
    const { root, baseSha } = fixture();
    const prepared = prepareIntegratedRun({ root, baseSha, taskId: "cleanup-residue", close: true });
    const remove = gitRemoval.removeManagedGitWorktree;
    vi.spyOn(gitRemoval, "removeManagedGitWorktree").mockImplementationOnce((repoRoot, worktreePath, verifyBeforeRemove) => {
      const ignoredPath = path.join(worktreePath, "node_modules", "preserve-me.txt");
      fs.mkdirSync(path.dirname(ignoredPath), { recursive: true });
      fs.writeFileSync(ignoredPath, "ignored contents remain user-owned\n");
      remove(repoRoot, worktreePath, verifyBeforeRemove);
    });

    const result = await reclaimRunWorktree({
      repoRoot: root, taskDir: prepared.taskDir, runId: prepared.runId,
      actor: closer, idempotencyKey: "cleanup-residue:reclaim",
    });

    const ignoredPath = path.join(prepared.workspace.canonicalPath, "node_modules", "preserve-me.txt");
    expect(result.state, JSON.stringify(result)).toBe("recovery-required");
    expect(fs.readFileSync(ignoredPath, "utf8")).toContain("user-owned");
    expect(fs.existsSync(prepared.workspace.canonicalPath)).toBe(true);
    expect(hasRegisteredWorktree(root, prepared.workspace.canonicalPath)).toBe(true);
    expect(readKernel(root, prepared.taskDir).runs.at(-1)?.workspace?.cleanupLease?.state).toBe("recovery-required");
  });

  it("records Git-unregistered residue as partial removal without deleting it", async () => {
    const { root, baseSha } = fixture();
    const prepared = prepareIntegratedRun({ root, baseSha, taskId: "cleanup-residue", close: true });
    const remove = gitRemoval.removeManagedGitWorktree;
    vi.spyOn(gitRemoval, "removeManagedGitWorktree").mockImplementationOnce((repoRoot, worktreePath, verifyBeforeRemove) => {
      verifyBeforeRemove();
      remove(repoRoot, worktreePath, () => undefined);
      const residue = path.join(worktreePath, "preserved-after-git-removal.txt");
      fs.mkdirSync(path.dirname(residue), { recursive: true });
      fs.writeFileSync(residue, "residue preserved after registration removal\n");
      throw new Error("simulated interrupted post-registration directory removal");
    });

    const result = await reclaimRunWorktree({
      repoRoot: root, taskDir: prepared.taskDir, runId: prepared.runId,
      actor: closer, idempotencyKey: "cleanup-residue:reclaim",
    });

    const residue = path.join(prepared.workspace.canonicalPath, "preserved-after-git-removal.txt");
    expect(result.state).toBe("partial-removal");
    expect(fs.readFileSync(residue, "utf8")).toContain("preserved");
    expect(fs.existsSync(prepared.workspace.canonicalPath)).toBe(true);
    expect(hasRegisteredWorktree(root, prepared.workspace.canonicalPath)).toBe(false);
    expect(readKernel(root, prepared.taskDir).runs.at(-1)?.workspace?.cleanupLease?.state).toBe("partial-removal");
  });

  it("restores a checkout at a late clean commit and marks recovery instead of reporting reclaimed", async () => {
    const { root, baseSha } = fixture();
    const prepared = prepareIntegratedRun({ root, baseSha, taskId: "cleanup-race", close: true });
    const remove = gitRemoval.removeManagedGitWorktree;
    vi.spyOn(gitRemoval, "removeManagedGitWorktree").mockImplementationOnce((repoRoot, worktreePath, verifyBeforeRemove) => {
      verifyBeforeRemove();
      const lateFile = path.join(worktreePath, "src", "late.ts");
      fs.writeFileSync(lateFile, "export const late = true;\n");
      git(worktreePath, "add", "--", "src/late.ts");
      git(worktreePath, "commit", "-q", "-m", "late user commit");
      remove(repoRoot, worktreePath, () => undefined);
    });

    const result = await reclaimRunWorktree({
      repoRoot: root, taskDir: prepared.taskDir, runId: prepared.runId,
      actor: closer, idempotencyKey: "cleanup-race:reclaim",
    });

    const kernel = readKernel(root, prepared.taskDir);
    const run = kernel.runs.find((item) => item.id === prepared.runId);
    expect(result.state, JSON.stringify(result)).toBe("recovery-required");
    expect(fs.existsSync(path.join(prepared.workspace.canonicalPath, "src", "late.ts")), JSON.stringify(result)).toBe(true);
    expect(git(prepared.workspace.canonicalPath, "rev-parse", "HEAD")).toBe(git(root, "rev-parse", `refs/heads/${prepared.workspace.branch}`));
    expect(hasRegisteredWorktree(root, prepared.workspace.canonicalPath)).toBe(true);
    expect(run?.workspace?.cleanupLease?.state).toBe("recovery-required");
    expect(path.resolve(run?.workspace?.manager?.gitDir ?? "")).toBe(path.resolve(git(prepared.workspace.canonicalPath, "rev-parse", "--absolute-git-dir")));
  });

  it("restores the Run checkout when the target rewrites deliverable content after the final pre-removal check", async () => {
    const { root, baseSha } = fixture();
    const prepared = prepareIntegratedRun({ root, baseSha, taskId: "cleanup-target-race", close: true });
    const remove = gitRemoval.removeManagedGitWorktree;
    vi.spyOn(gitRemoval, "removeManagedGitWorktree").mockImplementationOnce((repoRoot, worktreePath, verifyBeforeRemove) => {
      verifyBeforeRemove();
      fs.writeFileSync(path.join(root, "src", "feature.ts"), "export const targetRewrite = true;\n");
      git(root, "add", "--", "src/feature.ts");
      git(root, "commit", "-q", "-m", "target rewrite after preflight");
      remove(repoRoot, worktreePath, () => undefined);
    });

    const result = await reclaimRunWorktree({
      repoRoot: root, taskDir: prepared.taskDir, runId: prepared.runId,
      actor: closer, idempotencyKey: "cleanup-target-race:reclaim",
    });

    const run = readKernel(root, prepared.taskDir).runs.find((item) => item.id === prepared.runId);
    expect(result.state, JSON.stringify(result)).toBe("recovery-required");
    expect(fs.readFileSync(path.join(root, "src", "feature.ts"), "utf8")).toContain("targetRewrite");
    expect(fs.readFileSync(path.join(prepared.workspace.canonicalPath, "src", "feature.ts"), "utf8")).toContain("feature = true");
    expect(git(prepared.workspace.canonicalPath, "rev-parse", "HEAD")).toBe(git(root, "rev-parse", `refs/heads/${prepared.workspace.branch}`));
    expect(hasRegisteredWorktree(root, prepared.workspace.canonicalPath)).toBe(true);
    expect(run?.workspace?.cleanupLease?.state).toBe("recovery-required");
  });
});
