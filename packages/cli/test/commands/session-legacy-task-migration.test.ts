import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runSessionCli } from "../../src/commands/session.js";
import { runTaskCli } from "../../src/commands/task.js";
import { runContextCli } from "../../src/commands/context.js";
import { buildLegacyTaskV2Import } from "../../src/core/task/legacy-task-v2-import.js";
import { scanLegacyTaskMigration } from "../../src/core/task/legacy-task-migration.js";
import { emptyTaskRecord } from "../../src/core/task/schema.js";
import {
  legacyTaskMigrationOverlayPath,
} from "../../src/core/task/legacy-task-migration-reader.js";
import {
  createTaskKernel,
  readTaskKernel,
  startTaskRun,
} from "../../src/core/task/task-kernel.js";
import { runLegacyTaskBatch } from "../../src/pactile/migration/legacy-task-batch.js";
import { compileSessionPack } from "../../src/pactile/task/session-pack.js";
import { initializeDeveloper } from "../../src/utils/developer.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-p36-session-migration-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".pactile", "config.yaml"),
    "session_auto_commit: false\n",
    "utf8",
  );
  initializeDeveloper(root, "alice");
  return root;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function addLegacyTask(
  root: string,
  options: {
    readonly id: string;
    readonly directory: string;
    readonly needsDefinition?: boolean;
    readonly needsCoordination?: boolean;
  },
): string {
  const taskDir = path.join(root, ".pactile", "tasks", options.directory);
  writeJson(path.join(taskDir, "task.json"), {
    id: options.id,
    title: `Legacy ${options.id}`,
    description: "Preserve the selected legacy record.",
    status: "in_progress",
    createdAt: "2026-09-25T12:00:00.000Z",
    creator: "legacy-author",
    ...(options.needsDefinition
      ? {}
      : {
          deliverable: "A reviewable session migration result",
          deliveryLevel: "local-result",
        }),
    ...(options.needsCoordination
      ? { depends_on: ["missing-block-target"], depends_mode: "block" }
      : {}),
  });
  fs.writeFileSync(
    path.join(taskDir, "prd.md"),
    options.needsDefinition
      ? "# Legacy Task\n\n## Acceptance Criteria\n\n- TBD\n"
      : "# Legacy Task\n\n## Acceptance Criteria\n\n- Session entry remains source-preserving.\n",
    "utf8",
  );
  return taskDir;
}

async function importTasks(root: string): Promise<void> {
  const plan = scanLegacyTaskMigration({ projectRoot: root });
  const candidate = buildLegacyTaskV2Import(plan);
  const result = await runLegacyTaskBatch(
    { projectRoot: root, plan, targets: candidate.targets },
    { approved: true },
  );
  expect(result.status).toBe("completed");
}

function selectTask(root: string, taskDir: string): void {
  vi.stubEnv("PACTILE_CONTEXT_ID", "codex_session_migration_test");
  expect(runTaskCli(["select", path.basename(taskDir)], root)).toBe(0);
}

interface SessionWorkspaceSnapshot {
  readonly index: Buffer;
  readonly journals: ReadonlyMap<string, Buffer>;
}

function journalFiles(root: string): SessionWorkspaceSnapshot {
  const workspace = path.join(root, ".pactile", "workspace", "alice");
  const journals = fs
    .readdirSync(workspace)
    .filter((name) => /^journal-\d+\.md$/.test(name))
    .sort()
    .map((name) => [
      name,
      fs.readFileSync(path.join(workspace, name)),
    ] as const);
  return {
    index: fs.readFileSync(path.join(workspace, "index.md")),
    journals: new Map(journals),
  };
}

function expectJournalUnchanged(
  root: string,
  before: SessionWorkspaceSnapshot,
): void {
  const after = journalFiles(root);
  expect(after.index.equals(before.index)).toBe(true);
  expect([...after.journals.keys()]).toEqual([...before.journals.keys()]);
  for (const [name, contents] of before.journals)
    expect(after.journals.get(name)?.equals(contents)).toBe(true);
}

function createNativeV2Task(root: string, taskId: string): string {
  const taskDir = path.join(root, ".pactile", "tasks", taskId);
  createTaskKernel({
    root,
    taskDir,
    actor: "session-test",
    idempotencyKey: `create:${taskId}`,
    definition: {
      taskId,
      title: `Native ${taskId}`,
      description: "A native V2 task for the session command test.",
      deliverable: "A reviewable local result",
      deliveryLevel: "local-result",
      acceptanceCriteria: [
        { id: "AC-1", description: "The session entry can be recorded." },
      ],
      dependencies: [],
    },
  });
  return taskDir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("session add with selected legacy Task migrations", () => {
  it.each([
    ["needs-definition", { needsDefinition: true }],
    ["needs-coordination", { needsCoordination: true }],
  ] as const)(
    "shows %s and refuses to append a session journal",
    async (status, options) => {
      const root = makeRoot();
      const taskDir = addLegacyTask(root, {
        id: `legacy-${status}`,
        directory: `01-${status}`,
        ...options,
      });
      await importTasks(root);
      selectTask(root, taskDir);
      const before = journalFiles(root);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

      expect(runSessionCli(["add", "--title", "Should not be recorded"], root)).toBe(1);
      expect(String(error.mock.calls.at(-1)?.[0])).toContain(status);
      expect(String(error.mock.calls.at(-1)?.[0])).toContain(
        "session journal was not written",
      );
      expectJournalUnchanged(root, before);
    },
  );

  it.each([
    ["needs-definition", { needsDefinition: true }],
    ["needs-coordination", { needsCoordination: true }],
  ] as const)(
    "keeps %s selected Task visible but non-runnable in the Session Pack",
    async (status, options) => {
      const root = makeRoot();
      const taskDir = addLegacyTask(root, {
        id: `legacy-pack-${status}`,
        directory: `01-pack-${status}`,
        ...options,
      });
      const modules = path.join(root, ".pactile", "modules");
      fs.mkdirSync(path.join(modules, "define-basic"), { recursive: true });
      writeJson(path.join(modules, "index.json"), {
        modules: [{ id: "define-basic", contract: "define-basic/contract.md" }],
      });
      fs.writeFileSync(
        path.join(modules, "define-basic", "contract.md"),
        "Migration-only define contract must not be emitted as an active Task contract.",
        "utf8",
      );

      await importTasks(root);
      selectTask(root, taskDir);
      const pack = compileSessionPack(root);
      const layers = pack.layers as { moduleIds: string[]; items: unknown[]; text: string }[];

      expect(pack.kernel).toMatchObject({
        taskId: `legacy-pack-${status}`,
        schemaVersion: 0,
        phase: "define",
        condition: "blocked",
        selected: true,
        migrationStatus: status,
        runnable: false,
      });
      expect(pack.kernel).toHaveProperty(
        status === "needs-definition" ? "missingDefinitionFields" : "coordinationReasons",
      );
      expect(pack).not.toHaveProperty("rigor");
      expect(pack).not.toHaveProperty("topologyKind");
      expect(pack).not.toHaveProperty("tileSelection");
      expect(layers[0]?.text).toContain(`Migration ${status}:`);
      expect(layers[1]?.moduleIds).toEqual([]);
      expect(layers[2]?.items).toEqual([]);
      expect(JSON.stringify(pack)).not.toContain("Migration-only define contract");
      expect(JSON.stringify(pack)).not.toMatch(/Rigor=lite|topology=single|Open Proposal|Open approval/);
    },
  );

  it("returns an error for selected migration state with missing authority", async () => {
    const root = makeRoot();
    const taskDir = addLegacyTask(root, {
      id: "legacy-missing-authority-pack",
      directory: "01-missing-authority-pack",
    });
    await importTasks(root);
    selectTask(root, taskDir);
    const before = journalFiles(root);
    fs.rmSync(
      path.join(root, ".pactile", "runtime", "legacy-task-migrations", "authority.json"),
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(runContextCli(["--mode", "session", "--json"], root)).toBe(1);
    expect(output).not.toHaveBeenCalled();
    expect(String(error.mock.calls.at(-1)?.[0])).toMatch(
      /legacy-task-migration-authority-missing-with-residual-state/,
    );
    expectJournalUnchanged(root, before);
  });

  it("fails closed on a corrupt selected overlay without writing the journal", async () => {
    const root = makeRoot();
    const taskDir = addLegacyTask(root, {
      id: "legacy-corrupt-overlay",
      directory: "01-corrupt-overlay",
    });
    await importTasks(root);
    selectTask(root, taskDir);
    const imported = readTaskKernel({ root, taskDir, cwd: root });
    expect(imported.kind).toBe("task-kernel-v2");
    if (imported.kind !== "task-kernel-v2")
      throw new Error("expected active V2 Task");
    startTaskRun({
      root,
      taskDir,
      expectedRevision: imported.kernel.revision,
      actor: "session-migration-integrity-test",
      idempotencyKey: "session-migration-integrity-run",
      input: {
        summary: "Create a real mutable migration overlay",
        references: [],
      },
      authorization: {
        approvedBy: "test-approver",
        approvedAt: "2026-09-25T13:00:00.000Z",
        scope: "one Task",
        evidenceRef: "approval.json",
      },
    });
    const overlayDir = legacyTaskMigrationOverlayPath(root, taskDir);
    if (!overlayDir) throw new Error("missing migration overlay path");
    fs.writeFileSync(path.join(overlayDir, "kernel.json"), "corrupt overlay\n");
    const before = journalFiles(root);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(runSessionCli(["add", "--title", "Must fail closed"], root)).toBe(1);
    expect(String(error.mock.calls.at(-1)?.[0])).toMatch(/overlay hash-mismatch/);
    expectJournalUnchanged(root, before);
  });

  it("fails closed when migration authority is missing and preserves the journal", async () => {
    const root = makeRoot();
    const taskDir = addLegacyTask(root, {
      id: "legacy-missing-authority",
      directory: "01-missing-authority",
    });
    await importTasks(root);
    selectTask(root, taskDir);
    const before = journalFiles(root);
    fs.rmSync(
      path.join(
        root,
        ".pactile",
        "runtime",
        "legacy-task-migrations",
        "authority.json",
      ),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(runSessionCli(["add", "--title", "Must not be recorded"], root)).toBe(1);
    expect(String(error.mock.calls.at(-1)?.[0])).toMatch(
      /authority-missing-with-residual-state/,
    );
    expectJournalUnchanged(root, before);
  });

  it("allows session add for an imported V2 Task and records the journal", async () => {
    const root = makeRoot();
    const taskDir = addLegacyTask(root, {
      id: "legacy-imported-session-positive",
      directory: "01-imported-session-positive",
    });
    await importTasks(root);
    selectTask(root, taskDir);
    const before = journalFiles(root);

    expect(
      runSessionCli(["add", "--title", "Imported V2 session"], root),
    ).toBe(0);

    const after = journalFiles(root);
    expect(after.index.equals(before.index)).toBe(false);
    expect([...after.journals.keys()]).toEqual([...before.journals.keys()]);
    expect(after.journals.get("journal-1.md")?.equals(
      before.journals.get("journal-1.md") ?? Buffer.alloc(0),
    )).toBe(false);
    expect(after.journals.get("journal-1.md")?.toString("utf8")).toContain(
      "Session 1: Imported V2 session",
    );
    expect(after.index.toString("utf8")).toContain("**Total Sessions**: 1");
  });

  it("keeps a readable legacy Kernel v1 eligible for session add", () => {
    const root = makeRoot();
    expect(
      runTaskCli(
        ["legacy-create", "Confirmed legacy", "--slug", "confirmed-legacy"],
        root,
      ),
    ).toBe(0);
    const taskName = fs
      .readdirSync(path.join(root, ".pactile", "tasks"))
      .find((name) => name.endsWith("-confirmed-legacy"));
    if (!taskName) throw new Error("legacy-create did not create the Task directory");
    const taskDir = path.join(root, ".pactile", "tasks", taskName);
    const kernel = JSON.parse(
      fs.readFileSync(path.join(taskDir, "kernel.json"), "utf8"),
    ) as { schemaVersion: number };
    expect(kernel.schemaVersion).toBe(1);
    selectTask(root, taskDir);

    expect(
      runSessionCli(["add", "--title", "Confirmed legacy session"], root),
    ).toBe(0);
    expect(
      fs
        .readFileSync(
          path.join(root, ".pactile", "workspace", "alice", "journal-1.md"),
          "utf8",
        )
        .includes("Session 1: Confirmed legacy session"),
    ).toBe(true);
  });

  it("refuses a synthesized V1 result if kernel.json disappears after preflight", () => {
    const root = makeRoot();
    const taskDir = createNativeV2Task(root, "native-kernel-race-session");
    const taskFile = path.join(taskDir, "task.json");
    writeJson(
      taskFile,
      emptyTaskRecord({
        id: "native-kernel-race-session",
        name: "native-kernel-race-session",
        title: "Stale task projection",
        description: "A legacy-shaped task.json beside native V2 data.",
        status: "planning",
        creator: "session-test",
        assignee: "session-test",
        createdAt: "2026-09-25",
      }),
    );
    selectTask(root, taskDir);
    const kernelFile = path.join(taskDir, "kernel.json");
    const movedKernelFile = `${kernelFile}.moved-during-read`;
    const kernelBytes = fs.readFileSync(kernelFile);
    const taskBytes = fs.readFileSync(taskFile);
    const before = journalFiles(root);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const originalKernelStat = fs.lstatSync(kernelFile);
    const normalizedKernelFile = path.resolve(kernelFile).toLowerCase();
    let movedKernel = false;
    const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      const requestedPath = String(args[0]);
      if (path.resolve(requestedPath).toLowerCase() === normalizedKernelFile) {
        if (!movedKernel) {
          movedKernel = true;
          fs.renameSync(kernelFile, movedKernelFile);
          return originalKernelStat;
        }
        const missing = new Error(`kernel disappeared: ${kernelFile}`) as NodeJS.ErrnoException;
        missing.code = "ENOENT";
        throw missing;
      }
      return fs.statSync(requestedPath);
    });

    let exitCode = -1;
    try {
      exitCode = runSessionCli(
        ["add", "--title", "Must not record synthesized V1"],
        root,
      );
    } finally {
      lstatSpy.mockRestore();
    }

    expect(movedKernel).toBe(true);
    expect(exitCode).toBe(1);
    expect(String(error.mock.calls.at(-1)?.[0])).toContain(
      "selected-task-kernel-not-persisted",
    );
    expectJournalUnchanged(root, before);
    expect(fs.existsSync(kernelFile)).toBe(false);
    expect(fs.readFileSync(movedKernelFile).equals(kernelBytes)).toBe(true);
    expect(fs.readFileSync(taskFile).equals(taskBytes)).toBe(true);
    const fallback = readTaskKernel({ root, taskDir, cwd: root });
    expect(fallback.kind).toBe("legacy-task-kernel-v1");
    if (fallback.kind === "legacy-task-kernel-v1")
      expect(fallback.kernel.persisted).toBe(false);
  });

  it("fails closed on a corrupt native V2 Kernel without creating any journal", () => {
    const root = makeRoot();
    const taskDir = createNativeV2Task(root, "native-corrupt-session");
    selectTask(root, taskDir);
    const kernelFile = path.join(taskDir, "kernel.json");
    fs.writeFileSync(kernelFile, "{ corrupt native kernel\n", "utf8");
    const corruptKernel = fs.readFileSync(kernelFile);
    const before = journalFiles(root);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(
      runSessionCli(["add", "--title", "Must fail closed"], root),
    ).toBe(1);
    expect(String(error.mock.calls.at(-1)?.[0])).toMatch(/Failed to parse/);
    expectJournalUnchanged(root, before);
    expect(fs.readFileSync(kernelFile).equals(corruptKernel)).toBe(true);
  });

  it("rejects a missing native V2 Kernel instead of falling back to task.json", () => {
    const root = makeRoot();
    const taskDir = createNativeV2Task(root, "native-missing-session");
    selectTask(root, taskDir);
    fs.rmSync(path.join(taskDir, "kernel.json"));
    const before = journalFiles(root);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(
      runSessionCli(["add", "--title", "Must not be recorded"], root),
    ).toBe(1);
    expect(String(error.mock.calls.at(-1)?.[0])).toContain(
      "selected-task-kernel-missing",
    );
    expectJournalUnchanged(root, before);
  });

  it("does not treat a parseable task.json as legacy when kernel.json is missing", () => {
    const root = makeRoot();
    const taskDir = addLegacyTask(root, {
      id: "task-json-without-kernel",
      directory: "01-task-json-without-kernel",
    });
    selectTask(root, taskDir);
    const before = journalFiles(root);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(
      runSessionCli(["add", "--title", "Must not be recorded"], root),
    ).toBe(1);
    expect(String(error.mock.calls.at(-1)?.[0])).toContain(
      "selected-task-kernel-missing",
    );
    expectJournalUnchanged(root, before);
  });
});
