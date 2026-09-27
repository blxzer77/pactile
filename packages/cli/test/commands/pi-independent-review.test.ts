import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPiCli } from "../../src/commands/pi.js";
import {
  checkTaskClose,
  closeTaskKernel,
  createTaskKernel,
  readTaskKernel,
  recordTaskRunResult,
  startTaskRun,
  type TaskKernelSnapshotV2,
} from "../../src/core/task/index.js";
import { INDEPENDENT_REVIEW_AREAS } from "../../src/pactile/review/contract.js";
import { PiTaskBridge } from "../../src/pactile/pi/bridge.js";
import type { PiRunInput, PiRunRecord } from "../../src/pactile/pi/bridge.js";
import type { PiRpcLaunch } from "../../src/pactile/pi/rpc.js";

const roots: string[] = [];
const fakePiScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.tmp/p31-script-build/fixtures/fake-pi-review-provider.js",
);

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

interface ReviewFixture {
  root: string;
  task: string;
  taskDir: string;
  runId: string;
  candidateSnapshotId: string;
  candidateFingerprint: string;
  promptFile: string;
  runEvidenceRef?: string;
}

function fixture(
  options: {
    implementationSessionId?: string;
    includeRunEvidence?: boolean;
  } = {},
): ReviewFixture {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pactile-p40-review-route-"),
  );
  roots.push(root);
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "result.txt"), "candidate output\n");
  fs.writeFileSync(
    path.join(root, "tests", "verify.txt"),
    "verification evidence\n",
  );

  const task = "pi-review";
  const taskDir = path.join(root, ".pactile", "tasks", "09-27-pi-review");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, "verify.md"),
    "# Verify\nReview the fixed candidate.\n",
  );
  const runEvidenceRef = options.includeRunEvidence
    ? "run-completion.log"
    : null;
  if (runEvidenceRef) {
    fs.writeFileSync(
      path.join(taskDir, runEvidenceRef),
      "Run completion evidence\n",
    );
  }

  const created = createTaskKernel({
    root,
    taskDir,
    actor: "author",
    idempotencyKey: "create:pi-review",
    definition: {
      taskId: task,
      title: "Pi Review fixture",
      description: "Verify one fixed candidate.",
      deliverable: "A locally reviewable result.",
      deliveryLevel: "local-result",
      acceptanceCriteria: [
        { id: "AC-1", description: "The candidate output is present." },
      ],
      dependencies: [],
    },
  });
  const started = startTaskRun({
    root,
    taskDir,
    expectedRevision: created.kernel.revision,
    actor: "runner",
    idempotencyKey: "start:pi-review",
    input: { summary: "Produce the candidate.", references: ["prd.md"] },
    authorization: {
      approvedBy: "approver",
      approvedAt: "2026-09-27T00:00:00.000Z",
      scope: "result.txt, tests/verify.txt",
      evidenceRef: "approval.json",
    },
    writeSetSnapshot: ["result.txt", "tests/verify.txt"],
    ...(options.implementationSessionId
      ? {
          host: {
            host: "pi",
            role: "implement",
            sessionId: options.implementationSessionId,
            hostId: null,
            threadId: null,
            requestRefs: [],
            eventRefs: [],
            resultRefs: [],
            assuranceSource: "test-fixture",
          },
        }
      : {}),
  });
  const run = started.kernel.runs.at(-1);
  if (!run) throw new Error("Task Run is missing");
  const completed = recordTaskRunResult({
    root,
    taskDir,
    expectedRevision: started.kernel.revision,
    runId: run.id,
    outcome: "completed",
    summary: "Candidate output is ready.",
    evidenceRefs: [
      "tests/verify.txt",
      ...(runEvidenceRef ? [runEvidenceRef] : []),
    ],
    actor: "runner",
    idempotencyKey: "complete:pi-review",
  });
  const candidate = completed.kernel.runs.at(-1)?.candidateSnapshot;
  if (!candidate) throw new Error("Run candidate snapshot is missing");
  const promptFile = path.join(taskDir, "review-prompt.md");
  fs.writeFileSync(promptFile, "Perform the independent read-only Review.");
  return {
    root,
    task,
    taskDir,
    runId: run.id,
    candidateSnapshotId: candidate.id,
    candidateFingerprint: candidate.fingerprint,
    promptFile,
    ...(runEvidenceRef ? { runEvidenceRef } : {}),
  };
}

function report(fixture: ReviewFixture): Record<string, unknown> {
  const citedCandidateFile = "tests/verify.txt";
  return {
    contractVersion: 1,
    runId: fixture.runId,
    candidateSnapshotId: fixture.candidateSnapshotId,
    candidateFingerprint: fixture.candidateFingerprint,
    verdict: "pass",
    coverage: Object.fromEntries(
      INDEPENDENT_REVIEW_AREAS.map((area) => [
        area,
        {
          status: "clear",
          confidence: "high",
          evidenceRefs: [
            citedCandidateFile,
            ...(area === "task-drift" && fixture.runEvidenceRef
              ? [fixture.runEvidenceRef]
              : []),
          ],
          note: null,
        },
      ]),
    ),
    findings: [],
    blockers: [],
    unresolvedQuestions: [],
    evidenceRefs: [citedCandidateFile],
    acceptanceEvidence: { "AC-1": ["result.txt"] },
    escalation: { required: false, target: "none", reasons: [] },
    usage: { inputTokens: 10, outputTokens: 20, estimatedCostMicros: null },
  };
}

function fakePi(
  fixture: ReviewFixture,
  value: Record<string, unknown>,
  sessionId = "pi-checker",
): PiRpcLaunch {
  const resultFile = path.join(fixture.taskDir, "fake-pi-review-result.json");
  fs.writeFileSync(resultFile, JSON.stringify(value) + "\n");
  return {
    command: process.execPath,
    args: [
      fakePiScript,
      "--session-id",
      sessionId,
      "--result-file",
      resultFile,
    ],
  };
}

function readKernel(root: string, taskDir: string): TaskKernelSnapshotV2 {
  const result = readTaskKernel({ root, taskDir, cwd: root });
  if (result.kind !== "task-kernel-v2")
    throw new Error("Expected a V2 Task Kernel");
  return result.kernel;
}

function closeInput(task: ReviewFixture) {
  const kernel = readKernel(task.root, task.taskDir);
  const run = kernel.runs.at(-1);
  const review = kernel.reviews.at(-1);
  const candidate = run?.candidateSnapshot;
  if (!run || !review || !candidate) {
    throw new Error("Recorded Run, Review, or candidate snapshot is missing");
  }
  return {
    root: task.root,
    taskDir: task.taskDir,
    expectedRevision: kernel.revision,
    runId: run.id,
    reviewId: review.id,
    candidateObservation: {
      snapshotId: candidate.id,
      fingerprint: candidate.fingerprint,
      observedBy: "closer",
      observedAt: "2026-09-27T00:00:00.000Z",
      source: "caller-attested",
      evidenceRef: "candidate-observation.json",
    },
    deliveryEvidence: {
      level: "local-result" as const,
      reference: "result.txt",
      summary: "The candidate deliverable is present.",
    },
  };
}

async function runReview(
  fixture: ReviewFixture,
  value: Record<string, unknown>,
  prompt = "Review the candidate.",
  sessionId = "pi-checker",
): Promise<number> {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  fs.writeFileSync(fixture.promptFile, prompt);
  const invoke = runPiCli as unknown as (
    args: string[],
    root: string,
    launch: PiRpcLaunch,
  ) => Promise<number>;
  return invoke(
    [
      "run",
      fixture.task,
      "--role",
      "check",
      "--prompt-file",
      fixture.promptFile,
    ],
    fixture.root,
    fakePi(fixture, value, sessionId),
  );
}

describe("P40 independent Pi Review route", () => {
  it("starts a separate Check, records a verified stop receipt, and atomically records a Review artifact", async () => {
    const task = fixture();
    const status = await runReview(task, report(task));
    const kernel = readKernel(task.root, task.taskDir);
    expect(status).toBe(0);
    expect(kernel.reviews).toHaveLength(1);
    const piRun = JSON.parse(
      fs.readFileSync(
        path.join(task.taskDir, "pi-bridge", "latest.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;

    expect(kernel.reviews[0]).toMatchObject({
      runId: task.runId,
      decision: "pass",
      reviewer: "pi-session:pi-checker",
    });
    const checkEvidenceRefs = [
      piRun["review_file"],
      piRun["review_start_receipt_ref"],
      piRun["review_stop_receipt_ref"],
      piRun["result_file"],
      piRun["progress_evidence_ref"],
    ];
    expect(
      checkEvidenceRefs.every((reference) => typeof reference === "string"),
    ).toBe(true);
    const reviewEvidenceRefs = checkEvidenceRefs as string[];
    expect(kernel.reviews[0]?.evidenceRefs).toEqual(
      expect.arrayContaining(reviewEvidenceRefs),
    );
    const verifiedItems = kernel.reviews[0]?.evidenceVerification?.items ?? [];
    for (const reference of reviewEvidenceRefs) {
      const bytes = fs.readFileSync(path.join(task.taskDir, reference));
      expect(verifiedItems).toContainEqual({
        ref: reference,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength,
        source: "task-evidence",
      });
    }
    expect(piRun).toMatchObject({
      role: "check",
      outcome: "settled",
      review_status: "recorded",
      reviewer_identity_assurance: "caller-declared",
    });
    expect(piRun["review_start_receipt_ref"]).toEqual(
      expect.stringMatching(/^pi-bridge\/starts\//u),
    );
    expect(piRun["review_stop_receipt_ref"]).toEqual(
      expect.stringMatching(/^pi-bridge\/stops\//u),
    );
    expect(piRun["review_file"]).toEqual(
      expect.stringMatching(/^pi-bridge\/reviews\//u),
    );
    expect(
      fs.existsSync(path.join(task.taskDir, String(piRun["review_file"]))),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          task.taskDir,
          String(piRun["codex_escalation_request_ref"] ?? "__missing__"),
        ),
      ),
    ).toBe(false);
    expect(kernel.phase).toBe("verify");
  });

  it("does not record a PASS when Pi reports a tool/provider failure", async () => {
    const task = fixture();
    expect(await runReview(task, report(task), "TEST_TOOL_ERROR")).toBe(1);
    expect(readKernel(task.root, task.taskDir).reviews).toHaveLength(0);
  });

  it("rejects a stale candidate fingerprint and does not record a Kernel Review", async () => {
    const task = fixture();
    const stale = report(task);
    stale["candidateFingerprint"] = "b".repeat(64);
    expect(await runReview(task, stale)).toBe(1);
    expect(readKernel(task.root, task.taskDir).reviews).toHaveLength(0);
  });

  it("rejects a Check session that matches the implementation Run host session", async () => {
    const task = fixture({ implementationSessionId: "pi-checker" });
    expect(await runReview(task, report(task))).toBe(1);
    expect(readKernel(task.root, task.taskDir).reviews).toHaveLength(0);
    const piRun = JSON.parse(
      fs.readFileSync(
        path.join(task.taskDir, "pi-bridge", "latest.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(piRun["review_rejection_reason"]).toContain(
      "matches the implementation Run host session",
    );
  });

  it("rejects a candidate changed after Run completion, including an uncited entry", async () => {
    const task = fixture();
    expect(await runReview(task, report(task), "TEST_MUTATE_CANDIDATE")).toBe(
      1,
    );
    expect(readKernel(task.root, task.taskDir).reviews).toHaveLength(0);
  });

  it("rejects missing or changed evidence before Kernel Review persistence", async () => {
    const missing = fixture();
    fs.rmSync(path.join(missing.root, "tests", "verify.txt"));
    expect(await runReview(missing, report(missing))).toBe(1);
    expect(readKernel(missing.root, missing.taskDir).reviews).toHaveLength(0);

    const malformed = fixture();
    const badEvidence = report(malformed);
    badEvidence["evidenceRefs"] = ["candidate-without-bytes.txt"];
    expect(await runReview(malformed, badEvidence)).toBe(1);
    expect(readKernel(malformed.root, malformed.taskDir).reviews).toHaveLength(
      0,
    );
  });

  it("public Close rejects a Review artifact changed after PASS was recorded", async () => {
    const task = fixture();
    expect(await runReview(task, report(task))).toBe(0);
    const piRun = JSON.parse(
      fs.readFileSync(
        path.join(task.taskDir, "pi-bridge", "latest.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const artifactRef = String(piRun["review_file"]);
    fs.appendFileSync(
      path.join(task.taskDir, artifactRef),
      "tampered after Review\n",
    );

    const close = closeInput(task);
    expect(checkTaskClose(close).join("\n")).toContain(
      "Stored Review evidence",
    );
    expect(() =>
      closeTaskKernel({
        ...close,
        actor: "closer",
        idempotencyKey: "close-after-review-artifact-tamper",
      }),
    ).toThrow(/Stored Review evidence/u);
    expect(readKernel(task.root, task.taskDir).phase).toBe("verify");
  });

  it("public Close rejects a Check stop receipt changed after PASS was recorded", async () => {
    const task = fixture();
    expect(await runReview(task, report(task))).toBe(0);
    const piRun = JSON.parse(
      fs.readFileSync(
        path.join(task.taskDir, "pi-bridge", "latest.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const stopReceiptRef = String(piRun["review_stop_receipt_ref"]);
    fs.appendFileSync(
      path.join(task.taskDir, stopReceiptRef),
      "tampered after Review\n",
    );

    const close = closeInput(task);
    expect(checkTaskClose(close).join("\n")).toContain(
      "Stored Review evidence",
    );
    expect(() =>
      closeTaskKernel({
        ...close,
        actor: "closer",
        idempotencyKey: "close-after-review-stop-receipt-tamper",
      }),
    ).toThrow(/Stored Review evidence/u);
    expect(readKernel(task.root, task.taskDir).phase).toBe("verify");
  });

  it("public Close rejects a coverage-only Run evidence file changed after PASS", async () => {
    const task = fixture({ includeRunEvidence: true });
    const runEvidenceRef = task.runEvidenceRef;
    if (!runEvidenceRef)
      throw new Error("Run evidence fixture was not created");
    expect(await runReview(task, report(task))).toBe(0);
    fs.writeFileSync(
      path.join(task.taskDir, runEvidenceRef),
      "changed after Review\n",
    );

    const close = closeInput(task);
    expect(checkTaskClose(close).join("\n")).toContain(
      "Run evidence " +
        runEvidenceRef +
        " no longer matches its completion-time digest.",
    );
    expect(() =>
      closeTaskKernel({
        ...close,
        actor: "closer",
        idempotencyKey: "close-after-coverage-run-evidence-tamper",
      }),
    ).toThrow(
      new RegExp(
        "Run evidence " +
          runEvidenceRef +
          " no longer matches its completion-time digest",
        "u",
      ),
    );
    expect(readKernel(task.root, task.taskDir).phase).toBe("verify");
  });

  it("rejects tampered persisted stop evidence before Kernel Review persistence", async () => {
    const task = fixture();
    const originalRun = PiTaskBridge.prototype.run;
    vi.spyOn(PiTaskBridge.prototype, "run").mockImplementation(async function (
      this: PiTaskBridge,
      input: PiRunInput,
    ): Promise<PiRunRecord> {
      const result = await originalRun.call(this, input);
      if (result.review_stop_receipt_ref) {
        const file = path.join(task.taskDir, result.review_stop_receipt_ref);
        const receipt = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
          string,
          unknown
        >;
        receipt["exitCode"] = 7;
        fs.writeFileSync(file, `${JSON.stringify(receipt)}\n`);
      }
      return result;
    });
    expect(await runReview(task, report(task))).toBe(1);
    expect(readKernel(task.root, task.taskDir).reviews).toHaveLength(0);
  });

  it("prepares a bound Codex escalation without claiming a Codex response", async () => {
    const task = fixture();
    const escalated = report(task);
    escalated["verdict"] = "needs-changes";
    const coverage = escalated["coverage"] as Record<
      string,
      { status: string; confidence: string; evidenceRefs: string[]; note: null }
    >;
    coverage["security"] = { ...coverage["security"], confidence: "low" };
    escalated["escalation"] = {
      required: true,
      target: "codex",
      reasons: ["uncertainty"],
    };
    expect(await runReview(task, escalated)).toBe(1);

    const kernel = readKernel(task.root, task.taskDir);
    expect(kernel.reviews).toHaveLength(1);
    expect(kernel.reviews[0]?.decision).toBe("needs-changes");
    const piRun = JSON.parse(
      fs.readFileSync(
        path.join(task.taskDir, "pi-bridge", "latest.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(piRun).toMatchObject({
      review_status: "recorded",
      codex_escalation_request_status: "prepared",
    });
    const request = JSON.parse(
      fs.readFileSync(
        path.join(task.taskDir, String(piRun["codex_escalation_request_ref"])),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(request).toMatchObject({
      status: "prepared",
      target: "codex",
      sentAt: null,
      responseRef: null,
    });
    expect(request["reviewArtifactRef"]).toBe(piRun["review_file"]);
    expect(request["reviewArtifactSha256"]).toEqual(
      expect.stringMatching(/^[a-f0-9]{64}$/u),
    );
    expect(request["reviewContentFingerprint"]).toEqual(
      expect.stringMatching(/^[a-f0-9]{64}$/u),
    );
  });
});
