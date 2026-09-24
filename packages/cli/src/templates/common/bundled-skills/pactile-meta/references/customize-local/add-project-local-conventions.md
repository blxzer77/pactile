# Add Project-Local Conventions

Often the user does not need to change Pactile mechanics; they need local AI to understand their team's conventions. In that case, prefer `.pactile/spec/` or a project-local skill instead of editing `pactile-meta`.

## Where To Put Things

| Content type | Location |
| --- | --- |
| Rules code must follow | `.pactile/spec/<layer>/` |
| Cross-layer thinking methods | `.pactile/spec/guides/` |
| AI capability for a project-specific flow | Platform-local skill |
| One-off task material | `.pactile/tasks/<task>/` |
| Session summary | `.pactile/workspace/<developer>/journal-N.md` |

## Create A Project-Local Skill

If the user wants AI to know "how this project customizes Pactile," create a local skill:

```text
.claude/skills/pactile-local/
└── SKILL.md
```

Example:

```md
---
name: pactile-local
description: "Project-local Pactile customizations for this repository. Use when changing this project's Pactile workflow, hooks, local agents, or team-specific conventions."
---

# Pactile Local

## Local Scope

This skill documents this repository's Pactile customizations only.

## Custom Workflow Rules

- ...

## Local Hook Changes

- ...

## Local Agent Changes

- ...
```

For multi-platform projects, place equivalent versions in other platform skill directories, or use `.agents/skills/` for platforms that support the shared layer.

## Write To `.pactile/spec/`

If the content is a coding convention, write it to spec. Examples:

```text
.pactile/spec/backend/error-handling.md
.pactile/spec/frontend/components.md
.pactile/spec/guides/cross-platform-thinking-guide.md
```

After writing it, update the corresponding `index.md` so AI can find the new rule from the entry point.

## Make The Selected Task Use New Conventions

After writing a spec, add it to the selected task context:

```bash
pactile task add-context <task> implement ".pactile/spec/backend/error-handling.md" "Error handling conventions"
pactile task add-context <task> check ".pactile/spec/backend/error-handling.md" "Review error handling"
```

## Do Not Store Project-Private Rules In `pactile-meta`

`pactile-meta` is a public skill for understanding Pactile architecture and local customization entry points. Put project-private content in:

- `.pactile/spec/`
- a project-local skill
- the selected task
- workspace journal

This prevents future updates to Pactile's built-in `pactile-meta` from overwriting the team's own conventions.
