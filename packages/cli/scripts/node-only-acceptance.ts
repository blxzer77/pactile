/** Installed-tarball smoke with a Node-only PATH and the current V2 Task CLI. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [installed, root] = process.argv.slice(2);
if (!installed || !root)
  throw new Error(
    "Usage: node node-only-acceptance.js <installed-package> <workspace>",
  );
for (const folder of (process.env.PATH ?? "").split(path.delimiter)) {
  for (const name of [
    "python",
    "python.exe",
    "python3",
    "python3.exe",
    "py",
    "py.exe",
    "pi",
    "pi.cmd",
  ]) {
    if (folder && fs.existsSync(path.join(folder, name)))
      throw new Error(`Node-only PATH contains ${name}`);
  }
}
fs.mkdirSync(root, { recursive: true });
const cli = path.join(installed, "dist", "bin", "pactile.js");
const run = (args) =>
  String(
    execFileSync(process.execPath, [cli, ...args], {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ).trim();
const taskDir = (slug) => {
  const tasks = path.join(root, ".pactile", "tasks");
  const name = fs
    .readdirSync(tasks)
    .find((entry) => entry.endsWith(`-${slug}`));
  assert.ok(name, `Task ${slug} missing`);
  return path.join(tasks, name);
};
const moduleAt = async (relative) =>
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
run(["update", "--dry-run", "--skip-readiness", "--json"]);
run(["update", "--skip-all", "--skip-readiness", "--json"]);

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

const createLegacyTask = (title, slug, parent = undefined) => {
  const args = ["task", "legacy-create", title, "--legacy", "--slug", slug];
  if (parent) args.push("--parent", parent);
  run(args);
};
const startLegacyTask = (slug) =>
  run(["task", "start-execution", slug, "--approved"]);

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

const fake = path.join(root, "fake-pi.mjs");
fs.writeFileSync(
  fake,
  `import fs from 'node:fs';\nimport path from 'node:path';\n` +
    `const session=path.join(process.env.PI_CODING_AGENT_SESSION_DIR,'session.jsonl');\n` +
    `fs.mkdirSync(path.dirname(session),{recursive:true});fs.writeFileSync(session,'session\\n');\n` +
    `let input='';process.stdin.on('data',chunk=>{input+=chunk.toString();let at;while((at=input.indexOf('\\n'))>=0){` +
    `const line=input.slice(0,at);input=input.slice(at+1);if(!line)continue;const request=JSON.parse(line);` +
    `const reply=data=>process.stdout.write(JSON.stringify({id:request.id,type:'response',command:request.type,success:true,...data})+'\\n');` +
    `if(request.type==='get_state')reply({data:{isStreaming:false,sessionId:'smoke',sessionFile:session}});` +
    `else if(request.type==='prompt'){reply();process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n');` +
    `setTimeout(()=>process.stdout.write(JSON.stringify({type:'agent_end',messages:[{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop'}]})+'\\n'),100);}` +
    `else if(request.type==='abort')reply();}});\n`,
);
const { PiTaskBridge } = await moduleAt("pactile/pi/bridge.js");
const { runParallelBatch } = await moduleAt("pactile/parallel/batch.js");
const { readTaskMap, writeTaskMap } = await moduleAt(
  "pactile/task/task-map.js",
);
const strategy =
  "execution_mode: worker\nisolation: main-worktree\nverification_profile: standard\nretrieval_profile: exact-only\noptional_capabilities: []\nquality_gates:\n  mode: profile\n";
const prepareWorker = (slug) => {
  const dir = taskDir(slug);
  fs.writeFileSync(
    path.join(dir, "design.md"),
    "# Design\nIndependent smoke work.\n",
  );
  fs.writeFileSync(path.join(dir, "implement.md"), strategy);
  startLegacyTask(slug);
  return dir;
};
createLegacyTask("Pi smoke", "pi-smoke");
prepareWorker("pi-smoke");
const bridge = new PiTaskBridge(root, {
  command: process.execPath,
  args: [fake],
});
let first;
let second;
try {
  first = await bridge.run({
    root,
    task: "pi-smoke",
    role: "implement",
    prompt: "first",
    timeoutMs: 5000,
  });
  second = await bridge.run({
    root,
    task: "pi-smoke",
    role: "implement",
    prompt: "second",
    timeoutMs: 5000,
  });
} finally {
  await bridge.close();
}
assert.equal(first.outcome, "settled");
assert.equal(second.outcome, "settled");
assert.equal(second.process_mode, "warm");

createLegacyTask("Parallel parent", "parallel-parent");
const parent = taskDir("parallel-parent");
const children = [];
for (const slug of ["parallel-a", "parallel-b"]) {
  createLegacyTask(slug, slug, path.basename(parent));
  const dir = prepareWorker(slug);
  children.push({
    task: path.basename(dir),
    prompt_file: prompt,
    review_cost: "low",
  });
}
const map = readTaskMap(parent);
assert.ok(map.data);
map.data.parallel_limit = 2;
map.data.children.forEach((child, index) => {
  child.touches = [`src/${index}`];
});
writeTaskMap(parent, map.data, map.body);
const manifest = path.join(root, "batch.json");
fs.writeFileSync(
  manifest,
  JSON.stringify({ schema_version: 1, limit: 2, children }),
);
const batch = await runParallelBatch(root, "parallel-parent", manifest, {
  command: process.execPath,
  args: [fake],
});
assert.deepEqual(
  batch.children.map((child) => child.outcome),
  ["settled", "settled"],
);
assert.ok(
  batch.max_active >= 1 && batch.max_active <= children.length,
  "the scheduler must keep active workers within the manifest size",
);
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
    legacyCompatibilitySmokes: ["codex-bridge", "pi-bridge", "parallel-batch"],
    cursorCreated: false,
    codexReceipt: "simulated",
    piProvider: "simulated",
    coldStartMs,
    steadyCliMs,
    piColdStartupMs: first.startup_ms,
    piWarmStartupMs: second.startup_ms,
    parallelMaxActive: batch.max_active,
    parallelWallMs: batch.wall_ms,
    endToEndMs: Math.round(performance.now() - started),
  }),
);
