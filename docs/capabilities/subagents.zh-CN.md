# Subagent 与 worktree

[English](subagents.md) | 简体中文

Pactile Task 可以交给独立 Agent 会话。Parent 拥有集成权，Kernel 拥有持久状态转换权。Codex 桌面任务协作和 Pi Agent 桥接属于后续工作项；当前版本尚未提供该桥接。

## 安全派发

1. 选择或创建带有限写集的 Task。
2. 向 child 提供 PRD、design、实现契约与 Evidence 要求。
3. Child 只能报告 `working`、`review` 或 `blocked`，不能自行声明 Parent 集成。
4. 需要独立性时，在新鲜上下文中审查 change set 与 Evidence。
5. Parent 一次只集成一个已审阅 ref，并记录决定。

不要要求 child task 提交、发布、修改远程或扩大写集，除非显式变更 Task 契约。
