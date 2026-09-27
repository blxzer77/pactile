# 作为能力投影的 Skills

[English](skills.md) | 简体中文

Skill 是可复用的能力表面，不是第二套 workflow。Pactile 可以将 Tile 投影到 `.agents/skills/`，Codex 提供发现它的宿主 binding。canonical Tile 定义与 Task 策略仍在 `.pactile/`。

## mode 与 evidence

| 观察                         | mode                                  | 要记录的 evidence                           | 用户动作                                |
| ---------------------------- | ------------------------------------- | ------------------------------------------- | --------------------------------------- |
| 宿主已有兼容 Skill。         | `native`/`adopted`                    | 宿主路径、preimage、owner 与 claimant。     | 不改原生字节，直接 bind。               |
| Pactile 从 Tile 组合 Skill。 | 与 Provider 无关的 managed projection | generation、manifest 与 ownership receipt。 | 审阅 plan 后再 reconcile。              |
| Skill 存在但语义不同。       | `degraded`/`unsupported`              | 冲突详情和当前字节 fingerprint。            | 重命名、显式复用或跳过，不覆盖。        |
| Skill 缺失。                 | 安装或投影前为 `unsupported`          | 探测结果与安装提示。                        | 自行安装外部依赖，或选择 Pactile Tile。 |

共享 identity 是 workspace 内的 `resource kind + stable logical id`。两个宿主可以 claim 一个生成的 Skill。分离一个宿主只移除其 claimant；绝不删除 borrowed Skill；生成 Skill 只有在最后 claimant 离开且字节仍安全匹配时才删除。

## 检查与更新

```bash
pactile capability-smoke --json
pactile update --dry-run
```

接受更新前先读取 ownership ledger 与 projection receipt。用户文件和外部资源不在 Pactile 的删除边界内。完整状态机见[原生 adoption](native-adoption.zh-CN.md)。
