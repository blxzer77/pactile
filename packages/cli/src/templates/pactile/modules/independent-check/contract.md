# `independent-check`

P29 表名：`independent-check`（不得改名）。层：on-demand。

## 职责

只读的独立语义第二遍。在 `verify-basic` 的 Evidence 之上，对 Full / 硬 Risk / Policy 要求再做一次「不是同一双手」的检查。默认只出 findings/verdict，**不改代码**。实现缺陷回 Execute；任何代码修改使旧 verdict 失效，必须重跑。assurance 必须诚实：`self-review`（同一 Agent 结构化第二遍）vs `true-independent`（独立 Worker 或人）。Policy 要 true-independent 而平台没有独立 Worker → 阻塞，不得假绿。

## 触发/披露

Lite 当没装。Rigor=Full，或 Policy/硬 Risk 要求时激活。未激活则 Prompt 无 Check Agent 教战，也不得把 `verify-basic` 的自查写成 independent。非 Full/非触发不进包。

Agent 看见：

1. 只读。发现实现问题 → 回 Execute，再 Verify，再 Check。
2. 发现契约问题 → Return-to-Define，不是在 Check 里改 PRD 充数。
3. 无可靠独立 Worker 时标签必须是 `self-review`。
4. spawn `pactile-check` 仅当 `worker-orchestration` 同时激活且合同要求 worker；否则主会话做结构化第二遍并标 self-review。
5. Full / Parent：缺 `touches`、或 `touches` 明显跨无关模块且无 `serial_reason` / `oversized_accepted` → 不合格。Lite 缺 `touches` 不因此不合格。这是 Check 的判定，不是 `task.py create` 或 `start-execution --check` 的硬挡。

用户看见：Full 收工前多一次「是否独立查过」的诚实标签。Lite 不出现本块。

## 停止条件

- 触发：Full 或 Policy。
- 输出：verdict + findings；assurance 字段。
- 停止：在 Check 中改代码还声称同一 verdict；Lite 强制本块；无 Worker 却写 true-independent。

## 关掉必须消失

不得声称 independent。Lite 与 `verify-basic` 不受影响。Full 若 Policy 要求 true-independent 则无法 Close（诚实阻塞）。

## 不得带走

AC→Evidence 最低面（`verify-basic`）；派工通道本身（`worker-orchestration`）；Execute 改代码（`execute-agent`）。
