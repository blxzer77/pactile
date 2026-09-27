# 生命周期与安全变更

[English](index.md) | 简体中文

Pactile 生命周期命令先操作 canonical `.pactile/` generation，再协调宿主投影。根据项目状态选择路径：

| 状态                | 入口                                        | 首个动作                                         |
| ------------------- | ------------------------------------------- | ------------------------------------------------ |
| 新项目              | [安装](install.zh-CN.md)                    | `pactile init --codex`。                       |
| 已有 legacy 项目    | [升级与迁移](upgrade-and-migrate.zh-CN.md)  | 先 preview；只允许显式 legacy import。           |
| 混合或部分配置项目  | [排障](../troubleshooting/index.zh-CN.md)   | 更新前检查 ownership 与 readiness。              |
| 日常工作            | [Workflow](workflow.zh-CN.md)               | 遵循 canonical Task 与 Evidence gate。           |
| 移除一个或所有宿主  | [分离与卸载](detach-and-uninstall.zh-CN.md) | 先 dry-run，再执行非破坏性退出。                 |
| 恢复已知 generation | [回滚与 purge](rollback-and-purge.zh-CN.md) | 验证 sealed generation；purge 是独立破坏性步骤。 |

## 安全规则

- `--dry-run` 只预览，不授权后续写入。
- detach 与 uninstall 都保留 canonical 状态。
- modified、foreign、unknown、borrowed 或锁定资源会停在 review。
- rollback 只接受 sealed generation；恢复 canonical target 时某个 Adapter 仍可能 degraded。
- purge 需要 inactive install、无 ownership claim、新鲜 target fingerprint 与精确显式确认。

完整 Core 与 CLI suite 按约定只在最终发布前运行，不是日常生命周期命令。诊断证据见[能力 mode](../capabilities/index.zh-CN.md)与[恢复 runbook](../troubleshooting/recovery.zh-CN.md)。
