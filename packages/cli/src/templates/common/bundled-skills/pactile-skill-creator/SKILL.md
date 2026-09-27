---
name: pactile-skill-creator
description: "Create or improve Pactile-compatible agent skills. Use when the user asks to author a project-local skill, shared .agents skill, platform-specific skill, or upstream Pactile bundled skill."
---

# Pactile Skill Creator

Create high-quality skills for Pactile-managed projects and Pactile bundled templates. This unified guide covers general authoring method plus Pactile packaging constraints.

This skill is the authoring and review guide for skill files. It is not the local Pactile architecture map. Use `pactile-meta` first when the user needs to understand or customize `.pactile/`, hooks, settings, commands, prompts, workflows, agents, or platform directory layout.

## Hard Constraints

- Always inspect existing skill directories and platform conventions before creating or changing a skill.
- Always keep `SKILL.md` under 500 lines, in English, and focused on trigger, constraints, workflow, references, and boundaries.
- Always use lowercase letters, numbers, and hyphens in the frontmatter `name`.
- Always write a trigger-rich frontmatter `description` that states what the skill does (WHAT) and when it should trigger (WHEN).
- Always place safety, sequencing, and reliability rules in a `## Hard Constraints` section before `## Workflow`.
- Always write Hard Constraints (and any other rule list) as imperative one-liners ("Always X. Never Y."). Never bury rules in prose paragraphs.
- Always move long guidance, examples, prompts, and reference material into directly linked files.
- Always make helper scripts deterministic, runnable from the skill directory, and explicit about inputs and outputs.
- Never repeat the same rule in two sections — Hard Constraints is the single source of truth.
- Never duplicate `pactile-meta` architecture guidance or project-private conventions inside a public Pactile skill.
- Never edit a host's built-in Skill creator to implement a Pactile project Skill.

## Workflow

1. Classify the target skill location and read `references/pactile-skill-locations.md`.
2. Gather requirements (six elements): purpose and scope, trigger scenarios, target location, domain constraints (tools / APIs / reliability), output style, and existing patterns. Infer from conversation context when available; ask the user when discrete choices are ambiguous. Capture tool budget and overlap with existing skills.
3. Design, then draft: choose a specific skill name, write a trigger-rich description, decide script / no-script, and define success and stop criteria. Draft or revise `SKILL.md` using `references/authoring-rules.md` and `references/general-authoring.md`.
4. Add `references/`, `examples/`, `prompts/`, or `scripts/` only when they reduce entry-file size or make execution more deterministic.
5. Verify the result with `references/review-checklist.md`.
6. Report changed files, validation performed, and any boundaries or follow-up work.

## References

- `references/pactile-skill-locations.md`: Choose project-local, shared, platform-specific, or upstream bundled skill locations.
- `references/authoring-rules.md`: Frontmatter, trigger descriptions, hard-constraint form, progressive disclosure, writing-for-agents techniques, deterministic scripts, and anti-patterns.
- `references/general-authoring.md`: General authoring method — principles, directory layout, patterns, utility scripts, and the minimal template.
- `references/review-checklist.md`: Final quality checklist before handing off a skill change.

## When NOT To Use

- Do not use for general Pactile architecture discovery; use `pactile-meta`.
- Do not use for project coding conventions that belong in `.pactile/spec/`.
- Do not use for one-off commands or prompts unless the user wants a durable auto-triggered capability.
- Do not use for non-Pactile global skill installation or platform configuration unless the user explicitly asks for that scope.
