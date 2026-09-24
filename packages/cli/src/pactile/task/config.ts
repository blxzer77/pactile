import fs from "node:fs";
import path from "node:path";

type ConfigValue = string | ConfigValue[] | { [key: string]: ConfigValue };
export type PactileConfig = Record<string, ConfigValue>;

function stripComment(input: string): string {
  let quote: string | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "#" && (index === 0 || /\s/.test(input[index - 1]))) return input.slice(0, index);
  }
  return input;
}

function unquote(input: string): string {
  const value = input.trim();
  return value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1) : value;
}

/** Compatible with the nested mappings and scalar lists accepted by the old config reader. */
export function parseSimpleConfig(content: string): PactileConfig {
  const lines = content.split(/\r?\n/);
  const nextContent = (start: number): number => {
    for (let i = start; i < lines.length; i += 1) if (lines[i].trim() && !lines[i].trim().startsWith("#")) return i;
    return lines.length;
  };
  const parseBlock = (start: number, minIndent: number): [PactileConfig, number] => {
    const result: PactileConfig = {};
    let index = start;
    let list: ConfigValue[] | null = null;
    while (index < lines.length) {
      const line = lines[index];
      const stripped = line.trim();
      if (!stripped || stripped.startsWith("#")) { index += 1; continue; }
      const indent = line.length - line.trimStart().length;
      if (indent < minIndent) break;
      if (stripped.startsWith("- ")) {
        if (list) list.push(unquote(stripped.slice(2)));
        index += 1;
        continue;
      }
      const colon = stripped.indexOf(":");
      if (colon < 0) { index += 1; continue; }
      const key = stripped.slice(0, colon).trim();
      const value = unquote(stripComment(stripped.slice(colon + 1)));
      list = null;
      if (value) { result[key] = value; index += 1; continue; }
      const next = nextContent(index + 1);
      if (next >= lines.length) { result[key] = {}; index = next; continue; }
      if (lines[next].trim().startsWith("- ")) {
        list = [];
        result[key] = list;
        index += 1;
        continue;
      }
      const nextIndent = lines[next].length - lines[next].trimStart().length;
      if (nextIndent > indent) {
        const [nested, after] = parseBlock(index + 1, nextIndent);
        result[key] = nested;
        index = after;
      } else { result[key] = {}; index += 1; }
    }
    return [result, index];
  };
  return parseBlock(0, 0)[0];
}

export function readPactileConfig(root: string): PactileConfig {
  try { return parseSimpleConfig(fs.readFileSync(path.join(root, ".pactile", "config.yaml"), "utf8")); }
  catch { return {}; }
}
