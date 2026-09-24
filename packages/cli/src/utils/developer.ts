import fs from "node:fs";
import path from "node:path";
import { localDate } from "./local-date.js";

/** The user-owned identity format predates the Node runtime. Keep it stable. */
export function readDeveloper(root: string): string | null {
  const file = path.join(root, ".pactile", ".developer");
  if (!fs.existsSync(file)) return null;
  const match = fs.readFileSync(file, "utf8").match(/^name=(.*)$/m);
  const name = match?.[1]?.trim();
  if (!name) return null;
  return name;
}

/** Create the developer workspace skeleton. */
export function initializeDeveloper(root: string, name: string): boolean {
  const developer = name.trim();
  if (!developer || developer === "." || developer === ".." || /[\\/\r\n]/.test(developer)) {
    throw new Error("developer name must be a non-empty single path segment");
  }
  if (readDeveloper(root)) return false;

  const pactileRoot = path.join(root, ".pactile");
  const workspace = path.join(pactileRoot, "workspace", developer);
  fs.mkdirSync(workspace, { recursive: true });
  const today = localDate();
  const journal = path.join(workspace, "journal-1.md");
  if (!fs.existsSync(journal)) {
    fs.writeFileSync(journal, `# Journal - ${developer} (Part 1)\n\n> AI development session journal\n> Started: ${today}\n\n---\n\n`, "utf8");
  }
  const index = path.join(workspace, "index.md");
  if (!fs.existsSync(index)) {
    fs.writeFileSync(index, `# Workspace Index - ${developer}\n\n> Journal tracking for AI development sessions.\n\n---\n\n## Current Status\n\n<!-- @@@auto:current-status -->\n- **Active File**: \`journal-1.md\`\n- **Total Sessions**: 0\n- **Last Active**: -\n<!-- @@@/auto:current-status -->\n\n---\n\n## Active Documents\n\n<!-- @@@auto:active-documents -->\n| File | Lines | Status |\n|------|-------|--------|\n| \`journal-1.md\` | ~0 | Active |\n<!-- @@@/auto:active-documents -->\n\n---\n\n## Session History\n\n<!-- @@@auto:session-history -->\n| # | Date | Title | Commits | Branch |\n|---|------|-------|---------|--------|\n<!-- @@@/auto:session-history -->\n\n---\n\n## Notes\n\n- Sessions are appended to journal files\n- New journal file created when current exceeds 2000 lines\n- Use \`pactile session add\` to record sessions\n`, "utf8");
  }
  fs.writeFileSync(path.join(pactileRoot, ".developer"), `name=${developer}\ninitialized_at=${new Date().toISOString()}\n`, "utf8");
  return true;
}
