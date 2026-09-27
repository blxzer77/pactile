# `intake-basic`

P29 表名：`intake-basic`（不得改名）。层：baseline。

## 职责

在尚未选择 Task 时处理新请求：直接回答、澄清是否存在工作，或提出一个可交付 Task 的建议。Proposal 不是 Task，也不授权执行。

新建 V2 Task 的建议应识别：

- 具体交付物（deliverable）；
- 可观察、可验证的验收标准（AC）；
- 交付层级：`local-result`、`pull-request`、`merged-result` 或 `documentation`；
- 已知硬依赖对应的 Task ID。

只有当每份交付物都能独立验证和 Close 时，才建议拆成多个 Task。只有前置 Task 必须成功 Close 后，后续 Task 才能开始时，才记录硬依赖。不要让用户选择 rigor 或 topology 预设。

## 触发/披露

无选中 Task、有冲突的新请求，或用户明确要求另开 Task 时触发。选中 Task 内的普通跟进不重跑 Intake。

Agent 看见入口判断和精简 Proposal。用户看见是否可直接回答、是否需要建 Task，以及 Proposal 的交付物、AC、交付层级、依赖和理由。

## 停止条件

- 输出为直接回答、关于是否有工作的澄清，或 V2 Task Proposal。
- 用户明确同意 Proposal 后才能创建 Task。
- Intake 不写实现代码，不把未经确认的关系写成硬依赖。
- 统一 reader 明确报告选中的是 V1 legacy Task 时，沿用该 Task 的兼容路径；不要在 Intake 中擅自转换或解释成 V2。

## 关掉必须消失

已解决请求或已交给选中 Task 后，不继续输出 Intake 教战；普通会话工作不应默认被包装成 Task。

## 不得带走

Task 定义和 AC（`define-basic`）；人类授权（`approval-personal`）；执行（`execute-agent`）；证据和 Review（`verify-basic`）；Close（`close-basic`）。
