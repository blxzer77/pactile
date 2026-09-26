import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runLegacyTaskCli } from "../../../src/commands/legacy-task.js";
import { buildLegacyTaskV2Import } from "../../../src/core/task/legacy-task-v2-import.js";
import { scanLegacyTaskMigration } from "../../../src/core/task/legacy-task-migration.js";
import {
  readLegacyTaskImportRecord,
  readLegacyTaskMigrationView,
} from "../../../src/core/task/legacy-task-migration-reader.js";
import {
  closeTaskKernel,
  createTaskKernel,
  listTaskKernelSnapshots,
  readTaskKernel,
  recordTaskReview,
  recordTaskRunResult,
  startTaskRun,
} from "../../../src/core/task/task-kernel.js";
import { planTaskKernelGraphV1 } from "../../../src/pactile/scheduler/index.js";
import { resolveTaskDirectoryById } from "../../../src/core/task/task-kernel-paths.js";
import { runLegacyTaskBatch } from "../../../src/pactile/migration/legacy-task-batch.js";
import { runLegacyTaskReconciliation } from "../../../src/pactile/migration/legacy-task-reconciliation.js";

const roots: string[] = [];
const FIXTURE_ROOT = fileURLToPath(
  new URL("../../fixtures/legacy-v050-task-source/input", import.meta.url),
);
const FIXTURE_PROVENANCE = fileURLToPath(
  new URL("../../fixtures/legacy-v050-task-source/provenance.json", import.meta.url),
);

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-p36-resume-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
  return root;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function addLegacyTask(root: string, options: {
  id: string;
  directory: string;
  status?: string;
  dependsOn?: unknown;
  dependsMode?: unknown;
  deliverable?: string;
  deliveryLevel?: string;
  criteria?: string;
}): string {
  const dir = path.join(root, ".pactile", "tasks", options.directory);
  writeJson(path.join(dir, "task.json"), {
    id: options.id,
    title: `Legacy ${options.id}`,
    description: `Original description ${options.id}`,
    status: options.status ?? "completed",
    createdAt: "2026-09-20T09:00:00.000Z",
    creator: "legacy-author",
    deliverable: options.deliverable ?? "A defined output for this legacy Task.",
    deliveryLevel: options.deliveryLevel ?? "local-result",
    ...(options.dependsOn !== undefined ? { depends_on: options.dependsOn } : {}),
    ...(options.dependsMode !== undefined ? { depends_mode: options.dependsMode } : {}),
    unknown_extension: { retain: ["original", "bytes"] },
  });
  fs.writeFileSync(
    path.join(dir, "prd.md"),
    `# ${options.id}\n\n## Acceptance Criteria\n\n- ${options.criteria ?? "The reviewable output contains the required result."}\n`,
    "utf8",
  );
  return dir;
}

function addArchivedTask(root: string, id: string): string {
  const dir = path.join(root, ".pactile", "tasks", "archive", "2026-09", id);
  writeJson(path.join(dir, "task.json"), {
    id,
    title: `Archived ${id}`,
    description: `Historical source for ${id}.`,
    status: "completed",
    createdAt: "2026-09-20T09:00:00.000Z",
    creator: "legacy-author",
    deliverable: "A preserved historical output.",
    deliveryLevel: "local-result",
  });
  fs.writeFileSync(path.join(dir, "prd.md"), `## Acceptance Criteria\n\n- The historical output remains available.\n`, "utf8");
  return dir;
}

function addV2Task(root: string, directory: string, id: string, dependencies: string[] = []): string {
  const dir = path.join(root, ".pactile", "tasks", directory);
  createTaskKernel({
    root,
    taskDir: dir,
    cwd: root,
    actor: "legacy-reconciliation-test",
    idempotencyKey: `create-${id}`,
    definition: {
      taskId: id,
      title: `Existing ${id}`,
      description: "Existing Task for reconciliation safety test.",
      deliverable: "An existing result.",
      deliveryLevel: "local-result",
      acceptanceCriteria: [{ id: "AC-1", description: "The existing Task remains unchanged." }],
      dependencies,
    },
  });
  return dir;
}

function closeV2Task(root: string, taskDir: string, id: string): void {
  const current = readTaskKernel({ root, taskDir, cwd: root });
  if (current.kind !== "task-kernel-v2") throw new Error("expected V2 prerequisite");
  const started = startTaskRun({
    root,
    taskDir,
    expectedRevision: current.kernel.revision,
    actor: "legacy-reconciliation-test-worker",
    idempotencyKey: `start-${id}`,
    input: { summary: "Complete the dependency prerequisite", references: [] },
    authorization: {
      approvedBy: "test-approver",
      approvedAt: "2026-09-26T15:00:00.000Z",
      scope: "test prerequisite",
      evidenceRef: `approval-${id}`,
    },
    writeSetSnapshot: ["result.txt"],
  });
  const runId = started.kernel.runs.at(-1)?.id;
  if (!runId) throw new Error("missing prerequisite Run");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(root, "result.txt"), `result for ${id}\n`, "utf8");
  const completed = recordTaskRunResult({
    root,
    taskDir,
    expectedRevision: started.kernel.revision,
    runId,
    outcome: "completed",
    summary: "Prerequisite result is ready",
    evidenceRefs: ["result.txt"],
    actor: "legacy-reconciliation-test-worker",
    idempotencyKey: `result-${id}`,
  });
  const candidate = completed.kernel.runs.at(-1)?.candidateSnapshot;
  if (!candidate) throw new Error("missing prerequisite candidate");
  const acceptanceCriterion = started.kernel.definition.acceptanceCriteria[0];
  if (!acceptanceCriterion) throw new Error("missing prerequisite acceptance criterion");
  fs.writeFileSync(path.join(taskDir, "review.txt"), "Pass review.\n", "utf8");
  const reviewed = recordTaskReview({
    root,
    taskDir,
    expectedRevision: completed.kernel.revision,
    runId,
    candidateSnapshotId: candidate.id,
    candidateFingerprint: candidate.fingerprint,
    reviewer: "legacy-reconciliation-test-reviewer",
    decision: "pass",
    evidenceRefs: ["review.txt"],
    acceptanceEvidence: { [acceptanceCriterion.id]: ["result.txt"] },
    actor: "legacy-reconciliation-test-reviewer",
    idempotencyKey: `review-${id}`,
  });
  const review = reviewed.kernel.reviews.at(-1);
  if (!review) throw new Error("missing prerequisite Review");
  closeTaskKernel({
    root,
    taskDir,
    expectedRevision: reviewed.kernel.revision,
    runId,
    reviewId: review.id,
    candidateObservation: {
      snapshotId: candidate.id,
      fingerprint: candidate.fingerprint,
      observedBy: "legacy-reconciliation-test-closer",
      observedAt: "2026-09-26T15:10:00.000Z",
      source: "caller-attested",
      evidenceRef: "result.txt",
    },
    deliveryEvidence: {
      level: "local-result",
      reference: "result.txt",
      summary: "The prerequisite result is present.",
    },
    actor: "legacy-reconciliation-test-closer",
    idempotencyKey: `close-${id}`,
  });
}

async function importRoot(root: string) {
  const plan = scanLegacyTaskMigration({ projectRoot: root });
  const imported = buildLegacyTaskV2Import(plan);
  const result = await runLegacyTaskBatch(
    { projectRoot: root, plan, targets: imported.targets },
    { approved: true },
  );
  expect(result.status).toBe("completed");
  return { plan, imported, result };
}

function fixtureRoot(): { root: string; taskDir: string; bytes: Map<string, Buffer> } {
  const root = makeRoot();
  fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
  const taskDir = path.join(root, ".pactile", "tasks", "09-26-v050-migration-sample");
  const bytes = new Map(fs.readdirSync(taskDir).map((name) => [name, fs.readFileSync(path.join(taskDir, name))]));
  return { root, taskDir, bytes };
}

function fixtureRequest(root: string) {
  return {
    projectRoot: root,
    plan: scanLegacyTaskMigration({ projectRoot: root }),
    input: {
      taskPath: "09-26-v050-migration-sample",
      idempotencyKey: "v050-define-once",
      activationAt: "2026-09-26T10:00:00.000Z",
      definition: {
        deliverable: "A reviewed migration result with preserved v0.5.0 source evidence.",
        deliveryLevel: "local-result",
        acceptanceCriteria: [
          "The imported Task retains the original source bytes.",
          "The new V2 Task stays in Define with no historical Run or Review.",
        ],
      },
      dependencyResolutions: [],
    },
  } as const;
}

function sourceHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectKernelCode(action: () => unknown, code: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("P36 explicit legacy Task reconciliation", () => {
  it("activates a tagged v0.5.0 needs-definition Task from explicit fields without creating lifecycle history", async () => {
    const provenance = JSON.parse(fs.readFileSync(FIXTURE_PROVENANCE, "utf8")) as {
      provenance: { kind: string; ref: string; commit: string };
      files: { path: string; sha256: string }[];
    };
    expect(provenance.provenance).toMatchObject({
      kind: "release-writer-generated",
      ref: "pactile-v0.5.0",
      commit: "ad98139610b71822c23293894aabb3e99d149bdd",
    });
    const { root, taskDir, bytes } = fixtureRoot();
    await importRoot(root);
    expect(readLegacyTaskImportRecord(root, taskDir)?.status).toBe("needs-definition");
    expectKernelCode(() => readTaskKernel({ root, taskDir, cwd: root }), "LEGACY_TASK_REQUIRES_DEFINITION");

    const result = await runLegacyTaskReconciliation(fixtureRequest(root), { approved: true });
    expect(result).toMatchObject({ status: "completed", wrote: true, visible: true, resumed: false });
    const active = readTaskKernel({ root, taskDir, cwd: root });
    expect(active.kind).toBe("task-kernel-v2");
    if (active.kind !== "task-kernel-v2") throw new Error("expected active V2 Task");
    expect(active.kernel).toMatchObject({
      phase: "define",
      outcome: null,
      runs: [],
      reviews: [],
      closure: null,
      definition: {
        deliverable: "A reviewed migration result with preserved v0.5.0 source evidence.",
        deliveryLevel: "local-result",
        acceptanceCriteria: [
          { description: "The imported Task retains the original source bytes." },
          { description: "The new V2 Task stays in Define with no historical Run or Review." },
        ],
      },
    });
    expect(readLegacyTaskImportRecord(root, taskDir)).toMatchObject({
      status: "imported",
      historicalStatus: { present: true, value: "planning" },
      reconciliation: {
        kind: "explicit-legacy-task-reconciliation",
        idempotencyKey: "v050-define-once",
        historyPolicy: "legacy-lifecycle-remains-source-only",
      },
    });

    const activeSourceFingerprint = scanLegacyTaskMigration({ projectRoot: root }).sourceFingerprint;
    if (!activeSourceFingerprint) throw new Error("expected stable source fingerprint");
    for (const [name, original] of bytes) {
      expect(fs.readFileSync(path.join(taskDir, name))).toEqual(original);
      const backup = path.join(
        root,
        ".pactile",
        "runtime",
        "legacy-task-migrations",
        "sources",
        activeSourceFingerprint.slice("sha256:".length),
        "files",
        ".pactile",
        "tasks",
        "09-26-v050-migration-sample",
        name,
      );
      expect(fs.readFileSync(backup)).toEqual(original);
    }
    for (const file of provenance.files) {
      const source = fs.readFileSync(path.join(taskDir, path.basename(file.path)));
      expect(sourceHash(source)).toBe(file.sha256);
    }
    const retry = await runLegacyTaskReconciliation(fixtureRequest(root), { approved: true });
    expect(retry).toMatchObject({ status: "completed", wrote: false, visible: true, resumed: true });
  });

  it("keeps an archived source held when restore targets are occupied, then restores into a free target with one active ID", async () => {
    const root = makeRoot();
    const archivedDir = addArchivedTask(root, "archive-restore-id");
    const archivedBefore = new Map(fs.readdirSync(archivedDir).map((name) => [name, fs.readFileSync(path.join(archivedDir, name))]));
    await importRoot(root);

    const existingDir = addV2Task(root, "09-26-existing-v2", "existing-v2");
    const existingKernel = fs.readFileSync(path.join(existingDir, "kernel.json"));
    const request = (targetTaskPath: string, idempotencyKey: string) => ({
      projectRoot: root,
      plan: scanLegacyTaskMigration({ projectRoot: root }),
      input: {
        taskPath: "archive/2026-09/archive-restore-id",
        targetTaskPath,
        idempotencyKey,
        activationAt: "2026-09-26T14:00:00.000Z",
      },
    });
    const occupied = await runLegacyTaskReconciliation(request("09-26-existing-v2", "occupied-target-once"), { approved: true });
    expect(occupied).toMatchObject({
      status: "blocked",
      reason: "legacy-task-reconciliation-target-occupied",
      wrote: false,
      visible: false,
    });
    expect(fs.readFileSync(path.join(existingDir, "kernel.json"))).toEqual(existingKernel);
    expect(fs.existsSync(path.join(root, ".pactile", "runtime", "legacy-task-migrations", "reconciliations", "authority.json"))).toBe(false);
    for (const [name, bytes] of archivedBefore) expect(fs.readFileSync(path.join(archivedDir, name))).toEqual(bytes);

    const restored = await runLegacyTaskReconciliation(request("09-27-restored-after-retry", "free-target-after-retry"), { approved: true });
    expect(restored).toMatchObject({ status: "completed", visible: true });
    const restoredDir = path.join(root, ".pactile", "tasks", "09-27-restored-after-retry");
    expect(resolveTaskDirectoryById(root, "archive-restore-id")).toBe(restoredDir);
    expect(readLegacyTaskImportRecord(root, archivedDir)?.status).toBe("archived-historical-only");
    expect(readTaskKernel({ root, taskDir: existingDir, cwd: root })).toMatchObject({
      kind: "task-kernel-v2", kernel: { identity: { taskId: "existing-v2" } },
    });
    for (const [name, bytes] of archivedBefore) expect(fs.readFileSync(path.join(archivedDir, name))).toEqual(bytes);
  });

  it("rejects an archive restore whose legacy ID is already owned by an independent V2 Task", async () => {
    const root = makeRoot();
    addV2Task(root, "01-existing-same-id", "archive-duplicate-id");
    const archivedDir = addArchivedTask(root, "archive-duplicate-id");
    const archivedBytes = new Map(fs.readdirSync(archivedDir).map((name) => [name, fs.readFileSync(path.join(archivedDir, name))]));
    await importRoot(root);
    const request = {
      projectRoot: root,
      plan: scanLegacyTaskMigration({ projectRoot: root }),
      input: {
        taskPath: "archive/2026-09/archive-duplicate-id",
        targetTaskPath: "09-26-free-target",
        idempotencyKey: "archive-duplicate-id-restore",
        activationAt: "2026-09-26T14:30:00.000Z",
      },
    };
    const result = await runLegacyTaskReconciliation(request, { approved: true });
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("Task ID already exists: archive-duplicate-id");
    expect(result).toMatchObject({ wrote: false, visible: false });
    expect(fs.existsSync(path.join(root, ".pactile", "tasks", "09-26-free-target"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".pactile", "runtime", "legacy-task-migrations", "reconciliations", "authority.json"))).toBe(false);
    for (const [name, bytes] of archivedBytes) expect(fs.readFileSync(path.join(archivedDir, name))).toEqual(bytes);
    expect(() => resolveTaskDirectoryById(root, "archive-duplicate-id")).toThrow(/ambiguous across active and archived records/u);
  });

  it("keeps an interrupted source held when a restore target is occupied, then retries without changing its bytes", async () => {
    const root = makeRoot();
    const existingDir = addV2Task(root, "01-existing-v2", "existing-v2");
    const existingKernel = fs.readFileSync(path.join(existingDir, "kernel.json"));
    const interruptedDir = addLegacyTask(root, {
      id: "interrupted-retry-id",
      directory: "08-23-interrupted-retry",
    });
    fs.writeFileSync(path.join(interruptedDir, "kernel.json"), "{ interrupted\n", "utf8");
    const interruptedBefore = new Map(fs.readdirSync(interruptedDir).map((name) => [name, fs.readFileSync(path.join(interruptedDir, name))]));
    await importRoot(root);

    const request = (targetTaskPath: string) => ({
      projectRoot: root,
      plan: scanLegacyTaskMigration({ projectRoot: root }),
      input: {
        taskPath: "08-23-interrupted-retry",
        targetTaskPath,
        idempotencyKey: "restore-interrupted-after-target-retry",
        activationAt: "2026-09-26T15:25:00.000Z",
        acknowledgeLegacyHistoryGap: true,
      },
    });
    const blocked = await runLegacyTaskReconciliation(request("01-existing-v2"), { approved: true });
    expect(blocked).toMatchObject({
      status: "blocked",
      reason: "legacy-task-reconciliation-target-occupied",
      wrote: false,
      visible: false,
    });
    expect(readLegacyTaskImportRecord(root, interruptedDir)?.status).toBe("needs-definition");
    expect(fs.readFileSync(path.join(existingDir, "kernel.json"))).toEqual(existingKernel);
    expect(fs.existsSync(path.join(root, ".pactile", "tasks", "09-26-existing-v2", "legacy-import.json"))).toBe(false);
    for (const [name, bytes] of interruptedBefore) expect(fs.readFileSync(path.join(interruptedDir, name))).toEqual(bytes);

    const recovered = await runLegacyTaskReconciliation(request("09-28-free-interrupted-retry"), { approved: true });
    expect(recovered).toMatchObject({ status: "completed", visible: true });
    const targetDir = path.join(root, ".pactile", "tasks", "09-28-free-interrupted-retry");
    expect(resolveTaskDirectoryById(root, "interrupted-retry-id")).toBe(targetDir);
    expect(readTaskKernel({ root, taskDir: targetDir, cwd: root })).toMatchObject({
      kind: "task-kernel-v2",
      kernel: { phase: "define", outcome: null, runs: [], reviews: [], closure: null },
    });
    for (const [name, bytes] of interruptedBefore) expect(fs.readFileSync(path.join(interruptedDir, name))).toEqual(bytes);
  });

  it("resolves restored IDs for explicit block dependencies only after Close and keeps scheduler gates intact", async () => {
    const root = makeRoot();
    const openPrerequisite = addV2Task(root, "01-open-v2-prerequisite", "open-v2-prerequisite");
    addArchivedTask(root, "archived-v2-prerequisite");
    const dependent = addLegacyTask(root, {
      id: "archive-dependent",
      directory: "02-archive-dependent",
      dependsOn: ["archive-reference"],
      dependsMode: "block",
    });
    addLegacyTask(root, {
      id: "open-dependent",
      directory: "03-open-dependent",
      dependsOn: ["open-reference"],
      dependsMode: "block",
    });
    await importRoot(root);

    const restoredDir = path.join(root, ".pactile", "tasks", "09-25-restored-prerequisite");
    const archiveRestore = await runLegacyTaskReconciliation({
      projectRoot: root,
      plan: scanLegacyTaskMigration({ projectRoot: root }),
      input: {
        taskPath: "archive/2026-09/archived-v2-prerequisite",
        targetTaskPath: "09-25-restored-prerequisite",
        idempotencyKey: "restore-prerequisite-once",
        activationAt: "2026-09-26T15:20:00.000Z",
      },
    }, { approved: true });
    expect(archiveRestore.status).toBe("completed");
    expect(resolveTaskDirectoryById(root, "archived-v2-prerequisite")).toBe(restoredDir);

    const scheduleDependent = addV2Task(root, "04-scheduler-dependent", "scheduler-dependent", ["archived-v2-prerequisite"]);
    const beforeCloseSchedule = planTaskKernelGraphV1(root, ["scheduler-dependent"]);
    expect(beforeCloseSchedule.plan.decisions.find((item) => item.taskId === "scheduler-dependent")?.action).toBe("blocked");

    const dependencyRequest = {
      projectRoot: root,
      plan: scanLegacyTaskMigration({ projectRoot: root }),
      input: {
        taskPath: "02-archive-dependent",
        idempotencyKey: "map-restored-archive-dependency",
        activationAt: "2026-09-26T15:30:00.000Z",
        dependencyResolutions: [{ reference: "archive-reference", taskId: "archived-v2-prerequisite" }],
      },
    };
    const heldUntilClose = await runLegacyTaskReconciliation(dependencyRequest, { approved: true });
    expect(heldUntilClose).toMatchObject({ status: "blocked", wrote: false, visible: false });
    expect(heldUntilClose.reason).toContain("dependency-target-not-closed:archived-v2-prerequisite");
    expect(readLegacyTaskImportRecord(root, dependent)?.status).toBe("needs-coordination");

    closeV2Task(root, restoredDir, "archived-v2-prerequisite");
    const closedSchedule = planTaskKernelGraphV1(root, ["scheduler-dependent"]);
    expect(closedSchedule.plan.decisions.find((item) => item.taskId === "scheduler-dependent")?.action).not.toBe("blocked");
    expect(readTaskKernel({ root, taskDir: scheduleDependent, cwd: root })).toMatchObject({
      kind: "task-kernel-v2", kernel: { definition: { dependencies: ["archived-v2-prerequisite"] } },
    });

    const reconciled = await runLegacyTaskReconciliation(dependencyRequest, { approved: true });
    expect(reconciled.status).toBe("completed");
    const dependentKernel = readTaskKernel({ root, taskDir: dependent, cwd: root });
    if (dependentKernel.kind !== "task-kernel-v2") throw new Error("expected reconciled dependent V2 Task");
    expect(dependentKernel.kernel.definition.dependencies).toEqual(["archived-v2-prerequisite"]);
    expect(planTaskKernelGraphV1(root, ["archive-dependent"]).plan.decisions.find((item) => item.taskId === "archive-dependent")?.action).not.toBe("blocked");

    const unresolvedV2 = readTaskKernel({ root, taskDir: openPrerequisite, cwd: root });
    expect(unresolvedV2).toMatchObject({ kind: "task-kernel-v2", kernel: { phase: "define" } });
    const openRequest = {
      projectRoot: root,
      plan: scanLegacyTaskMigration({ projectRoot: root }),
      input: {
        taskPath: "03-open-dependent",
        idempotencyKey: "refuse-open-v2-dependency",
        activationAt: "2026-09-26T15:40:00.000Z",
        dependencyResolutions: [{ reference: "open-reference", taskId: "open-v2-prerequisite" }],
      },
    };
    const openDependency = await runLegacyTaskReconciliation(openRequest, { approved: true });
    expect(openDependency).toMatchObject({ status: "blocked", wrote: false, visible: false });
    expect(openDependency.reason).toContain("dependency-target-not-closed:open-v2-prerequisite");
  });

  it("keeps dry-run, cancel, placeholder, source-field override, and bad delivery level at zero visible writes", async () => {
    const { root, taskDir } = fixtureRoot();
    await importRoot(root);
    const request = fixtureRequest(root);
    expect(await runLegacyTaskReconciliation(request, { dryRun: true, approved: true })).toMatchObject({ status: "dry-run", wrote: false, visible: false });
    expect(await runLegacyTaskReconciliation(request, { cancelled: true, approved: true })).toMatchObject({ status: "cancelled", wrote: false, visible: false });
    for (const invalid of [
      { ...request.input, definition: { ...request.input.definition, deliverable: "TBD" } },
      { ...request.input, definition: { ...request.input.definition, title: "Should not replace source title" } },
      { ...request.input, definition: { ...request.input.definition, deliveryLevel: "maybe" } },
      { ...request.input, definition: { ...request.input.definition, acceptanceCriteria: ["TODO"] } },
    ]) {
      const result = await runLegacyTaskReconciliation({ ...request, input: invalid }, { approved: true });
      expect(result.status).toBe("blocked");
      expect(result.visible).toBe(false);
    }
    expect(fs.existsSync(path.join(root, ".pactile", "runtime", "legacy-task-migrations", "reconciliations"))).toBe(false);
    expect(readLegacyTaskImportRecord(root, taskDir)?.status).toBe("needs-definition");
    expectKernelCode(() => readTaskKernel({ root, taskDir, cwd: root }), "LEGACY_TASK_REQUIRES_DEFINITION");
  });

  it("maps only a uniquely supplied block dependency and retains the hard Run gate", async () => {
    const root = makeRoot();
    const prerequisite = addLegacyTask(root, { id: "prerequisite", directory: "01-prerequisite" });
    const blocker = addLegacyTask(root, {
      id: "blocked-task",
      directory: "02-blocked",
      dependsOn: ["missing-target"],
      dependsMode: "block",
    });
    const advisory = addLegacyTask(root, {
      id: "advisory-task",
      directory: "03-advisory",
      dependsOn: ["missing-advisory"],
      dependsMode: "warn",
    });
    await importRoot(root);
    expect(readLegacyTaskImportRecord(root, blocker)?.status).toBe("needs-coordination");
    const result = await runLegacyTaskReconciliation({
      projectRoot: root,
      plan: scanLegacyTaskMigration({ projectRoot: root }),
      input: {
        taskPath: "02-blocked",
        idempotencyKey: "resolve-one-block-edge",
        activationAt: "2026-09-26T10:30:00.000Z",
        dependencyResolutions: [{ reference: "missing-target", taskId: "prerequisite" }],
      },
    }, { approved: true });
    expect(result.status).toBe("completed");
    const blockedRead = readTaskKernel({ root, taskDir: blocker, cwd: root });
    const advisoryRead = readTaskKernel({ root, taskDir: advisory, cwd: root });
    if (blockedRead.kind !== "task-kernel-v2" || advisoryRead.kind !== "task-kernel-v2")
      throw new Error("expected V2 kernels");
    expect(blockedRead.kernel.definition.dependencies).toEqual(["prerequisite"]);
    expect(advisoryRead.kernel.definition.dependencies).toEqual([]);
    const authorization = {
      approvedBy: "approver",
      approvedAt: "2026-09-26T10:35:00.000Z",
      scope: "one task",
      evidenceRef: "approval.json",
    };
    expect(() => startTaskRun({
      root,
      taskDir: blocker,
      expectedRevision: blockedRead.kernel.revision,
      actor: "runner",
      idempotencyKey: "must-wait-for-prerequisite-close",
      input: { summary: "Run the explicitly dependent Task", references: [] },
      authorization,
    })).toThrow(/hard dependencies must be closed successfully: prerequisite/);
    expect(readTaskKernel({ root, taskDir: prerequisite, cwd: root })).toMatchObject({
      kind: "task-kernel-v2",
      kernel: { phase: "define", runs: [], reviews: [], closure: null },
    });
  });

  it("keeps the reconciliation pointer separate from existing Run overlays", async () => {
    const root = makeRoot();
    const activeDir = addLegacyTask(root, { id: "already-active", directory: "01-active" });
    const heldDir = addLegacyTask(root, {
      id: "held-definition",
      directory: "02-held",
      deliverable: "TBD",
    });
    await importRoot(root);
    const active = readTaskKernel({ root, taskDir: activeDir, cwd: root });
    if (active.kind !== "task-kernel-v2") throw new Error("expected base V2 kernel");
    startTaskRun({
      root,
      taskDir: activeDir,
      expectedRevision: active.kernel.revision,
      actor: "runner",
      idempotencyKey: "create-existing-run",
      input: { summary: "Record a new V2 Run", references: [] },
      authorization: { approvedBy: "approver", approvedAt: "2026-09-26T11:00:00.000Z", scope: "one task", evidenceRef: "approval.json" },
    });
    const overlayRoot = path.join(root, ".pactile", "runtime", "legacy-task-migrations", "overrides", "01-active");
    const before = new Map(fs.readdirSync(overlayRoot).map((name) => [name, fs.readFileSync(path.join(overlayRoot, name))]));
    const result = await runLegacyTaskReconciliation({
      projectRoot: root,
      plan: scanLegacyTaskMigration({ projectRoot: root }),
      input: {
        taskPath: "02-held",
        idempotencyKey: "define-second-task",
        activationAt: "2026-09-26T11:30:00.000Z",
        definition: { deliverable: "A defined result" },
      },
    }, { approved: true });
    expect(result.status).toBe("completed");
    expect(readTaskKernel({ root, taskDir: heldDir, cwd: root }).kind).toBe("task-kernel-v2");
    for (const [name, bytes] of before) expect(fs.readFileSync(path.join(overlayRoot, name))).toEqual(bytes);
    expect(listTaskKernelSnapshots(root)).toHaveLength(2);
  });

  it("recovers the exact same staged request and refuses source drift", async () => {
    const { root, taskDir } = fixtureRoot();
    await importRoot(root);
    const request = fixtureRequest(root);
    const staged = await runLegacyTaskReconciliation(request, {
      approved: true,
      onPhase(phase) {
        if (phase === "generation-staged") throw new Error("simulated interruption before pointer");
      },
    });
    expect(staged).toMatchObject({ status: "blocked", wrote: true, visible: false });
    expect(() => readLegacyTaskMigrationView(root)).toThrow(/authority-missing-with-residual-state/);
    const recovered = await runLegacyTaskReconciliation(request, { approved: true });
    expect(recovered).toMatchObject({ status: "completed", resumed: true, visible: true });
    expect(readTaskKernel({ root, taskDir, cwd: root }).kind).toBe("task-kernel-v2");

    const { root: driftRoot, taskDir: driftDir } = fixtureRoot();
    await importRoot(driftRoot);
    const driftRequest = fixtureRequest(driftRoot);
    const interrupted = await runLegacyTaskReconciliation(driftRequest, {
      approved: true,
      onPhase(phase) {
        if (phase === "generation-staged") {
          fs.appendFileSync(path.join(driftDir, "prd.md"), "\nUser changed the source after preflight.\n");
        }
      },
    });
    expect(interrupted).toMatchObject({ status: "blocked", visible: false });
    expect(interrupted.reason).toContain("source-drift");
    expect(fs.existsSync(path.join(driftRoot, ".pactile", "runtime", "legacy-task-migrations", "reconciliations", "authority.json"))).toBe(false);
  });

  it("refuses held-task orphan recovery before authority write when another imported Task overlay is corrupt", async () => {
    const root = makeRoot();
    const activeDir = addLegacyTask(root, { id: "already-active", directory: "01-active" });
    const heldDir = addLegacyTask(root, {
      id: "held-definition",
      directory: "02-held",
      deliverable: "TBD",
    });
    await importRoot(root);
    const active = readTaskKernel({ root, taskDir: activeDir, cwd: root });
    if (active.kind !== "task-kernel-v2") throw new Error("expected imported active Kernel");
    startTaskRun({
      root,
      taskDir: activeDir,
      expectedRevision: active.kernel.revision,
      actor: "runner",
      idempotencyKey: "create-run-before-recovery",
      input: { summary: "Preserve the existing imported Task overlay", references: [] },
      authorization: { approvedBy: "approver", approvedAt: "2026-09-26T11:00:00.000Z", scope: "one task", evidenceRef: "approval.json" },
    });

    const request = {
      projectRoot: root,
      plan: scanLegacyTaskMigration({ projectRoot: root }),
      input: {
        taskPath: "02-held",
        idempotencyKey: "define-held-after-orphan",
        activationAt: "2026-09-26T11:30:00.000Z",
        definition: { deliverable: "A defined result" },
      },
    };
    const staged = await runLegacyTaskReconciliation(request, {
      approved: true,
      onPhase(phase) {
        if (phase === "generation-staged") throw new Error("simulated interruption before pointer");
      },
    });
    expect(staged).toMatchObject({ status: "blocked", wrote: true, visible: false });

    const overlayRoot = path.join(root, ".pactile", "runtime", "legacy-task-migrations", "overrides", "01-active");
    const overlayPath = path.join(overlayRoot, "kernel.json");
    const corruptOverlayBytes = Buffer.concat([fs.readFileSync(overlayPath), Buffer.from("\ncorrupt-overlay\n")]);
    fs.writeFileSync(overlayPath, corruptOverlayBytes);
    const heldSourceBytes = fs.readFileSync(path.join(heldDir, "task.json"));
    const recRoot = path.join(root, ".pactile", "runtime", "legacy-task-migrations", "reconciliations");
    const generationId = fs.readdirSync(path.join(recRoot, "generations"))[0];
    const journalName = fs.readdirSync(path.join(recRoot, "journals"))[0];
    if (!generationId || !journalName) throw new Error("expected the staged recovery request");
    const stagedManifest = fs.readFileSync(path.join(recRoot, "generations", generationId, "manifest.json"));
    const stagedJournal = fs.readFileSync(path.join(recRoot, "journals", journalName));

    const retry = await runLegacyTaskReconciliation(request, { approved: true });

    expect(retry).toMatchObject({ status: "blocked", wrote: false, visible: false });
    expect(retry.reason).toContain("overlay hash-mismatch");
    expect(fs.existsSync(path.join(recRoot, "authority.json"))).toBe(false);
    expect(() => readTaskKernel({ root, taskDir: heldDir, cwd: root })).toThrow(/authority-missing-with-residual-state/);
    expect(fs.readFileSync(path.join(heldDir, "task.json"))).toEqual(heldSourceBytes);
    expect(fs.readFileSync(overlayPath)).toEqual(corruptOverlayBytes);
    expect(fs.readFileSync(path.join(recRoot, "generations", generationId, "manifest.json"))).toEqual(stagedManifest);
    expect(fs.readFileSync(path.join(recRoot, "journals", journalName))).toEqual(stagedJournal);
  });

  it("rechecks existing imported overlays inside the authority CAS after staging", async () => {
    const root = makeRoot();
    const activeDir = addLegacyTask(root, { id: "already-active", directory: "01-active" });
    const heldDir = addLegacyTask(root, {
      id: "held-definition",
      directory: "02-held",
      deliverable: "TBD",
    });
    await importRoot(root);
    const active = readTaskKernel({ root, taskDir: activeDir, cwd: root });
    if (active.kind !== "task-kernel-v2") throw new Error("expected imported active Kernel");
    startTaskRun({
      root,
      taskDir: activeDir,
      expectedRevision: active.kernel.revision,
      actor: "runner",
      idempotencyKey: "create-run-before-commit-boundary",
      input: { summary: "Preserve the imported Task overlay", references: [] },
      authorization: { approvedBy: "approver", approvedAt: "2026-09-26T11:00:00.000Z", scope: "one task", evidenceRef: "approval.json" },
    });
    const overlayPath = path.join(root, ".pactile", "runtime", "legacy-task-migrations", "overrides", "01-active", "kernel.json");
    const heldSourceBytes = fs.readFileSync(path.join(heldDir, "task.json"));
    const request = {
      projectRoot: root,
      plan: scanLegacyTaskMigration({ projectRoot: root }),
      input: {
        taskPath: "02-held",
        idempotencyKey: "define-held-after-overlay-drift",
        activationAt: "2026-09-26T11:30:00.000Z",
        definition: { deliverable: "A defined result" },
      },
    };

    const result = await runLegacyTaskReconciliation(request, {
      approved: true,
      onPhase(phase) {
        if (phase !== "generation-staged") return;
        const current = fs.readFileSync(overlayPath);
        const tampered = Buffer.from(current);
        tampered[0] = tampered[0] === 0x7b ? 0x20 : 0x7b;
        fs.writeFileSync(overlayPath, tampered);
      },
    });

    const recRoot = path.join(root, ".pactile", "runtime", "legacy-task-migrations", "reconciliations");
    const journalName = fs.readdirSync(path.join(recRoot, "journals"))[0];
    if (!journalName) throw new Error("expected a staged reconciliation journal");
    const journal = JSON.parse(fs.readFileSync(path.join(recRoot, "journals", journalName), "utf8")) as { state: string };
    expect(result).toMatchObject({ status: "blocked", wrote: true, visible: false });
    expect(result.reason).toContain("overlay hash-mismatch");
    expect(fs.existsSync(path.join(recRoot, "authority.json"))).toBe(false);
    expect(journal.state).toBe("staged");
    expect(() => readTaskKernel({ root, taskDir: heldDir, cwd: root })).toThrow(/authority-missing-with-residual-state/);
    expect(fs.readFileSync(path.join(heldDir, "task.json"))).toEqual(heldSourceBytes);
  });

  it("fails closed if a committed reconciliation authority disappears", async () => {
    const { root, taskDir } = fixtureRoot();
    await importRoot(root);
    const request = fixtureRequest(root);
    const committed = await runLegacyTaskReconciliation(request, { approved: true });
    expect(committed.status).toBe("completed");
    const recRoot = path.join(root, ".pactile", "runtime", "legacy-task-migrations", "reconciliations");
    const authorityPath = path.join(recRoot, "authority.json");
    const generationBytes = fs.readFileSync(path.join(recRoot, "generations", (committed as { generationId: string }).generationId, "manifest.json"));
    fs.rmSync(authorityPath);
    expect(() => readTaskKernel({ root, taskDir, cwd: root })).toThrow(/authority-missing-with-residual-state/);
    const retry = await runLegacyTaskReconciliation(request, { approved: true });
    expect(retry.status).toBe("blocked");
    expect(retry.visible).toBe(false);
    expect(retry.reason).toContain("recovery-not-safe");
    expect(fs.existsSync(authorityPath)).toBe(false);
    expect(fs.readFileSync(path.join(recRoot, "generations", (committed as { generationId: string }).generationId, "manifest.json"))).toEqual(generationBytes);
  });

  it("refuses to recover an orphan whose journal reached the committing phase", async () => {
    const { root, taskDir, bytes } = fixtureRoot();
    await importRoot(root);
    const request = fixtureRequest(root);
    const staged = await runLegacyTaskReconciliation(request, {
      approved: true,
      onPhase(phase) {
        if (phase === "generation-staged") throw new Error("simulated interruption before authority CAS");
      },
    });
    expect(staged).toMatchObject({ status: "blocked", wrote: true, visible: false });
    const recRoot = path.join(root, ".pactile", "runtime", "legacy-task-migrations", "reconciliations");
    const journals = path.join(recRoot, "journals");
    const journalName = fs.readdirSync(journals)[0];
    if (!journalName) throw new Error("expected staged reconciliation journal");
    const journalPath = path.join(journals, journalName);
    const originalJournal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(journalPath, `${JSON.stringify({ ...originalJournal, state: "committing" }, null, 2)}\n`);
    const generationRoot = path.join(recRoot, "generations");
    const generationId = fs.readdirSync(generationRoot)[0];
    if (!generationId) throw new Error("expected staged reconciliation generation");
    const manifest = JSON.parse(fs.readFileSync(path.join(generationRoot, generationId, "manifest.json"), "utf8")) as {
      files: { path: string }[];
    };
    const stagedBytes = new Map(manifest.files.map((file) => [
      file.path,
      fs.readFileSync(path.join(generationRoot, generationId, "files", ...file.path.split("/"))),
    ]));

    const retry = await runLegacyTaskReconciliation(request, { approved: true });
    expect(retry.status).toBe("blocked");
    expect(retry.visible).toBe(false);
    expect(retry.reason).toContain("recovery-not-safe");
    expect(fs.existsSync(path.join(recRoot, "authority.json"))).toBe(false);
    for (const [name, original] of bytes) expect(fs.readFileSync(path.join(taskDir, name))).toEqual(original);
    for (const [name, original] of stagedBytes) expect(fs.readFileSync(path.join(generationRoot, generationId, "files", ...name.split("/")))).toEqual(original);
  });

  it("finishes a visible pointer's journal on retry and refuses to recreate a lost pointer", async () => {
    const { root, taskDir } = fixtureRoot();
    await importRoot(root);
    const request = fixtureRequest(root);
    const interrupted = await runLegacyTaskReconciliation(request, {
      approved: true,
      onPhase(phase) {
        if (phase === "authority-written") throw new Error("simulated interruption after pointer CAS");
      },
    });
    expect(interrupted).toMatchObject({ status: "interrupted", wrote: true, visible: true });
    expect(readTaskKernel({ root, taskDir, cwd: root }).kind).toBe("task-kernel-v2");
    const recRoot = path.join(root, ".pactile", "runtime", "legacy-task-migrations", "reconciliations");
    const journalPath = path.join(recRoot, "journals", fs.readdirSync(path.join(recRoot, "journals"))[0] ?? "");
    expect(JSON.parse(fs.readFileSync(journalPath, "utf8"))).toMatchObject({ state: "committing" });
    const resumed = await runLegacyTaskReconciliation(request, { approved: true });
    expect(resumed).toMatchObject({ status: "completed", wrote: true, visible: true, resumed: true });
    expect(JSON.parse(fs.readFileSync(journalPath, "utf8"))).toMatchObject({ state: "committed" });

    const { root: lostRoot, taskDir: lostTaskDir, bytes } = fixtureRoot();
    await importRoot(lostRoot);
    const lostRequest = fixtureRequest(lostRoot);
    const pointerWritten = await runLegacyTaskReconciliation(lostRequest, {
      approved: true,
      onPhase(phase) {
        if (phase === "authority-written") throw new Error("simulated process exit after pointer write");
      },
    });
    expect(pointerWritten).toMatchObject({ status: "interrupted", visible: true });
    const lostRecRoot = path.join(lostRoot, ".pactile", "runtime", "legacy-task-migrations", "reconciliations");
    const lostAuthorityPath = path.join(lostRecRoot, "authority.json");
    const generationName = fs.readdirSync(path.join(lostRecRoot, "generations"))[0];
    const journalName = fs.readdirSync(path.join(lostRecRoot, "journals"))[0];
    if (!generationName || !journalName) throw new Error("expected committed-path recovery evidence");
    const generationManifest = fs.readFileSync(path.join(lostRecRoot, "generations", generationName, "manifest.json"));
    const journalBytes = fs.readFileSync(path.join(lostRecRoot, "journals", journalName));
    fs.rmSync(lostAuthorityPath);
    expect(() => readTaskKernel({ root: lostRoot, taskDir: lostTaskDir, cwd: lostRoot })).toThrow(/authority-missing-with-residual-state/);
    const refused = await runLegacyTaskReconciliation(lostRequest, { approved: true });
    expect(refused.status).toBe("blocked");
    expect(refused.visible).toBe(false);
    expect(refused.reason).toContain("recovery-not-safe");
    expect(fs.existsSync(lostAuthorityPath)).toBe(false);
    expect(fs.readFileSync(path.join(lostRecRoot, "generations", generationName, "manifest.json"))).toEqual(generationManifest);
    expect(fs.readFileSync(path.join(lostRecRoot, "journals", journalName))).toEqual(journalBytes);
    for (const [name, original] of bytes) expect(fs.readFileSync(path.join(lostTaskDir, name))).toEqual(original);
  });

  it("exposes an explicit one-Task CLI activation and rejects ambiguous repeated options", async () => {
    const { root, taskDir } = fixtureRoot();
    await importRoot(root);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const args = [
      "reconcile",
      "09-26-v050-migration-sample",
      "--idempotency-key",
      "cli-define-once",
      "--activation-at",
      "2026-09-26T12:00:00.000Z",
      "--deliverable",
      "A user supplied migration output.",
      "--delivery-level",
      "local-result",
      "--accept",
      "The original source bytes remain available.",
      "--accept",
      "No historical Run, Review, or Close is created.",
      "--approved",
    ];
    expect(await runLegacyTaskCli(args, root)).toBe(0);
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
      status: "completed",
      visible: true,
      taskPath: ".pactile/tasks/09-26-v050-migration-sample",
    });
    expect(readTaskKernel({ root, taskDir, cwd: root }).kind).toBe("task-kernel-v2");
    const pointer = fs.readFileSync(path.join(root, ".pactile", "runtime", "legacy-task-migrations", "reconciliations", "authority.json"));
    expect(await runLegacyTaskCli([
      ...args.slice(0, 4),
      "--idempotency-key",
      "second-key",
      ...args.slice(4),
    ], root)).toBe(1);
    expect(fs.readFileSync(path.join(root, ".pactile", "runtime", "legacy-task-migrations", "reconciliations", "authority.json"))).toEqual(pointer);
    log.mockRestore();
    error.mockRestore();
  });

  it("shows archived bytes as historical-only and rejects traversal or symlinks", async () => {
    const root = makeRoot();
    const archived = path.join(root, ".pactile", "tasks", "archive", "2026-09", "closed-task");
    fs.mkdirSync(archived, { recursive: true });
    writeJson(path.join(archived, "task.json"), { id: "old-task", status: "completed" });
    writeJson(path.join(archived, "kernel.json"), { phase: "close", outcome: "completed" });
    fs.writeFileSync(path.join(archived, "verify.md"), "Historical verification evidence.\n", "utf8");
    const original = fs.readFileSync(path.join(archived, "verify.md"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runLegacyTaskCli(["history", "archive/2026-09/closed-task", "--json"], root)).toBe(0);
    const result = JSON.parse(String(log.mock.lastCall?.[0])) as { status: string; runnable: boolean; lifecyclePolicy: string; files: { path: string; sha256: string }[] };
    expect(result).toMatchObject({ status: "archived-historical-only", runnable: false, lifecyclePolicy: "source-only-no-v2-run-review-or-close" });
    expect(result.files.some((file) => file.path.endsWith("/verify.md"))).toBe(true);
    expect(await runLegacyTaskCli(["history", "archive/../closed-task"], root)).toBe(1);
    fs.writeFileSync(path.join(archived, "large.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));
    expect(await runLegacyTaskCli(["history", "archive/2026-09/closed-task"], root)).toBe(1);
    expect(fs.readFileSync(path.join(archived, "verify.md"))).toEqual(original);

    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    let symlinkAvailable = true;
    try {
      fs.symlinkSync(outside, path.join(root, ".pactile", "tasks", "archive", "link"), "junction");
    } catch {
      symlinkAvailable = false;
    }
    if (symlinkAvailable) expect(await runLegacyTaskCli(["history", "archive/link"], root)).toBe(1);
    log.mockRestore();
    error.mockRestore();
  });
});
