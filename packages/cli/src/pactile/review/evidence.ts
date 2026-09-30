import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import parseShell from "shell-quote/parse.js";
import {
  resolveTaskReviewEvidenceV1,
  type TaskRunV2,
} from "../../core/task/index.js";
import { resolvePiReviewWorkspace } from "../pi/review-workspace.js";

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

export type PiReviewToolFailureV1 =
  | "missing-source"
  | "missing-tool"
  | "readonly-temp"
  | "read-probe"
  | "empty-query"
  | "required-validation"
  | "unclassified";
export interface PiReviewToolCallV1 {
  id: string;
  tool: string;
  startedEvent: number;
  endedEvent: number;
  inputSha256: string;
  resultSha256: string;
  outcome: "success" | "error";
  failure: PiReviewToolFailureV1 | null;
}
export interface PiReviewToolEvidenceV1 {
  schemaVersion: 1;
  source: "pactile-pi-review-tools-v1";
  calls: PiReviewToolCallV1[];
  fatalErrors: number;
}
export interface PiReviewToolRecoveryV1 {
  failedToolCallId: string;
  recoveredByToolCallId: string;
  rationale: string;
}

const MAX_REVIEW_TOOL_CALLS = 512;
// Pi Responses providers preserve call_id|function_call_id. Keep the full opaque
// identity, including its delimiter; never collapse separate provider calls.
export const PI_REVIEW_TOOL_CALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/|+=-]{0,255}$/u;
/** A bounded model-facing reference; the complete native ID remains authoritative. */
export function piReviewToolReferenceV1(id: string): string {
  if (!PI_REVIEW_TOOL_CALL_ID_PATTERN.test(id)) throw new Error("Invalid native Pi tool identity");
  return `pactile-call-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
}
const CALL_ID = PI_REVIEW_TOOL_CALL_ID_PATTERN;
const HASH = /^[a-f0-9]{64}$/u;
const RECOVERABLE = new Set<PiReviewToolFailureV1>([
  "missing-source",
  "missing-tool",
  "readonly-temp",
  "read-probe",
  "empty-query",
]);
const VALIDATION_WORD = /^(?:test|check|lint|typecheck|build|vitest|jest|mocha|pytest|eslint|tsc|playwright|cypress)$/iu;
interface BashProbeShape { last: string[]; writes: boolean; validation: boolean; }

/** Tokenize without expansion or execution. Only a small, proven query grammar is eligible. */
function bashProbeShape(command: string): BashProbeShape | null {
  if (!command || command.length > 16_384 || /[\r\n`]|\$\(/u.test(command)) return null;
  let tokens: ReturnType<typeof parseShell>;
  try { tokens = parseShell(command, () => ({ op: "pactile-dynamic-expansion" })); }
  catch { return null; }
  if (tokens.length > 1024) return null;
  const commands: string[][] = [];
  let words: string[] = [];
  let writes = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (typeof token === "string") { words.push(token); continue; }
    if (!token || !("op" in token)) {
      if (token && "comment" in token) break;
      return null;
    }
    if (token.op === "glob") {
      if (words.length === 0) return null;
      words.push(token.pattern); continue;
    }
    if ([";", "&&", "||", "|"].includes(token.op)) {
      if (words.length === 0) return null;
      commands.push(words); words = []; continue;
    }
    if ([">", ">>", "<", ">&", "<&"].includes(token.op)) {
      const target = tokens[++index];
      if (typeof target !== "string" || !target) return null;
      if (/^\d+$/u.test(words.at(-1) ?? "")) words.pop();
      if (token.op !== "<" && token.op !== "<&" && target !== "/dev/null" && !/^\d+$/u.test(target)) writes = true;
      continue;
    }
    return null;
  }
  if (words.length === 0) return null;
  commands.push(words);
  let validation = false;
  for (const invocation of commands) {
    const executable = invocation[0] ?? "";
    const program = path.posix.basename(executable);
    const args = invocation.slice(1);
    if (VALIDATION_WORD.test(program)
      || /^(?:npm|pnpm|yarn|bun)$/u.test(program) && args.some((arg) => VALIDATION_WORD.test(arg))
      || /^(?:go|cargo|dotnet)$/u.test(program) && args[0] === "test"
      || program === "node" && args.includes("--test")
      || /^python[0-9.]*$/u.test(program) && args[0] === "-m" && /^(?:pytest|unittest)$/u.test(args[1] ?? "")) {
      validation = true; continue;
    }
    if (executable.includes("/") && (path.posix.normalize(executable) !== executable
      || !["/bin", "/usr/bin", "/usr/local/bin"].includes(path.posix.dirname(executable)))) return null;
    if (program === "grep" || program === "git" && args[0] === "check-ignore") {
      try {
        const options = parseArgs({ args: program === "grep" ? args : args.slice(1), strict: false, allowPositionals: true, tokens: true,
          options: { quiet: { type: "boolean", short: "q" }, silent: { type: "boolean" }, regexp: { type: "string", short: "e" }, file: { type: "string", short: "f" } } });
        const assertionNames = program === "grep" ? ["quiet", "silent"] : ["quiet"];
        const abbreviated = options.tokens.some((token) => token.kind === "option" && token.rawName.startsWith("--")
          && token.name.length > 0 && assertionNames.some((name) => name.startsWith(token.name)));
        if (options.values.quiet || program === "grep" && options.values.silent || abbreviated) { validation = true; continue; }
      } catch { return null; }
    }
    const simpleQuery = /^(?:ls|cat|head|tail|wc|pwd|echo|which|grep|cd)$/u.test(program)
      || program === "command" && args[0] === "-v"
      || program === "node" && args.length === 1 && ["--version", "-v"].includes(args[0] ?? "")
      || program === "printf" && args.length === 1 && !(args[0] ?? "").includes("%")
      || program === "find" && !args.some((arg) => /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf)$/u.test(arg))
      || program === "sed" && args[0] === "-n" && /^\d+(?:,\d+)?p$/u.test(args[1] ?? "") && args.slice(2).every((arg) => !arg.startsWith("-"))
      || program === "git" && /^(?:status|show|diff|ls-files|rev-parse|check-ignore)$/u.test(args[0] ?? "")
        && !args.some((arg) => /^(?:--ext-diff|--textconv|-c|--exec-path)(?:=|$)/u.test(arg));
    if (!simpleQuery) return null;
  }
  const last = commands.at(-1);
  return last ? { last, writes, validation } : null;
}

function toolHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}
function failureKind(
  tool: string,
  args: unknown,
  result: unknown,
  toolCallId: string,
): PiReviewToolFailureV1 {
  const input =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const command = typeof input.command === "string" ? input.command : "";
  const shell = tool === "bash" ? bashProbeShape(command) : null;
  // A failed validation command is never reclassified by the model's explanation.
  if (shell?.validation) return "required-validation";
  const output =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  const content = Array.isArray(output.content) ? output.content : [];
  const textBlocks = content
    .map((item: unknown) =>
      item &&
      typeof item === "object" &&
      typeof (item as Record<string, unknown>).text === "string"
        ? ((item as Record<string, unknown>).text as string)
        : "",
    );
  // The policy appends this exact metadata block after the original result.
  // Keep it in the result hash; classification reads the original text only.
  const legacyAnnotation = `Pactile tool evidence: ${JSON.stringify({ toolCallId, outcome: "error" })}`;
  const annotation = `Pactile tool evidence: ${JSON.stringify({ toolCallId, reviewToolRef: piReviewToolReferenceV1(toolCallId), outcome: "error" })}`;
  if ([annotation, legacyAnnotation].includes(textBlocks.at(-1) ?? "")) textBlocks.pop();
  const text = textBlocks.join("\n").slice(0, 32_768);
  if (
    /^\s*(?:AssertionError\b|Error\s*\[ERR_ASSERTION\]|FAIL\s|(?:Test Files|Tests)\s+\d+\s+failed)/mu.test(text)
  )
    return "required-validation";
  if (
    tool === "read" &&
    /\bENOENT\b|file (?:does not exist|not found)|offset .*beyond/iu.test(text)
  )
    return "missing-source";
  // Wrappers, substitutions, multiline scripts and unknown commands cannot hide
  // an earlier validation behind a final discovery call. Their failures stay hard.
  if (tool === "bash" && !shell) return "unclassified";
  if (
    tool === "bash" &&
    /(?:^|[\s'"=])\/tmp\//u.test(command) &&
    /\bEROFS\b|read-only file system/iu.test(text)
  )
    return "readonly-temp";
  if (
    tool === "bash" &&
    /command not found|(?:^|\n)[^\n]*:\s*(?:\d+:\s*)?[^\n]*:\s*not found|spawn \S+ ENOENT/iu.test(
      text,
    )
  )
    return "missing-tool";
  // These are eligibility hints only. The independent Review still has to bind
  // later successful evidence and explain why the query was exploratory.
  const exit = /Command exited with code ([12])\s*$/u.exec(text)?.[1];
  if (shell?.writes) return "unclassified";
  const lastProgram = shell ? path.posix.basename(shell.last[0] ?? "") : "";
  if (tool === "bash" && exit === "1" && (lastProgram === "which" || lastProgram === "command" && shell?.last[1] === "-v")) return "missing-tool";
  const readProbe = /^(?:ls|cat|sed|grep|head|tail|wc|find|git)$/u.test(lastProgram);
  if (tool === "bash" && readProbe && exit) {
    return exit === "1" && (lastProgram === "grep" || lastProgram === "git" && shell?.last[1] === "check-ignore")
      ? "empty-query"
      : "read-probe";
  }
  return "unclassified";
}

/** Attach only IDs, order, outcomes and hashes to the existing secret-safe event stream. */
export class PiReviewToolObserverV1 {
  private readonly inputs = new Map<string, unknown>();
  public observe(
    event: Record<string, unknown>,
    index: number,
    safe: Record<string, unknown>,
  ): void {
    if (
      !["tool_execution_start", "tool_execution_end"].includes(
        String(event.type),
      )
    )
      return;
    const id = event.toolCallId;
    if (typeof id !== "string" || !CALL_ID.test(id)) return;
    if (event.type === "tool_execution_start") {
      if (this.inputs.size >= MAX_REVIEW_TOOL_CALLS || this.inputs.has(id))
        return;
      this.inputs.set(id, event.args);
      safe.review_tool = {
        phase: "start",
        id,
        index,
        tool: safe.tool ?? "other",
        inputSha256: toolHash(event.args),
      };
    } else {
      safe.review_tool = {
        phase: "end",
        id,
        index,
        tool: safe.tool ?? "other",
        resultSha256: toolHash(event.result),
        outcome: event.isError === true ? "error" : "success",
        failure:
          event.isError === true
            ? failureKind(
                String(event.toolName),
                this.inputs.get(id),
                event.result,
                id,
              )
            : null,
      };
    }
  }
}

/** Reconstruct from the stop-receipt-bound events; no persisted counter can waive failures. */
export function readPiReviewToolEvidenceV1(
  events: readonly Record<string, unknown>[],
): PiReviewToolEvidenceV1 {
  const starts = new Map<
    string,
    { tool: string; index: number; inputSha256: string }
  >();
  const calls: PiReviewToolCallV1[] = [];
  const ended = new Set<string>();
  let fatalErrors = 0;
  for (const [offset, event] of events.entries()) {
    if (
      event.type === "extension_error" ||
      (event.type === "auto_retry_end" && event.success === false)
    )
      fatalErrors += 1;
    if (
      !["tool_execution_start", "tool_execution_end"].includes(
        String(event.type),
      )
    )
      continue;
    const raw = event.review_tool;
    const item =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const id = item.id;
    const index = offset + 1;
    if (
      typeof id !== "string" ||
      !CALL_ID.test(id) ||
      item.index !== index ||
      item.tool !== event.tool ||
      typeof item.tool !== "string"
    ) {
      fatalErrors += 1;
      continue;
    }
    if (event.type === "tool_execution_start") {
      if (
        item.phase !== "start" ||
        starts.has(id) ||
        starts.size >= MAX_REVIEW_TOOL_CALLS ||
        typeof item.inputSha256 !== "string" ||
        !HASH.test(item.inputSha256)
      ) {
        fatalErrors += 1;
        continue;
      }
      starts.set(id, { tool: item.tool, index, inputSha256: item.inputSha256 });
      continue;
    }
    const start = starts.get(id);
    const failure = item.failure as PiReviewToolFailureV1 | null;
    if (
      !start ||
      ended.has(id) ||
      start.tool !== item.tool ||
      item.phase !== "end" ||
      typeof item.resultSha256 !== "string" ||
      !HASH.test(item.resultSha256) ||
      item.outcome !== (event.is_error === true ? "error" : "success") ||
      (event.is_error === true
        ? ![
            "missing-source",
            "missing-tool",
            "readonly-temp",
            "read-probe",
            "empty-query",
            "required-validation",
            "unclassified",
          ].includes(String(failure))
        : failure !== null)
    ) {
      fatalErrors += 1;
      continue;
    }
    ended.add(id);
    calls.push({
      id,
      tool: start.tool,
      startedEvent: start.index,
      endedEvent: index,
      inputSha256: start.inputSha256,
      resultSha256: item.resultSha256,
      outcome: item.outcome as "success" | "error",
      failure,
    });
  }
  fatalErrors += starts.size - ended.size;
  return {
    schemaVersion: 1,
    source: "pactile-pi-review-tools-v1",
    calls,
    fatalErrors,
  };
}

export function assertPiReviewToolEvidenceV1(
  evidence: PiReviewToolEvidenceV1 | undefined,
  errors: number,
): void {
  if (!evidence) {
    if (errors !== 0)
      throw new Error(
        "Pi tool errors require complete recorded recovery evidence",
      );
    return;
  }
  if (
    evidence.schemaVersion !== 1 ||
    evidence.source !== "pactile-pi-review-tools-v1" ||
    evidence.fatalErrors !== 0 ||
    !Array.isArray(evidence.calls) ||
    evidence.calls.length > MAX_REVIEW_TOOL_CALLS
  )
    throw new Error(
      "Pi tool evidence is incomplete or contains a fatal runtime error",
    );
  const ids = new Set<string>();
  const references = new Set<string>();
  const eventIndexes = new Set<number>();
  for (const call of evidence.calls) {
    if (
      !CALL_ID.test(call.id) ||
      ids.has(call.id) ||
      references.has(piReviewToolReferenceV1(call.id)) ||
      typeof call.tool !== "string" ||
      call.tool.length > 128 ||
      !HASH.test(call.inputSha256) ||
      !HASH.test(call.resultSha256) ||
      !Number.isSafeInteger(call.startedEvent) ||
      call.startedEvent < 1 ||
      !Number.isSafeInteger(call.endedEvent) ||
      call.endedEvent <= call.startedEvent ||
      eventIndexes.has(call.startedEvent) ||
      eventIndexes.has(call.endedEvent) ||
      !["success", "error"].includes(call.outcome) ||
      (call.outcome === "success"
        ? call.failure !== null
        : !RECOVERABLE.has(call.failure as PiReviewToolFailureV1))
    )
      throw new Error(
        "Pi tool evidence contains an unclassified or required-validation failure",
      );
    ids.add(call.id);
    references.add(piReviewToolReferenceV1(call.id));
    eventIndexes.add(call.startedEvent);
    eventIndexes.add(call.endedEvent);
  }
  if (
    evidence.calls.filter((call) => call.outcome === "error").length !== errors
  )
    throw new Error("Pi tool error count does not match recorded failures");
}

export function assertPiReviewToolRecoveriesV1(
  evidence: PiReviewToolEvidenceV1 | undefined,
  errors: number,
  recoveries: readonly PiReviewToolRecoveryV1[],
): PiReviewToolRecoveryV1[] {
  assertPiReviewToolEvidenceV1(evidence, errors);
  const failures =
    evidence?.calls.filter((call) => call.outcome === "error") ?? [];
  if (recoveries.length !== failures.length)
    throw new Error(
      "Pi tool recovery explanations do not cover every recorded failure",
    );
  const accounted = new Set<string>();
  const resolved: PiReviewToolRecoveryV1[] = [];
  const resolve = (id: string): PiReviewToolCallV1 | undefined => {
    const matches = evidence?.calls.filter((call) => call.id === id || piReviewToolReferenceV1(call.id) === id) ?? [];
    return matches.length === 1 ? matches[0] : undefined;
  };
  for (const recovery of recoveries) {
    const failed = resolve(recovery.failedToolCallId);
    const succeeded = resolve(recovery.recoveredByToolCallId);
    if (
      failed?.outcome !== "error" ||
      accounted.has(failed.id) ||
      succeeded?.outcome !== "success" ||
      succeeded.startedEvent <= failed.endedEvent ||
      typeof recovery.rationale !== "string" ||
      recovery.rationale.trim().length < 1 ||
      recovery.rationale.length > 1000
    )
      throw new Error(
        "Pi tool recovery needs a unique failure, a later successful call and independent explanation",
      );
    accounted.add(failed.id);
    resolved.push({ failedToolCallId: failed.id, recoveredByToolCallId: succeeded.id, rationale: recovery.rationale });
  }
  return resolved;
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
    throw new Error(
      "Pi Review evidence requires the latest completed Run candidate",
    );
  }

  const projectRoot = fs.realpathSync(input.root);
  const realTaskDir = fs.realpathSync(input.taskDir);
  const taskRelative = path.relative(projectRoot, realTaskDir);
  const taskPrefix = `${path.join(".pactile", "tasks")}${path.sep}`;
  const normalizedTaskRelative =
    process.platform === "win32" ? taskRelative.toLowerCase() : taskRelative;
  const normalizedTaskPrefix =
    process.platform === "win32" ? taskPrefix.toLowerCase() : taskPrefix;
  if (!normalizedTaskRelative.startsWith(normalizedTaskPrefix)) {
    throw new Error("Pi Review TaskDir is outside the project task store");
  }

  resolvePiReviewWorkspace({
    root: projectRoot,
    taskDir: input.taskDir,
    run: input.run,
    candidateRoot: input.candidateRoot,
  });

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
    if (
      item.source !== "candidate-snapshot" &&
      item.source !== "run-evidence"
    ) {
      throw new Error("Pi Review evidence resolved to an unsupported source");
    }
    return {
      ref: item.ref,
      sha256: item.sha256,
      sizeBytes: item.sizeBytes,
      source: item.source,
    };
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
