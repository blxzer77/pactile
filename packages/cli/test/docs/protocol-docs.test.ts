import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { frameworkDocs } from "../../src/templates/markdown/index.js";
import { poolPlanTemplate, workflowMdTemplate } from "../../src/templates/pactile/index.js";

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

function stripFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "");
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

  it("ships seven optional-or-required providers and does not leave Playwright/GitHub as Extra-unmanaged", () => {
    const protocol = doc("middleware-protocol.md");
    for (const id of [
      "smart-search",
      "codegraph",
      "fast-context",
      "chrome-cdp",
      "playwright",
      "github",
      "cursor-ide-browser",
    ]) {
      expect(protocol).toContain(`id: ${id}`);
    }
    expect(protocol).toContain("blaze-skills/chrome-cdp");
    expect(protocol).toContain("host-platform");
    expect(protocol).toContain("GITHUB_TOKEN");
    expect(protocol).not.toMatch(/Playwright \/ GitHub \| 默认不集成/);
    expect(protocol).toContain("仅 **smart-search** = `required`");
    expect(protocol).toContain("强制安装 Playwright / GitHub");
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

  it("P31 plan skeleton has attention bands and no bare item-id tokens in prose", () => {
    expect(poolPlanTemplate).toContain("priority-0");
    expect(poolPlanTemplate).toContain("priority-1");
    expect(poolPlanTemplate).toContain("priority-2");
    expect(poolPlanTemplate).toMatch(/parallel group/i);
    const prose = stripFences(poolPlanTemplate);
    expect(prose).not.toMatch(/\bP\d+\b/);
  });
});
