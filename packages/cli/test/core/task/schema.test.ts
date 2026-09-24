import { describe, expect, it } from "vitest";

import {
  TASK_RECORD_FIELD_ORDER,
  emptyTaskRecord,
  taskRecordSchema,
} from "../../../src/core/task/index.js";

describe("emptyTaskRecord", () => {
  it("emits every canonical field in canonical order", () => {
    const record = emptyTaskRecord();
    expect(Object.keys(record)).toEqual([...TASK_RECORD_FIELD_ORDER]);
  });

  it("uses canonical defaults: planning status, P2 priority, today ISO date", () => {
    const record = emptyTaskRecord();
    expect(record.status).toBe("planning");
    expect(record.priority).toBe("P2");
    expect(record.dev_type).toBeNull();
    expect(record.subtasks).toEqual([]);
    expect(record.children).toEqual([]);
    expect(record.relatedFiles).toEqual([]);
    expect(record.meta).toEqual({});
    expect(record.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("shallow-merges overrides on top of defaults", () => {
    const record = emptyTaskRecord({
      id: "demo",
      name: "demo",
      title: "Demo task",
      assignee: "developer",
      package: "core",
    });
    expect(record.id).toBe("demo");
    expect(record.title).toBe("Demo task");
    expect(record.assignee).toBe("developer");
    expect(record.package).toBe("core");
    expect(record.priority).toBe("P2");
  });

  it("copies collection overrides so callers cannot share mutable state", () => {
    const overrides = {
      children: ["child-a"],
      relatedFiles: ["src/demo.ts"],
      subtasks: ["subtask-a"],
      meta: { tracker: "demo", nested: { id: "n1" } },
    };
    const first = emptyTaskRecord(overrides);
    const second = emptyTaskRecord(overrides);

    overrides.children.push("child-b");
    overrides.meta.nested.id = "changed-by-override";
    first.relatedFiles.push("src/changed.ts");
    first.subtasks.push("subtask-b");
    first.meta.tracker = "changed";
    (first.meta.nested as { id: string }).id = "changed-by-first";

    expect(first.children).toEqual(["child-a"]);
    expect(second.relatedFiles).toEqual(["src/demo.ts"]);
    expect(second.subtasks).toEqual(["subtask-a"]);
    expect(second.meta).toEqual({ tracker: "demo", nested: { id: "n1" } });
  });
});

describe("taskRecordSchema", () => {
  it("parses a canonical record", () => {
    const input = emptyTaskRecord({ id: "x", name: "x", title: "X" });
    const parsed = taskRecordSchema.parse(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
  });

  it("rejects non-object inputs", () => {
    expect(() => taskRecordSchema.parse("nope")).toThrow(/must be a JSON object/);
    expect(() => taskRecordSchema.parse(null)).toThrow();
    expect(() => taskRecordSchema.parse([])).toThrow();
  });

  it("rejects wrong field types", () => {
    expect(() =>
      taskRecordSchema.parse({ ...emptyTaskRecord(), title: 42 }),
    ).toThrow(/task.title must be a string/);
    expect(() =>
      taskRecordSchema.parse({ ...emptyTaskRecord(), children: ["ok", 1] }),
    ).toThrow(/task.children must be an array of strings/);
    expect(() =>
      taskRecordSchema.parse({ ...emptyTaskRecord(), meta: [] }),
    ).toThrow(/task.meta must be a JSON object/);
    expect(() =>
      taskRecordSchema.parse({
        ...emptyTaskRecord(),
        meta: { nested: new Date() },
      }),
    ).toThrow(/task.meta.nested must contain only JSON values/);
  });

  it("rejects records missing canonical fields", () => {
    expect(() =>
      taskRecordSchema.parse({
        ...emptyTaskRecord(),
        meta: undefined,
      }),
    ).toThrow(/task.meta must be a JSON object/);

    const partial = { ...emptyTaskRecord() } as Record<string, unknown>;
    delete partial.base_branch;
    expect(() => taskRecordSchema.parse(partial)).toThrow(
      /task.base_branch is required/,
    );
  });

  it("allows null for nullable string fields", () => {
    const parsed = taskRecordSchema.parse({
      ...emptyTaskRecord(),
      branch: null,
      worktree_path: null,
      parent: null,
    });
    expect(parsed.branch).toBeNull();
    expect(parsed.worktree_path).toBeNull();
    expect(parsed.parent).toBeNull();
  });

  it("safeParse returns success / error discriminated result", () => {
    const ok = taskRecordSchema.safeParse(emptyTaskRecord());
    expect(ok.success).toBe(true);
    const bad = taskRecordSchema.safeParse({ title: 1 });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.message).toMatch(/task.id is required/);
    }
  });

  it("drops unknown fields from the structured output (load surface)", () => {
    const parsed = taskRecordSchema.parse({
      ...emptyTaskRecord({ id: "x" }),
      // @ts-expect-error - simulate older/newer on-disk field
      legacy_field: "keep-me-on-disk",
    });
    expect("legacy_field" in parsed).toBe(false);
  });
});
