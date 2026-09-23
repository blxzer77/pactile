import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  scriptsInit,
  commonInit,
  commonPaths,
  commonDeveloper,
  commonGitContext,
  commonTaskQueue,
  commonTaskUtils,
  commonActiveTask,
  commonCliAdapter,
  commonArtifactSearch,
  commonSessionMemory,
  commonSmartSearchEvidence,
  getDeveloperScript,
  initDeveloperScript,
  taskScript,
  getContextScript,
  addSessionScript,
  searchArtifactsScript,
  searchMemoryScript,
  runSmartSearchScript,
  workflowMdTemplate,
  gitignoreTemplate,
  getAllScripts,
  getAllTaskTemplates,
  MAINTAINER_ONLY_SCRIPT_PATHS,
} from "../../src/templates/pactile/index.js";

// =============================================================================
// Template Constants — module-level string exports
// =============================================================================

describe("Pactile template constants", () => {
  const allTemplates = {
    scriptsInit,
    commonInit,
    commonPaths,
    commonDeveloper,
    commonGitContext,
    commonTaskQueue,
    commonTaskUtils,
    commonActiveTask,
    commonCliAdapter,
    commonArtifactSearch,
    commonSessionMemory,
    commonSmartSearchEvidence,
    getDeveloperScript,
    initDeveloperScript,
    taskScript,
    getContextScript,
    addSessionScript,
    searchArtifactsScript,
    searchMemoryScript,
    runSmartSearchScript,
    workflowMdTemplate,
    gitignoreTemplate,
  };

  function normalizeLineEndings(content: string): string {
    return content.replace(/\r\n/g, "\n");
  }

  function readMarketplaceWorkflow(
    relativePath: string,
  ): string | undefined {
    const repoRoot = fs.existsSync(path.join(process.cwd(), "marketplace"))
      ? process.cwd()
      : path.resolve(process.cwd(), "../..");
    const workflowPath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(workflowPath)) {
      return undefined;
    }
    return fs.readFileSync(workflowPath, "utf-8");
  }

  function workflowStateBreadcrumb(status: string): string {
    const match = new RegExp(
      `^\\[workflow-state:${status}\\]\\r?\\n([\\s\\S]*?)^\\[/workflow-state:${status}\\]`,
      "m",
    ).exec(
      workflowMdTemplate,
    );
    if (!match) {
      throw new Error(`${status} breadcrumb block must exist in workflow.md`);
    }
    return match[1];
  }

  it("all templates are non-empty strings", () => {
    for (const [name, content] of Object.entries(allTemplates)) {
      expect(content.length, `${name} should be non-empty`).toBeGreaterThan(0);
    }
  });

  it("Python scripts contain valid Python syntax indicators", () => {
    // scriptsInit (__init__.py) only has docstrings, so use scripts with actual code
    const pyScripts = [
      commonInit,
      commonPaths,
      commonActiveTask,
      commonArtifactSearch,
      commonSessionMemory,
      commonSmartSearchEvidence,
      getDeveloperScript,
      taskScript,
      searchArtifactsScript,
      searchMemoryScript,
      runSmartSearchScript,
    ];
    for (const script of pyScripts) {
      expect(
        script.includes("import") ||
          script.includes("def ") ||
          script.includes("class ") ||
          script.includes("#"),
      ).toBe(true);
    }
  });

  it("scriptsInit is a Python docstring module", () => {
    expect(scriptsInit).toContain('"""');
  });

  it("workflowMdTemplate is markdown", () => {
    expect(workflowMdTemplate).toContain("#");
  });

  it("marketplace native workflow mirror matches the bundled workflow", () => {
    const marketplaceNative = readMarketplaceWorkflow(
      "marketplace/workflows/native/workflow.md",
    );
    if (marketplaceNative === undefined) return;

    expect(normalizeLineEndings(marketplaceNative)).toBe(
      normalizeLineEndings(workflowMdTemplate),
    );
  });

  it("marketplace TDD workflow planning breadcrumbs include behavior gates", () => {
    const tddWorkflow = readMarketplaceWorkflow(
      "marketplace/workflows/tdd/workflow.md",
    );
    if (tddWorkflow === undefined) return;
    const normalized = normalizeLineEndings(tddWorkflow);
    const planning =
      /^\[workflow-state:planning\]\n([\s\S]*?)^\[\/workflow-state:planning\]/m.exec(
        normalized,
      )?.[1];
    const planningInline =
      /^\[workflow-state:planning-inline\]\n([\s\S]*?)^\[\/workflow-state:planning-inline\]/m.exec(
        normalized,
      )?.[1];

    for (const block of [planning, planningInline]) {
      expect(block).toContain("observable behavior slices");
      expect(block).toContain("public interface under test");
      expect(block).toContain("mock boundaries");
    }
  });

  it("workflow.md is a thin interface card, not the runtime SSOT", () => {
    expect(workflowMdTemplate).toMatch(/Human overview[^\n]*not runtime SSOT/i);
    expect(workflowMdTemplate).toContain("## Interfaces");
    for (const artifact of [
      "`prd.md`",
      "`implement.md`",
      "`verify.md`",
      "`task.json`",
      "`kernel.json`",
    ]) {
      expect(workflowMdTemplate).toContain(artifact);
    }
    expect(workflowMdTemplate).not.toContain("## Phase Index");
    expect(workflowMdTemplate).not.toContain("Request Triage");
    expect(workflowMdTemplate).not.toContain("MANDATORY TRIAGE");
    expect(workflowMdTemplate).not.toContain("[Triage:");
  });

  it("workflow.md keeps the Execute and Close command signatures", () => {
    expect(workflowMdTemplate).toContain(
      "task.py start-execution <task> --approved",
    );
    expect(workflowMdTemplate).toContain("task.py archive <task>");
    expect(workflowMdTemplate).toContain("`--check` is preflight only");
  });

  it("workflow.md keeps concise workflow-state breadcrumbs", () => {
    for (const status of ["no_task", "planning", "in_progress", "completed"]) {
      const lines = workflowStateBreadcrumb(status)
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      expect(lines.length, `${status} should contain one or two fact lines`).toBeGreaterThan(0);
      expect(lines.length, `${status} should stay concise`).toBeLessThanOrEqual(2);
    }
    expect(workflowStateBreadcrumb("planning")).toContain(
      "task.py start-execution --approved",
    );
    expect(workflowStateBreadcrumb("in_progress")).toContain(
      "task.py archive",
    );
  });

  it("workflow.md points detailed methods to framework docs", () => {
    expect(workflowMdTemplate).toContain(
      ".pactile/framework/parallel-first-execution.md",
    );
    expect(workflowMdTemplate).toContain(
      ".pactile/framework/verification-strength-guide.md",
    );
    expect(workflowMdTemplate).toContain(
      ".pactile/framework/retrieval-daily-guide.md",
    );
    expect(workflowMdTemplate).toContain(
      ".pactile/framework/cursor-subagent-policy.md",
    );
  });

  it("gitignoreTemplate contains ignore patterns", () => {
    expect(gitignoreTemplate).toContain(".developer");
    expect(gitignoreTemplate).toContain("worktrees/");
    expect(gitignoreTemplate).toContain("__pycache__");
  });

});

function importNames(raw: string): string[] {
  return raw
    .replace(/[()]/g, " ")
    .split(",")
    .map((part) => part.trim().split(/\s+as\s+/)[0]?.trim())
    .filter((name): name is string => Boolean(name) && name !== "*");
}

/** Resolve in-package imports to getAllScripts keys (posix .py paths). */
function localPythonImportTargets(scriptKey: string, source: string): string[] {
  const stripped = source
    .replace(/'''[\s\S]*?'''/g, "\n")
    .replace(/"""[\s\S]*?"""/g, "\n")
    .replace(/#.*$/gm, "");
  const packageDir = path.posix.dirname(scriptKey);
  const targets: string[] = [];

  const joinModule = (baseDir: string, dotted: string): string => {
    const rel = dotted.replaceAll(".", "/");
    if (!baseDir || baseDir === ".") {
      return `${rel}.py`;
    }
    return `${baseDir}/${rel}.py`;
  };

  for (const line of stripped.split("\n")) {
    // Top-level only: nested retrieval/session-memory imports stay maintainer-only.
    if (line.startsWith(" ") || line.startsWith("\t")) continue;
    const trimmed = line.trim();
    const relative = trimmed.match(/^from\s+(\.+)([\w.]*)\s+import\s+(.+)$/);
    if (relative) {
      let base = packageDir === "." ? "" : packageDir;
      for (let i = 1; i < relative[1].length; i += 1) {
        base = path.posix.dirname(base);
        if (base === ".") base = "";
      }
      if (relative[2]) {
        targets.push(joinModule(base, relative[2]));
      } else {
        for (const name of importNames(relative[3])) {
          targets.push(joinModule(base, name));
        }
      }
      continue;
    }
    const fromCommon = trimmed.match(
      /^from\s+(common(?:\.[\w]+)*)\s+import\s+(.+)$/,
    );
    if (fromCommon) {
      if (fromCommon[1] === "common") {
        for (const name of importNames(fromCommon[2])) {
          targets.push(`common/${name}.py`);
        }
      } else {
        targets.push(`${fromCommon[1].replaceAll(".", "/")}.py`);
      }
      continue;
    }
    const importCommon = trimmed.match(/^import\s+(common(?:\.[\w]+)+)/);
    if (importCommon) {
      targets.push(`${importCommon[1].replaceAll(".", "/")}.py`);
    }
  }
  return [...new Set(targets)];
}

// =============================================================================
// getAllScripts — pure function assembling pre-loaded strings
// =============================================================================

describe("getAllScripts", () => {
  it("returns a Map", () => {
    const scripts = getAllScripts();
    expect(scripts).toBeInstanceOf(Map);
  });

  it("contains expected script entries", () => {
    const scripts = getAllScripts();
    expect(scripts.has("__init__.py")).toBe(true);
    expect(scripts.has("common/__init__.py")).toBe(true);
    expect(scripts.has("common/paths.py")).toBe(true);
    expect(scripts.has("common/active_task.py")).toBe(true);
    expect(scripts.has("common/kernel_command.py")).toBe(true);
    expect(scripts.has("task.py")).toBe(true);
    expect(scripts.has("get_developer.py")).toBe(true);
    expect(scripts.has("common/lite_context.py")).toBe(true);
    expect(scripts.has("common/session_pack.py")).toBe(true);
    expect(scripts.has("compile_session_pack.py")).toBe(true);
    expect(scripts.has("common/full_quality.py")).toBe(true);
    expect(scripts.has("common/ondemand_topology.py")).toBe(true);
    expect(scripts.has("common/parallel_declaration.py")).toBe(true);
    expect(scripts.has("common/adapter_middleware.py")).toBe(true);
    expect(scripts.has("common/artifact_search.py")).toBe(true);
    expect(scripts.has("common/injection_budget.py")).toBe(true);
    expect(scripts.has("search_artifacts.py")).toBe(false);
    expect(scripts.has("run_smart_search.py")).toBe(false);
    expect(scripts.has("build_retrieval_pack.py")).toBe(false);
    expect(MAINTAINER_ONLY_SCRIPT_PATHS.has("common/artifact_search.py")).toBe(
      false,
    );
    expect(MAINTAINER_ONLY_SCRIPT_PATHS.has("common/injection_budget.py")).toBe(
      false,
    );
  });

  it("has at least one entry", () => {
    const scripts = getAllScripts();
    expect(scripts.size).toBeGreaterThan(0);
  });

  it("all values are non-empty strings", () => {
    const scripts = getAllScripts();
    for (const [key, value] of scripts) {
      expect(value.length, `${key} should be non-empty`).toBeGreaterThan(0);
    }
  });

  it("values match the exported constants", () => {
    const scripts = getAllScripts();
    expect(scripts.get("__init__.py")).toBe(scriptsInit);
    expect(scripts.get("common/__init__.py")).toBe(commonInit);
    expect(scripts.get("task.py")).toBe(taskScript);
  });

  it("does not contain multi_agent entries", () => {
    const scripts = getAllScripts();
    for (const [key] of scripts) {
      expect(key, `${key} should not be a multi_agent script`).not.toContain("multi_agent");
    }
  });

  it("does not ship maintainer-only probe or test scripts", () => {
    const scripts = getAllScripts();
    expect(scripts.has("cursor_retrieval_probe.py")).toBe(false);
    expect(scripts.has("common/test_retrieval_arbitration.py")).toBe(false);
    expect(scripts.has("aggregate_retrieval_telemetry.py")).toBe(false);
    expect(scripts.has("batch_plan_envelope.py")).toBe(false);
  });

  it("shipped Python files form a closed import graph", () => {
    const scripts = getAllScripts();
    const missing: string[] = [];
    for (const [key, source] of scripts) {
      if (!key.endsWith(".py")) continue;
      for (const target of localPythonImportTargets(key, source)) {
        if (!scripts.has(target)) {
          missing.push(`${key} -> ${target}`);
        }
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });
});

describe("getAllTaskTemplates", () => {
  it("returns release-readiness and release-execution template files", () => {
    const templates = getAllTaskTemplates();
    expect(templates.size).toBe(10);
    for (const rel of [
      "tasks/templates/release-readiness/prd.md",
      "tasks/templates/release-readiness/design.md",
      "tasks/templates/release-readiness/implement.md",
      "tasks/templates/release-readiness/handoff-template.md",
      "tasks/templates/release-execution/prd.md",
      "tasks/templates/release-execution/design.md",
      "tasks/templates/release-execution/implement.md",
      "tasks/templates/release-execution/handoff-template.md",
      "tasks/locale/zh/default-prd.md",
      "tasks/locale/en/default-prd.md",
    ]) {
      expect(templates.has(rel), rel).toBe(true);
      const template = templates.get(rel);
      expect(template, rel).toBeDefined();
      expect(template?.length).toBeGreaterThan(0);
    }
  });

  it("release-execution templates require explicit publish approval", () => {
    const templates = getAllTaskTemplates();
    const executionDesign = templates.get(
      "tasks/templates/release-execution/design.md",
    );
    expect(executionDesign).toBeDefined();
    expect(executionDesign).toContain("Approval gate (mandatory)");
    expect(executionDesign).toContain("explicit user approval");
    const readinessPrd = templates.get(
      "tasks/templates/release-readiness/prd.md",
    );
    expect(readinessPrd).toBeDefined();
    expect(readinessPrd).toMatch(/without.*publishing/i);
  });
});
