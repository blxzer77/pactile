import fs from "node:fs";
import path from "node:path";
import { fingerprintTaskValue } from "../../core/task/index.js";
import {
  listProjectWriteLeases,
  withProjectSchedulerMutex,
} from "./project-lease-store.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasPermittedAdmissionReceipt(
  root: string,
  taskId: string,
  runId: string,
): boolean {
  const folder = path.join(
    root,
    ".pactile",
    ".runtime",
    "scheduler",
    "admissions",
  );
  if (!fs.existsSync(folder)) return false;

  for (const name of fs
    .readdirSync(folder)
    .filter((entry) => entry.endsWith(".json"))
    .sort()) {
    try {
      const value: unknown = JSON.parse(
        fs.readFileSync(path.join(folder, name), "utf8"),
      );
      if (!isRecord(value)) return true;
      const {
        schemaVersion,
        scope,
        receiptFingerprint,
        createdAt,
        ...base
      } = value;
      if (
        schemaVersion !== 1 ||
        scope !== "task-kernel-v2-run-admission" ||
        typeof receiptFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/u.test(receiptFingerprint) ||
        path.basename(name, ".json") !== receiptFingerprint ||
        typeof createdAt !== "string" ||
        fingerprintTaskValue(base) !== receiptFingerprint
      ) {
        return true;
      }
      const request = value.request;
      if (
        !isRecord(request) ||
        typeof request.taskId !== "string" ||
        typeof request.runId !== "string"
      ) {
        return true;
      }
      if (request.taskId !== taskId || request.runId !== runId) continue;
      if (value.decision === "permitted") return true;
      if (value.decision !== "rejected") return true;
    } catch {
      // An unreadable admission cannot prove that this Run was never admitted.
      return true;
    }
  }
  return false;
}

/**
 * Returns true when persisted scheduler state shows that this Run has already
 * crossed admission, still owns a project writer lease, or cannot be proven
 * not to have done so.
 */
export function hasActiveOrUncertainTaskRunDispatch(
  rootValue: string,
  taskId: string,
  runId: string,
): boolean {
  const root = path.resolve(rootValue);
  try {
    const leases = withProjectSchedulerMutex(root, () =>
      listProjectWriteLeases(root),
    );
    if (
      leases.some(
        ({ lease }) => lease.task_id === taskId && lease.run_id === runId,
      )
    ) {
      return true;
    }
    return hasPermittedAdmissionReceipt(root, taskId, runId);
  } catch {
    // An unreadable lease set is not safe evidence for dispatch eligibility.
    return true;
  }
}
