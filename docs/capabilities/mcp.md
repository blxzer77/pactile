# MCP and external tools

English | [简体中文](mcp.zh-CN.md)

MCP is a transport and tool boundary. It is not automatically a capability
claim. Pactile records a selected project capability and asks the host to
resolve a Provider manifest; startup, credentials, network access, and tool
policy remain explicit.

## Current project capabilities

| ID                   | Purpose                                                      | Server example              | Safe fallback                                     |
| -------------------- | ------------------------------------------------------------ | --------------------------- | ------------------------------------------------- |
| `codebase-retrieval` | Exact search plus optional structural/semantic retrieval.    | `codegraph`, `fast-context` | `rg`, direct reads, and source/test verification. |
| `github-mcp`         | Explicit remote repository, issue, PR, or review operations. | `github`                    | Local Git; do not claim remote writes.            |
| `playwright-mcp`     | Browser and rendered UI verification.                        | `playwright`                | Static checks or a clearly recorded manual check. |

Select capabilities during init only when the project needs them:

```bash
pactile init --codex --capability codebase-retrieval -y
pactile capability-smoke --json
```

The generated project configuration contains no token values. A missing or
stale server is reported as `degraded` or `unsupported`; Pactile does not
silently run `npx`, start a browser, or infer readiness from host identity.

## Provider contract

Before using an MCP result, check the manifest, project authorization, binding,
runtime version, probe timestamp, privacy policy, and required assurance. Keep
the result as candidate Evidence and verify important claims in current source,
tests, or a bounded receipt. Read [Providers](providers.md) and [privacy](privacy-and-permissions.md).
