import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { appendTrace, readTrace, serializeTraceEvent, verifyTrace } from "../../../../src/core/pactile/trace-runtime/index.js";

const event = (sequence = 1, previousEventFingerprint: string | null = null) => ({
  schemaVersion: 1, traceId: "run-a", eventId: `event-${sequence}`, sequence,
  previousEventFingerprint, at: "2026-09-09T00:00:00Z", event: "tile.selected",
  outcome: "accepted", taskId: "task-a", tileId: "tile-a", relatedTileId: null,
  intent: null, provider: null, position: null, durationMs: null, errorCode: null,
  artifactRefs: [], evidenceRefs: [],
});
const empty = { sequence: 0, fingerprint: null };

describe("Composition Trace public store", () => {
  let root: string;
  let log: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-trace-"));
    log = path.join(root, ".pactile/runtime/traces/run-a.jsonl");
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { force: true, recursive: true }); });

  it.each(["read", "append"])("F3 maps %s non-directory I/O errors to path-free symbolic diagnostics", (operation) => {
    const marker = "private-path-marker", invalidRoot = path.join(root, marker);
    fs.writeFileSync(invalidRoot, "not a directory");
    let caught: unknown;
    try { if (operation === "read") readTrace(invalidRoot, "run-a"); else appendTrace(invalidRoot, event(), empty); }
    catch (error) { caught = error; }
    expect(caught).toMatchObject({ name: "TraceError", code: "io-failure", message: "PACTILE_TRACE_IO_FAILURE" });
    const fields = caught as Error & { code: string };
    for (const value of [fields.name, fields.code, fields.message]) {
      expect(value).not.toContain(root); expect(value).not.toContain(marker);
    }
    expect(fs.readFileSync(invalidRoot, "utf8")).toBe("not a directory");
  });

  it("appends only observable M0 events and returns an externally retainable head", () => {
    expect(readTrace(root, "run-a").head).toEqual(empty);
    expect(fs.readdirSync(root)).toEqual([]);
    const first = appendTrace(root, event(), empty);
    const second = appendTrace(root, event(2, first.fingerprint), first);
    expect(second.sequence).toBe(2);
    expect(readTrace(root, "run-a", second).events.map((item) => item.eventId)).toEqual(["event-1", "event-2"]);
    expect(() => appendTrace(root, event(3, second.fingerprint), first)).toThrow("CAS_MISMATCH");
    expect(readTrace(root, "run-a").head).toEqual(second);
  });

  it("detects suffix truncation and last-event mutation using its checkpoint", () => {
    const first = appendTrace(root, event(), empty);
    const original = fs.readFileSync(log, "utf8");
    appendTrace(root, event(2, first.fingerprint), first);
    fs.writeFileSync(log, original);
    expect(() => readTrace(root, "run-a")).toThrow("CHECKPOINT_MISMATCH");
    fs.writeFileSync(log, "");
    expect(() => readTrace(root, "run-a")).toThrow("CHECKPOINT_MISMATCH");
    fs.writeFileSync(log, original.replace("tile-a", "tile-b"));
    expect(() => readTrace(root, "run-a")).toThrow("CHECKPOINT_MISMATCH");
  });

  it("detects reorder, duplicate sequence, broken chain, duplicate id, and partial writes", () => {
    const first = serializeTraceEvent(event());
    const second = serializeTraceEvent(event(2, first.fingerprint));
    expect(() => verifyTrace(`${second.json}\n${first.json}\n`, "run-a")).toThrow("SEQUENCE_MISMATCH");
    expect(() => verifyTrace(`${first.json}\n${first.json}\n`, "run-a")).toThrow("SEQUENCE_MISMATCH");
    const broken = serializeTraceEvent(event(2, `sha256:${"0".repeat(64)}`));
    expect(() => verifyTrace(`${first.json}\n${broken.json}\n`, "run-a")).toThrow("CHAIN_MISMATCH");
    const duplicate = serializeTraceEvent({ ...event(2, first.fingerprint), eventId: "event-1" });
    expect(() => verifyTrace(`${first.json}\n${duplicate.json}\n`, "run-a")).toThrow("DUPLICATE_EVENT");
    expect(() => verifyTrace(first.json, "run-a")).toThrow("UNCOMMITTED");
  });

  it.each(["prompt", "reasoning", "chainOfThought", "secret", "arguments"])("rejects %s without echoing rejected content", (key) => {
    const value = "private-value-that-must-never-be-echoed";
    expect(() => serializeTraceEvent({ ...event(), [key]: value })).toThrow("INVALID_EVENT");
    try { appendTrace(root, { ...event(), [key]: value }, empty); }
    catch (error) { expect(String(error)).not.toContain(value); }
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it.each([
    { taskId: "sk-proj-abcdefghijklmnopqrst" },
    { artifactRefs: ["artifact://token/value"] },
    { artifactRefs: ["artifact://result?password=123"] },
    { tileId: "chain-of-thought" },
    { evidenceRefs: ["https://user:pass@example.org"] },
  ])("rejects credential-like payload hidden in allowed fields", (patch) => {
    expect(() => serializeTraceEvent({ ...event(), ...patch })).toThrow("INVALID_EVENT");
  });

  it("rejects accessors without executing them", () => {
    let invoked = false;
    const input = { ...event(), get prompt() { invoked = true; return "private"; } };
    expect(() => serializeTraceEvent(input)).toThrow("INVALID_EVENT");
    expect(invoked).toBe(false);
  });

  it("never steals an existing writer lock or repairs an uncommitted append", () => {
    appendTrace(root, event(), empty);
    fs.writeFileSync(`${log}.lock`, "another-writer");
    expect(() => readTrace(root, "run-a")).toThrow("LOCKED");
    expect(() => appendTrace(root, event(), empty)).toThrow("LOCKED");
    expect(fs.readFileSync(`${log}.lock`, "utf8")).toBe("another-writer");
    fs.unlinkSync(`${log}.lock`);
    fs.appendFileSync(log, "{\"partial\":");
    const damaged = fs.readFileSync(log, "utf8");
    expect(() => readTrace(root, "run-a")).toThrow("UNCOMMITTED");
    expect(() => appendTrace(root, event(), empty)).toThrow("UNCOMMITTED");
    expect(fs.readFileSync(log, "utf8")).toBe(damaged);
  });

  it("rejects path escape, case-alias roots, and portable device names", () => {
    for (const id of ["../escape", "con", "nul.log", "name:stream"]) {
      expect(() => readTrace(root, id)).toThrow("UNSAFE_PATH");
    }
    fs.mkdirSync(path.join(root, ".PACTILE"));
    expect(() => appendTrace(root, event(), empty)).toThrow("UNSAFE_PATH");
    expect(fs.readdirSync(root)).toEqual([".PACTILE"]);
  });

  it("refuses a symlink/junction escape without creating files outside the project", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "trace-outside-"));
    try {
      fs.symlinkSync(outside, path.join(root, ".pactile"), process.platform === "win32" ? "junction" : "dir");
      expect(() => appendTrace(root, event(), empty)).toThrow("UNSAFE_PATH");
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally { fs.rmSync(outside, { force: true, recursive: true }); }
  });

  it("rejects aliases in derived runtime path segments, not only the canonical root", () => {
    fs.mkdirSync(path.join(root, ".pactile/Runtime"), { recursive: true });
    expect(() => appendTrace(root, event(), empty)).toThrow("UNSAFE_PATH");
    expect(fs.readdirSync(path.join(root, ".pactile"))).toEqual(["Runtime"]);
  });

  it.each(["", ".head.json", ".lock"])("rejects hardlinked trace storage %s without mutating the outside inode", (suffix) => {
    const first = appendTrace(root, event(), empty);
    const target = `${log}${suffix}`;
    if (suffix === ".lock") fs.writeFileSync(target, "held");
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-hardlink-"));
    const outside = path.join(outsideDir, "outside");
    try {
      fs.linkSync(target, outside);
      const before = fs.readFileSync(outside);
      expect(() => readTrace(root, "run-a")).toThrow("UNSAFE_PATH");
      expect(() => appendTrace(root, event(2, first.fingerprint), first)).toThrow("UNSAFE_PATH");
      expect(fs.readFileSync(outside)).toEqual(before);
    } finally { fs.rmSync(outsideDir, { recursive: true, force: true }); }
  });

  it("reports an interrupted checkpoint update, retaining committed event bytes without silent repair", () => {
    const first = appendTrace(root, event(), empty);
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith(".head.json")) throw new Error("injected checkpoint failure");
      rename(from, to);
    });
    expect(() => appendTrace(root, event(2, first.fingerprint), first)).toThrow("PACTILE_TRACE_IO_FAILURE");
    vi.restoreAllMocks();
    const retained = fs.readFileSync(log, "utf8");
    expect(retained.split("\n").filter(Boolean)).toHaveLength(2);
    expect(() => readTrace(root, "run-a")).toThrow("CHECKPOINT_MISMATCH");
    expect(() => appendTrace(root, event(2, first.fingerprint), first)).toThrow("CHECKPOINT_MISMATCH");
    expect(fs.readFileSync(log, "utf8")).toBe(retained);
    expect(fs.existsSync(`${log}.lock`)).toBe(false);
  });

  it("F3 redacts non-TraceError read and cleanup failures without claiming append success", () => {
    const privateMessage = `private-io-secret:${root}`;
    vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw Object.assign(new Error(privateMessage), { name: privateMessage, code: privateMessage }); });
    let caught: unknown;
    try { readTrace(root, "run-a"); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ name: "TraceError", code: "io-failure", message: "PACTILE_TRACE_IO_FAILURE" });
    expect(JSON.stringify(caught)).not.toContain(privateMessage);
    vi.restoreAllMocks();
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      if (String(target).endsWith(".lock")) throw new Error(privateMessage);
      unlink(target);
    });
    expect(() => appendTrace(root, event(), empty)).toThrow("PACTILE_TRACE_IO_FAILURE");
    vi.restoreAllMocks();
    expect(fs.existsSync(`${log}.lock`)).toBe(true);
    expect(() => readTrace(root, "run-a")).toThrow("LOCKED");
  });

  const builtModule = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dist/pactile/trace-runtime/index.js");
  it.skipIf(!fs.existsSync(builtModule))("allows exactly one winner when separate processes append against the same head", async () => {
    const script = `import { appendTrace } from ${JSON.stringify(pathToFileURL(builtModule).href)};
      try { appendTrace(${JSON.stringify(root)}, ${JSON.stringify(event())}, {sequence:0,fingerprint:null}); process.stdout.write('appended'); }
      catch(e) { process.stdout.write(e.code ?? 'unexpected'); }`;
    const run = (): Promise<string> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
      let output = "";
      child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`child failed: ${code}`)));
    });
    const results = await Promise.all(Array.from({ length: 6 }, run));
    expect(results.filter((result) => result === "appended")).toHaveLength(1);
    expect(results.every((result) => ["appended", "locked", "cas-mismatch"].includes(result))).toBe(true);
    expect(readTrace(root, "run-a").events).toHaveLength(1);
  });
});
