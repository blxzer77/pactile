# `context-progressive`

P29 表名：`context-progressive`（不得改名）。层：baseline。

## 职责

按统一读取器识别的 Task schema、Kernel 阶段/条件、模块激活事实和产物角色编译 Session Pack。V2 定义来自 Kernel，不从旧 `task.json` 或 Markdown 推断状态。保留 `exact` / `semantic` / `structural` / `external` 四类检索意图；工具与 Provider 由适配面绑定。

## 触发/披露

通过 `pactile context --mode session --json` 查看编译结果，逐层取最少必要信息：

1. 当前阶段、约束与下一动作。
2. 当前阶段所需且已激活的短契约；注册、选择建议和执行授权是不同事实。
3. V2 Kernel 定义及产物索引；用 `pactile task artifacts <task> --agent` 获取指纹引用，再按 fact/document/section 展开。原始 V1 文件片段只在读取器明确识别旧任务时使用。
4. 有事实缺口才规划检索；排序和证据 pack 属于 `retrieval-extended`。Jev 建议受项目外发策略约束，不改变显式意图或授予权限。
5. 卡住时提供 `debug-recovery` 指针，再按实际原因读诊断材料。

没有选中 Task 时只做 Intake 提案，不载入任务产物或执行指引。目标 schema 未识别、迁移待协调或 Kernel 读失败时停止，不回退为可执行的 V1。

## 停止条件

- 当前编译器最多保留 8 项、4000 estimated tokens；单个模块正文最多读取 2200 字符。遗漏项带原因，关键边界不能靠被截掉的正文传递。
- 包里没有某模块，不表示未安装；本包不替未披露模块激活，也不授予执行权限。不得补读全部方法论来绕过披露边界。
- 源码、文档或 section 指纹过期时先重新取索引；不要把旧引用当当前证据。
- `workflow.md`、AGENTS 长文和 `[workflow-state:*]` 不是运行时 SSOT；V1 的强度/拓扑过滤不适用于 V2。
- 不新增第五个常驻检索意图，不把工具名写入 baseline。

## 关掉必须消失

没有 Pactile 编译上下文包；宿主可能仍可启动，但不能声称已交付渐进披露。传输或注入是否成功由实际宿主收据证明。

## 不得带走

模块正文所有权；Kernel 生命周期/批准；Artifact 指纹读取；Middleware Provider；检索评分/pack；journal 的授权存取。
