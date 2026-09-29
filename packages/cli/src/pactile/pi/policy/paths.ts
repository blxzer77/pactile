import fs from "node:fs";
import path from "node:path";

export interface PiPathGrant {
  path: string;
  kind: "file" | "directory";
}

/** Reject links, missing-root paths and ambiguous Windows spellings before admission. */
export function canonicalPiPath(value: string, cwd: string): string {
  if (!value || [...value].some((character) => character.charCodeAt(0) < 32) || /^(?:\\\\|\/\/)/u.test(value))
    throw new Error("Pi path is empty, a device/UNC path, or contains control characters");
  if (process.platform === "win32") {
    const tail = value.replace(/^[A-Za-z]:/u, "");
    if (tail.includes(":")) throw new Error("Pi alternate data streams are forbidden");
    if (value.split(/[\\/]/u).some((part) => /[. ]$/u.test(part) && part !== "." && part !== ".."))
      throw new Error("Pi path has an ambiguous trailing character");
    if (value.split(/[\\/]/u).some((part) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)))
      throw new Error("Pi device filenames are forbidden");
    if (/^[A-Za-z]:[^\\/]/u.test(value)) throw new Error("Pi drive-relative paths are forbidden");
  }
  const absolute = path.resolve(cwd, value);
  const parts: string[] = [];
  let existing = absolute;
  while (!fs.lstatSync(existing, { throwIfNoEntry: false })) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error("Pi path has no existing filesystem root");
    parts.unshift(path.basename(existing));
    existing = parent;
  }
  // Walk each existing component; realpath alone would silently bless a symlink escape.
  let cursor = path.parse(existing).root;
  for (const component of existing.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Pi symbolic links/reparse paths are forbidden");
  }
  const resolved = path.join(fs.realpathSync(existing), ...parts);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

export function insidePiPath(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function matchesPiGrant(target: string, grant: PiPathGrant): boolean {
  return grant.kind === "file" ? target === grant.path : insidePiPath(target, grant.path);
}

export function isPiProtectedPath(target: string): boolean {
  return target.split(/[\\/]/u).some((part) => /^(?:\.git|\.pactile)$/iu.test(part));
}

export function isPiProtectedWrite(target: string, cwd: string, roots: string[], registeredRun: boolean): boolean {
  // A legitimate P38 workspace lives under the Kernel's .pactile/worktrees. Its
  // ancestor is not its writable product content; its own .git/.pactile stay protected.
  if (insidePiPath(target, cwd) && isPiProtectedPath(path.relative(cwd, target))) return true;
  return roots.some((root) => insidePiPath(target, root) && !(registeredRun && root !== cwd && insidePiPath(cwd, root) && insidePiPath(target, cwd)));
}

export function isPiCredentialPath(target: string): boolean {
  return target.split(/[\\/]/u).some((part) => !/^(?:\.env\.(?:example|sample|template))$/iu.test(part) && /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|auth\.json|models\.json|credentials(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|p12|pfx|key))$/iu.test(part));
}

/** Bound aggregate reads and exclude links/credentials; never ask a search server to follow them. */
export function piReadExclusions(target: string): string[] {
  const patterns = new Set<string>(["!**/.git/**", "!**/.pactile/**", "!**/node_modules/**"]);
  let visited = 0;
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++visited > 50_000) throw new Error("Pi aggregate read exceeds its entry budget; use a narrower source");
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || isPiCredentialPath(file) || [".git", ".pactile", "node_modules"].includes(entry.name)) {
        const relative = path.relative(target, file).replaceAll("\\", "/");
        if (/[!*?[\]{}]/u.test(relative)) throw new Error("Pi excluded search path cannot be expressed unambiguously");
        patterns.add(`!${relative}`); patterns.add(`!${relative}/**`);
      } else if (entry.isDirectory()) walk(file);
    }
  };
  walk(target); return [...patterns];
}
