import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PiRpcClient } from "../../src/pactile/pi/rpc.js";

const roots: string[] = [];
const FAKE_PI_PROVIDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.tmp/p31-script-build/fixtures/fake-pi-provider.js",
);

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function client(args: string[] = []): PiRpcClient {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-pi-settlement-"));
  roots.push(root);
  return new PiRpcClient({
    cwd: root,
    sessionDir: path.join(root, "sessions"),
    launch: { command: process.execPath, args: [FAKE_PI_PROVIDER, ...args] },
  });
}

async function expectNoFinalAgentMessage(args: string[], expectedEvents: string[]): Promise<void> {
  const rpc = client([...args, "--response-delay-ms", "40"]);
  const eventTypes: string[] = [];
  const detach = rpc.onEvent((event) => eventTypes.push(String(event.type)));
  try {
    await rpc.start();
    await expect(rpc.prompt("missing final message", 5_000)).rejects.toThrow(
      "Pi settled without a final agent message",
    );
    expect(eventTypes).toEqual(expectedEvents);
  } finally {
    detach();
    await rpc.close();
  }
}

describe("Pi RPC prompt settlement", () => {
  it("waits through an automatic retry and returns the final agent_end messages", async () => {
    const rpc = client([
      "--retry-settlement",
      "--response-delay-ms",
      "80",
      "--result-text",
      "Final retry result",
    ]);
    const eventTypes: string[] = [];
    let settledObserved = false;
    const detach = rpc.onEvent((event) => {
      eventTypes.push(String(event.type));
      if (event.type === "agent_settled") settledObserved = true;
    });
    try {
      await rpc.start();
      let settledAtPromptReturn = false;
      const result = await rpc
        .prompt("retry until settled", 5_000)
        .then((value) => {
          settledAtPromptReturn = settledObserved;
          return value;
        });

      expect(settledAtPromptReturn).toBe(true);
      expect(eventTypes).toEqual([
        "agent_start",
        "agent_end",
        "auto_retry_start",
        "agent_end",
        "agent_settled",
      ]);
      expect(result.event).toMatchObject({
        type: "agent_end",
        willRetry: false,
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Final retry result" }],
            stopReason: "stop",
          },
        ],
      });
    } finally {
      detach();
      await rpc.close();
    }
  });

  it("fails closed when settled arrives without an agent_end", async () => {
    await expectNoFinalAgentMessage(
      ["--settle-without-agent-end"],
      ["agent_start", "agent_settled"],
    );
  });

  it("fails closed when a retry attempt settles without a final agent_end", async () => {
    await expectNoFinalAgentMessage(
      ["--retry-settles-without-final-agent-end"],
      ["agent_start", "agent_end", "auto_retry_start", "agent_start", "agent_settled"],
    );
  });

  it("invalidates an earlier agent_end when a new prompt segment starts", async () => {
    await expectNoFinalAgentMessage(
      ["--restart-settles-without-final-agent-end"],
      ["agent_start", "agent_end", "agent_start", "agent_settled"],
    );
  });
});
