# `parent-child`

P29 表名：`parent-child`（不得改名）。层：on-demand。

## 职责

仅维护明确识别为 V1 的历史 Parent/Child 流程。V2 的任务都是独立可验收交付结果，通过硬依赖、Run 写集和调度合同协作；没有 Parent 独占的集成权，也不使用本模块。

## 触发/披露

只有统一 Task 读取器识别 `legacy-task-kernel-v1` 后，才按该任务原有拓扑与批准考虑兼容流程。目录中存在 `task.json` 或旧文案本身不能证明正在使用 V1。

V2 Task 的 Tile offer 和 Session Pack 排除本模块；目录及 manifest 保留供旧安装和历史组合加载，不把历史规则迁移成新限制。

## 停止条件

V1 原流程中：Decompose **只出提案**；用户确认后才建 Child；未确认不得建 Child。旧状态、基线、交接及集成证据须按其原合同保存，Git merge 仍需适用授权。

- schema 未识别、迁移待补字段/待协调时，不执行旧命令或猜测拓扑。
- V2 不调用旧 `add-subtask`、`prepare-child-worktree` 或 `integrate-child` 来制造新 Parent/Child 关系；采用 Task/Run 和 managed worktree 能力。
- 不把 Parent、Child 或旧并发槽位写成新任务的强度/并发限制。
- 阅读旧合同、接收交接或记录集成证据都不授予代码、Git 或远端写权限。

## 关掉必须消失

V1 的 Parent/Child 专项指引不再披露；V2 的依赖、授权、隔离、冲突和独立 Review 门继续由当前 Kernel/调度器维护。

## 不得带走

V2 Task 定义/硬依赖；Run admission 与资源租约；worktree 管理；实际 Git 合并；独立 Review 与 Close。
