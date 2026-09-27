import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  fingerprintTaskValue,
  readTaskKernel,
  type TaskKernelSnapshotV2,
  type TaskRunV2,
} from "../core/task/index.js";
import {
  adoptTaskRunWorktree,
  createTaskRunWorktree,
  inspectRunWorktree,
  integrateTaskRunWorktree,
  reconcileTaskRunWorktree,
  reclaimRunWorktree,
} from "../pactile/worktree/index.js";
import { readDeveloper } from "../utils/developer.js";
import { resolveTaskDir } from "../pactile/task/session.js";

interface ParsedArgs {
  positionals: string[];
  values: Map<string, string>;
}

function parseArgs(args: string[], allowedOptions: readonly string[]): ParsedArgs {
  const allowed = new Set(allowedOptions);
  const positionals: string[] = [];
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (!allowed.has(value)) throw new Error(`Unknown option: ${value}`);
    const optionValue = args[index + 1];
    if (!optionValue || optionValue.startsWith("--")) throw new Error(`${value} requires a value`);
    if (values.has(value)) throw new Error(`${value} may be provided only once`);
    values.set(value, optionValue);
    index += 1;
  }
  return { positionals, values };
}

function option(parsed: ParsedArgs, name: string): string | undefined {
  return parsed.values.get(name);
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function gitRoot(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function taskRunContext(cwd: string, taskReference: string, runId: string): {
  repoRoot: string;
  taskDir: string;
  kernel: TaskKernelSnapshotV2;
  run: TaskRunV2;
} {
  const repoRoot = gitRoot(cwd);
  const taskDir = resolveTaskDir(repoRoot, taskReference);
  const read = readTaskKernel({ root: repoRoot, taskDir, cwd: repoRoot });
  if (read.kind !== "task-kernel-v2") throw new Error("Run worktree commands require a Task Kernel V2");
  const run = read.kernel.runs.find((candidate) => candidate.id === runId);
  if (run?.taskId !== read.kernel.identity.taskId) throw new Error(`Task Kernel has no Run ${runId}`);
  return { repoRoot, taskDir, kernel: read.kernel, run };
}

function actor(repoRoot: string, parsed: ParsedArgs): string {
  const supplied = option(parsed, "--actor")?.trim();
  if (supplied) return supplied;
  return readDeveloper(repoRoot) ?? "user";
}

function idempotencyKey(parsed: ParsedArgs, operation: string, runId: string, request: unknown): string {
  return option(parsed, "--idempotency-key") ?? `worktree:${operation}:${runId}:${fingerprintTaskValue(request)}`;
}

function usage(): string {
  return [
    "Usage: pactile worktree <create|reconcile|adopt|inspect|integrate|reclaim> <task> <run-id> [options]",
    "  create <task> <run-id> [--branch <branch>] [--base-ref <ref>] [--actor <name>]",
    "  reconcile <task> <run-id> [--actor <name>]",
    "  adopt <task> <run-id> --path <registered-checkout> --branch <branch> --base-sha <sha> --approved-by <name> --approval-evidence <ref> [--approved-at <iso>]",
    "  inspect <task> <run-id>",
    "  integrate <task> <run-id> --target <local-branch>",
    "  reclaim <task> <run-id>  (automatic only after host stop, integration and Task Close gates pass)",
    "Create/adopt binds manager provenance to the active Run; reconcile safely completes an interrupted same-Run bind. Integration verifies that the target already contains the Run result; it does not merge branches.",
  ].join("\n");
}

export async function runWorktreeCli(argv: string[], cwd = process.cwd()): Promise<number> {
  const [operation, taskReference, runId, ...rawArgs] = argv;
  if (!operation || operation === "help" || operation === "--help") {
    console.log(usage());
    return 0;
  }
  if (!taskReference || !runId) throw new Error(usage());

  const allowedByOperation: Record<string, readonly string[]> = {
    create: ["--branch", "--base-ref", "--actor", "--idempotency-key"],
    reconcile: ["--actor", "--idempotency-key"],
    adopt: ["--path", "--branch", "--base-sha", "--approved-by", "--approval-evidence", "--approved-at", "--actor", "--idempotency-key"],
    inspect: [],
    integrate: ["--target", "--actor", "--idempotency-key"],
    reclaim: ["--actor", "--idempotency-key"],
  };
  const allowedOptions = allowedByOperation[operation];
  if (!allowedOptions) throw new Error(usage());
  const parsed = parseArgs(rawArgs, allowedOptions);
  if (parsed.positionals.length) throw new Error(`Unexpected positional argument: ${parsed.positionals[0]}`);

  const { repoRoot, taskDir, run } = taskRunContext(cwd, taskReference, runId);
  if (operation === "create") {
    const branchSuffix = runId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    const branch = option(parsed, "--branch") ?? `pactile/run/${branchSuffix}`;
    const baseRef = option(parsed, "--base-ref") ?? run.candidateBaseSha ?? "HEAD";
    const request = { runId, branch, baseRef, writeSet: run.writeSetSnapshot };
    const created = createTaskRunWorktree({
      repoRoot, taskDir, runId, branch, baseRef,
      actor: actor(repoRoot, parsed),
      idempotencyKey: idempotencyKey(parsed, operation, runId, request),
    });
    console.log(JSON.stringify({
      operation, runId, branch: created.binding.branch, canonicalPath: created.binding.canonicalPath,
      baseSha: created.binding.baseSha, writeSet: created.binding.writeSet, credentialId: created.binding.manager?.credentialId,
    }, null, 2));
    return 0;
  }

  if (operation === "reconcile") {
    const request = { runId };
    const reconciled = reconcileTaskRunWorktree({
      repoRoot, taskDir, runId,
      actor: actor(repoRoot, parsed),
      idempotencyKey: idempotencyKey(parsed, operation, runId, request),
    });
    console.log(JSON.stringify({
      operation, runId, state: reconciled.mutation ? "reconciled" : "already-bound",
      branch: reconciled.binding.branch, canonicalPath: reconciled.binding.canonicalPath,
      baseSha: reconciled.binding.baseSha, writeSet: reconciled.binding.writeSet,
      credentialId: reconciled.binding.manager?.credentialId,
    }, null, 2));
    return 0;
  }

  if (operation === "adopt") {
    const canonicalPath = required(option(parsed, "--path"), "--path");
    const branch = required(option(parsed, "--branch"), "--branch");
    const baseSha = required(option(parsed, "--base-sha"), "--base-sha");
    const approvedBy = required(option(parsed, "--approved-by"), "--approved-by");
    const evidenceRef = required(option(parsed, "--approval-evidence"), "--approval-evidence");
    const request = { runId, canonicalPath, branch, baseSha, approvedBy, evidenceRef };
    const adopted = adoptTaskRunWorktree({
      repoRoot, taskDir, runId, canonicalPath, branch, baseSha,
      authorization: { approvedBy, approvedAt: option(parsed, "--approved-at") ?? new Date().toISOString(), evidenceRef },
      actor: actor(repoRoot, parsed),
      idempotencyKey: idempotencyKey(parsed, operation, runId, request),
    });
    console.log(JSON.stringify({
      operation, runId, branch: adopted.binding.branch, canonicalPath: adopted.binding.canonicalPath,
      baseSha: adopted.binding.baseSha, writeSet: adopted.binding.writeSet,
      credentialId: adopted.binding.manager?.credentialId, approvalEvidence: evidenceRef,
    }, null, 2));
    return 0;
  }

  if (operation === "inspect") {
    const binding = run.workspace;
    if (!binding) {
      console.log(JSON.stringify({ operation, runId, workspace: null, state: "not-bound" }, null, 2));
      return 2;
    }
    const inspection = inspectRunWorktree({
      repoRoot, runId, runState: run.state, binding,
    });
    console.log(JSON.stringify({ operation, runId, inspection }, null, 2));
    return inspection.state === "clean" || inspection.state === "unintegrated" ? 0 : 2;
  }

  if (operation === "integrate") {
    const targetRef = required(option(parsed, "--target"), "--target");
    const request = { runId, targetRef };
    const integrated = integrateTaskRunWorktree({
      repoRoot, taskDir, runId, targetRef,
      actor: actor(repoRoot, parsed),
      idempotencyKey: idempotencyKey(parsed, operation, runId, request),
    });
    console.log(JSON.stringify({ operation, runId, receipt: integrated.receipt }, null, 2));
    return 0;
  }

  const result = await reclaimRunWorktree({
    repoRoot, taskDir, runId,
    actor: actor(repoRoot, parsed),
    idempotencyKey: idempotencyKey(parsed, operation, runId, { runId }),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.state !== "reclaimed") return 2;
  return 0;
}

export async function runWorktreeCommand(argv: string[], cwd = process.cwd()): Promise<number> {
  try {
    return await runWorktreeCli(argv, cwd);
  } catch (error) {
    console.error(`Run worktree: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export function resolveWorktreeTaskDirectory(cwd: string, taskReference: string): string {
  const repoRoot = gitRoot(cwd);
  return path.resolve(resolveTaskDir(repoRoot, taskReference));
}
