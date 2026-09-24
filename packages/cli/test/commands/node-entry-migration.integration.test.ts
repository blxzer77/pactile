import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { init } from "../../src/commands/init.js";
import { update, type UpdateOptions } from "../../src/commands/update.js";
import { runTaskCli } from "../../src/commands/task.js";
import { listLegacyPythonScripts } from "../../src/pactile/compat/node-entry-migration.js";
import { discoverCanonicalGenerationPaths } from "../../src/pactile/lifecycle/project-files.js";
import { GenerationStore, InstallStateStore } from "../../src/pactile/runtime/stores.js";
import { computeHash } from "../../src/utils/template-hash.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const OLD_CONTEXT = `#!/usr/bin/env python3
"""Get Session Context for AI Agent."""
from __future__ import annotations
from common.git_context import main
if __name__ == "__main__":
    main()
`;
const OLD_PACK = `#!/usr/bin/env python3
"""Build a bounded retrieval context pack."""
from __future__ import annotations
from common.context_pack import main
if __name__ == "__main__":
    raise SystemExit(main())
`;

function stageLegacyScripts(root: string): void {
  const scripts = path.join(root, ".pactile", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "get_context.py"), OLD_CONTEXT);
  fs.writeFileSync(path.join(scripts, "build_context_pack.py"), `${OLD_PACK}\n# Local change\n`);
  fs.writeFileSync(path.join(scripts, "custom.py"), "# user-owned helper\n");
  fs.writeFileSync(path.join(scripts, "unsafe.py"), OLD_CONTEXT);
  fs.linkSync(path.join(scripts, "unsafe.py"), path.join(root, "user-copy.txt"));
  const hashPath = path.join(root, ".pactile", ".template-hashes.json");
  const manifest = JSON.parse(fs.readFileSync(hashPath, "utf8")) as {
    __version: number; hashes: Record<string, string>;
  };
  manifest.hashes[".pactile/scripts/get_context.py"] = computeHash(OLD_CONTEXT);
  manifest.hashes[".pactile/scripts/build_context_pack.py"] = computeHash(OLD_PACK);
  manifest.hashes[".pactile/scripts/unsafe.py"] = computeHash(OLD_CONTEXT);
  fs.writeFileSync(hashPath, JSON.stringify(manifest, null, 2));
}

describe("installed 0.5.0 project to Node entry", () => {
  it("retires pristine Python, preserves modified and user files, and activates only Node files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-node-upgrade-"));
    roots.push(root);
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ version: "0.5.0" }),
    }));

    await init({ yes: true, user: "alice", force: true, skipReadiness: true });
    stageLegacyScripts(root);
    const taskData = path.join(root, ".pactile", "tasks", "legacy-task", "notes.md");
    fs.mkdirSync(path.dirname(taskData), { recursive: true });
    fs.writeFileSync(taskData, "User task evidence\n");
    const agents = path.join(root, "AGENTS.md");
    fs.appendFileSync(agents, "\nUser footer\n");

    expect(listLegacyPythonScripts(root)).toEqual([
      ".pactile/scripts/build_context_pack.py",
      ".pactile/scripts/custom.py",
      ".pactile/scripts/get_context.py",
      ".pactile/scripts/unsafe.py",
    ]);
    expect(discoverCanonicalGenerationPaths(root)).not.toContain(
      ".pactile/scripts/get_context.py",
    );

    const options: UpdateOptions = {
      skipAll: true, skipReadiness: true, skipPostUpdateSmoke: true,
    };
    await update(options);

    const scripts = path.join(root, ".pactile", "scripts");
    expect(fs.existsSync(path.join(scripts, "get_context.py"))).toBe(false);
    expect(fs.readFileSync(path.join(scripts, "build_context_pack.py"), "utf8"))
      .toContain("# Local change");
    expect(fs.readFileSync(path.join(scripts, "custom.py"), "utf8"))
      .toBe("# user-owned helper\n");
    expect(fs.readFileSync(path.join(scripts, "unsafe.py"), "utf8"))
      .toBe(OLD_CONTEXT);
    expect(fs.readFileSync(path.join(root, "user-copy.txt"), "utf8"))
      .toBe(OLD_CONTEXT);
    expect(fs.readFileSync(taskData, "utf8")).toBe("User task evidence\n");
    expect(fs.readFileSync(agents, "utf8")).toContain("User footer");
    const updatedHashes = JSON.parse(fs.readFileSync(path.join(root, ".pactile", ".template-hashes.json"), "utf8")) as {
      hashes: Record<string, string>;
    };
    expect(Object.keys(updatedHashes.hashes).some((file) => file.startsWith(".pactile/scripts/"))).toBe(false);

    const report = options.lastReport;
    expect(report?.plan.files.safeDeleted).toContain(".pactile/scripts/get_context.py");
    expect(report?.plan.files.legacyPythonPreserved)
      .toContain(".pactile/scripts/build_context_pack.py");
    expect(report?.plan.files.legacyPythonUnprocessed)
      .toContain(".pactile/scripts/custom.py");
    expect(report?.plan.files.legacyPythonUnprocessed)
      .toContain(".pactile/scripts/unsafe.py");
    expect(report?.apply?.backupPath).toBeTruthy();
    expect(fs.existsSync(path.join(root, report?.apply?.backupPath ?? "", ".pactile", "scripts", "get_context.py"))).toBe(true);

    const install = new InstallStateStore(root).read();
    expect(install?.state.generationId).toBeTruthy();
    const seal = new GenerationStore(root).verify(install?.state.generationId ?? "");
    expect(seal.files.some((file) => file.path.startsWith("scripts/"))).toBe(false);
    expect(runTaskCli(["create", "Migrated", "--slug", "migrated"], root)).toBe(0);
  });

  it("backs up a metadata-only claim release while retaining edited scripts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-node-claim-"));
    roots.push(root);
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ version: "0.5.0" }),
    }));
    await init({ yes: true, user: "alice", force: true, skipReadiness: true });

    const script = path.join(root, ".pactile", "scripts", "get_context.py");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, `${OLD_CONTEXT}\n# edited locally\n`);
    const hashPath = path.join(root, ".pactile", ".template-hashes.json");
    const original = JSON.parse(fs.readFileSync(hashPath, "utf8")) as {
      __version: number; hashes: Record<string, string>;
    };
    original.hashes[".pactile/scripts/get_context.py"] = computeHash(OLD_CONTEXT);
    fs.writeFileSync(hashPath, JSON.stringify(original, null, 2));

    const options: UpdateOptions = {
      skipAll: true, skipReadiness: true, skipPostUpdateSmoke: true,
    };
    await update(options);
    const backup = options.lastReport?.plan.backupPath;
    expect(backup).toBeTruthy();
    const backupHashes = JSON.parse(fs.readFileSync(path.join(root, backup ?? "", ".pactile", ".template-hashes.json"), "utf8")) as {
      hashes: Record<string, string>;
    };
    expect(backupHashes.hashes[".pactile/scripts/get_context.py"])
      .toBe(computeHash(OLD_CONTEXT));
    const updated = JSON.parse(fs.readFileSync(hashPath, "utf8")) as {
      hashes: Record<string, string>;
    };
    expect(updated.hashes[".pactile/scripts/get_context.py"]).toBeUndefined();
    expect(fs.readFileSync(script, "utf8")).toContain("# edited locally");
    expect(options.lastReport?.plan.files.legacyPythonHashClaimsReleased)
      .toContain(".pactile/scripts/get_context.py");
  });
});
