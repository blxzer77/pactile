import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TASK_RECORD_FIELD_ORDER,
  emptyTaskRecord,
  loadTaskRecord,
  writeTaskRecord,
} from "../../../src/core/task/index.js";

describe("loadTaskRecord / writeTaskRecord", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-core-task-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes canonical fields in canonical order", () => {
    const dir = path.join(tmp, "05-13-demo");
    writeTaskRecord({
      taskDir: dir,
      record: emptyTaskRecord({
        id: "demo",
        name: "demo",
        title: "Demo",
        assignee: "developer",
      }),
    });
    const raw = fs.readFileSync(path.join(dir, "task.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).slice(0, TASK_RECORD_FIELD_ORDER.length)).toEqual([
      ...TASK_RECORD_FIELD_ORDER,
    ]);
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("still reads legacy archive records with status=planning", () => {
    const dir = path.join(tmp, "archive", "2026-08", "old-planning");
    writeTaskRecord({
      taskDir: dir,
      record: emptyTaskRecord({
        id: "old-planning",
        name: "old-planning",
        title: "Legacy planning archive",
        status: "planning",
      }),
    });
    const loaded = loadTaskRecord({ taskDir: dir });
    expect(loaded.status).toBe("planning");
    expect(TASK_RECORD_FIELD_ORDER).toContain("status");
  });

  it("loadTaskRecord round-trips a written record", () => {
    const dir = path.join(tmp, "05-13-round-trip");
    const record = emptyTaskRecord({
      id: "rt",
      name: "rt",
      title: "Round Trip",
      assignee: "developer",
      branch: "feat/x",
    });
    writeTaskRecord({ taskDir: dir, record });
    const loaded = loadTaskRecord({ taskDir: dir });
    expect(loaded).toEqual(record);
  });

  it("loadTaskRecord rejects incomplete on-disk records instead of defaulting fields", () => {
    const dir = path.join(tmp, "05-13-incomplete");
    fs.mkdirSync(dir, { recursive: true });
    const partial = { ...emptyTaskRecord({ id: "partial" }) } as Record<
      string,
      unknown
    >;
    delete partial.assignee;
    fs.writeFileSync(
      path.join(dir, "task.json"),
      JSON.stringify(partial, null, 2) + "\n",
      "utf-8",
    );

    expect(() => loadTaskRecord({ taskDir: dir })).toThrow(
      /task.assignee is required/,
    );
  });

  it("writeTaskRecord rejects incomplete records before touching disk", () => {
    const dir = path.join(tmp, "05-13-write-incomplete");
    const file = path.join(dir, "task.json");
    writeTaskRecord({
      taskDir: dir,
      record: emptyTaskRecord({ id: "ok", name: "ok", title: "OK" }),
    });
    const before = fs.readFileSync(file, "utf-8");

    const partial = { ...emptyTaskRecord({ id: "bad" }) } as Record<
      string,
      unknown
    >;
    delete partial.createdAt;

    expect(() =>
      writeTaskRecord({
        taskDir: dir,
        // @ts-expect-error - public JS callers can still pass incomplete values.
        record: partial,
      }),
    ).toThrow(/task.createdAt is required/);

    expect(fs.readFileSync(file, "utf-8")).toBe(before);
  });

  it("loadTaskRecord rejects non-object task.json records", () => {
    const dir = path.join(tmp, "05-13-non-object");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "task.json"), "[]\n", "utf-8");

    expect(() => loadTaskRecord({ taskDir: dir })).toThrow(
      /task record must be a JSON object/,
    );
  });

  it("preserves unknown on-disk fields across writeTaskRecord", () => {
    const dir = path.join(tmp, "05-13-unknown");
    fs.mkdirSync(dir, { recursive: true });
    const original = {
      ...emptyTaskRecord({ id: "u", name: "u", title: "U" }),
      // Simulate a field added by an external tool / future version.
      external_tracker: { id: "external-42", system: "external" },
      legacy_flag: true,
    };
    fs.writeFileSync(
      path.join(dir, "task.json"),
      JSON.stringify(original, null, 2) + "\n",
      "utf-8",
    );

    writeTaskRecord({
      taskDir: dir,
      record: emptyTaskRecord({
        id: "u",
        name: "u",
        title: "U updated",
        status: "in_progress",
      }),
    });

    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, "task.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(raw.title).toBe("U updated");
    expect(raw.status).toBe("in_progress");
    expect(raw.external_tracker).toEqual({
      id: "external-42",
      system: "external",
    });
    expect(raw.legacy_flag).toBe(true);

    // Canonical fields come first, unknown fields trail in original order.
    const keys = Object.keys(raw);
    const canonicalCount = TASK_RECORD_FIELD_ORDER.length;
    expect(keys.slice(0, canonicalCount)).toEqual([...TASK_RECORD_FIELD_ORDER]);
    expect(keys.slice(canonicalCount)).toEqual([
      "external_tracker",
      "legacy_flag",
    ]);
  });

  it("refuses to overwrite corrupt existing task.json files", () => {
    const dir = path.join(tmp, "05-13-corrupt");
    const file = path.join(dir, "task.json");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, "{ not json\n", "utf-8");

    expect(() =>
      writeTaskRecord({
        taskDir: dir,
        record: emptyTaskRecord({ id: "c", name: "c", title: "C" }),
      }),
    ).toThrow(/Refusing to overwrite corrupt/);

    expect(fs.readFileSync(file, "utf-8")).toBe("{ not json\n");
  });

  it("refuses to overwrite non-object existing task.json files", () => {
    const dir = path.join(tmp, "05-13-array");
    const file = path.join(dir, "task.json");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, "[]\n", "utf-8");

    expect(() =>
      writeTaskRecord({
        taskDir: dir,
        record: emptyTaskRecord({ id: "a", name: "a", title: "A" }),
      }),
    ).toThrow(/Refusing to overwrite non-object task record/);

    expect(fs.readFileSync(file, "utf-8")).toBe("[]\n");
  });

  it("creates the task directory when it does not exist", () => {
    const dir = path.join(tmp, "05-13-missing", "nested");
    writeTaskRecord({
      taskDir: dir,
      record: emptyTaskRecord({ id: "n", name: "n", title: "N" }),
    });
    expect(fs.existsSync(path.join(dir, "task.json"))).toBe(true);
  });

  it("resolves relative taskDir against cwd option", () => {
    const dir = "05-13-rel";
    writeTaskRecord({
      taskDir: dir,
      cwd: tmp,
      record: emptyTaskRecord({ id: "r", name: "r", title: "R" }),
    });
    const loaded = loadTaskRecord({ taskDir: dir, cwd: tmp });
    expect(loaded.title).toBe("R");
    expect(fs.existsSync(path.join(tmp, dir, "task.json"))).toBe(true);
  });

  it("overwrites canonical fields even when no prior file exists", () => {
    const dir = path.join(tmp, "05-13-fresh");
    writeTaskRecord({
      taskDir: dir,
      record: emptyTaskRecord({
        id: "fresh",
        name: "fresh",
        title: "Fresh",
        children: ["a", "b"],
      }),
    });
    const loaded = loadTaskRecord({ taskDir: dir });
    expect(loaded.children).toEqual(["a", "b"]);
  });

  it("validates the supplied record before writing", () => {
    const dir = path.join(tmp, "05-13-invalid");
    const file = path.join(dir, "task.json");
    writeTaskRecord({
      taskDir: dir,
      record: emptyTaskRecord({ id: "ok", name: "ok", title: "OK" }),
    });
    const before = fs.readFileSync(file, "utf-8");

    expect(() =>
      writeTaskRecord({
        taskDir: dir,
        record: {
          ...emptyTaskRecord({ id: "bad", name: "bad", title: "Bad" }),
          // @ts-expect-error - public JS callers can still pass invalid values.
          children: ["ok", 1],
        },
      }),
    ).toThrow(/task.children must be an array of strings/);

    expect(fs.readFileSync(file, "utf-8")).toBe(before);
  });
});
