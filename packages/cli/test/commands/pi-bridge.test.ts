import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTaskCli } from "../../src/commands/task.js";
import { runPiCli } from "../../src/commands/pi.js";
import { PiTaskBridge } from "../../src/pactile/pi/bridge.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(approve = true): { root: string; script: string; task: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-pi-rpc-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".pactile", "tasks", "locale", "en"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pactile", "tasks", "locale", "en", "default-prd.md"), "# {title}\n{goal}\n");
  fs.writeFileSync(path.join(root, ".pactile", "config.yaml"), "artifact_locale: en\n");
  fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=tester\n");
  expect(runTaskCli(["create", "Pi bridge", "--slug", "pi-bridge"], root)).toBe(0);
  const task = fs.readdirSync(path.join(root, ".pactile", "tasks")).find((entry) => entry.endsWith("-pi-bridge"));
  if (!task) throw new Error("task fixture missing");
  const dir = path.join(root, ".pactile", "tasks", task);
  fs.writeFileSync(path.join(dir, "design.md"), "# Design\nPi worker.\n");
  fs.writeFileSync(path.join(dir, "implement.md"), [
    "execution_mode: worker", "isolation: main-worktree", "verification_profile: standard",
    "retrieval_profile: exact-only", "optional_capabilities: []", "quality_gates:", "  mode: profile", "",
  ].join("\n"));
  if (approve) expect(runTaskCli(["start-execution", task, "--approved"], root)).toBe(0);
  const script = path.join(root, "fake-pi.mjs");
  fs.writeFileSync(script, `
import fs from 'node:fs';
import path from 'node:path';
const session = path.join(process.env.PI_CODING_AGENT_SESSION_DIR, 'fake-session.jsonl');
fs.mkdirSync(path.dirname(session), {recursive:true});
fs.writeFileSync(session, 'session\\n');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk.toString();
  let at;
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0,at); buffer = buffer.slice(at+1);
    if (!line) continue;
    const request = JSON.parse(line);
    const reply = data => process.stdout.write(JSON.stringify({id:request.id,type:'response',command:request.type,success:true,...data})+'\\n');
    if (request.type === 'get_state') reply({data:{isStreaming:false,sessionId:'fake-id',sessionFile:session}});
    else if (request.type === 'switch_session') reply({data:{cancelled:false}});
    else if (request.type === 'prompt') {
      fs.appendFileSync(session, request.message+'\\n');
      reply();
      process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n');
      if (request.message.includes('CRASH')) process.exit(7);
      if (request.message.includes('HANG')) continue;
      if (request.message.includes('MODEL_ERROR')) {
        const message = {role:'assistant',content:[],stopReason:'error',errorMessage:'402 Insufficient Balance'};
        process.stdout.write(JSON.stringify({type:'agent_end',messages:[message]})+'\\n');
        continue;
      }
      if (request.message.includes('TOOL_ERROR')) process.stdout.write(JSON.stringify({type:'tool_execution_end',toolName:'bash',isError:true})+'\\n');
      const message = {role:'assistant',content:[{type:'text',text:'Work reported. secret=hidden-value'}],stopReason:'stop'};
      process.stdout.write(JSON.stringify({type:'agent_end',messages:[message]})+'\\n');
    } else if (request.type === 'abort') reply();
  }
});
`);
  return { root, script, task };
}

describe("Pi native RPC task bridge", () => {
  it("rejects a Planning task without creating Pi state", async () => {
    const { root, script, task } = fixture(false);
    const bridge = new PiTaskBridge(root, { command: process.execPath, args: [script] });
    try {
      await expect(bridge.run({ root, task, role: "implement", prompt: "do work", timeoutMs: 1000 })).rejects.toThrow("approved task in Kernel Execute phase");
      expect(fs.existsSync(path.join(root, ".pactile", "tasks", task, "pi-bridge"))).toBe(false);
    } finally { await bridge.close(); }
  });

  it("requires execution approval and a worker contract before launch", async () => {
    const { root, script, task } = fixture();
    const bridge = new PiTaskBridge(root, { command: process.execPath, args: [script] });
    try {
      const dir = path.join(root, ".pactile", "tasks", task);
      fs.writeFileSync(path.join(dir, "implement.md"), "execution_mode: inline\n");
      await expect(bridge.run({ root, task, role: "implement", prompt: "do work", timeoutMs: 1000 })).rejects.toThrow("Execution contract changed after approval");
      expect(fs.existsSync(path.join(dir, "pi-bridge"))).toBe(false);
    } finally { await bridge.close(); }
  });

  it("reuses one process, records safe event evidence, and leaves Kernel Execute untouched", async () => {
    const { root, script, task } = fixture();
    const bridge = new PiTaskBridge(root, { command: process.execPath, args: [script] });
    try {
      const progress: string[] = [];
      const first = await bridge.run({ root, task, role: "implement", prompt: "FIRST", timeoutMs: 5000, onProgress: (event) => progress.push(String(event.type)) });
      expect(first).toMatchObject({ outcome: "settled", process_mode: "cold", session_id: "fake-id" });
      expect(progress).toEqual(["agent_start", "agent_end"]);
      if (!first.session_file) throw new Error("Pi session file missing");
      expect(fs.readFileSync(first.session_file, "utf8")).toContain("execution_mode: worker");
      const second = await bridge.run({ root, task, role: "implement", prompt: "SECOND", timeoutMs: 5000 });
      expect(second).toMatchObject({ outcome: "settled", process_mode: "warm", startup_ms: 0 });
      const dir = path.join(root, ".pactile", "tasks", task);
      const eventText = fs.readFileSync(path.join(dir, "pi-bridge", "events", `${second.run_id}.jsonl`), "utf8");
      expect(eventText).toContain("agent_end");
      expect(eventText).not.toContain("hidden-value");
      if (!second.result_file) throw new Error("Pi result file missing");
      expect(fs.readFileSync(path.join(dir, second.result_file), "utf8")).toContain("secret=[redacted]");
      expect(JSON.parse(fs.readFileSync(path.join(dir, "kernel.json"), "utf8")).phase).toBe("execute");
      expect(await runPiCli(["status", task], root)).toBe(0);
    } finally { await bridge.close(); }
  });

  it("distinguishes tool errors, unexpected exit, timeout, and external cancellation", async () => {
    const { root, script, task } = fixture();
    const launch = { command: process.execPath, args: [script] };
    const review = new PiTaskBridge(root, launch);
    expect((await review.run({ root, task, role: "implement", prompt: "TOOL_ERROR", timeoutMs: 5000 })).outcome).toBe("needs_review");
    await review.close();
    const provider = new PiTaskBridge(root, launch);
    expect(await provider.run({ root, task, role: "implement", prompt: "MODEL_ERROR", timeoutMs: 5000 }))
      .toMatchObject({ outcome: "needs_review", reason: "Pi stopReason=error; 402 Insufficient Balance" });
    await provider.close();
    const crash = new PiTaskBridge(root, launch);
    expect((await crash.run({ root, task, role: "implement", prompt: "CRASH", timeoutMs: 5000 })).outcome).toBe("interrupted");
    await crash.close();
    const timeout = new PiTaskBridge(root, launch);
    expect((await timeout.run({ root, task, role: "implement", prompt: "HANG", timeoutMs: 1000 })).outcome).toBe("timed_out");
    await timeout.close();
    const cancel = new PiTaskBridge(root, launch);
    const running = cancel.run({ root, task, role: "implement", prompt: "HANG", timeoutMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await runPiCli(["cancel", task], root)).toBe(0);
    expect((await running).outcome).toBe("cancelled");
    await cancel.close();
  });

  it("marks an orphaned run interrupted before resuming its task session", async () => {
    const { root, script, task } = fixture();
    const launch = { command: process.execPath, args: [script] };
    const first = new PiTaskBridge(root, launch);
    const prior = await first.run({ root, task, role: "implement", prompt: "FIRST", timeoutMs: 5000 });
    await first.close();
    const evidence = path.join(root, ".pactile", "tasks", task, "pi-bridge");
    const stale = { ...prior, outcome: "running", ended_at: null };
    fs.writeFileSync(path.join(evidence, "latest.json"), JSON.stringify(stale));
    fs.writeFileSync(path.join(evidence, "active.json"), JSON.stringify({ parent_pid: 999999999, child_pid: 999999998, run_id: prior.run_id }));
    const resumed = new PiTaskBridge(root, launch);
    try {
      const result = await resumed.run({ root, task, role: "implement", prompt: "SECOND", timeoutMs: 5000, resume: true });
      expect(result.outcome).toBe("settled");
      const recovered = JSON.parse(fs.readFileSync(path.join(evidence, "runs", `${prior.run_id}.json`), "utf8"));
      expect(recovered.outcome).toBe("interrupted");
    } finally { await resumed.close(); }
  });
});
