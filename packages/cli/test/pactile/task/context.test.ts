import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addContextEntry, readContextEntries, validateContextFile } from "../../../src/pactile/task/context.js";

const roots: string[] = [];
function project(): { root: string; task: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-node-context-"));
  roots.push(root);
  const task = path.join(root, ".pactile", "tasks", "09-23-example");
  fs.mkdirSync(task, { recursive: true });
  fs.mkdirSync(path.join(root, ".pactile", "spec"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pactile", "spec", "guide.md"), "# Guide\n");
  return { root, task };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Node JSONL task context", () => {
  it("ignores a seed row and validates real referenced files", () => {
    const { root, task } = project();
    fs.writeFileSync(path.join(task, "implement.jsonl"), '{"_example":"seed"}\n');
    expect(addContextEntry(root, task, "implement", ".pactile/spec/guide.md", "guide")).toBe(true);
    expect(addContextEntry(root, task, "implement", ".pactile/spec/guide.md", "duplicate")).toBe(false);
    expect(readContextEntries(task, "implement")).toEqual([{ file: ".pactile/spec/guide.md", type: "file", reason: "guide" }]);
    expect(validateContextFile(root, task, "implement").errors).toEqual([]);
    fs.rmSync(path.join(root, ".pactile", "spec", "guide.md"));
    expect(validateContextFile(root, task, "implement").errors).toMatchObject([expect.stringContaining("File not found")]);
  });

  it("rejects a path that escapes the project", () => {
    const { root, task } = project();
    expect(() => addContextEntry(root, task, "check", "../outside")).toThrow(/inside the project/);
  });
});
