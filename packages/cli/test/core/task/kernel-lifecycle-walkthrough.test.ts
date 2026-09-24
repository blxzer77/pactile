import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { handleKernelRequest } from "../../../src/core/task/kernel-cli.js";
import { emptyTaskRecord } from "../../../src/core/task/schema.js";

it("walks an isolated PRD through Node Kernel create, execute, and close", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-walkthrough-"));
  const taskDir = path.join(root, ".pactile", "tasks", "walkthrough");
  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "prd.md"), "# Synthetic lifecycle task\nAcceptance: preserve close evidence.\n");
    const record = emptyTaskRecord({ id: "walkthrough", name: "walkthrough", title: "Synthetic walkthrough", creator: "fixture", assignee: "fixture" });
    const created = handleKernelRequest({ op: "create", taskDir, actor: "fixture", idempotencyKey: "create", record });
    expect(created).toMatchObject({ ok: true, kernel: { phase: "define", revision: 1 } });
    const started = handleKernelRequest({
      op: "start", taskDir, actor: "fixture", idempotencyKey: "start", expectedRevision: 1,
      record: { ...record, status: "in_progress" },
      extras: { execution_approval: { approved_by: "fixture", transition: "start-execution" } },
    });
    expect(started).toMatchObject({ ok: true, kernel: { phase: "execute" } });
    const startRevision = JSON.parse(fs.readFileSync(path.join(taskDir, "kernel.json"), "utf8")).revision as number;
    fs.writeFileSync(path.join(taskDir, "verify.md"), "# Verification\nValidation commands: isolated Kernel walkthrough passed\nFinal acceptance evidence: PRD to closed projection\n");
    const closed = handleKernelRequest({
      op: "archive", taskDir, actor: "fixture", idempotencyKey: "archive", expectedRevision: startRevision,
      record: { ...record, status: "completed", completedAt: "2026-09-24" },
      extras: { notes_projection: { source: "verify.md", outcome: "completed" } },
      evidence: "verify.md",
    });
    expect(closed).toMatchObject({ ok: true, kernel: { phase: "close", projection: { extras: { notes_projection: { outcome: "completed" } } } } });
    expect(JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"))).toMatchObject({ status: "completed" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
