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
let sessionId = option("--session-id", "pi-checker");
const malformedMode = option("--malformed", "none");
const switchSessionOnSecond = process.argv.includes("--switch-session-on-second");
const delayCorrectionGetStateMs = Number(
  option("--delay-correction-get-state-ms", "0"),
);
const maliciousMetadata = process.argv.includes("--malicious-metadata");
const switchSessionBeforeCorrection = process.argv.includes(
  "--switch-session-before-correction",
);
const cancelCorrectionPreflight = process.argv.includes(
  "--cancel-correction-preflight",
);
const cancelFile = option("--cancel-file");
const latestFile = option("--latest-file");
const metadataCanary = "private-metadata-canary-74192";
let promptCount = 0;
let stateRequestCount = 0;
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
    stateRequestCount += 1;
    if (stateRequestCount === 4 && switchSessionBeforeCorrection)
      sessionId = "switched-before-correction";
    if (stateRequestCount === 4 && cancelCorrectionPreflight) {
      const latest: unknown = JSON.parse(fs.readFileSync(latestFile, "utf8"));
      if (!isRecord(latest) || typeof latest.run_id !== "string") {
        throw new Error("The fake Pi Review fixture could not identify its run.");
      }
      fs.writeFileSync(
        cancelFile,
        `${JSON.stringify({ request_id: "cancel-correction-preflight", run_id: latest.run_id })}\n`,
        { mode: 0o600 },
      );
    }
    const reportedSessionFile = maliciousMetadata
      ? `${sessionDirectory}/${metadataCanary}`
      : sessionFile;
    const data = { isStreaming, sessionId, sessionFile: reportedSessionFile };
    if (stateRequestCount === 4 && delayCorrectionGetStateMs > 0) {
      setTimeout(() => reply({ data }), delayCorrectionGetStateMs);
    } else {
      reply({ data });
    }
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
  promptCount += 1;
  if (switchSessionOnSecond && promptCount === 2) sessionId = "switched-session";
  fs.appendFileSync(sessionFile, `${message}\n`);
  reply();
  isStreaming = true;
  if (malformedMode === "hang-after-first" && promptCount >= 2) return;
  writeMessage({ type: "agent_start" });
  if (maliciousMetadata) {
    writeMessage({
      type: `provider-event-${metadataCanary}`,
      toolName: `extension-${metadataCanary}`,
    });
    writeMessage({
      type: "message_end",
      message: {
        role: metadataCanary,
        stopReason: metadataCanary,
      },
    });
  }

  if (message.includes("TEST_MUTATE_CANDIDATE")) {
    fs.writeFileSync(
      path.join(process.cwd(), "result.txt"),
      "changed during Pi Check\n",
    );
  }
  if (message.includes("TEST_NON_REGULAR_CANDIDATE")) {
    const candidate = path.join(process.cwd(), "result.txt");
    fs.rmSync(candidate, { force: true });
    fs.mkdirSync(candidate);
  }
  if (message.includes("TEST_TOOL_ERROR")) {
    writeMessage({
      type: "tool_execution_end",
      toolName: "read",
      isError: true,
    });
  }

  const malformed = malformedMode === "always" ||
    ((malformedMode === "first" ||
      malformedMode === "first-sensitive" ||
      malformedMode === "hang-after-first") &&
      promptCount === 1);
  const text = malformed
    ? malformedMode === "first-sensitive"
      ? "<|DSML|>analysis <|tool_call|>inspect_candidate() token=private-provider-response-secret-1234567890 ghs_abcdefghijklmnop ghs_abcdefghijk- ghp_abcdefghijk_ Bearer abcdefghijk+ Bearer abcdefghijk/"
      : "<|DSML|>analysis <|tool_call|>inspect_candidate() <|tool_result|> unavailable"
    : JSON.stringify(reviewResult);
  writeMessage({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
        ...(maliciousMetadata ? { errorMessage: metadataCanary } : {}),
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
