import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { frameworkDocs } from "../../src/templates/markdown/index.js";
import { workflowMdTemplate } from "../../src/templates/pactile/index.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(testDir, "../..");
const frameworkDir = path.join(cliRoot, "src/templates/markdown/framework");

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
    for (const id of ["smart-search", "codegraph", "fast-context"]) {
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

  it("keeps BYOK as an older unimplemented placeholder outside current release scope", () => {
    const boundary = doc("release-boundary.md");
    expect(boundary).toContain("pactile-byok");
    expect(boundary).toMatch(/早期 BYOK 规划的历史说明/);
    expect(boundary).toMatch(/optional 占位，明确无实现/);
    expect(boundary).toMatch(/不表示当前存在独立 BYOK 产品、仓库或发布轨/);
    expect(boundary).toMatch(/不构成 PACTILE 发布门禁/);
    for (const currentTrackClaim of [
      /是另一条产品线/,
      /是另一个仓库/,
      /是另一次发布/,
      /两者是独立发布轨/,
    ]) {
      expect(boundary).not.toMatch(currentTrackClaim);
    }
    expect(boundary).toContain(".pactile/middleware/");
    expect(boundary).not.toMatch(/P33.*硬依赖/);
  });

  it("workflow and framework index point to the current Task/Run scheduling contract", () => {
    expect(workflowMdTemplate).toMatch(/critical-path scheduling/i);
    expect(workflowMdTemplate).toContain(
      "./framework/parallel-first-execution.md",
    );
    const parallelFirst = doc("parallel-first-execution.md");
    expect(parallelFirst).toMatch(/Compatibility filename/i);
    expect(parallelFirst).toMatch(/Task Kernel V2/i);
    expect(parallelFirst).toMatch(/critical-path/i);
    expect(parallelFirst).toMatch(/dependenc(?:y|ies)/i);
    expect(parallelFirst).toMatch(
      /missing dependency or any cycle fails the whole planning call/i,
    );
    expect(parallelFirst).toMatch(/no schedule plan or receipt is produced/i);
    expect(parallelFirst).toMatch(
      /each dependency must have a successful Task Close/i,
    );
    expect(parallelFirst).toMatch(
      /its lifecycle is `closed` and its outcome is `completed`/i,
    );
    expect(parallelFirst).toMatch(
      /a completed Run alone does not satisfy a dependency/i,
    );
    expect(parallelFirst).toMatch(
      /an open dependency keeps its dependent Task undispatchable/i,
    );
    expect(parallelFirst).toMatch(
      /even if a later advisory schedule wave lists it/i,
    );
    expect(parallelFirst).toMatch(
      /unaffected eligible Tasks may still be scheduled/i,
    );
    expect(parallelFirst).toMatch(/write sets/i);
    expect(parallelFirst).toMatch(/isolation/i);
    expect(parallelFirst).toMatch(/waiting/i);
    expect(parallelFirst).toMatch(/Review/i);
    expect(parallelFirst).toMatch(/host integration is optional/i);
    expect(parallelFirst).toMatch(/no fixed numeric concurrency cap/i);
    for (const staleRule of [
      /(?:Parent|Full)\s*\/\s*(?:Parent|Full)/i,
      /parallel by default/i,
      /serial_reason/i,
      /Check FAIL/i,
      /bounded batch/i,
      /32-Child/i,
      /Parent cap/i,
      /parallel_limit/i,
    ]) {
      expect(parallelFirst).not.toMatch(staleRule);
    }
    expect(doc("index.md")).toMatch(/Task\/Run critical-path scheduling/);

    const releaseBoundary = doc("release-boundary.md");
    expect(releaseBoundary).toMatch(/Task\/Run 关键路径调度/);
    expect(releaseBoundary).toMatch(/没有固定数值并发上限/);

    const agentsTemplate = fs.readFileSync(
      path.join(cliRoot, "src/templates/markdown/agents.md"),
      "utf8",
    );
    expect(agentsTemplate).toMatch(/critical-path scheduling/i);
    expect(agentsTemplate).toMatch(/Task\/Run\/Review overview/i);
  });
});
