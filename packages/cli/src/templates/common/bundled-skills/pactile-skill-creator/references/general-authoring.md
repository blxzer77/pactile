# General Skill Authoring

Method and patterns for writing reusable agent skills. Imperative rules live in `SKILL.md` Hard Constraints; this file explains how to apply them. For Pactile location choice, read `pactile-skill-locations.md`. For description wording and anti-patterns, read `authoring-rules.md`.

## Gather Requirements

Collect these six elements before writing files:

1. **Purpose and scope**: What specific workflow should this skill solve?
2. **Trigger scenarios**: When should the agent automatically use it?
3. **Target location**: Project skill, shared skill, bundled template, or personal skill?
4. **Domain constraints**: Required tools, APIs, reliability constraints.
5. **Output style**: Report template, checklist, strict schema, etc.
6. **Existing patterns**: Are there existing skills or conventions to follow?

### Inferring from Context

If previous conversation already surfaced workflows, patterns, or domain knowledge, infer the skill from that context.

Ask the user when requirements are ambiguous and discrete choices are needed.

## Directory Layout

```
skill-name/
├── SKILL.md            # required
├── scripts/            # optional utility scripts
├── bin/                # optional compiled binaries
├── references/         # optional detailed docs (preferred over a single reference.md)
├── examples/           # optional samples
└── prompts/            # optional long prompts
```

Keep the entry file short. Put long guidance one level deep under `references/` and link it from `SKILL.md`.

Generic storage scopes (`~/.agents/skills/` vs project `.agents/skills/`) are not enough for Pactile work. Use `pactile-skill-locations.md` to pick the target directory.

## Core Authoring Principles

### 1. Concise is Key

The context window is shared with conversation history, other skills, and requests. Every token competes for space.

Default assumption: the agent is already very smart. Only add context it does not already have.

Challenge each piece of information:

- Does the agent really need this explanation?
- Can I assume the agent knows this?
- Does this paragraph justify its token cost?

### 2. Progressive Disclosure

Put essential information in `SKILL.md`; detailed reference material in separate files that the agent reads only when needed.

Keep references one level deep — link directly from `SKILL.md`. Nested reference chains may result in partial reads.

### 3. One File, One Concern

Each skill should address a single workflow. If a skill tries to do too many things, split it.

### 4. Maximize Determinism

Skills run through multiple independent tool calls. Each call is stateless — no shared session or persistent variables between calls.

Eliminate ambiguity at every layer — description, workflow, script parameters, and output format.

- Internalize decisions: if a value can be decided inside a script (output path, temp filename, timestamp), do not expose it as a parameter.
- Use fixed literal paths in workflows. The agent copies commands verbatim. Never rely on shell variables staying consistent across separate tool calls.
- Minimize script parameters. Only require what the agent must provide.
- Scripts return structured JSON to stdout so the agent can parse the result deterministically.
- Specify an exact tool-call sequence, for example: "Exactly 3 steps: write file → run command → deliver output."
- Add stop conditions. Prevent open-ended tool loops for expensive operations.

### 5. Set Appropriate Degrees of Freedom

Match specificity to the task's fragility:

| Freedom Level | When to Use | Example |
|---------------|-------------|---------|
| **High** (text instructions) | Multiple valid approaches, context-dependent | Code review guidelines |
| **Medium** (pseudocode / templates) | Preferred pattern with acceptable variation | Report generation |
| **Low** (specific scripts) | Fragile operations, consistency critical | Database migrations |

## Recommended SKILL.md Sections

1. Goal
2. Hard Constraints (imperative one-liners; placed before Workflow)
3. Workflow
4. Output Template
5. When NOT to use this skill

## Common Patterns

### Workflow Pattern

Break operations into explicit steps with a clear tool-call sequence:

```markdown
## Workflow

1. Gather input data
2. Process: `<exact command the agent should run>`
3. Parse output, proceed to the next step
4. Stop when the condition is met
```

### Template Pattern

Provide output format templates:

````markdown
## Output Template

```markdown
# [Title]

## Summary
[One-paragraph overview]

## Findings
- Finding 1 with supporting data
- Finding 2 with supporting data
```
````

### Conditional Workflow Pattern

Guide through decision points:

```markdown
## Workflow

1. Determine the type:
   **Creating new?** → Follow "Creation workflow" below
   **Editing existing?** → Follow "Editing workflow" below
```

### Feedback Loop Pattern

For quality-critical tasks, implement validation:

```markdown
1. Make edits
2. Validate: `node scripts/validate.mjs output/`
3. If validation fails → fix and re-validate
4. Only proceed when validation passes
```

## Utility Scripts

Pre-made scripts are more reliable than generated code, save tokens, and keep behavior consistent.

Script design:

- Only expose parameters the agent must supply (input data, mode selection).
- Let the script handle internal decisions (output path, temp files, format defaults).
- Return results as structured JSON to stdout.
- State whether the agent should **execute** the script or **read** it as reference.

## Minimal Template

```markdown
---
name: skill-name
description: Specific capability and trigger scenarios.
---

# Skill Name

## Goal
One clear objective.

## Hard Constraints
- Always X. Never Y.
- Always validate the input before step 2.
- Never call the API more than 5 times per run.

## Workflow
1. Step one
2. Step two
3. Stop when condition met

## Output Template
Required output structure.

## When NOT to use this skill
- Boundary cases.
```
