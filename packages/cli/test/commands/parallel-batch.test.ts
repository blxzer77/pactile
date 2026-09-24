import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTaskCli } from "../../src/commands/task.js";
import { parallelStatus, runParallelBatch } from "../../src/pactile/parallel/batch.js";
import { reserveParallelChild } from "../../src/pactile/parallel/policy.js";
import { readTaskMap, writeTaskMap } from "../../src/pactile/task/task-map.js";
import { prepareCodexRequest, recordCodexReceipt } from "../../src/pactile/codex/bridge.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(worktree = false, baseBranch = false): { root: string; parent: string; children: string[]; manifest: string; script: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-parallel-"));
  roots.push(root);
  const tasks = path.join(root, ".pactile", "tasks");
  fs.mkdirSync(path.join(tasks, "locale", "en"), { recursive: true });
  fs.writeFileSync(path.join(tasks, "locale", "en", "default-prd.md"), "# {title}\n{goal}\n");
  fs.writeFileSync(path.join(root, ".pactile", "config.yaml"), "artifact_locale: en\n");
  fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=tester\n");
  expect(runTaskCli(["create", "Parent", "--slug", "parallel-parent"], root)).toBe(0);
  const parent = fs.readdirSync(tasks).find((name) => name.endsWith("-parallel-parent")) ?? "";
  const children: string[] = [];
  for (const slug of ["alpha", "beta", "gamma"]) {
    expect(runTaskCli(["create", slug, "--slug", slug, "--parent", parent], root)).toBe(0);
    const child = fs.readdirSync(tasks).find((name) => name.endsWith(`-${slug}`)) ?? "";
    const dir = path.join(tasks, child);
    fs.writeFileSync(path.join(dir, "design.md"), "# Design\nIndependent worker.\n");
    fs.writeFileSync(path.join(dir, "implement.md"), `execution_mode: worker\nisolation: ${worktree && slug === "alpha" ? "git-worktree" : "main-worktree"}\nverification_profile: standard\nretrieval_profile: exact-only\noptional_capabilities: []\nquality_gates:\n  mode: profile\n`);
    if (baseBranch && slug === "alpha") expect(runTaskCli(["set-base-branch", child, "develop"], root)).toBe(0);
    expect(runTaskCli(["start-execution", child, "--approved"], root)).toBe(0);
    children.push(child);
  }
  const parentDir = path.join(tasks, parent);
  const { data, body } = readTaskMap(parentDir);
  if (!data) throw new Error("Missing task map");
  data.parallel_limit = 2;
  data.children.forEach((child, index) => { child.touches = index === 2 ? ["src/alpha"] : [`src/${index === 0 ? "alpha" : "beta"}`]; });
  writeTaskMap(parentDir, data, body);
  const manifest = path.join(root, "parallel.json");
  const items = children.map((child) => {
    const prompt = path.join(root, `${child}.md`);
    fs.writeFileSync(prompt, `Implement ${child}.`);
    return { task: child, prompt_file: prompt, review_cost: "low" };
  });
  fs.writeFileSync(manifest, JSON.stringify({ schema_version: 1, limit: 2, children: items }));
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
    else if (request.type === 'prompt') {
      reply();
      process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n');
      setTimeout(() => {
        const message = {role:'assistant',content:[{type:'text',text:process.cwd()}],stopReason:'stop'};
        process.stdout.write(JSON.stringify({type:'agent_end',messages:[message]})+'\\n');
      }, 250);
    } else if (request.type === 'abort') reply();
  }
});
`);
  return { root, parent, children, manifest, script };
}

describe("bounded Parent dispatch", () => {
  it("runs disjoint Children at once, serializes a conflicting Child, and records integration metrics", async () => {
    const { root, parent, children, manifest, script } = fixture();
    const result = await runParallelBatch(root, parent, manifest, { command: process.execPath, args: [script] });
    expect(result.children.map((child) => child.outcome)).toEqual(["settled", "settled", "settled"]);
    expect(result.max_active).toBe(2);
    const [alpha, beta, gamma] = result.children;
    expect(Date.parse(alpha.started_at)).toBeLessThan(Date.parse(beta.ended_at));
    expect(Date.parse(beta.started_at)).toBeLessThan(Date.parse(alpha.ended_at));
    expect(Date.parse(gamma.started_at)).toBeGreaterThanOrEqual(Date.parse(alpha.ended_at));
    expect(result.queue_wait_total_ms).toBeGreaterThan(0);
    expect(parallelStatus(root, parent)).toMatchObject({ integration_owner: "parent", merge_limit: 1, integration_complete: false,
      latest_batch: { batch_id: result.batch_id, wall_ms: result.wall_ms } });
    for (const child of children) {
      const dir = path.join(root, ".pactile", "tasks", child);
      fs.appendFileSync(path.join(dir, "verify.md"), "\nValidation commands: fake Pi RPC passed\nFinal acceptance evidence: Parent reviewed result\n");
      fs.writeFileSync(path.join(dir, "handoff.md"), "# Handoff\nReviewed change-set: local fixture\n");
      expect(runTaskCli(["set-child-state", parent, child, "review", "--evidence", "pi-run"], root)).toBe(0);
      expect(runTaskCli(["integrate-child", parent, child, "accepted", "--evidence", "parent-review", "--ref", `git:${child}`], root)).toBe(0);
    }
    expect(runTaskCli(["integrate-child", parent, children[0], "integrating", "--evidence", "merge-ready", "--ref", `git:${children[0]}`], root)).toBe(0);
    expect(runTaskCli(["integrate-child", parent, children[1], "integrating", "--evidence", "merge-ready", "--ref", `git:${children[1]}`], root)).toBe(1);
    expect(runTaskCli(["integrate-child", parent, children[0], "integrated", "--evidence", "merge", "--ref", `git:${children[0]}`], root)).toBe(0);
    for (const child of children.slice(1)) {
      expect(runTaskCli(["integrate-child", parent, child, "integrating", "--evidence", "merge-ready", "--ref", `git:${child}`], root)).toBe(0);
      expect(runTaskCli(["integrate-child", parent, child, "integrated", "--evidence", "merge", "--ref", `git:${child}`], root)).toBe(0);
    }
    expect(parallelStatus(root, parent)).toMatchObject({ integration_complete: true });
  });

  it("blocks unmet dependencies and overlapping direct bridge reservations before launch", async () => {
    const { root, parent, children, manifest, script } = fixture();
    const parentDir = path.join(root, ".pactile", "tasks", parent);
    const { data, body } = readTaskMap(parentDir);
    if (!data) throw new Error("Missing task map");
    data.children[1].depends_on = [children[0]];
    writeTaskMap(parentDir, data, body);
    await expect(runParallelBatch(root, parent, manifest, { command: process.execPath, args: [script] })).rejects.toThrow("requires unmet");
    expect(fs.existsSync(path.join(parentDir, "parallel", "latest.json"))).toBe(false);
    data.children[1].depends_on = [];
    writeTaskMap(parentDir, data, body);
    const release = reserveParallelChild(root, path.join(root, ".pactile", "tasks", children[0]));
    try {
      expect(() => reserveParallelChild(root, path.join(root, ".pactile", "tasks", children[2]))).toThrow("write-set conflict");
      const releaseBeta = reserveParallelChild(root, path.join(root, ".pactile", "tasks", children[1]));
      releaseBeta();
    } finally { release(); }
    data.execution_topology = "serial";
    writeTaskMap(parentDir, data, body);
    await expect(runParallelBatch(root, parent, manifest, { command: process.execPath, args: [script] })).rejects.toThrow("execution_topology must be parallel");
  });

  it("serializes a high review-cost Child even when write sets are disjoint", async () => {
    const { root, parent, manifest, script } = fixture();
    const value = JSON.parse(fs.readFileSync(manifest, "utf8")) as { children: { review_cost: string }[] };
    value.children[1].review_cost = "high";
    fs.writeFileSync(manifest, JSON.stringify(value));
    const result = await runParallelBatch(root, parent, manifest, { command: process.execPath, args: [script] });
    expect(result.max_active).toBe(1);
  });

  it("refuses a missing worktree and runs Pi in a verified Child checkout once prepared", async () => {
    const { root, parent, children, manifest, script } = fixture(true);
    await expect(runParallelBatch(root, parent, manifest, { command: process.execPath, args: [script] })).rejects.toThrow("prepared Child worktree");
    expect(fs.existsSync(path.join(root, ".pactile", "tasks", parent, "parallel", "latest.json"))).toBe(false);
    const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init");
    fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
    git("add", "README.md");
    git("-c", "user.name=Pactile Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture");
    const checkout = path.join(root, ".pactile", "worktrees", "alpha");
    fs.mkdirSync(path.dirname(checkout), { recursive: true });
    git("worktree", "add", "-b", "feat/alpha", checkout, "HEAD");
    const childDir = path.join(root, ".pactile", "tasks", children[0]);
    const task = JSON.parse(fs.readFileSync(path.join(childDir, "task.json"), "utf8")) as Record<string, unknown>;
    task.worktree_path = path.relative(root, checkout);
    fs.writeFileSync(path.join(childDir, "task.json"), JSON.stringify(task));
    const result = await runParallelBatch(root, parent, manifest, { command: process.execPath, args: [script] });
    expect(result.children[0].outcome).toBe("settled");
    const latest = JSON.parse(fs.readFileSync(path.join(childDir, "pi-bridge", "latest.json"), "utf8")) as { result_file: string };
    expect(fs.readFileSync(path.join(childDir, latest.result_file), "utf8").trim().toLowerCase()).toBe(fs.realpathSync(checkout).toLowerCase());
  });

  it("holds a Codex Execute slot until a completed native wait receipt", () => {
    const { root, children } = fixture(false, true);
    const prompt = path.join(root, "codex-prompt.md");
    fs.writeFileSync(prompt, "Implement the approved Child write set.");
    const first = prepareCodexRequest({ root, task: children[0], tool: "create_thread", role: "execute", promptFile: prompt,
      projectId: "pactile-project", environment: "worktree" });
    expect(String(first.arguments.prompt)).toContain("Parent-approved write set: src/alpha");
    expect(first.arguments).toMatchObject({ target: { environment: { type: "worktree", startingState: { type: "branch", branchName: "develop" } } } });
    expect(() => prepareCodexRequest({ root, task: children[2], tool: "create_thread", role: "execute", promptFile: prompt,
      projectId: "pactile-project", environment: "worktree" })).toThrow("write-set conflict");
    const threadId = "01a0cca7-8fe7-7c82-a682-1366b68e2139";
    const receipt = (name: string, value: Record<string, unknown>): string => {
      const file = path.join(root, `${name}.json`);
      fs.writeFileSync(file, JSON.stringify(value));
      return file;
    };
    recordCodexReceipt(root, children[0], first.request_id, receipt("created", {
      request_id: first.request_id, tool: first.tool, outcome: "ok", thread_id: threadId, host_id: "local",
    }));
    const wait = prepareCodexRequest({ root, task: children[0], tool: "wait_threads", threadId, timeoutMs: 0 });
    recordCodexReceipt(root, children[0], wait.request_id, receipt("completed", {
      request_id: wait.request_id, tool: wait.tool, outcome: "ok", thread_id: threadId, host_id: "local", status: "completed",
    }));
    expect(() => prepareCodexRequest({ root, task: children[2], tool: "create_thread", role: "execute", promptFile: prompt,
      projectId: "pactile-project", environment: "worktree" })).not.toThrow();
  });
});
