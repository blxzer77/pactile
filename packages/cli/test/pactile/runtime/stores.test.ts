import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { InstallStateV1 } from "../../../src/core/index.js";
import {
  GenerationStore,
  InstallStateStore,
} from "../../../src/pactile/runtime/stores.js";
import { resolveCanonicalPaths } from "../../../src/pactile/runtime/paths.js";

const roots: string[] = [];
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-store-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
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
function sealed(root: string, id: string): void {
  const store = new GenerationStore(root);
  store.stage(id);
  const file = store.writeFile(id, "tiles/readme.md", "hello\n");
  // SHA-256 known from independent fixture bytes, not computed with store internals.
  expect(file.fingerprint).toBe(
    "sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
  );
  store.seal(id, [file]);
}

describe("sealed generations and atomic activation", () => {
  it("stages, validates, seals and activates without writing either legacy tree", () => {
    const root = fixture();
    for (const name of [".cstl", ".trellis"]) {
      fs.mkdirSync(path.join(root, name));
      fs.writeFileSync(path.join(root, name, "task.json"), "legacy bytes\r\n");
    }
    const store = new GenerationStore(root);
    sealed(root, "gen:first");
    expect(store.readFile("gen:first", "tiles/readme.md").toString()).toBe(
      "hello\n",
    );
    expect(() => store.writeFile("gen:first", "other.md", "bad")).toThrow(
      "generation-sealed",
    );
    expect(() => store.seal("gen:first", [])).toThrow("generation-sealed");
    const installs = new InstallStateStore(root);
    expect(installs.read()).toBeNull();
    const initial = installs.compareAndSwap(null, state("gen:first"));
    expect(installs.read()).toEqual(initial);
    expect(installs.recover()).toEqual({
      activeGenerationId: "gen:first",
      diagnostics: [],
    });
    for (const name of [".cstl", ".trellis"])
      expect(fs.readFileSync(path.join(root, name, "task.json"), "utf8")).toBe(
        "legacy bytes\r\n",
      );
    expect(fs.existsSync(path.join(root, ".pactile/runtime/current"))).toBe(
      false,
    );
  });

  it("rejects stale CAS and unfinished or tampered generations without moving the pointer", () => {
    const root = fixture();
    sealed(root, "gen-a");
    const installs = new InstallStateStore(root);
    const initial = installs.compareAndSwap(null, state("gen-a"));
    const bytes = fs.readFileSync(resolveCanonicalPaths(root).installStatePath);
    const generations = new GenerationStore(root);
    generations.stage("gen-b");
    const file = generations.writeFile("gen-b", "draft.txt", "draft");
    expect(() => generations.seal("gen-b", [])).toThrow("generation-invalid");
    expect(() =>
      installs.compareAndSwap(initial.fingerprint, state("gen-b")),
    ).toThrow("generation-unsealed");
    generations.seal("gen-b", [file]);
    expect(() => installs.compareAndSwap(null, state("gen-b"))).toThrow(
      "cas-mismatch",
    );
    const generated = path.join(
      resolveCanonicalPaths(root).generationsPath,
      "g-gen-b/files/draft.txt",
    );
    fs.writeFileSync(generated, "tampered");
    expect(() =>
      installs.compareAndSwap(initial.fingerprint, state("gen-b")),
    ).toThrow("generation-unsealed");
    expect(
      fs.readFileSync(resolveCanonicalPaths(root).installStatePath),
    ).toEqual(bytes);
    expect(installs.read()).toEqual(initial);
  });

  it("keeps previous bytes on fsync/rename failure and reports unknown residue without deleting it", () => {
    const root = fixture();
    sealed(root, "gen-a");
    sealed(root, "gen-b");
    const installs = new InstallStateStore(root);
    const initial = installs.compareAndSwap(null, state("gen-a"));
    const paths = resolveCanonicalPaths(root);
    const bytes = fs.readFileSync(paths.installStatePath);
    const io = {
      ...fs,
      renameSync: (): never => {
        throw Object.assign(new Error("locked"), { code: "EACCES" });
      },
    };
    expect(() =>
      new InstallStateStore(root, io).compareAndSwap(
        initial.fingerprint,
        state("gen-b"),
      ),
    ).toThrow("atomic-replace-failed");
    const flushFault = {
      ...fs,
      fsyncSync: (): never => {
        throw Object.assign(new Error("disk error"), { code: "EIO" });
      },
    };
    expect(() =>
      new InstallStateStore(root, flushFault).compareAndSwap(
        initial.fingerprint,
        state("gen-b"),
      ),
    ).toThrow("atomic-replace-failed");
    expect(fs.readFileSync(paths.installStatePath)).toEqual(bytes);
    fs.writeFileSync(`${paths.installStatePath}.tmp-unknown`, "partial");
    new GenerationStore(root).stage("gen-c");
    fs.writeFileSync(
      path.join(paths.generationsPath, "g-gen-c/.sealed.json.tmp-unknown"),
      "partial seal",
    );
    fs.writeFileSync(
      path.join(paths.generationsPath, "g-gen-c/.generation.lock"),
      "interrupted writer",
    );
    const recovered = installs.recover();
    expect(recovered.activeGenerationId).toBe("gen-a");
    expect(recovered.diagnostics).toEqual(
      expect.arrayContaining([
        {
          code: "orphan-generation",
          path: ".pactile/runtime/generations/g-gen-b",
        },
        {
          code: "generation-unsealed",
          path: ".pactile/runtime/generations/g-gen-c",
        },
        {
          code: "leftover-temp",
          path: ".pactile/runtime/generations/g-gen-c/.sealed.json.tmp-unknown",
        },
        {
          code: "leftover-lock",
          path: ".pactile/runtime/generations/g-gen-c/.generation.lock",
        },
        {
          code: "leftover-temp",
          path: ".pactile/runtime/install-state.json.tmp-unknown",
        },
        {
          code: "leftover-lock",
          path: ".pactile/runtime/install-state.json.lock",
        },
      ]),
    );
    expect(
      fs.readFileSync(`${paths.installStatePath}.tmp-unknown`, "utf8"),
    ).toBe("partial");
    expect(installs.read()).toEqual(initial);
  });

  it("does not steal an existing writer lock and rejects malformed install state", () => {
    const root = fixture();
    sealed(root, "gen-a");
    const paths = resolveCanonicalPaths(root);
    fs.writeFileSync(`${paths.installStatePath}.lock`, "other writer");
    const installs = new InstallStateStore(root);
    expect(() => installs.compareAndSwap(null, state("gen-a"))).toThrow(
      "atomic-replace-failed",
    );
    expect(fs.readFileSync(`${paths.installStatePath}.lock`, "utf8")).toBe(
      "other writer",
    );
    expect(installs.read()).toBeNull();
    fs.writeFileSync(paths.installStatePath, '{"generationId":"fake"}');
    expect(() => installs.read()).toThrow("state-malformed");
    expect(installs.recover().diagnostics).toContainEqual({
      code: "state-malformed",
      path: ".pactile/runtime/install-state.json",
    });
    expect(installs.recover().diagnostics).toContainEqual({
      code: "generation-activation-unknown",
      path: ".pactile/runtime/generations/g-gen-a",
    });
  });

  it("gives one winner to clients with the same snapshot and preserves state on a temp-file flush failure", () => {
    const root = fixture();
    sealed(root, "gen-a");
    sealed(root, "gen-b");
    sealed(root, "gen-c");
    const first = new InstallStateStore(root);
    const second = new InstallStateStore(root);
    const initial = first.compareAndSwap(null, state("gen-a"));
    expect(second.read()).toEqual(initial);
    const winner = first.compareAndSwap(initial.fingerprint, state("gen-b"));
    expect(() =>
      second.compareAndSwap(initial.fingerprint, state("gen-c")),
    ).toThrow("cas-mismatch");
    const target = resolveCanonicalPaths(root).installStatePath;
    let temporaryDescriptor = -1;
    const io = {
      ...fs,
      openSync: ((file, flags, mode) => {
        const descriptor = fs.openSync(file, flags, mode);
        if (String(file).startsWith(`${target}.tmp-`))
          temporaryDescriptor = descriptor;
        return descriptor;
      }) as typeof fs.openSync,
      fsyncSync: (descriptor: number): void => {
        if (descriptor === temporaryDescriptor)
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        fs.fsyncSync(descriptor);
      },
    };
    expect(() =>
      new InstallStateStore(root, io).compareAndSwap(
        winner.fingerprint,
        state("gen-c"),
      ),
    ).toThrow("atomic-replace-failed");
    expect(second.read()).toEqual(winner);
    expect(
      second
        .recover()
        .diagnostics.some((item) => item.code === "leftover-temp"),
    ).toBe(true);
  });

  it.skipIf(process.platform !== "win32")(
    "retains active pointer when Windows denies atomic replacement of a genuinely locked file",
    async () => {
      const root = fixture();
      sealed(root, "gen-a");
      sealed(root, "gen-b");
      const installs = new InstallStateStore(root);
      const initial = installs.compareAndSwap(null, state("gen-a"));
      const target = resolveCanonicalPaths(root).installStatePath;
      const bytes = fs.readFileSync(target);
      const child = spawn(
        "pwsh",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$file=[IO.File]::Open($env:PACTILE_LOCK_TARGET,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::WriteLine('locked'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null; $file.Dispose()",
        ],
        {
          env: { ...process.env, PACTILE_LOCK_TARGET: target },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          child.on("error", reject);
          child.on("exit", (code) => {
            if (code !== null) reject(new Error(`lock process exited ${code}`));
          });
          child.stdout.on("data", (data: Buffer) => {
            if (data.toString().includes("locked")) resolve();
          });
        });
        expect(() =>
          installs.compareAndSwap(initial.fingerprint, state("gen-b")),
        ).toThrow("atomic-replace-failed");
        expect(installs.read()).toEqual(initial);
        expect(fs.readFileSync(target)).toEqual(bytes);
      } finally {
        child.stdin.end("\n");
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
        });
      }
    },
  );
});
