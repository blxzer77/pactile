/** Developer probe: observe retained memory at an existing migration boundary. */
import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// Script compilation runs before dist exists on a fresh checkout. Describe only
// the diagnostic seam here; selected package modules are loaded at probe runtime.
interface ProbePlan { sourceFingerprint: string; scannedFileCount: number }
interface SourceApi {
  scanLegacyTaskMigration(input: { projectRoot: string }): ProbePlan;
}
interface BatchApi {
  runLegacyTaskBatch(
    request: {
      projectRoot: string;
      plan: ProbePlan;
      targets: { path: string; bytes: Uint8Array }[];
    },
    options: {
      approved: boolean;
      occurredAt: string;
      onPhase(phase: string): Promise<void>;
    },
  ): Promise<{ status: string; reason?: string; journal?: { state: string } }>;
}

const [packageRootArg, fixtureRootArg, sizeArg = "64"] = process.argv.slice(2);
if (
  !packageRootArg ||
  !fixtureRootArg ||
  !path.isAbsolute(packageRootArg) ||
  !path.isAbsolute(fixtureRootArg) ||
  typeof global.gc !== "function"
) {
  throw new Error(
    "Use node --expose-gc migration-retention.js <absolute-package-root> <fresh-absolute-fixture-root> [MiB].",
  );
}
const sizeMiB = Number(sizeArg);
if (!Number.isInteger(sizeMiB) || sizeMiB < 1 || sizeMiB > 256) {
  throw new Error("The diagnostic payload must be between 1 and 256 MiB.");
}
const packageRoot = path.resolve(packageRootArg);
const fixtureRoot = path.resolve(fixtureRootArg);
if (fs.existsSync(fixtureRoot)) throw new Error("The fixture root must be fresh.");
const taskRoot = path.join(fixtureRoot, ".pactile", "tasks", "09-28-retention");
fs.mkdirSync(taskRoot, { recursive: true });
fs.writeFileSync(
  path.join(taskRoot, "task.json"),
  `${JSON.stringify({ id: "retention-sample", status: "planning" })}\n`,
);
fs.writeFileSync(path.join(taskRoot, "prd.md"), "# Synthetic retention probe\n");
fs.writeFileSync(
  path.join(taskRoot, "retention-evidence.txt"),
  Buffer.alloc(sizeMiB * 1024 * 1024, 0x61),
);

const source = (await import(
  pathToFileURL(path.join(packageRoot, "dist/core/task/legacy-task-migration.js"))
    .href
)) as SourceApi;
const batch = (await import(
  pathToFileURL(path.join(packageRoot, "dist/pactile/migration/legacy-task-batch.js"))
    .href
)) as BatchApi;
const plan = source.scanLegacyTaskMigration({ projectRoot: fixtureRoot });
let observation: ReturnType<typeof process.memoryUsage> | null = null;
const result = await batch.runLegacyTaskBatch(
  {
    projectRoot: fixtureRoot,
    plan,
    targets: [
      {
        path: "prepared/retention-index.json",
        bytes: Buffer.from('{"kind":"synthetic-retention-probe"}\n'),
      },
    ],
  },
  {
    approved: true,
    occurredAt: "2026-09-28T00:00:00.000Z",
    async onPhase(phase) {
      if (phase !== "source-backed-up") return;
      await nextTurn();
      global.gc();
      await nextTurn();
      global.gc();
      observation = process.memoryUsage();
      // Stop before target staging and authority commit; this is a memory probe.
      throw new Error("retention-probe-complete");
    },
  },
);
if (
  !observation ||
  result.status !== "interrupted" ||
  result.reason !== "retention-probe-complete" ||
  result.journal?.state !== "backed-up"
) {
  throw new Error("The probe did not reach the verified source-backup boundary.");
}
console.log(
  JSON.stringify({
    fixtureRoot,
    sizeMiB,
    sourceFingerprint: plan.sourceFingerprint,
    sourceFiles: plan.scannedFileCount,
    phase: result.journal.state,
    authorityCommitted: false,
    memory: observation,
  }),
);
