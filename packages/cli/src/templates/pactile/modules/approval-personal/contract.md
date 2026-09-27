# `approval-personal`

P29 表名：`approval-personal`（不得改名）。层：baseline。

## 职责

区分人类授权、Kernel 校验和执行记录。

1. **创建 Task：**先取得用户对交付物、AC、交付层级和已知硬依赖的明确同意。V2 Kernel 从 Define 开始；不要在 Kernel 中虚构 Open 阶段。
2. **授权 Run：**开始执行前取得对指定范围的授权。V2 Run 会记录 `approvedBy`、`approvedAt`、`scope` 和证据引用；这些字段保留调用者声明和证据指针，本身不验证身份。
3. **授权外部动作：**按需取得 commit、远程推送、合并、发布或其他重要外部动作的人类授权。Close 是独立的 Kernel 转换。

## 触发/披露

在决策边界提问，不在每个阶段反复询问。创建 Task 的请求不授权超出 Proposal 交付物的工作。Run 授权只适用于已记录范围和契约。

## 停止条件

- 用户未同意 Task Proposal，不创建 Task。
- 没有明确 Run 授权，不开始实现 Run。
- Kernel 预检 PASS 只表示记录的门看起来满足，不代表人已批准。
- V2 `--approved-by` 与授权证据字段是调用者提供的记录，不是身份验证。V1 的 `--approved` 也不得教成身份或授权证明。
- 交付物、AC、交付层级、依赖或授权范围发生实质变化时，继续执行前必须重新取得人类审查。

## 关掉必须消失

决策记录继续保留审计。不得把日常状态回复或一次 commit 当作隐式授权。

## 不得带走

Kernel 转换和依赖校验；定义内容（`define-basic`）；执行方式（`execute-agent`）；证据是否满足 AC（`verify-basic`）；外部系统是否真实完成动作。
