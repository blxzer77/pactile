# Task system

[English](task-system.md) | 简体中文

Pactile task 把需要跨越对话的工作变成 `.pactile/tasks/` 下持久、可审阅的项目状态。Artifacts 说明需求与 Evidence；Kernel records 拥有阶段转换与 audit chain。

## 定义

Task 是一组可读 artifacts 与一份 canonical machine record。对话被压缩或交接后，artifacts 仍可继续使用；Kernel 则防止 Agent 或宿主集成绕过 approval、review 或 close 要求。

## 职责

- 保存 definition、design、execution contract 与 verification Evidence；
- 通过 `task.json` 记录 status 与 metadata accounting projection；
- 通过 Kernel 校验 phase transition、gate、revision 与 idempotency；
- 支持 lightweight、full-quality 与 Parent/Child integration topology；
- 把完成工作归档，同时保留 final acceptance 与 audit trail。

## 边界

Task 不是聊天记录，不代替项目 specs；目录已经存在也不代表获准执行。创建或定义任务不会批准 implementation。选择 task 只改变会话焦点，不改变 canonical phase。`workflow.md` 是人类 interface card；Kernel record 与已接受 artifacts 才是权威。

## 持久集成面

| 集成面                            | 作用                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| `prd.md`                          | Definition、constraints 与 acceptance criteria                                     |
| `design.md`                       | 需要设计深度时的技术边界与决策                                                     |
| `implement.md`                    | 需要时的已批准 execution/verification contract                                     |
| `verify.md`                       | 命令、outcomes、reviewed change set、final acceptance 与 durable-learning decision |
| `implement.jsonl` / `check.jsonl` | 可选精选 context manifests，不是状态权威                                           |
| `task.json`                       | 面向用户的 status 与 task metadata accounting projection                           |
| `kernel.json`                     | Canonical phase、revision、gates、outcome 与 atomic audit chain                    |
| `task-map.md`                     | Parent 拥有的 Child dependency 与 integration ledger                               |

并非每个 task 都需要所有 artifact。当前 rigor 与 controls 决定必需项；复杂或 public-contract 工作通常需要 design、execution contract 与 independent review Evidence。

## 生命周期

Kernel 使用以下宿主无关阶段：

```text
Open -> Define -> Approve -> Execute -> Verify -> Integrate? -> Close
```

单 task 可以跳过 `Integrate`；Parent 接受 Child 时则需要它。面向人的 `task.json.status` 仍是 `planning`、`in_progress`、`completed` 等较粗 accounting projection；consumer 不能只根据该字段自行推导合法转换。

两个命令边界刻意保持显式：

```bash
pactile task start-execution <task> --check
pactile task start-execution <task> --approved
```

第一条是 read-only readiness preflight；第二条记录显式批准并进入 Execute。类似地，`archive <task> --check` 只是 preflight；`archive <task>` 执行 Close、写入 completion/audit 状态并把目录移入 archive。

`pactile task set-deps <task> <required-task-id>` 声明 Kernel 的硬 `requires` 边。依赖未满足时，预检与执行默认都会阻断。CLI 会从活动或已归档任务核实完成状态；只有已完成的任务才能满足依赖，取消不算完成。只有用户明确批准，才能用 `--ignore-deps` 记录覆盖，且不会伪称依赖已经满足。

## Gates 与 Evidence

Gate result 只有在对应已知 transition 且具备 reviewed Evidence 时才会接受。Contract 与 artifact fingerprints 防止 definition 变化后静默复用过期 review。Reviewer gate 必须显式记录，不能从绿测或自述文本推断。

Closeout Evidence 通常标识：

- validation commands 与 outcomes；
- acceptance-criteria results；
- manual 或 independent review notes；
- 精确的 reviewed change set 或 ref；
- durable-learning decision：更新项目 spec、带理由拒绝更新，或解决一次有界不确定性。

`pactile task prepare-archive-evidence <task>` 会把缺失的 `verify.md` 栏位草拟为 `TODO`；占位符不能通过归档门槛。`pactile task prepare-learning-scaffold <task>` 只打印 spec 决策清单。Parent 可先用 `pactile task review-child <parent> <child> --check` 检查 Child handoff，再记录接受或返工决定。

## Parent 与 Child tasks

Parent 是 integration authority，不是自动完成 Children 的目录。每个 Child 拥有可独立定义和验证的 deliverable；Parent 拥有跨 Child acceptance、dependency ordering、conflict decisions 与最终 integration Evidence。

```text
Parent
  +-- Child A: focused implementation -> Verify -> Parent review -> Integrated
  +-- Child B: focused documentation  -> Verify -> Parent review -> Integrated
  +-- Child C: integration smoke, depends on A and B
  `-- Parent: cross-slice review -> Close
```

Child-controlled state 表示已准备到什么程度。只有 Parent 能接受、要求修改、集成或取消 Child。移动目录、共享 worktree 或绿测都不能代替 integration decision。

## 用户场景

一个 release candidate 需要独立的 lifecycle、adapter、documentation 与 dogfood slices。每个 Child 都有有界 write set 与 focused Evidence；Parent 每次集成一个已审切片，然后执行跨切片检查。最终发布套件仍是另一道需授权 gate；完成 release-candidate Parent 不会隐含授权 publish、tag 或 merge。

## 应检查什么

- `prd.md`、`design.md` 与 `implement.md`：已批准 contract；
- `kernel.json`：canonical phase、gates、revision 与 audit；
- `verify.md`：实际 outcomes，而不是计划中的 checks；
- `task-map.md` 与 Parent review Evidence：确认 Child 是否已集成；
- archived task artifacts：重建某项决策为何被接受。

继续阅读 [Spec system](spec-system.zh-CN.md)和 [Kernel、Evidence 与 Trace](kernel-evidence-trace.zh-CN.md)。
