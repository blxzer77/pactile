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

回执格式示例：`{"request_id":"<request-id>","tool":"create_thread","outcome":"ok","thread_id":"<threadId>","host_id":"local"}`。后续用 `--tool message|wait|read --thread-id <threadId>` 准备请求；分别调用桌面原生 `send_message_to_thread`、`wait_threads`、`read_thread`，再以相同方式记录回执。等待回执还需 `status: completed|needs_attention|timeout`。失败回执用 `outcome: failed` 和简短 `reason`。`status` 会显示尚未收到回执的请求及绑定的桌面任务。

创建 worktree 任务时，App 可能先只返回 `clientThreadId`。此时记录 `outcome: queued` 与 `client_thread_id`；临时 ID 不能用于发消息或等待。App 报告就绪的 `threadId`、`hostId` 后，再记录最终 `outcome: ok`，同时带上原 `client_thread_id` 和就绪 ID。`pactile codex status` 在此期间显示排队请求。

桥接回执标记为 `host-reported`：它记录桌面工具的返回身份与结果，不代替代码审查、Pi 结果检查、AC 证据或 Kernel gate。若收到回执时 Kernel revision 已变化，回执标记 `contract_stale`，应重新核对任务契约。规划仅允许在 Open/Define/Approve；审核仅允许在 Verify/Integrate。Pi 实现派发继续由 `pactile pi run` 校验已记录的用户批准和工作契约。不要把 Codex CLI/App Server/ACP 会话当作桌面任务，也不要派发 Codex subagent。桌面原生工具不可用时在当前任务串行工作，并记录原因。

独立实现任务在 Execute 批准后可选 `--role execute`；创建必须采用 `--target project --environment worktree`。请求会附带 Pactile Task 的绝对路径，因为 App 工作树不一定包含被忽略的任务状态；若已批准合同有 `base_branch`，从该分支启动。Parent Child 在准备桌面创建请求时占用一个共享并发槽；创建失败或 `wait_threads` 的完成回执释放该槽。桌面任务归用户所有。回执并不证明代码已验收，Parent 仍需单独审核并逐个 `integrate-child`。

Pactile 归档任务后，`pactile codex status <task>` 仍可只读查看归档回执；新请求和回执只允许写入活动任务。

## 分离

```bash
pactile detach codex --dry-run
pactile detach codex
```

dry-run 会展示 claimant 与保留资源。应用分离后只移除 Codex 专属 binding，共享或 borrowed 资源保持不变。
