# `execute-agent`

P29 表名：`execute-agent`（不得改名）。层：baseline。

## 职责

按已记录的 Task Definition 执行一个获授权的 V2 Run。一个 Task 可以保留多个 Run；每次尝试和结果都要留在历史中。前一次结束后重试应新建 Run，不覆盖先前记录。每个成功 Run 都有独立冻结的候选快照供后续 Review。

写入前遵守 Run 的授权范围和 `writeSetSnapshot`。记录可获得的等待、执行、Review 时长估算及实测引用，供后续调度评估成本。估算本身不能证明工作已开始或完成。

## 触发/披露

只有在取得该 Run 的人类授权、且 Kernel 校验 Task 硬依赖后才执行。一个 Task 同时最多有一个 active 或 waiting Run。使用平台 Adapter 的真实执行绑定；未发生隔离或委派时不得声称已发生。

不同 Task 的 Run 只有经过派工协调器准入后才可并发。硬依赖必须先成功 Close。写集重叠默认串行；显式允许重叠时，必须记录授权与集成计划。仅有 worker 请求或本合同本身不构成并行许可。

## 停止条件

- 工作不得超出交付物、AC、已批范围和 Run 写集。
- 成功时记录候选条目和证据；失败、取消或阻塞时如实记录该 Run 的终态。
- 实现发现定义或授权不正确时停止，在获支持的定义/授权更新后再继续。
- 不得把计划中的 Run 报告为已完成工作。

## 关掉必须消失

Intake、Define、Review 和 Close 阶段不加载实现教战。保留 Run 历史和候选身份供后续生命周期使用。

## 不得带走

Task 定义和 AC（`define-basic`）；人类授权（`approval-personal`）；派工/准入政策；候选 Review（`verify-basic`）；交付验收（`close-basic`）。
