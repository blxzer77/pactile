import fs from "node:fs";
import path from "node:path";
import { resolveTaskReviewEvidenceV1, type TaskRunV2 } from "../../core/task/index.js";

export interface PiReviewEvidenceItemV1 {
  ref: string;
  sha256: string;
  sizeBytes: number;
  source: "candidate-snapshot" | "run-evidence";
}

export interface PiReviewEvidenceVerificationV1 {
  schemaVersion: 1;
  source: "pactile-task-review-evidence-v1";
  observedAt: string;
  runId: string;
  candidateSnapshotId: string;
  candidateFingerprint: string;
  items: PiReviewEvidenceItemV1[];
}

/** Re-observe the full latest Run candidate and resolve every Review citation to recorded bytes. */
export function resolvePiReviewEvidenceV1(input: {
  root: string;
  taskDir: string;
  candidateRoot: string;
  run: TaskRunV2;
  references: readonly string[];
}): PiReviewEvidenceVerificationV1 {
  const candidate = input.run.candidateSnapshot;
  if (input.run.state !== "completed" || !input.run.result || !candidate) {
    throw new Error("Pi Review evidence requires the latest completed Run candidate");
  }

  const projectRoot = fs.realpathSync(input.root);
  const realTaskDir = fs.realpathSync(input.taskDir);
  const taskRelative = path.relative(projectRoot, realTaskDir);
  const taskPrefix = `${path.join(".pactile", "tasks")}${path.sep}`;
  const normalizedTaskRelative = process.platform === "win32" ? taskRelative.toLowerCase() : taskRelative;
  const normalizedTaskPrefix = process.platform === "win32" ? taskPrefix.toLowerCase() : taskPrefix;
  if (!normalizedTaskRelative.startsWith(normalizedTaskPrefix)) {
    throw new Error("Pi Review TaskDir is outside the project task store");
  }

  const candidateRoot = fs.realpathSync(input.candidateRoot);
  if (input.run.workspace) {
    const workspaceRoot = fs.realpathSync(input.run.workspace.canonicalPath);
    const worktreesRoot = fs.realpathSync(path.join(projectRoot, ".pactile", "worktrees"));
    const workspaceRelative = path.relative(worktreesRoot, workspaceRoot);
    const normalizedWorkspaceRelative = process.platform === "win32" ? workspaceRelative.toLowerCase() : workspaceRelative;
    if (
      candidateRoot !== workspaceRoot || !normalizedWorkspaceRelative || normalizedWorkspaceRelative === ".." ||
      normalizedWorkspaceRelative.startsWith(`..${path.sep}`) || path.isAbsolute(workspaceRelative)
    ) {
      throw new Error("Pi Review candidate workspace is not the bound in-project Run worktree");
    }
  } else if (candidateRoot !== projectRoot) {
    throw new Error("Pi Review candidate files must resolve from the project root when the Run has no workspace binding");
  }

  const resolved = resolveTaskReviewEvidenceV1({
    root: projectRoot,
    taskDir: input.taskDir,
    run: input.run,
    candidateSnapshotId: candidate.id,
    candidateFingerprint: candidate.fingerprint,
    evidenceRefs: input.references,
    allowTaskEvidence: false,
  });
  const items = resolved.items.map((item): PiReviewEvidenceItemV1 => {
    if (item.source !== "candidate-snapshot" && item.source !== "run-evidence") {
      throw new Error("Pi Review evidence resolved to an unsupported source");
    }
    return { ref: item.ref, sha256: item.sha256, sizeBytes: item.sizeBytes, source: item.source };
  });

  return {
    schemaVersion: 1,
    source: "pactile-task-review-evidence-v1",
    observedAt: resolved.observedAt,
    runId: resolved.runId,
    candidateSnapshotId: resolved.candidateSnapshotId,
    candidateFingerprint: resolved.candidateFingerprint,
    items,
  };
}
