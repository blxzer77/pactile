/**
 * Test-only fake Pi RPC provider for scheduler and dispatch integration tests.
 * It is compiled from this checked fixture and is not provider acceptance evidence.
 */
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

function options(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1])
      values.push(process.argv[index + 1] as string);
  }
  return values;
}

function hasOption(name: string): boolean {
  return process.argv.includes(name);
}

const sessionDirectory = process.env.PI_CODING_AGENT_SESSION_DIR;
if (!sessionDirectory)
  throw new Error(
    "PI_CODING_AGENT_SESSION_DIR is required by the fake Pi wave fixture.",
  );

const sessionFile = path.join(
  sessionDirectory,
  option("--session-name", "session.jsonl"),
);
fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
fs.writeFileSync(sessionFile, "fake session\n");

const marker = option("--marker");
if (marker) fs.writeFileSync(marker, option("--marker-content", "started"));

const taskDir = path.dirname(path.dirname(sessionDirectory));
const taskId = path.basename(taskDir);
const startedDirectory = option("--started-directory");
const barrierSize = Number(option("--barrier-size", "0"));
const failTaskIds = new Set(options("--fail-task-id"));
const hangTaskIds = new Set(options("--hang-task-id"));

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function markStarted(): void {
  if (!startedDirectory) return;
  fs.mkdirSync(startedDirectory, { recursive: true });
  fs.writeFileSync(path.join(startedDirectory, `${taskId}.started`), "started");
}

function handleLine(line: string): void {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || typeof value.type !== "string")
    throw new Error(
      "The fake Pi wave fixture received an invalid RPC request.",
    );
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
    reply({
      data: {
        isStreaming: false,
        sessionId: option("--session-id", `fake-session-${taskId}`),
        sessionFile,
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
    writeMessage({
      id: request.id,
      type: "response",
      command: request.type,
      success: false,
      error: `Unsupported fake Pi RPC: ${request.type}`,
    });
    return;
  }

  const prompt = typeof request.message === "string" ? request.message : "";
  fs.appendFileSync(sessionFile, `${prompt}\n`);
  reply();
  writeMessage({ type: "agent_start" });

  if (hasOption("--hang") || hangTaskIds.has(taskId)) {
    markStarted();
    return;
  }

  const finish = (): void => {
    writeMessage({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: option(
                "--result-text",
                `Fake Pi provider fixture result for ${taskId}`,
              ),
            },
          ],
          stopReason: failTaskIds.has(taskId) ? "error" : "stop",
        },
      ],
    });
  };

  if (
    Number.isSafeInteger(barrierSize) &&
    barrierSize > 0 &&
    startedDirectory
  ) {
    markStarted();
    const interval = setInterval(() => {
      const startedCount = fs
        .readdirSync(startedDirectory)
        .filter((entry) => entry.endsWith(".started")).length;
      if (startedCount >= barrierSize) {
        clearInterval(interval);
        finish();
      }
    }, 5);
    return;
  }

  markStarted();
  const delay = Number(option("--response-delay-ms", "30"));
  setTimeout(finish, Number.isFinite(delay) && delay >= 0 ? delay : 30);
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
