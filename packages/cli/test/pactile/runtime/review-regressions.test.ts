import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleRuntimePathRequest } from "../../../src/pactile/runtime/json-api.js";
import {
  parseInstallStateV1,
  type InstallStateV1,
} from "@blxzer/pactile-core";
import {
  GenerationStore,
  InstallStateStore,
} from "../../../src/pactile/runtime/stores.js";
import {
  RuntimeError,
  assertCanonicalWriteTarget,
  discoverRuntimeRoots,
} from "../../../src/pactile/runtime/paths.js";

function state(generationId: string): InstallStateV1 {
  return {
    schemaVersion: 1,
    product: "pactile",
    canonicalRoot: ".pactile",
    runtimeVersion: "0.5.0",
    contractVersion: 1,
    generationId,
    status: "active",
    installedAdapters: [],
    lastMigrationJournalId: null,
    createdAt: "2026-09-09T00:00:00Z",
    updatedAt: "2026-09-09T00:00:00Z",
  };
}

const roots: string[] = [];
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-review-fix-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("independent-review regression contracts", () => {
  it("RUNTIME-CHECK-004 returns stable code-only errors for duplicate staging writes and preserves bytes", () => {
    const root = fixture();
    const generations = new GenerationStore(root);
    generations.stage("stage-a");
    const file = generations.writeFile("stage-a", "a.txt", "original");
    let observed: unknown;
    try {
      generations.writeFile("stage-a", "a.txt", "replacement");
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(RuntimeError);
    expect(observed).toMatchObject({
      code: "generation-invalid",
      message: "generation-invalid",
    });
    generations.seal("stage-a", [file]);
    expect(generations.readFile("stage-a", "a.txt").toString()).toBe(
      "original",
    );
    expect(() => generations.stage("stage-a")).toThrowError(
      new RuntimeError("generation-invalid"),
    );
  });

  it.each(["open", "write", "flush", "close"])(
    "RUNTIME-CHECK-004 maps %s faults on staging payloads without activating or leaking paths",
    (phase) => {
      const root = fixture();
      new GenerationStore(root).stage("stage-a");
      let payloadDescriptor = -1;
      const failure = (): never => {
        throw Object.assign(new Error(`EIO: private path ${root}`), {
          code: "EIO",
        });
      };
      const io = {
        ...fs,
        openSync: ((file, flags, mode) => {
          if (String(file).endsWith("payload.txt") && phase === "open")
            failure();
          const descriptor = fs.openSync(file, flags, mode);
          if (String(file).endsWith("payload.txt"))
            payloadDescriptor = descriptor;
          return descriptor;
        }) as typeof fs.openSync,
        writeFileSync: ((file, data, options) => {
          if (file === payloadDescriptor && phase === "write") failure();
          fs.writeFileSync(file, data, options);
        }) as typeof fs.writeFileSync,
        fsyncSync: (descriptor: number): void => {
          if (descriptor === payloadDescriptor && phase === "flush") failure();
          fs.fsyncSync(descriptor);
        },
        closeSync: (descriptor: number): void => {
          fs.closeSync(descriptor);
          if (descriptor === payloadDescriptor && phase === "close") failure();
        },
      };
      let observed: unknown;
      try {
        new GenerationStore(root, io).writeFile(
          "stage-a",
          "payload.txt",
          "candidate",
        );
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(RuntimeError);
      expect(observed).toMatchObject({
        code: "atomic-replace-failed",
        message: "atomic-replace-failed",
      });
      expect(String(observed)).not.toContain(root);
      expect(new InstallStateStore(root).read()).toBeNull();
      expect(() => new GenerationStore(root).verify("stage-a")).toThrow(
        "generation-unsealed",
      );
    },
  );

  it("RUNTIME-CHECK-004 maps filesystem failures and missing project roots without absolute-path leakage", () => {
    const root = fixture();
    const missing = path.join(root, "not-present");
    const failures: [() => unknown, string][] = [
      [
        () => assertCanonicalWriteTarget(missing, ".pactile/file"),
        "outside-project",
      ],
      [() => discoverRuntimeRoots(missing), "outside-project"],
      [
        () =>
          new GenerationStore(root, {
            ...fs,
            mkdirSync: (() => {
              throw Object.assign(new Error(`EACCES: ${root}`), {
                code: "EACCES",
              });
            }) as typeof fs.mkdirSync,
          }).stage("stage-a"),
        "atomic-replace-failed",
      ],
    ];
    for (const [operation, code] of failures) {
      let observed: unknown;
      try {
        operation();
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(RuntimeError);
      expect(observed).toMatchObject({ code, message: code });
      expect(String(observed)).not.toContain(root);
    }
    const requests = [
      { operation: "guard", projectRoot: missing, target: ".pactile/file" },
      { operation: "discover", projectRoot: missing },
    ];
    const expected = [
      { ok: false, error: { code: "outside-project" } },
      { ok: false, error: { code: "outside-project" } },
    ];
    expect(
      requests.map((request) => handleRuntimePathRequest(request)),
    ).toEqual(expected);
  });

  it.each(["missing", "missing-store", "unsealed", "tampered"])(
    "RUNTIME-CHECK-003 diagnoses %s active generation without changing the pointer",
    (corruption) => {
      const root = fixture();
      const generations = new GenerationStore(root);
      generations.stage("active-a");
      const file = generations.writeFile("active-a", "payload.txt", "original");
      generations.seal("active-a", [file]);
      const installs = new InstallStateStore(root);
      const pointer = installs.compareAndSwap(null, state("active-a"));
      const directory = path.join(
        root,
        ".pactile/runtime/generations/g-active-a",
      );
      if (corruption === "missing") fs.rmSync(directory, { recursive: true });
      else if (corruption === "missing-store")
        fs.rmSync(path.dirname(directory), { recursive: true });
      else if (corruption === "unsealed")
        fs.unlinkSync(path.join(directory, ".sealed.json"));
      else
        fs.writeFileSync(path.join(directory, "files/payload.txt"), "tampered");
      expect(installs.recover()).toEqual({
        activeGenerationId: "active-a",
        diagnostics: [
          {
            code: "generation-unsealed",
            path: ".pactile/runtime/generations/g-active-a",
          },
        ],
      });
      expect(installs.read()).toEqual(pointer);
    },
  );

  it("RUNTIME-CHECK-002 stores and recovers every device-stem logical ID accepted by B0", () => {
    const stems = [
      "con",
      "prn",
      "aux",
      "nul",
      ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
      ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
    ];
    for (const stem of stems) {
      const root = fixture();
      const generations = new GenerationStore(root);
      for (const id of [stem, `${stem}.data`, `${stem}:one`]) {
        expect(parseInstallStateV1(state(id)).success).toBe(true);
        generations.stage(id);
        generations.seal(id, []);
      }
      const installs = new InstallStateStore(root);
      installs.compareAndSwap(null, state(stem));
      const recovered = installs.recover();
      expect(recovered.activeGenerationId).toBe(stem);
      expect(recovered.diagnostics.map((item) => item.code)).toEqual([
        "orphan-generation",
        "orphan-generation",
      ]);
      expect(recovered.diagnostics.map((item) => item.path)).toEqual([
        `.pactile/runtime/generations/g-${stem}%3Aone`,
        `.pactile/runtime/generations/g-${stem}.data`,
      ]);
    }
  }, 60_000);

  it("RUNTIME-CHECK-001 pins normalization of Unicode 16 composition sequences to Unicode 15", () => {
    const component = String.fromCodePoint(0x105d2, 0x0307);
    const requests = [
      { operation: "fold", component },
      { operation: "normalize", path: `.pactile/${component}/state.json` },
    ];
    const expected = [
      { ok: true, result: component },
      { ok: true, result: `.pactile/${component}/state.json` },
    ];
    expect(
      requests.map((request) => handleRuntimePathRequest(request)),
    ).toEqual(expected);
  });
});
