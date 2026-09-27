import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyDeferredLiveWrites, captureDeferredLiveWrite } from "../../src/pactile/lifecycle/deferred-live.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-deferred-live-"));
  roots.push(dir);
  return dir;
}

describe("update post-commit project-file writes", () => {
  it("refuses a hardlinked target before writing project template bytes", () => {
    const dir = root();
    const external = path.join(root(), "outside.md");
    fs.writeFileSync(external, "user bytes\n");
    fs.linkSync(external, path.join(dir, "CONTEXT.md"));
    expect(() => captureDeferredLiveWrite(dir, "CONTEXT.md", "template bytes\n", false)).toThrow(/standalone/);
    expect(fs.readFileSync(external, "utf8")).toBe("user bytes\n");
  });

  it("preserves a file edited after its update bytes were planned", () => {
    const dir = root();
    const target = path.join(dir, "CONTEXT.md");
    fs.writeFileSync(target, "original\n");
    const writes = new Map([["CONTEXT.md", { content: "new template\n", executable: false, original: Buffer.from("original\n") }]]);
    fs.writeFileSync(target, "user changed this during update\n");
    expect(() => applyDeferredLiveWrites(dir, writes)).toThrow(/changed|drift/i);
    expect(fs.readFileSync(target, "utf8")).toBe("user changed this during update\n");
  });

  it("restores prior project files when a later live write fails", () => {
    const dir = root();
    const first = path.join(dir, "CONTEXT.md");
    const second = path.join(dir, "docs", "adr", "README.md");
    fs.writeFileSync(first, "first old\n");
    fs.mkdirSync(path.dirname(second), { recursive: true });
    fs.writeFileSync(second, "second old\n");
    const writes = new Map([
      ["CONTEXT.md", { content: "first new\n", executable: false, original: Buffer.from("first old\n") }],
      ["docs/adr/README.md", { content: "second new\n", executable: false, original: Buffer.from("second old\n") }],
    ]);
    const actualWrite = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((file, content, options) => {
      if (String(file) === second) throw new Error("injected live write failure");
      return actualWrite(file, content, options);
    }) as typeof fs.writeFileSync);
    expect(() => applyDeferredLiveWrites(dir, writes)).toThrow("injected live write failure");
    expect(fs.readFileSync(first, "utf8")).toBe("first old\n");
    expect(fs.readFileSync(second, "utf8")).toBe("second old\n");
  });

  it("preserves a concurrent user edit during rollback and reports incomplete recovery", () => {
    const dir = root();
    const first = path.join(dir, "CONTEXT.md");
    const second = path.join(dir, "README.md");
    fs.writeFileSync(first, "first old\n");
    fs.writeFileSync(second, "second old\n");
    const writes = new Map([
      ["CONTEXT.md", { content: "first new\n", executable: false, original: Buffer.from("first old\n") }],
      ["README.md", { content: "second new\n", executable: false, original: Buffer.from("second old\n") }],
    ]);
    const actualWrite = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((file, content, options) => {
      if (String(file) === second) {
        actualWrite(first, "user edit during update\n");
        throw new Error("injected later failure");
      }
      return actualWrite(file, content, options);
    }) as typeof fs.writeFileSync);
    expect(() => applyDeferredLiveWrites(dir, writes)).toThrow("rollback was incomplete");
    expect(fs.readFileSync(first, "utf8")).toBe("user edit during update\n");
  });
});
