# Tiles

[English](tiles.md) | 简体中文

## 定义

Tile 是一个小型、有版本的能力契约，由模型或用户针对当前任务选择和组合。它声明能力所需条件与允许边界，不规定私有推理，也不嵌入宿主特定脚本。

## 职责

Tile 声明：

- 稳定 identity 与 semantic version；
- trigger 与支持的 intent；
- 逻辑输入、输出、依赖与冲突；
- filesystem、process、network、credential、privacy、telemetry、destination 与 cost 上限；
- 最低 assurance 与必需 Evidence 类型；
- 有界 fallback policy、停止条件与 attempt limit。

Compiler 在执行前检查依赖、冲突、策略上限、确定性顺序和 fallback 边界。模型仍负责选择有用的 Tiles 并理解任务；Kernel 不是中央规划器。

## 边界

Tile 不包含 steps DSL、tool/MCP server 名、Cursor/Codex 路径、prompt 记录、任意 URL、credential value 或私有 chain of thought。`structural`、`external` 等 intent 稍后通过 Middleware 解析。MCP 是一种可能的 Provider 集成，不是 Tile。

Fallback 不能扩大 permission、destination、egress、credential、telemetry、cost 或 assurance policy。禁止网络的 Tile 也不能通过 fallback 偷渡远程行为。

## 用户场景

一次仓库调查需要精确 symbol 搜索和结构依赖视图。模型选择两个输出兼容的 Tiles；Compiler 为它们排序，确认都不请求网络，并记录选择。如果 structural Provider 不可用，只有当本地 exact search fallback 不越过原策略上限且仍满足最低 assurance 时才能使用；否则应返回 degraded 和明确用户动作。

## 选择流程

Bundled registry 将 Tile 明确分为**基础 Tile**与**按需 Tile**。两类 Tile 都进入选择服务，但每次只针对一个请求作选择。分类和生命周期属于 registry 元数据，不改变冻结的 v1 Tile manifest。纯选择 API 要求每个 catalog ref 都有一条生命周期事实。基础 Tile 必须为 `active`；按需 Tile 可以为 `active` 或 `registered`。`deprecated`、`disabled`、`retired` 与 `degraded` Tile 会在构造 Agent 候选集前过滤。

当前选中的真实 Task 通过 `prepareSelectedTaskBatch2TileSelection(root, request)` 读取 Kernel phase、condition、outcome、revision 和可用的激活事实。Legacy Kernel 缺少或包含未知模块生命周期事实时会 fail closed。Task Kernel v2 尚未存储 Tile 激活状态，因此当前将 bundled 基础 Tile 视为 active、按需 Tile 视为 registered。`decideSelectedTaskBatch2TileSelection` 会再次读取；如果 Task 快照已变化，旧 offer 会被标记为 stale。

已批准且运行中的 Task Run scope 可以携带版本化 Tile grant：`pactile-tile-selection/v1:` 加规范化 JSON，字段为 `schemaVersion`、`policyCeiling`、`capabilities` 和 `providerFacts`。grant 是权限上限；调用方 request 会与它取交集，因此调用方更严格的限制会保留，调用方不能扩大权限。没有有效记录的 grant 时，Task API 使用只读、本地、低成本上限，不带 capability 或 Provider。Kernel approval scope 是调用方声明的证据；选择回执会记录这种 assurance，但不会声称身份已验证。

真实 Agent 宿主入口是 `pactile context --mode session --json`。存在选中 Task 时，它会调用当前 Task prepare API，只返回通过 Compiler 校验的 `tileSelection.offer`，不会把 `plan.audit` 或已过滤 Tile 的详情发送给 Agent。也可以直接用安全默认配置请求候选，然后按 offer fingerprint 决策：

```sh
pactile tile-selection prepare --intent structural --output task.design
pactile tile-selection decide --offer-fingerprint <offer-fingerprint> --kind adopt --intent structural --output task.design
pactile tile-selection replay --snapshot-fingerprint <snapshot-fingerprint>
```

`decide` 会把有界、只写一次的快照保存在 `.pactile/runtime/receipts/`。快照包含规范化 request、哈希后的项目/Task 身份、Kernel facts、不可变 bundled manifest 和 Skill 内容、Compiler ABI、原始决策及回执；不包含本机路径或 `plan.audit`。Provider evidence reference 在保存前会哈希。历史 replay 只读取该快照，重算并返回原候选 offer 与回执，不依赖可变的当前 Task 状态。选择决策不会激活 Tile、启动 Kernel Run 或授权执行；这些 gate 彼此独立。

已有 lifecycle facts 的调用方可以用 `loadBatch2TileSelectionSurface(lifecycleByRef)` 加载已校验的 bundled catalog 与显式事实，再调用纯接口 `prepareBatch2TileSelection(request, lifecycleByRef)`。候选构造随后会：

1. 检查 intent 和调用方 channel；
2. 展开依赖，并按各自层级的生命周期规则检查依赖闭包；
3. 按任务权限上限过滤请求权限过宽的 Tile；
4. 拒绝依赖闭包冲突或无法通过 Tile Compiler 校验的 Tile；
5. 在 `offer.candidates` 中仅返回符合条件的摘要，并生成确定性的目标输出覆盖建议。

独立的 `plan.audit` 只包含有界的符号过滤代码，用于检查具体候选为什么未出现；不要把它作为模型的候选列表传递。处于 `blocked` 或 `waiting` condition、或已有终态 outcome 的 Task，不会产生 Agent 可见候选。

纯 bundled API 显式接收 lifecycle facts：`decideBatch2TileSelection(request, decision, lifecycleByRef)`；当前 Task API 会自行读取事实：`decideSelectedTaskBatch2TileSelection(root, request, decision)`。`adopt` 采用完整建议；`override` 可选择其他符合条件的组合，两者都会再次调用 Compiler。不完整覆盖目标输出的 override 会记为 `mis-selection`；非法、已过滤或被 Compiler 拒绝的选择会留下相应结果。`no-match` 可以保留先前尝试，从而同时回执误选和后续改正。确定性决策回执包含所选与展开后的 refs、输出覆盖、诊断、Compiler fingerprint 和回执自身 fingerprint。`replayBatch2TileSelectionDecision(request, decision, lifecycleByRef)` 会从相同的当前输入重算回执；`replayStoredSelectedTaskBatch2TileSelectionDecision(root, fingerprint)` 会验证已持久化的历史决策。

```ts
import {
  decideSelectedTaskBatch2TileSelection,
  prepareSelectedTaskBatch2TileSelection,
  taskTileSelectionRequest,
} from "@blxzer/pactile";

const request = taskTileSelectionRequest("define");
const plan = prepareSelectedTaskBatch2TileSelection(projectRoot, request);
if (plan.success) {
  const result = decideSelectedTaskBatch2TileSelection(projectRoot, request, {
    kind: "adopt",
    offerFingerprint: plan.data.offer.fingerprint,
  });
  if (result.success) console.log(result.data, result.snapshot);
}
```

建议只对可能覆盖目标输出的 Tile 进行排序，不授权执行，也不写任务状态。持久化任务迁移仍由 Kernel 把关，Tile 组合仍由 Tile Compiler 校验。

## 应检查什么

- Tile manifest 表示请求的最大权限。
- Provider 解析结果表示实际 origin、assurance、readiness 与 Evidence。
- Trace 表示 Tile 被 selected、invoked、skipped、failed 还是 completed。
- Policy denial 是合法结果，不能成为静默调用更宽权限工具的理由。

继续阅读 [Kernel、Evidence 与 Trace](kernel-evidence-trace.zh-CN.md)和[能力](../capabilities/index.zh-CN.md)。
