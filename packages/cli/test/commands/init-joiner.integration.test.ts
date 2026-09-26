/**
 * Integration tests for the joiner-onboarding branch of init().
 *
 * Covers the three-branch dispatch:
 *   no .pactile/                         → creator bootstrap task
 *   .pactile/ exists, .developer missing → joiner onboarding task
 *   both exist                           → no task created
 *
 * Uses the same fs-temp-dir + hoisted-mock approach as init.integration.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// === External dependency mocks (hoisted by vitest) ===

vi.mock("figlet", () => ({
  default: { textSync: vi.fn(() => "PACTILE") },
}));

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn().mockResolvedValue({}) },
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockImplementation((cmd: string) => {
    const py = process.platform === "win32" ? "python" : "python3";
    return cmd === `${py} --version` ? "Python 3.11.12" : "";
  }),
}));

// === Imports ===

import { init } from "../../src/commands/init.js";
import { readTaskKernel } from "../../src/core/task/index.js";
import { scheduleTaskKernelGraph } from "../../src/pactile/scheduler/index.js";
import { DIR_NAMES, FILE_NAMES, PATHS } from "../../src/constants/paths.js";
import { execSync } from "node:child_process";
import { createTaskWithArtifacts } from "../../src/pactile/task/creation.js";
import { emptyTaskJson } from "../../src/utils/task-json.js";

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

describe("init() joiner onboarding", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-joiner-int-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.spyOn(console, "log").mockImplementation(noop);
    vi.spyOn(console, "warn").mockImplementation(noop);
    vi.spyOn(console, "error").mockImplementation(noop);
    vi.mocked(execSync).mockClear();
    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      const py = process.platform === "win32" ? "python" : "python3";
      return cmd === `${py} --version` ? "Python 3.11.12" : "";
    }) as typeof execSync);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper: simulate a fresh clone of an existing Pactile project — `.pactile/`
   * committed (with at least one archived task indicating prior work),
   * `.developer` absent. Real fresh-clone state always has either an active or
   * archived bootstrap task; an empty `tasks/` indicates an aborted partial
   * init (issue #204) and triggers the bootstrap fallback instead of joiner.
   *
   * NOTE: the seeded `tasks/archive/` is load-bearing for the joiner branch.
   * If you change the `tasksEmpty` predicate in init.ts (currently
   * `!exists || readdirSync().length === 0`), audit this helper — e.g., if
   * archive/ stops counting as "non-empty", every joiner test below regresses
   * into the bootstrap-fallback branch and assertions flip silently.
   */
  function simulateExistingCheckout(): void {
    const workflow = path.join(tmpDir, DIR_NAMES.WORKFLOW);
    fs.mkdirSync(path.join(workflow, DIR_NAMES.TASKS, "archive"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(workflow, DIR_NAMES.SPEC), { recursive: true });
    fs.mkdirSync(path.join(workflow, DIR_NAMES.WORKSPACE), { recursive: true });
  }

  /** Helper: simulate same-dev re-init — both `.pactile/` and `.developer` exist */
  function simulateSameDevReinit(name: string): void {
    simulateExistingCheckout();
    fs.writeFileSync(
      path.join(tmpDir, PATHS.DEVELOPER_FILE),
      `${name}\n`,
      "utf-8",
    );
  }

  it("#1 empty cwd + init → creator bootstrap task created", async () => {
    await init({ yes: true, user: "alice" });

    const bootstrap = path.join(
      tmpDir,
      PATHS.TASKS,
      "00-bootstrap-guidelines",
    );
    expect(fs.existsSync(bootstrap)).toBe(true);
    const bootstrapKernel = readTaskKernel({
      root: tmpDir,
      taskDir: bootstrap,
      cwd: tmpDir,
    });
    expect(bootstrapKernel.kind).toBe("task-kernel-v2");
    if (bootstrapKernel.kind === "task-kernel-v2") {
      expect(bootstrapKernel.kernel.phase).toBe("define");
      expect(bootstrapKernel.kernel.definition.deliveryLevel).toBe(
        "documentation",
      );
      expect(
        bootstrapKernel.kernel.definition.acceptanceCriteria.length,
      ).toBeGreaterThan(0);
      expect(bootstrapKernel.kernel.definition.dependencies).toEqual([]);
      expect(bootstrapKernel.kernel.runs).toEqual([]);
      expect(bootstrapKernel.kernel.reviews).toEqual([]);
      expect(bootstrapKernel.kernel.closure).toBeNull();
    }
    expect(fs.existsSync(path.join(bootstrap, FILE_NAMES.TASK_JSON))).toBe(
      false,
    );

    // No joiner task present
    const joiner = path.join(tmpDir, PATHS.TASKS, "00-join-alice");
    expect(fs.existsSync(joiner)).toBe(false);
  });

  it("keeps V2 bootstrap bytes and user files on repeated recovery init", async () => {
    await init({ yes: true, user: "alice" });
    const taskDir = path.join(tmpDir, PATHS.TASKS, "00-bootstrap-guidelines");
    const kernelPath = path.join(taskDir, "kernel.json");
    const prdPath = path.join(taskDir, FILE_NAMES.PRD);
    const userFile = path.join(taskDir, "human-note.md");
    fs.writeFileSync(userFile, "Keep this note.\n", "utf8");
    const kernelBefore = fs.readFileSync(kernelPath);
    const prdBefore = fs.readFileSync(prdPath);
    const marker = path.join(
      tmpDir,
      PATHS.TASKS,
      ".pending-00-bootstrap-guidelines",
    );
    fs.writeFileSync(
      marker,
      "Task creation was interrupted; retry pactile init.\n",
      "utf8",
    );

    await init({ yes: true, user: "alice", force: true });

    expect(fs.readFileSync(kernelPath)).toEqual(kernelBefore);
    expect(fs.readFileSync(prdPath)).toEqual(prdBefore);
    expect(fs.readFileSync(userFile, "utf8")).toBe("Keep this note.\n");
    expect(fs.existsSync(marker)).toBe(false);
    const kernel = readTaskKernel({ root: tmpDir, taskDir, cwd: tmpDir });
    expect(kernel.kind).toBe("task-kernel-v2");
    if (kernel.kind === "task-kernel-v2")
      expect(kernel.kernel.runs).toEqual([]);
  });

  it("leaves an existing complete V1 bootstrap untouched for the migration flow", async () => {
    simulateExistingCheckout();
    const taskId = "00-bootstrap-guidelines";
    const taskDir = path.join(tmpDir, PATHS.TASKS, taskId);
    createTaskWithArtifacts({
      root: tmpDir,
      dirName: taskId,
      record: emptyTaskJson({
        id: taskId,
        name: taskId,
        title: "Historical Bootstrap",
        status: "planning",
        dev_type: "docs",
        priority: "P1",
        creator: "legacy",
        assignee: "legacy",
      }),
      artifacts: new Map([
        [FILE_NAMES.PRD, "Historical 0.5.x bootstrap task.\n"],
      ]),
      actor: "legacy init",
      idempotencyKey: "legacy-bootstrap",
      evidence: "historical init task",
      ifExists: "error",
    });
    const before = new Map(
      ["kernel.json", FILE_NAMES.TASK_JSON, FILE_NAMES.PRD].map((name) => [
        name,
        fs.readFileSync(path.join(taskDir, name)),
      ]),
    );
    fs.writeFileSync(
      path.join(tmpDir, PATHS.TASKS, ".pending-00-bootstrap-guidelines"),
      "Task creation was interrupted; retry pactile init.\n",
      "utf8",
    );

    await init({ yes: true, user: "alice", force: true });

    for (const [name, bytes] of before) {
      expect(fs.readFileSync(path.join(taskDir, name))).toEqual(bytes);
    }
    const legacy = readTaskKernel({ root: tmpDir, taskDir, cwd: tmpDir });
    expect(legacy.kind).toBe("legacy-task-kernel-v1");
    if (legacy.kind === "legacy-task-kernel-v1")
      expect(legacy.kernel.persisted).toBe(true);
    expect(fs.existsSync(path.join(taskDir, "onboarding-notes.md"))).toBe(
      false,
    );
    expect(
      fs.existsSync(
        path.join(tmpDir, PATHS.TASKS, ".pending-00-bootstrap-guidelines"),
      ),
    ).toBe(false);
  });

  it("retries bootstrap after a failed PRD write without publishing a partial task", async () => {
    const original = fs.writeFileSync;
    const fault = vi.spyOn(fs, "writeFileSync").mockImplementation(((file, content, options) => {
      if (String(file).includes("00-bootstrap-guidelines") && String(file).endsWith("prd.md")) throw new Error("injected PRD failure");
      return original(file, content, options);
    }) as typeof fs.writeFileSync);
    try { await init({ yes: true, user: "alice" }); }
    finally { fault.mockRestore(); }
    const bootstrap = path.join(tmpDir, PATHS.TASKS, "00-bootstrap-guidelines");
    expect(fs.existsSync(bootstrap)).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, PATHS.TASKS, ".pending-00-bootstrap-guidelines"))).toBe(true);
    await init({ yes: true, user: "alice" });
    expect(
      fs.readFileSync(path.join(bootstrap, FILE_NAMES.PRD), "utf8"),
    ).toContain("Bootstrap");
    const kernel = readTaskKernel({
      root: tmpDir,
      taskDir: bootstrap,
      cwd: tmpDir,
    });
    expect(kernel.kind).toBe("task-kernel-v2");
    if (kernel.kind === "task-kernel-v2") {
      expect(kernel.kernel.phase).toBe("define");
      expect(kernel.kernel.runs).toEqual([]);
    }
  });

  it("#2 existing .pactile/ + no .developer → joiner onboarding task created", async () => {
    simulateExistingCheckout();
    const marker = path.join(
      tmpDir,
      PATHS.TASKS,
      ".pending-00-join-bob",
    );
    const developerFile = path.join(tmpDir, PATHS.DEVELOPER_FILE);
    const originalWriteFileSync = fs.writeFileSync;
    let intentExistedWhenIdentityWasWritten = false;
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(((
      filePath: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: fs.WriteFileOptions,
    ) => {
      if (String(filePath) === developerFile) {
        intentExistedWhenIdentityWasWritten =
          fs.readFileSync(marker, "utf8") ===
          "Task creation was interrupted; retry pactile init.\n";
      }
      return originalWriteFileSync(filePath, data, options);
    }) as typeof fs.writeFileSync);

    try {
      await init({ yes: true, user: "bob", force: true });
    } finally {
      writeSpy.mockRestore();
    }

    expect(intentExistedWhenIdentityWasWritten).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);

    const joiner = path.join(tmpDir, PATHS.TASKS, "00-join-bob");
    expect(fs.existsSync(joiner)).toBe(true);

    const kernel = readTaskKernel({
      root: tmpDir,
      taskDir: joiner,
      cwd: tmpDir,
    });
    expect(kernel.kind).toBe("task-kernel-v2");
    if (kernel.kind !== "task-kernel-v2")
      throw new Error("expected V2 joiner Task");
    expect(kernel.kernel.identity.taskId).toBe("00-join-bob");
    expect(kernel.kernel.phase).toBe("define");
    expect(kernel.kernel.definition.title).toContain("bob");
    expect(kernel.kernel.definition.deliveryLevel).toBe("documentation");
    expect(kernel.kernel.definition.dependencies).toEqual([]);
    expect(kernel.kernel.definition.acceptanceCriteria.length).toBeGreaterThan(
      0,
    );
    expect(kernel.kernel.runs).toEqual([]);
    expect(kernel.kernel.reviews).toEqual([]);
    expect(kernel.kernel.closure).toBeNull();
    expect(fs.existsSync(path.join(joiner, FILE_NAMES.TASK_JSON))).toBe(false);

    const prd = fs.readFileSync(path.join(joiner, FILE_NAMES.PRD), "utf-8");
    // PRD is the human-readable plan for the new V2 Define Task.
    expect(prd).toContain("bob");
    expect(prd).toContain("V2 Define");
    expect(prd).toContain("No Run exists");
    expect(prd).toContain("workflow.md");
    expect(prd).toContain(".pactile/spec/");
    expect(prd).toContain("00-join-bob");
    expect(prd).toContain("pactile task schedule list");
    expect(prd).toContain("candidate-bound independent Review");
    expect(prd).not.toContain("/cstl:continue");
    expect(prd).not.toContain("/cstl:finish-work");
    expect(prd).not.toContain("/cstl:start");
    expect(prd).not.toMatch(/loads the Phase Index/i);
    expect(prd).not.toMatch(/pactile task (?:start-execution|archive)/i);
    expect(prd).not.toContain("pactile-implement");
    expect(prd).not.toContain("pactile-check");
    expect(prd).not.toContain("auto-inject");
    expect(prd).not.toContain("Integrate?");
    expect(prd).toContain("onboarding-notes.md");
    expect(prd).toContain(
      "Do not move the task directory as a substitute for Close",
    );

    // init creates the joiner task but does not set repo-global current-task state.
    expect(fs.existsSync(path.join(tmpDir, PATHS.CURRENT_TASK_FILE))).toBe(
      false,
    );

    // Bootstrap task NOT created
    expect(
      fs.existsSync(path.join(tmpDir, PATHS.TASKS, "00-bootstrap-guidelines")),
    ).toBe(false);
  });

  it("#2b issue #204: existing .pactile/ but tasks/ empty → bootstrap fallback (--yes alone, no --force)", async () => {
    // Mirrors the exact reproduction in issue #204: first run aborted partway
    // after writing the .pactile/ skeleton but before creating bootstrap;
    // second run uses `--yes` alone (no --force, no --skip-existing) to recover.
    // Without the empty-tasks early-bypass at init.ts:931, this command would
    // route through handleReinit and mis-create a joiner task.
    const workflow = path.join(tmpDir, DIR_NAMES.WORKFLOW);
    fs.mkdirSync(path.join(workflow, DIR_NAMES.TASKS), { recursive: true });
    fs.mkdirSync(path.join(workflow, DIR_NAMES.SPEC), { recursive: true });
    fs.mkdirSync(path.join(workflow, DIR_NAMES.WORKSPACE), { recursive: true });

    await init({ yes: true, user: "alice" });

    expect(
      fs.existsSync(path.join(tmpDir, PATHS.TASKS, "00-bootstrap-guidelines")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, PATHS.TASKS, "00-join-alice")),
    ).toBe(false);
  });

  it("#2c issue #204 with --force: empty tasks/ also triggers bootstrap fallback (not joiner)", async () => {
    // Same recovery scenario but with --force, which bypasses handleReinit
    // via the original guard rather than the empty-tasks bypass. Both paths
    // must converge on bootstrap creation.
    const workflow = path.join(tmpDir, DIR_NAMES.WORKFLOW);
    fs.mkdirSync(path.join(workflow, DIR_NAMES.TASKS), { recursive: true });
    fs.mkdirSync(path.join(workflow, DIR_NAMES.SPEC), { recursive: true });
    fs.mkdirSync(path.join(workflow, DIR_NAMES.WORKSPACE), { recursive: true });

    await init({ yes: true, user: "alice", force: true });

    expect(
      fs.existsSync(path.join(tmpDir, PATHS.TASKS, "00-bootstrap-guidelines")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, PATHS.TASKS, "00-join-alice")),
    ).toBe(false);
  });

  it("#3 existing .pactile/ + .developer → no task created", async () => {
    simulateSameDevReinit("carol");

    await init({ yes: true, user: "carol", force: true });

    expect(
      fs.existsSync(path.join(tmpDir, PATHS.TASKS, "00-join-carol")),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(tmpDir, PATHS.TASKS, "00-bootstrap-guidelines")),
    ).toBe(false);
  });

  it("#4 after the joiner directory is removed but .developer remains → no new task on re-init", async () => {
    simulateExistingCheckout();

    await init({ yes: true, user: "dave", force: true });
    const joinerPath = path.join(tmpDir, PATHS.TASKS, "00-join-dave");
    expect(fs.existsSync(joinerPath)).toBe(true);

    // Manually create the .developer file that init_developer.py would have
    // written (it's mocked in this test), then remove the task directory.
    fs.writeFileSync(
      path.join(tmpDir, PATHS.DEVELOPER_FILE),
      "dave\n",
      "utf-8",
    );
    fs.rmSync(joinerPath, { recursive: true, force: true });

    // Re-init: should NOT recreate the joiner task
    await init({ yes: true, user: "dave", force: true });

    expect(fs.existsSync(joinerPath)).toBe(false);
  }, 60_000);

  it("recovers an interrupted joiner from its durable marker after identity was written", async () => {
    simulateExistingCheckout();
    const developerFile = path.join(tmpDir, PATHS.DEVELOPER_FILE);
    const marker = path.join(
      tmpDir,
      PATHS.TASKS,
      ".pending-00-join-dave",
    );
    const joinerPath = path.join(tmpDir, PATHS.TASKS, "00-join-dave");

    // Model a process exit after initializeDeveloper wrote identity but before
    // the staged V2 Task directory was atomically published.
    fs.writeFileSync(
      developerFile,
      `name=dave\ninitialized_at=${new Date().toISOString()}\n`,
      "utf8",
    );
    fs.writeFileSync(
      marker,
      "Task creation was interrupted; retry pactile init.\n",
      "utf8",
    );

    await init({ yes: true });

    expect(fs.existsSync(joinerPath)).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    const kernel = readTaskKernel({ root: tmpDir, taskDir: joinerPath, cwd: tmpDir });
    expect(kernel.kind).toBe("task-kernel-v2");
    if (kernel.kind === "task-kernel-v2") {
      expect(kernel.kernel.phase).toBe("define");
      expect(kernel.kernel.runs).toEqual([]);
      expect(kernel.kernel.reviews).toEqual([]);
      expect(kernel.kernel.closure).toBeNull();
    }
  });

  it("#5a developer name with spaces → filesystem-safe slug", async () => {
    simulateExistingCheckout();

    await init({ yes: true, user: "Tao Su", force: true });

    const joiner = path.join(tmpDir, PATHS.TASKS, "00-join-tao-su");
    expect(fs.existsSync(joiner)).toBe(true);

    const kernel = readTaskKernel({
      root: tmpDir,
      taskDir: joiner,
      cwd: tmpDir,
    });
    expect(kernel.kind).toBe("task-kernel-v2");
    if (kernel.kind === "task-kernel-v2") {
      expect(kernel.kernel.definition.createdBy).toContain("Tao Su");
      expect(kernel.kernel.definition.title).toContain("Tao Su");
      expect(kernel.kernel.identity.taskId).toBe("00-join-tao-su");
    }
  });

  it("#5b developer name with '/' → slug strips separator", async () => {
    simulateExistingCheckout();

    await init({ yes: true, user: "@org/bob", force: true });

    // slugifyDeveloperName: lowercase @org/bob → punctuation-collapsed to "org-bob"
    const joiner = path.join(tmpDir, PATHS.TASKS, "00-join-org-bob");
    expect(fs.existsSync(joiner)).toBe(true);
  });

  it("#5c developer name with Unicode letters → task dir is filesystem-safe", async () => {
    simulateExistingCheckout();

    await init({ yes: true, user: "田中 太郎", force: true });

    // Unicode letters pass through \p{Letter}, so dir name is non-empty
    const entries = fs
      .readdirSync(path.join(tmpDir, PATHS.TASKS))
      .filter((name) => name.startsWith("00-join-"));
    expect(entries).toHaveLength(1);

    const joiner = path.join(tmpDir, PATHS.TASKS, entries[0]);
    const kernel = readTaskKernel({
      root: tmpDir,
      taskDir: joiner,
      cwd: tmpDir,
    });
    expect(kernel.kind).toBe("task-kernel-v2");
    if (kernel.kind === "task-kernel-v2") {
      expect(kernel.kernel.definition.createdBy).toContain("田中 太郎");
      expect(kernel.kernel.identity.taskId).toMatch(
        /^00-join-u[0-9a-f]+-u[0-9a-f]+/u,
      );
      const planned = scheduleTaskKernelGraph(tmpDir, [
        kernel.kernel.identity.taskId,
      ]);
      expect(planned.receipt.scope).toBe("task-kernel-v2");
      expect(planned.receipt.candidateTaskIds).toEqual([
        kernel.kernel.identity.taskId,
      ]);
      const afterPlan = readTaskKernel({
        root: tmpDir,
        taskDir: joiner,
        cwd: tmpDir,
      });
      expect(afterPlan.kind).toBe("task-kernel-v2");
      if (afterPlan.kind === "task-kernel-v2")
        expect(afterPlan.kernel.runs).toEqual([]);
    }
  });

  it("#6 joiner creation failure surfaces as warning, init does not crash", async () => {
    // Simulate "fresh clone" state, then set up conditions that make
    // The PRD write occurs only in the private staging directory. Throwing
    // there must leave no published partial task and keep a recovery marker.
    simulateExistingCheckout();

    const originalWriteFileSync = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(((
      filePath: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: fs.WriteFileOptions,
    ) => {
      const pathStr = String(filePath);
      if (pathStr.includes("00-join-eve") && pathStr.endsWith("prd.md")) {
        throw new Error("simulated PRD failure");
      }
      return originalWriteFileSync(filePath, data, options);
    }) as typeof fs.writeFileSync);

    const warnSpy = vi.spyOn(console, "warn");

    await expect(
      init({ yes: true, user: "eve", force: true }),
    ).resolves.toBeUndefined();

    expect(
      warnSpy.mock.calls.some((call) =>
        call.some(
          (arg) =>
            typeof arg === "string" &&
            arg.includes("Failed to create joiner onboarding task"),
        ),
      ),
    ).toBe(true);

    writeSpy.mockRestore();
    const joiner = path.join(tmpDir, PATHS.TASKS, "00-join-eve");
    expect(fs.existsSync(joiner)).toBe(false);
    expect(
      fs.existsSync(path.join(tmpDir, PATHS.TASKS, ".pending-00-join-eve")),
    ).toBe(true);
    await init({ yes: true, user: "eve", force: true });
    const kernel = readTaskKernel({
      root: tmpDir,
      taskDir: joiner,
      cwd: tmpDir,
    });
    expect(kernel.kind).toBe("task-kernel-v2");
    if (kernel.kind === "task-kernel-v2") {
      expect(kernel.kernel.phase).toBe("define");
      expect(kernel.kernel.runs).toEqual([]);
    }
    expect(
      fs.readFileSync(path.join(joiner, FILE_NAMES.PRD), "utf8"),
    ).toContain("Joiner Onboarding Task");
  });

  it("preserves a pre-existing empty .creating directory after successful task creation", async () => {
    simulateExistingCheckout();
    const stagingRoot = path.join(tmpDir, PATHS.TASKS, ".creating");
    fs.mkdirSync(stagingRoot);

    await init({ yes: true, user: "iris", force: true });

    expect(fs.statSync(stagingRoot).isDirectory()).toBe(true);
    expect(fs.readdirSync(stagingRoot)).toEqual([]);
    expect(
      fs.existsSync(path.join(tmpDir, PATHS.TASKS, "00-join-iris")),
    ).toBe(true);
  });

  it("preserves a pre-existing .creating file and reports a clean task failure", async () => {
    simulateExistingCheckout();
    const stagingPath = path.join(tmpDir, PATHS.TASKS, ".creating");
    const marker = path.join(
      tmpDir,
      PATHS.TASKS,
      ".pending-00-join-jules",
    );
    const warningSpy = vi.spyOn(console, "warn");
    fs.writeFileSync(stagingPath, "User-owned path.\n", "utf8");

    await expect(
      init({ yes: true, user: "jules", force: true }),
    ).resolves.toBeUndefined();

    expect(fs.readFileSync(stagingPath, "utf8")).toBe("User-owned path.\n");
    expect(fs.statSync(stagingPath).isFile()).toBe(true);
    expect(fs.existsSync(marker)).toBe(true);
    expect(
      warningSpy.mock.calls.some((call) =>
        call.some(
          (arg) =>
            typeof arg === "string" &&
            arg.includes("Failed to create joiner onboarding task"),
        ),
      ),
    ).toBe(true);
  });

  // Tests #7/#8 cover the handleReinit path — the default flow when .pactile/
  // already exists and neither --force nor --skip-existing is passed. init()
  // routes through handleReinit() instead of the main dispatch, so joiner
  // creation is wired separately inside handleReinit's add-developer branch.
  // The earlier tests all pass force:true, which bypasses this path.

  it("#7 handleReinit path: existing .pactile/ + no .developer → joiner task created", async () => {
    simulateExistingCheckout();
    const marker = path.join(
      tmpDir,
      PATHS.TASKS,
      ".pending-00-join-frank",
    );
    const developerFile = path.join(tmpDir, PATHS.DEVELOPER_FILE);
    const originalWriteFileSync = fs.writeFileSync;
    let intentExistedWhenIdentityWasWritten = false;
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(((
      filePath: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: fs.WriteFileOptions,
    ) => {
      if (String(filePath) === developerFile) {
        intentExistedWhenIdentityWasWritten =
          fs.readFileSync(marker, "utf8") ===
          "Task creation was interrupted; retry pactile init.\n";
      }
      return originalWriteFileSync(filePath, data, options);
    }) as typeof fs.writeFileSync);

    try {
      await init({ yes: true, user: "frank" });
    } finally {
      writeSpy.mockRestore();
    }

    expect(intentExistedWhenIdentityWasWritten).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    const joiner = path.join(tmpDir, PATHS.TASKS, "00-join-frank");
    expect(fs.existsSync(joiner)).toBe(true);

    const kernel = readTaskKernel({
      root: tmpDir,
      taskDir: joiner,
      cwd: tmpDir,
    });
    expect(kernel.kind).toBe("task-kernel-v2");
    if (kernel.kind === "task-kernel-v2") {
      expect(kernel.kernel.definition.createdBy).toContain("frank");
      expect(kernel.kernel.phase).toBe("define");
    }

    expect(fs.existsSync(path.join(tmpDir, PATHS.CURRENT_TASK_FILE))).toBe(
      false,
    );
  });

  it("#8 handleReinit path: existing .pactile/ + .developer → no task created", async () => {
    simulateSameDevReinit("grace");

    await init({ yes: true, user: "grace" });

    expect(
      fs.existsSync(path.join(tmpDir, PATHS.TASKS, "00-join-grace")),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(tmpDir, PATHS.TASKS, "00-bootstrap-guidelines")),
    ).toBe(false);
  });
});
