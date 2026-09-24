# 架构与权威

[English](architecture.md) | 简体中文

Pactile 只有一个 canonical runtime 和可重建的 Codex 宿主投影。Adapter 可以描述并协调宿主所需内容，但不能重新定义持久项目真相。

## 组件

| 组件                | 读取                                                      | 写入                                      | 主要输出                                    |
| ------------------- | --------------------------------------------------------- | ----------------------------------------- | ------------------------------------------- |
| Runtime             | 项目输入与显式只读迁移源                                  | `.pactile/` canonical 状态                | sealed generation 与 install state          |
| Tile compiler       | Tile catalog 与模型/显式选择                              | 不写文件状态                              | 有序 composition 与 diagnostics             |
| Kernel              | canonical records 与转换请求                              | 已校验的 canonical task/lifecycle records | 接受转换或 typed rejection                  |
| Middleware resolver | 能力 intent、策略上限、Provider manifests、probe Evidence | 仅通过所属 workflow 写 readiness          | 带 origin 与 assurance 的 Provider 解析结果 |
| Adapter             | canonical generation 与宿主观察                           | 不直接写文件                              | Projection Plan                             |
| Reconciler          | Projection Plan、Ownership ledger、当前宿主 bytes         | 获准的投影目标与 receipts                 | applied、retryable、degraded 或 review 结果 |

严格 JSON schema 见 [v1 契约参考](../pactile/contracts-v1.md)。概念页解释用户应如何理解这些契约。

## 端到端流程

```text
Tile catalog + task intent
        |
        v
模型选择 -> compiler diagnostics -> Kernel/lifecycle 校验
        |                                 |
        +------------- canonical commit --+
                                          v
                                sealed .pactile generation
                                           |
                                     Codex Adapter
                                           |
                                     Projection Plan
                                           |
                              Ownership-aware Reconciler
                                             |
                                 宿主文件 + bindings + receipts
                                             |
                                     Evidence + Trace
```

Adapter 有独立结果和重试次数。宿主投影处于 degraded 时，已提交的 canonical generation 仍可保持健康。

## 权威规则

1. `.pactile/` 是唯一可写 canonical root。
2. 声明过的迁移 root 是只读输入；当前代码不写这些路径。
3. Projection Plan 只表达意图，不携带直接文件写权限。
4. 只有 Reconciler 能写宿主投影。
5. 每次覆盖、恢复或删除都受 Ownership 与当前 bytes 检查约束。
6. 外部资产和 Provider 保留原 owner、安装面、认证状态与删除边界。

## 故障隔离

| 故障                                | 必须采取的行为                                                 |
| ----------------------------------- | -------------------------------------------------------------- |
| Tile 非法或请求扩大策略权限         | 调用前拒绝，并输出 diagnostics。                               |
| Provider 缺席或探测过期             | 报告实际更低 assurance 或 degraded/unsupported，并给用户动作。 |
| Canonical commit 失败               | 不启动 Adapter reconcile。                                     |
| Commit 后 Adapter 失败              | 保留 canonical 真相，留下可重试 receipt。                       |
| 当前宿主 bytes 与受管 snapshot 不同 | 保留并进入 review，不覆盖、不删除。                            |
| 迁移中断                            | 根据 journal 与保留的 backup 恢复，不写旧源。                  |

## 用户场景

一个项目使用 Codex，且已有用户安装的 Skill。Pactile 读取 active generation，生成 Codex Projection Plan，并将该 Skill 记为 borrowed binding。分离 Codex 时移除其 claim，同时保留用户资产。

## 边界

Pactile 不是远程编排器、secret manager、plugin marketplace，也不能替代宿主授权。它可以提供安装提示，并绑定已发现的 native asset，但不能静默安装，更不能把逻辑引用变成所有权。

继续阅读 [Tiles](tiles.zh-CN.md)、[Kernel、Evidence 与 Trace](kernel-evidence-trace.zh-CN.md)和 [Projection 与 Ownership](projection-and-ownership.zh-CN.md)。
