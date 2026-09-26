import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendTaskRunHostSettlementRefs,
  bindTaskRunHostReceipt,
  bindTaskRunWorkspace,
  createTaskKernel,
  recordTaskRunHostStopReceipt,
  recordTaskRunResult,
  startTaskRun,
} from "../../../src/core/task/index.js";
import { taskRunWorkspaceWriteSetsEqual } from "../../../src/core/task/task-kernel-write-set.js";

const roots: string[] = [];
const prefix = "pactile-p38-host-contract-";
const actor = "p38-contract-test";

describe("Task Run workspace write-set equivalence", () => {
  it("matches Kernel slash, ordering, and Windows case rules while rejecting different paths", () => {
    expect(
      taskRunWorkspaceWriteSetsEqual(
        ["src/", "docs\\readme.md"],
        ["docs/readme.md", "src"],
      ),
    ).toBe(true);
    expect(taskRunWorkspaceWriteSetsEqual(["src/one.ts"], ["src/two.ts"])).toBe(false);
    expect(taskRunWorkspaceWriteSetsEqual(["SRC/"], ["src"])).toBe(process.platform === "win32");
  });
});

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
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Pactile Test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "pactile-test@example.invalid"], { cwd: root, stdio: "ignore" });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), ".pactile/\n");
  fs.writeFileSync(path.join(root, "src", "base.ts"), "export const base = true;\n");
  execFileSync("git", ["add", "--all"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "test baseline"], { cwd: root, stdio: "ignore" });
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
    writeSetSnapshot: ["src/"],
  });
  const runId = started.kernel.runs.at(-1)?.id;
  if (!runId) throw new Error("Run was not started");
  return { root, taskDir, runId, started: started.kernel };
}

describe("Task Run workspace candidate baseline", () => {
  it("moves the branch binding to a managed checkout at the same captured base and rejects a changed base", () => {
    const context = setup();
    const prior = context.started.runs.at(-1);
    if (!prior?.candidateBaseSha) throw new Error("Run Git baseline is missing");
    execFileSync("git", ["switch", "--create", "feat/host-contract"], { cwd: context.root, stdio: "ignore" });
    const workspace = {
      ownerRunId: context.runId,
      canonicalPath: context.root,
      branch: "feat/host-contract",
      baseSha: prior.candidateBaseSha,
      writeSet: ["src/"],
      integrationState: "not-integrated" as const,
      reclamationState: "not-requested" as const,
      manager: {
        version: 1 as const,
        credentialId: "manager:test",
        projectRoot: context.root,
        commonDir: path.join(context.root, ".git"),
        gitDir: path.join(context.root, ".git"),
        source: "created" as const,
        recordedAt: "2026-09-26T00:00:00.000Z",
      },
      integrationReceipt: null,
      cleanupLease: null,
    };
    expect(() => bindTaskRunWorkspace({
      root: context.root,
      taskDir: context.taskDir,
      expectedRevision: context.started.revision,
      runId: context.runId,
      workspace: { ...workspace, baseSha: "b".repeat(40) },
      actor,
      idempotencyKey: "workspace:wrong-base",
    })).toThrow(/base must match the Git commit captured when the Run started/);

    expect(() => bindTaskRunWorkspace({
      root: context.root,
      taskDir: context.taskDir,
      expectedRevision: context.started.revision,
      runId: context.runId,
      workspace: { ...workspace, writeSet: ["docs/"] },
      actor,
      idempotencyKey: "workspace:different-write-set",
    })).toThrow(/Workspace write set must match the Run write-set snapshot/);

    const bound = bindTaskRunWorkspace({
      root: context.root,
      taskDir: context.taskDir,
      expectedRevision: context.started.revision,
      runId: context.runId,
      workspace,
      actor,
      idempotencyKey: "workspace:matching-base",
    });
    const run = bound.kernel.runs.at(-1);
    expect(run?.candidateBaseSha).toBe(workspace.baseSha);
    expect(run?.candidateBaseBranch).toBe(workspace.branch);
    expect(run?.workspace?.branch).toBe(workspace.branch);
  });
});

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

    const candidateBytes = "export const ready = true;\n";
    fs.writeFileSync(path.join(context.root, "src", "feature.ts"), candidateBytes);
    fs.writeFileSync(path.join(context.taskDir, "run-result.json"), "{\"result\":\"ready\"}\n");
    const completed = recordTaskRunResult({
      root: context.root, taskDir: context.taskDir, expectedRevision: settled.kernel.revision, runId: context.runId,
      outcome: "completed", summary: "Feature is ready", evidenceRefs: ["run-result.json"],
      candidateEntries: [{ ref: "src/feature.ts", fingerprint: createHash("sha256").update(candidateBytes).digest("hex") }], actor,
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
