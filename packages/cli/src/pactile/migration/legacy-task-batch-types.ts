import { createHash } from "node:crypto";
import path from "node:path";

import {
  type LegacySourceFile,
  type LegacyTaskMigrationPlan,
} from "../../core/task/legacy-task-migration.js";
import {
  caseFoldComponent,
  normalizeRuntimeRelativePath,
} from "../runtime/paths.js";
export const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
export const STORAGE_RELATIVE = ".pactile/runtime/legacy-task-migrations";
export const JOURNAL_STATES = [
  "planned",
  "backed-up",
  "staged",
  "validated",
  "committed",
  "review",
] as const;
export const JOURNAL_EVENTS = [
  "planned",
  "source-backed-up",
  "targets-staged",
  "targets-validated",
  "authority-committed",
  "needs-review",
] as const;

export interface LegacyTaskBatchTargetFile {
  /** Relative to the immutable staged batch's files/ directory. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface LegacyTaskBatchRequest {
  readonly projectRoot: string;
  readonly plan: LegacyTaskMigrationPlan;
  /** Complete candidate payload, supplied by a future version-specific adapter. */
  readonly targets: readonly LegacyTaskBatchTargetFile[];
}

export interface LegacyTaskBatchValidationContext {
  readonly batchId: string;
  readonly generationId: string;
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
  readonly targets: readonly {
    readonly path: string;
    readonly fingerprint: string;
    readonly byteLength: number;
  }[];
}

export type LegacyTaskBatchPhase =
  | "source-backed-up"
  | "targets-staged"
  | "targets-validated"
  | "authority-committed";

export interface LegacyTaskBatchOptions {
  readonly dryRun?: boolean;
  /** No user-state write occurs unless this is true. */
  readonly approved?: boolean;
  readonly validateStaged?: (
    context: LegacyTaskBatchValidationContext,
  ) => boolean | Promise<boolean>;
  /** Progress hook, also useful to verify recovery at persisted boundaries. */
  readonly onPhase?: (phase: LegacyTaskBatchPhase) => void | Promise<void>;
  readonly occurredAt?: string;
}

export interface LegacyTaskBatchJournal {
  readonly schemaVersion: 1;
  readonly batchId: string;
  readonly generationId: string;
  readonly state: (typeof JOURNAL_STATES)[number];
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
  readonly planFingerprint: string;
  readonly expectedAuthorityFingerprint: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reason: string | null;
  readonly events: readonly {
    readonly sequence: number;
    readonly at: string;
    readonly event: (typeof JOURNAL_EVENTS)[number];
    readonly evidenceFingerprint: string;
  }[];
}

export interface LegacyTaskBatchAuthority {
  readonly schemaVersion: 1;
  readonly kind: "prepared-legacy-task-batch";
  /** The pointer exposes one fully verified Task import generation atomically. */
  readonly visibility: "active-v2";
  readonly batchId: string;
  readonly generationId: string;
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
  readonly committedAt: string;
}

export type LegacyTaskBatchResult =
  | {
      readonly status: "dry-run" | "cancelled";
      readonly batchId: string;
      readonly generationId: string;
      readonly sourceFingerprint: string;
      readonly targetFingerprint: string;
      readonly wrote: false;
      readonly journal: null;
    }
  | {
      readonly status: "completed";
      readonly resumed: boolean;
      readonly batchId: string;
      readonly generationId: string;
      readonly sourceFingerprint: string;
      readonly targetFingerprint: string;
      readonly wrote: boolean;
      readonly journal: LegacyTaskBatchJournal;
    }
  | {
      readonly status: "blocked" | "review" | "interrupted";
      readonly reason: string;
      readonly batchId: string | null;
      readonly generationId: string | null;
      readonly sourceFingerprint: string | null;
      readonly targetFingerprint: string | null;
      readonly wrote: boolean;
      readonly journal: LegacyTaskBatchJournal | null;
    };

export interface NormalizedTarget {
  readonly path: string;
  readonly bytes: Buffer;
  readonly fingerprint: string;
}

export interface NormalizedRequest {
  readonly projectRoot: string;
  readonly plan: LegacyTaskMigrationPlan;
  readonly targets: readonly NormalizedTarget[];
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
  readonly planFingerprint: string;
  readonly batchId: string;
  readonly generationId: string;
}

export interface JournalSnapshot {
  readonly journal: LegacyTaskBatchJournal;
  readonly fingerprint: string;
}

export interface AuthoritySnapshot {
  readonly authority: LegacyTaskBatchAuthority;
  readonly fingerprint: string;
}

export function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function bytesForSource(file: LegacySourceFile): Buffer {
  return file.encoding === "utf8"
    ? Buffer.from(file.content, "utf8")
    : Buffer.from(file.content, "base64");
}

export function fingerprintSources(
  plan: LegacyTaskMigrationPlan,
): string | null {
  const files = plan.tasks.flatMap((task) => task.files);
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )) {
    const bytes = bytesForSource(file);
    if (bytes.byteLength !== file.byteLength || digest(bytes) !== file.sha256)
      return null;
    hash.update(file.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(bytes.byteLength), "utf8");
    hash.update("\0", "utf8");
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

export function canonicalTargetPath(value: string): string {
  const normalized = normalizeRuntimeRelativePath(value);
  if (
    normalized.split("/").some((part) => part.toLowerCase() === "archive") &&
    !normalized.endsWith("/legacy-import.json")
  )
    throw new Error("archived-target-write-forbidden");
  return normalized;
}

export function normalizeRequest(
  request: LegacyTaskBatchRequest,
): NormalizedRequest | null {
  try {
    const projectRoot = path.resolve(request.projectRoot);
    const plan = request.plan;
    if (
      !path.isAbsolute(request.projectRoot) ||
      path.resolve(plan.projectRoot) !== projectRoot ||
      plan.tasksRoot !== path.join(projectRoot, ".pactile", "tasks") ||
      plan.readOnly !== true ||
      plan.wrote !== false ||
      plan.preflight.status !== "clear-to-review" ||
      plan.preflight.blockerCount !== 0 ||
      !FINGERPRINT.test(plan.sourceFingerprint ?? "") ||
      !Array.isArray(request.targets) ||
      request.targets.length === 0
    )
      return null;

    const sourceFingerprint = fingerprintSources(plan);
    if (
      !sourceFingerprint ||
      !plan.sourceFingerprint ||
      sourceFingerprint !== plan.sourceFingerprint
    )
      return null;
    const targets = request.targets
      .map((target): NormalizedTarget => {
        const targetPath = canonicalTargetPath(target.path);
        const bytes = Buffer.from(target.bytes);
        if (
          targetPath.split("/").some((part) => part.toLowerCase() === "archive")
        ) {
          const taskPath = targetPath.slice(0, -"/legacy-import.json".length);
          const source = plan.tasks.find(
            (task) => task.directory === taskPath && task.archivedByPath,
          );
          let record: unknown;
          try {
            record = JSON.parse(bytes.toString("utf8")) as unknown;
          } catch {
            throw new Error("archived-target-record-invalid");
          }
          if (
            !source ||
            !record ||
            typeof record !== "object" ||
            Array.isArray(record) ||
            (record as { status?: unknown }).status !==
              "archived-historical-only" ||
            (record as { taskPath?: unknown }).taskPath !== taskPath
          )
            throw new Error("archived-target-record-invalid");
        }
        return { path: targetPath, bytes, fingerprint: digest(bytes) };
      })
      .sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      );
    const foldedPaths = targets.map((target) =>
      target.path.split("/").map(caseFoldComponent).join("/"),
    );
    if (new Set(foldedPaths).size !== targets.length) return null;

    const targetFingerprint = digest(
      jsonBytes(
        targets.map(({ path: targetPath, bytes, fingerprint }) => ({
          path: targetPath,
          byteLength: bytes.byteLength,
          fingerprint,
        })),
      ),
    );
    const planFingerprint = digest(
      jsonBytes({ sourceFingerprint, targetFingerprint }),
    );
    const batchId = `legacy-${planFingerprint.slice("sha256:".length)}`;
    return {
      projectRoot,
      plan,
      targets,
      sourceFingerprint,
      targetFingerprint,
      planFingerprint,
      batchId,
      generationId: batchId,
    };
  } catch {
    return null;
  }
}
