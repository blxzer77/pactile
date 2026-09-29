# `vcs-integration`

P29 表名：`vcs-integration`（不得改名）。层：on-demand。

## 职责

处理交付所需的 Git/PR/合并事实和 Run worktree 集成、回收。`local-result` / `documentation` 可不要求 Git；`pull-request` / `merged-result` 必须满足定义的层级与 HTTPS 交付引用。Git 操作和 Kernel Close 是分别可核对的结果。

## 触发/披露

Task 的交付层级、获授权的 Git 最终操作或已结束 Run 的资源清理需要时加载。按仓库分支策略和已有授权操作；commit、merge、push、tag、release 保持各自边界，不能由 Review PASS 或交接自动获得。

复用 `pactile worktree create|adopt|reconcile|inspect|integrate|reclaim`；先用 `pactile worktree --help` 核对参数。`integrate <task> <run> --target <local-branch>` 校验目标已含该 Run 结果，不执行 Git merge。worktree 提供文件隔离，不等于 OS 沙箱或所有资源隔离。

回收通过 manager 在 Host 已停止、集成事实和 Task Close 等门满足后进行；先核对具体路径、所有者、dirty/ignored 数据、独有历史及其他进程。被使用或有需保全内容时保留并记录原因，不能裸删目录来满足清理指标。

## 停止条件

- 候选、基线、目标或远端事实变化时，刷新相关证据再操作。
- 用户 dirty 文件、未集成提交、其他会话工作或授权不清时，不 reset/clean/force 或迁移所有权。
- 隔离能力不可达时说明实际保证并停止依赖该保证的派发，不声称主工作树等同受管隔离。
- 集成或清理失败，保留原状态和可恢复引用；不靠目录消失或命令退出证明交付。

## 关掉必须消失

Git/PR/资源专项指引不再注入；定义的交付层级和已有 worktree 管理门不消失，也不要求无关任务新增 Git 仪式。

## 不得带走

任务拆分/调度；批准；实际角色动作策略；Kernel Review/Close；Task 证据的保留/归档。
