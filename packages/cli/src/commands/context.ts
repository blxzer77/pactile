import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  buildLiteContextPack,
  readTaskKernel,
  type LitePackArtifact,
  type KernelPhase,
} from "../core/task/index.js";
import {
  readPactileConfig,
  type PactileConfig,
} from "../pactile/task/config.js";
import {
  resolveSelectedTask,
  resolveTaskDir,
} from "../pactile/task/session.js";
import { compileSessionPackWithJevV1 } from "../pactile/task/session-jev.js";
import { compileSessionPack } from "../pactile/task/session-pack.js";
import { compileSessionRetrievalPlanWithJevV1 } from "../pactile/task/session-retrieval-jev.js";
import { readDeveloper } from "../utils/developer.js";
import { readWorkflowPhase } from "../pactile/task/workflow-phase.js";
import { buildRetrievalPack } from "../pactile/retrieval/pack.js";
import { readLegacyTaskImportRecord } from "../core/task/legacy-task-migration-reader.js";

type JsonRecord = Record<string, unknown>;

function phaseFromLegacyStatus(status: unknown): KernelPhase {
  if (status === "in_progress") return "execute";
  if (status === "review") return "verify";
  if (status === "completed") return "close";
  if (status === "planning") return "define";
  return "open";
}

function mapping(value: unknown): PactileConfig {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as PactileConfig)
    : {};
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return "";
  }
}

function gitContext(root: string): JsonRecord {
  const isRepo = git(root, ["rev-parse", "--is-inside-work-tree"]) === "true";
  if (!isRepo)
    return {
      isRepo: false,
      branch: "",
      isClean: false,
      uncommittedChanges: 0,
      recentCommits: [],
    };
  const changes = git(root, ["status", "--porcelain"])
    .split(/\r?\n/)
    .filter(Boolean);
  const recentCommits = git(root, ["log", "--oneline", "-5"])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash, ...message] = line.split(" ");
      return { hash, message: message.join(" ") };
    });
  return {
    isRepo,
    branch: git(root, ["branch", "--show-current"]) || "unknown",
    isClean: changes.length === 0,
    uncommittedChanges: changes.length,
    recentCommits,
    statusShort: changes.slice(0, 10),
  };
}

function activeTasks(root: string): (JsonRecord & { dir: string })[] {
  const tasksRoot = path.join(root, ".pactile", "tasks");
  if (!fs.existsSync(tasksRoot)) return [];
  return fs
    .readdirSync(tasksRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !["archive", "locale", "templates"].includes(entry.name),
    )
    .flatMap((entry): (JsonRecord & { dir: string })[] => {
      const taskDir = path.join(tasksRoot, entry.name);
      const importRecord = readLegacyTaskImportRecord(root, taskDir);
      if (importRecord && importRecord.status !== "imported") {
        let legacy: JsonRecord = {};
        try {
          const value: unknown = JSON.parse(
            fs.readFileSync(path.join(taskDir, "task.json"), "utf8"),
          );
          if (value && typeof value === "object" && !Array.isArray(value))
            legacy = value as JsonRecord;
        } catch {
          // The source id and migration record remain sufficient to show the
          // task's non-runnable reconciliation state.
        }
        return [{
          id: importRecord.legacyTaskId,
          name: legacy.title ?? legacy.name ?? importRecord.legacyTaskId,
          title: legacy.title ?? legacy.name ?? importRecord.legacyTaskId,
          status: importRecord.status,
          phase: "define",
          migrationStatus: importRecord.status,
          runnable: false,
          missingDefinitionFields: importRecord.missingDefinitionFields,
          coordinationReasons: importRecord.coordinationReasons,
          dir: entry.name,
          kernelVersion: null,
        }];
      }
      if (importRecord?.status === "imported") {
        const read = readTaskKernel({ root, taskDir, cwd: root });
        if (read.kind !== "task-kernel-v2")
          throw new Error("legacy-task-imported-kernel-unavailable");
        const kernel = read.kernel;
        return [{
          id: kernel.identity.taskId,
          name: kernel.definition.title,
          title: kernel.definition.title,
          status: kernel.phase === "close" ? "closed" : kernel.phase,
          phase: kernel.phase,
          assignee: kernel.definition.createdBy,
          createdBy: kernel.definition.createdBy,
          deliveryLevel: kernel.definition.deliveryLevel,
          dependencies: kernel.definition.dependencies,
          acceptanceCriteria: kernel.definition.acceptanceCriteria,
          dir: entry.name,
          kernelVersion: 2,
        }];
      }
      try {
        const kernelFile = path.join(taskDir, "kernel.json");
        if (fs.existsSync(kernelFile)) {
          const read = readTaskKernel({ root, taskDir, cwd: root });
          if (read.kind === "task-kernel-v2") {
            const kernel = read.kernel;
            const status = kernel.phase === "close" ? "closed" : kernel.phase;
            return [
              {
                id: kernel.identity.taskId,
                name: kernel.definition.title,
                title: kernel.definition.title,
                status,
                phase: kernel.phase,
                assignee: kernel.definition.createdBy,
                createdBy: kernel.definition.createdBy,
                deliveryLevel: kernel.definition.deliveryLevel,
                dependencies: kernel.definition.dependencies,
                acceptanceCriteria: kernel.definition.acceptanceCriteria,
                dir: entry.name,
                kernelVersion: 2,
              },
            ];
          }
        }
        const record: unknown = JSON.parse(
          fs.readFileSync(path.join(taskDir, "task.json"), "utf8"),
        );
        if (record && typeof record === "object" && !Array.isArray(record)) {
          const legacy = record as JsonRecord;
          return [
            {
              ...legacy,
              phase: phaseFromLegacyStatus(legacy.status),
              dir: entry.name,
              kernelVersion: 1,
            },
          ];
        }
        return [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

function selectedTask(root: string): JsonRecord | null {
  const selected = resolveSelectedTask(root);
  if (!selected.taskPath || selected.stale) return null;
  const dir = resolveTaskDir(root, selected.taskPath);
  const importRecord = readLegacyTaskImportRecord(root, dir);
  if (importRecord && importRecord.status !== "imported") {
    return {
      path: selected.taskPath,
      taskId: importRecord.legacyTaskId,
      name: importRecord.legacyTaskId,
      status: importRecord.status,
      phase: "define",
      migrationStatus: importRecord.status,
      runnable: false,
      missingDefinitionFields: importRecord.missingDefinitionFields,
      coordinationReasons: importRecord.coordinationReasons,
      kernelVersion: null,
      source: selected.source,
      contextKey: selected.contextKey,
    };
  }
  if (importRecord?.status === "imported") {
    const read = readTaskKernel({ root, taskDir: dir, cwd: root });
    if (read.kind !== "task-kernel-v2")
      throw new Error("legacy-task-imported-kernel-unavailable");
    return {
      path: selected.taskPath,
      taskId: read.kernel.identity.taskId,
      name: read.kernel.definition.title,
      status: read.kernel.phase === "close" ? "closed" : read.kernel.phase,
      phase: read.kernel.phase,
      condition: read.kernel.condition,
      revision: read.kernel.revision,
      kernelVersion: 2,
      source: selected.source,
      contextKey: selected.contextKey,
    };
  }
  try {
    if (
      fs.existsSync(path.join(dir, "kernel.json")) ||
      readLegacyTaskImportRecord(root, dir)
    ) {
      const read = readTaskKernel({ root, taskDir: dir, cwd: root });
      if (read.kind === "task-kernel-v2") {
        return {
          path: selected.taskPath,
          taskId: read.kernel.identity.taskId,
          name: read.kernel.definition.title,
          status: read.kernel.phase === "close" ? "closed" : read.kernel.phase,
          phase: read.kernel.phase,
          condition: read.kernel.condition,
          revision: read.kernel.revision,
          kernelVersion: 2,
          source: selected.source,
          contextKey: selected.contextKey,
        };
      }
      const record = JSON.parse(
        fs.readFileSync(path.join(dir, "task.json"), "utf8"),
      ) as JsonRecord;
      return {
        path: selected.taskPath,
        name: record.name,
        status: record.status,
        phase: read.kernel.kernel.phase,
        revision: read.kernel.kernel.revision,
        kernelVersion: 1,
        source: selected.source,
        contextKey: selected.contextKey,
      };
    }
    const data = JSON.parse(
      fs.readFileSync(path.join(dir, "task.json"), "utf8"),
    ) as JsonRecord;
    return {
      path: selected.taskPath,
      taskId: data.id,
      name: data.name,
      status: data.status,
      phase: phaseFromLegacyStatus(data.status),
      kernelVersion: 1,
      source: selected.source,
      contextKey: selected.contextKey,
    };
  } catch {
    return null;
  }
}

function journal(root: string, developer: string | null): JsonRecord {
  if (!developer) return { file: "", lines: 0, nearLimit: false };
  const workspace = path.join(root, ".pactile", "workspace", developer);
  if (!fs.existsSync(workspace))
    return { file: "", lines: 0, nearLimit: false };
  const names = fs
    .readdirSync(workspace)
    .filter((name) => /^journal-\d+\.md$/.test(name))
    .sort(
      (a, b) =>
        Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0),
    );
  const name = names.at(-1);
  if (!name) return { file: "", lines: 0, nearLimit: false };
  const lines = fs
    .readFileSync(path.join(workspace, name), "utf8")
    .split(/\r?\n/).length;
  return {
    file: `.pactile/workspace/${developer}/${name}`,
    lines,
    nearLimit: lines > 1800,
  };
}

function specLayers(root: string, pkg?: string): string[] {
  const base = path.join(root, ".pactile", "spec", ...(pkg ? [pkg] : []));
  return fs.existsSync(base)
    ? fs
        .readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== "guides")
        .map((entry) => entry.name)
        .sort()
    : [];
}

function packagesContext(root: string): JsonRecord {
  const config = readPactileConfig(root);
  const configured = mapping(config.packages);
  const names = Object.keys(configured);
  if (!names.length)
    return { mode: "single-repo", specLayers: specLayers(root) };
  const defaultPackage =
    typeof config.default_package === "string" ? config.default_package : null;
  const packages = names.map((name) => {
    const settings = mapping(configured[name]);
    const type = typeof settings.type === "string" ? settings.type : "local";
    return {
      name,
      path: typeof settings.path === "string" ? settings.path : name,
      type,
      default: name === defaultPackage,
      specLayers: specLayers(root, name),
      isSubmodule: type === "submodule",
      isGitRepo: settings.git === "true",
    };
  });
  return {
    mode: "monorepo",
    packages,
    defaultPackage,
    specScope: config.spec_scope ?? null,
  };
}

function renderPackages(root: string): string {
  const data = packagesContext(root);
  if (data.mode === "single-repo")
    return `Single-repo project (no packages configured)\n\nSpec layers: ${(data.specLayers as string[]).join(", ")}`;
  const lines = ["## PACKAGES", ""];
  for (const pkg of data.packages as {
    name: string;
    path: string;
    type: string;
    default: boolean;
    specLayers: string[];
    isGitRepo: boolean;
  }[]) {
    lines.push(
      `### ${pkg.name}${pkg.default ? " (default)" : ""}${pkg.type === "local" ? "" : ` [${pkg.type}]`}${pkg.isGitRepo ? " [git repo]" : ""}`,
    );
    lines.push(`Path: ${pkg.path}`);
    for (const layer of pkg.specLayers)
      lines.push(`  - .pactile/spec/${pkg.name}/${layer}/index.md`);
    if (!pkg.specLayers.length) lines.push("Spec: not configured");
    lines.push("");
  }
  if (fs.existsSync(path.join(root, ".pactile", "spec", "guides")))
    lines.push(
      "### Shared Guides (always included)",
      "Path: .pactile/spec/guides/index.md",
    );
  return lines.join("\n");
}

function context(root: string, mode: "default" | "record"): JsonRecord {
  const developer = readDeveloper(root);
  const tasks = activeTasks(root);
  const selected = selectedTask(root);
  const base = { developer: developer ?? "", git: gitContext(root) };
  if (mode === "record")
    return {
      ...base,
      myTasks: tasks
        .filter((task) => task.assignee === developer)
        .map((task) => ({
          dir: task.dir,
          title: task.title,
          status: task.status,
          priority: task.priority,
          children: task.children ?? [],
          parent: task.parent ?? null,
          meta: task.meta ?? {
            deliveryLevel: task.deliveryLevel,
            dependencies: task.dependencies,
          },
        })),
      selectedTask: selected,
    };
  return {
    ...base,
    artifactLocale: readPactileConfig(root).artifact_locale ?? "zh",
    tasks: {
      active: tasks.map((task) => ({
        dir: task.dir,
        name: task.name,
        status: task.status,
        children: task.children ?? [],
        parent: task.parent ?? null,
      })),
      directory: ".pactile/tasks",
    },
    journal: journal(root, developer),
    selectedTask: selected,
  };
}

function renderContext(
  data: JsonRecord,
  root: string,
  mode: "default" | "record",
): string {
  const gitData = data.git as JsonRecord;
  const selected = data.selectedTask as JsonRecord | null;
  const lines = [
    "========================================",
    mode === "record" ? "SESSION CONTEXT (RECORD MODE)" : "SESSION CONTEXT",
    "========================================",
    "",
    "## DEVELOPER",
    `Name: ${data.developer ? String(data.developer) : "(not initialized)"}`,
    "",
    "## GIT STATUS",
  ];
  lines.push(
    gitData.isRepo
      ? `Branch: ${gitData.branch}\nWorking directory: ${gitData.isClean ? "Clean" : `${gitData.uncommittedChanges} uncommitted change(s)`}`
      : "Root is not a Git repository.",
  );
  lines.push("", "## RECENT COMMITS");
  for (const commit of gitData.recentCommits as {
    hash: string;
    message: string;
  }[])
    lines.push(`${commit.hash} ${commit.message}`);
  lines.push(
    "",
    "## SELECTED TASK",
    selected
      ? `Path: ${selected.path}\nStatus: ${selected.status}\nSource: ${selected.source}`
      : "(none)",
    "",
    "## TASK DASHBOARD",
  );
  const tasks = activeTasks(root);
  for (const task of tasks)
    lines.push(`- ${task.dir}/ (${task.status}) @${task.assignee ?? "-"}`);
  if (!tasks.length) lines.push("(no active tasks)");
  lines.push("", "## MY TASKS (Assigned to me)");
  const mine = tasks.filter((task) => task.assignee === data.developer);
  for (const task of mine)
    lines.push(`- [${task.priority}] ${task.title} (${task.status})`);
  if (!mine.length) lines.push("(no tasks assigned to you)");
  if (mode === "default") lines.push("", renderPackages(root));
  return lines.join("\n");
}

function liteContext(root: string): ReturnType<typeof buildLiteContextPack> {
  const selected = resolveSelectedTask(root);
  if (!selected.taskPath || selected.stale)
    return buildLiteContextPack({ phase: "open" });
  const dir = resolveTaskDir(root, selected.taskPath);
  const importRecord = readLegacyTaskImportRecord(root, dir);
  if (importRecord && importRecord.status !== "imported") {
    const pack = buildLiteContextPack({ phase: "define" }) as ReturnType<
      typeof buildLiteContextPack
    > & {
      migrationStatus: string;
      runnable: false;
      missingDefinitionFields?: readonly string[];
      coordinationReasons?: readonly string[];
    };
    pack.migrationStatus = importRecord.status;
    pack.runnable = false;
    if (importRecord.status === "needs-definition")
      pack.missingDefinitionFields = importRecord.missingDefinitionFields;
    if (importRecord.status === "needs-coordination")
      pack.coordinationReasons = importRecord.coordinationReasons;
    pack.warnings.push(
      `Legacy migration status=${importRecord.status}; V2 Run is unavailable until reconciliation.`,
    );
    return pack;
  }
  const read =
    fs.existsSync(path.join(dir, "kernel.json")) ||
    importRecord
      ? readTaskKernel({ root, taskDir: dir, cwd: root })
      : null;
  const legacy =
    read?.kind === "legacy-task-kernel-v1" ? read.kernel.kernel : null;
  const legacyTask = !read
    ? (JSON.parse(
        fs.readFileSync(path.join(dir, "task.json"), "utf8"),
      ) as JsonRecord)
    : null;
  const phase =
    read?.kind === "task-kernel-v2"
      ? read.kernel.phase
      : (legacy?.phase ?? phaseFromLegacyStatus(legacyTask?.status));
  const artifacts: LitePackArtifact[] = [];
  if (read?.kind === "task-kernel-v2") {
    const definition = read.kernel.definition;
    const text = [
      definition.title,
      `Deliverable: ${definition.deliverable}`,
      `Delivery level: ${definition.deliveryLevel}`,
      `Dependencies: ${definition.dependencies.join(", ") || "none"}`,
      "Acceptance criteria:",
      ...definition.acceptanceCriteria.map(
        (criterion) => `- ${criterion.id}: ${criterion.description}`,
      ),
    ].join("\n");
    artifacts.push({
      role: "definition",
      path: ".pactile/tasks/kernel.json",
      content: text.slice(0, 12_000),
    });
  }
  for (const [role, name] of [
    ["definition", "prd.md"],
    ["evidence", "verify.md"],
  ] as const) {
    const file = path.join(dir, name);
    if (fs.existsSync(file))
      artifacts.push({
        role,
        path: name,
        content: fs.readFileSync(file, "utf8").slice(0, 12_000),
      });
  }
  return buildLiteContextPack({ phase, artifacts });
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--"))
    throw new Error(`${name} requires a value`);
  return args[index + 1];
}

function positiveLimit(args: string[], name: string): number | undefined {
  const value = option(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function retrievalPackContext(root: string, args: string[]): JsonRecord {
  const input = option(args, "--input");
  const raw =
    input === "-"
      ? fs.readFileSync(0, "utf8")
      : input
        ? fs.readFileSync(path.resolve(root, input), "utf8")
        : "{}";
  const parsed: unknown = JSON.parse(raw.trim() || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("retrieval-pack input must be a JSON object");
  const payload = parsed as JsonRecord;
  const selected = resolveSelectedTask(root);
  if (!payload.retrievalGuide && selected.taskPath && !selected.stale) {
    const dir = resolveTaskDir(root, selected.taskPath);
    const present = (name: string): boolean =>
      fs.existsSync(path.join(dir, name));
    payload.retrievalGuide = {
      selectedTaskArtifacts: {
        taskPath: selected.taskPath,
        prd: present("prd.md"),
        design: present("design.md"),
        implement: present("implement.md"),
        verify: present("verify.md"),
        research: present("research"),
      },
    };
  }
  const result = buildRetrievalPack(payload, root, {
    maxItems: positiveLimit(args, "--max-items"),
    maxEstimatedTokens: positiveLimit(args, "--max-estimated-tokens"),
    includeDiagnostics: args.includes("--include-diagnostics"),
  });
  const output = option(args, "--output");
  if (output) {
    const file = path.resolve(root, output);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(result, null, 2)}\n`, {
        flag: "wx",
      });
      fs.renameSync(temp, file);
    } finally {
      if (fs.existsSync(temp)) fs.rmSync(temp);
    }
  }
  return result;
}

/** Read active task context through the Node CLI. */
export function runContextCli(args: string[], root = process.cwd()): number {
  try {
    const modeIndex =
      args.indexOf("--mode") >= 0 ? args.indexOf("--mode") : args.indexOf("-m");
    const mode = modeIndex >= 0 ? args[modeIndex + 1] : "default";
    const json = args.includes("--json") || args.includes("-j");
    if (mode === "packages") {
      console.log(
        json
          ? JSON.stringify(packagesContext(root), null, 2)
          : renderPackages(root),
      );
      return 0;
    }
    if (mode === "lite") {
      console.log(
        JSON.stringify(liteContext(root), null, json ? 2 : undefined),
      );
      return 0;
    }
    if (mode === "session") {
      console.log(
        JSON.stringify(
          compileSessionPack(
            root,
            process.env.PACTILE_SESSION_FACT_GAP === "1",
          ),
          null,
          json ? 2 : undefined,
        ),
      );
      return 0;
    }
    if (mode === "phase") {
      const stepIndex = args.indexOf("--step");
      const platformIndex = args.indexOf("--platform");
      console.log(
        readWorkflowPhase(
          root,
          stepIndex >= 0 ? args[stepIndex + 1] : undefined,
          platformIndex >= 0 ? args[platformIndex + 1] : undefined,
        ).trimEnd(),
      );
      return 0;
    }
    if (mode === "retrieval-pack") {
      console.log(
        JSON.stringify(
          retrievalPackContext(root, args),
          null,
          json ? 2 : undefined,
        ),
      );
      return 0;
    }
    if (mode !== "default" && mode !== "record")
      throw new Error(
        `Context mode ${mode} is not yet available in the Node runtime`,
      );
    const data = context(root, mode);
    console.log(
      json ? JSON.stringify(data, null, 2) : renderContext(data, root, mode),
    );
    return 0;
  } catch (error) {
    console.error(
      `Context error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

/** Async CLI entry point for the optionally provider-advised session mode. */
export async function runContextCliAsync(
  args: string[],
  root = process.cwd(),
): Promise<number> {
  const modeIndex = args.indexOf("--mode") >= 0 ? args.indexOf("--mode") : args.indexOf("-m");
  const mode = modeIndex >= 0 ? args[modeIndex + 1] : "default";
  if (mode !== "session") return runContextCli(args, root);
  try {
    const json = args.includes("--json") || args.includes("-j");
    const factGap = process.env.PACTILE_SESSION_FACT_GAP === "1";
    const sessionPack = await compileSessionPackWithJevV1(root, factGap);
    const pack = await compileSessionRetrievalPlanWithJevV1(root, sessionPack);
    console.log(JSON.stringify(pack, null, json ? 2 : undefined));
    return 0;
  } catch (error) {
    console.error(`Context error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
