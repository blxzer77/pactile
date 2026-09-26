import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTaskKernel,
  readTaskKernel,
  recordTaskRunResult,
  startTaskRun,
  type TaskKernelSnapshotV2,
} from "../../src/core/task/index.js";
import {
  createTaskCandidateEntry,
  observeTaskRunCandidate,
} from "../../src/core/task/task-candidate-observer.js";
import { runTaskCliWithWorkspaceReclaim } from "../../src/commands/task-worktree-close.js";
import type {
  JevVerificationAdviceReceiptV1,
  VerificationPlan,
} from "../../src/pactile/index.js";

const fixturePrefix = "pactile-p41-verify-plan-";
const fixtureRoots: string[] = [];

interface VerifyPlanOutput {
  readonly status: string;
  readonly deterministicPlan: VerificationPlan;
  readonly jevAdvice: JevVerificationAdviceReceiptV1;
  readonly decision: {
    readonly choice: "adopt" | "override";
    readonly adoptedOptionalCheckIds: readonly string[];
  };
  readonly input: { readonly completeRepositoryCiInventory: false };
  readonly jevEgressPolicy:
    | { readonly allowed: true; readonly source: "default" | "configured" }
    | {
        readonly allowed: false;
        readonly reasonCode: "egress-denied" | "configuration-invalid";
      };
  readonly execution: "not-run";
  readonly receipt: {
    readonly status: string;
    readonly ref?: string;
  };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/\r?\n$/u, "");
}

function kernel(root: string, taskDir: string): TaskKernelSnapshotV2 {
  const read = readTaskKernel({ root, taskDir, cwd: root });
  if (read.kind !== "task-kernel-v2")
    throw new Error("Expected Task Kernel v2");
  return read.kernel;
}

function fixture(
  options: { denyEgress?: boolean; invalidEgress?: boolean } = {},
): {
  root: string;
  taskId: string;
  taskDir: string;
  runId: string;
  manifestPath: string;
  initialKernel: TaskKernelSnapshotV2;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), fixturePrefix));
  fixtureRoots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Pactile Test");
  git(root, "config", "user.email", "pactile@example.invalid");
  fs.mkdirSync(path.join(root, ".pactile"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".gitignore"),
    ".pactile/tasks/\nnode_modules/\n",
  );
  fs.writeFileSync(path.join(root, ".pactile", ".gitignore"), ".runtime/\n");
  if (options.denyEgress || options.invalidEgress) {
    fs.writeFileSync(
      path.join(root, ".pactile", "config.yaml"),
      options.denyEgress ? "jev:\n  egress: deny\n" : "jev: true\n",
    );
  }
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "feature.ts"),
    "export const feature = false;\n",
  );
  const baselineFiles = [".gitignore", ".pactile/.gitignore", "src/feature.ts"];
  if (options.denyEgress || options.invalidEgress)
    baselineFiles.push(".pactile/config.yaml");
  git(root, "add", ...baselineFiles);
  git(root, "commit", "-q", "-m", "fixture baseline");

  const taskId = "verify-plan-fixture";
  const taskDir = path.join(root, ".pactile", "tasks", taskId);
  const created = createTaskKernel({
    root,
    taskDir,
    actor: "author",
    idempotencyKey: `create:${taskId}`,
    definition: {
      taskId,
      title: "Verification planning fixture",
      description: "",
      deliverable: "Candidate behavior",
      deliveryLevel: "local-result",
      acceptanceCriteria: [{ id: "AC-1", description: "The candidate exists" }],
      dependencies: [],
    },
  });
  const started = startTaskRun({
    root,
    taskDir,
    expectedRevision: created.kernel.revision,
    actor: "worker",
    idempotencyKey: `start:${taskId}`,
    input: { summary: "Implement the candidate", references: [] },
    authorization: {
      approvedBy: "approver",
      approvedAt: "2026-09-26T00:00:00.000Z",
      scope: "src",
      evidenceRef: "approval:test",
    },
    writeSetSnapshot: ["src/"],
  });
  const run = started.kernel.runs.at(-1);
  if (!run) throw new Error("Started Run is missing");
  fs.writeFileSync(
    path.join(root, "src", "feature.ts"),
    "export const feature = true;\n",
  );
  const observation = observeTaskRunCandidate({ run, repositoryRoot: root });
  const completed = recordTaskRunResult({
    root,
    taskDir,
    expectedRevision: started.kernel.revision,
    runId: run.id,
    outcome: "completed",
    summary: "Candidate behavior implemented",
    evidenceRefs: ["src/feature.ts"],
    candidateEntries: [createTaskCandidateEntry(observation)],
    actor: "worker",
    idempotencyKey: `complete:${taskId}`,
  });
  const completedRun = completed.kernel.runs.at(-1);
  if (!completedRun?.candidateSnapshot)
    throw new Error("Completed candidate is missing");
  const manifestPath = path.join(taskDir, "verify-plan.json");
  return {
    root,
    taskId,
    taskDir,
    runId: run.id,
    manifestPath,
    initialKernel: completed.kernel,
  };
}

function manifestFor(
  input: {
    scope?: "single-area" | "cross-module" | "repository-wide";
    changedSurfaces?: string[];
    risks?: string[];
    checks?: Record<string, unknown>[];
  } = {},
): Record<string, unknown> {
  return {
    impact: {
      changedSurfaces: input.changedSurfaces ?? ["task.create"],
      risks: input.risks ?? [],
      scope: input.scope ?? "single-area",
    },
    checks: input.checks ?? [
      {
        kind: "behavior",
        id: "task.create.focused",
        title: "Focused public behavior check",
        mode: "focused",
        evidence: "independent-public-behavior",
        coversRisks: [],
        coversSurfaces: ["task.create"],
      },
    ],
  };
}

function saveManifest(
  root: string,
  file: string,
  value: Record<string, unknown>,
): string {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
  return path.relative(root, file);
}

function lastOutput(spy: ReturnType<typeof vi.spyOn>): VerifyPlanOutput {
  const value = spy.mock.calls.at(-1)?.[0];
  if (typeof value !== "string")
    throw new Error("CLI did not print JSON output");
  return JSON.parse(value) as VerifyPlanOutput;
}

function removeFixtures(): void {
  const tempRoot = path.resolve(os.tmpdir());
  for (const root of fixtureRoots.splice(0)) {
    const resolved = path.resolve(root);
    const relative = path.relative(tempRoot, resolved);
    if (
      path.isAbsolute(relative) ||
      relative.startsWith(`..${path.sep}`) ||
      path.dirname(resolved) !== tempRoot ||
      !path.basename(resolved).startsWith(fixturePrefix)
    ) {
      throw new Error(
        `Refusing to recursively remove a non-fixture path: ${resolved}`,
      );
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  removeFixtures();
});

describe("task verify-plan CLI", () => {
  it.each([
    {
      name: "small change",
      manifest: manifestFor(),
      expected: ["task.create.focused"],
    },
    {
      name: "cross-module change",
      manifest: manifestFor({
        scope: "cross-module",
        changedSurfaces: ["task.create", "task.verify"],
        checks: [
          {
            kind: "behavior",
            id: "task.create.focused",
            title: "Focused create check",
            mode: "focused",
            evidence: "independent-public-behavior",
            coversRisks: [],
            coversSurfaces: ["task.create"],
          },
          {
            kind: "behavior",
            id: "task.cross-module.integration",
            title: "Cross-module integration check",
            mode: "integration",
            evidence: "independent-public-behavior",
            coversRisks: [],
            coversSurfaces: ["task.create", "task.verify"],
          },
        ],
      }),
      expected: ["task.cross-module.integration"],
    },
    {
      name: "migration",
      manifest: manifestFor({
        changedSurfaces: ["task.migration"],
        risks: ["migration"],
        checks: [
          {
            kind: "behavior",
            id: "task.migration.check",
            title: "Migration behavior check",
            mode: "migration",
            evidence: "independent-public-behavior",
            coversRisks: ["migration"],
            coversSurfaces: ["task.migration"],
          },
        ],
      }),
      expected: ["task.migration.check"],
    },
    {
      name: "release",
      manifest: manifestFor({
        changedSurfaces: ["package.release"],
        risks: ["release"],
        checks: [
          {
            kind: "behavior",
            id: "package.release.check",
            title: "Release contract check",
            mode: "release",
            evidence: "independent-public-behavior",
            coversRisks: ["release"],
            coversSurfaces: ["package.release"],
          },
        ],
      }),
      expected: ["package.release.check"],
    },
  ])("selects a suitable check for a $name", async ({ manifest, expected }) => {
    const target = fixture();
    const relativeManifest = saveManifest(
      target.root,
      target.manifestPath,
      manifest,
    );
    vi.stubEnv("PACTILE_JEV_ENABLED", "false");
    vi.stubEnv("PACTILE_JEV_API_KEY", "");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(
      await runTaskCliWithWorkspaceReclaim(
        [
          "verify-plan",
          target.taskId,
          "--manifest",
          relativeManifest,
          "--override",
          "--no-jev",
        ],
        target.root,
      ),
    ).toBe(0);
    expect(error).not.toHaveBeenCalled();
    const output = lastOutput(log);
    expect(output.status).toBe("planned-only");
    expect(
      output.deterministicPlan.selected.map((entry) => entry.checkId),
    ).toEqual(expected);
    expect(output.input.completeRepositoryCiInventory).toBe(false);
    expect(output.execution).toBe("not-run");
    expect(output.receipt.status).toBe("persisted");
    if (!output.receipt.ref)
      throw new Error("Planning receipt locator is missing");
    expect(fs.existsSync(path.join(target.root, output.receipt.ref))).toBe(
      true,
    );

    const after = kernel(target.root, target.taskDir);
    expect(after.revision).toBe(target.initialKernel.revision);
    expect(after.runs).toEqual(target.initialKernel.runs);
    expect(after.reviews).toEqual(target.initialKernel.reviews);
    const completedRun = after.runs.at(-1);
    const candidate = completedRun?.candidateSnapshot;
    if (!completedRun || !candidate)
      throw new Error("Completed candidate disappeared");
    const observed = observeTaskRunCandidate({
      run: completedRun,
      repositoryRoot: target.root,
    });
    expect(observed.fingerprint).toBe(
      candidate.entries.find(
        (entry) => entry.ref === "pactile:verification:git-working-tree-v1",
      )?.fingerprint,
    );
  });

  it("does not reduce caller-declared required CI, skips mirror checks, and records an explicit Jev adoption separately", async () => {
    const target = fixture();
    const checks = [
      {
        kind: "policy-ci",
        id: "ci.required",
        title: "Required repository CI check",
        requiredBy: ["project CI: test"],
      },
      {
        kind: "behavior",
        id: "task.create.aaa-primary",
        title: "Primary public behavior check",
        mode: "focused",
        evidence: "independent-public-behavior",
        coversRisks: [],
        coversSurfaces: ["task.create"],
      },
      {
        kind: "behavior",
        id: "task.create.zzz-optional",
        title: "Optional independent public check",
        mode: "focused",
        evidence: "independent-public-behavior",
        coversRisks: [],
        coversSurfaces: ["task.create"],
      },
      {
        kind: "behavior",
        id: "task.create.mirror",
        title: "Implementation mirror check",
        mode: "focused",
        evidence: "implementation-mirror",
        coversRisks: [],
        coversSurfaces: ["task.create"],
      },
    ];
    const relativeManifest = saveManifest(
      target.root,
      target.manifestPath,
      manifestFor({ checks }),
    );
    vi.stubEnv("PACTILE_JEV_ENABLED", "true");
    vi.stubEnv("PACTILE_JEV_API_KEY", "test-key-for-plan-cli");
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        questions: { additional_check: { criteria: Record<string, string> } };
      };
      const labels = Object.keys(request.questions.additional_check.criteria);
      const choice =
        labels.find((label) => label.startsWith("candidate-")) ?? "none";
      const probabilities = Object.fromEntries(
        labels.map((label) => [
          label,
          label === choice ? 0.98 : 0.02 / Math.max(1, labels.length - 1),
        ]),
      );
      return new Response(
        JSON.stringify({
          model: "jev-test",
          answers: {
            additional_check: {
              type: "choice",
              choice,
              confidence: 0.98,
              probabilities,
            },
          },
          usage: { input_tokens: 42, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      await runTaskCliWithWorkspaceReclaim(
        [
          "verify-plan",
          target.taskId,
          "--manifest",
          relativeManifest,
          "--adopt",
        ],
        target.root,
      ),
    ).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const output = lastOutput(log);
    expect(
      output.deterministicPlan.selected.map((entry) => entry.checkId),
    ).toEqual(["ci.required", "task.create.aaa-primary"]);
    expect(output.deterministicPlan.selected[0]).toMatchObject({
      reason: "required-by-policy",
      requiredBy: ["project CI: test"],
    });
    expect(output.deterministicPlan.skipped).toContainEqual(
      expect.objectContaining({
        checkId: "task.create.mirror",
        reason: "implementation-mirror",
      }),
    );
    expect(output.jevAdvice.adoptedCheckIds).toEqual([
      "task.create.zzz-optional",
    ]);
    expect(output.decision.adoptedOptionalCheckIds).toEqual([
      "task.create.zzz-optional",
    ]);
    expect(
      output.deterministicPlan.selected.map((entry) => entry.checkId),
    ).not.toContain("task.create.zzz-optional");
    expect(output.jevAdvice.transport).toMatchObject({
      model: "jev-test",
      inputTokens: 42,
      outputTokens: 5,
    });
    expect(output.execution).toBe("not-run");
  });

  it.each([
    {
      name: "explicit denial",
      options: { denyEgress: true },
      reasonCode: "egress-denied",
    },
    {
      name: "invalid configuration",
      options: { invalidEgress: true },
      reasonCode: "configuration-invalid",
    },
  ])(
    "honors project egress policy ($name) before HTTP",
    async ({ options, reasonCode }) => {
      const target = fixture(options);
      const relativeManifest = saveManifest(
        target.root,
        target.manifestPath,
        manifestFor({
          checks: [
            {
              kind: "behavior",
              id: "task.a-primary",
              title: "Primary public check",
              mode: "focused",
              evidence: "independent-public-behavior",
              coversRisks: [],
              coversSurfaces: ["task.create"],
            },
            {
              kind: "behavior",
              id: "task.z-optional",
              title: "Optional public check",
              mode: "focused",
              evidence: "independent-public-behavior",
              coversRisks: [],
              coversSurfaces: ["task.create"],
            },
          ],
        }),
      );
      vi.stubEnv("PACTILE_JEV_ENABLED", "true");
      vi.stubEnv("PACTILE_JEV_API_KEY", "test-key-for-plan-cli");
      const fetchMock = vi.fn(
        async () => new Response("unused", { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

      expect(
        await runTaskCliWithWorkspaceReclaim(
          [
            "verify-plan",
            target.taskId,
            "--manifest",
            relativeManifest,
            "--override",
          ],
          target.root,
        ),
      ).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(lastOutput(log)).toMatchObject({
        jevEgressPolicy: { allowed: false, reasonCode },
        jevAdvice: { status: "fallback", transport: { attempts: 0 } },
      });
    },
  );

  it.each([
    {
      name: "missing key",
      apiKey: "",
      reasonCode: "configuration-missing",
      reject: false,
    },
    {
      name: "transport failure",
      apiKey: "test-key-for-plan-cli",
      reasonCode: "transport-error",
      reject: true,
    },
    {
      name: "low confidence response",
      apiKey: "test-key-for-plan-cli",
      reasonCode: "low-confidence",
      reject: false,
      lowConfidence: true,
    },
    {
      name: "request deadline expiry",
      apiKey: "test-key-for-plan-cli",
      reasonCode: "deadline-exceeded",
      reject: false,
      timeout: true,
    },
  ])(
    "falls back locally on $name",
    async ({
      apiKey,
      reasonCode,
      reject,
      lowConfidence = false,
      timeout = false,
    }) => {
      const target = fixture();
      const relativeManifest = saveManifest(
        target.root,
        target.manifestPath,
        manifestFor({
          checks: [
            {
              kind: "behavior",
              id: "task.a-primary",
              title: "Primary public check",
              mode: "focused",
              evidence: "independent-public-behavior",
              coversRisks: [],
              coversSurfaces: ["task.create"],
            },
            {
              kind: "behavior",
              id: "task.z-optional",
              title: "Optional public check",
              mode: "focused",
              evidence: "independent-public-behavior",
              coversRisks: [],
              coversSurfaces: ["task.create"],
            },
          ],
        }),
      );
      vi.stubEnv("PACTILE_JEV_ENABLED", "true");
      vi.stubEnv("PACTILE_JEV_API_KEY", apiKey);
      const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
        if (reject) throw new Error("provider detail must not escape");
        if (timeout) return await new Promise<Response>(() => undefined);
        if (lowConfidence) {
          const request = JSON.parse(String(init?.body)) as {
            questions: {
              additional_check: { criteria: Record<string, string> };
            };
          };
          const labels = Object.keys(
            request.questions.additional_check.criteria,
          );
          const choice = labels[0];
          if (!choice) throw new Error("Jev choice labels are missing");
          const choiceProbability = Math.max(0.4, 1 / labels.length);
          const probabilities = Object.fromEntries(
            labels.map((label) => [
              label,
              label === choice
                ? choiceProbability
                : (1 - choiceProbability) / (labels.length - 1),
            ]),
          );
          return new Response(
            JSON.stringify({
              model: "jev-low-confidence-test",
              answers: {
                additional_check: {
                  type: "choice",
                  choice,
                  confidence: 0.4,
                  probabilities,
                },
              },
              usage: { input_tokens: 42, output_tokens: 5 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("unused", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

      expect(
        await runTaskCliWithWorkspaceReclaim(
          [
            "verify-plan",
            target.taskId,
            "--manifest",
            relativeManifest,
            "--override",
          ],
          target.root,
        ),
      ).toBe(0);
      expect(lastOutput(log).jevAdvice).toMatchObject({
        status: "fallback",
        reasonCode,
      });
      expect(JSON.stringify(lastOutput(log))).not.toContain(
        "provider detail must not escape",
      );
      expect(fetchMock).toHaveBeenCalledTimes(
        reject || lowConfidence || timeout ? 1 : 0,
      );
      expect(
        lastOutput(log).deterministicPlan.selected.map(
          (entry) => entry.checkId,
        ),
      ).toContain("task.a-primary");
    },
  );

  it("rejects an answer when the candidate changes during Jev and writes no receipt", async () => {
    const target = fixture();
    const relativeManifest = saveManifest(
      target.root,
      target.manifestPath,
      manifestFor({
        checks: [
          {
            kind: "behavior",
            id: "task.a-primary",
            title: "Primary public check",
            mode: "focused",
            evidence: "independent-public-behavior",
            coversRisks: [],
            coversSurfaces: ["task.create"],
          },
          {
            kind: "behavior",
            id: "task.z-optional",
            title: "Optional public check",
            mode: "focused",
            evidence: "independent-public-behavior",
            coversRisks: [],
            coversSurfaces: ["task.create"],
          },
        ],
      }),
    );
    vi.stubEnv("PACTILE_JEV_ENABLED", "true");
    vi.stubEnv("PACTILE_JEV_API_KEY", "test-key-for-plan-cli");
    const fetchMock = vi.fn(async () => {
      fs.writeFileSync(
        path.join(target.root, "src", "feature.ts"),
        "export const feature = 'drift';\n",
      );
      return new Response(
        JSON.stringify({
          model: "jev-test",
          answers: {
            additional_check: {
              type: "choice",
              choice: "candidate-01",
              confidence: 0.98,
              probabilities: { "candidate-01": 0.98, none: 0.02 },
            },
          },
          usage: { input_tokens: 42, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(
      await runTaskCliWithWorkspaceReclaim(
        [
          "verify-plan",
          target.taskId,
          "--manifest",
          relativeManifest,
          "--adopt",
        ],
        target.root,
      ),
    ).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.at(-1)?.[0]).toContain("candidate");
    expect(fs.existsSync(path.join(target.root, ".pactile", ".runtime"))).toBe(
      false,
    );
    const after = kernel(target.root, target.taskDir);
    expect(after.revision).toBe(target.initialKernel.revision);
    expect(after.runs).toEqual(target.initialKernel.runs);
    expect(after.reviews).toEqual(target.initialKernel.reviews);
    const storedCandidate = after.runs
      .at(-1)
      ?.candidateSnapshot?.entries.find(
        (entry) => entry.ref === "pactile:verification:git-working-tree-v1",
      );
    const originalCandidate = target.initialKernel.runs
      .at(-1)
      ?.candidateSnapshot?.entries.find(
        (entry) => entry.ref === "pactile:verification:git-working-tree-v1",
      );
    expect(storedCandidate?.fingerprint).toBe(originalCandidate?.fingerprint);
    const latestRun = after.runs.at(-1);
    if (!latestRun) throw new Error("Latest Run disappeared");
    const currentObservation = observeTaskRunCandidate({
      run: latestRun,
      repositoryRoot: target.root,
    });
    expect(currentObservation.fingerprint).not.toBe(
      storedCandidate?.fingerprint,
    );
  });
});
