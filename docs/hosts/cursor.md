# Cursor host (historical)

English | [简体中文](cursor.zh-CN.md)

The Cursor adapter shipped in Pactile v0.5 and is retired for v0.6. New
installations use [Codex](codex.md); `pactile init --cursor` and
`pactile validate-rules` are no longer available.

Older projects may still contain `.cursor/` and an `adapter.cursor` ownership
claim. Preview its removal before changing files:

```bash
pactile detach cursor --dry-run
```

After reviewing the plan, run `pactile detach cursor`. Pactile preserves
borrowed, modified, and user-owned content under the ownership rules. See
[detach and uninstall](../lifecycle/detach-and-uninstall.md).
