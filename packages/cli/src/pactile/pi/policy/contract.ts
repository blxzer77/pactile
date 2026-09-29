import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import type { TaskKernelSnapshotV2, TaskRunV2 } from "../../../core/task/index.js";
import { observeGitRepositoryBaseline } from "../../../core/task/task-candidate-observer.js";
import { canonicalPiPath, insidePiPath, isPiProtectedWrite, type PiPathGrant } from "./paths.js";

const grant = z.strictObject({ path: z.string().min(1), kind: z.enum(["file", "directory"]) });
export const piRoleContractSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  taskId: z.string().min(1),
  taskRunId: z.string().nullable(),
  role: z.enum(["implement", "research", "check"]),
  cwd: z.string().min(1),
  workspaceIdentity: z.strictObject({ device: z.string(), inode: z.string(), git: z.strictObject({ headSha: z.string(), branch: z.string().nullable() }).nullable() }).nullable(),
  authorityFile: z.string().min(1),
  authorityFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  candidateSnapshotId: z.string().nullable(),
  candidateFingerprint: z.string().nullable(),
  reads: z.array(grant).min(1),
  writes: z.array(grant),
  scratch: grant,
  protectedRoots: z.array(z.string()).min(1),
  sourceGuards: z.array(z.strictObject({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) })),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  shell: z.enum(["deny", "isolated"]),
  backend: z.enum(["tool-policy", "docker"]),
  remoteGrants: z.array(z.strictObject({
    server: z.string().min(1), tool: z.string().min(1),
    actions: z.array(z.string()).optional(),
    arguments: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  })),
  relay: z.strictObject({ socketPath: z.string(), token: z.string(), modelOrigins: z.array(z.string()) }).nullable(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type PiRoleContract = z.infer<typeof piRoleContractSchema>;
export type PiWorkerRole = PiRoleContract["role"];

export function piFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** A cheap revocation check after the unified Kernel reader admitted the launch. */
export function piAuthorityFingerprint(value: unknown, runId: string | null): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pi authority is malformed");
  const kernel = value as Record<string, unknown>;
  if (runId === null) return piFingerprint(kernel);
  if (kernel.schemaVersion !== 2 || !Array.isArray(kernel.runs)) throw new Error("Pi authority no longer has the admitted Kernel schema");
  const run = kernel.runs.find((item: Record<string, unknown>) => item.id === runId) as Record<string, unknown> | undefined;
  if (!run) throw new Error("Pi authority Run is missing");
  return piFingerprint({
    identity: kernel.identity, definition: kernel.definition,
    phase: kernel.phase, condition: kernel.condition,
    latestRunId: (kernel.runs.at(-1) as Record<string, unknown> | undefined)?.id,
    run: { id: run.id, taskId: run.taskId, state: run.state, input: run.input,
      authorization: run.authorization, writeSetSnapshot: run.writeSetSnapshot,
      workspace: run.workspace, candidateSnapshot: run.candidateSnapshot },
  });
}

export function sealPiRoleContract(contract: Omit<PiRoleContract, "fingerprint">): PiRoleContract {
  return piRoleContractSchema.parse({ ...contract, fingerprint: piFingerprint(contract) });
}

export function piRolePermissionFingerprint(contract: PiRoleContract): string {
  const { id: _id, fingerprint: _fingerprint, issuedAt: _issuedAt, expiresAt: _expiresAt, ...permissions } = contract;
  return piFingerprint(permissions);
}

/** Reuse Core's stable Git baseline; file contents remain the candidate observer's responsibility. */
function workspaceIdentity(cwd: string): NonNullable<PiRoleContract["workspaceIdentity"]> {
  const stat = fs.statSync(cwd, { bigint: true });
  if (!stat.isDirectory() || stat.ino === 0n) throw new Error("Pi workspace has no observable directory identity");
  return { device: stat.dev.toString(), inode: stat.ino.toString(),
    git: fs.existsSync(path.join(cwd, ".git")) ? observeGitRepositoryBaseline(cwd) : null };
}

export function assertPiRoleContract(contract: PiRoleContract, now = Date.now()): void {
  piRoleContractSchema.parse(contract);
  const { fingerprint, ...body } = contract;
  if (piFingerprint(body) !== fingerprint) throw new Error("Pi role contract fingerprint changed");
  if (Date.parse(contract.issuedAt) > now + 5_000 || Date.parse(contract.expiresAt) <= now)
    throw new Error("Pi role contract is expired or not yet valid");
  if (canonicalPiPath(contract.cwd, contract.cwd) !== contract.cwd)
    throw new Error("Pi role workspace identity changed");
  if (contract.workspaceIdentity) {
    if (piFingerprint(workspaceIdentity(contract.cwd)) !== piFingerprint(contract.workspaceIdentity))
      throw new Error("Pi role workspace identity or Git baseline changed; obtain a fresh contract");
  } else if (contract.backend !== "docker" || !contract.relay) {
    throw new Error("Pi role workspace identity is missing");
  }
  const live: unknown = JSON.parse(fs.readFileSync(contract.authorityFile, "utf8"));
  if (piAuthorityFingerprint(live, contract.taskRunId) !== contract.authorityFingerprint)
    throw new Error("Pi Task/Run authority changed; obtain a fresh contract");
  for (const guard of contract.sourceGuards) {
    if (createHash("sha256").update(fs.readFileSync(guard.path)).digest("hex") !== guard.sha256)
      throw new Error("Pi approved source contract changed");
  }
  if (contract.role !== "implement" && contract.writes.length)
    throw new Error("Readonly Pi roles cannot receive product writes");
  if ((contract.shell === "isolated") !== (contract.backend === "docker"))
    throw new Error("Pi Shell requires the admitted whole-process backend");
  if (insidePiPath(contract.cwd, contract.scratch.path) || insidePiPath(contract.scratch.path, contract.cwd)
    || insidePiPath(contract.authorityFile, contract.scratch.path)
    || contract.protectedRoots.some((root) => insidePiPath(contract.scratch.path, root)))
    throw new Error("Pi scratch overlaps a source or protected authority scope");
  for (const write of contract.writes) {
    if (!insidePiPath(write.path, contract.cwd) || isPiProtectedWrite(write.path, contract.cwd, contract.protectedRoots, contract.taskRunId !== null))
      throw new Error("Pi role contract contains a protected product write");
    if (insidePiPath(contract.authorityFile, write.path))
      throw new Error("Pi authority cannot be in a writable scope");
  }
}

export function buildPiRoleContract(input: {
  root: string; taskDir: string; workdir: string; role: PiWorkerRole;
  scratchDir: string; timeoutMs: number; writeSet: string[];
  kernel?: TaskKernelSnapshotV2; run?: TaskRunV2;
  /** Trusted local resource configuration, never supplied by a model recommendation. */
  resourceRoots?: string[];
}): PiRoleContract {
  const cwd = canonicalPiPath(input.workdir, input.workdir);
  const taskDir = canonicalPiPath(input.taskDir, input.taskDir);
  const authorityFile = path.join(taskDir, input.run ? "kernel.json" : "task.json");
  const authority: unknown = JSON.parse(fs.readFileSync(authorityFile, "utf8"));
  if (input.run && (input.kernel?.identity.taskId !== input.run.taskId || input.run.workspace?.ownerRunId && input.run.workspace.ownerRunId !== input.run.id))
    throw new Error("Pi role contract requires the current Kernel Run binding");
  if (input.run?.workspace && canonicalPiPath(input.run.workspace.canonicalPath, input.run.workspace.canonicalPath) !== cwd)
    throw new Error("Pi role contract workspace differs from the registered Run");
  if (input.run && input.kernel && piAuthorityFingerprint(input.kernel, input.run.id) !== piAuthorityFingerprint(authority, input.run.id))
    throw new Error("Pi role contract Kernel facts changed after admission");
  if (input.kernel && ((input.role === "implement" && input.kernel.phase !== "execute") || (input.role === "check" && input.kernel.phase !== "verify")))
    throw new Error("Pi role contract Kernel phase does not admit this role");
  if (input.run && ((input.role === "implement" && input.run.state !== "running") || (input.role === "check" && (input.run.state !== "completed" || !input.run.candidateSnapshot))))
    throw new Error("Pi role contract Run is not eligible for this role");
  const reads: PiPathGrant[] = [{ path: cwd, kind: "directory" }, { path: taskDir, kind: "directory" }];
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  for (const resource of input.resourceRoots ?? [path.join(agentDir, "skills"), path.join(agentDir, "extensions"), path.join(agentDir, "npm"), path.join(os.homedir(), ".agents", "skills"), path.join(input.root, ".agents", "skills")]) {
    if (!fs.existsSync(resource)) continue;
    const target = canonicalPiPath(resource, resource);
    if (!reads.some((entry) => entry.path === target)) reads.push({ path: target, kind: fs.statSync(target).isDirectory() ? "directory" : "file" });
  }
  const writes: PiPathGrant[] = input.role === "implement" ? input.writeSet.map((reference) => {
    if (!reference || path.isAbsolute(reference) || reference.split(/[\\/]/u).includes("..") || /[*?]/u.test(reference))
      throw new Error("Pi write set requires bounded file or directory paths");
    const target = canonicalPiPath(reference, cwd);
    if (!insidePiPath(target, cwd) || target === cwd) throw new Error("Pi write set cannot grant the entire workspace");
    return { path: target, kind: fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() ? "directory" : "file" };
  }) : [];
  if (input.run && input.role === "implement") {
    const ceiling = input.run.writeSetSnapshot.map((reference) => {
      const target = canonicalPiPath(reference, cwd);
      return { path: target, kind: fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() ? "directory" as const : "file" as const };
    });
    if (writes.some((write) => !ceiling.some((limit) => limit.kind === "file" ? limit.path === write.path : insidePiPath(write.path, limit.path))))
      throw new Error("Pi role write set exceeds the approved Run snapshot");
  }
  const scratch = { path: canonicalPiPath(input.scratchDir, input.scratchDir), kind: "directory" as const };
  if (insidePiPath(scratch.path, cwd) || insidePiPath(scratch.path, taskDir)) throw new Error("Pi scratch must be outside the candidate and Task evidence");
  const verificationRefs = input.role === "check" ? input.run?.result?.evidenceRefs.filter((ref) => /^verify(?:-run[0-9]+)?\.md$/u.test(ref)) ?? [] : [];
  const sourceGuards = ["prd.md", "design.md", "implement.md", "approval.md", ...(input.role === "check" ? ["verify.md", ...verificationRefs] : [])]
    .map((name) => path.join(taskDir, name)).filter((file) => fs.existsSync(file))
    .map((file) => ({ path: file, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") }));
  const issuedAt = new Date();
  const contract = sealPiRoleContract({
    schemaVersion: 1, id: randomUUID(), taskId: input.run?.taskId ?? path.basename(taskDir), taskRunId: input.run?.id ?? null,
    role: input.role, cwd, workspaceIdentity: workspaceIdentity(cwd), authorityFile, authorityFingerprint: piAuthorityFingerprint(authority, input.run?.id ?? null),
    candidateSnapshotId: input.run?.candidateSnapshot?.id ?? null, candidateFingerprint: input.run?.candidateSnapshot?.fingerprint ?? null,
    reads, writes, scratch, protectedRoots: [canonicalPiPath(path.join(input.root, ".pactile"), input.root), taskDir, path.join(cwd, ".git"), path.join(cwd, ".pactile")],
    sourceGuards, issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + input.timeoutMs).toISOString(),
    shell: "deny", backend: "tool-policy", remoteGrants: [], relay: null,
  });
  assertPiRoleContract(contract);
  return contract;
}
