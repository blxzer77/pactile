# 升级与迁移

[English](upgrade-and-migrate.md) | 简体中文

将 CLI 升级与项目迁移分开。upgrade 改变全局工具；update 协调一个项目；import 只读取显式指定的 legacy 源。每次写入前先 preview。

| intent               | 命令                                             | 写入边界                                      |
| -------------------- | ------------------------------------------------ | --------------------------------------------- |
| 查看项目变化         | `pactile update --dry-run`                       | 只读。                                        |
| 应用已审阅的项目更新 | `pactile update`                                 | canonical `.pactile/` 与安全的 managed 投影。 |
| 预览 legacy 迁移     | `pactile migrate --dry-run`                      | 此命令始终只读。                              |
| 显式 legacy import   | 见[显式导入参考](../pactile/compatibility-inputs.zh-CN.md#显式导入)。 | 读取 legacy 树；审阅后只写 canonical 状态。   |
| 升级全局 CLI         | `pactile upgrade --dry-run` 再 `pactile upgrade` | 包管理器范围，不改项目数据。                  |

在 0.5.x compatibility window 中，经 receipt 与 ownership plan 允许时可以双读旧输入。新输出只使用 Pactile 名称与 `.pactile/`。modified 或 foreign 文件不会被静默迁移。preview 显示 checksum、manifest 或 ownership 冲突时，保留 preimage、记录 evidence，解决后再使用 `--force`。

`pactile rollout --project <path> --dry-run --json` 可汇总显式列出的项目 preview；不要把它当成隐式全局扫描。
