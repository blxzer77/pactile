import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exitTask, resolveSelectedTask, resolveTaskDir, selectTask } from "../../../src/pactile/task/session.js";

const roots: string[] = [];
function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-node-task-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".pactile", "tasks", "09-23-example"), { recursive: true });
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Node task session selection", () => {
  it("keeps independent session pointers and leaves task data untouched", () => {
    const root = project();
    const first = { PACTILE_CONTEXT_ID: "codex_first" };
    const second = { PACTILE_CONTEXT_ID: "codex_second" };
    const chosen = selectTask(root, "example", first);
    expect(chosen.taskPath).toBe(".pactile/tasks/09-23-example");
    expect(resolveSelectedTask(root, second).taskPath).toBeNull();
    expect(resolveSelectedTask(root, first).source).toBe("session:codex_first");
    exitTask(root, first);
    expect(resolveSelectedTask(root, first).taskPath).toBeNull();
    expect(fs.existsSync(path.join(root, ".pactile", "tasks", "09-23-example"))).toBe(true);
  });

  it("fails closed without a session identity", () => {
    const root = project();
    expect(() => selectTask(root, "example", {})).toThrow(/session identity/);
    expect(resolveSelectedTask(root, {}).taskPath).toBeNull();
  });

  it("rejects task references outside the active task directory", () => {
    const root = project();
    expect(() => resolveTaskDir(root, "../../outside")).toThrow(/active task/);
    expect(() => resolveTaskDir(root, path.join(root, "elsewhere"))).toThrow(/active task/);
  });
});
