import fs from "node:fs";
import path from "node:path";
import { parseSimpleConfig } from "../task/config.js";

export type JevProjectEgressPolicyV1 =
  | {
      readonly allowed: true;
      readonly source: "default" | "configured";
    }
  | {
      readonly allowed: false;
      readonly reasonCode: "egress-denied" | "configuration-invalid";
    };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function withoutComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/u.test(line[index - 1] ?? "")))
      return line.slice(0, index);
  }
  return line;
}

function hasBalancedQuotes(line: string): boolean {
  let quote: string | null = null;
  for (const character of line) {
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === "'" || character === '"') {
      quote = character;
    }
  }
  return quote === null;
}

function validSimpleConfigBlock(
  lines: readonly string[],
  start: number,
  indentation: number,
  kind: "mapping" | "list",
): number {
  let index = start;
  while (index < lines.length) {
    const raw = withoutComment(lines[index] ?? "");
    if (!raw.trim()) {
      index += 1;
      continue;
    }
    if (raw.includes("\t") || !hasBalancedQuotes(raw)) return -1;
    const currentIndentation = raw.length - raw.trimStart().length;
    if (currentIndentation < indentation) return index;
    if (currentIndentation > indentation) return -1;

    const entry = raw.trim();
    if (kind === "list") {
      if (!entry.startsWith("- ") || !entry.slice(2).trim()) return -1;
      index += 1;
      continue;
    }
    if (entry.startsWith("- ")) return -1;
    const separator = entry.indexOf(":");
    const key = entry.slice(0, separator).trim();
    if (
      separator <= 0 ||
      !key ||
      key.includes("'") ||
      key.includes('"') ||
      key.includes("[") ||
      key.includes("]") ||
      /[{}?&*!>|]/u.test(key) ||
      key.startsWith("-")
    )
      return -1;
    const value = entry.slice(separator + 1).trim();
    index += 1;
    if (value) continue;

    let next = index;
    while (next < lines.length && !withoutComment(lines[next] ?? "").trim())
      next += 1;
    if (next >= lines.length) continue;
    const childLine = withoutComment(lines[next] ?? "");
    const childIndentation = childLine.length - childLine.trimStart().length;
    if (childIndentation <= indentation) continue;
    const childKind = childLine.trim().startsWith("- ") ? "list" : "mapping";
    const afterChild = validSimpleConfigBlock(
      lines,
      next,
      childIndentation,
      childKind,
    );
    if (afterChild < 0) return -1;
    index = afterChild;
  }
  return index;
}

function validateSimpleConfigSyntax(content: string): boolean {
  const lines = content.split(/\r?\n/u);
  const first = lines.findIndex((line) => withoutComment(line).trim());
  if (first < 0) return true;
  const firstLine = withoutComment(lines[first] ?? "");
  if (
    firstLine.includes("\t") ||
    firstLine.length !== firstLine.trimStart().length
  )
    return false;
  return validSimpleConfigBlock(lines, first, 0, "mapping") === lines.length;
}

function validateJevConfigSection(content: string): boolean {
  const lines = content.split(/\r?\n/u);
  const declarations: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = withoutComment(lines[index] ?? "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indentation = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (indentation === 0 && /^jev(?:\s*:|\s*$)/iu.test(trimmed)) {
      if (!/^jev(?:\s*:|\s*$)/u.test(trimmed)) return false;
      if (!/^jev\s*:/u.test(trimmed)) return false;
      declarations.push(index);
      if (withoutComment(trimmed.slice(trimmed.indexOf(":") + 1)).trim())
        return false;
    }
  }
  if (declarations.length > 1) return false;
  if (declarations.length === 0) return true;

  let egressDeclarations = 0;
  const start = declarations[0] ?? -1;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = withoutComment(lines[index] ?? "");
    if (!line.trim()) continue;
    const indentation = line.length - line.trimStart().length;
    if (indentation === 0) break;
    const trimmed = line.trim();
    if (!/^(?:egress|["']egress["'])(?:\s|:|$)/u.test(trimmed)) continue;
    if (indentation !== 2 || !/^egress\s*:/u.test(trimmed)) return false;
    egressDeclarations += 1;
  }
  return egressDeclarations <= 1;
}

function invalid(): JevProjectEgressPolicyV1 {
  return { allowed: false, reasonCode: "configuration-invalid" };
}

/** Resolve only the project-level Jev egress switch; it does not grant retrieval Providers. */
export function resolveJevProjectEgressPolicyV1(
  root: string,
): JevProjectEgressPolicyV1 {
  const configPath = path.join(root, ".pactile", "config.yaml");
  let content: string;
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { allowed: true, source: "default" };
    return invalid();
  }
  try {
    if (
      !validateSimpleConfigSyntax(content) ||
      !validateJevConfigSection(content)
    )
      return invalid();

    const config = parseSimpleConfig(content);
    const jev = config.jev;
    if (jev === undefined) return { allowed: true, source: "default" };
    const section = record(jev);
    if (!section) return invalid();
    const egress = section.egress;
    if (egress === undefined) return { allowed: true, source: "default" };
    if (egress === "allow") return { allowed: true, source: "configured" };
    if (egress === "deny")
      return { allowed: false, reasonCode: "egress-denied" };
    return invalid();
  } catch {
    return invalid();
  }
}
