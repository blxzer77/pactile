import fs from "node:fs";
import path from "node:path";

import { readKernel, type PactileTaskRecord } from "../../core/task/index.js";
import { readDependencyGraph, unmetRequires } from "../../core/task/ondemand-topology.js";
import { dependencyStatus } from "../../core/task/start-authority.js";
import { checkStartExecution } from "./guards.js";
import { resolveTaskDir } from "./session.js";

/** Shared Execute authority for optional hosts. Role and workdir policy stay with each host. */
export function approvedExecuteTask(root: string, reference: string): string {
  const dir = resolveTaskDir(root, reference);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Task not found: ${reference}`);
  const { kernel } = readKernel({ taskDir: dir, cwd: root });
  if (kernel.phase !== "execute" || kernel.projection?.status !== "in_progress") {
    throw new Error("Dispatch requires an approved task in Kernel Execute phase");
  }
  const approval = kernel.projection.extras.execution_approval;
  if (!approval || typeof approval !== "object" || (approval as Record<string, unknown>).approved_by !== "user") {
    throw new Error("Dispatch requires recorded user execution approval");
  }
  const stamp = approval as Record<string, unknown>;
  const live: unknown = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
  if (!live || typeof live !== "object" || Array.isArray(live)) throw new Error("Task projection is invalid");
  const planning = { ...live as PactileTaskRecord, status: "planning" } as PactileTaskRecord;
  if (stamp.task_id !== undefined && stamp.task_id !== planning.id) throw new Error("Execution approval belongs to another task");
  const extras = kernel.projection.extras;
  const missing = unmetRequires(readDependencyGraph(extras), dependencyStatus(root, dir, planning).satisfied, planning.id);
  const override = extras.dependency_override && typeof extras.dependency_override === "object"
    ? extras.dependency_override as Record<string, unknown> : null;
  const waived = override?.approved_by === "user" && override.transition === "start-execution" && Array.isArray(override.dependencies)
    ? override.dependencies.filter((item): item is string => typeof item === "string") : [];
  const ignoreDeps = missing.length > 0 && missing.every((item) => waived.includes(item));
  const guard = checkStartExecution(root, dir, planning, false, ignoreDeps);
  if (stamp.contract_fingerprint !== guard.contractFingerprint || stamp.artifact_fingerprint !== guard.artifactFingerprint) {
    throw new Error("Execution contract changed after approval; return to Define and renew approval");
  }
  if (!guard.ok) throw new Error(`Execution authority no longer valid: ${guard.errors.join("; ")}`);
  return dir;
}
