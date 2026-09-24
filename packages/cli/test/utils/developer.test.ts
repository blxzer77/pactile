import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeDeveloper, readDeveloper } from "../../src/utils/developer.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Node developer initialization", () => {
  it("writes the legacy identity format and never replaces an existing workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-node-dev-"));
    roots.push(root);
    expect(initializeDeveloper(root, "Alice")).toBe(true);
    expect(readDeveloper(root)).toBe("Alice");
    const journal = path.join(root, ".pactile", "workspace", "Alice", "journal-1.md");
    fs.writeFileSync(journal, "user edits\n");
    expect(initializeDeveloper(root, "Bob")).toBe(false);
    expect(fs.readFileSync(journal, "utf8")).toBe("user edits\n");
    expect(readDeveloper(root)).toBe("Alice");
  });

  it("rejects a name that could escape the workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-node-dev-"));
    roots.push(root);
    expect(() => initializeDeveloper(root, "../outside")).toThrow(/single path segment/);
    expect(fs.existsSync(path.join(root, ".pactile", ".developer"))).toBe(false);
  });
});
