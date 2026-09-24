import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyTaskRecord } from "../../../src/core/task/schema.js";
import { handleKernelRequest } from "../../../src/core/task/kernel-cli.js";
import { applyKernelCreate, applyKernelPatch, applyKernelRecordGate, createTaskProjectionPort } from "../../../src/core/task/kernel-store.js";
import { neutralKernelExtrasBoundary } from "../../../src/core/task/kernel-contract.js";

describe("Canonical projection inspection and explicit repair", () => {
  let root: string;
  let file: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-projection-"));
    file = path.join(root, "task.json");
    applyKernelCreate({ taskDir: root, actor: "test", idempotencyKey: "create", record: emptyTaskRecord({ id: "demo", title: "Canonical title" }), extrasBoundary: neutralKernelExtrasBoundary });
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { force: true, recursive: true }); });

  it("F2 reports drift when a canonical own constructor key is missing rather than reading Object.prototype", () => {
    applyKernelPatch({ taskDir: root, expectedRevision: 1, actor: "test", idempotencyKey: "constructor", extras: { constructor: "canonical constructor" }, extrasBoundary: neutralKernelExtrasBoundary });
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    Reflect.deleteProperty(current, "constructor"); fs.writeFileSync(file, JSON.stringify(current));
    const port = createTaskProjectionPort({ taskDir: root });
    expect(port.inspect().status).toBe("drifted");
    expect(port.repair(port.inspect()).status).toBe("repaired");
    expect(port.inspect().status).toBe("in-sync");
    expect(Object.hasOwn(JSON.parse(fs.readFileSync(file, "utf8")) as object, "constructor")).toBe(true);
  });

  it("F2 preserves safe foreign own prototype-named keys through ordinary lifecycle projection", () => {
    const foreign = { constructor: "foreign constructor", prototype: "foreign prototype", toString: "foreign toString", hasOwnProperty: "foreign hasOwnProperty", nested: { ["__proto__"]: "nested data" } };
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as object;
    fs.writeFileSync(file, JSON.stringify({ ...current, ...foreign }));
    const result = applyKernelPatch({ taskDir: root, expectedRevision: 1, actor: "test", idempotencyKey: "unrelated", record: { title: "new title" }, extrasBoundary: neutralKernelExtrasBoundary });
    expect(result.projected).toBe(true);
    const after = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    for (const [key, value] of Object.entries(foreign)) {
      expect(Object.hasOwn(after, key)).toBe(true); expect(after[key]).toEqual(value);
    }
    expect(after.title).toBe("new title");
  });

  it("F2 rejects a current top-level __proto__ before canonical persist and leaves both files byte-identical", () => {
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as object;
    fs.writeFileSync(file, JSON.stringify({ ...current, constructor: "foreign", ["__proto__"]: { keep: true } }));
    const before = fs.readFileSync(file), kernelBefore = fs.readFileSync(path.join(root, "kernel.json"));
    expect(() => applyKernelPatch({ taskDir: root, expectedRevision: 1, actor: "test", idempotencyKey: "unsafe-current", record: { title: "must not land" }, extrasBoundary: neutralKernelExtrasBoundary })).toThrow("unsafe projection key");
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readFileSync(path.join(root, "kernel.json"))).toEqual(kernelBefore);
  });

  it("F2 rejects canonical top-level __proto__ on create before writing kernel or task", () => {
    const taskDir = path.join(root, "unsafe-create");
    const extras = JSON.parse('{"__proto__":{"keep":true},"constructor":"safe"}') as Record<string, unknown>;
    expect(() => applyKernelCreate({ taskDir, actor: "test", idempotencyKey: "unsafe-create", record: emptyTaskRecord({ id: "unsafe-create" }), extras, extrasBoundary: neutralKernelExtrasBoundary })).toThrow("unsafe projection key");
    expect(fs.existsSync(path.join(taskDir, "kernel.json"))).toBe(false);
    expect(fs.existsSync(path.join(taskDir, "task.json"))).toBe(false);
  });

  it("F1 dictionary scan preserves prototype-named own transition/gate entries across lifecycle reload", () => {
    applyKernelRecordGate({ taskDir: root, expectedRevision: 1, actor: "test", idempotencyKey: "gate", transition: "__proto__", gateName: "constructor", record: { result: "FAIL" }, extrasBoundary: neutralKernelExtrasBoundary });
    const result = applyKernelPatch({ taskDir: root, expectedRevision: 2, actor: "test", idempotencyKey: "after-gate", record: { title: "after gate" }, extrasBoundary: neutralKernelExtrasBoundary });
    const transitions = result.kernel.gates.transitions;
    expect(Object.hasOwn(transitions, "__proto__")).toBe(true);
    expect(Object.hasOwn(transitions["__proto__"], "constructor")).toBe(true);
    expect(transitions["__proto__"].constructor).toEqual({ result: "FAIL" });
  });

  it("reports drift without writing, then CAS repairs owned fields and preserves foreign data", () => {
    const original = fs.readFileSync(file, "utf8");
    const altered = JSON.stringify({ ...JSON.parse(original) as object, title: "old script", foreign: { keep: true } });
    fs.writeFileSync(file, altered);
    const beforeFiles = fs.readdirSync(root);
    const port = createTaskProjectionPort({ taskDir: root });
    const observed = port.inspect();
    expect(observed.status).toBe("drifted");
    expect(fs.readFileSync(file, "utf8")).toBe(altered);
    expect(fs.readdirSync(root)).toEqual(beforeFiles);
    const receipt = port.repair(observed);
    expect(receipt.status).toBe("repaired");
    expect(receipt.canonicalRevision).toBe(1);
    expect(port.inspect().status).toBe("in-sync");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ title: "Canonical title", foreign: { keep: true } });
    expect(port.repair(port.inspect()).status).toBe("in-sync");
  });

  it.each(["missing", "malformed"])("supports %s projection only through an explicit fingerprint-approved repair", (scenario) => {
    if (scenario === "missing") fs.unlinkSync(file);
    else fs.writeFileSync(file, "{bad json");
    const port = createTaskProjectionPort({ taskDir: root });
    const observed = port.inspect();
    expect(observed.status).toBe(scenario);
    expect(fs.existsSync(file)).toBe(scenario !== "missing");
    expect(port.repair(observed).status).toBe("repaired");
    expect(port.inspect().status).toBe("in-sync");
  });

  it("does not overwrite an intervening projection edit or canonical revision", () => {
    const port = createTaskProjectionPort({ taskDir: root });
    const observed = port.inspect();
    fs.appendFileSync(file, "\n");
    const changed = fs.readFileSync(file, "utf8");
    expect(port.repair(observed).status).toBe("cas-mismatch");
    expect(fs.readFileSync(file, "utf8")).toBe(changed);
    const next = port.inspect();
    applyKernelPatch({ taskDir: root, expectedRevision: next.canonicalRevision, actor: "test", idempotencyKey: "patch", record: { title: "New canonical" }, extrasBoundary: neutralKernelExtrasBoundary });
    expect(port.repair(next).status).toBe("cas-mismatch");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ title: "New canonical" });
  });

  it("exposes inspect/repair through the JSON CLI and fails closed without CAS fields", () => {
    fs.writeFileSync(file, "[]");
    const observed = handleKernelRequest({ op: "inspect-projection", taskDir: root });
    expect(observed).toMatchObject({ ok: true, status: "malformed", canonicalRevision: 1 });
    expect(handleKernelRequest({ op: "repair-projection", taskDir: root })).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    if (!observed.ok || observed.op !== "inspect-projection") throw new Error("inspect failed");
    expect(handleKernelRequest({ op: "repair-projection", taskDir: root, expectedCanonicalRevision: observed.canonicalRevision, expectedCurrentFingerprint: observed.currentFingerprint })).toMatchObject({ ok: true, status: "repaired" });
  });

  it("preserves current bytes and canonical state if atomic installation fails", () => {
    fs.writeFileSync(file, "{malformed");
    const kernelBefore = fs.readFileSync(path.join(root, "kernel.json"), "utf8");
    const port = createTaskProjectionPort({ taskDir: root });
    const observed = port.inspect();
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("injected rename failure"); });
    expect(() => port.repair(observed)).toThrow("injected rename failure");
    expect(fs.readFileSync(file, "utf8")).toBe("{malformed");
    expect(fs.readFileSync(path.join(root, "kernel.json"), "utf8")).toBe(kernelBefore);
    expect(fs.readdirSync(root).sort()).toEqual(["kernel.json", "task.json"]);
  });

  it("CAS fingerprints malformed binary bytes, not lossy UTF-8 replacement text", () => {
    const port = createTaskProjectionPort({ taskDir: root });
    fs.writeFileSync(file, Buffer.from([0x80]));
    const observed = port.inspect();
    expect(observed.status).toBe("malformed");
    fs.writeFileSync(file, Buffer.from([0x81]));
    expect(port.inspect().currentFingerprint).not.toBe(observed.currentFingerprint);
    expect(port.repair(observed).status).toBe("cas-mismatch");
    expect(fs.readFileSync(file)).toEqual(Buffer.from([0x81]));
  });

  it("rejects an unsafe foreign __proto__ key instead of silently dropping it", () => {
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const altered = JSON.stringify({ ...current, title: "drifted", ["__proto__"]: { owner: "foreign" } });
    fs.writeFileSync(file, altered);
    const port = createTaskProjectionPort({ taskDir: root });
    const observed = port.inspect();
    const kernelBefore = fs.readFileSync(path.join(root, "kernel.json"));
    expect(() => port.repair(observed)).toThrow("unsafe projection key");
    expect(fs.readFileSync(file, "utf8")).toBe(altered);
    expect(fs.readFileSync(path.join(root, "kernel.json"))).toEqual(kernelBefore);
    expect(fs.readdirSync(root).sort()).toEqual(["kernel.json", "task.json"]);
  });

  it.each([false, true])("rejects a taskDir junction/symlink (ancestor=%s) before creating a lock or staging file", (ancestor) => {
    const actualTaskDir = ancestor ? path.join(root, "nested-task") : root;
    if (ancestor) {
      fs.mkdirSync(actualTaskDir);
      fs.copyFileSync(path.join(root, "kernel.json"), path.join(actualTaskDir, "kernel.json"));
    }
    const actualFile = path.join(actualTaskDir, "task.json");
    fs.writeFileSync(actualFile, "{needs repair");
    const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), "projection-alias-"));
    const alias = path.join(aliasRoot, "linked-parent");
    try {
      fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
      const port = createTaskProjectionPort({ taskDir: ancestor ? path.join(alias, "nested-task") : alias });
      const observed = port.inspect();
      const kernelBefore = fs.readFileSync(path.join(actualTaskDir, "kernel.json"));
      expect(() => port.repair(observed)).toThrow("unsafe projection path");
      expect(fs.readFileSync(actualFile, "utf8")).toBe("{needs repair");
      expect(fs.readFileSync(path.join(actualTaskDir, "kernel.json"))).toEqual(kernelBefore);
      expect(fs.readdirSync(actualTaskDir).sort()).toEqual(["kernel.json", "task.json"]);
    } finally { fs.rmSync(aliasRoot, { recursive: true, force: true }); }
  });

  it.each(["task.json", "kernel.json", "kernel.json.lock"])("refuses hardlinked %s without modifying outside data", (name) => {
    fs.writeFileSync(file, "{needs repair");
    const port = createTaskProjectionPort({ taskDir: root });
    const observed = port.inspect();
    const target = path.join(root, name);
    if (name === "kernel.json.lock") fs.writeFileSync(target, "invalid-pid");
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "projection-hardlink-"));
    const outside = path.join(outsideDir, "outside");
    try {
      fs.linkSync(target, outside);
      const before = fs.readFileSync(outside);
      expect(() => port.repair(observed)).toThrow("unsafe projection path");
      expect(fs.readFileSync(outside)).toEqual(before);
      expect(fs.readFileSync(file, "utf8")).toBe("{needs repair");
      expect(fs.readdirSync(root).some((entry) => entry.startsWith(".projection-repair-"))).toBe(false);
    } finally { fs.rmSync(outsideDir, { recursive: true, force: true }); }
  });

  it("preserves ordinary constructor/prototype keys and nested __proto__ data", () => {
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const foreign = { constructor: "user constructor", prototype: "user prototype", nested: { ["__proto__"]: "user data" } };
    fs.writeFileSync(file, JSON.stringify({ ...current, ...foreign, title: "drifted" }));
    const port = createTaskProjectionPort({ taskDir: root });
    expect(port.repair(port.inspect()).status).toBe("repaired");
    const result = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(result.constructor).toBe("user constructor");
    expect(result.prototype).toBe("user prototype");
    expect(result.nested).toEqual({ ["__proto__"]: "user data" });
    expect(Object.hasOwn(result.nested as object, "__proto__")).toBe(true);
  });

  it("rechecks byte CAS after staging when another writer edits the projection", () => {
    fs.writeFileSync(file, "{first damaged version");
    const port = createTaskProjectionPort({ taskDir: root });
    const observed = port.inspect();
    const fsync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      fsync(fd);
      fs.writeFileSync(file, "{intervening writer version");
    });
    const result = port.repair(observed);
    expect(result.status).toBe("cas-mismatch");
    expect(fs.readFileSync(file, "utf8")).toBe("{intervening writer version");
    expect(result.afterFingerprint).toBe(port.inspect().currentFingerprint);
    expect(fs.readdirSync(root).sort()).toEqual(["kernel.json", "task.json"]);
  });
});
