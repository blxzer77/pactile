# Codex host

English | [简体中文](codex.zh-CN.md)

The Codex adapter consumes the canonical `.pactile/` generation. When the
ChatGPT desktop app reports native project support, it may project supported
Codex files under `.codex/`; a baseline install with an unavailable app keeps
that native tree absent and reports the adapter as degraded. The adapter does
not copy the canonical Task database into a second authority. `AGENTS.md` and
shared Skills remain subject to ownership checks.

## Install and inspect

```bash
pactile init --codex -y
pactile capability-smoke --json
```

Inspect the generated project projection and the canonical receipts. A host
configuration entry can be user-owned, borrowed, Pactile-managed, or
ambiguous; the ownership ledger is the deciding evidence.

| Codex surface                       | Pactile contract                                                         |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `.codex/` project configuration     | Conditional rebuildable projection; absent when native project support is unavailable. |
| `AGENTS.md`                         | One shared managed block; user text outside the block is preserved.      |
| `.agents/skills/`                   | Shared Skill projection; a claimant does not become the owner. |
| External MCP/provider configuration | Resolved by Middleware and the host; never copied into canonical state.  |

Read each capability's origin and assurance before relying on it. Use
[capability readiness](../capabilities/index.md) for the mode matrix.

## Detach

```bash
pactile detach codex --dry-run
pactile detach codex
```

The dry run shows claimants and preserved resources. Applying the detach
removes Codex-specific bindings and leaves shared or borrowed resources alone.
