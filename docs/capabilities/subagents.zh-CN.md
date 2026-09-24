# Subagent 与 worktree

[English](subagents.md) | 简体中文

Pactile Task 可以交给独立 Agent 会话。Parent 拥有集成权，Kernel 拥有持久状态转换权。已批准的 Execute 任务可通过 Pi Agent 原生 RPC 执行；Codex 桌面任务协作是后续工作项。

## Pi Agent 桥接

单独安装并配置 `pi`，包括 Provider 和模型。Pactile 不依赖 Python 运行时，也不经过 ACP 中介。用户批准并记录 `pactile task start-execution <task> --approved` 后，准备有限范围的提示文件，再派给 Pi：

```text
pactile pi run <task> --role implement --prompt-file worker-prompt.md
pactile pi status <task>
pactile pi cancel <task>
```

implement 工人要求已批准的 `implement.md` 写明 `execution_mode: worker`。check 与 research 角色只开放 Pi 只读工具。重复传入 `--prompt-file` 可以在同一 Pi 进程里顺序执行，后续 CLI 调用可用 `--resume` 恢复记录的 Pi 会话。桥接在任务 `pi-bridge/` 下记录会话身份、事件摘要、最终文本、失败结局和冷/热启动耗时。它不会把 Kernel 阶段改成 Close；`settled` 只表示 Pi 正常停下，验收与验证仍需单独完成。

## 安全派发

1. 选择或创建带有限写集的 Task。
2. 向 child 提供 PRD、design、实现契约与 Evidence 要求。
3. Child 只能报告 `working`、`review` 或 `blocked`，不能自行声明 Parent 集成。
4. 需要独立性时，在新鲜上下文中审查 change set 与 Evidence。
5. Parent 一次只集成一个已审阅 ref，并记录决定。

不要要求 child task 提交、发布、修改远程或扩大写集，除非显式变更 Task 契约。
