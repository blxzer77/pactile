import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTaskCli } from "../../src/commands/task.js";
import { codexBridgeStatus, prepareCodexRequest, recordCodexReceipt } from "../../src/pactile/codex/bridge.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(): { root: string; task: string; prompt: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-codex-bridge-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".pactile", "tasks", "locale", "en"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pactile", "tasks", "locale", "en", "default-prd.md"), "# {title}\n{goal}\n");
  fs.writeFileSync(path.join(root, ".pactile", "config.yaml"), "artifact_locale: en\n");
  fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=tester\n");
  expect(runTaskCli(["create", "Codex bridge", "--slug", "codex-bridge"], root)).toBe(0);
  const task = fs.readdirSync(path.join(root, ".pactile", "tasks")).find((name) => name.endsWith("-codex-bridge"));
  if (!task) throw new Error("Task fixture missing");
  const prompt = path.join(root, "prompt.md");
  fs.writeFileSync(prompt, "Plan the acceptance evidence. Do not implement.\n");
  return { root, task, prompt };
}

function result(root: string, body: Record<string, unknown>): string {
  const file = path.join(root, `receipt-${Math.random()}.json`);
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

describe("Codex desktop request and receipt bridge", () => {
  it("binds a native desktop task and records message/wait receipts without changing Kernel", () => {
    const { root, task, prompt } = fixture();
    const create = prepareCodexRequest({ root, task, tool: "create_thread", role: "plan", promptFile: prompt,
      projectId: "project-1", environment: "worktree", title: "Plan Pactile task" });
    expect(create.arguments).toMatchObject({ target: { type: "project", projectId: "project-1", environment: { type: "worktree" } } });
    expect(String(create.arguments.prompt)).toContain(`Pactile task: .pactile/tasks/${task}`);
    expect(codexBridgeStatus(root, task).pending).toHaveLength(1);
    expect(JSON.stringify(codexBridgeStatus(root, task))).not.toContain("Plan the acceptance evidence");
    const threadId = "01a0cca7-8fe7-7c82-a682-1366b68e2139";
    const created = recordCodexReceipt(root, task, create.request_id, result(root, {
      request_id: create.request_id, tool: create.tool, outcome: "ok", thread_id: threadId, host_id: "local",
    }));
    expect(created).toMatchObject({ assurance: "host-reported", contract_stale: false });
    const message = prepareCodexRequest({ root, task, tool: "send_message_to_thread", threadId, promptFile: prompt });
    expect(message.arguments).toMatchObject({ threadId, hostId: "local" });
    expect(() => recordCodexReceipt(root, task, message.request_id, result(root, {
      request_id: message.request_id, tool: message.tool, outcome: "ok", thread_id: "wrong", host_id: "local",
    }))).toThrow("thread identity changed");
    recordCodexReceipt(root, task, message.request_id, result(root, {
      request_id: message.request_id, tool: message.tool, outcome: "ok", thread_id: threadId, host_id: "local",
    }));
    const wait = prepareCodexRequest({ root, task, tool: "wait_threads", threadId, timeoutMs: 0 });
    expect(wait.arguments).toMatchObject({ targets: [{ threadId, hostId: "local" }], timeoutMs: 0 });
    recordCodexReceipt(root, task, wait.request_id, result(root, {
      request_id: wait.request_id, tool: wait.tool, outcome: "ok", thread_id: threadId, host_id: "local", status: "completed", cursor: "cursor-1",
    }));
    const secondWait = prepareCodexRequest({ root, task, tool: "wait_threads", threadId, timeoutMs: 0 });
    expect(secondWait.arguments).toMatchObject({ targets: [{ afterCursor: "cursor-1" }] });
    recordCodexReceipt(root, task, secondWait.request_id, result(root, {
      request_id: secondWait.request_id, tool: secondWait.tool, outcome: "ok", thread_id: threadId, host_id: "local", status: "completed", cursor: "cursor-2",
    }));
    expect(prepareCodexRequest({ root, task, tool: "wait_threads", threadId, timeoutMs: 0 }).arguments)
      .toMatchObject({ targets: [{ afterCursor: "cursor-2" }] });
    const read = prepareCodexRequest({ root, task, tool: "read_thread", threadId });
    expect(recordCodexReceipt(root, task, read.request_id, result(root, {
      request_id: read.request_id, tool: read.tool, outcome: "failed", reason: "App temporarily unavailable",
    }))).toMatchObject({ outcome: "failed", thread_id: threadId, host_id: "local" });
    expect(codexBridgeStatus(root, task)).toMatchObject({ phase: "define", threads: [{ threadId, hostId: "local", role: "plan" }] });
    expect(JSON.parse(fs.readFileSync(path.join(root, ".pactile", "tasks", task, "kernel.json"), "utf8")).phase).toBe("define");
  });

  it("rejects unbound, phase-invalid, mismatched and duplicate receipts", () => {
    const { root, task, prompt } = fixture();
    expect(() => prepareCodexRequest({ root, task, tool: "send_message_to_thread", threadId: "other", promptFile: prompt })).toThrow("not bound");
    expect(() => prepareCodexRequest({ root, task, tool: "create_thread", role: "review", promptFile: prompt,
      projectId: "project-1", environment: "local" })).toThrow("review requires");
    const create = prepareCodexRequest({ root, task, tool: "create_thread", role: "plan", promptFile: prompt,
      projectId: "project-1", environment: "local" });
    expect(() => recordCodexReceipt(root, task, create.request_id, result(root, {
      request_id: "different", tool: create.tool, outcome: "ok", thread_id: "thread-1", host_id: "local",
    }))).toThrow("does not match");
    const file = result(root, { request_id: create.request_id, tool: create.tool, outcome: "ok", thread_id: "thread-1", host_id: "local" });
    recordCodexReceipt(root, task, create.request_id, file);
    expect(() => recordCodexReceipt(root, task, create.request_id, file)).toThrow();
  });

  it("marks receipts stale when the canonical task changes after preparation", () => {
    const { root, task, prompt } = fixture();
    const create = prepareCodexRequest({ root, task, tool: "create_thread", role: "plan", promptFile: prompt,
      projectId: "project-1", environment: "local" });
    expect(runTaskCli(["set-scope", task, "changed"], root)).toBe(0);
    const receipt = recordCodexReceipt(root, task, create.request_id, result(root, {
      request_id: create.request_id, tool: create.tool, outcome: "ok", thread_id: "thread-2", host_id: "local",
    }));
    expect(receipt.contract_stale).toBe(true);
  });

  it("does not use a queued clientThreadId for cross-task messaging", () => {
    const { root, task, prompt } = fixture();
    const create = prepareCodexRequest({ root, task, tool: "create_thread", role: "plan", promptFile: prompt,
      projectId: "project-1", environment: "worktree" });
    recordCodexReceipt(root, task, create.request_id, result(root, {
      request_id: create.request_id, tool: create.tool, outcome: "queued", client_thread_id: "client-123",
    }));
    expect(codexBridgeStatus(root, task).queued).toHaveLength(1);
    expect(() => prepareCodexRequest({ root, task, tool: "send_message_to_thread", threadId: "client-123", promptFile: prompt })).toThrow("not bound");
    expect(() => recordCodexReceipt(root, task, create.request_id, result(root, {
      request_id: create.request_id, tool: create.tool, outcome: "ok", client_thread_id: "different",
      thread_id: "thread-123", host_id: "local",
    }))).toThrow("must match");
    recordCodexReceipt(root, task, create.request_id, result(root, {
      request_id: create.request_id, tool: create.tool, outcome: "ok", client_thread_id: "client-123",
      thread_id: "thread-123", host_id: "local",
    }));
    expect(codexBridgeStatus(root, task).queued).toHaveLength(0);
    expect(codexBridgeStatus(root, task).threads).toMatchObject([{ threadId: "thread-123" }]);
  });

  it("supports a projectless desktop task when the product checkout is not saved in the App", () => {
    const { root, task, prompt } = fixture();
    const request = prepareCodexRequest({ root, task, tool: "create_thread", role: "plan", promptFile: prompt,
      targetType: "projectless" });
    expect(request.arguments.target).toEqual({ type: "projectless" });
  });

  it("keeps receipts readable after the Pactile task is archived", () => {
    const { root, task, prompt } = fixture();
    const create = prepareCodexRequest({ root, task, tool: "create_thread", role: "plan", promptFile: prompt,
      targetType: "projectless" });
    recordCodexReceipt(root, task, create.request_id, result(root, {
      request_id: create.request_id, tool: create.tool, outcome: "ok", thread_id: "thread-archived", host_id: "local",
    }));
    expect(runTaskCli(["start-execution", task, "--approved"], root)).toBe(0);
    fs.appendFileSync(path.join(root, ".pactile", "tasks", task, "verify.md"),
      "\nValidation commands: bridge test passed\nFinal acceptance evidence: receipt retained\n");
    expect(runTaskCli(["archive", task, "--no-commit"], root)).toBe(0);
    expect(codexBridgeStatus(root, task)).toMatchObject({ archived: true, phase: "close", threads: [{ threadId: "thread-archived" }] });
    expect(() => prepareCodexRequest({ root, task, tool: "read_thread", threadId: "thread-archived" })).toThrow("Task not found");
  });
});
