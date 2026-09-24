import { lstat } from "node:fs/promises";
import path from "node:path";
import type { ExternalAssetRefV1 } from "../../core/index.js";
import {
  buildInventory,
  parseContext,
  sanitizeCandidate,
  type DiscoveryContext,
  type InventoryResult,
} from "./inventory.js";
import {
  diagnostic,
  diagnostics,
  digest,
  fail,
  field,
  items,
  logicalId,
  type AdoptionDiagnostic,
} from "./safety.js";

interface ApprovedRoot {
  readonly path: string;
  readonly context: DiscoveryContext;
}

function absolutePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\0\r\n]/.test(value) ||
    value.startsWith("\\\\") ||
    value.startsWith("//") ||
    !path.isAbsolute(value)
  )
    fail("outside-allowlist", "roots");
  // A drive-relative root on Windows (\foo), UNC, and whole-volume roots are not grants.
  if (process.platform === "win32" && !/^[a-z]:[\\/]/i.test(value))
    fail("outside-allowlist", "roots");
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root)
    fail("outside-allowlist", "roots");
  return resolved;
}

function relativeEntry(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    /[:\0\r\n]/.test(value)
  )
    fail("outside-allowlist", "entries");
  const normalized = value.replaceAll("\\", "/").normalize("NFC");
  if (
    normalized
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.endsWith(".") ||
          part.endsWith(" "),
      )
  )
    fail("outside-allowlist", "entries");
  return normalized;
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

/** Inspect each lexical ancestor before the next lstat. Never realpath/readlink,
 * recurse, stat a link target, or open a Skill file. The caller supplies approved
 * manifest/frontmatter snapshots separately. Link metadata is advisory, not permission
 * to follow: even in-bound links stay unknown. Concurrently replaced directories
 * are not trusted input; this metadata-only port does not open or copy content.
 */
async function inspect(
  target: string,
): Promise<"present" | "missing" | "link"> {
  const volume = path.parse(target).root;
  let current = volume;
  const parts = path.relative(volume, target).split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) return "link";
      if (index < parts.length - 1 && !metadata.isDirectory())
        fail("unavailable", "entries");
      if (
        index === parts.length - 1 &&
        !metadata.isFile() &&
        !metadata.isDirectory()
      )
        fail("unavailable", "entries");
    } catch (error) {
      if (field(error, "code") === "ENOENT") return "missing";
      fail("unavailable", "entries");
    }
  }
  return "present";
}

/** Explicit roots: [{path, context}], entries: [{rootId, relativePath, metadata,
 * linkTarget?}]. `metadata` is a caller-supplied public Skill manifest/frontmatter
 * snapshot, never SKILL.md text. No roots or entries are inferred from cwd/HOME.
 * The only filesystem operation is lstat on named lexical ancestors/entries.
 */
export async function discoverSkillEntries(
  input: unknown,
): Promise<InventoryResult> {
  const assets: ExternalAssetRefV1[] = [];
  const problems: AdoptionDiagnostic[] = [];
  try {
    const roots = new Map<string, ApprovedRoot>();
    for (const value of items(field(input, "roots"))) {
      const root = {
        path: absolutePath(field(value, "path")),
        context: parseContext(field(value, "context")),
      };
      const previous = roots.get(root.context.rootId);
      if (
        previous &&
        (previous.path !== root.path ||
          JSON.stringify(previous.context) !== JSON.stringify(root.context))
      )
        fail("invalid-context", "roots");
      roots.set(root.context.rootId, root);
    }
    for (const value of items(field(input, "entries"))) {
      try {
        const root = roots.get(logicalId(field(value, "rootId")));
        if (!root) fail("outside-allowlist", "entries");
        const relative = relativeEntry(field(value, "relativePath"));
        const target = path.resolve(root.path, relative);
        if (!within(root.path, target)) fail("outside-allowlist", "entries");
        const metadata = field(value, "metadata");
        // Explicit field projection occurs before hashing or constructing diagnostics.
        // A caller's mistaken body/env/header properties are never accessed.
        const candidate = sanitizeCandidate(root.context, {
          id: field(metadata, "id"),
          kind: "skill",
          locatorToken: `entry.${digest(relative)}`,
          enabled: field(metadata, "enabled"),
          present: undefined,
          publicFingerprint: field(metadata, "publicFingerprint"),
        });
        const state = await inspect(target);
        if (state === "link") {
          const rawTarget = field(value, "linkTarget");
          if (rawTarget !== undefined) {
            const declaredTarget = absolutePath(rawTarget);
            if (
              ![...roots.values()].some((approved) =>
                within(approved.path, declaredTarget),
              )
            )
              fail("outside-allowlist", "entries");
          }
          assets.push({
            ...candidate,
            readiness: "unknown",
            fingerprint: null,
          });
          problems.push({ code: "link-not-followed", path: "entries" });
        } else {
          assets.push(
            sanitizeCandidate(root.context, {
              id: candidate.id,
              kind: "skill",
              locatorToken: `entry.${digest(relative)}`,
              enabled: field(metadata, "enabled"),
              present: state === "present",
              publicFingerprint: field(metadata, "publicFingerprint"),
            }),
          );
        }
      } catch (error) {
        problems.push(diagnostic(error, "invalid-asset", "entries"));
      }
    }
    const inventory = buildInventory(assets);
    return {
      assets: inventory.assets,
      diagnostics: diagnostics([...problems, ...inventory.diagnostics]),
    };
  } catch (error) {
    return {
      assets: [],
      diagnostics: [diagnostic(error, "invalid-input", "input")],
    };
  }
}
