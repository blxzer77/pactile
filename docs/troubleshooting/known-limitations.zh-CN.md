# 已知限制

[English](known-limitations.md) | 简体中文

以下是明确边界，不是隐藏失败：

- Codex 桌面任务协作与 Pi Agent 桥接尚未由当前 CLI 安装，属于后续工作。
- Pactile 不安装或授权可选 MCP 与检索 Provider。readiness 缺失可以诚实地是 `unsupported` 或 `degraded`。
- Provider 结果在源码、Git、测试或受限 receipt 佐证前只是候选。
- detach 与 uninstall 保留 canonical 状态；只有显式确认的 purge 才删除 canonical target 集。
- 当前 CLI 没有 `doctor` 命令；请使用[doctor 风格页面](doctor.zh-CN.md)中的诊断检查。
- 完整 Core 与 CLI 测试是发布 preflight gate，不代表每次本地变更都运行了全量 suite。
