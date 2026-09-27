# `define-extended`

P29 表名：`define-extended`（不得改名）。层：on-demand。

## 职责

Define 阶段的加深，不是第二条生命周期。含：PRD Grill、多源研究协调、**条件** Design、按仓库事实第一次建立项目 Spec。Task **之前**只澄清到「有没有工作」——那是 `intake-basic`。本块只在 Open 之后、还在 Define 时出现。Design 角色仅当 Risk/Policy 或 `verification_profile: architecture` 要求时才成为必产出；不给每个 Full 空造 `design.md`。

## 触发/披露

未触发当没装。触发：Phase=Define 且（Rigor=Full 或硬 Risk 或用户明确要深挖/研究/设计）。Lite 成功路径可以全程不见 Grill、不见 Design。外部事实走 Middleware（smart-search）；本块协调「要不要研、研完写哪」，不实现搜索引擎。

离开 Define 或未触发则从包中消失。

Agent 看见：

1. Grill 纪律：只问产品意图/偏好/风险；仓库事实自己取。
2. 不得把 Grill 做成每回合仪式，也不得恢复 `[Triage:]`。
3. 无 Design 要求时，不写空 `design.md` 来「凑 Full」。
4. spec-bootstrap 只在项目确实还没有、且需要编码规范时，依据仓库事实建；安装不预置空 spec 骨架。
5. Adapter 可把深 Define 绑定到宿主提供的计划界面；界面说明不在本块。

用户看见：需要深挖时才出现 Grill/设计讨论。Lite 写完 PRD+AC 就可以去请 Execute，不必经过本块。

## 停止条件

- 触发条件见上。
- 产出：Grill 结论写回 Definition；条件 Design；可选 research 产物；条件 spec 骨架。
- 停止：Task 前用本块代替 intake 澄清；Lite 强制 Design；把 smart-search 实现收进本块。

## 关掉必须消失

无 Grill 全文、无条件 Design、无深研协调、无 bootstrap spec。`define-basic` 的 PRD/AC 仍足够 Lite Close 路径。

## 不得带走

AC 最低面（`define-basic`）；Execute 门（`approval-personal`）；检索 pack（`retrieval-extended`）。

## Grill 备忘

Grill 机制备忘只写在本块内。不恢复独立 skill 名作 slash，没有两个 slash、没有两个 subagent。

- **`grill-me`**：来自 Pactile/Herbivore 的无状态面试 skill。输入是用户访谈，用来逼问 PRD。Claude 路径曾是强制 gate（没 grill 完不准 design/implement）。Pactile **没有**把这个 skill装进默认包，也 **不**复制那道阻塞 gate。Matt 同名 skill 被标为「已被 `pactile-micro-grill` 覆盖」（KB `01`）。引擎（frontier 轮次）经 P03 进了 brainstorm / micro-grill 的提问节奏，**不是**独立 `grill-me` 包装。
- **`grill-with-docs`**：工作区从未找到正式 skill。2026-06-16 锁定的是其**精神**：以 `prd.md` 为唯一文档面做检查 pass（目标、事实 vs 假设、可测 AC、非目标、依赖、平台…），仓库能查的不问用户。落地在 bundled `brainstorm` 的 Phase B，可加载摘要是 `.pactile/framework/prd-grill-frontier.md`。
- **现在怎么存在**：Task 前澄清 = `intake-basic`（旧称 micro-grill 策略，不是 Task 类型）。Open 之后的 PRD Grill = `define-extended` 内的文档检查 pass + 仅 blocking 项再用 micro-grill 契约追问。提问节奏：PRD Grill 用 frontier（一轮 ≤3）；单独 micro-grill 仍可一次一问（`prd-grill-frontier.md` 的 override 说明）。完成标准：清单满足或显式 N/A、无 blocking open questions、AC 可测——然后才是 Execute 门，不是「grill-me subagent 打勾」。
