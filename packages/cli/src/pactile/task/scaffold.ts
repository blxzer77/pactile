import fs from "node:fs";
import path from "node:path";
import type { PactileTaskRecord } from "../../core/task/index.js";
import { checkArchive } from "./guards.js";

const DRAFT_MARKER = "<!-- pactile:archive-evidence-draft -->";

function specSuggestions(root: string, record: PactileTaskRecord): string[] {
  const choices = [record.package, record.scope, "guides"];
  const found: string[] = [];
  for (const choice of choices) {
    if (typeof choice !== "string" || !/^[a-zA-Z0-9_-]+$/.test(choice)) continue;
    const relative = `.pactile/spec/${choice}/index.md`;
    if (fs.existsSync(path.join(root, relative)) && !found.includes(relative)) found.push(relative);
  }
  return found;
}

/** Draft missing archive slots without inventing evidence or overwriting user text. */
export function prepareArchiveEvidence(dir: string, record: PactileTaskRecord, dryRun: boolean): string[] {
  const file = path.join(dir, "verify.md");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "# Verification Evidence\n";
  const errors = checkArchive(dir, record).errors;
  const missing = [
    ["verify.md missing validation evidence", "Validation commands: TODO"],
    ["verify.md missing final acceptance evidence", "Final acceptance evidence: TODO"],
    ["verify.md missing durable-learning decision evidence", "Durable learning decision: TODO"],
    ["verify.md missing check evidence", "Check evidence: TODO"],
    ["verify.md or handoff.md missing reviewed change-set evidence", "Reviewed change-set: TODO"],
  ] as const;
  const missingFile = errors.includes("verify.md");
  const lines = missing.filter(([error], index) => errors.includes(error) || (missingFile && index < 2)).map(([, draft]) => draft);
  if (!lines.length) return ["No missing archive evidence slots to draft."];
  if (current.includes(DRAFT_MARKER)) return ["Existing archive evidence draft found; edit its TODO lines in place."];
  const draft = `${DRAFT_MARKER}\n## Archive evidence draft\n\n${lines.join("\n")}\n`;
  if (dryRun) return ["Dry run: would append the following draft to verify.md:", draft];
  fs.writeFileSync(file, `${current.trimEnd()}\n\n${draft}`, "utf8");
  return ["Appended archive evidence draft to verify.md; replace TODO lines with actual evidence before archive."];
}

/** Read-only suggestions; the user decides whether a spec change is warranted. */
export function learningScaffold(root: string, dir: string, record: PactileTaskRecord, trigger?: string): string {
  const lines = [
    "## Spec update scaffold (reviewer-confirmed)",
    "",
    "Suggestions only. Confirm the learning decision before editing project specs.",
    "",
  ];
  if (trigger?.trim()) lines.push(`Trigger: ${trigger.trim()}`, "");
  lines.push(
    "1. Record one durable learning decision in verify.md:",
    "   - No reusable learning: `Durable learning decision: no durable learning`",
    "   - Spec changed: `Spec update evidence: .pactile/spec/<path>`",
    `   - Already documented: \`Learning artifact: .pactile/tasks/${path.basename(dir)}/handoff.md\``,
    "",
    "2. Review likely spec indexes; this command does not edit them:",
  );
  const suggestions = specSuggestions(root, record);
  lines.push(...(suggestions.length ? suggestions.map((item) => `   - ${item}`) : ["   - Browse .pactile/spec/ for the relevant index.md"]));
  lines.push("", `3. Run \`pactile task archive ${path.basename(dir)} --check\` after verify.md is final.`, "");
  return lines.join("\n");
}
