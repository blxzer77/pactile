import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizePactileJsonV1,
  fingerprintPactileContractV1,
} from "../../../src/core/index.js";
import {
  projectTaskKernelLifecycle,
  readTaskKernel,
} from "../../../src/core/task/index.js";
import { runTaskCli } from "../../../src/commands/task.js";
import { prepareSelectedTaskAgentTileSelection } from "../../../src/pactile/registry.js";
import {
  createSessionJevReceiptV1,
  readSessionJevReceiptV1,
  sessionJevApplicationV1,
} from "../../../src/pactile/task/session-jev-receipt.js";

const JEV_ORIGIN = "https://api.typesafe.ai";
const API_KEY = "session-test-secret-key";
const CLI_ENTRY = fileURLToPath(
  new URL("../../../dist/cli/index.js", import.meta.url),
);
const FAKE_JEV_PRELOAD = fileURLToPath(
  new URL(
    "../../../.tmp/p31-script-build/fixtures/fake-jev-preload.js",
    import.meta.url,
  ),
);
const roots: string[] = [];
const externalArtifacts = new Set<string>();

const DENIED_POLICY = {
  filesystem: "write",
  process: "execute",
  network: "forbidden",
  credentials: "forbidden",
  privacy: "local-only",
  egressDestinations: [],
  telemetry: "local-only",
  cost: "medium",
} as const;
const APPROVED_POLICY = {
  ...DENIED_POLICY,
  network: "project-authorized",
  credentials: "project-authorized",
  privacy: "project-approved-egress",
  egressDestinations: [JEV_ORIGIN],
} as const;

interface CliProcessOptions {
  readonly apiKey?: string;
  readonly preload?: string;
  readonly response?: "answer" | "failure" | "wait";
  readonly releaseFile?: string;
  readonly selectedRefs?: readonly string[];
  readonly enabled?: string;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  for (const artifact of externalArtifacts)
    fs.rmSync(artifact, { force: true });
  externalArtifacts.clear();
});

function testArtifactPath(root: string, name: string): string {
  const file = path.join(
    path.dirname(root),
    `${path.basename(root)}-${name}`,
  );
  externalArtifacts.add(file);
  return file;
}

function writeRunResultCandidate(root: string): string {
  const bytes = Buffer.from("Run result fixture candidate\n", "utf8");
  fs.writeFileSync(path.join(root, "result.txt"), bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

function createActiveTask(
  root: string,
  policy: typeof APPROVED_POLICY | typeof DENIED_POLICY,
  writeSet?: readonly string[],
): {
  readonly slug: string;
  readonly runId: string;
} {
  fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=alice\n");
  vi.stubEnv("PACTILE_CONTEXT_ID", "codex_p34_session_jev");
  const slug = "session-jev-task";
  const errorLog = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const run = (args: string[]): void => {
    const code = runTaskCli(args, root);
    if (code !== 0)
      throw new Error(
        `Task CLI failed (${args[0]}): ${String(errorLog.mock.lastCall?.[0] ?? log.mock.lastCall?.[0])}`,
      );
  };
  run([
    "create",
    "Session Jev routing task",
    "--slug",
    slug,
    "--description",
    "Exercise the optional Jev session route",
    "--deliverable",
    "a checked local result",
    "--delivery-level",
    "local-result",
    "--accept",
    "AC-1=The result is recorded",
  ]);
  run(["select", slug]);
  const grant = {
    schemaVersion: 1,
    policyCeiling: policy,
    capabilities: [{ id: "agent.dispatch", assurance: "evidence-backed" }],
    providerFacts: [],
  };
  const grantScope = `pactile-tile-selection/v1:${canonicalizePactileJsonV1(grant)}`;
  run([
    "run-start",
    slug,
    "--actor",
    "alice",
    "--input-summary",
    "Select a Tile that can provide worker.handoff",
    "--approved-by",
    "user",
    "--approved-at",
    "2026-09-26T00:00:00.000Z",
    "--authorization-scope",
    grantScope,
    "--authorization-evidence",
    "tile-egress-approval.json",
    ...(writeSet?.length ? ["--write-set", ...writeSet] : []),
  ]);
  const taskDir = path.join(
    root,
    ".pactile",
    "tasks",
    fs
      .readdirSync(path.join(root, ".pactile", "tasks"))
      .find((entry) => entry.endsWith(`-${slug}`)) ?? "missing",
  );
  const current = readTaskKernel({ root, taskDir, cwd: root });
  if (current.kind !== "task-kernel-v2")
    throw new Error("Expected an active V2 Task Kernel");
  const lifecycle = projectTaskKernelLifecycle(current.kernel);
  if (lifecycle.gateSnapshot.runStart.activeRunId === null)
    throw new Error("Expected an active V2 Run");
  return { slug, runId: lifecycle.gateSnapshot.runStart.activeRunId };
}

function createRoot(
  policy: typeof APPROVED_POLICY | typeof DENIED_POLICY,
  writeSet?: readonly string[],
): {
  readonly root: string;
  readonly slug: string;
  readonly runId: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-session-jev-"));
  roots.push(root);
  const task = createActiveTask(root, policy, writeSet);
  return { root, ...task };
}

function writeProjectConfig(root: string, content: string): void {
  fs.writeFileSync(path.join(root, ".pactile", "config.yaml"), content);
}

function createPreload(): string {
  if (!fs.existsSync(FAKE_JEV_PRELOAD))
    throw new Error(
      "Compiled TypeScript fake Jev preload is missing; run pnpm test.",
    );
  return FAKE_JEV_PRELOAD;
}

function childEnv(
  root: string,
  options: CliProcessOptions = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PACTILE_JEV_API_KEY;
  delete env.PACTILE_JEV_ENABLED;
  if (options.apiKey !== undefined) env.PACTILE_JEV_API_KEY = options.apiKey;
  if (options.enabled !== undefined) env.PACTILE_JEV_ENABLED = options.enabled;
  env.PACTILE_CONTEXT_ID = "codex_p34_session_jev";
  env.PACTILE_TEST_JEV_CAPTURE = testArtifactPath(
    root,
    "fake-jev-capture.json",
  );
  env.PACTILE_TEST_JEV_RESPONSE = options.response ?? "answer";
  env.PACTILE_TEST_JEV_SELECTED_REFS = JSON.stringify(
    options.selectedRefs ?? [],
  );
  if (options.releaseFile) env.PACTILE_TEST_JEV_RELEASE = options.releaseFile;
  return env;
}

function childArgs(cliArgs: readonly string[], preload?: string): string[] {
  return [
    ...(preload ? ["--import", pathToFileURL(preload).href] : []),
    CLI_ENTRY,
    ...cliArgs,
  ];
}

function runCliProcess(
  root: string,
  options: CliProcessOptions = {},
): ReturnType<typeof spawnSync> {
  const preload = options.preload ?? createPreload();
  return spawnSync(
    process.execPath,
    childArgs(["context", "--mode", "session", "--json"], preload),
    {
      cwd: root,
      env: childEnv(root, options),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}

function runCliCommand(
  root: string,
  cliArgs: readonly string[],
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, childArgs(cliArgs), {
    cwd: root,
    env: childEnv(root),
    encoding: "utf8",
    timeout: 30_000,
  });
}

function parseOutput(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function waitForFile(file: string, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - started > timeoutMs)
      throw new Error("Timed out waiting for the mock Jev request");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function startCliProcess(
  root: string,
  preload: string,
  releaseFile: string,
  selectedRefs: readonly string[],
) {
  const child = spawn(
    process.execPath,
    childArgs(["context", "--mode", "session", "--json"], preload),
    {
      cwd: root,
      env: childEnv(root, {
        apiKey: API_KEY,
        preload,
        response: "wait",
        releaseFile,
        selectedRefs,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (value: string) => {
    stdout += value;
  });
  child.stderr?.setEncoding("utf8").on("data", (value: string) => {
    stderr += value;
  });
  const completion = new Promise<{
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, completion };
}

describe("Pactile session Jev route", () => {
  it("uses the active Run grant and returns a receipt from the real CLI process", () => {
    const { root, runId } = createRoot(APPROVED_POLICY);
    const preload = createPreload();
    const current = prepareSelectedTaskAgentTileSelection(root);
    if (!current.success)
      throw new Error("Expected the authorized current session offer");
    const suggestedRefs = current.data.offer.candidates
      .slice(0, 2)
      .map((candidate) => candidate.ref);
    if (suggestedRefs.length !== 2)
      throw new Error("Expected two candidates for the Jev order regression");
    const result = runCliProcess(root, {
      apiKey: API_KEY,
      preload,
      selectedRefs: suggestedRefs,
    });
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    expect(result.stdout).not.toContain(API_KEY);
    expect(result.stderr).not.toContain(API_KEY);
    const pack = parseOutput(result.stdout);
    const selection = pack.tileSelection as Record<string, unknown>;
    const offer = selection.offer as {
      fingerprint: string;
      candidates: { ref: string }[];
    };
    const advice = selection.jevAdvice as Record<string, unknown>;
    const capture = JSON.parse(
      fs.readFileSync(testArtifactPath(root, "fake-jev-capture.json"), "utf8"),
    ) as {
      callCount: number;
      url: string;
      method: string;
      authorizationMatchesConfiguredKey: boolean;
      body: {
        state: {
          taskSummary: string;
          sourceSnippets: { ref: string; text: string }[];
        };
        questions: Record<string, unknown>;
      };
    };

    expect(selection.status).toBe("offered");
    expect(advice).toMatchObject({
      schemaVersion: 1,
      status: "answered",
      node: "tile-selection",
      model: "jev-test-model",
      activeRunId: runId,
      approvalRunId: runId,
      offerFingerprint: offer.fingerprint,
      outboundAttempted: true,
      attempts: 1,
      latencyMs: expect.any(Number),
      httpStatus: 200,
      requestId: "req_session_01",
      inputTokens: 45,
      outputTokens: 5,
      estimatedInputCostMicrousd: 2,
      confidence: {
        candidate0: { status: "unavailable", reasonCode: "not-provided" },
        candidate1: { status: "unavailable", reasonCode: "not-provided" },
      },
      application: "pending-explicit-decision",
      fallback: null,
    });
    expect(advice.candidateRefs).toEqual(
      expect.arrayContaining([
        "worker-orchestration@1.0.0",
        "parent-child@1.0.0",
      ]),
    );
    expect(advice.suggestedRefs).toEqual(suggestedRefs);
    expect(advice.recommendedAction).toBe("override");
    expect(advice.decisionCommand).toContain("--kind override");
    const adviceFingerprint = String(advice["adviceFingerprint"]);
    expect(adviceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(advice.decisionCommand).toContain(
      `--jev-advice-fingerprint ${adviceFingerprint}`,
    );
    expect(capture).toMatchObject({
      callCount: 1,
      url: "https://api.typesafe.ai/v1/systemone",
      method: "POST",
      authorizationMatchesConfiguredKey: true,
    });
    expect(capture.body.state.taskSummary).toContain("worker.handoff");
    expect(Object.keys(capture.body.questions)).toHaveLength(2);
    expect(capture.body.state.sourceSnippets.length).toBeGreaterThan(0);
    expect(JSON.stringify(capture)).not.toContain(API_KEY);
    expect(JSON.stringify(advice)).not.toContain(API_KEY);
    expect(JSON.stringify(advice)).not.toContain(
      capture.body.state.taskSummary,
    );
    expect(JSON.stringify(advice)).not.toContain(root);
    expect(JSON.stringify(pack)).not.toContain("plan.audit");

    const receiptsDir = path.join(root, ".pactile", "runtime", "receipts");
    const persistedAdvicePath = path.join(
      receiptsDir,
      `session-jev-advice-${adviceFingerprint.slice(7)}.json`,
    );
    const originalAdviceBytes = fs.readFileSync(persistedAdvicePath);
    const sidecarAdvice = readSessionJevReceiptV1(
      root,
      adviceFingerprint,
      current.data.offer,
      { activeRunId: runId, approvalRunId: runId },
    );
    expect(sidecarAdvice.suggestedRefs).toEqual(suggestedRefs);
    expect(sidecarAdvice.recommendedAction).toBe("override");
    const [firstRef, secondRef] = suggestedRefs;
    if (!firstRef || !secondRef)
      throw new Error("Expected two Tile refs for duplicate-count coverage");
    const duplicateAdvice = {
      ...sidecarAdvice,
      suggestedRefs: [firstRef, firstRef],
    };
    const differentCountsDecision = {
      offerFingerprint: sidecarAdvice.offerFingerprint,
      outcome: "selected",
      decision: "adopt",
      selectedRefs: [firstRef, secondRef],
    } as Parameters<typeof sessionJevApplicationV1>[1];
    expect(
      sessionJevApplicationV1(duplicateAdvice, differentCountsDecision),
    ).toBe("overridden");
    expect(() =>
      readSessionJevReceiptV1(root, adviceFingerprint, current.data.offer, {
        activeRunId: "run-b-active",
        approvalRunId: "run-b-approval",
      }),
    ).toThrow("session-jev-advice-run-identity-mismatch");
    const forgedAdvice = JSON.parse(
      originalAdviceBytes.toString("utf8"),
    ) as Record<string, unknown>;
    delete forgedAdvice["adviceFingerprint"];
    forgedAdvice["activeRunId"] = "run-b-active";
    forgedAdvice["approvalRunId"] = "run-b-approval";
    const forgedAdviceFingerprint = fingerprintPactileContractV1(forgedAdvice);
    const forgedAdvicePath = path.join(
      receiptsDir,
      `session-jev-advice-${forgedAdviceFingerprint.slice(7)}.json`,
    );
    fs.writeFileSync(
      forgedAdvicePath,
      `${canonicalizePactileJsonV1({
        ...forgedAdvice,
        adviceFingerprint: forgedAdviceFingerprint,
      })}\n`,
    );
    const runBDecisionArgs = String(advice["decisionCommand"])
      .trim()
      .split(/\s+/)
      .slice(1);
    runBDecisionArgs[
      runBDecisionArgs.indexOf("--jev-advice-fingerprint") + 1
    ] = forgedAdviceFingerprint;
    const snapshotsBeforeRunBDecision = fs
      .readdirSync(receiptsDir)
      .filter((file) => file.startsWith("tile-selection-"))
      .sort();
    const runBDecision = runCliCommand(root, runBDecisionArgs);
    expect(runBDecision.status).toBe(1);
    expect(parseOutput(runBDecision.stdout)).toMatchObject({
      success: false,
      diagnostics: [
        { code: "tile-selection-snapshot-jev-run-identity-mismatch" },
      ],
    });
    expect(
      fs
        .readdirSync(receiptsDir)
        .filter((file) => file.startsWith("tile-selection-"))
        .sort(),
    ).toEqual(snapshotsBeforeRunBDecision);
    fs.unlinkSync(forgedAdvicePath);

    const ordinaryDecisionArgs = String(selection["decisionCommand"])
      .trim()
      .split(/\s+/)
      .slice(1);
    expect(ordinaryDecisionArgs).not.toContain("--jev-advice-fingerprint");
    const ordinaryDecision = runCliCommand(root, ordinaryDecisionArgs);
    expect(ordinaryDecision.status, ordinaryDecision.stderr).toBe(0);
    const ordinarySnapshot = parseOutput(ordinaryDecision.stdout).snapshot as {
      fingerprint: string;
      fileName: string;
    };
    const ordinarySnapshotValue = JSON.parse(
      fs.readFileSync(
        path.join(receiptsDir, ordinarySnapshot.fileName),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(ordinarySnapshotValue).toMatchObject({ schemaVersion: 2 });
    expect(ordinarySnapshotValue).not.toHaveProperty("sessionJev");
    const ordinaryReplay = runCliCommand(root, [
      "tile-selection",
      "replay",
      "--snapshot-fingerprint",
      ordinarySnapshot.fingerprint,
    ]);
    expect(ordinaryReplay.status, ordinaryReplay.stderr).toBe(0);

    const tamperedAdvice = JSON.parse(
      originalAdviceBytes.toString("utf8"),
    ) as Record<string, unknown>;
    tamperedAdvice["activeRunId"] = "tampered-run-id";
    fs.writeFileSync(
      persistedAdvicePath,
      `${canonicalizePactileJsonV1(tamperedAdvice)}\n`,
    );
    const decisionCommand = String(advice["decisionCommand"]);
    const decisionArgs = decisionCommand.trim().split(/\s+/).slice(1);
    const filesBeforeTamperDecision = fs
      .readdirSync(receiptsDir)
      .filter((file) => file.startsWith("tile-selection-"))
      .sort();
    const tamperedDecision = runCliCommand(root, decisionArgs);
    expect(tamperedDecision.status).toBe(1);
    expect(parseOutput(tamperedDecision.stdout)).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-selection-snapshot-jev-advice-invalid" }],
    });
    expect(
      fs
        .readdirSync(receiptsDir)
        .filter((file) => file.startsWith("tile-selection-"))
        .sort(),
    ).toEqual(filesBeforeTamperDecision);
    fs.writeFileSync(persistedAdvicePath, originalAdviceBytes);

    expect(decisionArgs.slice(0, 2)).toEqual(["tile-selection", "decide"]);
    const decisionResult = runCliCommand(root, decisionArgs);
    expect(decisionResult.status, decisionResult.stderr).toBe(0);
    const decisionReceipt = parseOutput(decisionResult.stdout);
    expect(decisionReceipt).toMatchObject({
      success: true,
      executionAuthorization: "not-granted",
      receipt: {
        outcome: "overridden",
        compilerPassed: true,
        offerFingerprint: offer.fingerprint,
      },
    });
    const acceptedRefs = (decisionReceipt.receipt as Record<string, unknown>)[
      "selectedRefs"
    ] as string[];
    expect(acceptedRefs).toEqual([...suggestedRefs].sort());
    expect(acceptedRefs).not.toEqual(suggestedRefs);
    const snapshot = decisionReceipt.snapshot as {
      fingerprint: string;
      fileName: string;
    };
    const snapshotFile = path.join(receiptsDir, snapshot.fileName);
    const persisted = fs.readFileSync(snapshotFile, "utf8");
    const snapshotValue = JSON.parse(persisted) as Record<string, unknown>;
    expect(snapshotValue).toMatchObject({
      schemaVersion: 3,
      sessionJev: {
        adviceFingerprint,
        activeRunId: runId,
        approvalRunId: runId,
        offerFingerprint: offer.fingerprint,
        decisionFingerprint: (
          decisionReceipt.receipt as Record<string, unknown>
        )["fingerprint"],
        application: "adopted",
      },
    });
    expect(
      (snapshotValue["sessionJev"] as Record<string, unknown>)[
        "taskLifecycleFingerprint"
      ],
    ).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const persistedAdvice = fs.readFileSync(persistedAdvicePath, "utf8");
    expect(JSON.parse(persistedAdvice)).toMatchObject({
      adviceFingerprint,
      status: "answered",
      application: "pending-explicit-decision",
      offerFingerprint: offer.fingerprint,
    });
    expect(persistedAdvice).not.toContain(API_KEY);
    expect(persistedAdvice).not.toContain(root);
    expect(persistedAdvice).not.toContain(capture.body.state.taskSummary);
    expect(persisted).toContain(snapshot.fingerprint);
    expect(persisted).not.toContain(root);
    expect(persisted).not.toContain(API_KEY);
    const originalSnapshotBytes = fs.readFileSync(snapshotFile);
    const tamperedSnapshot = JSON.parse(
      originalSnapshotBytes.toString("utf8"),
    ) as Record<string, unknown>;
    const tamperedBinding = tamperedSnapshot["sessionJev"] as Record<string, unknown>;
    tamperedBinding["activeRunId"] = "tampered-run-id";
    fs.writeFileSync(
      snapshotFile,
      canonicalizePactileJsonV1(tamperedSnapshot),
    );
    const tamperedReplay = runCliCommand(root, [
      "tile-selection",
      "replay",
      "--snapshot-fingerprint",
      snapshot.fingerprint,
    ]);
    expect(tamperedReplay.status).toBe(1);
    expect(parseOutput(tamperedReplay.stdout)).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-selection-snapshot-identity-mismatch" }],
    });
    fs.writeFileSync(snapshotFile, originalSnapshotBytes);
    const replay = runCliCommand(root, [
      "tile-selection",
      "replay",
      "--snapshot-fingerprint",
      snapshot.fingerprint,
    ]);
    expect(replay.status, replay.stderr).toBe(0);
    expect(parseOutput(replay.stdout)).toMatchObject({
      success: true,
      data: { offerFingerprint: offer.fingerprint },
    });

    const oldErrorLabelSnapshot = JSON.parse(
      originalSnapshotBytes.toString("utf8"),
    ) as Record<string, unknown>;
    delete oldErrorLabelSnapshot["fingerprint"];
    const oldErrorLabelBinding = oldErrorLabelSnapshot["sessionJev"] as Record<
      string,
      unknown
    >;
    oldErrorLabelBinding["application"] = "overridden";
    const oldErrorLabelFingerprint = fingerprintPactileContractV1(
      oldErrorLabelSnapshot,
    );
    const oldErrorLabelPath = path.join(
      receiptsDir,
      `tile-selection-${oldErrorLabelFingerprint.slice(7)}.json`,
    );
    fs.writeFileSync(
      oldErrorLabelPath,
      canonicalizePactileJsonV1({
        ...oldErrorLabelSnapshot,
        fingerprint: oldErrorLabelFingerprint,
      }),
    );
    const oldErrorLabelReplay = runCliCommand(root, [
      "tile-selection",
      "replay",
      "--snapshot-fingerprint",
      oldErrorLabelFingerprint,
    ]);
    expect(oldErrorLabelReplay.status).toBe(1);
    expect(parseOutput(oldErrorLabelReplay.stdout)).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-selection-snapshot-jev-decision-mismatch" }],
    });
  });

  it("compares Jev ref sets without discarding duplicate counts", () => {
    const offerFingerprint = `sha256:${"a".repeat(64)}`;
    const offer = {
      fingerprint: offerFingerprint,
      candidates: [
        { ref: "alpha@1.0.0", outputScore: 1 },
        { ref: "beta@1.0.0", outputScore: 1 },
      ],
      suggestion: { selectedRefs: ["alpha@1.0.0", "beta@1.0.0"] },
    } as unknown as Parameters<typeof createSessionJevReceiptV1>[0];
    const advice = {
      source: "jev-advised",
      suggestedDecision: {
        kind: "override",
        offerFingerprint,
        selectedRefs: ["beta@1.0.0", "alpha@1.0.0"],
      },
      jevDecision: null,
      fallback: null,
    } as unknown as Parameters<typeof createSessionJevReceiptV1>[1];
    const receipt = createSessionJevReceiptV1(offer, advice, {
      activeRunId: "run-active-a",
      approvalRunId: "run-approval-a",
    });
    expect(receipt.recommendedAction).toBe("adopt");
    expect(receipt.decisionCommand).toContain("--kind adopt");

    const reorderedDecision = {
      offerFingerprint,
      outcome: "selected",
      decision: "override",
      selectedRefs: ["beta@1.0.0", "alpha@1.0.0"],
    } as unknown as Parameters<typeof sessionJevApplicationV1>[1];
    expect(
      sessionJevApplicationV1(receipt, reorderedDecision),
    ).toBe("adopted");

    const repeatedDecision = {
      ...reorderedDecision,
      selectedRefs: ["alpha@1.0.0", "alpha@1.0.0"],
    };
    expect(
      sessionJevApplicationV1(receipt, repeatedDecision),
    ).toBe("overridden");

    const repeatedAdvice = {
      ...advice,
      suggestedDecision: {
        kind: "override",
        offerFingerprint,
        selectedRefs: ["alpha@1.0.0", "alpha@1.0.0"],
      },
    } as unknown as Parameters<typeof createSessionJevReceiptV1>[1];
    expect(
      createSessionJevReceiptV1(offer, repeatedAdvice, {
        activeRunId: "run-active-a",
        approvalRunId: "run-approval-a",
      }).recommendedAction,
    ).toBe("override");
  });

  it("binds adopted, overridden, and no-match outcomes to the exact Jev advice", () => {
    const overrideTask = createRoot(APPROVED_POLICY);
    const current = prepareSelectedTaskAgentTileSelection(overrideTask.root);
    if (!current.success)
      throw new Error("Expected the authorized current session offer");
    const deterministicRefs = current.data.offer.suggestion.selectedRefs;
    const alternateRef = current.data.offer.candidates.find(
      (candidate) => !deterministicRefs.includes(candidate.ref),
    )?.ref;
    if (!alternateRef)
      throw new Error("Expected an eligible alternative Tile candidate");
    const jevResult = runCliProcess(overrideTask.root, {
      apiKey: API_KEY,
      preload: createPreload(),
      selectedRefs: [alternateRef],
    });
    expect(jevResult.status, jevResult.stderr).toBe(0);
    const pack = parseOutput(jevResult.stdout);
    const selection = pack.tileSelection as Record<string, unknown>;
    const advice = selection["jevAdvice"] as Record<string, unknown>;
    expect(advice).toMatchObject({
      status: "answered",
      recommendedAction: "override",
      suggestedRefs: [alternateRef],
    });
    const generatedArgs = String(advice["decisionCommand"])
      .trim()
      .split(/\s+/)
      .slice(1);
    const staleArgs = [...generatedArgs];
    staleArgs[staleArgs.indexOf("--offer-fingerprint") + 1] =
      `sha256:${"0".repeat(64)}`;
    const staleResult = runCliCommand(overrideTask.root, staleArgs);
    expect(staleResult.status).toBe(1);
    expect(parseOutput(staleResult.stdout)).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-selection-session-jev-advice-stale" }],
    });

    const accepted = runCliCommand(overrideTask.root, generatedArgs);
    expect(accepted.status, accepted.stderr).toBe(0);
    const acceptedSnapshot = parseOutput(accepted.stdout).snapshot as {
      fileName: string;
    };
    const receiptsDir = path.join(
      overrideTask.root,
      ".pactile",
      "runtime",
      "receipts",
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(receiptsDir, acceptedSnapshot.fileName),
          "utf8",
        ),
      ),
    ).toMatchObject({ sessionJev: { application: "adopted" } });

    const userOverrideArgs = [...generatedArgs];
    userOverrideArgs[userOverrideArgs.indexOf("--kind") + 1] = "adopt";
    for (let index = userOverrideArgs.length - 1; index >= 0; index -= 1) {
      if (userOverrideArgs[index] === "--tile")
        userOverrideArgs.splice(index, 2);
    }
    const overridden = runCliCommand(overrideTask.root, userOverrideArgs);
    expect(overridden.status, overridden.stderr).toBe(0);
    const overriddenSnapshot = parseOutput(overridden.stdout).snapshot as {
      fileName: string;
    };
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(receiptsDir, overriddenSnapshot.fileName),
          "utf8",
        ),
      ),
    ).toMatchObject({ sessionJev: { application: "overridden" } });

    const noMatchTask = createRoot(APPROVED_POLICY);
    const noMatchResult = runCliProcess(noMatchTask.root, {
      apiKey: API_KEY,
      preload: createPreload(),
      selectedRefs: [],
    });
    expect(noMatchResult.status, noMatchResult.stderr).toBe(0);
    const noMatchAdvice = (
      parseOutput(noMatchResult.stdout).tileSelection as Record<string, unknown>
    )["jevAdvice"] as Record<string, unknown>;
    expect(noMatchAdvice).toMatchObject({
      status: "answered",
      recommendedAction: "no-match",
    });
    const noMatchArgs = String(noMatchAdvice["decisionCommand"])
      .trim()
      .split(/\s+/)
      .slice(1);
    const noMatchDecision = runCliCommand(noMatchTask.root, noMatchArgs);
    expect(noMatchDecision.status, noMatchDecision.stderr).toBe(0);
    const noMatchSnapshot = parseOutput(noMatchDecision.stdout).snapshot as {
      fileName: string;
    };
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            noMatchTask.root,
            ".pactile",
            "runtime",
            "receipts",
            noMatchSnapshot.fileName,
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({ sessionJev: { application: "no-match" } });
  });

  it("falls back without a key and does not invoke fake or real fetch", () => {
    const { root } = createRoot(APPROVED_POLICY);
    const result = runCliProcess(root, { preload: createPreload() });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(testArtifactPath(root, "fake-jev-capture.json"))).toBe(false);
    const pack = parseOutput(result.stdout);
    expect(pack.tileSelection).toMatchObject({
      status: "offered",
      jevAdvice: {
        status: "fallback",
        outboundAttempted: false,
        attempts: 0,
        confidence: {
          candidate0: { status: "unavailable", reasonCode: "not-returned" },
          candidate1: { status: "unavailable", reasonCode: "not-returned" },
        },
        fallback: { reasonCode: "configuration-missing" },
      },
    });
    expect(result.stdout).not.toContain(API_KEY);
  });

  it("keeps a low-confidence Noul fallback in the redacted receipt", () => {
    const { root } = createRoot(APPROVED_POLICY);
    writeProjectConfig(root, "jev:\n  egress: allow\n");
    const result = runCliProcess(root, {
      apiKey: API_KEY,
      preload: createPreload(),
      response: "low-confidence",
    });

    expect(result.status, result.stderr).toBe(0);
    const advice = parseOutput(result.stdout).tileSelection as {
      jevAdvice: Record<string, unknown>;
    };
    expect(advice.jevAdvice).toMatchObject({
      status: "fallback",
      outboundAttempted: true,
      attempts: 1,
      application: "not-applied",
      confidence: {
        candidate0: { status: "unavailable", reasonCode: "not-provided" },
        candidate1: { status: "unavailable", reasonCode: "not-provided" },
      },
      fallback: { reasonCode: "low-confidence" },
    });
    expect(JSON.stringify(advice.jevAdvice)).not.toContain(API_KEY);
    expect(fs.existsSync(testArtifactPath(root, "fake-jev-capture.json"))).toBe(true);
  });

  it("allows configured project egress when the active Run grant also permits it", () => {
    const { root } = createRoot(APPROVED_POLICY);
    writeProjectConfig(root, "jev:\n  egress: allow\n");
    const result = runCliProcess(root, {
      apiKey: API_KEY,
      preload: createPreload(),
    });

    expect(result.status, result.stderr).toBe(0);
    const pack = parseOutput(result.stdout);
    expect(pack.tileSelection).toMatchObject({
      status: "offered",
      jevAdvice: {
        status: "answered",
        outboundAttempted: true,
        attempts: 1,
        fallback: null,
      },
    });
    expect(
      JSON.parse(
        fs.readFileSync(testArtifactPath(root, "fake-jev-capture.json"), "utf8"),
      ),
    ).toMatchObject({ callCount: 1 });
    expect(result.stdout).not.toContain(API_KEY);
  });

  it("blocks Jev before fetch when project policy denies egress despite an allowing active Run grant", () => {
    const { root } = createRoot(APPROVED_POLICY);
    writeProjectConfig(root, "jev:\n  egress: deny\n");
    const deterministic = prepareSelectedTaskAgentTileSelection(root);
    if (!deterministic.success)
      throw new Error("Expected the authorized deterministic session offer");

    const result = runCliProcess(root, {
      apiKey: API_KEY,
      preload: createPreload(),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(testArtifactPath(root, "fake-jev-capture.json"))).toBe(false);
    const pack = parseOutput(result.stdout);
    expect(pack.tileSelection).toMatchObject({
      status: "offered",
      offer: { fingerprint: deterministic.data.offer.fingerprint },
      jevAdvice: {
        status: "fallback",
        outboundAttempted: false,
        attempts: 0,
        fallback: { reasonCode: "egress-denied" },
      },
    });
    expect(result.stdout).not.toContain(API_KEY);
  });

  it("fails closed before fetch when project Jev egress policy is malformed", () => {
    const { root } = createRoot(APPROVED_POLICY);
    writeProjectConfig(root, "jev:\n  egress: maybe\n");

    const result = runCliProcess(root, {
      apiKey: API_KEY,
      preload: createPreload(),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(testArtifactPath(root, "fake-jev-capture.json"))).toBe(false);
    expect(parseOutput(result.stdout).tileSelection).toMatchObject({
      status: "offered",
      jevAdvice: {
        status: "fallback",
        outboundAttempted: false,
        attempts: 0,
        fallback: { reasonCode: "configuration-invalid" },
      },
    });
    expect(result.stdout).not.toContain(API_KEY);
  });

  it("honors the explicit Jev kill switch even when the key and active grant exist", () => {
    const { root } = createRoot(APPROVED_POLICY);
    const result = runCliProcess(root, {
      apiKey: API_KEY,
      enabled: "false",
      preload: createPreload(),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(testArtifactPath(root, "fake-jev-capture.json"))).toBe(false);
    expect(parseOutput(result.stdout).tileSelection).toMatchObject({
      status: "offered",
      jevAdvice: {
        status: "fallback",
        outboundAttempted: false,
        attempts: 0,
        fallback: { reasonCode: "disabled" },
      },
    });
    expect(result.stdout).not.toContain(API_KEY);
  });

  it("does not widen a denied Task Run grant with project allow", () => {
    const { root } = createRoot(DENIED_POLICY);
    writeProjectConfig(root, "jev:\n  egress: allow\n");
    const result = runCliProcess(root, {
      apiKey: API_KEY,
      preload: createPreload(),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(testArtifactPath(root, "fake-jev-capture.json"))).toBe(false);
    const pack = parseOutput(result.stdout);
    expect(pack.tileSelection).toMatchObject({
      status: "offered",
      jevAdvice: {
        status: "fallback",
        outboundAttempted: false,
        attempts: 0,
        fallback: { reasonCode: "egress-denied" },
      },
    });
    expect(result.stdout).not.toContain(API_KEY);
  });

  it("does not use the approval grant after its active V2 Run has ended", () => {
    const { root, slug, runId } = createRoot(APPROVED_POLICY, ["result.txt"]);
    const candidateFingerprint = writeRunResultCandidate(root);
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const resultCode = runTaskCli(
      [
        "run-result",
        slug,
        runId,
        "--outcome",
        "completed",
        "--summary",
        "Result recorded",
        "--candidate",
        `result.txt=${candidateFingerprint}`,
      ],
      root,
    );
    expect(resultCode, String(errorLog.mock.lastCall?.[0] ?? "")).toBe(0);

    const result = runCliProcess(root, {
      apiKey: API_KEY,
      preload: createPreload(),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(testArtifactPath(root, "fake-jev-capture.json"))).toBe(false);
    const pack = parseOutput(result.stdout);
    expect(pack.tileSelection).toMatchObject({
      status: "offered",
      offer: { taskLifecycle: { phase: "verify" } },
      jevAdvice: {
        status: "fallback",
        outboundAttempted: false,
        attempts: 0,
        fallback: { reasonCode: "session-run-identity-unavailable" },
      },
    });
    expect(result.stdout).not.toContain(API_KEY);
  });

  it("explains an HTTP failure without exposing the provider body", () => {
    const { root } = createRoot(APPROVED_POLICY);
    const current = prepareSelectedTaskAgentTileSelection(root);
    if (!current.success)
      throw new Error("Expected the authorized current session offer");
    const result = runCliProcess(root, {
      apiKey: API_KEY,
      preload: createPreload(),
      response: "failure",
      selectedRefs: current.data.offer.suggestion.selectedRefs,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(API_KEY);
    expect(result.stdout).not.toContain("provider detail must not escape");
    const advice = (
      parseOutput(result.stdout).tileSelection as Record<string, unknown>
    ).jevAdvice as Record<string, unknown>;
    expect(advice).toMatchObject({
      status: "fallback",
      application: "not-applied",
      outboundAttempted: true,
      attempts: 2,
      httpStatus: 503,
      fallback: { reasonCode: "service-unavailable" },
    });
    const capture = JSON.parse(
      fs.readFileSync(testArtifactPath(root, "fake-jev-capture.json"), "utf8"),
    ) as { callCount: number };
    expect(capture.callCount).toBe(2);
  });

  it("discards a Jev answer when the selected Task Run changes during the request", async () => {
    const { root, slug, runId } = createRoot(APPROVED_POLICY, ["result.txt"]);
    const before = prepareSelectedTaskAgentTileSelection(root);
    if (!before.success)
      throw new Error("Expected the approved session Tile offer");
    const originalFingerprint = before.data.offer.fingerprint;
    const captureFile = testArtifactPath(root, "fake-jev-capture.json");
    const releaseFile = testArtifactPath(root, "release-mock-jev");
    const preload = createPreload();
    const { child, completion } = startCliProcess(
      root,
      preload,
      releaseFile,
      before.data.offer.suggestion.selectedRefs,
    );
    try {
      await waitForFile(captureFile);
      const errorLog = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const candidateFingerprint = writeRunResultCandidate(root);
      expect(
        runTaskCli(
          [
            "run-result",
            slug,
            runId,
            "--outcome",
            "completed",
            "--summary",
            "The candidate is ready for verification",
            "--candidate",
            `result.txt=${candidateFingerprint}`,
          ],
          root,
        ),
        String(errorLog.mock.lastCall?.[0] ?? log.mock.lastCall?.[0]),
      ).toBe(0);
      fs.writeFileSync(releaseFile, "released", "utf8");
      const result = await completion;
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(API_KEY);
      const pack = parseOutput(result.stdout);
      const selection = pack.tileSelection as Record<string, unknown>;
      const advice = selection.jevAdvice as Record<string, unknown>;
      const offer = selection.offer as { fingerprint: string };
      expect(pack.kernel).toMatchObject({ phase: "verify" });
      expect(offer.fingerprint).not.toBe(originalFingerprint);
      expect(advice).toMatchObject({
        status: "discarded-stale",
        application: "discarded",
        suggestedRefs: [],
        recommendedAction: null,
        outboundAttempted: true,
        fallback: { reasonCode: "session-changed-during-advice" },
      });
      expect(advice.offerFingerprint).toBe(originalFingerprint);
      expect(JSON.stringify(advice)).not.toContain("provider detail");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        fs.writeFileSync(releaseFile, "released", "utf8");
        child.kill();
      }
      await completion.catch(() => undefined);
    }
  }, 15_000);
});
