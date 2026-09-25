import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TaskRunWorkspaceManagerBinding } from "../../core/task/task-kernel-types.js";
import { assertNoSymlinkBetween, pathKey, pathWithin } from "./git-probe.js";
import {
  WorktreeManagerError,
  type GitIdentity,
  type ManagerProvenance,
  type RunWorkspaceBinding,
} from "./manager-types.js";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

export function provenanceRoot(identity: GitIdentity, create: boolean): string | null {
  const root = path.join(identity.commonDir, "pactile-run-workspaces-v1");
  assertNoSymlinkBetween(identity.commonDir, root);
  if (create) fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(root)) return null;
  assertNoSymlinkBetween(identity.commonDir, root);
  const real = fs.realpathSync(root);
  if (pathKey(real) !== pathKey(root)) throw new WorktreeManagerError("manager-provenance-invalid", "Manager provenance directory resolves through an alias", root);
  if (!fs.statSync(real).isDirectory()) throw new WorktreeManagerError("manager-provenance-invalid", "Manager provenance location is not a directory", root);
  return real;
}

function validManagerProvenance(value: unknown): value is ManagerProvenance {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ManagerProvenance>;
  return record.version === 1 && typeof record.credentialId === "string" && !!record.credentialId
    && typeof record.ownerRunId === "string" && RUN_ID.test(record.ownerRunId)
    && typeof record.canonicalPath === "string" && path.isAbsolute(record.canonicalPath)
    && typeof record.projectRoot === "string" && path.isAbsolute(record.projectRoot)
    && typeof record.commonDir === "string" && path.isAbsolute(record.commonDir)
    && typeof record.gitDir === "string" && path.isAbsolute(record.gitDir)
    && typeof record.branch === "string" && !!record.branch
    && typeof record.baseSha === "string" && SHA.test(record.baseSha)
    && Array.isArray(record.writeSet) && record.writeSet.every((item) => typeof item === "string")
    && (record.source === "created" || record.source === "adopted")
    && typeof record.recordedAt === "string" && !!record.recordedAt;
}

export function readAllManagerProvenance(identity: GitIdentity): ManagerProvenance[] {
  const root = provenanceRoot(identity, false);
  if (!root) return [];
  return fs.readdirSync(root).filter((name) => name.endsWith(".json")).map((name) => {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new WorktreeManagerError("manager-provenance-invalid", "Manager provenance record is not a regular file", file);
    }
    const real = fs.realpathSync(file);
    if (!pathWithin(root, real) || pathKey(real) !== pathKey(file)) {
      throw new WorktreeManagerError("manager-provenance-invalid", "Manager provenance record resolves outside its registry", file);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(real, "utf8")) as unknown; }
    catch { throw new WorktreeManagerError("manager-provenance-invalid", "Manager provenance record is unreadable", file); }
    if (!validManagerProvenance(parsed) || name !== `${parsed.ownerRunId}.json`) {
      throw new WorktreeManagerError("manager-provenance-invalid", "Manager provenance record is malformed", file);
    }
    return parsed;
  });
}

export function persistManagerProvenance(identity: GitIdentity, provenance: ManagerProvenance): void {
  const root = provenanceRoot(identity, true);
  if (!root) throw new WorktreeManagerError("manager-provenance-invalid", "Manager provenance directory is unavailable");
  const existing = readAllManagerProvenance(identity);
  if (existing.some((item) => pathKey(item.canonicalPath) === pathKey(provenance.canonicalPath))) {
    throw new WorktreeManagerError("owner-conflict", "Worktree already has a manager ownership record", provenance.canonicalPath);
  }
  const file = path.join(root, `${provenance.ownerRunId}.json`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } catch {
    throw new WorktreeManagerError("manager-provenance-write-failed", "Could not persist manager ownership evidence", provenance.canonicalPath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function provenanceFor(input: {
  identity: GitIdentity;
  binding: RunWorkspaceBinding;
  gitDir: string;
  source: "created" | "adopted";
  adoption?: { approvedBy: string; approvedAt: string; evidenceRef: string };
}): ManagerProvenance {
  return {
    version: 1,
    credentialId: randomUUID(),
    ownerRunId: input.binding.ownerRunId,
    canonicalPath: input.binding.canonicalPath,
    projectRoot: input.identity.root,
    commonDir: input.identity.commonDir,
    gitDir: input.gitDir,
    branch: input.binding.branch,
    baseSha: input.binding.baseSha,
    writeSet: [...input.binding.writeSet],
    source: input.source,
    recordedAt: new Date().toISOString(),
    ...(input.adoption ? { adoption: input.adoption } : {}),
  };
}

export function taskKernelManagerBinding(provenance: ManagerProvenance): TaskRunWorkspaceManagerBinding {
  return {
    version: 1,
    credentialId: provenance.credentialId,
    projectRoot: provenance.projectRoot,
    commonDir: provenance.commonDir,
    gitDir: provenance.gitDir,
    source: provenance.source,
    recordedAt: provenance.recordedAt,
  };
}
