# 宿主集成

[English](index.md) | 简体中文

Pactile 只保留一份项目 canonical 状态，并向 Codex 投影。宿主页面描述可观察的支持契约，不把宿主原生工具或 Provider 的安装状态假定为已满足。

## 选择路径

| 需求 | 从这里开始 | 结果 |
| --- | --- | --- |
| 新项目 | [Codex](codex.zh-CN.md) | `.pactile/`、受管 `AGENTS.md` 和 `.agents/skills/`；原生绑定取决于 readiness。 |
| 旧 Cursor 安装 | [生命周期安全](../lifecycle/index.zh-CN.md) | 先用 `pactile detach cursor --dry-run` 预览清理。 |

所有宿主都遵循同一顺序：

```text
detect -> install or adopt -> bind -> reconcile -> report readiness
```

探测是只读的。缺少宿主依赖时，Pactile 只报告安装提示，不安装宿主工具，也不复制凭据。因此 canonical install 成功时，可选能力仍可能诚实地处于 `degraded`。

## 通用首次运行

```bash
npm install -g @blxzer/pactile
pactile init --codex -y
pactile capability-smoke --json
```

先阅读 JSON 中的 readiness 与 user action，再判断能力是否可用。接下来阅读[能力来源与 Provider](../capabilities/index.zh-CN.md)或[生命周期安全](../lifecycle/index.zh-CN.md)。
