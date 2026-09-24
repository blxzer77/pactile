import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyTaskRecord } from "../../../src/core/task/index.js";
import { handleKernelRequest } from "../../../src/core/task/kernel-cli.js";
import { applyKernelCreate, applyKernelStart } from "../../../src/core/task/kernel-store.js";
import { scanContractMigration } from "../../../src/core/task/contract-migrate.js";

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("Stage 7 contract migrate dry-run", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-stage7-migrate-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reports old fields, parent, depends_mode, and file-inferred rigor without writing", () => {
    const tasks = path.join(tmp, ".pactile", "tasks");
    const legacy = path.join(tasks, "legacy-full");
    writeJson(path.join(legacy, "task.json"), {
      ...emptyTaskRecord({
        id: "legacy-full",
        name: "legacy-full",
        title: "Legacy",
        parent: "old-parent",
        children: ["child-a"],
        meta: { classification: "full" },
      }),
      task_kind: "full",
      depends_mode: "block",
    });
    fs.writeFileSync(path.join(legacy, "design.md"), "# d\n", "utf-8");
    fs.writeFileSync(path.join(legacy, "implement.md"), "# i\n", "utf-8");
    writeJson(path.join(tmp, ".pactile", "config.yaml"), "classification: personal\n");

    const before = fs.readFileSync(path.join(legacy, "task.json"), "utf-8");
    const report = scanContractMigration({ root: tmp });
    const after = fs.readFileSync(path.join(legacy, "task.json"), "utf-8");

    expect(report.dryRun).toBe(true);
    expect(report.wrote).toBe(false);
    expect(after).toBe(before);
    expect(fs.existsSync(path.join(legacy, "kernel.json"))).toBe(false);
    expect(fs.existsSync(path.join(legacy, "verify.md"))).toBe(false);
    expect(report.findings.map((item) => item.kind).sort()).toEqual(
      [
        "artifact-inference",
        "children-inferred-parent",
        "depends-mode",
        "file-inferred-rigor",
        "legacy-parent",
        "profile-ref",
        "retired-field",
        "retired-field",
      ].sort(),
    );
  });

  it("Kernel migrate without dryRun is rejected and writes nothing", () => {
    const taskDir = path.join(tmp, ".pactile", "tasks", "x");
    writeJson(path.join(taskDir, "task.json"), emptyTaskRecord({ id: "x", name: "x" }));
    const before = fs.readdirSync(taskDir);
    const result = handleKernelRequest({ op: "migrate", cwd: tmp });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/dryRun/);
    expect(fs.readdirSync(taskDir)).toEqual(before);
  });

  it("Kernel migrate dry-run returns findings over JSON CLI and does not rewrite task.json", () => {
    const taskDir = path.join(tmp, ".pactile", "tasks", "old");
    const record = {
      ...emptyTaskRecord({ id: "old", name: "old", meta: { classification: "parent" } }),
      kind: "parent",
    };
    writeJson(path.join(taskDir, "task.json"), record);
    const before = fs.readFileSync(path.join(taskDir, "task.json"), "utf-8");
    const result = handleKernelRequest({
      op: "migrate",
      dryRun: true,
      cwd: tmp,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.op).toBe("migrate");
    expect(result.wrote).toBe(false);
    expect(result.findings.some((item) => item.kind === "retired-field")).toBe(true);
    expect(fs.readFileSync(path.join(taskDir, "task.json"), "utf-8")).toBe(before);
  });

  it("new create/start omit retired fields and persist explicit Lite by default", () => {
    const taskDir = path.join(tmp, "new-task");
    const created = applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:new-task",
      record: emptyTaskRecord({
        id: "new-task",
        name: "new-task",
        title: "New",
        meta: { classification: "full", note: "keep" },
      }),
      extras: { task_kind: "full", mode: "parent" },
    });
    const extras = created.kernel.projection?.extras as {
      required_controls?: { rigor?: string };
      task_kind?: unknown;
      mode?: unknown;
    };
    expect(extras.required_controls?.rigor).toBe("lite");
    expect(extras.task_kind).toBeUndefined();
    expect(extras.mode).toBeUndefined();
    expect(created.kernel.projection?.record.meta.classification).toBeUndefined();
    expect(created.kernel.projection?.record.meta.note).toBe("keep");

    fs.writeFileSync(path.join(taskDir, "prd.md"), "# n\n", "utf-8");
    fs.writeFileSync(path.join(taskDir, "implement.md"), "execution_mode: inline\n", "utf-8");
    const started = applyKernelStart({
      taskDir,
      expectedRevision: created.kernel.revision,
      actor: "a",
      idempotencyKey: "start:new-task",
      record: { ...emptyTaskRecord({ id: "new-task", name: "new-task" }), status: "in_progress" },
      extras: { task_type: "full" },
      evidence: "start",
    });
    const disk = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(disk.task_kind).toBeUndefined();
    expect(disk.task_type).toBeUndefined();
    expect(disk.kind).toBeUndefined();
    expect(disk.mode).toBeUndefined();
    expect((disk.meta as { classification?: string }).classification).toBeUndefined();
    expect(
      (started.kernel.projection?.extras.required_controls as { rigor?: string }).rigor,
    ).toBe("lite");
  });
});
