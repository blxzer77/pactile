# `retrieval-extended`

P29 表名：`retrieval-extended`（不得改名）。层：on-demand（optional）。

## 职责

对已经收集的多源证据评分、排序和生成 retrieval pack；提供维护者按需评测入口。它是质量层，不是搜索引擎、默认检索规划器或 Close Evidence。Node 版能力保留，不依赖 Python。

## 触发/披露

有已收集材料需要排名/收口引用，或获授权的 probe/评测时加载；第一次字面查询、每个用户回合或安装着检索工具都不触发 pack。输入为路径、provider、可选 freshness；输出为排序、分数、来源及诊断。

Node 入口：`pactile context --mode retrieval-pack --input <collected-evidence.json> --max-items 8 --output <task>/research/retrieval-pack-latest.json --json`。输入 `items[]` 或 `collectedEvidence[]`，每项提供 `path`、`provider`。默认排除失败/不可用项；`--include-diagnostics` 才纳入这些诊断。产物标记 `closeEvidenceEligible=false`，不能直接充 AC 证据。

Session 有事实缺口时的薄意图规划（含可回退 Jev 建议）独立于本模块；项目外发策略、显式意图和 Provider 就绪边界仍有效。桥接未实际交付时记录失败/不可用，不声称已注入。

## 停止条件

- 没有材料不空跑 pack 充 Evidence；检索命中须用当前源码/测试或独立来源佐证。
- pack 不执行外部搜索；额外网络、模型或评测动作仍需适用授权，不能由 provider 标签授予。
- 不把本模块 off 解释为停用 Session 薄规划或所有外部工具；不要求每回合评分。
- 输入不可读、Provider 不可达或来源无法核实时明确质量缺口；不拿降级结果冒认原保证。

## 关掉必须消失

评分、pack 和专项评测不再披露；四意图、Middleware 按需搜索及 Session 事实缺口规划继续存在。

## 不得带走

`context-progressive` 薄规划；Middleware Provider/降级；独立发版的 smart-search；Task 定义、AC 映射和 Kernel Close。

## 检索三层 ABI

| 层 | Owner | 边界 |
| --- | --- | --- |
| 意图 | `context-progressive` | `exact` / `semantic` / `structural` / `external`，不绑定工具或排名 |
| 提供 | Middleware | Provider 就绪/降级与 Adapter 绑定，不把平台 Web 冒充同等保证 |
| 质量 | `retrieval-extended` | 已收集材料的评分/pack，不自行搜索或充当 Close Evidence |

## 后续不可改

可以独立演进评分、pack schema、Provider 和注入通道，但必须保留分层和真实交付证据。不新增第五个常驻检索意图；不把工具名写回 baseline，不强制每回合 pack，不让 smart-search 与 Kernel 发版锁步，不把三层重新合并进 `workflow.md`。
