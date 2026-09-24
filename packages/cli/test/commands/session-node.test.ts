import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runSessionCli } from "../../src/commands/session.js";
import { initializeDeveloper } from "../../src/utils/developer.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it("records and rotates a journal with matching index markers through Node", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-session-node-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".pactile"));
  fs.writeFileSync(path.join(root, ".pactile", "config.yaml"), "session_auto_commit: false\nmax_journal_lines: 65\n");
  initializeDeveloper(root, "alice");

  expect(runSessionCli(["add", "--title", "First", "--summary", "Planned"], root)).toBe(0);
  expect(runSessionCli(["add", "--title", "Second", "--summary", "Verified"], root)).toBe(0);

  const workspace = path.join(root, ".pactile", "workspace", "alice");
  const index = fs.readFileSync(path.join(workspace, "index.md"), "utf8");
  expect(index).toContain("**Total Sessions**: 2");
  expect(index).toContain("| 2 |");
  expect(index).toContain("| 1 |");
  expect(fs.readFileSync(path.join(workspace, "journal-2.md"), "utf8")).toContain("Session 2: Second");
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  expect(runSessionCli(["search", "--query", "Verified", "--json"], root)).toBe(0);
  const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? "{}")) as { results: { title: string; summary: string }[] };
  expect(payload.results).toMatchObject([{ title: "Second", summary: "Verified" }]);
  log.mockRestore();
});
