import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTaskKernel,
  fingerprintTaskValue,
  readTaskKernel,
  resumeTaskRun,
  startTaskRun,
} from "../../../src/core/task/index.js";
import { runTaskCliWithWorkspaceReclaim } from "../../../src/commands/task-worktree-close.js";
import {
  createJevDecisionFacadeV1,
  type JevDecisionFacadeV1,
  type JevEgressAuthorizationV1,
} from "../../../src/pactile/jev/index.js";
import * as jevProjectPolicy from "../../../src/pactile/jev/project-policy.js";
import * as jevResponse from "../../../src/pactile/jev/response.js";
import {
  acquireTaskKernelRunDispatchV1,
  planTaskKernelGraphV1,
  readTaskKernelScheduleReceiptV1,
  scheduleTaskKernelGraph,
  scheduleTaskKernelGraphWithJevV1,
} from "../../../src/pactile/scheduler/index.js";
import { createTaskRunWorktree } from "../../../src/pactile/worktree/index.js";

const roots: string[] = [];

const egress: JevEgressAuthorizationV1 = {
  network: "project-authorized",
  privacy: "project-approved-egress",
  credentials: "project-authorized",
  destination: "https://api.typesafe.ai",
  egressDestinations: ["https://api.typesafe.ai"],
  contentDecision: "task-summary-approved",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeGitRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pactile-v2-jev-schedule-"),
  );
  roots.push(root);
  fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "scheduler fixture\n", "utf8");
  git(root, "init");
  git(root, "add", "README.md");
  git(
    root,
    "-c",
    "user.name=Pactile Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "scheduler fixture",
  );
  return root;
}

interface TaskFixture {
  taskId: string;
  taskDir: string;
  runId: string | null;
}

function makeTask(
  root: string,
  taskId: string,
  options: {
    approvedAt?: string;
    dependencies?: string[];
    start?: boolean;
    writeSet?: string[];
  } = {},
): TaskFixture {
  const taskDir = path.join(root, ".pactile", "tasks", taskId);
  const created = createTaskKernel({
    root,
    taskDir,
    actor: "test-author",
    idempotencyKey: `create:${taskId}`,
    definition: {
      taskId,
      title: `V2 schedule ${taskId}`,
      description: "Jev scheduling fixture",
      deliverable: "one bounded implementation result",
      deliveryLevel: "local-result",
      acceptanceCriteria: [{ id: "AC-1", description: "result is reviewable" }],
      dependencies: options.dependencies ?? [],
    },
  });
  if (options.start === false) return { taskId, taskDir, runId: null };
  const started = startTaskRun({
    root,
    taskDir,
    expectedRevision: created.kernel.revision,
    actor: "test-approver",
    idempotencyKey: `start:${taskId}`,
    input: { summary: "Implement the declared result", references: [] },
    authorization: {
      approvedBy: "test-approver",
      approvedAt: options.approvedAt ?? "2026-09-26T00:00:00.000Z",
      scope: "declared Task write set",
      evidenceRef: `approval:${taskId}`,
    },
    initialState: "waiting",
    writeSetSnapshot: options.writeSet ?? [`src/${taskId}.ts`],
    estimatedDurations: { executionMs: 100_000 },
  });
  const runId = started.kernel.runs.at(-1)?.id;
  if (!runId) throw new Error(`Task Run was not recorded: ${taskId}`);
  return { taskId, taskDir, runId };
}

function attachManagedWorktree(root: string, task: TaskFixture): void {
  if (!task.runId) throw new Error(`Task Run is missing: ${task.taskId}`);
  createTaskRunWorktree({
    repoRoot: root,
    taskDir: task.taskDir,
    runId: task.runId,
    branch: `feat/${task.taskId}`,
    baseRef: git(root, "rev-parse", "HEAD"),
    actor: "test-worktree-manager",
    idempotencyKey: `worktree:${task.taskId}`,
  });
}

function answerFacade(
  input: {
    beforeAnswer?: () => void;
    choice?: "candidate-01" | "candidate-02";
  } = {},
): JevDecisionFacadeV1 & { decide: ReturnType<typeof vi.fn> } {
  const choice = input.choice ?? "candidate-02";
  const other = choice === "candidate-01" ? "candidate-02" : "candidate-01";
  return {
    decide: vi.fn(async () => {
      input.beforeAnswer?.();
      return {
        node: "task-scheduling" as const,
        status: "answered" as const,
        answers: {
          first_task: {
            type: "choice" as const,
            choice,
            confidence: 0.96,
            probabilities: { [choice]: 0.96, [other]: 0.04 },
          },
        },
        fallback: null,
        receipt: {
          schemaVersion: 1 as const,
          node: "task-scheduling" as const,
          transport: {
            provider: "typesafe-jev" as const,
            outcome: "answered" as const,
            reasonCode: null,
            attempts: 1,
            latencyMs: 7,
            httpStatus: 200,
            requestId: "test-request",
            model: "jev-test",
            inputTokens: 42,
            outputTokens: 0,
            estimatedInputCostMicrousd: 2,
            confidence: {
              first_task: { status: "available", value: 0.96 },
            },
          },
          budget: {
            maxDecisions: 1,
            decisionsUsed: 1,
            decisionsRemaining: 0,
            maximumHttpAttempts: 2,
            observedEstimatedInputCostMicrousd: 2,
          },
        },
      } as Awaited<ReturnType<JevDecisionFacadeV1["decide"]>>;
    }),
  };
}

function successResponse(
  choice: "candidate-01" | "candidate-02" = "candidate-02",
): Response {
  const other = choice === "candidate-01" ? "candidate-02" : "candidate-01";
  return new Response(
    JSON.stringify({
      model: "jev-test",
      answers: {
        first_task: {
          type: "choice",
          choice,
          confidence: 0.96,
          probabilities: { [choice]: 0.96, [other]: 0.04 },
        },
      },
      usage: { input_tokens: 42, output_tokens: 0 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function realJevFacade(fetchImpl: typeof fetch): JevDecisionFacadeV1 {
  return createJevDecisionFacadeV1({
    enabled: true,
    maxDecisions: 1,
    maxDeadlineMs: 2_500,
    transport: {
      apiKey: "test-schedule-key-not-for-output",
      deadlineMs: 2_500,
      maxRetries: 0,
      fetchImpl,
    },
  });
}

describe("V2 Task Jev schedule advice", () => {
  it("reuses a schedule receipt when multi-key confidence insertion order differs from sort order", async () => {
    const root = makeGitRoot();
    const first = makeTask(root, "jev-schedule-confidence-a");
    const second = makeTask(root, "jev-schedule-confidence-b");
    attachManagedWorktree(root, first);
    attachManagedWorktree(root, second);
    const confidence = Object.assign(Object.create(null), {
      z_question: { status: "available", value: 0.75 },
      a_question: { status: "unavailable", reasonCode: "not-returned" },
    }) as ReturnType<typeof jevResponse.projectJevConfidenceReceiptV1>;
    vi.spyOn(jevResponse, "projectJevConfidenceReceiptV1").mockReturnValue(
      confidence,
    );
    const facade = answerFacade();
    vi.useFakeTimers({ now: new Date("2026-09-27T00:00:00.000Z") });

    const firstPlan = await scheduleTaskKernelGraphWithJevV1(
      root,
      [first.taskId, second.taskId],
      {},
      { facade, egress },
    );
    expect(
      Object.keys(firstPlan.receipt.jevAdviceAudit?.transport.confidence ?? {}),
    ).toEqual(["z_question", "a_question"]);

    const repeatedPlan = await scheduleTaskKernelGraphWithJevV1(
      root,
      [first.taskId, second.taskId],
      {},
      { facade, egress },
    );

    expect(repeatedPlan.created).toBe(false);
    expect(repeatedPlan.receipt.receiptFingerprint).toBe(
      firstPlan.receipt.receiptFingerprint,
    );

    const firstAudit = firstPlan.receipt.jevAdviceAudit;
    if (!firstAudit) throw new Error("Schedule receipt Jev audit is missing");
    const legacyReceiptBody = {
      ...firstPlan.receipt,
      jevAdviceAudit: {
        ...firstAudit,
        transport: { ...firstAudit.transport, confidence },
      },
    };
    const legacyScheduleKey = fingerprintTaskValue(
      Object.fromEntries(
        Object.entries(legacyReceiptBody).filter(
          ([key]) =>
            ![
              "schemaVersion",
              "scope",
              "receiptFingerprint",
              "createdAt",
              "integrityVersion",
              "scheduleKey",
            ].includes(key),
        ),
      ),
    );
    const legacyUnsignedReceipt = {
      ...legacyReceiptBody,
      scheduleKey: legacyScheduleKey,
    };
    const legacyFingerprint = fingerprintTaskValue(
      Object.fromEntries(
        Object.entries(legacyUnsignedReceipt).filter(
          ([key]) => key !== "receiptFingerprint",
        ),
      ),
    );
    const legacyReceipt = {
      ...legacyUnsignedReceipt,
      receiptFingerprint: legacyFingerprint,
    };
    const receiptDir = path.join(
      root,
      ".pactile",
      ".runtime",
      "scheduler",
      "receipts",
    );
    fs.rmSync(path.resolve(root, firstPlan.receiptFile), { force: true });
    fs.writeFileSync(
      path.join(receiptDir, `${legacyFingerprint}.json`),
      `${JSON.stringify(legacyReceipt, null, 2)}\n`,
      { flag: "wx" },
    );

    const reusedLegacyPlan = await scheduleTaskKernelGraphWithJevV1(
      root,
      [first.taskId, second.taskId],
      {},
      { facade, egress },
    );
    expect(reusedLegacyPlan.created).toBe(false);
    expect(reusedLegacyPlan.receipt.receiptFingerprint).toBe(legacyFingerprint);
  });

  it("round-trips unavailable confidence receipts and verifies legacy fingerprints", async () => {
    const root = makeGitRoot();
    const candidate = makeTask(root, "jev-schedule-unavailable-confidence");
    const facade = answerFacade();
    const result = await scheduleTaskKernelGraphWithJevV1(
      root,
      [candidate.taskId],
      {},
      { facade, egress },
    );
    const confidence = result.receipt.jevAdviceAudit?.transport.confidence;

    expect(result.receipt.jevAdviceAudit).toMatchObject({
      status: "skipped",
      reasonCode: "insufficient-candidates",
      transport: {
        confidence: {
          first_task: { status: "unavailable", reasonCode: "not-returned" },
        },
      },
    });
    const loaded = readTaskKernelScheduleReceiptV1(
      root,
      result.receipt.receiptFingerprint,
    );
    expect(loaded.integrity).toBe("fingerprint-verified");
    expect(loaded.receipt.jevAdviceAudit).toEqual(
      result.receipt.jevAdviceAudit,
    );

    if (!confidence || !result.receipt.jevAdviceAudit)
      throw new Error("Unavailable confidence audit is missing");
    const legacyEnvelope = JSON.parse(
      JSON.stringify(result.receipt),
    ) as typeof result.receipt;
    const legacyAudit = legacyEnvelope.jevAdviceAudit;
    if (!legacyAudit) throw new Error("Schedule receipt Jev audit is missing");
    const legacyConfidence = Object.assign(Object.create(null), {
      z_question: { status: "available", value: 0.75 },
      a_question: { status: "unavailable", reasonCode: "not-returned" },
    }) as NonNullable<typeof confidence>;
    legacyEnvelope.jevAdviceAudit = {
      ...legacyAudit,
      transport: {
        ...legacyAudit.transport,
        confidence: legacyConfidence,
      },
    };
    const legacyFingerprintBase = Object.fromEntries(
      Object.entries(legacyEnvelope).filter(
        ([key]) => key !== "receiptFingerprint",
      ),
    );
    const legacyFingerprint = fingerprintTaskValue(legacyFingerprintBase);
    const legacyReceipt = {
      ...legacyEnvelope,
      receiptFingerprint: legacyFingerprint,
    };
    const receiptDir = path.join(
      root,
      ".pactile",
      ".runtime",
      "scheduler",
      "receipts",
    );
    fs.writeFileSync(
      path.join(receiptDir, `${legacyFingerprint}.json`),
      `${JSON.stringify(legacyReceipt, null, 2)}\n`,
      { flag: "wx" },
    );
    expect(
      readTaskKernelScheduleReceiptV1(root, legacyFingerprint),
    ).toMatchObject({
      integrity: "fingerprint-verified",
      receipt: { receiptFingerprint: legacyFingerprint },
    });

    const tampered = JSON.parse(
      fs.readFileSync(
        path.join(receiptDir, `${legacyFingerprint}.json`),
        "utf8",
      ),
    ) as typeof legacyReceipt;
    const tamperedConfidence = tampered.jevAdviceAudit?.transport.confidence as
      | Record<string, { status: string; reasonCode?: string }>
      | undefined;
    if (!tamperedConfidence?.a_question)
      throw new Error("Legacy confidence entry is missing");
    tamperedConfidence.a_question.reasonCode = "invalid";
    fs.writeFileSync(
      path.join(receiptDir, `${legacyFingerprint}.json`),
      `${JSON.stringify(tampered, null, 2)}\n`,
    );
    expect(() =>
      readTaskKernelScheduleReceiptV1(root, legacyFingerprint),
    ).toThrow(/fingerprint does not match its contents/);
  });

  it("advises only the first-wave eligible Run tie and binds adoption into the receipt", async () => {
    const root = makeGitRoot();
    const first = makeTask(root, "jev-schedule-a");
    const second = makeTask(root, "jev-schedule-b");
    attachManagedWorktree(root, first);
    attachManagedWorktree(root, second);
    const baseline = planTaskKernelGraphV1(root, [first.taskId, second.taskId]);
    const facade = answerFacade();

    const result = await scheduleTaskKernelGraphWithJevV1(
      root,
      [first.taskId, second.taskId],
      {},
      { facade, egress },
    );

    expect(facade.decide).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(facade.decide.mock.calls[0]?.[0]);
    expect(sent).not.toContain(first.taskId);
    expect(sent).not.toContain(second.taskId);
    expect(sent).not.toContain("src/jev-schedule-");
    expect(sent).toContain("candidate-01");
    expect(result.receipt.request.tasks).toEqual(baseline.request.tasks);
    expect(result.receipt.plan.waves[0]?.taskIds).toHaveLength(2);
    expect(result.receipt.jevAdviceAudit).toMatchObject({
      status: "answered",
      reasonCode: null,
      eligibilityChanged: false,
      suggestedTaskIds: [second.taskId, first.taskId],
      adoptedTaskIds: [second.taskId, first.taskId],
      overriddenTaskIds: [],
      finalEligibleCandidates: {
        candidateTaskIds: [first.taskId, second.taskId],
        eligibility: {
          approvalPassedTaskIds: [first.taskId, second.taskId],
          worktreePassedTaskIds: [first.taskId, second.taskId],
        },
      },
      transport: {
        confidence: {
          first_task: { status: "available", value: 0.96 },
        },
      },
    });
    expect(
      readTaskKernelScheduleReceiptV1(root, result.receipt.receiptFingerprint)
        .integrity,
    ).toBe("fingerprint-verified");
    expect(
      readTaskKernelScheduleReceiptV1(root, result.receipt.receiptFingerprint)
        .receipt.jevAdviceAudit,
    ).toEqual(result.receipt.jevAdviceAudit);
  });

  it("keeps an unresolved hard dependency out of Jev candidates and preserves the dependency plan", async () => {
    const root = makeGitRoot();
    const prerequisite = makeTask(root, "jev-schedule-prerequisite");
    const independent = makeTask(root, "jev-schedule-independent");
    const dependent = makeTask(root, "jev-schedule-dependent", {
      dependencies: [prerequisite.taskId],
      start: false,
    });
    attachManagedWorktree(root, prerequisite);
    attachManagedWorktree(root, independent);
    const facade = answerFacade({ choice: "candidate-01" });

    const result = await scheduleTaskKernelGraphWithJevV1(
      root,
      [prerequisite.taskId, independent.taskId, dependent.taskId],
      {},
      { facade, egress },
    );

    expect(facade.decide).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(facade.decide.mock.calls[0]?.[0]);
    expect(sent).not.toContain(dependent.taskId);
    expect(
      result.receipt.request.tasks.find(
        ({ taskId }) => taskId === dependent.taskId,
      ),
    ).toMatchObject({ dependsOn: [prerequisite.taskId], state: "waiting" });
    const prerequisiteDecision = result.receipt.plan.decisions.find(
      ({ taskId }) => taskId === prerequisite.taskId,
    );
    const dependentDecision = result.receipt.plan.decisions.find(
      ({ taskId }) => taskId === dependent.taskId,
    );
    expect(prerequisiteDecision?.action).toBe("scheduled");
    expect(dependentDecision?.action).toBe("scheduled");
    expect(dependentDecision?.wave).toBeGreaterThan(
      prerequisiteDecision?.wave ?? 0,
    );
    expect(result.receipt.plan.waves[0]?.candidateTaskIds).not.toContain(
      dependent.taskId,
    );
    expect(result.receipt.jevAdviceAudit?.suggestedTaskIds).not.toContain(
      dependent.taskId,
    );
  });

  it("supersedes a Jev answer when the waiting Run changes during the request", async () => {
    const root = makeGitRoot();
    const first = makeTask(root, "jev-stale-a");
    const second = makeTask(root, "jev-stale-b");
    attachManagedWorktree(root, first);
    attachManagedWorktree(root, second);
    const facade = answerFacade({
      beforeAnswer: () => {
        const read = readTaskKernel({
          root,
          taskDir: first.taskDir,
          cwd: root,
        });
        if (read.kind !== "task-kernel-v2")
          throw new Error("Expected Task Kernel V2");
        if (!first.runId) throw new Error("Run fixture is missing");
        resumeTaskRun({
          root,
          taskDir: first.taskDir,
          expectedRevision: read.kernel.revision,
          runId: first.runId,
          actor: "test-worker",
          idempotencyKey: "resume-during-jev",
        });
      },
    });

    const result = await scheduleTaskKernelGraphWithJevV1(
      root,
      [first.taskId, second.taskId],
      {},
      { facade, egress },
    );

    expect(result.receipt.request.jevAdvice).toBeUndefined();
    expect(result.receipt.jevAdviceAudit).toMatchObject({
      status: "superseded",
      reasonCode: "eligibility-changed",
      eligibilityChanged: true,
      adoptedTaskIds: [],
      overriddenTaskIds: [second.taskId, first.taskId],
    });
    expect(result.receipt.taskKernelRevisions[first.taskId]).toBeGreaterThan(2);
  });

  it("does not ask Jev to rank a candidate without its approved manager-owned Run worktree", async () => {
    const root = makeGitRoot();
    const eligible = makeTask(root, "jev-eligible-a");
    const unbound = makeTask(root, "jev-unbound-b");
    attachManagedWorktree(root, eligible);
    const facade = answerFacade();

    const result = await scheduleTaskKernelGraphWithJevV1(
      root,
      [eligible.taskId, unbound.taskId],
      {},
      { facade, egress },
    );

    expect(facade.decide).not.toHaveBeenCalled();
    expect(result.receipt.request.jevAdvice).toBeUndefined();
    expect(result.receipt.jevAdviceAudit).toMatchObject({
      status: "skipped",
      reasonCode: "insufficient-candidates",
      finalEligibleCandidates: {
        candidateTaskIds: [eligible.taskId],
        filteredCandidates: [
          { taskId: unbound.taskId, reasonCode: "worktree-rejected" },
        ],
      },
    });
  });

  it("filters a waiting Run whose approval timestamp is invalid", async () => {
    const root = makeGitRoot();
    const invalid = makeTask(root, "jev-approval-invalid", {
      approvedAt: "not-an-instant",
    });
    const eligible = makeTask(root, "jev-approval-eligible");
    attachManagedWorktree(root, invalid);
    attachManagedWorktree(root, eligible);
    const facade = answerFacade();

    const result = await scheduleTaskKernelGraphWithJevV1(
      root,
      [invalid.taskId, eligible.taskId],
      {},
      { facade, egress },
    );

    expect(facade.decide).not.toHaveBeenCalled();
    expect(result.receipt.request.jevAdvice).toBeUndefined();
    expect(result.receipt.jevAdviceAudit).toMatchObject({
      status: "skipped",
      reasonCode: "insufficient-candidates",
      finalEligibleCandidates: {
        candidateTaskIds: [eligible.taskId],
        filteredCandidates: [
          { taskId: invalid.taskId, reasonCode: "approval-rejected" },
        ],
        eligibility: {
          approvalPassedTaskIds: [eligible.taskId],
          worktreePassedTaskIds: [eligible.taskId],
        },
      },
    });
  });

  it("filters a candidate that conflicts with an active project write lease", async () => {
    const root = makeGitRoot();
    const leaseHolder = makeTask(root, "jev-lease-holder", {
      writeSet: ["src/shared.ts"],
    });
    const conflict = makeTask(root, "jev-lease-conflict", {
      writeSet: ["src/shared.ts"],
    });
    const unaffected = makeTask(root, "jev-lease-unaffected", {
      writeSet: ["src/unaffected.ts"],
    });
    attachManagedWorktree(root, leaseHolder);
    attachManagedWorktree(root, conflict);
    attachManagedWorktree(root, unaffected);
    if (!leaseHolder.runId) throw new Error("Lease holder Run is missing");
    const holderSchedule = scheduleTaskKernelGraph(root, [leaseHolder.taskId]);
    const admission = acquireTaskKernelRunDispatchV1(root, {
      scheduleReceiptFingerprint: holderSchedule.receipt.receiptFingerprint,
      taskId: leaseHolder.taskId,
      runId: leaseHolder.runId,
      owner: {
        host: "pi",
        role: "implement",
        sessionId: null,
        threadId: null,
        hostId: null,
      },
    });
    expect(admission.permitted).toBe(true);
    const facade = answerFacade();

    const result = await scheduleTaskKernelGraphWithJevV1(
      root,
      [conflict.taskId, unaffected.taskId],
      {},
      { facade, egress },
    );

    expect(facade.decide).not.toHaveBeenCalled();
    expect(result.receipt.request.jevAdvice).toBeUndefined();
    expect(result.receipt.jevAdviceAudit).toMatchObject({
      status: "skipped",
      reasonCode: "insufficient-candidates",
      finalEligibleCandidates: {
        candidateTaskIds: [unaffected.taskId],
        filteredCandidates: [
          {
            taskId: conflict.taskId,
            reasonCode: "active-write-lease-conflict",
          },
        ],
      },
    });
  });

  it("does not send later-wave candidates held behind overlapping writes", async () => {
    const root = makeGitRoot();
    const first = makeTask(root, "jev-overlap-a", {
      writeSet: ["src/shared.ts"],
    });
    const second = makeTask(root, "jev-overlap-b", {
      writeSet: ["src/shared.ts"],
    });
    attachManagedWorktree(root, first);
    attachManagedWorktree(root, second);
    const baseline = planTaskKernelGraphV1(root, [first.taskId, second.taskId]);
    expect(baseline.plan.waves[0]?.candidateTaskIds).toHaveLength(1);
    const facade = answerFacade();

    const result = await scheduleTaskKernelGraphWithJevV1(
      root,
      [first.taskId, second.taskId],
      {},
      { facade, egress },
    );

    expect(facade.decide).not.toHaveBeenCalled();
    expect(result.receipt.request.jevAdvice).toBeUndefined();
    expect(result.receipt.jevAdviceAudit).toMatchObject({
      status: "skipped",
      reasonCode: "insufficient-candidates",
      preparedRequestSnapshot: null,
      sentRequestSnapshot: null,
    });
  });

  it.each([
    ["deny", "jev:\n  egress: deny\n", "egress-denied"],
    ["invalid", "jev:\n  egress: maybe\n", "configuration-invalid"],
  ] as const)(
    "keeps the public schedule plan route deterministic with zero network for project egress %s",
    async (_label, config, reasonCode) => {
      const root = makeGitRoot();
      const first = makeTask(root, `jev-egress-a-${reasonCode}`);
      const second = makeTask(root, `jev-egress-b-${reasonCode}`);
      attachManagedWorktree(root, first);
      attachManagedWorktree(root, second);
      fs.writeFileSync(
        path.join(root, ".pactile", "config.yaml"),
        config,
        "utf8",
      );
      vi.stubEnv("PACTILE_JEV_API_KEY", "test-schedule-key-not-for-output");
      vi.stubEnv("PACTILE_JEV_ENABLED", "true");
      const fetchMock = vi.fn(async () => successResponse("candidate-02"));
      vi.stubGlobal("fetch", fetchMock);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const before = planTaskKernelGraphV1(root, [first.taskId, second.taskId]);

      await expect(
        runTaskCliWithWorkspaceReclaim(
          ["schedule", "plan", first.taskId, second.taskId],
          root,
        ),
      ).resolves.toBe(0);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(1);
      const output = JSON.parse(String(log.mock.lastCall?.[0])) as {
        receipt: {
          request: { jevAdvice?: unknown };
          plan: unknown;
          jevAdviceAudit: {
            status: string;
            reasonCode: string;
            sentRequestSnapshot: unknown;
            transport: { attempts: number };
          };
        };
      };
      expect(output.receipt.request.jevAdvice).toBeUndefined();
      expect(output.receipt.plan).toEqual(before.plan);
      expect(output.receipt.jevAdviceAudit).toMatchObject({
        status: "fallback",
        reasonCode,
        sentRequestSnapshot: null,
        transport: {
          attempts: 0,
          confidence: {
            first_task: {
              status: "unavailable",
              reasonCode: "not-returned",
            },
          },
        },
      });
      expect(JSON.stringify(output)).not.toContain(
        "test-schedule-key-not-for-output",
      );
      expect(fetchMock.mock.calls).toHaveLength(0);
    },
  );

  it("keeps the public receipt policy snapshot consistent when deny changes to allow before the library check", async () => {
    const root = makeGitRoot();
    const first = makeTask(root, "jev-egress-deny-to-allow-a");
    const second = makeTask(root, "jev-egress-deny-to-allow-b");
    attachManagedWorktree(root, first);
    attachManagedWorktree(root, second);
    fs.writeFileSync(
      path.join(root, ".pactile", "config.yaml"),
      "jev:\n  egress: deny\n",
      "utf8",
    );
    vi.stubEnv("PACTILE_JEV_API_KEY", "test-schedule-key-not-for-output");
    vi.stubEnv("PACTILE_JEV_ENABLED", "true");
    const fetchMock = vi.fn(async () => successResponse());
    vi.stubGlobal("fetch", fetchMock);
    const denied = { allowed: false, reasonCode: "egress-denied" } as const;
    const allowed = { allowed: true, source: "configured" } as const;
    vi.spyOn(jevProjectPolicy, "resolveJevProjectEgressPolicyV1")
      .mockReturnValueOnce(denied)
      .mockReturnValue(allowed);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      runTaskCliWithWorkspaceReclaim(
        ["schedule", "plan", first.taskId, second.taskId],
        root,
      ),
    ).resolves.toBe(0);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    const output = JSON.parse(String(log.mock.lastCall?.[0])) as {
      receipt: {
        jevAdviceAudit: {
          status: string;
          reasonCode: string;
          projectEgressPolicy: {
            atScheduleStart: string;
            beforeAdviceRequest: string;
            afterAdviceResponse: string;
            changed: boolean;
          };
        };
      };
    };
    expect(output.receipt.jevAdviceAudit).toMatchObject({
      status: "fallback",
      reasonCode: "egress-denied",
      projectEgressPolicy: {
        atScheduleStart: "egress-denied",
        beforeAdviceRequest: "allowed",
        afterAdviceResponse: "allowed",
        changed: true,
      },
    });
  });

  it.each([
    ["deny", "jev:\n  egress: deny\n", "egress-denied"],
    ["invalid", "jev:\n  egress: maybe\n", "configuration-invalid"],
  ] as const)(
    "keeps direct V2 library calls local for project egress %s",
    async (_label, config, reasonCode) => {
      const root = makeGitRoot();
      const first = makeTask(root, `jev-api-egress-a-${reasonCode}`);
      const second = makeTask(root, `jev-api-egress-b-${reasonCode}`);
      attachManagedWorktree(root, first);
      attachManagedWorktree(root, second);
      fs.writeFileSync(
        path.join(root, ".pactile", "config.yaml"),
        config,
        "utf8",
      );
      const fetchMock = vi.fn(async () => successResponse());
      const facade = realJevFacade(fetchMock as unknown as typeof fetch);
      const baseline = planTaskKernelGraphV1(root, [
        first.taskId,
        second.taskId,
      ]);

      const result = await scheduleTaskKernelGraphWithJevV1(
        root,
        [first.taskId, second.taskId],
        {},
        { facade, egress },
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.receipt.request.jevAdvice).toBeUndefined();
      expect(result.receipt.plan).toEqual(baseline.plan);
      expect(result.receipt.jevAdviceAudit).toMatchObject({
        status: "fallback",
        reasonCode,
        sentRequestSnapshot: null,
        transport: { attempts: 0 },
        projectEgressPolicy: {
          atScheduleStart: reasonCode,
          beforeAdviceRequest: reasonCode,
          afterAdviceResponse: reasonCode,
          changed: false,
        },
      });
    },
  );

  it("rejects public schedule plan advice when project egress changes to deny during the request", async () => {
    const root = makeGitRoot();
    const first = makeTask(root, "jev-egress-drift-a");
    const second = makeTask(root, "jev-egress-drift-b");
    attachManagedWorktree(root, first);
    attachManagedWorktree(root, second);
    const configPath = path.join(root, ".pactile", "config.yaml");
    fs.writeFileSync(configPath, "jev:\n  egress: allow\n", "utf8");
    const fetchMock = vi.fn(async () => {
      fs.writeFileSync(configPath, "jev:\n  egress: deny\n", "utf8");
      return successResponse();
    });
    vi.stubEnv("PACTILE_JEV_API_KEY", "test-schedule-key-not-for-output");
    vi.stubEnv("PACTILE_JEV_ENABLED", "true");
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const baseline = planTaskKernelGraphV1(root, [first.taskId, second.taskId]);

    await expect(
      runTaskCliWithWorkspaceReclaim(
        ["schedule", "plan", first.taskId, second.taskId],
        root,
      ),
    ).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    const output = JSON.parse(String(log.mock.lastCall?.[0])) as {
      receipt: {
        request: { jevAdvice?: unknown };
        plan: unknown;
        jevAdviceAudit: {
          status: string;
          reasonCode: string;
          adoptedTaskIds: string[];
          overriddenTaskIds: string[];
          sentRequestSnapshot: { candidateTaskIds: string[] } | null;
          projectEgressPolicy: {
            atScheduleStart: string;
            beforeAdviceRequest: string;
            afterAdviceResponse: string;
            changed: boolean;
          };
        };
      };
    };
    expect(output.receipt.request.jevAdvice).toBeUndefined();
    expect(output.receipt.plan).toEqual(baseline.plan);
    expect(output.receipt.jevAdviceAudit).toMatchObject({
      status: "superseded",
      reasonCode: "egress-denied",
      adoptedTaskIds: [],
      overriddenTaskIds: [second.taskId, first.taskId],
      sentRequestSnapshot: {
        candidateTaskIds: [first.taskId, second.taskId],
      },
      projectEgressPolicy: {
        atScheduleStart: "allowed",
        beforeAdviceRequest: "allowed",
        afterAdviceResponse: "egress-denied",
        changed: true,
      },
    });
  });

  it("routes public task schedule plan through Jev when project egress is allowed", async () => {
    const root = makeGitRoot();
    const first = makeTask(root, "jev-cli-allowed-a");
    const second = makeTask(root, "jev-cli-allowed-b");
    attachManagedWorktree(root, first);
    attachManagedWorktree(root, second);
    fs.writeFileSync(
      path.join(root, ".pactile", "config.yaml"),
      "jev:\n  egress: allow\n",
      "utf8",
    );
    vi.stubEnv("PACTILE_JEV_API_KEY", "test-schedule-key-not-for-output");
    vi.stubEnv("PACTILE_JEV_ENABLED", "true");
    const requestBodies: string[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        requestBodies.push(String(init?.body ?? ""));
        return successResponse();
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      runTaskCliWithWorkspaceReclaim(
        ["schedule", "plan", first.taskId, second.taskId],
        root,
      ),
    ).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestBody = requestBodies[0] ?? "";
    expect(requestBody).not.toContain(first.taskId);
    expect(requestBody).not.toContain(second.taskId);
    expect(requestBody).not.toContain("src/jev-cli-allowed-");
    expect(log).toHaveBeenCalledTimes(1);
    const output = JSON.parse(String(log.mock.lastCall?.[0])) as {
      receipt: {
        jevAdviceAudit: {
          status: string;
          adoptedTaskIds: string[];
          projectEgressPolicy: {
            atScheduleStart: string;
            beforeAdviceRequest: string;
            afterAdviceResponse: string;
            changed: boolean;
          };
        };
      };
    };
    expect(output.receipt.jevAdviceAudit).toMatchObject({
      status: "answered",
      adoptedTaskIds: [second.taskId, first.taskId],
      projectEgressPolicy: {
        atScheduleStart: "allowed",
        beforeAdviceRequest: "allowed",
        afterAdviceResponse: "allowed",
        changed: false,
      },
    });
  });
});
