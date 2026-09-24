# Pactile 核心概念

[English](index.md) | 简体中文

Pactile 将持久项目真相与各 AI 宿主的消费方式分开。模型组合小而受治理的能力；Kernel 校验持久边界；Adapter 生成投影；Evidence、Trace 与 Ownership 让结果可检查、可恢复。

## 五个核心概念

| 概念                                                       | 定义                                                          | 职责                                                                 | 边界                                                                      | 典型场景                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [Tile](tiles.zh-CN.md)                                     | 小型、有版本的能力契约。                                      | 声明输入、输出、策略上限、assurance、Evidence、fallback 与停止条件。 | 不包含宿主路径、工具脚本、提示词记录或中央计划。                          | 增加结构化代码检索，而不加载整套研究 playbook。            |
| [Kernel](kernel-evidence-trace.zh-CN.md#kernel)            | 宿主无关的持久状态与转换校验器。                              | 检查任务、生命周期、gate、archive 与记录契约。                       | 不替模型选择 Tile、推理，也不写宿主文件。                                 | 缺少定义或授权证据时拒绝任务进入执行。                     |
| [Trace](kernel-evidence-trace.zh-CN.md#trace)              | 按顺序记录可观察组合事件的日志。                              | 关联选择、调用、结果、Provider 解析、artifact 与 Evidence。          | 不包含私有推理、prompt、secret 或任意内联输出。                           | 说明运行了哪个能力、结果由哪些 Evidence 支持。             |
| [Projection](projection-and-ownership.zh-CN.md#projection) | 一个 canonical generation 的可重建宿主视图。                  | 表达 Codex 文件、managed block 与外部 binding。                      | 不能成为 canonical 状态，也不能写入 `.pactile/`。                         | 协调 Codex 项目文件，无需重写项目真相。                   |
| [Ownership](projection-and-ownership.zh-CN.md#ownership)   | 记录资源 owner、control、snapshot、claimant 与冲突的 ledger。 | 判断 reconcile、detach、restore 或 remove 是否安全。                 | Claimant 不会获得删除 borrowed、foreign、unknown 或 modified 内容的权限。 | 分离 Codex 时保留 borrowed Skill。                        |

Evidence 是连接层：它以稳定引用指向 artifact、检查、receipt 或 Provider 结果，为声明提供依据。它不是第六个规划器，也不包含隐藏推理。

## 如何协作

```text
用户意图
  -> 模型选择并排序 Tiles
  -> Kernel 校验契约与生命周期 gate
  -> canonical generation 封存在 .pactile/
  -> 每个 Adapter 生成 Projection Plan
  -> Reconciler 根据 Ownership 安全应用操作
  -> receipt、Evidence 与 Trace 记录发生了什么
```

失败只影响发生问题的边界。非法 Tile 在组合前被拒绝；某个宿主投影失败，不会回滚已 sealed 的 canonical generation 或成功的 sibling Adapter；modified 或 borrowed 资源会保留并进入审阅。

## 权威映射

| 状态                                                               | 权威                   | 可重建？                                      |
| ------------------------------------------------------------------ | ---------------------- | --------------------------------------------- |
| `.pactile/` generation、workflow、任务、Tiles、ledger、receipts    | Pactile canonical 状态 | 否，这是持久来源。                            |
| 可选 `.codex/`、受管 `AGENTS.md`、Pactile-owned 共享 Skills | Adapter 投影 | 是，但必须通过 ownership 检查；Codex 叶子取决于原生支持。 |
| 宿主原生 Skills、plugins、MCP 安装、凭据、用户文件                 | 用户、宿主或第三方     | 否；Pactile 只能在策略内发现、adopt 或 bind。 |

## 继续阅读

- [架构](architecture.zh-CN.md)：组件、权威与故障隔离。
- [Tiles](tiles.zh-CN.md)：能力组合与策略上限。
- [Kernel、Evidence 与 Trace](kernel-evidence-trace.zh-CN.md)：持久校验与可观察性。
- [Projection 与 Ownership](projection-and-ownership.zh-CN.md)：宿主协调与安全退出。
- [Spec 系统](spec-system.zh-CN.md)：渐进式项目知识。
- [Task 系统](task-system.zh-CN.md)：持久工作、gate、Parent/Child 拓扑与关闭证据。
- [仓库五分钟上手](../../README.zh-CN.md)：安装与首次 readiness 检查。
