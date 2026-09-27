/**
 * Compatibility scrubbers for structured config files during detach.
 *
 * Each scrubber takes the file content (and any context it needs) and returns
 * `{ content, fullyEmpty }`:
 * - `content` is the post-scrub text to write back if the file should remain.
 * - `fullyEmpty` is true when, after stripping every Pactile-managed value,
 *   nothing meaningful is left. The caller deletes the file in that case.
 *
 * Manifest path matching (for hooks.json scrubbers) uses substring containment
 * on the resolved `command` string. The leading `python3 ` / `python ` prefix
 * does not matter — we just look for the manifest-relative file path.
 */

export interface ScrubResult {
  content: string;
  fullyEmpty: boolean;
}

/**
 * Test whether a hook command string references any of the given manifest paths.
 *
 * Pactile-emitted hook commands have the shape
 *   `<python-cmd> [interpreter-flags] <manifest-path> [hook-args…]`
 * e.g. `python .legacy/hooks/event-bridge.py --event sessionStart`.
 * The invoked script is the first non-flag token after the interpreter, not
 * necessarily the last token. Matching only the last token left leftover
 * `event-bridge.py` references after uninstall.
 *
 * This is still stricter than substring matching: a user hook whose body
 * merely mentions a deleted path inside an `echo` argument
 * (`echo "see .claude/hooks/session-start.py for inspiration" && python3 my-hook.py`)
 * does NOT match, because the invoked script is `my-hook.py`. Absolute-path
 * variants like `/Users/me/proj/.claude/hooks/session-start.py` match via
 * `endsWith("/" + p)`.
 */
function isPythonCommandToken(token: string): boolean {
  const base = token
    .replace(/^["']|["']$/g, "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.toLowerCase();
  return (
    base === "python" ||
    base === "python3" ||
    base === "python.exe" ||
    base === "python3.exe" ||
    base === "py" ||
    base === "py.exe"
  );
}

function extractInvokedScriptToken(command: string): string {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length === 0) return "";

  for (let i = 0; i < tokens.length; i++) {
    if (!isPythonCommandToken(tokens[i])) continue;
    let j = i + 1;
    while (j < tokens.length) {
      const opt = tokens[j].replace(/^["']|["']$/g, "");
      if (opt.startsWith("-") && !opt.includes("/") && !opt.endsWith(".py")) {
        j += 1;
        continue;
      }
      break;
    }
    if (j < tokens.length) {
      return tokens[j].replace(/^["']|["']$/g, "");
    }
  }

  return tokens[tokens.length - 1].replace(/^["']|["']$/g, "");
}

function commandMatchesDeletedPath(
  command: string,
  deletedPaths: readonly string[],
): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;

  const scriptToken = extractInvokedScriptToken(trimmed);
  if (scriptToken.length === 0) return false;

  for (const p of deletedPaths) {
    if (scriptToken === p || scriptToken.endsWith("/" + p)) {
      return true;
    }
  }
  return false;
}

/**
 * Read the `command` (or fallback `bash` / `powershell`) string out of an
 * arbitrary hook entry. Copilot's flat schema uses `bash` + `powershell`
 * instead of `command` for some events.
 */
function getEntryCommand(entry: unknown): string | null {
  if (entry === null || typeof entry !== "object") {
    return null;
  }
  const obj = entry as Record<string, unknown>;
  if (typeof obj.command === "string") return obj.command;
  if (typeof obj.bash === "string") return obj.bash;
  if (typeof obj.powershell === "string") return obj.powershell;
  return null;
}

/**
 * Scrub a hooks-shaped settings JSON file.
 *
 * `mode = "nested"` → `hooks.{Event}.[ {matcher?, hooks: [ {command,...} ]} ]`
 * `mode = "flat"`   → `hooks.{Event}.[ {command,...} ]`
 *
 * Strips every entry whose command references a path in `deletedPaths`,
 * then bottom-up cleans empty containers (matcher block, event array, hooks
 * object). Any user-defined keys outside `hooks` (e.g. `env`, `model`,
 * `permissions`, `version`) are preserved verbatim.
 */
export function scrubHooksJson(
  content: string,
  deletedPaths: readonly string[],
  mode: "nested" | "flat",
): ScrubResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Malformed JSON — leave it untouched, caller will skip.
    return { content, fullyEmpty: false };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { content, fullyEmpty: false };
  }

  const root = parsed as Record<string, unknown>;
  const hooks = root.hooks;

  if (hooks === undefined) {
    // No hooks block — nothing to scrub. Treat as fully empty only if the
    // entire file has no other keys.
    const fullyEmpty = Object.keys(root).length === 0;
    return { content: JSON.stringify(root, null, 2) + "\n", fullyEmpty };
  }

  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
    // hooks is some unexpected shape — leave it alone.
    return { content, fullyEmpty: false };
  }

  const hooksObj = hooks as Record<string, unknown>;

  for (const eventName of Object.keys(hooksObj)) {
    const eventArr = hooksObj[eventName];
    if (!Array.isArray(eventArr)) continue;

    const filteredEvent: unknown[] = [];

    for (const entry of eventArr) {
      if (mode === "flat") {
        const cmd = getEntryCommand(entry);
        if (cmd !== null && commandMatchesDeletedPath(cmd, deletedPaths)) {
          continue; // drop Pactile entry
        }
        filteredEvent.push(entry);
      } else {
        // nested: entry is { matcher?, hooks: [...] }
        if (entry === null || typeof entry !== "object") {
          filteredEvent.push(entry);
          continue;
        }
        const matcherBlock = entry as Record<string, unknown>;
        const inner = matcherBlock.hooks;
        if (!Array.isArray(inner)) {
          filteredEvent.push(entry);
          continue;
        }

        const filteredInner = inner.filter((sub) => {
          const cmd = getEntryCommand(sub);
          return !(
            cmd !== null && commandMatchesDeletedPath(cmd, deletedPaths)
          );
        });

        if (filteredInner.length === 0) {
          // Whole matcher block is now empty → drop the block.
          continue;
        }

        // Reconstruct the block with the filtered inner list.
        const rebuilt: Record<string, unknown> = { ...matcherBlock };
        rebuilt.hooks = filteredInner;
        filteredEvent.push(rebuilt);
      }
    }

    if (filteredEvent.length === 0) {
      // Drop the whole event array.
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete hooksObj[eventName];
    } else {
      hooksObj[eventName] = filteredEvent;
    }
  }

  // If hooks is empty → drop the key.
  if (Object.keys(hooksObj).length === 0) {
    delete root.hooks;
  } else {
    root.hooks = hooksObj;
  }

  const fullyEmpty = Object.keys(root).length === 0;
  return {
    content: JSON.stringify(root, null, 2) + "\n",
    fullyEmpty,
  };
}
