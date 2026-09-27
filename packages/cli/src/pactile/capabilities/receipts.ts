import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { BoundedCapabilityReceiptV1 } from "../../core/index.js";
import {
  CapabilityNodeError,
  RECEIPT_ROOT,
  isInside,
  mapFilesystemError,
  sameFileIdentity,
} from "./shared.js";

export interface ReceiptDirectory {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

export interface ReceiptClaim {
  readonly path: string;
  readonly handle: Awaited<ReturnType<typeof fsp.open>>;
  readonly stat: fs.Stats;
}

export async function inspectReceiptDirectory(
  root: string,
  expected?: ReceiptDirectory,
): Promise<ReceiptDirectory> {
  const segments = RECEIPT_ROOT.split("/");
  let resolved = root;
  let stat: fs.Stats | null = null;
  for (let index = 0; index < segments.length; index += 1) {
    const lexical = path.join(root, ...segments.slice(0, index + 1));
    try {
      stat = await fsp.lstat(lexical);
      resolved = await fsp.realpath(lexical);
    } catch (error) {
      throw mapFilesystemError(error);
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !isInside(root, resolved)
    ) {
      throw new CapabilityNodeError(
        "OUT_OF_SCOPE",
        "Receipt directory must remain a real directory inside the workspace.",
      );
    }
  }
  if (!stat)
    throw new CapabilityNodeError(
      "NOT_FOUND",
      "Receipt directory is unavailable.",
    );
  if (
    expected &&
    (expected.path !== resolved ||
      expected.device !== stat.dev ||
      expected.inode !== stat.ino)
  ) {
    throw new CapabilityNodeError(
      "OUT_OF_SCOPE",
      "Receipt directory changed while the request was running.",
    );
  }
  return { path: resolved, device: stat.dev, inode: stat.ino };
}

export async function ensureReceiptDirectory(
  root: string,
): Promise<ReceiptDirectory> {
  for (let index = 0; index < RECEIPT_ROOT.split("/").length; index += 1) {
    const lexical = path.join(
      root,
      ...RECEIPT_ROOT.split("/").slice(0, index + 1),
    );
    try {
      await fsp.mkdir(lexical, { mode: 0o700 });
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code !== "EEXIST") throw mapFilesystemError(error);
    }
    // Check each newly observed parent before creating the next child.
    await inspectPartialReceiptDirectory(root, index + 1);
  }
  return inspectReceiptDirectory(root);
}

async function inspectPartialReceiptDirectory(
  root: string,
  segmentCount: number,
): Promise<void> {
  for (let index = 0; index < segmentCount; index += 1) {
    const lexical = path.join(
      root,
      ...RECEIPT_ROOT.split("/").slice(0, index + 1),
    );
    let stat: fs.Stats;
    let resolved: string;
    try {
      stat = await fsp.lstat(lexical);
      resolved = await fsp.realpath(lexical);
    } catch (error) {
      throw mapFilesystemError(error);
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !isInside(root, resolved)
    ) {
      throw new CapabilityNodeError(
        "OUT_OF_SCOPE",
        "Receipt directory must remain a real directory inside the workspace.",
      );
    }
  }
}

export async function writeReceipt(
  root: string,
  directory: ReceiptDirectory,
  claim: ReceiptClaim,
  receipt: BoundedCapabilityReceiptV1,
): Promise<void> {
  try {
    await inspectReceiptDirectory(root, directory);
    const [handleStat, fileStat, resolvedFile] = await Promise.all([
      claim.handle.stat(),
      fsp.lstat(claim.path),
      fsp.realpath(claim.path),
    ]);
    if (
      !sameFileIdentity(claim.stat, handleStat) ||
      !sameFileIdentity(handleStat, fileStat) ||
      fileStat.isSymbolicLink() ||
      !isInside(root, resolvedFile)
    ) {
      throw new CapabilityNodeError(
        "OUT_OF_SCOPE",
        "The receipt path changed before its result could be recorded.",
      );
    }
    await claim.handle.writeFile(JSON.stringify(receipt), "utf8");
  } finally {
    await claim.handle.close().catch(() => undefined);
  }
}
