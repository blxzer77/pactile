import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { update } from "../../../src/commands/update.js";
import { VERSION } from "../../../src/constants/version.js";
import {
  captureCanonicalView,
  collectCanonicalGenerationFiles,
  collectLegacyCstlLifecycleFiles,
  discoverCanonicalGenerationPaths,
  materializeCanonicalGeneration,
  materializePreparedLegacyUserState,
  prepareLegacyCstlImport,
  runLifecycleCommand,
  seedCanonicalBuildRoot,
} from "../../../src/pactile/lifecycle/index.js";
import {
  GenerationStore,
  InstallStateStore,
} from "../../../src/pactile/runtime/stores.js";

const roots: string[] = [];
const runtimeVersion = "0.5.0-beta.5";

function tempRoot(prefix: string): string {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(result);
  return result;
}

function write(root: string, relativePath: string, contents: string): void {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function candidate(root: string) {
  return collectCanonicalGenerationFiles(
    root,
    discoverCanonicalGenerationPaths(root),
    [],
    runtimeVersion,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("Batch 3 lifecycle integration", () => {
  it("keeps local .runtime state out of sealed generations and live materialization", () => {
    const projectRoot = tempRoot("pactile-b3-runtime-boundary-");
    const buildRoot = tempRoot("pactile-b3-runtime-build-");
    const session = ".pactile/.runtime/sessions/current.json";
    write(projectRoot, ".pactile/workflow.md", "old workflow\n");
    write(projectRoot, session, '{"selectedTask":"local"}\n');

    expect(discoverCanonicalGenerationPaths(projectRoot)).toEqual([".pactile/workflow.md"]);
    expect(seedCanonicalBuildRoot(projectRoot, buildRoot)).toEqual([".pactile/workflow.md"]);
    expect(fs.existsSync(path.join(buildRoot, session))).toBe(false);
    expect(candidate(projectRoot).map((file) => file.path)).not.toContain(".runtime/sessions/current.json");

    materializeCanonicalGeneration(projectRoot, {
      generationId: "g-runtime-boundary",
      files: [{ path: "workflow.md", fingerprint: "test" }],
      readFile: () => Buffer.from("new workflow\n"),
    });
    expect(fs.readFileSync(path.join(projectRoot, ".pactile/workflow.md"), "utf8")).toBe("new workflow\n");
    expect(fs.readFileSync(path.join(projectRoot, session), "utf8")).toBe('{"selectedTask":"local"}\n');
  });

  it("keeps update construction isolated and resumes post-commit materialization", async () => {
    const projectRoot = tempRoot("pactile-b3-project-");
    const initBuildRoot = tempRoot("pactile-b3-init-");
    write(initBuildRoot, ".pactile/workflow.md", "version one\n");
    const initialized = await runLifecycleCommand({
      projectRoot,
      operation: "init",
      runtimeVersion,
      files: candidate(initBuildRoot),
      platforms: [],
      occurredAt: "2026-09-10T06:00:00.000Z",
      materializeCanonical: (context) => {
        expect(
          new InstallStateStore(projectRoot).read()?.state.generationId,
        ).toBe(context.generationId);
        materializeCanonicalGeneration(projectRoot, context);
      },
    });
    expect(initialized.status).toBe("completed");
    if (initialized.status !== "completed")
      throw new Error(JSON.stringify(initialized));
    expect(
      fs.readFileSync(path.join(projectRoot, ".pactile/workflow.md"), "utf8"),
    ).toBe("version one\n");

    const updateBuildRoot = tempRoot("pactile-b3-update-");
    seedCanonicalBuildRoot(projectRoot, updateBuildRoot);
    write(updateBuildRoot, ".pactile/workflow.md", "version two\n");
    write(updateBuildRoot, ".pactile/framework/new.md", "new managed file\n");
    const updateFiles = candidate(updateBuildRoot);

    // Candidate construction has not touched the active live view.
    expect(
      fs.readFileSync(path.join(projectRoot, ".pactile/workflow.md"), "utf8"),
    ).toBe("version one\n");
    expect(
      fs.existsSync(path.join(projectRoot, ".pactile/framework/new.md")),
    ).toBe(false);

    const interrupted = await runLifecycleCommand({
      projectRoot,
      operation: "update",
      runtimeVersion,
      files: updateFiles,
      platforms: [],
      occurredAt: "2026-09-10T06:01:00.000Z",
      materializeCanonical: () => {
        throw new Error("injected-materialization-interruption");
      },
    });
    expect(interrupted).toMatchObject({
      status: "interrupted",
      reason: "canonical-commit-not-completed",
    });
    expect(
      fs.readFileSync(path.join(projectRoot, ".pactile/workflow.md"), "utf8"),
    ).toBe("version one\n");

    const resumed = await runLifecycleCommand({
      projectRoot,
      operation: "update",
      runtimeVersion,
      files: updateFiles,
      platforms: [],
      occurredAt: "2026-09-10T06:01:00.000Z",
      materializeCanonical: (context) =>
        materializeCanonicalGeneration(projectRoot, context),
    });
    expect(resumed).toMatchObject({ status: "completed" });
    if (resumed.status !== "completed")
      throw new Error(JSON.stringify(resumed));
    expect(resumed.installState.state.generationId).toBe(
      interrupted.installState?.state.generationId,
    );
    expect(resumed.installState.state.generationId).not.toBe(
      initialized.installState.state.generationId,
    );
    expect(
      fs.readFileSync(path.join(projectRoot, ".pactile/workflow.md"), "utf8"),
    ).toBe("version two\n");
    expect(
      fs.readFileSync(
        path.join(projectRoot, ".pactile/framework/new.md"),
        "utf8",
      ),
    ).toBe("new managed file\n");
    expect(
      fs.existsSync(
        path.join(projectRoot, ".pactile/runtime/composition.json"),
      ),
    ).toBe(false);
    expect(
      new GenerationStore(projectRoot).verify(
        initialized.installState.state.generationId,
      ).generationId,
    ).toBe(initialized.installState.state.generationId);
  });

  it("imports from a read-only legacy source and publishes user state after commit", async () => {
    const projectRoot = tempRoot("pactile-b3-import-project-");
    const buildRoot = tempRoot("pactile-b3-import-build-");
    write(projectRoot, ".cstl/workflow.md", "legacy workflow\r\n");
    write(projectRoot, ".cstl/spec/domain.md", "user domain\n");
    write(projectRoot, ".cstl/runtime/private.json", '{"secret":"fixture"}\n');
    const legacyBefore = fs.readFileSync(
      path.join(projectRoot, ".cstl/workflow.md"),
    );

    prepareLegacyCstlImport(projectRoot, buildRoot);
    write(buildRoot, ".pactile/.version", `${runtimeVersion}\n`);
    const candidateFiles = candidate(buildRoot);
    const legacyFiles = collectLegacyCstlLifecycleFiles(
      projectRoot,
      buildRoot,
      candidateFiles,
    );
    expect(fs.existsSync(path.join(projectRoot, ".pactile"))).toBe(false);

    const imported = await runLifecycleCommand({
      projectRoot,
      operation: "import",
      runtimeVersion,
      files: candidateFiles,
      platforms: [],
      occurredAt: "2026-09-10T06:02:00.000Z",
      legacy: {
        runtimeVersion: "0.4.3",
        schemaVersion: null,
        files: legacyFiles,
      },
      materializeCanonical: (context) =>
        materializeCanonicalGeneration(projectRoot, context),
    });
    expect(imported.status).toBe("completed");
    expect(
      fs.readFileSync(path.join(projectRoot, ".cstl/workflow.md")),
    ).toEqual(legacyBefore);
    expect(
      fs.existsSync(path.join(projectRoot, ".pactile/spec/domain.md")),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(projectRoot, ".pactile/runtime/private.json")),
    ).toBe(false);

    expect(materializePreparedLegacyUserState(buildRoot, projectRoot)).toEqual([
      "spec/domain.md",
    ]);
    expect(
      fs.readFileSync(
        path.join(projectRoot, ".pactile/spec/domain.md"),
        "utf8",
      ),
    ).toBe("user domain\n");
    expect(
      fs.readFileSync(path.join(projectRoot, ".cstl/workflow.md")),
    ).toEqual(legacyBefore);
  });

  it("does not expose update template writes when canonical activation fails", async () => {
    const projectRoot = tempRoot("pactile-b3-update-command-");
    const buildRoot = tempRoot("pactile-b3-update-seed-");
    write(buildRoot, ".pactile/workflow.md", "active workflow\n");
    write(buildRoot, ".pactile/.version", `${VERSION}\n`);
    const initialized = await runLifecycleCommand({
      projectRoot,
      operation: "init",
      runtimeVersion: VERSION,
      files: collectCanonicalGenerationFiles(
        buildRoot,
        discoverCanonicalGenerationPaths(buildRoot),
        [],
        VERSION,
      ),
      platforms: [],
      occurredAt: "2026-09-10T06:03:00.000Z",
      materializeCanonical: (context) =>
        materializeCanonicalGeneration(projectRoot, context),
    });
    expect(initialized.status).toBe("completed");
    const before = captureCanonicalView(projectRoot);
    const retiredHostSurface = path.join(
      projectRoot,
      ".cursor/rules/cstl-triage.mdc",
    );
    fs.mkdirSync(path.dirname(retiredHostSurface), { recursive: true });
    fs.writeFileSync(
      retiredHostSurface,
      "---\nalwaysApply: true\n---\nshipped residue\n",
    );

    vi.spyOn(process, "cwd").mockReturnValue(projectRoot);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: VERSION }),
      }),
    );
    const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (
        path.resolve(String(destination)) ===
        path.resolve(projectRoot, ".pactile/runtime/install-state.json")
      )
        throw new Error("injected-install-state-activation-failure");
      return realRename(source, destination);
    });

    await expect(
      update({
        force: true,
        skipReadiness: true,
        skipPostUpdateSmoke: true,
      }),
    ).rejects.toThrow("canonical-commit-not-completed");
    expect(captureCanonicalView(projectRoot)).toEqual(before);
    expect(fs.existsSync(retiredHostSurface)).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, ".pactile/config.yaml"))).toBe(
      false,
    );
  });
});
