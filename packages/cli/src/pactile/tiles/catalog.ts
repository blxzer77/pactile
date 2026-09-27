import {
  fingerprintPactileContractV1,
  parseTileManifestV1,
  type AssuranceLevelV1,
  type TileTriggerV1,
} from "../../core/index.js";
import {
  tileFingerprint,
  type TileCatalogEntry,
  type TileDiagnostic,
  type TileResult,
} from "./loader.js";
import { normalizeTileText } from "./safe-yaml.js";

export interface TileCatalog {
  readonly entries: readonly TileCatalogEntry[];
  readonly conflicts: readonly (readonly [string, string])[];
  readonly fingerprint: string;
}

/** Model-facing catalog view; never inject full Skill bodies during selection. */
export interface TileCatalogSummary {
  readonly ref: string;
  readonly summary: string;
  readonly trigger: TileTriggerV1;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly dependencies: readonly string[];
  readonly conflicts: readonly string[];
  readonly minimumAssurance: AssuranceLevelV1;
  readonly fingerprint: string;
}

export function describeTileCatalog(
  catalog: TileCatalog,
): readonly TileCatalogSummary[] {
  return [...catalog.entries]
    .sort((a, b) => compareTileRefs(a.ref, b.ref))
    .map(({ ref, manifest, fingerprint }) => ({
      ref,
      summary: manifest.summary,
      trigger: manifest.trigger,
      inputs: manifest.inputs,
      outputs: manifest.outputs,
      dependencies: manifest.dependencies,
      conflicts: manifest.conflicts,
      minimumAssurance: manifest.minimumAssurance,
      fingerprint,
    }));
}

export function compareTileRefs(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortTileDiagnostics(
  diagnostics: readonly TileDiagnostic[],
): TileDiagnostic[] {
  const unique = new Map(
    diagnostics.map((diagnostic) => [JSON.stringify(diagnostic), diagnostic]),
  );
  return [...unique.values()].sort((a, b) =>
    compareTileRefs(
      `${a.tileRef ?? ""}\0${a.code}\0${a.relatedRef ?? ""}\0${a.path}`,
      `${b.tileRef ?? ""}\0${b.code}\0${b.relatedRef ?? ""}\0${b.path}`,
    ),
  );
}

export function diagnostic(
  code: string,
  tileRef: string | null,
  relatedRef: string | null = null,
  at = "$",
): TileDiagnostic {
  return { code, tileRef, relatedRef, path: at };
}

/** Caller transport bound, not a change to the frozen M0 manifest schema. */
export const MAX_TILE_CALLER_REFERENCE_LENGTH = 256;

export function isCanonicalTileCallerReference(
  value: unknown,
  allowVersion: boolean,
): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TILE_CALLER_REFERENCE_LENGTH ||
    /[\\/\s]/u.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    return false;
  const parts = value.split("@");
  if (parts.length > (allowVersion ? 2 : 1)) return false;
  // M0 exports the full decoder, not its identity subdecoder. Project only its
  // identity validation so the canonical id/semver grammar has one authority.
  // The intentionally absent manifest fields are irrelevant to this narrow port.
  const parsed = parseTileManifestV1({
    identity: {
      id: parts[0],
      version: parts.length === 2 ? parts[1] : "0.0.0",
    },
  });
  return (
    parsed.success ||
    !parsed.issues.some(
      (issue) =>
        issue.path === "$.identity" || issue.path.startsWith("$.identity."),
    )
  );
}

/** No version guessing: unqualified ids must identify exactly one version. */
export function resolveTileReference(
  entries: readonly TileCatalogEntry[],
  reference: string,
): TileResult<TileCatalogEntry> {
  if (!isCanonicalTileCallerReference(reference, true))
    return {
      success: false,
      diagnostics: [
        diagnostic("tile-invalid-caller-reference", null, null, "$.reference"),
      ],
    };
  const matches = entries.filter((entry) =>
    reference.includes("@")
      ? entry.ref === reference
      : entry.manifest.identity.id === reference,
  );
  if (matches.length !== 1)
    return {
      success: false,
      diagnostics: [
        diagnostic(
          matches.length
            ? "tile-ambiguous-reference"
            : "tile-missing-reference",
          null,
          reference,
        ),
      ],
    };
  return { success: true, data: matches[0] };
}

/** Validate all declared dependency graphs; conflicts remain catalog alternatives. */
export function buildTileCatalog(
  entries: readonly TileCatalogEntry[],
  availableCapabilities?: readonly string[],
): TileResult<TileCatalog> {
  const ordered = [...entries].sort((a, b) => compareTileRefs(a.ref, b.ref));
  const diagnostics: TileDiagnostic[] = [];
  const seen = new Set<string>();
  const canonicalEntries: TileCatalogEntry[] = [];
  for (const [index, reference] of (availableCapabilities ?? []).entries()) {
    if (!isCanonicalTileCallerReference(reference, false))
      diagnostics.push(
        diagnostic(
          "tile-invalid-caller-reference",
          null,
          null,
          `$.availableCapabilities[${index}]`,
        ),
      );
  }
  for (const entry of ordered) {
    if (!isCanonicalTileCallerReference(entry.ref, true)) {
      diagnostics.push(
        diagnostic(
          "tile-invalid-caller-reference",
          null,
          null,
          "$.entries[].ref",
        ),
      );
      continue;
    }
    const parsed = parseTileManifestV1(entry.manifest);
    if (!parsed.success) {
      diagnostics.push(
        ...parsed.issues.map((issue) =>
          diagnostic(`manifest-${issue.code}`, entry.ref, null, issue.path),
        ),
      );
      continue;
    }
    if (
      entry.ref !==
        `${parsed.data.identity.id}@${parsed.data.identity.version}` ||
      entry.fingerprint !== tileFingerprint(parsed.data, entry.skillText)
    )
      diagnostics.push(diagnostic("tile-entry-mismatch", entry.ref));
    if (seen.has(entry.ref))
      diagnostics.push(diagnostic("tile-duplicate-identity", entry.ref));
    seen.add(entry.ref);
    canonicalEntries.push({
      ref: entry.ref,
      manifest: parsed.data,
      skillText: normalizeTileText(entry.skillText),
      fingerprint: entry.fingerprint,
    });
  }
  if (diagnostics.length)
    return { success: false, diagnostics: sortTileDiagnostics(diagnostics) };
  for (const entry of canonicalEntries) {
    const closure = expandTileSelection(canonicalEntries, [entry.ref]);
    if (!closure.success) diagnostics.push(...closure.diagnostics);
    else {
      diagnostics.push(...conflictDiagnostics(closure.data));
      if (availableCapabilities)
        diagnostics.push(
          ...missingCapabilityDiagnostics(closure.data, availableCapabilities),
        );
    }
  }
  if (diagnostics.length)
    return { success: false, diagnostics: sortTileDiagnostics(diagnostics) };
  const conflicts = new Map<string, readonly [string, string]>();
  for (const left of canonicalEntries)
    for (const right of canonicalEntries) {
      if (left.manifest.conflicts.includes(right.manifest.identity.id)) {
        const pair: [string, string] =
          compareTileRefs(left.ref, right.ref) < 0
            ? [left.ref, right.ref]
            : [right.ref, left.ref];
        conflicts.set(JSON.stringify(pair), pair);
      }
    }
  const symmetric = [...conflicts.values()].sort((a, b) =>
    compareTileRefs(JSON.stringify(a), JSON.stringify(b)),
  );
  return {
    success: true,
    data: {
      entries: canonicalEntries,
      conflicts: symmetric,
      fingerprint: fingerprintPactileContractV1(
        canonicalEntries.map(({ ref, fingerprint }) => ({ ref, fingerprint })),
      ),
    },
  };
}

/** Stable layered Kahn ordering: dependencies before consumers, refs within a layer. */
export function expandTileSelection(
  entries: readonly TileCatalogEntry[],
  requested: readonly string[],
): TileResult<TileCatalogEntry[]> {
  const diagnostics: TileDiagnostic[] = [];
  const selected = new Map<string, TileCatalogEntry>();
  const queue = [...requested].sort(compareTileRefs);
  const dependencies = new Map<string, Set<string>>();
  while (queue.length) {
    const reference = queue.shift();
    if (reference === undefined) break;
    const resolved = resolveTileReference(entries, reference);
    if (!resolved.success) {
      diagnostics.push(...resolved.diagnostics);
      continue;
    }
    const entry = resolved.data;
    if (selected.has(entry.ref)) continue;
    selected.set(entry.ref, entry);
    const deps = new Set<string>();
    for (const dependency of [...entry.manifest.dependencies].sort(
      compareTileRefs,
    )) {
      const dep = resolveTileReference(entries, dependency);
      if (!dep.success)
        diagnostics.push(
          diagnostic(
            dep.diagnostics[0].code === "tile-ambiguous-reference"
              ? "tile-ambiguous-dependency"
              : "tile-missing-dependency",
            entry.ref,
            dependency,
          ),
        );
      else {
        deps.add(dep.data.ref);
        queue.push(dep.data.ref);
      }
    }
    dependencies.set(entry.ref, deps);
  }
  // Selecting different versions of one Tile does not grant two distinct capabilities.
  const ids = new Set<string>();
  for (const entry of selected.values()) {
    if (ids.has(entry.manifest.identity.id))
      diagnostics.push(
        diagnostic("tile-version-conflict", null, entry.manifest.identity.id),
      );
    ids.add(entry.manifest.identity.id);
  }
  if (diagnostics.length)
    return { success: false, diagnostics: sortTileDiagnostics(diagnostics) };
  const result: TileCatalogEntry[] = [];
  while (selected.size) {
    const layer = [...selected.values()]
      .filter((entry) => dependencies.get(entry.ref)?.size === 0)
      .sort((a, b) => compareTileRefs(a.ref, b.ref));
    if (!layer.length)
      return {
        success: false,
        diagnostics: [...selected.keys()]
          .sort(compareTileRefs)
          .map((ref) => diagnostic("tile-dependency-cycle", ref)),
      };
    for (const entry of layer) {
      result.push(entry);
      selected.delete(entry.ref);
    }
    for (const deps of dependencies.values())
      for (const entry of layer) deps.delete(entry.ref);
  }
  return { success: true, data: result };
}

export function conflictDiagnostics(
  entries: readonly TileCatalogEntry[],
): TileDiagnostic[] {
  const issues: TileDiagnostic[] = [];
  for (const [index, left] of entries.entries())
    for (const right of entries.slice(index + 1)) {
      if (
        left.manifest.conflicts.includes(right.manifest.identity.id) ||
        right.manifest.conflicts.includes(left.manifest.identity.id)
      ) {
        const [a, b] = [left.ref, right.ref].sort(compareTileRefs);
        issues.push(diagnostic("tile-conflict", a, b));
      }
    }
  return issues;
}

export function missingCapabilityDiagnostics(
  entries: readonly TileCatalogEntry[],
  available: readonly string[],
): TileDiagnostic[] {
  const issues: TileDiagnostic[] = [];
  const outputs = new Map<string, Set<string>>();
  for (const entry of entries) {
    const inherited = new Set(available);
    for (const dependency of entry.manifest.dependencies)
      for (const output of outputs.get(dependency) ?? []) inherited.add(output);
    for (const input of entry.manifest.inputs)
      if (!inherited.has(input))
        issues.push(diagnostic("tile-missing-capability", entry.ref, input));
    outputs.set(
      entry.manifest.identity.id,
      new Set([...inherited, ...entry.manifest.outputs]),
    );
  }
  return issues;
}
