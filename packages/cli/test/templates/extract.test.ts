import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  getPactileTemplatePath,
  getPactileSourcePath,
  readPactileFile,
  readTemplate,
  readMarkdown,
  collectUserModuleTemplates,
  isUserShippedModuleFile,
} from "../../src/templates/extract.js";
import { listModuleCatalog } from "../../src/templates/pactile/modules/catalog.js";

// =============================================================================
// getXxxTemplatePath — returns existing directory paths
// =============================================================================

describe("template path functions", () => {
  it("getPactileTemplatePath returns existing directory", () => {
    const p = getPactileTemplatePath();
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).isDirectory()).toBe(true);
  });
});

// =============================================================================
// Deprecated aliases return same result
// =============================================================================

describe("deprecated source path aliases", () => {
  it("getPactileSourcePath equals getPactileTemplatePath", () => {
    expect(getPactileSourcePath()).toBe(getPactileTemplatePath());
  });
});

// =============================================================================
// readPactileFile — reads files from the Pactile template directory
// =============================================================================

describe("readPactileFile", () => {
  it("reads workflow.md from Pactile templates", () => {
    const content = readPactileFile("workflow.md");
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("#");
  });

  it("reads a Node runtime configuration file", () => {
    const content = readPactileFile("config/execution-strategy-rules.json");
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(0);
  });

  it("throws for nonexistent file", () => {
    expect(() => readPactileFile("nonexistent.txt")).toThrow();
  });
});

// =============================================================================
// readTemplate — reads from category subdirectories
// =============================================================================

describe("readTemplate", () => {
  it("throws for nonexistent category/file", () => {
    expect(() => readTemplate("commands", "nonexistent.txt")).toThrow();
  });
});

// =============================================================================
// readMarkdown helper
// =============================================================================

describe("readMarkdown", () => {
  it("reads workflow.md", () => {
    const content = readMarkdown("workflow.md");
    expect(typeof content).toBe("string");
    expect(content).toContain("#");
  });
});

describe("user-shipped module templates", () => {
  it("accepts only index.json and <id>/contract.md", () => {
    expect(isUserShippedModuleFile("index.json")).toBe(true);
    expect(isUserShippedModuleFile("intake-basic/contract.md")).toBe(true);
    expect(isUserShippedModuleFile("catalog.ts")).toBe(false);
    expect(isUserShippedModuleFile("intake-basic/catalog.ts")).toBe(false);
    expect(isUserShippedModuleFile("README.md")).toBe(false);
    expect(isUserShippedModuleFile("nested/id/contract.md")).toBe(false);
  });

  it("walks modules/ without catalog.ts or other .ts files", () => {
    const files = collectUserModuleTemplates();
    const keys = [...files.keys()].sort();

    expect(keys).toContain("index.json");
    expect(keys.some((key) => key.endsWith(".ts"))).toBe(false);
    expect(keys).not.toContain("catalog.ts");

    const catalog = listModuleCatalog();
    expect(catalog).toHaveLength(19);
    for (const entry of catalog) {
      expect(keys).toContain(entry.contract);
      expect(files.get(entry.contract)?.trim().length).toBeGreaterThan(0);
    }
    expect(keys).toHaveLength(1 + catalog.length);
  });
});
