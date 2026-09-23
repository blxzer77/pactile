# Generated files

A new `pactile init --codex` prepares canonical framework files under `.pactile/`, a managed block in `AGENTS.md`, and shared Skills under `.agents/skills/`. Optional native Codex bindings depend on readiness.

`.pactile/spec/`, tasks, workspace notes, and personal host settings are user-owned. `pactile update` reviews modified framework files before replacing them and does not treat a directory's existence as ownership.

Old `.cursor/` assets may remain in upgraded projects. The active adapter does not refresh them; use `pactile detach cursor --dry-run` before legacy cleanup.
