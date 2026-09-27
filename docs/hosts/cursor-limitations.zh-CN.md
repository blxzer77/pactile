# Cursor 限制与安全回退

**历史资料（v0.5）：** 此宿主适配器已从 v0.6 发布线移除。本页记录过去的行为，不是当前安装或清理指南。

[English](cursor-limitations.md) | 简体中文

适配器会分别报告宿主能力和上下文通道，并把不确定行为限制在 best-effort 或
degraded assurance。本页保留这些观察，用来解释 v0.5 receipt 与用户报告。

| v0.5 观察                                        | 当时报告的模式              | 历史证据                                    | 当时记录的回退                                                    |
| ----------------------------------------------- | --------------------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| 项目 rules 与 bootstrap rule 已加载。           | `native`                    | 已安装的 rule manifest。                    | 继续使用 canonical workflow。                                     |
| Session Hook 运行，但 Agent 未收到额外上下文。  | `heuristic`/`degraded`      | Hook receipt 与缺少上下文的诊断。           | 阅读 `AGENTS.md`、`.pactile/workflow.md` 与 CLI dispatch prompt。 |
| 选定的 MCP 或 Provider 未安装，或 probe 已过期。 | `unsupported` 或 `degraded` | 当时的 readiness 与 action 输出。           | 安装或授权依赖，然后重新 probe。                                  |
| 宿主文件被修改、属于外部、被锁定或语义不明确。   | `degraded`                  | Ownership preimage 与当前字节比较。         | 保留文件并显式解决 ownership。                                    |

当时采用保守的 ownership 规则：看到宿主配置目录不代表其中每个文件都由 Pactile 所有；
Provider 名称不代表 readiness；宿主投影也不会变成 canonical 状态。

当前支持的诊断和操作见 [Codex 指南](codex.zh-CN.md)。
