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

<a id="p36-held-task-reconciliation"></a>
## P36 导入后的 held Task 核对与 reconciliation

旧版 Task 的 P36 导入由项目 `update` 执行。先查看计划，再应用更新；交互终端可在审阅后确认 `pactile update`，下面的 `--skip-all` 示例适用于已确认并希望保留所有本地 managed 文件改动的非交互更新：

```bash
pactile update --dry-run --json
pactile update --skip-all --json
pactile task list
```

`pactile task list` 会把尚未解决的导入项列为 `needs definition` 或 `needs dependency coordination`，并标注 `not runnable`。只对这些 held Task 补充缺失定义或映射依赖。先用 `--check` 查看单个 Task 的 reconciliation 计划：

```bash
pactile legacy-task reconcile .pactile/tasks/09-26-v050-migration-sample \
  --idempotency-key p36-migration-definition-2026-09-26 \
  --activation-at 2026-09-26T12:00:00.000Z \
  --deliverable "An explicitly defined migrated Task" \
  --delivery-level local-result \
  --accept "AC-1=The original Task source remains available" \
  --accept "AC-2=The V2 Task begins without inferred lifecycle history" \
  --check
```

根据源记录与项目证据填写定义。`needs-coordination` Task 还要为每条待处理引用显式提供 `--resolve-dependency "<legacy-reference>=<existing-task-id>"`；在 dry-run 和批准执行时传入相同映射。确认计划后，使用同一组参数和稳定的幂等键，把末尾 `--check` 换成 `--approved`：

```bash
pactile legacy-task reconcile .pactile/tasks/09-26-v050-migration-sample \
  --idempotency-key p36-migration-definition-2026-09-26 \
  --activation-at 2026-09-26T12:00:00.000Z \
  --deliverable "An explicitly defined migrated Task" \
  --delivery-level local-result \
  --accept "AC-1=The original Task source remains available" \
  --accept "AC-2=The V2 Task begins without inferred lifecycle history" \
  --approved
pactile task artifacts 09-26-v050-migration-sample --agent
```

`--check` 返回 dry-run 且不写入、不激活 Task；`--approved` 只激活这一个 held Task。reconciliation 使用新的 migration generation，保留原始 `task.json` 与作者文档字节，不从旧状态推断 V2 Run、Review 或 Close。已激活的 Task 只接受相同幂等键与请求的重试；不同请求不能重新定义它。若源文件在导入后变化，命令会拒绝 reconciliation；先检查 `pactile task list` 和源状态，再决定是否重试。结构化文档读取方式见[结构化 Task 工件](../capabilities/structured-task-artifacts.zh-CN.md)。

archive 记录会由 `update` 写入可校验的 held 来源记录，并继续保留原归档字节。用 `pactile legacy-task history archive/<月份>/<目录> --json` 查看来源与缺失定义。只有显式选定新的 active 目标并补齐缺失字段后，才会从 archive 创建新的 Define Task；例如给 reconcile 增加 `--target-path 09-26-restored-task`。原归档不移动、不改写，恢复后的 Task 不继承旧 Run、Review 或 Close。

Kernel JSON 被截断或无法解析的 active 来源会作为 `legacyHistoryGap` held 项保留。用 `pactile legacy-task history held/<目录> --json` 查看原始字节、来源元数据和诊断。补全定义并审阅历史缺口后，通过 `--acknowledge-history-gap --target-path <active-task-path> --approved` 显式继续；此确认只表示无法解析旧 lifecycle 字节，不会修复或解释这些字节，新 V2 Task 从 Define 开始。

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
[`release-conformance.ts`](../../packages/cli/scripts/release-conformance.ts)
验收。它在无 Python 的 PATH 中记录 CLI 冷启动、后续调用、Pi RPC 冷/热启动、
并行批次与整体耗时。此验收使用模拟的 Codex 回执和 Pi 响应；真实桌面宿主与
模型 Provider 的结果应另行记录。
