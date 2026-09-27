# Skills and commands

Pactile projects expose managed Skills under `.agents/skills/`. Project-specific Skills can live there when the user owns them; inspect existing names and ownership before editing. Keep durable project conventions in `.pactile/spec/`.

Use `pactile-skill-creator` when authoring a Skill. Keep `pactile-meta` focused on routing and architecture. The CLI owns task lifecycle commands; a Skill can explain when to run one, but its text does not prove that a command ran.

Legacy host command directories are not active installation targets.
