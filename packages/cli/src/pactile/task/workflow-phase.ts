import fs from "node:fs";
import path from "node:path";

/** Human orientation only; Kernel remains the runtime phase authority. */
export function readWorkflowPhase(root: string, step?: string, platform?: string): string {
  const file = path.join(root, ".pactile", "workflow.md");
  if (!fs.existsSync(file)) throw new Error(`workflow.md not found: ${file}`);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  if (step) {
    start = lines.findIndex((line) => line.match(/^####\s+(\d+\.\d+)\b/)?.[1] === step);
    if (start < 0) throw new Error(`Step not found: ${step}`);
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^#{2,4}\s/.test(lines[index]) || lines[index].trim() === "---") { end = index; break; }
    }
  } else {
    start = lines.findIndex((line) => line.trim() === "## Phase Index");
    if (start < 0) throw new Error("Phase Index section not found in workflow.md");
    const next = lines.findIndex((line, index) => index > start && line.trim() === "## Phase 1: Plan");
    if (next >= 0) end = next;
  }
  let content = lines.slice(start, end).join("\n").replace(/\[workflow-state:([A-Za-z0-9_-]+)\]\s*\n[\s\S]*?\n\s*\[\/workflow-state:\1\]\n?/g, "");
  if (platform) {
    const target = platform.toLowerCase().replace(/[-_\s]/g, "");
    let active = false;
    let keep = false;
    const output: string[] = [];
    for (const line of content.split("\n")) {
      const marker = line.match(/^\[\/?([A-Za-z][^[\]]*)\]\s*$/);
      if (marker) {
        if (line.startsWith("[/")) { active = false; keep = false; }
        else { active = true; keep = marker[1].split(",").some((name) => name.toLowerCase().replace(/[-_\s]/g, "") === target); }
        continue;
      }
      if (!active || keep) output.push(line);
    }
    content = output.join("\n").replace(/\n{4,}/g, "\n\n\n");
  }
  return `${content.trimEnd()}\n`;
}
