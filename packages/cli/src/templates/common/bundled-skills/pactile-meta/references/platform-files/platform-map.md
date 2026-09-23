# Active host map

| Host | Init flag | Managed project files |
| --- | --- | --- |
| Codex desktop | `--codex` | `AGENTS.md`, `.agents/skills/`, and optional native project configuration |

Pactile does not install a Cursor adapter. `pactile detach cursor --dry-run` previews cleanup of an older installation.

Check actual files and `pactile capability-smoke --json` before assuming a native hook, MCP server, or plugin is active. The Codex cross-session bridge is planned work; project files alone do not dispatch another task.
