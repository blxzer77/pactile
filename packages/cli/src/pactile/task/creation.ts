import fs from "node:fs";
import path from "node:path";

import { applyKernelCreate, type PactileTaskRecord } from "../../core/task/index.js";
import { parseKernelSnapshot } from "../../core/task/kernel-contract.js";

export interface CreateTaskWithArtifactsInput {
  root: string;
  dirName: string;
  record: PactileTaskRecord;
  artifacts: ReadonlyMap<string, string>;
  actor: string;
  idempotencyKey: string;
  evidence: string;
  extras?: Record<string, unknown>;
  ifExists: "error" | "keep-complete";
}

export interface TaskCreationResult {
  taskDir: string;
  created: boolean;
}

function hasCompleteTask(dir: string, expectedId: string, artifacts: ReadonlyMap<string, string>): boolean {
  for (const name of ["kernel.json", "task.json", ...artifacts.keys()]) {
    const file = path.join(dir, name);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return false;
  }
  try {
    const task: unknown = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
    const kernel = parseKernelSnapshot(JSON.parse(fs.readFileSync(path.join(dir, "kernel.json"), "utf8")) as unknown);
    const projection = kernel.projection;
    if (!projection) return false;
    return task !== null && typeof task === "object" && !Array.isArray(task)
      && "id" in task && task.id === expectedId
      && "status" in task && task.status === projection.status
      && kernel.identity.taskId === expectedId
      && projection.record.id === expectedId
      && projection.record.status === projection.status
      && fs.readFileSync(path.join(dir, "prd.md"), "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

function cleanupStaging(stagingRoot: string, stagingDir: string): void {
  const relative = path.relative(stagingRoot, path.resolve(stagingDir));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || fs.lstatSync(stagingDir).isSymbolicLink()) {
    throw new Error("Unsafe task staging cleanup target");
  }
  fs.rmSync(stagingDir, { recursive: true, force: true });
}

/**
 * Make a task visible only after its artifacts and Kernel projection exist.
 * An interrupted private staging directory never appears in the active task list.
 */
export function createTaskWithArtifacts(input: CreateTaskWithArtifactsInput): TaskCreationResult {
  if (!/^(?:\d\d-\d\d|00)-[\p{Letter}\p{Number}]+(?:-[\p{Letter}\p{Number}]+)*$/u.test(input.dirName)) {
    throw new Error("Invalid task directory name");
  }
  if (!input.artifacts.has("prd.md")) throw new Error("Task creation requires prd.md");
  for (const [name, content] of input.artifacts) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === "kernel.json" || name === "task.json") {
      throw new Error(`Invalid task artifact name: ${name}`);
    }
    if (typeof content !== "string") throw new Error(`Invalid task artifact content: ${name}`);
  }

  const tasksRoot = path.resolve(input.root, ".pactile", "tasks");
  const taskDir = path.join(tasksRoot, input.dirName);
  if (fs.existsSync(taskDir)) {
    if (input.ifExists === "keep-complete" && hasCompleteTask(taskDir, input.record.id, input.artifacts)) {
      return { taskDir, created: false };
    }
    throw new Error(`Task already exists or needs recovery: ${input.dirName}`);
  }

  const stagingRoot = path.join(tasksRoot, ".creating");
  fs.mkdirSync(stagingRoot, { recursive: true });
  if (fs.lstatSync(stagingRoot).isSymbolicLink()) throw new Error("Task staging directory must not be a symlink");
  const stagingDir = fs.mkdtempSync(path.join(stagingRoot, `${input.dirName}-`));
  let committed = false;
  try {
    for (const [name, content] of input.artifacts) {
      fs.writeFileSync(path.join(stagingDir, name), content, { encoding: "utf8", flag: "wx" });
    }
    applyKernelCreate({
      taskDir: stagingDir,
      cwd: input.root,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      record: { ...input.record, status: "planning" },
      evidence: input.evidence,
      extras: input.extras,
    });
    if (fs.existsSync(taskDir)) throw new Error(`Task already exists: ${input.dirName}`);
    fs.renameSync(stagingDir, taskDir);
    committed = true;
    return { taskDir, created: true };
  } finally {
    if (!committed && fs.existsSync(stagingDir)) {
      cleanupStaging(stagingRoot, stagingDir);
    }
    if (fs.existsSync(stagingRoot) && fs.readdirSync(stagingRoot).length === 0) {
      fs.rmdirSync(stagingRoot);
    }
  }
}
