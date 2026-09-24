import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createWorkflowStructure } from "../../src/configurators/workflow.js";
import { setWriteMode } from "../../src/utils/file-writer.js";
import { listModuleCatalog } from "../../src/templates/pactile/modules/catalog.js";
import { PATHS } from "../../src/constants/paths.js";

describe("createWorkflowStructure — retired alternate-client bundle is never written", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-workflow-"));
    setWriteMode("force");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setWriteMode("ask");
  });

  it("does NOT write an alternate-client bundle", async () => {
    await createWorkflowStructure(tmpDir, { projectType: "fullstack" });
    const alternateClientDir = path.join(
      tmpDir,
      ".pactile",
      "local",
      "alternate-client",
    );
    expect(fs.existsSync(alternateClientDir)).toBe(false);
    expect(
      fs.existsSync(path.join(alternateClientDir, "patch-client.py")),
    ).toBe(false);
    // Alternate-client setup is not a WorkflowOptions field.
    expect(
      "alternateClient" in
        (({ projectType: "fullstack" }) as Record<string, unknown>),
    ).toBe(false);
  });

  it("does not install a Python script tree", async () => {
    await createWorkflowStructure(tmpDir, { projectType: "fullstack" });
    const scriptsDir = path.join(tmpDir, ".pactile", "scripts");
    expect(fs.existsSync(scriptsDir)).toBe(false);
  });

  it("creates the canonical .pactile base structure", async () => {
    await createWorkflowStructure(tmpDir, {
      projectType: "fullstack",
    });
    expect(fs.existsSync(path.join(tmpDir, ".pactile"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".pactile", "scripts"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".pactile", "tasks"))).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, ".pactile", "workflow.md")),
    ).toBe(true);
  });
});

describe("createWorkflowStructure — P29 modules ship", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-modules-"));
    setWriteMode("force");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setWriteMode("ask");
  });

  it("writes index.json and all nineteen contract.md files, never catalog.ts", async () => {
    await createWorkflowStructure(tmpDir, { projectType: "fullstack" });

    const modulesDir = path.join(tmpDir, PATHS.MODULES);
    expect(fs.existsSync(path.join(modulesDir, "index.json"))).toBe(true);
    expect(fs.existsSync(path.join(modulesDir, "catalog.ts"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, PATHS.MIDDLEWARE))).toBe(false);

    const catalog = listModuleCatalog();
    const baseline = catalog.filter((entry) => entry.layer === "baseline");
    const onDemand = catalog.filter((entry) => entry.layer === "on-demand");
    expect(baseline).toHaveLength(8);
    expect(onDemand).toHaveLength(11);

    for (const entry of catalog) {
      const contractPath = path.join(modulesDir, entry.contract);
      expect(fs.existsSync(contractPath)).toBe(true);
      expect(
        fs.readFileSync(contractPath, "utf-8").trim().length,
      ).toBeGreaterThan(0);
    }

    const tsFiles: string[] = [];
    function walk(dir: string): void {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) {
          walk(full);
        } else if (name.endsWith(".ts")) {
          tsFiles.push(full);
        }
      }
    }
    walk(modulesDir);
    expect(tsFiles).toEqual([]);
  });
});
