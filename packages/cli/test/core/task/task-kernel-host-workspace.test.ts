import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendTaskRunHostSettlementRefs,
  bindTaskRunHostReceipt,
  createTaskKernel,
  recordTaskRunHostStopReceipt,
  recordTaskRunResult,
  startTaskRun,
} from "../../../src/core/task/index.js";

const roots: string[] = [];
const prefix = "pactile-p38-host-contract-";
const actor = "p38-contract-test";

afterEach(() => {
  const tempRoot = path.resolve(os.tmpdir());
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    const relative = path.relative(tempRoot, resolved);
    if (path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)
      || path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith(prefix)) {
      throw new Error(`Refusing to recursively remove a non-fixture path: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  const taskDir = path.join(root, ".pactile", "tasks", "host-contract");
  const created = createTaskKernel({
    root, taskDir, actor: "author", idempotencyKey: "create:host-contract",
    definition: {
      taskId: "host-contract", title: "Host settlement contract", description: "", deliverable: "A terminal receipt",
      deliveryLevel: "local-result", acceptanceCriteria: [{ id: "AC-1", description: "Result is preserved" }], dependencies: [],
    },
  });
  const started = startTaskRun({
    root, taskDir, expectedRevision: created.kernel.revision, actor, idempotencyKey: "start:host-contract",
    input: { summary: "Run with a manager-owned Pi child", references: ["task contract"] },
    authorization: { approvedBy: "approver", approvedAt: "2026-09-26T00:00:00.000Z", scope: "src", evidenceRef: "approval.json" },
    writeSetSnapshot: ["src"],
  });
  const runId = started.kernel.runs.at(-1)?.id;
  if (!runId) throw new Error("Run was not started");
  return { root, taskDir, runId, started: started.kernel };
}

describe("Task Run host binding and stop receipt contract", () => {
  it("requires one active binding, append-only settlement refs, a terminal Run, and the exact current candidate", () => {
    const context = setup();
    const host = {
      host: "pi", role: "implement", sessionId: "session-p38", hostId: null, threadId: null,
      requestRefs: ["pi-start:run-1"], eventRefs: ["pi-bridge/events/run-1.jsonl"], resultRefs: [],
      assuranceSource: "manager-owned-child-exit",
    };
    const bound = bindTaskRunHostReceipt({
      root: context.root, taskDir: context.taskDir, expectedRevision: context.started.revision, runId: context.runId,
      host, actor, idempotencyKey: "host-bind:run-1",
    });
    const activeRun = bound.kernel.runs.at(-1);
    expect(activeRun?.host).toMatchObject({
      host: "pi", role: "implement", sessionId: "session-p38", assuranceSource: "manager-owned-child-exit",
      kernelRevision: bound.kernel.revision, stopReceipt: null,
    });
    expect(activeRun?.host?.contractFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(() => bindTaskRunHostReceipt({
      root: context.root, taskDir: context.taskDir, expectedRevision: bound.kernel.revision, runId: context.runId,
      host: { ...host, sessionId: "replacement-session" }, actor, idempotencyKey: "host-rebind:run-1",
    })).toThrow(/immutable/);

    const settled = appendTaskRunHostSettlementRefs({
      root: context.root, taskDir: context.taskDir, expectedRevision: bound.kernel.revision, runId: context.runId,
      eventRefs: ["pi-settle:run-1"], resultRefs: ["pi-bridge/runs/run-1.json"], actor,
      idempotencyKey: "host-settlement:run-1",
    });
    expect(settled.kernel.runs.at(-1)?.host).toMatchObject({
      eventRefs: ["pi-bridge/events/run-1.jsonl", "pi-settle:run-1"],
      resultRefs: ["pi-bridge/runs/run-1.json"],
    });
    expect(() => appendTaskRunHostSettlementRefs({
      root: context.root, taskDir: context.taskDir, expectedRevision: settled.kernel.revision, runId: context.runId,
      eventRefs: ["pi-settle:run-1"], actor, idempotencyKey: "host-settlement-empty:run-1",
    })).toThrow(/at least one new reference/);

    const premature = {
      source: "pactile-pi-rpc", assurance: "manager-owned-child-exit", evidenceLevel: "manager-owned-child-exit",
      taskId: "host-contract", runId: context.runId, sessionId: "session-p38", threadId: null,
      startRequestId: "pi-start:run-1", settleReceiptId: "pi-settle:run-1", terminalStatus: "exited",
      requestKernelRevision: bound.kernel.revision, receiptKernelRevision: settled.kernel.revision,
      contractFingerprint: activeRun?.host?.contractFingerprint ?? "", contractStale: false,
      candidateSnapshotId: null, candidateFingerprint: null, candidateSource: null,
      receiptRef: "pi-bridge/runs/run-1.json", evidenceRef: "pi-bridge/runs/run-1.json#process_stop_receipt",
      recordedAt: "2026-09-26T00:01:00.000Z",
    } as const;
    expect(() => recordTaskRunHostStopReceipt({
      root: context.root, taskDir: context.taskDir, expectedRevision: settled.kernel.revision, runId: context.runId,
      receipt: premature, actor, idempotencyKey: "host-stop-premature:run-1",
    })).toThrow(/terminal Run/);

    const completed = recordTaskRunResult({
      root: context.root, taskDir: context.taskDir, expectedRevision: settled.kernel.revision, runId: context.runId,
      outcome: "completed", summary: "Feature is ready", evidenceRefs: ["run-result.json"],
      candidateEntries: [{ ref: "src/feature.ts", fingerprint: "a".repeat(64) }], actor,
      idempotencyKey: "result:run-1",
    });
    const candidate = completed.kernel.runs.at(-1)?.candidateSnapshot;
    if (!candidate) throw new Error("Run candidate is missing");
    const receipt = {
      ...premature,
      receiptKernelRevision: completed.kernel.revision,
      candidateSnapshotId: candidate.id,
      candidateFingerprint: candidate.fingerprint,
      candidateSource: "derived" as const,
    };
    expect(() => recordTaskRunHostStopReceipt({
      root: context.root, taskDir: context.taskDir, expectedRevision: completed.kernel.revision, runId: context.runId,
      receipt: { ...receipt, candidateSnapshotId: "another-candidate" }, actor, idempotencyKey: "host-stop-wrong-candidate:run-1",
    })).toThrow(/does not match the current Run candidate/);
    const stopped = recordTaskRunHostStopReceipt({
      root: context.root, taskDir: context.taskDir, expectedRevision: completed.kernel.revision, runId: context.runId,
      receipt, actor, idempotencyKey: "host-stop:run-1",
    });
    expect(stopped.kernel.runs.at(-1)?.host?.stopReceipt).toMatchObject({
      runId: context.runId, settleReceiptId: "pi-settle:run-1", candidateSnapshotId: candidate.id,
      candidateFingerprint: candidate.fingerprint, candidateSource: "derived", terminalStatus: "exited",
    });
    expect(() => appendTaskRunHostSettlementRefs({
      root: context.root, taskDir: context.taskDir, expectedRevision: stopped.kernel.revision, runId: context.runId,
      eventRefs: ["late-settlement"], actor, idempotencyKey: "host-settlement-late:run-1",
    })).toThrow(/terminal receipt/);
  });
});
