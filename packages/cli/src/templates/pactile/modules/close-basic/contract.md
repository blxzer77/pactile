# `close-basic`

P29 表名：`close-basic`（不得改名）。层：baseline。

## 职责

只有最新记录的 Run（且状态必须为 completed）、它冻结的候选快照、绑定到该候选的最新通过的独立 Review、完整 AC 证据和调用者提供的当前候选观察都满足时，才可 Close V2 Task。所有硬依赖必须已成功 Close。

交付证据的 level 必须与 Task 声明的交付层级完全一致：

- `local-result`：引用已产出的本地结果；
- `pull-request`：引用 Pull Request，且必须是绝对 HTTPS URL；
- `merged-result`：引用已合并结果，且必须是绝对 HTTPS URL；
- `documentation`：引用已交付的文档。

level 不一致、候选过期、引用较早的 Review、证据缺失或依赖未满足都会拒绝 Close。不能从 Run 摘要推断交付证据。

## 触发/披露

Review 和证据就绪后加载。调用者对候选的观察必须匹配所选 Run 快照的 ID 和 fingerprint。Kernel 记录 Close 结论和审计历史；目录归档、Git commit、推送或发布都不等于 Close。

## 停止条件

- 没有完整 AC 证据和最新的候选绑定通过 Review，不 Close。
- 有较新的 Run 时，不 Close 旧 Run。
- 不得用其他交付层级或其他候选的证据替代。
- 没有相应证据和另行要求的人类授权时，不得声称已外部合并、发布或通过业务验收。

## 关掉必须消失

Close 后继续保留 Task、Runs、候选、Reviews 和结项证据，作为可读取的生命周期历史。

## 不得带走

如何产出结果（`execute-agent`）；如何检查结果（`verify-basic`）；V1 Task 目录归档；Git、远程、发布或业务动作。
