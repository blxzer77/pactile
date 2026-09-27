# `retrieval-extended`

P29 表名：`retrieval-extended`（不得改名）。层：on-demand。

## 职责

对**已经收集到的**证据做评分、排序、retrieval pack、probe/matrix。它是检索质量层，不是搜索引擎，也不是薄路由。个人默认不把评测栈灌进每个 Task。后续检索优化的**产品落点**是本块内部 + Middleware Provider，不是再写一部上帝检索文档。

## 触发/披露

未触发当没装。Lite 日常 `rg` / 一次 cheap 外部查询看不见本块。触发（可审计）：

1. 任务目录里已有 research / 多源证据，需要 ranking 或收口引用；或
2. `define-extended` 深研结束，要打 pack 而不是再搜一轮；或
3. 维护者跑 probe / 评测矩阵。

**不是**触发：每个用户回合；第一次字面搜索；第一次外部知识探测；仓库装着 codegraph / fast-context。

打分窗口结束，本块从常驻包消失。

Agent 看见：

1. 搜索 ≠ 打分。没有收集到的材料，不得空跑 pack 充 Evidence。
2. 命中是候选，直到被仓库 / 测试 / 第二源证实。Pack 整理已有材料的质量与来源，不代替 `verify-basic` 的 AC 映射。
3. 检索计划和 evidence pack 只在本块激活且有 research 产物时生成。桥接传递失败时只记 assurance / 本地遥测，**不得**假装计划已进 Prompt。成功标准是该打分时打分，不是每回合强制注入计划。
4. 四意图标签来自编译器；本块不把 Agent 工具名（Grep、@codebase、codegraph、WebSearch…）写进 Baseline。Optional Provider 只有 Profile 选了才由 Adapter 绑定。
5. 需要外部知识而 Provider 未就绪：走 Middleware 降级（平台 Web ≠ 等价）。不需要外部知识的 Task 仍可 Close。本块不实现爬虫。

用户看见：普通 Lite 不出现矩阵、pack、per-prompt 计划。没有常驻检索配置向导。维护者评测是另一条面。

## 停止条件

- 三层分界见下方 ABI 表。
- 输入产物：`collected-evidence`（路径 + provider 标签 + 可选 freshness）。输出产物：`retrieval-pack`（排序、分数、provenance）；可选 `probe-report`（维护者）。
- Node 入口：`pactile context --mode retrieval-pack --input <collected-evidence.json> --max-items 8 --output {TASK}/research/retrieval-pack-latest.json --json`；输入 `items[]` 或 `collectedEvidence[]`，每项提供 `path`、`provider`。只处理已有材料；`--include-diagnostics` 才把失败/不可用项纳入 pack 正文。默认排除这些项，且 `closeEvidenceEligible=false`。
- 停止：未激活仍灌检索教战或 stop 打分钩；把 pack 当 AC Evidence；把 smart-search 收进本块；每回合强制检索计划；通道失败却声称已注入。
- 评分算法细节用指针，不在本块另写上帝文档。算法/ranking 特征/pack schema 版本属于本块内部，后续可改。

## 关掉必须消失

无 pack、无 per-prompt 检索计划、无 stop 打分钩。四意图路由仍在；smart-search 仍可按需。不需要外部知识的 Open→Close 仍成立。

## 不得带走

薄 router（`context-progressive`）；smart-search 本体与就绪（Middleware）；要不要研、写到哪（`define-extended`）；journal 搜索（`personal-memory`）；AC→Evidence（`verify-basic`）。

## 检索三层 ABI

冻结。后续优化检索时不得拆掉，否则会重新变成上帝文档。

| 层 | Owner | 认什么 | 不认什么 |
| --- | --- | --- | --- |
| 意图 | `context-progressive` | `exact` / `semantic` / `structural` / `external` | 工具名、分数、pack、每回合计划 |
| 提供 | Middleware | capability 就绪与降级；默认 `external-knowledge` → smart-search；Optional 的 codegraph / fast-context 经 Profile 选择 | PACTILE Kernel 发版锁步；平台 Web 冒充等价 |
| 质量 | `retrieval-extended` | 对已收集证据打分、pack、probe | 自己去搜；自己当 Close Evidence |

不新增第五个常驻检索意图，除非同时改编译器契约。

## 后续不可改

后续优化**可以**改（不必回头改本重构的生命周期）：

- 本块内部的评分算法、ranking 特征、pack schema 版本。
- 维护者 probe / 评测矩阵。
- 新 Optional Provider：Manifest + Adapter 绑定到已有意图，不新增第五个常驻意图，除非同时改编译器契约。
- 注入通道：仅在宿主已验证交付检索计划后消费；不能则记录未交付状态，产品不假绿。
- smart-search 独立发版、独立 CLI。

后续优化**不可以**改（改了等于放弃模块化）：

- 把旧 8 意图或工具名写回 Baseline 常驻 Prompt。
- 把 smart-search 收进 Kernel / 本块 / `pactile update` 锁步。
- 每个回合强制 pack 或强制 `beforeSubmitPrompt` 计划。
- 用 pack 代替 `verify-basic`。
- 把 `retrieval-daily-guide.md` 当 SessionStart SSOT。
- 为了「检索好改」把三层重新合并进 `workflow.md`。

现状债务：Node 检索路由、证据打分与桥接仍需统一；搜索与 pack 在文档里仍易混用。完成态是所有权先分清，再在本块和 Provider 里演进算法。
