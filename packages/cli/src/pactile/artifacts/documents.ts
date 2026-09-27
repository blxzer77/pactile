import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { TaskArtifactStageV1 } from "./types.js";

export type TaskArtifactDocumentStatusV1 = "present" | "absent";

export interface TaskArtifactDocumentSourceV1 {
  readonly kind: "task-document";
  /** Stable opaque URI for the stage's Markdown source set. */
  readonly ref: string;
}

export interface TaskArtifactDocumentProvenanceV1 {
  /** Read-only observation; no Markdown content is copied into the Kernel. */
  readonly method: "read-only-content-fingerprint";
}

export interface TaskArtifactDocumentLocatorV1 {
  /** Present Markdown paths, or expected paths when the stage is absent. */
  readonly paths: readonly string[];
  readonly selector: "markdown-content" | "markdown-files";
}

export type TaskArtifactDocumentSectionKindV1 =
  | "scope"
  | "decision"
  | "rationale"
  | "risk";

export interface TaskArtifactDocumentSectionReferenceV1 {
  /** Stable heading identity; it remains separate from Kernel fact IDs. */
  readonly id: string;
  readonly kind: TaskArtifactDocumentSectionKindV1;
  readonly title: string;
  readonly status: "present";
  readonly contentFingerprint: string;
  readonly source: TaskArtifactDocumentSourceV1;
  readonly provenance: TaskArtifactDocumentProvenanceV1;
  readonly ref: { readonly path: string; readonly selector: string };
}

export interface TaskArtifactDocumentReferenceV1 {
  /** Stable for a stage even when its document content changes. */
  readonly id: string;
  readonly stage: TaskArtifactStageV1;
  readonly status: TaskArtifactDocumentStatusV1;
  /** Hash of the observed Markdown path/content set; null when absent. */
  readonly contentFingerprint: string | null;
  readonly source: TaskArtifactDocumentSourceV1;
  readonly provenance: TaskArtifactDocumentProvenanceV1;
  readonly ref: TaskArtifactDocumentLocatorV1;
  /** Recognized decision/scope/risk headings, without copied body text. */
  readonly sections?: readonly TaskArtifactDocumentSectionReferenceV1[];
}

export interface TaskArtifactDocumentContentV1 {
  readonly document: TaskArtifactDocumentReferenceV1;
  /** Bodies appear only for explicitly selected documents. */
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}

export interface TaskArtifactDocumentSelectionV1 {
  readonly id: string;
  /** The fingerprint copied from an earlier index, or `absent` for no file. */
  readonly expectedFingerprint: string;
}

export interface TaskArtifactDocumentSectionSelectionV1 {
  readonly id: string;
  readonly expectedFingerprint: string;
}

export interface TaskArtifactDocumentSectionContentV1 {
  readonly section: TaskArtifactDocumentSectionReferenceV1;
  readonly content: string;
}

interface DocumentSpec {
  readonly stage: TaskArtifactStageV1;
  readonly id: string;
  readonly uriName: string;
  readonly expectedPaths: readonly string[];
  readonly selector: TaskArtifactDocumentLocatorV1["selector"];
  readonly optional?: boolean;
}

interface MarkdownFile {
  readonly path: string;
  readonly bytes: Buffer;
}

const DOCUMENT_SPECS: readonly DocumentSpec[] = [
  {
    stage: "prd",
    id: "document:prd",
    uriName: "prd",
    expectedPaths: ["prd.md"],
    selector: "markdown-content",
  },
  {
    stage: "design",
    id: "document:design",
    uriName: "design",
    expectedPaths: ["design.md"],
    selector: "markdown-content",
  },
  {
    stage: "implement",
    id: "document:implement",
    uriName: "implement",
    expectedPaths: ["implement.md"],
    selector: "markdown-content",
  },
  {
    stage: "review",
    id: "document:review",
    uriName: "review",
    expectedPaths: ["review.md", "review/"],
    selector: "markdown-files",
  },
  {
    stage: "verify",
    id: "document:verify",
    uriName: "verify",
    expectedPaths: ["verify.md"],
    selector: "markdown-content",
  },
  {
    stage: "prd",
    id: "document:legacy-task-map",
    uriName: "legacy-task-map",
    expectedPaths: ["task-map.md"],
    selector: "markdown-content",
    optional: true,
  },
  {
    stage: "implement",
    id: "document:legacy-handoff",
    uriName: "legacy-handoff",
    expectedPaths: ["handoff.md"],
    selector: "markdown-content",
    optional: true,
  },
];

const READ_ONLY_PROVENANCE: TaskArtifactDocumentProvenanceV1 = Object.freeze({
  method: "read-only-content-fingerprint",
});

function sourceTaskSegment(taskId: string): string {
  const sensitiveTerms = new Set([
    "credential",
    "credentials",
    "passwd",
    "password",
    "secret",
    "token",
  ]);
  const parts = taskId.split(/[._-]/u);
  if (!parts.some((part) => sensitiveTerms.has(part))) return taskId;
  return `task-${createHash("sha256").update(taskId).digest("hex").slice(0, 16)}`;
}

function relativePath(...segments: string[]): string {
  return segments.join("/");
}

function resolveTaskPath(taskDir: string, relative: string): string {
  const resolvedTaskDir = path.resolve(taskDir);
  const target = path.resolve(resolvedTaskDir, relative);
  const relativeToTask = path.relative(resolvedTaskDir, target);
  if (
    relativeToTask === ".." ||
    relativeToTask.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToTask)
  ) {
    throw new Error(
      `task document locator escapes the task directory: ${relative}`,
    );
  }
  return target;
}

function readRegularMarkdownFile(
  taskDir: string,
  relative: string,
): MarkdownFile | null {
  const target = resolveTaskPath(taskDir, relative);
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`task document is not a regular file: ${relative}`);
  }
  return { path: relative, bytes: fs.readFileSync(target) };
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readReviewDirectory(taskDir: string): MarkdownFile[] {
  const root = resolveTaskPath(taskDir, "review");
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat) return [];
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("task review path is not a regular directory: review/");
  }

  const files: MarkdownFile[] = [];
  const visit = (directory: string, relativeDirectory: string): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      comparePaths(left.name, right.name),
    )) {
      const relative = relativePath(relativeDirectory, entry.name);
      const target = resolveTaskPath(taskDir, relative);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `task review path contains a symbolic link: ${relative}`,
        );
      }
      if (stat.isDirectory()) {
        visit(target, relative);
      } else if (stat.isFile() && /\.md$/iu.test(entry.name)) {
        files.push({ path: relative, bytes: fs.readFileSync(target) });
      }
    }
  };

  visit(root, "review");
  return files;
}

function fingerprint(files: readonly MarkdownFile[]): string | null {
  if (!files.length) return null;
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    comparePaths(left.path, right.path),
  )) {
    hash.update(file.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(file.bytes.length), "utf8");
    hash.update("\0", "utf8");
    hash.update(file.bytes);
    hash.update("\0", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

function filesForSpec(taskDir: string, spec: DocumentSpec): MarkdownFile[] {
  if (spec.stage !== "review") {
    const expectedPath = spec.expectedPaths[0];
    if (!expectedPath) {
      throw new Error(`task artifact document path is missing: ${spec.stage}`);
    }
    const file = readRegularMarkdownFile(taskDir, expectedPath);
    return file ? [file] : [];
  }
  const reviewFile = readRegularMarkdownFile(taskDir, "review.md");
  const reviewDirectoryFiles = readReviewDirectory(taskDir);
  return [...(reviewFile ? [reviewFile] : []), ...reviewDirectoryFiles].sort(
    (left, right) => comparePaths(left.path, right.path),
  );
}

function documentSource(
  taskId: string,
  spec: DocumentSpec,
): TaskArtifactDocumentSourceV1 {
  return {
    kind: "task-document",
    ref: `artifact://tasks/${sourceTaskSegment(taskId)}/documents/${spec.uriName}`,
  };
}

function headingKind(
  stage: TaskArtifactStageV1,
  title: string,
): TaskArtifactDocumentSectionKindV1 | null {
  const prefix = title
    .trim()
    .replace(/\s*[:：—–-].*$/u, "")
    .toLowerCase()
    .replace(/[.!?。！？]+$/u, "")
    .trim();
  if (stage === "prd") {
    if (
      [
        "scope",
        "task scope",
        "in scope",
        "out of scope",
        "范围",
        "任务范围",
      ].includes(prefix)
    )
      return "scope";
    if (
      [
        "risk",
        "risks",
        "risk assessment",
        "risk mitigation",
        "风险",
        "风险评估",
        "风险缓解",
      ].includes(prefix)
    )
      return "risk";
    return null;
  }
  if (stage !== "design") return null;
  if (
    [
      "decision",
      "decisions",
      "design decision",
      "architecture decision",
      "决策",
      "设计决策",
      "架构决策",
    ].includes(prefix)
  )
    return "decision";
  if (
    [
      "rationale",
      "reason",
      "reasons",
      "trade-off",
      "tradeoffs",
      "trade-offs",
      "理由",
      "原因",
      "权衡",
      "取舍",
    ].includes(prefix)
  )
    return "rationale";
  if (
    [
      "risk",
      "risks",
      "risk assessment",
      "risk mitigation",
      "风险",
      "风险评估",
      "风险缓解",
    ].includes(prefix)
  )
    return "risk";
  return null;
}

function sectionFingerprint(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function indexedSections(
  files: readonly MarkdownFile[],
  spec: DocumentSpec,
  taskId: string,
): {
  refs: TaskArtifactDocumentSectionReferenceV1[];
  contents: Map<string, string>;
} {
  const refs: TaskArtifactDocumentSectionReferenceV1[] = [];
  const contents = new Map<string, string>();
  const counts = new Map<TaskArtifactDocumentSectionKindV1, number>();
  const source = documentSource(taskId, spec);
  const documentNamespace =
    spec.id === `document:${spec.stage}`
      ? ""
      : `${spec.id.slice("document:".length)}:`;
  for (const file of files) {
    const lines = file.bytes.toString("utf8").split(/\r?\n/u);
    const boundaries: { index: number; level: number; title: string }[] = [];
    const selectorCounts = new Map<string, number>();
    let fence: string | null = null;
    for (const [index, line] of lines.entries()) {
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/u);
      if (fenceMatch) {
        const marker = fenceMatch[1]?.[0] ?? "`";
        fence = fence === marker ? null : (fence ?? marker);
        continue;
      }
      if (fence) continue;
      const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/u);
      if (!heading) continue;
      const title = heading[2]?.trim() ?? "";
      boundaries.push({ index, level: heading[1]?.length ?? 1, title });
    }
    for (const boundary of boundaries) {
      const kind = headingKind(spec.stage, boundary.title);
      if (!kind) continue;
      const heading = { ...boundary, kind };
      const nextBoundary = boundaries.find(
        (candidate) =>
          candidate.index > heading.index && candidate.level <= heading.level,
      );
      const end = nextBoundary?.index ?? -1;
      const block = lines
        .slice(heading.index, end === -1 ? undefined : end)
        .join("\n");
      const occurrence = (counts.get(heading.kind) ?? 0) + 1;
      counts.set(heading.kind, occurrence);
      const id = `section:${spec.stage}:${documentNamespace}${heading.kind}${occurrence > 1 ? `-${occurrence}` : ""}`;
      const selectorBase = `heading:${
        heading.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, "-")
          .replace(/^-|-$/gu, "") || heading.kind
      }`;
      const selectorOccurrence = (selectorCounts.get(selectorBase) ?? 0) + 1;
      selectorCounts.set(selectorBase, selectorOccurrence);
      const selector =
        selectorOccurrence === 1
          ? selectorBase
          : `${selectorBase}:${selectorOccurrence}`;
      const reference: TaskArtifactDocumentSectionReferenceV1 = {
        id,
        kind: heading.kind,
        title: heading.title,
        status: "present",
        contentFingerprint: sectionFingerprint(block),
        source,
        provenance: READ_ONLY_PROVENANCE,
        ref: { path: file.path, selector },
      };
      refs.push(reference);
      contents.set(id, block);
    }
  }
  return { refs, contents };
}

/** Read stable document references and fingerprints without persisting them. */
export function readTaskArtifactDocumentIndexV1(
  taskDir: string,
  taskId: string,
): TaskArtifactDocumentReferenceV1[] {
  const root = path.resolve(taskDir);
  return DOCUMENT_SPECS.flatMap((spec): TaskArtifactDocumentReferenceV1[] => {
    const files = filesForSpec(root, spec);
    const present = files.length > 0;
    if (spec.optional && !present) return [];
    const paths = present
      ? files.map(({ path: filePath }) => filePath)
      : [...spec.expectedPaths];
    const sections = indexedSections(files, spec, taskId).refs;
    return [
      {
        id: spec.id,
        stage: spec.stage,
        status: present ? "present" : "absent",
        contentFingerprint: fingerprint(files),
        source: documentSource(taskId, spec),
        provenance: READ_ONLY_PROVENANCE,
        ref: { paths, selector: spec.selector },
        ...(sections.length ? { sections } : {}),
      },
    ];
  });
}

/** Read only explicitly selected document bodies, rejecting stale locators. */
export function readSelectedTaskArtifactDocumentsV1(
  taskDir: string,
  taskId: string,
  selections: readonly TaskArtifactDocumentSelectionV1[],
): TaskArtifactDocumentContentV1[] {
  const currentById = new Map<string, TaskArtifactDocumentReferenceV1>(
    readTaskArtifactDocumentIndexV1(taskDir, taskId).map((document) => [
      document.id,
      document,
    ]),
  );
  const uniqueSelections = new Map<string, TaskArtifactDocumentSelectionV1>();
  for (const selection of selections) {
    if (
      !selection.id ||
      (selection.expectedFingerprint !== "absent" &&
        !/^sha256:[a-f0-9]{64}$/u.test(selection.expectedFingerprint))
    ) {
      throw new Error("invalid expected task document fingerprint");
    }
    const previous = uniqueSelections.get(selection.id);
    if (
      previous &&
      previous.expectedFingerprint !== selection.expectedFingerprint
    ) {
      throw new Error(
        `conflicting expected document fingerprints: ${selection.id}`,
      );
    }
    uniqueSelections.set(selection.id, selection);
  }

  return [...uniqueSelections.values()].map((selection) => {
    const { id } = selection;
    const current = currentById.get(id);
    if (!current) {
      throw new Error(`unknown task artifact document: ${id}`);
    }
    const expectedFingerprint =
      selection.expectedFingerprint === "absent"
        ? null
        : selection.expectedFingerprint;
    if (current.contentFingerprint !== expectedFingerprint) {
      throw new Error(
        `task document locator is stale; re-read the artifact index: ${id}`,
      );
    }
    const spec = DOCUMENT_SPECS.find((candidate) => candidate.id === id);
    if (!spec) throw new Error(`unknown task artifact document: ${id}`);
    const files =
      current.status === "present"
        ? filesForSpec(path.resolve(taskDir), spec)
        : [];
    if (fingerprint(files) !== current.contentFingerprint) {
      throw new Error(`task document changed while it was being read: ${id}`);
    }
    return {
      document: current,
      files: files.map(({ path: filePath, bytes }) => ({
        path: filePath,
        content: bytes.toString("utf8"),
      })),
    };
  });
}

/** Read only selected recognized Markdown sections, rejecting stale section locators. */
export function readSelectedTaskArtifactDocumentSectionsV1(
  taskDir: string,
  taskId: string,
  selections: readonly TaskArtifactDocumentSectionSelectionV1[],
): TaskArtifactDocumentSectionContentV1[] {
  const current = readTaskArtifactDocumentIndexV1(taskDir, taskId);
  const byId = new Map(
    current.flatMap((document) =>
      (document.sections ?? []).map(
        (section) => [section.id, { document, section }] as const,
      ),
    ),
  );
  const seen = new Set<string>();
  return selections.flatMap((selection) => {
    if (seen.has(selection.id)) return [];
    seen.add(selection.id);
    if (!/^sha256:[a-f0-9]{64}$/u.test(selection.expectedFingerprint)) {
      throw new Error("invalid expected task document section fingerprint");
    }
    const match = byId.get(selection.id);
    if (!match)
      throw new Error(
        `unknown task artifact document section: ${selection.id}`,
      );
    if (match.section.contentFingerprint !== selection.expectedFingerprint) {
      throw new Error(
        `task document section is stale; re-read the artifact index: ${selection.id}`,
      );
    }
    const spec = DOCUMENT_SPECS.find(({ id }) => id === match.document.id);
    if (!spec)
      throw new Error(
        `unknown task artifact document section: ${selection.id}`,
      );
    const files = filesForSpec(path.resolve(taskDir), spec);
    const fresh = indexedSections(files, spec, taskId);
    const content = fresh.contents.get(selection.id);
    const freshReference = fresh.refs.find(({ id }) => id === selection.id);
    if (
      !content ||
      freshReference?.contentFingerprint !== match.section.contentFingerprint
    ) {
      throw new Error(
        `task document section changed while it was being read: ${selection.id}`,
      );
    }
    return [{ section: match.section, content }];
  });
}
