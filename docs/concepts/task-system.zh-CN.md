# Task system

[English](task-system.md) | 简体中文

Pactile task 把需要跨越对话的工作变成 `.pactile/tasks/` 下持久、可审阅的项目状态。Artifacts 说明需求与 Evidence；Kernel records 拥有阶段转换与 audit chain。

## Task Kernel v2：新 Task 的默认模型

`pactile task create` 会在 `kernel.json` 中创建 Task Kernel v2 记录。Task 声明一个可交付结果、验收标准与交付层级：`local-result`、`pull-request`、`merged-result` 或 `documentation`。新 Task 不再创建 Lite/Full 或 Parent/Child 种类；硬依赖通过 `--depends-on <task-id>` 显式关联。

V2 的 `kernel.json` 是唯一可写的生命周期权威，包含 Task 定义、带 revision 的事件与 audit、所有 Run、所有 Review 和 Close 记录。V2 创建不会再写一份并列的 `task.json` 状态。`task list`、`show`、`selected`、context 与 session pack 同时读取 V2 和旧记录，因此新建 Task 可被常用入口发现与继续处理。

这条命令路径与宿主无关，不要求 Codex、Pi 或常驻服务。示例中的英文标题与摘要可替换成实际任务的中文内容：

```bash
pactile task create "Search result" --slug search-result \
  --deliverable "A tested local result" --delivery-level local-result \
  --accept AC-1="The result satisfies the requested behavior"
pactile task run-start search-result --actor alice \
  --input-summary "Implement AC-1" --approved-by alice \
  --authorization-scope "the declared deliverable" --authorization-evidence approval.md
pactile task run-result search-result <run-id> --outcome completed \
  --summary "Result produced" --candidate src/result.ts=<sha256>
pactile task review search-result --actor reviewer --run <run-id> \
  --candidate-id <snapshot-id> --candidate-fingerprint <sha256> \
  --reviewer reviewer --decision pass --evidence review.md \
  --criterion AC-1=src/result.ts
pactile task close search-result --run <run-id> --review <review-id> \
  --candidate-id <snapshot-id> --candidate-fingerprint <sha256> \
  --candidate-observed-by reviewer --candidate-observation-source declared \
  --candidate-observation-ref observation.md --delivery-level local-result \
  --delivery-ref src/result.ts --delivery-summary "Reviewed result is present"
```

一个 Run 表示一次隔离尝试。Kernel 保留其输入、显式授权、attempt 编号、write-set snapshot、可选宿主/session 回执、可选 worktree 身份、candidate snapshot、结果或失败以及可选耗时证据。等待或阻塞的 Run 不能 Close；后续重试会追加 Run，不会覆盖历史。宿主、worktree 与调度字段都是可选数据，不意味着有常驻服务。

Review 绑定一次已完成的 Run 及其 candidate snapshot ID 与 fingerprint。PASS 必须包含 Review 和每条已声明验收标准的 evidence ref、未解决 blocker 必须为零，且 reviewer 必须不同于 Run 实施者和授权者。多个 Review 会保留在历史中；Close 必须采用最新 Run candidate 对应的最新 Review。诸如 `Pi settled` 的桥接回执不能自动生成 PASS Review。

Close 由同一个 Kernel 权威提交。它检查 Task 已处于 Verify、最新 Run 已完成、Review 通过且绑定该候选、所有硬依赖均已成功 Close、验收证据齐全，并且交付证据符合 Task 声明的交付层级。Pull request 和 merged-result 的证据引用必须是 HTTPS URL；Kernel 校验声明的证据格式，但不会访问远端确认合并状态。

本切片对候选新鲜度有明确限制：Close 要求调用方提交当前 observation ID/fingerprint，并记录来源和 evidence ref。Kernel 会把该 observation 与冻结的 Run snapshot 对照，但不会重新计算当前 Git HEAD、暂存/未暂存状态或文件字节。因此，Git/文件观察器接入前，这只是声明性观察。只读 `readTaskKernel` reader 与 `projectTaskKernelLifecycle` projection 会导出 Kernel revision、phase、已记录的审批字段和 gate snapshot；这些审批字段也是调用方声明，projection 只供只读判断，最终权限仍由每次 Kernel mutation 检查。

0.5.x Kernel v1 与 `task.json` 记录仍可读取，并保留旧命令路径。V2 读取时不会迁移旧数据。`pactile task legacy-create` 是显式兼容入口；旧数据自动迁移由 P36 单独处理。

新 `task create` 命令必须提供 `--deliverable`、`--delivery-level` 和至少一条 `--accept`。旧的 `task create <title> --slug <slug>` 不再是 V2 创建方式；需要显式创建 0.5.x Task 时使用 `task legacy-create`。这样新写入不会静默沿用 Lite/Full 或 Parent/Child 预设。

actor、approver、reviewer、observer、approval、candidate observation 与 evidence ref 都是调用方声明的值。Kernel 校验字段形状以及 Task、Run、候选、Review、Close 之间的关联，并要求 evidence ref 存在；它不会认证这些身份、打开被引用文件、向宿主验证审批，也不会查询 PR 或合并服务。Git/文件观察器接入并核对外部事实前，候选 observation 仍是声明。

## 0.5.x Kernel v1 记录与命令

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

第一条是只读预检；第二条由调用者声明已获得明确批准，并记录任务 ID、来源、时间与当前任务/工件指纹后进入 Execute。CLI 无法验证屏幕另一端的身份，因此 `approved_by: user` 是调用者声明，不是身份认证。Kernel 在最终提交前再次核对这些数据；工件或审核结论变化会阻断启动。相同的已批准启动请求可安全重试。类似地，`archive <task> --check` 只是预检；`archive <task>` 执行 Close、写入 completion/audit 状态并把目录移入 archive。

`pactile init` 自动建立的 bootstrap 与 onboarding 任务均从 Planning 开始。初始化只创建工作清单；处理这些任务时仍需按普通任务运行启动预检并获得 Execute 批准。任务创建先写齐 PRD 和 Kernel 再发布目录；创建失败可重试，已有不完整目录会明确报待恢复，避免覆盖用户内容。

`pactile task set-deps <task> <required-task-id>` 声明 Kernel 的硬 `requires` 边。依赖未满足时，预检与执行默认都会阻断。CLI 会从活动或已归档任务的 Kernel 核实完成状态；只有已完成的任务才能满足依赖，取消不算完成。只有用户明确批准，才能用 `--ignore-deps` 记录覆盖，且不会伪称依赖已经满足；有效覆盖也适用于随后由可选宿主发起的 Execute。

## Gates 与 Evidence

Gate result 只有在对应已知 transition 且具备 reviewed Evidence 时才会接受。Contract 与 artifact fingerprints 防止 definition 变化后静默复用过期 review。Reviewer gate 必须显式记录，不能从绿测或自述文本推断。

Full 任务在 `start-execution --check` 前，须用 `pactile task record-gate` 分别记录当前策略所需的 `requirements-review`，以及需要时的 `architecture-review`。`--approved` 只消费这些结果，不会替 reviewer 写入 PASS；FAIL、缺失和指纹过期都会阻断启动。

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
