import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  canonicalizePactileJsonV1,
  fingerprintPactileContractV1,
} from "../../core/index.js";
import {
  assertCanonicalWriteTarget,
  resolveCanonicalPaths,
} from "../runtime/paths.js";

export type ExitAction = "detach" | "uninstall" | "rollback" | "purge";

/**
 * Intentionally path- and content-free. Command output may show a relative
 * preview, but the durable receipt must never retain project paths, file
 * bodies, credentials, or provider payloads.
 */
export interface ExitReceiptV1 {
  readonly schemaVersion: 1;
  readonly action: ExitAction;
  readonly generationId: string;
  readonly previousGenerationId: string | null;
  readonly adapterIds: readonly string[];
  readonly result: "applied" | "degraded";
  readonly evidenceFingerprint: string;
  readonly occurredAt: string;
}

export interface ExitReceiptSnapshot {
  readonly receipt: ExitReceiptV1;
  readonly fingerprint: string;
}

function safeReceiptTarget(projectRoot: string, fingerprint: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(fingerprint))
    throw new Error("invalid-exit-receipt-fingerprint");
  const receipts = resolveCanonicalPaths(projectRoot).receiptsPath;
  return assertCanonicalWriteTarget(
    projectRoot,
    path.join(receipts, `exit-${fingerprint.slice(7)}.json`),
  );
}

function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && left.equals(right);
}

/** Write-once, idempotent receipt storage under the canonical runtime root. */
export function writeExitReceipt(
  projectRoot: string,
  receipt: ExitReceiptV1,
): ExitReceiptSnapshot {
  const bytes = Buffer.from(canonicalizePactileJsonV1(receipt));
  const fingerprint = fingerprintPactileContractV1(receipt);
  const target = safeReceiptTarget(projectRoot, fingerprint);
  const parent = assertCanonicalWriteTarget(projectRoot, path.dirname(target));
  fs.mkdirSync(parent, { recursive: true });
  assertCanonicalWriteTarget(projectRoot, parent);

  try {
    const existing = fs.readFileSync(target);
    if (!sameBytes(existing, bytes)) throw new Error("exit-receipt-conflict");
    return { receipt, fingerprint };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }

  const temporary = assertCanonicalWriteTarget(
    projectRoot,
    `${target}.tmp-${randomUUID()}`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("unsafe-exit-receipt-target");
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertCanonicalWriteTarget(projectRoot, target);
    assertCanonicalWriteTarget(projectRoot, temporary);
    fs.renameSync(temporary, target);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch {
      // A residue is intentionally discoverable; never replace another file.
    }
  }
  return { receipt, fingerprint };
}
