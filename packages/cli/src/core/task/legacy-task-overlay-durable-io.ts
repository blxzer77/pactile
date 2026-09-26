import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface LegacyTaskOverlayFileSystem {
  openSync(file: string, flags: string, mode?: number): number;
  writeSync(
    fd: number,
    bytes: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(oldPath: string, newPath: string): void;
}

const DEFAULT_IO: LegacyTaskOverlayFileSystem = {
  openSync: (file, flags, mode) => fs.openSync(file, flags, mode),
  writeSync: (fd, bytes, offset, length, position) =>
    fs.writeSync(fd, bytes, offset, length, position),
  fsyncSync: (fd) => fs.fsyncSync(fd),
  closeSync: (fd) => fs.closeSync(fd),
  renameSync: (oldPath, newPath) => fs.renameSync(oldPath, newPath),
};

/** Write every byte; a zero-length write is an I/O failure, never success. */
export function writeAllOverlayBytes(
  fd: number,
  bytes: Buffer,
  io: LegacyTaskOverlayFileSystem = DEFAULT_IO,
): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset;
    const written = io.writeSync(fd, bytes, offset, remaining, null);
    if (
      !Number.isSafeInteger(written) ||
      written <= 0 ||
      written > remaining
    ) {
      throw new Error("legacy-task-overlay-write-incomplete");
    }
    offset += written;
  }
}

/** Append and fsync one journal line before the corresponding Kernel mutation. */
export function appendLegacyTaskOverlayJournalLine(
  journalPath: string,
  line: string,
  io: LegacyTaskOverlayFileSystem = DEFAULT_IO,
): void {
  const fd = io.openSync(journalPath, "a", 0o600);
  try {
    writeAllOverlayBytes(fd, Buffer.from(line, "utf8"), io);
    io.fsyncSync(fd);
  } finally {
    io.closeSync(fd);
  }
}

/**
 * Persist a migrated Task overlay without the shared writer's copy fallback.
 * The temporary file stays beside the target so rename is the only visibility
 * switch. Failed writes/renames retain the temporary file as a recovery clue.
 */
export function writeLegacyTaskOverlayKernel(
  targetPath: string,
  bytes: Buffer,
  io: LegacyTaskOverlayFileSystem = DEFAULT_IO,
): void {
  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.p36.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = io.openSync(temporaryPath, "wx", 0o600);
    writeAllOverlayBytes(fd, bytes, io);
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = null;
    io.renameSync(temporaryPath, targetPath);
  } catch (error) {
    if (fd !== null) {
      try {
        io.closeSync(fd);
      } catch {
        // Preserve the original write/sync/rename failure.
      }
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `legacy-task-kernel-overlay-durable-write-failed; recovery-temp=${temporaryPath}; ${reason}`,
    );
  }
}
