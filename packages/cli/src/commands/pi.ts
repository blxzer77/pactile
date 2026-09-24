import fs from "node:fs";
import path from "node:path";
import { PiTaskBridge, type PiRunRecord } from "../pactile/pi/bridge.js";
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

/** Native Pi RPC, bound to a Pactile task and its recorded execution approval. */
export async function runPiCli(argv: string[], root = process.cwd()): Promise<number> {
  const [operation, reference, ...args] = argv;
  try {
    if (operation === "status") {
      const record = readRecord(path.join(evidenceDir(root, required(reference, "task")), "latest.json"));
      if (!record) throw new Error("No Pi run has been recorded for this task");
      console.log(JSON.stringify(record, null, 2));
      return 0;
    }
    if (operation === "cancel") {
      const evidence = evidenceDir(root, required(reference, "task"));
      const record = readRecord(path.join(evidence, "latest.json"));
      if (record?.outcome !== "running") throw new Error("No active Pi run to cancel");
      fs.writeFileSync(path.join(evidence, "cancel-request.json"), `${JSON.stringify({ run_id: record.run_id, requested_at: new Date().toISOString() })}\n`, { mode: 0o600 });
      console.log(`Cancellation requested for Pi run ${record.run_id}`);
      return 0;
    }
    if (operation !== "run") throw new Error("Usage: pactile pi <run|status|cancel> <task> ...");
    const task = required(reference, "task");
    const role = required(option(args, "--role"), "--role");
    if (role !== "implement" && role !== "check" && role !== "research") throw new Error("--role must be implement, check, or research");
    const promptFiles = args.flatMap((arg, index) => arg === "--prompt-file" ? [path.resolve(root, required(args[index + 1], "--prompt-file"))] : []);
    if (!promptFiles.length) throw new Error("--prompt-file is required");
    for (const file of promptFiles) if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`Prompt file not found: ${file}`);
    const timeoutMs = option(args, "--timeout-ms") ? Number(option(args, "--timeout-ms")) : 30 * 60_000;
    const controller = new AbortController();
    const onSignal = (): void => controller.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    const bridge = new PiTaskBridge(root);
    try {
      for (const [index, file] of promptFiles.entries()) {
        const result = await bridge.run({
          root, task, role, prompt: fs.readFileSync(file, "utf8"), timeoutMs,
          resume: index === 0 && args.includes("--resume"), signal: controller.signal,
          onProgress: (event) => {
            if (["agent_start", "agent_end", "agent_settled", "tool_execution_start", "tool_execution_end"].includes(String(event.type))) {
              console.error(`[pi] ${event.type}${event.tool ? ` ${event.tool}` : ""}${event.is_error ? " ERROR" : ""}`);
            }
          },
        });
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
    console.error(`Pi bridge: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
