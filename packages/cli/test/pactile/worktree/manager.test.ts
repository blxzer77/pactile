import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskKernel, readTaskKernel, startTaskRun } from "../../../src/core/task/index.js";
import {
  adoptRunWorktree,
  createRunWorktree,
  createTaskRunWorktree,
  decideParallelWriteSets,
  inspectRunWorktree,
  planRunWorktreeCleanup,
  reconcileRunWorktree,
  reconcileTaskRunWorktree,
  verifyWorktreeIntegration,
  type RunResultEvidence,
  type RunWorkspaceBinding,
} from "../../../src/pactile/worktree/index.js";
import { repoIdentity } from "../../../src/pactile/worktree/git-probe.js";
import { persistManagerProvenance, provenanceFor, readAllManagerProvenance } from "../../../src/pactile/worktree/manager-provenance.js";
import { WorktreeManagerError } from "../../../src/pactile/worktree/manager-types.js";

const roots: string[] = [];
const fixturePrefix = "pactile-run-worktree-";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(/\r?\n$/, "");
}

function alternateCase(value: string): string {
  return value.replace(/[a-z]/gi, (letter) => letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase());
}

function hasRegisteredWorktree(root: string, target: string): boolean {
  const expected = path.resolve(target).replaceAll("\\", "/").toLowerCase();
  return git(root, "worktree", "list", "--porcelain").split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .some((line) => path.resolve(line.slice("worktree ".length)).replaceAll("\\", "/").toLowerCase() === expected);
}

function fixture(): { root: string; baseSha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), fixturePrefix));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Pactile Test");
  git(root, "config", "user.email", "pactile@example.invalid");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  fs.writeFileSync(path.join(root, "src", "base.ts"), "export const base = true;\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  git(root, "add", "README.md", ".gitignore", "src/base.ts");
  git(root, "commit", "-q", "-m", "base");
  return { root, baseSha: git(root, "rev-parse", "HEAD") };
}

function removeFixtures(): void {
  const tempRoot = path.resolve(os.tmpdir());
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    const relative = path.relative(tempRoot, resolved);
    if (path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)
      || path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith(fixturePrefix)) {
      throw new Error(`Refusing to recursively remove a non-fixture path: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

afterEach(removeFixtures);

function create(input: { root: string; baseSha: string; runId?: string; writeSet?: string[] }): RunWorkspaceBinding {
  return createRunWorktree({
    repoRoot: input.root,
    runId: input.runId ?? "run-one",
    branch: `feat/${input.runId ?? "run-one"}`,
    baseRef: input.baseSha,
    writeSet: input.writeSet ?? ["src"],
    knownOwners: [],
  });
}

function startKernelRun(root: string, taskId: string, writeSetSnapshot: string[]): { taskDir: string; runId: string } {
  const taskDir = path.join(root, ".pactile", "tasks", taskId);
  const created = createTaskKernel({
    root, taskDir, actor: "author", idempotencyKey: `create:${taskId}`,
    definition: {
      taskId, title: "Managed worktree write-set test", description: "", deliverable: "an isolated checkout",
      deliveryLevel: "local-result", acceptanceCriteria: [{ id: "AC-1", description: "Run scope is bound" }], dependencies: [],
    },
  });
  const started = startTaskRun({
    root, taskDir, expectedRevision: created.kernel.revision, actor: "runner", idempotencyKey: `start:${taskId}`,
    input: { summary: "Create a scoped worktree", references: [] },
    authorization: { approvedBy: "approver", approvedAt: "2026-09-27T00:00:00.000Z", scope: "src", evidenceRef: "approval:manager-test" },
    writeSetSnapshot,
  });
  const runId = started.kernel.runs.at(-1)?.id;
  if (!runId) throw new Error("Started Run is missing");
  return { taskDir, runId };
}

function result(runId: string): RunResultEvidence {
  return { runId, summary: "Run result saved", evidenceRefs: [`kernel://runs/${runId}/result`] };
}

function commitRunChange(binding: RunWorkspaceBinding, relativePath = "src/feature.ts"): void {
  const file = path.join(binding.canonicalPath, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "export const delivered = true;\n");
  git(binding.canonicalPath, "add", "--", relativePath);
  git(binding.canonicalPath, "commit", "-q", "-m", "Run result");
}

function mergeRun(root: string, binding: RunWorkspaceBinding): void {
  git(root, "merge", "--no-ff", "--no-edit", binding.branch);
}

function integration(input: {
  root: string;
  binding: RunWorkspaceBinding;
  runId?: string;
  result?: RunResultEvidence | null;
}) {
  return verifyWorktreeIntegration({
    repoRoot: input.root,
    runId: input.runId ?? input.binding.ownerRunId,
    runState: "completed",
    binding: input.binding,
    knownOwners: [],
    targetRef: "HEAD",
    result: input.result === undefined ? result(input.runId ?? input.binding.ownerRunId) : input.result,
  });
}

function ownershipRegistry(root: string): string {
  const commonDir = path.resolve(root, git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  return path.join(commonDir, "pactile-run-workspaces-v1");
}

function expectManagerError(action: () => unknown, code: string): void {
  let caught: unknown;
  try { action(); }
  catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(WorktreeManagerError);
  expect(caught).toMatchObject({ code });
}

function ownerProvenance(input: {
  root: string; baseSha: string; runId: string; canonicalPath: string; branch: string;
}): ReturnType<typeof provenanceFor> {
  const identity = repoIdentity(input.root);
  const gitDir = git(input.canonicalPath, "rev-parse", "--absolute-git-dir");
  return provenanceFor({
    identity,
    binding: {
      ownerRunId: input.runId, canonicalPath: input.canonicalPath, branch: input.branch,
      baseSha: input.baseSha, writeSet: ["src"], integrationState: "not-integrated", reclamationState: "not-requested",
    },
    gitDir,
    source: "adopted",
    adoption: { approvedBy: "test-approver", approvedAt: "2026-09-26T00:00:00.000Z", evidenceRef: "test:adoption" },
  });
}

function spawnOwnershipClaim(input: {
  cliRoot: string; root: string; runId: string; canonicalPath: string; branch: string; baseSha: string; barrierDir: string;
}) {
  const fixture = path.join(
    input.cliRoot,
    ".tmp",
    "p31-script-build",
    "fixtures",
    "worktree-owner-claim.js",
  );
  const child = spawn(
    process.execPath,
    [
      fixture,
      input.cliRoot,
      input.root,
      input.runId,
      input.canonicalPath,
      input.branch,
      input.baseSha,
      input.barrierDir,
    ],
    { cwd: input.cliRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, completion };
}

function waitForReadyClaims(input: { children: ReturnType<typeof spawnOwnershipClaim>[]; barrierDir: string; runIds: string[] }): void {
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 15000;
  while (!input.runIds.every((runId) => fs.existsSync(path.join(input.barrierDir, runId + ".ready")))) {
    const exited = input.children.find(({ child }) => child.exitCode !== null);
    if (exited) throw new Error("Ownership claimant exited before the barrier: " + exited.child.exitCode);
    if (Date.now() > deadline) throw new Error("Ownership claimants did not reach the read barrier");
    Atomics.wait(waitCell, 0, 0, 10);
  }
}

describe("Run worktree manager", () => {
  it("atomically assigns one canonical checkout to one Run across two Node processes", async () => {
    const { root, baseSha } = fixture();
    const canonicalPath = path.join(root, ".pactile", "worktrees", "shared-checkout");
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    git(root, "worktree", "add", "--no-track", "-b", "feat/shared-checkout", canonicalPath, baseSha);
    const barrierDir = path.join(root, ".ownership-race-barrier");
    fs.mkdirSync(barrierDir);
    const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    expect(fs.existsSync(path.join(cliRoot, ".tmp/p31-script-build/fixtures/worktree-owner-claim.js"))).toBe(true);
    const runIds = ["run-race-a", "run-race-b"];
    const children = runIds.map((runId) => spawnOwnershipClaim({
      cliRoot, root, runId, canonicalPath, branch: "feat/shared-checkout", baseSha, barrierDir,
    }));

    try {
      waitForReadyClaims({ children, barrierDir, runIds });
      fs.writeFileSync(path.join(barrierDir, "go"), "go");
      const completed = await Promise.all(children.map(({ completion }) => completion));
      expect(completed.map(({ code }) => code), JSON.stringify(completed)).toEqual([0, 0]);
      const output = completed.map(({ stdout, stderr }) => `${stdout}\n${stderr}`).join("\n");
      expect((output.match(/CLAIMED:/g) ?? []).length, output).toBe(1);
      expect((output.match(/REJECTED:/g) ?? []).length, output).toBe(1);

      const records = readAllManagerProvenance(repoIdentity(root));
      expect(records).toHaveLength(1);
      expect(records[0]?.canonicalPath).toBe(canonicalPath);
      expect(records[0]?.ownershipProtocol).toBe("canonical-path-index-v1");
      const pathIndexFiles = fs.readdirSync(path.join(ownershipRegistry(root), "paths"))
        .filter((name) => name.endsWith(".json"));
      expect(pathIndexFiles).toHaveLength(1);
      expect(hasRegisteredWorktree(root, canonicalPath)).toBe(true);
    } finally {
      for (const { child } of children) if (child.exitCode === null) child.kill();
      await Promise.all(children.map(({ completion }) => completion));
    }
  });

  it("fails closed when a process crashes between the Run record and canonical-path index", () => {
    const { root, baseSha } = fixture();
    const binding = create({ root, baseSha });
    const registry = ownershipRegistry(root);
    const ownerRecord = path.join(registry, `${binding.ownerRunId}.json`);
    const pathIndexes = fs.readdirSync(path.join(registry, "paths")).filter((name) => name.endsWith(".json"));
    expect(pathIndexes).toHaveLength(1);
    fs.unlinkSync(path.join(registry, "paths", pathIndexes[0] as string));

    const inspection = inspectRunWorktree({
      repoRoot: root, runId: binding.ownerRunId, runState: "running", binding,
    });
    expect(inspection.state).toBe("manager-provenance-mismatch");
    expect(() => readAllManagerProvenance(repoIdentity(root))).toThrow(WorktreeManagerError);
    const competingClaim = ownerProvenance({
      root, baseSha, runId: "run-after-crash", canonicalPath: binding.canonicalPath, branch: binding.branch,
    });
    expect(() => persistManagerProvenance(repoIdentity(root), competingClaim)).toThrow(WorktreeManagerError);
    expect(fs.existsSync(ownerRecord)).toBe(true);
    expect(fs.existsSync(binding.canonicalPath)).toBe(true);
    expect(hasRegisteredWorktree(root, binding.canonicalPath)).toBe(true);
  });

  it("detects a pre-existing legacy duplicate owner and makes inspection fail closed", () => {
    const { root, baseSha } = fixture();
    const binding = create({ root, baseSha });
    const registry = ownershipRegistry(root);
    const primaryFile = path.join(registry, `${binding.ownerRunId}.json`);
    const duplicate = JSON.parse(fs.readFileSync(primaryFile, "utf8")) as Record<string, unknown>;
    duplicate.ownerRunId = "legacy-duplicate-owner";
    duplicate.credentialId = "legacy-duplicate-credential";
    delete duplicate.ownershipProtocol;
    fs.writeFileSync(path.join(registry, "legacy-duplicate-owner.json"), `${JSON.stringify(duplicate, null, 2)}\n`);

    expect(() => readAllManagerProvenance(repoIdentity(root))).toThrow(/multiple Run owners/);
    const inspection = inspectRunWorktree({
      repoRoot: root, runId: binding.ownerRunId, runState: "running", binding,
    });
    expect(inspection.state).toBe("manager-provenance-mismatch");
    expect(fs.existsSync(binding.canonicalPath)).toBe(true);
    expect(hasRegisteredWorktree(root, binding.canonicalPath)).toBe(true);
  });

  it("treats Windows case variants as the same canonical ownership path", () => {
    if (process.platform !== "win32") return;
    const { root, baseSha } = fixture();
    const binding = create({ root, baseSha });
    const secondClaim = ownerProvenance({
      root, baseSha, runId: "run-case-variant", canonicalPath: alternateCase(binding.canonicalPath), branch: binding.branch,
    });

    expect(() => persistManagerProvenance(repoIdentity(root), secondClaim)).toThrow(/already has a manager ownership record/);
    expect(readAllManagerProvenance(repoIdentity(root))).toHaveLength(1);
    expect(fs.readdirSync(path.join(ownershipRegistry(root), "paths")).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect(fs.existsSync(binding.canonicalPath)).toBe(true);
    expect(hasRegisteredWorktree(root, binding.canonicalPath)).toBe(true);
  });

  it("creates and verifies a registered checkout with explicit Run, branch, base SHA, and write set", () => {
    const { root, baseSha } = fixture();
    const binding = create({ root, baseSha });
    const inspection = inspectRunWorktree({ repoRoot: root, runId: binding.ownerRunId, runState: "running", binding, knownOwners: [] });

    expect(binding).toMatchObject({
      ownerRunId: "run-one", branch: "feat/run-one", baseSha,
      writeSet: ["src"], integrationState: "not-integrated", reclamationState: "not-requested",
    });
    expect(path.isAbsolute(binding.canonicalPath)).toBe(true);
    expect(path.relative(path.join(root, ".pactile", "worktrees"), binding.canonicalPath).startsWith("..")).toBe(false);
    expect(inspection).toMatchObject({ state: "unintegrated", actualPath: binding.canonicalPath, branch: binding.branch, headSha: baseSha });
    expect(inspection.issues).toEqual(["unintegrated"]);
    expect(git(root, "worktree", "list", "--porcelain")).toContain(`branch refs/heads/${binding.branch}`);
  });

  it("rejects an empty Task Kernel Run snapshot before creating a Git checkout or manager provenance", () => {
    const { root, baseSha } = fixture();
    const taskId = "run-empty-create";
    const { taskDir, runId } = startKernelRun(root, taskId, []);
    const canonicalPath = path.join(root, ".pactile", "worktrees", runId);

    expectManagerError(() => createTaskRunWorktree({
      repoRoot: root, taskDir, runId, branch: "feat/run-empty-create", baseRef: baseSha,
      actor: "runner", idempotencyKey: `workspace:${taskId}`,
    }), "invalid-write-set");

    expect(fs.existsSync(canonicalPath)).toBe(false);
    expect(hasRegisteredWorktree(root, canonicalPath)).toBe(false);
    expect(git(root, "branch", "--list", "feat/run-empty-create")).toBe("");
    expect(readAllManagerProvenance(repoIdentity(root))).toEqual([]);

    const read = readTaskKernel({ root, taskDir });
    expect(read?.kind).toBe("task-kernel-v2");
    if (read?.kind !== "task-kernel-v2") throw new Error("Task Kernel v2 was not preserved");
    expect(read.kernel.runs.at(-1)?.workspace).toBeNull();
    expect(read.kernel.events.some((event) => event.type === "run.workspace-claim-refused" && event.entityId === runId)).toBe(true);
    expect(read.kernel.events.some((event) => event.type === "run.workspace-bound" && event.entityId === runId)).toBe(false);
  });

  it("rejects empty write sets before adoption or reconciliation changes ownership", () => {
    const { root, baseSha } = fixture();
    const adoptedPath = path.join(root, ".pactile", "worktrees", "run-empty-adopt");
    fs.mkdirSync(path.dirname(adoptedPath), { recursive: true });
    git(root, "worktree", "add", "--no-track", "-b", "feat/run-empty-adopt", adoptedPath, baseSha);
    const registrationsBeforeAdoption = git(root, "worktree", "list", "--porcelain");
    const ownersBeforeAdoption = readAllManagerProvenance(repoIdentity(root));

    expectManagerError(() => adoptRunWorktree({
      repoRoot: root, runId: "run-empty-adopt", runState: "running", canonicalPath: adoptedPath,
      branch: "feat/run-empty-adopt", baseSha, writeSet: [], knownOwners: [],
      authorization: { approvedBy: "alice", approvedAt: "2026-09-25T10:00:00Z", evidenceRef: "approval:empty-adopt" },
    }), "invalid-write-set");

    expect(git(root, "worktree", "list", "--porcelain")).toBe(registrationsBeforeAdoption);
    expect(readAllManagerProvenance(repoIdentity(root))).toEqual(ownersBeforeAdoption);
    expect(hasRegisteredWorktree(root, adoptedPath)).toBe(true);

    const reconciled = create({ root, baseSha, runId: "run-empty-reconcile", writeSet: ["src"] });
    const ownersBeforeReconcile = readAllManagerProvenance(repoIdentity(root));
    const registrationsBeforeReconcile = git(root, "worktree", "list", "--porcelain");

    expectManagerError(() => reconcileRunWorktree({
      repoRoot: root, runId: reconciled.ownerRunId, runState: "running", baseSha, writeSet: [],
    }), "invalid-write-set");

    expect(git(root, "worktree", "list", "--porcelain")).toBe(registrationsBeforeReconcile);
    expect(readAllManagerProvenance(repoIdentity(root))).toEqual(ownersBeforeReconcile);
    expect(hasRegisteredWorktree(root, reconciled.canonicalPath)).toBe(true);
  });

  it("refuses to reconcile a legacy bound Run whose frozen snapshot has become empty", () => {
    const { root, baseSha } = fixture();
    const taskId = "run-legacy-empty-reconcile";
    const { taskDir, runId } = startKernelRun(root, taskId, ["src"]);
    const { binding } = createTaskRunWorktree({
      repoRoot: root, taskDir, runId, branch: `feat/${taskId}`, baseRef: baseSha,
      actor: "runner", idempotencyKey: `workspace:${taskId}`,
    });
    const before = readTaskKernel({ root, taskDir });
    if (before?.kind !== "task-kernel-v2") throw new Error("Task Kernel v2 was not preserved");
    const boundEventCount = before.kernel.events.filter(
      (event) => event.type === "run.workspace-bound" && event.entityId === runId,
    ).length;
    const ownerRecordsBefore = readAllManagerProvenance(repoIdentity(root));
    const registrationsBefore = git(root, "worktree", "list", "--porcelain");

    const kernelPath = path.join(taskDir, "kernel.json");
    const document = JSON.parse(fs.readFileSync(kernelPath, "utf8")) as {
      runs: { id: string; writeSetSnapshot: string[] }[];
    };
    const legacyRun = document.runs.find((run) => run.id === runId);
    if (!legacyRun) throw new Error("Persisted Run is missing");
    legacyRun.writeSetSnapshot = [];
    fs.writeFileSync(kernelPath, `${JSON.stringify(document, null, 2)}\n`);

    expectManagerError(() => reconcileTaskRunWorktree({
      repoRoot: root, taskDir, runId, actor: "runner", idempotencyKey: `reconcile:${taskId}`,
    }), "invalid-write-set");

    const after = readTaskKernel({ root, taskDir });
    expect(after?.kind).toBe("task-kernel-v2");
    if (after?.kind !== "task-kernel-v2") throw new Error("Task Kernel v2 was not preserved");
    expect(after.kernel.runs.at(-1)?.workspace).toEqual(binding);
    expect(after.kernel.events.filter(
      (event) => event.type === "run.workspace-bound" && event.entityId === runId,
    )).toHaveLength(boundEventCount);
    const refusal = after.kernel.events.find(
      (event) => event.type === "run.workspace-claim-refused" && event.entityId === runId,
    );
    expect(refusal).toBeDefined();
    expect(after.kernel.audit.find((entry) => entry.idempotencyKey === refusal?.idempotencyKey)?.evidence)
      .toContain("Workspace reconcile claim refused [invalid-write-set]:");
    expect(readAllManagerProvenance(repoIdentity(root))).toEqual(ownerRecordsBefore);
    expect(git(root, "worktree", "list", "--porcelain")).toBe(registrationsBefore);
  });

  it("binds a normal non-empty Run write set and preserves explicit wildcard claims", () => {
    const { root, baseSha } = fixture();
    const taskId = "run-nonempty-write-set";
    const { taskDir, runId } = startKernelRun(root, taskId, ["src"]);

    const { binding } = createTaskRunWorktree({
      repoRoot: root, taskDir, runId, branch: `feat/${taskId}`, baseRef: baseSha,
      actor: "runner", idempotencyKey: `workspace:${taskId}`,
    });
    const read = readTaskKernel({ root, taskDir });

    expect(binding.writeSet).toEqual(["src"]);
    expect(read?.kind).toBe("task-kernel-v2");
    if (read?.kind !== "task-kernel-v2") throw new Error("Task Kernel v2 was not preserved");
    expect(read.kernel.runs.at(-1)?.workspace?.writeSet).toEqual(["src"]);
    expect(read.kernel.events.some((event) => event.type === "run.workspace-bound" && event.entityId === runId)).toBe(true);

    const wildcard = createRunWorktree({
      repoRoot: root, runId: "run-explicit-wildcard", branch: "feat/run-explicit-wildcard", baseRef: baseSha,
      writeSet: ["*"], knownOwners: [],
    });
    expect(wildcard.writeSet).toEqual(["*"]);
  });

  it("resolves Windows case-only path spellings to the registered physical worktree", () => {
    if (process.platform !== "win32") return;
    const { root, baseSha } = fixture();
    const binding = create({ root, baseSha });
    const aliasRoot = alternateCase(root);
    const aliasBinding = { ...binding, canonicalPath: alternateCase(binding.canonicalPath) };
    const inspection = inspectRunWorktree({
      repoRoot: aliasRoot, runId: binding.ownerRunId, runState: "running", binding: aliasBinding, knownOwners: [],
    });

    expect(inspection.state).toBe("unintegrated");
    expect(inspection.actualPath?.replaceAll("\\", "/").toLowerCase())
      .toBe(fs.realpathSync(binding.canonicalPath).replaceAll("\\", "/").toLowerCase());
    expect(fs.realpathSync(aliasBinding.canonicalPath).replaceAll("\\", "/").toLowerCase())
      .toBe(inspection.actualPath?.replaceAll("\\", "/").toLowerCase());
    expect(git(root, "worktree", "list", "--porcelain").toLowerCase()).toContain(`branch refs/heads/${binding.branch.toLowerCase()}`);
  });

  it("rejects unsafe Run ids, invalid branches, and an existing destination without touching another path", () => {
    const { root, baseSha } = fixture();
    expect(() => createRunWorktree({ repoRoot: root, runId: "../escape", branch: "feat/escape", baseRef: baseSha, writeSet: ["src"], knownOwners: [] }))
      .toThrow("Run id is not a safe path component");
    expect(() => createRunWorktree({ repoRoot: root, runId: "run-bad-branch", branch: "-option", baseRef: baseSha, writeSet: ["src"], knownOwners: [] }))
      .toThrow("Branch name is invalid");
    const binding = create({ root, baseSha });
    expect(() => create({ root, baseSha })).toThrow("destination already exists");
    expect(fs.existsSync(binding.canonicalPath)).toBe(true);
  });

  it("adopts only a registered, clean checkout at the exact base with explicit authorization", () => {
    const { root, baseSha } = fixture();
    const canonicalPath = path.join(root, ".pactile", "worktrees", "adopted");
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    git(root, "worktree", "add", "--no-track", "-b", "feat/adopted", canonicalPath, baseSha);
    const binding = adoptRunWorktree({
      repoRoot: root, runId: "run-adopted", runState: "waiting", canonicalPath,
      branch: "feat/adopted", baseSha, writeSet: ["src"], knownOwners: [],
      authorization: { approvedBy: "alice", approvedAt: "2026-09-25T10:00:00Z", evidenceRef: "approval:adopt" },
    });
    expect(binding).toMatchObject({ ownerRunId: "run-adopted", branch: "feat/adopted", baseSha, integrationState: "not-integrated" });
    expect(inspectRunWorktree({ repoRoot: root, runId: "run-adopted", runState: "running", binding, knownOwners: [] }).state)
      .toBe("unintegrated");
    expect(() => adoptRunWorktree({
      repoRoot: root, runId: "other-run", runState: "waiting", canonicalPath,
      branch: binding.branch, baseSha, writeSet: ["src"], knownOwners: [{ ownerRunId: "run-adopted", canonicalPath }],
      authorization: { approvedBy: "alice", approvedAt: "now", evidenceRef: "approval:takeover" },
    })).toThrow("already owned by another Run");
  });

  it("refuses dirty, foreign, outside-root, and unapproved adoption candidates", () => {
    const { root, baseSha } = fixture();
    const canonicalPath = path.join(root, ".pactile", "worktrees", "dirty");
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    git(root, "worktree", "add", "--no-track", "-b", "feat/dirty", canonicalPath, baseSha);
    fs.writeFileSync(path.join(canonicalPath, "user-edit.txt"), "keep me\n");
    const common = {
      repoRoot: root, runId: "run-dirty", runState: "waiting" as const, canonicalPath,
      branch: "feat/dirty", baseSha, writeSet: ["src"], knownOwners: [],
    };
    expect(() => adoptRunWorktree({ ...common, authorization: { approvedBy: "alice", approvedAt: "now", evidenceRef: "approval" } }))
      .toThrow("Only a clean, unmodified worktree");
    expect(fs.readFileSync(path.join(canonicalPath, "user-edit.txt"), "utf8")).toBe("keep me\n");
    expect(() => adoptRunWorktree({ ...common, authorization: { approvedBy: "", approvedAt: "", evidenceRef: "" } }))
      .toThrow("Adoption requires an explicit recorded authorization");
    expect(() => adoptRunWorktree({ ...common, canonicalPath: path.join(root, "outside"), authorization: { approvedBy: "alice", approvedAt: "now", evidenceRef: "approval" } }))
      .toThrow("inside .pactile/worktrees");
  });

  it("rejects a nested repository that is not registered as this project's worktree", () => {
    const { root, baseSha } = fixture();
    const nested = path.join(root, ".pactile", "worktrees", "foreign-repository");
    fs.mkdirSync(nested, { recursive: true });
    git(nested, "init", "-q", "-b", "main");
    git(nested, "config", "user.name", "Pactile Test");
    git(nested, "config", "user.email", "pactile@example.invalid");
    fs.writeFileSync(path.join(nested, "README.md"), "foreign\n");
    git(nested, "add", "README.md");
    git(nested, "commit", "-q", "-m", "foreign repository");
    const candidate = {
      repoRoot: root, runId: "run-foreign", runState: "waiting" as const, canonicalPath: nested,
      branch: "main", baseSha, writeSet: ["src"], knownOwners: [],
      authorization: { approvedBy: "alice", approvedAt: "now", evidenceRef: "approval:adopt" },
    };
    expect(inspectRunWorktree({
      repoRoot: root, runId: candidate.runId, runState: "waiting",
      binding: { ownerRunId: candidate.runId, canonicalPath: nested, branch: "main", baseSha, writeSet: ["src"], integrationState: "not-integrated", reclamationState: "not-requested" },
      knownOwners: [],
    }).state).toBe("not-registered");
    expect(() => adoptRunWorktree(candidate)).toThrow("Only a clean, unmodified worktree");
  });

  it("rejects a junction that resolves to a different worktree path", (context) => {
    const { root, baseSha } = fixture();
    const outside = path.join(root, "outside-checkout");
    git(root, "worktree", "add", "--no-track", "-b", "feat/outside", outside, baseSha);
    const alias = path.join(root, ".pactile", "worktrees", "alias");
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    try { fs.symlinkSync(outside, alias, "junction"); }
    catch { context.skip("The host does not allow creating a directory junction in this test environment"); }
    expect(() => adoptRunWorktree({
      repoRoot: root, runId: "run-alias", runState: "waiting", canonicalPath: alias,
      branch: "feat/outside", baseSha, writeSet: ["src"], knownOwners: [],
      authorization: { approvedBy: "alice", approvedAt: "now", evidenceRef: "approval:adopt" },
    })).toThrow("symlink");
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("classifies interrupted, branch-changed, and baseline-mismatched worktrees", () => {
    const { root, baseSha } = fixture();
    const binding = create({ root, baseSha });
    const baselineBinding = create({ root, baseSha, runId: "run-baseline" });
    expect(inspectRunWorktree({ repoRoot: root, runId: binding.ownerRunId, runState: "interrupted", binding, knownOwners: [] }).state)
      .toBe("interrupted");

    git(binding.canonicalPath, "checkout", "--detach", "HEAD");
    expect(inspectRunWorktree({ repoRoot: root, runId: binding.ownerRunId, runState: "running", binding, knownOwners: [] }).state)
      .toBe("branch-mismatch");

    const nextMainFile = path.join(root, "later.txt");
    git(root, "checkout", "--orphan", "unrelated-baseline");
    fs.writeFileSync(nextMainFile, "new unrelated history\n");
    git(root, "add", "later.txt");
    git(root, "commit", "-q", "-m", "unrelated baseline");
    const unrelatedSha = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "main");
    git(baselineBinding.canonicalPath, "reset", "--hard", unrelatedSha);
    expect(inspectRunWorktree({ repoRoot: root, runId: baselineBinding.ownerRunId, runState: "running", binding: baselineBinding, knownOwners: [] }).state)
      .toBe("baseline-mismatch");
  });

  it("requires a proven merge of a clean, in-scope Run head and preserved result", () => {
    const { root, baseSha } = fixture();
    const binding = create({ root, baseSha });
    commitRunChange(binding);
    expect(() => integration({ root, binding, result: null })).toThrow("Persist the Run result");
    expect(() => verifyWorktreeIntegration({
      repoRoot: root, runId: binding.ownerRunId, runState: "completed", binding, knownOwners: [],
      targetRef: binding.branch, result: result(binding.ownerRunId),
    })).toThrow("Integration target must be a different local branch");
    expect(() => integration({ root, binding })).toThrow("Target ref does not contain");
    mergeRun(root, binding);
    const verified = integration({ root, binding });
    expect(verified.binding).toMatchObject({ integrationState: "integrated", reclamationState: "pending" });
    expect(verified.receipt).toMatchObject({ runId: binding.ownerRunId, targetRef: "HEAD", worktreeHeadSha: git(binding.canonicalPath, "rev-parse", "HEAD") });
    expect(verified.receipt.contentFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const outsideBinding = create({ root, baseSha, runId: "run-outside-scope", writeSet: ["src"] });
    commitRunChange(outsideBinding, "README.md");
    expect(() => integration({ root, binding: outsideBinding })).toThrow("Run worktree cannot be integrated");
  });

  it("rejects an ancestry-only ours merge that discards the Run changed-path content", () => {
    const { root, baseSha } = fixture();
    const binding = create({ root, baseSha, runId: "run-ours-merge" });
    commitRunChange(binding);
    const runHead = git(binding.canonicalPath, "rev-parse", "HEAD");
    git(root, "merge", "--no-ff", "-s", "ours", "--no-edit", binding.branch);

    expect(git(root, "merge-base", "--is-ancestor", runHead, "HEAD")).toBe("");
    expect(fs.existsSync(path.join(root, "src", "feature.ts"))).toBe(false);
    expect(() => integration({ root, binding })).toThrow("Target tree does not preserve Run changes at src/feature.ts");
  });

  it("creates a manual cleanup plan for a verified integrated Run and leaves its worktree intact", () => {
    const { root, baseSha } = fixture();
    const binding = create({ root, baseSha });
    commitRunChange(binding);
    mergeRun(root, binding);
    const integrated = integration({ root, binding }).binding;
    const cleanup = planRunWorktreeCleanup({
      repoRoot: root, runId: binding.ownerRunId, runState: "completed", binding: integrated,
      knownOwners: [], targetRef: "HEAD", result: result(binding.ownerRunId),
    });
    expect(cleanup).toMatchObject({
      state: "manual-action-required",
      path: binding.canonicalPath,
      plan: {
        ownerRunId: binding.ownerRunId,
        expectedHeadSha: git(binding.canonicalPath, "rev-parse", "HEAD"),
        targetBranch: "main",
        command: { executable: "git", args: ["worktree", "remove", binding.canonicalPath], cwd: root },
      },
    });
    expect(fs.existsSync(binding.canonicalPath)).toBe(true);
    expect(hasRegisteredWorktree(root, binding.canonicalPath)).toBe(true);
  });

  it("retains dirty, ignored, interrupted, unintegrated, and foreign-owned worktrees", () => {
    const { root, baseSha } = fixture();
    const binding = create({ root, baseSha });
    commitRunChange(binding);
    mergeRun(root, binding);
    const integrated = integration({ root, binding }).binding;
    fs.mkdirSync(path.join(binding.canonicalPath, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(binding.canonicalPath, "node_modules", "user-cache.txt"), "preserve\n");
    const dirty = planRunWorktreeCleanup({
      repoRoot: root, runId: binding.ownerRunId, runState: "completed", binding: integrated,
      knownOwners: [], targetRef: "HEAD", result: result(binding.ownerRunId),
    });
    expect(dirty.state).toBe("retained");
    expect(fs.readFileSync(path.join(binding.canonicalPath, "node_modules", "user-cache.txt"), "utf8")).toBe("preserve\n");
    expect(dirty.binding.reclamationState).toBe("pending");

    const interrupted = planRunWorktreeCleanup({
      repoRoot: root, runId: binding.ownerRunId, runState: "interrupted", binding: integrated,
      knownOwners: [], targetRef: "HEAD", result: result(binding.ownerRunId),
    });
    expect(interrupted.state).toBe("retained");
    expect(fs.existsSync(binding.canonicalPath)).toBe(true);

    const foreign = planRunWorktreeCleanup({
      repoRoot: root, runId: binding.ownerRunId, runState: "completed", binding: integrated,
      knownOwners: [{ ownerRunId: "other-run", canonicalPath: binding.canonicalPath }],
      targetRef: "HEAD", result: result(binding.ownerRunId),
    });
    expect(foreign.state).toBe("retained");
    expect(fs.existsSync(binding.canonicalPath)).toBe(true);

    const unintegratedBinding = { ...binding, reclamationState: "pending" as const };
    const unintegrated = planRunWorktreeCleanup({
      repoRoot: root, runId: binding.ownerRunId, runState: "completed", binding: unintegratedBinding,
      knownOwners: [], targetRef: "HEAD", result: result(binding.ownerRunId),
    });
    expect(unintegrated.state).toBe("retained");
    expect(fs.existsSync(binding.canonicalPath)).toBe(true);
  });

  it("does not reclaim a user-created, merged worktree from a forged binding and empty owner list", () => {
    const { root, baseSha } = fixture();
    const canonicalPath = path.join(root, ".pactile", "worktrees", "user-owned");
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    git(root, "worktree", "add", "--no-track", "-b", "feat/user-owned", canonicalPath, baseSha);
    const forged: RunWorkspaceBinding = {
      ownerRunId: "user-owned", canonicalPath, branch: "feat/user-owned", baseSha,
      writeSet: ["src"], integrationState: "integrated", reclamationState: "pending",
    };
    commitRunChange(forged);
    mergeRun(root, forged);

    const cleanup = planRunWorktreeCleanup({
      repoRoot: root, runId: forged.ownerRunId, runState: "completed", binding: forged,
      knownOwners: [], targetRef: "HEAD", result: result(forged.ownerRunId),
    });
    expect(cleanup.state).toBe("retained");
    expect(fs.existsSync(canonicalPath)).toBe(true);
    expect(hasRegisteredWorktree(root, canonicalPath)).toBe(true);
  });

  it("detects a same-common-dir .git pointer swap through gitdir, symbolic-ref, and registration checks", () => {
    const { root, baseSha } = fixture();
    const first = create({ root, baseSha, runId: "run-pointer-a" });
    const second = create({ root, baseSha, runId: "run-pointer-b" });
    const firstGitFile = path.join(first.canonicalPath, ".git");
    const original = fs.readFileSync(firstGitFile, "utf8");
    const secondGitDir = git(second.canonicalPath, "rev-parse", "--absolute-git-dir");
    fs.chmodSync(firstGitFile, 0o666);
    fs.unlinkSync(firstGitFile);
    try {
      fs.writeFileSync(firstGitFile, `gitdir: ${secondGitDir}\n`);
      const inspection = inspectRunWorktree({ repoRoot: root, runId: first.ownerRunId, runState: "running", binding: first, knownOwners: [] });
      expect(inspection.issues).toEqual(expect.arrayContaining(["gitdir-mismatch", "branch-mismatch", "manager-provenance-mismatch"]));
      expect(inspection.state).toBe("manager-provenance-mismatch");
    } finally {
      if (fs.existsSync(firstGitFile)) fs.unlinkSync(firstGitFile);
      fs.writeFileSync(firstGitFile, original);
    }
  });

  it("leaves a verified checkout in place so a later clean commit cannot be lost to a cleanup race", () => {
    const { root, baseSha } = fixture();
    const binding = create({ root, baseSha });
    commitRunChange(binding);
    mergeRun(root, binding);
    const integrated = integration({ root, binding }).binding;
    const plan = planRunWorktreeCleanup({
      repoRoot: root, runId: binding.ownerRunId, runState: "completed", binding: integrated,
      knownOwners: [], targetRef: "HEAD", result: result(binding.ownerRunId),
    });
    expect(plan.state).toBe("manual-action-required");
    if (plan.state !== "manual-action-required") throw new Error("Expected a manual cleanup plan");
    commitRunChange(binding, "src/late-commit.ts");
    expect(plan.plan.expectedHeadSha).not.toBe(git(binding.canonicalPath, "rev-parse", "HEAD"));
    expect(fs.existsSync(binding.canonicalPath)).toBe(true);
    expect(hasRegisteredWorktree(root, binding.canonicalPath)).toBe(true);
  });

  it("allows overlapping writes only with an exact authorization and integration plan", () => {
    expect(decideParallelWriteSets({ leftRunId: "a", left: ["src"], rightRunId: "b", right: ["src/ui"] }))
      .toMatchObject({ allowed: false, overlapPaths: ["src/ui"], reason: "write-set-conflict" });
    expect(decideParallelWriteSets({ leftRunId: "a", left: ["src/a.ts"], rightRunId: "b", right: ["src/b.ts"] }))
      .toMatchObject({ allowed: true, overlapPaths: [] });
    const authorization = {
      runIds: ["a", "b"] as [string, string], overlapPaths: ["src/ui"], approvedBy: "alice",
      approvedAt: "2026-09-25T10:00:00Z", evidenceRef: "approval:parallel", integrationPlan: "Parent serially integrates Run a before Run b",
    };
    expect(decideParallelWriteSets({ leftRunId: "a", left: ["src"], rightRunId: "b", right: ["src/ui"], authorization }))
      .toMatchObject({ allowed: true, overlapPaths: ["src/ui"], authorization });
    expect(decideParallelWriteSets({ leftRunId: "a", left: ["src"], rightRunId: "b", right: ["src/ui"], authorization: { ...authorization, runIds: ["a", "c"] } }))
      .toMatchObject({ allowed: false, reason: "invalid-authorization" });
  });
});
