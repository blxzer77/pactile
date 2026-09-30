import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import {
  createTaskKernel,
  recordTaskRunResult,
  startTaskRun,
  type TaskRunV2,
} from "../../../src/core/task/index.js";
import { preparePiReviewRoute } from "../../../src/pactile/pi/bridge.js";
import { resolvePiReviewWorkspace } from "../../../src/pactile/pi/review-workspace.js";
import { resolvePiReviewEvidenceV1 } from "../../../src/pactile/review/evidence.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(worktree = true) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-p48-review-workspace-"));
  roots.push(home);
  const root = path.join(home, "project");
  const workspace = worktree ? path.join(home, "isolated-candidate") : root;
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "result.txt"), "original\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  let baseSha: string | null = null;
  if (worktree) {
    git("init", "-b", "develop");
    fs.writeFileSync(path.join(root, ".gitignore"), ".pactile/\n");
    git("add", ".gitignore", "src/result.txt");
    git("-c", "user.name=P48 fixture", "-c", "user.email=p48@example.invalid", "commit", "-m", "fixture baseline");
    baseSha = git("rev-parse", "HEAD");
    git("worktree", "add", "-b", "feat/review-fixture", workspace, "develop");
  }
  const task = "review-workspace";
  const taskDir = path.join(root, ".pactile", "tasks", "09-29-review-workspace");
  const created = createTaskKernel({
    root, taskDir, actor: "planner", idempotencyKey: "create",
    definition: {
      taskId: task, title: "External candidate workspace", description: "Review the registered result.",
      deliverable: "A result file", deliveryLevel: "local-result",
      acceptanceCriteria: [{ id: "AC-1", description: "The result is present." }], dependencies: [],
    },
  });
  fs.writeFileSync(path.join(taskDir, "verify.md"), "# Verify\nInspect src/result.txt.\n");
  const started = startTaskRun({
    root, taskDir, expectedRevision: created.kernel.revision, actor: "implementer", idempotencyKey: "start",
    input: { summary: "Produce a result", references: ["verify.md"] },
    authorization: {
      approvedBy: "fixture-user", approvedAt: "2026-09-29T00:00:00.000Z",
      scope: "src/result.txt in the registered workspace", evidenceRef: "approval.md",
    },
    writeSetSnapshot: ["src/result.txt"],
    ...(worktree && baseSha ? { workspace: {
      canonicalPath: fs.realpathSync(workspace), branch: "feat/review-fixture", baseSha,
      writeSet: ["src/result.txt"], integrationState: "not-integrated" as const,
      reclamationState: "not-requested" as const,
    } } : {}),
  });
  const active = started.kernel.runs.at(-1);
  if (!active) throw new Error("Fixture Run is missing");
  fs.writeFileSync(path.join(workspace, "src", "result.txt"), "reviewable result\n");
  const completed = recordTaskRunResult({
    root, taskDir, expectedRevision: started.kernel.revision, actor: "implementer", idempotencyKey: "complete",
    runId: active.id, outcome: "completed", summary: "Ready for Review", evidenceRefs: ["src/result.txt"],
  });
  const run = completed.kernel.runs.at(-1);
  if (!run) throw new Error("Completed fixture Run is missing");
  return { home, root, workspace: fs.realpathSync(workspace), task, taskDir, run, git };
}

describe("Pi Review workspace bound to the exact Kernel candidate", () => {
  it("allows a registered external Git worktree through preparation and evidence resolution", () => {
    const f = fixture();
    const prepared = preparePiReviewRoute(f.root, f.task);
    expect(prepared.workdir).toBe(f.workspace);
    expect(prepared.binding.candidateFingerprint).toBe(f.run.candidateSnapshot?.fingerprint);
    const evidence = resolvePiReviewEvidenceV1({ ...f, candidateRoot: f.workspace, references: ["src/result.txt"] });
    expect(evidence.items).toEqual([expect.objectContaining({ ref: "src/result.txt", source: "candidate-snapshot" })]);
    expect(f.run.workspace?.manager).toBeNull();
  });

  it("keeps non-Git document/local-result candidates eligible through the same Core observer", () => {
    const f = fixture(false);
    expect(preparePiReviewRoute(f.root, f.task).workdir).toBe(f.workspace);
    expect(resolvePiReviewEvidenceV1({ ...f, candidateRoot: f.workspace, references: ["src/result.txt"] }).items).toHaveLength(1);
  });

  it("rejects an explicit candidate root that differs from the bound workspace", () => {
    const f = fixture();
    expect(() => resolvePiReviewEvidenceV1({ ...f, candidateRoot: f.root, references: ["src/result.txt"] })).toThrow(/Kernel Run binding/);
  });

  it("rejects source bytes changed after completion before starting Review", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.workspace, "src", "result.txt"), "changed after completion\n");
    expect(() => preparePiReviewRoute(f.root, f.task)).toThrow(/candidate|changed|match/i);
  });

  it("rejects a different checkout with the same result bytes", () => {
    const f = fixture();
    const other = path.join(f.home, "other-candidate");
    f.git("worktree", "add", "--detach", other, "develop");
    fs.writeFileSync(path.join(other, "src", "result.txt"), "reviewable result\n");
    const changed = structuredClone(f.run);
    if (!changed.workspace) throw new Error("Fixture workspace missing");
    changed.workspace.canonicalPath = fs.realpathSync(other);
    changed.workspace.branch = "";
    expect(() => resolvePiReviewWorkspace({ ...f, run: changed })).toThrow(/candidate|branch|match/i);
  });

  it("rejects a mismatched workspace owner even when the path is unchanged", () => {
    const f = fixture();
    const changed = structuredClone(f.run);
    if (!changed.workspace) throw new Error("Fixture workspace missing");
    changed.workspace.ownerRunId = "another-run";
    expect(() => resolvePiReviewWorkspace({ ...f, run: changed })).toThrow(/owner|match/i);
  });

  it("rejects scope changes rather than treating external directories as arbitrary approved roots", () => {
    const f = fixture();
    const changed = structuredClone(f.run);
    changed.writeSetSnapshot = ["other.txt"];
    expect(() => resolvePiReviewWorkspace({ ...f, run: changed })).toThrow(/write.?set|scope|match/i);
  });

  it("requires the completed candidate and does not turn a running Run into a Review", () => {
    const f = fixture(false);
    const changed = { ...f.run, state: "running" } as TaskRunV2;
    expect(() => resolvePiReviewWorkspace({ ...f, run: changed })).toThrow(/completed Run candidate/);
  });
});
