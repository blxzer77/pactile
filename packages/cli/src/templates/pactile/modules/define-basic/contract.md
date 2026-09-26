# `define-basic`

P29 表名：`define-basic`（不得改名）。层：baseline。

## 职责

在第一个 Run 开始前定义 V2 deliverable Task。Kernel Definition 记录标题、描述、交付物、单一交付层级、验收标准和硬依赖 Task ID。交付物应足以供人检查，每条 AC 应能映射到证据。

交付层级应描述 Task 所要求的结果：

- `local-result`：项目或指定工作区中的可审查结果；
- `pull-request`：可审查的 Pull Request；Close 证据须为 HTTPS 引用；
- `merged-result`：已合并的结果；Close 证据须为 HTTPS 引用；
- `documentation`：要求交付的文档。

每个依赖都是硬依赖：它必须存在且成功 Close，当前 Task 才能开始 Run 或 Close。仅表示建议顺序的事项不应写成硬依赖。以 V2 Kernel 字段作为定义，不额外引入未记录的流程模型。

## 触发/披露

V2 Define 阶段加载。Kernel Definition 是 Task 交付物、AC、交付层级和依赖 ID 的事实来源。草稿可以帮助人写定义，但不能代替 Kernel 中的记录。

## 停止条件

- 未记录交付物、交付层级和可测 AC，不得开始 Run。
- 每个硬依赖都必须指向现存 Task ID；缺失依赖和依赖环均无效。
- 范围或交付层级变化时，先使用 Kernel 支持的定义更新路径，再请求 Run 授权；不要在实现或 Review 中静默改契约。
- 不得宣称 CLI 预检或授权记录字段验证了某人的身份或批准。

## 关掉必须消失

定义稳定后，以已记录 Definition 作为执行边界。契约变化时须重新评估 Run 授权和候选证据。

## 不得带走

人类授权（`approval-personal`）；实现（`execute-agent`）；AC 到证据的映射及候选 Review（`verify-basic`）；交付证据和 Close（`close-basic`）。
