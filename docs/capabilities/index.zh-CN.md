# 能力、Provider 与隐私

[English](index.md) | 简体中文

Pactile 将能力的 origin 与 assurance 分开。能力可能是宿主原生、由显式配置的 Provider 提供、由 heuristic 推断，或 unsupported。只有当前 Evidence 与策略检查才能提升 assurance；配置文件中的名称不是证明。

## 能力地图

| 能力     | 页面                                             | 常见 origin                       | 首个安全检查                                     |
| -------- | ------------------------------------------------ | --------------------------------- | ------------------------------------------------ |
| Skills   | [Skills](skills.zh-CN.md)                        | `native`、adopted 或 Pactile 投影 | 检查 `.agents/skills/` 与 ownership。            |
| MCP      | [MCP](mcp.zh-CN.md)                              | `provider` 或 `unsupported`       | 读取选定 manifest 并运行获批 probe。             |
| 原生资源 | [install、adopt、bind](native-adoption.zh-CN.md) | 宿主所有或 borrowed               | 将当前字节与已记录 preimage 比较。               |
| 检索     | [检索](retrieval.zh-CN.md)                       | exact search 加可选 Provider      | 先做精确搜索，再在源码中核对候选。               |
| 工作区工具 | [有界工作区请求](bounded-workspace-requests.zh-CN.md) | 内置 Node Adapter                   | 设置请求预算，并检查 outcome 与错误码。           |
| Provider | [Provider](providers.zh-CN.md)                   | 显式安装并授权                    | 检查 origin、readiness、freshness 与 assurance。 |
| 隐私     | [隐私与权限](privacy-and-permissions.zh-CN.md)   | 策略边界                          | 启用前审阅数据流和凭据范围。                     |
| Subagent | [Subagent](subagents.zh-CN.md)                   | 宿主派发加共享 Task 契约          | 使用 CLI dispatch prompt 与 Task gate。          |
| 结构化任务工件 | [PRD、Design、Implement、Review 与 Verify](structured-task-artifacts.zh-CN.md) | Kernel 派生的生命周期事实 | 先读索引，再按需展开事实或用户撰写的文档。 |

## 四种 mode

| mode          | 含义                                   | 允许什么                                               | 不能证明什么                                       |
| ------------- | -------------------------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| `native`      | 选定宿主直接暴露该能力。               | 在声明的策略内使用宿主 API。                           | 结果新鲜、跨宿主或高 assurance。                   |
| `provider`    | 外部且经项目授权的 Provider 提供能力。 | 只有 manifest、binding、probe 与隐私检查通过后才可用。 | 没有 Evidence 就证明 Provider 已安装、可达或可信。 |
| `heuristic`   | fallback 或尽力而为的推断产生候选。    | 带明确说明继续，并直接核实。                           | 最终技术结论。                                     |
| `unsupported` | 没有允许的实现。                       | 报告用户动作或选择更安全的替代。                       | 静默安装或虚构结果。                               |

`pactile capability-smoke --json` 报告选定能力与 readiness。`--write-status` 是显式状态写入；不带它时命令只读。

## 共享边界

Provider 由用户或宿主安装并授权。Pactile 不复制凭据、不启动任意 server，也不会自动把 Provider 输出变成 canonical 状态。启用新集成前阅读[隐私](privacy-and-permissions.zh-CN.md)与[原生 adoption](native-adoption.zh-CN.md)。

## v0.6.0 的 Jev 判断节点

Jev 是可选能力。每个活跃节点先构造经过策略过滤的确定性决策；Jev 只能在这些候选内给出建议。下表列出实际调用节点的产品入口。

| 节点 | 产品入口 | Jev 的有界选择 |
| --- | --- | --- |
| `tile-selection` | Session context 与选中 Task 的 Tile offer（`compileSessionPackWithJevV1`） | 建议合格的 Tile ref；显式 Tile 决策与 Compiler 仍需通过。 |
| `retrieval-planning` | 存在 fact gap 的 Session context（`compileSessionRetrievalPlanWithJevV1`） | 可增加本地 semantic 或 structural intent；保留 exact，不能增加 external。 |
| `task-scheduling` | Task schedule plan 与活动 Parent 并行派发（`scheduleTaskKernelGraphWithJevV1` / `scheduleParentTaskGraphWithJevV1`） | 只打破首波合格关键路径并列；依赖、worktree、写入 lease 门仍由本地检查。 |
| `verification-planning` | Task verify plan（`adviseVerificationPlanWithJevV1`） | 建议可选检查；不能移除必需 CI 或已声明的检查。 |
| `review-routing` | 独立 Pi Check（`createPiReviewRoutingAdviceV1`） | 在 Pi Review 非通过后建议可选的 Codex 只读 Review；强制升级规则与 Kernel Review 仍有最终权威。 |
| `execution-routing` | 预留；当前 V2 Run 路径没有调用方 | Pi 是唯一合格的 Execute provider。出现其他合格 provider 前，无需调用模型。 |

项目 `jev.egress: deny` 和无效项目策略会阻止传输。缺少配置、内容被拒绝、低置信度、超时或服务故障时，保留本地决策并记录有界回退回执。回执区分 Provider 原样提供的置信度与不可用置信度，并在有数据时记录延迟、模型、usage 和预计成本。Jev 不能授权、启动 Run、放宽硬依赖、给出 Review PASS 或关闭 Task。只有节点与当前授权同时允许时才会外发源码片段；共享外发门会在 HTTP 前拒绝识别出的凭据和显式敏感标记。
