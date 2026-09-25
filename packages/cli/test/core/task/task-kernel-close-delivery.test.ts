import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkTaskClose,
  closeTaskKernel,
  createTaskKernel,
  parseTaskKernelSnapshotV2,
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

const provider = vi.hoisted(() => ({
  fact: null as Record<string, unknown> | null,
}));
vi.mock("../../../src/core/task/task-pull-request-observer.js", () => ({
  observeGitHubPullRequest: () => {
    if (provider.fact === null)
      throw new Error("test provider fact was not configured");
    return provider.fact;
  },
}));

const roots: string[] = [];

afterEach(() => {
  provider.fact = null;
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeRepository(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pactile-task-close-delivery-"),
  );
  roots.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Pactile Close Tests");
  git(root, "config", "user.email", "pactile-close@example.invalid");
  fs.writeFileSync(path.join(root, ".gitignore"), ".pactile/\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "--quiet", "-m", "baseline");
  git(
    root,
    "remote",
    "add",
    "origin",
    "https://github.com/example/project.git",
  );
  fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=author\n");
  return root;
}

function kernel(
  root: string,
  taskId: string,
  deliveryLevel: "pull-request" | "merged-result",
): { dir: string; kernel: TaskKernelSnapshotV2 } {
  const dir = path.join(root, ".pactile", "tasks", taskId);
  const created = createTaskKernel({
    root,
    taskDir: dir,
    actor: "author",
    idempotencyKey: `create:${taskId}`,
    definition: {
      taskId,
      title: taskId,
      description: "provider verified close fixture",
      deliverable: "committed result",
      deliveryLevel,
      acceptanceCriteria: [{ id: "AC-1", description: "result is present" }],
      dependencies: [],
    },
  });
  fs.writeFileSync(path.join(dir, "review.md"), "Independent Review report\n");
  return { dir, kernel: created.kernel };
}

function prepareCandidate(
  root: string,
  taskDir: string,
  taskId: string,
  options: {
    deliveryPath?: string;
    writeSet?: string[];
    evidenceRef?: string;
  } = {},
) {
  const deliveryPath = options.deliveryPath ?? "result.txt";
  const writeSet = options.writeSet ?? [deliveryPath];
  const evidenceRef = options.evidenceRef ?? deliveryPath;
  const baseSha = git(root, "rev-parse", "HEAD");
  const branch = `feat/${taskId}`;
  const workspaceRoot = path.join(
    os.tmpdir(),
    `${path.basename(root)}-${taskId}-worktree`,
  );
  roots.push(workspaceRoot);
  git(root, "worktree", "add", "--quiet", "-b", branch, workspaceRoot, baseSha);
  const current = readTaskKernel({ root, taskDir, cwd: root });
  if (current.kind !== "task-kernel-v2") throw new Error("expected V2 Task");
  const started = startTaskRun({
    root,
    taskDir,
    expectedRevision: current.kernel.revision,
    actor: "implementer",
    idempotencyKey: `run:${taskId}`,
    input: { summary: "produce PR deliverable", references: [] },
    authorization: {
      approvedBy: "approver",
      approvedAt: "now",
      scope: deliveryPath,
      evidenceRef: "approval.json",
    },
    workspace: {
      canonicalPath: workspaceRoot,
      branch,
      baseSha,
      writeSet,
      integrationState: "not-integrated",
      reclamationState: "not-requested",
    },
  });
  const run = started.kernel.runs.at(-1);
  if (!run) throw new Error("started Run is missing");
  const bytes = `result for ${taskId}\n`;
  const absoluteDeliveryPath = path.join(workspaceRoot, deliveryPath);
  fs.mkdirSync(path.dirname(absoluteDeliveryPath), { recursive: true });
  fs.writeFileSync(absoluteDeliveryPath, bytes);
  git(workspaceRoot, "add", deliveryPath);
  if (git(workspaceRoot, "status", "--porcelain")) {
    git(workspaceRoot, "commit", "--quiet", "-m", `deliver ${taskId}`);
  }
  const observation = observeTaskRunCandidate({ run });
  const updated = readTaskKernel({ root, taskDir, cwd: root });
  if (updated.kind !== "task-kernel-v2") throw new Error("expected V2 Task");
  const completed = recordTaskRunResult({
    root,
    taskDir,
    expectedRevision: updated.kernel.revision,
    runId: run.id,
    outcome: "completed",
    summary: "committed result",
    evidenceRefs: [evidenceRef],
    candidateEntries: [
      ...(evidenceRef === deliveryPath
        ? [
            {
              ref: deliveryPath,
              fingerprint: createHash("sha256").update(bytes).digest("hex"),
            },
          ]
        : []),
      createTaskCandidateEntry(observation),
    ],
    actor: "implementer",
    idempotencyKey: `result:${taskId}`,
  });
  const candidate = completed.kernel.runs.at(-1)?.candidateSnapshot;
  if (!candidate) throw new Error("candidate snapshot is missing");
  const reviewed = recordTaskReview({
    root,
    taskDir,
    expectedRevision: completed.kernel.revision,
    runId: run.id,
    candidateSnapshotId: candidate.id,
    candidateFingerprint: candidate.fingerprint,
    reviewer: "independent-reviewer",
    decision: "pass",
    evidenceRefs: ["review.md"],
    acceptanceEvidence: { "AC-1": [evidenceRef] },
    actor: "independent-reviewer",
    idempotencyKey: `review:${taskId}`,
  });
  const review = reviewed.kernel.reviews.at(-1);
  if (!review) throw new Error("Review is missing");
  return {
    run,
    candidate,
    review,
    kernel: reviewed.kernel,
    bytes,
    deliveryPath,
    observation,
    workspaceRoot,
  };
}

function providerFact(input: {
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  mergeCommitSha: string | null;
}): Record<string, unknown> {
  return {
    source: "github-rest-pull-request-v1",
    url: "https://github.com/example/project/pull/17",
    repository: "example/project",
    number: 17,
    state: input.state,
    draft: false,
    headSha: input.headSha,
    baseBranch: "main",
    merged: input.merged,
    mergeCommitSha: input.mergeCommitSha,
  };
}

describe("Task Close delivery observation", () => {
  it("captures a standalone Run base and rejects committed scope drift before candidate freeze", () => {
    const root = makeRepository();
    const task = kernel(root, "standalone-out-of-scope", "pull-request");
    const baseSha = git(root, "rev-parse", "HEAD");
    const started = startTaskRun({
      root,
      taskDir: task.dir,
      expectedRevision: task.kernel.revision,
      actor: "implementer",
      idempotencyKey: "standalone-out-of-scope-start",
      input: { summary: "make standalone candidate", references: [] },
      authorization: {
        approvedBy: "approver",
        approvedAt: "now",
        scope: "result.txt",
        evidenceRef: "approval.json",
      },
      writeSetSnapshot: ["result.txt"],
    });
    const run = started.kernel.runs.at(-1);
    if (!run) throw new Error("started Run is missing");
    expect(run.workspace).toBeNull();
    expect(run.candidateBaseSha).toBe(baseSha);
    expect(run.candidateBaseBranch).toBe("main");

    const resultBytes = "standalone result\n";
    fs.writeFileSync(path.join(root, "result.txt"), resultBytes);
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "outside.md"), "out of scope\n");
    git(root, "add", "result.txt", "docs/outside.md");
    git(root, "commit", "--quiet", "-m", "standalone candidate with extra path");
    expect(git(root, "status", "--porcelain")).toBe("");

    expect(() =>
      recordTaskRunResult({
        root,
        taskDir: task.dir,
        expectedRevision: started.kernel.revision,
        runId: run.id,
        outcome: "completed",
        summary: "standalone candidate",
        evidenceRefs: ["result.txt"],
        candidateEntries: [
          {
            ref: "result.txt",
            fingerprint: createHash("sha256").update(resultBytes).digest("hex"),
          },
        ],
        actor: "implementer",
        idempotencyKey: "standalone-out-of-scope-result",
      }),
    ).toThrow(/Candidate observation is out-of-scope/);
    expect(readTaskKernel({ root, taskDir: task.dir, cwd: root })).toMatchObject({
      kind: "task-kernel-v2",
      kernel: { runs: [{ state: "running" }] },
    });
  });

  it("closes a pull-request delivery only for an open, non-draft PR at the candidate HEAD", () => {
    const root = makeRepository();
    const task = kernel(root, "pr-delivery", "pull-request");
    const prepared = prepareCandidate(root, task.dir, "pr-delivery");
    const candidateHead = prepared.observation.head;
    provider.fact = providerFact({
      state: "open",
      merged: false,
      headSha: candidateHead,
      mergeCommitSha: "c".repeat(40),
    });
    const request = {
      root,
      taskDir: task.dir,
      expectedRevision: prepared.kernel.revision,
      runId: prepared.run.id,
      reviewId: prepared.review.id,
      candidateObservation: {
        snapshotId: prepared.candidate.id,
        fingerprint: prepared.candidate.fingerprint,
        observedBy: "caller",
        observedAt: "now",
        source: "caller-attested",
        evidenceRef: "candidate.json",
      },
      deliveryEvidence: {
        level: "pull-request" as const,
        reference: "https://github.com/example/project/pull/17",
        path: "result.txt",
        summary: "candidate branch PR",
      },
    };
    expect(checkTaskClose(request)).toEqual([]);
    const closed = closeTaskKernel({
      ...request,
      actor: "closer",
      idempotencyKey: "pr-delivery-close",
    });
    expect(closed.kernel.closure?.deliveryVerification).toMatchObject({
      level: "pull-request",
      path: "result.txt",
      candidateHead,
      fileSha256: createHash("sha256").update(prepared.bytes).digest("hex"),
      pullRequest: {
        source: "github-rest-pull-request-v1",
        state: "open",
        headSha: candidateHead,
        draft: false,
      },
    });
    const closure = closed.kernel.closure;
    if (!closure?.deliveryVerification)
      throw new Error("delivery verification receipt is missing");
    expect(() =>
      parseTaskKernelSnapshotV2({
        ...closed.kernel,
        closure: {
          ...closure,
          deliveryEvidence: {
            ...closure.deliveryEvidence,
            path: "different.txt",
          },
        },
      }),
    ).toThrow("must match the recorded delivery level and path");
    expect(() =>
      parseTaskKernelSnapshotV2({
        ...closed.kernel,
        closure: {
          ...closure,
          deliveryVerification: {
            ...closure.deliveryVerification,
            level: "merged-result",
          },
        },
      }),
    ).toThrow("has inconsistent merged-result delivery facts");
    expect(() =>
      parseTaskKernelSnapshotV2({
        ...closed.kernel,
        closure: {
          ...closure,
          deliveryVerification: {
            ...closure.deliveryVerification,
            fileSha256: "0".repeat(64),
          },
        },
      }),
    ).toThrow("has inconsistent pull-request delivery facts");
  });

  it("rejects PR delivery bytes hidden from Git status by skip-worktree", () => {
    const root = makeRepository();
    const deliveryPath = "src/result.txt";
    const baselineBytes = "result for hidden-index-delivery\n";
    fs.mkdirSync(path.dirname(path.join(root, deliveryPath)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(root, deliveryPath), baselineBytes);
    git(root, "add", deliveryPath);
    git(root, "commit", "--quiet", "-m", "baseline delivery file");

    const task = kernel(root, "hidden-index-delivery", "pull-request");
    const prepared = prepareCandidate(root, task.dir, "hidden-index-delivery", {
      deliveryPath,
      writeSet: ["src/"],
      evidenceRef: "review.md",
    });
    expect(prepared.bytes).toBe(baselineBytes);
    expect(prepared.observation.currentFiles).toEqual([]);

    fs.writeFileSync(
      path.join(prepared.workspaceRoot, deliveryPath),
      "tampered after Run\n",
    );
    git(
      prepared.workspaceRoot,
      "update-index",
      "--skip-worktree",
      deliveryPath,
    );
    expect(git(prepared.workspaceRoot, "status", "--porcelain")).toBe("");
    provider.fact = providerFact({
      state: "open",
      merged: false,
      headSha: prepared.observation.head,
      mergeCommitSha: null,
    });

    const errors = checkTaskClose({
      root,
      taskDir: task.dir,
      expectedRevision: prepared.kernel.revision,
      runId: prepared.run.id,
      reviewId: prepared.review.id,
      candidateObservation: {
        snapshotId: prepared.candidate.id,
        fingerprint: prepared.candidate.fingerprint,
        observedBy: "caller",
        observedAt: "now",
        source: "caller-attested",
        evidenceRef: "candidate.json",
      },
      deliveryEvidence: {
        level: "pull-request",
        reference: "https://github.com/example/project/pull/17",
        path: deliveryPath,
        summary: "clean status must not hide changed delivery bytes",
      },
    });

    expect(errors.join("\n")).toContain(
      "current bytes do not match the frozen candidate HEAD blob",
    );
    expect(errors.join("\n")).not.toContain("Run candidate is stale");
  });

  it("requires the provider merge commit in the local target ancestry and matching target bytes", () => {
    const root = makeRepository();
    const task = kernel(root, "merged-delivery", "merged-result");
    const prepared = prepareCandidate(root, task.dir, "merged-delivery");
    const candidateHead = prepared.observation.head;
    git(
      root,
      "merge",
      "--quiet",
      "--no-ff",
      "feat/merged-delivery",
      "-m",
      "merge verified delivery",
    );
    const mergeCommitSha = git(root, "rev-parse", "HEAD");
    provider.fact = providerFact({
      state: "closed",
      merged: true,
      headSha: candidateHead,
      mergeCommitSha,
    });
    const request = {
      root,
      taskDir: task.dir,
      expectedRevision: prepared.kernel.revision,
      runId: prepared.run.id,
      reviewId: prepared.review.id,
      candidateObservation: {
        snapshotId: prepared.candidate.id,
        fingerprint: prepared.candidate.fingerprint,
        observedBy: "caller",
        observedAt: "now",
        source: "caller-attested",
        evidenceRef: "candidate.json",
      },
      deliveryEvidence: {
        level: "merged-result" as const,
        reference: "https://github.com/example/project/pull/17",
        path: "result.txt",
        targetBranch: "main",
        summary: "merged candidate",
      },
    };
    expect(checkTaskClose(request)).toEqual([]);
    const closed = closeTaskKernel({
      ...request,
      actor: "closer",
      idempotencyKey: "merged-delivery-close",
    });
    expect(closed.kernel.closure?.deliveryVerification).toMatchObject({
      level: "merged-result",
      candidateHead,
      targetBranch: "main",
      targetSha: mergeCommitSha,
      integrationCommitSha: mergeCommitSha,
      ancestryVerified: true,
      pullRequest: { merged: true, state: "closed", headSha: candidateHead },
    });
    expect(closed.kernel.closure?.candidateFingerprint).toBe(
      prepared.candidate.fingerprint,
    );
  });

  it("does not close when a provider merge claim is absent from local target ancestry", () => {
    const root = makeRepository();
    const task = kernel(root, "unmerged-local-target", "merged-result");
    const prepared = prepareCandidate(root, task.dir, "unmerged-local-target");
    const candidateHead = prepared.observation.head;
    provider.fact = providerFact({
      state: "closed",
      merged: true,
      headSha: candidateHead,
      mergeCommitSha: candidateHead,
    });
    const errors = checkTaskClose({
      root,
      taskDir: task.dir,
      expectedRevision: prepared.kernel.revision,
      runId: prepared.run.id,
      reviewId: prepared.review.id,
      candidateObservation: {
        snapshotId: prepared.candidate.id,
        fingerprint: prepared.candidate.fingerprint,
        observedBy: "caller",
        observedAt: "now",
        source: "caller-attested",
        evidenceRef: "candidate.json",
      },
      deliveryEvidence: {
        level: "merged-result",
        reference: "https://github.com/example/project/pull/17",
        path: "result.txt",
        targetBranch: "main",
        summary: "unverified merge claim",
      },
    });
    expect(errors.join("\n")).toContain("not an ancestor of local target main");
  });

  it("refuses Close when a verified TaskDir Review artifact changes", () => {
    const root = makeRepository();
    const task = kernel(root, "review-evidence-drift", "pull-request");
    const prepared = prepareCandidate(root, task.dir, "review-evidence-drift");
    provider.fact = providerFact({
      state: "open",
      merged: false,
      headSha: prepared.observation.head,
      mergeCommitSha: null,
    });
    fs.writeFileSync(
      path.join(task.dir, "review.md"),
      "tampered Review report\n",
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
        observedBy: "caller",
        observedAt: "now",
        source: "caller-attested",
        evidenceRef: "candidate.json",
      },
      deliveryEvidence: {
        level: "pull-request",
        reference: "https://github.com/example/project/pull/17",
        path: "result.txt",
        summary: "candidate branch PR",
      },
    });
    expect(errors.join("\n")).toContain(
      "Stored Review evidence is missing, stale, or has changed bytes",
    );
  });
});
