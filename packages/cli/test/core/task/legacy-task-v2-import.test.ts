import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runTaskCli } from "../../../src/commands/task.js";
import { runContextCli } from "../../../src/commands/context.js";
import { buildLegacyTaskV2Import } from "../../../src/core/task/legacy-task-v2-import.js";
import { scanLegacyTaskMigration } from "../../../src/core/task/legacy-task-migration.js";
import { legacyTaskMigrationOverlayPath } from "../../../src/core/task/legacy-task-migration-reader.js";
import {
  listTaskKernelSnapshots,
  readTaskKernel,
  startTaskRun,
} from "../../../src/core/task/task-kernel.js";
import { runLegacyTaskBatch } from "../../../src/pactile/migration/legacy-task-batch.js";

const roots: string[] = [];
const RELEASE_WRITER_FIXTURE_ROOT = fileURLToPath(
  new URL("../../fixtures/legacy-v050-task-source/input", import.meta.url),
);
const RELEASE_WRITER_PROVENANCE = fileURLToPath(
  new URL(
    "../../fixtures/legacy-v050-task-source/provenance.json",
    import.meta.url,
  ),
);

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-p36-v2-import-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
  return root;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

interface LegacyTaskOptions {
  readonly id: string;
  readonly directory: string;
  readonly status?: string;
  readonly dependsOn?: unknown;
  readonly dependsMode?: unknown;
  readonly metaDependsMode?: unknown;
  readonly deliverable?: string;
  readonly deliveryLevel?: string;
  readonly rawAcceptanceCriteria?: unknown;
  readonly prd?: string;
  readonly kernel?: string;
  readonly extra?: Record<string, unknown>;
}

function addLegacyTask(root: string, options: LegacyTaskOptions): string {
  const dir = path.join(root, ".pactile", "tasks", options.directory);
  const task: Record<string, unknown> = {
    id: options.id,
    title: `Title for ${options.id}`,
    description: `Source description for ${options.id}`,
    status: options.status ?? "in_progress",
    createdAt: "2026-09-25T12:00:00.000Z",
    creator: "legacy-author",
    deliverable: options.deliverable ?? `A reviewable result for ${options.id}`,
    deliveryLevel: options.deliveryLevel ?? "local-result",
    ...(options.dependsOn !== undefined
      ? { depends_on: options.dependsOn }
      : {}),
    ...(options.dependsMode !== undefined
      ? { depends_mode: options.dependsMode }
      : {}),
    ...(options.metaDependsMode !== undefined
      ? { meta: { depends_mode: options.metaDependsMode } }
      : {}),
    ...(options.rawAcceptanceCriteria !== undefined
      ? { acceptanceCriteria: options.rawAcceptanceCriteria }
      : {}),
    ...options.extra,
  };
  writeJson(path.join(dir, "task.json"), task);
  if (options.prd !== undefined)
    fs.writeFileSync(path.join(dir, "prd.md"), options.prd, "utf8");
  if (options.kernel !== undefined)
    fs.writeFileSync(path.join(dir, "kernel.json"), options.kernel, "utf8");
  return dir;
}

function prd(
  criteria = "The exported result contains the exact requested values.",
): string {
  return `# Task\n\nKeep source description.\n\n## Acceptance Criteria\n\n- ${criteria}\n`;
}

function importPlan(root: string) {
  const plan = scanLegacyTaskMigration({ projectRoot: root });
  const imported = buildLegacyTaskV2Import(plan);
  return { plan, imported };
}

function requiredTarget<T extends { path: string }>(
  targets: readonly T[],
  targetPath: string,
): T {
  const target = targets.find((item) => item.path === targetPath);
  if (!target) throw new Error(`missing staged target: ${targetPath}`);
  return target;
}

async function commitImport(root: string) {
  const { plan, imported } = importPlan(root);
  const result = await runLegacyTaskBatch(
    { projectRoot: root, plan, targets: imported.targets },
    { approved: true },
  );
  expect(result.status).toBe("completed");
  if (result.status !== "completed")
    throw new Error("legacy import did not commit");
  return { plan, imported, result };
}

function v2At(root: string, taskDir: string) {
  const read = readTaskKernel({ root, taskDir, cwd: root });
  if (read.kind !== "task-kernel-v2")
    throw new Error("expected committed V2 Task");
  return read.kernel;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("legacy Task to V2 import mapping", () => {
  it("fails closed on deleted or hash-mismatched mutable overlays across read, list, show, and Run", async () => {
    const root = makeRoot();
    const taskDir = addLegacyTask(root, {
      id: "overlay-integrity-task",
      directory: "01-overlay-integrity",
      prd: prd(),
    });
    await commitImport(root);
    vi.stubEnv("PACTILE_CONTEXT_ID", "codex_overlay_integrity");
    expect(runTaskCli(["select", path.basename(taskDir)], root)).toBe(0);
    const initial = v2At(root, taskDir);
    const request = {
      root,
      taskDir,
      expectedRevision: initial.revision,
      actor: "migration-integrity-test",
      idempotencyKey: "overlay-integrity-run",
      input: { summary: "Create a real V2 Run", references: [] },
      authorization: {
        approvedBy: "test-approver",
        approvedAt: "2026-09-25T13:00:00.000Z",
        scope: "one Task",
        evidenceRef: "approval.json",
      },
    };
    startTaskRun(request);
    const overlayDir = legacyTaskMigrationOverlayPath(root, taskDir);
    if (!overlayDir) throw new Error("missing migration overlay path");
    const overlayKernelPath = path.join(overlayDir, "kernel.json");
    const validBytes = fs.readFileSync(overlayKernelPath);
    fs.writeFileSync(overlayKernelPath, Buffer.concat([validBytes, Buffer.from(" ")]));

    expect(() => readTaskKernel({ root, taskDir, cwd: root })).toThrow(
      /overlay hash-mismatch/,
    );
    expect(() => listTaskKernelSnapshots(root)).toThrow(/overlay hash-mismatch/);
    const errorOutput: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((message) => {
      errorOutput.push(String(message));
    });
    expect(runTaskCli(["show", path.basename(taskDir)], root)).toBe(1);
    expect(runTaskCli(["list"], root)).toBe(1);
    expect(runContextCli(["--mode", "record", "--json"], root)).toBe(1);
    expect(runContextCli(["--mode", "lite", "--json"], root)).toBe(1);
    expect(runContextCli(["--mode", "session", "--json"], root)).toBe(1);
    expect(errorOutput.join("\n")).toMatch(/overlay hash-mismatch/);
    expect(() => startTaskRun(request)).toThrow(/overlay hash-mismatch/);

    fs.rmSync(overlayDir, { recursive: true, force: true });
    expect(() => readTaskKernel({ root, taskDir, cwd: root })).toThrow(
      /overlay kernel-missing/,
    );
    expect(() => startTaskRun(request)).toThrow(/overlay kernel-missing/);
    expect(() => listTaskKernelSnapshots(root)).toThrow(/overlay kernel-missing/);
    expect(runContextCli(["--mode", "record", "--json"], root)).toBe(1);
    expect(runContextCli(["--mode", "lite", "--json"], root)).toBe(1);
    expect(runContextCli(["--mode", "session", "--json"], root)).toBe(1);
    expect(errorOutput.join("\n")).toMatch(/overlay kernel-missing/);
    errorSpy.mockRestore();
  });

  it("shows needs-definition and needs-coordination as selected, visible, and non-runnable", async () => {
    const root = makeRoot();
    addLegacyTask(root, {
      id: "needs-definition-task",
      directory: "01-needs-definition",
      deliveryLevel: "TBD",
      prd: prd("TBD"),
    });
    addLegacyTask(root, {
      id: "needs-coordination-task",
      directory: "02-needs-coordination",
      dependsOn: ["missing-block-target"],
      dependsMode: "block",
      prd: prd(),
    });
    const { imported } = await commitImport(root);
    expect(imported).toMatchObject({ needsDefinition: 1, needsCoordination: 1 });
    vi.stubEnv("PACTILE_CONTEXT_ID", "codex_legacy_reconciliation");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const [directory, status] of [
        ["01-needs-definition", "needs-definition"],
        ["02-needs-coordination", "needs-coordination"],
      ] as const) {
        expect(runTaskCli(["select", directory], root)).toBe(0);
        expect(runTaskCli(["selected", "--json"], root)).toBe(0);
        expect(JSON.parse(String(logSpy.mock.lastCall?.[0]))).toMatchObject({
          migrationStatus: status,
          runnable: false,
          kernelVersion: null,
        });

        expect(runContextCli(["--mode", "record", "--json"], root)).toBe(0);
        expect(JSON.parse(String(logSpy.mock.lastCall?.[0])).selectedTask).toMatchObject({
          status,
          migrationStatus: status,
          runnable: false,
          kernelVersion: null,
        });

        expect(runContextCli(["--mode", "lite", "--json"], root)).toBe(0);
        expect(JSON.parse(String(logSpy.mock.lastCall?.[0]))).toMatchObject({
          phase: "define",
          migrationStatus: status,
          runnable: false,
        });
        expect(String(logSpy.mock.lastCall?.[0])).toContain(
          "V2 Run is unavailable until reconciliation",
        );

        expect(runContextCli(["--mode", "session", "--json"], root)).toBe(0);
        expect(JSON.parse(String(logSpy.mock.lastCall?.[0])).kernel).toMatchObject({
          phase: "define",
          migrationStatus: status,
          runnable: false,
          schemaVersion: 0,
        });
        expect(String(logSpy.mock.lastCall?.[0])).toContain(
          "before any V2 Run",
        );

        expect(runContextCli([], root)).toBe(0);
        expect(String(logSpy.mock.lastCall?.[0])).toContain(`(${status})`);
      }
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("maps only explicit block edges and never treats a completed legacy record as a completed V2 dependency", async () => {
    const root = makeRoot();
    const prerequisite = addLegacyTask(root, {
      id: "legacy-prerequisite",
      directory: "01-prerequisite",
      status: "completed",
      kernel: `${JSON.stringify({ schemaVersion: 1, identity: { taskId: "legacy-prerequisite" }, phase: "close", outcome: "completed" })}\n`,
      prd: prd(),
    });
    const dependent = addLegacyTask(root, {
      id: "legacy-dependent",
      directory: "02-dependent",
      dependsOn: ["legacy-prerequisite"],
      metaDependsMode: "block",
      prd: prd(),
      extra: { user_extension: { keep: ["the", "source"] } },
    });
    const sourceTaskBytes = fs.readFileSync(path.join(dependent, "task.json"));
    const sourceKernelBytes = fs.readFileSync(
      path.join(prerequisite, "kernel.json"),
    );
    const { imported, result } = await commitImport(root);

    expect(imported).toMatchObject({
      imported: 2,
      needsDefinition: 0,
      needsCoordination: 0,
    });
    const prerequisiteKernel = v2At(root, prerequisite);
    const dependentKernel = v2At(root, dependent);
    expect(prerequisiteKernel).toMatchObject({
      phase: "define",
      outcome: null,
      runs: [],
      reviews: [],
      closure: null,
    });
    expect(dependentKernel.definition.dependencies).toEqual([
      "legacy-prerequisite",
    ]);
    expect(dependentKernel.reviews).toEqual([]);
    expect(dependentKernel.closure).toBeNull();
    expect(
      fs
        .readFileSync(path.join(dependent, "task.json"))
        .equals(sourceTaskBytes),
    ).toBe(true);
    expect(
      fs
        .readFileSync(path.join(prerequisite, "kernel.json"))
        .equals(sourceKernelBytes),
    ).toBe(true);
    expect(() =>
      startTaskRun({
        root,
        taskDir: dependent,
        expectedRevision: dependentKernel.revision,
        actor: "runner",
        idempotencyKey: "start-before-dependency-close",
        input: { summary: "Run the task" },
        authorization: {
          approvedBy: "approver",
          approvedAt: "2026-09-25T13:00:00.000Z",
          scope: "one task",
          evidenceRef: "approval.json",
        },
      }),
    ).toThrow(
      /hard dependencies must be closed successfully: legacy-prerequisite/,
    );
    startTaskRun({
      root,
      taskDir: prerequisite,
      expectedRevision: prerequisiteKernel.revision,
      actor: "runner",
      idempotencyKey: "start-prerequisite-v2-run",
      input: { summary: "Start a new V2 Run", references: [] },
      authorization: {
        approvedBy: "approver",
        approvedAt: "2026-09-25T13:00:00.000Z",
        scope: "one task",
        evidenceRef: "approval.json",
      },
    });
    expect(v2At(root, prerequisite).runs).toHaveLength(1);
    const overlayPath = legacyTaskMigrationOverlayPath(root, prerequisite);
    if (!overlayPath) throw new Error("missing migration overlay path");
    expect(
      fs.existsSync(
        path.join(overlayPath, "kernel.json"),
      ),
    ).toBe(true);
    expect(
      fs
        .readFileSync(path.join(dependent, "task.json"))
        .equals(sourceTaskBytes),
    ).toBe(true);
    expect(
      fs
        .readFileSync(path.join(prerequisite, "kernel.json"))
        .equals(sourceKernelBytes),
    ).toBe(true);

    const backedUpTask = path.join(
      root,
      ".pactile",
      "runtime",
      "legacy-task-migrations",
      "sources",
      result.sourceFingerprint.slice("sha256:".length),
      "files",
      ".pactile",
      "tasks",
      "02-dependent",
      "task.json",
    );
    expect(fs.readFileSync(backedUpTask).equals(sourceTaskBytes)).toBe(true);
  });

  it("keeps warn/off pool and dangling references advisory while retaining their source facts", () => {
    const root = makeRoot();
    addLegacyTask(root, {
      id: "warn-task",
      directory: "01-warn",
      dependsOn: ["pool:reviewers", "missing-warning-target"],
      metaDependsMode: "warn",
      prd: prd(),
    });
    addLegacyTask(root, {
      id: "off-task",
      directory: "02-off",
      dependsOn: ["pool:disabled", "missing-disabled-target"],
      dependsMode: "off",
      prd: prd(),
    });
    const { plan, imported } = importPlan(root);
    expect(plan.preflight.status).toBe("clear-to-review");
    expect(imported).toMatchObject({
      imported: 2,
      needsCoordination: 0,
      needsDefinition: 0,
    });
    for (const directory of ["01-warn", "02-off"]) {
      const kernelTarget = requiredTarget(
        imported.targets,
        `.pactile/tasks/${directory}/kernel.json`,
      );
      const kernel = JSON.parse(kernelTarget.bytes.toString("utf8")) as {
        definition: { dependencies: string[] };
      };
      expect(kernel.definition.dependencies).toEqual([]);
    }
    const warnRecordTarget = requiredTarget(
      imported.targets,
      ".pactile/tasks/01-warn/legacy-import.json",
    );
    const warnRecord = JSON.parse(warnRecordTarget.bytes.toString("utf8")) as {
      dependencyFacts: { diagnostics: string[] };
    };
    expect(warnRecord).toMatchObject({
      dependencyFacts: {
        taskJsonDependsOn: {
          value: ["pool:reviewers", "missing-warning-target"],
        },
        metaDependsMode: { value: "warn" },
      },
    });
    expect(warnRecord.dependencyFacts.diagnostics.join(" ")).toContain(
      "warn-pool-reference:pool:reviewers",
    );
    expect(warnRecord.dependencyFacts.diagnostics.join(" ")).toContain(
      "warn-dangling-reference:missing-warning-target",
    );
  });

  it("holds block pool, dangling, ambiguous, and cyclic edges for explicit coordination", () => {
    const root = makeRoot();
    addLegacyTask(root, {
      id: "pool-block",
      directory: "01-pool",
      dependsOn: ["pool:reviewers"],
      dependsMode: "block",
      prd: prd(),
    });
    addLegacyTask(root, {
      id: "dangling-block",
      directory: "02-dangling",
      dependsOn: ["missing-block-target"],
      dependsMode: "block",
      prd: prd(),
    });
    addLegacyTask(root, {
      id: "ambiguous-block",
      directory: "03-ambiguous",
      dependsOn: ["04-alias"],
      dependsMode: "block",
      prd: prd(),
    });
    addLegacyTask(root, {
      id: "directory-target",
      directory: "04-alias",
      prd: prd(),
    });
    addLegacyTask(root, { id: "04-alias", directory: "04-other", prd: prd() });
    addLegacyTask(root, {
      id: "cycle-a",
      directory: "05-cycle-a",
      dependsOn: ["cycle-b"],
      dependsMode: "block",
      prd: prd(),
    });
    addLegacyTask(root, {
      id: "cycle-b",
      directory: "06-cycle-b",
      dependsOn: ["cycle-a"],
      dependsMode: "block",
      prd: prd(),
    });
    const { plan, imported } = importPlan(root);
    expect(plan.preflight.status).toBe("clear-to-review");
    expect(imported).toMatchObject({
      imported: 2,
      needsCoordination: 5,
      needsDefinition: 0,
    });
    for (const directory of [
      "01-pool",
      "02-dangling",
      "03-ambiguous",
      "05-cycle-a",
      "06-cycle-b",
    ]) {
      const recordTarget = imported.targets.find(
        (target) =>
          target.path === `.pactile/tasks/${directory}/legacy-import.json`,
      );
      expect(recordTarget).toBeDefined();
    }
    for (const directory of [
      "01-pool",
      "02-dangling",
      "03-ambiguous",
      "05-cycle-a",
      "06-cycle-b",
    ]) {
      expect(
        imported.targets.some(
          (target) => target.path === `.pactile/tasks/${directory}/kernel.json`,
        ),
      ).toBe(false);
    }
    const ambiguous = JSON.parse(
      requiredTarget(
        imported.targets,
        ".pactile/tasks/03-ambiguous/legacy-import.json",
      ).bytes.toString("utf8"),
    ) as { coordinationReasons: string[] };
    expect(ambiguous.coordinationReasons.join(" ")).toContain(
      "ambiguous-reference:04-alias",
    );
  });

  it("uses an explicit Child row in Parent Task Map only when that Child declares block", () => {
    const root = makeRoot();
    const parent = addLegacyTask(root, {
      id: "legacy-parent",
      directory: "01-parent",
      prd: prd(),
    });
    const child = addLegacyTask(root, {
      id: "legacy-child",
      directory: "02-child",
      metaDependsMode: "block",
      prd: prd(),
    });
    addLegacyTask(root, {
      id: "legacy-prerequisite",
      directory: "03-prerequisite",
      prd: prd(),
    });
    fs.writeFileSync(
      path.join(parent, "task-map.md"),
      `---\nparent_id: legacy-parent\nchildren:\n  - id: legacy-child\n    state: review\n    depends_on: [legacy-prerequisite]\n---\n\n## Event Log\n\n- Historical state event.\n`,
      "utf8",
    );

    const { imported } = importPlan(root);
    expect(imported.needsCoordination).toBe(0);
    expect(
      imported.targets.find(
        (target) => target.path === ".pactile/tasks/02-child/kernel.json",
      ),
    ).toBeDefined();
    const childKernel = JSON.parse(
      requiredTarget(
        imported.targets,
        ".pactile/tasks/02-child/kernel.json",
      ).bytes.toString("utf8"),
    ) as {
      definition: { dependencies: string[] };
    };
    expect(childKernel.definition.dependencies).toEqual([
      "legacy-prerequisite",
    ]);
    expect(
      imported.targets.find(
        (target) => target.path === ".pactile/tasks/01-parent/kernel.json",
      ),
    ).toBeDefined();
    expect(fs.existsSync(path.join(child, "kernel.json"))).toBe(false);
  });

  it("holds an explicitly blocking Task Map edge when its reference list cannot be parsed", () => {
    const root = makeRoot();
    const parent = addLegacyTask(root, {
      id: "map-parent",
      directory: "01-parent",
      dependsMode: "block",
      prd: prd(),
    });
    addLegacyTask(root, {
      id: "map-child",
      directory: "02-child",
      metaDependsMode: "block",
      prd: prd(),
    });
    fs.writeFileSync(
      path.join(parent, "task-map.md"),
      `---\nparent_id: map-parent\ndepends_on: [unclosed\nchildren:\n  - id: map-child\n    depends_on: [also-unclosed\n---\n`,
      "utf8",
    );
    const { imported } = importPlan(root);
    expect(imported.needsCoordination).toBe(2);
    expect(
      imported.targets.some(
        (target) => target.path === ".pactile/tasks/01-parent/kernel.json",
      ),
    ).toBe(false);
    expect(
      imported.targets.some(
        (target) => target.path === ".pactile/tasks/02-child/kernel.json",
      ),
    ).toBe(false);
    expect(
      JSON.parse(
        requiredTarget(
          imported.targets,
          ".pactile/tasks/01-parent/legacy-import.json",
        ).bytes.toString("utf8"),
      ),
    ).toMatchObject({
      status: "needs-coordination",
      coordinationReasons: [
        "task-map-top-level-dependency-frontmatter-unparsed",
      ],
    });
    expect(
      JSON.parse(
        requiredTarget(
          imported.targets,
          ".pactile/tasks/02-child/legacy-import.json",
        ).bytes.toString("utf8"),
      ),
    ).toMatchObject({
      status: "needs-coordination",
      coordinationReasons: ["task-map-dependency-frontmatter-unparsed"],
    });
  });

  it("imports only explicit non-TBD PRD Acceptance Criteria and leaves incomplete Tasks non-runnable", () => {
    const root = makeRoot();
    addLegacyTask(root, {
      id: "criteria-task",
      directory: "01-criteria",
      prd: prd("The exact source criterion remains readable after import."),
    });
    addLegacyTask(root, {
      id: "json-only-ac",
      directory: "02-json-only-ac",
      rawAcceptanceCriteria: [
        "A JSON field alone is not an Acceptance Criteria section.",
      ],
    });
    addLegacyTask(root, {
      id: "tbd-ac",
      directory: "03-tbd-ac",
      prd: prd("TBD"),
    });
    addLegacyTask(root, {
      id: "missing-delivery",
      directory: "04-missing-delivery",
      deliveryLevel: "TBD",
      prd: prd(),
    });
    const { imported, plan } = importPlan(root);
    expect(plan.preflight.status).toBe("clear-to-review");
    expect(imported).toMatchObject({
      imported: 1,
      needsDefinition: 3,
      needsCoordination: 0,
    });

    const criteriaKernelTarget = requiredTarget(
      imported.targets,
      ".pactile/tasks/01-criteria/kernel.json",
    );
    const criteriaKernel = JSON.parse(
      criteriaKernelTarget.bytes.toString("utf8"),
    ) as {
      phase: string;
      outcome: string | null;
      definition: { acceptanceCriteria: { description: string }[] };
      runs: unknown[];
      reviews: unknown[];
      closure: unknown;
    };
    expect(criteriaKernel.definition.acceptanceCriteria).toHaveLength(1);
    expect(criteriaKernel.definition.acceptanceCriteria[0]?.description).toBe(
      "The exact source criterion remains readable after import.",
    );
    expect(criteriaKernel).toMatchObject({
      phase: "define",
      outcome: null,
      runs: [],
      reviews: [],
      closure: null,
    });
    for (const directory of [
      "02-json-only-ac",
      "03-tbd-ac",
      "04-missing-delivery",
    ]) {
      const recordTarget = imported.targets.find(
        (target) =>
          target.path === `.pactile/tasks/${directory}/legacy-import.json`,
      );
      expect(recordTarget).toBeDefined();
      expect(
        imported.targets.some(
          (target) => target.path === `.pactile/tasks/${directory}/kernel.json`,
        ),
      ).toBe(false);
    }
  });

  it("blocks the entire source set for a damaged legacy Kernel before preparing any V2 target", () => {
    const root = makeRoot();
    addLegacyTask(root, {
      id: "valid-task",
      directory: "01-valid",
      prd: prd(),
    });
    addLegacyTask(root, {
      id: "damaged-task",
      directory: "02-damaged",
      prd: prd(),
      kernel: "{ broken legacy kernel\n",
    });
    const { plan, imported } = importPlan(root);
    expect(plan.preflight.status).toBe("blocked");
    expect(
      plan.findings.some((finding) => finding.code === "invalid-kernel-json"),
    ).toBe(true);
    expect(imported.targets).toEqual([]);
    expect(
      fs.existsSync(
        path.join(root, ".pactile", "runtime", "legacy-task-migrations"),
      ),
    ).toBe(false);
  });

  it("preserves a tagged v0.5.0 writer-generated Task byte-for-byte as needs-definition", async () => {
    const provenance = JSON.parse(
      fs.readFileSync(RELEASE_WRITER_PROVENANCE, "utf8"),
    ) as {
      provenance: { ref: string; commit: string; kind: string };
      files: { path: string; sha256: string }[];
    };
    expect(provenance.provenance).toMatchObject({
      kind: "release-writer-generated",
      ref: "pactile-v0.5.0",
      commit: "ad98139610b71822c23293894aabb3e99d149bdd",
    });
    for (const file of provenance.files) {
      const source = fs.readFileSync(
        path.join(RELEASE_WRITER_FIXTURE_ROOT, ...file.path.split("/")),
      );
      const actualHash = createHash("sha256").update(source).digest("hex");
      expect(actualHash).toBe(file.sha256);
    }

    const root = makeRoot();
    fs.cpSync(RELEASE_WRITER_FIXTURE_ROOT, root, { recursive: true });
    const taskDir = path.join(
      root,
      ".pactile",
      "tasks",
      "09-26-v050-migration-sample",
    );
    const sourceBytes = new Map(
      fs
        .readdirSync(taskDir)
        .map((name) => [name, fs.readFileSync(path.join(taskDir, name))]),
    );
    const plan = scanLegacyTaskMigration({ projectRoot: root });
    const imported = buildLegacyTaskV2Import(plan);
    expect(plan.preflight.status).toBe("clear-to-review");
    expect(imported).toMatchObject({
      imported: 0,
      needsDefinition: 1,
      needsCoordination: 0,
    });
    expect(
      imported.targets.some(
        (target) =>
          target.path ===
          ".pactile/tasks/09-26-v050-migration-sample/kernel.json",
      ),
    ).toBe(false);
    const result = await runLegacyTaskBatch(
      { projectRoot: root, plan, targets: imported.targets },
      { approved: true },
    );
    expect(result.status).toBe("completed");
    if (result.status !== "completed")
      throw new Error("tagged fixture import did not commit");

    for (const [name, bytes] of sourceBytes) {
      const actual = fs.readFileSync(path.join(taskDir, name));
      expect(actual.equals(bytes)).toBe(true);
      const backupPath = path.join(
        root,
        ".pactile",
        "runtime",
        "legacy-task-migrations",
        "sources",
        result.sourceFingerprint.slice("sha256:".length),
        "files",
        ".pactile",
        "tasks",
        "09-26-v050-migration-sample",
        name,
      );
      expect(fs.readFileSync(backupPath).equals(bytes)).toBe(true);
    }
    const recordPath = path.join(
      root,
      ".pactile",
      "runtime",
      "legacy-task-migrations",
      "generations",
      result.generationId,
      "files",
      ".pactile",
      "tasks",
      "09-26-v050-migration-sample",
      "legacy-import.json",
    );
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as {
      status: string;
      missingDefinitionFields: string[];
    };
    expect(record).toMatchObject({
      status: "needs-definition",
      missingDefinitionFields: expect.arrayContaining([
        "deliverable",
        "deliveryLevel",
        "acceptanceCriteria",
      ]),
    });
    let kernelError: unknown;
    try {
      readTaskKernel({ root, taskDir, cwd: root });
    } catch (error) {
      kernelError = error;
    }
    expect(kernelError).toMatchObject({
      code: "LEGACY_TASK_REQUIRES_DEFINITION",
    });
  });
});
