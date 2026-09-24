import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sameGitRoot } from "../../src/utils/git-root.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("Git root identity", () => {
  it("accepts an alternate spelling of the same directory and rejects a sibling", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-git-root-"));
    roots.push(root);
    const sibling = path.join(root, "sibling");
    fs.mkdirSync(sibling);
    expect(sameGitRoot(path.toNamespacedPath(root), root)).toBe(true);
    expect(sameGitRoot(sibling, root)).toBe(false);
    expect(sameGitRoot(path.join(root, "missing"), root)).toBe(false);
  });
});
