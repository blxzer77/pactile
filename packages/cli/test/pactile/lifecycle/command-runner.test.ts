import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareLegacyCstlImport,
  collectLegacyCstlLifecycleFiles,
  discoverCanonicalGenerationPaths,
  installedPactilePlatforms,
  materializeCanonicalGeneration,
  materializePreparedLegacyUserState,
  runLifecycleCommand,
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
