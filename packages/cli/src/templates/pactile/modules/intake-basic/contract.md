# `intake-basic`

P29 表名：`intake-basic`（不得改名）。层：baseline。

## 职责

事件式入口。在无选中任务、或新请求可能产生工作时，判断：直接回答（无 Task）/ 澄清 / 建议开 Task，并带上建议的 Rigor（Lite|Full）与 Topology（single|parent-child）。建议 Topology 时必须带「有无可隔离单位」（写集 / 交付物能否切开）。产出 Open Proposal 形状，不创建 Task。无 `[Triage:]` 行。任务内跟进不重跑 Intake（除非显式切换/退出/新独立交付物/契约冲突）。

## 触发/披露

Baseline 装着，但只在 Intake 事件进入 Prompt。有 `selected_task` 且无冲突时，本块不进包。

触发：无选中任务 | 新请求与当前 Task 冲突 | 用户显式要新 Task。

Agent 看见：入口判断规则、Risk 初判标签（可解释，非黑箱分）、禁止未同意就 `pactile task create` 的提醒（门本身在 approval）。建议 Topology 时先问/判「有无可隔离单位」：能指出 ≥2 个可隔离写集 → 倾向多个可 Close 的 Full 或 Full 扇出，**不默认 Parent**；要统一集成权威才建议 parent-child；指不出 → 倾向 single，并预期真·单写集要写 `serial_reason`。开过大 Task（关不了 / 证不了 / `touches` 跨无关模块）必须建议拆成更小的 Task；用户可坚持，但要写范围风险 / `serial_reason`。会话内已可直接做的小改仍不必开 Task。看不见五档梯子印、看不见 Parent 集成教战。

用户看见：闲聊被直接回答；要开 Task 时看到形状建议（Lite/Full × single/parent-child）以及有无可隔离单位，被问是否 Open。

派生摘要可内用，不得要求每回合打印 `[Triage:]`。

## 停止条件

- 输入：Intake 事件（无选中任务 / 冲突 / 显式要新 Task）。
- 出口：无 Task（直接答）/ 澄清（Task 前，只澄清到「有没有工作」）/ Open Proposal（Rigor×Topology + 有无可隔离单位 + 理由）。
- 不得写 `prd.md`、不得 archive、不得改代码。
- 不得未同意就 `pactile task create`。

## 关掉必须消失

开 Task 判断、形状建议。Kernel 仍在，但没有入口模块。

## 不得带走

Open/Execute 人批（`approval-personal`）；Grill/Design（`define-basic` / `define-extended`）；Decompose 建 Child（`parent-child`，Intake 只可建议 Topology=parent-child）。
