import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CANONICAL_PATHS_V1 } from "../../core/index.js";
import { caseFoldComponent } from "./case-fold.js";
import { normalizeNfc15 } from "./unicode-nfc.js";

export type RuntimeErrorCode =
  | "canonical-collision"
  | "outside-project"
  | "link-escape"
  | "legacy-write-denied"
  | "state-malformed"
  | "cas-mismatch"
  | "generation-unsealed"
  | "generation-sealed"
  | "generation-invalid"
  | "atomic-replace-failed";

export class RuntimeError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

/** Do not leak native errno messages (which commonly embed absolute paths). */
export function runtimeBoundary<T>(
  fallback: RuntimeErrorCode,
  action: () => T,
): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError(fallback);
  }
}

/** Filesystem boundary, injectable for I/O faults; no lifecycle/host operations. */
export type RuntimeFileSystem = Pick<
  typeof fs,
  | "lstatSync"
  | "realpathSync"
  | "readdirSync"
  | "readFileSync"
  | "mkdirSync"
  | "openSync"
  | "writeFileSync"
  | "fsyncSync"
  | "closeSync"
  | "renameSync"
  | "unlinkSync"
  | "fstatSync"
>;

export const nodeRuntimeFileSystem: RuntimeFileSystem = fs;
export { caseFoldComponent } from "./case-fold.js";

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function maybeStat(
  io: RuntimeFileSystem,
  target: string,
): fs.Stats | null {
  try {
    return io.lstatSync(target);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new RuntimeError("state-malformed");
  }
}

/** Pure, no filesystem access. All data paths come from the frozen M0 contract. */
export function resolveCanonicalPaths(projectRoot: string): {
  projectRoot: string;
  canonicalRoot: string;
  writePolicy: "canonical-only";
  installStatePath: string;
  generationsPath: string;
  tilesPath: string;
  tasksPath: string;
  archivePath: string;
  workspacePath: string;
  ownershipLedgerPath: string;
  migrationJournalsPath: string;
  receiptsPath: string;
} {
  const root = path.resolve(projectRoot);
  const absolute = (relative: string): string => path.join(root, relative);
  const paths = DEFAULT_CANONICAL_PATHS_V1;
  return {
    projectRoot: root,
    canonicalRoot: absolute(paths.canonicalRoot),
    writePolicy: paths.writePolicy,
    installStatePath: absolute(paths.installStatePath),
    generationsPath: absolute(paths.generationsPath),
    tilesPath: absolute(paths.tilesPath),
    tasksPath: absolute(paths.tasksPath),
    archivePath: absolute(paths.archivePath),
    workspacePath: absolute(paths.workspacePath),
    ownershipLedgerPath: absolute(paths.ownershipLedgerPath),
    migrationJournalsPath: absolute(paths.migrationJournalsPath),
    receiptsPath: absolute(paths.receiptsPath),
  };
}

/** Portable path grammar: reject aliases (including Windows ADS/device names). */
export function normalizeRuntimeRelativePath(value: string): string {
  const normalized = normalizeNfc15(value.replace(/\\/g, "/"));
  const parts = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[<>:"|?*]/u.test(part) ||
        Array.from(part).some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        ) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
    )
  ) {
    throw new RuntimeError("outside-project");
  }
  return normalized;
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function assertRoot(io: RuntimeFileSystem, root: string): string {
  const stat = maybeStat(io, root);
  if (stat === null) throw new RuntimeError("outside-project");
  if (stat.isSymbolicLink()) throw new RuntimeError("link-escape");
  if (!stat.isDirectory()) throw new RuntimeError("outside-project");
  // A symlink in any ancestor would otherwise make the lexical project boundary ambiguous.
  const real = io.realpathSync(root);
  if (path.relative(real, root) !== "") throw new RuntimeError("link-escape");
  return real;
}

/** Check each existing component without following links; reject even in-root links.
 * Callers must use the returned NFC path and recheck immediately before I/O.
 * This is a local cooperative-writer boundary, not an OS sandbox against a
 * hostile same-user process replacing directory ancestors concurrently.
 */
export function assertCanonicalWriteTarget(
  projectRoot: string,
  target: string,
  io: RuntimeFileSystem = fs,
): string {
  return runtimeBoundary("state-malformed", () =>
    canonicalWriteTarget(projectRoot, target, io),
  );
}

function canonicalWriteTarget(
  projectRoot: string,
  target: string,
  io: RuntimeFileSystem,
): string {
  const root = path.resolve(projectRoot);
  const absolute = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(root, target.replace(/\\/g, "/"));
  if (!contained(root, absolute)) throw new RuntimeError("outside-project");
  // Inspect the original spelling, not only path.resolve's collapsed result.
  const rawRelative = path.isAbsolute(target)
    ? path.relative(root, target)
    : target;
  const relative = normalizeRuntimeRelativePath(rawRelative);
  const parts = relative.split("/");
  const first = caseFoldComponent(parts[0]);
  if (
    DEFAULT_CANONICAL_PATHS_V1.legacySources.some(
      (source) => first === source.root,
    )
  ) {
    throw new RuntimeError("legacy-write-denied");
  }
  if (first !== DEFAULT_CANONICAL_PATHS_V1.canonicalRoot)
    throw new RuntimeError("outside-project");
  if (parts[0] !== DEFAULT_CANONICAL_PATHS_V1.canonicalRoot)
    throw new RuntimeError("canonical-collision");
  const realRoot = assertRoot(io, root);
  let current = root;
  for (const [index, part] of parts.entries()) {
    const parentStat = maybeStat(io, current);
    if (parentStat) {
      const matches = io
        .readdirSync(current)
        .filter((name) => caseFoldComponent(name) === caseFoldComponent(part));
      if (matches.length > 1 || (matches.length === 1 && matches[0] !== part)) {
        throw new RuntimeError("canonical-collision");
      }
    }
    current = path.join(current, part);
    const stat = maybeStat(io, current);
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new RuntimeError("link-escape");
    const real = io.realpathSync(current);
    if (!contained(realRoot, real) || path.relative(current, real) !== "")
      throw new RuntimeError("link-escape");
    if (stat.isFile() && stat.nlink > 1) throw new RuntimeError("link-escape");
    if (!stat.isFile() && !stat.isDirectory())
      throw new RuntimeError("link-escape");
    if (index < parts.length - 1 && !stat.isDirectory())
      throw new RuntimeError("state-malformed");
  }
  return current;
}

export interface RuntimeDiscovery {
  canonical: { root: ".pactile"; present: boolean; access: "canonical-only" };
  legacy: {
    kind: "cstl" | "trellis";
    root: ".cstl" | ".trellis";
    present: boolean;
    access: "read-only";
  }[];
  diagnostics: { code: RuntimeErrorCode; root: string }[];
}

/** Read-only inventory. Presence never grants permission to write legacy state. */
export function discoverRuntimeRoots(
  projectRoot: string,
  io: RuntimeFileSystem = fs,
): RuntimeDiscovery {
  return runtimeBoundary("state-malformed", () =>
    discoverRoots(projectRoot, io),
  );
}

function discoverRoots(
  projectRoot: string,
  io: RuntimeFileSystem,
): RuntimeDiscovery {
  const root = path.resolve(projectRoot);
  assertRoot(io, root);
  const names = io.readdirSync(root);
  const diagnostics: RuntimeDiscovery["diagnostics"] = [];
  const inspect = (name: string): boolean => {
    const matches = names.filter((entry) => caseFoldComponent(entry) === name);
    if (matches.length > 1 || (matches.length === 1 && matches[0] !== name)) {
      diagnostics.push({ code: "canonical-collision", root: name });
      return false;
    }
    if (matches.length === 0) return false;
    const stat = io.lstatSync(path.join(root, name));
    if (
      stat.isSymbolicLink() ||
      path.relative(
        path.join(root, name),
        io.realpathSync(path.join(root, name)),
      ) !== ""
    ) {
      diagnostics.push({ code: "link-escape", root: name });
      return false;
    }
    if (!stat.isDirectory()) {
      diagnostics.push({ code: "state-malformed", root: name });
      return false;
    }
    return true;
  };
  const canonical = {
    root: ".pactile",
    present: inspect(".pactile"),
    access: "canonical-only",
  } as const;
  const legacy = DEFAULT_CANONICAL_PATHS_V1.legacySources.map((source) => ({
    ...source,
    present: inspect(source.root),
  }));
  return { canonical, legacy, diagnostics };
}

/** Legacy lifecycle facade: intentionally does not select .pactile until Batch 2. */
export function resolveLegacyWorkflowDirName(
  projectRoot: string,
): string | null {
  return (
    DEFAULT_CANONICAL_PATHS_V1.legacySources.find((source) =>
      fs.existsSync(path.join(projectRoot, source.root)),
    )?.root ?? null
  );
}
