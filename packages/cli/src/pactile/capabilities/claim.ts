import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  CapabilityNodeError,
  RECEIPT_ROOT,
  isInside,
  mapFilesystemError,
  sameFileIdentity,
} from "./shared.js";
import { inspectReceiptDirectory } from "./receipts.js";
import type { ReceiptClaim, ReceiptDirectory } from "./receipts.js";

const MAX_PENDING_RECEIPT_CLAIMS = 32;

export async function claimRequestId(
  root: string,
  directory: ReceiptDirectory,
  requestId: string,
): Promise<ReceiptClaim> {
  await inspectReceiptDirectory(root, directory);
  const file = path.join(directory.path, `${requestId}.json`);
  try {
    await fsp.lstat(file);
    throw new CapabilityNodeError(
      "REQUEST_ID_REUSED",
      "This request id is in progress or has already been used.",
    );
  } catch (error) {
    if (error instanceof CapabilityNodeError) throw error;
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code !== "ENOENT") throw mapFilesystemError(error);
  }
  await assertPendingReceiptClaimCapacity(directory);
  await inspectReceiptDirectory(root, directory);
  const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
  const handle = await fsp.open(
    file,
    fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_WRONLY |
      noFollow,
    0o600,
  );
  try {
    const handleStat = await handle.stat();
    const fileStat = await fsp.lstat(file);
    await inspectReceiptDirectory(root, directory);
    const resolvedFile = await fsp.realpath(file);
    if (
      !handleStat.isFile() ||
      fileStat.isSymbolicLink() ||
      !sameFileIdentity(handleStat, fileStat) ||
      !isInside(root, resolvedFile)
    ) {
      throw new CapabilityNodeError(
        "OUT_OF_SCOPE",
        "The receipt file changed while its workspace boundary was being checked.",
      );
    }
    return { path: file, handle, stat: handleStat };
  } catch {
    await handle.close().catch(() => undefined);
    throw new CapabilityNodeError(
      "REQUEST_CLAIM_RETAINED",
      `Request id ${requestId} was reserved before receipt verification failed. The capability operation did not run, and its incomplete claim was retained. Retry with a new requestId, or confirm the receipt directory still resolves inside the workspace before inspecting ${RECEIPT_ROOT}/${requestId}.json; remove it only after confirming it is an empty regular file and no request is active.`,
    );
  }
}

async function assertPendingReceiptClaimCapacity(
  directory: ReceiptDirectory,
): Promise<void> {
  let pendingClaims = 0;
  let handle: fs.Dir | null = null;
  try {
    handle = await fsp.opendir(directory.path);
    for await (const entry of handle) {
      if (!entry.name.toLocaleLowerCase().endsWith(".json") || !entry.isFile())
        continue;
      try {
        const stat = await fsp.lstat(path.join(directory.path, entry.name));
        if (
          stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.size === 0 &&
          ++pendingClaims >= MAX_PENDING_RECEIPT_CLAIMS
        ) {
          throw new CapabilityNodeError(
            "REQUEST_CLAIM_LIMIT",
            `The receipt store already contains ${MAX_PENDING_RECEIPT_CLAIMS} incomplete empty claims. Inspect and resolve stale claims before retrying.`,
          );
        }
      } catch (error) {
        if (error instanceof CapabilityNodeError) throw error;
        const mapped = mapFilesystemError(error);
        if (mapped.code !== "NOT_FOUND") throw mapped;
      }
    }
  } catch (error) {
    if (error instanceof CapabilityNodeError) throw error;
    throw mapFilesystemError(error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
