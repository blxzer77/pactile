# Codex 宿主

[English](codex.md) | 简体中文

Codex Adapter 使用 canonical `.pactile/` generation。ChatGPT desktop app 报告原生项目支持时，才可能把受支持的 Codex 文件投影到 `.codex/`；baseline install 在宿主不可用时会保持该原生目录不存在，并把 Adapter 明确报告为 degraded。Adapter 不会把 canonical Task 数据库复制成第二份权威。`AGENTS.md` 与共享 Skill 仍受 ownership 检查约束。

## 安装与检查

```bash
pactile init --codex -y
pactile capability-smoke --json
```

检查生成的项目投影和 canonical receipt。宿主配置条目可能属于用户、是 borrowed、由 Pactile 管理或语义不明确；ownership ledger 才是判断依据。

| Codex 表面             | Pactile 契约                                             |
| ---------------------- | -------------------------------------------------------- |
| `.codex/` 项目配置     | 条件式可重建投影；原生项目支持不可用时不生成。             |
| `AGENTS.md`            | 一个共享受管区块；区块外用户文本保留。                   |
| `.agents/skills/`      | 共享 Skill 投影；每个宿主是 claimant，而不是重复 owner。 |
| 外部 MCP/Provider 配置 | 由 Middleware 与宿主解析，不复制进 canonical 状态。      |

依赖某项能力前，应读取其 origin 与 assurance。模式矩阵见[能力 readiness](../capabilities/index.zh-CN.md)。

## 桌面任务与 Pactile Task 桥接

Codex 桌面任务可以通过 `pactile task` 和 `pactile kernel --json` 读取、更新 Pactile Task；在用户批准 Execute 后，可用 `pactile pi run` 派发 Pi。Pactile 的 Kernel 和任务文件仍是生命周期与证据真源。Codex 桌面原生的创建、发消息、等待和读取工具由当前桌面任务调用；Node 进程不能直接调用这些 App 工具。

用户明确要求创建独立桌面任务后，先通过 App 的项目列表取得项目 ID，再准备请求：

```text
pactile codex prepare <task> --tool create --role plan --project-id <Codex project ID> --environment worktree --prompt-file plan.md
```

`--environment` 按 App 返回的项目类型选择 Git 项目的 `worktree` 或非 Git 项目的 `local`。CLI 输出请求 ID、Kernel revision 和原生 `create_thread` 参数。当前 Codex 任务调用对应原生工具后，把返回的 `threadId`、`hostId` 写成简短的 JSON 回执文件，再执行：

若该 checkout 尚未保存为 App 项目，可使用 `--target projectless`，并在提示中写明绝对 checkout 与任务路径；无需项目 ID 与 environment。

```text
pactile codex receipt <task> <request-id> --result-file create-result.json
pactile codex status <task>
```

回执格式示例：`{"request_id":"<request-id>","tool":"create_thread","outcome":"ok","thread_id":"<threadId>","host_id":"local"}`。后续用 `--tool message|wait|read --thread-id <threadId>` 准备请求；分别调用桌面原生 `send_message_to_thread`、`wait_threads`、`read_thread`，再以相同方式记录回执。`--evidence-level` 默认为 `simulated`；只有回执直接整理自当前 Codex 桌面任务调用的原生工具时才标记 `desktop-native`。桌面原生 create/wait 回执必须回显实际 `thread_id` 与 `host_id`。等待回执还需 `status: completed|needs_attention|timeout`。失败回执用 `outcome: failed` 和简短 `reason`。`status` 会显示尚未收到回执的请求及绑定的桌面任务。

V2 Run 可以通过 `--run-id <Task Run ID>` 关联 create、message 和 wait 请求。桌面任务在 Run candidate snapshot 已记录后终结时，用相同 `--run-id` 准备 wait；回执会保留等待请求当时的 candidate snapshot ID 与 fingerprint，候选或 Task revision 变化时不能作为当前终结证据。跨 Task 消息使用发送方 Task、目标线程所属 Task 和可选的两端 Run 显式关联：

```text
pactile codex prepare <sender-task> --tool message --thread-id <receiver-thread> --to-task <receiver-task> --to-run-id <receiver-run> --prompt-file message.md
pactile codex receipt <sender-task> <request-id> --result-file message-result.json --evidence-level desktop-native
pactile codex block <receiver-task> --message-id <request-id> --blocked-by-task <sender-task> --reason "Waiting for input"
pactile codex unblock <receiver-task> <block-id> --resolution-message-id <request-id> --unblocked-by-task <sender-task> --reason "Input received and checked"
```

示例中的 `Waiting for input` 表示“等待输入”，`Input received and checked` 表示“已收到并核对输入”；实际 reason 可按场景用中文填写。

跨 Task 消息正文上限为 4096 UTF-8 字节。默认是纯协调消息：允许目标 Task 正在 waiting/blocked 时接收，但不会改 Run、解除阻塞或授予写权限，提示会要求收件方保留阻塞状态。当前切片因尚未接入 P37 admission、lease、Resume 和 block 校验，对 Task Kernel v2 Execute create 与 `--resume-execute` 一律 fail closed。完成这些 gate 接线后，写入派发仍须先由 Kernel 明确 Resume 并通过 P37 admission；发送回执本身不授予派发许可。只有非 stale 的成功发送回执可用于创建与消息关联的 block；消息关联的 unblock 要求成功的 `desktop-native` resolution 证据，模拟发送不能解除阻塞。“sent”只表示 Host 接受发送请求，不表示收件方已读。每次解除都会留下独立日志事件。用户也可在给出原因后手动解除。

### Pi Review 升级到 Codex Review

已准备的 P40 升级可以请求另一个已绑定的 Codex `review` thread 给出独立、只读 Review。Pi Review 产物保持不可变。发送必须从来源 Task 当前 V2 Verify Run 和非通过 Pi Review 发起，并发给具有当前已完成候选的 V2 Verify/Integrate Task 及其已绑定 Review thread：

若 Pi Review 为非 PASS，且未命中强制升级规则，Pactile 可调用 Jev 的
`review-routing` 节点提出一个有界问题。摘要只包含经过验证的 Pi Review
结论、覆盖区域的状态与置信度、发现项风险计数，以及 blocker 和未解决问题的
数量。请求不包含 Task 身份、候选细节、Review 正文、证据引用或源码片段。只有
provider 原样报告且不低于 0.65 的 `append-codex-review` 置信度会准备可选 P40 请求；
`keep-pi-review`、建议不可用、低置信度或项目 egress 被拒绝时，保留当前路由。
每次调用或跳过都会写入本地安全回执，记录建议、采用依据、provider 置信度、
项目 egress 状态和传输延迟/成本事实。Pi 对不确定性、高影响和争议发现的规则
仍然强制执行并跳过 Jev；PASS 也跳过 Jev。该建议不会改变 Pi verdict 或
Kernel Review，不会发送 Codex 消息、授权 Run 或 Close Task；发送仍须显式走
下方 P40 命令。

当前 V2 Execute 路径只有 Pi 执行器，没有可路由的替代 provider 候选集，因此
Jev 的 `execution-routing` 节点仅预留，本路径不会调用。

```text
pactile codex prepare <source-task> --tool message --thread-id <review-thread> --to-task <review-task> --run-id <source-run> --to-run-id <review-run> --escalation-id pi-escalation:<pi-run-uuid>
pactile codex receipt <source-task> <send-request-id> --result-file send-result.json --evidence-level desktop-native
pactile codex prepare <review-task> --tool read --thread-id <review-thread> --reply-to-escalation-id pi-escalation:<pi-run-uuid> --source-task <source-task> --send-request-id <send-request-id>
pactile codex receipt <review-task> <read-request-id> --result-file read-result.json --evidence-level desktop-native
pactile codex review-escalation <source-task> --escalation-id pi-escalation:<pi-run-uuid> --send-request-id <send-request-id> --read-request-id <read-request-id>
```

发送准备会读取并验证真实 Pi 升级产物与 Pi Review 证据，再为已绑定 Review thread 生成固定 P40 提示。原生 read 结果必须包含已完成且相关联的 `reply_evidence`；正文是一个 JSON 对象，精确绑定升级 ID、Task/Run/候选与 Pi 产物，并包含审核者 `hostId`、`threadId`、`role: review`、`independent: true`，`pass`、`fail` 或 `needs-changes` 结论，coverage、findings、blockers、questions、逐项处理每个原 Pi finding/blocker/question 且带证据的 `concernResolutions`、AC 证据与引用。Concern ID 是稳定的不透明标识；跨 Task 提示不会转发 Pi 自由文本摘要。正文不能含额外字段或 Markdown fence。PASS 必须有证据地解决所有原 Pi concern。每个报告引用必须与当前按字节验真的候选/Run 证据集完全一致；由原生 thread 推导的审核者身份必须不同于 Run 执行者和批准者。

`pactile codex review-escalation` 会重新读取两端准备请求与原生回执，将原始字节复制到来源 Task 的证据树，校验完整回复，再调用现有 public Kernel Review mutation。PASS 会让 Kernel Review condition 变为 ready；该命令不会 Close Task，也不会授权新 Run。旧 Pi Review 保留在 Kernel 历史中，产物不改写。派发前和记入前都会复验旧 Pi Kernel Review 的 Core 证据摘要；新 Review 会继承全部旧 Pi 证据引用，使 public Close 再次核对 Check start/stop/result。Reply read 绑定指定成功 send 的 request/receipt 摘要，必须发生在 send 之后，结算时仍须对应最新成功 send。来源或回复 Task 过期、模拟回执、ID/thread 错绑、候选不符、证据缺失、非 JSON 文本、遗漏或未解决 Pi concern、结构化合同无效或凭据样式的 Pi 文本，都会在外发或新增 Kernel Review 前 fail closed。相同输入重复 finalization 是幂等的；不同回复不能替换已记录 Review。`desktop-native` 仍只是 Host 报告的 assurance，并非经签名验证的桌面身份；只有结果直接来自当前 Codex 桌面工具调用时才可如此标记。即使使用原生结果，也必须通过结构化回复合同和 Kernel independence 校验。

创建 worktree 任务时，App 可能先只返回 `clientThreadId`。此时记录 `outcome: queued` 与 `client_thread_id`；临时 ID 不能用于发消息或等待。App 报告就绪的 `threadId`、`hostId` 后，再记录最终 `outcome: ok`，同时带上原 `client_thread_id` 和就绪 ID。`pactile codex status` 在此期间显示排队请求。

桥接回执标记为 `host-reported`：这是 Node 从调用方提供的原生工具结果中记录的事实，不是产品认证的桌面签名。哈希链和 receipt 不会把模拟结果升级成桌面证据；测试中的模拟回执不能证明真实桌面验收。回执不代替代码审查、Pi 结果检查、AC 证据或 Kernel gate。若收到回执时 Kernel revision 或 Run candidate 已变化，回执标记 `contract_stale`，应重新核对任务契约。规划仅允许在 Open/Define/Approve；审核仅允许在 Verify/Integrate。Pi 实现派发继续由 `pactile pi run` 校验已记录的用户批准和工作契约。不要把 Codex CLI/App Server/ACP 会话当作桌面任务，也不要派发 Codex subagent。此桥接无需后台常驻服务。桌面原生工具不可用时在当前任务串行工作，并记录原因。

0.5.x 兼容桥接仍允许旧任务在 Execute 批准后使用 `--role execute`。该路径由 App
创建工作树，不会绑定到 P38 管理的 V2 Run 工作树。新的 Task Kernel V2 工作中，
Codex 桌面任务负责规划和独立审核；Pi 通过 `pactile pi run` 执行已批准的 Run。

旧版 Execute 创建须使用 `--target project --environment worktree`，并附带 Pactile
Task 的绝对路径，因为 App 工作树不一定包含被忽略的任务状态；若已批准的旧任务有
`base_branch`，则从该分支启动。旧版 Parent Child 在准备桌面创建请求时占用一个
共享并发槽；创建失败或 `wait_threads` 的完成回执释放该槽。桌面任务归用户所有。
回执不证明代码已验收，旧版 Parent 仍需单独审核并逐个 `integrate-child`。

Pactile 归档任务后，`pactile codex status <task>` 仍可只读查看归档回执；新请求和回执只允许写入活动任务；迟到的 Host 响应会被拒绝，不会追加到归档 Task。

## 分离

```bash
pactile detach codex --dry-run
pactile detach codex
```

dry-run 会展示 claimant 与保留资源。应用分离后只移除 Codex 专属 binding，共享或 borrowed 资源保持不变。
