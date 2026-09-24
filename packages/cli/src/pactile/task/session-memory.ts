import fs from "node:fs";
import path from "node:path";
import { readDeveloper } from "../../utils/developer.js";

interface MemoryEntry {
  developer: string; session: number; title: string; date: string; task: string;
  package: string; branch: string; commits: string[]; sections: Record<string, string>;
  path: string; line: number;
}

const WEIGHTS: Record<string, number> = {
  title: 8, task: 8, summary: 6, "next steps": 6, "main changes": 4,
  commits: 3, package: 3, branch: 3, path: 3,
};

function parseJournal(root: string, file: string, developer: string): MemoryEntry[] {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const starts = lines.flatMap((line, index) => /^## Session \d+:/.test(line) ? [index] : []);
  return starts.map((start, index) => {
    const part = lines.slice(start + 1, starts[index + 1] ?? lines.length);
    const match = /^## Session (\d+):\s*(.+?)\s*$/.exec(lines[start]);
    const title = match?.[2]?.trim() ?? "";
    const fields: Record<string, string> = {};
    const sections: Record<string, string> = {};
    let section: string | null = null;
    for (const line of part) {
      const field = /^\*\*(Date|Task|Package|Branch)\*\*:\s*(.+?)\s*$/.exec(line);
      if (field) fields[field[1].toLowerCase()] = field[2].replace(/^`|`$/g, "").trim();
      const heading = /^###\s+(.+?)\s*$/.exec(line);
      if (heading) { section = heading[1].toLowerCase(); sections[section] = ""; continue; }
      if (section) sections[section] += `${line}\n`;
    }
    for (const [key, content] of Object.entries(sections)) sections[key] = content.trim();
    const commits = [...new Set((sections["git commits"] ?? "").match(/\b[a-f0-9]{7,40}\b/gi) ?? [])].sort();
    return {
      developer, session: Number(match?.[1] ?? 0), title,
      date: fields.date ?? "", task: fields.task ?? title,
      package: fields.package ?? "", branch: fields.branch ?? "", commits,
      sections, path: path.relative(root, file).replaceAll("\\", "/"), line: start + 1,
    };
  });
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  return index < 0 ? "" : args[index + 1] ?? "";
}

export function searchSessionMemory(root: string, args: string[]): Record<string, unknown> {
  const query = option(args, "--query") || option(args, "-q");
  const developers: string[] = [];
  for (let index = 0; index < args.length - 1; index += 1) if (args[index] === "--developer") developers.push(args[index + 1]);
  const filters = { task: option(args, "--task"), package: option(args, "--package"), branch: option(args, "--branch"), since: option(args, "--since"), until: option(args, "--until") };
  const limit = args.includes("--limit") ? Number(option(args, "--limit")) : 10;
  if (!Number.isInteger(limit) || limit < 0) throw new Error("--limit must be >= 0");
  const workspace = path.join(root, ".pactile", "workspace");
  const current = readDeveloper(root);
  const selected = developers.length ? developers : current ? [current] : fs.existsSync(workspace)
    ? fs.readdirSync(workspace, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name) : [];
  const tokens = query.toLowerCase().match(/\S+/g) ?? [];
  const scored: Record<string, unknown>[] = [];
  for (const developer of selected) {
    if (!developer || developer === "." || developer === ".." || /[\\/]/.test(developer)) continue;
    const folder = path.join(workspace, developer);
    if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) continue;
    const journals = fs.readdirSync(folder).filter((name) => /^journal-\d+\.md$/.test(name))
      .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0));
    for (const name of journals) for (const entry of parseJournal(root, path.join(folder, name), developer)) {
      if (filters.task && ![entry.task, entry.title].some((value) => value.toLowerCase().includes(filters.task.toLowerCase()))) continue;
      if (filters.package && !entry.package.toLowerCase().includes(filters.package.toLowerCase())) continue;
      if (filters.branch && !entry.branch.toLowerCase().includes(filters.branch.toLowerCase())) continue;
      if (filters.since && entry.date && entry.date < filters.since) continue;
      if (filters.until && entry.date && entry.date > filters.until) continue;
      let score = Math.min(entry.session, 5);
      const matchedSections = new Set<string>();
      const matchedFields = new Set<string>();
      const reasons: string[] = [];
      const fields: [string, string][] = [
        ["title", entry.title], ["task", entry.task], ["package", entry.package],
        ["branch", entry.branch], ["commits", entry.commits.join(" ")], ["path", entry.path],
        ...Object.entries(entry.sections),
      ];
      for (const token of tokens) {
        let matched = false;
        for (const [field, value] of fields) if (value.toLowerCase().includes(token)) {
          matched = true;
          score += WEIGHTS[field] ?? 2;
          if (field in entry.sections) matchedSections.add(field.split(" ").map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(" "));
          else matchedFields.add(field);
        }
        if (matched) reasons.push(`matched '${token}'`);
      }
      if (tokens.length && !reasons.length) continue;
      scored.push({
        version: 1, source: "session-memory", developer, session: entry.session,
        title: entry.title, date: entry.date, task: entry.task, package: entry.package,
        branch: entry.branch, commits: entry.commits,
        summary: (entry.sections.summary ?? "").replace(/\s+/g, " ").trim(),
        matchedSections: [...matchedSections].sort(), matchedFields: [...matchedFields].sort(),
        path: entry.path, line: entry.line, score,
        reason: reasons.length ? reasons.join("; ") : "recent session memory",
      });
    }
  }
  scored.sort((a, b) => Number(b.score) - Number(a.score) || Number(b.session) - Number(a.session)
    || String(a.path).localeCompare(String(b.path)) || Number(a.line) - Number(b.line));
  const results = limit ? scored.slice(0, limit) : scored;
  return { query, developers, filters, total: results.length, results };
}
