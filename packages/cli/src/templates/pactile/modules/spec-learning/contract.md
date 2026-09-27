# `spec-learning`

P29 表名：`spec-learning`（不得改名）。层：on-demand。

## 职责

Close 窗口里，把**可复用**的约定写进长期知识（`.pactile/spec/`、ADR、Policy）。先提案、人确认、再写盘。`pactile-update-spec` 是本块的内部技能，不是用户 slash。`close-basic` 只产出学习 disposition（update-spec / no-update / unsure）；本块只在 disposition 需要写盘时才动手。不在 Execute 中改长期 spec，不把任务 `prd.md` 当长期 spec。

## 写盘动作会有机器记录（只记事实、不拦写盘）

对 `.pactile/spec/`、`docs/adr/`、Policy 文件的修改，在任务证据中记录**谁写的（actor）、写盘时间、目标文件、有没有经过确认（经/未经验证）**。自动写盘审计需由后续 Codex / Pi 桥接提供；当前不得声称已有自动 hook 记录。

- **机器记录 ≠ 机器裁决**：机器只记"有没有确认记录"这个**事实**，不做"内容对错"判定。对错由人裁决。
- **只记录、不拦写盘**：记录失败不阻塞写盘；不因"未经验证"而拒绝写盘。本 gate 是记录不是门禁，任何情况下不因缺确认记录而挡住写盘。

## 触发/披露

未触发当没装。Execute / Define / 日常修 bug 看不见本块。触发（可审计）：

1. Close 且 disposition 为 update-spec，或 unsure 经一次追问变成 update-spec；或
2. 强信号：公共契约/API/CLI 变了、同类错误反复、`debug-recovery` 的防再发要求入 spec、用户明确要沉淀。

**不是**触发：例行 bugfix、一次性配置、已经写在任务产物里且没有跨任务价值。默认**不问**「每个功能都要更新 spec」。

写完或明确 no-update 后，本块教战从包中消失。

Agent 看见：

1. 先写任务内提案（目标路径 + 要点），**未确认不得**改 `.pactile/spec/` / ADR / Policy。
2. 确认后才写；在 Evidence 里留下 spec 路径。禁止 hook / check 静默改 spec。
3. no-update 必须带一句理由。unsure 只追问一次，不得假装已经写过。
4. 编码期读 spec 是 `context-progressive` + spec 文件，不是本块把全文灌进 Close 包。
5. 第一次从仓库事实建项目 spec 骨架是 `define-extended`（spec-bootstrap），不是本块。技能作者流程不是本块。

用户看见：收工时最多被问一次「这条要不要写进长期约定」。多数 Lite Close 直接 no-update。没有常驻「学习配置」。

## 停止条件

- 与 `close-basic` 的分工：disposition vs 写盘。
- 提案 → 确认 → 写盘 → 证据路径。
- 停止：Execute 中改 spec；静默写盘；把 `prd.md` 当长期 spec；无确认写 Policy；用本块代替 spec-bootstrap。
- Lite Close 不因缺 spec 更新而阻塞（缺的是 disposition 记录，那是 `close-basic`）。

## 关掉必须消失

Close 不得改长期 spec。disposition 仍可记 no-update。任务内 PRD/AC 不受影响。编码仍可按已有 spec 文件进行。

## 不得带走

Close Outcome（`close-basic`）；Define 时 bootstrap spec（`define-extended`）；把 spec 编进 Session 包（`context-progressive`）；break-loop 分类（`debug-recovery`）；技能作者（Maintainer Overlay / `pactile-skill-creator`）；跨 Task journal（`personal-memory`）。
