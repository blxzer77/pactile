import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  appendLegacyTaskOverlayJournalLine,
  type LegacyTaskOverlayFileSystem,
  writeLegacyTaskOverlayKernel,
} from "../../../src/core/task/legacy-task-overlay-durable-io.js";

const roots: string[] = [];

function makeDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pactile-p36-overlay-io-"),
  );
  roots.push(directory);
  return directory;
}

function ioWith(
  overrides: Partial<LegacyTaskOverlayFileSystem> = {},
): LegacyTaskOverlayFileSystem {
  return {
    openSync: (file, flags, mode) => fs.openSync(file, flags, mode),
    writeSync: (fd, bytes, offset, length, position) =>
      fs.writeSync(fd, bytes, offset, length, position),
    fsyncSync: (fd) => fs.fsyncSync(fd),
    closeSync: (fd) => fs.closeSync(fd),
    renameSync: (source, target) => fs.renameSync(source, target),
    ...overrides,
  };
}

function recoveryTemps(directory: string): string[] {
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".p36.tmp"))
    .map((name) => path.join(directory, name));
}

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("durable legacy Task Kernel overlay I/O", () => {
  it("completes journal and Kernel writes when the filesystem reports short writes", () => {
    const directory = makeDirectory();
    const journalPath = path.join(directory, "overlay.jsonl");
    const journalLine = '{"revision":2}\n';
    const shortWriteIo = ioWith({
      writeSync: (fd, bytes, offset, length, position) =>
        fs.writeSync(fd, bytes, offset, Math.min(length, 3), position),
    });

    appendLegacyTaskOverlayJournalLine(journalPath, journalLine, shortWriteIo);
    expect(fs.readFileSync(journalPath, "utf8")).toBe(journalLine);

    const targetPath = path.join(directory, "kernel.json");
    const nextBytes = Buffer.from('{"revision":2}\n');
    fs.writeFileSync(targetPath, Buffer.from('{"revision":1}\n'));
    writeLegacyTaskOverlayKernel(targetPath, nextBytes, shortWriteIo);
    expect(fs.readFileSync(targetPath)).toEqual(nextBytes);
    expect(recoveryTemps(directory)).toEqual([]);
  });

  it("rejects a zero-byte journal write instead of treating a partial append as durable", () => {
    const directory = makeDirectory();
    const journalPath = path.join(directory, "overlay.jsonl");
    const zeroWriteIo = ioWith({ writeSync: () => 0 });

    expect(() =>
      appendLegacyTaskOverlayJournalLine(
        journalPath,
        '{"revision":2}\n',
        zeroWriteIo,
      ),
    ).toThrow(/legacy-task-overlay-write-incomplete/);
    expect(fs.readFileSync(journalPath, "utf8")).toBe("");
  });

  it.each([
    ["zero write", { writeSync: () => 0 }],
    ["fsync failure", { fsyncSync: () => { throw new Error("injected-fsync"); } }],
    ["rename failure", { renameSync: () => { throw new Error("injected-rename"); } }],
  ] as const)("preserves the old Kernel and recovery temp after %s", (_label, overrides) => {
    const directory = makeDirectory();
    const targetPath = path.join(directory, "kernel.json");
    const previousBytes = Buffer.from('{"revision":1}\n');
    const nextBytes = Buffer.from('{"revision":2}\n');
    fs.writeFileSync(targetPath, previousBytes);

    expect(() =>
      writeLegacyTaskOverlayKernel(targetPath, nextBytes, ioWith(overrides)),
    ).toThrow(/legacy-task-kernel-overlay-durable-write-failed/);
    expect(fs.readFileSync(targetPath)).toEqual(previousBytes);
    const temps = recoveryTemps(directory);
    expect(temps).toHaveLength(1);
    const recoveryTemp = temps[0];
    if (!recoveryTemp) throw new Error("missing retained recovery temporary");
    if (_label !== "zero write")
      expect(fs.readFileSync(recoveryTemp)).toEqual(nextBytes);
  });
});
