# 恢复 Runbook

[English](recovery.md) | 简体中文

按症状、evidence、恢复、升级顺序处理。除非用户显式确认破坏性 purge，恢复都应保持局部且可逆。

| 症状                      | Evidence                                            | 恢复                                                                      | 何时升级                                     |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------- |
| Adapter 为 `degraded`     | Capability JSON、projection receipt、ownership 条目 | 解决宿主依赖或冲突，再只重试该 Adapter；不重建兄弟 Adapter。              | Receipt 表示 interrupted 或 ownership 含糊。 |
| Ownership 冲突            | Preimage 与当前字节 fingerprint                     | 保留文件；显式选择复用、重命名或跳过。                                    | 无法确定 owner 或 claimant。                 |
| Purge preview 过期        | 新 target fingerprint 不同                          | 停止，重新 dry-run 并审阅变化的 target 集。                               | 仍有 active claim 或不安全 target。          |
| Rollback target 未 sealed | Generation verification 错误                        | 从 install state/receipt 选择 sealed generation。                         | 没有 sealed generation。                     |
| Bin 冲突                  | 命令解析到意外 executable                           | 检查 PATH 与 package bins；使用 canonical `pactile`，不要盲删用户 alias。 | Package manifest 或安装 bin 含糊。           |

## 旧 Task 迁移恢复

迁移 authority 指针是 sealed V2 generation 对外可见的唯一开关。如果
`authority.json` 缺失，但仍有迁移备份、journal、generation 或 overlay 产物，
reader 和 `pactile update` 会 fail closed 并保留这些字节；不会回退到旧
`task.json`，也不会静默重新导入。

只有以下条件全部成立时，update 重试才可恢复：journal 已验证且处于提交前状态
（`planned`、`backed-up`、`staged` 或 `validated`）；source、target 和 plan
fingerprint 完全相同；所需备份与 sealed generation 已验证；并且没有 overlay
mutation 证据。已提交或含糊的 journal、fingerprint
不匹配、备份/generation 缺失或损坏，或存在任何 overlay journal/override 证据，
都需要根据保留的迁移存储进行协调。不要删除该存储，也不要对已变化的旧输入
重跑以消除错误。

不要靠删除 `.pactile/`、重写 legacy 源或把 secret 复制进模板修复。只收集最少命令输出，并使用[支持](../governance/index.zh-CN.md)提交受治理 issue。
