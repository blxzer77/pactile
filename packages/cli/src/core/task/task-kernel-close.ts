import { KernelError, requireNonEmptyString } from "./kernel-contract.js";
import {
  appendDomainEvent,
  appendPhase,
  mutateTaskKernel,
  readTaskKernel,
} from "./task-kernel-store-v2.js";
import {
  fingerprintTaskValue,
  getOwnRecordValue,
  parseCandidateObservation,
  parseDeliveryEvidence,
} from "./task-kernel-schema.js";
import {
  assertHardDependenciesSatisfied,
  canonicalProjectRoot,
  resolveInsideTaskRoot,
} from "./task-kernel-paths.js";
import {
  VERIFICATION_CANDIDATE_ENTRY_REF,
  fingerprintCurrentRepositoryFile,
  fingerprintGitTreeFile,
  isGitCommitAncestor,
  isTaskRunPathInWriteSet,
  observeTaskRunCandidate,
  resolveGitLocalBranchSha,
  type GitCandidateObservation,
} from "./task-candidate-observer.js";
import {
  observeGitHubPullRequest,
  type PullRequestProviderFact,
} from "./task-pull-request-observer.js";
import { verifyTaskReviewEvidenceV1 } from "./task-review-evidence.js";
import type {
  CheckTaskCloseRequest,
  CloseTaskKernelRequest,
  TaskCandidateObservation,
  TaskClosureV2,
  TaskDeliveryEvidence,
  TaskDeliveryVerificationV1,
  TaskKernelMutationResult,
  TaskKernelSnapshotV2,
  TaskRunV2,
} from "./task-kernel-types.js";

interface TaskCloseVerification {
  readonly errors: string[];
  readonly candidateObservation?: TaskCandidateObservation;
  readonly deliveryVerification?: TaskDeliveryVerificationV1;
}

export function checkTaskClose(request: CheckTaskCloseRequest): string[] {
  const root = canonicalProjectRoot(request.root, request.cwd);
  const read = readTaskKernel({
    root,
    taskDir: request.taskDir,
    cwd: request.cwd,
  });
  if (read.kind !== "task-kernel-v2") {
    throw new KernelError(
      "INVALID_REQUEST",
      "Close requires a Task Kernel schema v2 task",
    );
  }
  const currentTaskDir = resolveInsideTaskRoot(
    root,
    request.taskDir,
    request.cwd,
  );
  const verification = evaluateTaskClose(
    read.kernel,
    root,
    request.runId,
    request.reviewId,
    request.candidateObservation,
    request.deliveryEvidence,
    currentTaskDir,
  );
  if (request.expectedRevision !== read.kernel.revision) {
    verification.errors.unshift(
      `revision conflict: expected ${request.expectedRevision}, current ${read.kernel.revision}`,
    );
  }
  return verification.errors;
}

export function closeTaskKernel(
  request: CloseTaskKernelRequest,
): TaskKernelMutationResult {
  const root = canonicalProjectRoot(request.root, request.cwd);
  const actor = requireNonEmptyString(request.actor, "actor");
  const fingerprint = fingerprintTaskValue({
    runId: request.runId,
    reviewId: request.reviewId,
    candidateObservation: request.candidateObservation,
    deliveryEvidence: request.deliveryEvidence,
  });
  return mutateTaskKernel(
    root,
    request.taskDir,
    request.expectedRevision,
    actor,
    request.idempotencyKey,
    fingerprint,
    request.cwd,
    (current, dir) => {
      const verification = evaluateTaskClose(
        current,
        root,
        request.runId,
        request.reviewId,
        request.candidateObservation,
        request.deliveryEvidence,
        dir,
      );
      if (verification.errors.length) {
        throw new KernelError(
          "TASK_GATE_UNSATISFIED",
          verification.errors.join("; "),
        );
      }
      const run = current.runs.find((item) => item.id === request.runId);
      const review = current.reviews.find(
        (item) => item.id === request.reviewId,
      );
      if (
        !run ||
        !review ||
        !run.candidateSnapshot ||
        !verification.candidateObservation ||
        !verification.deliveryVerification
      ) {
        throw new KernelError(
          "TASK_GATE_UNSATISFIED",
          "Close is missing a machine-observed candidate or delivery verification.",
        );
      }
      const closure: TaskClosureV2 = {
        runId: run.id,
        reviewId: review.id,
        candidateSnapshotId: run.candidateSnapshot.id,
        candidateFingerprint: run.candidateSnapshot.fingerprint,
        candidateObservation: verification.candidateObservation,
        deliveryEvidence: {
          ...parseDeliveryEvidence(
            request.deliveryEvidence,
            current.definition.deliveryLevel,
          ),
          path: verification.deliveryVerification.path,
        },
        deliveryVerification: verification.deliveryVerification,
        acceptanceEvidence: review.acceptanceEvidence,
        closedAt: new Date().toISOString(),
        closedBy: actor,
      };
      let kernel = appendPhase(
        current,
        "close",
        actor,
        `${request.idempotencyKey}#close`,
        "Task acceptance and machine-observed delivery evidence satisfied.",
      );
      kernel = { ...kernel, outcome: "completed", condition: "ready", closure };
      return appendDomainEvent(
        kernel,
        actor,
        request.idempotencyKey,
        "task.closed",
        current.identity.taskId,
        fingerprint,
      );
    },
  );
}

export function taskCloseErrors(
  kernel: TaskKernelSnapshotV2,
  root: string,
  runId: string,
  reviewId: string,
  observationInput: TaskCandidateObservation,
  deliveryInput: TaskDeliveryEvidence,
  currentTaskDir?: string,
): string[] {
  return evaluateTaskClose(
    kernel,
    root,
    runId,
    reviewId,
    observationInput,
    deliveryInput,
    currentTaskDir,
  ).errors;
}

function evaluateTaskClose(
  kernel: TaskKernelSnapshotV2,
  root: string,
  runId: string,
  reviewId: string,
  observationInput: TaskCandidateObservation,
  deliveryInput: TaskDeliveryEvidence,
  currentTaskDir?: string,
): TaskCloseVerification {
  const errors: string[] = [];
  if (kernel.phase !== "verify") {
    errors.push(
      `Task must reach Verify before Close (current phase: ${kernel.phase})`,
    );
  }
  if (kernel.closure || kernel.phase === "close") {
    errors.push("Task is already closed");
  }
  const run = kernel.runs.find((item) => item.id === runId);
  if (run?.state !== "completed" || !run.candidateSnapshot) {
    errors.push(
      "Close requires a completed Run with a frozen candidate snapshot",
    );
  }
  if (run && kernel.runs.at(-1)?.id !== run.id) {
    errors.push(
      "Close requires the latest recorded Run; older candidates cannot be closed after a retry",
    );
  }
  const review = kernel.reviews.find((item) => item.id === reviewId);
  if (!review) errors.push("Close requires a recorded independent Review");
  if (run && review) {
    if (review.runId !== run.id)
      errors.push("Review must belong to the selected Run");
    if (
      review.candidateSnapshotId !== run.candidateSnapshot?.id ||
      review.candidateFingerprint !== run.candidateSnapshot.fingerprint
    ) {
      errors.push(
        "Review must match the selected Run candidate snapshot ID and fingerprint",
      );
    }
    if (
      review.independent !== true ||
      review.reviewer === run.startedBy ||
      review.reviewer === run.authorization.approvedBy
    ) {
      errors.push(
        "Review must be independent from the Run executor and approver",
      );
    }
    const later = kernel.reviews
      .filter(
        (candidate) =>
          candidate.runId === run.id &&
          candidate.candidateSnapshotId === review.candidateSnapshotId &&
          candidate.candidateFingerprint === review.candidateFingerprint,
      )
      .at(-1);
    if (later?.id !== review.id) {
      errors.push("the latest Review for the selected candidate must be used");
    }
    if (review.decision !== "pass") {
      errors.push("the latest Review for the selected candidate must pass");
    }
    if (review.unresolvedBlockers.length) {
      errors.push("the latest Review has unresolved blockers");
    }
    if (!review.evidenceRefs.length) {
      errors.push(
        "the latest Review must include structured evidence references",
      );
    }
    if (!review.evidenceVerification) {
      errors.push(
        "the latest Review has no Core-observed evidence verification",
      );
    } else if (!currentTaskDir) {
      errors.push(
        "Close cannot re-observe Review evidence without the Task directory",
      );
    } else if (run.candidateSnapshot) {
      try {
        verifyTaskReviewEvidenceV1({
          root,
          taskDir: currentTaskDir,
          run,
          candidateSnapshotId: run.candidateSnapshot.id,
          candidateFingerprint: run.candidateSnapshot.fingerprint,
          evidenceRefs: [
            ...new Set([
              ...review.evidenceRefs,
              ...Object.values(review.acceptanceEvidence).flat(),
            ]),
          ],
          expected: review.evidenceVerification,
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    for (const criterion of kernel.definition.acceptanceCriteria) {
      const refs = getOwnRecordValue(review.acceptanceEvidence, criterion.id);
      if (!refs?.length) {
        errors.push(`acceptance evidence missing for ${criterion.id}`);
      }
    }
  }

  let trustedCandidateObservation: TaskCandidateObservation | undefined;
  let currentCandidate: GitCandidateObservation | undefined;
  if (run?.candidateSnapshot) {
    try {
      const callerObservation = parseCandidateObservation(observationInput);
      if (
        callerObservation.snapshotId !== run.candidateSnapshot.id ||
        callerObservation.fingerprint !== run.candidateSnapshot.fingerprint
      ) {
        errors.push(
          "Close request must name the selected Run candidate snapshot ID and fingerprint",
        );
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      const current = observeTaskRunCandidate({
        run,
        ...(run.workspace === null ? { repositoryRoot: root } : {}),
      });
      currentCandidate = current;
      const candidateEntries = run.candidateSnapshot.entries.filter(
        (entry) => entry.ref === VERIFICATION_CANDIDATE_ENTRY_REF,
      );
      if (candidateEntries.length !== 1) {
        errors.push(
          "Run candidate must contain exactly one P41 machine-observed Git/file entry",
        );
      } else if (candidateEntries[0]?.fingerprint !== current.fingerprint) {
        errors.push(
          "Run candidate is stale: current Git or allowed file bytes no longer match the frozen candidate fingerprint",
        );
      }
      if (current.scopeStatus !== "within-write-set") {
        errors.push(
          `Current Run candidate is ${current.scopeStatus}; Close requires all changed paths inside the frozen write set`,
        );
      }
      if (
        candidateEntries.length === 1 &&
        candidateEntries[0]?.fingerprint === current.fingerprint
      ) {
        trustedCandidateObservation = {
          snapshotId: run.candidateSnapshot.id,
          fingerprint: run.candidateSnapshot.fingerprint,
          observedBy: "pactile-core-task-close",
          observedAt: current.observedAt,
          source: current.source,
          evidenceRef: VERIFICATION_CANDIDATE_ENTRY_REF,
        };
      }
    } catch (error) {
      errors.push(
        `Cannot re-observe the current Run candidate: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  try {
    assertHardDependenciesSatisfied(
      root,
      kernel.definition.dependencies,
      currentTaskDir,
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  let parsedDelivery: TaskDeliveryEvidence | undefined;
  try {
    parsedDelivery = parseDeliveryEvidence(
      deliveryInput,
      kernel.definition.deliveryLevel,
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (
    run &&
    trustedCandidateObservation &&
    currentCandidate &&
    parsedDelivery
  ) {
    try {
      const deliveryVerification = verifyDelivery(
        run,
        parsedDelivery,
        currentCandidate,
      );
      if (deliveryVerification) {
        return {
          errors,
          candidateObservation: trustedCandidateObservation,
          deliveryVerification,
        };
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    errors,
    ...(trustedCandidateObservation === undefined
      ? {}
      : { candidateObservation: trustedCandidateObservation }),
  };
}

function verifyDelivery(
  run: TaskRunV2,
  delivery: TaskDeliveryEvidence,
  observation: GitCandidateObservation,
): TaskDeliveryVerificationV1 {
  const repositoryRoot = observation.repositoryRoot;
  const repositoryPath =
    delivery.path ??
    (delivery.level === "local-result" || delivery.level === "documentation"
      ? delivery.reference
      : undefined);
  if (!repositoryPath) {
    throw new KernelError(
      "INVALID_DELIVERY_EVIDENCE",
      `${delivery.level} delivery requires --delivery-path inside the Run write set`,
    );
  }
  if (!isTaskRunPathInWriteSet(run, repositoryPath)) {
    throw new KernelError(
      "INVALID_DELIVERY_EVIDENCE",
      `Delivery path ${repositoryPath} is outside the frozen Run write set`,
    );
  }
  const currentFile = fingerprintCurrentRepositoryFile(
    repositoryRoot,
    repositoryPath,
  );
  if (currentFile.kind !== "regular-file" || currentFile.sha256 === null) {
    throw new KernelError(
      "INVALID_DELIVERY_EVIDENCE",
      `Delivery path ${repositoryPath} is not a current regular file`,
    );
  }
  const currentCandidateFile = observation.currentFiles.find(
    (entry) => entry.path === currentFile.path,
  );
  if (
    currentCandidateFile &&
    (currentCandidateFile.kind !== "regular-file" ||
      currentCandidateFile.sha256 !== currentFile.sha256)
  ) {
    throw new KernelError(
      "INVALID_DELIVERY_EVIDENCE",
      `Delivery path ${repositoryPath} changed after candidate observation`,
    );
  }
  const candidateGitFile = fingerprintGitTreeFile(
    repositoryRoot,
    observation.head,
    repositoryPath,
  );
  if (!currentCandidateFile && !candidateGitFile) {
    throw new KernelError(
      "INVALID_DELIVERY_EVIDENCE",
      `Delivery path ${repositoryPath} is not bound to changed candidate bytes or the frozen Git HEAD`,
    );
  }

  const result: TaskDeliveryVerificationV1 = {
    schemaVersion: 1,
    source: "pactile-task-delivery-observer-v1",
    observedAt: new Date().toISOString(),
    candidateFingerprint: run.candidateSnapshot?.fingerprint ?? "",
    candidateHead: observation.head,
    level: delivery.level,
    path: currentFile.path,
    fileSha256: currentFile.sha256,
    gitBlobSha256: candidateGitFile?.sha256 ?? null,
    targetBranch: null,
    targetSha: null,
    integrationCommitSha: null,
    ancestryVerified: null,
    pullRequest: null,
  };
  if (delivery.level === "local-result" || delivery.level === "documentation") {
    return result;
  }

  if (
    observation.stagedPaths.length > 0 ||
    observation.unstagedPaths.length > 0 ||
    observation.untrackedPaths.length > 0 ||
    observation.conflictPaths.length > 0
  ) {
    throw new KernelError(
      "INVALID_DELIVERY_EVIDENCE",
      `${delivery.level} delivery requires a clean candidate Git worktree with no staged, unstaged, untracked, or conflicted paths`,
    );
  }
  if (!candidateGitFile) {
    throw new KernelError(
      "INVALID_DELIVERY_EVIDENCE",
      `Delivery path ${repositoryPath} is not present at the frozen candidate HEAD`,
    );
  }
  if (currentFile.sha256 !== candidateGitFile.sha256) {
    throw new KernelError(
      "INVALID_DELIVERY_EVIDENCE",
      `Delivery path ${repositoryPath} current bytes do not match the frozen candidate HEAD blob`,
    );
  }
  const pullRequest = observeGitHubPullRequest(
    repositoryRoot,
    delivery.reference,
  );
  assertPullRequestMatchesCandidate(pullRequest, observation.head);
  if (delivery.level === "pull-request") {
    if (pullRequest.state !== "open" || pullRequest.merged) {
      throw new KernelError(
        "INVALID_DELIVERY_EVIDENCE",
        "pull-request delivery requires a provider-confirmed open Pull Request",
      );
    }
    return {
      ...result,
      pullRequest,
    };
  }

  const targetBranch = delivery.targetBranch;
  if (!targetBranch) {
    throw new KernelError(
      "INVALID_DELIVERY_EVIDENCE",
      "merged-result delivery requires --target-branch for local ancestry verification",
    );
  }
  if (!pullRequest.merged || pullRequest.state !== "closed") {
    throw new KernelError(
      "INVALID_DELIVERY_EVIDENCE",
      "merged-result delivery requires provider-confirmed merged Pull Request state",
    );
  }
  if (pullRequest.baseBranch !== targetBranch) {
    throw new KernelError(
      "INVALID_DELIVERY_EVIDENCE",
      `Pull Request base branch ${pullRequest.baseBranch} does not match target branch ${targetBranch}`,
    );
  }
  const integrationCommitSha = pullRequest.mergeCommitSha;
  if (!integrationCommitSha) {
    throw new KernelError(
      "INVALID_DELIVERY_EVIDENCE",
      "Merged Pull Request has no provider-confirmed merge commit SHA",
    );
  }
  const targetSha = resolveGitLocalBranchSha(repositoryRoot, targetBranch);
  if (!isGitCommitAncestor(repositoryRoot, integrationCommitSha, targetSha)) {
    throw new KernelError(
      "INVALID_DELIVERY_EVIDENCE",
      `Provider merge commit ${integrationCommitSha} is not an ancestor of local target ${targetBranch} (${targetSha})`,
    );
  }
  const targetFile = fingerprintGitTreeFile(
    repositoryRoot,
    targetSha,
    repositoryPath,
  );
  if (targetFile?.sha256 !== candidateGitFile.sha256) {
    throw new KernelError(
      "INVALID_DELIVERY_EVIDENCE",
      `Target branch ${targetBranch} does not contain the same delivery bytes at ${repositoryPath}`,
    );
  }
  return {
    ...result,
    targetBranch,
    targetSha,
    integrationCommitSha,
    ancestryVerified: true,
    pullRequest,
  };
}

function assertPullRequestMatchesCandidate(
  pullRequest: PullRequestProviderFact,
  candidateHead: string,
): void {
  if (pullRequest.headSha !== candidateHead) {
    throw new KernelError(
      "INVALID_DELIVERY_EVIDENCE",
      `Provider Pull Request head ${pullRequest.headSha} does not match frozen candidate HEAD ${candidateHead}`,
    );
  }
  if (pullRequest.draft) {
    throw new KernelError(
      "INVALID_DELIVERY_EVIDENCE",
      "Draft Pull Requests cannot satisfy delivery evidence",
    );
  }
  if (pullRequest.state !== "open" && !pullRequest.merged) {
    throw new KernelError(
      "INVALID_DELIVERY_EVIDENCE",
      "Pull Request is closed without being merged",
    );
  }
}
