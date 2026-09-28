import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareLegacyCstlImport,
  collectLegacyCstlLifecycleFiles,
  captureCanonicalView,
  collectCanonicalGenerationFiles,
  discoverCanonicalGenerationPaths,
  installedPactilePlatforms,
  materializeCanonicalGeneration,
  materializePreparedLegacyUserState,
  runLifecycleCommand,
  seedCanonicalBuildRoot,
} from "../../../src/pactile/lifecycle/index.js";

const roots: string[] = [];
const runtimeVersion = "0.5.0-beta.5";
const occurredAt = "2026-09-10T05:00:00.000Z";

function root(): string {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-command-"));
  roots.push(result);
  return result;
}

afterEach(() => {
  for (const target of roots.splice(0))
    fs.rmSync(target, { recursive: true, force: true });
});

describe("lifecycle command facade", () => {
  it("never captures backups or mutable control state in a generation", () => {
    const projectRoot = root();
    fs.mkdirSync(path.join(projectRoot, ".pactile/.backup-snapshot"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(projectRoot, ".pactile/runtime"), {
      recursive: true,
    });
    fs.mkdirSync(
      path.join(projectRoot, ".pactile/scripts/common/__pycache__"),
      { recursive: true },
    );
    fs.writeFileSync(path.join(projectRoot, ".pactile/workflow.md"), "ok\n");
    fs.writeFileSync(
      path.join(projectRoot, ".pactile/.backup-snapshot/private.txt"),
      "must-not-enter-generation\n",
    );
    fs.writeFileSync(
      path.join(projectRoot, ".pactile/runtime/state.json"),
      "{}\n",
    );
    fs.writeFileSync(
      path.join(projectRoot, ".pactile/.p36-wave-c.json"),
      "{}\n",
    );
    fs.writeFileSync(
      path.join(
        projectRoot,
        ".pactile/scripts/common/__pycache__/paths.cpython-312.pyc",
      ),
      "generated-cache",
    );
    fs.writeFileSync(
      path.join(projectRoot, ".pactile/scripts/common/manual.pyc"),
      "generated-cache",
    );

    expect(discoverCanonicalGenerationPaths(projectRoot)).toEqual([
      ".pactile/workflow.md",
    ]);
  });

  it("does not traverse legacy worktrees, scratch or personal templates", () => {
    const projectRoot = root();
    const worktree = path.join(projectRoot, ".pactile/worktrees/legacy-run");
    const archive = path.join(projectRoot, ".pactile/worktree-archives/old");
    const templates = path.join(projectRoot, ".pactile/templates/tasks");
    const scratch = path.join(projectRoot, ".pactile/tmp/build/node_modules");
    const scratchNamed = path.join(projectRoot, ".pactile/tmp-commit-msgs");
    fs.mkdirSync(worktree, { recursive: true });
    fs.mkdirSync(archive, { recursive: true });
    fs.mkdirSync(templates, { recursive: true });
    fs.mkdirSync(scratch, { recursive: true });
    fs.mkdirSync(scratchNamed, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".pactile/workflow.md"), "ok\n");
    const shared = path.join(worktree, "shared.txt");
    fs.writeFileSync(shared, "legacy worktree\n");
    fs.linkSync(shared, path.join(worktree, "hard-linked.txt"));
    fs.linkSync(shared, path.join(archive, "hard-linked.txt"));
    fs.linkSync(shared, path.join(scratch, "hard-linked.txt"));
    fs.linkSync(shared, path.join(scratchNamed, "hard-linked.txt"));
    fs.writeFileSync(path.join(templates, "custom.md"), "personal\n");

    expect(discoverCanonicalGenerationPaths(projectRoot)).toEqual([
      ".pactile/workflow.md",
    ]);
  });

  it("preserves cleanup backups without traversing their dependency links", () => {
    const projectRoot = root();
    const buildRoot = root();
    const dependencies = root();
    const backup = path.join(projectRoot, ".pactile/cleanup-backups/retired");
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".pactile/workflow.md"), "old\n");
    const privateFile = path.join(dependencies, "private.txt");
    fs.writeFileSync(privateFile, "preserved user data\n");
    fs.linkSync(privateFile, path.join(backup, "private.txt"));
    fs.symlinkSync(dependencies, path.join(backup, "node_modules"), "junction");

    const managed = [".pactile/workflow.md"];
    expect(discoverCanonicalGenerationPaths(projectRoot)).toEqual(managed);
    expect(seedCanonicalBuildRoot(projectRoot, buildRoot)).toEqual(managed);
    expect(
      fs.existsSync(path.join(buildRoot, ".pactile/cleanup-backups")),
    ).toBe(false);
    expect(captureCanonicalView(projectRoot).map((file) => file.path)).toEqual([
      "workflow.md",
    ]);
    expect(
      collectCanonicalGenerationFiles(
        projectRoot,
        [
          ...managed,
          ".pactile/cleanup-backups/retired/private.txt",
          ".pactile/cleanup-backups/retired/node_modules/private.txt",
        ],
        [],
        runtimeVersion,
      ).map((file) => file.path),
    ).toEqual(["runtime/composition.json", "workflow.md"]);

    materializeCanonicalGeneration(projectRoot, {
      generationId: "generation.backup-boundary",
      files: [{ path: "workflow.md", fingerprint: `sha256:${"0".repeat(64)}` }],
      readFile: () => Buffer.from("new\n"),
    });
    expect(
      fs.readFileSync(path.join(projectRoot, ".pactile/workflow.md"), "utf8"),
    ).toBe("new\n");
    expect(fs.readFileSync(path.join(backup, "private.txt"), "utf8")).toBe(
      "preserved user data\n",
    );
    expect(fs.readFileSync(privateFile, "utf8")).toBe("preserved user data\n");
    expect(
      fs.lstatSync(path.join(backup, "node_modules")).isSymbolicLink(),
    ).toBe(true);
  });

  it("keeps task evidence outside generation capture and materialization", () => {
    const projectRoot = root();
    const buildRoot = root();
    const dependencies = root();
    const evidenceRoot = path.join(projectRoot, ".pactile/evidence/review");
    fs.mkdirSync(evidenceRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".pactile/workflow.md"), "old\n");
    const archivePath = path.join(evidenceRoot, "source.tar");
    const archive = Buffer.alloc(5 * 1024 * 1024, 7);
    fs.writeFileSync(archivePath, archive);
    fs.symlinkSync(
      dependencies,
      path.join(evidenceRoot, "node_modules"),
      "junction",
    );

    const managed = [".pactile/workflow.md"];
    expect(discoverCanonicalGenerationPaths(projectRoot)).toEqual(managed);
    expect(seedCanonicalBuildRoot(projectRoot, buildRoot)).toEqual(managed);
    expect(fs.existsSync(path.join(buildRoot, ".pactile/evidence"))).toBe(
      false,
    );
    expect(captureCanonicalView(projectRoot).map((file) => file.path)).toEqual([
      "workflow.md",
    ]);
    expect(
      collectCanonicalGenerationFiles(
        projectRoot,
        [...managed, ".pactile/evidence/review/source.tar"],
        [],
        runtimeVersion,
      ).map((file) => file.path),
    ).toEqual(["runtime/composition.json", "workflow.md"]);

    materializeCanonicalGeneration(projectRoot, {
      generationId: "generation.evidence-boundary",
      files: [{ path: "workflow.md", fingerprint: `sha256:${"0".repeat(64)}` }],
      readFile: () => Buffer.from("new\n"),
    });
    expect(fs.readFileSync(archivePath)).toEqual(archive);
    expect(
      fs.lstatSync(path.join(evidenceRoot, "node_modules")).isSymbolicLink(),
    ).toBe(true);
    expect(
      fs.readFileSync(path.join(projectRoot, ".pactile/workflow.md"), "utf8"),
    ).toBe("new\n");
  });

  it("still rejects hard links in managed canonical files", () => {
    const projectRoot = root();
    fs.mkdirSync(path.join(projectRoot, ".pactile"));
    const original = path.join(projectRoot, "user.txt");
    fs.writeFileSync(original, "unchanged\n");
    fs.linkSync(original, path.join(projectRoot, ".pactile/workflow.md"));
    expect(() => discoverCanonicalGenerationPaths(projectRoot)).toThrow(
      "canonical-generation-source-unsafe",
    );
    expect(() =>
      collectCanonicalGenerationFiles(
        projectRoot,
        [".pactile/workflow.md"],
        [],
        runtimeVersion,
      ),
    ).toThrow("canonical-generation-source-unsafe");
    expect(fs.readFileSync(original, "utf8")).toBe("unchanged\n");
  });

  it("publishes an exact managed live view without touching Runtime or user data", () => {
    const projectRoot = root();
    fs.mkdirSync(path.join(projectRoot, ".pactile/runtime"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(projectRoot, ".pactile/spec"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".pactile/obsolete.md"), "old\n");
    fs.writeFileSync(
      path.join(projectRoot, ".pactile/runtime/state.json"),
      "{}\n",
    );
    fs.writeFileSync(path.join(projectRoot, ".pactile/spec/user.md"), "user\n");
    const bytes = new Map([
      ["workflow.md", Buffer.from("# Pactile\n")],
      ["runtime/composition.json", Buffer.from('{"platforms":[]}')],
    ]);

    materializeCanonicalGeneration(projectRoot, {
      generationId: "generation.test",
      files: [...bytes].map(([filePath]) => ({
        path: filePath,
        fingerprint: `sha256:${"0".repeat(64)}`,
      })),
      readFile: (filePath) => bytes.get(filePath) ?? Buffer.alloc(0),
    });

    expect(
      fs.readFileSync(path.join(projectRoot, ".pactile/workflow.md"), "utf8"),
    ).toBe("# Pactile\n");
    expect(fs.existsSync(path.join(projectRoot, ".pactile/obsolete.md"))).toBe(
      false,
    );
    expect(
      fs.readFileSync(
        path.join(projectRoot, ".pactile/runtime/state.json"),
        "utf8",
      ),
    ).toBe("{}\n");
    expect(
      fs.existsSync(
        path.join(projectRoot, ".pactile/runtime/composition.json"),
      ),
    ).toBe(false);
    expect(
      fs.readFileSync(path.join(projectRoot, ".pactile/spec/user.md"), "utf8"),
    ).toBe("user\n");
  });

  it("preflights every managed target before replacing any file", () => {
    const projectRoot = root();
    fs.mkdirSync(path.join(projectRoot, ".pactile"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".pactile/a.txt"), "old-a\n");
    const external = path.join(projectRoot, "external-z.txt");
    fs.writeFileSync(external, "old-z\n");
    fs.linkSync(external, path.join(projectRoot, ".pactile/z.txt"));

    const files = new Map([
      ["a.txt", Buffer.from("new-a\n")],
      ["z.txt", Buffer.from("new-z\n")],
    ]);
    expect(() =>
      materializeCanonicalGeneration(projectRoot, {
        generationId: "generation.preflight",
        files: [...files].map(([filePath]) => ({
          path: filePath,
          fingerprint: `sha256:${"0".repeat(64)}`,
        })),
        readFile: (filePath) => files.get(filePath) ?? Buffer.alloc(0),
      }),
    ).toThrow();
    expect(
      fs.readFileSync(path.join(projectRoot, ".pactile/a.txt"), "utf8"),
    ).toBe("old-a\n");
    expect(
      fs.readFileSync(path.join(projectRoot, ".pactile/z.txt"), "utf8"),
    ).toBe("old-z\n");
    expect(fs.readFileSync(external, "utf8")).toBe("old-z\n");
  });

  it("does not reactivate a legacy Cursor adapter during update", () => {
    expect(
      installedPactilePlatforms({
        schemaVersion: 1,
        product: "pactile",
        canonicalRoot: ".pactile",
        runtimeVersion,
        contractVersion: 1,
        generationId: "generation.test",
        status: "degraded",
        installedAdapters: [
          {
            id: "adapter.cursor",
            version: runtimeVersion,
            status: "active",
            lastProjectionFingerprint: null,
            reconciledAt: occurredAt,
          },
          {
            id: "adapter.codex",
            version: runtimeVersion,
            status: "detached",
            lastProjectionFingerprint: null,
            reconciledAt: occurredAt,
          },
        ],
        lastMigrationJournalId: "lifecycle.test",
        createdAt: occurredAt,
        updatedAt: occurredAt,
      }),
    ).toEqual([]);
  });

  it("uses deterministic identities and reuses the active generation for reconcile", async () => {
    const projectRoot = root();
    const files = [{ path: "workflow.md", bytes: Buffer.from("# Pactile\n") }];
    const initialized = await runLifecycleCommand({
      projectRoot,
      operation: "init",
      runtimeVersion,
      files,
      platforms: [],
      occurredAt,
    });
    expect(initialized.status).toBe("completed");
    if (initialized.status !== "completed")
      throw new Error(JSON.stringify(initialized));

    const reconciled = await runLifecycleCommand({
      projectRoot,
      operation: "reconcile",
      runtimeVersion,
      files,
      platforms: [],
      occurredAt,
    });
    expect(reconciled.status).toBe("completed");
    if (reconciled.status !== "completed")
      throw new Error(JSON.stringify(reconciled));
    expect(reconciled.installState.state.generationId).toBe(
      initialized.installState.state.generationId,
    );
    const journalPath = path.join(
      projectRoot,
      ".pactile/runtime/migrations",
      `${reconciled.plan.id}.json`,
    );
    const before = fs.readFileSync(journalPath);
    const repeated = await runLifecycleCommand({
      projectRoot,
      operation: "reconcile",
      runtimeVersion,
      files,
      platforms: [],
      occurredAt,
    });
    expect(repeated.status).toBe("completed");
    expect(repeated.resumed).toBe(true);
    expect(fs.readFileSync(journalPath)).toEqual(before);
  });

  it("copies an explicit cstl source without modifying it and excludes control metadata", () => {
    const projectRoot = root();
    const buildRoot = root();
    fs.mkdirSync(path.join(projectRoot, ".cstl/spec"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".cstl/runtime"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".cstl/workflow.md"), "legacy\r\n");
    fs.writeFileSync(path.join(projectRoot, ".cstl/spec/user.md"), "user\n");
    fs.writeFileSync(path.join(projectRoot, ".cstl/.version"), "0.4.3\n");
    fs.writeFileSync(
      path.join(projectRoot, ".cstl/runtime/unsafe.json"),
      "{}\n",
    );
    const before = fs.readFileSync(path.join(projectRoot, ".cstl/workflow.md"));

    expect(prepareLegacyCstlImport(projectRoot, buildRoot)).toEqual([
      "spec/user.md",
      "workflow.md",
    ]);
    expect(
      fs.readFileSync(path.join(projectRoot, ".cstl/workflow.md")),
    ).toEqual(before);
    expect(
      fs.readFileSync(path.join(buildRoot, ".pactile/workflow.md")),
    ).toEqual(before);
    expect(
      fs.existsSync(path.join(buildRoot, ".pactile/runtime/unsafe.json")),
    ).toBe(false);
    const files = collectLegacyCstlLifecycleFiles(projectRoot, buildRoot, [
      { path: "workflow.md", bytes: before },
      { path: ".version", bytes: Buffer.from(runtimeVersion) },
      {
        path: "runtime/composition.json",
        bytes: Buffer.from('{"platforms":[]}'),
      },
    ]);
    expect(files).toMatchObject([
      { path: ".version", classification: "generated" },
      { path: "runtime/composition.json", classification: "generated" },
      { path: "workflow.md", classification: "active" },
    ]);
    expect(materializePreparedLegacyUserState(buildRoot, projectRoot)).toEqual([
      "spec/user.md",
    ]);
    expect(
      fs.readFileSync(path.join(projectRoot, ".pactile/spec/user.md"), "utf8"),
    ).toBe("user\n");
  });
});
