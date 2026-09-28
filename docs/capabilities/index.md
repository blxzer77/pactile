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
| Structured task artifacts | [Structured task artifacts (简体中文)](structured-task-artifacts.zh-CN.md) | Kernel-derived lifecycle facts | Read the index first, then expand selected facts or authored documents. |
| Reuse decisions | [Reuse before building](reuse-first.md) | Define/Execute/Verify guidance | Inspect existing capabilities, permitted alternatives and decision evidence. |

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

## Jev decision nodes in v0.6.0

Jev is optional. Each active node first builds a deterministic, policy-filtered
decision; Jev may advise only within those candidates. The table names the
product entry point that actually calls each node.

| Node | Product entry point | Jev's bounded choice |
| --- | --- | --- |
| `tile-selection` | Session context and selected Task Tile offer (`compileSessionPackWithJevV1`) | Suggest eligible Tile refs; the explicit Tile decision and Compiler still apply. |
| `retrieval-planning` | Session context with a fact gap (`compileSessionRetrievalPlanWithJevV1`) | Add local semantic or structural intent; keep exact and never add external. |
| `task-scheduling` | Task schedule plan and active Parent parallel dispatch (`scheduleTaskKernelGraphWithJevV1` / `scheduleParentTaskGraphWithJevV1`) | Break an eligible first-wave critical-path tie; dependency, worktree, and write-lease gates stay local. |
| `verification-planning` | Task verify plan (`adviseVerificationPlanWithJevV1`) | Suggest optional checks; required CI and declared checks cannot be removed. |
| `review-routing` | Independent Pi Check (`createPiReviewRoutingAdviceV1`) | Suggest an optional Codex read-only Review after a non-passing Pi Review; mandatory escalation rules and Kernel Review remain authoritative. |
| `execution-routing` | Reserved; no caller in the current V2 Run path | Pi is the only eligible Execute provider. No model call is useful until another eligible provider exists. |

Project `jev.egress: deny` and invalid project policy block transport. Missing
configuration, rejected content, low confidence, timeout, or service failure
retain the local decision and a bounded fallback receipt. Receipts distinguish
provider-reported confidence from unavailable confidence and record observed
latency, model, usage, and estimated cost where returned. Jev cannot grant
approval, start a Run, relax a hard dependency, issue Review PASS, or Close a
Task. Source snippets are sent only where the specific node and current
authorization permit them; the shared outbound guard rejects recognized
credentials and explicit sensitive markers before HTTP.
