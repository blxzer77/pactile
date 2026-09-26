import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTaskCli } from "../../src/commands/task.js";
import { createTaskKernel, startTaskRun } from "../../src/core/task/index.js";
import {
  parallelStatus,
  runParallelBatch,
} from "../../src/pactile/parallel/batch.js";
import { PiTaskBridge, type PiRunRecord } from "../../src/pactile/pi/bridge.js";
import { reserveParallelChild } from "../../src/pactile/parallel/policy.js";
import { projectWriteSetsConflict } from "../../src/pactile/scheduler/project-lease-store.js";
import { readTaskMap, writeTaskMap } from "../../src/pactile/task/task-map.js";
import {
  prepareCodexRequest,
  recordCodexReceipt,
} from "../../src/pactile/codex/bridge.js";

const roots: string[] = [];
const FAKE_PI_PROVIDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.tmp/p31-script-build/fixtures/fake-pi-provider.js",
);

function requiredAt<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`Missing item at index ${index}`);
  return value;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture(
  worktree = false,
  baseBranch = false,
  childCount = 3,
): {
  root: string;
  parent: string;
  children: string[];
  manifest: string;
  scriptArgs: string[];
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-parallel-"));
  roots.push(root);
  const tasks = path.join(root, ".pactile", "tasks");
  fs.mkdirSync(path.join(tasks, "locale", "en"), { recursive: true });
  fs.writeFileSync(
    path.join(tasks, "locale", "en", "default-prd.md"),
    "# {title}\n{goal}\n",
  );
  fs.writeFileSync(
    path.join(root, ".pactile", "config.yaml"),
    "artifact_locale: en\n",
  );
  fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=tester\n");
  expect(
    runTaskCli(["legacy-create", "Parent", "--slug", "parallel-parent"], root),
  ).toBe(0);
  const parent =
    fs.readdirSync(tasks).find((name) => name.endsWith("-parallel-parent")) ??
    "";
  const children: string[] = [];
  const slugs = [
    "alpha",
    "beta",
    "gamma",
    ...Array.from(
      { length: Math.max(0, childCount - 3) },
      (_, index) => `extra-${String(index).padStart(2, "0")}`,
    ),
  ];
  for (const slug of slugs) {
    expect(
      runTaskCli(
        ["legacy-create", slug, "--slug", slug, "--parent", parent],
        root,
      ),
    ).toBe(0);
    const child =
      fs.readdirSync(tasks).find((name) => name.endsWith(`-${slug}`)) ?? "";
    const dir = path.join(tasks, child);
    fs.writeFileSync(
      path.join(dir, "design.md"),
      "# Design\nIndependent worker.\n",
    );
    fs.writeFileSync(
      path.join(dir, "implement.md"),
      `execution_mode: worker\nisolation: ${worktree && slug === "alpha" ? "git-worktree" : "main-worktree"}\nverification_profile: standard\nretrieval_profile: exact-only\noptional_capabilities: []\nquality_gates:\n  mode: profile\n`,
    );
    if (baseBranch && slug === "alpha")
      expect(runTaskCli(["set-base-branch", child, "develop"], root)).toBe(0);
    expect(runTaskCli(["start-execution", child, "--approved"], root)).toBe(0);
    children.push(child);
  }
  const parentDir = path.join(tasks, parent);
  const { data, body } = readTaskMap(parentDir);
  if (!data) throw new Error("Missing task map");
  data.parallel_limit = 1;
  data.children.forEach((child, index) => {
    child.touches =
      index === 2 && childCount === 3
        ? ["src/alpha"]
        : [`src/${index === 0 ? "alpha" : child.id}`];
  });
  writeTaskMap(parentDir, data, body);
  const manifest = path.join(root, "parallel.json");
  const items = children.map((child) => {
    const prompt = path.join(root, `${child}.md`);
    fs.writeFileSync(prompt, `Implement ${child}.`);
    return {
      task: child,
      prompt_file: prompt,
      review_cost: "low",
      estimated_costs: { executionMs: 300_000 },
    };
  });
  fs.writeFileSync(
    manifest,
    JSON.stringify({ schema_version: 1, limit: 1, children: items }),
  );
  const scriptArgs = [
    FAKE_PI_PROVIDER,
    "--session-name",
    "fake-session.jsonl",
    "--result-cwd",
    "--response-delay-ms",
    "250",
  ];
  return { root, parent, children, manifest, scriptArgs };
}

describe("scheduler-driven Parent dispatch", () => {
  it("ignores legacy numeric limits, follows schedule waves, and records integration metrics", async () => {
    const { root, parent, children, manifest, scriptArgs } = fixture();
    const result = await runParallelBatch(root, parent, manifest, {
      command: process.execPath,
      args: scriptArgs,
    });
    expect(result.children.map((child) => child.outcome)).toEqual([
      "settled",
      "settled",
      "settled",
    ]);
    expect(result.max_active).toBe(2);
    expect(result.compatibility_limit_ignored).toBe(1);
    expect(result.schedule_receipt_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const [alpha, beta, gamma] = result.children;
    expect(Date.parse(alpha.started_at)).toBeLessThan(
      Date.parse(beta.ended_at),
    );
    expect(Date.parse(beta.started_at)).toBeLessThan(
      Date.parse(alpha.ended_at),
    );
    expect(Date.parse(gamma.started_at)).toBeGreaterThanOrEqual(
      Date.parse(alpha.ended_at),
    );
    expect(result.queue_wait_total_ms).toBeGreaterThan(0);
    expect(parallelStatus(root, parent)).toMatchObject({
      integration_owner: "parent",
      merge_limit: 1,
      integration_complete: false,
      latest_batch: { batch_id: result.batch_id, wall_ms: result.wall_ms },
    });
    for (const child of children) {
      const dir = path.join(root, ".pactile", "tasks", child);
      fs.appendFileSync(
        path.join(dir, "verify.md"),
        "\nValidation commands: fake Pi RPC passed\nFinal acceptance evidence: Parent reviewed result\n",
      );
      fs.writeFileSync(
        path.join(dir, "handoff.md"),
        "# Handoff\nReviewed change-set: local fixture\n",
      );
      expect(
        runTaskCli(
          ["set-child-state", parent, child, "review", "--evidence", "pi-run"],
          root,
        ),
      ).toBe(0);
      expect(
        runTaskCli(
          [
            "integrate-child",
            parent,
            child,
            "accepted",
            "--evidence",
            "parent-review",
            "--ref",
            `git:${child}`,
          ],
          root,
        ),
      ).toBe(0);
    }
    expect(
      runTaskCli(
        [
          "integrate-child",
          parent,
          children[0],
          "integrating",
          "--evidence",
          "merge-ready",
          "--ref",
          `git:${children[0]}`,
        ],
        root,
      ),
    ).toBe(0);
    expect(
      runTaskCli(
        [
          "integrate-child",
          parent,
          children[1],
          "integrating",
          "--evidence",
          "merge-ready",
          "--ref",
          `git:${children[1]}`,
        ],
        root,
      ),
    ).toBe(1);
    expect(
      runTaskCli(
        [
          "integrate-child",
          parent,
          children[0],
          "integrated",
          "--evidence",
          "merge",
          "--ref",
          `git:${children[0]}`,
        ],
        root,
      ),
    ).toBe(0);
    for (const child of children.slice(1)) {
      expect(
        runTaskCli(
          [
            "integrate-child",
            parent,
            child,
            "integrating",
            "--evidence",
            "merge-ready",
            "--ref",
            `git:${child}`,
          ],
          root,
        ),
      ).toBe(0);
      expect(
        runTaskCli(
          [
            "integrate-child",
            parent,
            child,
            "integrated",
            "--evidence",
            "merge",
            "--ref",
            `git:${child}`,
          ],
          root,
        ),
      ).toBe(0);
    }
    expect(parallelStatus(root, parent)).toMatchObject({
      integration_complete: true,
    });
  });

  it("blocks unmet dependencies and overlapping direct bridge reservations before launch", async () => {
    const { root, parent, children, manifest, scriptArgs } = fixture();
    const parentDir = path.join(root, ".pactile", "tasks", parent);
    const { data, body } = readTaskMap(parentDir);
    if (!data) throw new Error("Missing task map");
    data.children[1].depends_on = [children[0]];
    writeTaskMap(parentDir, data, body);
    await expect(
      runParallelBatch(root, parent, manifest, {
        command: process.execPath,
        args: scriptArgs,
      }),
    ).rejects.toThrow("requires unmet");
    expect(fs.existsSync(path.join(parentDir, "parallel", "latest.json"))).toBe(
      false,
    );
    data.children[1].depends_on = [];
    writeTaskMap(parentDir, data, body);
    const release = reserveParallelChild(
      root,
      path.join(root, ".pactile", "tasks", children[0]),
    );
    try {
      expect(() =>
        reserveParallelChild(
          root,
          path.join(root, ".pactile", "tasks", children[2]),
        ),
      ).toThrow("write-set conflict");
      const releaseBeta = reserveParallelChild(
        root,
        path.join(root, ".pactile", "tasks", children[1]),
      );
      releaseBeta();
    } finally {
      release();
    }
    data.execution_topology = "serial";
    writeTaskMap(parentDir, data, body);
    await expect(
      runParallelBatch(root, parent, manifest, {
        command: process.execPath,
        args: scriptArgs,
      }),
    ).rejects.toThrow("execution_topology must be parallel");
  });

  it("coordinates legacy writer reservations across Parent boundaries", () => {
    const { root, children } = fixture();
    const tasks = path.join(root, ".pactile", "tasks");
    expect(
      runTaskCli(["legacy-create", "Parent", "--slug", "other-parent"], root),
    ).toBe(0);
    const otherParent =
      fs.readdirSync(tasks).find((name) => name.endsWith("-other-parent")) ??
      "";
    expect(otherParent).not.toBe("");
    expect(
      runTaskCli(
        [
          "legacy-create",
          "other",
          "--slug",
          "other-child",
          "--parent",
          otherParent,
        ],
        root,
      ),
    ).toBe(0);
    const otherChild =
      fs.readdirSync(tasks).find((name) => name.endsWith("-other-child")) ?? "";
    const otherChildDir = path.join(tasks, otherChild);
    fs.writeFileSync(
      path.join(otherChildDir, "design.md"),
      "# Design\nCross-parent overlap.\n",
    );
    fs.writeFileSync(
      path.join(otherChildDir, "implement.md"),
      "execution_mode: worker\nisolation: main-worktree\nverification_profile: standard\nretrieval_profile: exact-only\noptional_capabilities: []\nquality_gates:\n  mode: profile\n",
    );
    expect(
      runTaskCli(["start-execution", otherChild, "--approved"], root),
    ).toBe(0);
    const otherParentDir = path.join(tasks, otherParent);
    const otherMap = readTaskMap(otherParentDir);
    if (!otherMap.data) throw new Error("Missing other Parent task map");
    requiredAt(otherMap.data.children, 0).touches = ["src/alpha"];
    writeTaskMap(otherParentDir, otherMap.data, otherMap.body);

    const release = reserveParallelChild(
      root,
      path.join(tasks, requiredAt(children, 0)),
    );
    try {
      expect(() => reserveParallelChild(root, otherChildDir)).toThrow(
        "write-set conflict",
      );
    } finally {
      release();
    }
  });

  it("normalizes durable legacy leases before cross-Parent conflict checks", () => {
    expect(projectWriteSetsConflict([], ["src/Shared.ts"])).toBe(true);
    const { root, parent } = fixture();
    const tasks = path.join(root, ".pactile", "tasks");
    const parentDir = path.join(tasks, parent);
    const parentMap = readTaskMap(parentDir);
    if (!parentMap.data) throw new Error("Missing Parent task map");
    requiredAt(parentMap.data.children, 0).touches = ["SRC/Shared.ts"];
    writeTaskMap(parentDir, parentMap.data, parentMap.body);

    expect(
      runTaskCli(["legacy-create", "Parent", "--slug", "other-parent"], root),
    ).toBe(0);
    const otherParent =
      fs.readdirSync(tasks).find((name) => name.endsWith("-other-parent")) ??
      "";
    expect(otherParent).not.toBe("");
    expect(
      runTaskCli(
        [
          "legacy-create",
          "other-child",
          "--slug",
          "other-child",
          "--parent",
          otherParent,
        ],
        root,
      ),
    ).toBe(0);
    const otherChild =
      fs.readdirSync(tasks).find((name) => name.endsWith("-other-child")) ?? "";
    const otherChildDir = path.join(tasks, otherChild);
    fs.writeFileSync(
      path.join(otherChildDir, "design.md"),
      "# Design\nCross-parent overlap.\n",
    );
    fs.writeFileSync(
      path.join(otherChildDir, "implement.md"),
      "execution_mode: worker\nisolation: main-worktree\nverification_profile: standard\nretrieval_profile: exact-only\noptional_capabilities: []\nquality_gates:\n  mode: profile\n",
    );
    expect(
      runTaskCli(["start-execution", otherChild, "--approved"], root),
    ).toBe(0);
    const otherParentDir = path.join(tasks, otherParent);
    const otherMap = readTaskMap(otherParentDir);
    if (!otherMap.data) throw new Error("Missing other Parent task map");
    requiredAt(otherMap.data.children, 0).touches = ["src/Shared.ts"];
    writeTaskMap(otherParentDir, otherMap.data, otherMap.body);

    const legacyActive = path.join(parentDir, "parallel", "active");
    fs.mkdirSync(legacyActive, { recursive: true });
    const legacyLease = path.join(legacyActive, "old-writer.json");
    fs.writeFileSync(
      legacyLease,
      JSON.stringify({
        id: "old-writer",
        pid: process.pid,
        durable: true,
        child: "old-child",
        touches:
          process.platform === "win32" ? ["SRC/Shared.ts"] : ["src/Shared.ts"],
      }),
    );

    // On Windows these spellings differ only by case; on case-sensitive
    // filesystems the fixture uses the same spelling as the new writer.
    expect(() => reserveParallelChild(root, otherChildDir)).toThrow(
      "write-set conflict",
    );

    // An empty old scope carries no proof of disjointness and must conflict
    // with every new writer instead of being treated as no writes.
    fs.writeFileSync(
      legacyLease,
      JSON.stringify({
        id: "old-writer",
        pid: process.pid,
        durable: true,
        child: "old-child",
        touches: [],
      }),
    );
    expect(() => reserveParallelChild(root, otherChildDir)).toThrow(
      "write-set conflict",
    );
  });

  it("merges a V2 Run-only write set into active Parent Child lease conflicts", () => {
    const { root, parent, children } = fixture();
    const parentDir = path.join(root, ".pactile", "tasks", parent);
    const mapRead = readTaskMap(parentDir);
    if (!mapRead.data) throw new Error("Missing Parent task map");
    requiredAt(mapRead.data.children, 2).touches = ["src/run-only.ts"];
    writeTaskMap(parentDir, mapRead.data, mapRead.body);

    const alphaDir = path.join(
      root,
      ".pactile",
      "tasks",
      requiredAt(children, 0),
    );
    const kernelFixtureDir = path.join(alphaDir, "v2-run-fixture");
    const created = createTaskKernel({
      root,
      taskDir: kernelFixtureDir,
      actor: "author",
      idempotencyKey: "create:run-only-child",
      definition: {
        taskId: requiredAt(children, 0),
        title: "Run-only write-set fixture",
        description: "The Run owns a path omitted from Child touches.",
        deliverable: "a combined lease write set",
        deliveryLevel: "local-result",
        acceptanceCriteria: [
          { id: "AC-1", description: "Run writes are leased" },
        ],
        dependencies: [],
      },
    });
    const run = startTaskRun({
      root,
      taskDir: kernelFixtureDir,
      expectedRevision: created.kernel.revision,
      actor: "implementer",
      idempotencyKey: "run:run-only-child",
      input: { summary: "Run-only write-set fixture", references: [] },
      authorization: {
        approvedBy: "approver",
        approvedAt: "2026-09-26T00:00:00.000Z",
        scope: "fixture",
        evidenceRef: "approval.json",
      },
      initialState: "waiting",
      writeSetSnapshot: ["src/run-only.ts"],
    });
    expect(run.kernel.runs.at(-1)?.writeSetSnapshot).toEqual([
      "src/run-only.ts",
    ]);
    fs.copyFileSync(
      path.join(kernelFixtureDir, "kernel.json"),
      path.join(alphaDir, "kernel.json"),
    );

    const release = reserveParallelChild(root, alphaDir);
    try {
      expect(() =>
        reserveParallelChild(
          root,
          path.join(root, ".pactile", "tasks", requiredAt(children, 2)),
        ),
      ).toThrow("write-set conflict");
    } finally {
      release();
    }
  });

  it("uses high review cost as a scheduling weight without forbidding parallel work", async () => {
    const { root, parent, manifest, scriptArgs } = fixture();
    const value = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
      children: { review_cost: string }[];
    };
    value.children[1].review_cost = "high";
    fs.writeFileSync(manifest, JSON.stringify(value));
    const result = await runParallelBatch(root, parent, manifest, {
      command: process.execPath,
      args: scriptArgs,
    });
    expect(result.max_active).toBe(2);
  });

  it("allows overlapping writers only when the persisted wave carries explicit authorization and an integration plan", async () => {
    const { root, parent, children, manifest, scriptArgs } = fixture();
    const value = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
      conflict_parallelizations?: unknown;
    };
    value.conflict_parallelizations = [
      {
        task_ids: [children[0], children[2]],
        approved_by: "reviewer",
        authorization_ref: "approval/P37-overlap",
        integration_owner: "parent-integrator",
        integration_plan:
          "Integrate alpha and gamma serially and resolve their shared src/alpha paths before review.",
      },
    ];
    fs.writeFileSync(manifest, JSON.stringify(value));

    const result = await runParallelBatch(root, parent, manifest, {
      command: process.execPath,
      args: scriptArgs,
    });
    expect(result.max_active).toBe(3);
    const receipt = JSON.parse(
      fs.readFileSync(path.resolve(root, result.schedule_receipt_file), "utf8"),
    ) as {
      plan: {
        waves: {
          taskIds: string[];
          conflictAuthorizations: {
            approvedBy: string;
            authorizationRef: string;
            integrationOwner: string;
            integrationPlan: string;
          }[];
        }[];
      };
    };
    const authorization = receipt.plan.waves
      .flatMap((wave) => wave.conflictAuthorizations)
      .find((item) => item.authorizationRef === "approval/P37-overlap");
    expect(authorization).toMatchObject({
      approvedBy: "reviewer",
      integrationOwner: "parent-integrator",
      integrationPlan: expect.stringContaining("serially"),
    });

    const invalid = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
      conflict_parallelizations: { integration_plan: string }[];
    };
    const invalidAuthorization = invalid.conflict_parallelizations[0];
    if (!invalidAuthorization)
      throw new Error("fixture did not include conflict authorization");
    invalidAuthorization.integration_plan = " ";
    fs.writeFileSync(manifest, JSON.stringify(invalid));
    await expect(
      runParallelBatch(root, parent, manifest, {
        command: process.execPath,
        args: scriptArgs,
      }),
    ).rejects.toThrow(/integrationPlan/);
  });

  it("runs 33 approved disjoint Children in one planned wave despite old 1-child and 32-child limits", async () => {
    const { root, parent, children, manifest } = fixture(false, false, 33);
    let active = 0;
    let observedMax = 0;
    vi.spyOn(PiTaskBridge.prototype, "run").mockImplementation(
      async (input) => {
        active += 1;
        observedMax = Math.max(observedMax, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        const now = new Date().toISOString();
        return {
          schema_version: 1,
          run_id: `mock-${input.task}`,
          task: input.task,
          role: "implement",
          outcome: "settled",
          started_at: now,
          ended_at: now,
          prompt_sha256: "0".repeat(64),
          session_id: "mock-session",
          session_file: null,
          process_mode: "warm",
          startup_ms: 0,
          first_event_ms: 0,
          elapsed_ms: 10,
          event_count: 1,
          tool_errors: 0,
          reason: null,
          result_file: null,
        } satisfies PiRunRecord;
      },
    );
    vi.spyOn(PiTaskBridge.prototype, "close").mockResolvedValue(undefined);

    const result = await runParallelBatch(root, parent, manifest);
    expect(children).toHaveLength(33);
    expect(result.max_active).toBe(33);
    expect(observedMax).toBe(33);
    expect(result.compatibility_limit_ignored).toBe(1);
    expect(result.children).toHaveLength(33);
  });

  it("reserves more than four disjoint direct bridge leases while reading old parallel_limit as compatibility data", () => {
    const { root, parent, children } = fixture(false, false, 6);
    const releases: (() => void)[] = [];
    try {
      for (const child of children) {
        releases.push(
          reserveParallelChild(
            root,
            path.join(root, ".pactile", "tasks", child),
          ),
        );
      }
      expect(releases).toHaveLength(6);
      expect(
        fs.readdirSync(
          path.join(root, ".pactile", "tasks", parent, "parallel", "active"),
        ),
      ).toHaveLength(6);
    } finally {
      for (const release of releases.reverse()) release();
    }
  });

  it("refuses a missing worktree and runs Pi in a verified Child checkout once prepared", async () => {
    const { root, parent, children, manifest, scriptArgs } = fixture(true);
    await expect(
      runParallelBatch(root, parent, manifest, {
        command: process.execPath,
        args: scriptArgs,
      }),
    ).rejects.toThrow("prepared Child worktree");
    expect(
      fs.existsSync(
        path.join(root, ".pactile", "tasks", parent, "parallel", "latest.json"),
      ),
    ).toBe(false);
    const git = (...args: string[]): string =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init");
    fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
    git("add", "README.md");
    git(
      "-c",
      "user.name=Pactile Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    const checkout = path.join(root, ".pactile", "worktrees", "alpha");
    fs.mkdirSync(path.dirname(checkout), { recursive: true });
    git("worktree", "add", "-b", "feat/alpha", checkout, "HEAD");
    const childDir = path.join(root, ".pactile", "tasks", children[0]);
    const task = JSON.parse(
      fs.readFileSync(path.join(childDir, "task.json"), "utf8"),
    ) as Record<string, unknown>;
    task.worktree_path = path.relative(root, checkout);
    fs.writeFileSync(path.join(childDir, "task.json"), JSON.stringify(task));
    const result = await runParallelBatch(root, parent, manifest, {
      command: process.execPath,
      args: scriptArgs,
    });
    expect(result.children[0].outcome).toBe("settled");
    const latest = JSON.parse(
      fs.readFileSync(path.join(childDir, "pi-bridge", "latest.json"), "utf8"),
    ) as { result_file: string };
    expect(
      fs
        .readFileSync(path.join(childDir, latest.result_file), "utf8")
        .trim()
        .toLowerCase(),
    ).toBe(fs.realpathSync(checkout).toLowerCase());
  });

  it("holds a Codex Execute slot until a completed native wait receipt", () => {
    const { root, children } = fixture(false, true);
    const prompt = path.join(root, "codex-prompt.md");
    fs.writeFileSync(prompt, "Implement the approved Child write set.");
    const first = prepareCodexRequest({
      root,
      task: children[0],
      tool: "create_thread",
      role: "execute",
      promptFile: prompt,
      projectId: "pactile-project",
      environment: "worktree",
    });
    expect(String(first.arguments.prompt)).toContain(
      "Parent-approved write set: src/alpha",
    );
    expect(first.arguments).toMatchObject({
      target: {
        environment: {
          type: "worktree",
          startingState: { type: "branch", branchName: "develop" },
        },
      },
    });
    expect(() =>
      prepareCodexRequest({
        root,
        task: children[2],
        tool: "create_thread",
        role: "execute",
        promptFile: prompt,
        projectId: "pactile-project",
        environment: "worktree",
      }),
    ).toThrow("write-set conflict");
    const threadId = "01a0cca7-8fe7-7c82-a682-1366b68e2139";
    const receipt = (name: string, value: Record<string, unknown>): string => {
      const file = path.join(root, `${name}.json`);
      fs.writeFileSync(file, JSON.stringify(value));
      return file;
    };
    recordCodexReceipt(
      root,
      children[0],
      first.request_id,
      receipt("created", {
        request_id: first.request_id,
        tool: first.tool,
        outcome: "ok",
        thread_id: threadId,
        host_id: "local",
      }),
    );
    const wait = prepareCodexRequest({
      root,
      task: children[0],
      tool: "wait_threads",
      threadId,
      timeoutMs: 0,
    });
    recordCodexReceipt(
      root,
      children[0],
      wait.request_id,
      receipt("completed", {
        request_id: wait.request_id,
        tool: wait.tool,
        outcome: "ok",
        thread_id: threadId,
        host_id: "local",
        status: "completed",
      }),
    );
    expect(() =>
      prepareCodexRequest({
        root,
        task: children[2],
        tool: "create_thread",
        role: "execute",
        promptFile: prompt,
        projectId: "pactile-project",
        environment: "worktree",
      }),
    ).not.toThrow();
  });
});
