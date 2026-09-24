import fs from "node:fs";
import path from "node:path";
import { parseMigrationJournalV1 } from "../../core/index.js";

export interface LegacyInitContext {
  readonly importedDeveloperFilePresent: boolean;
  readonly coexistenceNotice: readonly string[];
}

function recoverableImportRoot(cwd: string): boolean {
  const canonicalRoot = path.join(cwd, ".pactile");
  try {
    const root = fs.lstatSync(canonicalRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) return false;
    const journals = path.join(canonicalRoot, "runtime", "migrations");
    const journalRoot = fs.lstatSync(journals);
    if (!journalRoot.isDirectory() || journalRoot.isSymbolicLink()) return false;
    return fs.readdirSync(journals).some((name) => {
      if (!/^lifecycle\.import\.[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*\.json$/u.test(name))
        return false;
      try {
        const target = path.join(journals, name);
        const stat = fs.lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          return false;
        const parsed = parseMigrationJournalV1(
          JSON.parse(fs.readFileSync(target, "utf8")) as unknown,
        );
        if (!parsed.success) return false;
        const id = name.slice(0, -".json".length);
        if (parsed.data.id !== id) return false;
        // A completed/rolled-back/failed import is historical evidence, not a
        // recovery lease. Re-importing over an existing canonical root must
        // require a fresh explicit ownership decision rather than any stale
        // filename left under runtime/migrations.
        return [
          "planned",
          "backed-up",
          "staged",
          "validated",
          "committed",
          "reconciling",
          "degraded",
          "recovering",
        ].includes(parsed.data.state);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Inspect legacy roots without granting write authority. The returned strings
 * are compatibility guidance only; all generation remains under `.pactile`.
 */
export function inspectLegacyInitContext(options: {
  readonly cwd: string;
  readonly canonicalRootAbsent: boolean;
  readonly importRequested: boolean;
  readonly developerFileName: string;
}): LegacyInitContext {
  const legacyCstlRoot = path.join(options.cwd, ".cstl");
  const hasLegacyCstl = fs.existsSync(legacyCstlRoot);

  if (
    options.importRequested &&
    ((!options.canonicalRootAbsent && !recoverableImportRoot(options.cwd)) ||
      !hasLegacyCstl)
  ) {
    throw new Error(
      "--import-cstl requires a readable .cstl source and either no .pactile root or a recoverable import journal",
    );
  }
  if (
    options.canonicalRootAbsent &&
    hasLegacyCstl &&
    !options.importRequested
  ) {
    throw new Error(
      "Existing .cstl detected. Re-run with --import-cstl to perform an explicit read-only legacy import.",
    );
  }

  const importedDeveloperFilePresent =
    options.importRequested &&
    fs.existsSync(path.join(legacyCstlRoot, options.developerFileName));
  const foreignRootPresent =
    options.canonicalRootAbsent &&
    fs.existsSync(path.join(options.cwd, ".trellis"));

  return {
    importedDeveloperFilePresent,
    coexistenceNotice: foreignRootPresent
      ? [
          "\n  Detected upstream `.trellis/` — coexistence mode: Pactile will use `.pactile/`",
          "  alongside `.trellis/`; the upstream tree will not be touched.\n",
          "  Upstream state is never imported without a separate explicit ownership decision.\n",
        ]
      : [],
  };
}

export function legacyImportPreparedMessage(fileCount: number): string {
  return `Prepared explicit read-only .cstl import (${fileCount} preserved file(s)); source bytes were not modified.`;
}
