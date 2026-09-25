import { KernelError, requireNonEmptyString } from "./kernel-contract.js";
import { appendDomainEvent, mutateTaskKernel } from "./task-kernel-store-v2.js";
import { fingerprintTaskValue, parseHostBinding, parseHostStopReceipt } from "./task-kernel-schema.js";
import type {
  AppendTaskRunHostSettlementRefsRequest,
  BindTaskRunHostReceiptRequest,
  RecordTaskRunHostStopReceiptRequest,
  TaskKernelMutationResult,
  TaskKernelSnapshotV2,
  TaskRunV2,
} from "./task-kernel-types.js";

function runAt(current: TaskKernelSnapshotV2, runId: string): { run: TaskRunV2; index: number } {
  const index = current.runs.findIndex((item) => item.id === runId);
  if (index < 0) throw new KernelError("NOT_FOUND", `Run not found: ${runId}`);
  const run = current.runs[index];
  if (!run) throw new KernelError("CORRUPT_STATE", `Run is missing: ${runId}`);
  return { run, index };
}

function replaceRun(current: TaskKernelSnapshotV2, index: number, run: TaskRunV2): TaskKernelSnapshotV2 {
  return { ...current, runs: current.runs.map((item, i) => i === index ? run : item) };
}

export function bindTaskRunHostReceipt(request: BindTaskRunHostReceiptRequest): TaskKernelMutationResult {
  const actor = requireNonEmptyString(request.actor, "actor");
  const runId = requireNonEmptyString(request.runId, "runId");
  const requestedHost = parseHostBinding({
    ...request.host,
    kernelRevision: request.expectedRevision + 1,
    contractFingerprint: "0".repeat(64),
    stopReceipt: null,
  }, "host");
  const fingerprint = fingerprintTaskValue({ runId, host: requestedHost });
  return mutateTaskKernel(request.root, request.taskDir, request.expectedRevision, actor, request.idempotencyKey, fingerprint, request.cwd, (current) => {
    const { run, index } = runAt(current, runId);
    if (current.runs.at(-1)?.id !== runId || (run.state !== "running" && run.state !== "waiting")) {
      throw new KernelError("INVALID_TRANSITION", "Host receipt can only bind to the latest active or waiting Run");
    }
    if (run.host) throw new KernelError("INVALID_TRANSITION", "Run host binding is immutable after its first receipt");
    const host = parseHostBinding({
      ...requestedHost,
      kernelRevision: current.revision + 1,
      contractFingerprint: fingerprintTaskValue(current.definition),
      stopReceipt: null,
    }, "host");
    const next = replaceRun(current, index, { ...run, host });
    return appendDomainEvent(next, actor, request.idempotencyKey, "run.host-bound", runId, fingerprint);
  });
}

export function appendTaskRunHostSettlementRefs(request: AppendTaskRunHostSettlementRefsRequest): TaskKernelMutationResult {
  const actor = requireNonEmptyString(request.actor, "actor");
  const runId = requireNonEmptyString(request.runId, "runId");
  const additions = {
    requestRefs: request.requestRefs ?? [],
    eventRefs: request.eventRefs ?? [],
    resultRefs: request.resultRefs ?? [],
  };
  const fingerprint = fingerprintTaskValue({ runId, additions });
  return mutateTaskKernel(request.root, request.taskDir, request.expectedRevision, actor, request.idempotencyKey, fingerprint, request.cwd, (current) => {
    const { run, index } = runAt(current, runId);
    if (!run.host) throw new KernelError("INVALID_TRANSITION", "Run has no manager-bound host receipt");
    if (run.host.stopReceipt) throw new KernelError("INVALID_TRANSITION", "Run host already has a terminal receipt");
    const appendOnly = (existing: string[], added: string[], field: string): string[] => {
      if (!Array.isArray(added) || added.some((item) => typeof item !== "string" || !item.trim())) {
        throw new KernelError("INVALID_REQUEST", `${field} must contain non-empty references`);
      }
      return [...new Set([...existing, ...added])];
    };
    const host = {
      ...run.host,
      requestRefs: appendOnly(run.host.requestRefs, additions.requestRefs, "requestRefs"),
      eventRefs: appendOnly(run.host.eventRefs, additions.eventRefs, "eventRefs"),
      resultRefs: appendOnly(run.host.resultRefs, additions.resultRefs, "resultRefs"),
    };
    if (host.requestRefs.length === run.host.requestRefs.length
      && host.eventRefs.length === run.host.eventRefs.length
      && host.resultRefs.length === run.host.resultRefs.length) {
      throw new KernelError("INVALID_REQUEST", "Host settlement must append at least one new reference");
    }
    const next = replaceRun(current, index, { ...run, host });
    return appendDomainEvent(next, actor, request.idempotencyKey, "run.host-settlement-recorded", runId, fingerprint);
  });
}

export function recordTaskRunHostStopReceipt(request: RecordTaskRunHostStopReceiptRequest): TaskKernelMutationResult {
  const actor = requireNonEmptyString(request.actor, "actor");
  const runId = requireNonEmptyString(request.runId, "runId");
  const receipt = parseHostStopReceipt(request.receipt, "hostStopReceipt");
  const fingerprint = fingerprintTaskValue({ runId, receipt });
  return mutateTaskKernel(request.root, request.taskDir, request.expectedRevision, actor, request.idempotencyKey, fingerprint, request.cwd, (current) => {
    const { run, index } = runAt(current, runId);
    const host = run.host;
    if (!host) throw new KernelError("INVALID_TRANSITION", "Run has no manager-bound host receipt");
    if (run.state === "running" || run.state === "waiting") throw new KernelError("INVALID_TRANSITION", "Run host stop receipt requires a terminal Run");
    if (receipt.taskId !== current.identity.taskId || receipt.runId !== run.id
      || receipt.sessionId !== host.sessionId || receipt.threadId !== host.threadId
      || receipt.contractFingerprint !== host.contractFingerprint
      || receipt.contractFingerprint !== fingerprintTaskValue(current.definition)
      || receipt.contractStale || receipt.receiptKernelRevision > current.revision) {
      throw new KernelError("INVALID_REQUEST", "Host stop receipt does not match this Task, Run, binding, or current contract");
    }
    if (!host.requestRefs.includes(receipt.startRequestId)
      || !host.eventRefs.includes(receipt.settleReceiptId)
      || (!host.resultRefs.includes(receipt.evidenceRef) && !host.resultRefs.includes(receipt.receiptRef))) {
      throw new KernelError("INVALID_REQUEST", "Host stop receipt references were not durably bound to the Run");
    }
    const codex = host.host === "codex-desktop" && receipt.source === "codex-desktop-bridge"
      && receipt.assurance === "host-reported" && receipt.evidenceLevel === "desktop-native"
      && receipt.terminalStatus === "completed";
    const pi = host.host === "pi" && receipt.source === "pactile-pi-rpc"
      && receipt.assurance === "manager-owned-child-exit"
      && (receipt.terminalStatus === "exited" || receipt.terminalStatus === "cancelled");
    if (!codex && !pi) throw new KernelError("INVALID_REQUEST", "Host stop receipt source or terminal state is not supported for this Run binding");
    const candidate = run.candidateSnapshot;
    if (candidate) {
      if (receipt.candidateSnapshotId !== candidate.id || receipt.candidateFingerprint !== candidate.fingerprint) {
        throw new KernelError("INVALID_REQUEST", "Host stop receipt candidate does not match the current Run candidate");
      }
      if (receipt.candidateSource !== "captured" && receipt.candidateSource !== "derived") {
        throw new KernelError("INVALID_REQUEST", "A Run candidate requires captured or derived stop-receipt provenance");
      }
    } else if (receipt.candidateSnapshotId !== null || receipt.candidateFingerprint !== null) {
      throw new KernelError("INVALID_REQUEST", "Host stop receipt cannot cite a candidate absent from the Run");
    } else if (receipt.candidateSource !== null) {
      throw new KernelError("INVALID_REQUEST", "A stop receipt without a Run candidate cannot claim candidate provenance");
    }
    if (host.stopReceipt) throw new KernelError("INVALID_TRANSITION", "Run host stop receipt is immutable once recorded");
    const nextHost = { ...host, stopReceipt: receipt };
    const next = replaceRun(current, index, { ...run, host: nextHost });
    return appendDomainEvent(next, actor, request.idempotencyKey, "run.host-settled", runId, fingerprint);
  });
}
