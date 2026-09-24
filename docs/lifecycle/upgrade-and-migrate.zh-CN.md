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

## 已有安装迁到 Node 入口（v0.6.0）

安装 v0.6.0 CLI 后，在每个已安装项目的根目录执行：

```bash
pactile update --dry-run --json
pactile update --skip-all --json
pactile task list
```

预览中的 `plan.files` 列出新增和刷新的 Node 版模板、`safeDeleted` 候选、
本地改动后保留的 `legacyPythonPreserved` 文件，以及无归属或被跳过的
`legacyPythonUnprocessed` 文件。`legacyPythonHashClaimsReleased` 列出已解除
模板哈希归属的旧脚本，即使文件仍留在磁盘上。应用报告列出实际删除项。检查
备份路径与 lifecycle/Adapter 状态；遇到 degraded 或 interrupted 应先排查，再依赖新入口。
`--skip-all` 保留用户修改过的 managed 文件；之后逐项审阅，再决定是否覆盖。
保留下来的 `.pactile/scripts/*.py` 不会进入活动 Node generation。更新过程
不运行 Python，用户任务、spec、middleware 和外来文件不在替换范围内。

未发布的 `0.5.1-beta.0` pool 预置迁移已并入 `0.6.0-beta.1` 清单，正式版
`0.6.0` 也保留该清单。从 `0.5.0` 直接升级正式版或升级 beta 都会执行，
从 beta 升级正式版不会重复执行。只有旧骨架的三个
路径是哈希校验后的删除候选：`.pactile/pool/README.md`、
`.pactile/pool/plan.md`、`.pactile/pool/items/.gitkeep`。用户编写的 pool
条目不在目标内，也无需先执行独立的 `0.5.1-beta.0` 升级。

发布前维护者运行封装 tarball 的
[`release-conformance.js`](../../packages/cli/scripts/release-conformance.js)
验收。它在无 Python 的 PATH 中记录 CLI 冷启动、后续调用、Pi RPC 冷/热启动、
并行批次与整体耗时。此验收使用模拟的 Codex 回执和 Pi 响应；真实桌面宿主与
模型 Provider 的结果应另行记录。
