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

Close 通过 `closeTaskKernel` 提交；CLI 调用的也是同一个 Core API。它检查 Task 已处于 Verify、最新 Run 已完成、最新 Review 通过且绑定该候选、所有硬依赖均已成功 Close、验收证据齐全，并且交付证据符合 Task 声明的交付层级。对 `local-result` 和 `documentation`，Core 会重新观察 Run 写入范围内的当前普通文件，并将文件字节绑定到候选。对 `pull-request` 和 `merged-result`，Core 要求 Git 候选，并通过只读 GitHub `gh api` observer 查询 PR；调用方给出的 HTTPS URL 只是定位符，本身不能证明交付。`pull-request` 必须由 provider 确认 PR 处于 open、非 draft 状态且 head 等于候选 HEAD；`merged-result` 还要求 provider 确认已合并、合并提交存在于本地目标分支的祖先链中，且该分支上的交付字节匹配。Provider 不支持或无法读取时，Close 会阻断。

Close 请求中的 candidate ID 和 fingerprint 必须匹配最新冻结的 Run snapshot，但调用方提供的 observer 字段不构成新鲜度证明：Core 会重新观察当前候选并记录自己的 observation。Git Run 会检查 HEAD、分支、Git 报告的暂存/未暂存/未跟踪/冲突/已提交路径，并为变化的写入范围路径及精确写入路径计算有界文件指纹；非 Git Run 则重新扫描有界项目文件快照。这不代表对磁盘上每个字节作出证明：Git 未跟踪路径发现使用 `--exclude-standard`，非 Git 观察器会跳过配置的排除路径，并限制文件数、路径数和字节数。Close 还会重新打开 Review 与验收证据文件，按 Review 中保存的验证结果复核指纹。只读 `readTaskKernel` reader 与 `projectTaskKernelLifecycle` projection 只导出已记录状态，不触发这些观察；projection 仅供只读参考，每次 mutation 仍由 Kernel 作最终门槛判断。

0.5.x Kernel v1 与 `task.json` 记录仍可读取，并保留旧命令路径。V2 读取时不会迁移旧数据。`pactile update` 会按 P36 契约将符合条件的旧任务导入待补定义状态；缺少交付定义或依赖映射时，须显式协调后才能启用 V2 Task。原生命周期只作历史证据，不伪造新的 Run、Review 或 Close。`pactile task legacy-create` 仍是显式兼容入口。详见[升级与迁移](../lifecycle/upgrade-and-migrate.zh-CN.md#p36-held-task-reconciliation)。

新 `task create` 命令必须提供 `--deliverable`、`--delivery-level` 和至少一条 `--accept`。旧的 `task create <title> --slug <slug>` 不再是 V2 创建方式；需要显式创建 0.5.x Task 时使用 `task legacy-create`。这样新写入不会静默沿用 Lite/Full 或 Parent/Child 预设。

actor、approver、reviewer 与 Run authorization 字段由调用方提供；Core 会检查字段形状和记录之间的关联，但不会认证身份或向外部宿主验证审批。Close 请求中的 candidate ID/fingerprint 只负责绑定所选 Run；当前 observation 由 Core 自行生成。Review 和验收 evidence ref 会在记录 Review 时解析为有界文件并计算指纹，Close 时再打开文件复核。PR 状态只通过内置的只读 GitHub provider 查询，适用于受支持的 GitHub 仓库，不代表通用 PR 主机集成。

## 只读概览

`task dashboard` 和 `task list` 校验已提交的 Task 目标 generation、指针、
当前 Kernel 文档与协调数据，每次查询不再重读整份历史源备份。存在已导入
generation 时，输出会明确标注本次查询没有审计历史源备份。

`readTaskKernelOverview` 提供这类展示数据。它的迁移快照不能用作已完整验证的
事务快照。`readTaskKernel`、`listTaskKernelSnapshots`、执行、Review、Close 与
历史恢复保留现有完整校验；概览不能证明历史源字节仍然完整，不能代替验收证据。

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

## Verification planning

`pactile task verify-plan <task-id> --manifest <project-relative-json> (--adopt|--override) [--no-jev]` 会为 Task 最新一次已完成 Run 生成确定性 P41 计划。命令会在可选 Jev 建议前后重新观察 Run candidate；如果 Run、candidate 或 Jev 出站策略发生变化，就会拒绝该过期响应。

UTF-8 JSON manifest 上限为 32 KiB，只能包含 `impact` 和 `checks`。有界 metadata 不得包含文件路径、链接、邮箱地址或疑似密钥值。该清单由调用方提供，不能证明它列全了仓库必需 CI；仓库策略与仓库 CI 仍是权威。Planner 不会从收到的清单中移除必需检查，也不会执行任何检查。

确定性计划完成后，Jev 最多建议一项额外的独立行为检查。项目 `jev.egress: deny`、无效策略、缺少凭证、传输失败或低置信度都会回退到本地计划。请求只发送有界的影响摘要和可选检查模式，不发送源码片段、检查标题、路径或密钥。`--adopt` 或 `--override` 记录调用方对建议的决定；采纳仍只是计划选择，不会执行检查、创建 Run/Review、声明 Review PASS 或授权 Close。

建议回执保留 Provider 原样返回的 `additional_check` confidence；缺失或无效时显式标为 unavailable，不会从建议、fallback 或验证结果推导 confidence。

仅当 `.pactile/.runtime/task-verification/plans/` 已被排除在 Git candidate observation 之外时，命令才会写入 `planned-only` 回执；否则只打印绑定后的计划，不持久化。该回执与 Run 执行回执分开，不修改 Kernel 生命周期状态。实际验证结果应进入 Run Evidence 与 Review；仓库 CI 仍须按原有策略执行。

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
