/**
 * Read-only inventory of pre-V2 Pactile Task trees.
 *
 * This is a source scanner and migration preflight only. It does not create
 * Task, Run, or Review records, rewrite source files, or decide dependency
 * semantics. The raw JSON and file bytes stay in the plan so a later writer
 * can preserve unknown data and verify the source has not changed.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isPlainObject } from "./schema.js";

const TASK_JSON = "task.json";
const KERNEL_JSON = "kernel.json";
const TASK_MAP_MD = "task-map.md";
const ORPHAN_CANDIDATE_FILES = new Set([
  TASK_JSON,
  KERNEL_JSON,
  TASK_MAP_MD,
  "prd.md",
  "verify.md",
  "design.md",
  "implement.md",
  "handoff.md",
]);
const SOURCE_COMPLETENESS_FINDINGS = new Set<LegacyMigrationFindingCode>([
  "source-directory-unreadable",
  "source-file-unreadable",
  "source-symlink-skipped",
  "orphan-task-artifacts",
]);

const LEGACY_TASK_FIELDS = new Set([
  "id",
  "name",
  "title",
  "description",
  "status",
  "dev_type",
  "scope",
  "package",
  "priority",
  "creator",
  "assignee",
  "createdAt",
  "completedAt",
  "branch",
  "base_branch",
  "worktree_path",
  "commit",
  "pr_url",
  "subtasks",
  "children",
  "parent",
  "relatedFiles",
  "notes",
  "meta",
  "task_kind",
  "task_type",
  "kind",
  "mode",
  "profile",
  "depends_mode",
  "depends_on",
  "dependency_satisfied",
  "execution_approval",
  "quality_gate_results",
  "required_controls",
  "ac_evidence_ledger",
  "independent_check",
  "notes_projection",
  "topology",
  "dependency_graph",
  "ondemand_modules",
  "baseline_modules",
  "decompose_proposal",
  "profile_health",
  "event_bridge",
  "middleware_providers",
  "capability_router",
  "required_capabilities",
]);

const LEGACY_META_FIELDS = new Set([
  "classification",
  "task_kind",
  "task_type",
  "mode",
  "depends_mode",
  "depends_ignore_events",
]);

export type LegacyMigrationFindingSeverity = "blocker" | "warning" | "info";

export type LegacyMigrationFindingCode =
  | "tasks-root-missing"
  | "source-directory-unreadable"
  | "source-file-unreadable"
  | "source-symlink-skipped"
  | "orphan-task-artifacts"
  | "invalid-task-json"
  | "invalid-kernel-json"
  | "kernel-identity-mismatch"
  | "task-id-missing"
  | "duplicate-task-id"
  | "dependency-mapping-deferred"
  | "task-map-preserved-unparsed"
  | "task-status-preserved";

export interface LegacyMigrationFinding {
  code: LegacyMigrationFindingCode;
  severity: LegacyMigrationFindingSeverity;
  sourcePath: string;
  detail: string;
}

export interface LegacySourceFile {
  /** POSIX-relative to the supplied project root. */
  path: string;
  name: string;
  role:
    | "task-json"
    | "kernel-json"
    | "task-map"
    | "prd"
    | "verify"
    | "document";
  byteLength: number;
  sha256: string;
  encoding: "utf8" | "base64";
  /** Exact UTF-8 text, or exact base64 bytes when the file is not UTF-8. */
  content: string;
}

export interface LegacyJsonSource {
  file: LegacySourceFile;
  value: Record<string, unknown> | null;
  parseError: string | null;
}

export interface LegacyFieldFact {
  present: boolean;
  value?: unknown;
}

export interface LegacyTaskSource {
  /** POSIX-relative to the supplied project root. */
  directory: string;
  directoryName: string;
  archivedByPath: boolean;
  /** Raw legacy ID; this is not a proposed V2 Task ID. */
  legacyTaskId: LegacyFieldFact;
  status: LegacyFieldFact;
  parent: LegacyFieldFact;
  children: LegacyFieldFact;
  typeMarkers: {
    topLevel: Record<string, unknown>;
    meta: Record<string, unknown>;
    requiredControls: LegacyFieldFact;
    topology: LegacyFieldFact;
  };
  dependencies: {
    taskJsonDependsOn: LegacyFieldFact;
    topLevelDependsMode: LegacyFieldFact;
    metaDependsMode: LegacyFieldFact;
    taskMapPath: string | null;
    taskMapHash: string | null;
    /** No V2 hard-requires decision is made by this scanner. */
    mappingDecision: "deferred";
  };
  taskJson: LegacyJsonSource | null;
  kernelJson: LegacyJsonSource | null;
  taskMap: LegacySourceFile | null;
  documents: LegacySourceFile[];
  /** Parsed original object including every legacy and unknown property. */
  rawTaskData: Record<string, unknown> | null;
  unknownTaskFields: Record<string, unknown>;
  unknownMetaFields: Record<string, unknown>;
  files: LegacySourceFile[];
  sourceFingerprint: string | null;
  preflight: "clear-to-review" | "blocked";
}

export interface LegacyTaskMigrationPlan {
  schemaVersion: 1;
  readOnly: true;
  wrote: false;
  projectRoot: string;
  tasksRoot: string;
  sourceFingerprint: string | null;
  scannedTaskCount: number;
  scannedFileCount: number;
  preflight: {
    status: "clear-to-review" | "blocked" | "empty";
    blockerCount: number;
  };
  migration: {
    status: "pending-v2-writer";
    targetWriter: "P35 Task/Run/Review";
    writesPlanned: false;
  };
  tasks: LegacyTaskSource[];
  findings: LegacyMigrationFinding[];
}

export interface ScanLegacyTaskMigrationOptions {
  /** Project root containing `.pactile/tasks`; no implicit cwd is used. */
  projectRoot: string;
}

interface DirectoryScan {
  taskDirectories: Set<string>;
  filesByDirectory: Map<string, string[]>;
  directories: string[];
  symlinks: string[];
}

function posixRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function decodeUtf8(bytes: Buffer): string | null {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : null;
}

function roleFor(name: string): LegacySourceFile["role"] {
  if (name === TASK_JSON) return "task-json";
  if (name === KERNEL_JSON) return "kernel-json";
  if (name === TASK_MAP_MD) return "task-map";
  if (name === "prd.md") return "prd";
  if (name === "verify.md") return "verify";
  return "document";
}

function captureFile(projectRoot: string, filePath: string): LegacySourceFile {
  const bytes = fs.readFileSync(filePath);
  const text = decodeUtf8(bytes);
  return {
    path: posixRelative(projectRoot, filePath),
    name: path.basename(filePath),
    role: roleFor(path.basename(filePath)),
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    encoding: text === null ? "base64" : "utf8",
    content: text ?? bytes.toString("base64"),
  };
}

function capturedBytes(file: LegacySourceFile): Buffer {
  return file.encoding === "utf8"
    ? Buffer.from(file.content, "utf8")
    : Buffer.from(file.content, "base64");
}

function fingerprintFiles(files: LegacySourceFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    const bytes = capturedBytes(file);
    hash.update(file.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(bytes.byteLength), "utf8");
    hash.update("\0", "utf8");
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function addFinding(
  findings: LegacyMigrationFinding[],
  projectRoot: string,
  code: LegacyMigrationFindingCode,
  severity: LegacyMigrationFindingSeverity,
  sourcePath: string,
  detail: string,
): void {
  findings.push({
    code,
    severity,
    sourcePath: posixRelative(projectRoot, sourcePath),
    detail,
  });
}

function walkTasksRoot(
  tasksRoot: string,
  projectRoot: string,
  findings: LegacyMigrationFinding[],
): DirectoryScan {
  const result: DirectoryScan = {
    taskDirectories: new Set(),
    filesByDirectory: new Map(),
    directories: [],
    symlinks: [],
  };

  const visit = (directory: string): void => {
    result.directories.push(directory);
    let entries: fs.Dirent[];
    try {
      entries = fs
        .readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch (error) {
      addFinding(
        findings,
        projectRoot,
        "source-directory-unreadable",
        "blocker",
        directory,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        result.symlinks.push(fullPath);
      } else if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
        if (entry.name === TASK_JSON) result.taskDirectories.add(directory);
      }
    }
    result.filesByDirectory.set(directory, files);
  };

  visit(tasksRoot);
  return result;
}

function nearestTaskDirectory(
  directory: string,
  tasksRoot: string,
  taskDirectories: Set<string>,
): string | null {
  let current = directory;
  while (
    current === tasksRoot ||
    current.startsWith(`${tasksRoot}${path.sep}`)
  ) {
    if (taskDirectories.has(current)) return current;
    if (current === tasksRoot) break;
    current = path.dirname(current);
  }
  return null;
}

function filesOwnedByTask(
  taskDirectory: string,
  tasksRoot: string,
  scan: DirectoryScan,
): string[] {
  const owned: string[] = [];
  for (const [directory, files] of scan.filesByDirectory) {
    if (
      nearestTaskDirectory(directory, tasksRoot, scan.taskDirectories) ===
      taskDirectory
    ) {
      owned.push(...files);
    }
  }
  return owned.sort((a, b) => {
    const left = posixRelative(tasksRoot, a);
    const right = posixRelative(tasksRoot, b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function isStandaloneV2TaskDirectory(files: readonly string[]): boolean {
  if (files.some((file) => path.basename(file) === TASK_JSON)) return false;
  const kernelPath = files.find((file) => path.basename(file) === KERNEL_JSON);
  if (!kernelPath) return false;
  try {
    const stat = fs.lstatSync(kernelPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      return false;
    const value: unknown = JSON.parse(fs.readFileSync(kernelPath, "utf8"));
    if (!isPlainObject(value) || value.schemaVersion !== 2) return false;
    const identity = value.identity;
    return isPlainObject(identity) && typeof identity.taskId === "string";
  } catch {
    return false;
  }
}

function isWithinV2TaskDirectory(
  directory: string,
  tasksRoot: string,
  v2TaskDirectories: ReadonlySet<string>,
): boolean {
  let current = directory;
  while (
    current === tasksRoot ||
    current.startsWith(`${tasksRoot}${path.sep}`)
  ) {
    if (v2TaskDirectories.has(current)) return true;
    if (current === tasksRoot) return false;
    current = path.dirname(current);
  }
  return false;
}

function fact(
  record: Record<string, unknown> | null,
  key: string,
): LegacyFieldFact {
  if (!record || !Object.hasOwn(record, key)) return { present: false };
  return { present: true, value: record[key] };
}

function parseJsonSource(file: LegacySourceFile): LegacyJsonSource {
  if (file.encoding !== "utf8") {
    return { file, value: null, parseError: "JSON source is not valid UTF-8" };
  }
  try {
    const parsed: unknown = JSON.parse(file.content);
    if (!isPlainObject(parsed)) {
      return { file, value: null, parseError: "JSON source must be an object" };
    }
    return { file, value: parsed, parseError: null };
  } catch (error) {
    return {
      file,
      value: null,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function unknownFields(
  value: Record<string, unknown> | null,
  known: Set<string>,
): Record<string, unknown> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !known.has(key)),
  );
}

function markerFields(
  value: Record<string, unknown> | null,
  names: string[],
): Record<string, unknown> {
  if (!value) return {};
  return Object.fromEntries(
    names
      .filter((name) => Object.hasOwn(value, name))
      .map((name) => [name, value[name]]),
  );
}

function buildTaskSource(
  projectRoot: string,
  tasksRoot: string,
  directory: string,
  allFiles: string[],
  findings: LegacyMigrationFinding[],
): LegacyTaskSource {
  const sourceFiles: LegacySourceFile[] = [];
  for (const filePath of allFiles) {
    try {
      sourceFiles.push(captureFile(projectRoot, filePath));
    } catch (error) {
      addFinding(
        findings,
        projectRoot,
        "source-file-unreadable",
        "blocker",
        filePath,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  sourceFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const directSource = (name: string): LegacySourceFile | null =>
    sourceFiles.find(
      (file) =>
        file.path === posixRelative(projectRoot, path.join(directory, name)),
    ) ?? null;

  const taskFile = directSource(TASK_JSON);
  const kernelFile = directSource(KERNEL_JSON);
  const taskMapFile = directSource(TASK_MAP_MD);
  const taskJson = taskFile ? parseJsonSource(taskFile) : null;
  const kernelJson = kernelFile ? parseJsonSource(kernelFile) : null;
  const record = taskJson?.value ?? null;
  const meta = record && isPlainObject(record.meta) ? record.meta : null;
  const directoryRelative = posixRelative(projectRoot, directory);
  const taskPathRelative = posixRelative(tasksRoot, directory);
  const archivedByPath =
    taskPathRelative === "archive" || taskPathRelative.startsWith("archive/");

  if (!taskFile) {
    addFinding(
      findings,
      projectRoot,
      "orphan-task-artifacts",
      "blocker",
      directory,
      "task-related source files exist without task.json",
    );
  } else if (taskJson?.parseError) {
    addFinding(
      findings,
      projectRoot,
      "invalid-task-json",
      "blocker",
      taskFile.path.startsWith(`${projectRoot}${path.sep}`)
        ? path.join(projectRoot, taskFile.path.replaceAll("/", path.sep))
        : path.join(projectRoot, taskFile.path),
      taskJson.parseError,
    );
  }

  if (kernelJson?.parseError) {
    addFinding(
      findings,
      projectRoot,
      "invalid-kernel-json",
      "warning",
      path.join(
        projectRoot,
        kernelFile?.path.replaceAll("/", path.sep) ?? "kernel.json",
      ),
      kernelJson.parseError,
    );
  }

  const legacyId = fact(record, "id");
  if (
    !legacyId.present ||
    typeof legacyId.value !== "string" ||
    legacyId.value.trim() === ""
  ) {
    addFinding(
      findings,
      projectRoot,
      "task-id-missing",
      "blocker",
      path.join(directory, TASK_JSON),
      "legacy ID is absent or not a non-empty string; directory name remains separate source evidence",
    );
  }

  const kernelIdentity = kernelJson?.value?.identity;
  const kernelTaskId = isPlainObject(kernelIdentity)
    ? kernelIdentity.taskId
    : undefined;
  if (
    typeof record?.id === "string" &&
    typeof kernelTaskId === "string" &&
    kernelTaskId !== record.id
  ) {
    addFinding(
      findings,
      projectRoot,
      "kernel-identity-mismatch",
      "blocker",
      path.join(directory, KERNEL_JSON),
      `kernel identity ${kernelTaskId} differs from task.json id ${record.id}`,
    );
  }

  const dependsOn = fact(record, "depends_on");
  const topLevelDependsMode = fact(record, "depends_mode");
  const metaDependsMode = fact(meta, "depends_mode");
  if (
    dependsOn.present ||
    topLevelDependsMode.present ||
    metaDependsMode.present
  ) {
    addFinding(
      findings,
      projectRoot,
      "dependency-mapping-deferred",
      "info",
      path.join(directory, TASK_JSON),
      "raw dependency fields and source mode are retained; no V2 requires edge is emitted",
    );
  }
  if (taskMapFile) {
    addFinding(
      findings,
      projectRoot,
      "task-map-preserved-unparsed",
      "info",
      path.join(directory, TASK_MAP_MD),
      "task-map frontmatter and Event Log are retained as exact source bytes, without topology inference",
    );
  }
  const status = fact(record, "status");
  if (status.present) {
    addFinding(
      findings,
      projectRoot,
      "task-status-preserved",
      "info",
      path.join(directory, TASK_JSON),
      "status is reported as a raw fact; no V2 lifecycle or completion result is inferred",
    );
  }

  const hasBlocker = findings.some(
    (finding) =>
      finding.severity === "blocker" &&
      (finding.sourcePath === directoryRelative ||
        finding.sourcePath.startsWith(`${directoryRelative}/`)),
  );
  const hasIncompleteSource = findings.some(
    (finding) =>
      SOURCE_COMPLETENESS_FINDINGS.has(finding.code) &&
      (finding.sourcePath === directoryRelative ||
        finding.sourcePath.startsWith(`${directoryRelative}/`)),
  );

  return {
    directory: directoryRelative,
    directoryName: path.basename(directory),
    archivedByPath,
    legacyTaskId: legacyId,
    status,
    parent: fact(record, "parent"),
    children: fact(record, "children"),
    typeMarkers: {
      topLevel: markerFields(record, [
        "task_kind",
        "task_type",
        "kind",
        "mode",
      ]),
      meta: markerFields(meta, [
        "classification",
        "task_kind",
        "task_type",
        "mode",
      ]),
      requiredControls: fact(record, "required_controls"),
      topology: fact(record, "topology"),
    },
    dependencies: {
      taskJsonDependsOn: dependsOn,
      topLevelDependsMode,
      metaDependsMode,
      taskMapPath: taskMapFile?.path ?? null,
      taskMapHash: taskMapFile?.sha256 ?? null,
      mappingDecision: "deferred",
    },
    taskJson,
    kernelJson,
    taskMap: taskMapFile,
    documents: sourceFiles.filter(
      (file) =>
        file.role === "prd" ||
        file.role === "verify" ||
        file.role === "document",
    ),
    rawTaskData: record,
    unknownTaskFields: unknownFields(record, LEGACY_TASK_FIELDS),
    unknownMetaFields: unknownFields(meta, LEGACY_META_FIELDS),
    files: sourceFiles,
    sourceFingerprint:
      !hasIncompleteSource && sourceFiles.length === allFiles.length
        ? fingerprintFiles(sourceFiles)
        : null,
    preflight: hasBlocker ? "blocked" : "clear-to-review",
  };
}

/**
 * Scan `.pactile/tasks` and prepare a source-preserving, non-mutating plan.
 * The supplied project root is explicit so callers cannot accidentally scan
 * the current working directory or a different checkout.
 */
export function scanLegacyTaskMigration(
  options: ScanLegacyTaskMigrationOptions,
): LegacyTaskMigrationPlan {
  const projectRoot = path.resolve(options.projectRoot);
  const pactileRoot = path.join(projectRoot, ".pactile");
  const tasksRoot = path.join(projectRoot, ".pactile", "tasks");
  const findings: LegacyMigrationFinding[] = [];

  try {
    const pactileStat = fs.lstatSync(pactileRoot);
    if (!pactileStat.isDirectory() || pactileStat.isSymbolicLink()) {
      addFinding(
        findings,
        projectRoot,
        "source-directory-unreadable",
        "blocker",
        pactileRoot,
        ".pactile root must be a real directory, not a symlink or file",
      );
      return emptyBlockedPlan(projectRoot, tasksRoot, findings);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      addFinding(
        findings,
        projectRoot,
        "source-directory-unreadable",
        "blocker",
        pactileRoot,
        error instanceof Error ? error.message : String(error),
      );
      return emptyBlockedPlan(projectRoot, tasksRoot, findings);
    }
  }

  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(tasksRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      addFinding(
        findings,
        projectRoot,
        "tasks-root-missing",
        "info",
        tasksRoot,
        "no .pactile/tasks root is present",
      );
      return {
        schemaVersion: 1,
        readOnly: true,
        wrote: false,
        projectRoot,
        tasksRoot,
        sourceFingerprint: fingerprintFiles([]),
        scannedTaskCount: 0,
        scannedFileCount: 0,
        preflight: { status: "empty", blockerCount: 0 },
        migration: {
          status: "pending-v2-writer",
          targetWriter: "P35 Task/Run/Review",
          writesPlanned: false,
        },
        tasks: [],
        findings,
      };
    }
    addFinding(
      findings,
      projectRoot,
      "source-directory-unreadable",
      "blocker",
      tasksRoot,
      error instanceof Error ? error.message : String(error),
    );
    return emptyBlockedPlan(projectRoot, tasksRoot, findings);
  }

  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    addFinding(
      findings,
      projectRoot,
      "source-directory-unreadable",
      "blocker",
      tasksRoot,
      "tasks root must be a real directory, not a symlink or file",
    );
    return emptyBlockedPlan(projectRoot, tasksRoot, findings);
  }

  const scan = walkTasksRoot(tasksRoot, projectRoot, findings);
  for (const symlink of scan.symlinks) {
    addFinding(
      findings,
      projectRoot,
      "source-symlink-skipped",
      "blocker",
      symlink,
      "symlink was not followed; its source bytes cannot be safely inventoried",
    );
  }

  const taskDirectories = [...scan.taskDirectories].sort((a, b) => {
    const left = posixRelative(tasksRoot, a);
    const right = posixRelative(tasksRoot, b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const v2TaskDirectories = new Set(
    [...scan.filesByDirectory.entries()]
      .filter(([, files]) => isStandaloneV2TaskDirectory(files))
      .map(([directory]) => directory),
  );
  const orphanDirectories = new Set<string>();
  for (const [directory, files] of scan.filesByDirectory) {
    const hasOrphanCandidate = files.some((file) =>
      ORPHAN_CANDIDATE_FILES.has(path.basename(file)),
    );
    if (
      hasOrphanCandidate &&
      !isWithinV2TaskDirectory(directory, tasksRoot, v2TaskDirectories) &&
      !nearestTaskDirectory(directory, tasksRoot, scan.taskDirectories)
    ) {
      orphanDirectories.add(directory);
    }
  }
  for (const directory of orphanDirectories) {
    addFinding(
      findings,
      projectRoot,
      "orphan-task-artifacts",
      "blocker",
      directory,
      "task-related source files exist without task.json",
    );
  }

  const tasks: LegacyTaskSource[] = [];
  for (const directory of taskDirectories) {
    const files = filesOwnedByTask(directory, tasksRoot, scan);
    tasks.push(
      buildTaskSource(projectRoot, tasksRoot, directory, files, findings),
    );
  }

  const ids = new Map<string, LegacyTaskSource[]>();
  for (const task of tasks) {
    if (
      typeof task.legacyTaskId.value !== "string" ||
      !task.legacyTaskId.value.trim()
    )
      continue;
    const group = ids.get(task.legacyTaskId.value) ?? [];
    group.push(task);
    ids.set(task.legacyTaskId.value, group);
  }
  for (const [id, duplicates] of ids) {
    if (duplicates.length < 2) continue;
    for (const duplicate of duplicates) {
      findings.push({
        code: "duplicate-task-id",
        severity: "blocker",
        sourcePath: duplicate.directory,
        detail: `legacy task ID ${id} appears in multiple source directories`,
      });
      duplicate.preflight = "blocked";
    }
  }

  const allFiles = tasks.flatMap((task) => task.files);
  const blockerCount = findings.filter(
    (finding) => finding.severity === "blocker",
  ).length;
  return {
    schemaVersion: 1,
    readOnly: true,
    wrote: false,
    projectRoot,
    tasksRoot,
    sourceFingerprint:
      !findings.some((finding) =>
        SOURCE_COMPLETENESS_FINDINGS.has(finding.code),
      ) && tasks.every((task) => task.sourceFingerprint !== null)
        ? fingerprintFiles(allFiles)
        : null,
    scannedTaskCount: tasks.length,
    scannedFileCount: allFiles.length,
    preflight: {
      status:
        blockerCount > 0
          ? "blocked"
          : tasks.length === 0
            ? "empty"
            : "clear-to-review",
      blockerCount,
    },
    migration: {
      status: "pending-v2-writer",
      targetWriter: "P35 Task/Run/Review",
      writesPlanned: false,
    },
    tasks,
    findings,
  };
}

function emptyBlockedPlan(
  projectRoot: string,
  tasksRoot: string,
  findings: LegacyMigrationFinding[],
): LegacyTaskMigrationPlan {
  return {
    schemaVersion: 1,
    readOnly: true,
    wrote: false,
    projectRoot,
    tasksRoot,
    sourceFingerprint: null,
    scannedTaskCount: 0,
    scannedFileCount: 0,
    preflight: {
      status: "blocked",
      blockerCount: findings.filter((finding) => finding.severity === "blocker")
        .length,
    },
    migration: {
      status: "pending-v2-writer",
      targetWriter: "P35 Task/Run/Review",
      writesPlanned: false,
    },
    tasks: [],
    findings,
  };
}
