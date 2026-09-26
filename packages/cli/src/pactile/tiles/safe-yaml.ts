/** Deliberately restricted YAML transport, not a general YAML implementation. */
export const MAX_TILE_TEXT_BYTES = 1_048_576;

export class TileYamlError extends Error {
  constructor(
    readonly code: string,
    readonly line: number,
  ) {
    super(`${code} at line ${line}`);
  }
}

interface Line {
  indent: number;
  text: string;
  number: number;
}

export function normalizeTileText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** JSON-shaped maps/lists/scalars; empty [] and {} are the only flow syntax. */
export interface TileYamlParseOptions {
  /** Keep legacy Pactile config values yes/no/on/off as strings. */
  readonly allowLegacyBooleanStrings?: boolean;
}

export function parseTileYaml(
  text: string,
  options: TileYamlParseOptions = {},
): unknown {
  if (Buffer.byteLength(text, "utf8") > MAX_TILE_TEXT_BYTES)
    throw new TileYamlError("yaml-size-limit", 1);
  const lines: Line[] = [];
  for (const [index, raw] of normalizeTileText(text).split("\n").entries()) {
    if (raw.includes("\t")) throw new TileYamlError("yaml-tab", index + 1);
    // Controls other than the already-split newline are not safe text.
    if ([...raw].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
      throw new TileYamlError("yaml-control-character", index + 1);
    }
    const content = stripComment(raw, index + 1).trimEnd();
    if (!content.trim()) continue;
    const indent = content.length - content.trimStart().length;
    if (content.slice(0, indent) !== " ".repeat(indent))
      throw new TileYamlError("yaml-indentation", index + 1);
    const value = content.slice(indent);
    if (/^(---|\.\.\.)(?:\s|$)|^%/.test(value))
      throw new TileYamlError("yaml-document", index + 1);
    lines.push({ indent, text: value, number: index + 1 });
  }
  if (!lines.length) throw new TileYamlError("yaml-empty", 1);
  if (lines[0].indent !== 0)
    throw new TileYamlError("yaml-indentation", lines[0].number);
  let position = 0;

  function block(indent: number, depth: number): unknown {
    if (depth > 64)
      throw new TileYamlError("yaml-depth-limit", lines[position].number);
    const list = /^-(?: |$)/.test(lines[position].text);
    const array: unknown[] = [];
    const object: Record<string, unknown> = {};
    while (position < lines.length && lines[position].indent === indent) {
      const line = lines[position++];
      if (list) {
        if (!/^-(?: |$)/.test(line.text))
          throw new TileYamlError("yaml-mixed-collection", line.number);
        const item = line.text.slice(1).trimStart();
        if (!item) array.push(nested(indent, depth, line.number));
        else if (mappingSplit(item) >= 0) {
          const record: Record<string, unknown> = {};
          member(record, item, indent + 2, depth + 1, line.number);
          while (
            position < lines.length &&
            lines[position].indent > indent
          ) {
            const continuation = lines[position++];
            if (continuation.indent !== indent + 2)
              throw new TileYamlError("yaml-indentation", continuation.number);
            member(
              record,
              continuation.text,
              indent + 2,
              depth + 1,
              continuation.number,
            );
          }
          array.push(record);
        } else {
          array.push(
            scalar(item, line.number, options.allowLegacyBooleanStrings),
          );
        }
      } else {
        member(object, line.text, indent, depth, line.number);
      }
      if (position < lines.length && lines[position].indent > indent)
        throw new TileYamlError("yaml-indentation", lines[position].number);
    }
    return list ? array : object;
  }

  function nested(indent: number, depth: number, line: number): unknown {
    if (position >= lines.length || lines[position].indent <= indent)
      throw new TileYamlError("yaml-missing-value", line);
    return block(lines[position].indent, depth + 1);
  }

  function member(
    record: Record<string, unknown>,
    text: string,
    indent: number,
    depth: number,
    line: number,
  ): void {
    const split = mappingSplit(text);
    if (split < 0) throw new TileYamlError("yaml-mapping-required", line);
    const rawKey = text.slice(0, split).trim();
    const key = scalar(rawKey, line);
    if (typeof key !== "string" || !key || key === "<<")
      throw new TileYamlError("yaml-complex-key", line);
    if (Object.hasOwn(record, key))
      throw new TileYamlError("yaml-duplicate-key", line);
    const rawValue = text.slice(split + 1).trim();
    const value = rawValue
      ? scalar(rawValue, line, options.allowLegacyBooleanStrings)
      : nested(indent, depth, line);
    // defineProperty avoids the legacy __proto__ setter while keeping a plain JSON object.
    Object.defineProperty(record, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const result = block(0, 0);
  if (position !== lines.length)
    throw new TileYamlError("yaml-indentation", lines[position].number);
  return result;
}

function stripComment(text: string, line: number): string {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === '"' && c === "\\") {
      i++;
      continue;
    }
    if (quote === "'" && c === "'" && text[i + 1] === "'") {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
    } else if (
      (c === '"' || c === "'") &&
      (i === 0 || /[\s:]/.test(text[i - 1]))
    )
      quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(text[i - 1])))
      return text.slice(0, i);
  }
  if (quote) throw new TileYamlError("yaml-unterminated-string", line);
  return text;
}

function mappingSplit(text: string): number {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === '"' && c === "\\") {
      i++;
      continue;
    }
    if (quote === "'" && c === "'" && text[i + 1] === "'") {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
    } else if (i === 0 && (c === '"' || c === "'")) quote = c;
    else if (c === ":" && (i === text.length - 1 || text[i + 1] === " "))
      return i;
  }
  return -1;
}

function scalar(
  text: string,
  line: number,
  allowLegacyBooleanStrings = false,
): unknown {
  if (text === "[]") return [];
  if (text === "{}") return {};
  if (text.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "string") return parsed;
    } catch {
      /* Reject unsupported escapes and trailing syntax. */
    }
    throw new TileYamlError("yaml-invalid-string", line);
  }
  if (text.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(text))
      throw new TileYamlError("yaml-invalid-string", line);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (
    !text ||
    /^[[\]{}&*!|>@`?,%]|^-(?: |$)|^<<$/.test(text) ||
    /(?:^|\s)[&*!][^\s]*|:\s/.test(text)
  ) {
    throw new TileYamlError("yaml-unsupported-syntax", line);
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  // A full dotted version is unambiguously a string, not a YAML number.
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(text))
    return text;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) {
    const value = Number(text);
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    )
      throw new TileYamlError("yaml-number-range", line);
    return value;
  }
  if (
    (!allowLegacyBooleanStrings || !/^(?:yes|no|on|off)$/i.test(text)) &&
    (/^(?:true|false|null|yes|no|on|off|~|[+-]?\.(?:inf|nan))$/i.test(text) ||
      /^\d{4}-\d\d-\d\d(?:$|[Tt ])/.test(text) ||
      /^[+-]?(?:\d|\.\d)/.test(text))
  ) {
    // Ambiguous implicit scalars must be explicitly quoted.
    throw new TileYamlError("yaml-implicit-scalar", line);
  }
  return text;
}
