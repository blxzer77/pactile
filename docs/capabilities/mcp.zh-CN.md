# MCP 与外部工具

[English](mcp.md) | 简体中文

MCP 是传输与工具边界，不自动等同于能力声明。Pactile 记录项目选定的 capability，再让宿主解析 Provider manifest；启动、凭据、网络和工具策略都必须显式。

## 当前项目能力

| ID                   | 作用                                     | server 示例                 | 安全回退                            |
| -------------------- | ---------------------------------------- | --------------------------- | ----------------------------------- |
| `codebase-retrieval` | 精确搜索以及可选结构/语义检索。          | `codegraph`、`fast-context` | `rg`、直接读取与 source/test 核验。 |
| `github-mcp`         | 显式远程仓库、issue、PR 或 review 操作。 | `github`                    | 本地 Git；不要声称远程写入。        |
| `playwright-mcp`     | 浏览器和渲染 UI 验证。                   | `playwright`                | 静态检查或明确记录的人工检查。      |

只在项目需要时于 init 选择能力：

```bash
pactile init --codex --capability codebase-retrieval -y
pactile capability-smoke --json
```

生成的项目配置不包含 token 值。server 缺失或过期时报告 `degraded` 或 `unsupported`；Pactile 不会静默运行 `npx`、启动浏览器，也不会根据宿主 identity 推断 readiness。

## Provider 契约

使用 MCP 结果前检查 manifest、项目授权、binding、runtime version、probe 时间、隐私策略与所需 assurance。结果只作为候选 Evidence；重要结论仍需在当前源码、测试或受限 receipt 中核验。阅读[Provider](providers.zh-CN.md)与[隐私](privacy-and-permissions.zh-CN.md)。
