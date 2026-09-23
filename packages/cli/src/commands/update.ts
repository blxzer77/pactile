import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import inquirer from "inquirer";

import {
  DIR_NAMES,
  FILE_NAMES,
  PATHS,
  isUserMiddlewareOverlayPath,
} from "../constants/paths.js";
import type { AITool } from "../types/ai-tools.js";
import { VERSION, PACKAGE_NAME } from "../constants/version.js";
import {
  getMigrationsForVersion,
  getAllMigrations,
  getMigrationMetadata,
  getConfigSectionsAddedBetween,
} from "../migrations/index.js";
import type {
  ConfigSectionAdded,
  MigrationItem,
  ClassifiedMigrations,
  MigrationResult,
  MigrationAction,
  TemplateHashes,
} from "../types/migration.js";
import {
  isWorkflowInitialized,
  resolveWorkflowDirName,
  workflowPath,
} from "../utils/workflow-dir.js";
import {
  loadHashes,
  saveHashes,
  updateHashes,
  isTemplateModified,
  removeHash,
  renameHash,
  computeHash,
} from "../utils/template-hash.js";
import { compareVersions } from "../utils/compare-versions.js";
import { toPosix } from "../utils/posix.js";
import { setupProxy } from "../utils/proxy.js";
import {
  reportUpdateReadiness,
  snapshotReadinessForRollout,
} from "../utils/readiness.js";
import {
  collectProjectCapabilityTemplates,
  loadProjectCapabilities,
} from "../utils/project-capabilities.js";
import {
  applyArtifactMigration,
  applyKernelCreate,
  planArtifactMigration,
  planWaveC,
  scanContractMigration,
  writeWaveCConfirmed,
} from "@blxzer/pactile-core/task";
import { emptyTaskJson } from "../utils/task-json.js";
import {
  applyOfficialRetire,
  composeP36Plan,
  officialWorkPending,
  planOfficialSurfaceA,
  printP36Vernacular,
  p36SummaryForRollout,
  waveCWorkPending,
  type P36UpgradePlan,
} from "../utils/p36-upgrade.js";

// Import templates for comparison
import {
  getAllScripts,
  // Configuration
  configYamlTemplate,
  gitignoreTemplate,
  workflowMdTemplate,
  executionStrategyRulesJson,
} from "../templates/pactile/index.js";
import { collectUserModuleTemplates } from "../templates/extract.js";
import { frameworkDocs } from "../templates/markdown/index.js";

import {
  ALL_MANAGED_DIRS,
  getConfiguredPlatforms,
  isManagedPath,
  isManagedRootDir,
} from "../configurators/index.js";
import { getWorkflowRootTemplateFiles } from "../configurators/workflow.js";
import { replacePythonCommandLiterals } from "../configurators/shared.js";
import { pruneOrphanManifestKeys } from "../utils/manifest-prune.js";
import { runPostUpdateSmoke } from "../utils/post-update-smoke.js";
import { cleanupRetiredAlternateClientResidue } from "../pactile/compat/retired-alternate-client.js";
import {
  buildFilePlanFromChanges,
  createBaseRolloutReport,
  emitRolloutReport,
  lifecycleResultToSummary,
  migrationResultToSummary,
  summarizeMigrationPlan,
  type UpdateReadinessSnapshot,
  type UpdateReleaseBlocker,
  type UpdateRolloutReport,
} from "../utils/update-rollout-report.js";
import {
  collectCanonicalGenerationFiles,
  discoverCanonicalGenerationPaths,
  installedPactilePlatforms,
  isCanonicalGenerationPath,
  materializeCanonicalGeneration,
  seedCanonicalBuildRoot,
  runLifecycleCommand,
  type LifecycleGenerationFile,
  type LifecycleResult,
} from "../pactile/lifecycle/index.js";
import { InstallStateStore } from "../pactile/runtime/stores.js";
import { filterReadOnlyLegacyMigrationItems } from "../pactile/compat/legacy-migrations.js";
import {
  printLegacyCursorSkillResidueNotice,
  printRetiredAlternateClientNotice,
} from "../pactile/compat/update-residue.js";
import { LEGACY_UPDATE_BLOCK_MESSAGE } from "../pactile/compat/cli-options.js";

export interface UpdateOptions {
  dryRun?: boolean;
  force?: boolean;
  skipAll?: boolean;
  createNew?: boolean;
  allowDowngrade?: boolean;
  migrate?: boolean;
  skipReadiness?: boolean;
  /** Emit a single-line JSON rollout evidence object (dry-run or apply). */
  json?: boolean;
  /** Skip post-apply Python script smoke checks (apply mode only). */
  skipPostUpdateSmoke?: boolean;
  /**
   * Maintainer / harness: after one confirm, write artifact B projections.
   * User default stays dual-read only.
   */
  writeArtifacts?: boolean;
  /** Filled on completion for `pactile rollout` aggregation. */
  lastReport?: UpdateRolloutReport;
}

interface FileChange {
  path: string;
  relativePath: string;
  newContent: string;
  status: "new" | "unchanged" | "changed";
}

interface ChangeAnalysis {
  newFiles: FileChange[];
  unchangedFiles: FileChange[];
  autoUpdateFiles: FileChange[]; // Template updated, user didn't modify
  changedFiles: FileChange[]; // User modified, needs confirmation
  userDeletedFiles: FileChange[]; // User deleted (hash exists but file missing)
  protectedPaths: string[];
}

type ConflictAction = "overwrite" | "skip" | "create-new";

// Paths that should never be touched (true user data)
// spec/ is user-customized content created during init; update should never modify it
const PROTECTED_PATHS = [
  `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.WORKSPACE}`, // workspace/
  `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.TASKS}`, // tasks/
  `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.SPEC}`, // spec/
  PATHS.MIDDLEWARE, // user overlay — never write/delete/hash
  `${DIR_NAMES.WORKFLOW}/.developer`,
  `${DIR_NAMES.WORKFLOW}/.current-task`,
];

/**
 * Check if a path is blocked by PROTECTED_PATHS
 */
function isProtectedPath(filePath: string): boolean {
  return PROTECTED_PATHS.some(
    (pp) =>
      filePath === pp || filePath.startsWith(pp.endsWith("/") ? pp : pp + "/"),
  );
}

/** Classified safe-file-delete item with reason */
interface SafeFileDeleteClassified {
  item: MigrationItem;
  action:
    | "delete"
    | "skip-missing"
    | "skip-modified"
    | "skip-protected"
    | "skip-update-skip";
}

/**
 * Collect and classify safe-file-delete migrations
 *
 * safe-file-delete auto-executes (no --migrate needed) when:
 * - File exists
 * - Content hash matches allowed_hashes
 * - Path is not protected or in update.skip
 */
function collectSafeFileDeletes(
  migrations: MigrationItem[],
  cwd: string,
  skipPaths: string[],
  /**
   * Bypass `update.skip` for safe-file-delete. Enable this for breaking releases
   * where honoring skip would leave the project half-migrated (old files at
   * protected paths sitting next to the new architecture forever). The hash
   * check in `allowed_hashes` is still the ultimate safety net — user-modified
   * files still stay put with a "skip-modified" warning.
   */
  bypassUpdateSkip = false,
): SafeFileDeleteClassified[] {
  const safeDeletes = migrations.filter((m) => m.type === "safe-file-delete");
  const results: SafeFileDeleteClassified[] = [];

  for (const item of safeDeletes) {
    const fullPath = path.join(cwd, item.from);

    // Check: file exists?
    if (!fs.existsSync(fullPath)) {
      results.push({ item, action: "skip-missing" });
      continue;
    }

    // Check: protected path? (user data dirs — always protected, never bypassed)
    if (isProtectedPath(item.from)) {
      results.push({ item, action: "skip-protected" });
      continue;
    }

    // Check: update.skip? (can be bypassed for breaking releases)
    if (
      !bypassUpdateSkip &&
      skipPaths.some(
        (skip) =>
          item.from === skip ||
          item.from.startsWith(skip.endsWith("/") ? skip : skip + "/"),
      )
    ) {
      results.push({ item, action: "skip-update-skip" });
      continue;
    }

    // Check: hash matches allowed_hashes?
    if (!item.allowed_hashes || item.allowed_hashes.length === 0) {
      // No allowed hashes defined — skip for safety
      results.push({ item, action: "skip-modified" });
      continue;
    }

    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const fileHash = computeHash(content);
      if (item.allowed_hashes.includes(fileHash)) {
        results.push({ item, action: "delete" });
      } else {
        results.push({ item, action: "skip-modified" });
      }
    } catch {
      results.push({ item, action: "skip-missing" });
    }
  }

  return results;
}

/**
 * Print safe-file-delete summary
 */
function printSafeFileDeleteSummary(
  classified: SafeFileDeleteClassified[],
): void {
  const toDelete = classified.filter((c) => c.action === "delete");
  const modified = classified.filter((c) => c.action === "skip-modified");
  const updateSkip = classified.filter((c) => c.action === "skip-update-skip");

  if (
    toDelete.length === 0 &&
    modified.length === 0 &&
    updateSkip.length === 0
  ) {
    return;
  }

  console.log(chalk.cyan("  Deprecated commands cleanup:"));

  if (toDelete.length > 0) {
    for (const c of toDelete) {
      console.log(
        chalk.green(
          `    ✕ ${c.item.from}${c.item.description ? ` (${c.item.description})` : ""}`,
        ),
      );
    }
  }

  if (modified.length > 0) {
    for (const c of modified) {
      console.log(chalk.yellow(`    ? ${c.item.from} (modified, skipped)`));
    }
  }

  if (updateSkip.length > 0) {
    for (const c of updateSkip) {
      console.log(chalk.gray(`    ○ ${c.item.from} (skipped, update.skip)`));
    }
  }

  console.log("");
}

/**
 * Execute safe-file-delete items (delete files + clean up empty dirs)
 */
function executeSafeFileDeletes(
  classified: SafeFileDeleteClassified[],
  cwd: string,
): number {
  const toDelete = classified.filter((c) => c.action === "delete");
  let deleted = 0;

  for (const c of toDelete) {
    const fullPath = path.join(cwd, c.item.from);
    try {
      // Re-check after staging. Adapter reconciliation may have touched the
      // same host path since classification; never delete bytes whose current
      // hash no longer matches the manifest allow-list.
      const current = fs.readFileSync(fullPath, "utf-8");
      if (!c.item.allowed_hashes?.includes(computeHash(current))) continue;
      fs.unlinkSync(fullPath);
      removeHash(cwd, c.item.from);
      cleanupEmptyDirs(cwd, path.dirname(c.item.from));
      deleted++;
    } catch {
      // File may have been removed between classify and execute
    }
  }

  return deleted;
}

/**
 * Load update.skip paths from the canonical config file.
 *
 * Parses simple YAML structure:
 *   update:
 *     skip:
 *       - path1
 *       - path2
 *
 * @internal Exported for testing only
 */
export function loadUpdateSkipPaths(cwd: string): string[] {
  const configPath = workflowPath(cwd, "config.yaml");
  if (!configPath || !fs.existsSync(configPath)) return [];

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const lines = content.split("\n");
    const paths: string[] = [];
    let inUpdate = false;
    let inSkip = false;

    for (const line of lines) {
      const trimmed = line.trimEnd();

      // Check for "update:" section (no indentation or at root level)
      if (/^update:\s*$/.test(trimmed)) {
        inUpdate = true;
        inSkip = false;
        continue;
      }

      // Check for "skip:" under update (indented)
      if (inUpdate && /^\s+skip:\s*$/.test(trimmed)) {
        inSkip = true;
        continue;
      }

      // Collect list items under skip
      if (inSkip) {
        const match = trimmed.match(/^\s+-\s+(.+)$/);
        if (match) {
          paths.push(match[1].trim().replace(/^['"]|['"]$/g, ""));
          continue;
        }
        // If line is non-empty and not a list item, we've left the skip section
        if (trimmed !== "" && !trimmed.startsWith("#")) {
          inSkip = false;
          inUpdate = false;
        }
      }

      // If we're in update but hit a non-indented line, we've left the update section
      if (
        inUpdate &&
        trimmed !== "" &&
        !trimmed.startsWith(" ") &&
        !trimmed.startsWith("#")
      ) {
        inUpdate = false;
        inSkip = false;
      }
    }

    return paths;
  } catch {
    // Config exists but failed to parse — warn user that skip rules won't apply
    console.warn(
      `Warning: failed to parse ${configPath}, update.skip rules will not be applied`,
    );
    return [];
  }
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function parseSkipListItemPath(line: string): string | null {
  const match = line.trimEnd().match(/^\s+-\s+(.+)$/);
  if (!match) return null;
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

/**
 * File-level `update.skip` entries that no longer protect a fork: the file on
 * disk already matches the official template (typical after a release that
 * absorbs a local dogfood patch). Directory skips are never treated as stale.
 *
 * @internal Exported for testing only
 */
export function collectStaleUpdateSkipPaths(
  cwd: string,
  skipPaths: readonly string[],
  officialTemplates: Map<string, string>,
): string[] {
  const stale: string[] = [];
  for (const skip of skipPaths) {
    if (
      !skip ||
      skip.endsWith("/") ||
      skip === `${DIR_NAMES.WORKFLOW}/config.yaml`
    ) {
      continue;
    }
    const official = officialTemplates.get(skip);
    if (official === undefined) continue;
    const fullPath = path.join(cwd, skip);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) continue;
    const disk = fs.readFileSync(fullPath, "utf-8");
    if (normalizeNewlines(disk) === normalizeNewlines(official)) {
      stale.push(skip);
    }
  }
  return stale;
}

/**
 * Drop listed paths from canonical `config.yaml` `update.skip`. If the skip list
 * becomes empty, remove `skip:` and a now-empty `update:` key. Does not touch
 * surrounding comments.
 *
 * @internal Exported for testing only
 */
export function removeUpdateSkipPathsFromConfig(
  cwd: string,
  pathsToRemove: readonly string[],
): string[] {
  if (pathsToRemove.length === 0) return [];
  const removeSet = new Set(pathsToRemove);
  const configPath = workflowPath(cwd, "config.yaml");
  if (!configPath || !fs.existsSync(configPath)) return [];

  const original = fs.readFileSync(configPath, "utf-8");
  const nl = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const keep = lines.map(() => true);
  let inUpdate = false;
  let inSkip = false;
  let updateLine = -1;
  let skipLine = -1;
  const remainingSkipItems: string[] = [];
  const removed: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimEnd();
    if (/^update:\s*$/.test(trimmed)) {
      inUpdate = true;
      inSkip = false;
      updateLine = i;
      continue;
    }
    if (inUpdate && /^\s+skip:\s*$/.test(trimmed)) {
      inSkip = true;
      skipLine = i;
      continue;
    }
    if (inSkip) {
      const itemPath = parseSkipListItemPath(lines[i]);
      if (itemPath !== null) {
        if (removeSet.has(itemPath)) {
          keep[i] = false;
          removed.push(itemPath);
        } else {
          remainingSkipItems.push(itemPath);
        }
        continue;
      }
      if (trimmed !== "" && !trimmed.startsWith("#")) {
        inSkip = false;
        inUpdate = false;
      }
    }
    if (
      inUpdate &&
      trimmed !== "" &&
      !trimmed.startsWith(" ") &&
      !trimmed.startsWith("#")
    ) {
      inUpdate = false;
      inSkip = false;
    }
  }

  if (removed.length === 0) return [];

  if (remainingSkipItems.length === 0 && skipLine >= 0) {
    keep[skipLine] = false;
  }

  if (updateLine >= 0 && remainingSkipItems.length === 0) {
    let hasOtherUpdateKey = false;
    for (let i = updateLine + 1; i < lines.length; i++) {
      if (!keep[i]) continue;
      const trimmed = lines[i].trimEnd();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      if (!trimmed.startsWith(" ") && !trimmed.startsWith("\t")) break;
      if (/^\s+\S/.test(trimmed) && !/^\s+skip:\s*$/.test(trimmed)) {
        hasOtherUpdateKey = true;
        break;
      }
    }
    if (!hasOtherUpdateKey) {
      keep[updateLine] = false;
    }
  }

  let newContent = lines.filter((_, i) => keep[i]).join(nl);
  if (original.endsWith("\n") && !newContent.endsWith("\n")) {
    newContent += original.includes("\r\n") ? "\r\n" : "\n";
  }
  if (newContent !== original) {
    fs.writeFileSync(configPath, newContent);
  }
  return removed;
}

function logStaleUpdateSkip(paths: readonly string[], dryRun: boolean): void {
  if (paths.length === 0) return;
  const prefix = dryRun
    ? "Would remove stale update.skip"
    : "Removed stale update.skip";
  console.log(
    chalk.cyan(`  ${prefix} (file already matches official template):`),
  );
  for (const skipPath of paths) {
    console.log(chalk.cyan(`    - ${skipPath}`));
  }
  console.log("");
}

/**
 * Extract a "section" from a config.yaml-style template by sectionHeading.
 *
 * A section is delimited by `#---...---` separator lines (the same pattern
 * used in the bundled `config.yaml` template). The first line inside the
 * separator block whose `# ` content matches `sectionHeading` identifies the
 * section; the section spans from that opening separator block through the
 * line preceding the next `#---` separator block (or EOF).
 *
 * Returns the extracted text including its leading separator block, or `null`
 * when no matching section is found.
 *
 * @internal Exported for testing only.
 */
export function extractConfigSection(
  template: string,
  sectionHeading: string,
): string | null {
  const lines = template.split("\n");
  const isSeparator = (line: string): boolean =>
    /^#-{3,}\s*$/.test(line.trimEnd());

  for (let i = 0; i < lines.length; i++) {
    if (!isSeparator(lines[i])) continue;
    // Look ahead for `# <heading>` then another separator that closes the
    // heading block.
    const headingLine = lines[i + 1];
    const closingSeparator = lines[i + 2];
    if (headingLine === undefined || closingSeparator === undefined) continue;
    if (!headingLine.startsWith("# ")) continue;
    if (!isSeparator(closingSeparator)) continue;
    if (headingLine.slice(2).trim() !== sectionHeading) continue;

    // Section starts at i; find the next separator block to bound it.
    let end = lines.length;
    for (let j = i + 3; j < lines.length; j++) {
      if (isSeparator(lines[j])) {
        end = j;
        break;
      }
    }
    return lines.slice(i, end).join("\n").replace(/\n+$/, "");
  }
  return null;
}

/**
 * Apply additive config.yaml sections introduced between two versions.
 *
 * Walks the supplied entries, dedupes by `file+sentinel`, and for each unique
 * entry: if the user file exists and lacks the sentinel, extracts the named
 * section from `templateContent` and appends it. Idempotent — re-running the
 * step on a file that already contains the sentinel is a no-op.
 *
 * @internal Exported for testing only.
 */
export function applyConfigSectionsAdded(
  entries: ConfigSectionAdded[],
  cwd: string,
  bundledTemplates: Map<string, string>,
): { appended: number } {
  const seen = new Set<string>();
  let appended = 0;

  for (const entry of entries) {
    const dedupeKey = `${entry.file}::${entry.sentinel}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const targetPath = path.join(cwd, entry.file);
    if (!fs.existsSync(targetPath)) continue;

    let userContent: string;
    try {
      userContent = fs.readFileSync(targetPath, "utf-8");
    } catch {
      continue;
    }
    if (userContent.includes(entry.sentinel)) continue;

    const template = bundledTemplates.get(entry.file);
    if (!template) continue;

    const section = extractConfigSection(template, entry.sectionHeading);
    if (!section) continue;

    const separator = userContent.endsWith("\n") ? "\n" : "\n\n";
    const newContent = userContent + separator + section + "\n";
    try {
      fs.writeFileSync(targetPath, newContent);
    } catch {
      continue;
    }
    console.log(
      chalk.green(
        `  + Added config section "${entry.sectionHeading}" to ${entry.file}`,
      ),
    );
    appended++;
  }

  return { appended };
}

/**
 * Collect all template files that should be managed by update.
 * Only collects templates for platforms that are already configured (have directories).
 * Exported so tests can assert the hash set includes canonical modules and
 * never user middleware.
 */
export function collectTemplateFiles(
  cwd: string,
  /**
   * Bypass `update.skip` when collecting templates. Enable this for breaking
   * releases so new files (e.g. `continue.md` added in 0.5.0) and template
   * updates can land even under skip-protected paths. Without this, users with
   * `.cursor/commands/` in their skip list would silently miss new commands.
   * Existing user customizations are still guarded at WRITE time via the
   * "Modified by you" conflict prompt — they can skip per-file there.
   */
  bypassUpdateSkip = false,
): Map<string, string> {
  const files = new Map<string, string>();
  // Python scripts (single source of truth: getAllScripts())
  for (const [scriptPath, content] of getAllScripts()) {
    files.set(`${PATHS.SCRIPTS}/${scriptPath}`, content);
  }

  // P29 short contracts (index.json + <id>/contract.md). Not scripts.
  for (const [modulePath, content] of collectUserModuleTemplates()) {
    files.set(`${PATHS.MODULES}/${modulePath}`, content);
  }

  // Configuration
  files.set(`${DIR_NAMES.WORKFLOW}/config.yaml`, configYamlTemplate);
  files.set(
    `${DIR_NAMES.WORKFLOW}/config/execution-strategy-rules.json`,
    executionStrategyRulesJson,
  );
  files.set(`${DIR_NAMES.WORKFLOW}/.gitignore`, gitignoreTemplate);
  // Retired alternate-client files are handled only by the explicit
  // compatibility residue cleaner and are never refreshed or injected.
  // workflow.md is included here because it is runtime-parsed by
  // get_context.py and shared hooks. Keep it on the normal template update
  // path: if the installed file still matches the tracked hash, update the
  // whole file. If the user edited it, the standard modified-file prompt /
  // --force behavior applies. Partial tag-block merging is unsafe because
  // platform routing markers outside [workflow-state:*] blocks are also
  // script-consumed.
  files.set(`${DIR_NAMES.WORKFLOW}/workflow.md`, workflowMdTemplate);
  // Framework docs are framework-owned and refreshed by update.
  // New files flow through the standard new/auto-update/hash-conflict
  // analysis; canonical spec content stays fully protected.
  for (const doc of frameworkDocs) {
    files.set(`${PATHS.FRAMEWORK}/${doc.name}`, doc.content);
  }
  // Project domain glossary stub + ADR rules (user-maintained; conflict
  // handling works the same as workflow.md — modified files prompt first).
  for (const [relativePath, content] of getWorkflowRootTemplateFiles()) {
    files.set(relativePath, content);
  }
  // workspace/index.md stays excluded — it's runtime-appended by add_session.py
  // (journal index) and has no script-parsed structure.
  for (const [filePath, content] of collectProjectCapabilityTemplates(
    cwd,
    [],
  )) {
    files.set(filePath, content);
  }

  // Apply update.skip from config.yaml (unless bypassed for breaking release)
  if (!bypassUpdateSkip) {
    const skipPaths = loadUpdateSkipPaths(cwd);
    if (skipPaths.length > 0) {
      for (const [filePath] of [...files]) {
        if (
          skipPaths.some(
            (skip) =>
              filePath === skip ||
              filePath.startsWith(skip.endsWith("/") ? skip : skip + "/"),
          )
        ) {
          files.delete(filePath);
        }
      }
    }
  }

  // Apply python3→python replacement for Windows consistency with init-time writes
  for (const [filePath, content] of files) {
    files.set(filePath, replacePythonCommandLiterals(content));
  }

  // User overlay is never a template — strip even if a future collector
  // accidentally adds it. Retired alternate-client cleanup is a separate allow-list
  // and must not target this directory.
  for (const [filePath] of [...files]) {
    if (isUserMiddlewareOverlayPath(filePath)) {
      files.delete(filePath);
    }
  }

  return files;
}

/**
 * Analyze changes between current files and templates
 *
 * Uses hash tracking to distinguish between:
 * - User didn't modify + template same = skip (unchangedFiles)
 * - User didn't modify + template updated = auto-update (autoUpdateFiles)
 * - User modified = needs confirmation (changedFiles)
 */
function analyzeChanges(
  cwd: string,
  hashes: TemplateHashes,
  templates: Map<string, string>,
): ChangeAnalysis {
  const result: ChangeAnalysis = {
    newFiles: [],
    unchangedFiles: [],
    autoUpdateFiles: [],
    changedFiles: [],
    userDeletedFiles: [],
    protectedPaths: PROTECTED_PATHS,
  };

  for (const [relativePath, newContent] of templates) {
    const fullPath = path.join(cwd, relativePath);
    const exists = fs.existsSync(fullPath);

    const change: FileChange = {
      path: fullPath,
      relativePath,
      newContent,
      status: "new",
    };

    if (!exists) {
      const storedHash = hashes[relativePath];
      if (storedHash) {
        // Previously installed but user deleted — respect deletion
        result.userDeletedFiles.push(change);
      } else {
        change.status = "new";
        result.newFiles.push(change);
      }
    } else {
      const existingContent = fs.readFileSync(fullPath, "utf-8");
      if (existingContent === newContent) {
        // Content same as template - already up to date
        change.status = "unchanged";
        result.unchangedFiles.push(change);
      } else {
        // Content differs - check if user modified or template updated
        const storedHash = hashes[relativePath];
        const currentHash = computeHash(existingContent);

        if (storedHash && storedHash === currentHash) {
          // Either the tracked hash matches, or this is a known pristine template
          // from before the path was hash-tracked. Safe to auto-update.
          change.status = "changed";
          result.autoUpdateFiles.push(change);
        } else {
          // Hash differs (or no stored hash) - user modified the file
          // Needs confirmation
          change.status = "changed";
          result.changedFiles.push(change);
        }
      }
    }
  }

  return result;
}

/**
 * Unchanged templates with no stored hash (canary hand-copy, first hash
 * tracking, or a newly shipped canonical module path). Record the
 * hash so the next real template edit auto-updates instead of prompting
 * "Modified by you" or listing the path as new.
 */
export function collectMissingTemplateHashes(
  changes: Pick<ChangeAnalysis, "unchangedFiles">,
  hashes: TemplateHashes,
): Map<string, string> {
  const files = new Map<string, string>();

  for (const file of changes.unchangedFiles) {
    if (isUserMiddlewareOverlayPath(file.relativePath)) {
      continue;
    }
    if (!hashes[file.relativePath]) {
      files.set(file.relativePath, file.newContent);
    }
  }

  return files;
}

/**
 * Print change summary
 */
function printChangeSummary(changes: ChangeAnalysis): void {
  console.log("\nScanning for changes...\n");

  if (changes.newFiles.length > 0) {
    console.log(chalk.green("  New files (will add):"));
    for (const file of changes.newFiles) {
      console.log(chalk.green(`    + ${file.relativePath}`));
    }
    console.log("");
  }

  if (changes.autoUpdateFiles.length > 0) {
    console.log(chalk.cyan("  Template updated (will auto-update):"));
    for (const file of changes.autoUpdateFiles) {
      console.log(chalk.cyan(`    ↑ ${file.relativePath}`));
    }
    console.log("");
  }

  if (changes.unchangedFiles.length > 0) {
    console.log(chalk.gray("  Unchanged files (will skip):"));
    for (const file of changes.unchangedFiles.slice(0, 5)) {
      console.log(chalk.gray(`    ○ ${file.relativePath}`));
    }
    if (changes.unchangedFiles.length > 5) {
      console.log(
        chalk.gray(`    ... and ${changes.unchangedFiles.length - 5} more`),
      );
    }
    console.log("");
  }

  if (changes.changedFiles.length > 0) {
    console.log(chalk.yellow("  Modified by you (need your decision):"));
    for (const file of changes.changedFiles) {
      console.log(chalk.yellow(`    ? ${file.relativePath}`));
    }
    console.log("");
  }

  if (changes.userDeletedFiles.length > 0) {
    console.log(chalk.gray("  Deleted by you (preserved):"));
    for (const file of changes.userDeletedFiles) {
      console.log(chalk.gray(`    \u2715 ${file.relativePath}`));
    }
    console.log("");
  }

  // Only show protected paths that actually exist
  const existingProtectedPaths = changes.protectedPaths.filter((p) => {
    const fullPath = path.join(process.cwd(), p);
    return fs.existsSync(fullPath);
  });

  if (existingProtectedPaths.length > 0) {
    console.log(chalk.gray("  User data (preserved):"));
    for (const protectedPath of existingProtectedPaths) {
      console.log(chalk.gray(`    ○ ${protectedPath}/`));
    }
    console.log("");
  }
}

/**
 * Prompt user for conflict resolution
 */
async function promptConflictResolution(
  file: FileChange,
  options: UpdateOptions,
  applyToAll: { action: ConflictAction | null },
): Promise<ConflictAction> {
  // If we have a batch action, use it
  if (applyToAll.action) {
    return applyToAll.action;
  }

  // Check command-line options
  if (options.force) {
    return "overwrite";
  }
  if (options.skipAll) {
    return "skip";
  }
  if (options.createNew) {
    return "create-new";
  }

  // Interactive prompt
  const { action } = await inquirer.prompt<{ action: string }>([
    {
      type: "list",
      name: "action",
      message: `${file.relativePath} has changes.`,
      choices: [
        {
          name: "[1] Overwrite - Replace with new version",
          value: "overwrite",
        },
        { name: "[2] Skip - Keep your current version", value: "skip" },
        {
          name: "[3] Create copy - Save new version as .new",
          value: "create-new",
        },
        { name: "[a] Apply Overwrite to all", value: "overwrite-all" },
        { name: "[s] Apply Skip to all", value: "skip-all" },
        { name: "[n] Apply Create copy to all", value: "create-new-all" },
      ],
      default: "skip",
    },
  ]);

  if (action === "overwrite-all") {
    applyToAll.action = "overwrite";
    return "overwrite";
  }
  if (action === "skip-all") {
    applyToAll.action = "skip";
    return "skip";
  }
  if (action === "create-new-all") {
    applyToAll.action = "create-new";
    return "create-new";
  }

  return action as ConflictAction;
}

/**
 * Create a timestamped backup directory path
 */
function createBackupDirPath(cwd: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const workflowRoot =
    workflowPath(cwd, `.backup-${timestamp}`) ??
    path.join(cwd, DIR_NAMES.WORKFLOW, `.backup-${timestamp}`);
  return workflowRoot;
}

/**
 * Backup a single file to the backup directory
 */
function backupFile(
  cwd: string,
  backupDir: string,
  relativePath: string,
): void {
  const srcPath = path.join(cwd, relativePath);
  if (!fs.existsSync(srcPath)) return;

  const backupPath = path.join(backupDir, relativePath);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.copyFileSync(srcPath, backupPath);
}

/**
 * Directories to backup as complete snapshot (derived from platform registry)
 */
const BACKUP_DIRS = ALL_MANAGED_DIRS;

/** Root-level managed files to include in update backups. */
const BACKUP_FILES = [FILE_NAMES.AGENTS] as const;

/**
 * Patterns to exclude from backup (user data that shouldn't be backed up)
 */
const BACKUP_EXCLUDE_PATTERNS = [
  ".backup-", // Previous backups
  "/node_modules", // Installed dependencies; restore via package manager
  "/workspace/", // Developer workspace (user data)
  "/tasks/", // Task data (user data)
  "/spec/", // Spec files (user-customized content)
  "/middleware/", // User middleware overlay (never managed)
  "/backlog/", // Backlog data (user data)
  "/agent-traces/", // Agent traces (user data, legacy name)
  // Platform-native worktree dirs — these are full sub-repos the CLI
  // spawns for parallel sessions. Backing them up on every update would
  // snapshot the entire nested working tree. Confirmed convention:
  //   Cursor CLI:  .cursor/worktrees/
  // Matches any platform using the same convention (future-proof).
  "/worktrees/",
  "/worktree/",
];

/**
 * Check if a path should be excluded from backup
 * @internal Exported for testing only
 */
export function shouldExcludeFromBackup(relativePath: string): boolean {
  // Normalize Windows backslashes to forward slashes so patterns like
  // "/worktrees/" / "/tasks/" match regardless of host OS. Without this,
  // Windows `path.relative` returns `.cursor\worktrees\...` and none of
  // the slash-prefixed exclude patterns trigger — which causes
  // `collectAllFiles` to descend into platform worktrees (full nested
  // project copies) and explode the scan. Same normalization pattern
  // used by `isManagedPath` in configurators/index.ts.
  const normalized = relativePath.replace(/\\/g, "/");
  for (const pattern of BACKUP_EXCLUDE_PATTERNS) {
    if (normalized.includes(pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Create complete snapshot backup of all managed directories
 * Backs up all managed platform/workflow directories entirely
 * (excluding user data like workspace/, tasks/, backlog/)
 */
function createFullBackup(cwd: string): string | null {
  const backupDir = createBackupDirPath(cwd);
  let hasFiles = false;

  for (const dir of BACKUP_DIRS) {
    const dirPath = path.join(cwd, dir);
    if (!fs.existsSync(dirPath)) continue;

    const files = collectAllFiles(dirPath, cwd);
    for (const fullPath of files) {
      const relativePath = path.relative(cwd, fullPath);

      // Skip excluded paths
      if (shouldExcludeFromBackup(relativePath)) continue;

      // Create backup
      if (!hasFiles) {
        fs.mkdirSync(backupDir, { recursive: true });
        hasFiles = true;
      }
      backupFile(cwd, backupDir, relativePath);
    }
  }

  for (const relativePath of BACKUP_FILES) {
    const fullPath = path.join(cwd, relativePath);
    if (!fs.existsSync(fullPath)) continue;
    if (shouldExcludeFromBackup(relativePath)) continue;

    if (!hasFiles) {
      fs.mkdirSync(backupDir, { recursive: true });
      hasFiles = true;
    }
    backupFile(cwd, backupDir, relativePath);
  }

  return hasFiles ? backupDir : null;
}

/**
 * Update version file
 */
function updateVersionFile(cwd: string): void {
  const dirName = resolveWorkflowDirName(cwd) ?? DIR_NAMES.WORKFLOW;
  const versionPath = path.join(cwd, dirName, ".version");
  fs.writeFileSync(versionPath, VERSION);
}

/**
 * Get current installed version
 */
function getInstalledVersion(cwd: string): string {
  const versionPath = workflowPath(cwd, ".version");
  if (versionPath && fs.existsSync(versionPath)) {
    return fs.readFileSync(versionPath, "utf-8").trim();
  }
  return "unknown";
}

/**
 * Fetch latest version from npm registry
 */
async function getLatestNpmVersion(): Promise<string | null> {
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
    );
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Recursively collect all files in a directory
 */
function collectAllFiles(dirPath: string, cwd = process.cwd()): string[] {
  if (!fs.existsSync(dirPath)) return [];

  const files: string[] = [];
  const stack = [dirPath];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) continue;

    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(cwd, fullPath);

      // Never follow symlinks / Windows directory junctions — a junction
      // pointing at an ancestor would loop the scan forever. Node's
      // `isSymbolicLink()` returns true for NTFS junctions since v12.
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (!shouldExcludeFromBackup(relativePath)) {
          stack.push(fullPath);
        }
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

/**
 * Check if a directory only contains unmodified template files
 * Returns true if safe to delete:
 * - All files are tracked and unmodified, OR
 * - All files match current template content (even if not tracked)
 */
function isDirectorySafeToReplace(
  cwd: string,
  dirRelativePath: string,
  hashes: TemplateHashes,
  templates: Map<string, string>,
): boolean {
  const dirFullPath = path.join(cwd, dirRelativePath);
  if (!fs.existsSync(dirFullPath)) return true;

  const files = collectAllFiles(dirFullPath, cwd);
  if (files.length === 0) return true; // Empty directory is safe

  for (const fullPath of files) {
    // POSIX-normalize: hashes/templates keys are persisted as POSIX, but
    // `path.relative` returns OS-native separators (backslash on Windows).
    const relativePath = toPosix(path.relative(cwd, fullPath));
    const storedHash = hashes[relativePath];
    const templateContent = templates.get(relativePath);

    // Check if file matches template content (handles untracked files)
    if (templateContent) {
      const currentContent = fs.readFileSync(fullPath, "utf-8");
      if (currentContent === templateContent) {
        // File matches template - safe
        continue;
      }
    }

    // Check if file is tracked and unmodified
    if (storedHash && !isTemplateModified(cwd, relativePath, hashes)) {
      // Tracked and unmodified - safe
      continue;
    }

    // File is either user-created or user-modified - not safe
    return false;
  }

  return true;
}

/**
 * Recursively delete a directory
 */
function removeDirectoryRecursive(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return;
  fs.rmSync(dirPath, { recursive: true, force: true });
}

/**
 * Check if a file is safe to overwrite (matches template content)
 */
function isFileSafeToReplace(
  cwd: string,
  relativePath: string,
  templates: Map<string, string>,
): boolean {
  const fullPath = path.join(cwd, relativePath);
  if (!fs.existsSync(fullPath)) return true;

  const templateContent = templates.get(relativePath);
  if (!templateContent) return false; // Not a template file

  const currentContent = fs.readFileSync(fullPath, "utf-8");
  return currentContent === templateContent;
}

/**
 * Classify migrations based on file state and user modifications
 */
function classifyMigrations(
  migrations: MigrationItem[],
  cwd: string,
  hashes: TemplateHashes,
  templates: Map<string, string>,
): ClassifiedMigrations {
  const result: ClassifiedMigrations = {
    auto: [],
    confirm: [],
    conflict: [],
    skip: [],
  };

  for (const item of migrations) {
    // safe-file-delete handled separately (not via --migrate)
    if (item.type === "safe-file-delete") continue;

    // Enforce PROTECTED_PATHS — never migrate FROM protected paths (prevents moving/deleting user data)
    if (isProtectedPath(item.from)) {
      result.skip.push(item);
      continue;
    }
    // For non-rename types, also block writing TO protected paths
    // Historical rename operations may target paths now protected as user data.
    if (
      item.to &&
      isProtectedPath(item.to) &&
      item.type !== "rename" &&
      item.type !== "rename-dir"
    ) {
      result.skip.push(item);
      continue;
    }

    const oldPath = path.join(cwd, item.from);
    const oldExists = fs.existsSync(oldPath);

    if (!oldExists) {
      // Old file doesn't exist, nothing to migrate
      result.skip.push(item);
      continue;
    }

    if (item.type === "rename" && item.to) {
      const newPath = path.join(cwd, item.to);
      const newExists = fs.existsSync(newPath);

      if (newExists) {
        // Both exist - check if new file matches template (safe to overwrite)
        if (isFileSafeToReplace(cwd, item.to, templates)) {
          // New file is just template content - safe to delete and rename
          result.auto.push(item);
        } else {
          // New file has user content - conflict
          result.conflict.push(item);
        }
      } else if (isTemplateModified(cwd, item.from, hashes)) {
        // User has modified the file - needs confirmation
        result.confirm.push(item);
      } else {
        // Unmodified template - safe to auto-migrate
        result.auto.push(item);
      }
    } else if (item.type === "rename-dir" && item.to) {
      const newPath = path.join(cwd, item.to);
      const newExists = fs.existsSync(newPath);

      if (newExists) {
        // Target exists - check if it only contains unmodified template files
        if (isDirectorySafeToReplace(cwd, item.to, hashes, templates)) {
          // Safe to delete target and rename source
          result.auto.push(item);
        } else {
          // Target has user modifications - conflict
          result.conflict.push(item);
        }
      } else {
        // Directory rename - always auto (includes user files)
        result.auto.push(item);
      }
    } else if (item.type === "delete") {
      if (isTemplateModified(cwd, item.from, hashes)) {
        // User has modified - needs confirmation before delete
        result.confirm.push(item);
      } else {
        // Unmodified - safe to auto-delete
        result.auto.push(item);
      }
    }
  }

  return result;
}

/**
 * Print migration summary
 */
function printMigrationSummary(classified: ClassifiedMigrations): void {
  const total =
    classified.auto.length +
    classified.confirm.length +
    classified.conflict.length +
    classified.skip.length;

  if (total === 0) {
    console.log(chalk.gray("  No migrations to apply.\n"));
    return;
  }

  if (classified.auto.length > 0) {
    console.log(chalk.green("  ✓ Auto-migrate (unmodified):"));
    for (const item of classified.auto) {
      if (item.type === "rename") {
        console.log(chalk.green(`    ${item.from} → ${item.to}`));
      } else if (item.type === "rename-dir") {
        console.log(chalk.green(`    [dir] ${item.from}/ → ${item.to}/`));
      } else {
        console.log(chalk.green(`    ✕ ${item.from}`));
      }
    }
    console.log("");
  }

  if (classified.confirm.length > 0) {
    console.log(chalk.yellow("  ⚠ Requires confirmation (modified by user):"));
    for (const item of classified.confirm) {
      if (item.type === "rename") {
        console.log(chalk.yellow(`    ${item.from} → ${item.to}`));
      } else {
        console.log(chalk.yellow(`    ✕ ${item.from}`));
      }
    }
    console.log("");
  }

  if (classified.conflict.length > 0) {
    console.log(chalk.red("  ⊘ Conflict (both old and new exist):"));
    for (const item of classified.conflict) {
      if (item.type === "rename-dir") {
        console.log(chalk.red(`    [dir] ${item.from}/ ↔ ${item.to}/`));
      } else {
        console.log(chalk.red(`    ${item.from} ↔ ${item.to}`));
      }
    }
    console.log(
      chalk.gray(
        "    → Resolve manually: merge or delete one, then re-run update",
      ),
    );
    console.log("");
  }

  if (classified.skip.length > 0) {
    console.log(chalk.gray("  ○ Skipping (old file not found):"));
    for (const item of classified.skip.slice(0, 3)) {
      console.log(chalk.gray(`    ${item.from}`));
    }
    if (classified.skip.length > 3) {
      console.log(chalk.gray(`    ... and ${classified.skip.length - 3} more`));
    }
    console.log("");
  }
}

/**
 * Prompt user for migration action on a single item.
 *
 * Design notes:
 * - Default is `backup-rename`: safest — preserves user's content as a .backup
 *   alongside the rename, so Enter-to-continue never destroys work or leaves
 *   stale paths behind.
 * - "Skip" leaves a stale old path that won't be cleaned by later updates —
 *   warn explicitly so users understand the consequence.
 * - Show manifest description + why-flagged so users can make an informed
 *   choice without needing to dig through the diff.
 */
async function promptMigrationAction(
  item: MigrationItem,
): Promise<MigrationAction> {
  const headline =
    item.type === "rename"
      ? `${chalk.cyan(item.from)} → ${chalk.green(item.to)}`
      : `${chalk.red("Delete")} ${chalk.cyan(item.from)}`;

  const description =
    item.description ?? "No description provided in manifest.";

  // Actions with inline guidance so users see the trade-off per choice.
  const renameLabel =
    item.type === "rename"
      ? "[r] Rename anyway — use if the file is unchanged, or any edits are fine to move as-is"
      : "[d] Delete anyway — use if you don't need this file (already migrated to replacement)";
  const backupLabel =
    item.type === "rename"
      ? "[b] Backup original, then proceed — SAFEST: writes <new-path>.backup with your current content, then renames"
      : "[b] Backup original, then proceed — SAFEST: writes <path>.backup with your current content, then deletes";
  const skipLabel =
    item.type === "rename"
      ? "[s] Skip — leaves the old path in place (you'll see it flagged on future updates until cleaned up manually)"
      : "[s] Skip — keeps the deprecated file (you'll see it flagged on future updates until cleaned up manually)";

  // Prefer the per-migration `reason` (version-specific context authored in the
  // manifest) over a generic fallback. Hardcoding version-specific hints here
  // rots fast — every release gets a new set of edge cases.
  const whyFlagged = item.reason
    ? chalk.gray(
        item.reason
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n"),
      )
    : chalk.gray(
        `  Why prompted: file content doesn't match the Pactile template hash\n` +
          `  for this path — usually local customization. If unsure, pick [b].`,
      );

  const message = [
    headline,
    "",
    chalk.bold("  What:") + " " + description,
    whyFlagged,
    "",
    chalk.bold("  Choose:"),
  ].join("\n");

  const { choice } = await inquirer.prompt<{ choice: MigrationAction }>([
    {
      type: "list",
      name: "choice",
      message,
      choices: [
        { name: backupLabel, value: "backup-rename" as MigrationAction },
        { name: renameLabel, value: "rename" as MigrationAction },
        { name: skipLabel, value: "skip" as MigrationAction },
      ],
      default: "backup-rename",
    },
  ]);

  return choice;
}

/**
 * Clean up empty directories after file migration
 * Recursively remove empty parent directories up to the managed root.
 */
/** @internal Exported for testing only */
export function cleanupEmptyDirs(cwd: string, dirPath: string): void {
  const fullPath = path.join(cwd, dirPath);

  // Safety: don't delete outside of managed directories
  if (!isManagedPath(dirPath)) {
    return;
  }

  // Safety: never delete managed root directories themselves.
  if (isManagedRootDir(dirPath)) {
    return;
  }

  // Check if directory exists and is empty
  if (!fs.existsSync(fullPath)) return;

  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isDirectory()) return;

    const contents = fs.readdirSync(fullPath);
    if (contents.length === 0) {
      fs.rmdirSync(fullPath);
      // Recursively check parent (but stop at root directories)
      const parent = path.dirname(dirPath);
      if (parent !== "." && parent !== dirPath && !isManagedRootDir(parent)) {
        cleanupEmptyDirs(cwd, parent);
      }
    }
  } catch {
    // Ignore errors (permission issues, etc.)
  }
}

/**
 * Sort migrations for safe execution order
 * - rename-dir with deeper paths first (to handle nested directories)
 * - rename-dir before rename/delete
 */
/** @internal Exported for testing only */
export function sortMigrationsForExecution(
  migrations: MigrationItem[],
): MigrationItem[] {
  return [...migrations].sort((a, b) => {
    // rename-dir should be sorted by path depth (deeper first)
    if (a.type === "rename-dir" && b.type === "rename-dir") {
      const aDepth = a.from.split("/").length;
      const bDepth = b.from.split("/").length;
      return bDepth - aDepth; // Deeper paths first
    }
    // rename-dir before rename/delete (directories first)
    if (a.type === "rename-dir" && b.type !== "rename-dir") return -1;
    if (a.type !== "rename-dir" && b.type === "rename-dir") return 1;
    return 0;
  });
}

/**
 * Execute classified migrations
 *
 * @param options.force - Force migrate modified files without asking
 * @param options.skipAll - Skip all modified files without asking
 * If neither is set, prompts interactively for modified files
 */
async function executeMigrations(
  classified: ClassifiedMigrations,
  cwd: string,
  options: { force?: boolean; skipAll?: boolean },
): Promise<MigrationResult> {
  const result: MigrationResult = {
    renamed: 0,
    deleted: 0,
    skipped: 0,
    conflicts: classified.conflict.length,
  };

  // Sort migrations for safe execution order
  const sortedAuto = sortMigrationsForExecution(classified.auto);

  // 1. Execute auto migrations (unmodified files and directories)
  for (const item of sortedAuto) {
    if (item.type === "rename" && item.to) {
      const oldPath = path.join(cwd, item.from);
      const newPath = path.join(cwd, item.to);

      // Ensure target directory exists
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      fs.renameSync(oldPath, newPath);

      // Update hash tracking
      renameHash(cwd, item.from, item.to);

      // Make executable if it's a script
      if (item.to.endsWith(".sh") || item.to.endsWith(".py")) {
        fs.chmodSync(newPath, "755");
      }

      // Clean up empty source directory
      cleanupEmptyDirs(cwd, path.dirname(item.from));

      result.renamed++;
    } else if (item.type === "rename-dir" && item.to) {
      const oldPath = path.join(cwd, item.from);
      const newPath = path.join(cwd, item.to);

      // If target exists (safe to replace, already checked in classification)
      // delete it first before renaming
      if (fs.existsSync(newPath)) {
        removeDirectoryRecursive(newPath);
      }

      // Ensure parent directory exists
      fs.mkdirSync(path.dirname(newPath), { recursive: true });

      // Rename the entire directory (includes all user files)
      fs.renameSync(oldPath, newPath);

      // Batch update hash tracking for all files in the directory
      const hashes = loadHashes(cwd);
      const oldPrefix = item.from.endsWith("/") ? item.from : item.from + "/";
      const newPrefix = item.to.endsWith("/") ? item.to : item.to + "/";

      const updatedHashes: TemplateHashes = {};
      for (const [hashPath, hashValue] of Object.entries(hashes)) {
        if (hashPath.startsWith(oldPrefix)) {
          // Rename path: old prefix -> new prefix
          const newHashPath = newPrefix + hashPath.slice(oldPrefix.length);
          updatedHashes[newHashPath] = hashValue;
        } else if (hashPath.startsWith(newPrefix)) {
          // Skip old hashes from deleted target directory
          // (they will be replaced by renamed source files)
          continue;
        } else {
          // Keep unchanged
          updatedHashes[hashPath] = hashValue;
        }
      }
      saveHashes(cwd, updatedHashes);

      result.renamed++;
    } else if (item.type === "delete") {
      const filePath = path.join(cwd, item.from);
      fs.unlinkSync(filePath);

      // Remove from hash tracking
      removeHash(cwd, item.from);

      // Clean up empty directory
      cleanupEmptyDirs(cwd, path.dirname(item.from));

      result.deleted++;
    }
  }

  // 2. Handle confirm items (modified files)
  // Note: All files are already backed up by createMigrationBackup before execution
  for (const item of classified.confirm) {
    let action: MigrationAction;

    if (options.force) {
      // Force mode: proceed (already backed up)
      action = "rename";
    } else if (options.skipAll) {
      // Skip mode: skip all modified files
      action = "skip";
    } else {
      // Default: interactive prompt
      action = await promptMigrationAction(item);
    }

    if (action === "skip") {
      result.skipped++;
      continue;
    }

    // For `backup-rename`, leave an inline .backup copy of the user's modified
    // original next to the new location (for rename) or in place (for delete).
    // This is in addition to the full canonical project snapshot backup.
    // the inline copy is more discoverable when the user wants to diff or merge
    // their customizations against the new template.
    if (item.type === "rename" && item.to) {
      const oldPath = path.join(cwd, item.from);
      const newPath = path.join(cwd, item.to);

      fs.mkdirSync(path.dirname(newPath), { recursive: true });

      if (action === "backup-rename") {
        // Copy original alongside the new path before the rename overwrites nothing
        // (target dir is guaranteed fresh since `conflict` is handled elsewhere).
        fs.copyFileSync(oldPath, newPath + ".backup");
      }

      fs.renameSync(oldPath, newPath);
      renameHash(cwd, item.from, item.to);

      if (item.to.endsWith(".sh") || item.to.endsWith(".py")) {
        fs.chmodSync(newPath, "755");
      }

      // Clean up empty source directory
      cleanupEmptyDirs(cwd, path.dirname(item.from));

      result.renamed++;
    } else if (item.type === "delete") {
      const filePath = path.join(cwd, item.from);

      if (action === "backup-rename") {
        // Keep a .backup copy in place before deletion so the user can recover
        // inline without digging through the full snapshot backup.
        fs.copyFileSync(filePath, filePath + ".backup");
      }

      fs.unlinkSync(filePath);
      removeHash(cwd, item.from);

      // Clean up empty directory
      cleanupEmptyDirs(cwd, path.dirname(item.from));

      result.deleted++;
    }
  }

  // 3. Skip count already tracked (old files not found)
  result.skipped += classified.skip.length;

  return result;
}

/**
 * Print migration result summary
 */
function printMigrationResult(result: MigrationResult): void {
  const parts: string[] = [];

  if (result.renamed > 0) {
    parts.push(`${result.renamed} renamed`);
  }
  if (result.deleted > 0) {
    parts.push(`${result.deleted} deleted`);
  }
  if (result.skipped > 0) {
    parts.push(`${result.skipped} skipped`);
  }
  if (result.conflicts > 0) {
    parts.push(
      `${result.conflicts} conflict${result.conflicts > 1 ? "s" : ""}`,
    );
  }

  if (parts.length > 0) {
    console.log(chalk.cyan(`Migration complete: ${parts.join(", ")}`));
  }
}

function rolloutOptionsFromUpdate(
  options: UpdateOptions,
): UpdateRolloutReport["options"] {
  return {
    dryRun: Boolean(options.dryRun),
    force: Boolean(options.force),
    skipAll: Boolean(options.skipAll),
    createNew: Boolean(options.createNew),
    migrate: Boolean(options.migrate),
    allowDowngrade: Boolean(options.allowDowngrade),
    skipReadiness: Boolean(options.skipReadiness),
    writeArtifacts: Boolean(options.writeArtifacts),
  };
}

function upgradeDirectionFromCompare(
  cliVsProject: number,
  projectVersion: string,
): UpdateRolloutReport["plan"]["upgradeDirection"] {
  if (projectVersion === "unknown") return "unknown";
  if (cliVsProject > 0) return "upgrade";
  if (cliVsProject < 0) return "downgrade";
  return "same";
}

function releaseBlockersFromReadiness(
  readiness: UpdateReadinessSnapshot,
  cliBehindNpm: boolean,
  cliVersion: string,
  latestNpmVersion: string | null,
): UpdateReleaseBlocker[] {
  const blockers: UpdateReleaseBlocker[] = [];
  if (cliBehindNpm && latestNpmVersion) {
    blockers.push({
      code: "cli_behind_npm",
      message: `CLI ${cliVersion} is behind npm ${latestNpmVersion}`,
      recovery: ["pactile upgrade"],
    });
  }
  if (!readiness.skipped && !readiness.smartSearch.ok) {
    blockers.push({
      code: "smart_search_readiness",
      message: "Smart Search readiness unverified (does not block Proceed?)",
      recovery: [
        "smart-search doctor --format json",
        "Treat Smart Search as unverified; official files can still update after Proceed?",
      ],
    });
  }
  for (const cap of readiness.capabilities) {
    if (!cap.ok) {
      blockers.push({
        code: `capability_${cap.id}`,
        message: `Capability ${cap.id} readiness unverified (does not block Proceed?)`,
        recovery: [
          "Treat this capability as unverified; official files can still update after Proceed?",
        ],
      });
    }
  }
  return blockers;
}

function finishRollout(
  options: UpdateOptions,
  report: UpdateRolloutReport,
): void {
  options.lastReport = report;
  emitRolloutReport(report, options.json);
}

function candidatePath(
  projectRoot: string,
  canonicalBuildRoot: string,
  relativePath: string,
): string {
  const root = isCanonicalGenerationPath(relativePath)
    ? canonicalBuildRoot
    : projectRoot;
  return path.join(root, ...relativePath.replace(/\\/g, "/").split("/"));
}

interface DeferredLiveWrite {
  readonly content: string;
  readonly executable: boolean;
}

/**
 * Apply template writes that are outside the canonical generation only after
 * lifecycle commit. Canonical paths are staged in the OS temporary root; live
 * paths are kept as bytes in memory until ProjectionStore/lifecycle succeeds.
 */
function applyDeferredLiveWrites(
  cwd: string,
  writes: ReadonlyMap<string, DeferredLiveWrite>,
): void {
  for (const [relativePath, write] of writes) {
    const target = path.join(cwd, ...relativePath.replace(/\\/g, "/").split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, write.content);
    if (write.executable) fs.chmodSync(target, 0o755);
  }
}

function migrationRoot(item: MigrationItem): "canonical" | "live" {
  const paths = [item.from, item.to].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const canonical = paths.map(isCanonicalGenerationPath);
  if (canonical.some(Boolean) && !canonical.every(Boolean))
    throw new Error("canonical-migration-cross-boundary");
  return canonical.length > 0 && canonical.every(Boolean)
    ? "canonical"
    : "live";
}

function partitionMigrations(classified: ClassifiedMigrations): {
  canonical: ClassifiedMigrations;
  live: ClassifiedMigrations;
} {
  const empty = (): ClassifiedMigrations => ({
    auto: [],
    confirm: [],
    conflict: [],
    skip: [],
  });
  const result = { canonical: empty(), live: empty() };
  for (const key of ["auto", "confirm", "conflict", "skip"] as const) {
    for (const item of classified[key])
      result[migrationRoot(item)][key].push(item);
  }
  return result;
}

function mergeMigrationResults(
  left: MigrationResult,
  right: MigrationResult,
): MigrationResult {
  return {
    renamed: left.renamed + right.renamed,
    deleted: left.deleted + right.deleted,
    skipped: left.skipped + right.skipped,
    conflicts: left.conflicts + right.conflicts,
  };
}

function reportUpdateLifecycle(result: LifecycleResult): void {
  if (result.status === "review" || result.status === "interrupted") {
    throw new Error(`Pactile lifecycle update stopped: ${result.reason}`);
  }
  if (result.status === "degraded") {
    const failures = result.adapters
      .filter((adapter) => adapter.status !== "succeeded")
      .map(
        (adapter) =>
          `${adapter.adapterId}: ${adapter.reason ?? "pending"}${
            adapter.retryable ? " (retryable)" : ""
          }`,
      );
    console.warn(
      chalk.yellow(
        `Canonical update committed; Adapter reconciliation is degraded: ${failures.join(", ")}`,
      ),
    );
    return;
  }
  console.log(
    chalk.green("✓ Canonical generation and Adapter projections reconciled"),
  );
}

async function runUpdateLifecycle(
  cwd: string,
  operation: "update" | "reconcile",
  candidateFiles?: readonly LifecycleGenerationFile[],
): Promise<LifecycleResult> {
  const installed = new InstallStateStore(cwd).read();
  if (!installed)
    throw new Error(
      "Missing .pactile install state. Re-run `pactile init` to recover before update.",
    );
  const platforms = installedPactilePlatforms(installed.state);
  const files =
    candidateFiles ??
    collectCanonicalGenerationFiles(
      cwd,
      discoverCanonicalGenerationPaths(cwd),
      platforms,
      VERSION,
    );
  const result = await runLifecycleCommand({
    projectRoot: cwd,
    operation,
    runtimeVersion: VERSION,
    files,
    platforms,
    materializeCanonical: candidateFiles
      ? (context) => materializeCanonicalGeneration(cwd, context)
      : undefined,
  });
  reportUpdateLifecycle(result);
  return result;
}

/**
 * Main update command
 */
export async function update(options: UpdateOptions): Promise<void> {
  const cwd = process.cwd();
  const rolloutOpts = rolloutOptionsFromUpdate(options);
  let readinessSnapshot: UpdateReadinessSnapshot | null = null;
  let projectVersion = "unknown";
  let cliVersion = VERSION;
  let latestNpmVersion: string | null = null;
  let cliVsProject = 0;
  let cliVsNpm = 0;

  const emitEarly = (
    outcome: UpdateRolloutReport["outcome"],
    extra?: Partial<{
      files: ReturnType<typeof buildFilePlanFromChanges>;
      conflictsPending: string[];
      migrations: ReturnType<typeof summarizeMigrationPlan>;
      breakingMigrationGateRequired: boolean;
      projectVersionAfter: string | null;
      apply: UpdateRolloutReport["apply"];
      postUpdateSmoke: UpdateRolloutReport["postUpdateSmoke"];
    }>,
  ): void => {
    const readiness =
      readinessSnapshot ??
      snapshotReadinessForRollout({
        cwd,
        selected: loadProjectCapabilities(cwd),
        skipReadiness: options.skipReadiness,
      });
    const report = createBaseRolloutReport({
      mode: options.dryRun ? "dry-run" : "apply",
      outcome,
      projectPath: cwd,
      projectVersionBefore: projectVersion,
      projectVersionAfter: extra?.projectVersionAfter ?? null,
      latestNpmVersion,
      cliBehindNpm: cliVsNpm < 0 && latestNpmVersion !== null,
      options: rolloutOpts,
      readiness,
      upgradeDirection: upgradeDirectionFromCompare(
        cliVsProject,
        projectVersion,
      ),
      files:
        extra?.files ??
        buildFilePlanFromChanges({
          newFiles: [],
          unchangedFiles: [],
          autoUpdateFiles: [],
          changedFiles: [],
          userDeletedFiles: [],
        }),
      conflictsPending: extra?.conflictsPending ?? [],
      migrations: extra?.migrations ?? summarizeMigrationPlan(null, 0),
      breakingMigrationGateRequired:
        extra?.breakingMigrationGateRequired ?? false,
      apply: extra?.apply,
      postUpdateSmoke: extra?.postUpdateSmoke,
      releaseBlockers: releaseBlockersFromReadiness(
        readiness,
        cliVsNpm < 0 && latestNpmVersion !== null,
        cliVersion,
        latestNpmVersion,
      ),
    });
    finishRollout(options, report);
  };

  // Resolve canonical state first; legacy-only projects receive import guidance.
  if (!isWorkflowInitialized(cwd)) {
    console.log(chalk.red("Error: Pactile not initialized in this directory."));
    console.log(chalk.gray("Run 'pactile init' first."));
    emitEarly("blocked_not_initialized");
    return;
  }
  if (resolveWorkflowDirName(cwd) !== DIR_NAMES.WORKFLOW) {
    console.log(chalk.red(LEGACY_UPDATE_BLOCK_MESSAGE));
    emitEarly("blocked_not_initialized");
    return;
  }

  console.log(chalk.cyan("\nPactile Update"));
  console.log(chalk.cyan("══════════════\n"));

  // Set up proxy before any network calls (npm version check)
  setupProxy();

  readinessSnapshot = snapshotReadinessForRollout({
    cwd,
    selected: loadProjectCapabilities(cwd),
    skipReadiness: options.skipReadiness,
  });
  reportUpdateReadiness(readinessSnapshot);

  // Get versions
  projectVersion = getInstalledVersion(cwd);
  cliVersion = VERSION;
  latestNpmVersion = await getLatestNpmVersion();

  // Version comparison
  cliVsProject = compareVersions(cliVersion, projectVersion);
  cliVsNpm = latestNpmVersion
    ? compareVersions(cliVersion, latestNpmVersion)
    : 0;

  // Display versions with context
  console.log(`Project version: ${chalk.white(projectVersion)}`);
  console.log(`CLI version:     ${chalk.white(cliVersion)}`);
  if (latestNpmVersion) {
    console.log(`Latest on npm:   ${chalk.white(latestNpmVersion)}`);
  } else {
    console.log(chalk.gray("Latest on npm:   (unable to fetch)"));
  }
  console.log("");

  // Check if CLI is outdated compared to npm
  if (cliVsNpm < 0 && latestNpmVersion) {
    console.log(
      chalk.yellow(
        `⚠️  Your CLI (${cliVersion}) is behind npm (${latestNpmVersion}).`,
      ),
    );
    console.log(chalk.yellow(`   Run: pactile upgrade\n`));
  }

  // Check for downgrade situation
  if (cliVsProject < 0) {
    console.log(
      chalk.red(
        `❌ Cannot update: CLI version (${cliVersion}) < project version (${projectVersion})`,
      ),
    );
    console.log(chalk.red(`   This would DOWNGRADE your project!\n`));

    if (!options.allowDowngrade) {
      console.log(chalk.gray("Solutions:"));
      console.log(chalk.gray(`  1. Update your CLI: pactile upgrade`));
      console.log(
        chalk.gray(`  2. Force downgrade: pactile update --allow-downgrade\n`),
      );
      emitEarly("blocked_downgrade");
      return;
    }

    console.log(
      chalk.yellow(
        "⚠️  --allow-downgrade flag set. Proceeding with downgrade...\n",
      ),
    );
  }

  // Migration metadata is displayed at the end to prevent scrolling off screen

  // Load template hashes for modification detection
  let hashes = loadHashes(cwd);
  const isFirstHashTracking = Object.keys(hashes).length === 0;

  // Handle unknown version - skip regular migrations but safe-file-delete still runs
  const isUnknownVersion = projectVersion === "unknown";
  if (isUnknownVersion) {
    console.log(
      chalk.yellow(
        "⚠️  No version file found. Skipping migrations — run pactile init to fix.",
      ),
    );
    console.log(chalk.gray("   Template updates will still be applied."));
    console.log(
      chalk.gray("   Safe file cleanup will still run (hash-verified).\n"),
    );
  }

  // Self-heal poisoned manifests: prune entries that no current platform
  // configurator owns. This silently removes user-owned paths that early
  // Older init versions over-hashed some user-owned session directories.
  let prunedManifest = false;
  {
    const configuredPlatforms = new Set<AITool>(getConfiguredPlatforms(cwd));
    const prune = pruneOrphanManifestKeys(
      cwd,
      [...configuredPlatforms],
      hashes,
      { persist: false },
    );
    if (prune.pruned.length > 0) {
      console.log(
        chalk.gray(
          `   Pruned ${prune.pruned.length} orphan manifest entries from .template-hashes.json`,
        ),
      );
      hashes = prune.hashes;
      prunedManifest = true;
    }
  }

  // For breaking releases with recommendMigrate + --migrate, bypass update.skip
  // across the board (safe-file-delete, new file writes, template updates).
  // Why: honoring skip here leaves users forever half-migrated — old deprecated
  // files persist under skip-protected paths, new commands like `continue.md`
  // never land, and every future update re-flags the same mess. Rename
  // migrations already ignore update.skip; this makes the rest consistent
  // during a breaking upgrade. User customizations are still guarded by the
  // per-file conflict prompt ("Modified by you") at write time.
  const breakingBypass =
    options.migrate === true &&
    cliVsProject > 0 &&
    projectVersion !== "unknown" &&
    (() => {
      const md = getMigrationMetadata(projectVersion, cliVersion);
      return md.breaking && md.recommendMigrate;
    })();

  // Collect templates (used for both migration classification and change analysis).
  // Official set ignores update.skip so we can detect skip entries that already
  // match the shipped template (dogfood pin absorbed by this release).
  const officialTemplates = collectTemplateFiles(cwd, true);
  const templates = collectTemplateFiles(cwd, breakingBypass);
  printLegacyCursorSkillResidueNotice(cwd);

  // Load update.skip paths (used for both safe-file-delete and template collection)
  const skipPaths = loadUpdateSkipPaths(cwd);
  const staleSkipPaths = collectStaleUpdateSkipPaths(
    cwd,
    skipPaths,
    officialTemplates,
  );

  // Collect safe-file-delete items from ALL manifests (hash match is the safety net)
  // This runs regardless of version — unknown version still gets safe cleanup
  const allMigrations = getAllMigrations();
  const safeFileDeletes = collectSafeFileDeletes(
    allMigrations,
    cwd,
    skipPaths,
    breakingBypass,
  );
  const hasSafeDeletes =
    safeFileDeletes.filter((c) => c.action === "delete").length > 0;

  // Check for pending regular migrations (skip if unknown version)
  let pendingMigrations = isUnknownVersion
    ? []
    : filterReadOnlyLegacyMigrationItems(
        getMigrationsForVersion(projectVersion, cliVersion),
      );

  // Also check for "orphaned" migrations - where source still exists but version says we shouldn't migrate
  // This handles cases where version was updated but migrations weren't applied
  const orphanedMigrations = allMigrations.filter((item) => {
    // Only check rename and rename-dir migrations
    if (item.type !== "rename" && item.type !== "rename-dir") return false;
    if (!item.from || !item.to) return false;

    const oldPath = path.join(cwd, item.from);
    const newPath = path.join(cwd, item.to);

    // Orphaned if: source exists AND target doesn't exist
    // AND this migration isn't already in pendingMigrations
    const sourceExists = fs.existsSync(oldPath);
    const targetExists = fs.existsSync(newPath);
    const alreadyPending = pendingMigrations.some(
      (m) => m.from === item.from && m.to === item.to,
    );

    return sourceExists && !targetExists && !alreadyPending;
  });

  // Add orphaned migrations to pending (they need to be applied)
  if (orphanedMigrations.length > 0) {
    console.log(
      chalk.yellow("⚠️  Detected incomplete migrations from previous updates:"),
    );
    for (const item of orphanedMigrations) {
      console.log(chalk.yellow(`    ${item.from} → ${item.to}`));
    }
    console.log("");
    pendingMigrations = filterReadOnlyLegacyMigrationItems([
      ...pendingMigrations,
      ...orphanedMigrations,
    ]);
  }

  const hasMigrations = pendingMigrations.length > 0;

  // Classify migrations (stored for later backup creation)
  let classifiedMigrations: ClassifiedMigrations | null = null;

  if (hasMigrations) {
    console.log(chalk.cyan("Analyzing migrations...\n"));

    classifiedMigrations = classifyMigrations(
      pendingMigrations,
      cwd,
      hashes,
      templates,
    );

    printMigrationSummary(classifiedMigrations);

    // Hard-stop: pending rename/delete work from a breaking release requires --migrate.
    // Why: without --migrate, those entries are skipped and update()'s later path silently
    // bumps the version stamp, leaving old paths orphaned next to new templates. Force
    // explicit opt-in so the user can't half-migrate by accident.
    const pendingMigrationCount =
      classifiedMigrations.auto.length +
      classifiedMigrations.confirm.length +
      classifiedMigrations.conflict.length;

    if (
      pendingMigrationCount > 0 &&
      !options.migrate &&
      !options.dryRun &&
      cliVsProject > 0 &&
      projectVersion !== "unknown"
    ) {
      const gateMetadata = getMigrationMetadata(projectVersion, cliVersion);
      if (gateMetadata.breaking && gateMetadata.recommendMigrate) {
        console.log(
          chalk.bgRed.white.bold(" ✖ MIGRATION REQUIRED ") +
            chalk.red(
              ` Breaking changes between ${projectVersion} → ${cliVersion} require --migrate.`,
            ),
        );
        console.log("");
        console.log(chalk.yellow(`  Run: pactile update --migrate`));
        console.log("");
        console.log(
          chalk.gray(
            "  Without --migrate, renamed/relocated files from breaking releases aren't moved,\n" +
              "  leaving your project with stale paths alongside new templates.\n" +
              "  Use --dry-run to preview what --migrate will do.",
          ),
        );
        const safeDeleteCandidateCount = safeFileDeletes.filter(
          (c) => c.action === "delete",
        ).length;
        emitEarly("blocked_migration_required", {
          breakingMigrationGateRequired: true,
          migrations: summarizeMigrationPlan(
            classifiedMigrations,
            safeDeleteCandidateCount,
          ),
        });
        process.exit(1);
      }
    }

    // Soft hint: non-breaking migrations or projects that chose not to set recommendMigrate
    if (!options.migrate) {
      const autoCount = classifiedMigrations.auto.length;
      const confirmCount = classifiedMigrations.confirm.length;

      if (autoCount > 0 || confirmCount > 0) {
        console.log(
          chalk.gray(
            `Tip: Use --migrate to apply migrations (prompts for modified files).`,
          ),
        );
        if (confirmCount > 0) {
          console.log(
            chalk.gray(
              `     Use --migrate -f to force all, or --migrate -s to skip modified.\n`,
            ),
          );
        } else {
          console.log("");
        }
      }
    }
  }

  // Print safe-file-delete summary (always shown, runs without --migrate)
  if (safeFileDeletes.length > 0) {
    printSafeFileDeleteSummary(safeFileDeletes);
  }

  // Preview retired alternate-client cleanup (hash-safe; always considered).
  const alternateClientResiduePreview = cleanupRetiredAlternateClientResidue(
    cwd,
    {
      dryRun: true,
    },
  );
  if (alternateClientResiduePreview.deleted.length > 0) {
    console.log(chalk.cyan("\nRetired alternate-client cleanup (hash-safe):"));
    for (const rel of alternateClientResiduePreview.deleted) {
      console.log(chalk.gray(`  would delete: ${rel}`));
    }
  }
  if (alternateClientResiduePreview.preservedModified.length > 0) {
    console.log(
      chalk.yellow(
        `  preserve (user-modified): ${alternateClientResiduePreview.preservedModified.join(", ")}`,
      ),
    );
  }

  // Analyze changes (pass hashes for modification detection)
  const changes = analyzeChanges(cwd, hashes, templates);
  const missingTemplateHashes = collectMissingTemplateHashes(changes, hashes);

  const safeDeleteCandidateCount = safeFileDeletes.filter(
    (c) => c.action === "delete",
  ).length;
  const migrationPlanSummary = summarizeMigrationPlan(
    classifiedMigrations,
    safeDeleteCandidateCount,
  );
  const safeDeletePaths = safeFileDeletes
    .filter((c) => c.action === "delete")
    .map((c) => c.item.from);
  const conflictsPending = changes.changedFiles.map((f) => f.relativePath);
  const buildRolloutFilePlan = (): ReturnType<
    typeof buildFilePlanFromChanges
  > =>
    buildFilePlanFromChanges({
      newFiles: changes.newFiles,
      unchangedFiles: changes.unchangedFiles,
      autoUpdateFiles: changes.autoUpdateFiles,
      changedFiles: changes.changedFiles,
      userDeletedFiles: changes.userDeletedFiles,
      safeDeletePaths,
    });

  const p36State: { report?: UpdateRolloutReport["p36"] } = {};
  let lifecycleResult: LifecycleResult | null = null;

  const emitRollout = (
    outcome: UpdateRolloutReport["outcome"],
    extra?: Partial<{
      projectVersionAfter: string | null;
      apply: UpdateRolloutReport["apply"];
      postUpdateSmoke: UpdateRolloutReport["postUpdateSmoke"];
      files: ReturnType<typeof buildFilePlanFromChanges>;
      breakingMigrationGateRequired: boolean;
      backupPath: string | null;
      p36: UpdateRolloutReport["p36"];
      lifecycle: UpdateRolloutReport["lifecycle"];
    }>,
  ): void => {
    const readiness =
      readinessSnapshot ??
      snapshotReadinessForRollout({
        cwd,
        selected: loadProjectCapabilities(cwd),
        skipReadiness: options.skipReadiness,
      });
    const report = createBaseRolloutReport({
      mode: options.dryRun ? "dry-run" : "apply",
      outcome,
      projectPath: cwd,
      projectVersionBefore: projectVersion,
      projectVersionAfter: extra?.projectVersionAfter ?? null,
      latestNpmVersion,
      cliBehindNpm: cliVsNpm < 0 && latestNpmVersion !== null,
      options: rolloutOpts,
      readiness,
      upgradeDirection: upgradeDirectionFromCompare(
        cliVsProject,
        projectVersion,
      ),
      files: extra?.files ?? buildRolloutFilePlan(),
      conflictsPending,
      migrations: migrationPlanSummary,
      breakingMigrationGateRequired:
        extra?.breakingMigrationGateRequired ?? false,
      backupPath: extra?.backupPath ?? null,
      apply: extra?.apply,
      postUpdateSmoke: extra?.postUpdateSmoke,
      lifecycle: extra?.lifecycle ?? lifecycleResultToSummary(lifecycleResult),
      releaseBlockers: releaseBlockersFromReadiness(
        readiness,
        cliVsNpm < 0 && latestNpmVersion !== null,
        cliVersion,
        latestNpmVersion,
      ),
      p36: extra?.p36 ?? p36State.report,
    });
    finishRollout(options, report);
  };

  // Print summary
  printChangeSummary(changes);
  if (options.dryRun) {
    logStaleUpdateSkip(staleSkipPaths, true);
  }

  const officialPlan = planOfficialSurfaceA({
    cwd,
    hashes,
    refresh: changes.autoUpdateFiles.map((file) => file.relativePath),
    preserved: changes.changedFiles.map((file) => file.relativePath),
    added: changes.newFiles.map((file) => file.relativePath),
  });
  const artifactPlan = planArtifactMigration({ root: cwd });
  const waveCPlan = planWaveC({
    root: cwd,
    report: scanContractMigration({ root: cwd }),
  });
  const p36Plan: P36UpgradePlan = composeP36Plan({
    official: officialPlan,
    artifacts: artifactPlan,
    writeArtifacts: Boolean(options.writeArtifacts),
    waveC: waveCPlan,
  });
  p36State.report = p36SummaryForRollout(p36Plan);
  printP36Vernacular(p36Plan);

  // First-time hash tracking hint
  if (isFirstHashTracking && changes.changedFiles.length > 0) {
    console.log(chalk.cyan("ℹ️  First update with hash tracking enabled."));
    console.log(
      chalk.gray(
        "   Changed files shown above may not be actual user modifications.",
      ),
    );
    console.log(
      chalk.gray(
        "   After this update, hash tracking will accurately detect changes.\n",
      ),
    );
  }

  // Check if there's anything to do
  const isUpgrade = cliVsProject > 0;
  const isDowngrade = cliVsProject < 0;
  const isSameVersion = cliVsProject === 0;

  // Check if we have pending migrations that need to be applied
  const hasPendingMigrations =
    options.migrate &&
    classifiedMigrations &&
    (classifiedMigrations.auto.length > 0 ||
      classifiedMigrations.confirm.length > 0);

  const hasOfficialP36 = officialWorkPending(officialPlan);
  const hasMaintainerArtifactWrites =
    Boolean(options.writeArtifacts) && artifactPlan.writable.length > 0;
  const hasWaveCPending = waveCWorkPending(p36Plan);

  if (
    changes.newFiles.length === 0 &&
    changes.autoUpdateFiles.length === 0 &&
    changes.changedFiles.length === 0 &&
    !hasPendingMigrations &&
    !hasSafeDeletes &&
    !hasOfficialP36 &&
    !hasMaintainerArtifactWrites &&
    !hasWaveCPending
  ) {
    if (!options.dryRun) {
      const canonicalBuildRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "pactile-update-"),
      );
      try {
        seedCanonicalBuildRoot(cwd, canonicalBuildRoot);
        if (prunedManifest) saveHashes(canonicalBuildRoot, hashes);
        if (missingTemplateHashes.size > 0) {
          updateHashes(canonicalBuildRoot, missingTemplateHashes);
        }
        if (!isSameVersion) updateVersionFile(canonicalBuildRoot);
        const activePlatforms = installedPactilePlatforms(
          new InstallStateStore(cwd).read()?.state ?? null,
        );
        const candidate = collectCanonicalGenerationFiles(
          canonicalBuildRoot,
          discoverCanonicalGenerationPaths(canonicalBuildRoot),
          activePlatforms,
          VERSION,
        );
        lifecycleResult = await runUpdateLifecycle(
          cwd,
          isSameVersion ? "reconcile" : "update",
          candidate,
        );
      } finally {
        fs.rmSync(canonicalBuildRoot, { recursive: true, force: true });
      }
    }

    if (isSameVersion) {
      console.log(chalk.green("✓ Already up to date!"));
    } else {
      if (isUpgrade) {
        console.log(
          chalk.green(
            `✓ No file changes needed for ${projectVersion} → ${cliVersion}`,
          ),
        );
      } else if (isDowngrade) {
        console.log(
          chalk.green(
            `✓ No file changes needed for ${projectVersion} → ${cliVersion} (downgrade)`,
          ),
        );
      }
    }
    const afterVersion = getInstalledVersion(cwd);
    emitRollout(
      lifecycleResult?.status === "degraded"
        ? "applied_degraded"
        : "no_changes",
      {
        projectVersionAfter: afterVersion,
        files: buildRolloutFilePlan(),
      },
    );
    return;
  }

  // Show what this operation will do
  if (isUpgrade) {
    console.log(
      chalk.green(`This will UPGRADE: ${projectVersion} → ${cliVersion}\n`),
    );
  } else if (isDowngrade) {
    console.log(
      chalk.red(`⚠️  This will DOWNGRADE: ${projectVersion} → ${cliVersion}\n`),
    );
  }

  // Show breaking change warning before confirm
  if (cliVsProject > 0 && projectVersion !== "unknown") {
    const preConfirmMetadata = getMigrationMetadata(projectVersion, cliVersion);
    if (preConfirmMetadata.breaking) {
      console.log(chalk.cyan("═".repeat(60)));
      console.log(
        chalk.bgRed.white.bold(" ⚠️  BREAKING CHANGES ") +
          chalk.red.bold(" Review the changes above carefully!"),
      );
      if (preConfirmMetadata.changelog.length > 0) {
        console.log("");
        console.log(chalk.white(preConfirmMetadata.changelog[0]));
      }
      if (preConfirmMetadata.recommendMigrate && !options.migrate) {
        console.log("");
        console.log(
          chalk.bgGreen.black.bold(" 💡 RECOMMENDED ") +
            chalk.green.bold(" Run with --migrate to complete the migration"),
        );
      }
      // Notice when update.skip is bypassed so user isn't surprised when
      // skipPaths-protected files get cleaned up during this breaking upgrade.
      if (breakingBypass && skipPaths.length > 0) {
        const willBypass = safeFileDeletes.filter(
          (c) =>
            c.action === "delete" &&
            skipPaths.some(
              (skip) =>
                c.item.from === skip ||
                c.item.from.startsWith(skip.endsWith("/") ? skip : skip + "/"),
            ),
        );
        if (willBypass.length > 0) {
          console.log("");
          console.log(
            chalk.bgYellow.black.bold(" ⚠ update.skip BYPASSED ") +
              chalk.yellow.bold(
                ` Breaking release — ${willBypass.length.toString()} file(s) under your update.skip paths will be cleaned up.`,
              ),
          );
          console.log(
            chalk.gray(
              "  Hash-verified: only files matching known Pactile templates are deleted. Your local customizations (hash mismatch) are still preserved.",
            ),
          );
        }
      }
      console.log(chalk.cyan("═".repeat(60)));
      console.log("");
    }
  }

  // Dry run mode
  if (options.dryRun) {
    console.log(chalk.gray("[Dry run] No changes made."));
    emitRollout("would_apply", { files: buildRolloutFilePlan() });
    return;
  }

  // File-conflict flags (--force / --skip-all / --create-new) consent to apply
  // official A writes. They are not Wave C stop-read confirm. Only interactive
  // Proceed? yes writes the canonical Wave C decision artifact.
  let waveCInteractivelyConfirmed = false;

  // Batch-resolution flags are explicit consent for non-interactive runs.
  // Prompting here breaks CI and `node ... update --force --migrate` smoke tests.
  if (!options.force && !options.skipAll && !options.createNew) {
    // Non-interactive (no TTY on stdin) and no explicit consent flag: hard-fail
    // instead of hanging on inquirer.prompt, which waits forever for stdin that
    // never arrives (observed when update is run in a backgrounded shell, CI
    // pipeline, or any redirected-stdin context). Guide the operator toward an
    // explicit consent flag or a dry-run first.
    if (!process.stdin.isTTY) {
      throw new Error(
        "Non-interactive `pactile update` requires an explicit consent flag. " +
          "Re-run with --force (apply all), --skip-all (preserve modified), --create-new (.new copies), or --dry-run (preview only).",
      );
    }
    const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
      {
        type: "confirm",
        name: "proceed",
        message: "Proceed?",
        default: true,
      },
    ]);

    if (!proceed) {
      console.log(chalk.yellow("Update cancelled."));
      emitRollout("cancelled", { files: buildRolloutFilePlan() });
      return;
    }
    waveCInteractivelyConfirmed = true;
  }

  // Create complete backup of all managed platform/workflow directories
  const canonicalBuildRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pactile-update-"),
  );
  seedCanonicalBuildRoot(cwd, canonicalBuildRoot);
  if (prunedManifest) saveHashes(canonicalBuildRoot, hashes);
  const backupDir = createFullBackup(cwd);
  let migrationApplyResult: MigrationResult | null = null;
  let officialRetired = 0;
  let safeDeleted = 0;
  let liveMigrationApplyResult: MigrationResult | null = null;
  let deferredLiveSafeDeletes: SafeFileDeleteClassified[] = [];
  let deferredLiveMigrations: ClassifiedMigrations | null = null;
  let added = 0;
  let autoUpdated = 0;
  let updated = 0;
  let skipped = 0;
  let createdNew = 0;
  let configSectionsAppended = 0;
  let deferredLiveConfigSections: ConfigSectionAdded[] = [];
  let artifactApply: ReturnType<typeof applyArtifactMigration> | null = null;
  const overwrittenPaths: string[] = [];
  const skippedConflictPaths: string[] = [];
  const createdNewPaths: string[] = [];
  const deferredLiveWrites = new Map<string, DeferredLiveWrite>();
  const stageTemplateWrite = (
    relativePath: string,
    content: string,
  ): void => {
    const executable =
      relativePath.endsWith(".sh") || relativePath.endsWith(".py");
    if (!isCanonicalGenerationPath(relativePath)) {
      deferredLiveWrites.set(relativePath, { content, executable });
      return;
    }
    const target = candidatePath(cwd, canonicalBuildRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    if (executable) fs.chmodSync(target, 0o755);
  };

  if (backupDir) {
    console.log(
      chalk.gray(`\nBackup created: ${path.relative(cwd, backupDir)}/`),
    );
  }

  try {
    // Build all canonical changes in the isolated generation root first.
    // Legacy host mutations are intentionally deferred until lifecycle has
    // durably activated that generation below.
    if (options.migrate && classifiedMigrations) {
      const migrations = partitionMigrations(classifiedMigrations);
      const canonicalResult = await executeMigrations(
        migrations.canonical,
        canonicalBuildRoot,
        { force: options.force, skipAll: options.skipAll },
      );
      migrationApplyResult = canonicalResult;
      deferredLiveMigrations = migrations.live;
    }

    // Canonical safe deletes are staged with the candidate. Host deletes are
    // held until after the canonical lifecycle commit.
    if (hasSafeDeletes) {
      const canonicalSafeDeletes = safeFileDeletes.filter((item) =>
        isCanonicalGenerationPath(item.item.from),
      );
      deferredLiveSafeDeletes = safeFileDeletes.filter(
        (item) => !isCanonicalGenerationPath(item.item.from),
      );
      safeDeleted = executeSafeFileDeletes(
        canonicalSafeDeletes,
        canonicalBuildRoot,
      );
      if (safeDeleted > 0) {
        console.log(
          chalk.cyan(`\nCleaned up ${safeDeleted} deprecated command file(s)`),
        );
      }
    }

    // Add new files
    if (changes.newFiles.length > 0) {
      console.log(chalk.blue("\nAdding new files..."));
      for (const file of changes.newFiles) {
        stageTemplateWrite(file.relativePath, file.newContent);

        console.log(chalk.green(`  + ${file.relativePath}`));
        added++;
      }
    }

    // Auto-update files (template updated, user didn't modify)
    if (changes.autoUpdateFiles.length > 0) {
      console.log(chalk.blue("\nAuto-updating template files..."));
      for (const file of changes.autoUpdateFiles) {
        stageTemplateWrite(file.relativePath, file.newContent);

        console.log(chalk.cyan(`  ↑ ${file.relativePath}`));
        autoUpdated++;
      }
    }

    // Handle changed files
    if (changes.changedFiles.length > 0) {
      console.log(chalk.blue("\n--- Resolving conflicts ---\n"));

      const applyToAll: { action: ConflictAction | null } = { action: null };

      for (const file of changes.changedFiles) {
        const action = await promptConflictResolution(
          file,
          options,
          applyToAll,
        );

        if (action === "overwrite") {
          stageTemplateWrite(file.relativePath, file.newContent);
          console.log(chalk.yellow(`  ✓ Overwritten: ${file.relativePath}`));
          updated++;
          overwrittenPaths.push(file.relativePath);
        } else if (action === "create-new") {
          stageTemplateWrite(`${file.relativePath}.new`, file.newContent);
          console.log(chalk.blue(`  ✓ Created: ${file.relativePath}.new`));
          createdNew++;
          createdNewPaths.push(`${file.relativePath}.new`);
        } else {
          console.log(chalk.gray(`  ○ Skipped: ${file.relativePath}`));
          skipped++;
          skippedConflictPaths.push(file.relativePath);
        }
      }
    }

    // Append additive config.yaml sections introduced between versions.
    // Sentinel-gated, so users keep their customizations and re-running update
    // on already-migrated files is a no-op. Skipped on unknown / downgrade.
    if (cliVsProject > 0 && projectVersion !== "unknown") {
      const sectionEntries = getConfigSectionsAddedBetween(
        projectVersion,
        cliVersion,
      );
      if (sectionEntries.length > 0) {
        const canonicalSections = sectionEntries.filter((entry) =>
          isCanonicalGenerationPath(entry.file),
        );
        const liveSections = sectionEntries.filter(
          (entry) => !isCanonicalGenerationPath(entry.file),
        );
        configSectionsAppended = applyConfigSectionsAdded(
          canonicalSections,
          canonicalBuildRoot,
          templates,
        ).appended;
        deferredLiveConfigSections = liveSections;
      }
    }

    // Update version file
    updateVersionFile(canonicalBuildRoot);

    // Update template hashes for new, auto-updated, and overwritten files
    const filesToHash = new Map<string, string>(missingTemplateHashes);
    for (const file of changes.newFiles) {
      filesToHash.set(file.relativePath, file.newContent);
    }
    // Auto-updated files always get new hash
    for (const file of changes.autoUpdateFiles) {
      filesToHash.set(file.relativePath, file.newContent);
    }
    // Only hash overwritten files (not skipped or .new copies)
    for (const file of changes.changedFiles) {
      const staged = isCanonicalGenerationPath(file.relativePath)
        ? (() => {
            const fullPath = candidatePath(
              cwd,
              canonicalBuildRoot,
              file.relativePath,
            );
            return fs.existsSync(fullPath)
              ? fs.readFileSync(fullPath, "utf-8")
              : null;
          })()
        : deferredLiveWrites.get(file.relativePath)?.content ?? null;
      if (staged === file.newContent)
        filesToHash.set(file.relativePath, file.newContent);
    }
    if (filesToHash.size > 0) {
      updateHashes(canonicalBuildRoot, filesToHash);
    }

    const activePlatforms = installedPactilePlatforms(
      new InstallStateStore(cwd).read()?.state ?? null,
    );
    const canonicalCandidate = collectCanonicalGenerationFiles(
      canonicalBuildRoot,
      discoverCanonicalGenerationPaths(canonicalBuildRoot),
      activePlatforms,
      VERSION,
    );
    lifecycleResult = await runUpdateLifecycle(
      cwd,
      "update",
      canonicalCandidate,
    );
  } finally {
    fs.rmSync(canonicalBuildRoot, { recursive: true, force: true });
  }

  // The canonical lifecycle (including Adapter ProjectionStore writes) is now
  // committed. Only at this point may legacy host cleanup, live migrations,
  // noncanonical template bytes, and optional artifact projections touch cwd.
  officialRetired = applyOfficialRetire(cwd, officialPlan);
  if (officialRetired > 0) {
    console.log(
      chalk.cyan(
        `\nStopped ${officialRetired} extra official always-on rule(s)`,
      ),
    );
  }

  if (deferredLiveMigrations) {
    liveMigrationApplyResult = await executeMigrations(
      deferredLiveMigrations,
      cwd,
      { force: options.force, skipAll: options.skipAll },
    );

    // Hardcoded: Rename traces-*.md to journal-*.md in workspace directories.
    // Trace file names are variable and therefore cannot be represented by the
    // fixed-path migration manifest. This remains a post-commit user-state
    // migration and never runs before the canonical generation is active.
    const workspaceDir = path.join(cwd, PATHS.WORKSPACE);
    if (fs.existsSync(workspaceDir)) {
      let journalRenamed = 0;
      const devDirs = fs.readdirSync(workspaceDir);
      for (const dev of devDirs) {
        const devPath = path.join(workspaceDir, dev);
        if (!fs.statSync(devPath).isDirectory()) continue;

        const files = fs.readdirSync(devPath);
        for (const file of files) {
          if (!file.startsWith("traces-") || !file.endsWith(".md")) continue;
          const oldPath = path.join(devPath, file);
          const newPath = path.join(
            devPath,
            file.replace("traces-", "journal-"),
          );
          fs.renameSync(oldPath, newPath);
          journalRenamed++;
        }
      }
      if (journalRenamed > 0) {
        console.log(
          chalk.cyan(`Renamed ${journalRenamed} traces file(s) to journal`),
        );
      }
    }
  }

  if (deferredLiveSafeDeletes.length > 0) {
    const deleted = executeSafeFileDeletes(deferredLiveSafeDeletes, cwd);
    safeDeleted += deleted;
  }

  const alternateClientCleanup = cleanupRetiredAlternateClientResidue(cwd);
  if (alternateClientCleanup.deleted.length > 0) {
    safeDeleted += alternateClientCleanup.deleted.length;
    console.log(
      chalk.cyan(
        `\nCleaned up ${alternateClientCleanup.deleted.length} retired alternate-client file(s)`,
      ),
    );
  }
  if (alternateClientCleanup.preservedModified.length > 0) {
    console.log(
      chalk.yellow(
        `Preserved user-modified alternate-client residue: ${alternateClientCleanup.preservedModified.join(", ")}`,
      ),
    );
  }

  applyDeferredLiveWrites(cwd, deferredLiveWrites);
  if (deferredLiveConfigSections.length > 0) {
    configSectionsAppended += applyConfigSectionsAdded(
      deferredLiveConfigSections,
      cwd,
      templates,
    ).appended;
  }

  if (options.writeArtifacts && artifactPlan.writable.length > 0) {
    artifactApply = applyArtifactMigration({
      root: cwd,
      plan: artifactPlan,
    });
    if (artifactApply.ok) {
      console.log(
        chalk.cyan(
          `\nWrote ${artifactApply.written} artifact projection(s); business text kept.`,
        ),
      );
    } else {
      console.log(
        chalk.yellow("产物写入失败，已回到双读。项目仍可用，可再跑 update。"),
      );
      if (artifactApply.error) console.log(chalk.gray(`  ${artifactApply.error}`));
    }
  }

  if (migrationApplyResult || liveMigrationApplyResult) {
    migrationApplyResult = mergeMigrationResults(
      migrationApplyResult ?? {
        renamed: 0,
        deleted: 0,
        skipped: 0,
        conflicts: 0,
      },
      liveMigrationApplyResult ?? {
        renamed: 0,
        deleted: 0,
        skipped: 0,
        conflicts: 0,
      },
    );
    printMigrationResult(migrationApplyResult);
  }

  // Print summary
  console.log(chalk.cyan("\n--- Summary ---\n"));
  if (added > 0) {
    console.log(`  Added: ${added} file(s)`);
  }
  if (autoUpdated > 0) {
    console.log(`  Auto-updated: ${autoUpdated} file(s)`);
  }
  if (updated > 0) {
    console.log(`  Updated: ${updated} file(s)`);
  }
  if (skipped > 0) {
    console.log(`  Skipped: ${skipped} file(s)`);
  }
  if (createdNew > 0) {
    console.log(`  Created .new copies: ${createdNew} file(s)`);
  }
  if (safeDeleted > 0) {
    console.log(`  Cleaned up: ${safeDeleted} deprecated file(s)`);
  }
  if (configSectionsAppended > 0) {
    console.log(`  Config sections added: ${configSectionsAppended}`);
  }
  if (officialRetired > 0) {
    console.log(`  Official always-on stopped: ${officialRetired}`);
  }
  if (artifactApply?.ok && artifactApply.written > 0) {
    console.log(`  Artifact projections written: ${artifactApply.written}`);
  }
  if (artifactApply && !artifactApply.ok) {
    console.log("  Artifact projections: rolled back to dual-read");
  }
  if (hasWaveCPending && waveCInteractivelyConfirmed) {
    try {
      writeWaveCConfirmed(cwd);
      console.log(
        "  已确认停读旧形状（leftover kind/mode/classification 不再当唯一真相）",
      );
    } catch (err) {
      console.log(
        chalk.yellow(
          "停读确认未写上。项目仍可用，旧字段仍双读，可再跑 update。",
        ),
      );
      if (err instanceof Error && err.message) {
        console.log(chalk.gray(`  ${err.message}`));
      }
    }
  } else if (hasWaveCPending) {
    console.log(
      chalk.yellow(
        "  旧字段仍双读。停读需要再跑一次交互式 `pactile update` 并确认 Proceed?（--force / --skip-all / --create-new 不算停读确认）。",
      ),
    );
  }
  if (backupDir) {
    console.log(`  Backup: ${path.relative(cwd, backupDir)}/`);
  }

  const skipAfterApply = loadUpdateSkipPaths(cwd);
  const staleSkipAfterApply = collectStaleUpdateSkipPaths(
    cwd,
    skipAfterApply,
    officialTemplates,
  );
  const prunedSkip = removeUpdateSkipPathsFromConfig(cwd, staleSkipAfterApply);
  if (prunedSkip.length > 0) {
    logStaleUpdateSkip(prunedSkip, false);
  }

  const actionWord = isDowngrade ? "Downgrade" : "Update";
  console.log(
    chalk.green(
      `\n✅ ${actionWord} complete! (${projectVersion} → ${cliVersion})`,
    ),
  );
  printRetiredAlternateClientNotice(cwd);

  if (createdNew > 0) {
    console.log(
      chalk.gray(
        "\nTip: Review .new files and merge changes manually if needed.",
      ),
    );
  }

  // Create migration task if there are breaking changes with migration guides
  if (cliVsProject > 0 && projectVersion !== "unknown") {
    const metadata = getMigrationMetadata(projectVersion, cliVersion);

    if (metadata.breaking && metadata.migrationGuides.length > 0) {
      // Create task directory
      const today = new Date();
      const monthDay = `${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const taskSlug = `migrate-to-${cliVersion}`;
      const taskDirName = `${monthDay}-${taskSlug}`;
      const tasksDir = path.join(cwd, DIR_NAMES.WORKFLOW, DIR_NAMES.TASKS);
      const taskDir = path.join(tasksDir, taskDirName);

      // Check if task already exists
      if (!fs.existsSync(taskDir)) {
        fs.mkdirSync(taskDir, { recursive: true });

        // Get current developer for assignee.
        // `.developer` is a key=value file (written by init_developer.py):
        //   name=<developer-name>
        //   initialized_at=<iso8601>
        // Reading it raw and .trim()-ing embeds the entire file contents
        // (including the `name=` prefix and the `initialized_at` line) into
        // the assignee field, producing bogus assignees like
        // "name=suyuan\ninitialized_at=2026-04-07T23:41:21.978312" that
        // later break session-start task rendering.
        const developerFile = path.join(cwd, DIR_NAMES.WORKFLOW, ".developer");
        let currentDeveloper = "unknown";
        if (fs.existsSync(developerFile)) {
          const raw = fs.readFileSync(developerFile, "utf-8");
          const nameMatch = raw.match(/^\s*name\s*=\s*(.+?)\s*$/m);
          if (nameMatch) {
            currentDeveloper = nameMatch[1];
          }
        }

        // Build task.json — canonical 24-field shape via shared factory.
        const taskTitle = `Migrate to v${cliVersion}`;
        const todayStr = today.toISOString().split("T")[0];
        const taskJson = emptyTaskJson({
          id: taskSlug,
          name: taskSlug,
          title: taskTitle,
          description: `Breaking change migration from v${projectVersion} to v${cliVersion}`,
          status: "planning",
          scope: "migration",
          priority: "P1",
          creator: "pactile-update",
          assignee: currentDeveloper,
          createdAt: todayStr,
        });

        applyKernelCreate({
          taskDir,
          actor: "pactile update",
          idempotencyKey: `update:${taskSlug}`,
          record: taskJson,
          evidence: "pactile update migration skeleton",
        });

        // Build PRD content
        let prdContent = `# Migration Task: Upgrade to v${cliVersion}\n\n`;
        prdContent += `**Created**: ${todayStr}\n`;
        prdContent += `**From Version**: ${projectVersion}\n`;
        prdContent += `**To Version**: ${cliVersion}\n`;
        prdContent += `**Assignee**: ${currentDeveloper}\n\n`;
        prdContent += `## Status\n\n- [ ] Review migration guide\n- [ ] Update custom files\n- [ ] Run \`pactile update --migrate\`\n- [ ] Test workflows\n\n`;

        for (const {
          version,
          guide,
          aiInstructions,
        } of metadata.migrationGuides) {
          prdContent += `---\n\n## v${version} Migration Guide\n\n`;
          prdContent += guide;
          prdContent += "\n\n";

          if (aiInstructions) {
            prdContent += `### AI Assistant Instructions\n\n`;
            prdContent += `When helping with this migration:\n\n`;
            prdContent += aiInstructions;
            prdContent += "\n\n";
          }
        }

        // Write PRD
        const prdPath = path.join(taskDir, "prd.md");
        fs.writeFileSync(prdPath, prdContent);

        console.log("");
        console.log(chalk.bgCyan.black.bold(" 📋 MIGRATION TASK CREATED "));
        console.log(
          chalk.cyan(
            `A task has been created to help you complete the migration:`,
          ),
        );
        console.log(
          chalk.white(
            `   ${DIR_NAMES.WORKFLOW}/${DIR_NAMES.TASKS}/${taskDirName}/`,
          ),
        );
        console.log("");
        console.log(
          chalk.gray(
            "Use AI to help: Ask Claude/Cursor to read the task and fix your custom files.",
          ),
        );
      }
    }
  }

  // Display breaking change warnings at the very end (so they don't scroll off screen)
  if (cliVsProject > 0 && projectVersion !== "unknown") {
    const finalMetadata = getMigrationMetadata(projectVersion, cliVersion);

    if (finalMetadata.breaking || finalMetadata.changelog.length > 0) {
      console.log("");
      console.log(chalk.cyan("═".repeat(60)));

      if (finalMetadata.breaking) {
        console.log(
          chalk.bgRed.white.bold(" ⚠️  BREAKING CHANGES ") +
            chalk.red.bold(" This update contains breaking changes!"),
        );
        console.log("");
      }

      if (finalMetadata.changelog.length > 0) {
        console.log(chalk.cyan.bold("📋 What's Changed:"));
        for (const entry of finalMetadata.changelog) {
          console.log(chalk.white(`   ${entry}`));
        }
        console.log("");
      }

      if (finalMetadata.recommendMigrate && !options.migrate) {
        console.log(
          chalk.bgGreen.black.bold(" 💡 RECOMMENDED ") +
            chalk.green.bold(" Run with --migrate to complete the migration"),
        );
        console.log(
          chalk.gray("   This will remove legacy files and apply all changes."),
        );
        console.log("");
      }

      console.log(chalk.cyan("═".repeat(60)));
    }
  }

  const appliedFilePlan = buildRolloutFilePlan();
  appliedFilePlan.added = changes.newFiles.map((f) => f.relativePath);
  appliedFilePlan.autoUpdated = changes.autoUpdateFiles.map(
    (f) => f.relativePath,
  );
  appliedFilePlan.overwritten = overwrittenPaths;
  appliedFilePlan.skipped = skippedConflictPaths;
  appliedFilePlan.createdNew = createdNewPaths;
  if (safeDeleted > 0) {
    appliedFilePlan.safeDeleted = safeFileDeletes
      .filter((c) => c.action === "delete")
      .map((c) => c.item.from);
  }

  const postSmoke = options.skipPostUpdateSmoke ? [] : runPostUpdateSmoke(cwd);

  const relBackup = backupDir ? path.relative(cwd, backupDir) : null;

  emitRollout(
    lifecycleResult?.status === "degraded" ? "applied_degraded" : "applied",
    {
      projectVersionAfter: getInstalledVersion(cwd),
      files: appliedFilePlan,
      backupPath: relBackup,
      apply: {
        backupPath: relBackup,
        migrations: migrationResultToSummary(migrationApplyResult),
        safeDeleted,
        configSectionsAppended,
      },
      postUpdateSmoke: postSmoke,
    },
  );
}
