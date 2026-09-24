# Canonical workflow

[English](workflow.md) | 简体中文

Workflow 是与宿主无关的 intent、definition、approval、execution、verification、integration 与 close 顺序。Codex task conversation 消费这个顺序；canonical Task 记录才是权威。

```text
triage -> define -> approve -> execute -> verify -> integrate -> close
```

持久变更应将 Task PRD、实现契约、Evidence、review gate 与 ownership 决定放在一起。Shell 命令成功或模型回复不能直接成为 close gate。Kernel 只有在必需事实与 fingerprint 新鲜时才接受转换。

## 宿主无关检查

```bash
python ./.pactile/scripts/task.py start-execution <task-dir> --check
python ./.pactile/scripts/task.py record-gate <task-dir> --transition full-task-complete --gate code-review --result PASS --evidence verify.md
```

具体 gate 选项以生成的 Task 契约为准。Host Hook 与上下文注入只是尽力而为；缺失时直接阅读 `.pactile/workflow.md`、Task 工件和 CLI 生成的 dispatch prompt。

## Evidence 与 close

验证应写明命令、退出状态、受影响文件和跳过原因。独立审查只读。只有 Parent/Child 状态、Evidence ledger、review gate 与 durable-learning 决定都记录后才归档。若发布边界如此规定，完整 Core 与 CLI suite 留到最终发布前 preflight。
