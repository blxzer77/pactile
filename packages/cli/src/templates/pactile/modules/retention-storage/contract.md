# `retention-storage`

P29 表名：`retention-storage`（不得改名）。层：on-demand。

## 职责

Closed Task 的**物理**处置：目录搬家（如 `archive/`）、压缩、保留期限、冷存储。不写业务 Outcome，不撤销 Close。Close 与 Archive 分离：`close-basic` 完成生命周期；本块可以在 Close **之后**跑。Retention 失败不得改 Outcome；只留下 Condition / 修复证据。本需求**不包含** Event Sourcing；更高级存储若将来出现，也只是 Policy 可选实现，不是完成条件。

## 触发/披露

维护者 / 磁盘策略。Agent 日常 Open→Execute→Verify **不看见**本块。触发（可审计）：

1. Outcome 已写入之后的物理收纳；或
2. 维护者明确要压缩/清理；或
3. Policy 的保留期限到期。

**不是**触发：把 `pactile task archive` 当成 Close；Execute 当天；用搬家证明做完了。

永远不进默认 Prompt 第 2 层（可与 `observability-local` 类似：零教战成功）。

Agent 看见：

1. 不得用「目录已在 archive/」宣称 completed。
2. 不得在未 Close 时搬走活任务目录。
3. 删除、覆盖原目录、不可逆压缩：先问（人 / Policy）。个人默认搬家不是静默删除。
4. 搬家后若路径变了，通知 Kernel 更新投影；本块不写 Phase/Outcome。
5. 不拥有 Git；不拥有 session temp handoff。

用户看见：日常收工只关心 Outcome。磁盘策略、压缩、过期清理不出现在每回合。关掉本块时，Closed Task 可以留在原地。

## 停止条件

- Close 已完成才可物理处置。
- 失败不回滚 Outcome。
- 停止：物理搬家冒充 Close；未 Close 就 archive；静默删除用户工作；把 Event Sourcing 当成本需求验收。

## 关掉必须消失

不能把搬家当完成条件。Outcome 照写。活任务目录不被本块搬走。CLI 仍可有业务 Close，只是不移动文件。

## 不得带走

业务 Close / Outcome（`close-basic`）；Git commit（`vcs-integration`）；过境文档（`session-transfer`）；journal（`personal-memory`）。
