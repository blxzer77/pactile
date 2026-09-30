# `define-extended`

P29 表名：`define-extended`（不得改名）。层：on-demand。

## 职责

针对尚未解决的产品选择、复杂依赖、风险边界或竞争方案深研，产出足以实施和独立验收的设计。Task 不预设 Lite/Full/Parent/Child 强度；没有改变结果的疑问就不展开仪式化规划。

## 触发/披露

当前 Kernel 定义/AC 不足以决定下一步，或公开接口、数据安全、跨模块依赖确需设计时按需读取。先查现有源码与适用研究，再向用户询问意图、取舍、授权或风险容忍度。使用 [规划与问题前沿](../../framework/prd-grill-frontier.md) 和 [复用优先](../../framework/reuse-first-guide.md)。

输入：当前 Task 定义、已证实事实、约束、尚未裁决的问题。输出：阻塞决策、最小充分设计与 Decision/Rationale/Risk；Markdown 为 Agent 提供结构化索引，为人提供清楚说明，不改变 Kernel 状态。

独立验收的交付结果可以拆成多个 Task，通过硬依赖表达顺序；规划提案不是创建任务或开始 Run 的授权。需要改变已执行合同且无支持的更新路径时，停止并协调新 Task/Run，不能擅改 Kernel 或伪造 Return-to-Define。

## 停止条件

- 可从仓库回答的事实不交给用户确认；独立问题一轮最多三项，有前置决策的问题等前置解决。
- 存在会改变 AC、范围或权限的阻塞决策时，不执行依赖该决定的工作。
- AC 能区分互相冲突的结果，继续提问不再改变交付或风险时，结束深研。
- 不按文件数量、问题数量或任务标签制造额外批准门；适用的原授权可复用。

## 关掉必须消失

深研、可选 Grill 和方案比较不再注入；基础 Task 定义、AC、批准、依赖与 Review 门仍成立。

## 不得带走

Kernel 定义和生命周期；执行授权；检索 Provider/质量层；风险驱动验证；独立 Review 和 Close。

## Grill 备忘

`grill-me` / `grill-with-docs` 是历史机制名称，只保留检查文档表面、按问题前置推进的思路；不恢复独立 skill 名作 slash，也不要求新建 Subagent。实际入口为本模块和上面的规划指南。
