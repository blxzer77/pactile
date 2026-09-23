# `parent-child`

P29 表名：`parent-child`（不得改名）。层：on-demand。

## 职责

拓扑模块。把「一件事拆成可独立验收的多交付物」变成单父树，并提供 **Integrate** 槽的行为（Kernel 仍写 Phase/依赖图；本块提供 Decompose、边界、集成权威与 `integration-handoff`）。Parent 握总需求、Child 边界、集成权、最终 Evidence；默认不直接写功能代码。Child 是独立 Task：自己的生命周期、自己的 Rigor。Decompose **只出提案**，用户确认后才建 Child。依赖图投影为 `task-map`（人读）；依赖管 readiness，不调度、不表达所有权。

## 触发/披露

未触发当没装。Single 的 Open→Close 全程不见本块、不见 Integrate 阶段名。触发（可审计）：

1. Open Proposal 的 Topology 已批为 parent-child；或
2. 已选中任务出现 ≥2 个可独立演示的交付物，建议拆分；或
3. 用户明确要求拆 Parent/Child。

**不是**触发：Rigor=Full；文件多、耗时长。个人默认只暴露 **一层**（Parent + 其 Child）；Kernel 允许更深嵌套，本 Profile 短契约不教孙任务 Decompose。

非 Parent/非拆分窗口不进包。Child 会话只带该 Child 合同 + 与 Parent 的边界，不灌整棵树教战。

Agent 看见：

1. Decompose 产出：纵向切片边界、依赖、每 Child 的 Acceptance、冲突面、集成点。未获人确认不得 `create --parent` / 挂 Child。
2. Child 不得 `integrate-child`，不得把自己标成 accepted / integrating / integrated / cancelled。Child 交付 = Verify 完成 + `integration-handoff`。只有 Parent 做 Integrate。
3. Parent 未把每个结构性 Child 标成 integrated 或 cancelled，不得 Close（`close-basic` 已遵守此因果）。
4. Parent 与 Child 各自 Lite/Full；Parent 常建议 Full，但不与 Full 绑定。拓扑叠加的是 task-map、Child Evidence、Integration Gate，不是自动 Independent Check。
5. 并行声明（可并行组 / 合并点 / 冲突面）写在 task-map；HITL、Execute 门、Check、`integrate-child` 仍串行。默认 `merge_limit: 1`。串行执行须写 `serial_reason`。真正 spawn 工人仅当 `worker-orchestration` 同时激活；否则 Child 走 inline 或顺序会话。
6. 跨树关系走 Kernel 依赖图（`requires` 硬前置 / advisory 提示）。默认 advisory；硬挡是 Policy/opt-in，不是本块调度器。

用户看见：只有多交付物或主动要拆时才出现 Parent/Child 与 Integrate。Lite Single 看起来仍是一条直线。没有「拆了才算 Full」。

## 停止条件

- 触发与非触发；个人默认一层。
- Decompose 提案形状；建 Child 必须先确认。Decompose 先提案，未确认不得建 Child。
- 权威：Parent 独有 Integrate；Child 独有自身 Verify + handoff。
- 停止：未激活仍讲 task-map / integrate-child；Child 自集成；把依赖当调度器；把 Parent 当 Full 的同义词；未确认就建 Child。

## 关掉必须消失

无 Decompose、无建 Child、无 task-map 教战、无 Integrate 阶段叙事、无集成权。Intake 仍可在 Open Proposal 里**建议** Topology=parent-child，但无处落地。Full Single 仍合法。

## 不得带走

Kernel 的 `topology` / `parent_id` / 合法 Integrate 边（Kernel 单写）；工人派工（`worker-orchestration`）；Git worktree 命令细节（`vcs-integration`，本块只要求 Child 可隔离交付）；跨窗 `/pactile-handoff`（`session-transfer`）。
