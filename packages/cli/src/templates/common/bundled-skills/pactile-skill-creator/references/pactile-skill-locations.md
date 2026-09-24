# Pactile Skill locations

| Need | Location | Ownership |
| --- | --- | --- |
| Project-local Codex Skill | `.agents/skills/<name>/SKILL.md` | User-owned unless the ownership ledger explicitly claims it |
| Project coding rule | `.pactile/spec/` | User-owned |
| Bundled product Skill | `packages/cli/src/templates/common/bundled-skills/<name>/` in the Pactile source repository | Product-owned |

Inspect the project's existing Skill names and ownership before writing. Do not overwrite a generated Skill silently. A project-local change belongs in the project; an upstream product change belongs in the Pactile repository with validation.

Older host Skill directories can remain after upgrade. They are migration inputs, not new Pactile installation targets.
