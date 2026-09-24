# Cursor 与 Codex 共存（历史）

[English](coexistence.md) | 简体中文

Pactile v0.5 曾允许同一个 canonical generation 同时向 Cursor 与 Codex 投影。
该安装模式已退役。新安装和更新只选择 Codex。旧 Cursor claim 可用于安全退出，
Codex 更新不会刷新它。

对于已有双宿主项目，先运行 `pactile detach cursor --dry-run` 审阅 ownership
计划。执行 `pactile detach cursor` 仅释放该 claim，并保留 modified、borrowed
和用户所有的文件。参见[投影与所有权](../concepts/projection-and-ownership.zh-CN.md)。
