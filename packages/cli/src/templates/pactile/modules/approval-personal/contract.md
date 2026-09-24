# `approval-personal`

P29 表名：`approval-personal`（不得改名）。层：baseline。

## 职责

Human Attention 的三道人门，不是 Kernel 状态机本身。Kernel 校验「能不能转」；本块决定「人有没有点头」。

1. **Open**：同意建立 Task 并批准 Rigor×Topology。不授权改代码、不授权 Execute。
2. **Execute**：Define 完成后，同意进入实现。`--check` 只是 CLI 预检（指纹/槽位/契约在不在），**不得**写成「已评审通过」。
3. **Finalize**：需要人类权威时合并询问——Git commit、远程推送、最终业务验收等。可与 Close 收尾并成一次，不拆成逐步确认。

## 触发/披露

不到门不进 Prompt、不进用户视野。Define 进行中不反复问「是否同意」。无硬 Risk 的 Lite：Open 之后可在用户**预先启用** Auto-Approve 时不再问 Execute；仍必须写审计，不是跳过 Approve 里程碑。Full / Parent / 硬 Risk：默认 Open + Execute；Finalize 在有人类权威动作时出现。异常才打断：范围或契约变、Policy 豁免、Secret、不可逆或远程副作用、平台底线不满足、真实 blocker、新高风险权限。

Agent 看见：

1. 未过 Open：不得 `pactile task create`（Intake 只出 Proposal）。
2. 未过 Execute：不得把 Phase 推进到 Execute、不得 `--approved`、不得开始改产品代码。
3. 预检 PASS 只可用来**请求** Execute 门，不可宣称已批准。
4. 日常「ok / 开始 / 确认」若不是在回答明确的门，不得当成 Execute 授权。
5. Return-to-Define 之后，旧 Execute 批准失效，必须再过门。

用户看见：很少的关键问句。Lite 常常只有一次 Open。Full 通常 Open + Execute。有 commit/远程时再并一次 Finalize。不是每个 Phase 点一次。

渐进：过门后从常驻包拿掉本块教战，只留「本任务已过哪些门」。

## 停止条件

- 三门各自授权什么、不授权什么（见职责）。
- `--check` ≠ 人批；人批必须可审计（谁、何时、哪一扇门）。
- Auto-Approve 边界：仅预启用 + 无硬 Risk + Policy 允许；仍留痕迹。
- 升级打断清单与上列异常一致；同一 frontier 可批量问，避免一题一轮。
- 不得把预检 PASS 写成已批准；不得把日常确认当成 Execute 授权。

## 关掉必须消失

没有人点头路径。不得静默 create / `--approved` / 把 commit 当已 Finalize。Kernel 仍可拒绝非法转换，但不能冒充人已批。

## 不得带走

契约正文与 AC（`define-basic`）；指纹算法与合法边（Kernel）；是否真的 git commit（`vcs-integration`）；物理归档（`retention-storage`）。
