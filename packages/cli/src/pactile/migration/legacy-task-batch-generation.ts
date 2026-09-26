import path from "node:path";

import {
  assertCanonicalWriteTarget,
  caseFoldComponent,
} from "../runtime/paths.js";
import {
  FINGERPRINT,
  canonicalTargetPath,
  digest,
  jsonBytes,
  type NormalizedRequest,
} from "./legacy-task-batch-types.js";
import {
  ensureDirectory,
  readRegularFile,
  storagePath,
  writeExclusive,
} from "./legacy-task-batch-io.js";
import { listFiles } from "./legacy-task-batch-source.js";
export interface GenerationManifest {
  readonly schemaVersion: 1;
  readonly kind: "legacy-task-staged-generation";
  readonly batchId: string;
  readonly generationId: string;
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
  readonly files: readonly {
    readonly path: string;
    readonly byteLength: number;
    readonly fingerprint: string;
  }[];
  readonly createdAt: string;
}

export function generationDirectory(
  projectRoot: string,
  generationId: string,
): string {
  return storagePath(projectRoot, "generations", generationId);
}

export function stageTargets(
  request: NormalizedRequest,
  createdAt: string,
): void {
  const directory = generationDirectory(
    request.projectRoot,
    request.generationId,
  );
  ensureDirectory(request.projectRoot, directory);
  for (const target of request.targets) {
    const absolute = assertCanonicalWriteTarget(
      request.projectRoot,
      path.join(directory, "files", target.path),
    );
    ensureDirectory(request.projectRoot, path.dirname(absolute));
    writeExclusive(request.projectRoot, absolute, target.bytes);
  }
  const manifest: GenerationManifest = {
    schemaVersion: 1,
    kind: "legacy-task-staged-generation",
    batchId: request.batchId,
    generationId: request.generationId,
    sourceFingerprint: request.sourceFingerprint,
    targetFingerprint: request.targetFingerprint,
    files: request.targets.map((target) => ({
      path: target.path,
      byteLength: target.bytes.byteLength,
      fingerprint: target.fingerprint,
    })),
    createdAt,
  };
  writeExclusive(
    request.projectRoot,
    path.join(directory, "manifest.json"),
    jsonBytes(manifest),
  );
  verifyGeneration(request.projectRoot, request.generationId, {
    batchId: request.batchId,
    sourceFingerprint: request.sourceFingerprint,
    targetFingerprint: request.targetFingerprint,
  });
}

export function verifyGeneration(
  projectRoot: string,
  generationId: string,
  expected: {
    readonly batchId: string;
    readonly sourceFingerprint: string;
    readonly targetFingerprint: string;
  },
): GenerationManifest {
  const directory = generationDirectory(projectRoot, generationId);
  const manifestBytes = readRegularFile(
    projectRoot,
    path.join(directory, "manifest.json"),
  );
  if (!manifestBytes) throw new Error("migration-generation-invalid");
  let value: unknown;
  try {
    value = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("migration-generation-invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("migration-generation-invalid");
  const manifest = value as Partial<GenerationManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "legacy-task-staged-generation" ||
    manifest.batchId !== expected.batchId ||
    manifest.generationId !== generationId ||
    manifest.sourceFingerprint !== expected.sourceFingerprint ||
    manifest.targetFingerprint !== expected.targetFingerprint ||
    typeof manifest.createdAt !== "string" ||
    !Array.isArray(manifest.files)
  )
    throw new Error("migration-generation-invalid");

  const fileEntries = manifest.files;
  const names = new Set<string>();
  const targetFacts: {
    path: string;
    byteLength: number;
    fingerprint: string;
  }[] = [];
  for (const entry of fileEntries) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      typeof entry.byteLength !== "number" ||
      !FINGERPRINT.test(entry.fingerprint)
    )
      throw new Error("migration-generation-invalid");
    const relative = canonicalTargetPath(entry.path);
    const folded = relative.split("/").map(caseFoldComponent).join("/");
    if (names.has(folded)) throw new Error("migration-generation-invalid");
    names.add(folded);
    const fileBytes = readRegularFile(
      projectRoot,
      path.join(directory, "files", relative),
    );
    if (
      !fileBytes ||
      fileBytes.byteLength !== entry.byteLength ||
      digest(fileBytes) !== entry.fingerprint
    )
      throw new Error("migration-generation-invalid");
    targetFacts.push({
      path: relative,
      byteLength: entry.byteLength,
      fingerprint: entry.fingerprint,
    });
  }
  if (
    digest(jsonBytes(targetFacts)) !== manifest.targetFingerprint ||
    targetFacts.length === 0
  )
    throw new Error("migration-generation-invalid");
  const actualFiles = listFiles(projectRoot, path.join(directory, "files"))
    .map((target) =>
      path
        .relative(path.join(directory, "files"), target)
        .split(path.sep)
        .join("/"),
    )
    .sort();
  const expectedFiles = targetFacts.map((item) => item.path).sort();
  if (
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((file, index) => file !== expectedFiles[index])
  )
    throw new Error("migration-generation-invalid");
  return manifest as GenerationManifest;
}
