import fs from "node:fs";
import path from "node:path";
import { fakePiRolePolicyHandshake } from "./pi-role-policy-probe.js";

interface PiRequest extends Record<string, unknown> {
  type: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function option(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

function hasOption(name: string): boolean {
  return process.argv.includes(name);
}

const sessionDirectory = process.env.PI_CODING_AGENT_SESSION_DIR;
if (!sessionDirectory) {
  throw new Error(
    "PI_CODING_AGENT_SESSION_DIR is required by the fake Pi fixture.",
  );
}

const sessionFile = path.join(
  sessionDirectory,
  option("--session-name", "session.jsonl"),
);
fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
fs.writeFileSync(sessionFile, "session\n");

const marker = option("--marker");
if (marker) fs.writeFileSync(marker, option("--marker-content", "started"));

let isStreaming = false;

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleLine(line: string): void {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("The fake Pi fixture received an invalid RPC request.");
  }
  const request = value as PiRequest;
  if (fakePiRolePolicyHandshake(request, writeMessage)) return;
  const reply = (data: Record<string, unknown> = {}) =>
    writeMessage({
      id: request.id,
      type: "response",
      command: request.type,
      success: true,
      ...data,
    });

  if (request.type === "get_state") {
    reply({
      data: {
        isStreaming,
        sessionId: option("--session-id", "fake-id"),
        sessionFile,
        launchArgs: process.argv.slice(2),
      },
    });
    return;
  }
  if (request.type === "switch_session") {
    reply({ data: { cancelled: false } });
    return;
  }
  if (request.type === "abort") {
    reply();
    return;
  }
  if (request.type !== "prompt") {
    reply({
      success: false,
      error: `Unsupported fake Pi RPC: ${request.type}`,
    });
    return;
  }

  const message = typeof request.message === "string" ? request.message : "";
  fs.appendFileSync(sessionFile, `${message}\n`);
  reply();
  isStreaming = true;
  writeMessage({ type: "agent_start" });

  if (hasOption("--settle-without-agent-end")) {
    isStreaming = false;
    writeMessage({ type: "agent_settled" });
    return;
  }

  if (message.includes("CRASH")) {
    process.exit(7);
  }
  if (hasOption("--hang") || message.includes("HANG")) return;
  if (hasOption("--retry-settlement")) {
    const delay = Number(option("--response-delay-ms", "100"));
    const waitMs = Number.isFinite(delay) && delay >= 0 ? delay : 100;
    writeMessage({
      type: "agent_end",
      willRetry: true,
      messages: [
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Temporary provider error",
        },
      ],
    });
    writeMessage({ type: "auto_retry_start" });
    setTimeout(() => {
      writeMessage({
        type: "agent_end",
        willRetry: false,
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: option("--result-text", "Final retry result") }],
            stopReason: "stop",
          },
        ],
      });
      setTimeout(() => {
        isStreaming = false;
        writeMessage({ type: "agent_settled" });
      }, waitMs);
    }, waitMs);
    return;
  }
  if (hasOption("--retry-settles-without-final-agent-end")) {
    const delay = Number(option("--response-delay-ms", "100"));
    const waitMs = Number.isFinite(delay) && delay >= 0 ? delay : 100;
    writeMessage({
      type: "agent_end",
      willRetry: true,
      messages: [
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Temporary provider error",
        },
      ],
    });
    writeMessage({ type: "auto_retry_start" });
    setTimeout(() => {
      writeMessage({ type: "agent_start" });
      setTimeout(() => {
        isStreaming = false;
        writeMessage({ type: "agent_settled" });
      }, waitMs);
    }, waitMs);
    return;
  }
  if (hasOption("--restart-settles-without-final-agent-end")) {
    const delay = Number(option("--response-delay-ms", "100"));
    const waitMs = Number.isFinite(delay) && delay >= 0 ? delay : 100;
    writeMessage({
      type: "agent_end",
      willRetry: false,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Intermediate result" }],
          stopReason: "stop",
        },
      ],
    });
    writeMessage({ type: "agent_start" });
    setTimeout(() => {
      isStreaming = false;
      writeMessage({ type: "agent_settled" });
    }, waitMs);
    return;
  }
  if (message.includes("MODEL_ERROR")) {
    writeMessage({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "402 Insufficient Balance",
        },
      ],
    });
    isStreaming = false;
    writeMessage({ type: "agent_settled" });
    return;
  }
  if (message.includes("TOOL_ERROR")) {
    writeMessage({
      type: "tool_execution_end",
      toolName: "bash",
      isError: true,
    });
  }

  const resultText = hasOption("--result-cwd")
    ? process.cwd()
    : option("--result-text", "Work reported. secret=hidden-value");
  const delay = Number(option("--response-delay-ms", "100"));
  setTimeout(
    () => {
      writeMessage({
        type: "agent_end",
        willRetry: false,
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: resultText }],
            stopReason: "stop",
          },
        ],
      });
      isStreaming = false;
      writeMessage({ type: "agent_settled" });
    },
    Number.isFinite(delay) && delay >= 0 ? delay : 100,
  );
}

let pendingInput = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  pendingInput += chunk;
  let newline = pendingInput.indexOf("\n");
  while (newline >= 0) {
    const line = pendingInput.slice(0, newline);
    pendingInput = pendingInput.slice(newline + 1);
    if (line) handleLine(line);
    newline = pendingInput.indexOf("\n");
  }
});
