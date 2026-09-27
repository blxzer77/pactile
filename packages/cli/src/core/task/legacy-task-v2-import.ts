/** Build a deterministic, source-preserving V2 import generation for P36. */

import { createHash } from "node:crypto";

import {
  deriveStateForPhase,
  type KernelAuditEvent,
} from "./kernel-contract.js";
import {
  type LegacyTaskMigrationPlan,
  type LegacyTaskSource,
} from "./legacy-task-migration.js";
import {
  TASK_DELIVERY_LEVELS,
  fingerprintTaskValue,
  parseTaskKernelSnapshotV2,
  type TaskAcceptanceCriterion,
  type TaskDefinitionV2,
  type TaskKernelEventV2,
  type TaskKernelSnapshotV2,
} from "./task-kernel.js";

const TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLACEHOLDER =
  /^(?:\[[ xX]\]\s*)?(?:tbd|todo|tba|n\/?a|to be determined|to be supplied|待补充|待定义|未定义|待确定|待完善)(?:[.!…]*)$/i;

export interface LegacyTaskV2ImportTarget {
  readonly path: string;
  readonly bytes: Buffer;
}

export interface LegacyTaskV2ImportSummary {
  readonly sourceFingerprint: string | null;
  readonly targets: readonly LegacyTaskV2ImportTarget[];
  readonly imported: number;
  readonly needsDefinition: number;
  readonly needsCoordination: number;
  readonly archived: number;
  readonly archivedTasks: readonly {
    readonly taskPath: string;
    readonly legacyTaskId: string;
    readonly missingDefinitionFields: readonly string[];
    readonly sourceFiles: readonly { path: string; fingerprint: string }[];
  }[];
  readonly diagnostics: readonly string[];
}

export interface LegacyTaskV2ReconciliationInput {
  readonly taskPath: string;
  /** Required when explicitly restoring an archived source into an active path. */
  readonly targetTaskPath?: string;
  /** Explicit replacement V2 identity for an invalid legacy slug. */
  readonly targetTaskId?: string;
  readonly idempotencyKey: string;
  readonly activationAt: string;
  /** Added by the transaction writer; callers must not choose this value. */
  readonly requestFingerprint?: string;
  readonly definition?: {
      readonly title?: string;
      readonly deliverable?: string;
      readonly deliveryLevel?: string;
      readonly createdAt?: string;
      readonly acceptanceCriteria?: readonly string[];
  };
  /** Explicitly acknowledge a malformed source Kernel before starting a fresh Define lifecycle. */
  readonly acknowledgeLegacyHistoryGap?: boolean;
  readonly dependencyResolutions?: readonly {
    readonly reference: string;
    readonly taskId: string;
  }[];
}

export interface LegacyTaskV2ReconciliationBuild {
  readonly targets: readonly LegacyTaskV2ImportTarget[];
  readonly diagnostics: readonly string[];
}

interface DependencyDeclaration {
  readonly owner: LegacyTaskSource | null;
  readonly ownerId: string | null;
  readonly references: readonly unknown[];
  readonly mode: {
    readonly state: "block" | "warn" | "off" | "conflict";
    readonly raw: readonly unknown[];
  };
  readonly source: string;
}

interface ChildMapEntry {
  id: string | null;
  dependsOn: unknown[];
  dependsMode: unknown;
  hasDependsOn: boolean;
  dependencyParseInvalid: boolean;
  dependsModeParseInvalid: boolean;
}

interface ParsedTaskMap {
  readonly entries: readonly ChildMapEntry[];
  readonly topLevelDependsOn: readonly unknown[];
  readonly hasTopLevelDependsOn: boolean;
  readonly topLevelDependsMode: unknown;
  readonly hasTopLevelDependsMode: boolean;
  readonly topLevelDependsParseInvalid: boolean;
  readonly topLevelDependsModeParseInvalid: boolean;
  readonly unsupported: boolean;
}

interface TaskImportAssessment {
  readonly source: LegacyTaskSource;
  readonly sourceTaskId: string;
  taskId: string;
  readonly hardDependencies: Set<string>;
  readonly dependencyDiagnostics: string[];
  readonly coordinationReasons: Set<string>;
  readonly legacyHistoryDiagnostics: string[];
  readonly missingDefinitionFields: Set<string>;
  title: string | null;
  description: string;
  deliverable: string | null;
  deliveryLevel: TaskDefinitionV2["deliveryLevel"] | null;
  createdAt: string | null;
  acceptanceCriteria: TaskAcceptanceCriterion[] | null;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function factValue(fact: { present: boolean; value?: unknown }): unknown {
  return fact.present ? fact.value : undefined;
}

function canonicalActiveTaskPath(value: string): string {
  if (
    !value ||
    value.length > 2048 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) throw new Error("legacy-task-reconciliation-target-path-invalid");
  const relative = value.startsWith(".pactile/tasks/")
    ? value.slice(".pactile/tasks/".length)
    : value;
  const parts = relative.split("/");
  if (
    parts.length === 0 ||
    parts.length > 32 ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.length > 255 ||
        part.toLowerCase() === "archive",
    )
  ) throw new Error("legacy-task-reconciliation-target-path-invalid");
  return `.pactile/tasks/${parts.join("/")}`;
}

function nonPlaceholder(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !PLACEHOLDER.test(value.trim())
  );
}

function parseModeFacts(
  facts: readonly { present: boolean; value?: unknown }[],
  additional: readonly { present: boolean; value?: unknown }[] = [],
): DependencyDeclaration["mode"] {
  const raw = [...facts, ...additional]
    .filter((item) => item.present)
    .map((item) => item.value);
  const normalized = raw.map((value) =>
    typeof value === "string" ? value.trim() : "invalid",
  );
  if (normalized.length === 0) return { state: "warn", raw };
  if (normalized.some((value) => !["block", "warn", "off"].includes(value))) {
    return { state: "conflict", raw };
  }
  if (new Set(normalized).size > 1) {
    return { state: normalized.includes("block") ? "conflict" : "warn", raw };
  }
  return { state: normalized[0] as "block" | "warn" | "off", raw };
}

function parseYamlScalar(value: string): string | null {
  const stripped = value.replace(/\s+#.*$/, "").trim();
  if (!stripped) return null;
  if (stripped.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(stripped);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (stripped.startsWith("'")) {
    if (!stripped.endsWith("'") || stripped.length < 2) return null;
    return stripped.slice(1, -1).replaceAll("''", "'");
  }
  if (/[:{}[\],&*!|>'"%@`]/.test(stripped)) return null;
  return stripped;
}

function parseYamlStringList(value: string): {
  valid: boolean;
  values: string[];
} {
  const trimmed = value.trim();
  if (trimmed === "[]") return { valid: true, values: [] };
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return { valid: false, values: [] };
  }
  const inner = trimmed.slice(1, -1);
  if (!inner.trim()) return { valid: true, values: [] };
  const pieces: string[] = [];
  let quote: "'" | '"' | null = null;
  let start = 0;
  for (let index = 0; index < inner.length; index++) {
    const char = inner.charAt(index);
    if (quote === '"' && char === "\\") {
      index++;
      continue;
    }
    if (quote === "'" && char === "'" && inner[index + 1] === "'") {
      index++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ",") {
      pieces.push(inner.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote) return { valid: false, values: [] };
  pieces.push(inner.slice(start).trim());
  const values = pieces.map(parseYamlScalar);
  if (values.some((item) => item === null)) return { valid: false, values: [] };
  return { valid: true, values: values as string[] };
}

/** Parse only the explicit simple frontmatter fields used by legacy Parent maps. */
function parseTaskMap(text: string): ParsedTaskMap {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) {
    return {
      entries: [],
      topLevelDependsOn: [],
      hasTopLevelDependsOn: false,
      topLevelDependsMode: undefined,
      hasTopLevelDependsMode: false,
      topLevelDependsParseInvalid: false,
      topLevelDependsModeParseInvalid: false,
      unsupported: true,
    };
  }
  const lines = (frontmatter[1] ?? "").split(/\r?\n/);
  const entries: ChildMapEntry[] = [];
  let current: ChildMapEntry | null = null;
  let inChildren = false;
  let unsupported = false;
  let topLevelDependsOn: unknown[] = [];
  let hasTopLevelDependsOn = false;
  let topLevelDependsParseInvalid = false;
  let topLevelDependsModeParseInvalid = false;
  let topLevelDependsMode: unknown;
  let hasTopLevelDependsMode = false;
  const parseListValue = (
    raw: string,
  ): { valid: boolean; values: string[] } => {
    if (raw.trim()) return parseYamlStringList(raw);
    return { valid: true, values: [] };
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const childHeader = line.match(/^\s{2}-\s+id:\s*(.*?)\s*$/);
    if (childHeader) {
      inChildren = true;
      current = {
        id: parseYamlScalar(childHeader[1] ?? ""),
        dependsOn: [],
        dependsMode: undefined,
        hasDependsOn: false,
        dependencyParseInvalid: false,
        dependsModeParseInvalid: false,
      };
      if (!current.id) unsupported = true;
      entries.push(current);
      continue;
    }
    if (/^\S/.test(line) && !line.startsWith(" ")) {
      current = null;
      inChildren = line.startsWith("children:");
      const topMode = line.match(/^depends_mode:\s*(.*?)\s*$/);
      if (topMode) {
        if (hasTopLevelDependsMode) {
          unsupported = true;
          topLevelDependsModeParseInvalid = true;
        }
        hasTopLevelDependsMode = true;
        topLevelDependsMode = parseYamlScalar(topMode[1] ?? "");
        if (topLevelDependsMode === null) {
          unsupported = true;
          topLevelDependsModeParseInvalid = true;
        }
      }
      const topDeps = line.match(/^depends_on:\s*(.*?)\s*$/);
      if (topDeps) {
        if (hasTopLevelDependsOn) {
          unsupported = true;
          topLevelDependsParseInvalid = true;
        }
        hasTopLevelDependsOn = true;
        const raw = topDeps[1] ?? "";
        let parsed = parseListValue(raw);
        if (!raw.trim()) {
          const nested: string[] = [];
          let lookahead = index + 1;
          while (lookahead < lines.length && /^\s{2}-\s+/.test(lines[lookahead] ?? "")) {
            const nestedLine = lines[lookahead] ?? "";
            const item = parseYamlScalar(nestedLine.replace(/^\s{2}-\s+/, ""));
            if (item === null) {
              unsupported = true;
              topLevelDependsParseInvalid = true;
            } else nested.push(item);
            lookahead++;
          }
          if (/^\s+-\s+/.test(lines[lookahead] ?? "")) {
            unsupported = true;
            topLevelDependsParseInvalid = true;
          }
          parsed = { valid: !topLevelDependsParseInvalid, values: nested };
          index = lookahead - 1;
        }
        if (!parsed.valid) {
          unsupported = true;
          topLevelDependsParseInvalid = true;
        }
        topLevelDependsOn = parsed.values;
      }
      if (!inChildren && !topMode && !topDeps && !/^\w[\w-]*\s*:/.test(line)) {
        unsupported = true;
      }
      continue;
    }
    if (!current || !inChildren) continue;
    const mode = line.match(/^\s{4}depends_mode:\s*(.*?)\s*$/);
    if (mode) {
      if (current.dependsMode !== undefined) {
        unsupported = true;
        current.dependsModeParseInvalid = true;
      }
      current.dependsMode = parseYamlScalar(mode[1] ?? "");
      if (current.dependsMode === null) {
        unsupported = true;
        current.dependsModeParseInvalid = true;
      }
      continue;
    }
    const dependency = line.match(/^\s{4}depends_on:\s*(.*?)\s*$/);
    if (dependency) {
      if (current.hasDependsOn) {
        unsupported = true;
        current.dependencyParseInvalid = true;
      }
      current.hasDependsOn = true;
      const raw = dependency[1] ?? "";
      if (raw.trim()) {
        const parsed = parseListValue(raw);
        if (!parsed.valid) {
          unsupported = true;
          current.dependencyParseInvalid = true;
        }
        current.dependsOn = parsed.values;
      } else {
        const nested: string[] = [];
        let lookahead = index + 1;
        while (
          lookahead < lines.length &&
          /^\s{6}-\s+/.test(lines[lookahead] ?? "")
        ) {
          const nestedLine = lines[lookahead] ?? "";
          const item = parseYamlScalar(
            nestedLine.replace(/^\s{6}-\s+/, ""),
          );
          if (item === null) {
            unsupported = true;
            current.dependencyParseInvalid = true;
          } else nested.push(item);
          lookahead++;
        }
        if (/^\s+-\s+/.test(lines[lookahead] ?? "")) {
          unsupported = true;
          current.dependencyParseInvalid = true;
        }
        current.dependsOn = nested;
      }
      continue;
    }
    if (/^\s{2}-\s+/.test(line)) continue;
    if (/^\s{4}[\w-]+\s*:/.test(line) || !line.trim()) continue;
    if (/^\s+/.test(line) && current.hasDependsOn) continue;
    unsupported = true;
  }
  return {
    entries,
    topLevelDependsOn,
    hasTopLevelDependsOn,
    topLevelDependsMode,
    hasTopLevelDependsMode,
    topLevelDependsParseInvalid,
    topLevelDependsModeParseInvalid,
    unsupported,
  };
}

function legacyId(task: LegacyTaskSource): string | null {
  return typeof task.legacyTaskId.value === "string"
    ? task.legacyTaskId.value
    : null;
}

function uniqueTaskForReference(
  reference: unknown,
  tasks: readonly LegacyTaskSource[],
): { task: LegacyTaskSource | null; reason: string | null } {
  if (typeof reference !== "string" || !reference.trim()) {
    return { task: null, reason: "invalid-reference" };
  }
  const value = reference.trim();
  if (value.toLowerCase().startsWith("pool:")) {
    return { task: null, reason: `pool-reference:${value}` };
  }
  const matches = tasks.filter(
    (task) => legacyId(task) === value || task.directoryName === value,
  );
  if (matches.length === 0)
    return { task: null, reason: `dangling-reference:${value}` };
  if (matches.length > 1)
    return { task: null, reason: `ambiguous-reference:${value}` };
  const task = matches[0];
  if (!task) return { task: null, reason: `dangling-reference:${value}` };
  if (task.archivedByPath)
    return { task: null, reason: `archived-reference:${value}` };
  const id = legacyId(task);
  if (!id || !TASK_ID.test(id))
    return { task: null, reason: `invalid-task-id:${value}` };
  return { task, reason: null };
}

function taskJsonDependencies(source: LegacyTaskSource): unknown[] {
  const raw = factValue(source.dependencies.taskJsonDependsOn);
  return Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
}

function taskMapDeclarations(
  tasks: readonly LegacyTaskSource[],
  byDirectory: Map<string, TaskImportAssessment>,
): DependencyDeclaration[] {
  const declarations: DependencyDeclaration[] = [];
  for (const parent of tasks) {
    if (!parent.taskMap) continue;
    const parsed = parseTaskMap(parent.taskMap.content);
    const parentAssessment = byDirectory.get(parent.directory);
    if (parsed.hasTopLevelDependsOn) {
      declarations.push({
        owner: parent,
        ownerId: legacyId(parent),
        references: parsed.topLevelDependsOn,
        mode: parseModeFacts(
          [
            parent.dependencies.topLevelDependsMode,
            parent.dependencies.metaDependsMode,
          ],
          parsed.hasTopLevelDependsMode
            ? [{ present: true, value: parsed.topLevelDependsMode }]
            : [],
        ),
        source: parent.taskMap.path,
      });
    }
    for (const entry of parsed.entries) {
      if (!entry.hasDependsOn) continue;
      const owners = tasks.filter(
        (task) =>
          legacyId(task) === entry.id || task.directoryName === entry.id,
      );
      const owner = owners.length === 1 ? (owners[0] ?? null) : null;
      const rowMode =
        entry.dependsMode === undefined
          ? []
          : [{ present: true, value: entry.dependsMode }];
      const declaration: DependencyDeclaration = {
        owner,
        ownerId: entry.id,
        references: entry.dependsOn,
        mode: owner
          ? parseModeFacts(
              [
                owner.dependencies.topLevelDependsMode,
                owner.dependencies.metaDependsMode,
              ],
              rowMode,
            )
          : parseModeFacts([], rowMode),
        source: parent.taskMap.path,
      };
      declarations.push(declaration);
      if (
        owners.length !== 1 &&
        declaration.mode.state !== "warn" &&
        declaration.mode.state !== "off"
      ) {
        parentAssessment?.coordinationReasons.add(
          `task-map-owner-${owners.length === 0 ? "unresolved" : "ambiguous"}:${String(entry.id)}`,
        );
      }
    }
    if (parsed.unsupported && parentAssessment) {
      parentAssessment.dependencyDiagnostics.push(
        `task-map-contains-unsupported-frontmatter:${parent.taskMap.path}`,
      );
    }
    if (parsed.topLevelDependsParseInvalid) {
      const mode = parseModeFacts(
        [
          parent.dependencies.topLevelDependsMode,
          parent.dependencies.metaDependsMode,
        ],
        parsed.hasTopLevelDependsMode
          ? [{ present: true, value: parsed.topLevelDependsMode }]
          : [],
      );
      if (mode.state === "block" || mode.state === "conflict") {
        parentAssessment?.coordinationReasons.add(
          "task-map-top-level-dependency-frontmatter-unparsed",
        );
      }
    }
    if (parsed.topLevelDependsModeParseInvalid) {
      parentAssessment?.coordinationReasons.add(
        "task-map-top-level-dependency-mode-unparsed",
      );
    }
    for (const entry of parsed.entries) {
      if (!entry.dependencyParseInvalid && !entry.dependsModeParseInvalid)
        continue;
      const owners = tasks.filter(
        (task) =>
          legacyId(task) === entry.id || task.directoryName === entry.id,
      );
      const owner = owners.length === 1 ? (owners[0] ?? null) : null;
      const ownerAssessment = owner ? byDirectory.get(owner.directory) : null;
      const rowMode =
        entry.dependsMode === undefined
          ? []
          : [{ present: true, value: entry.dependsMode }];
      const mode = owner
        ? parseModeFacts(
            [
              owner.dependencies.topLevelDependsMode,
              owner.dependencies.metaDependsMode,
            ],
            rowMode,
          )
        : parseModeFacts([], rowMode);
      if (mode.state === "warn" || mode.state === "off") {
        if (entry.dependsModeParseInvalid) {
          (ownerAssessment ?? parentAssessment)?.coordinationReasons.add(
            "task-map-dependency-mode-unparsed",
          );
          continue;
        }
        (ownerAssessment ?? parentAssessment)?.dependencyDiagnostics.push(
          `${mode.state}-task-map-dependency-frontmatter-unparsed:${parent.taskMap.path}`,
        );
        continue;
      }
      if (mode.state !== "block" && mode.state !== "conflict") continue;
      if (ownerAssessment) {
        ownerAssessment.coordinationReasons.add(
          "task-map-dependency-frontmatter-unparsed",
        );
      } else {
        parentAssessment?.coordinationReasons.add(
          `task-map-block-owner-${owners.length === 0 ? "unresolved" : "ambiguous"}:${String(entry.id)}`,
        );
      }
    }
  }
  return declarations;
}

function parsePrdAcceptanceCriteria(
  source: LegacyTaskSource,
): TaskAcceptanceCriterion[] | null {
  const prd = source.documents.find((file) => file.name === "prd.md");
  if (prd?.encoding !== "utf8") return null;
  const lines = prd.content.split(/\r?\n/);
  const headings = lines.flatMap((line, index) => {
    const match = line.match(
      /^(#{1,6})\s+(?:Acceptance Criteria|验收标准)\s*#*\s*$/i,
    );
    return match ? [{ index, level: (match[1] ?? "").length }] : [];
  });
  if (headings.length !== 1) return null;
  const section = headings[0];
  if (!section) return null;
  const content: string[] = [];
  for (let index = section.index + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const heading = line.match(/^(#{1,6})\s+/);
    if (heading && (heading[1] ?? "").length <= section.level) break;
    content.push(line);
  }
  const criteria: TaskAcceptanceCriterion[] = [];
  for (const line of content) {
    if (!line.trim() || /^\s*<!--/.test(line)) continue;
    const item = line.match(
      /^\s*(?:[-+*]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?(.*?)\s*$/,
    );
    if (!item) return null;
    const description = item[1] ?? "";
    if (!nonPlaceholder(description)) continue;
    const id = `legacy-ac-${criteria.length + 1}-${stableHash({ path: source.directory, description }).slice(0, 8)}`;
    criteria.push({ id, description });
  }
  return criteria.length ? criteria : null;
}

function assessmentFor(source: LegacyTaskSource): TaskImportAssessment {
  const taskId = legacyId(source) ?? "";
  const raw = source.rawTaskData ?? {};
  const title = nonPlaceholder(raw.title)
    ? raw.title
    : nonPlaceholder(raw.name)
      ? raw.name
      : null;
  const deliverable = nonPlaceholder(raw.deliverable) ? raw.deliverable : null;
  const deliveryLevel = TASK_DELIVERY_LEVELS.includes(
    raw.deliveryLevel as (typeof TASK_DELIVERY_LEVELS)[number],
  )
    ? (raw.deliveryLevel as TaskDefinitionV2["deliveryLevel"])
    : null;
  const acceptanceCriteria = parsePrdAcceptanceCriteria(source);
  const missingDefinitionFields = new Set<string>();
  if (!TASK_ID.test(taskId)) missingDefinitionFields.add("taskId");
  if (!title) missingDefinitionFields.add("title");
  if (!deliverable) missingDefinitionFields.add("deliverable");
  if (!deliveryLevel) missingDefinitionFields.add("deliveryLevel");
  if (!acceptanceCriteria) missingDefinitionFields.add("acceptanceCriteria");
  if (
    typeof raw.createdAt !== "string" ||
    !raw.createdAt.trim() ||
    Number.isNaN(Date.parse(raw.createdAt))
  ) {
    missingDefinitionFields.add("createdAt");
  }
  if (source.kernelJson?.parseError) {
    missingDefinitionFields.add("legacyHistoryGap");
  }
  return {
    source,
    sourceTaskId: taskId,
    taskId,
    hardDependencies: new Set(),
    dependencyDiagnostics: [],
    coordinationReasons: new Set(),
    legacyHistoryDiagnostics: source.kernelJson?.parseError
      ? [`legacy-kernel-unparsed:${source.kernelJson.file.path}`]
      : [],
    missingDefinitionFields,
    title,
    description: typeof raw.description === "string" ? raw.description : "",
    deliverable,
    deliveryLevel,
    createdAt:
      typeof raw.createdAt === "string" &&
      raw.createdAt.trim() !== "" &&
      !Number.isNaN(Date.parse(raw.createdAt))
        ? raw.createdAt
        : null,
    acceptanceCriteria,
  };
}

function applyReconciliationDefinition(
  assessment: TaskImportAssessment,
  input: LegacyTaskV2ReconciliationInput,
): void {
  const definition = input.definition ?? {};
  const keys = Object.keys(definition);
  if (keys.some((key) => !["title", "deliverable", "deliveryLevel", "createdAt", "acceptanceCriteria"].includes(key))) {
    throw new Error("legacy-task-reconciliation-definition-field-invalid");
  }
  const takeMissing = (field: string): void => {
    if (!assessment.missingDefinitionFields.has(field))
      throw new Error(`legacy-task-reconciliation-field-already-defined:${field}`);
    assessment.missingDefinitionFields.delete(field);
  };
  if (Object.hasOwn(definition, "title")) {
    if (!nonPlaceholder(definition.title))
      throw new Error("legacy-task-reconciliation-title-invalid");
    takeMissing("title");
    assessment.title = definition.title.trim();
  }
  if (Object.hasOwn(definition, "deliverable")) {
    if (!nonPlaceholder(definition.deliverable))
      throw new Error("legacy-task-reconciliation-deliverable-invalid");
    takeMissing("deliverable");
    assessment.deliverable = definition.deliverable.trim();
  }
  if (Object.hasOwn(definition, "deliveryLevel")) {
    if (!TASK_DELIVERY_LEVELS.includes(
      definition.deliveryLevel as (typeof TASK_DELIVERY_LEVELS)[number],
    )) throw new Error("legacy-task-reconciliation-delivery-level-invalid");
    takeMissing("deliveryLevel");
    assessment.deliveryLevel = definition.deliveryLevel as TaskDefinitionV2["deliveryLevel"];
  }
  if (Object.hasOwn(definition, "createdAt")) {
    if (typeof definition.createdAt !== "string" || Number.isNaN(Date.parse(definition.createdAt)))
      throw new Error("legacy-task-reconciliation-created-at-invalid");
    takeMissing("createdAt");
    assessment.createdAt = definition.createdAt;
  }
  if (Object.hasOwn(definition, "acceptanceCriteria")) {
    const supplied = definition.acceptanceCriteria;
    if (
      !Array.isArray(supplied) ||
      supplied.length === 0 ||
      supplied.some((criterion) => !nonPlaceholder(criterion))
    ) throw new Error("legacy-task-reconciliation-acceptance-criteria-invalid");
    takeMissing("acceptanceCriteria");
    assessment.acceptanceCriteria = supplied.map((description, index) => ({
      id: `legacy-ac-${index + 1}-${stableHash({ path: assessment.source.directory, description: description.trim() }).slice(0, 8)}`,
      description: description.trim(),
    }));
  }
  if (input.acknowledgeLegacyHistoryGap === true) {
    if (
      !assessment.legacyHistoryDiagnostics.length ||
      !assessment.missingDefinitionFields.has("legacyHistoryGap")
    ) throw new Error("legacy-task-reconciliation-history-gap-acknowledgement-not-required");
    assessment.missingDefinitionFields.delete("legacyHistoryGap");
  }
}

function explicitTaskJsonDeclaration(
  source: LegacyTaskSource,
): DependencyDeclaration | null {
  if (!source.dependencies.taskJsonDependsOn.present) return null;
  const references = taskJsonDependencies(source);
  const raw = factValue(source.dependencies.taskJsonDependsOn);
  const malformed = raw !== undefined && !Array.isArray(raw);
  return {
    owner: source,
    ownerId: legacyId(source),
    references: malformed ? [raw] : references,
    mode: parseModeFacts([
      source.dependencies.topLevelDependsMode,
      source.dependencies.metaDependsMode,
    ]),
    source: source.taskJson?.file.path ?? `${source.directory}/task.json`,
  };
}

function addDependencyDeclarations(
  declaration: DependencyDeclaration,
  tasks: readonly LegacyTaskSource[],
  byDirectory: Map<string, TaskImportAssessment>,
  explicitResolutions: ReadonlyMap<string, LegacyTaskSource> = new Map(),
  externalResolutions: ReadonlyMap<string, string> = new Map(),
): void {
  const owner = declaration.owner
    ? byDirectory.get(declaration.owner.directory)
    : null;
  if (!owner) return;
  if (declaration.mode.state === "warn" || declaration.mode.state === "off") {
    if (declaration.references.length) {
      owner.dependencyDiagnostics.push(
        `${declaration.mode.state}-mode-preserved:${declaration.source}`,
      );
      for (const reference of declaration.references) {
        const resolved = uniqueTaskForReference(reference, tasks);
        if (resolved.reason) {
          owner.dependencyDiagnostics.push(
            `${declaration.mode.state}-${resolved.reason}:${declaration.source}`,
          );
        }
      }
    }
    return;
  }
  if (declaration.mode.state === "conflict") {
    owner.coordinationReasons.add(
      `depends-mode-conflict:${declaration.source}`,
    );
    return;
  }
  for (const reference of declaration.references) {
    const resolutionKey = `${declaration.source}\0${typeof reference === "string" ? reference.trim() : String(reference)}`;
    const externalId = externalResolutions.get(resolutionKey);
    if (externalId) {
      if (externalId === owner.taskId) owner.coordinationReasons.add(`dependency-self-cycle:${externalId}`);
      else owner.hardDependencies.add(externalId);
      continue;
    }
    const resolved = explicitResolutions.has(resolutionKey)
      ? { task: explicitResolutions.get(resolutionKey) ?? null, reason: null }
      : uniqueTaskForReference(reference, tasks);
    if (!resolved.task || resolved.reason) {
      owner.coordinationReasons.add(
        `${resolved.reason ?? "dependency-unresolved"}:${declaration.source}`,
      );
      continue;
    }
    const dependencyId = legacyId(resolved.task);
    if (!dependencyId) {
      owner.coordinationReasons.add(
        `dependency-id-missing:${declaration.source}`,
      );
      continue;
    }
    if (dependencyId === owner.taskId) {
      owner.coordinationReasons.add(`dependency-self-cycle:${dependencyId}`);
      continue;
    }
    owner.hardDependencies.add(dependencyId);
  }
}

function markHardDependencyCycles(
  assessments: readonly TaskImportAssessment[],
): void {
  const byId = new Map(
    assessments.map((assessment) => [assessment.taskId, assessment]),
  );
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (taskId: string): void => {
    const current = byId.get(taskId);
    if (!current) return;
    if (state.get(taskId) === 1) {
      const start = stack.lastIndexOf(taskId);
      for (const cycleId of stack.slice(Math.max(0, start))) {
        byId
          .get(cycleId)
          ?.coordinationReasons.add(`hard-dependency-cycle:${taskId}`);
      }
      return;
    }
    if (state.get(taskId) === 2) return;
    state.set(taskId, 1);
    stack.push(taskId);
    for (const dependencyId of current.hardDependencies) visit(dependencyId);
    stack.pop();
    state.set(taskId, 2);
  };
  for (const taskId of byId.keys()) visit(taskId);
}

function importedSnapshot(
  assessment: TaskImportAssessment,
  sourceFingerprint: string,
  activationAt?: string,
): TaskKernelSnapshotV2 {
  if (
    !assessment.title ||
    !assessment.deliverable ||
    !assessment.deliveryLevel ||
    !assessment.acceptanceCriteria
  ) {
    throw new Error("legacy-task-import-definition-missing");
  }
  const raw = assessment.source.rawTaskData ?? {};
  const createdAt = assessment.createdAt;
  if (!createdAt) throw new Error("legacy-task-import-created-at-missing");
  const eventAt = activationAt ?? createdAt;
  const actor = nonPlaceholder(raw.creator)
    ? raw.creator
    : "pactile-legacy-migration";
  const definition: TaskDefinitionV2 = {
    taskId: assessment.taskId,
    title: assessment.title,
    description: assessment.description,
    deliverable: assessment.deliverable,
    deliveryLevel: assessment.deliveryLevel,
    acceptanceCriteria: assessment.acceptanceCriteria,
    dependencies: [...assessment.hardDependencies].sort(),
    createdAt,
    createdBy: actor,
  };
  const idempotencyKey = `legacy-import:${sourceFingerprint}:${assessment.taskId}`;
  const requestFingerprint = fingerprintTaskValue({
    sourceFingerprint,
    taskPath: assessment.source.directory,
    definition,
  });
  const eventId = `legacy-import-${stableHash({ sourceFingerprint, taskId: assessment.taskId }).slice(0, 32)}`;
  const state = deriveStateForPhase("define");
  const event: TaskKernelEventV2 = {
    id: eventId,
    revision: 1,
    at: eventAt,
    actor: "pactile-legacy-migration",
    idempotencyKey,
    type: "task.created",
    entityId: assessment.taskId,
    requestFingerprint,
  };
  const audit: KernelAuditEvent = {
    id: eventId,
    at: eventAt,
    actor: "pactile-legacy-migration",
    idempotencyKey,
    evidence: `Imported legacy Task source ${sourceFingerprint}; historical lifecycle evidence remains in the immutable source snapshot.`,
    from: { ...state, revision: 0 },
    to: { ...state, revision: 1 },
  };
  return parseTaskKernelSnapshotV2({
    schemaVersion: 2,
    identity: { taskId: assessment.taskId },
    revision: 1,
    ...state,
    definition,
    runs: [],
    reviews: [],
    closure: null,
    audit: [audit],
    events: [event],
  });
}

function importRecord(
  assessment: TaskImportAssessment,
  sourceFingerprint: string,
  statusOverride?: "archived-historical-only",
): Record<string, unknown> {
  const dependencies = assessment.source.dependencies;
  const modeFacts = [
    dependencies.topLevelDependsMode,
    dependencies.metaDependsMode,
  ]
    .filter((item) => item.present)
    .map((item) => item.value);
  const status = assessment.coordinationReasons.size
    ? "needs-coordination"
    : assessment.missingDefinitionFields.size
      ? "needs-definition"
      : "imported";
  const taskJson = assessment.source.taskJson?.file;
  const taskMap = assessment.source.taskMap;
  return {
    schemaVersion: 1,
    kind: "legacy-task-import-record",
    status: statusOverride ?? status,
    taskPath: assessment.source.directory,
    legacyTaskId: assessment.sourceTaskId,
    sourceFingerprint,
    sourceFiles: assessment.source.files.map((file) => ({
      path: file.path,
      fingerprint: file.sha256,
    })),
    legacySourceMetadata: {
      parent: assessment.source.parent,
      children: assessment.source.children,
      typeMarkers: assessment.source.typeMarkers,
      fileReferences: {
        taskJson: taskJson
          ? { path: taskJson.path, fingerprint: taskJson.sha256 }
          : null,
        taskMap: taskMap
          ? { path: taskMap.path, fingerprint: taskMap.sha256 }
          : null,
      },
    },
    historicalStatus: assessment.source.status,
    dependencyFacts: {
      taskJsonDependsOn: dependencies.taskJsonDependsOn,
      topLevelDependsMode: dependencies.topLevelDependsMode,
      metaDependsMode: dependencies.metaDependsMode,
      hardDependencies: [...assessment.hardDependencies].sort(),
      diagnostics: [
        ...assessment.dependencyDiagnostics,
        ...assessment.coordinationReasons,
      ].sort(),
      rawModes: modeFacts,
    },
    legacyHistoryDiagnostics: [...assessment.legacyHistoryDiagnostics].sort(),
    missingDefinitionFields: [...assessment.missingDefinitionFields].sort(),
    coordinationReasons: [...assessment.coordinationReasons].sort(),
  };
}

/**
 * Convert the scan into one complete staged generation. The original Task,
 * Kernel, Parent map and docs remain untouched; incomplete/cyclic/uncertain
 * tasks get explicit reconciliation records and no runnable V2 Kernel.
 */
export function buildLegacyTaskV2Import(
  plan: LegacyTaskMigrationPlan,
): LegacyTaskV2ImportSummary {
  if (plan.preflight.status !== "clear-to-review" || !plan.sourceFingerprint) {
    return {
      sourceFingerprint: plan.sourceFingerprint,
      targets: [],
      imported: 0,
      needsDefinition: 0,
      needsCoordination: 0,
      archived: plan.tasks.filter((task) => task.archivedByPath).length,
      archivedTasks: [],
      diagnostics: ["legacy-task-preflight-blocked"],
    };
  }
  const active = plan.tasks.filter((task) => !task.archivedByPath);
  const assessments = active.map(assessmentFor);
  const byDirectory = new Map(
    assessments.map((item) => [item.source.directory, item]),
  );
  const declarations = active.flatMap((task) => {
    const jsonDeclaration = explicitTaskJsonDeclaration(task);
    return jsonDeclaration ? [jsonDeclaration] : [];
  });
  declarations.push(...taskMapDeclarations(plan.tasks, byDirectory));
  for (const declaration of declarations)
    addDependencyDeclarations(declaration, plan.tasks, byDirectory);
  markHardDependencyCycles(assessments);

  const archivedAssessments = plan.tasks
    .filter((task) => task.archivedByPath)
    .map(assessmentFor);
  const archivedTasks = archivedAssessments.map((assessment) => ({
    taskPath: assessment.source.directory,
    legacyTaskId: assessment.sourceTaskId,
    missingDefinitionFields: [...assessment.missingDefinitionFields].sort(),
    sourceFiles: assessment.source.files.map((file) => ({
      path: file.path,
      fingerprint: file.sha256,
    })),
  }));
  const targets: LegacyTaskV2ImportTarget[] = [];
  for (const assessment of archivedAssessments) {
    targets.push({
      path: `${assessment.source.directory}/legacy-import.json`,
      bytes: jsonBytes(
        importRecord(assessment, plan.sourceFingerprint, "archived-historical-only"),
      ),
    });
  }
  const diagnostics: string[] = [];
  let imported = 0;
  let needsDefinition = 0;
  let needsCoordination = 0;
  for (const assessment of assessments) {
    const relative = assessment.source.directory;
    const root = relative;
    const migrationStatus = assessment.coordinationReasons.size
      ? "needs-coordination"
      : assessment.missingDefinitionFields.size
        ? "needs-definition"
        : "imported";
    const metadata = importRecord(assessment, plan.sourceFingerprint);
    targets.push({
      path: `${root}/legacy-import.json`,
      bytes: jsonBytes(metadata),
    });
    if (migrationStatus === "imported") {
      try {
        const kernel = importedSnapshot(assessment, plan.sourceFingerprint);
        targets.push({
          path: `${root}/kernel.json`,
          bytes: jsonBytes(kernel),
        });
        imported++;
      } catch (error) {
        const reason = `invalid-v2-definition:${relative}:${error instanceof Error ? error.message : String(error)}`;
        assessment.missingDefinitionFields.add("definition-validation");
        diagnostics.push(reason);
        const updatedMetadata = importRecord(
          assessment,
          plan.sourceFingerprint,
        );
        targets[targets.length - 1] = {
          path: `${root}/legacy-import.json`,
          bytes: jsonBytes(updatedMetadata),
        };
        needsDefinition++;
      }
    } else if (migrationStatus === "needs-definition") {
      needsDefinition++;
    } else {
      needsCoordination++;
      diagnostics.push(...assessment.coordinationReasons);
    }
  }
  targets.sort((left, right) => left.path.localeCompare(right.path));
  return {
    sourceFingerprint: plan.sourceFingerprint,
    targets,
    imported,
    needsDefinition,
    needsCoordination,
    archived: plan.tasks.filter((task) => task.archivedByPath).length,
    archivedTasks,
    diagnostics: [...new Set(diagnostics)].sort(),
  };
}

/**
 * Build one explicit, non-historical V2 activation for a previously held Task.
 * This builder never changes the source scan and refuses to emit a kernel while
 * any required definition field or blocking dependency remains unresolved.
 */
export function buildLegacyTaskV2Reconciliation(
  plan: LegacyTaskMigrationPlan,
  input: LegacyTaskV2ReconciliationInput,
  options: { readonly externalDependencyIds?: ReadonlySet<string> } = {},
): LegacyTaskV2ReconciliationBuild {
  if (
    plan.preflight.status !== "clear-to-review" ||
    !plan.sourceFingerprint ||
    !input.idempotencyKey.trim() ||
    Number.isNaN(Date.parse(input.activationAt))
  ) throw new Error("legacy-task-reconciliation-preflight-blocked");
  const source = plan.tasks.find((task) => task.directory === input.taskPath);
  if (!source)
    throw new Error("legacy-task-reconciliation-task-not-found");
  const active = plan.tasks.filter((task) => !task.archivedByPath);
  const targetTaskPath = input.targetTaskPath
    ? canonicalActiveTaskPath(input.targetTaskPath)
    : source.directory;
  const isArchivedSource = source.archivedByPath;
  const isInterruptedSource = Boolean(source.kernelJson?.parseError);
  const requiresSeparateTarget =
    isArchivedSource ||
    isInterruptedSource && input.acknowledgeLegacyHistoryGap === true;
  if (
    requiresSeparateTarget && !input.targetTaskPath ||
    !requiresSeparateTarget && input.targetTaskPath && targetTaskPath !== source.directory ||
    isInterruptedSource && input.acknowledgeLegacyHistoryGap !== true && input.targetTaskPath !== undefined ||
    targetTaskPath.split("/").some((part) => part.toLowerCase() === "archive") ||
    plan.tasks.some((task) => task.directory === targetTaskPath && targetTaskPath !== source.directory)
  ) throw new Error("legacy-task-reconciliation-target-path-invalid");
  const assessments = [
    ...active.map((task) => assessmentFor(task)),
    ...(isArchivedSource ? [assessmentFor(source)] : []),
  ];
  const byDirectory = new Map(assessments.map((item) => [item.source.directory, item]));
  const finalAssessment = byDirectory.get(source.directory);
  if (!finalAssessment)
    throw new Error("legacy-task-reconciliation-task-id-invalid");
  const legacyTaskIdIsInvalid = finalAssessment.missingDefinitionFields.has("taskId");
  if (input.targetTaskId !== undefined) {
    if (!legacyTaskIdIsInvalid || !TASK_ID.test(input.targetTaskId))
      throw new Error("legacy-task-reconciliation-target-task-id-invalid");
    finalAssessment.taskId = input.targetTaskId;
    finalAssessment.missingDefinitionFields.delete("taskId");
  } else if (legacyTaskIdIsInvalid) {
    throw new Error("legacy-task-reconciliation-task-id-invalid");
  }
  applyReconciliationDefinition(finalAssessment, input);
  const dependencySources = isArchivedSource ? [...active, source] : active;
  const declarations = dependencySources.flatMap((task) => {
    const jsonDeclaration = explicitTaskJsonDeclaration(task);
    return jsonDeclaration ? [jsonDeclaration] : [];
  });
  declarations.push(...taskMapDeclarations(plan.tasks, byDirectory));

  const selectedDeclaration = (declaration: DependencyDeclaration): boolean =>
    declaration.owner?.directory === source.directory;
  const explicitResolutions = new Map<string, LegacyTaskSource>();
  const explicitExternalResolutions = new Map<string, string>();
  const seenReferences = new Set<string>();
  for (const item of input.dependencyResolutions ?? []) {
    if (
      typeof item.reference !== "string" || !item.reference.trim() ||
      typeof item.taskId !== "string" || !TASK_ID.test(item.taskId)
    ) throw new Error("legacy-task-reconciliation-dependency-resolution-invalid");
    const matching = declarations.filter((declaration) => {
      if (!selectedDeclaration(declaration) || declaration.mode.state !== "block") return false;
      return declaration.references.some((reference) =>
        typeof reference === "string" && reference.trim() === item.reference.trim() &&
        uniqueTaskForReference(reference, plan.tasks).reason !== null,
      );
    });
    if (matching.length !== 1)
      throw new Error(`legacy-task-reconciliation-dependency-resolution-not-unique:${item.reference}`);
    const declaration = matching[0];
    if (!declaration) throw new Error("legacy-task-reconciliation-dependency-resolution-invalid");
    const resolutionKey = `${declaration.source}\0${item.reference.trim()}`;
    if (seenReferences.has(resolutionKey))
      throw new Error(`legacy-task-reconciliation-dependency-resolution-duplicate:${item.reference}`);
    seenReferences.add(resolutionKey);
    const targets = active.filter((task) => legacyId(task) === item.taskId);
    if (targets.length > 1)
      throw new Error(`legacy-task-reconciliation-dependency-target-not-unique:${item.taskId}`);
    if (targets.length === 1) {
      explicitResolutions.set(resolutionKey, targets[0] as LegacyTaskSource);
    } else if (options.externalDependencyIds?.has(item.taskId)) {
      explicitExternalResolutions.set(resolutionKey, item.taskId);
    } else {
      throw new Error(`legacy-task-reconciliation-dependency-target-not-unique:${item.taskId}`);
    }
  }

  for (const declaration of declarations)
    addDependencyDeclarations(declaration, plan.tasks, byDirectory, explicitResolutions, explicitExternalResolutions);
  markHardDependencyCycles(assessments);
  const reconciledAssessment = byDirectory.get(source.directory);
  if (!reconciledAssessment) throw new Error("legacy-task-reconciliation-assessment-missing");
  if (reconciledAssessment.coordinationReasons.size)
    throw new Error(`legacy-task-reconciliation-needs-coordination:${[...reconciledAssessment.coordinationReasons].sort().join(",")}`);
  if (reconciledAssessment.missingDefinitionFields.size)
    throw new Error(`legacy-task-reconciliation-needs-definition:${[...reconciledAssessment.missingDefinitionFields].sort().join(",")}`);

  const resolvedDependencies = [...(input.dependencyResolutions ?? [])].map((item) => ({
    reference: item.reference.trim(),
    taskId: item.taskId,
  }));
  if (isInterruptedSource && input.acknowledgeLegacyHistoryGap !== true)
    throw new Error("legacy-task-reconciliation-history-gap-acknowledgement-required");
  const record = importRecord(reconciledAssessment, plan.sourceFingerprint);
  record.taskPath = targetTaskPath;
  record.reconciliation = {
    schemaVersion: 1,
    kind: "explicit-legacy-task-reconciliation",
    activationAt: input.activationAt,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: input.requestFingerprint ?? null,
    suppliedDefinition: input.definition ?? {},
    ...(input.targetTaskId ? { mappedTaskId: input.targetTaskId } : {}),
    ...(input.acknowledgeLegacyHistoryGap === true
      ? { acknowledgedLegacyHistoryGap: true }
      : {}),
    resolvedDependencies,
    historyPolicy: "legacy-lifecycle-remains-source-only",
  };
  const kernel = importedSnapshot(reconciledAssessment, plan.sourceFingerprint, input.activationAt);
  const root = targetTaskPath;
  return {
    targets: [
      { path: `${root}/legacy-import.json`, bytes: jsonBytes(record) },
      { path: `${root}/kernel.json`, bytes: jsonBytes(kernel) },
    ].sort((left, right) => left.path.localeCompare(right.path)),
    diagnostics: [],
  };
}
