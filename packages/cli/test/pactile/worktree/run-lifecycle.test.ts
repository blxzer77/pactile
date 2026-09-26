import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as taskKernelApi from "../../../src/core/task/task-kernel.js";
import {
  acquireTaskRunWorkspaceCleanupLease,
  appendTaskRunHostSettlementRefs,
  bindTaskRunHostReceipt,
  closeTaskKernel,
  createTaskKernel,
  readTaskKernel,
  recordTaskRunHostStopReceipt,
  recordTaskReview,
  recordTaskRunResult,
  startTaskRun,
} from "../../../src/core/task/index.js";
import { TASK_RUN_WORKSPACE_CLEANUP_RISK_DISCLOSURE } from "../../../src/core/task/task-kernel-types.js";
import { adoptTaskRunWorktree, createTaskRunWorktree, integrateTaskRunWorktree, reclaimRunWorktree } from "../../../src/pactile/worktree/index.js";
import { runTaskCliWithWorkspaceReclaim } from "../../../src/commands/task-worktree-close.js";
import { runWorktreeCli } from "../../../src/commands/worktree.js";
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

function prepareIntegratedRun(input: { root: string; baseSha: string; taskId: string; close: boolean; integrate?: boolean }) {
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
    writeSetSnapshot: ["src/"],
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
  const featureBytes = "export const feature = true;\n";
  fs.writeFileSync(featurePath, featureBytes);
  git(workspace.canonicalPath, "add", "--", "src/feature.ts");
  git(workspace.canonicalPath, "commit", "-q", "-m", "Run feature");
  git(root, "merge", "--no-ff", "--no-edit", workspace.branch);

  kernel = readKernel(root, taskDir);
  fs.writeFileSync(path.join(taskDir, "run-result.json"), JSON.stringify({ taskId, runId, status: "completed" }) + "\n");
  const completed = recordTaskRunResult({
    root, taskDir, expectedRevision: kernel.revision, runId, outcome: "completed", summary: "Feature implemented",
    candidateEntries: [{ ref: "src/feature.ts", fingerprint: createHash("sha256").update(featureBytes).digest("hex") }], evidenceRefs: ["run-result.json"],
    actor: runActor, idempotencyKey: `run-result:${taskId}`,
  });
  const candidate = completed.kernel.runs.at(-1)?.candidateSnapshot;
  if (!candidate) throw new Error("Completed Run candidate is missing");
  if (input.integrate !== false) {
    integrateTaskRunWorktree({ repoRoot: root, taskDir, runId, targetRef: "main", actor: runActor, idempotencyKey: `integrate:${taskId}` });
  }
  kernel = readKernel(root, taskDir);
  fs.writeFileSync(path.join(taskDir, "review.json"), JSON.stringify({ taskId, runId, candidate: candidate.fingerprint }) + "\n");
  recordTaskReview({
    root, taskDir, expectedRevision: kernel.revision, runId, candidateSnapshotId: candidate.id,
    candidateFingerprint: candidate.fingerprint, reviewer, decision: "pass", evidenceRefs: ["review.json"],
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

function closeArgs(prepared: ReturnType<typeof prepareIntegratedRun>): string[] {
  const kernel = readKernel(prepared.root, prepared.taskDir);
  const run = kernel.runs.find((item) => item.id === prepared.runId);
  const review = kernel.reviews.at(-1);
  if (!run?.candidateSnapshot || !review) throw new Error("Close needs a candidate and passing review");
  return [
    "close", prepared.taskId,
    "--run", prepared.runId,
    "--review", review.id,
    "--candidate-id", run.candidateSnapshot.id,
    "--candidate-fingerprint", run.candidateSnapshot.fingerprint,
    "--candidate-observed-by", closer,
    "--candidate-observed-at", "2026-09-26T00:02:00.000Z",
    "--candidate-observation-source", "test-observer",
    "--candidate-observation-ref", `candidate:${prepared.taskId}`,
    "--delivery-level", "local-result",
    "--delivery-ref", "src/feature.ts",
    "--delivery-summary", "The reviewed result is present",
    "--idempotency-key", `task-close:${prepared.taskId}`,
  ];
}

function hasRegisteredWorktree(root: string, target: string): boolean {
  const expected = path.resolve(target).replaceAll("\\", "/").toLowerCase();
  return git(root, "worktree", "list", "--porcelain").split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .some((line) => path.resolve(line.slice("worktree ".length)).replaceAll("\\", "/").toLowerCase() === expected);
}

function startActiveTaskRun(root: string, taskId: string): { taskDir: string; runId: string } {
  const taskDir = path.join(root, ".pactile", "tasks", taskId);
  const created = createTaskKernel({
    root, taskDir, actor: "author", idempotencyKey: `create:${taskId}`,
    definition: {
      taskId, title: "Worktree claim audit", description: "", deliverable: "an isolated checkout",
      deliveryLevel: "local-result", acceptanceCriteria: [{ id: "AC-1", description: "Run claim is auditable" }], dependencies: [],
    },
  });
  const started = startTaskRun({
    root, taskDir, expectedRevision: created.kernel.revision, actor: runActor, idempotencyKey: `start:${taskId}`,
    input: { summary: "Claim an isolated checkout", references: [] },
    authorization: { approvedBy: approver, approvedAt: "2026-09-26T00:00:00.000Z", scope: "src", evidenceRef: `approval:${taskId}` },
    writeSetSnapshot: ["src"],
  });
  const runId = started.kernel.runs.at(-1)?.id;
  if (!runId) throw new Error("Started Run is missing");
  return { taskDir, runId };
}

function snapshotFiles(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (directory: string, relative = ""): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) snapshot[childRelative] = `symlink:${fs.readlinkSync(child)}`;
      else if (entry.isDirectory()) visit(child, childRelative);
      else if (entry.isFile()) snapshot[childRelative] = fs.readFileSync(child).toString("base64");
      else snapshot[childRelative] = `other:${entry.mode}`;
    }
  };
  visit(root);
  return snapshot;
}

describe("managed Run worktree reclamation", () => {
  it("persists Run B adoption conflicts and retries idempotently without changing Run A ownership", () => {
    const { root, baseSha } = fixture();
    const ownerA = startActiveTaskRun(root, "claim-owner-a");
    const ownerB = startActiveTaskRun(root, "claim-owner-b");
    const workspaceA = createTaskRunWorktree({
      repoRoot: root, taskDir: ownerA.taskDir, runId: ownerA.runId, branch: "feat/claim-owner-a", baseRef: baseSha,
      actor: runActor, idempotencyKey: "owner-a-create",
    }).binding;
    const ownerAKernelBefore = readKernel(root, ownerA.taskDir);
    const commonDir = path.resolve(root, git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    const registry = path.join(commonDir, "pactile-run-workspaces-v1");
    const managerFilesBefore = snapshotFiles(registry);
    const checkoutFilesBefore = snapshotFiles(workspaceA.canonicalPath);
    const gitRegistrationsBefore = git(root, "worktree", "list", "--porcelain");
    const refusalKey = "owner-b-adopt-conflict-secret-key";
    const adopt = () => adoptTaskRunWorktree({
      repoRoot: root,
      taskDir: ownerB.taskDir,
      runId: ownerB.runId,
      canonicalPath: workspaceA.canonicalPath,
      branch: workspaceA.branch,
      baseSha,
      authorization: { approvedBy: approver, approvedAt: "2026-09-26T00:01:00.000Z", evidenceRef: "adoption:owner-b" },
      actor: runActor,
      idempotencyKey: refusalKey,
    });

    let firstError: unknown;
    try { adopt(); } catch (error) { firstError = error; }
    expect(firstError).toMatchObject({ code: "owner-conflict" });
    const ownerBKernelAfterFirstRefusal = readKernel(root, ownerB.taskDir);
    const refusal = ownerBKernelAfterFirstRefusal.events.find(
      (event) => event.type === "run.workspace-claim-refused" && event.entityId === ownerB.runId,
    );
    const refusalAudit = ownerBKernelAfterFirstRefusal.audit.find((entry) => entry.idempotencyKey === refusal?.idempotencyKey);
    expect(refusal).toMatchObject({ type: "run.workspace-claim-refused", entityId: ownerB.runId });
    expect(refusal?.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(refusal?.idempotencyKey).toMatch(/^workspace-claim-refused:[a-f0-9]{64}$/);
    expect(refusal?.idempotencyKey).not.toContain(refusalKey);
    expect(refusalAudit?.evidence).toContain("Workspace adopt claim refused [owner-conflict]:");
    expect(refusalAudit?.evidence).not.toContain(workspaceA.canonicalPath);
    expect(refusalAudit?.evidence).not.toContain(workspaceA.manager?.credentialId);
    expect(ownerBKernelAfterFirstRefusal.runs.find((run) => run.id === ownerB.runId)?.workspace).toBeNull();

    let retryError: unknown;
    try { adopt(); } catch (error) { retryError = error; }
    expect(retryError).toMatchObject({ code: "owner-conflict" });
    const ownerBKernelAfterRetry = readKernel(root, ownerB.taskDir);
    expect(ownerBKernelAfterRetry.revision).toBe(ownerBKernelAfterFirstRefusal.revision);
    expect(ownerBKernelAfterRetry.events.filter(
      (event) => event.type === "run.workspace-claim-refused" && event.entityId === ownerB.runId,
    )).toHaveLength(1);

    expect(readKernel(root, ownerA.taskDir)).toEqual(ownerAKernelBefore);
    expect(snapshotFiles(registry)).toEqual(managerFilesBefore);
    expect(snapshotFiles(workspaceA.canonicalPath)).toEqual(checkoutFilesBefore);
    expect(git(root, "worktree", "list", "--porcelain")).toBe(gitRegistrationsBefore);
    expect(hasRegisteredWorktree(root, workspaceA.canonicalPath)).toBe(true);
  });

  it("persists an occupied create-path refusal without touching the path", () => {
    const { root, baseSha } = fixture();
    const task = startActiveTaskRun(root, "claim-create-occupied");
    const canonicalPath = path.join(root, ".pactile", "worktrees", task.runId);
    const marker = path.join(canonicalPath, "keep-user-file.txt");
    fs.mkdirSync(canonicalPath, { recursive: true });
    fs.writeFileSync(marker, "user-owned contents\n");

    let error: unknown;
    try {
      createTaskRunWorktree({
        repoRoot: root, taskDir: task.taskDir, runId: task.runId, branch: "feat/claim-create-occupied", baseRef: baseSha,
        actor: runActor, idempotencyKey: "create-refusal-sensitive-key",
      });
    } catch (caught) { error = caught; }

    expect(error).toMatchObject({ code: "path-exists" });
    const kernel = readKernel(root, task.taskDir);
    const refusal = kernel.events.find((event) => event.type === "run.workspace-claim-refused");
    const refusalAudit = kernel.audit.find((entry) => entry.idempotencyKey === refusal?.idempotencyKey);
    expect(refusal).toMatchObject({ entityId: task.runId, requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(refusal?.idempotencyKey).not.toContain("create-refusal-sensitive-key");
    expect(refusalAudit?.evidence).toContain("Workspace create claim refused [path-exists]:");
    expect(refusalAudit?.evidence).not.toContain(canonicalPath);
    expect(fs.readFileSync(marker, "utf8")).toBe("user-owned contents\n");
    expect(kernel.runs.find((run) => run.id === task.runId)?.workspace).toBeNull();
    expect(hasRegisteredWorktree(root, canonicalPath)).toBe(false);
  });

  it("keeps unsafe adoption classified separately from ownership conflicts", () => {
    const { root, baseSha } = fixture();
    const task = startActiveTaskRun(root, "claim-adopt-unsafe");
    const canonicalPath = path.join(root, ".pactile", "worktrees", "preexisting-unsafe");
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    git(root, "worktree", "add", "--no-track", "-b", "feat/claim-adopt-unsafe", canonicalPath, baseSha);
    const userFile = path.join(canonicalPath, "src", "user-change.ts");
    fs.writeFileSync(userFile, "export const userChange = true;\n");

    let error: unknown;
    try {
      adoptTaskRunWorktree({
        repoRoot: root, taskDir: task.taskDir, runId: task.runId, canonicalPath,
        branch: "feat/claim-adopt-unsafe", baseSha,
        authorization: { approvedBy: approver, approvedAt: "2026-09-26T00:01:00.000Z", evidenceRef: "adoption:unsafe" },
        actor: runActor, idempotencyKey: "claim-adopt-unsafe",
      });
    } catch (caught) { error = caught; }

    expect(error).toMatchObject({ code: "adoption-not-safe" });
    const kernel = readKernel(root, task.taskDir);
    const refusal = kernel.events.find((event) => event.type === "run.workspace-claim-refused");
    const refusalAudit = kernel.audit.find((entry) => entry.idempotencyKey === refusal?.idempotencyKey);
    expect(refusal).toMatchObject({ entityId: task.runId });
    expect(refusalAudit?.evidence).toContain("Workspace adopt claim refused [adoption-not-safe]:");
    expect(refusalAudit?.evidence).not.toContain(canonicalPath);
    expect(fs.readFileSync(userFile, "utf8")).toBe("export const userChange = true;\n");
    expect(hasRegisteredWorktree(root, canonicalPath)).toBe(true);
    expect(kernel.runs.find((run) => run.id === task.runId)?.workspace).toBeNull();
  });

  it("binds the successful create claimant after a competing create refusal advances the Kernel", () => {
    const { root, baseSha } = fixture();
    const task = startActiveTaskRun(root, "claim-create-race");
    const canonicalPath = path.join(root, ".pactile", "worktrees", task.runId);
    const commonDir = path.resolve(root, git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    const registry = path.join(commonDir, "pactile-run-workspaces-v1");
    const originalBind = taskKernelApi.bindTaskRunWorkspace;
    let injected = false;
    let loserError: unknown;
    let managerFilesBeforeLoser: Record<string, string> | null = null;
    let checkoutFilesBeforeLoser: Record<string, string> | null = null;
    let gitRegistrationsBeforeLoser: string | null = null;
    vi.spyOn(taskKernelApi, "bindTaskRunWorkspace").mockImplementation((request) => {
      if (!injected) {
        injected = true;
        managerFilesBeforeLoser = snapshotFiles(registry);
        checkoutFilesBeforeLoser = snapshotFiles(canonicalPath);
        gitRegistrationsBeforeLoser = git(root, "worktree", "list", "--porcelain");
        try {
          createTaskRunWorktree({
            repoRoot: root, taskDir: task.taskDir, runId: task.runId,
            branch: "feat/claim-create-race", baseRef: baseSha,
            actor: runActor, idempotencyKey: "claim-create-race-loser",
          });
        } catch (error) { loserError = error; }
      }
      return originalBind(request);
    });

    const winner = createTaskRunWorktree({
      repoRoot: root, taskDir: task.taskDir, runId: task.runId,
      branch: "feat/claim-create-race", baseRef: baseSha,
      actor: runActor, idempotencyKey: "claim-create-race-winner",
    });

    expect(injected).toBe(true);
    expect(loserError).toMatchObject({ code: "path-exists" });
    expect(managerFilesBeforeLoser).not.toBeNull();
    expect(checkoutFilesBeforeLoser).not.toBeNull();
    expect(gitRegistrationsBeforeLoser).not.toBeNull();
    const kernel = readKernel(root, task.taskDir);
    const run = kernel.runs.find((item) => item.id === task.runId);
    const refusalIndex = kernel.events.findIndex((event) => event.type === "run.workspace-claim-refused" && event.entityId === task.runId);
    const boundIndex = kernel.events.findIndex((event) => event.type === "run.workspace-bound" && event.entityId === task.runId);
    expect(refusalIndex).toBeGreaterThanOrEqual(0);
    expect(boundIndex).toBeGreaterThan(refusalIndex);
    expect(run?.workspace).toMatchObject({
      ownerRunId: task.runId,
      canonicalPath: winner.binding.canonicalPath,
      manager: { credentialId: winner.binding.manager?.credentialId, source: "created" },
    });
    expect(snapshotFiles(registry)).toEqual(managerFilesBeforeLoser);
    expect(snapshotFiles(canonicalPath)).toEqual(checkoutFilesBeforeLoser);
    expect(git(root, "worktree", "list", "--porcelain")).toBe(gitRegistrationsBeforeLoser);
    expect(hasRegisteredWorktree(root, canonicalPath)).toBe(true);
  });

  it("binds the successful adoption after a competing adoption refusal advances the Kernel", () => {
    const { root, baseSha } = fixture();
    const task = startActiveTaskRun(root, "claim-adopt-race");
    const canonicalPath = path.join(root, ".pactile", "worktrees", "claim-adopt-race-checkout");
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    git(root, "worktree", "add", "--no-track", "-b", "feat/claim-adopt-race", canonicalPath, baseSha);
    const commonDir = path.resolve(root, git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    const registry = path.join(commonDir, "pactile-run-workspaces-v1");
    const authorization = { approvedBy: approver, approvedAt: "2026-09-26T00:01:00.000Z", evidenceRef: "adoption:claim-race" };
    const originalBind = taskKernelApi.bindTaskRunWorkspace;
    let injected = false;
    let loserError: unknown;
    let managerFilesBeforeLoser: Record<string, string> | null = null;
    let checkoutFilesBeforeLoser: Record<string, string> | null = null;
    let gitRegistrationsBeforeLoser: string | null = null;
    vi.spyOn(taskKernelApi, "bindTaskRunWorkspace").mockImplementation((request) => {
      if (!injected) {
        injected = true;
        managerFilesBeforeLoser = snapshotFiles(registry);
        checkoutFilesBeforeLoser = snapshotFiles(canonicalPath);
        gitRegistrationsBeforeLoser = git(root, "worktree", "list", "--porcelain");
        try {
          adoptTaskRunWorktree({
            repoRoot: root, taskDir: task.taskDir, runId: task.runId, canonicalPath,
            branch: "feat/claim-adopt-race", baseSha, authorization,
            actor: runActor, idempotencyKey: "claim-adopt-race-loser",
          });
        } catch (error) { loserError = error; }
      }
      return originalBind(request);
    });

    const winner = adoptTaskRunWorktree({
      repoRoot: root, taskDir: task.taskDir, runId: task.runId, canonicalPath,
      branch: "feat/claim-adopt-race", baseSha, authorization,
      actor: runActor, idempotencyKey: "claim-adopt-race-winner",
    });

    expect(injected).toBe(true);
    expect(loserError).toMatchObject({ code: "owner-conflict" });
    expect(managerFilesBeforeLoser).not.toBeNull();
    expect(checkoutFilesBeforeLoser).not.toBeNull();
    expect(gitRegistrationsBeforeLoser).not.toBeNull();
    const kernel = readKernel(root, task.taskDir);
    const run = kernel.runs.find((item) => item.id === task.runId);
    const refusalIndex = kernel.events.findIndex((event) => event.type === "run.workspace-claim-refused" && event.entityId === task.runId);
    const boundIndex = kernel.events.findIndex((event) => event.type === "run.workspace-bound" && event.entityId === task.runId);
    expect(refusalIndex).toBeGreaterThanOrEqual(0);
    expect(boundIndex).toBeGreaterThan(refusalIndex);
    expect(run?.workspace).toMatchObject({
      ownerRunId: task.runId,
      canonicalPath: winner.binding.canonicalPath,
      manager: { credentialId: winner.binding.manager?.credentialId, source: "adopted" },
    });
    expect(snapshotFiles(registry)).toEqual(managerFilesBeforeLoser);
    expect(snapshotFiles(canonicalPath)).toEqual(checkoutFilesBeforeLoser);
    expect(git(root, "worktree", "list", "--porcelain")).toBe(gitRegistrationsBeforeLoser);
    expect(hasRegisteredWorktree(root, canonicalPath)).toBe(true);
  });

  it("returns an explicit unrecorded refusal when the Kernel cannot append the claim event", () => {
    const { root, baseSha } = fixture();
    const ownerA = startActiveTaskRun(root, "claim-unrecorded-owner-a");
    const ownerB = startActiveTaskRun(root, "claim-unrecorded-owner-b");
    const workspaceA = createTaskRunWorktree({
      repoRoot: root, taskDir: ownerA.taskDir, runId: ownerA.runId, branch: "feat/claim-unrecorded-a", baseRef: baseSha,
      actor: runActor, idempotencyKey: "claim-unrecorded-owner-a:create",
    }).binding;
    const ownerAKernelBefore = readKernel(root, ownerA.taskDir);
    const managerFilesBefore = snapshotFiles(path.join(path.resolve(root, git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")), "pactile-run-workspaces-v1"));
    const gitRegistrationsBefore = git(root, "worktree", "list", "--porcelain");
    vi.spyOn(taskKernelApi, "recordTaskRunWorkspaceClaimRefusal").mockImplementation(() => {
      throw new Error("simulated Kernel write failure");
    });

    let error: unknown;
    try {
      adoptTaskRunWorktree({
        repoRoot: root, taskDir: ownerB.taskDir, runId: ownerB.runId, canonicalPath: workspaceA.canonicalPath,
        branch: workspaceA.branch, baseSha,
        authorization: { approvedBy: approver, approvedAt: "2026-09-26T00:01:00.000Z", evidenceRef: "adoption:unrecorded" },
        actor: runActor, idempotencyKey: "claim-unrecorded-adopt",
      });
    } catch (caught) { error = caught; }

    expect(error).toMatchObject({ code: "workspace-claim-refusal-unrecorded" });
    expect((error as Error).message).toContain("refusal could not be persisted");
    const ownerBKernel = readKernel(root, ownerB.taskDir);
    expect(ownerBKernel.events.some((event) => event.type === "run.workspace-claim-refused")).toBe(false);
    expect(ownerBKernel.runs.find((run) => run.id === ownerB.runId)?.workspace).toBeNull();
    expect(readKernel(root, ownerA.taskDir)).toEqual(ownerAKernelBefore);
    expect(snapshotFiles(path.join(path.resolve(root, git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")), "pactile-run-workspaces-v1"))).toEqual(managerFilesBefore);
    expect(git(root, "worktree", "list", "--porcelain")).toBe(gitRegistrationsBefore);
    expect(hasRegisteredWorktree(root, workspaceA.canonicalPath)).toBe(true);
  });

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

  it("retains a closed Run checkout when durable registry history contains a second owner", async () => {
    const { root, baseSha } = fixture();
    const prepared = prepareIntegratedRun({ root, baseSha, taskId: "cleanup-duplicate-owner", close: true });
    const commonDir = path.resolve(root, git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    const registry = path.join(commonDir, "pactile-run-workspaces-v1");
    const primaryPath = path.join(registry, `${prepared.runId}.json`);
    const duplicate = JSON.parse(fs.readFileSync(primaryPath, "utf8")) as Record<string, unknown>;
    duplicate.ownerRunId = "legacy-duplicate-owner";
    duplicate.credentialId = "legacy-duplicate-credential";
    delete duplicate.ownershipProtocol;
    fs.writeFileSync(path.join(registry, "legacy-duplicate-owner.json"), `${JSON.stringify(duplicate, null, 2)}\n`);
    const removal = vi.spyOn(gitRemoval, "removeManagedGitWorktree");

    const result = await reclaimRunWorktree({
      repoRoot: root, taskDir: prepared.taskDir, runId: prepared.runId,
      actor: closer, idempotencyKey: "cleanup-duplicate-owner:reclaim",
    });

    expect(result.state).not.toBe("reclaimed");
    expect(result.reason).toMatch(/multiple Run owners|provenance/i);
    expect(removal).not.toHaveBeenCalled();
    expect(fs.existsSync(prepared.workspace.canonicalPath)).toBe(true);
    expect(hasRegisteredWorktree(root, prepared.workspace.canonicalPath)).toBe(true);
    const kernel = readKernel(root, prepared.taskDir);
    expect(kernel.runs.find((item) => item.id === prepared.runId)?.workspace?.cleanupLease?.state).toBe("recovery-required");
    expect(kernel.events.some((event) => event.type === "run.workspace-recovery-required" && event.entityId === prepared.runId)).toBe(true);
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
    const kernel = readKernel(root, prepared.taskDir);
    const refusal = kernel.events.find((event) => event.type === "run.workspace-cleanup-refused");
    expect(refusal).toMatchObject({ type: "run.workspace-cleanup-refused", entityId: prepared.runId });
    expect(kernel.audit.find((entry) => entry.idempotencyKey === refusal?.idempotencyKey)?.evidence)
      .toContain("Workspace cleanup refused:");
  });

  it("keeps the deletion gate closed when refusal-event persistence fails", async () => {
    const { root, baseSha } = fixture();
    const prepared = prepareIntegratedRun({ root, baseSha, taskId: "cleanup-refusal-write-fails", close: false });
    vi.spyOn(taskKernelApi, "recordTaskRunWorkspaceCleanupRefusal").mockImplementation(() => {
      throw new Error("simulated Kernel write failure");
    });
    const removal = vi.spyOn(gitRemoval, "removeManagedGitWorktree");

    const result = await reclaimRunWorktree({
      repoRoot: root, taskDir: prepared.taskDir, runId: prepared.runId,
      actor: closer, idempotencyKey: "cleanup-refusal-write-fails:reclaim",
    });

    expect(result.state).toBe("retained");
    expect(result.reason).toContain("refusal event could not be persisted");
    expect(removal).not.toHaveBeenCalled();
    expect(fs.existsSync(prepared.workspace.canonicalPath)).toBe(true);
  });

  it("automatically reclaims an integrated Run workspace after the public Task Close command succeeds", async () => {
    const { root, baseSha } = fixture();
    const prepared = prepareIntegratedRun({ root, baseSha, taskId: "cleanup-cli", close: false, integrate: false });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await runWorktreeCli(["integrate", prepared.taskId, prepared.runId, "--target", "main"], root)).toBe(0);
    expect(String(log.mock.lastCall?.[0])).toContain("contentFingerprint");
    const remove = vi.spyOn(gitRemoval, "removeManagedGitWorktree");
    const args = closeArgs(prepared);
    const closeCode = await runTaskCliWithWorkspaceReclaim(args, root);
    expect(await runTaskCliWithWorkspaceReclaim(args, root)).toBe(0);

    expect(closeCode).toBe(0);
    expect(log.mock.calls.map(([line]) => String(line)).join("\n")).toContain('"state": "reclaimed"');
    expect(error).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(prepared.workspace.canonicalPath)).toBe(false);
    expect(hasRegisteredWorktree(root, prepared.workspace.canonicalPath)).toBe(false);
    expect(readKernel(root, prepared.taskDir).runs.at(-1)?.workspace?.cleanupLease?.state).toBe("reclaimed");
  });

  it("returns success for Close but emits a retained status and refusal event when the writer stop receipt is absent", async () => {
    const { root, baseSha } = fixture();
    const prepared = prepareIntegratedRun({ root, baseSha, taskId: "cleanup-no-host-stop", close: false });
    readPiHostStopReceiptMock.mockResolvedValue(null);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const removal = vi.spyOn(gitRemoval, "removeManagedGitWorktree");

    expect(await runTaskCliWithWorkspaceReclaim(closeArgs(prepared), root)).toBe(0);

    const status = JSON.parse(String(error.mock.lastCall?.[0])) as { state: string; reason: string };
    expect(status).toMatchObject({ state: "retained" });
    expect(status.reason).toContain("persisted process exit receipt");
    expect(removal).not.toHaveBeenCalled();
    expect(fs.existsSync(prepared.workspace.canonicalPath)).toBe(true);
    expect(hasRegisteredWorktree(root, prepared.workspace.canonicalPath)).toBe(true);
    const kernel = readKernel(root, prepared.taskDir);
    expect(kernel.events.some((event) => event.type === "run.workspace-cleanup-refused" && event.entityId === prepared.runId)).toBe(true);
  });

  it("retains the checkout after a verified cancelled writer exit", async () => {
    const { root, baseSha } = fixture();
    const prepared = prepareIntegratedRun({ root, baseSha, taskId: "cleanup-cancelled", close: true });
    readPiHostStopReceiptMock.mockResolvedValue({
      schemaVersion: 1, source: "pactile-pi-rpc", assurance: "manager-owned-child-exit",
      taskId: prepared.taskId, taskRunId: prepared.runId, piRunId: prepared.piRunId,
      role: "implement", sessionId: `session-${prepared.taskId}`, processId: 31415,
      startRequestId: `pi-start:${prepared.taskId}`, settleReceiptId: `pi-settle:${prepared.taskId}`,
      terminal: "cancelled", exitCode: null, signalCode: "SIGTERM",
      cancellationRequestId: `cancel-request:${prepared.taskId}`,
      evidenceRef: `${prepared.receiptFile}#process_stop_receipt`, recordedAt: "2026-09-26T00:00:30.000Z",
    });
    const removal = vi.spyOn(gitRemoval, "removeManagedGitWorktree");

    const result = await reclaimRunWorktree({
      repoRoot: root, taskDir: prepared.taskDir, runId: prepared.runId,
      actor: closer, idempotencyKey: "cleanup-cancelled:reclaim",
    });

    expect(result.state).toBe("retained");
    expect(result.reason).toContain("Cancelled Runs are retained");
    expect(removal).not.toHaveBeenCalled();
    expect(fs.existsSync(prepared.workspace.canonicalPath)).toBe(true);
    expect(hasRegisteredWorktree(root, prepared.workspace.canonicalPath)).toBe(true);
  });

  it("retains user-written worktree changes and does not call Git removal", async () => {
    const { root, baseSha } = fixture();
    const prepared = prepareIntegratedRun({ root, baseSha, taskId: "cleanup-user-edit", close: true });
    const featurePath = path.join(prepared.workspace.canonicalPath, "src", "feature.ts");
    fs.writeFileSync(featurePath, "export const userEdit = true;\n");
    const removal = vi.spyOn(gitRemoval, "removeManagedGitWorktree");

    const result = await reclaimRunWorktree({
      repoRoot: root, taskDir: prepared.taskDir, runId: prepared.runId,
      actor: closer, idempotencyKey: "cleanup-user-edit:reclaim",
    });

    expect(result.state).toBe("recovery-required");
    expect(result.reason).toMatch(/dirty|changed|modified/i);
    expect(removal).not.toHaveBeenCalled();
    expect(fs.readFileSync(featurePath, "utf8")).toContain("userEdit");
    expect(hasRegisteredWorktree(root, prepared.workspace.canonicalPath)).toBe(true);
  });

  it("fails closed when the recorded Run path is replaced by a junction to another checkout", async (context) => {
    const { root, baseSha } = fixture();
    const prepared = prepareIntegratedRun({ root, baseSha, taskId: "cleanup-path-swap", close: true });
    const outside = path.join(root, "outside-checkout");
    git(root, "worktree", "add", "--no-track", "-b", "feat/path-swap-outside", outside, baseSha);
    git(root, "worktree", "remove", prepared.workspace.canonicalPath);
    try {
      fs.symlinkSync(outside, prepared.workspace.canonicalPath, "junction");
    } catch {
      context.skip("The host does not allow creating a directory junction in this test environment");
    }
    const removal = vi.spyOn(gitRemoval, "removeManagedGitWorktree");

    const result = await reclaimRunWorktree({
      repoRoot: root, taskDir: prepared.taskDir, runId: prepared.runId,
      actor: closer, idempotencyKey: "cleanup-path-swap:reclaim",
    });

    expect(["retained", "recovery-required"]).toContain(result.state);
    expect(result.reason).toMatch(/symlink|path|registration|worktree/i);
    expect(removal).not.toHaveBeenCalled();
    expect(fs.existsSync(outside)).toBe(true);
    expect(hasRegisteredWorktree(root, outside)).toBe(true);
    expect(fs.lstatSync(prepared.workspace.canonicalPath).isSymbolicLink()).toBe(true);
    expect(readKernel(root, prepared.taskDir).events.some(
      (event) => event.type === "run.workspace-cleanup-refused" && event.entityId === prepared.runId,
    )).toBe(true);
  });

  it("exposes create and inspect through the public Run worktree CLI using actual Git registrations", async () => {
    const { root } = fixture();
    const taskId = "worktree-cli-entry";
    const taskDir = path.join(root, ".pactile", "tasks", taskId);
    const created = createTaskKernel({
      root, taskDir, actor: "author", idempotencyKey: `create:${taskId}`,
      definition: {
        taskId, title: "Public worktree CLI", description: "", deliverable: "managed checkout",
        deliveryLevel: "local-result", acceptanceCriteria: [{ id: "AC-1", description: "Checkout is registered" }], dependencies: [],
      },
    });
    const started = startTaskRun({
      root, taskDir, expectedRevision: created.kernel.revision, actor: runActor, idempotencyKey: `start:${taskId}`,
      input: { summary: "Prepare an isolated checkout", references: [] },
      authorization: { approvedBy: approver, approvedAt: "2026-09-26T00:00:00.000Z", scope: "src", evidenceRef: "approval:cli" },
      writeSetSnapshot: ["src"],
    });
    const runId = started.kernel.runs.at(-1)?.id;
    if (!runId) throw new Error("Started Run is missing");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await runWorktreeCli(["create", taskId, runId], root)).toBe(0);
    const createReceipt = JSON.parse(String(log.mock.lastCall?.[0])) as { canonicalPath: string; credentialId: string };
    expect(createReceipt.credentialId).toBeTruthy();
    expect(hasRegisteredWorktree(root, createReceipt.canonicalPath)).toBe(true);
    expect(await runWorktreeCli(["inspect", taskId, runId], root)).toBe(0);
    expect(String(log.mock.lastCall?.[0])).toContain('"state": "unintegrated"');
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

  it("restores the Run checkout when a crashed cleanup retry finds target content rewritten", async () => {
    const { root, baseSha } = fixture();
    const prepared = prepareIntegratedRun({ root, baseSha, taskId: "cleanup-crash-target-race", close: true });
    let kernel = readKernel(root, prepared.taskDir);
    let run = kernel.runs.find((item) => item.id === prepared.runId);
    const candidate = run?.candidateSnapshot;
    const host = run?.host;
    const integration = run?.workspace?.integrationReceipt;
    if (!candidate || !host || !integration || !run?.result) throw new Error("Closed Run cleanup evidence is incomplete");

    const receiptRef = prepared.receiptFile;
    const evidenceRef = `${receiptRef}#process_stop_receipt`;
    const startRequestId = `pi-start:${prepared.taskId}`;
    const settleReceiptId = `pi-settle:${prepared.taskId}`;
    recordTaskRunHostStopReceipt({
      root, taskDir: prepared.taskDir, expectedRevision: kernel.revision, runId: prepared.runId,
      receipt: {
        source: "pactile-pi-rpc", assurance: "manager-owned-child-exit", evidenceLevel: "manager-owned-child-exit",
        taskId: prepared.taskId, runId: prepared.runId, sessionId: host.sessionId, threadId: null,
        startRequestId, settleReceiptId, terminalStatus: "exited", requestKernelRevision: host.kernelRevision,
        receiptKernelRevision: kernel.revision, contractFingerprint: host.contractFingerprint, contractStale: false,
        candidateSnapshotId: candidate.id, candidateFingerprint: candidate.fingerprint, candidateSource: "derived",
        receiptRef, evidenceRef, recordedAt: "2026-09-26T00:00:30.000Z",
      },
      actor: runActor, idempotencyKey: "cleanup-crash-target-race:host-stop",
    });

    kernel = readKernel(root, prepared.taskDir);
    run = kernel.runs.find((item) => item.id === prepared.runId);
    const stopReceipt = run?.host?.stopReceipt;
    if (!stopReceipt || !run?.workspace?.integrationReceipt) throw new Error("Host stop or integration receipt was not persisted");
    const staleProcessId = 2_147_483_647;
    acquireTaskRunWorkspaceCleanupLease({
      root, taskDir: prepared.taskDir, expectedRevision: kernel.revision, runId: prepared.runId,
      lease: {
        leaseId: "simulated-crashed-cleanup",
        processId: staleProcessId,
        acquiredAt: "2026-09-26T00:00:40.000Z",
        expectedHeadSha: run.workspace.integrationReceipt.worktreeHeadSha,
        targetBranch: run.workspace.integrationReceipt.targetBranch,
        targetHeadSha: run.workspace.integrationReceipt.targetHeadSha,
        receiptRef: stopReceipt.receiptRef,
        riskDisclosure: TASK_RUN_WORKSPACE_CLEANUP_RISK_DISCLOSURE,
      },
      actor: closer, idempotencyKey: "cleanup-crash-target-race:lease",
    });

    git(root, "worktree", "remove", prepared.workspace.canonicalPath);
    expect(fs.existsSync(prepared.workspace.canonicalPath)).toBe(false);
    expect(hasRegisteredWorktree(root, prepared.workspace.canonicalPath)).toBe(false);
    fs.writeFileSync(path.join(root, "src", "feature.ts"), "export const targetRewriteAfterCrash = true;\n");
    git(root, "add", "--", "src/feature.ts");
    git(root, "commit", "-q", "-m", "target rewrite after cleanup crash");

    const actualKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((processId, signal) => {
      if (processId === staleProcessId) {
        const error = new Error("simulated exited cleanup process") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return actualKill(processId, signal);
    });

    const result = await reclaimRunWorktree({
      repoRoot: root, taskDir: prepared.taskDir, runId: prepared.runId,
      actor: closer, idempotencyKey: "cleanup-crash-target-race:retry",
    });

    const recoveredKernel = readKernel(root, prepared.taskDir);
    const recoveredRun = recoveredKernel.runs.find((item) => item.id === prepared.runId);
    expect(result.state, JSON.stringify(result)).toBe("recovery-required");
    expect(result.reason).toContain("Target tree does not preserve Run changes at src/feature.ts");
    expect(fs.readFileSync(path.join(root, "src", "feature.ts"), "utf8")).toContain("targetRewriteAfterCrash");
    expect(fs.readFileSync(path.join(prepared.workspace.canonicalPath, "src", "feature.ts"), "utf8")).toContain("feature = true");
    expect(git(prepared.workspace.canonicalPath, "rev-parse", "HEAD")).toBe(integration.worktreeHeadSha);
    expect(git(root, "rev-parse", `refs/heads/${prepared.workspace.branch}`)).toBe(integration.worktreeHeadSha);
    expect(hasRegisteredWorktree(root, prepared.workspace.canonicalPath)).toBe(true);
    expect(recoveredRun?.workspace?.cleanupLease?.state).toBe("recovery-required");
    expect(path.resolve(recoveredRun?.workspace?.manager?.gitDir ?? "")).toBe(path.resolve(git(prepared.workspace.canonicalPath, "rev-parse", "--absolute-git-dir")));
  });
});
