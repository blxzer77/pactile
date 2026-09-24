import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_CANONICAL_PATHS_V1 } from "../runtime.js";
import { parseCompositionTraceEventV1, type CompositionTraceEventV1 } from "../trace.js";
import {
  canonicalizePactileJsonV1,
  fingerprintPactileContractV1,
  PACTILE_FINGERPRINT_PATTERN,
  isPlainRecordV1,
} from "../validation.js";

export type TraceErrorCode =
  | "invalid-event" | "unsafe-path" | "locked" | "malformed"
  | "sequence-mismatch" | "chain-mismatch" | "duplicate-event"
  | "checkpoint-mismatch" | "uncommitted" | "cas-mismatch" | "io-failure";

/** Messages are symbolic: rejected input is never echoed into diagnostics. */
export class TraceError extends Error {
  constructor(readonly code: TraceErrorCode, readonly line: number | null = null) {
    super(`PACTILE_TRACE_${code.replaceAll("-", "_").toUpperCase()}`);
    this.name = "TraceError";
  }
}

/** Never attach the original error/cause: Node I/O errors include caller paths. */
function traceIoBoundary<T>(action: () => T): T {
  try { return action(); }
  catch (error) {
    if (error instanceof TraceError) throw error;
    throw new TraceError("io-failure");
  }
}

export interface TraceHead {
  readonly sequence: number;
  readonly fingerprint: string | null;
}

export interface VerifiedTrace {
  readonly events: readonly CompositionTraceEventV1[];
  readonly head: TraceHead;
}

const EMPTY_HEAD: TraceHead = { sequence: 0, fingerprint: null };
const MAX_EVENT_BYTES = 64 * 1024;

/** Reject accessors/non-JSON objects before the v1 decoder can read them. */
function assertData(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (depth > 16) throw new TraceError("invalid-event");
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && (
      /(?:sk-(?:proj-|svcacct-)?[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{12,}|xox[baprs]-[a-z0-9-]{10,})/i.test(value) ||
      /(?:^|[._:/-])(?:prompt|reasoning|scratchpad|secret|password|credential|credentials|token|chain-of-thought)(?:$|[._:/-])/i.test(value)
    )) throw new TraceError("invalid-event");
    return;
  }
  if (ancestors.has(value) || (!Array.isArray(value) && !isPlainRecordV1(value))) {
    throw new TraceError("invalid-event");
  }
  ancestors.add(value);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === "length") continue;
    if (descriptor.get || descriptor.set || !descriptor.enumerable) throw new TraceError("invalid-event");
    assertData(descriptor.value, ancestors, depth + 1);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw new TraceError("invalid-event");
  ancestors.delete(value);
}

/** Strict M0 allowlist, canonical JSON, no envelope or arbitrary metadata. */
export function serializeTraceEvent(input: unknown): { event: CompositionTraceEventV1; json: string; fingerprint: string } {
  try {
    assertData(input);
    const raw = canonicalizePactileJsonV1(input);
    if (Buffer.byteLength(raw) > MAX_EVENT_BYTES) throw new TraceError("invalid-event");
    const parsed = parseCompositionTraceEventV1(JSON.parse(raw) as unknown);
    if (!parsed.success) throw new TraceError("invalid-event");
    return { event: parsed.data, json: canonicalizePactileJsonV1(parsed.data), fingerprint: parsed.fingerprint };
  } catch {
    throw new TraceError("invalid-event");
  }
}

/** An external trusted head detects complete suffix deletion, including an empty file. */
export function verifyTrace(text: string, traceId: string, expectedHead?: TraceHead): VerifiedTrace {
  const events: CompositionTraceEventV1[] = [];
  const ids = new Set<string>();
  let head = EMPTY_HEAD;
  if (text !== "" && !text.endsWith("\n")) throw new TraceError("uncommitted", text.split("\n").length);
  const lines = text === "" ? [] : text.slice(0, -1).split("\n");
  for (const [index, line] of lines.entries()) {
    let serialized: ReturnType<typeof serializeTraceEvent>;
    try {
      if (Buffer.byteLength(line) > MAX_EVENT_BYTES) throw new TraceError("malformed");
      serialized = serializeTraceEvent(JSON.parse(line) as unknown);
    } catch {
      throw new TraceError("malformed", index + 1);
    }
    const event = serialized.event;
    if (event.traceId !== traceId || event.sequence !== head.sequence + 1) throw new TraceError("sequence-mismatch", index + 1);
    if (event.previousEventFingerprint !== head.fingerprint) throw new TraceError("chain-mismatch", index + 1);
    if (ids.has(event.eventId)) throw new TraceError("duplicate-event", index + 1);
    ids.add(event.eventId);
    events.push(event);
    head = { sequence: event.sequence, fingerprint: serialized.fingerprint };
  }
  if (expectedHead && !sameHead(head, expectedHead)) throw new TraceError("checkpoint-mismatch", head.sequence + 1);
  return { events, head };
}

function sameHead(a: TraceHead, b: TraceHead): boolean {
  return a.sequence === b.sequence && a.fingerprint === b.fingerprint;
}

function assertSafePath(target: string): void {
  let current = path.resolve(target);
  while (true) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw new TraceError("unsafe-path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function assertNoCaseAlias(root: string, relativePath: string): void {
  let parent = root;
  for (const segment of relativePath.split(path.sep)) {
    if (!fs.existsSync(parent)) return;
    for (const entry of fs.readdirSync(parent)) {
      if (entry.normalize("NFC").toLowerCase() === segment.normalize("NFC").toLowerCase() && entry !== segment) {
        throw new TraceError("unsafe-path");
      }
    }
    parent = path.join(parent, segment);
  }
}

function traceFiles(projectRoot: string, traceId: string): { log: string; checkpoint: string; lock: string } {
  // Portable filename subset of LogicalIdV1; Windows device names are forbidden.
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(traceId) || traceId.length > 128 ||
      /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(traceId)) throw new TraceError("unsafe-path");
  const root = path.resolve(projectRoot);
  assertSafePath(root);
  const dir = path.join(root, path.dirname(DEFAULT_CANONICAL_PATHS_V1.installStatePath), "traces");
  const log = path.join(dir, `${traceId}.jsonl`);
  const checkpoint = `${log}.head.json`;
  const lock = `${log}.lock`;
  for (const file of [log, checkpoint, lock]) {
    assertSafePath(file);
    assertNoCaseAlias(root, path.relative(root, file));
  }
  return { log, checkpoint, lock };
}

function readOptional(file: string): string | null {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseHead(raw: string): TraceHead {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isPlainRecordV1(value) || Object.keys(value).sort().join(",") !== "fingerprint,sequence" ||
        !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 ||
        (value.sequence === 0 ? value.fingerprint !== null : typeof value.fingerprint !== "string" || !PACTILE_FINGERPRINT_PATTERN.test(value.fingerprint))) {
      throw new TraceError("malformed");
    }
    return { sequence: value.sequence as number, fingerprint: value.fingerprint as string | null };
  } catch { throw new TraceError("malformed"); }
}

/** Read-only; an interrupted writer or stale lock is reported, never stolen/repaired. */
export function readTrace(projectRoot: string, traceId: string, expectedHead?: TraceHead): VerifiedTrace {
  return traceIoBoundary(() => {
  const files = traceFiles(projectRoot, traceId);
  if (fs.existsSync(files.lock)) throw new TraceError("locked");
  const result = readTraceUnlocked(files, traceId, expectedHead);
  // A concurrent append may have started while the reader inspected the files.
  if (fs.existsSync(files.lock)) throw new TraceError("locked");
  return result;
  });
}

function readTraceUnlocked(files: { log: string; checkpoint: string }, traceId: string, expectedHead?: TraceHead): VerifiedTrace {
  const rawHead = readOptional(files.checkpoint);
  const rawLog = readOptional(files.log);
  if (rawHead === null) {
    if (rawLog !== null) throw new TraceError("uncommitted");
    return verifyTrace("", traceId, expectedHead);
  }
  const head = parseHead(rawHead);
  const result = verifyTrace(rawLog ?? "", traceId, head);
  if (expectedHead && !sameHead(result.head, expectedHead)) throw new TraceError("checkpoint-mismatch");
  return result;
}

function writeHead(file: string, head: TraceHead): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    try {
      assertExclusiveFile(fd, temp);
      fs.writeFileSync(fd, `${canonicalizePactileJsonV1(head)}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    assertSafePath(file);
    fs.renameSync(temp, file); // Never fall back to a non-atomic overwrite.
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function assertExclusiveFile(fd: number, file: string): void {
  assertSafePath(file);
  const opened = fs.fstatSync(fd);
  const named = fs.lstatSync(file);
  if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino) {
    throw new TraceError("unsafe-path");
  }
}

/**
 * Append under an exclusive process lock and optimistic head CAS. Event bytes
 * are fsynced before advancing the atomic checkpoint. A crash between these
 * steps is observable as checkpoint-mismatch; no history is auto-truncated.
 * Keep returned heads outside this directory when malicious whole-store
 * rollback must be detected. A hash chain is integrity evidence, not a signature.
 */
export function appendTrace(projectRoot: string, input: unknown, expectedHead: TraceHead): TraceHead {
  return traceIoBoundary(() => {
  const serialized = serializeTraceEvent(input);
  const files = traceFiles(projectRoot, serialized.event.traceId);
  fs.mkdirSync(path.dirname(files.log), { recursive: true });
  for (const file of [files.log, files.checkpoint, files.lock]) assertSafePath(file);
  let lockFd: number;
  try { lockFd = fs.openSync(files.lock, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new TraceError("locked");
    throw error;
  }
  try {
    assertExclusiveFile(lockFd, files.lock);
    const current = readTraceUnlocked(files, serialized.event.traceId);
    if (!sameHead(current.head, expectedHead)) throw new TraceError("cas-mismatch");
    if (serialized.event.sequence !== current.head.sequence + 1) throw new TraceError("sequence-mismatch");
    if (serialized.event.previousEventFingerprint !== current.head.fingerprint) throw new TraceError("chain-mismatch");
    if (current.events.some((event) => event.eventId === serialized.event.eventId)) throw new TraceError("duplicate-event");
    if (readOptional(files.checkpoint) === null) writeHead(files.checkpoint, EMPTY_HEAD);
    const fd = fs.openSync(files.log, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { assertExclusiveFile(fd, files.log); fs.writeFileSync(fd, `${serialized.json}\n`); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    const head = { sequence: serialized.event.sequence, fingerprint: serialized.fingerprint };
    writeHead(files.checkpoint, head);
    return head;
  } finally {
    fs.closeSync(lockFd);
    fs.unlinkSync(files.lock);
  }
  });
}

/** Stable identifier for an observable resolution/validation fact kept elsewhere. */
export const traceFactFingerprint = fingerprintPactileContractV1;
