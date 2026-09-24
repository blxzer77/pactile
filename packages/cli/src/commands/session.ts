import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { localDate } from "../utils/local-date.js";
import { readPactileConfig } from "../pactile/task/config.js";
import { searchSessionMemory } from "../pactile/task/session-memory.js";
import { resolveSelectedTask, resolveTaskDir } from "../pactile/task/session.js";
import { readDeveloper } from "../utils/developer.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function git(root: string, args: string[]): string {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
}

function selectedRecord(root: string): Record<string, unknown> | null {
  const selected = resolveSelectedTask(root);
  if (!selected.taskPath || selected.stale) return null;
  try { return JSON.parse(fs.readFileSync(path.join(resolveTaskDir(root, selected.taskPath), "task.json"), "utf8")) as Record<string, unknown>; }
  catch { return null; }
}

function replaceMarkedSection(content: string, marker: string, body: string): string {
  const start = `<!-- @@@auto:${marker} -->`;
  const end = `<!-- @@@/auto:${marker} -->`;
  const begin = content.indexOf(start);
  const finish = content.indexOf(end, begin + start.length);
  if (begin < 0 || finish < 0) throw new Error(`workspace index missing ${marker} markers`);
  return `${content.slice(0, begin + start.length)}\n${body.trimEnd()}\n${content.slice(finish)}`;
}

function lineCount(content: string): number {
  return content.length ? content.replace(/\r\n/g, "\n").trimEnd().split("\n").length : 0;
}

function writeAtomic(file: string, content: string): void {
  const temp = `${file}.pactile-${process.pid}.tmp`;
  fs.writeFileSync(temp, content, "utf8");
  try { fs.renameSync(temp, file); }
  catch (error) { fs.rmSync(temp, { force: true }); throw error; }
}

function addSession(args: string[], root: string): void {
  const title = option(args, "--title")?.trim();
  if (!title || title.startsWith("--")) throw new Error("--title is required");
  const developer = readDeveloper(root);
  if (!developer) throw new Error("developer identity missing; run pactile init --user <name>");
  const devDir = path.join(root, ".pactile", "workspace", developer);
  const indexFile = path.join(devDir, "index.md");
  if (!fs.existsSync(indexFile)) throw new Error(`workspace index missing: ${indexFile}`);
  const index = fs.readFileSync(indexFile, "utf8");
  for (const marker of ["current-status", "active-documents", "session-history"]) {
    if (!index.includes(`<!-- @@@auto:${marker} -->`) || !index.includes(`<!-- @@@/auto:${marker} -->`)) {
      throw new Error(`workspace index missing ${marker} markers`);
    }
  }
  const files = fs.readdirSync(devDir).map((name) => ({ name, match: /^journal-(\d+)\.md$/.exec(name) }))
    .filter((item): item is { name: string; match: RegExpExecArray } => item.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  const last = files.at(-1);
  if (!last) throw new Error("workspace journal missing");
  const currentFile = path.join(devDir, last.name);
  const current = fs.readFileSync(currentFile, "utf8");
  const sessionNumber = Number(index.match(/\*\*Total Sessions\*\*:\s*(\d+)/)?.[1] ?? 0) + 1;
  const today = localDate();
  const commit = option(args, "--commit") ?? "-";
  const summary = option(args, "--summary") ?? "(Add summary)";
  const contentFile = option(args, "--content-file");
  let details = "(Add details)";
  if (contentFile) {
    const resolved = path.resolve(root, contentFile);
    if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) throw new Error(`content file not found: ${resolved}`);
    details = fs.readFileSync(resolved, "utf8");
  } else if (args.includes("--stdin")) details = fs.readFileSync(0, "utf8");
  const config = readPactileConfig(root);
  const packageOptions = config.packages && typeof config.packages === "object" ? config.packages as Record<string, unknown> : {};
  const requestedPackage = option(args, "--package");
  const selected = selectedRecord(root);
  let pkg = requestedPackage ?? (typeof selected?.package === "string" ? selected.package : undefined)
    ?? (typeof config.default_package === "string" ? config.default_package : undefined);
  if (requestedPackage && !Object.keys(packageOptions).length) { console.warn("--package ignored in single-repo project"); pkg = undefined; }
  if (pkg && Object.keys(packageOptions).length && !(pkg in packageOptions)) throw new Error(`unknown package: ${pkg}`);
  const branch = option(args, "--branch") ?? (typeof selected?.branch === "string" ? selected.branch : undefined) ?? git(root, ["branch", "--show-current"]);
  const commitTable = commit !== "-" && commit.trim()
    ? `| Hash | Message |\n|------|---------|\n${commit.split(",").map((hash) => `| \`${hash.trim()}\` | (see git log) |`).join("\n")}`
    : "(No commits - planning session)";
  const entry = `\n\n## Session ${sessionNumber}: ${title}\n\n**Date**: ${today}\n**Task**: ${title}${pkg ? `\n**Package**: ${pkg}` : ""}${branch ? `\n**Branch**: \`${branch}\`` : ""}\n\n### Summary\n\n${summary}\n\n### Main Changes\n\n${details}\n\n### Git Commits\n\n${commitTable}\n\n### Testing\n\n- [OK] (Add test results)\n\n### Status\n\n[OK] **Completed**\n\n### Next Steps\n\n- None - task complete\n`;
  const maxLines = Number(config.max_journal_lines) || 2000;
  const rotate = lineCount(current) + lineCount(entry) > maxLines;
  const targetName = rotate ? `journal-${Number(last.match[1]) + 1}.md` : last.name;
  const targetFile = path.join(devDir, targetName);
  const nextJournal = rotate
    ? `# Journal - ${developer} (Part ${Number(last.match[1]) + 1})\n\n> Continuation from \`${last.name}\` (archived at ~${maxLines} lines)\n> Started: ${today}\n\n---\n\n${entry}`
    : current + entry;
  const journals = files.map((item) => item.name).concat(rotate ? [targetName] : []);
  const documents = ["| File | Lines | Status |", "|------|-------|--------|", ...journals.map((name) => {
    const contents = name === targetName ? nextJournal : fs.readFileSync(path.join(devDir, name), "utf8");
    return `| \`${name}\` | ~${lineCount(contents)} | ${name === targetName ? "Active" : "Archived"} |`;
  })].join("\n");
  const commitDisplay = commit === "-" ? "-" : commit.split(",").map((hash) => `\`${hash.trim()}\``).join(", ");
  const oldHistory = index.match(/<!-- @@@auto:session-history -->([\s\S]*?)<!-- @@@\/auto:session-history -->/)?.[1] ?? "";
  const rows = oldHistory.split(/\r?\n/).filter((line) => /^\|\s*\d+\s*\|/.test(line));
  const history = ["| # | Date | Title | Commits | Branch |", "|---|------|-------|---------|--------|", `| ${sessionNumber} | ${today} | ${title} | ${commitDisplay} | \`${branch || "-"}\` |`, ...rows].join("\n");
  const updated = replaceMarkedSection(replaceMarkedSection(replaceMarkedSection(index, "current-status", `- **Active File**: \`${targetName}\`\n- **Total Sessions**: ${sessionNumber}\n- **Last Active**: ${today}`), "active-documents", documents), "session-history", history);
  writeAtomic(targetFile, nextJournal);
  writeAtomic(indexFile, updated);
  console.log(`Session ${sessionNumber} added: ${targetName}`);
  if (args.includes("--no-commit") || config.session_auto_commit === "false") return;
  if (git(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") return;
  const relativePaths = [targetFile, indexFile].map((file) => path.relative(root, file).replaceAll("\\", "/"));
  try {
    execFileSync("git", ["add", "--", ...relativePaths], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["commit", "--only", "-m", "chore(session): record work", "--", ...relativePaths], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    console.warn(`Session saved, but scoped git auto-commit failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function runSessionCli(args: string[], root = process.cwd()): number {
  try {
    if (args[0] === "add") addSession(args.slice(1), root);
    else if (args[0] === "search") {
      const payload = searchSessionMemory(root, args.slice(1));
      if (args.includes("--json")) console.log(JSON.stringify(payload, null, 2));
      else {
        const results = payload.results as Record<string, unknown>[];
        if (!results.length) console.log("No session memory results.");
        for (const [index, result] of results.entries()) console.log(`${index + 1}. ${result.title} (${result.date ? String(result.date) : "unknown date"})\n   Path: ${result.path}:${result.line}\n   Score: ${result.score} - ${result.reason}\n   Summary: ${result.summary}`);
      }
    } else throw new Error("Usage: pactile session <add|search> ...");
    return 0;
  } catch (error) {
    console.error(`Session error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
