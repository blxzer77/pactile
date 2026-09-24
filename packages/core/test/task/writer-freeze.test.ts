import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreSrc = path.resolve(here, "../../src");
const cliSrc = path.resolve(here, "../../../cli/src");

function walkTs(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function isCoreTaskJsonWriter(source: string): boolean {
  return (
    source.includes("TASK_JSON_BASENAME") && /\bwriteFileSync\s*\(/.test(source)
  );
}

function isCliTaskJsonWriter(source: string): boolean {
  return /\bwriteFileSync\s*\(\s*(?:path\.join\([^)]*(?:FILE_NAMES\.TASK_JSON|["']task\.json["'])|[^,\n]*FILE_NAMES\.TASK_JSON)/s.test(source);
}

describe("Stage 1–2 task.json writer freeze", () => {
  it("packages/core/src has exactly one task.json write primitive (records.ts)", () => {
    const writers = walkTs(coreSrc)
      .filter((file) => isCoreTaskJsonWriter(fs.readFileSync(file, "utf-8")))
      .map((file) => rel(coreSrc, file));
    expect(writers).toEqual(["task/records.ts"]);
  });

  it("Kernel command projection uses writeTaskRecord; store has no extra writeFileSync task.json primitive", () => {
    const store = fs.readFileSync(
      path.join(coreSrc, "task/kernel-store.ts"),
      "utf-8",
    );
    expect(store).toMatch(/KERNEL_JSON_BASENAME/);
    expect(store).toMatch(/writeTaskRecord\s*\(/);
    expect(store).not.toMatch(/TASK_JSON_BASENAME/);
  });

  it("packages/cli/src keeps the Stage 0 task.json writer allowlist", () => {
    const writers = walkTs(cliSrc)
      .filter((file) => isCliTaskJsonWriter(fs.readFileSync(file, "utf-8")))
      .map((file) => rel(cliSrc, file));
    expect(writers).toEqual([]);
  });
});
