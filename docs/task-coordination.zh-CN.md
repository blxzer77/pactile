# Task / Run 协调存储（基础切片）

`packages/cli/src/pactile/coordination/` 提供不依赖 Codex、Pi 或后台服务的本地状态模型。它记录跨 Task 消息、回执、Task 阻塞/解除，以及 Run 的开始、进度和结果；不负责创建 Codex 桌面任务、发送 Host 消息、启动 Pi 或派发 subagent。

## 关联模型

- 消息以 `message_id` 关联 `from_task_id` / `to_task_id`，并可选关联两端 `run_id`。提供稳定的 `messageId` 可使重复写入幂等；相同 ID 携带不同内容会拒绝。
- 回执引用 `message_id` 和调用方稳定提供的 `receiptId`。状态只能从 `pending` 向 `queued`、`sent`、`delivered`、`acknowledged` 或 `failed` 前进；后续状态不能回退，终态不能再变化。
- `task.blocked` 有唯一 `block_id`，`task.unblocked` 必须指向该活动 block。引用消息阻塞或解除时，Codex bridge 会验证当前源/目标 Task ID、Kernel 类型与修订、contract、相关 Run 身份，以及非 stale 的成功回执；新增 `task.blocked` 且引用消息指定 `to_run_id` 时，V2 Run 还必须仍处于活动状态。回执驱动的解除必须是 `desktop-native`；不带解除消息的人工解除记为本地操作。解除记录保留在日志中。
- `run.started` 绑定全局唯一的 `run_id` 到 `task_id`，并可选记录 `workspace_id`（供 P38 worktree 身份关联）及 `provider_run_id`。进度事件带单调递增的序号，终态结果最多一条；两者都验证相同 Task/Run 绑定。

最小调用示例：

```ts
const coordination = new CoordinationStore(projectRoot);
coordination.createMessage({
  messageId: codexRequestId,
  fromTaskId: taskA,
  toTaskId: taskB,
  sender: { platform: "codex", id: codexThreadId },
  evidenceLevel: "desktop-native",
  body: "Task A 的接口决定已记录，请继续。",
  requestId: codexRequestId,
  hostRef: codexThreadId,
});
coordination.recordMessageReceipt({
  messageId: codexRequestId,
  receiptId: hostReceiptId,
  status: "delivered",
  actor: { platform: "host", id: null },
  evidenceLevel: "desktop-native",
});
const view = coordination.snapshot();
```

Codex Node bridge 会把显式 `--to-task` 的桌面消息请求/回执映射到消息记录，并将 V2 Task Run 的 bridge 回执作为有序进度事件引用。Host 的 `sent` 只表示调用方提交了发送回执，不证明对端已读；回执还须匹配当前 Task/Run/Kernel/contract，且回执驱动的解除要求 `desktop-native`。Pi RPC 生命周期由 Pi bridge 接线到 `run_id`；此协调存储本身不启动宿主或验证 provider。

## P39 阻塞解除与派发边界

- 活动的协调 block 会关闭 Task Run admission。`task.unblocked` 只记录解除，不等于 Kernel Resume，也不直接授予执行或文件写入权限。
- V2 解除事件绑定解除时处于活动状态的 Task Run（如有）及精确的 Kernel 修订和事件 ID。对该屏障绑定、仍处于 waiting（Kernel 事件仍为 `run.queued`）的 Run，必须通过协调锁内的 Kernel Resume 路径；该路径将 `run.resumed` 与对应解除事件写入因果授权记录，admission 再验证这组绑定。解除屏障前已 `run.started` 的旧 Run 不可借解除重新派发，须结束后重试；屏障后新启动的 Run 仍须通过 P37 admission。
- P37 admission 会在协调日志锁和项目调度锁内重检 block、Kernel/Run 与授权、硬依赖、批准范围、owner、write set 和 lease，并在派发前再次验证 lease。`--resume-execute` 不启用；手工或消息回执解除都不能绕过 Kernel Resume、批准或 admission。
- 执行阶段的 V2 Task 可通过同一 Task 身份与 contract 下仍有效的 Plan thread 接收跨 Task `send_message_to_thread` 协调消息；消息请求/回执绑定双方当前 Task、Run、Kernel 修订和 contract。该通道只用于协调：不得编辑文件、改变批准或派发 Codex subagent；收到消息后仍须等待明确的 Kernel Resume 和 P37 admission。Pi 的派发由 Pi Host 按自身策略执行，Node CLI 只承载边界请求与回执。

## 本地日志与边界

项目根下追加到 `.pactile/runtime/coordination/events.jsonl`。每行是 schema version 1 的事件信封，包含前一条哈希和当前事件哈希；读取会按行重放并验证结构、哈希链、Task/Run 绑定和状态转换。日志只追加，不静默修复损坏行。

- 写入通过短时排他 lock 文件串行化。已存在的 lock 会返回 `store-locked`；不会自动判断或偷删陈旧 lock。
- 写入使用 canonical `.pactile` 路径检查、拒绝符号链接/多硬链接目标、`O_NOFOLLOW`（平台支持时）、新建文件权限 `0600` 和 `fsync`。这是同一用户进程间的本地协作边界，不是对恶意本地进程的 OS 沙箱。
- 每段事件最多 16 KiB，日志最多 20,000 条或 16 MiB。达到上限时 fail closed；本切片不提供压缩、清理或归档。
- 消息和摘要各不超过 4 KiB；常见 token / Bearer / `api_key` / `secret` 形式会尝试脱敏。不要把凭据、完整 prompt 或任意 provider 输出当作摘要写入；脱敏并不构成通用 DLP。
- `evidence_level` 为 `local`、`simulated`、`desktop-native` 或 `provider`。它是写入方声明的证据类别。哈希链帮助发现日志行被改动或损坏，但不能证明桌面操作或 provider 响应真实发生；分类必须由实际 adapter/验收流程提供。
- Codex receipt 默认 `simulated`；调用方只有在当前桌面 Codex 任务实际调用原生工具后才可标 `desktop-native`。Node 记录的是 host-reported 回执，不是桌面签名。测试的模拟回执不证明原生桌面或真实 provider 接受。
- 任意文件引用只能是项目相对、无 `..` 的路径；不读取或复制引用目标内容。

## P35 / P38 接口约定与验证边界

- P35 的 Run 生命周期可用 `startRun({ taskId, runId })` 建立关联，`recordRunProgress` 追加有序运行事件，`recordRunResult` 保存终态和证据引用。`taskId` / `runId` 都是纯逻辑 ID，不要求同一目录结构，也不修改 Kernel。
- P38 的 worktree 模块应传稳定 `workspaceId`，不要把绝对 checkout 路径当 ID。后续可凭 Task/Run/Workspace ID 联结 Task、Run、Review 和 worktree 状态；本切片没有回收或隔离工作树操作。
- 测试只证明本地状态机、日志回放、限制和冲突保护。`simulated` 测试不证明 Codex 桌面原生操作；`provider` 标签的单元测试也不证明真实 Pi provider。真实 Codex/Pi 证据仍需在对应桌面宿主和 provider 上独立验收。
- 协调 API 本身不派发任何 agent，因此不会启用 Codex subagent，也不替 Pi Host 决定是否派生 agent。Host 的派发策略与审计由集成层执行。
