import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { KernelError } from "./kernel-contract.js";
import {
  canonicalProjectRoot,
  resolveInsideTaskRoot,
} from "./task-kernel-paths.js";
import {
  fingerprintCurrentRepositoryFile,
  isTaskRunPathInWriteSet,
  observeTaskRunCandidate,
  VERIFICATION_CANDIDATE_ENTRY_REF,
  type GitCandidateObservation,
} from "./task-candidate-observer.js";
import type {
  TaskReviewEvidenceItemV1,
  TaskReviewEvidenceVerificationV1,
  TaskRunEvidenceItemV1,
  TaskRunEvidenceVerificationV1,
  TaskRunV2,
} from "./task-kernel-types.js";

const MAX_EVIDENCE_REFS = 128;
const MAX_EVIDENCE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_EVIDENCE_BYTES = 32 * 1024 * 1024;

export interface ResolveTaskReviewEvidenceV1Request {
  readonly root: string;
  readonly taskDir: string;
  readonly cwd?: string;
  readonly run: TaskRunV2;
  readonly candidateSnapshotId: string;
  readonly candidateFingerprint: string;
  readonly evidenceRefs: readonly string[];
  readonly allowRunEvidence?: boolean;
  readonly allowTaskEvidence?: boolean;
}

export interface VerifyTaskReviewEvidenceV1Request extends ResolveTaskReviewEvidenceV1Request {
  readonly expected: TaskReviewEvidenceVerificationV1;
}

interface ResolvedFile {
  readonly sha256: string;
  readonly sizeBytes: number;
}

function fail(message: string): never {
  throw new KernelError("INVALID_DELIVERY_EVIDENCE", message);
}

function normalizeEvidencePath(value: string): string {
  if (value !== value.trim())
    return fail(
      "Review evidence references must be non-empty repository-relative paths.",
    );
  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        containsControlCharacter(segment),
    )
  ) {
    return fail(
      `Review evidence reference ${value} must be a safe relative file path.`,
    );
  }
  return segments.join("/");
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function taskFileSha256(
  taskDir: string,
  repositoryPath: string,
  remainingBytes: number,
): ResolvedFile {
  const taskRoot = fs.realpathSync(taskDir);
  let current = taskDir;
  const segments = repositoryPath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return fail(
        `Review evidence file ${repositoryPath} does not exist in the Task directory.`,
      );
    }
    if (stat.isSymbolicLink()) {
      return fail(
        `Review evidence file ${repositoryPath} cannot be a symlink.`,
      );
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      return fail(
        `Review evidence path ${repositoryPath} crosses a non-directory.`,
      );
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      return fail(
        `Review evidence file ${repositoryPath} must be a regular file.`,
      );
    }
  }
  const relative = path.relative(taskRoot, fs.realpathSync(current));
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return fail(
      `Review evidence file ${repositoryPath} escapes the Task directory.`,
    );
  }
  const before = fs.lstatSync(current);
  if (before.size > MAX_EVIDENCE_FILE_BYTES) {
    return fail(
      `Review evidence file ${repositoryPath} exceeds the ${MAX_EVIDENCE_FILE_BYTES}-byte limit.`,
    );
  }
  if (before.size > remainingBytes) {
    return fail(
      `Review evidence exceeds the ${MAX_TOTAL_EVIDENCE_BYTES}-byte total limit.`,
    );
  }
  const realPathBeforeRead = fs.realpathSync(current);
  const first = fs.readFileSync(current);
  const afterFirst = fs.lstatSync(current);
  const second = fs.readFileSync(current);
  const afterSecond = fs.lstatSync(current);
  const realPathAfterRead = fs.realpathSync(current);
  if (
    realPathBeforeRead !== realPathAfterRead ||
    !realPathAfterRead.startsWith(`${taskRoot}${path.sep}`) ||
    before.dev !== afterFirst.dev ||
    before.ino !== afterFirst.ino ||
    before.size !== afterFirst.size ||
    before.mtimeMs !== afterFirst.mtimeMs ||
    afterFirst.dev !== afterSecond.dev ||
    afterFirst.ino !== afterSecond.ino ||
    afterFirst.size !== afterSecond.size ||
    afterFirst.mtimeMs !== afterSecond.mtimeMs ||
    !first.equals(second)
  ) {
    return fail(
      `Review evidence file ${repositoryPath} changed during observation.`,
    );
  }
  return {
    sha256: createHash("sha256").update(first).digest("hex"),
    sizeBytes: first.byteLength,
  };
}

function findRunObservation(
  request: ResolveTaskReviewEvidenceV1Request,
): GitCandidateObservation {
  const run = request.run;
  if (
    run.state !== "completed" ||
    !run.result ||
    !run.candidateSnapshot ||
    run.id !== request.run.id ||
    run.candidateSnapshot.id !== request.candidateSnapshotId ||
    run.candidateSnapshot.fingerprint !== request.candidateFingerprint
  ) {
    throw new KernelError(
      "CANDIDATE_MISMATCH",
      "Review evidence must bind to the selected completed Run and candidate snapshot.",
    );
  }
  let observation;
  try {
    observation =
      run.workspace === null
        ? observeTaskRunCandidate({
            run,
            repositoryRoot: canonicalProjectRoot(request.root, request.cwd),
          })
        : observeTaskRunCandidate({ run });
  } catch (error) {
    throw new KernelError(
      "CANDIDATE_MISMATCH",
      `Review evidence cannot use a stale candidate: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const observerEntries = run.candidateSnapshot.entries.filter(
    (entry) => entry.ref === VERIFICATION_CANDIDATE_ENTRY_REF,
  );
  if (
    observerEntries.length !== 1 ||
    observerEntries[0]?.fingerprint !== observation.fingerprint
  ) {
    throw new KernelError(
      "CANDIDATE_MISMATCH",
      "Review evidence cannot use a stale Core-observed Run candidate entry.",
    );
  }
  return observation;
}

/** Freeze Run evidence against the real candidate bytes or TaskDir files at completion. */
export function freezeTaskRunEvidenceV1(request: {
  readonly root: string;
  readonly taskDir: string;
  readonly cwd?: string;
  readonly run: TaskRunV2;
}): TaskRunEvidenceVerificationV1 {
  const run = request.run;
  const snapshot = run.candidateSnapshot;
  if (run.state !== "completed" || !run.result || !snapshot) {
    throw new KernelError(
      "CANDIDATE_MISMATCH",
      "Run evidence can only be frozen with a completed Run candidate.",
    );
  }
  const refs = uniqueEvidenceRefs(run.result.evidenceRefs);
  const observation = observeTaskRunCandidate({
    run,
    ...(run.workspace === null
      ? { repositoryRoot: canonicalProjectRoot(request.root, request.cwd) }
      : {}),
  });
  const observerEntries = snapshot.entries.filter(
    (entry) => entry.ref === VERIFICATION_CANDIDATE_ENTRY_REF,
  );
  if (
    observerEntries.length !== 1 ||
    observerEntries[0]?.fingerprint !== observation.fingerprint
  ) {
    throw new KernelError(
      "CANDIDATE_MISMATCH",
      "Run evidence cannot bind to a stale Core-observed candidate entry.",
    );
  }
  const observedFiles = new Map(
    observation.currentFiles.map((file) => [file.path, file]),
  );
  const entries = new Map<string, (typeof snapshot.entries)[number]>();
  for (const entry of snapshot.entries) {
    if (entry.ref === VERIFICATION_CANDIDATE_ENTRY_REF) continue;
    const ref = normalizeEvidencePath(entry.ref);
    if (entries.has(ref)) {
      return fail(`Run candidate contains duplicate evidence reference ${ref}.`);
    }
    entries.set(ref, entry);
  }
  const realTaskDir = resolveInsideTaskRoot(
    canonicalProjectRoot(request.root, request.cwd),
    request.taskDir,
    request.cwd,
  );
  if (fs.lstatSync(realTaskDir).isSymbolicLink()) {
    return fail("Run evidence cannot be resolved through a symlink Task directory.");
  }
  let totalBytes = 0;
  const items: TaskRunEvidenceItemV1[] = [];
  for (const ref of refs) {
    if (isTaskRunPathInWriteSet(run, ref)) {
      const entry = entries.get(ref);
      const file = observedFiles.get(ref);
      if (
        !entry ||
        file?.kind !== "regular-file" ||
        file.sha256 === null ||
        entry.fingerprint !== file.sha256
      ) {
        return fail(
          `Run evidence ${ref} must match a frozen regular-file candidate entry in the Run write set.`,
        );
      }
      totalBytes += file.sizeBytes;
      items.push({
        ref,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        source: "candidate-snapshot",
      });
    } else {
      const file = taskFileSha256(
        realTaskDir,
        ref,
        MAX_TOTAL_EVIDENCE_BYTES - totalBytes,
      );
      totalBytes += file.sizeBytes;
      items.push({ ...file, ref, source: "task-evidence" });
    }
  }
  if (totalBytes > MAX_TOTAL_EVIDENCE_BYTES) {
    return fail(
      `Run evidence exceeds the ${MAX_TOTAL_EVIDENCE_BYTES}-byte total limit.`,
    );
  }
  return {
    schemaVersion: 1,
    source: "pactile-task-run-evidence-v1",
    observedAt: new Date().toISOString(),
    runId: run.id,
    candidateSnapshotId: snapshot.id,
    candidateFingerprint: snapshot.fingerprint,
    items,
  };
}

function uniqueEvidenceRefs(refs: readonly string[]): string[] {
  if (refs.length > MAX_EVIDENCE_REFS) {
    return fail(
      `Review evidence exceeds the ${MAX_EVIDENCE_REFS}-reference limit.`,
    );
  }
  const normalized = refs.map(normalizeEvidencePath);
  if (new Set(normalized).size !== normalized.length) {
    return fail(
      "Review evidence references must be unique after path normalization.",
    );
  }
  return normalized;
}

function observeEvidenceItems(
  request: ResolveTaskReviewEvidenceV1Request,
  refs: readonly string[],
): TaskReviewEvidenceItemV1[] {
  const root = canonicalProjectRoot(request.root, request.cwd);
  const taskDir = resolveInsideTaskRoot(root, request.taskDir, root);
  if (fs.lstatSync(taskDir).isSymbolicLink()) {
    return fail(
      "Review evidence cannot be resolved through a symlink Task directory.",
    );
  }
  const realTaskDir = fs.realpathSync(taskDir);
  const run = request.run;
  const snapshot = run.candidateSnapshot;
  if (!snapshot) {
    throw new KernelError(
      "CANDIDATE_MISMATCH",
      "Run candidate snapshot is missing.",
    );
  }
  const observation = findRunObservation(request);
  const observationFiles = new Map(
    observation.currentFiles.map((file) => [file.path, file]),
  );
  const runEvidenceVerification = run.result?.evidenceVerification;
  if (
    runEvidenceVerification &&
    (runEvidenceVerification.source !== "pactile-task-run-evidence-v1" ||
      runEvidenceVerification.runId !== run.id ||
      runEvidenceVerification.candidateSnapshotId !== snapshot.id ||
      runEvidenceVerification.candidateFingerprint !== snapshot.fingerprint)
  ) {
    return fail(
      "Run evidence digest receipt does not match the selected Run candidate.",
    );
  }
  const runEvidenceItems = new Map(
    runEvidenceVerification?.items.map((item) => [item.ref, item]) ?? [],
  );
  const entriesByRef = new Map<string, (typeof snapshot.entries)[number]>();
  for (const entry of snapshot.entries) {
    if (entry.ref === VERIFICATION_CANDIDATE_ENTRY_REF) continue;
    let normalized: string;
    try {
      normalized = normalizeEvidencePath(entry.ref);
    } catch {
      continue;
    }
    if (entriesByRef.has(normalized)) {
      return fail(
        `Run candidate contains duplicate evidence reference ${normalized}.`,
      );
    }
    entriesByRef.set(normalized, entry);
  }
  const recordedRunRefs = new Set(run.result?.evidenceRefs ?? []);
  const workspaceRoot = run.workspace?.canonicalPath ?? root;
  let totalBytes = 0;
  const items: TaskReviewEvidenceItemV1[] = [];
  for (const ref of refs) {
    const candidateEntry = entriesByRef.get(ref);
    const wasRunEvidence = recordedRunRefs.has(ref);
    const runEvidenceItem = runEvidenceItems.get(ref);
    if (wasRunEvidence && (!runEvidenceVerification || !runEvidenceItem)) {
      return fail(
        `Run evidence ${ref} has no completion-time Core digest receipt.`,
      );
    }
    if (candidateEntry) {
      if (!isTaskRunPathInWriteSet(run, ref)) {
        return fail(`Candidate evidence ${ref} is outside the Run write set.`);
      }
      let file: ReturnType<typeof fingerprintCurrentRepositoryFile>;
      try {
        file = fingerprintCurrentRepositoryFile(workspaceRoot, ref);
      } catch (error) {
        return fail(
          `Candidate evidence ${ref} cannot be observed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (file.sha256 === null) {
        return fail(`Candidate evidence ${ref} has no regular-file digest.`);
      }
      const frozenFile = observationFiles.get(ref);
      if (
        candidateEntry.fingerprint !== file.sha256 ||
        frozenFile?.kind !== "regular-file" ||
        frozenFile.sha256 !== file.sha256 ||
        (wasRunEvidence &&
          (runEvidenceItem?.source !== "candidate-snapshot" ||
            runEvidenceItem.sha256 !== file.sha256 ||
            runEvidenceItem.sizeBytes !== file.sizeBytes))
      ) {
        return fail(
          `Candidate evidence ${ref} does not match the Run's frozen regular-file bytes.`,
        );
      }
      totalBytes += file.sizeBytes;
      items.push({
        ref,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        source: "candidate-snapshot",
      });
      continue;
    }

    if (!wasRunEvidence && request.allowTaskEvidence === false) {
      return fail(
        `Review evidence ${ref} is not present in the Run candidate or result.`,
      );
    }
    if (wasRunEvidence && request.allowRunEvidence === false) {
      return fail(`Run evidence ${ref} is not allowed in this Review.`);
    }
    if (wasRunEvidence && isTaskRunPathInWriteSet(run, ref)) {
      let file: ReturnType<typeof fingerprintCurrentRepositoryFile>;
      try {
        file = fingerprintCurrentRepositoryFile(workspaceRoot, ref);
      } catch (error) {
        return fail(
          `Run evidence ${ref} cannot be observed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (file.sha256 === null) {
        return fail(`Run evidence ${ref} has no regular-file digest.`);
      }
      const frozenFile = observationFiles.get(ref);
      if (
        frozenFile?.kind !== "regular-file" ||
        frozenFile.sha256 !== file.sha256 ||
        runEvidenceItem?.source !== "candidate-snapshot" ||
        runEvidenceItem.sha256 !== file.sha256 ||
        runEvidenceItem.sizeBytes !== file.sizeBytes
      ) {
        return fail(
          `Run evidence ${ref} was not bound to the frozen candidate bytes.`,
        );
      }
      totalBytes += file.sizeBytes;
      items.push({
        ref,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        source: "run-evidence",
      });
      continue;
    }
    if (wasRunEvidence || request.allowTaskEvidence !== false) {
      const file = taskFileSha256(
        realTaskDir,
        ref,
        MAX_TOTAL_EVIDENCE_BYTES - totalBytes,
      );
      if (
        wasRunEvidence &&
        (runEvidenceItem?.source !== "task-evidence" ||
          runEvidenceItem.sha256 !== file.sha256 ||
          runEvidenceItem.sizeBytes !== file.sizeBytes)
      ) {
        return fail(
          `Run evidence ${ref} no longer matches its completion-time digest.`,
        );
      }
      totalBytes += file.sizeBytes;
      items.push({
        ref,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        source: wasRunEvidence ? "run-evidence" : "task-evidence",
      });
      continue;
    }
    return fail(
      `Review evidence ${ref} could not be resolved to an allowed file.`,
    );
  }
  if (totalBytes > MAX_TOTAL_EVIDENCE_BYTES) {
    return fail(
      `Review evidence exceeds the ${MAX_TOTAL_EVIDENCE_BYTES}-byte total limit.`,
    );
  }
  return items;
}

/** Resolve Review and acceptance references to bounded, current file bytes. */
export function resolveTaskReviewEvidenceV1(
  request: ResolveTaskReviewEvidenceV1Request,
): TaskReviewEvidenceVerificationV1 {
  const refs = uniqueEvidenceRefs(request.evidenceRefs);
  const items = observeEvidenceItems(request, refs);
  return {
    schemaVersion: 1,
    source: "pactile-task-review-evidence-v1",
    observedAt: new Date().toISOString(),
    runId: request.run.id,
    candidateSnapshotId: request.candidateSnapshotId,
    candidateFingerprint: request.candidateFingerprint,
    items,
  };
}

/** Re-resolve and compare stored Review evidence at Close time. */
export function verifyTaskReviewEvidenceV1(
  request: VerifyTaskReviewEvidenceV1Request,
): void {
  const current = resolveTaskReviewEvidenceV1(request);
  const expected = request.expected;
  if (
    expected.schemaVersion !== 1 ||
    expected.source !== "pactile-task-review-evidence-v1" ||
    expected.runId !== current.runId ||
    expected.candidateSnapshotId !== current.candidateSnapshotId ||
    expected.candidateFingerprint !== current.candidateFingerprint ||
    JSON.stringify(expected.items) !== JSON.stringify(current.items)
  ) {
    return fail(
      "Stored Review evidence is missing, stale, or has changed bytes.",
    );
  }
}
