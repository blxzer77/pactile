import fs from "node:fs";
import path from "node:path";

export const CONTEXT_FILES = ["implement.jsonl", "check.jsonl"] as const;
export const JSONL_MAX_ENTRIES = 8;
export const JSONL_MAX_TOTAL_CHARS = 48_000;

export interface ContextEntry {
  file: string;
  type?: "file" | "directory";
  reason?: string;
}

export interface ContextValidation {
  file: string;
  entries: number;
  expandedChars: number;
  errors: string[];
  warnings: string[];
}

function manifestName(input: string): string {
  const name = input.endsWith(".jsonl") ? input : `${input}.jsonl`;
  if (!/^[A-Za-z0-9_-]+\.jsonl$/.test(name)) {
    throw new Error(`unsupported context manifest: ${name}`);
  }
  return name;
}

function resolveProjectPath(root: string, reference: string): string {
  const result = path.resolve(root, reference);
  const relative = path.relative(root, result);
  if (!reference.trim() || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`context path must stay inside the project: ${reference}`);
  }
  return result;
}

export function readContextEntries(taskDir: string, name: string): ContextEntry[] {
  const file = path.join(taskDir, manifestName(name));
  if (!fs.existsSync(file)) return [];
  const entries: ContextEntry[] = [];
  for (const [index, line] of fs.readFileSync(file, "utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { throw new Error(`${path.basename(file)}:${index + 1}: Invalid JSON`); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${path.basename(file)}:${index + 1}: JSON object required`);
    }
    const value = parsed as Record<string, unknown>;
    if (typeof value.file !== "string" || !value.file.trim()) continue; // Seed/comment row.
    entries.push({
      file: value.file,
      type: value.type === "directory" ? "directory" : "file",
      reason: typeof value.reason === "string" ? value.reason : undefined,
    });
  }
  return entries;
}

export function addContextEntry(root: string, taskDir: string, name: string, reference: string, reason = "Added manually"): boolean {
  if (!fs.statSync(taskDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`task directory not found: ${taskDir}`);
  }
  const fullPath = resolveProjectPath(root, reference);
  const stat = fs.statSync(fullPath, { throwIfNoEntry: false });
  if (!stat?.isFile() && !stat?.isDirectory()) throw new Error(`context path not found: ${reference}`);
  const normalized = reference.replaceAll("\\", "/").replace(/^\.\//, "") + (stat.isDirectory() && !reference.endsWith("/") ? "/" : "");
  const file = path.join(taskDir, manifestName(name));
  if (readContextEntries(taskDir, name).some((entry) => entry.file === normalized)) return false;
  const entry: ContextEntry = { file: normalized, reason };
  if (stat.isDirectory()) entry.type = "directory";
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  return true;
}

export function validateContextFile(root: string, taskDir: string, name: string): ContextValidation {
  const file = manifestName(name);
  const result: ContextValidation = { file, entries: 0, expandedChars: 0, errors: [], warnings: [] };
  const full = path.join(taskDir, file);
  if (!fs.existsSync(full)) return result;
  const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { result.errors.push(`${file}:${index + 1}: Invalid JSON`); continue; }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      result.errors.push(`${file}:${index + 1}: JSON object required`); continue;
    }
    const entry = parsed as Record<string, unknown>;
    if (typeof entry.file !== "string" || !entry.file.trim()) continue;
    result.entries++;
    let target: string;
    try { target = resolveProjectPath(root, entry.file); }
    catch (err) { result.errors.push(`${file}:${index + 1}: ${String(err)}`); continue; }
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    const directory = entry.type === "directory";
    if (directory ? !stat?.isDirectory() : !stat?.isFile()) {
      result.errors.push(`${file}:${index + 1}: ${directory ? "Directory" : "File"} not found: ${entry.file}`);
      continue;
    }
    if (stat?.isFile()) result.expandedChars += stat.size;
  }
  if (result.entries > JSONL_MAX_ENTRIES) result.warnings.push(`${file}: ${result.entries} entries exceeds ${JSONL_MAX_ENTRIES}`);
  if (result.expandedChars > JSONL_MAX_TOTAL_CHARS) result.warnings.push(`${file}: ${result.expandedChars} expanded chars exceeds ${JSONL_MAX_TOTAL_CHARS}`);
  return result;
}
