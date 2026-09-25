import type { TaskRunWorkspaceBinding } from "../../core/task/task-kernel.js";

export type RunWorkspaceBinding = TaskRunWorkspaceBinding;
export type WorkspaceRunState = "waiting" | "running" | "completed" | "failed" | "blocked" | "cancelled" | "interrupted";

export interface WorkspaceOwnerRef {
  ownerRunId: string;
  canonicalPath: string;
}

export interface RunResultEvidence {
  runId: string;
  summary: string;
  evidenceRefs: string[];
  candidateSnapshotId?: string;
  candidateFingerprint?: string;
}

export type WorktreeIssueCode =
  | "path-anomaly"
  | "owner-mismatch"
  | "manager-provenance-mismatch"
  | "gitdir-mismatch"
  | "not-registered"
  | "common-dir-mismatch"
  | "branch-mismatch"
  | "registered-head-mismatch"
  | "baseline-mismatch"
  | "write-set-violation"
  | "interrupted"
  | "unintegrated"
  | "dirty";

export interface WorktreeInspection {
  state: "clean" | WorktreeIssueCode;
  ownerRunId: string;
  canonicalPath: string;
  actualPath: string | null;
  commonDir: string | null;
  gitDir: string | null;
  branch: string | null;
  baseSha: string;
  headSha: string | null;
  dirty: boolean;
  dirtyEntryCount: number;
  changedPaths: string[];
  scopeViolations: string[];
  issues: WorktreeIssueCode[];
}

export interface ParallelWriteSetAuthorization {
  runIds: [string, string];
  overlapPaths: string[];
  approvedBy: string;
  approvedAt: string;
  evidenceRef: string;
  integrationPlan: string;
}

export type ParallelWriteSetDecision =
  | { allowed: true; overlapPaths: string[]; authorization: ParallelWriteSetAuthorization | null }
  | { allowed: false; overlapPaths: string[]; reason: "write-set-conflict" | "invalid-authorization" };

export class WorktreeManagerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly worktreePath: string | null = null,
  ) {
    super(message);
    this.name = "WorktreeManagerError";
  }
}

export interface GitIdentity {
  root: string;
  commonDir: string;
}

export interface ManagerProvenance {
  version: 1;
  credentialId: string;
  ownerRunId: string;
  canonicalPath: string;
  projectRoot: string;
  commonDir: string;
  gitDir: string;
  branch: string;
  baseSha: string;
  writeSet: string[];
  source: "created" | "adopted";
  recordedAt: string;
  adoption?: { approvedBy: string; approvedAt: string; evidenceRef: string };
}

export interface GitWorktreeRegistration {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
}
