import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runTaskCli } from "../../src/commands/task.js";
import { applyKernelStart, readKernel, setKernelAfterWriteHook } from "../../src/core/task/kernel-store.js";
import { resolveRequiredControls } from "../../src/core/task/full-quality.js";
import { startFingerprints } from "../../src/core/task/start-authority.js";
import { approvedExecuteTask } from "../../src/pactile/task/authorization.js";

const roots: string[] = [];
afterEach(() => {
  setKernelAfterWriteHook(null);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function task(full = false): { root: string; dir: string; name: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-start-authority-"));
  roots.push(root);
  const tasks = path.join(root, ".pactile", "tasks");
  fs.mkdirSync(path.join(tasks, "locale", "en"), { recursive: true });
  fs.writeFileSync(path.join(tasks, "locale", "en", "default-prd.md"), "# {title}\n\n## Acceptance Criteria\n\n- [ ] observable behavior works\n");
  fs.writeFileSync(path.join(root, ".pactile", "config.yaml"), "artifact_locale: en\n");
  fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=alice\n");
  expect(runTaskCli(["legacy-create", "Authority", "--slug", "authority", ...(full ? ["--rigor", "full"] : [])], root)).toBe(0);
  const name = fs.readdirSync(tasks).find((entry) => entry.endsWith("-authority")) ?? "";
  const dir = path.join(tasks, name);
  if (full) {
    fs.writeFileSync(path.join(dir, "design.md"), "# Design\n\nReview this change.\n");
    fs.writeFileSync(path.join(dir, "implement.md"), [
      "# Strategy", "execution_mode: inline", "isolation: main-worktree", "verification_profile: standard",
      "retrieval_profile: exact-only", "optional_capabilities: []", "quality_gates:", "  mode: profile", "",
    ].join("\n"));
  }
  return { root, dir, name };
}

function gate(root: string, name: string, result: "PASS" | "FAIL"): void {
  expect(runTaskCli(["record-gate", name, "--transition", "start-execution", "--gate", "requirements-review",
    "--result", result, "--reviewer", "reviewer", "--evidence", "prd.md#requirements",
    ...(result === "FAIL" ? ["--issue-fingerprint", "sha256:review-issue", "--root-cause", "contract-changing-defect"] : [])], root)).toBe(0);
}

describe("start authority at the final Kernel transition", () => {
  it("does not let --approved turn an explicit FAIL review into PASS", () => {
    const { root, dir, name } = task(true);
    gate(root, name, "FAIL");
    expect(runTaskCli(["start-execution", name, "--check"], root)).toBe(1);
    expect(runTaskCli(["start-execution", name, "--approved"], root)).toBe(1);
    const kernel = readKernel({ taskDir: dir, cwd: root }).kernel;
    expect(kernel.phase).toBe("define");
    expect(kernel.gates.transitions["start-execution"]?.["requirements-review"]).toMatchObject({ result: "FAIL", reviewer: "reviewer" });
  });

  it("rejects a direct Kernel start that has no recorded approval", () => {
    const { root, dir } = task();
    const before = readKernel({ taskDir: dir, cwd: root }).kernel;
    if (!before.projection) throw new Error("missing task projection");
    expect(() => applyKernelStart({ taskDir: dir, cwd: root, expectedRevision: before.revision,
      actor: "direct caller", idempotencyKey: "unapproved", record: { ...before.projection.record, status: "in_progress" },
    })).toThrow(/approval/i);
    expect(readKernel({ taskDir: dir, cwd: root }).kernel.phase).toBe("define");
  });

  it("does not let a direct caller lower a Full task to Lite at start", () => {
    const { root, dir, name } = task(true);
    gate(root, name, "FAIL");
    const before = readKernel({ taskDir: dir, cwd: root }).kernel;
    if (!before.projection) throw new Error("missing task projection");
    const record = before.projection.record;
    const stamps = startFingerprints(dir, record);
    expect(() => applyKernelStart({ taskDir: dir, cwd: root, expectedRevision: before.revision,
      actor: "direct caller", idempotencyKey: "downgrade", record: { ...record, status: "in_progress" },
      extras: {
        required_controls: resolveRequiredControls({ rigor: "lite" }),
        execution_approval: { transition: "start-execution", approved_by: "user", task_id: record.id,
          approval_source: "test caller", approved_at: new Date().toISOString(),
          contract_fingerprint: stamps.contractFingerprint, artifact_fingerprint: stamps.artifactFingerprint },
      },
    })).toThrow(/required controls|requirements-review|gate/i);
    expect(readKernel({ taskDir: dir, cwd: root }).kernel.phase).toBe("define");
  });

  it("does not satisfy a hard dependency from an edited task.json status", () => {
    const { root, name } = task();
    expect(runTaskCli(["legacy-create", "Upstream", "--slug", "upstream"], root)).toBe(0);
    expect(runTaskCli(["set-deps", name, "upstream"], root)).toBe(0);
    const upstreamDir = path.join(root, ".pactile", "tasks", fs.readdirSync(path.join(root, ".pactile", "tasks"))
      .find((entry) => entry.endsWith("-upstream")) ?? "missing");
    const projection = JSON.parse(fs.readFileSync(path.join(upstreamDir, "task.json"), "utf8")) as Record<string, unknown>;
    fs.writeFileSync(path.join(upstreamDir, "task.json"), `${JSON.stringify({ ...projection, status: "completed" })}\n`);
    expect(readKernel({ taskDir: upstreamDir, cwd: root }).kernel.phase).toBe("define");
    expect(runTaskCli(["start-execution", name, "--check"], root)).toBe(1);
    expect(runTaskCli(["start-execution", name, "--approved"], root)).toBe(1);
  });

  it("resolves completed dependencies for a direct Kernel start without cwd", () => {
    const { root, dir, name } = task();
    expect(runTaskCli(["legacy-create", "Upstream", "--slug", "upstream"], root)).toBe(0);
    const upstreamName = fs.readdirSync(path.join(root, ".pactile", "tasks"))
      .find((entry) => entry.endsWith("-upstream")) ?? "missing";
    expect(runTaskCli(["start-execution", upstreamName, "--approved"], root)).toBe(0);
    fs.appendFileSync(path.join(root, ".pactile", "tasks", upstreamName, "verify.md"),
      "\nValidation commands: local smoke passed\nFinal acceptance evidence: upstream complete\n");
    expect(runTaskCli(["archive", upstreamName, "--no-commit"], root)).toBe(0);
    expect(runTaskCli(["set-deps", name, "upstream"], root)).toBe(0);

    const before = readKernel({ taskDir: dir }).kernel;
    if (!before.projection) throw new Error("missing task projection");
    const record = before.projection.record;
    const liveRecord = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8")) as typeof record;
    const stamps = startFingerprints(dir, liveRecord);
    expect(() => applyKernelStart({ taskDir: dir, expectedRevision: before.revision,
      actor: "direct caller", idempotencyKey: "completed-dependency", record: { ...record, status: "in_progress" },
      extras: { dependency_satisfied: ["upstream"], execution_approval: { transition: "start-execution",
        approved_by: "user", task_id: record.id, approval_source: "test caller",
        approved_at: new Date().toISOString(), contract_fingerprint: stamps.contractFingerprint,
        artifact_fingerprint: stamps.artifactFingerprint } }, evidence: "completed upstream in Kernel",
    })).not.toThrow();
    expect(readKernel({ taskDir: dir }).kernel.projection?.status).toBe("in_progress");
  });

  it("keeps an explicitly approved dependency override usable by optional Execute hosts", () => {
    const { root, dir, name } = task();
    expect(runTaskCli(["set-deps", name, "unavailable-upstream"], root)).toBe(0);
    expect(runTaskCli(["start-execution", name, "--approved", "--ignore-deps"], root)).toBe(0);
    expect(approvedExecuteTask(root, name)).toBe(dir);
    const revision = readKernel({ taskDir: dir, cwd: root }).kernel.revision;
    expect(runTaskCli(["start-execution", name, "--approved"], root)).toBe(0);
    expect(readKernel({ taskDir: dir, cwd: root }).kernel.revision).toBe(revision);
  });

  it("rolls back a start if PRD changes between approval check and final projection", () => {
    const { root, dir, name } = task(true);
    gate(root, name, "PASS");
    setKernelAfterWriteHook(() => { fs.appendFileSync(path.join(dir, "prd.md"), "\nLate unreviewed change.\n"); });
    expect(runTaskCli(["start-execution", name, "--approved"], root)).toBe(1);
    const kernel = readKernel({ taskDir: dir, cwd: root }).kernel;
    expect(kernel.phase).toBe("define");
    expect(kernel.projection?.status).toBe("planning");
  });

  it("repeating the same approved start keeps its revision and approval", () => {
    const { root, dir, name } = task();
    expect(runTaskCli(["start-execution", name, "--approved"], root)).toBe(0);
    const first = readKernel({ taskDir: dir, cwd: root }).kernel;
    expect(runTaskCli(["start-execution", name, "--approved"], root)).toBe(0);
    const second = readKernel({ taskDir: dir, cwd: root }).kernel;
    expect(second.revision).toBe(first.revision);
    expect(second.projection?.extras.execution_approval).toEqual(first.projection?.extras.execution_approval);
  });
});
