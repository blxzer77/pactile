# `independent-check`

P29 表名：`independent-check`（不得改名）。层：on-demand。

## 职责

为准确候选提供独立审查方法：对照任务要求、代码规范、边界和实际风险，报告 blocker、可选建议及证据。该可选专项模块不决定 V2 是否需要 Review；每个 V2 Close 仍须通过 Kernel 的候选绑定独立 Review 门。

## 触发/披露

最新 Run 已完成且候选快照可读，需独立检查或复核风险时加载。Reviewer 与该 Run 的执行者和授权者不同；从定义、当前候选及验证记录重建结论，不复制实现者自评。

审核候选和业务状态只读，不在审核中修补代码；必要临时/报告写入需明确授权路径。保留 Pi 默认 MCP、Skill、tool、扩展和模型配置，并按职责/Task 授权限制具体动作。提示词不能提供执行保护；当前默认 RPC 尚无职责动作拦截/OS 沙箱，需要的保护不可用时停止危险派发，明确缺失保证。

日常审查可由已配置的独立 Pi 承担；难以消除的不确定性可交给获授权的 Codex 桌面审核任务。角色或工具名不是强制宿主依赖。参见 [风险驱动验证](../../framework/verification-strength-guide.md) 和 [派发边界](../worker-orchestration/contract.md)。

## 停止条件

- 记录 Run、candidate ID/fingerprint、每条 AC 证据、结论和 blocker；最新非通过判定不能被旧 PASS 绕过。
- 候选、定义或验证来源过期时停止并重新获取；改动候选需新 Run 和新候选 Review。
- 不能自评代替独立 Review，不能把正常退出、格式正确或未发现问题单独算验收。
- 针对具体风险检查，不复制代码托管 CI 的大型 Review 工程；扩大检查须有剩余风险或必需 gate。
- 工具越权、证据不足或实际隔离无法证明时，记录阻塞而非降级为“提示词已保护”。

## 关掉必须消失

本模块的专项审查方法/路由不再注入；Kernel Review 的独立性、候选绑定和 AC 门不消失。

## 不得带走

执行修复；批准与权限授予；验证命令执行结果；Kernel Review/Close 存储和最终关门判断。
