import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyTaskRecord } from "../../src/task/index.js";
import { readKernel } from "../../src/task/kernel-store.js";
import {
  applyArtifactMigration,
  formatArtifactVernacular,
  planArtifactMigration,
} from "../../src/task/p36-artifact-migrate.js";

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("P36 artifact B migrator", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-p36-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("dry-run / plan writes nothing and keeps Continue on old tasks", () => {
    const taskDir = path.join(tmp, ".pactile", "tasks", "old-lite");
    const record = {
      ...emptyTaskRecord({
        id: "old-lite",
        name: "old-lite",
        title: "Old lite",
        status: "in_progress",
        parent: "parent-a",
        children: [],
      }),
      depends_on: ["dep-1"],
    };
    writeJson(path.join(taskDir, "task.json"), record);
    fs.writeFileSync(
      path.join(taskDir, "prd.md"),
      "# KEEP-THIS-PRD-BODY\n",
      "utf-8",
    );
    const before = fs.readFileSync(path.join(taskDir, "task.json"), "utf-8");

    const plan = planArtifactMigration({ root: tmp });
    expect(plan.wrote).toBeUndefined();
    expect(plan.dualRead).toBe(1);
    expect(plan.activeDualRead).toBe(1);
    expect(plan.continueOk).toBe(true);
    expect(plan.writable).toHaveLength(1);
    expect(fs.readFileSync(path.join(taskDir, "task.json"), "utf-8")).toBe(
      before,
    );

    const kernel = readKernel({ taskDir });
    expect(kernel.persisted).toBe(false);
    expect(kernel.legacy.status).toBe("in_progress");
    expect(kernel.kernel.phase).toBe("execute");
    expect(fs.existsSync(path.join(taskDir, "prd.md"))).toBe(true);
    expect(fs.readFileSync(path.join(taskDir, "prd.md"), "utf-8")).toContain(
      "KEEP-THIS-PRD-BODY",
    );
  });

  it("maintainer write adds projections and keeps business fields", () => {
    const taskDir = path.join(tmp, ".pactile", "tasks", "old-full");
    writeJson(path.join(taskDir, "task.json"), {
      ...emptyTaskRecord({
        id: "old-full",
        name: "old-full",
        title: "Keep title",
        status: "in_progress",
        notes: "keep notes",
        parent: "p1",
        children: ["c1"],
        meta: { classification: "full", owner_note: "keep" },
      }),
      depends_on: ["dep-1"],
    });
    fs.writeFileSync(path.join(taskDir, "prd.md"), "PRD-BODY\n", "utf-8");

    const plan = planArtifactMigration({ root: tmp });
    const result = applyArtifactMigration({ root: tmp, plan });
    expect(result.ok).toBe(true);
    expect(result.wrote).toBe(true);

    const disk = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(disk.title).toBe("Keep title");
    expect(disk.notes).toBe("keep notes");
    expect(disk.status).toBe("in_progress");
    expect(disk.depends_on).toEqual(["dep-1"]);
    expect((disk.meta as { owner_note?: string }).owner_note).toBe("keep");
    expect((disk.required_controls as { rigor?: string }).rigor).toBe("full");
    expect((disk.topology as { kind?: string }).kind).toBe("parent-child");
    expect(
      (disk.dependency_graph as { edges?: unknown[] }).edges,
    ).toHaveLength(1);
    expect(fs.readFileSync(path.join(taskDir, "prd.md"), "utf-8")).toBe(
      "PRD-BODY\n",
    );
  });

  it("writes a Child with parent and empty children as single", () => {
    const taskDir = path.join(tmp, ".pactile", "tasks", "old-child");
    writeJson(path.join(taskDir, "task.json"), {
      ...emptyTaskRecord({
        id: "old-child",
        name: "old-child",
        title: "Child keep title",
        status: "in_progress",
        parent: "parent-a",
        children: [],
      }),
    });

    const result = applyArtifactMigration({
      root: tmp,
      plan: planArtifactMigration({ root: tmp }),
    });
    expect(result.ok).toBe(true);
    const disk = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(disk.topology).toMatchObject({
      kind: "single",
      parent_id: "parent-a",
      children: [],
    });
  });

  it("repairs a written Child that was misclassified as parent-child", () => {
    const taskDir = path.join(tmp, ".pactile", "tasks", "mis-child");
    writeJson(path.join(taskDir, "task.json"), {
      ...emptyTaskRecord({
        id: "mis-child",
        name: "mis-child",
        title: "Already written",
        status: "in_progress",
        parent: "parent-a",
        children: [],
      }),
      required_controls: {
        schema_version: 1,
        source: "full-quality-contract",
        rigor: "lite",
        controls: ["definition", "evidence"],
        surfaces: {},
        resolved_from: {
          verification_profile: null,
          risk_signals: [],
          policy_requires_design: false,
        },
      },
      topology: {
        schema_version: 1,
        kind: "parent-child",
        parent_id: "parent-a",
        children: [],
      },
    });

    const plan = planArtifactMigration({ root: tmp });
    expect(plan.writable).toHaveLength(1);
    expect(plan.writable[0]?.extra?.topology).toMatchObject({
      kind: "single",
      parent_id: "parent-a",
      children: [],
    });

    const result = applyArtifactMigration({ root: tmp, plan });
    expect(result.ok).toBe(true);
    const disk = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(disk.title).toBe("Already written");
    expect(disk.topology).toMatchObject({
      kind: "single",
      parent_id: "parent-a",
      children: [],
    });
  });

  it("does not write archive tasks and rolls back on failure", () => {
    const live = path.join(tmp, ".pactile", "tasks", "live");
    const archived = path.join(tmp, ".pactile", "tasks", "archive", "old");
    writeJson(path.join(live, "task.json"), {
      ...emptyTaskRecord({
        id: "live",
        name: "live",
        status: "in_progress",
      }),
    });
    writeJson(path.join(archived, "task.json"), {
      ...emptyTaskRecord({
        id: "old",
        name: "old",
        status: "completed",
      }),
    });
    const archiveBefore = fs.readFileSync(
      path.join(archived, "task.json"),
      "utf-8",
    );
    const liveBefore = fs.readFileSync(path.join(live, "task.json"), "utf-8");

    const plan = planArtifactMigration({ root: tmp });
    expect(plan.archiveSkipped).toBe(1);
    expect(plan.writable.every((item) => !item.path.includes("archive"))).toBe(
      true,
    );

    const failed = applyArtifactMigration({
      root: tmp,
      plan,
      onBeforeWrite: () => {
        throw new Error("injected failure");
      },
    });
    expect(failed.ok).toBe(false);
    expect(failed.rolledBack).toBe(false);
    expect(fs.readFileSync(path.join(live, "task.json"), "utf-8")).toBe(
      liveBefore,
    );
    expect(fs.readFileSync(path.join(archived, "task.json"), "utf-8")).toBe(
      archiveBefore,
    );

    writeJson(path.join(tmp, ".pactile", "tasks", "second", "task.json"), {
      ...emptyTaskRecord({ id: "second", name: "second", status: "planning" }),
    });
    const two = planArtifactMigration({ root: tmp });
    let seen = 0;
    const rolled = applyArtifactMigration({
      root: tmp,
      plan: two,
      onBeforeWrite: () => {
        seen += 1;
        if (seen === 2) throw new Error("second write fails");
      },
    });
    expect(rolled.ok).toBe(false);
    expect(rolled.rolledBack).toBe(true);
    const liveAfter = JSON.parse(
      fs.readFileSync(path.join(live, "task.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(liveAfter.required_controls).toBeUndefined();
    expect(fs.readFileSync(path.join(archived, "task.json"), "utf-8")).toBe(
      archiveBefore,
    );
  });

  it("vernacular has no Stage map and no harness full-migrate", () => {
    const plan = planArtifactMigration({ root: tmp });
    const text = formatArtifactVernacular(plan, false).join("\n");
    expect(text).not.toMatch(/Stage\s*[0-7]/);
    expect(text).not.toMatch(/MyHarness/);
    expect(text).not.toMatch(/全量迁移/);
    expect(text).not.toMatch(/手搬/);
    expect(text).toMatch(/旧形状可读|这次不用改/);
  });
});
