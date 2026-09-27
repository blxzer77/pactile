import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readTaskKernel, recordTaskReview } from "../core/task/index.js";
import {
  PiTaskBridge,
  preparePiReviewRoute,
  readPiCheckRunEvidenceV1,
  type PiReviewRouteContext,
  type PiRunRecord,
} from "../pactile/pi/bridge.js";
import type { PiRpcLaunch } from "../pactile/pi/rpc.js";
import {
  collectIndependentPiReviewEvidenceRefs,
  safeParseIndependentPiReview,
  type IndependentPiReviewContext,
} from "../pactile/review/contract.js";
import { resolvePiReviewEvidenceV1 } from "../pactile/review/evidence.js";
import {
  preparePiReviewEscalationV1,
  writePiReviewArtifact,
} from "../pactile/review/escalation.js";
import { createPiReviewRoutingAdviceV1 } from "../pactile/review/jev-escalation-advice.js";
import { resolveTaskDir } from "../pactile/task/session.js";

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

function required(value: string | undefined, label: string): string {
  if (!value || value.startsWith("--")) throw new Error(`${label} is required`);
  return value;
}

function evidenceDir(root: string, task: string): string {
  const dir = resolveTaskDir(root, task);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Task not found: ${task}`);
  return path.join(dir, "pi-bridge");
}

function readRecord(file: string): PiRunRecord | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as PiRunRecord; } catch { return null; }
}

function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

function safeReviewReason(value: string): string {
  return value
    .replace(
      /\b(?:sk[-_]|ghp_|gho_|glpat-|plane_api_)[A-Za-z0-9_-]{12,}\b/gu,
      "[redacted]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{12,}\b/giu, "Bearer [redacted]")
    .replace(
      /\b(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/giu,
      "$1=[redacted]",
    )
    .slice(0, 500);
}

function updateReviewRunRecord(
  taskDir: string,
  current: PiRunRecord,
  changes: Pick<
    PiRunRecord,
    | "review_status"
    | "review_rejection_reason"
    | "review_file"
    | "kernel_review_id"
    | "codex_escalation"
    | "codex_escalation_request_ref"
    | "codex_escalation_request_status"
    | "jev_review_advice_ref"
    | "jev_review_advice_status"
  >,
): PiRunRecord {
  const updated = { ...current, ...changes };
  const runFile = path.join(
    taskDir,
    "pi-bridge",
    "runs",
    `${current.run_id}.json`,
  );
  const persisted = readRecord(runFile);
  if (persisted?.run_id !== current.run_id) {
    throw new Error("Pi Check run receipt changed before Review persistence");
  }
  atomicJson(runFile, { ...persisted, ...changes });
  const latestFile = path.join(taskDir, "pi-bridge", "latest.json");
  const latest = readRecord(latestFile);
  if (latest?.run_id === current.run_id)
    atomicJson(latestFile, { ...latest, ...changes });
  return updated;
}

function sameReviewBinding(
  left: PiReviewRouteContext,
  right: PiReviewRouteContext,
): boolean {
  return JSON.stringify(left.binding) === JSON.stringify(right.binding);
}

function piReviewContext(
  prepared: PiReviewRouteContext,
  record: PiRunRecord,
  evidenceVerification: ReturnType<typeof resolvePiReviewEvidenceV1>,
): IndependentPiReviewContext {
  const candidate = prepared.run.candidateSnapshot;
  if (!candidate || !record.reviewer_id)
    throw new Error("Pi Check did not bind a candidate and reviewer identity");
  return {
    transportOutcome: record.outcome,
    reviewerId: record.reviewer_id,
    reviewerAuthority: "pi-check",
    latestCompletedRunId: prepared.run.id,
    kernelRevision: prepared.kernel.revision,
    piReceipt: {
      piRunId: record.run_id,
      role: "check",
      outcome: record.outcome,
      taskRunId: record.task_run_id ?? "",
      candidateSnapshotId: record.candidate_snapshot_id ?? "",
      candidateFingerprint: record.candidate_fingerprint ?? "",
      sessionId: record.session_id,
      reviewerId: record.reviewer_id,
      reviewerIdentityAssurance: record.reviewer_identity_assurance ?? null,
      kernelRevisionAtDispatch: record.kernel_revision_at_dispatch ?? -1,
      startupMs: Number.isSafeInteger(record.startup_ms)
        ? record.startup_ms
        : null,
      firstEventMs: Number.isSafeInteger(record.first_event_ms)
        ? record.first_event_ms
        : null,
      elapsedMs: Number.isSafeInteger(record.elapsed_ms)
        ? record.elapsed_ms
        : null,
      eventCount: record.event_count,
      toolErrors: record.tool_errors,
    },
    run: prepared.run,
    boundCandidate: {
      snapshotId: candidate.id,
      fingerprint: candidate.fingerprint,
    },
    acceptanceCriterionIds: prepared.kernel.definition.acceptanceCriteria.map(
      (criterion) => criterion.id,
    ),
    evidenceVerification,
  };
}

async function recordIndependentPiReview(
  root: string,
  taskReference: string,
  prepared: PiReviewRouteContext,
  record: PiRunRecord,
): Promise<{ record: PiRunRecord; exitCode: number }> {
  const taskDir = prepared.taskDir;
  let reviewArtifactRef: string | null = null;
  let escalationRequestRef: string | null = null;
  let escalation: PiRunRecord["codex_escalation"] = null;
  let escalationStatus: PiRunRecord["codex_escalation_request_status"] =
    "pending";
  let jevAdviceRef: string | null = null;
  let jevAdviceStatus: PiRunRecord["jev_review_advice_status"] = "skipped";
  let recordedReviewId: string | null = null;
  const reject = (reason: string, status = escalationStatus): PiRunRecord =>
    updateReviewRunRecord(taskDir, record, {
      review_status: "rejected",
      review_rejection_reason: safeReviewReason(reason),
      review_file: reviewArtifactRef,
      kernel_review_id: recordedReviewId,
      codex_escalation: escalation,
      codex_escalation_request_ref: escalationRequestRef,
      codex_escalation_request_status: status,
      jev_review_advice_ref: jevAdviceRef,
      jev_review_advice_status: jevAdviceStatus,
    });

  if (record.outcome !== "settled") {
    return {
      record: reject(
        record.reason ?? `Pi Check transport outcome is ${record.outcome}`,
      ),
      exitCode: 1,
    };
  }

  try {
    const current = preparePiReviewRoute(root, taskReference);
    if (!sameReviewBinding(prepared, current))
      throw new Error("Task Kernel or candidate changed during Pi Check");
    const runEvidence = readPiCheckRunEvidenceV1(taskDir, record);
    let payload: unknown;
    try {
      payload = JSON.parse(runEvidence.resultBytes.toString("utf8"));
    } catch {
      throw new Error(
        "Pi Check result is not one structured JSON Review object",
      );
    }
    const criteria = current.kernel.definition.acceptanceCriteria.map(
      (criterion) => criterion.id,
    );
    const references = collectIndependentPiReviewEvidenceRefs(
      payload,
      criteria,
    );
    if (!references.ok)
      throw new Error(
        `Pi Review evidence references are invalid: ${references.errors.join("; ")}`,
      );
    const evidenceVerification = resolvePiReviewEvidenceV1({
      root,
      taskDir,
      candidateRoot: current.workdir,
      run: current.run,
      references: references.references,
    });
    const context = piReviewContext(current, record, evidenceVerification);
    const parsed = safeParseIndependentPiReview(payload, context);
    if (!parsed.ok)
      throw new Error(
        `Pi Review contract rejected the result: ${parsed.errors.join("; ")}`,
      );
    const review = parsed.value;
    const reviewId = `pi-review-${record.run_id}`;
    const artifact = writePiReviewArtifact(taskDir, reviewId, {
      schemaVersion: 1,
      source: "pactile-independent-pi-review-v1",
      reviewId,
      taskId: current.kernel.identity.taskId,
      taskRunId: current.run.id,
      kernelRevision: current.kernel.revision,
      piRunId: record.run_id,
      startReceipt: runEvidence.start,
      stopReceipt: runEvidence.stop,
      resultRef: record.result_file,
      resultSha256: record.result_sha256,
      evidenceVerification,
      review,
    });
    reviewArtifactRef = artifact.ref;
    const kernelEvidenceRefs = [
      ...new Set([
        ...review.kernelReview.evidenceRefs,
        ...review.evidenceVerification.items.map((item) => item.ref),
        artifact.ref,
        ...runEvidence.evidenceRefs,
      ]),
    ];
    escalation = review.escalation;
    escalationStatus = "not-required";
    const routingAdvice = await createPiReviewRoutingAdviceV1({
      root,
      taskDir,
      binding: {
        taskId: current.kernel.identity.taskId,
        reviewId,
        piRunId: record.run_id,
        runId: current.run.id,
        candidateSnapshotId: current.run.candidateSnapshot?.id ?? "",
        candidateFingerprint:
          current.run.candidateSnapshot?.fingerprint ?? "",
        reviewArtifactRef: artifact.ref,
        reviewArtifactSha256: artifact.sha256,
        reviewContentFingerprint: artifact.contentFingerprint,
      },
      ...(review.escalation.required
        ? { skipReason: "hard-rule-required" as const }
        : review.verdict === "pass"
          ? { skipReason: "passing-review" as const }
          : {}),
      isStillCurrent: () =>
        sameReviewBinding(current, preparePiReviewRoute(root, taskReference)),
    });
    jevAdviceRef = routingAdvice.ref;
    jevAdviceStatus = routingAdvice.receipt.recommendationDisposition;
    if (review.escalation.required) {
      const preparedEscalation = preparePiReviewEscalationV1({
        taskDir,
        reviewId,
        taskId: current.kernel.identity.taskId,
        review,
        reviewArtifactRef: artifact.ref,
        reviewArtifactSha256: artifact.sha256,
        reviewContentFingerprint: artifact.contentFingerprint,
      });
      escalationRequestRef = preparedEscalation.ref;
      escalationStatus = "prepared";
    } else if (routingAdvice.prepareOptionalEscalation) {
      const preparedEscalation = preparePiReviewEscalationV1({
        taskDir,
        reviewId,
        taskId: current.kernel.identity.taskId,
        review,
        reviewArtifactRef: artifact.ref,
        reviewArtifactSha256: artifact.sha256,
        reviewContentFingerprint: artifact.contentFingerprint,
        basis: "jev-recommended",
        jevAdviceRef: routingAdvice.ref,
        jevAdviceSha256: routingAdvice.sha256,
      });
      escalationRequestRef = preparedEscalation.ref;
      escalationStatus = "prepared";
    }
    const latest = preparePiReviewRoute(root, taskReference);
    if (!sameReviewBinding(current, latest))
      throw new Error(
        "Task Kernel or candidate changed before atomic Review recording",
      );
    const mutation = recordTaskReview({
      root,
      taskDir,
      expectedRevision: latest.kernel.revision,
      reviewId,
      runId: review.kernelReview.runId,
      candidateSnapshotId: review.kernelReview.candidateSnapshotId,
      candidateFingerprint: review.kernelReview.candidateFingerprint,
      reviewer: review.kernelReview.reviewer,
      decision: review.kernelReview.decision,
      evidenceRefs: kernelEvidenceRefs,
      acceptanceEvidence: review.kernelReview.acceptanceEvidence,
      unresolvedBlockers: review.kernelReview.unresolvedBlockers,
      measurementRef: artifact.ref,
      actor: review.kernelReview.actor,
      idempotencyKey: `pi-review-record:${record.run_id}`,
      cwd: root,
    });
    const kernelReview = mutation.kernel.reviews.find(
      (item) => item.id === reviewId,
    );
    if (!kernelReview)
      throw new Error(
        "Core did not return the atomically recorded Kernel Review",
      );
    recordedReviewId = kernelReview.id;
    const readback = readTaskKernel({ root, taskDir, cwd: root });
    if (
      readback.kind !== "task-kernel-v2" ||
      !readback.kernel.reviews.some((item) => item.id === reviewId)
    ) {
      throw new Error(
        "Kernel Review was not readable after atomic persistence",
      );
    }
    const updated = updateReviewRunRecord(taskDir, record, {
      review_status: "recorded",
      review_rejection_reason: null,
      review_file: reviewArtifactRef,
      kernel_review_id: kernelReview.id,
      codex_escalation: escalation,
      codex_escalation_request_ref: escalationRequestRef,
      codex_escalation_request_status: escalationStatus,
      jev_review_advice_ref: jevAdviceRef,
      jev_review_advice_status: jevAdviceStatus,
    });
    return {
      record: updated,
      exitCode:
        review.verdict === "pass" && !review.escalation.required ? 0 : 1,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (recordedReviewId) {
      return {
        record: updateReviewRunRecord(taskDir, record, {
          review_status: "recorded",
          review_rejection_reason: null,
          review_file: reviewArtifactRef,
          kernel_review_id: recordedReviewId,
          codex_escalation: escalation,
          codex_escalation_request_ref: escalationRequestRef,
          codex_escalation_request_status: escalationStatus,
          jev_review_advice_ref: jevAdviceRef,
          jev_review_advice_status: jevAdviceStatus,
        }),
        exitCode: 1,
      };
    }
    return {
      record: reject(
        message,
        message.includes("escalation")
          ? "preparation-failed"
          : escalationStatus,
      ),
      exitCode: 1,
    };
  }
}

/** Native Pi RPC with an independent Verify-phase Check route. */
export async function runPiCli(
  argv: string[],
  root = process.cwd(),
  launch?: PiRpcLaunch,
): Promise<number> {
  const [operation, reference, ...args] = argv;
  try {
    if (operation === "status") {
      const record = readRecord(
        path.join(
          evidenceDir(root, required(reference, "task")),
          "latest.json",
        ),
      );
      if (!record) throw new Error("No Pi run has been recorded for this task");
      console.log(JSON.stringify(record, null, 2));
      return 0;
    }
    if (operation === "cancel") {
      const evidence = evidenceDir(root, required(reference, "task"));
      const record = readRecord(path.join(evidence, "latest.json"));
      if (record?.outcome !== "running")
        throw new Error("No active Pi run to cancel");
      fs.writeFileSync(
        path.join(evidence, "cancel-request.json"),
        `${JSON.stringify({ request_id: randomUUID(), run_id: record.run_id, requested_at: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
      console.log(`Cancellation requested for Pi run ${record.run_id}`);
      return 0;
    }
    if (operation !== "run")
      throw new Error("Usage: pactile pi <run|status|cancel> <task> ...");
    const task = required(reference, "task");
    const role = required(option(args, "--role"), "--role");
    if (role !== "implement" && role !== "check" && role !== "research")
      throw new Error("--role must be implement, check, or research");
    const runId = args.includes("--run-id")
      ? required(option(args, "--run-id"), "--run-id")
      : undefined;
    const promptFiles = args.flatMap((arg, index) =>
      arg === "--prompt-file"
        ? [path.resolve(root, required(args[index + 1], "--prompt-file"))]
        : [],
    );
    if (!promptFiles.length) throw new Error("--prompt-file is required");
    for (const file of promptFiles)
      if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile())
        throw new Error(`Prompt file not found: ${file}`);
    const timeoutMs = option(args, "--timeout-ms")
      ? Number(option(args, "--timeout-ms"))
      : 30 * 60_000;
    if (
      runId &&
      (promptFiles.length !== 1 ||
        args.includes("--resume") ||
        role !== "implement")
    ) {
      throw new Error(
        "Pi V2 dispatch requires one prompt file, --role implement, and no --resume",
      );
    }
    if (
      role === "check" &&
      (promptFiles.length !== 1 || args.includes("--resume") || runId)
    ) {
      throw new Error(
        "Independent Pi Review requires one prompt file, --role check, and no --resume or --run-id",
      );
    }
    const reviewRoute =
      role === "check" ? preparePiReviewRoute(root, task) : null;
    const controller = new AbortController();
    const onSignal = (): void => controller.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    const bridge = new PiTaskBridge(root, launch);
    try {
      for (const [index, file] of promptFiles.entries()) {
        const result = await bridge.run({
          root,
          task,
          role,
          prompt: fs.readFileSync(file, "utf8"),
          timeoutMs,
          runId,
          resume: index === 0 && args.includes("--resume"),
          signal: controller.signal,
          ...(reviewRoute ? { reviewBinding: reviewRoute.binding } : {}),
          onProgress: (event) => {
            if (
              [
                "agent_start",
                "agent_end",
                "agent_settled",
                "tool_execution_start",
                "tool_execution_end",
              ].includes(String(event.type))
            ) {
              console.error(
                `[pi] ${event.type}${event.tool ? ` ${event.tool}` : ""}${event.is_error ? " ERROR" : ""}`,
              );
            }
          },
        });
        if (role === "check" && reviewRoute) {
          const finalized = await recordIndependentPiReview(
            root,
            task,
            reviewRoute,
            result,
          );
          console.log(JSON.stringify(finalized.record, null, 2));
          return finalized.exitCode;
        }
        console.log(JSON.stringify(result, null, 2));
        if (result.outcome !== "settled") return 1;
      }
      return 0;
    } finally {
      await bridge.close();
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  } catch (error) {
    console.error(
      `Pi bridge: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
