import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { applyKernelArchive, applyKernelCreate, applyKernelPatch, applyKernelRecordGate, applyKernelStart, assertFullQualityForPhase, buildAcEvidenceLedger, emptyTaskRecord, parseAcceptanceItems, qualityFingerprint, readDependencyGraph, readKernel, readTopology, resolveRequiredControls, unmetRequires, type PactileTaskRecord } from "../core/task/index.js";
import { addContextEntry, CONTEXT_FILES, readContextEntries, validateContextFile } from "../pactile/task/context.js";
import { readPactileConfig } from "../pactile/task/config.js";
import { checkArchive, checkStartExecution, dependencyStatus } from "../pactile/task/guards.js";
import { exitTask, resolveSelectedTask, resolveTaskDir, selectTask } from "../pactile/task/session.js";
import { artifactFingerprint, contractFingerprint, currentGateErrors, readStrategyContract, requiredGates } from "../pactile/task/strategy.js";
import { CHILD_STATES, childStateErrors, ensureTaskMap, readTaskMap, writeTaskMap, type ChildState } from "../pactile/task/task-map.js";
import { readDeveloper } from "../utils/developer.js";
import { localDate } from "../utils/local-date.js";
import { getAllTaskTemplates } from "../templates/pactile/index.js";
import { learningScaffold, prepareArchiveEvidence } from "../pactile/task/scaffold.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requireArgument(value: string | undefined, label: string): string {
  if (!value || value.startsWith("--")) throw new Error(`${label} is required`);
  return value;
}

function taskDir(root: string, reference: string): string {
  const dir = resolveTaskDir(root, reference);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Task not found: ${reference}`);
  return dir;
}

function taskRecord(dir: string): PactileTaskRecord | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
    return value && typeof value === "object" ? value as PactileTaskRecord : null;
  } catch { return null; }
}

function runTaskHooks(root: string, event: "after_create" | "after_start" | "after_archive", taskJson: string): void {
  const hooks = readPactileConfig(root).hooks;
  const entries = hooks && typeof hooks === "object" && !Array.isArray(hooks) ? hooks[event] : undefined;
  if (!Array.isArray(entries)) return;
  for (const command of entries) {
    if (typeof command !== "string" || !command.trim()) continue;
    try {
      execSync(command, { cwd: root, env: { ...process.env, TASK_JSON_PATH: taskJson }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    } catch (error) {
      console.warn(`[WARN] Hook failed (${event}): ${command} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function patchTask(root: string, reference: string, change: Record<string, unknown>, operation: string, extras?: Record<string, unknown>): void {
  const dir = taskDir(root, reference);
  if (!taskRecord(dir)) throw new Error(`task.json not found at ${dir}`);
  const revision = readKernel({ taskDir: dir, cwd: root }).kernel.revision;
  applyKernelPatch({
    taskDir: dir,
    cwd: root,
    expectedRevision: revision,
    actor: `pactile task ${operation}`,
    idempotencyKey: `patch:${operation}:${path.basename(dir)}:r${revision}`,
    evidence: Object.keys(change).join(",") || operation,
    record: change,
    extras,
  });
}

function activeTasks(root: string): { dir: string; record: PactileTaskRecord }[] {
  const tasks = path.join(root, ".pactile", "tasks");
  if (!fs.existsSync(tasks)) return [];
  return fs.readdirSync(tasks, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "archive" && entry.name !== "locale" && entry.name !== "templates")
    .map((entry) => ({ dir: entry.name, record: taskRecord(path.join(tasks, entry.name)) }))
    .filter((item): item is { dir: string; record: PactileTaskRecord } => item.record !== null)
    .sort((left, right) => left.dir.localeCompare(right.dir));
}

function locale(root: string): "zh" | "en" {
  try {
    const config = fs.readFileSync(path.join(root, ".pactile", "config.yaml"), "utf8");
    return /^artifact_locale:\s*en\s*$/m.test(config) ? "en" : "zh";
  } catch { return "zh"; }
}

function verifySeed(taskLocale: "zh" | "en"): string {
  return taskLocale === "zh"
    ? "# 验证证据\n\n## Planning check\n\n_可选（Full 任务）— 记录规划阶段审查结果。_\n\n## Execution evidence\n\n### Validation commands\n\n<!-- 示例：Validation commands: <命令> — <结果> -->\n\n### Acceptance\n\n<!-- 示例：Final acceptance evidence: <验收标准达成说明> -->\n\n### Durable learning\n\n<!-- 示例：Durable learning decision: no durable learning -->\n"
    : "# Verification Evidence\n\n## Planning check\n\n_Optional for Full tasks — record planning review outcomes._\n\n## Execution evidence\n\n### Validation commands\n\n<!-- Example: Validation commands: <command> — <outcome> -->\n\n### Acceptance\n\n<!-- Example: Final acceptance evidence: <criteria met> -->\n\n### Durable learning\n\n<!-- Example: Durable learning decision: no durable learning -->\n";
}

function createTask(args: string[], root: string): void {
  const title = requireArgument(args[0], "title");
  const slug = (option(args, "--slug") ?? title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("slug must contain lowercase letters, digits and hyphens");
  const parentRef = option(args, "--parent");
  if (parentRef) {
    const parent = taskRecord(taskDir(root, parentRef));
    if (parent?.status !== "planning") throw new Error("create --parent requires a planning Parent task");
  }
  const developer = readDeveloper(root);
  const assignee = option(args, "--assignee") ?? developer;
  if (!assignee) throw new Error("No developer set. Run pactile init --user <name> or pass --assignee");
  const now = new Date();
  const today = localDate(now);
  const prefix = today.slice(5);
  const dirName = `${prefix}-${slug}`;
  const tasks = path.join(root, ".pactile", "tasks");
  const dir = path.join(tasks, dirName);
  if (fs.existsSync(path.join(dir, "task.json"))) throw new Error(`Task already exists: ${dirName}`);
  const archive = path.join(tasks, "archive");
  if (fs.existsSync(archive) && fs.readdirSync(archive, { withFileTypes: true }).some((month) => month.isDirectory() && fs.existsSync(path.join(archive, month.name, dirName)))) {
    throw new Error(`Task already archived: ${dirName}`);
  }
  const taskLocale = locale(root);
  const templatePath = path.join(tasks, "locale", taskLocale, "default-prd.md");
  const prdTemplate = fs.existsSync(templatePath)
    ? fs.readFileSync(templatePath, "utf8")
    : getAllTaskTemplates().get(`tasks/locale/${taskLocale}/default-prd.md`);
  if (!prdTemplate) throw new Error(`Task PRD template not found for locale ${taskLocale}`);
  const contextSeeds = fs.existsSync(path.join(root, ".codex"))
    ? [".pactile/spec/guides/index.md", ".pactile/framework/verification-strength-guide.md", ".pactile/framework/injection-budget-guide.md"]
      .filter((entry) => fs.existsSync(path.join(root, entry)))
    : [];
  if (fs.existsSync(path.join(root, ".codex")) && contextSeeds.length < 2) {
    throw new Error("task create requires at least two existing spec guide paths for JSONL seed");
  }
  let baseBranch = "main";
  try { baseBranch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() || "main"; }
  catch { /* A non-Git project still has a valid default base branch. */ }
  const description = option(args, "--description") ?? "";
  const record = emptyTaskRecord({
    id: slug, name: slug, title, description,
    priority: option(args, "--priority") ?? "P2",
    package: option(args, "--package") ?? null,
    creator: developer ?? assignee,
    assignee,
    createdAt: today,
    base_branch: baseBranch,
  });
  const rigor = option(args, "--rigor") ?? "lite";
  if (rigor !== "lite" && rigor !== "full") throw new Error("--rigor must be lite or full");
  fs.mkdirSync(dir, { recursive: true });
  applyKernelCreate({ taskDir: dir, record, actor: "pactile task create", idempotencyKey: `create:${slug}`, evidence: "pactile task create", cwd: root,
    extras: { required_controls: resolveRequiredControls({ rigor }) } });
  const prd = path.join(dir, "prd.md");
  const verify = path.join(dir, "verify.md");
  if (!fs.existsSync(prd)) {
    fs.writeFileSync(prd, prdTemplate.replaceAll("{title}", title).replaceAll("{goal}", description || (taskLocale === "zh" ? "待补充。" : "TBD.")), "utf8");
  }
  if (!fs.existsSync(verify)) fs.writeFileSync(verify, verifySeed(taskLocale), "utf8");
  if (fs.existsSync(path.join(root, ".codex"))) {
    for (const name of CONTEXT_FILES) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) fs.writeFileSync(file, `${contextSeeds.map((entry) => JSON.stringify({ file: entry, reason: "default spec seed — curate entries for this task" })).join("\n")}\n`, "utf8");
    }
  }
  if (parentRef) linkChild(root, parentRef, dirName);
  runTaskHooks(root, "after_create", path.join(dir, "task.json"));
  console.log(path.relative(root, dir).replaceAll("\\", "/"));
}

function linkChild(root: string, parentRef: string, childRef: string): void {
  const parentDir = taskDir(root, parentRef);
  const childDir = taskDir(root, childRef);
  if (parentDir === childDir) throw new Error("a task cannot be its own parent");
  const parent = taskRecord(parentDir);
  const child = taskRecord(childDir);
  if (!parent || !child) throw new Error("parent and child need task.json");
  if (child.parent && child.parent !== path.basename(parentDir)) throw new Error(`single-parent tree: child already belongs to ${child.parent}`);
  if (parent.parent === path.basename(childDir) || child.children.includes(path.basename(parentDir))) throw new Error("parent-child cycle rejected");
  if (parent.status !== "planning" || child.status !== "planning") throw new Error("link children while both tasks are planning");
  if (parent.children.includes(path.basename(childDir)) && child.parent === path.basename(parentDir)) return;
  const nextChildren = [...new Set([...parent.children, path.basename(childDir)])];
  patchTask(root, path.basename(parentDir), { children: nextChildren }, "add-subtask");
  try { patchTask(root, path.basename(childDir), { parent: path.basename(parentDir) }, "add-subtask"); }
  catch (error) {
    patchTask(root, path.basename(parentDir), { children: parent.children }, "add-subtask-rollback",
      { topology: { ...readTopology(readKernel({ taskDir: parentDir, cwd: root }).kernel.projection?.extras ?? {}), children: parent.children } });
    throw error;
  }
  const nextParent = taskRecord(parentDir);
  if (!nextParent) throw new Error("parent projection vanished after link");
  ensureTaskMap(parentDir, nextParent, `Linked Child ${path.basename(childDir)}.`);
}

function unlinkChild(root: string, parentRef: string, childRef: string): void {
  const parentDir = taskDir(root, parentRef);
  const childDir = taskDir(root, childRef);
  const parent = taskRecord(parentDir);
  const child = taskRecord(childDir);
  if (!parent || !child) throw new Error("parent and child need task.json");
  if (!parent.children.includes(path.basename(childDir)) || child.parent !== path.basename(parentDir)) throw new Error("parent-child link not found");
  const map = readTaskMap(parentDir).data;
  const entry = map?.children.find((item) => item.id === path.basename(childDir));
  if (parent.status !== "planning" || child.status !== "planning" || (entry && entry.state !== "open")) throw new Error("unlink only an open Child while both tasks are planning");
  const nextChildren = parent.children.filter((id) => id !== path.basename(childDir));
  const parentTopology = readTopology(readKernel({ taskDir: parentDir, cwd: root }).kernel.projection?.extras ?? {});
  const childTopology = readTopology(readKernel({ taskDir: childDir, cwd: root }).kernel.projection?.extras ?? {});
  patchTask(root, path.basename(childDir), { parent: null }, "remove-subtask", { topology: { ...childTopology, parent_id: null } });
  patchTask(root, path.basename(parentDir), { children: nextChildren }, "remove-subtask", { topology: { ...parentTopology, children: nextChildren } });
  const nextParent = taskRecord(parentDir);
  if (nextParent) ensureTaskMap(parentDir, nextParent, `Unlinked Child ${path.basename(childDir)}.`);
}

function prepareChildWorktree(root: string, args: string[]): number {
  const parentDir = taskDir(root, requireArgument(args[0], "parent task"));
  const childDir = taskDir(root, requireArgument(args[1], "child task"));
  const branch = requireArgument(option(args, "--branch"), "--branch");
  const parent = taskRecord(parentDir);
  const child = taskRecord(childDir);
  if (!parent || !child) throw new Error("Parent and Child need task.json");
  if (child.parent !== path.basename(parentDir) || !parent.children.includes(path.basename(childDir))) throw new Error("Child must be linked to the Parent");
  const map = readTaskMap(parentDir);
  if (!map.data?.children.some((entry) => entry.id === path.basename(childDir))) throw new Error("Child missing from Parent task-map.md");
  const base = option(args, "--base") ?? child.base_branch ?? parent.base_branch ?? "HEAD";
  const worktreeRoot = path.resolve(root, ".pactile", "worktrees");
  const destination = path.resolve(root, option(args, "--path") ?? path.join(worktreeRoot, path.basename(childDir)));
  const relative = path.relative(worktreeRoot, destination);
  const errors: string[] = [];
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) errors.push("worktree path must stay under .pactile/worktrees");
  if (fs.lstatSync(path.join(root, ".pactile"), { throwIfNoEntry: false })?.isSymbolicLink()) errors.push(".pactile must not be a symlink");
  if (fs.lstatSync(worktreeRoot, { throwIfNoEntry: false })?.isSymbolicLink()) errors.push(".pactile/worktrees must not be a symlink");
  let ancestor = worktreeRoot;
  for (const segment of relative.split(path.sep).slice(0, -1)) {
    ancestor = path.join(ancestor, segment);
    if (fs.lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) errors.push(`worktree path crosses a symlink: ${ancestor}`);
  }
  if (fs.existsSync(destination)) errors.push(`worktree path already exists: ${destination}`);
  if (branch.startsWith("-") || /[\r\n]/.test(branch)) errors.push("invalid branch name");
  if (typeof base !== "string" || base.startsWith("-") || /[\r\n]/.test(base)) errors.push("invalid base ref");
  const git = (...gitArgs: string[]): string => execFileSync("git", gitArgs, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    if (git("rev-parse", "--show-toplevel").toLowerCase() !== path.resolve(root).replaceAll("\\", "/").toLowerCase()) errors.push("prepare-child-worktree requires the project Git root");
    git("check-ref-format", "--branch", branch);
    if (typeof base === "string" && !base.startsWith("-")) git("rev-parse", "--verify", `${base}^{commit}`);
  } catch { errors.push("Git repository, branch, or base ref validation failed"); }
  if (errors.length) { console.error(errors.map((error) => `  - ${error}`).join("\n")); return 1; }
  const worktreePath = path.relative(root, destination).replaceAll("\\", "/");
  if (args.includes("--check")) { console.log(`Prepare-child-worktree check: PASS\nBranch: ${branch}\nBase: ${base}\nPath: ${worktreePath}\nNo files changed.`); return 0; }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  let branchExists = false;
  try { git("rev-parse", "--verify", `refs/heads/${branch}`); branchExists = true; } catch { /* New local branch. */ }
  try {
    git("worktree", "add", ...(branchExists ? [] : ["-b", branch]), destination, ...(branchExists ? [branch] : [base as string]));
  } catch (error) {
    console.error(`git worktree add failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  patchTask(root, path.basename(childDir), { branch, worktree_path: worktreePath }, "prepare-child-worktree");
  const entry = map.data?.children.find((item) => item.id === path.basename(childDir));
  if (!map.data || !entry) throw new Error("Child vanished from Parent task-map.md after worktree creation");
  Object.assign(entry, { isolation: "git-worktree", branch, worktree_path: worktreePath, base_ref: base, ref: `refs/heads/${branch}` });
  writeTaskMap(parentDir, map.data, map.body, `Prepared Child ${entry.id} git worktree at ${worktreePath} from ${base}.`);
  console.log(`Child worktree prepared: ${entry.id}\nBranch: ${branch}\nPath: ${worktreePath}`);
  return 0;
}

function updateChildState(root: string, args: string[], integrated: boolean): number {
  const parentDir = taskDir(root, requireArgument(args[0], "parent task"));
  const childDir = taskDir(root, requireArgument(args[1], "child task"));
  const state = requireArgument(args[2], "state") as ChildState;
  if (!(CHILD_STATES as readonly string[]).includes(state)) throw new Error(`unknown child state: ${state}`);
  if (integrated !== ["changes", "accepted", "integrating", "integrated", "cancelled"].includes(state)) throw new Error(integrated ? "use a Parent-controlled integration state" : "use integrate-child for Parent-controlled states");
  const parent = taskRecord(parentDir);
  const child = taskRecord(childDir);
  if (!parent || !child) throw new Error("parent and child need task.json");
  if (child.parent !== path.basename(parentDir)) throw new Error("child is not linked to parent");
  const evidence = requireArgument(option(args, "--evidence"), "--evidence");
  const ref = option(args, "--ref");
  const reason = option(args, "--reason");
  const errors = childStateErrors(parentDir, parent, childDir, state, evidence, { ref, reason });
  if (integrated && ["accepted", "integrating", "integrated"].includes(state)) {
    const extras = readKernel({ taskDir: childDir, cwd: root }).kernel.projection?.extras ?? {};
    if ((extras.required_controls as Record<string, unknown> | undefined)?.rigor === "full") {
      const parsed = readStrategyContract(childDir);
      errors.push(...parsed.errors);
      if (parsed.contract) errors.push(...currentGateErrors(childDir, child, "child-review", requiredGates("child-review", parsed.contract), parsed.contract, readKernel({ taskDir: childDir, cwd: root }).kernel.gates as unknown as Record<string, unknown>));
      try { assertFullQualityForPhase(childDir, extras, "archive"); }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
  }
  const executeMerge = args.includes("--execute-merge");
  if (executeMerge) {
    if (!integrated || state !== "integrated") errors.push("--execute-merge is only valid with integrate-child ... integrated");
    if (!ref || ref.startsWith("-") || /[\r\n]/.test(ref)) errors.push("--execute-merge requires a valid --ref");
    const git = (...gitArgs: string[]): string => execFileSync("git", gitArgs, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    try {
      if (git("rev-parse", "--show-toplevel").toLowerCase() !== path.resolve(root).replaceAll("\\", "/").toLowerCase()) errors.push("merge execution requires the project Git root");
      if (ref) git("rev-parse", "--verify", `${ref}^{commit}`);
    } catch { errors.push(`merge ref does not resolve to a commit: ${ref ?? "(missing)"}`); }
    try {
      const dirty = git("status", "--porcelain", "--untracked-files=all").split(/\r?\n/).filter(Boolean)
        .map((line) => line.slice(3).trim().replaceAll("\\", "/").replace(/^"|"$/g, ""))
        .filter((file) => file !== ".pactile" && !file.startsWith(".pactile/"));
      if (dirty.length) errors.push(`non-Pactile working tree changes block merge execution: ${dirty.slice(0, 8).join(", ")}`);
    } catch { errors.push("git status failed during merge preflight"); }
  }
  if (errors.length) { console.error(errors.map((error) => `  - ${error}`).join("\n")); return 1; }
  if (args.includes("--check")) { console.log(`Child state check: PASS (${state})`); return 0; }
  if (executeMerge) {
    try { execFileSync("git", ["merge", "--no-ff", "--no-commit", ref as string], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) {
      console.error(`git merge failed; Parent task-map was not advanced to integrated: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  const { data, body } = readTaskMap(parentDir);
  if (!data) throw new Error("task-map.md missing");
  const entry = data.children.find((item) => item.id === path.basename(childDir));
  if (!entry) throw new Error("child missing from task-map.md");
  entry.state = state;
  entry.evidence = evidence;
  if (ref) entry.ref = ref;
  if (reason) entry.reason = reason;
  if (state === "integrating" && !data.integration_queue.includes(entry.id)) data.integration_queue.push(entry.id);
  else if (state !== "integrating") data.integration_queue = data.integration_queue.filter((id) => id !== entry.id);
  const previous = readKernel({ taskDir: parentDir, cwd: root }).kernel.projection?.extras ?? {};
  const states = previous.task_map_states && typeof previous.task_map_states === "object" ? previous.task_map_states as Record<string, unknown> : {};
  patchTask(root, path.basename(parentDir), {}, integrated ? "integrate-child" : "set-child-state",
    { task_map_states: { ...states, [entry.id]: state }, ...(integrated ? { integration_action: "integrate-child", integration_actor: "parent" } : {}) });
  writeTaskMap(parentDir, data, body, `${integrated ? "Parent integrated" : "Child reported"} ${entry.id} as ${state}. Evidence: ${evidence}.`);
  console.log(`${entry.id}: ${state}`);
  return 0;
}

function reviewChild(root: string, args: string[]): number {
  const parentDir = taskDir(root, requireArgument(args[0], "parent task"));
  const childDir = taskDir(root, requireArgument(args[1], "child task"));
  const parent = taskRecord(parentDir);
  const child = taskRecord(childDir);
  if (child?.parent !== path.basename(parentDir) || !parent?.children.includes(path.basename(childDir))) throw new Error("linked Parent and Child task.json are required");
  const map = readTaskMap(parentDir).data;
  const entry = map?.children.find((item) => item.id === path.basename(childDir));
  if (!entry) throw new Error("Child missing from Parent task-map.md");
  const decision = option(args, "--decision");
  if (decision && !["accept", "changes", "cancel", "integrate-through"].includes(decision)) throw new Error("--decision must be accept, changes, cancel, or integrate-through");
  const check = args.includes("--check") || !decision;
  const ref = option(args, "--ref");
  const reason = option(args, "--reason");
  const notes = option(args, "--notes");
  const verifyFile = path.join(childDir, "verify.md");
  const handoffFile = path.join(childDir, "handoff.md");
  const verify = fs.existsSync(verifyFile) ? fs.readFileSync(verifyFile, "utf8") : "";
  const handoff = fs.existsSync(handoffFile) ? fs.readFileSync(handoffFile, "utf8") : "";
  const excerpt = (content: string): string => content.slice(0, 800).trim().split(/\r?\n/).map((line) => `> ${line}`).join("\n") || "> (empty)";
  const report = [
    `# Parent review — \`${path.basename(childDir)}\``, "", `- Timestamp: ${new Date().toISOString()}`,
    `- Current integration state: \`${entry.state}\``, `- Decision: \`${check ? "check-only" : decision}\``, "",
    "## Handoff artifacts", "", `- verify.md: ${verify.trim() ? "present" : "missing"}`,
    `- handoff.md: ${handoff.trim() ? "present" : "missing"}`,
    `- validation signal: ${/^\s*(?:[-*]\s*)?validation(?:\s+(?:commands?|results?|evidence))?\s*:\s*\S.{2,}$/im.test(verify)}`,
    `- acceptance signal: ${/^\s*(?:[-*]\s*)?(?:(?:final|user)\s+)?acceptance(?:\s+evidence)?\s*:\s*\S.{2,}$/im.test(verify)}`,
    `- durable learning decision signal: ${/durable learning decision\s*:/i.test(verify)}`, "",
    ...(notes ? ["## Parent notes", "", excerpt(notes), ""] : []),
    "## verify.md excerpt", "", excerpt(verify), "",
    "## handoff.md excerpt", "", excerpt(handoff), "",
  ].join("\n");
  if (check) {
    const errors = [
      ...(entry.state !== "review" ? [`Child must be in review state, got ${entry.state}`] : []),
      ...(!verify.trim() ? ["verify.md missing"] : []),
      ...(!handoff.trim() ? ["handoff.md missing"] : []),
    ];
    console.log(`Review-child check: ${errors.length ? "FAIL" : "PASS"}\n${errors.map((error) => `  - ${error}`).join("\n")}\n\n${report}`);
    return errors.length ? 1 : 0;
  }
  const state = decision === "accept" || decision === "integrate-through" ? "accepted" : decision === "changes" ? "changes" : "cancelled";
  const transition = (target: string, evidence: string): number => updateChildState(root,
    [path.basename(parentDir), path.basename(childDir), target, "--evidence", evidence, ...(ref ? ["--ref", ref] : []), ...(reason ? ["--reason", reason] : [])], true);
  // Validate the first transition before writing any review artifact or Parent evidence.
  const firstCheck = updateChildState(root,
    [path.basename(parentDir), path.basename(childDir), state, "--evidence", "handoff.md", ...(ref ? ["--ref", ref] : []), ...(reason ? ["--reason", reason] : []), "--check"], true);
  if (firstCheck !== 0) return firstCheck;
  if (transition(state, "handoff.md") !== 0) return 1;
  if (decision === "integrate-through") {
    if (transition("integrating", "task-map.md") !== 0 || transition("integrated", "task-map.md") !== 0) return 1;
  }
  const reviewFile = path.join(parentDir, `review-${path.basename(childDir)}.md`);
  if (args.includes("--write-artifact")) fs.writeFileSync(reviewFile, `${report}\n`, "utf8");
  if (!args.includes("--no-append-parent-verify")) {
    const parentVerify = path.join(parentDir, "verify.md");
    const current = fs.existsSync(parentVerify) ? fs.readFileSync(parentVerify, "utf8") : "# Verification Evidence\n";
    const note = `## Parent review — \`${path.basename(childDir)}\`\n\n- Decision: ${decision}\n- Child handoff: ${path.basename(childDir)}/handoff.md\n- Child verification: ${path.basename(childDir)}/verify.md\n- Review artifact: ${args.includes("--write-artifact") ? path.basename(reviewFile) : "not written"}\n`;
    fs.writeFileSync(parentVerify, `${current.trimEnd()}\n\n${note}`, "utf8");
  }
  console.log(report);
  return 0;
}

function listTasks(args: string[], root: string): void {
  const developer = readDeveloper(root);
  const mine = args.includes("--mine") || args.includes("-m");
  if (mine && !developer) throw new Error("No developer set. Run pactile init --user <name>");
  const assignee = option(args, "--assignee") ?? (mine ? developer : undefined);
  const status = option(args, "--status") ?? option(args, "-s");
  const selected = resolveSelectedTask(root).taskPath;
  const tasks = activeTasks(root).filter(({ record }) => (!assignee || record.assignee === assignee) && (!status || record.status === status));
  console.log(assignee ? `Tasks (assignee: ${assignee}):` : "All active tasks:");
  console.log();
  for (const { dir, record } of tasks) {
    const marker = `.pactile/tasks/${dir}` === selected ? " <- selected" : "";
    console.log(`  - ${dir}/ (${record.status})${record.package ? ` @${record.package}` : ""} [${record.assignee || "-"}]${marker}`);
  }
  if (!tasks.length) console.log("  (no active tasks)");
  console.log(`\nTotal: ${tasks.length} task(s)`);
}

function listArchive(root: string, month?: string): void {
  if (month && !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error("archive month must be YYYY-MM");
  const archive = path.join(root, ".pactile", "tasks", "archive");
  console.log("Archived tasks:\n");
  if (!fs.existsSync(archive)) return;
  const months = month ? [month] : fs.readdirSync(archive, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const name of months) {
    const monthDir = path.join(archive, name);
    if (!fs.statSync(monthDir, { throwIfNoEntry: false })?.isDirectory()) { console.log(`  No archives for ${name}`); continue; }
    const tasks = fs.readdirSync(monthDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    console.log(`[${name}]${month ? "" : ` - ${tasks.length} task(s)`}`);
    if (month) for (const task of tasks) console.log(`  - ${task}/`);
  }
}

function dashboard(root: string): void {
  const selected = resolveSelectedTask(root);
  console.log("Task Dashboard\nPactile framework: active");
  console.log(`Selected task: ${selected.taskPath ?? "none"}${selected.taskPath ? ` (${selected.source})` : ""}\n`);
  const tasks = activeTasks(root);
  if (!tasks.length) console.log("Tasks: none");
  for (const [status, heading] of [["planning", "Define"], ["in_progress", "Execute"], ["review", "Verify"]] as const) {
    const matching = tasks.filter(({ record }) => record.status === status);
    if (!matching.length) continue;
    console.log(`${heading}:`);
    for (const { dir, record } of matching) console.log(`  - .pactile/tasks/${dir} (${heading}) [${record.assignee || "-"}]`);
    console.log();
  }
  console.log("Suggested actions:\n  - Select a task: pactile task select <task>\n  - Create a task: pactile task create \"<title>\" --slug <slug>\n  - Inspect raw list: pactile task list");
}

function startExecution(root: string, args: string[]): number {
  const dir = taskDir(root, requireArgument(args[0], "task"));
  const record = taskRecord(dir);
  if (!record) throw new Error(`task.json not found at ${dir}`);
  const check = args.includes("--check");
  const approved = args.includes("--approved");
  if (check === approved) throw new Error("choose --check or --approved");
  const guard = checkStartExecution(root, dir, record, approved, args.includes("--ignore-deps"));
  for (const warning of guard.warnings) console.error(`[dependencies] WARN: ${warning}`);
  if (!guard.ok) {
    console.error(`Start-execution check: FAIL\n${guard.errors.map((error) => `  - ${error}`).join("\n")}`);
    return 1;
  }
  if (check) {
    console.log(`Start-execution check: PASS\nContract fingerprint: ${guard.contractFingerprint}\nArtifact fingerprint: ${guard.artifactFingerprint}`);
    console.log("Artifact gates are ready. Ask the user for explicit execution approval before running --approved.");
    return 0;
  }
  const prior = record as unknown as Record<string, unknown>;
  const priorApproval = prior.execution_approval;
  if (priorApproval && typeof priorApproval === "object") {
    const old = priorApproval as Record<string, unknown>;
    if (old.contract_fingerprint !== guard.contractFingerprint || old.artifact_fingerprint !== guard.artifactFingerprint) {
      throw new Error("stale execution approval; return to Planning and ask for explicit approval again");
    }
  }
  const checkedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const baseline = {
    schema_version: 1, transition: "start-execution", gate: "baseline-check", result: "PASS",
    reviewer: "pactile-cli", evidence: "task.json", checked_at: checkedAt,
    contract_fingerprint: guard.contractFingerprint, artifact_fingerprint: guard.artifactFingerprint,
    issue_fingerprint: null, consecutive_failures: 0, approved_skip: null,
  };
  const existingQgr = prior.quality_gate_results && typeof prior.quality_gate_results === "object"
    ? prior.quality_gate_results as Record<string, unknown> : {};
  const transitions = existingQgr.transitions && typeof existingQgr.transitions === "object"
    ? existingQgr.transitions as Record<string, unknown> : {};
  const qualityGateResults = {
    ...existingQgr,
    schema_version: 1,
    contract_fingerprint: guard.contractFingerprint,
    artifact_fingerprint: guard.artifactFingerprint,
    transitions: { ...transitions, "start-execution": { "baseline-check": baseline } },
  };
  const approval = {
    schema_version: 1, transition: "start-execution", approved_at: checkedAt,
    approved_by: "user", approval_source: "pactile task start-execution --approved",
    contract_fingerprint: guard.contractFingerprint, artifact_fingerprint: guard.artifactFingerprint,
  };
  const extras: Record<string, unknown> = { quality_gate_results: qualityGateResults, execution_approval: approval };
  const dependencyFacts = dependencyStatus(root, dir, record);
  const priorExtras = readKernel({ taskDir: dir, cwd: root }).kernel.projection?.extras ?? {};
  const attestedSatisfied = Array.isArray(priorExtras.dependency_satisfied)
    ? priorExtras.dependency_satisfied.filter((item): item is string => typeof item === "string") : [];
  extras.dependency_satisfied = [...new Set([...attestedSatisfied, ...dependencyFacts.satisfied])];
  const controls = readKernel({ taskDir: dir, cwd: root }).kernel.projection?.extras?.required_controls;
  if (controls && typeof controls === "object" && (controls as Record<string, unknown>).rigor === "full") {
    const parsed = readStrategyContract(dir);
    if (!parsed.contract) throw new Error(parsed.errors.join("; "));
    const currentContract = contractFingerprint(dir, record, parsed.contract);
    const autoGates = requiredGates("start-execution", parsed.contract);
    for (const gate of autoGates) {
      const stamp = new Date().toISOString();
      const artifact = artifactFingerprint(dir, record, "start-execution", gate);
      const gateRecord = { schema_version: 1, transition: "start-execution", gate, result: "PASS", reviewer: "pactile-cli", evidence: gate === "requirements-review" ? "prd.md" : "design.md + implement.md",
        checked_at: stamp, contract_fingerprint: currentContract, artifact_fingerprint: artifact,
        issue_fingerprint: null, consecutive_failures: 0, approved_skip: null };
      const gateRevision = readKernel({ taskDir: dir, cwd: root }).kernel.revision;
      applyKernelRecordGate({ taskDir: dir, cwd: root, expectedRevision: gateRevision,
        actor: "pactile task start-execution planning review", idempotencyKey: `planning:${record.id}:${gate}:r${gateRevision}`,
        transition: "start-execution", gateName: gate, record: gateRecord, evidence: String(gateRecord.evidence) });
      const transitionRows = (qualityGateResults.transitions as Record<string, unknown>)["start-execution"] as Record<string, unknown>;
      transitionRows[gate] = gateRecord;
    }
  }
  if (args.includes("--ignore-deps")) {
    extras.dependency_override = {
      schema_version: 1,
      approved_by: "user",
      transition: "start-execution",
      dependencies: unmetRequires(readDependencyGraph(priorExtras), extras.dependency_satisfied as string[], record.id),
      source: "pactile task start-execution --approved --ignore-deps",
      at: checkedAt,
    };
  }
  const revision = readKernel({ taskDir: dir, cwd: root }).kernel.revision;
  applyKernelStart({
    taskDir: dir, cwd: root, expectedRevision: revision,
    actor: "pactile task start-execution --approved",
    idempotencyKey: `start:${record.id || path.basename(dir)}:${checkedAt}`,
    evidence: "pactile task start-execution --approved",
    record: { ...record, status: "in_progress" },
    extras,
  });
  runTaskHooks(root, "after_start", path.join(dir, "task.json"));
  console.log(`Execution approved for: ${path.relative(root, dir).replaceAll("\\", "/")}\nStatus: in_progress`);
  return 0;
}

function recordGate(root: string, args: string[]): number {
  const dir = taskDir(root, requireArgument(args[0], "task"));
  const task = taskRecord(dir);
  if (!task) throw new Error(`task.json not found at ${dir}`);
  const transition = requireArgument(option(args, "--transition"), "--transition");
  const gate = requireArgument(option(args, "--gate"), "--gate");
  const result = requireArgument(option(args, "--result"), "--result").toUpperCase();
  const reviewer = requireArgument(option(args, "--reviewer"), "--reviewer");
  const evidence = requireArgument(option(args, "--evidence"), "--evidence");
  if (!["PASS", "FAIL", "SKIPPED"].includes(result)) throw new Error("--result must be PASS, FAIL, or SKIPPED");
  const allowed: Record<string, string[]> = {
    "start-execution": ["requirements-review", "architecture-review"],
    "full-task-complete": ["code-review", "architecture-review", "architecture-deep-review"],
    "child-review": ["code-review", "architecture-review", "architecture-deep-review"],
    "parent-integrated": ["integration-review"],
  };
  if (!allowed[transition]?.includes(gate)) throw new Error(`unsupported transition/gate pair: ${transition}/${gate}`);
  if (!/^[A-Za-z0-9_.:@/-]+$/.test(reviewer)) throw new Error("--reviewer must be a short identifier");
  if (!evidence.trim() || evidence.length > 240 || /[\r\n]/.test(evidence)) throw new Error("--evidence must be a short single-line reference");
  if (result === "FAIL" && (!option(args, "--issue-fingerprint") || !option(args, "--root-cause"))) throw new Error("FAIL requires --issue-fingerprint and --root-cause");
  if (result === "FAIL" && !["implementation-defect", "contract-changing-defect", "validation-environment-blocker"].includes(option(args, "--root-cause") ?? "")) throw new Error("--root-cause is not a known failure route");
  if (result === "SKIPPED" && (option(args, "--skip-approved-by") !== "user" || !option(args, "--skip-reason"))) throw new Error("SKIPPED requires --skip-approved-by user and --skip-reason");
  const parsed = fs.existsSync(path.join(dir, "implement.md")) ? readStrategyContract(dir) : { contract: null, errors: [] };
  if (parsed.errors.length && transition !== "parent-integrated") throw new Error(parsed.errors.join("; "));
  const currentContract = contractFingerprint(dir, task, parsed.contract);
  const currentArtifact = artifactFingerprint(dir, task, transition, gate);
  if (option(args, "--contract-fingerprint") && option(args, "--contract-fingerprint") !== currentContract) throw new Error("contract fingerprint assertion is stale");
  if (option(args, "--artifact-fingerprint") && option(args, "--artifact-fingerprint") !== currentArtifact) throw new Error("artifact fingerprint assertion is stale");
  const record: Record<string, unknown> = {
    schema_version: 1, transition, gate, result, reviewer, evidence, checked_at: new Date().toISOString(),
    contract_fingerprint: currentContract, artifact_fingerprint: currentArtifact,
    issue_fingerprint: result === "FAIL" ? option(args, "--issue-fingerprint") : null,
    root_cause: result === "FAIL" ? option(args, "--root-cause") : null,
    issue_summary: result === "FAIL" ? option(args, "--issue-summary") ?? null : null,
    consecutive_failures: result === "FAIL" ? 1 : 0,
    approved_skip: result === "SKIPPED" ? { approved_by: "user", reason: option(args, "--skip-reason") } : null,
  };
  const revision = readKernel({ taskDir: dir, cwd: root }).kernel.revision;
  applyKernelRecordGate({ taskDir: dir, cwd: root, expectedRevision: revision, actor: `pactile task record-gate ${reviewer}`,
    idempotencyKey: `record-gate:${task.id}:${transition}:${gate}:r${revision}`,
    transition, gateName: gate, record, evidence });
  console.log(`${transition}/${gate}: ${result}`);
  return 0;
}

function recordAcEvidence(root: string, args: string[]): number {
  const reference = requireArgument(args[0], "task");
  const dir = taskDir(root, reference);
  const prd = fs.readFileSync(path.join(dir, "prd.md"), "utf8");
  const verify = fs.readFileSync(path.join(dir, "verify.md"), "utf8");
  const mappings: { ac_id: string; evidence_ref: string }[] = [];
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] !== "--map") continue;
    const assignment = requireArgument(args[index + 1], "--map AC-N=reference");
    const equal = assignment.indexOf("=");
    if (equal < 0) throw new Error("--map must be AC-N=reference");
    mappings.push({ ac_id: assignment.slice(0, equal), evidence_ref: assignment.slice(equal + 1) });
    index += 1;
  }
  if (!mappings.length) throw new Error("at least one --map AC-N=reference is required");
  const codeRef = requireArgument(option(args, "--code-ref"), "--code-ref");
  const ledger = buildAcEvidenceLedger({ acceptanceItems: parseAcceptanceItems(prd), mappings,
    sourceFingerprint: qualityFingerprint(prd), evidenceFingerprint: qualityFingerprint(verify), testedCodeFingerprint: codeRef });
  patchTask(root, reference, {}, "record-ac-evidence", { ac_evidence_ledger: ledger });
  console.log(`AC evidence ledger recorded: ${ledger.items.length} mapped criteria`);
  return 0;
}

function recordIndependentCheck(root: string, args: string[]): number {
  const reference = requireArgument(args[0], "task");
  const mode = requireArgument(option(args, "--mode"), "--mode");
  const result = requireArgument(option(args, "--result"), "--result").toUpperCase();
  const evidence = requireArgument(option(args, "--evidence"), "--evidence");
  const codeRef = requireArgument(option(args, "--code-ref"), "--code-ref");
  if (mode !== "self-review" && mode !== "true-independent") throw new Error("--mode must be self-review or true-independent");
  if (!["PASS", "FAIL", "BLOCKED"].includes(result)) throw new Error("--result must be PASS, FAIL, or BLOCKED");
  const independentWorker = args.includes("--independent-worker");
  if (mode === "true-independent" && result === "PASS" && !independentWorker) throw new Error("true-independent PASS requires --independent-worker");
  const reviewer = option(args, "--reviewer");
  if (mode === "true-independent" && result === "PASS" && !reviewer) throw new Error("true-independent PASS requires --reviewer");
  const verdict = { schema_version: 1, mode, readonly: true, result, evidence,
    independent_worker: independentWorker, reviewer: reviewer ?? null, code_fingerprint: codeRef, checked_at: new Date().toISOString() };
  patchTask(root, reference, {}, "record-independent-check", { independent_check: verdict });
  console.log(`Independent check: ${result} (${mode})`);
  return 0;
}

function archiveTask(root: string, args: string[]): number {
  const dir = taskDir(root, requireArgument(args[0], "task"));
  const record = taskRecord(dir);
  if (!record) throw new Error(`task.json not found at ${dir}`);
  const guard = checkArchive(dir, record);
  const activeChildren = record.children.map((id) => path.join(root, ".pactile", "tasks", id)).filter((candidate) => fs.existsSync(candidate));
  if (activeChildren.length && !args.includes("--archive-integrated-children")) guard.errors.push(`active children remain: ${activeChildren.map((candidate) => path.basename(candidate)).join(", ")}; use --archive-integrated-children after preflight`);
  if (activeChildren.length && args.includes("--archive-integrated-children")) {
    for (const childDir of activeChildren) {
      const child = taskRecord(childDir);
      if (!child) { guard.errors.push(`child task.json missing: ${path.basename(childDir)}`); continue; }
      guard.errors.push(...checkArchive(childDir, child).errors.map((message) => `${path.basename(childDir)}: ${message}`));
    }
  }
  guard.ok = guard.errors.length === 0;
  if (!guard.ok) {
    console.error(`Archive check: FAIL\n${guard.errors.map((error) => `  - ${error}`).join("\n")}`);
    return 1;
  }
  if (args.includes("--check")) {
    console.log("Archive check: PASS");
    return 0;
  }
  if (activeChildren.length) {
    for (const childDir of activeChildren) {
      const childArgs = [path.basename(childDir), "--no-commit"];
      if (archiveTask(root, childArgs) !== 0) throw new Error(`child archive failed: ${path.basename(childDir)}`);
    }
  }
  const now = new Date();
  const completedAt = localDate(now);
  const month = completedAt.slice(0, 7);
  const destination = path.join(root, ".pactile", "tasks", "archive", month, path.basename(dir));
  if (fs.existsSync(destination)) throw new Error(`Archive destination already exists: ${destination}`);
  const revision = readKernel({ taskDir: dir, cwd: root }).kernel.revision;
  const archivedRelative = path.relative(root, destination).replaceAll("\\", "/");
  const verifyText = fs.readFileSync(path.join(dir, "verify.md"), "utf8");
  const acceptance = verifyText.match(/^\s*(?:[-*]\s*)?(?:(?:final|user)\s+)?acceptance(?:\s+evidence)?\s*:\s*(\S[^\r\n]*)$/im)?.[1]?.trim();
  const points = acceptance ? [{ text: acceptance, source: "verify.md", confidence: "low" }] : [];
  const notesProjection = {
    schema_version: 1,
    summary: points.map((point) => point.text).join("; ").split(/\s+/).slice(0, 150).join(" "),
    pointers: [archivedRelative, `${archivedRelative}/verify.md`],
    source: "cmd_archive",
    points,
  };
  applyKernelArchive({
    taskDir: dir, cwd: root, expectedRevision: revision,
    actor: "pactile task archive", idempotencyKey: `archive:${path.basename(dir)}:${completedAt}`,
    evidence: "pactile task archive",
    record: { ...record, status: "completed", completedAt },
    extras: { notes_projection: notesProjection },
  });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(dir, destination);
  runTaskHooks(root, "after_archive", path.join(destination, "task.json"));
  const selected = resolveSelectedTask(root);
  if (selected.taskPath === `.pactile/tasks/${path.basename(dir)}`) exitTask(root);
  if (!args.includes("--no-commit") && readPactileConfig(root).session_auto_commit !== "false") {
    const relativeSource = path.relative(root, dir).replaceAll("\\", "/");
    const relativeDestination = path.relative(root, destination).replaceAll("\\", "/");
    let isRepo = false;
    try { isRepo = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true"; }
    catch { /* Archive remains valid in a non-Git project. */ }
    try {
      if (isRepo) {
        let ignored = false;
        try { execFileSync("git", ["check-ignore", "-q", "--", relativeDestination], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }); ignored = true; }
        catch { /* The archive path is not ignored. */ }
        if (!ignored) {
          execFileSync("git", ["add", "-A", "--", relativeSource, relativeDestination], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
          const message = `chore(task): archive ${path.basename(dir)}`;
          execFileSync("git", ["commit", "--only", "-m", message, "--", relativeSource, relativeDestination], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
        }
      }
    } catch (error) {
      console.warn(`Archive state is complete, but scoped git auto-commit failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(path.relative(root, destination).replaceAll("\\", "/"));
  return 0;
}

/** Node entry for the existing task command vocabulary. */
export function runTaskCli(argv: string[], root = process.cwd()): number {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "create": createTask(args, root); return 0;
      case "start-execution": return startExecution(root, args);
      case "record-gate": return recordGate(root, args);
      case "record-ac-evidence": return recordAcEvidence(root, args);
      case "record-independent-check": return recordIndependentCheck(root, args);
      case "add-subtask": linkChild(root, requireArgument(args[0], "parent task"), requireArgument(args[1], "child task")); return 0;
      case "remove-subtask": unlinkChild(root, requireArgument(args[0], "parent task"), requireArgument(args[1], "child task")); return 0;
      case "prepare-child-worktree": return prepareChildWorktree(root, args);
      case "set-child-state": return updateChildState(root, args, false);
      case "integrate-child": return updateChildState(root, args, true);
      case "review-child": return reviewChild(root, args);
      case "parent-status": {
        const dir = taskDir(root, requireArgument(args[0], "parent task"));
        const snapshot = readTaskMap(dir).data;
        if (!snapshot) throw new Error("task-map.md missing");
        console.log(args.includes("--json") ? JSON.stringify(snapshot, null, 2) : snapshot.children.map((child) => `${child.id}: ${child.state}`).join("\n"));
        return 0;
      }
      case "archive": return archiveTask(root, args);
      case "prepare-archive-evidence": {
        const dir = taskDir(root, requireArgument(args[0], "task"));
        const record = taskRecord(dir);
        if (!record) throw new Error(`task.json not found at ${dir}`);
        for (const line of prepareArchiveEvidence(dir, record, args.includes("--dry-run"))) console.log(line);
        return 0;
      }
      case "prepare-learning-scaffold": {
        const dir = taskDir(root, requireArgument(args[0], "task"));
        const record = taskRecord(dir);
        if (!record) throw new Error(`task.json not found at ${dir}`);
        console.log(learningScaffold(root, dir, record, option(args, "--trigger")));
        return 0;
      }
      case "dashboard": dashboard(root); return 0;
      case "list": listTasks(args, root); return 0;
      case "list-archive": listArchive(root, args[0]); return 0;
      case "select": {
        const chosen = selectTask(root, requireArgument(args[0], "task"));
        console.log(`Selected task: ${chosen.taskPath}\nSource: ${chosen.source}\nTask status unchanged.`);
        return 0;
      }
      case "selected": {
        const chosen = resolveSelectedTask(root);
        if (args.includes("--source")) {
          console.log(`Selected task: ${chosen.taskPath ?? "(none)"}\nSource: ${chosen.source}`);
          if (chosen.stale) console.log("State: stale");
        } else if (chosen.taskPath) console.log(chosen.taskPath);
        else console.error("No task selected for this live session.");
        return chosen.taskPath ? 0 : 1;
      }
      case "exit": {
        const previous = exitTask(root);
        console.log(previous.taskPath ? `Cleared selected task (was: ${previous.taskPath})\nTask status unchanged.` : "No selected task set");
        return 0;
      }
      case "add-context": {
        const dir = taskDir(root, requireArgument(args[0], "task"));
        const name = requireArgument(args[1], "manifest");
        const reference = requireArgument(args[2], "path");
        const added = addContextEntry(root, dir, name, reference, args[3]);
        console.log(added ? `Added: ${reference}` : `Entry already exists: ${reference}`);
        return 0;
      }
      case "set-branch":
      case "set-base-branch":
      case "set-scope": {
        const reference = requireArgument(args[0], "task");
        const value = requireArgument(args[1], command === "set-scope" ? "scope" : "branch");
        const key = command === "set-branch" ? "branch" : command === "set-base-branch" ? "base_branch" : "scope";
        patchTask(root, reference, { [key]: value }, command);
        console.log(`${key} set to: ${value}`);
        return 0;
      }
      case "set-deps": {
        const reference = requireArgument(args[0], "task");
        const dependencies = [...new Set(args.slice(1).filter((item) => item.trim()))];
        const dir = taskDir(root, reference);
        const record = taskRecord(dir);
        if (!record) throw new Error(`task.json not found at ${dir}`);
        const projection = readKernel({ taskDir: dir, cwd: root }).kernel.projection?.extras ?? {};
        const rawDeps = (record as unknown as Record<string, unknown>).depends_on;
        const oldDeps = Array.isArray(rawDeps) ? rawDeps.filter((item): item is string => typeof item === "string") : [];
        const graph = readDependencyGraph(projection);
        const edges = graph.edges.filter((edge) => !(edge.from === record.id && edge.type === "requires" && oldDeps.includes(edge.to)));
        const satisfied = Array.isArray(projection.dependency_satisfied) ? projection.dependency_satisfied.filter((item): item is string => typeof item === "string" && !oldDeps.includes(item)) : [];
        patchTask(root, reference, {}, command, { depends_on: dependencies, dependency_graph: { ...graph, edges }, dependency_satisfied: satisfied });
        console.log(dependencies.length ? `depends_on set: ${dependencies.join(", ")}` : "depends_on cleared to []");
        return 0;
      }
      case "set-depends-mode": {
        const reference = requireArgument(args[0], "task");
        const mode = requireArgument(args[1], "mode");
        if (mode !== "block") throw new Error("Node Kernel uses hard requires for all depends_on; only block is supported");
        const record = taskRecord(taskDir(root, reference));
        if (!record) throw new Error(`task.json not found for ${reference}`);
        patchTask(root, reference, { meta: { ...record.meta, depends_mode: mode } }, command);
        console.log(`depends_mode: ${mode}`);
        return 0;
      }
      case "artifact-locale": {
        const operation = requireArgument(args[0], "artifact-locale operation");
        const reference = option(args, "--task");
        if (operation === "get") {
          const task = reference ? taskRecord(taskDir(root, reference)) : null;
          const taskLocale = task?.meta && typeof task.meta === "object" ? (task.meta as Record<string, unknown>).artifact_locale : undefined;
          console.log(taskLocale === "en" || taskLocale === "zh" ? taskLocale : locale(root));
          return 0;
        }
        if (operation !== "set") throw new Error("use artifact-locale get|set");
        const value = requireArgument(args[1], "locale");
        if (value !== "zh" && value !== "en") throw new Error("artifact_locale must be zh or en");
        if (reference) {
          const record = taskRecord(taskDir(root, reference));
          if (!record) throw new Error(`task.json not found for ${reference}`);
          patchTask(root, reference, { meta: { ...record.meta, artifact_locale: value } }, command);
          console.log(`artifact_locale set to ${value} (task ${path.basename(taskDir(root, reference))})`);
          return 0;
        }
        const configFile = path.join(root, ".pactile", "config.yaml");
        const content = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : "# Pactile Configuration\n";
        const replacement = `artifact_locale: ${value}`;
        fs.mkdirSync(path.dirname(configFile), { recursive: true });
        fs.writeFileSync(configFile, /^\s*artifact_locale:\s*[^\r\n]*/m.test(content)
          ? content.replace(/^\s*artifact_locale:\s*[^\r\n]*/m, replacement)
          : `${content.trimEnd()}\n\n${replacement}\n`, "utf8");
        console.log(`artifact_locale set to ${value} (workspace)`);
        return 0;
      }
      case "validate": {
        const dir = taskDir(root, requireArgument(args[0], "task"));
        const results = CONTEXT_FILES.map((name) => validateContextFile(root, dir, name));
        for (const result of results) {
          console.log(`${result.file}: ${result.errors.length ? "FAIL" : "PASS"} (${result.entries} entries)`);
          for (const message of [...result.errors, ...result.warnings]) console.log(`  - ${message}`);
        }
        return results.some((result) => result.errors.length) ? 1 : 0;
      }
      case "list-context": {
        const dir = taskDir(root, requireArgument(args[0], "task"));
        for (const name of CONTEXT_FILES) {
          console.log(`[${name}]`);
          const entries = readContextEntries(dir, name);
          for (const [index, entry] of entries.entries()) console.log(`  ${index + 1}. ${entry.file} — ${entry.reason ?? "-"}`);
          if (!entries.length) console.log("  (no curated entries)");
        }
        return 0;
      }
      default:
        console.error("Usage: pactile task <create|start-execution|archive|prepare-archive-evidence|prepare-learning-scaffold|review-child|dashboard|list|select|selected|exit|add-context|validate|list-context|set-branch|set-base-branch|set-scope|set-deps|set-depends-mode> ...");
        return 1;
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
