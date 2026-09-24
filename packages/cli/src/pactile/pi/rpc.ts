import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

type RpcObject = Record<string, unknown>;

export interface PiRpcLaunch {
  command: string;
  args: string[];
}

export interface PiRpcOptions {
  cwd: string;
  sessionDir: string;
  launch?: PiRpcLaunch;
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: RpcObject) => void;
  readOnly?: boolean;
}

/** Pi's native RPC is strict LF-delimited JSON, including on Windows. */
export class PiRpcClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, { resolve: (value: RpcObject) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private listeners = new Set<(event: RpcObject) => void>();
  private ended: Error | null = null;
  private startupMs = 0;

  constructor(private readonly options: PiRpcOptions) {
    if (options.onEvent) this.listeners.add(options.onEvent);
  }

  get pid(): number | undefined { return this.child?.pid; }

  get isStarted(): boolean { return this.child !== null && this.ended === null; }

  onEvent(listener: (event: RpcObject) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.ended = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.listeners) {
      try { listener({ type: "transport_error", error: error.message }); } catch { /* Failure is already terminal. */ }
    }
  }

  private read(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      if (newline > 8 * 1024 * 1024) {
        this.fail(new Error("Pi RPC record exceeds 8 MiB"));
        this.child?.kill();
        return;
      }
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        let message: RpcObject;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("non-object RPC record");
          message = parsed as RpcObject;
        } catch {
          this.fail(new Error("Pi emitted invalid JSONL"));
          this.child?.kill();
          return;
        }
        const id = message.id;
        if (message.type === "response" && typeof id === "string" && this.pending.has(id)) {
          const pending = this.pending.get(id);
          this.pending.delete(id);
          if (pending) {
            clearTimeout(pending.timer);
            pending.resolve(message);
          }
        } else {
          for (const listener of this.listeners) {
            try { listener(message); }
            catch (error) {
              this.fail(new Error(`Pi RPC event recording failed: ${error instanceof Error ? error.message : String(error)}`));
              this.child?.kill();
              return;
            }
          }
        }
      }
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.fail(new Error("Pi RPC record exceeds 8 MiB"));
      this.child?.kill();
    }
  }

  async start(): Promise<number> {
    if (this.isStarted) return 0;
    if (this.child) throw new Error("Pi RPC process cannot be restarted after exit");
    fs.mkdirSync(this.options.sessionDir, { recursive: true });
    const launch = this.options.launch ?? (process.platform === "win32"
      ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `pi.cmd --mode rpc${this.options.readOnly ? " --tools read,grep,find,ls" : ""}`] }
      : { command: "pi", args: ["--mode", "rpc", ...(this.options.readOnly ? ["--tools", "read,grep,find,ls"] : [])] });
    const started = performance.now();
    const child = spawn(launch.command, launch.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env, PI_CODING_AGENT_SESSION_DIR: this.options.sessionDir },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.on("data", (data: Buffer) => this.read(data));
    // Stderr may contain provider secrets or prompt text; retain no raw stderr.
    child.stderr.resume();
    child.on("error", (error) => this.fail(new Error(`Pi RPC launch failed: ${error.message}`)));
    child.on("exit", (code, signal) => this.fail(new Error(`Pi RPC exited (code=${code ?? "null"}, signal=${signal ?? "none"})`)));
    await this.request("get_state", {}, 30_000);
    this.startupMs = Math.round(performance.now() - started);
    return this.startupMs;
  }

  async request(type: string, fields: RpcObject = {}, timeoutMs = 15_000): Promise<RpcObject> {
    if (!this.child || this.ended) throw this.ended ?? new Error("Pi RPC is not started");
    const id = randomUUID();
    const response = new Promise<RpcObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC ${type} response timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(id); }
      throw error;
    }
    const result = await response;
    if (result.success !== true) throw new Error(`Pi RPC ${type} rejected: ${String(result.error ?? "unknown error")}`);
    return result;
  }

  async state(): Promise<RpcObject> {
    const result = await this.request("get_state");
    return result.data && typeof result.data === "object" ? result.data as RpcObject : {};
  }

  async switchSession(sessionFile: string): Promise<void> {
    const result = await this.request("switch_session", { sessionPath: sessionFile });
    if ((result.data as RpcObject | undefined)?.cancelled === true) throw new Error("Pi refused session switch");
  }

  async prompt(message: string, timeoutMs: number, signal?: AbortSignal): Promise<{ event: RpcObject; firstEventMs: number | null }> {
    if (signal?.aborted) throw new Error("Pi run cancelled before dispatch");
    const began = performance.now();
    let firstEventMs: number | null = null;
    let finish!: (event: RpcObject) => void;
    let reject!: (error: Error) => void;
    const done = new Promise<RpcObject>((resolve, fail) => { finish = resolve; reject = fail; });
    // The command response can reject before completion is awaited.
    void done.catch(() => undefined);
    const listener = (event: RpcObject): void => {
      if (event.type === "transport_error") reject(new Error(String(event.error)));
      if (event.type === "agent_start" && firstEventMs === null) firstEventMs = Math.round(performance.now() - began);
      if (event.type === "agent_end" || event.type === "agent_settled") finish(event);
    };
    const abort = (): void => reject(new Error("Pi run cancelled"));
    const timer = setTimeout(() => reject(new Error("Pi run timed out")), timeoutMs);
    this.listeners.add(listener);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.request("prompt", { message }, Math.min(timeoutMs, 15_000));
      const event = await done;
      const state = await this.state();
      if (state.isStreaming === true) throw new Error("Pi emitted completion while still streaming");
      return { event, firstEventMs };
    } catch (error) {
      // Abort is best-effort. The caller closes the process if Pi does not settle.
      if (this.isStarted) void this.request("abort", {}, 2_000).catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
      this.listeners.delete(listener);
      signal?.removeEventListener("abort", abort);
    }
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    const exited = (): Promise<boolean> => new Promise((resolve) => {
      const timer = setTimeout(() => { child.removeListener("exit", onExit); resolve(false); }, 2_000);
      const onExit = (): void => { clearTimeout(timer); resolve(true); };
      child.once("exit", onExit);
    });
    if (await exited()) return;
    child.kill();
    if (!(await exited()) && child.exitCode === null && child.signalCode === null) {
      throw new Error("Pi RPC process did not stop after termination request");
    }
  }
}
