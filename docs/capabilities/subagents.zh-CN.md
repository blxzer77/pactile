# Subagent 与 worktree

[English](subagents.md) | 简体中文

Pactile Task 可以交给独立 Agent 会话。Parent 拥有集成权，Kernel 拥有持久状态转换权。已批准的 Execute 任务可通过 Pi Agent 原生 RPC 执行；Codex 桌面任务协作使用 App 原生工具与 Pactile Node 请求/回执记录。

## Pi Agent 桥接

单独安装并配置 `pi`，包括 Provider 和模型。Pactile 不依赖 Python 运行时，也不经过 ACP 中介。用户批准并记录 `pactile task start-execution <task> --approved` 后，准备有限范围的提示文件，再派给 Pi：

```text
pactile pi run <task> --role implement --prompt-file worker-prompt.md
pactile pi status <task>
pactile pi cancel <task>
```

implement 工人要求已批准的 `implement.md` 写明 `execution_mode: worker`。check 与 research 角色只开放 Pi 只读工具。重复传入 `--prompt-file` 可以在同一 Pi 进程里顺序执行，后续 CLI 调用可用 `--resume` 恢复记录的 Pi 会话。桥接在任务 `pi-bridge/` 下记录会话身份、事件摘要、最终文本、失败结局和冷/热启动耗时。它不会把 Kernel 阶段改成 Close；`settled` 只表示 Pi 正常停下，验收与验证仍需单独完成。

## Parent 有边界并行

在 Parent 的 `task-map.md` 为每个 Child 填写具体、相对项目根目录的 `touches`。硬依赖必须已 `integrated`，取消不算满足。可选 `parallel_limit` 默认为 2，允许 1–4；`merge_limit` 保持 1。每个 Child 自己的 Execute 合同都须经用户批准，且 `execution_mode: worker`。

本地批次清单示例：

```json
{
  "schema_version": 1,
  "limit": 2,
  "children": [
    { "task": "child-a", "prompt_file": "prompts/a.md", "review_cost": "low" },
    { "task": "child-b", "prompt_file": "prompts/b.md", "review_cost": "medium" }
  ]
}
```

```text
pactile parallel run <parent> --manifest parallel.json
pactile parallel status <parent>
```

批次只同时运行写集互不重叠的 Child，且不超过 Parent 上限。写集重叠、未声明或审核成本为 `high` 的 Child 串行；任何硬依赖未满足则整批在启动 Pi 前被拦下。若 Child 合同指定 `git-worktree`，先用 `pactile task prepare-child-worktree` 准备工作树；Pi 会以该 checkout 为真正的 cwd，缺失或无效时拒绝派发。直接 `pactile pi run` 与 Codex Execute 请求也共用 Parent 的冲突和并发槽。批次记录端到端耗时、排队等待、Pi 结局与事件数；`status` 汇总当前集成状态及已记录的返工事件。Parent 审查真实 diff 与 Child 证据后逐个执行 `integrate-child`。`touches` 是声明与派发门，审查仍需查出越界修改。

## 安全派发

1. 选择或创建带有限写集的 Task。
2. 向 child 提供 PRD、design、实现契约与 Evidence 要求。
3. Child 只能报告 `working`、`review` 或 `blocked`，不能自行声明 Parent 集成。
4. 需要独立性时，在新鲜上下文中审查 change set 与 Evidence。
5. Parent 一次只集成一个已审阅 ref，并记录决定。

不要要求 child task 提交、发布、修改远程或扩大写集，除非显式变更 Task 契约。
