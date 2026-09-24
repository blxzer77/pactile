import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTaskCli } from "../../src/commands/task.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Node task CLI", () => {
  it("creates canonical Kernel/task records and evidence artifacts without Python", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-node-cli-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
    fs.mkdirSync(path.join(root, ".pactile", "spec", "guides"), { recursive: true });
    fs.mkdirSync(path.join(root, ".pactile", "framework"), { recursive: true });
    fs.mkdirSync(path.join(root, ".codex"));
    fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=alice\n");
    fs.writeFileSync(path.join(root, ".pactile", "config.yaml"), "artifact_locale: zh\n");
    fs.writeFileSync(path.join(root, ".pactile", "spec", "guides", "index.md"), "# Guides\n");
    fs.writeFileSync(path.join(root, ".pactile", "framework", "verification-strength-guide.md"), "# Verify\n");
    expect(runTaskCli(["create", "Example", "--slug", "example"], root)).toBe(0);
    const tasks = path.join(root, ".pactile", "tasks");
    const created = fs.readdirSync(tasks).find((name) => name.endsWith("-example"));
    expect(created).toBeTruthy();
    const dir = path.join(tasks, created ?? "");
    const record = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
    expect(record).toMatchObject({ id: "example", creator: "alice", assignee: "alice", status: "planning" });
    expect(record.createdAt.slice(5)).toBe((created ?? "").slice(0, 5));
    expect(fs.existsSync(path.join(dir, "kernel.json"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "prd.md"), "utf8")).toContain("# Example");
    expect(fs.readFileSync(path.join(dir, "implement.jsonl"), "utf8")).toContain("verification-strength-guide.md");
    expect(runTaskCli(["set-base-branch", "example", "develop"], root)).toBe(0);
    const updated = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
    expect(updated.base_branch).toBe("develop");
    expect(runTaskCli(["start-execution", "example", "--check"], root)).toBe(0);
    expect(runTaskCli(["start-execution", "example"], root)).toBe(1);
    expect(runTaskCli(["start-execution", "example", "--approved"], root)).toBe(0);
    const started = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
    expect(started.status).toBe("in_progress");
    expect(started.execution_approval?.approved_by).toBe("user");
    expect(runTaskCli(["select", "example"], root)).toBe(1); // No session key must fail closed.
    expect(runTaskCli(["set-deps", "example", "PACTILE-24"], root)).toBe(0);
    const withDeps = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
    expect(withDeps.depends_on).toEqual(["PACTILE-24"]);
    expect(runTaskCli(["set-deps", "example"], root)).toBe(0);
    expect(runTaskCli(["archive", "example", "--check"], root)).toBe(1);
    fs.rmSync(path.join(dir, "verify.md"));
    expect(runTaskCli(["prepare-archive-evidence", "example", "--dry-run"], root)).toBe(0);
    expect(fs.existsSync(path.join(dir, "verify.md"))).toBe(false);
    expect(runTaskCli(["prepare-archive-evidence", "example"], root)).toBe(0);
    expect(fs.readFileSync(path.join(dir, "verify.md"), "utf8")).toContain("Validation commands: TODO");
    expect(runTaskCli(["archive", "example", "--check"], root)).toBe(1);
    expect(runTaskCli(["prepare-learning-scaffold", "example", "--trigger", "review"], root)).toBe(0);
    fs.appendFileSync(path.join(dir, "verify.md"), "\nValidation commands: pnpm test — passed\nFinal acceptance evidence: criteria reviewed\n");
    expect(runTaskCli(["archive", "example", "--check"], root)).toBe(0);
    expect(runTaskCli(["archive", "example"], root)).toBe(0);
    const month = new Date().toISOString().slice(0, 7);
    const archived = path.join(tasks, "archive", month, created ?? "");
    expect(JSON.parse(fs.readFileSync(path.join(archived, "task.json"), "utf8"))).toMatchObject({ status: "completed" });
    expect(fs.existsSync(dir)).toBe(false);
    expect(runTaskCli(["list-archive", month], root)).toBe(0);
    expect(runTaskCli(["list-archive", "../.."], root)).toBe(1);
  });

  it("keeps unrelated staged changes out of an archive auto-commit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-node-archive-git-"));
    roots.push(root);
    const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Pactile Test");
    git("config", "user.email", "pactile@example.invalid");
    fs.mkdirSync(path.join(root, ".pactile", "tasks", "locale", "zh"), { recursive: true });
    fs.writeFileSync(path.join(root, ".pactile", "tasks", "locale", "zh", "default-prd.md"), "# {title}\n{goal}\n");
    fs.writeFileSync(path.join(root, ".pactile", "config.yaml"), "artifact_locale: zh\nsession_auto_commit: true\n");
    fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=alice\n");
    fs.writeFileSync(path.join(root, "unrelated.txt"), "original\n");
    expect(runTaskCli(["create", "Archive sample", "--slug", "archive-sample"], root)).toBe(0);
    const created = fs.readdirSync(path.join(root, ".pactile", "tasks")).find((name) => name.endsWith("-archive-sample")) ?? "";
    const dir = path.join(root, ".pactile", "tasks", created);
    expect(runTaskCli(["start-execution", created, "--approved"], root)).toBe(0);
    fs.appendFileSync(path.join(dir, "verify.md"), "\nValidation commands: pnpm test — passed\nFinal acceptance evidence: criteria reviewed\n");
    git("add", ".");
    git("commit", "-q", "-m", "fixture");
    fs.writeFileSync(path.join(root, "unrelated.txt"), "staged user change\n");
    git("add", "unrelated.txt");
    expect(runTaskCli(["archive", created], root)).toBe(0);
    const committed = git("show", "--pretty=format:", "--name-only", "HEAD");
    expect(committed).toContain(`.pactile/tasks/archive/`);
    expect(committed).not.toContain("unrelated.txt");
    expect(git("diff", "--cached", "--name-only")).toContain("unrelated.txt");
  });

  it("archives ignored personal task state without attempting a Git commit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-node-ignored-archive-"));
    roots.push(root);
    const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q");
    fs.appendFileSync(path.join(root, ".git", "info", "exclude"), "\n/.pactile/\n");
    fs.mkdirSync(path.join(root, ".pactile", "tasks", "locale", "en"), { recursive: true });
    fs.writeFileSync(path.join(root, ".pactile", "tasks", "locale", "en", "default-prd.md"), "# {title}\n{goal}\n");
    fs.writeFileSync(path.join(root, ".pactile", "config.yaml"), "artifact_locale: en\n");
    fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=tester\n");
    expect(runTaskCli(["create", "Ignored archive", "--slug", "ignored-archive"], root)).toBe(0);
    const task = fs.readdirSync(path.join(root, ".pactile", "tasks")).find((name) => name.endsWith("-ignored-archive")) ?? "";
    expect(runTaskCli(["start-execution", task, "--approved"], root)).toBe(0);
    fs.appendFileSync(path.join(root, ".pactile", "tasks", task, "verify.md"),
      "\nValidation commands: local smoke passed\nFinal acceptance evidence: task archived\n");
    const warning = vi.spyOn(console, "warn");
    try {
      expect(runTaskCli(["archive", task], root)).toBe(0);
      expect(warning).not.toHaveBeenCalled();
      expect(git("status", "--porcelain")).toBe("");
    } finally { warning.mockRestore(); }
  });

  it("reports hard requires during preflight and records an explicit override without claiming satisfaction", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-node-deps-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, ".pactile", "tasks", "locale", "zh"), { recursive: true });
    fs.writeFileSync(path.join(root, ".pactile", "tasks", "locale", "zh", "default-prd.md"), "# {title}\n{goal}\n");
    fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=alice\n");
    expect(runTaskCli(["create", "Dependency sample", "--slug", "dependency-sample"], root)).toBe(0);
    expect(runTaskCli(["set-deps", "dependency-sample", "upstream"], root)).toBe(0);
    expect(runTaskCli(["start-execution", "dependency-sample", "--check"], root)).toBe(1);
    expect(runTaskCli(["set-depends-mode", "dependency-sample", "warn"], root)).toBe(1);
    expect(runTaskCli(["start-execution", "dependency-sample", "--approved"], root)).toBe(1);
    expect(runTaskCli(["start-execution", "dependency-sample", "--check", "--ignore-deps"], root)).toBe(0);
    expect(runTaskCli(["start-execution", "dependency-sample", "--approved", "--ignore-deps"], root)).toBe(0);
    const dir = fs.readdirSync(path.join(root, ".pactile", "tasks")).find((name) => name.endsWith("-dependency-sample")) ?? "";
    const kernel = JSON.parse(fs.readFileSync(path.join(root, ".pactile", "tasks", dir, "kernel.json"), "utf8"));
    expect(kernel.projection.extras.dependency_satisfied).toEqual([]);
    expect(kernel.projection.extras.dependency_override).toMatchObject({ approved_by: "user", dependencies: ["upstream"] });
  });

  it("keeps Full start and close behind strategy, AC evidence, independent check, and reviewer gate", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-node-full-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, ".pactile", "tasks", "locale", "en"), { recursive: true });
    fs.writeFileSync(path.join(root, ".pactile", "tasks", "locale", "en", "default-prd.md"), "# {title}\n\n## Acceptance Criteria\n\n- [ ] implemented behavior works\n");
    fs.writeFileSync(path.join(root, ".pactile", "config.yaml"), "artifact_locale: en\n");
    fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=alice\n");
    expect(runTaskCli(["create", "Full sample", "--slug", "full-sample", "--rigor", "full"], root)).toBe(0);
    const name = fs.readdirSync(path.join(root, ".pactile", "tasks")).find((entry) => entry.endsWith("-full-sample")) ?? "";
    const dir = path.join(root, ".pactile", "tasks", name);
    expect(runTaskCli(["start-execution", name, "--check"], root)).toBe(1);
    fs.writeFileSync(path.join(dir, "implement.md"), [
      "# Strategy", "execution_mode: inline", "isolation: main-worktree", "verification_profile: standard",
      "retrieval_profile: exact-only", "optional_capabilities: []", "quality_gates:", "  mode: profile", "",
    ].join("\n"));
    fs.writeFileSync(path.join(dir, "design.md"), "# Design\n\nThe change follows the existing task store.\n");
    expect(runTaskCli(["start-execution", name, "--check"], root)).toBe(0);
    expect(runTaskCli(["start-execution", name, "--approved"], root)).toBe(0);
    expect(runTaskCli(["archive", name, "--check"], root)).toBe(1);
    fs.appendFileSync(path.join(dir, "verify.md"), [
      "Validation commands: pnpm test — pass", "Final acceptance evidence: implemented behavior works",
      "Check evidence: separate review of behavior", "Reviewed change-set: git diff HEAD",
      "Durable learning decision: no durable learning", "",
    ].join("\n"));
    expect(runTaskCli(["record-ac-evidence", name, "--map", "AC-1=verify.md#acceptance", "--code-ref", "git:abc123"], root)).toBe(0);
    expect(runTaskCli(["record-independent-check", name, "--mode", "true-independent", "--result", "PASS", "--evidence", "verify.md#check", "--code-ref", "git:abc123"], root)).toBe(1);
    expect(runTaskCli(["record-independent-check", name, "--mode", "self-review", "--result", "PASS", "--evidence", "verify.md#check", "--code-ref", "git:abc123"], root)).toBe(0);
    expect(runTaskCli(["archive", name, "--check"], root)).toBe(1);
    expect(runTaskCli(["record-gate", name, "--transition", "full-task-complete", "--gate", "code-review", "--result", "PASS", "--reviewer", "reviewer", "--evidence", "verify.md#review"], root)).toBe(0);
    expect(runTaskCli(["archive", name, "--check"], root)).toBe(0);
    expect(runTaskCli(["archive", name, "--no-commit"], root)).toBe(0);
  });

  it("tracks Parent and Child state in Kernel topology and task-map with ordered integration", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-node-parent-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, ".pactile", "tasks", "locale", "en"), { recursive: true });
    fs.writeFileSync(path.join(root, ".pactile", "tasks", "locale", "en", "default-prd.md"), "# {title}\n\n## Acceptance Criteria\n\n- [ ] work accepted\n");
    fs.writeFileSync(path.join(root, ".pactile", "config.yaml"), "artifact_locale: en\n");
    fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=alice\n");
    expect(runTaskCli(["create", "Parent", "--slug", "parent"], root)).toBe(0);
    expect(runTaskCli(["create", "Child", "--slug", "child", "--parent", "parent"], root)).toBe(0);
    const taskRoot = path.join(root, ".pactile", "tasks");
    const parentName = fs.readdirSync(taskRoot).find((entry) => entry.endsWith("-parent")) ?? "";
    const childName = fs.readdirSync(taskRoot).find((entry) => entry.endsWith("-child")) ?? "";
    const parentDir = path.join(taskRoot, parentName);
    const childDir = path.join(taskRoot, childName);
    const parentKernel = JSON.parse(fs.readFileSync(path.join(parentDir, "kernel.json"), "utf8"));
    expect(parentKernel.projection.extras.topology).toMatchObject({ kind: "parent-child", children: [childName] });
    expect(JSON.parse(fs.readFileSync(path.join(childDir, "task.json"), "utf8")).parent).toBe(parentName);
    expect(runTaskCli(["start-execution", parentName, "--check"], root)).toBe(0);
    expect(runTaskCli(["start-execution", parentName, "--approved"], root)).toBe(0);
    expect(runTaskCli(["create", "Late child", "--slug", "late-child", "--parent", parentName], root)).toBe(1);
    expect(fs.readdirSync(taskRoot).some((entry) => entry.endsWith("-late-child"))).toBe(false);
    expect(runTaskCli(["start-execution", childName, "--approved"], root)).toBe(0);
    expect(runTaskCli(["integrate-child", parentName, childName, "accepted", "--evidence", "review", "--ref", "git:abc"], root)).toBe(1);
    expect(runTaskCli(["set-child-state", parentName, childName, "review", "--evidence", "handoff.md"], root)).toBe(0);
    fs.appendFileSync(path.join(childDir, "verify.md"), "Validation commands: pnpm test passed\nFinal acceptance evidence: work accepted\n");
    fs.writeFileSync(path.join(childDir, "handoff.md"), "# Handoff\nReviewed change-set: git:abc\n");
    expect(runTaskCli(["review-child", parentName, childName, "--check"], root)).toBe(0);
    expect(runTaskCli(["review-child", parentName, childName, "--decision", "accept", "--ref", "git:abc", "--write-artifact"], root)).toBe(0);
    expect(fs.existsSync(path.join(parentDir, `review-${childName}.md`))).toBe(true);
    expect(runTaskCli(["integrate-child", parentName, childName, "integrated", "--evidence", "merge", "--ref", "git:abc"], root)).toBe(1);
    expect(runTaskCli(["integrate-child", parentName, childName, "integrating", "--evidence", "merge-ready", "--ref", "git:abc"], root)).toBe(0);
    expect(runTaskCli(["integrate-child", parentName, childName, "integrated", "--evidence", "merge", "--ref", "git:abc"], root)).toBe(0);
    fs.appendFileSync(path.join(parentDir, "verify.md"), "Validation commands: pnpm test passed\nFinal acceptance evidence: parent work accepted\nFinal integration evidence: child merged at git:abc\nDurable learning decision: no durable learning\nCheck evidence: parent review passed\nReviewed change-set: git:abc\n");
    expect(runTaskCli(["archive", parentName, "--check"], root)).toBe(1);
    expect(runTaskCli(["record-gate", parentName, "--transition", "parent-integrated", "--gate", "integration-review", "--result", "PASS", "--reviewer", "reviewer", "--evidence", "verify.md#integration"], root)).toBe(0);
    expect(runTaskCli(["archive", parentName, "--check"], root)).toBe(1);
    expect(runTaskCli(["archive", parentName, "--check", "--archive-integrated-children"], root)).toBe(0);
    expect(runTaskCli(["archive", parentName, "--archive-integrated-children", "--no-commit"], root)).toBe(0);
  });

  it("satisfies a hard dependency from an archived completed task", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-node-deps-complete-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, ".pactile", "tasks", "locale", "en"), { recursive: true });
    fs.writeFileSync(path.join(root, ".pactile", "tasks", "locale", "en", "default-prd.md"), "# {title}\n\n{goal}\n");
    fs.writeFileSync(path.join(root, ".pactile", "config.yaml"), "artifact_locale: en\n");
    fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=alice\n");
    expect(runTaskCli(["create", "Upstream", "--slug", "upstream"], root)).toBe(0);
    expect(runTaskCli(["create", "Downstream", "--slug", "downstream"], root)).toBe(0);
    const tasks = path.join(root, ".pactile", "tasks");
    const upstream = fs.readdirSync(tasks).find((name) => name.endsWith("-upstream")) ?? "";
    const downstream = fs.readdirSync(tasks).find((name) => name.endsWith("-downstream")) ?? "";
    expect(runTaskCli(["set-deps", downstream, "upstream"], root)).toBe(0);
    expect(runTaskCli(["start-execution", downstream, "--check"], root)).toBe(1);
    fs.appendFileSync(path.join(tasks, upstream, "verify.md"), "Validation commands: pnpm test passed\nFinal acceptance evidence: upstream accepted\n");
    expect(runTaskCli(["archive", upstream, "--no-commit"], root)).toBe(0);
    expect(runTaskCli(["start-execution", downstream, "--check"], root)).toBe(0);
    expect(runTaskCli(["start-execution", downstream, "--approved"], root)).toBe(0);
    const kernel = JSON.parse(fs.readFileSync(path.join(tasks, downstream, "kernel.json"), "utf8"));
    expect(kernel.projection.extras.dependency_satisfied).toContain("upstream");
    expect(kernel.projection.extras.dependency_override).toBeUndefined();
  });

  it("only advances Parent integration after a successful local Git merge", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-node-merge-"));
    roots.push(root);
    const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Pactile Test");
    git("config", "user.email", "pactile@example.invalid");
    fs.writeFileSync(path.join(root, "base.txt"), "base\n");
    git("add", "base.txt");
    git("commit", "-q", "-m", "base");
    const baseBranch = git("branch", "--show-current");
    git("checkout", "-q", "-b", "child-branch");
    fs.writeFileSync(path.join(root, "child-work.txt"), "child\n");
    git("add", "child-work.txt");
    git("commit", "-q", "-m", "child");
    git("checkout", "-q", baseBranch);
    fs.mkdirSync(path.join(root, ".pactile", "tasks", "locale", "en"), { recursive: true });
    fs.writeFileSync(path.join(root, ".pactile", "tasks", "locale", "en", "default-prd.md"), "# {title}\n");
    fs.writeFileSync(path.join(root, ".pactile", "config.yaml"), "artifact_locale: en\n");
    fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=alice\n");
    expect(runTaskCli(["create", "Parent", "--slug", "parent"], root)).toBe(0);
    expect(runTaskCli(["create", "Child", "--slug", "child", "--parent", "parent"], root)).toBe(0);
    const tasks = path.join(root, ".pactile", "tasks");
    const parent = fs.readdirSync(tasks).find((entry) => entry.endsWith("-parent")) ?? "";
    const child = fs.readdirSync(tasks).find((entry) => entry.endsWith("-child")) ?? "";
    const childDir = path.join(tasks, child);
    fs.appendFileSync(path.join(childDir, "verify.md"), "Validation commands: pnpm test passed\nFinal acceptance evidence: reviewed child work\n");
    fs.writeFileSync(path.join(childDir, "handoff.md"), "# Handoff\nReviewed change-set: child-branch\n");
    expect(runTaskCli(["set-child-state", parent, child, "review", "--evidence", "handoff.md"], root)).toBe(0);
    expect(runTaskCli(["integrate-child", parent, child, "accepted", "--evidence", "review", "--ref", "child-branch"], root)).toBe(0);
    expect(runTaskCli(["integrate-child", parent, child, "integrating", "--evidence", "ready", "--ref", "child-branch"], root)).toBe(0);
    const mergeArgs = ["integrate-child", parent, child, "integrated", "--evidence", "merged", "--execute-merge"];
    expect(runTaskCli([...mergeArgs, "--ref", "missing-ref", "--check"], root)).toBe(1);
    expect(runTaskCli([...mergeArgs, "--ref", "child-branch", "--check"], root)).toBe(0);
    fs.writeFileSync(path.join(root, "dirty.txt"), "user change\n");
    expect(runTaskCli([...mergeArgs, "--ref", "child-branch"], root)).toBe(1);
    fs.rmSync(path.join(root, "dirty.txt"));
    expect(runTaskCli([...mergeArgs, "--ref", "child-branch"], root)).toBe(0);
    expect(fs.readFileSync(path.join(root, "child-work.txt"), "utf8").trim()).toBe("child");
    expect(fs.readFileSync(path.join(tasks, parent, "task-map.md"), "utf8")).toContain("state: integrated");
  });

  it("preflights a Child worktree path and records a local checkout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-node-worktree-"));
    roots.push(root);
    const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Pactile Test");
    git("config", "user.email", "pactile@example.invalid");
    fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
    git("add", "README.md");
    git("commit", "-q", "-m", "base");
    fs.mkdirSync(path.join(root, ".pactile", "tasks", "locale", "en"), { recursive: true });
    fs.writeFileSync(path.join(root, ".pactile", "tasks", "locale", "en", "default-prd.md"), "# {title}\n");
    fs.writeFileSync(path.join(root, ".pactile", "config.yaml"), "artifact_locale: en\n");
    fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=alice\n");
    expect(runTaskCli(["create", "Parent", "--slug", "parent"], root)).toBe(0);
    expect(runTaskCli(["create", "Child", "--slug", "child", "--parent", "parent"], root)).toBe(0);
    const tasks = path.join(root, ".pactile", "tasks");
    const parent = fs.readdirSync(tasks).find((entry) => entry.endsWith("-parent")) ?? "";
    const child = fs.readdirSync(tasks).find((entry) => entry.endsWith("-child")) ?? "";
    const args = ["prepare-child-worktree", parent, child, "--branch", "feat/child"];
    expect(runTaskCli([...args, "--path", path.join(root, "escape"), "--check"], root)).toBe(1);
    expect(runTaskCli([...args, "--check"], root)).toBe(0);
    expect(fs.existsSync(path.join(root, ".pactile", "worktrees", child))).toBe(false);
    expect(runTaskCli(args, root)).toBe(0);
    expect(fs.existsSync(path.join(root, ".pactile", "worktrees", child, "README.md"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(tasks, child, "task.json"), "utf8"))).toMatchObject({ branch: "feat/child" });
    expect(fs.readFileSync(path.join(tasks, parent, "task-map.md"), "utf8")).toContain("branch: feat/child");
  });
});
