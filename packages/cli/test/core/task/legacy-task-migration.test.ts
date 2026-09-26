import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scanLegacyTaskMigration } from "../../../src/core/task/legacy-task-migration.js";

const FIXTURE_ROOT = fileURLToPath(
  new URL(
    "../../fixtures/pactile/p36-legacy-task-source/input",
    import.meta.url,
  ),
);

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("legacy Task source migration preflight", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-p36-legacy-scan-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("preserves v0.5-shaped Task, Kernel, task-map, and document source without writes", () => {
    const original = scanLegacyTaskMigration({ projectRoot: FIXTURE_ROOT });
    const repeated = scanLegacyTaskMigration({ projectRoot: FIXTURE_ROOT });

    expect(original.readOnly).toBe(true);
    expect(original.wrote).toBe(false);
    expect(original.migration).toEqual({
      status: "pending-v2-writer",
      targetWriter: "P35 Task/Run/Review",
      writesPlanned: false,
    });
    expect(original.preflight.status).toBe("clear-to-review");
    expect(original.findings).toContainEqual(
      expect.objectContaining({
        code: "invalid-kernel-json",
        severity: "warning",
        sourcePath: ".pactile/tasks/08-23-interrupted/kernel.json",
      }),
    );
    expect(original.sourceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(repeated.sourceFingerprint).toBe(original.sourceFingerprint);

    const parent = original.tasks.find(
      (task) => task.legacyTaskId.value === "parent-legacy",
    );
    expect(parent?.status.value).toBe("in_progress");
    expect(parent?.kernelJson?.value?.audit).toHaveLength(1);
    expect(parent?.taskMap?.content).toContain("## Event Log");
    expect(parent?.documents.map((file) => file.name)).toEqual(
      expect.arrayContaining([
        "prd.md",
        "verify.md",
        "design.md",
        "implement.md",
      ]),
    );
    expect(parent?.rawTaskData?.legacy_extension).toEqual({
      owner: "fixture",
      keep: true,
    });
    expect(parent?.unknownTaskFields.legacy_extension).toEqual({
      owner: "fixture",
      keep: true,
    });
    expect(parent?.unknownMetaFields.owner_annotation).toBe(
      "preserve-this-user-authored-meta",
    );

    const child = original.tasks.find(
      (task) => task.legacyTaskId.value === "child-legacy",
    );
    expect(child?.status.value).toBe("review");
    expect(child?.typeMarkers.meta.classification).toBe("full");
    expect(child?.dependencies.taskJsonDependsOn.value).toEqual([
      "prerequisite-legacy",
    ]);
    expect(child?.dependencies.metaDependsMode.value).toBe("block");
    expect(child?.dependencies.mappingDecision).toBe("deferred");
    expect(child?.rawTaskData?.execution_approval).toMatchObject({
      transition: "start-execution",
      approved_by: "user",
      approval_source: "task.py start-execution --approved",
    });
    expect(child?.rawTaskData?.quality_gate_results).toMatchObject({
      transitions: {
        "child-review": {
          "code-review": { result: "FAIL", reviewer: "tester" },
        },
      },
    });
    expect(child?.kernelJson?.value?.gates).toMatchObject({
      transitions: {
        "child-review": {
          "code-review": { result: "FAIL", reviewer: "tester" },
        },
      },
    });

    const archived = original.tasks.find(
      (task) => task.legacyTaskId.value === "closed-lite-legacy",
    );
    expect(archived?.archivedByPath).toBe(true);
    expect(archived?.status.value).toBe("completed");

    for (const task of original.tasks) {
      for (const source of task.files) {
        const diskBytes = fs.readFileSync(path.join(FIXTURE_ROOT, source.path));
        const plannedBytes =
          source.encoding === "utf8"
            ? Buffer.from(source.content, "utf8")
            : Buffer.from(source.content, "base64");
        expect(diskBytes.equals(plannedBytes)).toBe(true);
      }
    }
  });

  it("blocks duplicate legacy IDs and orphan source artifacts without repairing them", () => {
    const first = path.join(tmp, ".pactile", "tasks", "01-01-first");
    const second = path.join(tmp, ".pactile", "tasks", "01-02-second");
    const orphan = path.join(tmp, ".pactile", "tasks", "01-03-orphan");
    writeJson(path.join(first, "task.json"), {
      id: "duplicate",
      status: "planning",
    });
    writeJson(path.join(second, "task.json"), {
      id: "duplicate",
      status: "planning",
    });
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(
      path.join(orphan, "prd.md"),
      "orphan user document\n",
      "utf8",
    );

    const before = fs
      .readdirSync(path.join(tmp, ".pactile", "tasks"), {
        withFileTypes: true,
      })
      .map((entry) => entry.name);
    const plan = scanLegacyTaskMigration({ projectRoot: tmp });

    expect(plan.wrote).toBe(false);
    expect(plan.preflight.status).toBe("blocked");
    expect(
      plan.findings.filter((item) => item.code === "duplicate-task-id"),
    ).toHaveLength(2);
    expect(plan.findings).toContainEqual(
      expect.objectContaining({
        code: "orphan-task-artifacts",
        severity: "blocker",
      }),
    );
    expect(
      fs
        .readdirSync(path.join(tmp, ".pactile", "tasks"), {
          withFileTypes: true,
        })
        .map((entry) => entry.name),
    ).toEqual(before);
    expect(fs.existsSync(path.join(orphan, "task.json"))).toBe(false);
  });

  it.each(["design.md", "implement.md", "handoff.md"])(
    "fails closed when %s is the only file in an orphan source directory",
    (name) => {
      const orphan = path.join(tmp, ".pactile", "tasks", `orphan-${name}`);
      fs.mkdirSync(orphan, { recursive: true });
      fs.writeFileSync(
        path.join(orphan, name),
        "legacy source bytes\n",
        "utf8",
      );

      const plan = scanLegacyTaskMigration({ projectRoot: tmp });

      expect(plan.preflight.status).toBe("blocked");
      expect(plan.findings).toContainEqual(
        expect.objectContaining({
          code: "orphan-task-artifacts",
          severity: "blocker",
          sourcePath: `.pactile/tasks/orphan-${name}`,
        }),
      );
      expect(fs.readFileSync(path.join(orphan, name), "utf8")).toBe(
        "legacy source bytes\n",
      );
    },
  );

  it("returns an empty read-only plan when no legacy tasks root exists", () => {
    const plan = scanLegacyTaskMigration({ projectRoot: tmp });
    expect(plan.preflight.status).toBe("empty");
    expect(plan.scannedTaskCount).toBe(0);
    expect(plan.wrote).toBe(false);
    expect(plan.findings.map((item) => item.code)).toEqual([
      "tasks-root-missing",
    ]);
  });
});
