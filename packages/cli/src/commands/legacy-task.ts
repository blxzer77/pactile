/** Read-only legacy Task history and explicit P36 held-import reconciliation. */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { scanLegacyTaskMigration } from "../core/task/legacy-task-migration.js";
import { runLegacyTaskReconciliation } from "../pactile/migration/legacy-task-reconciliation.js";

const HELP = `
Pactile legacy Task compatibility

  legacy-task reconcile <task-path> --idempotency-key <key> --activation-at <ISO-time> [definition fields] [--resolve-dependency <raw-ref>=<task-id>] [--approved|--check]
  legacy-task history <archive-relative-path> [--json]

Reconciliation only activates a Task after its missing definition and blocking references are explicitly resolved.
Legacy lifecycle data remains historical source evidence; no V2 Run, Review, or Close is inferred.
`;

const MAX_ARCHIVE_FILES = 512;
const MAX_ARCHIVE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 16 * 1024 * 1024;

interface ParsedArgs {
  positional: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const valueOptions = new Set([
    "--idempotency-key",
    "--activation-at",
    "--title",
    "--deliverable",
    "--delivery-level",
    "--created-at",
    "--accept",
    "--resolve-dependency",
  ]);
  const booleanOptions = new Set(["--approved", "--check", "--json", "--cancel"]);
  const repeatableValueOptions = new Set(["--accept", "--resolve-dependency"]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (booleanOptions.has(arg)) {
      flags.add(arg);
      continue;
    }
    if (valueOptions.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (!repeatableValueOptions.has(arg) && values.has(arg))
        throw new Error(`${arg} may be specified only once`);
      values.set(arg, [...(values.get(arg) ?? []), value]);
      index++;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    positional.push(arg);
  }
  return { positional, values, flags };
}

function option(parsed: ParsedArgs, name: string): string | undefined {
  return parsed.values.get(name)?.at(-1);
}

function utf8OrBase64(bytes: Buffer): { encoding: "utf8" | "base64"; content: string } {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes)
    ? { encoding: "utf8", content: text }
    : { encoding: "base64", content: bytes.toString("base64") };
}

function hash(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function historyFiles(root: string, taskPath: string): {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly encoding: "utf8" | "base64";
  readonly content: string;
}[] {
  if (
    !taskPath.startsWith("archive/") ||
    taskPath.includes("\\") ||
    path.posix.isAbsolute(taskPath) ||
    taskPath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) throw new Error("archived-task-history-path-invalid");
  const archiveRoot = path.join(root, ".pactile", "tasks", "archive");
  const base = path.resolve(root, ".pactile", "tasks", ...taskPath.split("/"));
  const relative = path.relative(archiveRoot, base);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("archived-task-history-path-invalid");
  let cursor = path.resolve(root);
  const parts = [".pactile", "tasks", ...taskPath.split("/")];
  for (const part of parts) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error("archived-task-history-link-invalid");
    if (!stat.isDirectory())
      throw new Error("archived-task-history-directory-invalid");
  }
  const files: { path: string; byteLength: number; sha256: string; encoding: "utf8" | "base64"; content: string }[] = [];
  let totalBytes = 0;
  const visit = (directory: string, relativeDir: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const childRel = `${relativeDir}/${name}`;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("archived-task-history-link-invalid");
      if (stat.isDirectory()) visit(file, childRel);
      else if (stat.isFile() && stat.nlink === 1) {
        if (stat.size > MAX_ARCHIVE_FILE_BYTES || files.length >= MAX_ARCHIVE_FILES)
          throw new Error("archived-task-history-size-limit-exceeded");
        totalBytes += stat.size;
        if (totalBytes > MAX_ARCHIVE_TOTAL_BYTES)
          throw new Error("archived-task-history-size-limit-exceeded");
        const bytes = fs.readFileSync(file);
        const afterRead = fs.lstatSync(file);
        if (
          !afterRead.isFile() ||
          afterRead.isSymbolicLink() ||
          afterRead.nlink !== 1 ||
          afterRead.dev !== stat.dev ||
          afterRead.ino !== stat.ino ||
          bytes.byteLength !== stat.size
        ) throw new Error("archived-task-history-file-changed-during-read");
        files.push({ path: childRel, byteLength: bytes.byteLength, sha256: hash(bytes), ...utf8OrBase64(bytes) });
      } else throw new Error("archived-task-history-file-invalid");
    }
  };
  visit(base, taskPath);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function showHistory(args: string[], root: string): number {
  const parsed = parseArgs(args);
  if (
    parsed.values.size ||
    [...parsed.flags].some((flag) => flag !== "--json")
  ) throw new Error("legacy-task history accepts only --json");
  const taskPath = parsed.positional[0];
  if (!taskPath || parsed.positional.length !== 1)
    throw new Error("legacy-task history requires one archive-relative Task path");
  const files = historyFiles(root, taskPath);
  if (!files.some((file) => file.path.endsWith("/task.json")))
    throw new Error("archived-task-history-task-json-missing");
  const result = {
    taskPath,
    status: "archived-historical-only",
    runnable: false,
    lifecyclePolicy: "source-only-no-v2-run-review-or-close",
    files,
  };
  if (parsed.flags.has("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Archived legacy Task: ${taskPath} (historical read-only)`);
    for (const file of files) {
      console.log(`\n--- ${file.path} (${file.sha256}, ${file.byteLength} bytes) ---`);
      console.log(file.encoding === "utf8" ? file.content : `[base64]\n${file.content}`);
    }
  }
  return 0;
}

async function reconcile(args: string[], root: string): Promise<number> {
  const parsed = parseArgs(args);
  if (
    [...parsed.flags].some((flag) => !["--approved", "--check", "--cancel"].includes(flag)) ||
    parsed.flags.has("--check") && parsed.flags.has("--cancel") ||
    parsed.flags.has("--approved") && (parsed.flags.has("--check") || parsed.flags.has("--cancel"))
  ) throw new Error("legacy-task reconcile options are conflicting or invalid");
  const taskPath = parsed.positional[0];
  if (!taskPath || parsed.positional.length !== 1)
    throw new Error("legacy-task reconcile requires one canonical active Task path");
  const idempotencyKey = option(parsed, "--idempotency-key");
  const activationAt = option(parsed, "--activation-at");
  if (!idempotencyKey || !activationAt)
    throw new Error("--idempotency-key and --activation-at are required for repeatable reconciliation");
  const definition: {
    title?: string;
    deliverable?: string;
    deliveryLevel?: string;
    createdAt?: string;
    acceptanceCriteria?: readonly string[];
  } = {};
  const title = option(parsed, "--title");
  const deliverable = option(parsed, "--deliverable");
  const deliveryLevel = option(parsed, "--delivery-level");
  const createdAt = option(parsed, "--created-at");
  const acceptanceCriteria = parsed.values.get("--accept");
  if ((acceptanceCriteria?.length ?? 0) > 100)
    throw new Error("--accept may be repeated at most 100 times");
  if (title !== undefined) definition.title = title;
  if (deliverable !== undefined) definition.deliverable = deliverable;
  if (deliveryLevel !== undefined) definition.deliveryLevel = deliveryLevel;
  if (createdAt !== undefined) definition.createdAt = createdAt;
  if (acceptanceCriteria !== undefined) definition.acceptanceCriteria = acceptanceCriteria;
  const rawResolutions = parsed.values.get("--resolve-dependency") ?? [];
  if (rawResolutions.length > 100)
    throw new Error("--resolve-dependency may be repeated at most 100 times");
  const dependencyResolutions = rawResolutions.map((value) => {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1)
      throw new Error("--resolve-dependency must be <raw-reference>=<task-id>");
    return { reference: value.slice(0, separator), taskId: value.slice(separator + 1) };
  });
  const plan = scanLegacyTaskMigration({ projectRoot: root });
  const result = await runLegacyTaskReconciliation(
    {
      projectRoot: root,
      plan,
      input: { taskPath, idempotencyKey, activationAt, definition, dependencyResolutions },
    },
    {
      approved: parsed.flags.has("--approved"),
      dryRun: parsed.flags.has("--check"),
      cancelled: parsed.flags.has("--cancel"),
      occurredAt: activationAt,
    },
  );
  console.log(JSON.stringify(result, null, 2));
  return result.status === "blocked" || result.status === "interrupted" ? 1 : 0;
}

export async function runLegacyTaskCli(args: string[], root = process.cwd()): Promise<number> {
  const [operation, ...rest] = args;
  if (!operation || operation === "--help" || operation === "-h") {
    console.log(HELP.trim());
    return 0;
  }
  try {
    if (operation === "history") return showHistory(rest, path.resolve(root));
    if (operation === "reconcile") return await reconcile(rest, path.resolve(root));
    throw new Error(`unknown legacy-task operation: ${operation}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
