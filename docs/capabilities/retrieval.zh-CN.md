# 检索与 assurance

[English](retrieval.md) | 简体中文

检索是一种路由策略，不承诺每个宿主都拥有相同搜索工具。Pactile 使用四种 intent，并报告当前宿主与 Provider 事实实际支持的最低 assurance。

| intent       | 首选路由                         | 可选路由               | 必需证明                                       |
| ------------ | -------------------------------- | ---------------------- | ---------------------------------------------- |
| `exact`      | `rg`、路径与字面量搜索           | 无需额外工具           | 阅读当前文件和行范围。                         |
| `structural` | 显式 codegraph 或同类工具        | 宿主结构 Adapter       | 在源码中确认返回的 symbol/range。              |
| `semantic`   | 项目授权的 semantic Provider     | 宿主原生 semantic 工具 | 检查 binding、freshness 与策略，再做精确读取。 |
| `external`   | 显式 Provider，例如 smart-search | 获批的 Web fallback    | 保存来源 URL、时间与相关性。                   |

声称可选能力 readiness 前运行：

```bash
pactile capability-smoke --json
```

宿主 identity 或用户全局路由文件永远不能选择 Provider。Provider 缺失、过期、未授权或超出隐私策略时，应标记 `heuristic`、`degraded` 或 `unsupported`，并在安全时回到 exact search。候选检索只有经当前源码、Git diff、测试或受限 receipt 佐证后才是最终 Evidence。

## 隐私边界

External intent 只能向选定 Provider 发送用户批准的 query 与允许的上下文。默认不要发送凭据、私有日志、隐藏推理或整个仓库。另见[Provider](providers.zh-CN.md)与[隐私与权限](privacy-and-permissions.zh-CN.md)。

## 可选 Jev 规划建议

异步 `pactile context --mode session --json` 路径在 V2 Session 存在 fact gap 且调用方没有显式指定 intents 时，可以询问 Jev 是否增加 semantic 或 structural 路由。它始终保留 `exact`。Jev 不能增加 `external`、授权 Provider 或改变 Kernel 策略。外发请求仅带本地生成的 V2 phase 与 fact-gap 摘要，不带用户控制的 Task 标题、交付物或源码片段。本地会检查有界 Task 文本中的已知凭据、assignment、JSON 字段、cookie/session/authorization 字段、含 user-info 的 URL 与敏感标记；命中时在 HTTP 前回退。结构化内容采用保守判断，可能触发安全回退；无法可靠识别任意未标记的秘密值，因此本入口始终不外发原始 Task 文本。

可在项目配置中显式允许或拒绝这次规划外发：

```yaml
jev:
  egress: deny
```

省略 `jev.egress` 时，有效或不存在的 `.pactile/config.yaml` 默认允许这次有界建议，但必须配置 `PACTILE_JEV_API_KEY`。`PACTILE_JEV_ENABLED=false` 会禁用建议。`egress: allow` 可显式记录默认值；`egress: deny` 会阻止请求。未知值、重复或有歧义的 Jev 配置、配置读取或解析不确定都会 fail closed，回退到确定性 exact 计划。密钥只从进程环境读取，不写入 Session receipt。

Session pack 会保留原有的 `retrievalPlanning` 字段，并增加脱敏的
`retrievalPlanning.audit` 回执。回执记录 retrieval-planning 节点、有界输入摘要的
指纹、semantic 与 structural 候选 intent、Jev 建议、确定性 intent、已采用或被覆盖
的 intent、模型、传输延迟、尝试次数、usage 与预计输入成本。回执不包含摘要正文、源码
片段、API key 或 Provider 响应正文。项目 deny、敏感内容命中、密钥缺失或传输失败都会
记录 fallback 审计，并保留 exact 计划。

此项目开关同时管理 Jev 检索规划与 selected Task 的 Tile Session 建议。Tile 建议遇到项目 deny 或无效配置时，会在 HTTP 前阻止 Jev，即使历史 active Run grant 曾允许外发。项目 allow 只是额外一道门：当前 active Run grant 仍须独立允许目标地址和其他 Jev 策略条件。
