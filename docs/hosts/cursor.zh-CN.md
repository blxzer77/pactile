# Cursor 宿主（历史）

[English](cursor.md) | 简体中文

Cursor 适配器曾在 Pactile v0.5 中提供，v0.6 已退役。新安装使用
[Codex](codex.zh-CN.md)；`pactile init --cursor` 和
`pactile validate-rules` 已不可用。

旧项目可能仍有 `.cursor/` 和 `adapter.cursor` ownership claim。先预览清理：

```bash
pactile detach cursor --dry-run
```

审阅计划后再运行 `pactile detach cursor`。Pactile 按 ownership 规则保留
borrowed、modified 与用户所有的内容。参见[分离与卸载](../lifecycle/detach-and-uninstall.zh-CN.md)。
