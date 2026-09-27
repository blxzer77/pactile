import fs from "node:fs";
import path from "node:path";

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

const sessionDirectory = process.env.PI_CODING_AGENT_SESSION_DIR;
if (!sessionDirectory) {
  throw new Error(
    "PI_CODING_AGENT_SESSION_DIR is required by the fake Pi Review fixture.",
  );
}

const resultFile = option("--result-file");
if (!resultFile) {
  throw new Error("--result-file is required by the fake Pi Review fixture.");
}

const sessionFile = path.join(sessionDirectory, "fake-review-session.jsonl");
fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
fs.writeFileSync(sessionFile, "session\n");

const reviewResult: unknown = JSON.parse(fs.readFileSync(resultFile, "utf8"));
const sessionId = option("--session-id", "pi-checker");
let isStreaming = false;

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleLine(line: string): void {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error(
      "The fake Pi Review fixture received an invalid RPC request.",
    );
  }

  const request = value as PiRequest;
  const reply = (data: Record<string, unknown> = {}) =>
    writeMessage({
      id: request.id,
      type: "response",
      command: request.type,
      success: true,
      ...data,
    });

  if (request.type === "get_state") {
    reply({ data: { isStreaming, sessionId, sessionFile } });
    return;
  }
  if (request.type === "switch_session" || request.type === "abort") {
    reply({ data: { cancelled: false } });
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

  if (message.includes("TEST_MUTATE_CANDIDATE")) {
    fs.writeFileSync(
      path.join(process.cwd(), "result.txt"),
      "changed during Pi Check\n",
    );
  }
  if (message.includes("TEST_TOOL_ERROR")) {
    writeMessage({
      type: "tool_execution_end",
      toolName: "read",
      isError: true,
    });
  }

  const text = message.includes("TEST_MALFORMED")
    ? "not-json"
    : JSON.stringify(reviewResult);
  writeMessage({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
      },
    ],
  });
  isStreaming = false;
  writeMessage({ type: "agent_settled" });
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
process.stdin.on("end", () => process.exit(0));
