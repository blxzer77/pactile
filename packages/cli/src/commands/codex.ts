import path from "node:path";
import { codexBridgeStatus, prepareCodexRequest, recordCodexReceipt,
  type CodexBridgeRole, type CodexBridgeTool } from "../pactile/codex/bridge.js";

function option(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function required(value: string | undefined, label: string): string {
  if (!value || value.startsWith("--")) throw new Error(`${label} is required`);
  return value;
}

const tools: Record<string, CodexBridgeTool> = {
  create: "create_thread", message: "send_message_to_thread", wait: "wait_threads", read: "read_thread",
};

/** The desktop host invokes the native tool; Node owns request and receipt evidence. */
export function runCodexCli(argv: string[], root = process.cwd()): number {
  const [operation, reference, ...args] = argv;
  try {
    const task = required(reference, "task");
    if (operation === "status") {
      console.log(JSON.stringify(codexBridgeStatus(root, task), null, 2));
      return 0;
    }
    if (operation === "receipt") {
      const requestId = required(args[0], "request id");
      const resultFile = path.resolve(root, required(option(args, "--result-file"), "--result-file"));
      console.log(JSON.stringify(recordCodexReceipt(root, task, requestId, resultFile), null, 2));
      return 0;
    }
    if (operation !== "prepare") throw new Error("Usage: pactile codex <prepare|receipt|status> <task> ...");
    const toolName = required(option(args, "--tool"), "--tool create|message|wait|read");
    const tool = tools[toolName];
    if (!tool) throw new Error("--tool must be create, message, wait or read");
    const promptFile = option(args, "--prompt-file");
    const timeout = option(args, "--timeout-ms");
    const request = prepareCodexRequest({ root, task, tool,
      role: option(args, "--role") as CodexBridgeRole | undefined,
      threadId: option(args, "--thread-id"),
      promptFile: promptFile ? path.resolve(root, promptFile) : undefined,
      projectId: option(args, "--project-id"),
      targetType: option(args, "--target") as "project" | "projectless" | undefined,
      environment: option(args, "--environment") as "local" | "worktree" | undefined,
      title: option(args, "--title"), timeoutMs: timeout === undefined ? undefined : Number(timeout),
    });
    console.log(JSON.stringify(request, null, 2));
    return 0;
  } catch (error) {
    console.error(`Codex bridge: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
