# Cursor 限制与安全回退

**历史资料（v0.5）：** Cursor 适配已退役。v0.6 开发线仅支持 Codex。旧安装可先运行 `pactile detach cursor --dry-run` 预览安全清理。

[English](cursor-limitations.md) | 简体中文

Cursor Adapter 采用保守策略。宿主功能可能存在，但其上下文通道只是尽力而为；Pactile 会标出这种差异，不把乐观探测直接升级为 assurance。

| 观察                                                      | mode                        | evidence                                                   | 安全回退                                                          |
| --------------------------------------------------------- | --------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| 项目 rules 与 bootstrap rule 已加载。                     | `native`                    | `pactile validate-rules` 与已安装 rule manifest。          | 继续使用 canonical workflow。                                     |
| Session Hook 运行了，但 Agent 没收到 additional context。 | `heuristic`/`degraded`      | Hook receipt 及缺少上下文诊断。                            | 阅读 `AGENTS.md`、`.pactile/workflow.md` 与 CLI dispatch prompt。 |
| 选定的 MCP 或 Provider 未安装，或 probe 已过期。          | `unsupported` 或 `degraded` | `pactile capability-smoke --json` 的 readiness 与 action。 | 由用户自行安装或授权依赖，再重新 probe。                          |
| 宿主文件被修改、属于外部、被锁定或语义不明确。            | `degraded`                  | Ownership preimage 与当前字节比较。                        | 保留文件，显式解决 ownership，只重试受影响的 Adapter。            |

## 不应推断的结论

- 看见 `.cursor/` 不代表其中每个文件都由 Pactile 所有。
- 配置文件中的 Provider 名称不代表 readiness、授权或 assurance。
- Hook 日志不能代替 Kernel gate 或 Evidence receipt。
- Cursor 投影不是 canonical 状态；审查后的变化应从 `.pactile/` 重建。

## 诊断

```bash
pactile capability-smoke --json
pactile validate-rules
pactile update --dry-run
```

求助时附上 JSON 输出与相关 receipt。不要粘贴凭据、私有日志或整个用户目录。如果问题只涉及上下文注入，可按[Codex 或共享 workflow 页面](../lifecycle/workflow.zh-CN.md)继续同一个 canonical Task。
