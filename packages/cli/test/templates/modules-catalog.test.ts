import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BASELINE_RETRIEVAL_INTENTS,
  getModuleCatalogPath,
  getModulesRoot,
  listModuleCatalog,
  loadModuleCatalog,
  readModuleContract,
} from "../../src/templates/pactile/modules/catalog.js";

const REQUIRED_HEADINGS = [
  "## 职责",
  "## 触发/披露",
  "## 停止条件",
  "## 关掉必须消失",
  "## 不得带走",
] as const;

const EXPECTED_BASELINE = [
  "intake-basic",
  "define-basic",
  "approval-personal",
  "execute-agent",
  "verify-basic",
  "close-basic",
  "context-progressive",
  "observability-local",
] as const;

const EXPECTED_ON_DEMAND = [
  "define-extended",
  "independent-check",
  "worker-orchestration",
  "parent-child",
  "debug-recovery",
  "session-transfer",
  "spec-learning",
  "vcs-integration",
  "personal-memory",
  "retention-storage",
  "retrieval-extended",
] as const;

describe("P29 module short-contract catalog", () => {
  it("lists all nineteen modules from index.json without parsing the human overview", () => {
    const catalogSource = readFileSync(
      join(getModulesRoot(), "catalog.ts"),
      "utf-8",
    );
    expect(catalogSource).toContain('join(root, "index.json")');
    expect(catalogSource).not.toMatch(/readFileSync\([^)]*workflow/);
    expect(catalogSource).not.toMatch(/from ["'][^"']*trellis["']/);
    expect(getModuleCatalogPath()).toBe(join(getModulesRoot(), "index.json"));

    const catalog = loadModuleCatalog();
    const listed = listModuleCatalog();

    expect(catalog.schema_version).toBe(1);
    expect(catalog.source).toBe("p29-module-table");
    expect(catalog.baseline_intents).toEqual([...BASELINE_RETRIEVAL_INTENTS]);
    expect(catalog.baseline_intents).toHaveLength(4);
    expect(listed).toHaveLength(19);
    expect(listed.map((entry) => entry.id)).toEqual([
      ...EXPECTED_BASELINE,
      ...EXPECTED_ON_DEMAND,
    ]);
    expect(catalog.layers.baseline).toEqual([...EXPECTED_BASELINE]);
    expect(catalog.layers["on-demand"]).toEqual([...EXPECTED_ON_DEMAND]);
  });

  it("has a non-empty contract file for every catalog id with required headings", () => {
    for (const entry of listModuleCatalog()) {
      const body = readModuleContract(entry.id);
      expect(body.trim().length, `${entry.id} contract is empty`).toBeGreaterThan(
        0,
      );
      expect(body).toContain(`# \`${entry.id}\``);
      expect(body).toContain(`P29 表名：\`${entry.id}\``);
      expect(body).toContain(`层：${entry.layer}`);
      for (const heading of REQUIRED_HEADINGS) {
        expect(body, `${entry.id} missing ${heading}`).toContain(heading);
      }
    }
  });

  it("keeps Grill notes only inside define-extended", () => {
    for (const entry of listModuleCatalog()) {
      const body = readModuleContract(entry.id);
      if (entry.id === "define-extended") {
        expect(body).toContain("## Grill 备忘");
        expect(body).toContain("`grill-me`");
        expect(body).toContain("`grill-with-docs`");
        expect(body).toContain("不恢复独立 skill 名作 slash");
        continue;
      }
      expect(body, `${entry.id} must not carry Grill 备忘`).not.toContain(
        "## Grill 备忘",
      );
    }
  });

  it("spot-checks locked short-contract semantics", () => {
    const closeBasic = readModuleContract("close-basic");
    expect(closeBasic).toContain("缺 Git");
    expect(closeBasic).toContain("不得挡 Close");
    expect(closeBasic).toContain("缺 `task-map.md`");
    expect(closeBasic).toContain("缺 `children[]`");

    const observability = readModuleContract("observability-local");
    expect(observability).toContain("零 Prompt");
    expect(observability).toContain("永远不");
    expect(observability).toContain("SessionStart");

    const parentChild = readModuleContract("parent-child");
    expect(parentChild).toContain("Decompose **只出提案**");
    expect(parentChild).toContain("用户确认后才建 Child");
    expect(parentChild).toContain("未确认不得建 Child");

    const retrieval = readModuleContract("retrieval-extended");
    expect(retrieval).toContain("## 检索三层 ABI");
    expect(retrieval).toContain("`context-progressive`");
    expect(retrieval).toContain("Middleware");
    expect(retrieval).toContain("`retrieval-extended`");
    expect(retrieval).toContain("`exact` / `semantic` / `structural` / `external`");
    expect(retrieval).toContain("## 后续不可改");
    expect(retrieval).toContain("不新增第五个常驻检索意图");
    expect(retrieval).toContain("把三层重新合并进 `workflow.md`");
  });
});

describe("module catalog isolation", () => {
  it("loads contracts through the catalog path, not a sibling overview file", () => {
    expect(dirname(getModulesRoot()).endsWith("pactile")).toBe(true);
    expect(getModuleCatalogPath().endsWith("index.json")).toBe(true);
    const listed = listModuleCatalog();
    expect(listed.every((entry) => entry.contract.endsWith("contract.md"))).toBe(
      true,
    );
  });
});
