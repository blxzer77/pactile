import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyTaskRecord, writeTaskRecord } from "../../../src/core/task/index.js";
import { KERNEL_JSON_BASENAME, KernelError } from "../../../src/core/task/kernel-contract.js";
import {
  applyKernelTransition,
  kernelJsonPath,
  readKernel,
} from "../../../src/core/task/kernel-store.js";
import {
  handleKernelRequest,
  runKernelJsonCli,
} from "../../../src/core/task/kernel-cli.js";

describe("Kernel store + JSON CLI", () => {
  let tmp: string;
  let taskDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-kernel-"));
    taskDir = path.join(tmp, "08-28-kernel-demo");
    writeTaskRecord({
      taskDir,
      record: emptyTaskRecord({
        id: "kernel-demo",
        name: "kernel-demo",
        title: "Kernel Demo",
        status: "planning",
        assignee: "developer",
      }),
    });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("projects a legacy planning task without persisting kernel.json", () => {
    const result = readKernel({ taskDir });
    expect(result.persisted).toBe(false);
    expect(result.kernel.revision).toBe(0);
    expect(result.kernel.phase).toBe("define");
    expect(result.kernel.condition).toBe("ready");
    expect(result.legacy.status).toBe("planning");
    expect(fs.existsSync(kernelJsonPath(taskDir))).toBe(false);
  });

  it("applies define → approve, writes revision + audit, leaves legacy status unchanged", () => {
    const applied = applyKernelTransition({
      taskDir,
      expectedRevision: 0,
      targetPhase: "approve",
      actor: "stage1-worker",
      idempotencyKey: "t-approve-1",
      evidence: "implement.md",
    });

    expect(applied.idempotent).toBe(false);
    expect(applied.kernel.revision).toBe(1);
    expect(applied.kernel.phase).toBe("approve");
    expect(applied.kernel.audit).toHaveLength(1);
    expect(applied.audit.idempotencyKey).toBe("t-approve-1");
    expect(applied.legacy.status).toBe("planning");

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(taskDir, KERNEL_JSON_BASENAME), "utf-8"),
    ) as { revision: number; phase: string; audit: unknown[] };
    expect(onDisk.revision).toBe(1);
    expect(onDisk.phase).toBe("approve");
    expect(onDisk.audit).toHaveLength(1);

    const taskJson = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"),
    ) as { status: string };
    expect(taskJson.status).toBe("planning");
  });

  it("rejects revision conflicts without writing", () => {
    applyKernelTransition({
      taskDir,
      expectedRevision: 0,
      targetPhase: "approve",
      actor: "a",
      idempotencyKey: "t1",
    });
    const before = fs.readFileSync(kernelJsonPath(taskDir), "utf-8");

    expect(() =>
      applyKernelTransition({
        taskDir,
        expectedRevision: 0,
        targetPhase: "execute",
        actor: "a",
        idempotencyKey: "t2",
      }),
    ).toThrow(KernelError);

    try {
      applyKernelTransition({
        taskDir,
        expectedRevision: 0,
        targetPhase: "execute",
        actor: "a",
        idempotencyKey: "t3",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).code).toBe("REVISION_CONFLICT");
    }

    expect(fs.readFileSync(kernelJsonPath(taskDir), "utf-8")).toBe(before);
    const taskJson = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"),
    ) as { status: string };
    expect(taskJson.status).toBe("planning");
  });

  it("replays the same idempotency key without a second audit event", () => {
    const first = applyKernelTransition({
      taskDir,
      expectedRevision: 0,
      targetPhase: "approve",
      actor: "a",
      idempotencyKey: "same-key",
    });
    const second = applyKernelTransition({
      taskDir,
      expectedRevision: 0,
      targetPhase: "approve",
      actor: "a",
      idempotencyKey: "same-key",
    });
    expect(second.idempotent).toBe(true);
    expect(second.kernel.revision).toBe(first.kernel.revision);
    expect(second.audit.id).toBe(first.audit.id);
    expect(second.kernel.audit).toHaveLength(1);
  });

  it("rejects illegal edges and unimplemented gate/policy hooks", () => {
    try {
      applyKernelTransition({
        taskDir,
        expectedRevision: 0,
        targetPhase: "execute",
        actor: "a",
        idempotencyKey: "bad-edge",
      });
      expect.unreachable("illegal edge should throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("INVALID_TRANSITION");
    }

    try {
      applyKernelTransition({
        taskDir,
        expectedRevision: 0,
        targetPhase: "approve",
        actor: "a",
        idempotencyKey: "gated",
        gate: { result: "PASS" },
      });
      expect.unreachable("gate hook should throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("GATE_HOOK_UNIMPLEMENTED");
    }

    try {
      applyKernelTransition({
        taskDir,
        expectedRevision: 0,
        targetPhase: "approve",
        actor: "a",
        idempotencyKey: "policy",
        policy: "team-default",
      });
      expect.unreachable("policy hook should throw");
    } catch (err) {
      expect((err as KernelError).code).toBe("POLICY_HOOK_UNIMPLEMENTED");
    }

    expect(fs.existsSync(kernelJsonPath(taskDir))).toBe(false);
  });

  it("handleKernelRequest serves read + transition JSON", () => {
    const read = handleKernelRequest({ op: "read", taskDir });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.op).toBe("read");
    expect(read.legacy.status).toBe("planning");

    const transition = handleKernelRequest({
      op: "transition",
      taskDir,
      expectedRevision: 0,
      targetPhase: "approve",
      actor: "cli",
      idempotencyKey: "json-1",
      evidence: "prd.md",
    });
    expect(transition.ok).toBe(true);
    if (!transition.ok) return;
    expect(transition.op).toBe("transition");
    expect(transition.kernel.revision).toBe(1);
    expect(transition.legacy.status).toBe("planning");
  });

  it("runKernelJsonCli writes one JSON line to stdout", async () => {
    const chunks: Buffer[] = [];
    const stdout = {
      write(chunk: string | Buffer): boolean {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const code = await runKernelJsonCli({
      stdin: Readable.from([
        JSON.stringify({ op: "read", taskDir }),
      ]),
      stdout,
    });
    expect(code).toBe(0);
    const body = Buffer.concat(chunks).toString("utf-8").trim();
    const parsed = JSON.parse(body) as { ok: boolean; op: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.op).toBe("read");
  });
});
