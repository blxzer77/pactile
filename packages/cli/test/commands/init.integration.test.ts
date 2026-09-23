/**
 * Integration tests for the init() command.
 *
 * Tests the full init flow in real temp directories with minimal mocking.
 * Only external dependencies are mocked: figlet, inquirer, child_process.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// === External dependency mocks (hoisted by vitest) ===

vi.mock("figlet", () => ({
  default: { textSync: vi.fn(() => "PACTILE") },
}));

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn().mockResolvedValue({}) },
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue(""),
}));

// === Imports ===

import { init } from "../../src/commands/init.js";
import { VERSION } from "../../src/constants/version.js";
import { DIR_NAMES, FILE_NAMES, PATHS } from "../../src/constants/paths.js";
import { frameworkDocs } from "../../src/templates/markdown/index.js";
import { replacePythonCommandLiterals } from "../../src/configurators/shared.js";
import {
  PACTILE_BLOCK_END,
  PACTILE_BLOCK_START,
  extractBlock,
} from "../../src/utils/agents-md.js";
import { execSync } from "node:child_process";
import inquirer from "inquirer";

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

function capabilityLookupCommand(command: string): string {
  return process.platform === "win32"
    ? `where "${command}"`
    : `command -v '${command}'`;
}

function npmPackageLookupCommand(packageName: string): string {
  return process.platform === "win32"
    ? `npm view "${packageName}" bin --json`
    : `npm view '${packageName}' bin --json`;
}

describe("init() integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-init-int-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.spyOn(console, "log").mockImplementation(noop);
    vi.spyOn(console, "warn").mockImplementation(noop);
    vi.spyOn(console, "error").mockImplementation(noop);
    vi.mocked(inquirer.prompt).mockReset();
    vi.mocked(inquirer.prompt).mockResolvedValue({});
    vi.mocked(execSync).mockClear();
    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      const expectedPythonCmd =
        process.platform === "win32" ? "python" : "python3";
      if (cmd === `${expectedPythonCmd} --version`) {
        return "Python 3.11.12";
      }
      if (cmd === "smart-search doctor --format json") {
        return JSON.stringify({ ok: true, minimum_profile_ok: true });
      }
      return "";
    }) as typeof execSync);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("#1 creates expected directory structure with defaults", async () => {
    await init({ yes: true });

    // Core workflow structure
    expect(fs.existsSync(path.join(tmpDir, DIR_NAMES.WORKFLOW))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, PATHS.SCRIPTS))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, PATHS.WORKSPACE))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, PATHS.TASKS))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, PATHS.SPEC))).toBe(true);

    // Codex is the only active host; baseline native project support may be unavailable.
    expect(fs.existsSync(path.join(tmpDir, ".cursor"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".codex"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".agents", "skills"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".agent", "workflows"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".kiro", "skills"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".gemini"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".qoder"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".codebuddy"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".windsurf", "workflows"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(tmpDir, ".github", "copilot"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".factory"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".pi"))).toBe(false);

    // Root files
    expect(fs.existsSync(path.join(tmpDir, "AGENTS.md"))).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, DIR_NAMES.WORKFLOW, "capabilities.json")),
    ).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".mcp.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".cursor", "mcp.json"))).toBe(false);

    // No Cursor command, rule, or agent is installed.
    expect(
      fs.existsSync(
        path.join(tmpDir, ".cursor", "commands", "pactile.md"),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(tmpDir, ".cursor", "rules", "pactile.mdc"),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(tmpDir, ".cursor", "agents", "pactile.md"),
      ),
    ).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".cursor", "skills"))).toBe(false);
  });

  it("#1f writes selected capability facts without bypassing ProjectionStore", async () => {
    await init({
      yes: true,
      codex: true,
      user: "dev",
      capability: ["fast-context-mcp", "fastctx"],
    });

    const capabilities = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, DIR_NAMES.WORKFLOW, "capabilities.json"),
        "utf-8",
      ),
    ) as {
      selected: string[];
      schema_version: number;
      capabilities: Record<string, { readiness_status?: string }>;
    };
    expect(capabilities.selected).toEqual([
      "codebase-retrieval",
      "fastctx",
    ]);
    expect(capabilities.schema_version).toBe(3);
    expect(
      capabilities.capabilities["codebase-retrieval"]?.readiness_status,
    ).toBe("pending");
    expect(
      capabilities.capabilities["fastctx"]?.readiness_status,
    ).toBe("pending");

    // Canonical capability facts are committed first. Init does not call the
    // old direct host writer for MCP configuration.
    expect(fs.existsSync(path.join(tmpDir, ".cursor", "mcp.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".mcp.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".codex", "config.toml"))).toBe(false);

    const bootstrapPrd = fs.readFileSync(
      path.join(tmpDir, PATHS.TASKS, "00-bootstrap-guidelines", "prd.md"),
      "utf-8",
    );
    expect(bootstrapPrd).toContain("## Capability readiness (required before archive)");
    expect(bootstrapPrd).toContain("`codebase-retrieval`");
    expect(bootstrapPrd).toContain("`fastctx`");
    expect(bootstrapPrd).toContain("watcher auto-syncs later edits");
  });


  it("#1f.0 default init never writes the optional-skill directory", async () => {
    await init({ yes: true });

    // No optional skill ships today; the machinery must stay off by default.
    expect(fs.existsSync(path.join(tmpDir, ".cursor", "skills"))).toBe(false);
  });

  it("#1f.0a --with-optional fails before writing host or canonical state", async () => {
    await expect(
      init({ yes: true, withOptional: ["example-skill"] }),
    ).rejects.toThrow(/no longer writes host skill directories/);
    expect(fs.existsSync(path.join(tmpDir, ".cursor", "skills"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, DIR_NAMES.WORKFLOW))).toBe(false);
  });

  it("#1f.1 records fastctx without projecting a machine-local path", async () => {
    await init({
      yes: true,
      codex: true,
      capability: ["fastctx"],
    });

    const capabilities = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, DIR_NAMES.WORKFLOW, "capabilities.json"),
        "utf-8",
      ),
    ) as { selected: string[] };
    expect(capabilities.selected).toEqual(["fastctx"]);

    // fastctx declares no MCP server, and its stable binary lives under the
    // user profile. init must not invent a project-level MCP entry for it.
    expect(fs.existsSync(path.join(tmpDir, ".cursor", "mcp.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".mcp.json"))).toBe(false);
  });

  it("#1b does not print the promotional pain-point block", async () => {
    await init({ yes: true });

    const logOutput = vi
      .mocked(console.log)
      .mock.calls.flat()
      .filter((part): part is string => typeof part === "string")
      .join("\n");

    expect(logOutput).not.toContain("Sound familiar?");
    expect(logOutput).not.toContain("You'll never say these again!!");
    expect(logOutput).not.toContain("Wrote CLAUDE.md, AI ignored it");
  });

  it("#1c verifies Smart Search readiness during init", async () => {
    await init({ yes: true });

    expect(execSync).toHaveBeenCalledWith(
      "smart-search doctor --format json",
      expect.objectContaining({
        encoding: "utf-8",
        stdio: "pipe",
      }),
    );
  });

  it("#1d continues init when Smart Search readiness fails", async () => {
    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      const expectedPythonCmd =
        process.platform === "win32" ? "python" : "python3";
      if (cmd === `${expectedPythonCmd} --version`) {
        return "Python 3.11.12";
      }
      if (cmd === "smart-search doctor --format json") {
        const error = new Error("Command failed: smart-search doctor");
        Object.assign(error, {
          status: 2,
          stdout: JSON.stringify({
            ok: false,
            minimum_profile_ok: false,
            minimum_profile_missing: ["main_search"],
            error_type: "config_error",
            error: "standard minimum profile is not configured",
          }),
        });
        throw error;
      }
      return "";
    }) as typeof execSync);

    await init({ yes: true, codex: true });

    expect(execSync).not.toHaveBeenCalledWith(
      "smart-search setup",
      expect.anything(),
    );
    expect(fs.existsSync(path.join(tmpDir, DIR_NAMES.WORKFLOW))).toBe(true);
    expect(
      fs.existsSync(
        path.join(tmpDir, ".cursor", "rules", "pactile.mdc"),
      ),
    ).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/Smart Search readiness unverified/),
    );
  });

  it("#1d.1 interactive init still writes files when Smart Search readiness fails", async () => {
    let doctorCalls = 0;
    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      const expectedPythonCmd =
        process.platform === "win32" ? "python" : "python3";
      if (cmd === `${expectedPythonCmd} --version`) {
        return "Python 3.11.12";
      }
      if (cmd === "smart-search doctor --format json") {
        doctorCalls += 1;
        const error = new Error("Command failed: smart-search doctor");
        Object.assign(error, {
          status: 2,
          stdout: JSON.stringify({
            ok: false,
            minimum_profile_ok: false,
            minimum_profile_missing: ["main_search"],
            error_type: "config_error",
            error: "standard minimum profile is not configured",
          }),
        });
        throw error;
      }
      return "";
    }) as typeof execSync);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: 1, templates: [] }),
      }),
    );
    vi.mocked(inquirer.prompt)
      .mockResolvedValueOnce({ tools: ["claude"] })
      .mockResolvedValueOnce({ capabilities: [] });

    await init({ user: "test-dev" });

    expect(doctorCalls).toBe(1);
    expect(execSync).not.toHaveBeenCalledWith(
      "smart-search setup",
      expect.anything(),
    );
    expect(fs.existsSync(path.join(tmpDir, DIR_NAMES.WORKFLOW))).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/Smart Search readiness unverified/),
    );
    expect(inquirer.prompt).not.toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          name: "smartSearchSetupAction",
        }),
      ]),
    );
  });

  it("#1e --skip-readiness bypasses Smart Search doctor and reports unverified readiness", async () => {
    await init({ yes: true, skipReadiness: true });

    const calls = vi.mocked(execSync).mock.calls;
    expect(
      calls.some(([cmd]) => cmd === "smart-search doctor --format json"),
    ).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, DIR_NAMES.WORKFLOW))).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("framework readiness is not verified"),
    );
  });

  it("#1g continues init when selected capability readiness fails", async () => {
    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      const expectedPythonCmd =
        process.platform === "win32" ? "python" : "python3";
      if (cmd === `${expectedPythonCmd} --version`) {
        return "Python 3.11.12";
      }
      if (cmd === "smart-search doctor --format json") {
        return JSON.stringify({ ok: true, minimum_profile_ok: true });
      }
      if (cmd === capabilityLookupCommand("rg")) {
        throw new Error("rg not found");
      }
      return "";
    }) as typeof execSync);

    await init({
      yes: true,
      codex: true,
      capability: ["codebase-retrieval"],
    });
    expect(fs.existsSync(path.join(tmpDir, DIR_NAMES.WORKFLOW))).toBe(true);
    expect(
      fs.existsSync(
        path.join(tmpDir, ".cursor", "rules", "pactile.mdc"),
      ),
    ).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/codebase-retrieval capability unverified/),
    );
  });

  it("#1h --skip-readiness bypasses selected capability probes", async () => {
    await init({
      yes: true,
      skipReadiness: true,
      capability: ["codebase-retrieval"],
    });

    const calls = vi.mocked(execSync).mock.calls;
    expect(calls.some(([cmd]) => cmd === capabilityLookupCommand("rg"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(tmpDir, DIR_NAMES.WORKFLOW))).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Selected project capability readiness skipped"),
    );
  });

  it("#1h.1 interactive init still writes files when selected capability readiness fails", async () => {
    let capabilityLookups = 0;
    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      const expectedPythonCmd =
        process.platform === "win32" ? "python" : "python3";
      if (cmd === `${expectedPythonCmd} --version`) {
        return "Python 3.11.12";
      }
      if (cmd === "smart-search doctor --format json") {
        return JSON.stringify({ ok: true, minimum_profile_ok: true });
      }
      if (cmd === capabilityLookupCommand("rg")) {
        capabilityLookups += 1;
        throw new Error("rg not found");
      }
      return "";
    }) as typeof execSync);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: 1, templates: [] }),
      }),
    );

    await init({
      user: "test-dev",
      codex: true,
      capability: ["codebase-retrieval"],
    });

    expect(capabilityLookups).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(tmpDir, DIR_NAMES.WORKFLOW))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".cursor", "mcp.json"))).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/codebase-retrieval capability unverified/),
    );
    expect(inquirer.prompt).not.toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          name: "capabilitySetupAction",
        }),
      ]),
    );
  });

  it("#1i warns when CodeGraph index freshness is not proven", async () => {
    await init({ yes: true, capability: ["codegraph"] });

    expect(execSync).toHaveBeenCalledWith(
      capabilityLookupCommand("rg"),
      expect.objectContaining({
        encoding: "utf-8",
        stdio: "pipe",
      }),
    );
    expect(execSync).toHaveBeenCalledWith(
      capabilityLookupCommand("npx"),
      expect.objectContaining({
        encoding: "utf-8",
        stdio: "pipe",
      }),
    );
    expect(execSync).toHaveBeenCalledWith(
      npmPackageLookupCommand("@colbymchenry/codegraph"),
      expect.objectContaining({
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 5000,
      }),
    );
    expect(fs.existsSync(path.join(tmpDir, DIR_NAMES.WORKFLOW))).toBe(true);
    const capabilitiesMd = fs.readFileSync(
      path.join(tmpDir, DIR_NAMES.WORKFLOW, "capabilities.md"),
      "utf-8",
    );
    expect(capabilitiesMd).toContain("## CLI Automation Guidance");
    expect(capabilitiesMd).toContain("`codegraph status <path> --json`");
    expect(capabilitiesMd).toContain(
      "`codegraph impact <symbol> --path <path> --depth <n> --json`",
    );
    expect(capabilitiesMd).toContain(
      "`codegraph affected <changed-files...> --path <path> --json`",
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("No common CodeGraph index marker was found"),
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Structural graph output remains unverified"),
    );
  });

  it("#1j continues init when a generated semantic MCP adapter package is unavailable", async () => {
    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      const expectedPythonCmd =
        process.platform === "win32" ? "python" : "python3";
      if (cmd === `${expectedPythonCmd} --version`) {
        return "Python 3.11.12";
      }
      if (cmd === "smart-search doctor --format json") {
        return JSON.stringify({ ok: true, minimum_profile_ok: true });
      }
      if (cmd === npmPackageLookupCommand("fast-context-mcp")) {
        throw new Error("fast-context-mcp not found");
      }
      return "";
    }) as typeof execSync);

    await init({
      yes: true,
      codex: true,
      capability: ["codebase-retrieval"],
    });
    expect(fs.existsSync(path.join(tmpDir, DIR_NAMES.WORKFLOW))).toBe(true);
    expect(
      fs.existsSync(
        path.join(tmpDir, ".cursor", "rules", "pactile.mdc"),
      ),
    ).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/codebase-retrieval capability unverified/),
    );
  });

  it("#1k continues init when a selected capability is not adopted yet", async () => {
    // fastctx readiness depends on a machine-local stable binary, so this
    // asserts the outcome-agnostic contract: a capability that is declared but
    // not adopted must be reported, never treated as a hard stop.
    await init({ yes: true, codex: true, capability: ["fastctx"] });

    expect(fs.existsSync(path.join(tmpDir, DIR_NAMES.WORKFLOW))).toBe(true);
    expect(
      fs.existsSync(
        path.join(tmpDir, ".cursor", "rules", "pactile.mdc"),
      ),
    ).toBe(false);
    const capabilities = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, DIR_NAMES.WORKFLOW, "capabilities.json"),
        "utf-8",
      ),
    ) as { selected: string[] };
    expect(capabilities.selected).toEqual(["fastctx"]);
  });

  it("#2 Codex-only init does not create another host directory", async () => {
    await init({ yes: true, codex: true });

    expect(fs.existsSync(path.join(tmpDir, ".cursor"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".claude"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".codex"))).toBe(false);
    expect(
      fs.existsSync(
        path.join(tmpDir, ".cursor", "commands", "pactile.md"),
      ),
    ).toBe(false);
  });

  

  

  

  

  

  

  

  

  

  

  

  it("#4 force mode overwrites previously modified files", async () => {
    await init({ yes: true, force: true });

    const workflowMd = path.join(tmpDir, PATHS.WORKFLOW_GUIDE_FILE);
    const original = fs.readFileSync(workflowMd, "utf-8");
    fs.writeFileSync(workflowMd, "user modified content");

    await init({ yes: true, force: true });

    expect(fs.readFileSync(workflowMd, "utf-8")).toBe(original);
  });

  it("#5 skip mode preserves previously modified files", async () => {
    await init({ yes: true, force: true });

    const workflowMd = path.join(tmpDir, PATHS.WORKFLOW_GUIDE_FILE);
    fs.writeFileSync(workflowMd, "user modified content");

    await init({ yes: true, skipExisting: true });

    expect(fs.readFileSync(workflowMd, "utf-8")).toBe("user modified content");
  });

  it("#6 re-init preserves managed files and stabilizes durable audit state", async () => {
    await init({ yes: true, force: true });

    const collectFiles = (dir: string): string[] => {
      const files: string[] = [];
      const walk = (d: string) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) walk(full);
          else files.push(path.relative(tmpDir, full));
        }
      };
      walk(dir);
      return files.sort();
    };

    const firstManaged = collectFiles(tmpDir).filter(
      (entry) => !entry.startsWith(`.pactile${path.sep}runtime${path.sep}`),
    );
    const generationRoot = path.join(
      tmpDir,
      ".pactile",
      "runtime",
      "generations",
    );
    expect(fs.readdirSync(generationRoot)).toHaveLength(1);

    await init({ yes: true, force: true });
    const secondManaged = collectFiles(tmpDir).filter(
      (entry) => !entry.startsWith(`.pactile${path.sep}runtime${path.sep}`),
    );

    expect(secondManaged).toEqual(firstManaged);
    expect(fs.readdirSync(generationRoot)).toHaveLength(1);

    const afterFirstReinit = collectFiles(
      path.join(tmpDir, ".pactile", "runtime"),
    );
    await init({ yes: true, force: true });
    expect(
      collectFiles(path.join(tmpDir, ".pactile", "runtime")),
    ).toEqual(afterFirstReinit);
  });

  it("#7 passes developer name to init_developer script", async () => {
    await init({ yes: true, user: "testdev" });

    const calls = vi.mocked(execSync).mock.calls;
    const match = calls.find(
      ([cmd]) => typeof cmd === "string" && cmd.includes("init_developer.py"),
    );
    expect(match).toBeDefined();
    const command = String((match as [unknown])[0]);
    const expectedPythonCmd =
      process.platform === "win32" ? "python" : "python3";
    expect(command).toContain(`${expectedPythonCmd} "`);
    expect(command).toContain('"testdev"');
  });

  it("#7b throws when the selected Python command is below 3.9", async () => {
    // v0.5.7: init now tries a fallback chain (#236). Mock every candidate to
    // return the same too-old version so all candidates fail uniformly.
    vi.mocked(execSync).mockImplementation(
      (() => "Python 3.8.18") as typeof execSync,
    );

    await expect(init({ yes: true, codex: true })).rejects.toThrow(
      /No supported Python command found.*Python 3\.8\.18 \(< 3\.9\)/s,
    );
    expect(fs.existsSync(path.join(tmpDir, DIR_NAMES.WORKFLOW))).toBe(false);
  });

  it("#7c throws when the selected Python command is missing", async () => {
    // v0.5.7: init now tries a fallback chain (#236). Mock every candidate to
    // throw "not found" so all candidates fail.
    vi.mocked(execSync).mockImplementation((() => {
      throw new Error("not found");
    }) as typeof execSync);

    await expect(init({ yes: true, codex: true })).rejects.toThrow(
      /No supported Python command found.*not found/s,
    );
    expect(fs.existsSync(path.join(tmpDir, DIR_NAMES.WORKFLOW))).toBe(false);
  });

  it("#7d renders the platform Python command into canonical generated text", async () => {
    const expectedPythonCmd =
      process.platform === "win32" ? "python" : "python3";

    await init({ yes: true, codex: true });

    const workspaceIndex = fs.readFileSync(
      path.join(tmpDir, PATHS.WORKSPACE, "index.md"),
      "utf-8",
    );
    expect(workspaceIndex).toContain(
      `${expectedPythonCmd} ./.pactile/scripts/init_developer.py`,
    );
  });

  it("#8 writes correct version file", async () => {
    await init({ yes: true });

    const content = fs.readFileSync(
      path.join(tmpDir, DIR_NAMES.WORKFLOW, ".version"),
      "utf-8",
    );
    expect(content).toBe(VERSION);
  });

  it("#9 initializes template hash tracking file", async () => {
    await init({ yes: true });

    const hashPath = path.join(
      tmpDir,
      DIR_NAMES.WORKFLOW,
      ".template-hashes.json",
    );
    expect(fs.existsSync(hashPath)).toBe(true);
    const hashesFile = JSON.parse(fs.readFileSync(hashPath, "utf-8")) as {
      hashes?: Record<string, string>;
    };
    const hashes = hashesFile.hashes ?? {};
    const agentsContent = fs.readFileSync(
      path.join(tmpDir, FILE_NAMES.AGENTS),
      "utf-8",
    );
    const pactileBlock = extractBlock(
      agentsContent,
      PACTILE_BLOCK_START,
      PACTILE_BLOCK_END,
    );
    expect(pactileBlock).not.toBeNull();
    if (pactileBlock === null) {
      throw new Error("expected generated AGENTS.md to contain the managed block");
    }
    expect(hashes[FILE_NAMES.AGENTS]).toBeUndefined();
    expect(Object.keys(hashes).length).toBeGreaterThan(0);
  });

  it("#10 creates spec templates for backend, frontend, and guides", async () => {
    await init({ yes: true });

    const specDir = path.join(tmpDir, PATHS.SPEC);
    expect(fs.existsSync(path.join(specDir, "backend", "index.md"))).toBe(true);
    expect(fs.existsSync(path.join(specDir, "frontend", "index.md"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(specDir, "guides", "index.md"))).toBe(true);
  });

  it("#10a init writes every frameworkDocs entry into .pactile/framework/", async () => {
    await init({ yes: true });

    const frameworkDir = path.join(tmpDir, PATHS.FRAMEWORK);
    for (const doc of frameworkDocs) {
      expect(fs.existsSync(path.join(frameworkDir, doc.name))).toBe(true);
      // init applies the same python3→python rewrite as update.ts so
      // same-version updates are a true no-op
      expect(
        fs.readFileSync(path.join(frameworkDir, doc.name), "utf-8"),
      ).toBe(replacePythonCommandLiterals(doc.content));
    }
    expect(fs.existsSync(path.join(frameworkDir, "index.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, PATHS.MIDDLEWARE))).toBe(false);
  });

  it("#10b spec/guides seeds stay init-only (8 guides + index; no moved docs, no maintainer runbooks)", async () => {
    await init({ yes: true });

    const guidesDir = path.join(tmpDir, PATHS.SPEC, "guides");
    const shipped = fs.readdirSync(guidesDir).sort();
    expect(shipped).toEqual([
      "code-reuse-thinking-guide.md",
      "cross-layer-thinking-guide.md",
      "cross-platform-thinking-guide.md",
      "debug-loop-guide.md",
      "durable-learning-decision-guide.md",
      "e2e-walkthrough-guide.md",
      "index.md",
      "prototype-guide.md",
      "test-discipline-guide.md",
    ]);
    expect(
      fs.readFileSync(path.join(guidesDir, "index.md"), "utf-8"),
    ).toContain("[E2E Walkthrough Guide](./e2e-walkthrough-guide.md)");
    expect(
      fs.readFileSync(
        path.join(guidesDir, "test-discipline-guide.md"),
        "utf-8",
      ),
    ).toContain("[E2E Walkthrough Guide](./e2e-walkthrough-guide.md)");

    // None of the relocated framework docs ship under spec/guides/
    // (index.md stays in both locations by design — spec seed + framework index)
    const movedNames = frameworkDocs
      .map((doc) => doc.name)
      .filter((name) => name !== "index.md");
    for (const name of movedNames) {
      expect(fs.existsSync(path.join(guidesDir, name))).toBe(false);
    }
    expect(
      fs.existsSync(path.join(guidesDir, "goal-release-regression-runbook.md")),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(guidesDir, "pactile-release-coexistence-guide.md"),
      ),
    ).toBe(false);
  });

  it("#11 backend project init skips frontend spec templates", async () => {
    // go.mod triggers detectProjectType → "backend"
    fs.writeFileSync(path.join(tmpDir, "go.mod"), "module example.com/app\n");

    await init({ yes: true });

    const specDir = path.join(tmpDir, PATHS.SPEC);
    expect(fs.existsSync(path.join(specDir, "backend", "index.md"))).toBe(true);
    expect(fs.existsSync(path.join(specDir, "frontend"))).toBe(false);
    expect(fs.existsSync(path.join(specDir, "guides", "index.md"))).toBe(true);
  });

  it("#12 frontend project init skips backend spec templates", async () => {
    // vite.config.ts triggers detectProjectType → "frontend"
    fs.writeFileSync(
      path.join(tmpDir, "vite.config.ts"),
      "export default {}\n",
    );

    await init({ yes: true });

    const specDir = path.join(tmpDir, PATHS.SPEC);
    expect(fs.existsSync(path.join(specDir, "frontend", "index.md"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(specDir, "backend"))).toBe(false);
    expect(fs.existsSync(path.join(specDir, "guides", "index.md"))).toBe(true);
  });

  // ===========================================================================
  // Monorepo integration tests
  // ===========================================================================

  /** Helper: set up a pnpm workspace with two packages */
  function setupPnpmWorkspace(
    dir: string,
    packages: { rel: string; name: string; files?: Record<string, string> }[],
  ): void {
    fs.writeFileSync(
      path.join(dir, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n",
    );
    for (const pkg of packages) {
      const pkgDir = path.join(dir, pkg.rel);
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name: pkg.name }),
      );
      if (pkg.files) {
        for (const [name, content] of Object.entries(pkg.files)) {
          fs.writeFileSync(path.join(pkgDir, name), content);
        }
      }
    }
  }

  it("#13 monorepo: creates per-package spec directories", async () => {
    // @app/web: vite.config.ts → frontend (package.json also present → still frontend)
    // @app/api: package.json + go.mod → fullstack (both indicators present)
    setupPnpmWorkspace(tmpDir, [
      {
        rel: "packages/web",
        name: "@app/web",
        files: { "vite.config.ts": "" },
      },
      { rel: "packages/api", name: "@app/api", files: { "go.mod": "" } },
    ]);

    await init({ yes: true });

    const specDir = path.join(tmpDir, PATHS.SPEC);
    // Per-package spec dirs created with sanitized names (scope stripped)
    expect(fs.existsSync(path.join(specDir, "web"))).toBe(true);
    expect(fs.existsSync(path.join(specDir, "api"))).toBe(true);

    // web: frontend (vite.config.ts) → has frontend/, no backend/
    expect(
      fs.existsSync(path.join(specDir, "web", "frontend", "index.md")),
    ).toBe(true);
    expect(fs.existsSync(path.join(specDir, "web", "backend"))).toBe(false);

    // api: fullstack (package.json + go.mod) → has both backend/ and frontend/
    expect(
      fs.existsSync(path.join(specDir, "api", "backend", "index.md")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(specDir, "api", "frontend", "index.md")),
    ).toBe(true);

    // Guides still created (shared)
    expect(fs.existsSync(path.join(specDir, "guides", "index.md"))).toBe(true);

    // Global backend/frontend should NOT exist (monorepo mode)
    expect(fs.existsSync(path.join(specDir, "backend"))).toBe(false);
    expect(fs.existsSync(path.join(specDir, "frontend"))).toBe(false);
  });

  it("#14 monorepo: writes packages section to config.yaml", async () => {
    setupPnpmWorkspace(tmpDir, [
      { rel: "packages/cli", name: "@example/cli" },
      { rel: "packages/docs", name: "@example/docs" },
    ]);

    await init({ yes: true });

    const configPath = path.join(tmpDir, DIR_NAMES.WORKFLOW, "config.yaml");
    expect(fs.existsSync(configPath)).toBe(true);

    const configContent = fs.readFileSync(configPath, "utf-8");
    expect(configContent).toContain("packages:");
    expect(configContent).toContain("cli:");
    expect(configContent).toContain("path: packages/cli");
    expect(configContent).toContain("docs:");
    expect(configContent).toContain("path: packages/docs");
    expect(configContent).toContain("default_package:");
  });

  it("#15 monorepo: bootstrap task references per-package spec paths", async () => {
    setupPnpmWorkspace(tmpDir, [
      { rel: "packages/core", name: "core" },
      { rel: "packages/ui", name: "ui" },
    ]);

    await init({ yes: true, user: "dev" });

    const taskDir = path.join(tmpDir, PATHS.TASKS, "00-bootstrap-guidelines");
    expect(fs.existsSync(taskDir)).toBe(true);

    const taskJson = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"),
    );

    // task.json.subtasks is canonical string[] (child task dir names);
    // per-package checklist items now live in prd.md as markdown checkboxes.
    expect(Array.isArray(taskJson.subtasks)).toBe(true);
    expect(taskJson.subtasks).toEqual([]);

    // Canonical shape: legacy current_phase / next_action must NOT appear
    expect(taskJson.current_phase).toBeUndefined();
    expect(taskJson.next_action).toBeUndefined();

    // relatedFiles point to spec/<name>/
    expect(taskJson.relatedFiles).toContain(".pactile/spec/core/");
    expect(taskJson.relatedFiles).toContain(".pactile/spec/ui/");

    // prd.md mentions packages + renders per-package checklist items
    const prd = fs.readFileSync(path.join(taskDir, "prd.md"), "utf-8");
    const expectedPythonCmd =
      process.platform === "win32" ? "python" : "python3";
    expect(prd).toContain("core");
    expect(prd).toContain("ui");
    expect(prd).toContain("spec/");
    expect(prd).toContain("- [ ] Fill guidelines for core");
    expect(prd).toContain("- [ ] Fill guidelines for ui");
    expect(prd).not.toContain(
      `${expectedPythonCmd} ./.pactile/scripts/task.py finish`,
    );
    expect(prd).toContain(
      `${expectedPythonCmd} ./.pactile/scripts/task.py archive 00-bootstrap-guidelines`,
    );
  });

  it("#16 --no-monorepo skips detection even with workspace config", async () => {
    setupPnpmWorkspace(tmpDir, [{ rel: "packages/a", name: "a" }]);

    await init({ yes: true, monorepo: false });

    const specDir = path.join(tmpDir, PATHS.SPEC);
    // Single-repo spec (global backend + frontend), no per-package dirs
    expect(fs.existsSync(path.join(specDir, "backend", "index.md"))).toBe(true);
    expect(fs.existsSync(path.join(specDir, "frontend", "index.md"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(specDir, "a"))).toBe(false);

    // config.yaml should NOT have packages: section
    const configContent = fs.readFileSync(
      path.join(tmpDir, DIR_NAMES.WORKFLOW, "config.yaml"),
      "utf-8",
    );
    expect(configContent).not.toMatch(/^packages\s*:/m);
  });

  it("#17 --monorepo without workspace config exits with error", async () => {
    // Empty directory — no workspace configs
    const logSpy = vi.mocked(console.log);

    await init({ yes: true, monorepo: true });

    // Should log error about missing multi-package layout
    const errorCall = logSpy.mock.calls.find(
      ([msg]) =>
        typeof msg === "string" &&
        msg.includes("no multi-package layout detected"),
    );
    expect(errorCall).toBeDefined();

    // Should also print the manual config.yaml example as guidance
    const guideCall = logSpy.mock.calls.find(
      ([msg]) => typeof msg === "string" && msg.includes("git: true"),
    );
    expect(guideCall).toBeDefined();

    // Should NOT create .pactile/ (early return)
    expect(fs.existsSync(path.join(tmpDir, DIR_NAMES.WORKFLOW))).toBe(false);
  });

  it("#20 -y --registry aborts on probe failure instead of direct download fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await init({
      yes: true,
      registry: "bitbucket:myorg/registry/spec",
    });

    const logOutput = vi
      .mocked(console.log)
      .mock.calls.flat()
      .filter((part): part is string => typeof part === "string")
      .join("\n");

    expect(logOutput).toContain("Error: Could not reach registry index");
    expect(fs.existsSync(path.join(tmpDir, DIR_NAMES.WORKFLOW))).toBe(false);
  });

  it("#19 polyrepo: writes git: true for sibling .git packages", async () => {
    // Two sibling .git directories — polyrepo fallback should pick them up
    fs.mkdirSync(path.join(tmpDir, "frontend", ".git"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "backend", ".git"), { recursive: true });

    await init({ yes: true });

    const configPath = path.join(tmpDir, DIR_NAMES.WORKFLOW, "config.yaml");
    expect(fs.existsSync(configPath)).toBe(true);

    const configContent = fs.readFileSync(configPath, "utf-8");
    // Slice off only the auto-generated section so commented-out template
    // examples (which legitimately mention `type: submodule`) do not pollute
    // the assertion.
    const generatedIdx = configContent.indexOf(
      "# Auto-detected monorepo packages",
    );
    expect(generatedIdx).toBeGreaterThanOrEqual(0);
    const generated = configContent.slice(generatedIdx);

    expect(generated).toContain("packages:");
    expect(generated).toContain("frontend:");
    expect(generated).toContain("backend:");
    expect(generated).toContain("path: frontend");
    expect(generated).toContain("path: backend");
    // Polyrepo packages should be marked git: true, NOT type: submodule
    expect(generated).toContain("git: true");
    expect(generated).not.toContain("type: submodule");
  });

  it("#18 monorepo: re-init does not duplicate packages in config.yaml", async () => {
    setupPnpmWorkspace(tmpDir, [{ rel: "packages/lib", name: "lib" }]);

    await init({ yes: true, force: true });
    await init({ yes: true, force: true });

    const configContent = fs.readFileSync(
      path.join(tmpDir, DIR_NAMES.WORKFLOW, "config.yaml"),
      "utf-8",
    );
    // packages: should appear exactly once
    const matches = configContent.match(/^packages\s*:/gm);
    expect(matches).toHaveLength(1);
  });

  it("#19 init does not bypass ProjectionStore to create hook config", async () => {
    await init({ yes: true, codex: true });
    expect(fs.existsSync(path.join(tmpDir, ".cursor", "hooks.json"))).toBe(false);
  });

  // A foreign legacy tree is coexistence evidence, never import authority.
  it("#20 preserves a foreign legacy tree and host surfaces", async () => {
    fs.mkdirSync(path.join(tmpDir, ".trellis", "scripts", "common"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(tmpDir, ".trellis", ".version"), "0.4.0");
    fs.writeFileSync(
      path.join(tmpDir, ".trellis", "scripts", "common", "marker.txt"),
      "upstream-owned",
    );
    // Foreign host surfaces exist before Pactile init.
    fs.mkdirSync(path.join(tmpDir, ".cursor", "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".cursor", "commands", "trellis-continue.md"),
      "# upstream continue",
    );
    fs.writeFileSync(
      path.join(tmpDir, ".cursor", "hooks.json"),
      '{"hooks":{},"upstream":true}',
    );
    // Foreign AGENTS.md managed block.
    fs.writeFileSync(
      path.join(tmpDir, "AGENTS.md"),
      `# Project\n\n<!-- TRELLIS:START -->\n# upstream trellis block\n<!-- TRELLIS:END -->\n\n# User footer\n`,
    );

    await init({ yes: true, codex: true });

    // Canonical state is created while the foreign tree remains byte-identical.
    expect(fs.existsSync(path.join(tmpDir, DIR_NAMES.WORKFLOW))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".trellis"))).toBe(true);
    expect(
      fs.readFileSync(
        path.join(tmpDir, ".trellis", "scripts", "common", "marker.txt"),
        "utf-8",
      ),
    ).toBe("upstream-owned");

    // Pactile preserves unrelated foreign host files and does not create
    // Cursor projection files or claim the upstream hook configuration.
    expect(
      fs.existsSync(
        path.join(tmpDir, ".cursor", "commands", "pactile.md"),
      ),
    ).toBe(false);
    const hooks = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".cursor", "hooks.json"), "utf-8"),
    ) as { upstream?: boolean; hooks?: unknown };
    expect(hooks.upstream).toBe(true);

    // AGENTS.md has both the foreign block and a new Pactile block.
    const agents = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("<!-- TRELLIS:START -->");
    expect(agents).toContain("<!-- TRELLIS:END -->");
    expect(agents).toContain("# upstream trellis block");
    expect(agents).toContain("<!-- PACTILE:START -->");
    expect(agents).toContain("<!-- PACTILE:END -->");
    expect(agents).toContain("# User footer");
    // Pactile block is placed after the foreign block.
    expect(agents.indexOf("<!-- TRELLIS:END -->")).toBeLessThan(
      agents.indexOf("<!-- PACTILE:START -->"),
    );
  });
});
