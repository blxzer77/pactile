import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { frameworkDocs } from "../../src/templates/markdown/index.js";
import { workflowMdTemplate } from "../../src/templates/pactile/index.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(testDir, "../..");
const frameworkDir = path.join(
  cliRoot,
  "src/templates/markdown/framework",
);

function doc(name: string): string {
  const hit = frameworkDocs.find((entry) => entry.name === name);
  if (!hit) {
    throw new Error(`frameworkDocs missing ${name}`);
  }
  return hit.content;
}

describe("P31–P36 product protocol docs", () => {
  it("ships protocol, upgrade, and release-boundary with init/update", () => {
    expect(frameworkDocs.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        "middleware-protocol.md",
        "upgrade.md",
        "release-boundary.md",
        "parallel-first-execution.md",
      ]),
    );
    for (const name of [
      "middleware-protocol.md.txt",
      "upgrade.md.txt",
      "release-boundary.md.txt",
    ]) {
      expect(fs.existsSync(path.join(frameworkDir, name))).toBe(true);
    }
  });

  it("P32 protocol names overlay, transports, Manifest, and update isolation", () => {
    const protocol = doc("middleware-protocol.md");
    expect(protocol).toContain(".pactile/middleware/");
    expect(protocol).toContain("protocol: 1");
    expect(protocol).toContain("skill+cli");
    expect(protocol).toContain("preserve-user-overlay");
    expect(protocol).toMatch(/永不写入/);
    expect(protocol).toMatch(/不删除/);
    expect(protocol).toMatch(/\.template-hashes\.json/);
    expect(protocol).toContain("secret_refs");
    expect(protocol).not.toMatch(/capability router.*bind/i);
  });

  it("registers only product-backed providers; retired MCPs stay Extra", () => {
    const protocol = doc("middleware-protocol.md");
    for (const id of [
      "smart-search",
      "codegraph",
      "fast-context",
    ]) {
      expect(protocol).toContain(`id: ${id}`);
    }
    expect(protocol).not.toContain("id: cursor-ide-browser");
    // The browser-session skill was retired; the protocol must not keep
    // advertising it as a shipped provider.
    expect(protocol).not.toContain("chrome-cdp");
    // Playwright and GitHub were retired with the external-capability
    // convergence work: no shipped-table row, no Manifest sample, no health
    // entry. They are Extra — PACTILE does not manage them. Naming them as
    // retired is allowed; registering them is not.
    for (const retired of ["playwright", "github"]) {
      expect(protocol).not.toMatch(new RegExp(`^\\| ${retired} \\|`, "m"));
      expect(protocol).not.toContain(`id: ${retired}`);
    }
    expect(protocol).not.toContain("GITHUB_TOKEN");
    expect(protocol).toContain("宿主 MCP / Agent 配置");
    expect(protocol).toContain("属 Extra");
    expect(protocol).toContain("仅 **smart-search** = `required`");
  });

  it("P36 user upgrade is a half-page with no Stage map and no local full-migrate", () => {
    const upgrade = doc("upgrade.md");
    expect(upgrade).toContain("pactile update");
    expect(upgrade).toMatch(/确认一次/);
    expect(upgrade).toMatch(/双读/);
    expect(upgrade).toMatch(/确认后才会停读旧形状/);
    expect(upgrade).not.toMatch(/Stage\s*[0-7]/);
    expect(upgrade).not.toMatch(/Stage 0/);
    expect(upgrade).not.toMatch(/MyHarness/);
    expect(upgrade).not.toMatch(/全量迁移/);
    expect(upgrade).not.toMatch(/P33/);
    expect(upgrade.length).toBeLessThan(1800);
  });

  it("P35 does not make BYOK a Pactile release gate", () => {
    const boundary = doc("release-boundary.md");
    expect(boundary).toContain("pactile-byok");
    expect(boundary).toMatch(/不是.*硬依赖|互不门禁/);
    expect(boundary).toContain(".pactile/middleware/");
    expect(boundary).not.toMatch(/P33.*硬依赖/);
  });

  it("P34 workflow points to the parallel-first product contract", () => {
    expect(workflowMdTemplate).toMatch(/Parallel first/i);
    expect(workflowMdTemplate).toContain(
      ".pactile/framework/parallel-first-execution.md",
    );
    const parallelFirst = doc("parallel-first-execution.md");
    expect(parallelFirst).toMatch(/product/i);
    expect(parallelFirst).toMatch(/not a .*hard gate/i);
  });
});
