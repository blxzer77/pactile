import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalizePactileJsonV1 } from "../../../src/core/index.js";
import {
  projectTaskKernelLifecycle,
  readTaskKernel,
} from "../../../src/core/task/index.js";
import { runTaskCli } from "../../../src/commands/task.js";
import { prepareSelectedTaskAgentTileSelection } from "../../../src/pactile/registry.js";

const JEV_ORIGIN = "https://api.typesafe.ai";
const API_KEY = "session-test-secret-key";
const CLI_SOURCE = fileURLToPath(
  new URL("../../../src/cli/index.ts", import.meta.url),
);
const FAKE_JEV_PRELOAD = fileURLToPath(
  new URL("../../../.tmp/p31-script-build/fixtures/fake-jev-preload.js", import.meta.url),
);
const TSX_LOADER = import.meta.resolve("tsx/esm");
const roots: string[] = [];

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
});

function createActiveTask(
  root: string,
  policy: typeof APPROVED_POLICY | typeof DENIED_POLICY,
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

function createRoot(policy: typeof APPROVED_POLICY | typeof DENIED_POLICY): {
  readonly root: string;
  readonly slug: string;
  readonly runId: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-session-jev-"));
  roots.push(root);
  const task = createActiveTask(root, policy);
  return { root, ...task };
}

function createPreload(): string {
  if (!fs.existsSync(FAKE_JEV_PRELOAD))
    throw new Error("Compiled TypeScript fake Jev preload is missing; run pnpm test.");
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
  env.PACTILE_TEST_JEV_CAPTURE = path.join(root, "fake-jev-capture.json");
  env.PACTILE_TEST_JEV_RESPONSE = options.response ?? "answer";
  env.PACTILE_TEST_JEV_SELECTED_REFS = JSON.stringify(
    options.selectedRefs ?? [],
  );
  if (options.releaseFile) env.PACTILE_TEST_JEV_RELEASE = options.releaseFile;
  return env;
}

function childArgs(
  root: string,
  cliArgs: readonly string[],
  preload?: string,
): string[] {
  return [
    "--import",
    TSX_LOADER,
    ...(preload ? ["--import", pathToFileURL(preload).href] : []),
    CLI_SOURCE,
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
    childArgs(root, ["context", "--mode", "session", "--json"], preload),
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
  return spawnSync(process.execPath, childArgs(root, cliArgs), {
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
    childArgs(root, ["context", "--mode", "session", "--json"], preload),
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
    const { root } = createRoot(APPROVED_POLICY);
    const preload = createPreload();
    const current = prepareSelectedTaskAgentTileSelection(root);
    if (!current.success)
      throw new Error("Expected the authorized current session offer");
    const result = runCliProcess(root, {
      apiKey: API_KEY,
      preload,
      selectedRefs: current.data.offer.suggestion.selectedRefs,
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
      fs.readFileSync(path.join(root, "fake-jev-capture.json"), "utf8"),
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
      offerFingerprint: offer.fingerprint,
      outboundAttempted: true,
      attempts: 1,
      latencyMs: expect.any(Number),
      httpStatus: 200,
      requestId: "req_session_01",
      inputTokens: 45,
      outputTokens: 5,
      estimatedInputCostMicrousd: 2,
      application: "pending-explicit-decision",
      fallback: null,
    });
    expect(advice.candidateRefs).toEqual(
      expect.arrayContaining([
        "worker-orchestration@1.0.0",
        "parent-child@1.0.0",
      ]),
    );
    expect(advice.suggestedRefs).toEqual(advice.deterministicRefs);
    expect(advice.recommendedAction).toBe("adopt");
    expect(advice.decisionCommand).toContain("--kind adopt");
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

    const decisionCommand = String(advice.decisionCommand);
    const decisionArgs = decisionCommand.trim().split(/\s+/).slice(1);
    expect(decisionArgs.slice(0, 2)).toEqual(["tile-selection", "decide"]);
    const decisionResult = runCliCommand(root, decisionArgs);
    expect(decisionResult.status, decisionResult.stderr).toBe(0);
    const decisionReceipt = parseOutput(decisionResult.stdout);
    expect(decisionReceipt).toMatchObject({
      success: true,
      executionAuthorization: "not-granted",
      receipt: {
        outcome: "selected",
        compilerPassed: true,
        offerFingerprint: offer.fingerprint,
      },
    });
    const snapshot = decisionReceipt.snapshot as {
      fingerprint: string;
      fileName: string;
    };
    const snapshotFile = path.join(
      root,
      ".pactile",
      "runtime",
      "receipts",
      snapshot.fileName,
    );
    const persisted = fs.readFileSync(snapshotFile, "utf8");
    expect(persisted).toContain(snapshot.fingerprint);
    expect(persisted).not.toContain(root);
    expect(persisted).not.toContain(API_KEY);
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
  });

  it("falls back without a key and does not invoke fake or real fetch", () => {
    const { root } = createRoot(APPROVED_POLICY);
    const result = runCliProcess(root, { preload: createPreload() });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(root, "fake-jev-capture.json"))).toBe(false);
    const pack = parseOutput(result.stdout);
    expect(pack.tileSelection).toMatchObject({
      status: "offered",
      jevAdvice: {
        status: "fallback",
        outboundAttempted: false,
        attempts: 0,
        fallback: { reasonCode: "configuration-missing" },
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
    expect(fs.existsSync(path.join(root, "fake-jev-capture.json"))).toBe(false);
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

  it("does not send a configured key when the selected Task egress policy denies Jev", () => {
    const { root } = createRoot(DENIED_POLICY);
    const result = runCliProcess(root, {
      apiKey: API_KEY,
      preload: createPreload(),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(root, "fake-jev-capture.json"))).toBe(false);
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
    const { root, slug, runId } = createRoot(APPROVED_POLICY);
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
        `result.txt=${"a".repeat(64)}`,
      ],
      root,
    );
    expect(resultCode, String(errorLog.mock.lastCall?.[0] ?? "")).toBe(0);

    const result = runCliProcess(root, {
      apiKey: API_KEY,
      preload: createPreload(),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(root, "fake-jev-capture.json"))).toBe(false);
    const pack = parseOutput(result.stdout);
    expect(pack.tileSelection).toMatchObject({
      status: "offered",
      offer: { taskLifecycle: { phase: "verify" } },
      jevAdvice: {
        status: "fallback",
        outboundAttempted: false,
        attempts: 0,
        fallback: { reasonCode: "egress-denied" },
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
      fs.readFileSync(path.join(root, "fake-jev-capture.json"), "utf8"),
    ) as { callCount: number };
    expect(capture.callCount).toBe(2);
  });

  it("discards a Jev answer when the selected Task Run changes during the request", async () => {
    const { root, slug, runId } = createRoot(APPROVED_POLICY);
    const before = prepareSelectedTaskAgentTileSelection(root);
    if (!before.success)
      throw new Error("Expected the approved session Tile offer");
    const originalFingerprint = before.data.offer.fingerprint;
    const captureFile = path.join(root, "fake-jev-capture.json");
    const releaseFile = path.join(root, "release-mock-jev");
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
            `result.txt=${"a".repeat(64)}`,
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
