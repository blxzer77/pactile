import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertCanonicalWriteTarget } from "../runtime/paths.js";
import {
  coordinationEnvelopeSchema,
  coordinationEventHash,
  COORDINATION_GENESIS_HASH,
  COORDINATION_MAX_EVENT_BYTES,
  COORDINATION_MAX_LOG_BYTES,
  COORDINATION_MAX_LOG_EVENTS,
  CoordinationError,
  type CoordinationEnvelope,
  type CoordinationEvent,
} from "./model.js";

const STORE_RELATIVE_DIR = ".pactile/runtime/coordination";
const STORE_FILE = `${STORE_RELATIVE_DIR}/events.jsonl`;
const LOCK_FILE = `${STORE_RELATIVE_DIR}/events.lock`;

export interface CoordinationJournal {
  events: CoordinationEvent[];
  bytes: number;
  lastHash: string;
}

function safeTarget(root: string, target: string): string {
  try {
    return assertCanonicalWriteTarget(root, target);
  } catch {
    throw new CoordinationError("unsafe-path");
  }
}

function errorCode(error: unknown): string | null {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}

function ensureStoreDirectory(root: string): void {
  const directory = path.join(
    path.resolve(root),
    ...STORE_RELATIVE_DIR.split("/"),
  );
  const target = safeTarget(root, directory);
  try {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    safeTarget(root, target);
  } catch (error) {
    if (error instanceof CoordinationError) throw error;
    throw new CoordinationError("store-io");
  }
}

export function withCoordinationJournalLock<T>(
  root: string,
  action: () => T,
): T {
  ensureStoreDirectory(root);
  const lockPath = path.join(path.resolve(root), ...LOCK_FILE.split("/"));
  const target = safeTarget(root, lockPath);
  const token = randomUUID();
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new CoordinationError("unsafe-path");
    }
    fs.writeFileSync(descriptor, token, "utf8");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        /* The primary lock failure is reported below. */
      }
      descriptor = null;
    }
    if (error instanceof CoordinationError) throw error;
    if (errorCode(error) === "EEXIST") {
      throw new CoordinationError("store-locked");
    }
    throw new CoordinationError("store-io");
  }
  try {
    const lockDescriptor = descriptor;
    if (lockDescriptor === null) throw new CoordinationError("store-io");
    descriptor = null;
    try {
      fs.closeSync(lockDescriptor);
    } catch {
      throw new CoordinationError("store-io");
    }
    return action();
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        /* A write error remains the primary result. */
      }
    }
    try {
      const lockTarget = safeTarget(root, target);
      const readDescriptor = fs.openSync(
        lockTarget,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      let ownsLock = false;
      try {
        const stat = fs.fstatSync(readDescriptor);
        ownsLock =
          stat.isFile() &&
          stat.nlink === 1 &&
          fs.readFileSync(readDescriptor, { encoding: "utf8" }) === token;
      } finally {
        fs.closeSync(readDescriptor);
      }
      if (ownsLock) fs.unlinkSync(safeTarget(root, target));
    } catch {
      /* A leftover lock is visible and is never removed unless it is ours. */
    }
  }
}

export function readCoordinationJournal(root: string): CoordinationJournal {
  const file = path.join(path.resolve(root), ...STORE_FILE.split("/"));
  const target = safeTarget(root, file);
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { events: [], bytes: 0, lastHash: COORDINATION_GENESIS_HASH };
    }
    throw new CoordinationError("store-io");
  }

  let content: string;
  let byteLength: number;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new CoordinationError("unsafe-path");
    }
    if (stat.size > COORDINATION_MAX_LOG_BYTES) {
      throw new CoordinationError("store-limit");
    }
    byteLength = stat.size;
    content = fs.readFileSync(descriptor, { encoding: "utf8" });
  } catch (error) {
    if (error instanceof CoordinationError) throw error;
    throw new CoordinationError("store-io");
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch {
      /* Read failures are reported by the original operation. */
    }
  }

  if (content.length === 0) {
    return {
      events: [],
      bytes: byteLength,
      lastHash: COORDINATION_GENESIS_HASH,
    };
  }
  if (!content.endsWith("\n")) {
    const lockPath = path.join(path.resolve(root), ...LOCK_FILE.split("/"));
    if (fs.existsSync(lockPath)) throw new CoordinationError("store-locked");
    throw new CoordinationError("store-corrupt");
  }

  const lines = content.slice(0, -1).split("\n");
  if (lines.length > COORDINATION_MAX_LOG_EVENTS) {
    throw new CoordinationError("store-limit");
  }
  let lastHash = COORDINATION_GENESIS_HASH;
  const events: CoordinationEvent[] = [];
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > COORDINATION_MAX_EVENT_BYTES) {
      throw new CoordinationError("store-corrupt");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new CoordinationError("store-corrupt");
    }
    const envelopeResult = coordinationEnvelopeSchema.safeParse(parsed);
    if (!envelopeResult.success) throw new CoordinationError("store-corrupt");
    const envelope: CoordinationEnvelope = envelopeResult.data;
    if (
      envelope.previous_hash !== lastHash ||
      coordinationEventHash(lastHash, envelope.event) !== envelope.hash
    ) {
      throw new CoordinationError("store-corrupt");
    }
    events.push(envelope.event);
    lastHash = envelope.hash;
  }
  return { events, bytes: byteLength, lastHash };
}

export function appendCoordinationEnvelope(
  root: string,
  journal: CoordinationJournal,
  event: CoordinationEvent,
): void {
  const envelope: CoordinationEnvelope = {
    schema_version: 1,
    previous_hash: journal.lastHash,
    hash: coordinationEventHash(journal.lastHash, event),
    event,
  };
  const line = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
  if (line.byteLength > COORDINATION_MAX_EVENT_BYTES) {
    throw new CoordinationError("store-limit");
  }
  if (
    journal.events.length >= COORDINATION_MAX_LOG_EVENTS ||
    journal.bytes + line.byteLength > COORDINATION_MAX_LOG_BYTES
  ) {
    throw new CoordinationError("store-limit");
  }
  const file = path.join(path.resolve(root), ...STORE_FILE.split("/"));
  const target = safeTarget(root, file);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_WRONLY |
        fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new CoordinationError("unsafe-path");
    }
    if (stat.size !== journal.bytes) {
      throw new CoordinationError("state-conflict");
    }
    safeTarget(root, target);
    let offset = 0;
    while (offset < line.byteLength) {
      const written = fs.writeSync(
        descriptor,
        line,
        offset,
        line.byteLength - offset,
        null,
      );
      if (written < 1) throw new CoordinationError("store-io");
      offset += written;
    }
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof CoordinationError) throw error;
    throw new CoordinationError("store-io");
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        /* A committed journal line has already been synced. */
      }
    }
  }
}
