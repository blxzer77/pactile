import { describe, expect, it } from "vitest";
import {  resolveAllAsSkillsNeutral,
  resolvePlaceholders,
  resolvePlaceholdersNeutral,
  resolveSkillsNeutral,
} from "../../src/configurators/shared.js";
import { AI_TOOLS } from "../../src/types/ai-tools.js";
import type { TemplateContext } from "../../src/types/ai-tools.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const claudeCtx: TemplateContext = {
  cmdRefPrefix: "/pactile:",
  executorAI: "Bash scripts or Task calls",
  userActionLabel: "Slash commands",
  agentCapable: true,
  hasHooks: true,
  cliFlag: "claude",
};

const codexCtx: TemplateContext = {
  cmdRefPrefix: "$",
  executorAI: "Bash scripts or tool calls",
  userActionLabel: "Skills",
  agentCapable: true,
  hasHooks: false,
  cliFlag: "codex",
};

const cursorCtx: TemplateContext = {
  cmdRefPrefix: "/pactile-",
  executorAI: "Bash scripts or file reads",
  userActionLabel: "Slash commands",
  agentCapable: false,
  hasHooks: false,
  cliFlag: "cursor",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolvePlaceholders", () => {
  // -----------------------------------------------------------------------
  // Legacy behavior (no context)
  // -----------------------------------------------------------------------

  describe("without context (legacy)", () => {
    it("does not infer a runtime command without context", () => {
      expect(resolvePlaceholders("pactile task dashboard")).toBe("pactile task dashboard");
    });

    it("leaves other placeholders untouched when no context", () => {
      const input = "See {{CMD_REF:brainstorm}} and {{EXECUTOR_AI}}";
      expect(resolvePlaceholders(input)).toBe(input);
    });
  });

  // -----------------------------------------------------------------------
  // CMD_REF substitution
  // -----------------------------------------------------------------------

  describe("{{CMD_REF:name}}", () => {
    it("resolves with /pactile: prefix (Claude)", () => {
      const result = resolvePlaceholders(
        "See {{CMD_REF:brainstorm}} for details",
        claudeCtx,
      );
      expect(result).toBe("See /pactile:brainstorm for details");
    });

    it("resolves with $ prefix (Codex)", () => {
      const result = resolvePlaceholders(
        "Run {{CMD_REF:check}} after coding",
        codexCtx,
      );
      expect(result).toBe("Run $check after coding");
    });

    it("resolves with /pactile- prefix (Cursor)", () => {
      const result = resolvePlaceholders(
        "Use {{CMD_REF:finish-work}} when done",
        cursorCtx,
      );
      expect(result).toBe("Use /pactile-finish-work when done");
    });

    it("handles multiple CMD_REF in one template", () => {
      const input =
        "{{CMD_REF:start}} then {{CMD_REF:brainstorm}} then {{CMD_REF:check}}";
      expect(resolvePlaceholders(input, claudeCtx)).toBe(
        "/pactile:start then /pactile:brainstorm then /pactile:check",
      );
    });

    it("handles hyphenated command names", () => {
      expect(
        resolvePlaceholders("{{CMD_REF:finish-work}}", claudeCtx),
      ).toBe("/pactile:finish-work");
      expect(
        resolvePlaceholders("{{CMD_REF:check-cross-layer}}", codexCtx),
      ).toBe("$check-cross-layer");
    });
  });

  // -----------------------------------------------------------------------
  // Simple substitutions
  // -----------------------------------------------------------------------

  describe("simple substitutions", () => {
    it("resolves {{EXECUTOR_AI}}", () => {
      expect(
        resolvePlaceholders("| `[AI]` | {{EXECUTOR_AI}} |", claudeCtx),
      ).toBe("| `[AI]` | Bash scripts or Task calls |");
      expect(
        resolvePlaceholders("| `[AI]` | {{EXECUTOR_AI}} |", codexCtx),
      ).toBe("| `[AI]` | Bash scripts or tool calls |");
    });

    it("resolves {{USER_ACTION_LABEL}}", () => {
      expect(
        resolvePlaceholders("| `[USER]` | {{USER_ACTION_LABEL}} |", claudeCtx),
      ).toBe("| `[USER]` | Slash commands |");
      expect(
        resolvePlaceholders("| `[USER]` | {{USER_ACTION_LABEL}} |", codexCtx),
      ).toBe("| `[USER]` | Skills |");
    });

    it("resolves Pactile command references alongside context placeholders", () => {
      const result = resolvePlaceholders(
        "pactile task dashboard and {{CMD_REF:start}}",
        claudeCtx,
      );
      expect(result).toBe("pactile task dashboard and /pactile:start");
    });
  });

  // -----------------------------------------------------------------------
  // Conditional blocks
  // -----------------------------------------------------------------------

  describe("conditional blocks", () => {
    describe("{{#AGENT_CAPABLE}}", () => {
      const template = [
        "Before",
        "{{#AGENT_CAPABLE}}",
        "Call Implement Agent",
        "{{/AGENT_CAPABLE}}",
        "After",
      ].join("\n");

      it("includes block when agentCapable=true", () => {
        const result = resolvePlaceholders(template, claudeCtx);
        expect(result).toContain("Call Implement Agent");
        expect(result).toContain("Before");
        expect(result).toContain("After");
      });

      it("removes block when agentCapable=false", () => {
        const result = resolvePlaceholders(template, cursorCtx);
        expect(result).not.toContain("Call Implement Agent");
        expect(result).toContain("Before");
        expect(result).toContain("After");
      });
    });

    describe("{{^AGENT_CAPABLE}} (negated)", () => {
      const template = [
        "{{^AGENT_CAPABLE}}",
        "Implement the changes directly",
        "{{/AGENT_CAPABLE}}",
      ].join("\n");

      it("removes block when agentCapable=true", () => {
        const result = resolvePlaceholders(template, claudeCtx);
        expect(result).not.toContain("Implement the changes directly");
      });

      it("includes block when agentCapable=false", () => {
        const result = resolvePlaceholders(template, cursorCtx);
        expect(result).toContain("Implement the changes directly");
      });
    });

    describe("{{#HAS_HOOKS}} / {{^HAS_HOOKS}}", () => {
      const template = [
        "{{#HAS_HOOKS}}",
        "code-spec context is auto-injected by hook",
        "{{/HAS_HOOKS}}",
        "{{^HAS_HOOKS}}",
        "read specs manually before coding",
        "{{/HAS_HOOKS}}",
      ].join("\n");

      it("Claude (hasHooks=true) gets hook text", () => {
        const result = resolvePlaceholders(template, claudeCtx);
        expect(result).toContain("auto-injected by hook");
        expect(result).not.toContain("read specs manually");
      });

      it("Codex (hasHooks=false) gets manual text", () => {
        const result = resolvePlaceholders(template, codexCtx);
        expect(result).not.toContain("auto-injected by hook");
        expect(result).toContain("read specs manually");
      });
    });

    describe("nested conditionals", () => {
      const template = [
        "{{#AGENT_CAPABLE}}",
        "Agents available",
        "{{#HAS_HOOKS}}",
        "Hook injection active",
        "{{/HAS_HOOKS}}",
        "{{^HAS_HOOKS}}",
        "No hooks, manual injection",
        "{{/HAS_HOOKS}}",
        "{{/AGENT_CAPABLE}}",
        "{{^AGENT_CAPABLE}}",
        "No agents, do it inline",
        "{{/AGENT_CAPABLE}}",
      ].join("\n");

      it("Claude (agent+hooks): agents + hook injection", () => {
        const result = resolvePlaceholders(template, claudeCtx);
        expect(result).toContain("Agents available");
        expect(result).toContain("Hook injection active");
        expect(result).not.toContain("No hooks");
        expect(result).not.toContain("No agents");
      });

      it("Codex (agent, no hooks): agents + manual injection", () => {
        const result = resolvePlaceholders(template, codexCtx);
        expect(result).toContain("Agents available");
        expect(result).not.toContain("Hook injection active");
        expect(result).toContain("No hooks, manual injection");
        expect(result).not.toContain("No agents");
      });

      it("Cursor (no agent, no hooks): inline only", () => {
        const result = resolvePlaceholders(template, cursorCtx);
        expect(result).not.toContain("Agents available");
        expect(result).not.toContain("Hook injection");
        expect(result).toContain("No agents, do it inline");
      });
    });
  });

  // -----------------------------------------------------------------------
  // Blank line cleanup
  // -----------------------------------------------------------------------

  describe("blank line cleanup", () => {
    it("collapses 3+ consecutive blank lines to 2", () => {
      const template = "A\n\n{{#AGENT_CAPABLE}}\nRemoved\n{{/AGENT_CAPABLE}}\n\nB";
      const result = resolvePlaceholders(template, cursorCtx);
      expect(result).not.toMatch(/\n{3,}/);
      expect(result).toContain("A");
      expect(result).toContain("B");
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // CLI_FLAG substitution (migrate-flow-bugs Bug B fix: platform propagation)
  // -----------------------------------------------------------------------

  describe("{{CLI_FLAG}}", () => {
    it("substitutes to the platform's cliFlag value", () => {
      const input = "--platform {{CLI_FLAG}}";
      expect(resolvePlaceholders(input, claudeCtx)).toBe("--platform claude");
      expect(resolvePlaceholders(input, codexCtx)).toBe("--platform codex");
      expect(resolvePlaceholders(input, cursorCtx)).toBe("--platform cursor");
    });

    it("substitutes multiple occurrences in one string", () => {
      const input = "a={{CLI_FLAG}} b={{CLI_FLAG}}";
      expect(resolvePlaceholders(input, codexCtx)).toBe("a=codex b=codex");
    });

    it("leaves {{CLI_FLAG}} literal when no context is provided", () => {
      const input = "--platform {{CLI_FLAG}}";
      expect(resolvePlaceholders(input)).toBe(input);
    });

    it("resolves the CLI flag alongside a Node task command", () => {
      expect(resolvePlaceholders("pactile task selected --source --platform {{CLI_FLAG}}", codexCtx))
        .toBe("pactile task selected --source --platform codex");
    });
  });

  describe("edge cases", () => {
    it("handles empty content", () => {
      expect(resolvePlaceholders("", claudeCtx)).toBe("");
    });

    it("handles content with no placeholders", () => {
      const plain = "# Just a heading\n\nSome text.";
      expect(resolvePlaceholders(plain, claudeCtx)).toBe(plain);
    });

    it("does not resolve unknown placeholders", () => {
      const input = "{{UNKNOWN}} and {{#UNKNOWN_FLAG}}x{{/UNKNOWN_FLAG}}";
      expect(resolvePlaceholders(input, claudeCtx)).toBe(input);
    });
  });
});

// ---------------------------------------------------------------------------
// resolvePlaceholdersNeutral — neutral CMD_REF for shared `.agents/skills/`
// (issue #224 fix: avoid Codex+Gemini last-writer-wins on identical files)
// ---------------------------------------------------------------------------

describe("resolvePlaceholdersNeutral", () => {
  it("renders {{CMD_REF:name}} as `name` (Pactile command) — platform-neutral", () => {
    expect(
      resolvePlaceholdersNeutral("See {{CMD_REF:brainstorm}}", claudeCtx),
    ).toBe("See `brainstorm` (Pactile command)");
    expect(
      resolvePlaceholdersNeutral("See {{CMD_REF:brainstorm}}", codexCtx),
    ).toBe("See `brainstorm` (Pactile command)");
  });

  it("produces byte-identical CMD_REF output across platforms", () => {
    const input =
      "Run {{CMD_REF:check}} then {{CMD_REF:finish-work}} after coding.";
    const claudeOut = resolvePlaceholdersNeutral(input, claudeCtx);
    const codexOut = resolvePlaceholdersNeutral(input, codexCtx);
    const cursorOut = resolvePlaceholdersNeutral(input, cursorCtx);
    expect(claudeOut).toBe(codexOut);
    expect(codexOut).toBe(cursorOut);
  });

  it("still resolves {{CLI_FLAG}} per platform (used by Codex-only command-as-skill files)", () => {
    expect(
      resolvePlaceholdersNeutral("--platform {{CLI_FLAG}}", codexCtx),
    ).toBe("--platform codex");
    expect(
      resolvePlaceholdersNeutral("--platform {{CLI_FLAG}}", claudeCtx),
    ).toBe("--platform claude");
  });

  it("still resolves {{EXECUTOR_AI}} and {{USER_ACTION_LABEL}} per platform", () => {
    // Defensive: not used in current shared skills, but kept functional for
    // future templates.
    expect(
      resolvePlaceholdersNeutral("{{EXECUTOR_AI}}", claudeCtx),
    ).toBe("Bash scripts or Task calls");
    expect(
      resolvePlaceholdersNeutral("{{USER_ACTION_LABEL}}", codexCtx),
    ).toBe("Skills");
  });

  it("still applies conditional blocks per context", () => {
    const template = [
      "{{#AGENT_CAPABLE}}",
      "Spawn agent",
      "{{/AGENT_CAPABLE}}",
      "{{^AGENT_CAPABLE}}",
      "Inline edit",
      "{{/AGENT_CAPABLE}}",
    ].join("\n");
    expect(resolvePlaceholdersNeutral(template, claudeCtx)).toContain(
      "Spawn agent",
    );
    expect(resolvePlaceholdersNeutral(template, cursorCtx)).toContain(
      "Inline edit",
    );
  });

  it("returns content unchanged when no context is provided", () => {
    const input = "See {{CMD_REF:brainstorm}}";
    expect(resolvePlaceholdersNeutral(input)).toBe(input);
  });

  it("handles empty content", () => {
    expect(resolvePlaceholdersNeutral("", claudeCtx)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// resolveSkillsNeutral / resolveAllAsSkillsNeutral — cross-platform parity
// for `.agents/skills/` writes
// ---------------------------------------------------------------------------

describe("resolveSkillsNeutral / resolveAllAsSkillsNeutral", () => {
  it("resolveSkillsNeutral produces a stable Codex skill set", () => {
    const codexSkills = resolveSkillsNeutral(AI_TOOLS.codex.templateContext);
    expect(codexSkills.length).toBeGreaterThan(0);
    expect(codexSkills.map((s) => s.name)).toContain("pactile-before-dev");
  });

  it("resolveSkillsNeutral renders CMD_REF without platform-specific prefix", () => {
    const neutral = resolveSkillsNeutral(AI_TOOLS.codex.templateContext);
    const cmdRefNames = [
      "start",
      "brainstorm",
      "check",
      "break-loop",
      "update-spec",
      "finish-work",
    ];
    for (const skill of neutral) {
      for (const name of cmdRefNames) {
        expect(
          skill.content,
          `${skill.name} leaks Codex prefix for ${name}`,
        ).not.toContain(`$${name}`);
        expect(
          skill.content,
          `${skill.name} leaks Claude prefix for ${name}`,
        ).not.toContain(`/pactile:${name}`);
        expect(
          skill.content,
          `${skill.name} leaks Cursor prefix for ${name}`,
        ).not.toContain(`/pactile-${name}`);
      }
    }
  });

  it("resolveAllAsSkillsNeutral keeps shared skills byte-identical to resolveSkillsNeutral", () => {
    const all = resolveAllAsSkillsNeutral(AI_TOOLS.codex.templateContext);
    const fiveOnly = resolveSkillsNeutral(AI_TOOLS.codex.templateContext);
    const sharedNames = new Set(fiveOnly.map((s) => s.name));
    const allShared = all.filter((s) => sharedNames.has(s.name));
    expect(allShared.length).toBe(fiveOnly.length);
    for (const five of fiveOnly) {
      const match = allShared.find((s) => s.name === five.name);
      expect(match?.content).toBe(five.content);
    }
  });
});
