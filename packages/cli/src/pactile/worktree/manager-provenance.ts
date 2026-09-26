import { createHash, randomUUID } from "node:crypto";
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
const OWNERSHIP_PROTOCOL = "canonical-path-index-v1" as const;

interface CanonicalPathOwnershipIndex {
  version: 1;
  protocol: typeof OWNERSHIP_PROTOCOL;
  pathHash: string;
  canonicalPath: string;
  ownerRunId: string;
  credentialId: string;
  projectRoot: string;
  commonDir: string;
  gitDir: string;
  branch: string;
}

function pathHash(canonicalPath: string): string {
  return createHash("sha256").update(pathKey(canonicalPath), "utf8").digest("hex");
}

function pathIndexRoot(identity: GitIdentity, create: boolean): string | null {
  const root = provenanceRoot(identity, create);
  if (!root) return null;
  const candidate = path.join(root, "paths");
  assertNoSymlinkBetween(root, candidate);
  if (create) fs.mkdirSync(candidate, { recursive: true });
  if (!fs.existsSync(candidate)) return null;
  assertNoSymlinkBetween(root, candidate);
  const real = fs.realpathSync(candidate);
  if (pathKey(real) !== pathKey(candidate) || !fs.statSync(real).isDirectory()) {
    throw new WorktreeManagerError("manager-provenance-invalid", "Manager path index resolves outside its registry", candidate);
  }
  return real;
}

function validPathIndex(value: unknown, file: string, canonicalPath: string): value is CanonicalPathOwnershipIndex {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CanonicalPathOwnershipIndex>;
  return record.version === 1 && record.protocol === OWNERSHIP_PROTOCOL
    && typeof record.pathHash === "string" && /^[a-f0-9]{64}$/.test(record.pathHash)
    && record.pathHash === pathHash(canonicalPath) && path.basename(file) === `${record.pathHash}.json`
    && typeof record.canonicalPath === "string" && path.isAbsolute(record.canonicalPath)
    && pathKey(record.canonicalPath) === pathKey(canonicalPath)
    && typeof record.ownerRunId === "string" && RUN_ID.test(record.ownerRunId)
    && typeof record.credentialId === "string" && !!record.credentialId
    && typeof record.projectRoot === "string" && path.isAbsolute(record.projectRoot)
    && typeof record.commonDir === "string" && path.isAbsolute(record.commonDir)
    && typeof record.gitDir === "string" && path.isAbsolute(record.gitDir)
    && typeof record.branch === "string" && !!record.branch;
}

function readPathIndex(identity: GitIdentity, canonicalPath: string): CanonicalPathOwnershipIndex | null {
  const root = pathIndexRoot(identity, false);
  if (!root) return null;
  const file = path.join(root, `${pathHash(canonicalPath)}.json`);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new WorktreeManagerError("manager-provenance-invalid", "Manager path index is not a regular file", file);
  }
  const real = fs.realpathSync(file);
  if (!pathWithin(root, real) || pathKey(real) !== pathKey(file)) {
    throw new WorktreeManagerError("manager-provenance-invalid", "Manager path index resolves outside its registry", file);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(real, "utf8")) as unknown; }
  catch { throw new WorktreeManagerError("manager-provenance-invalid", "Manager path index is unreadable", file); }
  if (!validPathIndex(parsed, file, canonicalPath)) {
    throw new WorktreeManagerError("manager-provenance-invalid", "Manager path index is malformed or mismatched", file);
  }
  return parsed;
}

function pathIndexFor(provenance: ManagerProvenance): CanonicalPathOwnershipIndex {
  return {
    version: 1,
    protocol: OWNERSHIP_PROTOCOL,
    pathHash: pathHash(provenance.canonicalPath),
    canonicalPath: provenance.canonicalPath,
    ownerRunId: provenance.ownerRunId,
    credentialId: provenance.credentialId,
    projectRoot: provenance.projectRoot,
    commonDir: provenance.commonDir,
    gitDir: provenance.gitDir,
    branch: provenance.branch,
  };
}

function samePathIndex(index: CanonicalPathOwnershipIndex, provenance: ManagerProvenance): boolean {
  return index.ownerRunId === provenance.ownerRunId
    && index.credentialId === provenance.credentialId
    && pathKey(index.canonicalPath) === pathKey(provenance.canonicalPath)
    && pathKey(index.projectRoot) === pathKey(provenance.projectRoot)
    && pathKey(index.commonDir) === pathKey(provenance.commonDir)
    && pathKey(index.gitDir) === pathKey(provenance.gitDir)
    && index.branch === provenance.branch;
}

function writeExclusiveJson(file: string, value: unknown): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* keep the original write error */ }
      descriptor = undefined;
      try { fs.unlinkSync(file); } catch { /* an incomplete record is left fail-closed */ }
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function removeOwnedRecord(file: string, provenance: ManagerProvenance): void {
  try {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) return;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ManagerProvenance>;
    if (parsed.ownerRunId === provenance.ownerRunId && parsed.credentialId === provenance.credentialId) fs.unlinkSync(file);
  } catch { /* leave any uncertain ownership record for fail-closed recovery */ }
}

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
    && typeof record.recordedAt === "string" && !!record.recordedAt
    && (record.ownershipProtocol === undefined || record.ownershipProtocol === OWNERSHIP_PROTOCOL);
}

export function readAllManagerProvenance(identity: GitIdentity): ManagerProvenance[] {
  const root = provenanceRoot(identity, false);
  if (!root) return [];
  const records = fs.readdirSync(root).filter((name) => name.endsWith(".json")).map((name) => {
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
    if (parsed.ownershipProtocol === OWNERSHIP_PROTOCOL) {
      const index = readPathIndex(identity, parsed.canonicalPath);
      if (!index || !samePathIndex(index, parsed)) {
        throw new WorktreeManagerError("manager-provenance-invalid", "Run provenance does not match its canonical-path ownership index", file);
      }
    }
    return parsed;
  });
  const ownersByRun = new Map<string, ManagerProvenance>();
  const ownersByPath = new Map<string, ManagerProvenance>();
  for (const record of records) {
    const priorRun = ownersByRun.get(record.ownerRunId);
    if (priorRun && pathKey(priorRun.canonicalPath) !== pathKey(record.canonicalPath)) {
      throw new WorktreeManagerError("owner-conflict", "One Run has multiple manager-owned worktree paths", record.canonicalPath);
    }
    const key = pathKey(record.canonicalPath);
    const priorPath = ownersByPath.get(key);
    if (priorPath && priorPath.ownerRunId !== record.ownerRunId) {
      throw new WorktreeManagerError("owner-conflict", "One canonical Git worktree path has multiple Run owners", record.canonicalPath);
    }
    ownersByRun.set(record.ownerRunId, record);
    ownersByPath.set(key, record);
  }
  return records;
}

export function persistManagerProvenance(identity: GitIdentity, provenance: ManagerProvenance): void {
  const root = provenanceRoot(identity, true);
  if (!root) throw new WorktreeManagerError("manager-provenance-invalid", "Manager provenance directory is unavailable");
  const existing = readAllManagerProvenance(identity);
  if (existing.some((item) => item.ownerRunId === provenance.ownerRunId)) {
    throw new WorktreeManagerError("owner-conflict", "Run already has a manager ownership record", provenance.canonicalPath);
  }
  if (existing.some((item) => pathKey(item.canonicalPath) === pathKey(provenance.canonicalPath))) {
    throw new WorktreeManagerError("owner-conflict", "Worktree already has a manager ownership record", provenance.canonicalPath);
  }
  const file = path.join(root, `${provenance.ownerRunId}.json`);
  const pathProvenance: ManagerProvenance = { ...provenance, ownershipProtocol: OWNERSHIP_PROTOCOL };
  const indexRoot = pathIndexRoot(identity, true);
  if (!indexRoot) throw new WorktreeManagerError("manager-provenance-invalid", "Manager path index directory is unavailable");
  const indexFile = path.join(indexRoot, `${pathHash(pathProvenance.canonicalPath)}.json`);
  let ownerRecordWritten = false;
  try {
    writeExclusiveJson(file, pathProvenance);
    ownerRecordWritten = true;
    try {
      writeExclusiveJson(indexFile, pathIndexFor(pathProvenance));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        throw new WorktreeManagerError("owner-conflict", "Canonical Git worktree path already has a manager ownership reservation", provenance.canonicalPath);
      }
      throw error;
    }
  } catch (error) {
    if (ownerRecordWritten) removeOwnedRecord(file, pathProvenance);
    if (error instanceof WorktreeManagerError) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new WorktreeManagerError("owner-conflict", "Run already has a manager ownership record", provenance.canonicalPath);
    }
    throw new WorktreeManagerError("manager-provenance-write-failed", "Could not persist manager ownership evidence", provenance.canonicalPath);
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
    ownershipProtocol: OWNERSHIP_PROTOCOL,
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
