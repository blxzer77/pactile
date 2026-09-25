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

export interface TaskArtifactDocumentReferenceV1 {
  /** Stable for a stage even when its document content changes. */
  readonly id: `document:${TaskArtifactStageV1}`;
  readonly stage: TaskArtifactStageV1;
  readonly status: TaskArtifactDocumentStatusV1;
  /** Hash of the observed Markdown path/content set; null when absent. */
  readonly contentFingerprint: string | null;
  readonly source: TaskArtifactDocumentSourceV1;
  readonly provenance: TaskArtifactDocumentProvenanceV1;
  readonly ref: TaskArtifactDocumentLocatorV1;
}

export interface TaskArtifactDocumentContentV1 {
  readonly document: TaskArtifactDocumentReferenceV1;
  /** Bodies appear only for explicitly selected documents. */
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}

interface DocumentSpec {
  readonly stage: TaskArtifactStageV1;
  readonly expectedPaths: readonly string[];
  readonly selector: TaskArtifactDocumentLocatorV1["selector"];
}

interface MarkdownFile {
  readonly path: string;
  readonly bytes: Buffer;
}

const DOCUMENT_SPECS: readonly DocumentSpec[] = [
  { stage: "prd", expectedPaths: ["prd.md"], selector: "markdown-content" },
  {
    stage: "design",
    expectedPaths: ["design.md"],
    selector: "markdown-content",
  },
  {
    stage: "implement",
    expectedPaths: ["implement.md"],
    selector: "markdown-content",
  },
  {
    stage: "review",
    expectedPaths: ["review.md", "review/"],
    selector: "markdown-files",
  },
  {
    stage: "verify",
    expectedPaths: ["verify.md"],
    selector: "markdown-content",
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

/** Read stable document references and fingerprints without persisting them. */
export function readTaskArtifactDocumentIndexV1(
  taskDir: string,
  taskId: string,
): TaskArtifactDocumentReferenceV1[] {
  const root = path.resolve(taskDir);
  return DOCUMENT_SPECS.map((spec): TaskArtifactDocumentReferenceV1 => {
    const files = filesForSpec(root, spec);
    const present = files.length > 0;
    const paths = present
      ? files.map(({ path: filePath }) => filePath)
      : [...spec.expectedPaths];
    return {
      id: `document:${spec.stage}`,
      stage: spec.stage,
      status: present ? "present" : "absent",
      contentFingerprint: fingerprint(files),
      source: {
        kind: "task-document",
        ref: `artifact://tasks/${sourceTaskSegment(taskId)}/documents/${spec.stage}`,
      },
      provenance: READ_ONLY_PROVENANCE,
      ref: { paths, selector: spec.selector },
    };
  });
}

/** Read only explicitly selected document bodies, rejecting stale locators. */
export function readSelectedTaskArtifactDocumentsV1(
  taskDir: string,
  taskId: string,
  indexedDocuments: readonly TaskArtifactDocumentReferenceV1[],
  selectedIds: readonly string[],
): TaskArtifactDocumentContentV1[] {
  const currentById = new Map<string, TaskArtifactDocumentReferenceV1>(
    readTaskArtifactDocumentIndexV1(taskDir, taskId).map((document) => [
      document.id,
      document,
    ]),
  );
  const indexedById = new Map<string, TaskArtifactDocumentReferenceV1>(
    indexedDocuments.map((document) => [document.id, document]),
  );

  return [...new Set(selectedIds)].map((id) => {
    const indexed = indexedById.get(id);
    if (!indexed) throw new Error(`unknown task artifact document: ${id}`);
    const current = currentById.get(id);
    if (!current || JSON.stringify(indexed) !== JSON.stringify(current)) {
      throw new Error(
        `task document locator is stale; re-read the artifact index: ${id}`,
      );
    }
    const spec = DOCUMENT_SPECS.find(({ stage }) => `document:${stage}` === id);
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
