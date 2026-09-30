import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runSessionCli } from "../../src/commands/session.js";
import { initializeDeveloper } from "../../src/utils/developer.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function gitSessionRoot(config: string): { root: string; git: (...args: string[]) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-session-git-"));
  roots.push(root);
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Pactile Test");
  git("config", "user.email", "pactile@example.invalid");
  initializeDeveloper(root, "alice");
  fs.writeFileSync(path.join(root, ".pactile", "config.yaml"), config);
  fs.writeFileSync(path.join(root, "unrelated.txt"), "original\n");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  return { root, git };
}

it.each(["", "session_auto_commit: OFF\n", "session_auto_commit: invalid\n"])(
  "saves the journal without staging or committing unless auto-commit is explicitly enabled (%j)",
  (config) => {
    const { root, git } = gitSessionRoot(config);
    const head = git("rev-parse", "HEAD");
    expect(runSessionCli(["add", "--title", "Local record"], root)).toBe(0);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("diff", "--cached", "--name-only")).toBe("");
    expect(git("diff", "--name-only")).toContain(".pactile/workspace/alice/journal-1.md");
  },
);

it("honors the opt-in commit message and leaves unrelated staged changes untouched", () => {
  const { root, git } = gitSessionRoot(
    "session_auto_commit: YES\nsession_commit_message: 'docs(session): preserve evidence'\n",
  );
  fs.writeFileSync(path.join(root, "unrelated.txt"), "staged user change\n");
  git("add", "unrelated.txt");
  expect(runSessionCli(["add", "--title", "Approved record"], root)).toBe(0);
  expect(git("log", "-1", "--format=%s")).toBe("docs(session): preserve evidence");
  expect(git("show", "--pretty=format:", "--name-only", "HEAD")).not.toContain("unrelated.txt");
  expect(git("diff", "--cached", "--name-only")).toBe("unrelated.txt");
});

it("gives --no-commit precedence over project opt-in", () => {
  const { root, git } = gitSessionRoot("session_auto_commit: on\n");
  const head = git("rev-parse", "HEAD");
  expect(runSessionCli(["add", "--title", "Review first", "--no-commit"], root)).toBe(0);
  expect(git("rev-parse", "HEAD")).toBe(head);
  expect(git("diff", "--cached", "--name-only")).toBe("");
});

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
