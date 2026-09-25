import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  appendTaskRunHostSettlementRefs,
  bindTaskRunHostReceipt,
  fingerprintTaskValue,
  readTaskKernel,
  type TaskKernelSnapshotV2,
  type TaskRunV2,
} from "../../core/task/index.js";
import {
  acquireTaskKernelRunDispatchV1,
  bindTaskKernelRunDispatchOwnerV1,
  releaseTaskKernelRunDispatchV1,
  scheduleTaskKernelGraph,
  validateTaskKernelRunDispatchStopProofV1,
  type TaskKernelRunDispatchOwnerV1,
} from "../scheduler/index.js";
import { resolveTaskDir } from "../task/session.js";
import { sameGitRoot } from "../../utils/git-root.js";

export interface PiV2RunDispatch {
  root: string;
  taskDir: string;
  taskDirRef: string;
  workdir: string;
  taskId: string;
  runId: string;
  run: TaskRunV2;
  scheduleReceiptFingerprint: string;
  admissionReceiptFingerprint: string;
  admissionReceiptRef: string;
  leaseId: string;
}

export interface PiProcessExitEvidence {
  processId: number;
  stopRequestedAt: string;
  killRequestedAt: string | null;
  exitObservedAt: string | null;
  exitCode: number | null;
  signalCode: string | null;
  terminationVerified: boolean;
}

export interface PiHostStopReceipt {
  schemaVersion: 1;
  source: "pactile-pi-rpc";
  assurance: "manager-owned-child-exit";
  taskId: string;
  taskRunId: string;
  piRunId: string;
  role: "implement";
  sessionId: string;
  processId: number;
  startRequestId: string;
  settleReceiptId: string;
  terminal: "exited" | "cancelled";
  exitCode: number | null;
  signalCode: string | null;
  cancellationRequestId: string | null;
  evidenceRef: string;
  progressEvidenceRef: string;
  resultRef: string | null;
  resultSha256: string | null;
  recordedAt: string;
  processExit: PiProcessExitEvidence;
}

export interface PiV2StopRecord {
  runId: string;
  startRequestId: string;
  sessionId: string;
  processId: number;
  progressEvidenceRef: string;
  startReceiptRef: string;
  runReceiptRef: string;
  resultRef: string | null;
  resultSha256: string | null;
  outcome: string;
  cancellationRequestId: string | null;
  processExit: PiProcessExitEvidence;
  processStopReceipt: PiHostStopReceipt;
}

export interface PiV2SettlementResult {
  stopReceiptRef: string;
  stopReceiptTaskRef: string;
  proofFingerprint: string;
  released: boolean;
  reasonCode: string | null;
}

function taskRelativeRef(root: string, taskDir: string, ref: string): string {
  const relative = path.relative(root, path.resolve(taskDir, ref));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Pi V2 evidence must stay inside its Task directory");
  }
  return relative.replaceAll("\\", "/");
}

function runAt(
  root: string,
  taskDir: string,
  taskId: string,
  runId: string,
): { kernel: TaskKernelSnapshotV2; run: TaskRunV2 } {
  const read = readTaskKernel({ root, taskDir, cwd: root });
  if (read.kind !== "task-kernel-v2" || read.kernel.identity.taskId !== taskId) {
    throw new Error("Pi V2 dispatch requires the matching Task Kernel V2");
  }
  const run = read.kernel.runs.at(-1);
  if (run?.id !== runId || run?.taskId !== taskId) {
    throw new Error("Pi V2 dispatch runId must identify the latest Task Run");
  }
  if (run.state !== "running" && run.state !== "waiting") {
    throw new Error(`Pi V2 Run is not dispatchable: ${run.state}`);
  }
  if (run.candidateSnapshot) {
    throw new Error("Pi V2 dispatch cannot start after a candidate snapshot exists");
  }
  return { kernel: read.kernel, run };
}

function workdirForRun(root: string, run: TaskRunV2): string {
  if (!run.workspace) return root;
  const allowedRoot = path.resolve(root, ".pactile", "worktrees");
  const candidate = path.resolve(run.workspace.canonicalPath);
  const relative = path.relative(allowedRoot, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Pi V2 Run workspace must stay under .pactile/worktrees");
  }
  if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Pi V2 Run workspace is missing");
  }
  const realRoot = fs.realpathSync(allowedRoot);
  const realCandidate = fs.realpathSync(candidate);
  const realRelative = path.relative(realRoot, realCandidate);
  if (!realRelative || realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error("Pi V2 Run workspace resolves outside .pactile/worktrees");
  }
  let gitRoot: string;
  try {
    gitRoot = execFileSync("git", [
      "-c",
      `safe.directory=${realCandidate.replaceAll("\\", "/")}`,
      "-C",
      realCandidate,
      "rev-parse",
      "--show-toplevel",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error("Pi V2 Run workspace is not a usable Git checkout");
  }
  if (!sameGitRoot(gitRoot, realCandidate)) {
    throw new Error("Pi V2 Run workspace Git root does not match its binding");
  }
  return realCandidate;
}

export function preparePiV2RunDispatch(
  rootValue: string,
  taskReference: string,
  runId: string,
): PiV2RunDispatch {
  const root = path.resolve(rootValue);
  const taskDir = resolveTaskDir(root, taskReference);
  const initial = readTaskKernel({ root, taskDir, cwd: root });
  if (initial.kind !== "task-kernel-v2") {
    throw new Error("--run-id requires a Task Kernel V2 task");
  }
  const taskId = initial.kernel.identity.taskId;
  const initialRun = initial.kernel.runs.at(-1);
  if (initialRun) {
    workdirForRun(root, initialRun);
    if (initialRun.host) throw new Error("Pi V2 Run already has a host binding");
  }
  const schedule = scheduleTaskKernelGraph(root, [taskId]);
  const admission = acquireTaskKernelRunDispatchV1(root, {
    scheduleReceiptFingerprint: schedule.receipt.receiptFingerprint,
    taskId,
    runId,
    owner: {
      host: "pi",
      role: "implement",
      sessionId: null,
      threadId: null,
      hostId: null,
      startRequestId: null,
      processId: null,
    },
  });
  if (!admission.permitted) {
    const reason = admission.receipt.reasonCodes.join(", ") || "dispatch denied";
    throw new Error(
      `Pi V2 dispatch rejected before process start (${reason}; admission receipt ${admission.receiptFile})`,
    );
  }
  const current = runAt(root, taskDir, taskId, runId);
  if (current.run.host) throw new Error("Pi V2 Run already has a host binding");
  const workdir = workdirForRun(root, current.run);
  return {
    root,
    taskDir,
    taskDirRef: path.relative(root, taskDir).replaceAll("\\", "/"),
    workdir,
    taskId,
    runId,
    run: current.run,
    scheduleReceiptFingerprint: schedule.receipt.receiptFingerprint,
    admissionReceiptFingerprint: admission.receipt.receiptFingerprint,
    admissionReceiptRef: admission.receiptFile,
    leaseId: admission.leaseId,
  };
}

export function bindPiV2RunHost(
  dispatch: PiV2RunDispatch,
  input: {
    piRunId: string;
    startRequestId: string;
    sessionId: string;
    processId: number;
    progressEvidenceRef: string;
  },
): { owner: TaskKernelRunDispatchOwnerV1; hostRevision: number } {
  const { kernel, run } = runAt(
    dispatch.root,
    dispatch.taskDir,
    dispatch.taskId,
    dispatch.runId,
  );
  if (run.host) throw new Error("Pi V2 Run already has a bound host");
  const hostMutation = bindTaskRunHostReceipt({
    root: dispatch.root,
    taskDir: dispatch.taskDir,
    expectedRevision: kernel.revision,
    runId: dispatch.runId,
    host: {
      host: "pi",
      role: "implement",
      sessionId: input.sessionId,
      hostId: null,
      threadId: null,
      requestRefs: [input.startRequestId],
      eventRefs: [input.progressEvidenceRef],
      resultRefs: [],
      assuranceSource: "manager-owned-child-exit",
    },
    actor: "pactile-pi-bridge",
    idempotencyKey: `pi-host-bound:${dispatch.runId}:${input.piRunId}`,
    cwd: dispatch.root,
  });
  const owner: TaskKernelRunDispatchOwnerV1 = {
    host: "pi",
    role: "implement",
    sessionId: input.sessionId,
    threadId: null,
    hostId: null,
    startRequestId: input.startRequestId,
    processId: input.processId,
  };
  const bound = bindTaskKernelRunDispatchOwnerV1(dispatch.root, {
    leaseId: dispatch.leaseId,
    taskId: dispatch.taskId,
    runId: dispatch.runId,
    owner,
  });
  if (!bound.bound) {
    throw new Error(`Pi V2 dispatch owner binding failed: ${bound.reasonCode}`);
  }
  return { owner, hostRevision: hostMutation.kernel.revision };
}

function storeProof(dispatch: PiV2RunDispatch, proofBase: Record<string, unknown>): string {
  const proofFingerprint = fingerprintTaskValue(proofBase);
  const file = path.join(
    dispatch.taskDir,
    "pi-bridge",
    "dispatch-proofs",
    `${proofFingerprint}.json`,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const value = { ...proofBase, proof_fingerprint: proofFingerprint };
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    fs.writeFileSync(file, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== content) throw error;
  }
  return path.relative(dispatch.root, file).replaceAll("\\", "/");
}

export function persistPiV2StopAndRelease(
  dispatch: PiV2RunDispatch,
  stop: PiV2StopRecord,
): PiV2SettlementResult {
  if (!stop.processExit.terminationVerified || !stop.processExit.exitObservedAt) {
    return { stopReceiptRef: "", stopReceiptTaskRef: "", proofFingerprint: "", released: false, reasonCode: "pi-process-close-unverified" };
  }
  const startFile = path.resolve(dispatch.taskDir, stop.startReceiptRef);
  const runFile = path.resolve(dispatch.taskDir, stop.runReceiptRef);
  const startReceipt = JSON.parse(fs.readFileSync(startFile, "utf8")) as Record<string, unknown>;
  const runRecord = JSON.parse(fs.readFileSync(runFile, "utf8")) as Record<string, unknown>;
  const processStopReceipt = stop.processStopReceipt;
  if (
    runRecord.run_id !== stop.runId ||
    runRecord.task_id !== dispatch.taskId ||
    runRecord.task_run_id !== dispatch.runId ||
    runRecord.start_request_id !== stop.startRequestId ||
    runRecord.session_id !== stop.sessionId ||
    runRecord.process_id !== stop.processId ||
    runRecord.settle_receipt_id !== processStopReceipt.settleReceiptId
  ) {
    return { stopReceiptRef: "", stopReceiptTaskRef: "", proofFingerprint: "", released: false, reasonCode: "pi-receipt-identity-mismatch" };
  }
  const kernelRead = readTaskKernel({ root: dispatch.root, taskDir: dispatch.taskDir, cwd: dispatch.root });
  if (kernelRead.kind !== "task-kernel-v2") {
    return { stopReceiptRef: "", stopReceiptTaskRef: "", proofFingerprint: "", released: false, reasonCode: "task-kernel-v2-required" };
  }
  const kernelRun = kernelRead.kernel.runs.find((run) => run.id === dispatch.runId);
  if (!kernelRun?.host || kernelRun.state !== "running" && kernelRun.state !== "waiting") {
    return { stopReceiptRef: "", stopReceiptTaskRef: "", proofFingerprint: "", released: false, reasonCode: "pi-run-host-binding-missing" };
  }
  try {
    appendTaskRunHostSettlementRefs({
      root: dispatch.root,
      taskDir: dispatch.taskDir,
      expectedRevision: kernelRead.kernel.revision,
      runId: dispatch.runId,
      eventRefs: [processStopReceipt.settleReceiptId],
      resultRefs: [stop.runReceiptRef],
      actor: "pactile-pi-bridge",
      idempotencyKey: `pi-host-settled:${dispatch.runId}:${processStopReceipt.settleReceiptId}`,
      cwd: dispatch.root,
    });
  } catch (error) {
    return {
      stopReceiptRef: "",
      stopReceiptTaskRef: "",
      proofFingerprint: "",
      released: false,
      reasonCode: error instanceof Error ? error.message : "pi-host-settlement-recording-failed",
    };
  }
  const proofBase = {
    schema_version: 1,
    scope: "task-kernel-v2-run-dispatch-stop",
    lease_id: dispatch.leaseId,
    task_id: dispatch.taskId,
    run_id: dispatch.runId,
    schedule_receipt_fingerprint: dispatch.scheduleReceiptFingerprint,
    admission_receipt_fingerprint: dispatch.admissionReceiptFingerprint,
    source: "pi-host",
    disposition: "native-terminal",
    writer_exited: true,
    owner: {
      host: "pi",
      role: "implement",
      session_id: stop.sessionId,
      thread_id: null,
      host_id: null,
      start_request_id: stop.startRequestId,
      process_id: stop.processId,
    },
    request_ref: taskRelativeRef(dispatch.root, dispatch.taskDir, stop.startReceiptRef),
    request_fingerprint: fingerprintTaskValue(startReceipt),
    native_receipt_ref: taskRelativeRef(dispatch.root, dispatch.taskDir, stop.runReceiptRef),
    native_receipt_fingerprint: fingerprintTaskValue(processStopReceipt),
  };
  const stopReceiptRef = storeProof(dispatch, proofBase);
  const proofFingerprint = fingerprintTaskValue(proofBase);
  const request = {
    leaseId: dispatch.leaseId,
    taskId: dispatch.taskId,
    runId: dispatch.runId,
    stopReceiptRef,
  };
  const validation = validateTaskKernelRunDispatchStopProofV1(dispatch.root, request);
  if (!validation.valid) {
    return { stopReceiptRef, stopReceiptTaskRef: path.relative(dispatch.taskDir, path.resolve(dispatch.root, stopReceiptRef)).replaceAll("\\", "/"), proofFingerprint, released: false, reasonCode: validation.reasonCode };
  }
  const result = releaseTaskKernelRunDispatchV1(dispatch.root, request);
  return {
    stopReceiptRef,
    stopReceiptTaskRef: path.relative(dispatch.taskDir, path.resolve(dispatch.root, stopReceiptRef)).replaceAll("\\", "/"),
    proofFingerprint,
    released: result.released,
    reasonCode: result.reasonCode,
  };
}

function readSafeTaskFile(taskDir: string, ref: string): { file: string; bytes: Buffer } | null {
  if (!ref || path.isAbsolute(ref) || ref.split(/[\\/]/u).includes("..")) return null;
  const file = path.resolve(taskDir, ref);
  const relative = path.relative(taskDir, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  try {
    const realTaskDir = fs.realpathSync(taskDir);
    let cursor = realTaskDir;
    for (const segment of relative.split(path.sep)) {
      cursor = path.join(cursor, segment);
      if (fs.lstatSync(cursor).isSymbolicLink()) return null;
    }
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) return null;
    const realFile = fs.realpathSync(file);
    const realRelative = path.relative(realTaskDir, realFile);
    if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) return null;
    return { file, bytes: fs.readFileSync(realFile) };
  } catch {
    return null;
  }
}

export function readPiHostStopReceipt(
  rootValue: string,
  taskReference: string,
  taskRunId: string,
): PiHostStopReceipt | null {
  try {
    const root = path.resolve(rootValue);
    const taskDir = resolveTaskDir(root, taskReference);
    const read = readTaskKernel({ root, taskDir, cwd: root });
    if (read.kind !== "task-kernel-v2") return null;
    const run = read.kernel.runs.find((item) => item.id === taskRunId);
    const host = run?.host;
    if (run?.host?.host !== "pi" || host?.role !== "implement" || host.assuranceSource !== "manager-owned-child-exit") return null;
    const runCandidates = host.resultRefs.filter((ref) => ref.startsWith("pi-bridge/runs/") && !ref.includes(".."));
    for (const runReceiptRef of runCandidates) {
      const safeRun = readSafeTaskFile(taskDir, runReceiptRef);
      if (!safeRun) continue;
      const runRecord = JSON.parse(safeRun.bytes.toString("utf8")) as Record<string, unknown>;
      const receipt = runRecord.process_stop_receipt as PiHostStopReceipt | undefined;
      const startReceiptRef = runRecord.host_start_receipt_ref;
      const progressRef = runRecord.progress_evidence_ref;
      if (!receipt || typeof startReceiptRef !== "string" || typeof progressRef !== "string") continue;
      const safeStart = readSafeTaskFile(taskDir, startReceiptRef);
      const safeProgress = readSafeTaskFile(taskDir, progressRef);
      if (!safeStart || !safeProgress) continue;
      const start = JSON.parse(safeStart.bytes.toString("utf8")) as Record<string, unknown>;
      const stop = receipt.processExit;
      if (
        receipt.schemaVersion !== 1 || receipt.source !== "pactile-pi-rpc" || receipt.assurance !== "manager-owned-child-exit" ||
        receipt.taskId !== read.kernel.identity.taskId || receipt.taskRunId !== run.id || receipt.role !== "implement" ||
        runRecord.run_id !== receipt.piRunId || runRecord.task_id !== receipt.taskId || runRecord.task_run_id !== receipt.taskRunId ||
        runRecord.role !== "implement" || runRecord.session_id !== receipt.sessionId || runRecord.process_id !== receipt.processId ||
        runRecord.start_request_id !== receipt.startRequestId || runRecord.settle_receipt_id !== receipt.settleReceiptId ||
        runRecord.task_host_id !== "pi" || runRecord.host_start_receipt_ref !== startReceiptRef || runRecord.progress_evidence_ref !== progressRef ||
        runRecord.outcome === "running" || host.sessionId !== receipt.sessionId || host.threadId !== null ||
        host.requestRefs.length !== 1 || !host.requestRefs.includes(receipt.startRequestId) || !host.eventRefs.includes(receipt.settleReceiptId) ||
        !host.eventRefs.includes(progressRef) || !host.resultRefs.includes(runReceiptRef) || receipt.evidenceRef !== runReceiptRef ||
        receipt.progressEvidenceRef !== progressRef || receipt.terminal !== "exited" && receipt.terminal !== "cancelled" ||
        stop?.terminationVerified !== true || stop.processId !== receipt.processId || !stop.exitObservedAt ||
        !Number.isFinite(Date.parse(stop.exitObservedAt)) || !Number.isFinite(Date.parse(receipt.recordedAt)) ||
        Date.parse(receipt.recordedAt) < Date.parse(stop.exitObservedAt) ||
        start.schemaVersion !== 1 || start.source !== "pactile-pi-rpc" || start.taskId !== receipt.taskId || start.taskRunId !== receipt.taskRunId ||
        start.piRunId !== receipt.piRunId || start.role !== "implement" || start.sessionId !== receipt.sessionId || start.processId !== receipt.processId ||
        start.startRequestId !== receipt.startRequestId || start.evidenceRef !== runReceiptRef || start.progressEvidenceRef !== progressRef ||
        receipt.processExit.exitCode !== receipt.exitCode || receipt.processExit.signalCode !== receipt.signalCode ||
        !Number.isSafeInteger(receipt.processId) || receipt.processId <= 0
      ) continue;
      const proofRef = runRecord.dispatch_stop_proof_ref;
      if (typeof proofRef !== "string") continue;
      const safeProof = readSafeTaskFile(taskDir, proofRef);
      if (!safeProof) continue;
      const proofFile = safeProof.file;
      const proof = JSON.parse(safeProof.bytes.toString("utf8")) as Record<string, unknown>;
      const { proof_fingerprint: storedProofFingerprint, ...proofBase } = proof;
      const proofOwner = proof.owner as Record<string, unknown> | undefined;
      if (
        typeof storedProofFingerprint !== "string" ||
        fingerprintTaskValue(proofBase) !== storedProofFingerprint ||
        path.basename(proofFile) !== `${storedProofFingerprint}.json` ||
        proof.source !== "pi-host" || proof.disposition !== "native-terminal" || proof.writer_exited !== true ||
        proof.task_id !== receipt.taskId || proof.run_id !== receipt.taskRunId ||
        proof.owner === null || typeof proofOwner !== "object" ||
        proofOwner.host !== "pi" || proofOwner.role !== "implement" || proofOwner.session_id !== receipt.sessionId ||
        proofOwner.start_request_id !== receipt.startRequestId || proofOwner.process_id !== receipt.processId ||
        proof.lease_id !== runRecord.dispatch_lease_id ||
        proof.schedule_receipt_fingerprint !== runRecord.schedule_receipt_fingerprint ||
        proof.admission_receipt_fingerprint !== runRecord.admission_receipt_fingerprint ||
        proof.request_ref !== path.relative(root, path.resolve(taskDir, startReceiptRef)).replaceAll("\\", "/") ||
        proof.native_receipt_ref !== path.relative(root, safeRun.file).replaceAll("\\", "/") ||
        proof.request_fingerprint !== fingerprintTaskValue(start) ||
        proof.native_receipt_fingerprint !== fingerprintTaskValue(receipt)
      ) continue;
      if (receipt.resultRef !== null) {
        const safeResult = readSafeTaskFile(taskDir, receipt.resultRef);
        if (!safeResult || typeof receipt.resultSha256 !== "string" ||
          createHash("sha256").update(safeResult.bytes).digest("hex") !== receipt.resultSha256 ||
          runRecord.result_sha256 !== receipt.resultSha256) continue;
      } else if (receipt.resultSha256 !== null || runRecord.result_file !== null || runRecord.result_sha256 !== null) {
        continue;
      }
      return receipt;
    }
    return null;
  } catch {
    return null;
  }
}
