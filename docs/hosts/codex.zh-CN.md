# Codex 宿主

[English](codex.md) | 简体中文

Codex Adapter 使用 canonical `.pactile/` generation。ChatGPT desktop app 报告原生项目支持时，才可能把受支持的 Codex 文件投影到 `.codex/`；baseline install 在宿主不可用时会保持该原生目录不存在，并把 Adapter 明确报告为 degraded。Adapter 不会把 canonical Task 数据库复制成第二份权威。`AGENTS.md` 与共享 Skill 仍受 ownership 检查约束。

## 安装与检查

```bash
pactile init --codex -y
pactile capability-smoke --json
```

检查生成的项目投影和 canonical receipt。宿主配置条目可能属于用户、是 borrowed、由 Pactile 管理或语义不明确；ownership ledger 才是判断依据。

| Codex 表面             | Pactile 契约                                             |
| ---------------------- | -------------------------------------------------------- |
| `.codex/` 项目配置     | 条件式可重建投影；原生项目支持不可用时不生成。             |
| `AGENTS.md`            | 一个共享受管区块；区块外用户文本保留。                   |
| `.agents/skills/`      | 共享 Skill 投影；每个宿主是 claimant，而不是重复 owner。 |
| 外部 MCP/Provider 配置 | 由 Middleware 与宿主解析，不复制进 canonical 状态。      |

依赖某项能力前，应读取其 origin 与 assurance。模式矩阵见[能力 readiness](../capabilities/index.zh-CN.md)。

## 分离

```bash
pactile detach codex --dry-run
pactile detach codex
```

dry-run 会展示 claimant 与保留资源。应用分离后只移除 Codex 专属 binding，共享或 borrowed 资源保持不变。
