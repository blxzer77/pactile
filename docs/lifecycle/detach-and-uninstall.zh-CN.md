# 分离与卸载

[English](detach-and-uninstall.md) | 简体中文

Detach 释放一个宿主 Adapter；uninstall 释放所有已安装 Adapter。二者都不会破坏 canonical 状态；破坏性清理由独立的 `purge` 完成。

| 操作           | Preview                              | 应用                                  | 保留内容                                                |
| -------------- | ------------------------------------ | ------------------------------------- | ------------------------------------------------------- |
| 当前宿主       | `pactile detach codex --dry-run`     | `pactile detach codex`              | `.pactile/`、borrowed 与 modified 文件。 |
| 旧 Cursor 安装 | `pactile detach cursor --dry-run`    | `pactile detach cursor`             | 用户文件与旧安装中的其他 claimant。 |
| 所有宿主       | `pactile uninstall --dry-run`        | `pactile uninstall --yes`             | 完整 `.pactile/` 状态与 receipt。                       |
| 清理 canonical | [Purge](rollback-and-purge.zh-CN.md) | 独立 fingerprint + 确认               | 确认目标集内的内容都不保留。                            |

Preview 绑定当前 install state、generation、ownership ledger 与当前字节。如果 preview 与 apply 之间文件发生变化，操作会安全停止。只有最后 claimant 离开且当前字节匹配安全 managed fingerprint 时才可移除生成文件；borrowed 资源永不删除。
