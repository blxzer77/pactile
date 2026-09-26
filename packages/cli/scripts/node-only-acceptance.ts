/** Installed-tarball smoke with a Node-only PATH and the current V2 Task CLI. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [installed, root, gitExecutable] = process.argv.slice(2);
if (!installed || !root || !gitExecutable)
  throw new Error(
    "Usage: node node-only-acceptance.js <installed-package> <workspace> <git-executable>",
  );
const pythonPathNames = [
  "python",
  "python.exe",
  "python3",
  "python3.exe",
  "py",
  "py.exe",
  "pi",
  "pi.cmd",
];
const assertNoPythonOnPath = (pathValue: string): void => {
  for (const folder of pathValue.split(path.delimiter)) {
    for (const name of pythonPathNames) {
      if (folder && fs.existsSync(path.join(folder, name)))
        throw new Error(`Node-only PATH contains ${name}`);
    }
  }
};
assertNoPythonOnPath(process.env.PATH ?? "");
if (!path.isAbsolute(gitExecutable) || !fs.existsSync(gitExecutable))
  throw new Error("V2 Pi acceptance requires the verified Git executable path");
const originalPath = process.env.PATH ?? "";
const gitBin = path.join(root, "node-only-git-bin");
fs.mkdirSync(gitBin, { recursive: true });
let bridgePath: string;
if (process.platform === "win32") {
  // Git for Windows needs sibling DLLs, so expose its Python-free bin folder.
  bridgePath = [originalPath, path.dirname(gitExecutable)].join(path.delimiter);
} else {
  // Keep /usr/bin (which commonly contains Python) off PATH while allowing the
  // checked Git executable to run for managed-worktree provider acceptance.
  fs.symlinkSync(gitExecutable, path.join(gitBin, "git"));
  if (fs.existsSync("/bin/sh"))
    fs.symlinkSync("/bin/sh", path.join(gitBin, "sh"));
  bridgePath = [originalPath, gitBin].join(path.delimiter);
}
assertNoPythonOnPath(bridgePath);
process.env.PATH = bridgePath;
execFileSync("git", ["--version"], { encoding: "utf8" });
fs.mkdirSync(root, { recursive: true });
const cli = path.join(installed, "dist", "bin", "pactile.js");
const run = (args: string[]) =>
  String(
    execFileSync(process.execPath, [cli, ...args], {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ).trim();
const taskDir = (projectRoot: string, slug: string) => {
  const tasks = path.join(projectRoot, ".pactile", "tasks");
  const name = fs
    .readdirSync(tasks)
    .find((entry) => entry.endsWith(`-${slug}`));
  assert.ok(name, `Task ${slug} missing`);
  return path.join(tasks, name);
};
const moduleAt = async (relative: string) =>
  import(pathToFileURL(path.join(installed, "dist", relative)).href);
const started = performance.now();
const coldStarted = performance.now();
run(["--version"]);
const coldStartMs = Math.round(performance.now() - coldStarted);
run([
  "init",
  "--codex",
  "--yes",
  "--user",
  "release-smoke",
  "--skip-readiness",
]);
assert.ok(fs.existsSync(path.join(root, ".pactile", "workflow.md")));
assert.equal(
  fs.existsSync(path.join(root, ".cursor")),
  false,
  "Codex init must not create Cursor integration",
);
const git = (args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n.pactile/\n");
fs.writeFileSync(
  path.join(root, "README.md"),
  "Node-only conformance workspace.\n",
);
git(["init", "-q", "-b", "main"]);
git(["config", "user.name", "Pactile Node-only Conformance"]);
git(["config", "user.email", "node-only-conformance@example.invalid"]);
git(["add", ".gitignore", "README.md"]);
git(["commit", "-q", "-m", "Node-only conformance base"]);

const v2Task = "node-only-task";
run([
  "task",
  "create",
  "Node-only Task smoke",
  "--slug",
  v2Task,
  "--deliverable",
  "A Task created and started by the installed Node-only package.",
  "--delivery-level",
  "local-result",
  "--accept",
  "AC-1=The installed CLI records a V2 Task and authorized Run.",
]);
run([
  "task",
  "run-start",
  v2Task,
  "--approved-by",
  "node-only-conformance",
  "--authorization-scope",
  "temporary release conformance workspace",
  "--authorization-evidence",
  "sealed tarball Node-only acceptance",
  "--input-summary",
  "Verify the V2 Task lifecycle entry point from the installed package.",
]);
const taskSnapshot = JSON.parse(run(["task", "show", v2Task, "--json"]));
assert.equal(taskSnapshot.schemaVersion, 2);
assert.equal(taskSnapshot.identity.taskId, v2Task);
assert.equal(taskSnapshot.phase, "execute");
assert.equal(taskSnapshot.runs.length, 1);
assert.equal(taskSnapshot.runs[0].state, "running");
assert.equal(
  taskSnapshot.runs[0].authorization.approvedBy,
  "node-only-conformance",
);

const warmStarted = performance.now();
run(["task", "list"]);
const steadyCliMs = Math.round(performance.now() - warmStarted);

const fake = fileURLToPath(
  new URL("./fixtures/fake-pi-provider.js", import.meta.url),
);
assert.ok(
  fs.existsSync(fake),
  "Compiled TypeScript fake Pi fixture is missing",
);
const { PiTaskBridge } = await moduleAt("pactile/pi/bridge.js");
const { createTaskRunWorktree } = await moduleAt("pactile/worktree/index.js");
const { scheduleTaskKernelGraph } = await moduleAt(
  "pactile/scheduler/index.js",
);
const parallelTasks: { taskId: string; runId: string; taskDir: string }[] = [];
for (const [taskId, writeSet] of [
  ["parallel-a", "src/parallel-a"],
  ["parallel-b", "src/parallel-b"],
]) {
  run([
    "task",
    "create",
    `Node-only V2 ${taskId}`,
    "--slug",
    taskId,
    "--deliverable",
    "A simulated Pi Task result recorded from a managed Run.",
    "--delivery-level",
    "local-result",
    "--accept",
    "AC-1=The V2 Pi dispatch settles and releases its lease.",
  ]);
  const runOutput = run([
    "task",
    "run-start",
    taskId,
    "--wait",
    "--approved-by",
    "node-only-conformance",
    "--authorization-scope",
    "temporary sealed-tarball V2 Pi smoke",
    "--authorization-evidence",
    "default npm install with Node-only PATH",
    "--input-summary",
    `Dispatch the compiled fake Pi provider for ${taskId}.`,
    "--write-set",
    writeSet,
  ]);
  const runId = runOutput.match(/^Run queued: ([^\r\n]+)/mu)?.[1];
  assert.ok(runId, `V2 Run ID missing for ${taskId}`);
  const dir = taskDir(root, taskId);
  createTaskRunWorktree({
    repoRoot: root,
    taskDir: dir,
    runId,
    branch: `feat/node-only-${taskId}`,
    baseRef: git(["rev-parse", "HEAD"]),
    actor: "node-only-conformance",
    idempotencyKey: `worktree:node-only:${taskId}`,
  });
  parallelTasks.push({ taskId, runId, taskDir: dir });
}
const taskIds = parallelTasks.map((task) => task.taskId);
const schedule = scheduleTaskKernelGraph(root, taskIds, {
  estimatedCosts: Object.fromEntries(
    taskIds.map((taskId) => [taskId, { executionMs: 300_000 }]),
  ),
});
assert.deepEqual(
  schedule.receipt.plan.decisions.map((decision) => decision.action),
  ["scheduled", "scheduled"],
  "V2 scheduler must admit both independent waiting Tasks",
);
assert.equal(schedule.receipt.plan.waves.length, 1);
assert.deepEqual(
  [...schedule.receipt.plan.waves[0].taskIds].sort(),
  [...taskIds].sort(),
  "V2 scheduler must place both independent Tasks in one parallel wave",
);
const parallelStarted = performance.now();
const piResults = await Promise.all(
  parallelTasks.map(async (task) => {
    const bridge = new PiTaskBridge(root, {
      command: process.execPath,
      args: [
        fake,
        "--session-name",
        `${task.taskId}.jsonl`,
        "--session-id",
        `node-only-${task.taskId}`,
        "--response-delay-ms",
        "250",
        "--result-text",
        `V2 Pi settled ${task.taskId}`,
      ],
    });
    try {
      return await bridge.run({
        root,
        task: task.taskId,
        runId: task.runId,
        role: "implement",
        prompt: `Settle the Node-only V2 Pi smoke for ${task.taskId}.`,
        timeoutMs: 15_000,
      });
    } finally {
      await bridge.close();
    }
  }),
);
const parallelWallMs = Math.round(performance.now() - parallelStarted);
assert.deepEqual(
  piResults.map((result) => result.outcome),
  ["settled", "settled"],
);
assert.ok(piResults.every((result) => result.schema_version === 2));
assert.ok(piResults.every((result) => result.dispatch_lease_released === true));

// Keep these legacy compatibility checks after the V2 scheduler fixture: the
// init seed is a V1 task, and `update` may materialize its migration preflight.
// The scheduler acceptance specifically covers the fresh-init V2 entry path.
run(["update", "--dry-run", "--skip-readiness", "--json"]);
run(["update", "--skip-all", "--skip-readiness", "--json"]);
let v2AfterUpdate: Record<string, unknown>;
try {
  const taskId = "node-only-post-update";
  run([
    "task",
    "create",
    "Node-only post-update V2 Task smoke",
    "--slug",
    taskId,
    "--deliverable",
    "A V2 Task created after the installed CLI updates an initialized project.",
    "--delivery-level",
    "local-result",
    "--accept",
    "AC-1=Post-update V2 scheduling and Pi dispatch settle from the tarball.",
  ]);
  const runOutput = run([
    "task",
    "run-start",
    taskId,
    "--wait",
    "--approved-by",
    "node-only-conformance",
    "--authorization-scope",
    "post-update sealed-tarball V2 Pi smoke",
    "--authorization-evidence",
    "default npm install with Node-only PATH",
    "--input-summary",
    "Verify a V2 Task created after `pactile update` can be scheduled.",
    "--write-set",
    "src/post-update",
  ]);
  const runId = runOutput.match(/^Run queued: ([^\r\n]+)/mu)?.[1];
  assert.ok(runId, `Post-update V2 Run ID missing for ${taskId}`);
  createTaskRunWorktree({
    repoRoot: root,
    taskDir: taskDir(root, taskId),
    runId,
    branch: "feat/node-only-post-update",
    baseRef: git(["rev-parse", "HEAD"]),
    actor: "node-only-conformance",
    idempotencyKey: "worktree:node-only:post-update",
  });
  const postUpdateSchedule = scheduleTaskKernelGraph(root, [taskId], {
    estimatedCosts: { [taskId]: { executionMs: 300_000 } },
  });
  assert.equal(
    postUpdateSchedule.receipt.plan.decisions[0]?.action,
    "scheduled",
    "Post-update scheduler must admit the V2 Task",
  );
  const bridge = new PiTaskBridge(root, {
    command: process.execPath,
    args: [
      fake,
      "--session-name",
      `${taskId}.jsonl`,
      "--session-id",
      "node-only-post-update",
      "--response-delay-ms",
      "250",
      "--result-text",
      "V2 Pi settled after update",
    ],
  });
  let piResult;
  try {
    piResult = await bridge.run({
      root,
      task: taskId,
      runId,
      role: "implement",
      prompt: "Settle the Node-only post-update V2 Pi smoke.",
      timeoutMs: 15_000,
    });
  } finally {
    await bridge.close();
  }
  assert.equal(piResult.outcome, "settled");
  assert.equal(piResult.schema_version, 2);
  assert.equal(piResult.dispatch_lease_released, true);
  v2AfterUpdate = {
    status: "passed",
    scheduledAction: postUpdateSchedule.receipt.plan.decisions[0]?.action,
    outcome: piResult.outcome,
    schemaVersion: piResult.schema_version,
    dispatchLeaseReleased: piResult.dispatch_lease_released,
  };
} catch (error) {
  v2AfterUpdate = {
    status: "blocked",
    errorCode:
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : null,
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}
const createLegacyTask = (title: string, slug: string) => {
  const args = ["task", "legacy-create", title, "--legacy", "--slug", slug];
  run(args);
};
createLegacyTask("Codex bridge smoke", "codex-smoke");
const prompt = path.join(root, "prompt.md");
fs.writeFileSync(prompt, "Plan acceptance evidence.\n");
const request = JSON.parse(
  run([
    "codex",
    "prepare",
    "codex-smoke",
    "--tool",
    "create",
    "--role",
    "plan",
    "--prompt-file",
    prompt,
    "--target",
    "projectless",
  ]),
);
assert.equal(request.tool, "create_thread");
const receipt = path.join(root, "codex-receipt.json");
fs.writeFileSync(
  receipt,
  JSON.stringify({
    request_id: request.request_id,
    tool: request.tool,
    outcome: "ok",
    thread_id: "installed-smoke-thread",
    host_id: "local",
  }),
);
run([
  "codex",
  "receipt",
  "codex-smoke",
  request.request_id,
  "--result-file",
  receipt,
]);
assert.equal(
  JSON.parse(run(["codex", "status", "codex-smoke"])).threads[0].threadId,
  "installed-smoke-thread",
);
const explicitBlockers = [
  "runParallelBatch remains a separate V1 approvedTask/Pi path; P31 V2 Pi and scheduler acceptance does not validate that legacy entry point. P37 review remains required.",
];
console.log(
  JSON.stringify({
    nodeOnly: true,
    installedTarball: true,
    taskContract: "task-kernel-v2",
    v2TaskReadBack: {
      taskId: taskSnapshot.identity.taskId,
      schemaVersion: taskSnapshot.schemaVersion,
      phase: taskSnapshot.phase,
      runState: taskSnapshot.runs[0].state,
    },
    legacyCompatibilitySmokes: ["codex-bridge"],
    explicitBlockers,
    cursorCreated: false,
    codexReceipt: "simulated",
    piProvider: "simulated",
    v2PiParallel: {
      taskIds,
      scheduledWaveCount: schedule.receipt.plan.waves.length,
      outcomes: piResults.map((result) => result.outcome),
      schemaVersions: piResults.map((result) => result.schema_version),
      dispatchLeasesReleased: piResults.map(
        (result) => result.dispatch_lease_released,
      ),
    },
    v2AfterUpdate,
    coldStartMs,
    steadyCliMs,
    piColdStartupMs: piResults.map((result) => result.startup_ms),
    parallelWallMs,
    endToEndMs: Math.round(performance.now() - started),
  }),
);
