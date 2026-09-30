# Canonical workflow

[English](workflow.md) | 简体中文

Workflow 是与宿主无关的 intent、definition、approval、execution、verification、integration 与 close 顺序。Codex task conversation 消费这个顺序；canonical Task 记录才是权威。

```text
triage -> define -> approve -> execute -> verify -> integrate -> close
```

持久变更应将 Task PRD、实现契约、Evidence、review gate 与 ownership 决定放在一起。Shell 命令成功或模型回复不能直接成为 close gate。Kernel 只有在必需事实与 fingerprint 新鲜时才接受转换。

## V2 生命周期命令

发布版 Node 运行时使用下面的 Task Kernel V2 链路。命令名称保持明确，
宿主适配器或 Agent 可以在不依赖旧任务目录状态的情况下恢复 Task：

```bash
pactile task create "<title>" --slug <slug> \
  --deliverable "<independently acceptable result>" \
  --delivery-level local-result --accept AC-1="<criterion>"

pactile task run-start <task> \
  --input-summary "<bounded input>" \
  --approved-by <actor> \
  --authorization-scope "<approved scope>" \
  --authorization-evidence <evidence-ref> \
  --write-set-snapshot <repo-relative-path>

pactile task run-result <task> <run-id> --outcome completed
pactile task review <task> --actor <reviewer> --run <run-id> --candidate-id <candidate-id> \
  --candidate-fingerprint <sha256> --reviewer <reviewer> --decision pass \
  --evidence <review-ref> --criterion <criterion-id>=<evidence-ref>
pactile task close <task> --run <run-id> --review <review-id> \
  --candidate-id <candidate-id> --candidate-fingerprint <sha256> \
  --candidate-observed-by <actor> --candidate-observation-source <source> \
  --candidate-observation-ref <observation-ref> \
  --delivery-level local-result --delivery-ref <delivery-ref> \
  --delivery-summary "<accepted result>" --check
```

`run-result` 记录候选结果；`review` 记录独立结论；`close --check` 报告
当前证据和 fingerprint 是否满足 Task 契约。只有检查通过后，才去掉
`--check` 执行同一条 `close` 命令。旧的 `start-execution`、`record-gate`
和 `archive` 仍是导入 V1 任务的兼容命令，不属于新建 V2 Task 的流程。

这些命令是生命周期提纲，不是能直接运行的占位符脚本。用
`--write-set-snapshot` 逐个声明允许产生结果的路径，在 `run-start` 后实现
已批准的变更，然后用 `pactile task show <task> --json` 读取 candidate ID
和 fingerprint。Review 证据放在 Task 目录内，避免写入审查文档时改变项目
候选。reviewer 必须与 Run 执行者和批准者不同。使用受管 Git worktree 时，
先以 `--wait` 将 Run 排队，创建或采用工作树，再恢复 Run 后写入；详见
[Run worktree 生命周期](../run-worktree-lifecycle.md)。

Host Hook 与上下文注入只是尽力而为；缺失时直接阅读 `.pactile/workflow.md`、
Task 工件和 CLI 生成的 dispatch prompt。

## Evidence 与 close

验证应写明命令、退出状态、受影响文件和跳过原因。独立审查只读。
只有 Task 的交付层级、Run 结果、候选观察、Review 结论、Evidence ledger
以及契约要求的 durable-learning 决定都记录后才可 Close。若发布边界如此
规定，完整 Core 与 CLI suite 留到最终发布前 preflight。
