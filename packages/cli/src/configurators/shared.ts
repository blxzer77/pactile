/**
 * Shared utilities for platform configurators.
 *
 * Extracted here to avoid circular dependencies (index.ts imports configurators,
 * configurators cannot import from index.ts).
 */

import type { TemplateContext } from "../types/ai-tools.js";

/**
 * Module-level resolved Python command, set by the init flow after probing.
 *
 * Windows commonly has Python under one of: `python`, `python3`, `py -3` —
 * which one works varies by installer (python.org / Microsoft Store / py
 * launcher). `init.ts` detects which is available, then calls
 * `setResolvedPythonCommand` so all subsequent template / configurator writes
 * use the resolved value instead of the platform default.
 *
 * If unset (e.g. unit tests bypass init), `getPythonCommandForPlatform` falls
 * back to the static platform default (`python` on Windows, `python3`
 * elsewhere) — preserving legacy behavior.
 */
let resolvedPythonCommand: string | null = null;

export function setResolvedPythonCommand(cmd: string): void {
  const trimmed = cmd.trim();
  resolvedPythonCommand = trimmed || null;
}

/** Test helper — clear the resolved cache between unit tests. */
export function resetResolvedPythonCommand(): void {
  resolvedPythonCommand = null;
}

/**
 * Get the Python command for the host platform.
 *
 * Returns the resolved command if `setResolvedPythonCommand` has been called;
 * otherwise the static platform default — Windows: `python`, others:
 * `python3`. Pass an explicit `platform` arg only for unit tests (it bypasses
 * the resolved cache).
 */
export function getPythonCommandForPlatform(
  platform?: NodeJS.Platform,
): string {
  if (platform === undefined && resolvedPythonCommand) {
    return resolvedPythonCommand;
  }
  const target = platform ?? process.platform;
  return target === "win32" ? "python" : "python3";
}

/**
 * Replace literal `python3` with the resolved Python command, excluding
 * shebang lines.
 *
 * Applied at init/update write time so that all file types (including .py,
 * .md, .toml, .json) get the correct command for the host platform without
 * template-level changes.
 *
 * No-op when the resolved command is `python3` (the template default).
 * Idempotent: running it twice produces the same result.
 */
export function replacePythonCommandLiterals(content: string): string {
  const target = getPythonCommandForPlatform();
  if (target === "python3") return content;
  return content
    .split("\n")
    .map((line) =>
      line.startsWith("#!") ? line : line.replaceAll("python3", target),
    )
    .join("\n");
}

/**
 * Resolve platform-specific placeholders in template content.
 *
 * When called without a context, only resolves {{PYTHON_CMD}} (legacy behavior
 * for settings.json, hooks.json, etc.).
 *
 * When called with a TemplateContext, additionally resolves:
 * - {{CMD_REF:name}}         → platform-specific command reference
 * - {{EXECUTOR_AI}}          → AI executor description
 * - {{USER_ACTION_LABEL}}    → user action label
 * - {{CLI_FLAG}}             → platform cli flag (e.g. "claude", "codex")
 * - {{#FLAG}}...{{/FLAG}}    → conditional include (when FLAG is true)
 * - {{^FLAG}}...{{/FLAG}}    → negated conditional (when FLAG is false)
 *
 * Supported conditional flags: AGENT_CAPABLE, HAS_HOOKS
 */
// Pre-compiled regexes for placeholder resolution
const RE_PYTHON_CMD = /\{\{PYTHON_CMD\}\}/g;
const RE_CMD_REF = /\{\{CMD_REF:([\w][\w-]*)\}\}/g;
const RE_EXECUTOR_AI = /\{\{EXECUTOR_AI\}\}/g;
const RE_USER_ACTION_LABEL = /\{\{USER_ACTION_LABEL\}\}/g;
const RE_CLI_FLAG = /\{\{CLI_FLAG\}\}/g;
const RE_BLANK_LINES = /\n{3,}/g;

const CONDITIONAL_FLAGS = ["AGENT_CAPABLE", "HAS_HOOKS"] as const;
const CONDITIONAL_REGEXES = Object.fromEntries(
  CONDITIONAL_FLAGS.map((flag) => [
    flag,
    {
      pos: new RegExp(
        `\\{\\{#${flag}\\}\\}([\\s\\S]*?)\\{\\{/${flag}\\}\\}`,
        "g",
      ),
      neg: new RegExp(
        `\\{\\{\\^${flag}\\}\\}([\\s\\S]*?)\\{\\{/${flag}\\}\\}`,
        "g",
      ),
    },
  ]),
) as Record<(typeof CONDITIONAL_FLAGS)[number], { pos: RegExp; neg: RegExp }>;

export function resolvePlaceholders(
  content: string,
  context?: TemplateContext,
): string {
  let result = replacePythonCommandLiterals(
    content.replace(RE_PYTHON_CMD, getPythonCommandForPlatform()),
  );

  if (!context) return result;

  // Simple substitutions
  result = result.replace(
    RE_CMD_REF,
    (_match, name: string) => `${context.cmdRefPrefix}${name}`,
  );
  result = result.replace(RE_EXECUTOR_AI, context.executorAI);
  result = result.replace(RE_USER_ACTION_LABEL, context.userActionLabel);
  result = result.replace(RE_CLI_FLAG, context.cliFlag);

  // Conditional blocks
  const flagValues: Record<(typeof CONDITIONAL_FLAGS)[number], boolean> = {
    AGENT_CAPABLE: context.agentCapable,
    HAS_HOOKS: context.hasHooks,
  };

  for (const flag of CONDITIONAL_FLAGS) {
    const value = flagValues[flag];
    const { pos, neg } = CONDITIONAL_REGEXES[flag];
    // Reset lastIndex for global regexes reused across calls
    pos.lastIndex = 0;
    neg.lastIndex = 0;
    result = result.replace(pos, value ? "$1" : "");
    result = result.replace(neg, value ? "" : "$1");
  }

  // Clean up blank lines left by removed conditional blocks
  result = result.replace(RE_BLANK_LINES, "\n\n");

  return result;
}

/**
 * Resolve placeholders for files written under `.agents/skills/` (the shared
 * Agent Skills directory consumed by multiple platforms via the upstream
 * `.agents/skills/` workspace alias — Codex, Gemini CLI 0.40+, etc.).
 *
 * Identical to {@link resolvePlaceholders} except that {@link CMD_REF} is
 * rendered in a platform-neutral form (`` `name` (Pactile command) ``)
 * instead of substituting a platform-specific prefix. This is the only
 * placeholder that varies between platforms in the 5 shared workflow skills
 * (`brainstorm`, `before-dev`, `check`, `break-loop`, `update-spec`), so
 * neutralizing it makes the rendered SKILL.md files byte-identical regardless
 * of which Pactile Adapter wrote them — eliminating the
 * "last-writer-wins" collision when both Codex and Gemini target
 * `.agents/skills/`.
 *
 * `{{CLI_FLAG}}`, `{{EXECUTOR_AI}}`, `{{USER_ACTION_LABEL}}`, conditionals,
 * and `{{PYTHON_CMD}}` are still resolved from the platform context. The 5
 * shared skills do not use those placeholders, so they remain platform-
 * neutral. Host-specific skill files (e.g. `pactile-continue/SKILL.md`,
 * `pactile-finish-work/SKILL.md` written via `resolveAllAsSkillsNeutral`) do
 * use `{{CLI_FLAG}}` / `{{PYTHON_CMD}}` and resolve to Codex-correct values
 * — no other platform writes those files, so byte-identity is not required.
 */
export function resolvePlaceholdersNeutral(
  content: string,
  context?: TemplateContext,
): string {
  let result = replacePythonCommandLiterals(
    content.replace(RE_PYTHON_CMD, getPythonCommandForPlatform()),
  );

  if (!context) return result;

  // Neutral form for the only collision-causing placeholder
  result = result.replace(
    RE_CMD_REF,
    (_match, name: string) => `\`${name}\` (Pactile command)`,
  );
  result = result.replace(RE_EXECUTOR_AI, context.executorAI);
  result = result.replace(RE_USER_ACTION_LABEL, context.userActionLabel);
  result = result.replace(RE_CLI_FLAG, context.cliFlag);

  // Conditional blocks (resolved per platform — none of the 5 shared skills
  // use conditionals, but Codex-only command-as-skill files might in future).
  const flagValues: Record<(typeof CONDITIONAL_FLAGS)[number], boolean> = {
    AGENT_CAPABLE: context.agentCapable,
    HAS_HOOKS: context.hasHooks,
  };

  for (const flag of CONDITIONAL_FLAGS) {
    const value = flagValues[flag];
    const { pos, neg } = CONDITIONAL_REGEXES[flag];
    pos.lastIndex = 0;
    neg.lastIndex = 0;
    result = result.replace(pos, value ? "$1" : "");
    result = result.replace(neg, value ? "" : "$1");
  }

  result = result.replace(RE_BLANK_LINES, "\n\n");

  return result;
}

// ---------------------------------------------------------------------------
// Template wrapping utilities
// ---------------------------------------------------------------------------

/** Skill description registry — maps template name to auto-trigger description. */
const SKILL_DESCRIPTIONS: Record<string, string> = {
  start:
    "Initializes an AI development session by reading Kernel/Dashboard, developer identity, git status, active tasks, and project guidelines from .pactile/. Dashboard entry only — does not select or resume a task. Use when beginning a new coding session or re-establishing project context.",
  continue:
    "Resume work on the selected task. Loads Kernel/Dashboard (and a compiled session pack if present). Do not treat get_context.py --mode phase as runtime SSOT. Use when coming back to an in-progress task and you need to know what to do next.",
  "finish-work":
    "Wrap up the current session using Close: confirm Verify evidence, remind user to Finalize commits, archive completed tasks, and record session progress to the developer journal. Use when done coding and ready to end the session.",
  "before-dev":
    "Discovers and injects project-specific coding guidelines from .pactile/spec/ before implementation begins. Reads spec indexes, pre-development checklists, and shared thinking guides for the target package. Use when starting a new coding task, before writing any code, switching to a different package, or needing to refresh project conventions and standards.",
  brainstorm:
    "Guides collaborative requirements discovery before implementation: Discovery Before Questions, PRD draft, then PRD Grill (document pass + micro-grill for blocking business questions). Use when requirements are unclear, multiple valid approaches exist, or the user describes a new feature or complex task.",
  check:
    "Comprehensive quality verification on two axes — Standards (spec compliance, lint, type-check, tests, code smells, cross-layer data flow) and Spec (prd fidelity, scope, learning/spec-sync). Use when code is written and needs quality verification, before committing changes, or to catch context drift during long sessions.",
  "break-loop":
    "Deep bug analysis to break the fix-forget-repeat cycle. Analyzes root cause category, why fixes failed, prevention mechanisms, and captures knowledge into specs. Use after fixing a bug to prevent the same class of bugs.",
  "update-spec":
    "Captures executable contracts and coding conventions into .pactile/spec/ documents. Use when learning something valuable from debugging, implementing, or discussion that should be preserved for future sessions.",
};

/**
 * Wrap resolved template content with YAML frontmatter for skill format.
 * Used by platforms that use SKILL.md (Codex, Kiro, Qoder, etc.).
 */
export function wrapWithSkillFrontmatter(
  name: string,
  content: string,
): string {
  // Look up description by base name (without pactile- prefix).
  const baseName = name.replace(/^pactile-/, "");
  const description = SKILL_DESCRIPTIONS[baseName];
  if (!description) {
    throw new Error(
      `Missing skill description for "${baseName}". Add it to SKILL_DESCRIPTIONS in shared.ts.`,
    );
  }
  return `---\nname: ${name}\ndescription: "${description}"\n---\n\n${content}`;
}

/**
 * One-line blurbs shown in a `/` command palette — kept separate from
 * SKILL_DESCRIPTIONS, which is long prose aimed at the skill matcher.
 */
const COMMAND_DESCRIPTIONS: Record<string, string> = {
  start: "Initialize a Pactile development session from the dashboard.",
  continue: "Resume the selected task using Kernel/Dashboard.",
  "finish-work":
    "Wrap up: Verify evidence, Close/archive, journal.",
  handoff:
    "Write a portable session handoff document to the OS temp directory for a new agent / harness / directory to continue the work.",
};

/** Wrap resolved command content with YAML frontmatter (name + description). */
export function wrapWithCommandFrontmatter(
  name: string,
  content: string,
): string {
  const baseName = name.replace(/^pactile-/, "");
  const description = COMMAND_DESCRIPTIONS[baseName];
  if (!description) {
    throw new Error(
      `Missing command description for "${baseName}". Add it to COMMAND_DESCRIPTIONS in shared.ts.`,
    );
  }
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}`;
}

// ---------------------------------------------------------------------------
// Shared configurator helpers
// ---------------------------------------------------------------------------

import path from "node:path";
import { ensureDir, writeFile } from "../utils/file-writer.js";
import {
  type CommonTemplate,
  getBundledSkillTemplates,
  getCommandTemplates,
  getSkillTemplates,
} from "../templates/common/index.js";

/** A resolved template ready to be written to disk. */
export interface ResolvedTemplate {
  name: string;
  content: string;
}

/** A resolved file inside a multi-file skill directory. */
export interface ResolvedSkillFile {
  /** POSIX path relative to the skills root, e.g. "pactile-meta/SKILL.md" */
  relativePath: string;
  content: string;
}

/**
 * Filter command templates based on platform capabilities.
 *
 * `start.md` is only emitted for agent-less platforms (kilo, antigravity,
 * windsurf). On agent-capable platforms, the session-start hook / plugin
 * already injects the workflow overview, so a user-facing `start` command
 * would be redundant.
 */
function filterCommands(
  templates: CommonTemplate[],
  ctx: TemplateContext,
): CommonTemplate[] {
  if (ctx.agentCapable) {
    return templates.filter((t) => t.name !== "start");
  }
  return templates;
}

/**
 * Resolve all templates as skills with the pactile- prefix.
 * Used by skill-only platforms (Kiro, Qoder, Codex) where everything is a skill.
 *
 * `start` is filtered out on agent-capable platforms — the session-start hook
 * injects the workflow overview instead.
 */
export function resolveAllAsSkills(ctx: TemplateContext): ResolvedTemplate[] {
  const skillNames = new Set(getSkillTemplates().map((t) => t.name));
  const templates = [
    ...filterCommands(getCommandTemplates(), ctx).filter(
      (t) => !skillNames.has(t.name),
    ),
    ...getSkillTemplates(),
  ];
  return templates.map((tmpl) => ({
    name: `pactile-${tmpl.name}`,
    content: wrapWithSkillFrontmatter(
      `pactile-${tmpl.name}`,
      resolvePlaceholders(tmpl.content, ctx),
    ),
  }));
}

/**
 * Resolve command templates as plain commands (no wrapping).
 * Used by "both" platforms for the user-ritual commands.
 *
 * `start` is filtered out on agent-capable platforms.
 */
export function resolveCommands(ctx: TemplateContext): ResolvedTemplate[] {
  return filterCommands(getCommandTemplates(), ctx).map((tmpl) => ({
    name: tmpl.name,
    content: resolvePlaceholders(tmpl.content, ctx),
  }));
}

/**
 * Resolve only the shared skill templates with Pactile frontmatter.
 * Used by "both" platforms for the auto-triggered skills.
 */
export function resolveSkills(ctx: TemplateContext): ResolvedTemplate[] {
  return getSkillTemplates().map((tmpl) => ({
    name: `pactile-${tmpl.name}`,
    content: wrapWithSkillFrontmatter(
      `pactile-${tmpl.name}`,
      resolvePlaceholders(tmpl.content, ctx),
    ),
  }));
}

/**
 * Emit selected command templates as skills.
 * Body comes from `common/commands/`; slash commands stay separate via {@link resolveCommands}.
 */
export function resolveCommandAsSkills(
  commandNames: string[],
  ctx: TemplateContext,
): ResolvedTemplate[] {
  const byName = new Map(getCommandTemplates().map((t) => [t.name, t]));
  const out: ResolvedTemplate[] = [];
  for (const name of commandNames) {
    const tmpl = byName.get(name);
    if (!tmpl) continue;
    out.push({
      name: `pactile-${name}`,
      content: wrapWithSkillFrontmatter(
        `pactile-${name}`,
        resolvePlaceholders(tmpl.content, ctx),
      ),
    });
  }
  return out;
}

/**
 * Same as {@link resolveSkills} but uses {@link resolvePlaceholdersNeutral}
 * so the rendered SKILL.md files are byte-identical across any two platforms
 * that target `.agents/skills/`. Use this for shared `.agents/skills/`
 * writes (Gemini); platform-private skill roots should keep
 * {@link resolveSkills}.
 */
export function resolveSkillsNeutral(ctx: TemplateContext): ResolvedTemplate[] {
  return getSkillTemplates().map((tmpl) => ({
    name: `pactile-${tmpl.name}`,
    content: wrapWithSkillFrontmatter(
      `pactile-${tmpl.name}`,
      resolvePlaceholdersNeutral(tmpl.content, ctx),
    ),
  }));
}

/**
 * Same as {@link resolveAllAsSkills} but uses
 * {@link resolvePlaceholdersNeutral} for the 5 shared skills. The 2 command
 * templates (continue, finish-work) folded into the skill set still resolve
 * `{{CLI_FLAG}}` / `{{PYTHON_CMD}}` per platform — only Codex writes those
 * files into `.agents/skills/`, so byte-identity isn't required there.
 */
export function resolveAllAsSkillsNeutral(
  ctx: TemplateContext,
): ResolvedTemplate[] {
  const templates = [
    ...filterCommands(getCommandTemplates(), ctx),
    ...getSkillTemplates(),
  ];
  return templates.map((tmpl) => ({
    name: `pactile-${tmpl.name}`,
    content: wrapWithSkillFrontmatter(
      `pactile-${tmpl.name}`,
      resolvePlaceholdersNeutral(tmpl.content, ctx),
    ),
  }));
}

/**
 * Codex needs a `pactile-start` skill in `.agents/skills/` so the
 * `<pactile-bootstrap>` notice from `inject-workflow-state.py` resolves
 * to an actual skill file (the bootstrap notice tells the AI to invoke
 * `$pactile-start` once on the first `no_task` turn.
 * after the Codex SessionStart hook was removed for de-recursion).
 *
 * Built from `common/commands/start.md` + skill frontmatter; renders
 * neutrally so init and update produce byte-identical output. Returns
 * `null` if the template is missing (defensive — should never happen).
 *
 * Used by both `configureCodex()` (init path, file write) and
 * `collectPlatformTemplates.codex` (update path, manifest map). Both
 * paths must agree, otherwise upgraded users miss the file (which broke
 * 0.4.x → 0.5.5/0.5.6 upgrades — see #247-style symptom: AI reports
 * "no .agents/skills/pactile-start/SKILL.md" because update only ran
 * `collectTemplates` and never wrote the file).
 */
export function resolveCodexPactileStartSkill(
  ctx: TemplateContext,
): ResolvedTemplate | null {
  const startTemplate = getCommandTemplates().find((t) => t.name === "start");
  if (!startTemplate) return null;
  return {
    name: "pactile-start",
    content: wrapWithSkillFrontmatter(
      "pactile-start",
      resolvePlaceholdersNeutral(startTemplate.content, ctx),
    ),
  };
}

/**
 * Resolve multi-file built-in skills.
 *
 * Unlike workflow skills, bundled skills already contain their own SKILL.md
 * frontmatter and may include references/assets. They are still rendered
 * through placeholder resolution so init and update get byte-identical output.
 */
export function resolveBundledSkills(
  ctx: TemplateContext,
): ResolvedSkillFile[] {
  return getBundledSkillTemplates().flatMap((skill) =>
    skill.files.map((file) => ({
      relativePath: `${skill.name}/${file.relativePath}`,
      content: resolvePlaceholders(file.content, ctx),
    })),
  );
}

// ---------------------------------------------------------------------------
// Shared configurator write helpers
// ---------------------------------------------------------------------------

/** Collect skill files under a target root for update hash tracking. */
export function collectSkillTemplates(
  skillsRoot: string,
  skills: readonly { name: string; content: string }[],
  bundledSkills: readonly ResolvedSkillFile[] = [],
): Map<string, string> {
  const files = new Map<string, string>();
  for (const skill of skills) {
    files.set(`${skillsRoot}/${skill.name}/SKILL.md`, skill.content);
  }
  for (const skillFile of bundledSkills) {
    files.set(`${skillsRoot}/${skillFile.relativePath}`, skillFile.content);
  }
  return files;
}

/** Write skill directories from resolved templates and bundled skill files. */
export async function writeSkills(
  skillsRoot: string,
  skills: { name: string; content: string }[],
  bundledSkills: readonly ResolvedSkillFile[] = [],
): Promise<void> {
  ensureDir(skillsRoot);
  for (const skill of skills) {
    const skillDir = path.join(skillsRoot, skill.name);
    ensureDir(skillDir);
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      replacePythonCommandLiterals(skill.content),
    );
  }
  for (const skillFile of bundledSkills) {
    const targetPath = path.join(skillsRoot, skillFile.relativePath);
    ensureDir(path.dirname(targetPath));
    await writeFile(
      targetPath,
      replacePythonCommandLiterals(skillFile.content),
    );
  }
}

/** Write agent/droid definition files */
export async function writeAgents(
  agentsDir: string,
  agents: { name: string; content: string }[],
  ext = ".md",
): Promise<void> {
  ensureDir(agentsDir);
  for (const agent of agents) {
    await writeFile(
      path.join(agentsDir, `${agent.name}${ext}`),
      replacePythonCommandLiterals(agent.content),
    );
  }
}

/** Write the shared hook scripts that `platform` actually registers. */
export async function writeSharedHooks(
  hooksDir: string,
  platform: import("../templates/shared-hooks/index.js").SharedHookPlatform,
): Promise<void> {
  const { getSharedHookScriptsForPlatform } =
    await import("../templates/shared-hooks/index.js");
  ensureDir(hooksDir);
  for (const hook of getSharedHookScriptsForPlatform(platform)) {
    await writeFile(
      path.join(hooksDir, hook.name),
      replacePythonCommandLiterals(hook.content),
    );
  }
}

/**
 * Build the only project-level Pactile instructions region.  The caller passes
 * already validated public Tile metadata; Skill bodies and host details never
 * enter AGENTS.md.
 */
export function buildPactileAgentsBlock(
  tiles: readonly { readonly id: string; readonly summary: string }[],
): string {
  const lines = [...tiles]
    .sort((left, right) => left.id.localeCompare(right.id, "en"))
    .map(({ id, summary }) => `- \`${id}\` — ${summary.trim()}`);
  return [
    "<!-- PACTILE:START -->",
    "# Pactile capabilities",
    "",
    "Use the smallest applicable capability and honor its declared policy, evidence, and stop conditions.",
    ...(lines.length ? ["", ...lines] : []),
    "<!-- PACTILE:END -->",
  ].join("\n");
}
