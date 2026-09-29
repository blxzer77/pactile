# Pactile 内部 Skill 与调用契约审计

本记录审计产品维护源及其生成链，不包含个人、第三方或系统 Skill。对应 Plane PACTILE-47；职责动作保护与沙箱为 PACTILE-48 的独立实现项。原安装副本、历史任务和发布清单不在本次写集。

## 维护源与调用链

| 表面 | 维护源 | 调用与权威边界 |
| --- | --- | --- |
| 八份基础 Skill | `packages/cli/src/pactile/tiles/content/baseline/index.ts` | Tile 构造器生成 manifest/正文；宿主通过 projection store 生成规范 name/description 头部。入口不保存另一套 Task 状态。 |
| 十一份按需 Tile | `packages/cli/src/pactile/tiles/content/ondemand/index.ts` | registry 读取内容、阶段、能力和 Task 批准；决策仅生成收据，不自动激活模块或授予执行权限。 |
| 十九份模块契约 | `packages/cli/src/templates/pactile/modules/index.json` 及各模块 `contract.md` | 目录负责寻址；Session Pack 按当前阶段及激活事实披露正文，不解析 workflow 长文作为状态。 |
| 运行时事实 | `src/core/task`、`src/pactile/artifacts`、`src/pactile/task/session-pack.ts` | 统一读取器识别 V1/V2；V2 来自 Kernel，Agent 索引及文档/section 通过指纹展开。 |
| 人可读指南 | `src/templates/pactile/workflow.md`、`src/templates/markdown/framework` | 解释当前能力与选择规则；不替代 Kernel、批准、Review 或宿主收据。 |
| 安装/更新 | templates 构建复制、generation、host projection store | 在产品源修改，经正式安装/冲突处理生成宿主文件；修改过的用户文件保持受 ownership 保护。 |

上表中的 `src/` 均指 `packages/cli/src/`。按需模块不另造一套独立 slash Skill；需要时由其 Tile/索引引用加载。未提供所有脚本的副本，不增加必需运行时或外部依赖。

## 逐条结论

| 模块 | 实际缺口或保留理由 | 本轮处置及必要调用 |
| --- | --- | --- |
| intake-basic | 模块已正确区分提案与建 Task；短入口未说明可独立验收、交付层级和依赖 | 完善入口；事实先查、提案获同意再 create，保留模块契约 |
| define-basic | Kernel 定义合同正确，复用优先已存在 | 保留模块；入口明确 Kernel/Markdown 边界及 Decision/Rationale/Risk，不另加规划实现 |
| approval-personal | 合同已支持复用适用授权，入口只说缺批准就停 | 入口说明复用、分别授权和记录不验证身份；保留模块与 Kernel 门 |
| execute-agent | 模块已按 Run、写集和历史尝试执行 | 入口引导已授权准入 Run、保全 unrelated work、变更范围停止；保留模块 |
| verify-basic | 精确候选与独立 Review 正确；引用验证指南仍按旧任务强度/profile 分档 | 保留候选合同，补风险选择及真实角色保护边界；重写引用指南，verify-plan 只作规划 |
| close-basic | 最新 Run/Review、AC、硬依赖和交付层级门已正确 | 保留模块；入口明确 Kernel Close 和不能冒认发布 |
| context-progressive | 混用“未注入”和“未安装”；预算被说成未实现；含旧 Lite/Parent 强度 | 修正模块及 pack 提示，披露当前预算、V2 指纹事实、schema 失败不回退；保留四意图 |
| observability-local | 本地收据和敏感数据边界已正确；能力摘要中的 secret-safe 被 Jev 当成敏感标记而误拦截 | 保留模块和外发拦截；摘要准确描述脱敏本地记录，入口区分实测/估计/不可用，不外发 raw prompt/秘密 |
| define-extended | 旧 Full/Lite、遗失 brainstorm 路径和旧执行 gate | 风险/歧义按需规划；更新问题前沿指南；只保留历史 Grill 思路，不建强制 Subagent |
| independent-check | 旧 Full 才独立审核、Lite 自评和自评回退会绕过当前 Review | 专项深度可选，Kernel 独立 Review 必需；候选只读、能力默认、动作实际保护不足则停止 |
| worker-orchestration | 旧 Parent 槽位、强制并行及 prompt-only 保护 | 前一局部修正已清理；本轮纳入累积候选，沿用关键路径、角色和真实保护事实 |
| parent-child | 旧树形权威及并发规则仍会成为 V2 的 Tile 候选 | 内容明确 V1-only；V2 registry 排除，显式 override 不得绕过，V1 catalog/组合保留 |
| debug-recovery | 指令承诺 V2 未提供的 Return-to-Define 转换 | 保留失败事实、按新假设局部检查、新 Run 重试；合同改变用支持的授权路径/新 Task |
| session-transfer | 旧 slash/Child 交接入口及身份/状态承接不清 | Task/Run/candidate、授权、工作区、dirty 和证据索引；接收方先实查，不自动恢复/派发 |
| spec-learning | 同时要求确认与宣称缺确认不阻止写入；假设未实现学习 Close 门 | 适用原授权可复用，缺确认不能变权限；去掉自动写入/必填 disposition 的错误保证 |
| vcs-integration | 假设所有 Git 都不影响 Close、Parent 专属集成及仅 Parent 隔离 | 按实际交付层级与独立 Git 授权；manager integrate 是校验而非 merge，reclaim 走实际门 |
| personal-memory | 宣称自动 Close→Notes，但源码没有调用者 | 明确现有 session add/search；仅授权存取、Task-first，无全量 journal 注入或新增 Close gate |
| retention-storage | 存储移动被暗示会自动维持 Kernel 引用；Task 与 worktree 清理混用 | 核对精确目标、所有权、在用/dirty/ignored/唯一历史；无支持的保全操作就保留 |
| retrieval-extended | 旧 Lite 条件、pack 与薄意图规划混用，含已过期迁移债务 | 保留 Node pack 和三层 ABI；pack 仅评分已有材料、非 AC/Close Evidence，薄规划独立 |

## 引用指南的实际能力修正

运行中还发现 V2 Execute 默认选择请求固定为 worker.handoff。经用户解释和裁决，已将 V2 默认会话 profile 改为 execution.result：普通执行以可交付结果为基线，派发按需选；显式 worker.handoff 请求仍校验其批准/能力，V1 profile 不改。移除 Parent/Child 后单相关候选跳过 Jev 是有效优化；模型对照须采用真正相关的多个候选，不能恢复旧拓扑凑选择。

- `prd-grill-frontier`：移除遗失 bundled brainstorm、旧 Parent/Child 清单、固定 profile 和 start-execution 默认入口；问题由事实、前置依赖和真正阻塞决策决定。
- `execution-strategy`：使用 V2 Run/scheduler/Pi 实现路径；明确 Codex 桌面用于规划/协调/审核，当前 V2 Execute dispatch 仍被产品拒绝。
- `codex-worker-dispatch`：保留原生 prepare/receipt/status；不把旧 Child 槽位描述为 V2，transport receipt 不冒认实施或保护。
- `verification-strength-guide`：按 AC、公开行为、数据/权限/并发/兼容风险和必需 gate 选最小充分检查；不按 Lite/Full、文件数量或文档存在推导强度，不添加文字镜像测试。
- `artifact-locale-guide`：当前 V2 create 写一次英文引用 scaffold；语言由作者/用户选择，旧 locale --task 只支持 task.json，不能承诺自动翻译或手改 Kernel。
- framework index 保持有效入口；workflow、critical-path 和 reuse-first 的当前合同不重写。

## 收据和证据的边界

本轮测试须分别记录内容/元数据、真实 CLI/Core 状态行为、安装投影和模型行为。Jev 模拟进程测试证明候选输入与采纳合同，不是 TypeSafe 实连或模型质量验收；静态格式、测试 PASS、host 退出也不是受保护 Pi Review。

Session Pack 当前上限为 8 项、4000 estimated tokens，单个模块读取 2200 字符；基础 Skill 既有轻量入口预算保持小于 500 字符。具体计数及安装引用以本 Task 的验证记录为准，不以删掉停止条件满足预算。

此前局部 Task 的“Session Pack 3”测试标签误记：实际为三项 Task 选择/会话指针测试。原 9/9 结果仍为模块目录 5、按需组合 1、会话指针 3；原证据封存不改写，本轮补记真实编译路径。

## 本轮定向验证

| 检查组 | 覆盖及结果 |
| --- | --- |
| 目录、基础/按需 Tile、选择 CLI、真实 Session Pack/迁移边界 | 24 项通过；默认目标调整后另复跑选择 CLI 的 4 项 |
| Task Kernel、风险验证规划、默认投影/ownership | 34 项通过，包含修改过的用户 Skill 保留 |
| Session Jev CLI、批准/外发策略、精确采纳/回放及陈旧拒绝 | 13 项的最终结果通过；失败项修复后仅局部复跑 |
| 构建、源码类型检查、改动 TypeScript lint、diff 格式 | 通过 |
| 正式隔离 init 的源/构建/安装/封存比对 | 19 份契约、6 份指南、8 份 Skill 通过，引用可达；模块最大 1729 字符，Skill 正文最大 442 字符 |

测试共覆盖 71 个不同用例，采用分组和失败项复跑，没有重复全量回归。Jev 的模型响应为模拟输入；最后一次隔离安装显式跳过外部 readiness，不能据此宣称外部服务已通过验收。新候选的独立 Review 仍待完成。

## 未完成边界

P48 的职责动作策略、平台沙箱适配及真实只读/越权拒绝尚未实现；当前 Pi 默认能力可用，但不能据此声称执行受保护。本轮不以自评替代准确候选的独立 Review，不自行 Close P47。既有模型任务、Git/远端、发布和本机宿主同步不由本轮审计自动授权。

最终定向命令、结果、生成一致性、ownership 保留和候选标识记录在根 Task `p47-internal-skill-alignment`，不将个人测试产物或凭据写入产品 Git。
