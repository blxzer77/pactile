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

## 关键路径调度的 Parent 派发

在 Parent 的 `task-map.md` 为每个 Child 填写具体、相对项目根目录的 `touches`。V2 Task 硬依赖与 Run 状态通过公开 Task Kernel API 读取；旧 `depends_on` 和 Child 生命周期仅作只读兼容输入。未 Close 或失败的硬依赖会阻止派发。`merge_limit` 保持 1。每个 Child 自己的 Execute 合同都须经用户批准，且 `execution_mode: worker`。

本地批次清单示例：

```json
{
  "schema_version": 1,
  "children": [
    { "task": "child-a", "prompt_file": "prompts/a.md", "review_cost": "low",
      "estimated_costs": { "executionMs": 180000, "integrationMs": 30000, "reviewMs": 20000 } },
    { "task": "child-b", "prompt_file": "prompts/b.md", "review_cost": "medium",
      "estimated_costs": { "executionMs": 120000, "reviewMs": 45000 } }
  ]
}
```

```text
pactile parallel run <parent> --manifest parallel.json
pactile parallel status <parent>
```

批次按确定性的关键路径波次执行，并在 Parent Task 下持久化内容寻址调度回执。没有固定并发数上限，也没有 manifest 子任务数量上限。调度器要求模型预测能缩短完成时间，才会把兼容任务编入同一波次；审核成本影响顺序和权重，但不会单独禁止并行。

V2 Run 写集快照与 workspace 写集会和 Child `touches` 合并；未知写集与任何写者冲突。重叠写入默认错开。显式并行冲突必须在 manifest 中记录精确 Child 对、授权人、授权证据引用和非空集成计划；调度回执与活跃租约会保留这些记录。

旧 `task-map` 的 `parallel_limit` 与 manifest 的 `limit` 字段保留只读兼容，但不会限制当前派发路径。已有含 `concurrency_limit` 的批次结果仍可读取为历史；新结果记录实际 `max_active` 与调度回执引用。若 Child 合同指定 `git-worktree`，先用 `pactile task prepare-child-worktree` 准备工作树；Pi 会以该 checkout 为真正的 cwd，缺失或无效时拒绝派发。直接 `pactile pi run` 与 Codex Execute 请求没有数量上限，但 Task 与写冲突门仍生效，除非同一份已验证调度回执授权，否则活跃写冲突会被拒绝。批次记录排队等待、Pi 结局、成本来源、调度波次和决策证据；`status` 汇总当前集成状态及已记录的返工事件。Parent 审查真实 diff 与 Child 证据后逐个执行 `integrate-child`。`touches` 是声明与派发门，审查仍需查出越界修改。

## 安全派发

1. 选择或创建带有限写集的 Task。
2. 向 child 提供 PRD、design、实现契约与 Evidence 要求。
3. Child 只能报告 `working`、`review` 或 `blocked`，不能自行声明 Parent 集成。
4. 需要独立性时，在新鲜上下文中审查 change set 与 Evidence。
5. Parent 一次只集成一个已审阅 ref，并记录决定。

不要要求 child task 提交、发布、修改远程或扩大写集，除非显式变更 Task 契约。
