import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import {
  fingerprintPactileContractV1,
  parseTileManifestV1,
  type TileManifestV1,
} from "../../core/index.js";
import {
  MAX_TILE_TEXT_BYTES,
  normalizeTileText,
  parseTileYaml,
  TileYamlError,
} from "./safe-yaml.js";

export const TILE_COMPILER_ABI_VERSION = 1 as const;
export interface TileDiagnostic {
  readonly code: string;
  readonly tileRef: string | null;
  readonly relatedRef: string | null;
  readonly path: string;
}
export type TileResult<T> =
  | { readonly success: true; readonly data: T }
  | {
      readonly success: false;
      readonly diagnostics: readonly TileDiagnostic[];
    };
export interface TileCatalogEntry {
  readonly ref: string;
  readonly manifest: TileManifestV1;
  readonly skillText: string;
  readonly fingerprint: string;
}
export interface TileTransportFile {
  readonly name: string;
  readonly text: string;
}

export function tileFingerprint(
  manifest: TileManifestV1,
  skillText: string,
): string {
  return fingerprintPactileContractV1({
    compilerAbiVersion: TILE_COMPILER_ABI_VERSION,
    manifest,
    skillText: normalizeTileText(skillText),
  });
}

/** The in-memory seam also allows deterministic filesystem fixtures on any OS. */
export function loadTileUnit(
  files: readonly TileTransportFile[],
): TileResult<TileCatalogEntry> {
  const pair = validatePair(files.map((file) => file.name));
  if (!pair.success) return pair;
  const yaml = files.find((file) => file.name === "tile.yaml");
  const skill = files.find((file) => file.name === "SKILL.md");
  if (!yaml || !skill) return failure("tile-file-missing", "$");
  if (Buffer.byteLength(skill.text, "utf8") > MAX_TILE_TEXT_BYTES)
    return failure("tile-size-limit", "SKILL.md");
  let value: unknown;
  try {
    value = parseTileYaml(yaml.text);
  } catch (error) {
    if (!(error instanceof TileYamlError)) throw error;
    return failure(error.code, `tile.yaml:${error.line}`);
  }
  const parsed = parseTileManifestV1(value);
  if (!parsed.success)
    return {
      success: false,
      diagnostics: parsed.issues.map((issue) => ({
        code: `manifest-${issue.code}`,
        tileRef: null,
        relatedRef: null,
        path: issue.path,
      })),
    };
  const manifest = parsed.data;
  const skillText = normalizeTileText(skill.text);
  return {
    success: true,
    data: {
      ref: `${manifest.identity.id}@${manifest.identity.version}`,
      manifest,
      skillText,
      fingerprint: tileFingerprint(manifest, skillText),
    },
  };
}

/** Read only the declared pair. No recursion, external assets, or file writes. */
export async function loadTileDirectory(
  directory: string,
): Promise<TileResult<TileCatalogEntry>> {
  try {
    const root = await lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink())
      return failure("tile-unsafe-file", "$");
    const names = await readdir(directory);
    const pair = validatePair(names);
    if (!pair.success) return pair;
    const files: TileTransportFile[] = [];
    for (const name of ["tile.yaml", "SKILL.md"]) {
      const filename = path.join(directory, name);
      const stat = await lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink())
        return failure("tile-unsafe-file", name);
      if (stat.size > MAX_TILE_TEXT_BYTES)
        return failure("tile-size-limit", name);
      const handle = await open(filename, "r");
      let bytes: Buffer;
      try {
        const opened = await handle.stat();
        const currentRoot = await lstat(directory);
        if (
          !opened.isFile() ||
          opened.dev !== stat.dev ||
          opened.ino !== stat.ino ||
          currentRoot.isSymbolicLink() ||
          currentRoot.dev !== root.dev ||
          currentRoot.ino !== root.ino
        )
          return failure("tile-unsafe-file", name);
        if (opened.size > MAX_TILE_TEXT_BYTES)
          return failure("tile-size-limit", name);
        // A concurrently growing file cannot make this loader allocate without bound.
        const buffer = Buffer.alloc(MAX_TILE_TEXT_BYTES + 1);
        let count = 0;
        while (count < buffer.length) {
          const read = await handle.read(
            buffer,
            count,
            buffer.length - count,
            null,
          );
          if (read.bytesRead === 0) break;
          count += read.bytesRead;
        }
        bytes = buffer.subarray(0, count);
        const after = await handle.stat();
        if (
          opened.size !== after.size ||
          opened.mtimeMs !== after.mtimeMs ||
          opened.ctimeMs !== after.ctimeMs
        )
          return failure("tile-file-changed", name);
      } finally {
        await handle.close();
      }
      if (bytes.length > MAX_TILE_TEXT_BYTES)
        return failure("tile-size-limit", name);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return failure("tile-invalid-encoding", name);
      }
      files.push({ name, text });
    }
    return loadTileUnit(files);
  } catch {
    // Never echo absolute paths or user file contents in public diagnostics.
    return failure("tile-read-failed", "$");
  }
}

function validatePair(names: readonly string[]): TileResult<null> {
  for (const required of ["tile.yaml", "SKILL.md"]) {
    const matches = names.filter(
      (name) => name.normalize("NFC").toLowerCase() === required.toLowerCase(),
    );
    if (matches.length !== 1 || matches[0] !== required)
      return failure(
        matches.length > 1 ? "tile-file-collision" : "tile-file-missing",
        required,
      );
  }
  return { success: true, data: null };
}

function failure(code: string, at: string): TileResult<never> {
  return {
    success: false,
    diagnostics: [{ code, tileRef: null, relatedRef: null, path: at }],
  };
}
