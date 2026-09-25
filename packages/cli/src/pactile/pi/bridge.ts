import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readStrategyContract } from "../task/strategy.js";
import { approvedExecuteTask } from "../task/authorization.js";
import {
  parallelChild,
  reserveParallelChild,
  updateParallelChildPid,
} from "../parallel/policy.js";
import { sameGitRoot } from "../../utils/git-root.js";
import { PiRpcClient, type PiRpcLaunch, type PiRpcProcessExitReceipt } from "./rpc.js";
import {
  bindPiV2RunHost,
  persistPiV2StopAndRelease,
  preparePiV2RunDispatch,
  type PiHostStopReceipt,
  type PiProcessExitEvidence,
  type PiV2RunDispatch,
} from "./v2-dispatch.js";
export { readPiHostStopReceipt } from "./v2-dispatch.js";

export type PiRunOutcome =
  | "settled"
  | "needs_review"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export interface PiRunRecord {
  schema_version: 1 | 2;
  run_id: string;
  task: string;
  role: "implement" | "check" | "research";
  outcome: PiRunOutcome | "running";
  started_at: string;
  ended_at: string | null;
  prompt_sha256: string;
  session_id: string | null;
  session_file: string | null;
  process_mode: "cold" | "warm";
  startup_ms: number;
  first_event_ms: number | null;
  elapsed_ms: number | null;
  event_count: number;
  tool_errors: number;
  reason: string | null;
  result_file: string | null;
  task_id?: string | null;
  task_run_id?: string | null;
  task_host_id?: "pi" | null;
  start_request_id?: string;
  process_id?: number | null;
  host_start_receipt_ref?: string | null;
  progress_evidence_ref?: string | null;
  settle_receipt_id?: string | null;
  process_stop_receipt?: PiHostStopReceipt | null;
  process_stop_error?: string | null;
  process_exit_receipt?: PiProcessExitEvidence | null;
  result_sha256?: string | null;
  result_redacted?: boolean;
  dispatch_lease_id?: string | null;
  schedule_receipt_fingerprint?: string | null;
  admission_receipt_fingerprint?: string | null;
  dispatch_stop_proof_ref?: string | null;
  dispatch_lease_released?: boolean;
  dispatch_lease_release_reason?: string | null;
}

export interface PiRunInput {
  root: string;
  task: string;
  role: PiRunRecord["role"];
  prompt: string;
  timeoutMs: number;
  runId?: string;
  scheduleReceiptFingerprint?: string;
  resume?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: Record<string, unknown>) => void;
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

function parseJson(file: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function alive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function redact(text: string): string {
  return text
    .replace(
      /\b(?:sk[-_]|ghp_|gho_|glpat-|plane_api_)[A-Za-z0-9_-]{12,}\b/g,
      "[redacted]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{12,}\b/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    );
}

function assistantText(event: Record<string, unknown>): {
  text: string;
  redacted: boolean;
  stopReason: string | null;
  errorMessage: string | null;
} {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  const assistant = [...messages]
    .reverse()
    .find(
      (message) =>
        message &&
        typeof message === "object" &&
        (message as Record<string, unknown>).role === "assistant",
    ) as Record<string, unknown> | undefined;
  if (!assistant) return { text: "", redacted: false, stopReason: null, errorMessage: null };
  const content = Array.isArray(assistant.content) ? assistant.content : [];
  const text = content
    .filter(
      (part) =>
        part &&
        typeof part === "object" &&
        (part as Record<string, unknown>).type === "text",
    )
    .map((part) => String((part as Record<string, unknown>).text ?? ""))
    .join("\n");
  return {
    text: redact(text),
    redacted: redact(text) !== text,
    stopReason:
      typeof assistant.stopReason === "string" ? assistant.stopReason : null,
    errorMessage:
      typeof assistant.errorMessage === "string"
        ? redact(assistant.errorMessage).slice(0, 500)
        : null,
  };
}

function evidenceEvent(
  event: Record<string, unknown>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {
    at: new Date().toISOString(),
    type: String(event.type ?? "unknown"),
  };
  if (typeof event.toolName === "string") safe.tool = event.toolName;
  if (event.type === "tool_execution_end")
    safe.is_error = event.isError === true;
  if (
    event.type === "message_end" &&
    event.message &&
    typeof event.message === "object"
  ) {
    const message = event.message as Record<string, unknown>;
    safe.role = typeof message.role === "string" ? message.role : "unknown";
    if (typeof message.stopReason === "string")
      safe.stop_reason = message.stopReason;
  }
  return safe;
}

export function approvedTask(
  root: string,
  reference: string,
  role: PiRunInput["role"],
): string {
  const dir = approvedExecuteTask(root, reference);
  const implementation = path.join(dir, "implement.md");
  if (role === "implement" && !fs.existsSync(implementation))
    throw new Error("Pi implement dispatch requires implement.md");
  if (fs.existsSync(implementation)) {
    const parsed = readStrategyContract(dir);
    if (parsed.errors.length)
      throw new Error(
        `Invalid execution contract: ${parsed.errors.join("; ")}`,
      );
    if (role === "implement" && parsed.contract?.execution_mode !== "worker") {
      throw new Error("Pi implement dispatch requires execution_mode: worker");
    }
  }
  if (role === "check" && !fs.existsSync(path.join(dir, "verify.md")))
    throw new Error("Pi check requires verify.md");
  return dir;
}

/** Resolve the approved execution location; never claim worktree isolation in the project root. */
export function piWorkdir(
  root: string,
  dir: string,
  role: PiRunInput["role"],
): string {
  if (role !== "implement" && !fs.existsSync(path.join(dir, "implement.md")))
    return root;
  const parsed = readStrategyContract(dir);
  if (parsed.errors.length || !parsed.contract)
    throw new Error(`Invalid execution contract: ${parsed.errors.join("; ")}`);
  if (parsed.contract.isolation === "main-worktree") return root;
  const task: unknown = JSON.parse(
    fs.readFileSync(path.join(dir, "task.json"), "utf8"),
  );
  const worktreePath =
    task && typeof task === "object" && "worktree_path" in task
      ? (task as { worktree_path?: unknown }).worktree_path
      : null;
  if (typeof worktreePath !== "string")
    throw new Error(
      "git-worktree isolation requires a prepared Child worktree",
    );
  const worktrees = path.resolve(root, ".pactile", "worktrees");
  const candidate = path.resolve(root, worktreePath);
  const relative = path.relative(worktrees, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Child worktree must stay under .pactile/worktrees");
  if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory())
    throw new Error("Child worktree directory is missing");
  const realRoot = fs.realpathSync(worktrees);
  const realCandidate = fs.realpathSync(candidate);
  const realRelative = path.relative(realRoot, realCandidate);
  if (
    !realRelative ||
    realRelative.startsWith("..") ||
    path.isAbsolute(realRelative)
  )
    throw new Error("Child worktree resolves outside .pactile/worktrees");
  let gitRoot: string;
  try {
    gitRoot = execFileSync(
      "git",
      [
        "-c",
        `safe.directory=${realCandidate.replaceAll("\\", "/")}`,
        "-C",
        realCandidate,
        "rev-parse",
        "--show-toplevel",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    throw new Error("Child worktree is not a usable Git checkout");
  }
  if (!sameGitRoot(gitRoot, realCandidate))
    throw new Error("Child worktree Git root does not match its recorded path");
  return realCandidate;
}

/** A reusable, one-task bridge. One Pi process can serve multiple sequential runs. */
export class PiTaskBridge {
  private client: PiRpcClient | null = null;
  private taskDir: string | null = null;
  private workdir: string | null = null;
  private role: PiRunInput["role"] | null = null;
  private locked = false;

  constructor(
    private readonly root: string,
    private readonly launch?: PiRpcLaunch,
  ) {}

  private async ensureClient(
    dir: string,
    workdir: string,
    role: PiRunInput["role"],
    resumeFile: string | null,
  ): Promise<{
    client: PiRpcClient;
    startupMs: number;
    mode: "cold" | "warm";
  }> {
    if (this.client && this.taskDir !== dir)
      throw new Error("Pi bridge is bound to one Pactile task");
    if (this.client && this.workdir !== workdir)
      throw new Error("Pi bridge cannot reuse a process in another worktree");
    if (this.client && this.role !== role)
      throw new Error("Pi bridge cannot reuse a process across worker roles");
    if (this.client?.isStarted)
      return { client: this.client, startupMs: 0, mode: "warm" };
    const client = new PiRpcClient({
      cwd: workdir,
      sessionDir: path.join(dir, "pi-bridge", "sessions"),
      launch: this.launch,
      readOnly: role !== "implement",
    });
    this.client = client;
    this.taskDir = dir;
    this.workdir = workdir;
    this.role = role;
    const startupMs = await client.start();
    if (resumeFile) await client.switchSession(resumeFile);
    return { client, startupMs, mode: "cold" };
  }

  private async closeForDispatch(): Promise<PiRpcProcessExitReceipt | null> {
    const client = this.client;
    if (!client) return null;
    const receipt = await client.closeAndObserve();
    if (receipt?.terminationVerified) {
      this.client = null;
      this.taskDir = null;
      this.workdir = null;
      this.role = null;
    }
    return receipt;
  }

  async run(input: PiRunInput): Promise<PiRunRecord> {
    if (path.resolve(input.root) !== path.resolve(this.root))
      throw new Error("Pi bridge root mismatch");
    if (!input.prompt.trim()) throw new Error("Pi prompt is empty");
    if (
      !Number.isInteger(input.timeoutMs) ||
      input.timeoutMs < 1_000 ||
      input.timeoutMs > 86_400_000
    )
      throw new Error("Pi timeout must be 1 second to 24 hours");
    if (this.locked) throw new Error("Pi bridge already has an active run");
    if (input.runId !== undefined) {
      if (input.role !== "implement")
        throw new Error("Pi V2 dispatch currently supports only the implement role");
      if (input.resume)
        throw new Error("Pi V2 dispatch cannot resume a prior session");
      if (this.client)
        throw new Error("Pi V2 dispatch requires a fresh Pi bridge process");
      if (!input.runId.trim()) throw new Error("Pi V2 --run-id must be non-empty");
      const dispatch = preparePiV2RunDispatch(
        this.root,
        input.task,
        input.runId,
      );
      return this.runApproved(
        input,
        dispatch.taskDir,
        dispatch.workdir,
        null,
        null,
        dispatch,
      );
    }
    const dir = approvedTask(this.root, input.task, input.role);
    const workdir = piWorkdir(this.root, dir, input.role);
    const scope = parallelChild(this.root, dir);
    const leaseId = randomUUID();
    const release = reserveParallelChild(this.root, dir, {
      id: leaseId,
      scheduleReceiptFingerprint: input.scheduleReceiptFingerprint,
    });
    try {
      return await this.runApproved(
        input,
        dir,
        workdir,
        scope?.touches ?? null,
        leaseId,
        null,
      );
    } finally {
      release();
    }
  }

  private async runApproved(
    input: PiRunInput,
    dir: string,
    workdir: string,
    touches: string[] | null,
    parallelLeaseId: string | null,
    dispatch: PiV2RunDispatch | null,
  ): Promise<PiRunRecord> {
    const evidence = path.join(dir, "pi-bridge");
    const lockFile = path.join(evidence, "active.json");
    const latestFile = path.join(evidence, "latest.json");
    const cancelFile = path.join(evidence, "cancel-request.json");
    fs.mkdirSync(evidence, { recursive: true });
    if (fs.existsSync(lockFile)) {
      const prior = parseJson(lockFile);
      if (alive(prior?.parent_pid) || alive(prior?.child_pid))
        throw new Error(
          "Pi dispatch already active; stop the existing bridge before retrying",
        );
      const stale = parseJson(latestFile);
      if (stale?.outcome === "running") {
        const recovered = {
          ...stale,
          outcome: "interrupted",
          ended_at: new Date().toISOString(),
          reason: "bridge process exited before recording a terminal event",
        };
        atomicJson(
          path.join(evidence, "runs", `${stale.run_id}.json`),
          recovered,
        );
        atomicJson(latestFile, recovered);
      }
      fs.rmSync(lockFile);
    }
    const orphan = parseJson(latestFile);
    if (orphan?.outcome === "running") {
      const stale = orphan;
      const recovered = {
        ...stale,
        outcome: "interrupted",
        ended_at: new Date().toISOString(),
        reason: "bridge process exited before recording a terminal event",
      };
      atomicJson(
        path.join(evidence, "runs", `${stale.run_id}.json`),
        recovered,
      );
      atomicJson(latestFile, recovered);
    }
    const previous = parseJson(latestFile);
    const sessionRoot = path.resolve(evidence, "sessions");
    const previousSession =
      typeof previous?.session_file === "string"
        ? path.resolve(previous.session_file)
        : null;
    const previousSessionReal =
      previousSession &&
      fs.statSync(previousSession, { throwIfNoEntry: false })?.isFile()
        ? fs.realpathSync(previousSession)
        : null;
    const sessionRootReal = fs.existsSync(sessionRoot)
      ? fs.realpathSync(sessionRoot)
      : null;
    const relativeSession =
      previousSessionReal && sessionRootReal
        ? path.relative(sessionRootReal, previousSessionReal)
        : null;
    const insideSessions =
      relativeSession &&
      relativeSession !== ".." &&
      !relativeSession.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeSession);
    if (
      input.resume &&
      !(
        previous?.role === input.role &&
        insideSessions &&
        previousSession &&
        fs.statSync(previousSession, { throwIfNoEntry: false })?.isFile()
      )
    ) {
      throw new Error("No previous Pi session is available to resume");
    }
    const runId = randomUUID();
    const startRequestId = dispatch ? randomUUID() : null;
    const now = new Date();
    const runFile = path.join(evidence, "runs", `${runId}.json`);
    const eventFile = path.join(evidence, "events", `${runId}.jsonl`);
    const runReceiptRef = path.relative(dir, runFile).replaceAll("\\", "/");
    const progressEvidenceRef = path.relative(dir, eventFile).replaceAll("\\", "/");
    const startReceiptRef = `pi-bridge/starts/${runId}.json`;
    const record: PiRunRecord = {
      schema_version: dispatch ? 2 : 1,
      run_id: runId,
      task: path.relative(this.root, dir).replaceAll("\\", "/"),
      role: input.role,
      outcome: "running",
      started_at: now.toISOString(),
      ended_at: null,
      prompt_sha256: createHash("sha256").update(input.prompt).digest("hex"),
      session_id: null,
      session_file: null,
      process_mode: "cold",
      startup_ms: 0,
      first_event_ms: null,
      elapsed_ms: null,
      event_count: 0,
      tool_errors: 0,
      reason: null,
      result_file: null,
      ...(dispatch
        ? {
            task_id: dispatch.taskId,
            task_run_id: dispatch.runId,
            task_host_id: "pi" as const,
            start_request_id: startRequestId as string,
            process_id: null,
            host_start_receipt_ref: null,
            progress_evidence_ref: progressEvidenceRef,
            settle_receipt_id: null,
            process_stop_receipt: null,
            process_stop_error: null,
            process_exit_receipt: null,
            result_sha256: null,
            result_redacted: false,
            dispatch_lease_id: dispatch.leaseId,
            schedule_receipt_fingerprint: dispatch.scheduleReceiptFingerprint,
            admission_receipt_fingerprint: dispatch.admissionReceiptFingerprint,
            dispatch_stop_proof_ref: null,
            dispatch_lease_released: false,
            dispatch_lease_release_reason: null,
          }
        : {}),
    };
    fs.mkdirSync(path.dirname(eventFile), { recursive: true });
    if (dispatch) fs.writeFileSync(eventFile, "", { flag: "wx", mode: 0o600 });
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ parent_pid: process.pid, run_id: runId }),
      { flag: "wx", mode: 0o600 },
    );
    this.locked = true;
    atomicJson(runFile, record);
    atomicJson(latestFile, record);
    const started = performance.now();
    let detach = (): void => undefined;
    let closeFailed = false;
    const controller = new AbortController();
    if (input.signal?.aborted) controller.abort();
    const onAbort = (): void => controller.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const pollCancel = setInterval(() => {
      if (parseJson(cancelFile)?.run_id === runId) controller.abort();
    }, 200);
    try {
      const resumeFile = input.resume ? previousSession : null;
      const { client, startupMs, mode } = await this.ensureClient(
        dir,
        workdir,
        input.role,
        resumeFile,
      );
      if (parallelLeaseId) updateParallelChildPid(this.root, dir, parallelLeaseId, client.pid);
      fs.writeFileSync(
        lockFile,
        JSON.stringify({
          parent_pid: process.pid,
          child_pid: client.pid,
          run_id: runId,
        }),
        "utf8",
      );
      record.process_mode = mode;
      record.startup_ms = startupMs;
      const state = await client.state();
      record.session_id =
        typeof state.sessionId === "string" ? state.sessionId : null;
      record.session_file =
        typeof state.sessionFile === "string" ? state.sessionFile : null;
      atomicJson(runFile, record);
      atomicJson(latestFile, record);
      if (dispatch) {
        if (!startRequestId || !record.session_id || !Number.isSafeInteger(client.pid) || !client.pid) {
          throw new Error("Pi V2 host start did not provide a process and session identity");
        }
        const startReceipt = {
          schemaVersion: 1,
          source: "pactile-pi-rpc",
          taskId: dispatch.taskId,
          taskRunId: dispatch.runId,
          piRunId: runId,
          role: "implement",
          sessionId: record.session_id,
          processId: client.pid,
          startRequestId,
          progressEvidenceRef,
          evidenceRef: runReceiptRef,
          recordedAt: new Date().toISOString(),
        };
        const startFile = path.join(dir, startReceiptRef);
        fs.mkdirSync(path.dirname(startFile), { recursive: true });
        fs.writeFileSync(startFile, `${JSON.stringify(startReceipt, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        record.process_id = client.pid;
        record.host_start_receipt_ref = startReceiptRef;
        atomicJson(runFile, record);
        atomicJson(latestFile, record);
        bindPiV2RunHost(dispatch, {
          piRunId: runId,
          startRequestId,
          sessionId: record.session_id,
          processId: client.pid,
          progressEvidenceRef,
        });
      }
      detach = client.onEvent((event) => {
        if (event.type === "transport_error") return;
        record.event_count += 1;
        if (event.type === "tool_execution_end" && event.isError === true)
          record.tool_errors += 1;
        if (
          event.type === "extension_error" ||
          (event.type === "auto_retry_end" && event.success === false)
        )
          record.tool_errors += 1;
        const summary = evidenceEvent(event);
        fs.appendFileSync(eventFile, `${JSON.stringify(summary)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        try {
          input.onProgress?.(summary);
        } catch {
          /* Observers cannot change the run outcome. */
        }
      });
      const taskPath = dir;
      const contractPath = path.join(dir, "implement.md");
      const contractExcerpt = fs.existsSync(contractPath)
        ? fs.readFileSync(contractPath, "utf8").slice(0, 1_200)
        : "(no implement.md)";
      const effectiveTouches = touches ?? (dispatch
        ? [...new Set([...dispatch.run.writeSetSnapshot, ...(dispatch.run.workspace?.writeSet ?? [])])]
        : null);
      const writeSetLabel = dispatch ? "Task Run write set" : "Parent-declared write set";
      const instructions = [
        `Pactile task: ${taskPath}`,
        `Execution worktree: ${workdir}`,
        `Role: ${input.role}`,
        `Definition: ${taskPath}/prd.md`,
        `Evidence: ${taskPath}/verify.md`,
        "Approved execution contract excerpt:",
        contractExcerpt,
        "Follow the approved task contract and its write set. Do not commit, archive, finalize, or mutate Pactile Kernel state. Report evidence and unresolved issues. Do not include credentials in the final answer.",
        effectiveTouches?.length
          ? `${writeSetLabel}: ${effectiveTouches.join(", ")}. Do not change files outside it.`
          : "",
        input.role === "implement"
          ? "Implementation may change files only inside the approved write set."
          : "This role is read-only; do not change files.",
        "Worker assignment:",
        input.prompt,
      ].join("\n\n");
      const result = await client.prompt(
        instructions,
        input.timeoutMs,
        controller.signal,
      );
      record.first_event_ms = result.firstEventMs;
      const { text, redacted, stopReason, errorMessage } = assistantText(result.event);
      record.outcome =
        stopReason === "stop" && text && !record.tool_errors
          ? "settled"
          : "needs_review";
      if (stopReason && stopReason !== "stop")
        record.reason = `Pi stopReason=${stopReason}${errorMessage ? `; ${errorMessage}` : ""}`;
      const resultFile = path.join(evidence, "results", `${runId}.md`);
      fs.mkdirSync(path.dirname(resultFile), { recursive: true });
      fs.writeFileSync(
        resultFile,
        `${text || "(Pi returned no assistant text.)"}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      record.result_file = path.relative(dir, resultFile).replaceAll("\\", "/");
      if (dispatch) {
        const resultBytes = fs.readFileSync(resultFile);
        record.result_sha256 = createHash("sha256").update(resultBytes).digest("hex");
        record.result_redacted = redacted;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      record.outcome =
        controller.signal.aborted || reason.includes("cancelled")
          ? "cancelled"
          : reason.includes("timed out")
            ? "timed_out"
            : reason.includes("exited")
              ? "interrupted"
              : "failed";
      record.reason = redact(reason);
      if (!dispatch) {
        try {
          await this.close();
        } catch (closeError) {
          closeFailed = true;
          record.reason = `${record.reason}; Pi termination failed: ${redact(closeError instanceof Error ? closeError.message : String(closeError))}`;
        }
      }
    } finally {
      detach();
      clearInterval(pollCancel);
      input.signal?.removeEventListener("abort", onAbort);
      let processExit: PiProcessExitEvidence | null = null;
      if (dispatch) {
        try {
          processExit = await this.closeForDispatch() ?? null;
        } catch (closeError) {
          record.process_stop_error = redact(closeError instanceof Error ? closeError.message : String(closeError));
        }
        if (processExit) record.process_exit_receipt = processExit;
        if (processExit?.terminationVerified && processExit.exitObservedAt && startRequestId &&
          record.session_id && Number.isSafeInteger(record.process_id) && record.process_id) {
          if (record.outcome === "settled" && (processExit.exitCode !== 0 || processExit.signalCode !== null)) {
            record.outcome = "interrupted";
            record.reason = "Pi reported a settled response but the manager-owned process exited abnormally";
          }
          const settleReceiptId = `settle-${runId}`;
          const receipt: PiHostStopReceipt = {
            schemaVersion: 1,
            source: "pactile-pi-rpc",
            assurance: "manager-owned-child-exit",
            taskId: dispatch.taskId,
            taskRunId: dispatch.runId,
            piRunId: runId,
            role: "implement",
            sessionId: record.session_id,
            processId: record.process_id,
            startRequestId,
            settleReceiptId,
            terminal: record.outcome === "cancelled" ? "cancelled" : "exited",
            exitCode: processExit.exitCode,
            signalCode: processExit.signalCode,
            cancellationRequestId: parseJson(cancelFile)?.run_id === runId && typeof parseJson(cancelFile)?.request_id === "string"
              ? String(parseJson(cancelFile)?.request_id)
              : null,
            evidenceRef: runReceiptRef,
            progressEvidenceRef,
            resultRef: record.result_file,
            resultSha256: record.result_sha256 ?? null,
            recordedAt: new Date().toISOString(),
            processExit,
          };
          record.settle_receipt_id = settleReceiptId;
          record.process_stop_receipt = receipt;
          record.process_stop_error = null;
        } else {
          record.process_stop_error ??= "Pi child close was not verified; dispatch lease retained";
        }
      }
      if (closeFailed && alive(this.client?.pid)) {
        record.outcome = "interrupted";
        record.reason = `${record.reason ?? "Pi run interrupted"}; Pi process may still be active`;
      }
      record.ended_at = new Date().toISOString();
      record.elapsed_ms = Math.round(performance.now() - started);
      atomicJson(runFile, record);
      atomicJson(latestFile, record);
      const v2ChildClosed = processExit?.terminationVerified === true;
      if ((!dispatch && !(closeFailed && alive(this.client?.pid))) || (dispatch && v2ChildClosed))
        fs.rmSync(lockFile, { force: true });
      if (parseJson(cancelFile)?.run_id === runId)
        fs.rmSync(cancelFile, { force: true });
      if (dispatch && record.process_stop_receipt && startRequestId && record.session_id && record.process_id) {
        try {
          const settlement = persistPiV2StopAndRelease(dispatch, {
            runId,
            startRequestId,
            sessionId: record.session_id,
            processId: record.process_id,
            progressEvidenceRef,
            startReceiptRef,
            runReceiptRef,
            resultRef: record.result_file,
            resultSha256: record.result_sha256 ?? null,
            outcome: record.outcome,
            cancellationRequestId: record.process_stop_receipt.cancellationRequestId,
            processExit: record.process_stop_receipt.processExit,
            processStopReceipt: record.process_stop_receipt,
          });
          record.dispatch_stop_proof_ref = settlement.stopReceiptTaskRef || null;
          record.dispatch_lease_released = settlement.released;
          record.dispatch_lease_release_reason = settlement.reasonCode;
        } catch (settleError) {
          record.dispatch_lease_released = false;
          record.dispatch_lease_release_reason = redact(settleError instanceof Error ? settleError.message : String(settleError));
        }
        atomicJson(runFile, record);
        atomicJson(latestFile, record);
      }
      this.locked = false;
    }
    return record;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.taskDir = null;
    this.workdir = null;
    this.role = null;
  }
}
