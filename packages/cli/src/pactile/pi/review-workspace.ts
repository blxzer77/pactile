import fs from "node:fs";

import { resolveTaskReviewEvidenceV1, type TaskRunV2 } from "../../core/task/index.js";

/** The Kernel binding and frozen candidate establish identity, not a directory name. */
export function resolvePiReviewWorkspace(input: {
  root: string;
  taskDir: string;
  run: TaskRunV2;
  candidateRoot?: string;
}): string {
  const { run } = input;
  const candidate = run.candidateSnapshot;
  if (run.state !== "completed" || !run.result || !candidate) {
    throw new Error("Pi Review workspace requires a completed Run candidate");
  }
  const root = fs.realpathSync(input.root);
  const workspace = fs.realpathSync(run.workspace?.canonicalPath ?? root);
  if (input.candidateRoot !== undefined && fs.realpathSync(input.candidateRoot) !== workspace) {
    throw new Error("Pi Review candidate workspace does not match the Kernel Run binding");
  }

  // Core re-observes workspace identity, base/branch, the complete candidate,
  // write-set scope and completion-time evidence. It also checks Task store scope.
  // Keep manual workspaces eligible without pretending they are manager-owned.
  resolveTaskReviewEvidenceV1({
    root,
    taskDir: input.taskDir,
    run,
    candidateSnapshotId: candidate.id,
    candidateFingerprint: candidate.fingerprint,
    evidenceRefs: run.result.evidenceRefs,
    allowTaskEvidence: false,
  });
  return workspace;
}
