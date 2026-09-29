import fs from "node:fs";
import { fakePiRolePolicyHandshake } from "./pi-role-policy-probe.js";
import path from "node:path";
import { createHash } from "node:crypto";

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
const firstPromptMarker = option("--first-prompt-marker");
const switchSessionOnSecond = process.argv.includes(
  "--switch-session-on-second",
);
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

// Simulate the native extension's documented result metadata on this fake RPC host.
function toolAnnotation(id: string, outcome: "error" | "success"): { type: "text"; text: string } {
  return { type: "text", text: `Pactile tool evidence: ${JSON.stringify({ toolCallId: id, reviewToolRef: `pactile-call-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`, outcome })}` };
}

function failedProbe(message: string): { command: string; text: string } {
  const hardCommands: Record<string, string> = {
    TEST_FILTERED_VALIDATION_FAILURE: "pnpm --filter @blxzer/pactile test; which node python3 rg",
    TEST_WRAPPED_VALIDATION_FAILURE: "sh -lc 'pnpm --filter @blxzer/pactile test'; which node python3 rg",
    TEST_ENV_VALIDATION_FAILURE: "CI=1 pnpm test; which node python3 rg",
    TEST_GREP_LATE_ASSERTION_FAILURE: "grep --regexp=marker -q result.txt; which node python3 rg",
    TEST_GIT_LATE_ASSERTION_FAILURE: "git check-ignore --verbose -q result.txt; which node python3 rg",
    TEST_GREP_SILENT_ASSERTION_FAILURE: "grep --silent marker result.txt; which node python3 rg",
    TEST_GREP_ABBREVIATED_ASSERTION_FAILURE: "grep --qui marker result.txt; which node python3 rg",
  };
  for (const [marker, command] of Object.entries(hardCommands)) {
    if (message.includes(marker)) return { command, text: "Command exited with code 1" };
  }
  if (message.includes("TEST_REQUIRED_VALIDATION_FAILURE"))
    return { command: "pnpm exec vitest run tests/check.test.ts", text: "cannot create /tmp/p47_modified.txt: Read-only file system" };
  if (message.includes("TEST_VALIDATION_BEFORE_DISCOVERY"))
    return { command: "pnpm exec vitest run tests/check.test.ts; echo discovery; which node python3 rg", text: "Command exited with code 1" };
  if (message.includes("TEST_MISSING_DISCOVERY_TOOL"))
    return { command: 'pwd; ls -la /workspace 2>&1 | head -40; echo "--- node:"; node --version; echo "--- which:"; which node git bash python3 rg 2>&1', text: "/workspace\n/usr/local/bin/node\n/usr/bin/git\n/usr/bin/bash\nCommand exited with code 1" };
  if (message.includes("TEST_GIT_EMPTY_QUERY"))
    return { command: 'cd /workspace && echo "=== fixtures ==="; cat packages/cli/test/fixtures/pactile/.gitignore; echo "=== check-ignore fixture path ==="; git check-ignore -v packages/cli/test/fixtures/pactile/p36-legacy-task-source/input/.pactile/tasks/08-21-parent/prd.md 2>&1', text: "=== fixtures ===\n# inert fixture bytes\n=== check-ignore fixture path ===\nCommand exited with code 1" };
  if (message.includes("TEST_GIT_ASSERTION_FAILURE"))
    return { command: "git check-ignore -q required-ignored-file", text: "Command exited with code 1" };
  if (message.includes("TEST_READONLY_PROBE_FAILURE"))
    return { command: 'ls /workspace/node_modules/.bin/ 2>/dev/null | head -30; echo "--- pkg cli bin:"; ls /workspace/packages/cli/node_modules/.bin/ 2>/dev/null | head -30; echo "--- vitest dirs:"; ls -d /workspace/node_modules/vitest /workspace/packages/cli/node_modules/vitest 2>/dev/null', text: "--- pkg cli bin:\n--- vitest dirs:\nCommand exited with code 2" };
  if (message.includes("TEST_EMPTY_QUERY_FAILURE"))
    return { command: 'sed -n \'1,200p\' /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js | grep -n "isError\\\\|exitCode\\\\|exit code" | head -20; echo "=== context ==="; grep -n "isError" /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js', text: "58:if (result.exitCode !== 0)\n=== context ===\nCommand exited with code 1" };
  if (message.includes("TEST_GREP_ASSERTION_FAILURE"))
    return { command: "grep -q required-marker result.txt; echo discovery; which node python3 rg", text: "Command exited with code 1" };
  if (message.includes("TEST_ASSERTION_FAILURE"))
    return { command: "node required-check.mjs", text: "AssertionError [ERR_ASSERTION]: required marker missing\nCommand exited with code 1" };
  return { command: "printf probe > /tmp/p47_modified.txt", text: "cannot create /tmp/p47_modified.txt: Read-only file system" };
}

function handleLine(line: string): void {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error(
      "The fake Pi Review fixture received an invalid RPC request.",
    );
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
    stateRequestCount += 1;
    if (stateRequestCount === 4 && switchSessionBeforeCorrection)
      sessionId = "switched-before-correction";
    if (stateRequestCount === 4 && cancelCorrectionPreflight) {
      const latest: unknown = JSON.parse(fs.readFileSync(latestFile, "utf8"));
      if (!isRecord(latest) || typeof latest.run_id !== "string") {
        throw new Error(
          "The fake Pi Review fixture could not identify its run.",
        );
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
  if (promptCount === 1 && firstPromptMarker)
    fs.writeFileSync(firstPromptMarker, "started\n", { mode: 0o600 });
  if (switchSessionOnSecond && promptCount === 2)
    sessionId = "switched-session";
  fs.appendFileSync(sessionFile, `${message}\n`);
  reply();
  isStreaming = true;
  if (
    (malformedMode === "hang-first" && promptCount === 1) ||
    (malformedMode === "hang-after-first" && promptCount >= 2)
  )
    return;
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
  if (message.includes("TEST_RECOVERED_TOOL_ERROR")) {
    const failedId = message.includes("TEST_NATIVE_TOOL_ID") ? "call_native_0|fc_native_0" : "explore-failed";
    const recoveredId = message.includes("TEST_NATIVE_TOOL_ID") ? "call_native_0|fc_native_1" : "explore-recovered";
    const failed = failedProbe(message);
    writeMessage({
      type: "tool_execution_start",
      toolCallId: failedId,
      toolName: "bash",
      args: { command: failed.command },
    });
    writeMessage({
      type: "tool_execution_end",
      toolCallId: failedId,
      toolName: "bash",
      isError: true,
      result: {
        content: [
          {
            type: "text",
            text: failed.text,
          },
          toolAnnotation(failedId, "error"),
        ],
      },
    });
    if (!message.includes("TEST_INCOMPLETE_RECOVERY"))
      writeMessage({
        type: "tool_execution_start",
        toolCallId: recoveredId,
        toolName: "bash",
        args: { command: "node -e 'process.stdout.write(JSON.stringify([]))'" },
      });
    writeMessage({
      type: "tool_execution_end",
      toolCallId: recoveredId,
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "[]" }, toolAnnotation(recoveredId, "success")] },
    });
  }
  if (message.includes("TEST_EXTENSION_ERROR"))
    writeMessage({
      type: "extension_error",
      error: "fixture extension failure",
    });

  const malformed =
    malformedMode === "always" ||
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
        stopReason: message.includes("TEST_PROVIDER_ERROR") ? "error" : "stop",
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
