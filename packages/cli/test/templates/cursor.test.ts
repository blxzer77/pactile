import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAllAgents } from "../../src/templates/cursor/index.js";
import { PROJECT_CAPABILITIES } from "../../src/utils/project-capabilities.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");

const EXPECTED_AGENT_NAMES = [
  "pactile-check",
  "pactile-implement",
  "pactile-research",
];

describe("cursor getAllAgents", () => {
  it("returns the expected agent set", () => {
    const agents = getAllAgents();
    const names = agents.map((a) => a.name).sort();
    expect(names).toEqual(EXPECTED_AGENT_NAMES);
  });

  it("keeps all three agents dispatchable, recursion-safe, and off the workflow SSOT", () => {
    const expectedDispatchKinds = new Map([
      ["pactile-check", "check"],
      ["pactile-implement", "implement"],
      ["pactile-research", "research"],
    ]);

    for (const agent of getAllAgents()) {
      const dispatchKind = expectedDispatchKinds.get(agent.name);
      expect(dispatchKind, `${agent.name} should have a dispatch kind`).toBeDefined();
      expect(agent.content).toContain(
        `generate_dispatch_prompt.py --agent ${dispatchKind}`,
      );
      expect(agent.content).toContain("## Recursion Guard");
      expect(agent.content).toMatch(
        /not (?:a )?runtime SSOT|not `\.pactile\/workflow\.md`/i,
      );
      expect(agent.content).toMatch(/## (?:Forbidden Operations|Write FORBIDDEN)/);
      for (const command of ["git commit", "git push", "git merge"]) {
        expect(agent.content).toContain(`\`${command}\``);
      }
    }
  });

  it("pactile-check keeps optional gate evidence without owning baseline-check", () => {
    const checkAgent = getAllAgents().find(
      (agent) => agent.name === "pactile-check",
    );
    expect(checkAgent?.content).toContain("task.py record-gate");
    expect(checkAgent?.content).toContain("Never record `baseline-check`");
    expect(checkAgent?.content).toContain("verify.md");
  });
});

// Cursor's agent UI parser only accepts a single-line literal `description:`
// in frontmatter. YAML block-scalar form (`description: |` followed by an
// indented body) is silently rejected — Description field renders empty and
// the agent becomes unusable. See PRD task
// 05-06-fix-codex-subagent-recursion-and-cursor-agent-description-format.
describe("cursor agents frontmatter single-line description", () => {
  for (const name of ["pactile-research", "pactile-implement", "pactile-check"]) {
    it(`${name}.md frontmatter description is a single-line literal (no '|' block scalar)`, () => {
      const filePath = path.join(
        repoRoot,
        "packages/cli/src/templates/cursor/agents",
        `${name}.md`,
      );
      const content = fs.readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
      const fm = content.split("---\n")[1] ?? "";

      // Block-scalar markers must be absent on the description line.
      expect(fm).not.toMatch(/^description:\s*\|\s*$/m);
      expect(fm).not.toMatch(/^description:\s*>\s*$/m);

      // Single-line form: `description: <text>` with text on the same line.
      const descMatch = fm.match(/^description:\s*(.+)$/m);
      expect(
        descMatch,
        `${name}.md must have 'description: <text>' on a single line`,
      ).not.toBeNull();
      const descValue = descMatch ? descMatch[1] : "";
      // No leading pipe / gt that would indicate a block scalar header
      expect(descValue.trim()).not.toBe("|");
      expect(descValue.trim()).not.toBe(">");
      expect(descValue.length).toBeGreaterThan(0);
    });
  }
});

/**
 * A subagent's `tools:` list is a promise about what that child can reach. A
 * whitelist naming an MCP server that Pactile does not declare is a broken
 * promise: the child is told it has a capability that nobody provides, and the
 * drift is invisible until someone reads the frontmatter closely.
 *
 * These cases pin the whitelist to the capability registry so the two cannot
 * drift apart again.
 */
describe("cursor agents MCP tool whitelist", () => {
  const DECLARED_MCP_SERVERS = new Set(
    PROJECT_CAPABILITIES.flatMap((capability) =>
      capability.mcpServers.map((server) => server.name),
    ),
  );

  function declaredToolTokens(agentName: string): string[] {
    const agent = getAllAgents().find((entry) => entry.name === agentName);
    if (!agent) throw new Error(`Expected agent "${agentName}" to exist`);
    // Working copies may carry CRLF; normalize before splitting frontmatter.
    const content = agent.content.replace(/\r\n/g, "\n");
    const frontmatter = content.split("---\n")[1] ?? "";
    const toolsLine = frontmatter.match(/^tools:\s*(.+)$/m);
    if (!toolsLine) throw new Error(`${agentName} has no tools: line`);
    return toolsLine[1]
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);
  }

  function mcpServerNames(tokens: readonly string[]): string[] {
    const names: string[] = [];
    for (const token of tokens) {
      const match = token.match(/^mcp__([^_]+(?:-[^_]+)*)__/);
      if (match) names.push(match[1]);
    }
    return names;
  }

  it("declares at least one MCP server in the capability registry", () => {
    // Guard for the guard: if the registry ever declares none, the assertion
    // below would pass vacuously and stop protecting anything.
    expect(DECLARED_MCP_SERVERS.size).toBeGreaterThan(0);
  });

  for (const name of ["pactile-check", "pactile-implement", "pactile-research"]) {
    it(`${name}.md only names MCP servers the capability registry declares`, () => {
      const servers = mcpServerNames(declaredToolTokens(name));

      for (const server of servers) {
        expect(
          DECLARED_MCP_SERVERS.has(server),
          `${name}.md grants "mcp__${server}__*" but no Pactile capability declares an MCP server named "${server}". ` +
            `Declared servers: ${[...DECLARED_MCP_SERVERS].join(", ") || "(none)"}.`,
        ).toBe(true);
      }
    });
  }

  it("does not resurrect retired MCP brands in an agent whitelist", () => {
    // These were granted to subagents and are not provided by anything in the
    // product. Even if a future registry re-added a similarly named server,
    // returning them here should be a deliberate, reviewed act.
    const retiredServers = ["exa", "chrome-devtools"];

    for (const name of [
      "pactile-check",
      "pactile-implement",
      "pactile-research",
    ]) {
      const servers = mcpServerNames(declaredToolTokens(name));
      for (const retired of retiredServers) {
        expect(
          servers,
          `${name}.md still grants a retired MCP server "${retired}".`,
        ).not.toContain(retired);
      }
    }
  });

  it("grants the repository retrieval servers to every worker role", () => {
    // The whole point of the fix: workers must be able to reach code lookup.
    for (const name of ["pactile-check", "pactile-implement", "pactile-research"]) {
      const servers = mcpServerNames(declaredToolTokens(name));
      expect(servers, `${name} cannot reach codegraph`).toContain("codegraph");
      expect(servers, `${name} cannot reach fast-context`).toContain(
        "fast-context",
      );
    }
  });
});
