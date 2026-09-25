# Capabilities, Providers, and privacy

English | [简体中文](index.zh-CN.md)

Pactile separates a capability's origin from its assurance. A capability may
be native to a host, supplied by an explicitly configured Provider, inferred by
a heuristic, or unsupported. Only current Evidence and policy checks can raise
assurance; a name in a config file is not proof.

## Capability map

| Capability       | Page                                                  | Typical origin                           | First safe check                                       |
| ---------------- | ----------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------ |
| Skills           | [Skills](skills.md)                                   | `native`, adopted, or Pactile projection | Inspect `.agents/skills/` and ownership.               |
| MCP              | [MCP](mcp.md)                                         | `provider` or `unsupported`              | Read the selected manifest and run an approved probe.  |
| Native resources | [Install, adopt, bind](native-adoption.md)            | host-owned or borrowed                   | Compare current bytes with the recorded preimage.      |
| Retrieval        | [Retrieval](retrieval.md)                             | exact search plus optional Provider      | Run exact search first; verify candidates in source.   |
| Workspace tools  | [Bounded workspace requests](bounded-workspace-requests.md) | built-in Node adapter                    | Set request budgets and check outcome/error codes.     |
| Providers        | [Providers](providers.md)                             | explicitly installed and authorized      | Check origin, readiness, freshness, and assurance.     |
| Privacy          | [Privacy and permissions](privacy-and-permissions.md) | policy boundary                          | Review data flow and credential scope before enabling. |
| Subagents        | [Subagents](subagents.md)                             | host dispatch plus shared Task contract  | Use the CLI dispatch prompt and task gates.            |

## Four modes

| Mode          | Meaning                                                   | What it permits                                                   | What it does not prove                                                      |
| ------------- | --------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `native`      | The selected host exposes the capability directly.        | Use the host API within its declared policy.                      | That the result is fresh, cross-host, or high assurance.                    |
| `provider`    | An external, project-authorized Provider supplies it.     | Use only after manifest, binding, probe, and privacy checks pass. | That the Provider is installed, reachable, or trustworthy without Evidence. |
| `heuristic`   | A fallback or best-effort inference produced a candidate. | Continue with explicit caveats and direct verification.           | A final technical claim.                                                    |
| `unsupported` | No permitted implementation is available.                 | Report the user action or choose a safer alternative.             | Silent installation or a made-up result.                                    |

`pactile capability-smoke --json` reports selected capabilities and readiness.
`--write-status` is an explicit state write; otherwise the command is read-only.

## Shared boundary

Providers are installed and authorized by the user or host. Pactile does not
copy credentials, start arbitrary servers, or turn a Provider's output into
canonical state automatically. Read [privacy](privacy-and-permissions.md) and
[native adoption](native-adoption.md) before enabling a new integration.
