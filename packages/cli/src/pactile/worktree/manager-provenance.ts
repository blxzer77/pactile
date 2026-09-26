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

function samePathIndexExceptGitDir(index: CanonicalPathOwnershipIndex, provenance: ManagerProvenance): boolean {
  return samePathIndex({ ...index, gitDir: provenance.gitDir }, provenance);
}

function sameManagerProvenanceExceptGitDir(left: ManagerProvenance, right: ManagerProvenance): boolean {
  return left.version === right.version
    && left.credentialId === right.credentialId
    && left.ownerRunId === right.ownerRunId
    && pathKey(left.canonicalPath) === pathKey(right.canonicalPath)
    && pathKey(left.projectRoot) === pathKey(right.projectRoot)
    && pathKey(left.commonDir) === pathKey(right.commonDir)
    && left.branch === right.branch
    && left.baseSha.toLowerCase() === right.baseSha.toLowerCase()
    && left.writeSet.length === right.writeSet.length
    && left.writeSet.every((item, index) => item === right.writeSet[index])
    && left.source === right.source
    && left.recordedAt === right.recordedAt
    && left.ownershipProtocol === right.ownershipProtocol
    && JSON.stringify(left.adoption ?? null) === JSON.stringify(right.adoption ?? null);
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

function readManagerProvenanceRecords(identity: GitIdentity, allowGitDirMismatchForRun?: string): ManagerProvenance[] {
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
      const matches = index && (samePathIndex(index, parsed)
        || (parsed.ownerRunId === allowGitDirMismatchForRun && samePathIndexExceptGitDir(index, parsed)));
      if (!matches) {
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

export function readAllManagerProvenance(identity: GitIdentity): ManagerProvenance[] {
  return readManagerProvenanceRecords(identity);
}

function writeReplacementJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } catch {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the replacement failure */ }
      descriptor = undefined;
    }
    try { fs.unlinkSync(temporary); } catch { /* keep any uncertain registry state fail-closed */ }
    throw new WorktreeManagerError("manager-provenance-write-failed", "Could not persist recovered worktree Git-directory evidence", file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function replaceManagerProvenancePair(
  identity: GitIdentity,
  updated: ManagerProvenance,
  allowedGitDirs: readonly string[],
): void {
  const root = provenanceRoot(identity, false);
  if (!root) throw new WorktreeManagerError("manager-provenance-invalid", "Manager provenance directory is unavailable");
  const records = readManagerProvenanceRecords(identity, updated.ownerRunId);
  const matches = records.filter((record) => record.ownerRunId === updated.ownerRunId);
  const old = matches[0];
  if (matches.length !== 1 || !old || !sameManagerProvenanceExceptGitDir(old, updated)) {
    throw new WorktreeManagerError("manager-provenance-invalid", "Recovered manager provenance no longer matches the same Run and credential", updated.canonicalPath);
  }
  const indexRoot = pathIndexRoot(identity, false);
  const index = readPathIndex(identity, old.canonicalPath);
  if (!indexRoot || !index || !samePathIndexExceptGitDir(index, old)) {
    throw new WorktreeManagerError("manager-provenance-invalid", "Recovered manager path index no longer matches its Run provenance", old.canonicalPath);
  }
  const allowed = new Set(allowedGitDirs.map((value) => pathKey(value)));
  if (!allowed.has(pathKey(old.gitDir)) || !allowed.has(pathKey(index.gitDir)) || !allowed.has(pathKey(updated.gitDir))) {
    throw new WorktreeManagerError("manager-provenance-invalid", "Recovered Git-directory change does not match the recorded Run state", old.canonicalPath);
  }
  const ownerFile = path.join(root, `${updated.ownerRunId}.json`);
  const ownerStat = fs.lstatSync(ownerFile, { throwIfNoEntry: false });
  if (!ownerStat?.isFile() || ownerStat.isSymbolicLink() || pathKey(fs.realpathSync(ownerFile)) !== pathKey(ownerFile)) {
    throw new WorktreeManagerError("manager-provenance-invalid", "Existing Run provenance file is not safe to update", ownerFile);
  }
  const indexFile = path.join(indexRoot, `${pathHash(updated.canonicalPath)}.json`);
  const indexStat = fs.lstatSync(indexFile, { throwIfNoEntry: false });
  if (!indexStat?.isFile() || indexStat.isSymbolicLink() || pathKey(fs.realpathSync(indexFile)) !== pathKey(indexFile)) {
    throw new WorktreeManagerError("manager-provenance-invalid", "Existing canonical-path index is not safe to update", indexFile);
  }

  // Replace the index first. If a process stops before the owner file follows,
  // the recovery reader can prove and complete this one-field Git-directory transition.
  writeReplacementJson(indexFile, pathIndexFor(updated));
  writeReplacementJson(ownerFile, updated);
  const readBack = readAllManagerProvenance(identity).find((record) => record.ownerRunId === updated.ownerRunId);
  if (!readBack || !sameManagerProvenanceExceptGitDir(readBack, updated) || pathKey(readBack.gitDir) !== pathKey(updated.gitDir)) {
    throw new WorktreeManagerError("manager-provenance-write-failed", "Recovered manager ownership pair failed read-back verification", updated.canonicalPath);
  }
}

/**
 * Reconcile the manager owner and canonical-path records after Git recreates a
 * linked checkout with a different administrative Git directory. A partial
 * index-first replacement can be retried only while both records still bind the
 * same Run credential and the changed Git directory is either the Run's prior
 * value or the currently verified linked directory.
 */
export function synchronizeManagerProvenanceGitDir(input: {
  identity: GitIdentity;
  ownerRunId: string;
  credentialId: string;
  priorGitDir: string;
  actualGitDir: string;
}): ManagerProvenance {
  const records = readManagerProvenanceRecords(input.identity, input.ownerRunId);
  const matches = records.filter((record) => record.ownerRunId === input.ownerRunId);
  const owner = matches[0];
  if (matches.length !== 1 || owner?.credentialId !== input.credentialId) {
    throw new WorktreeManagerError("manager-provenance-invalid", "Recovered manager provenance does not match this Run credential");
  }
  const index = readPathIndex(input.identity, owner.canonicalPath);
  if (!index || !samePathIndexExceptGitDir(index, owner)) {
    throw new WorktreeManagerError("manager-provenance-invalid", "Recovered manager path index does not match this Run");
  }
  const allowedGitDirs = [input.priorGitDir, input.actualGitDir];
  const allowed = new Set(allowedGitDirs.map((value) => pathKey(value)));
  if (!allowed.has(pathKey(owner.gitDir)) || !allowed.has(pathKey(index.gitDir))) {
    throw new WorktreeManagerError("manager-provenance-invalid", "Recovered Git-directory records changed outside the verified restoration");
  }
  const updated = { ...owner, gitDir: input.actualGitDir };
  if (pathKey(owner.gitDir) !== pathKey(updated.gitDir) || pathKey(index.gitDir) !== pathKey(updated.gitDir)) {
    replaceManagerProvenancePair(input.identity, updated, allowedGitDirs);
  }
  const readBack = readAllManagerProvenance(input.identity).find((record) => record.ownerRunId === input.ownerRunId);
  if (readBack?.credentialId !== input.credentialId || pathKey(readBack.gitDir) !== pathKey(input.actualGitDir)) {
    throw new WorktreeManagerError("manager-provenance-write-failed", "Recovered manager Git-directory records are not synchronized");
  }
  return readBack;
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
