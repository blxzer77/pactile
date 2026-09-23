import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyTaskRecord, writeTaskRecord } from "../../src/task/index.js";
import { KERNEL_JSON_BASENAME, KernelError } from "../../src/task/kernel-contract.js";
import {
  applyKernelArchive,
  applyKernelCreate,
  applyKernelPatch,
  applyKernelRecordGate,
  applyKernelStart,
  applyKernelTransition,
  kernelJsonPath,
  readKernel,
  setKernelAfterWriteHook,
} from "../../src/task/kernel-store.js";
import { handleKernelRequest } from "../../src/task/kernel-cli.js";

function demoRecord() {
  return emptyTaskRecord({
    id: "kernel-cmd",
    name: "kernel-cmd",
    title: "Kernel Command Demo",
    status: "planning",
    assignee: "developer",
    creator: "developer",
    priority: "P2",
  });
}

describe("Stage 2 Kernel commands + half-conversion", () => {
  let tmp: string;
  let taskDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-kernel-cmd-"));
    taskDir = path.join(tmp, "08-28-kernel-cmd");
    setKernelAfterWriteHook(null);
  });

  afterEach(() => {
    setKernelAfterWriteHook(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("create writes kernel.json revision+audit and projects planning status", () => {
    const created = applyKernelCreate({
      taskDir,
      actor: "task.py create",
      idempotencyKey: "create:kernel-cmd",
      record: demoRecord(),
    });

    expect(created.idempotent).toBe(false);
    expect(created.projected).toBe(true);
    expect(created.kernel.revision).toBe(1);
    expect(created.kernel.phase).toBe("define");
    expect(created.kernel.audit).toHaveLength(1);
    expect(created.legacy.status).toBe("planning");

    const taskJson = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"),
    ) as { status: string; id: string };
    expect(taskJson.status).toBe("planning");
    expect(taskJson.id).toBe("kernel-cmd");

    const kernel = JSON.parse(
      fs.readFileSync(path.join(taskDir, KERNEL_JSON_BASENAME), "utf-8"),
    ) as { revision: number; phase: string };
    expect(kernel.revision).toBe(1);
    expect(kernel.phase).toBe("define");
  });

  it("start hops define → execute and projects in_progress + extras", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:kernel-cmd",
      record: demoRecord(),
    });
    const started = applyKernelStart({
      taskDir,
      expectedRevision: 1,
      actor: "task.py start-execution --approved",
      idempotencyKey: "start:kernel-cmd:fp1",
      record: { ...demoRecord(), status: "in_progress" },
      extras: {
        execution_approval: { approved_by: "user", transition: "start-execution" },
      },
      evidence: "task.py start-execution --approved",
    });

    expect(started.kernel.phase).toBe("execute");
    expect(started.legacy.status).toBe("in_progress");
    expect(started.kernel.revision).toBeGreaterThan(1);

    const taskJson = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"),
    ) as {
      status: string;
      execution_approval?: { approved_by: string };
    };
    expect(taskJson.status).toBe("in_progress");
    expect(taskJson.execution_approval?.approved_by).toBe("user");
  });

  it("record-gate stores evidence in kernel and projects quality_gate_results", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:kernel-cmd",
      record: demoRecord(),
    });
    const gateRecord = {
      result: "PASS",
      evidence: "verify.md",
      reviewer: "blxzer77",
    };
    const recorded = applyKernelRecordGate({
      taskDir,
      expectedRevision: 1,
      actor: "task.py record-gate",
      idempotencyKey: "gate:code-review:1",
      transition: "start-execution",
      gateName: "code-review",
      record: gateRecord,
      extras: {
        quality_gate_results: {
          schema_version: 1,
          transitions: { "start-execution": { "code-review": gateRecord } },
        },
      },
    });

    expect(recorded.kernel.gates.transitions["start-execution"]?.["code-review"]).toEqual(
      gateRecord,
    );
    const taskJson = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"),
    ) as { quality_gate_results?: { transitions?: Record<string, unknown> } };
    expect(
      taskJson.quality_gate_results?.transitions?.["start-execution"],
    ).toMatchObject({ "code-review": gateRecord });
  });

  it("rejects PASS gate records without evidence (no fake-green)", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:kernel-cmd",
      record: demoRecord(),
    });
    try {
      applyKernelRecordGate({
        taskDir,
        expectedRevision: 1,
        actor: "a",
        idempotencyKey: "gate:bad",
        transition: "start-execution",
        gateName: "code-review",
        record: { result: "PASS", evidence: "" },
      });
      expect.unreachable("empty PASS evidence should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).code).toBe("INVALID_REQUEST");
    }
  });

  it("archive hops to close and projects completed", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:kernel-cmd",
      record: demoRecord(),
    });
    applyKernelStart({
      taskDir,
      expectedRevision: 1,
      actor: "a",
      idempotencyKey: "start:1",
      record: { ...demoRecord(), status: "in_progress" },
    });
    const current = readKernel({ taskDir });
    const archived = applyKernelArchive({
      taskDir,
      expectedRevision: current.kernel.revision,
      actor: "task.py archive",
      idempotencyKey: "archive:kernel-cmd",
      record: { ...demoRecord(), status: "completed", completedAt: "2026-08-28" },
    });

    expect(archived.kernel.phase).toBe("close");
    expect(archived.kernel.outcome).toBe("completed");
    expect(archived.legacy.status).toBe("completed");
    const taskJson = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"),
    ) as { status: string; completedAt: string | null };
    expect(taskJson.status).toBe("completed");
    expect(taskJson.completedAt).toBe("2026-08-28");
  });

  it("raw transition still does not rewrite task.json.status", () => {
    writeTaskRecord({ taskDir, record: demoRecord() });
    applyKernelTransition({
      taskDir,
      expectedRevision: 0,
      targetPhase: "approve",
      actor: "stage1",
      idempotencyKey: "t-approve",
    });
    const taskJson = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"),
    ) as { status: string };
    expect(taskJson.status).toBe("planning");
  });

  it("start rejects unimplemented gate hooks instead of fake-green", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:kernel-cmd",
      record: demoRecord(),
    });
    try {
      applyKernelStart({
        taskDir,
        expectedRevision: 1,
        actor: "a",
        idempotencyKey: "start-gated",
        record: { ...demoRecord(), status: "in_progress" },
        gate: { result: "PASS" },
      });
      expect.unreachable("gate hook should throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("GATE_HOOK_UNIMPLEMENTED");
    }
    const taskJson = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"),
    ) as { status: string };
    expect(taskJson.status).toBe("planning");
  });

  it("half-conversion: kernel.json committed, projection failure is not success", () => {
    setKernelAfterWriteHook(() => {
      throw new Error("injected projection failure");
    });
    try {
      applyKernelCreate({
        taskDir,
        actor: "a",
        idempotencyKey: "create:kernel-cmd",
        record: demoRecord(),
      });
      expect.unreachable("half-conversion should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).code).toBe("HALF_CONVERSION");
    }

    expect(fs.existsSync(kernelJsonPath(taskDir))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, "task.json"))).toBe(false);

    const json = handleKernelRequest({
      op: "create",
      taskDir,
      actor: "a",
      idempotencyKey: "create:kernel-cmd",
      record: demoRecord(),
    });
    expect(json.ok).toBe(false);
    if (json.ok) return;
    expect(json.error.code).toBe("HALF_CONVERSION");
    expect(json.halfConversion?.kernelPersisted).toBe(true);
    expect(json.halfConversion?.projectionPersisted).toBe(false);
  });

  it("replays create idempotency and recovers a missing projection", () => {
    setKernelAfterWriteHook(() => {
      throw new Error("injected projection failure");
    });
    try {
      applyKernelCreate({
        taskDir,
        actor: "a",
        idempotencyKey: "create:kernel-cmd",
        record: demoRecord(),
      });
    } catch {
      // expected HALF_CONVERSION
    }
    setKernelAfterWriteHook(null);

    const recovered = applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:kernel-cmd",
      record: demoRecord(),
    });
    expect(recovered.projected).toBe(true);
    expect(fs.existsSync(path.join(taskDir, "task.json"))).toBe(true);
    const taskJson = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"),
    ) as { status: string };
    expect(taskJson.status).toBe("planning");
  });

  it("handleKernelRequest serves create + start JSON ops", () => {
    const created = handleKernelRequest({
      op: "create",
      taskDir,
      actor: "cli",
      idempotencyKey: "create:json",
      record: demoRecord(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.op).toBe("create");
    expect(created.kernel.revision).toBe(1);

    const started = handleKernelRequest({
      op: "start",
      taskDir,
      expectedRevision: 1,
      actor: "cli",
      idempotencyKey: "start:json",
      record: { ...demoRecord(), status: "in_progress" },
      extras: { execution_approval: { approved_by: "user" } },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.op).toBe("start");
    expect(started.legacy.status).toBe("in_progress");
  });

  it("revision conflict on start does not write projection", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:kernel-cmd",
      record: demoRecord(),
    });
    const before = fs.readFileSync(path.join(taskDir, "task.json"), "utf-8");
    try {
      applyKernelStart({
        taskDir,
        expectedRevision: 0,
        actor: "a",
        idempotencyKey: "start:stale",
        record: { ...demoRecord(), status: "in_progress" },
      });
      expect.unreachable("stale revision should throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("REVISION_CONFLICT");
    }
    expect(fs.readFileSync(path.join(taskDir, "task.json"), "utf-8")).toBe(before);
  });

  it("patch updates meta, bumps revision, and keeps planning status", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:kernel-cmd",
      record: demoRecord(),
    });
    const patched = applyKernelPatch({
      taskDir,
      expectedRevision: 1,
      actor: "task.py set-depends-mode",
      idempotencyKey: "patch:depends-mode:kernel-cmd:block",
      record: { meta: { depends_mode: "block" } },
    });

    expect(patched.kernel.phase).toBe("define");
    expect(patched.legacy.status).toBe("planning");
    expect(patched.kernel.revision).toBe(2);
    expect(patched.kernel.projection?.record.meta).toEqual({ depends_mode: "block" });

    const taskJson = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"),
    ) as { status: string; meta?: { depends_mode?: string } };
    expect(taskJson.status).toBe("planning");
    expect(taskJson.meta?.depends_mode).toBe("block");
  });

  it("patch rejects lifecycle status hops", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:kernel-cmd",
      record: demoRecord(),
    });
    try {
      applyKernelPatch({
        taskDir,
        expectedRevision: 1,
        actor: "a",
        idempotencyKey: "patch:status-hop",
        record: { status: "in_progress" },
      });
      expect.unreachable("status hop should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).code).toBe("INVALID_TRANSITION");
    }
    const taskJson = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"),
    ) as { status: string };
    expect(taskJson.status).toBe("planning");
    expect(readKernel({ taskDir }).kernel.revision).toBe(1);
  });

  it("patch JSON op updates extras without changing phase", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:kernel-cmd",
      record: demoRecord(),
    });
    const json = handleKernelRequest({
      op: "patch",
      taskDir,
      expectedRevision: 1,
      actor: "cli",
      idempotencyKey: "patch:locale",
      record: { meta: { artifact_locale: "en" } },
      extras: { execution_approval: { approved_by: "user" } },
    });
    expect(json.ok).toBe(true);
    if (!json.ok) return;
    expect(json.op).toBe("patch");
    expect(json.kernel.phase).toBe("define");
    const taskJson = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"),
    ) as {
      status: string;
      meta?: { artifact_locale?: string };
      execution_approval?: { approved_by?: string };
    };
    expect(taskJson.status).toBe("planning");
    expect(taskJson.meta?.artifact_locale).toBe("en");
    expect(taskJson.execution_approval?.approved_by).toBe("user");
  });

  it("patch half-conversion commits kernel.json and recovers via idempotency", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:kernel-cmd",
      record: demoRecord(),
    });
    setKernelAfterWriteHook(() => {
      throw new Error("injected projection failure");
    });
    try {
      applyKernelPatch({
        taskDir,
        expectedRevision: 1,
        actor: "a",
        idempotencyKey: "patch:half",
        record: { meta: { depends_mode: "block" } },
      });
      expect.unreachable("half-conversion should throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("HALF_CONVERSION");
    }
    expect(fs.existsSync(kernelJsonPath(taskDir))).toBe(true);
    fs.rmSync(path.join(taskDir, "task.json"));

    const json = handleKernelRequest({
      op: "patch",
      taskDir,
      expectedRevision: 1,
      actor: "a",
      idempotencyKey: "patch:half",
      record: { meta: { depends_mode: "block" } },
    });
    expect(json.ok).toBe(false);
    if (json.ok) return;
    expect(json.error.code).toBe("HALF_CONVERSION");
    expect(json.halfConversion?.kernelPersisted).toBe(true);

    setKernelAfterWriteHook(null);
    const recovered = applyKernelPatch({
      taskDir,
      expectedRevision: 1,
      actor: "a",
      idempotencyKey: "patch:half",
      record: { meta: { depends_mode: "block" } },
    });
    expect(recovered.projected).toBe(true);
    const taskJson = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"),
    ) as { status: string; meta?: { depends_mode?: string } };
    expect(taskJson.status).toBe("planning");
    expect(taskJson.meta?.depends_mode).toBe("block");
  });

  it("patch rejects unimplemented gate hooks instead of fake-green", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:kernel-cmd",
      record: demoRecord(),
    });
    try {
      applyKernelPatch({
        taskDir,
        expectedRevision: 1,
        actor: "a",
        idempotencyKey: "patch:gated",
        record: { meta: { depends_mode: "block" } },
        gate: { result: "PASS" },
      });
      expect.unreachable("gate hook should throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("GATE_HOOK_UNIMPLEMENTED");
    }
  });
});
