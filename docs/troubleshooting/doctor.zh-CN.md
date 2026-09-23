# Doctor 风格诊断

[English](doctor.md) | 简体中文

当前 CLI 没有单独的 `doctor` 可执行命令。使用以下只读检查作为支持的诊断路径，并报告输出，不要虚构 health 结果。

```bash
pactile capability-smoke --json
pactile update --dry-run
```

按层解释结果：

| 结果                           | 含义                                   | 下一动作                                            |
| ------------------------------ | -------------------------------------- | --------------------------------------------------- |
| JSON capability 为 `ready`     | 选定 Provider 通过声明的 probe。       | 使用前仍检查 assurance 与 freshness。               |
| `pending` 或 readiness unknown | 没有当前 probe 证明可用。              | 授权/安装依赖，再运行检查。                         |
| `failed`/`degraded`            | 能力或投影被限制在失败范围。           | 遵循 user action，保留 canonical 状态，只重试局部。 |
| Update preview 报告冲突        | Ownership 或当前字节不安全替换。       | 保留 preimage，显式解决 ownership。                 |
