# Cursor limitations and safe fallbacks

**Historical v0.5 reference:** The Cursor adapter is retired in the v0.6 development line, which targets Codex. For an older installation, preview safe cleanup with `pactile detach cursor --dry-run`.

English | [简体中文](cursor-limitations.zh-CN.md)

The Cursor adapter is intentionally conservative. A host feature can be
available while its context channel is best-effort; Pactile labels that
difference instead of turning an optimistic probe into assurance.

| Observation                                                              | Mode                        | Evidence                                                  | Safe fallback                                                            |
| ------------------------------------------------------------------------ | --------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------ |
| Project rules and the bootstrap rule are loaded.                         | `native`                    | `pactile validate-rules` and the installed rule manifest. | Continue with the canonical workflow.                                    |
| A session hook runs but its additional context is absent from the Agent. | `heuristic`/`degraded`      | Hook receipt plus a missing-context diagnostic.           | Read `AGENTS.md`, `.pactile/workflow.md`, and the CLI dispatch prompt.   |
| A selected MCP or Provider is not installed or its probe is stale.       | `unsupported` or `degraded` | `pactile capability-smoke --json` readiness and action.   | Install or authorize the dependency yourself, then re-run the probe.     |
| A host file is modified, foreign, locked, or ambiguous.                  | `degraded`                  | Ownership preimage and current-byte comparison.           | Keep the file, resolve ownership explicitly, and retry the adapter only. |

## What not to infer

- A visible `.cursor/` directory does not prove that Pactile owns every file in
  it.
- A Provider name in a config file does not prove readiness, authorization, or
  assurance.
- A hook log does not replace a Kernel gate or an Evidence receipt.
- A Cursor projection does not become canonical state; regenerate it from
  `.pactile/` after a reviewed change.

## Diagnostics

```bash
pactile capability-smoke --json
pactile validate-rules
pactile update --dry-run
```

Capture the JSON output and the affected receipt when asking for help. Do not
paste credentials, private logs, or a whole user directory. If the issue is
only context injection, use the [Codex or shared workflow page](../lifecycle/workflow.md)
to continue with the same canonical Task.
