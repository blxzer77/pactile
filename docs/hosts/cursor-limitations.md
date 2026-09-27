# Cursor limitations and safe fallbacks

**Historical v0.5 reference:** The host adapter was removed from the v0.6 release line. This page records past behavior and is not a current setup or cleanup guide.

English | [简体中文](cursor-limitations.zh-CN.md)

The adapter reported host capability separately from its context channel and
kept uncertain behavior at best-effort or degraded assurance. These observations
are preserved to explain v0.5 receipts and user reports.

| v0.5 observation                                                        | Reported mode               | Historical evidence                            | Recorded fallback                                                      |
| ------------------------------------------------------------------------ | --------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| Project rules and the bootstrap rule were loaded.                       | `native`                    | The installed rule manifest.                  | Continue with the canonical workflow.                                  |
| A session hook ran but its additional context was absent from the Agent. | `heuristic`/`degraded`      | Hook receipt and missing-context diagnostic.  | Read `AGENTS.md`, `.pactile/workflow.md`, and the CLI dispatch prompt. |
| A selected MCP or Provider was not installed or its probe was stale.     | `unsupported` or `degraded` | Readiness and action output.                   | Install or authorize the dependency, then re-run its probe.             |
| A host file was modified, foreign, locked, or ambiguous.                 | `degraded`                  | Ownership preimage and current-byte comparison. | Keep the file and resolve ownership explicitly.                        |

The historical ownership rule was conservative: seeing a host configuration
directory did not prove Pactile owned every file in it; Provider names did not
prove readiness; and a host projection did not become canonical state.

Use the current [Codex guide](codex.md) for supported diagnostics and operations.
