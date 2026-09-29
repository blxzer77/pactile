# `verify-basic`

P29 表名：`verify-basic`（不得改名）。层：baseline。

## 职责

检查已完成的 V2 Run，并针对该 Run 的准确候选快照 ID 和 fingerprint 记录独立 Review。每条已记录 AC 都要映射到可定位证据。Run 结果或面向人的 `verify.md` 本身不能满足 Kernel Review 门。

每条 Review 都是绑定到一个候选的追加式判定。某候选的最新 Review 若为 `fail` 或 `needs-changes`，该候选不能 Close。之后可以重新检查同一候选并追加 Review；若实现已变化，必须新建 Run，并针对新候选重新 Review。Close 必须引用该候选的最新 Review。

## 触发/披露

按 `.pactile/framework/reuse-first-guide.md` 审核复用或自研选择是否满足需求、证据和维护成本目标，并检查实际接入边界。依赖数量、搜索记录或用了第三方库均不能单独作为通过标准。合理自研与明确披露的研究边界可成立；没有新风险时不重复核对仍适用的研究。

Run 完成并产生候选快照后加载。按已记录的交付物和 AC 检查候选。Reviewer 必须与 Run 执行者和授权者都不同。为 Review 记录证据引用，并为每条 AC 记录证据。

验证选择见 [风险驱动验证](../../framework/verification-strength-guide.md)：满足 AC 和仓库必需 gate，优先覆盖受影响的公开行为和真实失败风险；无新风险不重复全量回归。`pactile task verify-plan` 只产出候选绑定的规划收据，不运行测试、记录 Review 或 Close。

独立审核保持候选及业务状态只读；必要报告/临时产物须有明确写入范围。能力可用不等于所有动作获准，提示词不能证明执行保护。当前 Pi 默认 RPC 无职责动作拦截或 OS 沙箱；需要该保护却不可达时，不派发危险动作或冒认受保护 Review。

## 停止条件

- 候选 ID 和 fingerprint 必须与选中的已完成 Run 完全一致。
- 缺少 AC 证据、有未解决 blocker，或最新 Review 未通过，均表示验证未完成。
- 同一候选的后续 Review 会取代更早判定；先前的 pass 不能绕过后续的 fail 或 needs-changes。
- 候选变化时，不得把旧候选的 Review 用作新结果证据。
- 不在验证中扩展交付物或改写 AC。契约有误时回到获授权的定义更新路径。

## 关掉必须消失

Review 和证据始终绑定其检查过的候选。不得依据未绑定的笔记或自我 Review 宣称可 Close。

## 不得带走

实现修改（`execute-agent`）；定义修改（`define-basic`）；交付层级证据和 Close（`close-basic`）；由其他模块激活的可选专项检查。
