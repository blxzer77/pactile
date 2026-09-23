import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyCodexCapabilityConfig,
  buildProjectCapabilityTemplates,
  loadProjectCapabilities,
  loadStoredCapabilityStates,
  parseProjectCapabilities,
  renderCapabilitiesJson,
  renderCapabilitiesMarkdown,
  updateCapabilityReadinessStatus,
} from "../../src/utils/project-capabilities.js";

describe("project capabilities", () => {
  it("parses aliases, comma-separated values, all, and none", () => {
    expect(
      parseProjectCapabilities([
        "fast-context",
        "colbymchenry/codegraph",
        "none",
      ]),
    ).toEqual(["codebase-retrieval"]);

    expect(parseProjectCapabilities(["all"])).toEqual([
      "codebase-retrieval",
      "fastctx",
    ]);

    expect(parseProjectCapabilities(["fast-ctx"])).toEqual(["fastctx"]);
  });

  it("rejects unknown capability ids", () => {
    expect(() => parseProjectCapabilities(["nope-missing"])).toThrow(
      /Unknown project capability/,
    );

    // Capabilities that were retired must fail loudly for explicit input
    // rather than silently selecting nothing.
    expect(() => parseProjectCapabilities(["github"])).toThrow(
      /Unknown project capability "github"/,
    );
    expect(() => parseProjectCapabilities(["playwright-mcp"])).toThrow(
      /Unknown project capability "playwright-mcp"/,
    );
  });

  it("loads stored aliases and silently drops selections this build no longer knows", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pactile-capabilities-"),
    );
    try {
      fs.mkdirSync(path.join(tmpDir, ".pactile"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".pactile", "capabilities.json"),
        JSON.stringify({
          selected: [
            "fast-context-mcp",
            "codegraph",
            "legacy-architecture-graph",
            "playwright-mcp",
          ],
        }),
      );

      // Stored files are read tolerantly: a project that still lists a retired
      // capability keeps loading instead of erroring, and the retired entry
      // simply converges away on the next render.
      expect(loadProjectCapabilities(tmpDir)).toEqual(["codebase-retrieval"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves an existing Cursor MCP file while building Codex capability templates", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-legacy-mcp-"));
    try {
      const legacyFile = path.join(tmpDir, ".cursor", "mcp.json");
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, '{"mcpServers":{"keepme":{"command":"node"}}}');
      const before = fs.readFileSync(legacyFile);
      const files = buildProjectCapabilityTemplates(["codebase-retrieval"], ["codex"]);
      expect([...files.keys()].some((key) => key.startsWith(".cursor/"))).toBe(false);
      expect(fs.readFileSync(legacyFile)).toEqual(before);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("renders role-based retrieval adapters and fallback guidance without credentials", () => {
    const parsed = JSON.parse(
      renderCapabilitiesJson(["codebase-retrieval"]),
    ) as {
      schema_version: number;
      selected: string[];
      capabilities: Record<
        string,
        {
          adapters?: Record<
            string,
            { provider: string; required: boolean; evidence_status: string }
          >;
          fallback: string[];
        }
      >;
    };
    const retrieval = parsed.capabilities["codebase-retrieval"];

    expect(parsed.schema_version).toBe(3);
    expect(parsed.selected).toEqual(["codebase-retrieval"]);
    expect(retrieval?.readiness_status).toBe("pending");
    expect(retrieval?.adapters?.exact).toEqual(
      expect.objectContaining({
        provider: "rg",
        required: true,
        evidence_status: expect.stringContaining("Corroborated candidate"),
      }),
    );
    expect(retrieval?.adapters?.semantic).toEqual(
      expect.objectContaining({
        provider: "resolver-selected",
        required: false,
        evidence_status: expect.stringContaining("exact source reads"),
      }),
    );
    expect(retrieval?.adapters?.lsp?.provider).toBe("codegraph");
    expect(retrieval?.routing).toContain("explicitly selected");
    expect(retrieval?.fallback).toContain(
      "Install or expose `rg` on PATH before claiming codebase retrieval readiness.",
    );
    expect(retrieval?.fallback).toContain(
      "Ensure `npx -y fast-context-mcp` and `npx -y @colbymchenry/codegraph serve --mcp` can launch before generated MCP adapter entries are claimed as usable.",
    );
    expect(retrieval?.fallback).toContain(
      "If CodeGraph, LSP, or fast-context adapters are unavailable, skipped, stale, or uninvoked, label that adapter evidence as unverified and continue with exact search plus direct file reads.",
    );
    expect(retrieval?.fallback).toContain(
      "Record exploratory retrieval chains in task `research/*.md`; record final source/Git/test proof and unresolved adapter gaps in `verify.md`.",
    );
    expect(JSON.stringify(parsed)).not.toMatch(
      /gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|test-token/i,
    );
    expect(JSON.stringify(parsed)).not.toMatch(
      /BYOK|cursorEnv|\.ccursor\/routes\.json|byokMode/i,
    );
  });

  it("renders structured CodeGraph CLI automation guidance under retrieval", () => {
    const parsed = JSON.parse(
      renderCapabilitiesJson(["codebase-retrieval"]),
    ) as {
      capabilities: Record<
        string,
        {
          adapters?: Record<string, { purpose: string }>;
          cli_automation_guidance?: { command: string; use: string }[];
          routing: string;
        }
      >;
    };
    const retrieval = parsed.capabilities["codebase-retrieval"];

    expect(retrieval?.routing).toContain("policy/document-first routing");
    expect(retrieval?.routing).toContain("intent-gated");
    expect(retrieval?.routing).toContain("retrieval role");
    expect(retrieval?.adapters?.exact.purpose).toContain("policy phrases");
    expect(retrieval?.adapters?.exact.purpose).toContain("env prefixes");
    expect(retrieval?.cli_automation_guidance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "rg <pattern> <path>",
          use: expect.stringContaining("policy phrases"),
        }),
        expect.objectContaining({
          command:
            'rg -i "storage default|sidecar|sqlite only" AGENTS.md "**/AGENTS.md" README.md CONTRIBUTING.md .pactile/spec',
          use: expect.stringContaining("before implementation"),
        }),
        expect.objectContaining({
          command: "rg <env-prefix> scripts test e2e bench",
          use: expect.stringContaining("before auth"),
        }),
        expect.objectContaining({
          command: "rg <symbol> extensions/",
          use: expect.stringContaining("disambiguate"),
        }),
        expect.objectContaining({
          command: "codegraph callers <symbol> --path <path> --json",
          use: expect.stringContaining("facade"),
        }),
        expect.objectContaining({
          command: "Get-Content <file> | Select-Object -First <n>",
          use: expect.stringContaining("current source"),
        }),
        expect.objectContaining({
          command: "git diff -- <path>",
          use: expect.stringContaining("current worktree"),
        }),
        expect.objectContaining({
          command: "codegraph status <path> --json",
          use: expect.stringContaining("pending changes"),
        }),
        expect.objectContaining({
          command: "codegraph impact <symbol> --path <path> --depth <n> --json",
          use: expect.stringContaining("blast radius"),
        }),
        expect.objectContaining({
          command: "codegraph affected <changed-files...> --path <path> --json",
          use: expect.stringContaining("affected tests"),
        }),
      ]),
    );
  });

  it("renders Codex MCP server blocks inside a replaceable managed section", () => {
    const first = applyCodexCapabilityConfig("project_doc = []\n", [
      "codebase-retrieval",
    ]);
    expect(first).toContain("# PACTILE:PROJECT-CAPABILITIES:START");
    expect(first).toContain("[mcp_servers.fast-context]");
    expect(first).toContain("[mcp_servers.codegraph]");
    expect(first).not.toContain("[mcp_servers.graphify]");

    // fastctx owns no MCP server, so switching to it must clear the block
    // rather than leave stale adapter entries behind.
    const second = applyCodexCapabilityConfig(first, ["fastctx"]);
    expect(second).not.toContain("[mcp_servers.fast-context]");
    expect(second).not.toContain("[mcp_servers.codegraph]");
    expect(second).not.toContain("[mcp_servers.");
    expect(second.match(/PACTILE:PROJECT-CAPABILITIES:START/g)).toHaveLength(1);
  });

  it("builds capability metadata without writing host MCP files", () => {
    const files = buildProjectCapabilityTemplates(
      ["codebase-retrieval", "fastctx"],
      ["codex"],
    );
    expect(files.get(".pactile/capabilities.json")).toContain('"codebase-retrieval"');
    expect(files.get(".pactile/capabilities.md")).toContain("## Fallback Guidance");
    expect([...files.keys()].every((key) => key.startsWith(".pactile/"))).toBe(true);
  });

  it("renders selected retrieval workflow and CLI routing", () => {
    const capabilitiesMd = renderCapabilitiesMarkdown(["codebase-retrieval"]);

    expect(capabilitiesMd).toContain("- codebase-retrieval [pending]:");
    expect(capabilitiesMd).toContain(
      "## Policy and Document-First Routing (intent-gated)",
    );
    expect(capabilitiesMd).toContain(
      "inspect `AGENTS.md`, `.pactile/spec/**`, and README/contributing/architecture docs before semantic implementation search",
    );
    expect(capabilitiesMd).toContain(
      "### Storage and persistence policy (benchmark C03 pattern)",
    );
    expect(capabilitiesMd).toContain(">= 4/6");
    expect(capabilitiesMd).toContain("## Codebase Retrieval Workflow");
    expect(capabilitiesMd).toContain("## Query Intent Branches (intent-gated)");
    expect(capabilitiesMd).toContain("## Semantic recall");
    expect(capabilitiesMd).toContain("host-neutral resolver");
    expect(capabilitiesMd).toContain("user-global route file");
    expect(capabilitiesMd).not.toMatch(
      /BYOK|cursorEnv|\.ccursor\/routes\.json|byokMode/i,
    );
    expect(capabilitiesMd).not.toContain("do not substitute fast-context MCP");
    expect(capabilitiesMd).toContain("resolver-selected");
    expect(capabilitiesMd).toContain(
      "### Cross-cutting / conceptual discovery",
    );
    expect(capabilitiesMd).toContain("on-demand retrieval docs");
    expect(capabilitiesMd).toContain("### Caller and assembly chain (B-class)");
    expect(capabilitiesMd).toContain(
      "### Trap demotion and package boundary (E-class)",
    );
    expect(capabilitiesMd).toContain(
      "### Extension and shared-symbol disambiguation (A-class)",
    );
    expect(capabilitiesMd).toContain(
      "### Environment and config literals (D-class)",
    );
    expect(capabilitiesMd).toContain(
      "### Preserve strong routes (F / G / exact symbol)",
    );
    expect(capabilitiesMd).toContain("Intent-gated branches");
    expect(capabilitiesMd).toContain("## Codebase Evidence Levels");
    expect(capabilitiesMd).toContain(
      "Candidate evidence cannot support final claims",
    );
    expect(capabilitiesMd).toContain("Corroborated candidate");
    expect(capabilitiesMd).toContain("Verified claim");
    expect(capabilitiesMd).toContain("Unverified / unavailable");
    expect(capabilitiesMd).toContain("## Evidence Persistence");
    expect(capabilitiesMd).toContain("task `research/*.md`");
    expect(capabilitiesMd).toContain("`verify.md`");
    expect(capabilitiesMd).toContain("## Fallback Sequence");
    expect(capabilitiesMd).toContain("## Adapter Roles");
    expect(capabilitiesMd).toContain("### exact");
    expect(capabilitiesMd).toContain("### ast");
    expect(capabilitiesMd).toContain("### lsp");
    expect(capabilitiesMd).toContain("### semantic");
    expect(capabilitiesMd).toContain("### verification");
    expect(capabilitiesMd).toContain("## CLI Automation Guidance");
    expect(capabilitiesMd).toContain("### codebase-retrieval");
    expect(capabilitiesMd).toContain("`rg <pattern> <path>`");
    expect(capabilitiesMd).toContain(
      "`Get-Content <file> | Select-Object -First <n>`",
    );
    expect(capabilitiesMd).toContain("`git diff -- <path>`");
    expect(capabilitiesMd).toContain("`codegraph status <path> --json`");
    expect(capabilitiesMd).toContain(
      "`codegraph query <symbol-or-search> --path <path> --json`",
    );
    expect(capabilitiesMd).toContain(
      "`codegraph callers <symbol> --path <path> --json`",
    );
    expect(capabilitiesMd).toContain(
      "`rg <env-prefix> scripts test e2e bench`",
    );
    expect(capabilitiesMd).toContain("`rg <symbol> extensions/`");
    expect(capabilitiesMd).toContain(
      "`codegraph callees <symbol> --path <path> --json`",
    );
    expect(capabilitiesMd).toContain(
      "`codegraph impact <symbol> --path <path> --depth <n> --json`",
    );
    expect(capabilitiesMd).toContain(
      "`codegraph affected <changed-files...> --path <path> --json`",
    );
    expect(capabilitiesMd).toContain("readiness/freshness has been verified");
    expect(capabilitiesMd).toContain(
      "current source, Git, or tests confirm the claim",
    );
    expect(capabilitiesMd).not.toContain("## MCP Query Guidance");
  });

  it("updates readiness state and refreshes markdown", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pactile-capability-status-"),
    );
    try {
      fs.mkdirSync(path.join(tmpDir, ".pactile"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".pactile", "capabilities.json"),
        renderCapabilitiesJson(["codebase-retrieval", "fastctx"]),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(tmpDir, ".pactile", "capabilities.md"),
        renderCapabilitiesMarkdown(["codebase-retrieval", "fastctx"]),
        "utf-8",
      );

      updateCapabilityReadinessStatus(
        tmpDir,
        "codebase-retrieval",
        "ready",
        "smoke passed",
      );

      const parsed = JSON.parse(
        fs.readFileSync(
          path.join(tmpDir, ".pactile", "capabilities.json"),
          "utf-8",
        ),
      ) as {
        schema_version: number;
        capabilities: Record<
          string,
          {
            readiness_status?: string;
            readiness_status_detail?: string;
          }
        >;
      };
      const capabilitiesMd = fs.readFileSync(
        path.join(tmpDir, ".pactile", "capabilities.md"),
        "utf-8",
      );

      expect(parsed.schema_version).toBe(3);
      expect(parsed.capabilities["codebase-retrieval"]?.readiness_status).toBe(
        "ready",
      );
      expect(
        parsed.capabilities["codebase-retrieval"]?.readiness_status_detail,
      ).toBe("smoke passed");
      expect(capabilitiesMd).toContain("- codebase-retrieval [ready]:");
      expect(capabilitiesMd).toContain("(smoke passed)");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves stored readiness state when rebuilding templates", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pactile-capability-preserve-"),
    );
    try {
      fs.mkdirSync(path.join(tmpDir, ".pactile"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".pactile", "capabilities.json"),
        renderCapabilitiesJson(["codebase-retrieval"]),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(tmpDir, ".pactile", "capabilities.md"),
        renderCapabilitiesMarkdown(["codebase-retrieval"]),
        "utf-8",
      );

      updateCapabilityReadinessStatus(tmpDir, "codebase-retrieval", "ready");

      const templates = buildProjectCapabilityTemplates(
        ["codebase-retrieval"],
        ["cursor"],
        loadStoredCapabilityStates(tmpDir),
      );
      const rebuilt = JSON.parse(
        templates.get(".pactile/capabilities.json") ?? "{}",
      ) as {
        capabilities: Record<string, { readiness_status?: string }>;
      };

      expect(rebuilt.capabilities["codebase-retrieval"]?.readiness_status).toBe(
        "ready",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
