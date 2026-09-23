# Projection 与 Ownership

[English](projection-and-ownership.md) | 简体中文

Pactile 把项目真相保存在 `.pactile/`，再通过可重建的 Projection 把同一份真相呈现给每个宿主。Ownership 记录约束这些宿主侧资源如何修改或移除。

## Projection

### 定义

Projection 是一个 canonical generation 的宿主特定视图。Adapter 观察目标宿主并生成 Projection Plan；之后只有 Reconciler 可以把该计划应用到宿主文件或外部 binding。

### 职责

- 把 canonical capabilities 与 instructions 转换为 Codex 支持的集成面；
- 使用 `ensure`、`merge`、`remove`、`bind`、`detach` 等稳定 operation；
- 声明期望内容与 fingerprint，但不直接写文件；
- 为每个 Adapter 提供独立的 result、receipt 与 retry 边界；
- 可由同一 canonical generation 和宿主观察状态重新生成。

### 边界

Projection Plan 不能指向 canonical `.pactile/` 状态或只读 legacy roots。Borrowed asset 只能 bind 或 detach，不能改写。一个 Projection 失败不会使已 sealed generation 或成功的 sibling Adapter 失效。

## Ownership

### 定义

Ownership 是 canonical ledger：它把一个逻辑 resource id 对应到唯一 physical target，并记录 owner、control mode、claimants、snapshots、conflicts 与 proposed disposition。

### 职责

- 区分 Pactile-owned、borrowed 与 unknown control；
- 保留 `preimage`、generated 与 observed current snapshots；
- 防止两个 resource id 声明同一 physical target；
- 在仍有任一 Adapter 或 Tile claimant 时保留共享资源；
- 判断 write、no-op、preserve、review、restore preimage 或 remove generated 何时安全。

### 边界

不能根据文件名、目录、package，或 Pactile 能否读取某资源来推断 Ownership。Adoption 不会抹去外部 owner。Claimant 只表示仍在使用，不获得删除权限。Unknown、borrowed 或 modified 资源会安全降级到 preserve 或 manual review。

## 资源分类

| 条件                                                       | Pactile 可以做                                   | Pactile 不能做                         |
| ---------------------------------------------------------- | ------------------------------------------------ | -------------------------------------- |
| Pactile 创建、未修改、无 claimant                          | 通过所需 lifecycle 检查后移除 generated resource | 仍有 claimant 时移除                   |
| 已 adopt、未修改、保留 preimage、无 claimant               | 恢复保留的 preimage                              | 杜撰 preimage 或覆盖 modified bytes    |
| Borrowed native Skill、Plugin、MCP installation 或 service | bind、检查 readiness、detach binding             | 复制 credential/content 或卸载外部资产 |
| 当前 bytes 与 generated snapshot 不同                      | 保留并进入 review                                | 仅因路径受管就覆盖或删除               |
| Owner 或 origin 未知                                       | 保留并要求 manual review                         | 根据位置或命名猜测所有权               |

## 共享 claimant 场景

```text
共享 Skill target
  claimant: Codex Adapter

detach Codex
  -> claimant 清零
  -> 仅当 Pactile-owned 且 current == generated 时移除
  -> 否则按 ledger 规则保留或恢复
```

因此 detach 不是递归删除。它先改变 claim，再由 Reconciler 根据当前 bytes 与记录的 ownership 评估资源。

## 三方安全比较

受管文件的安全 reconcile 会比较三个视图：

1. adopt 既有文件时保留的 preimage；
2. 上一次 generated snapshot；
3. 当前观察到的 bytes。

如果 current 仍等于 generated，Pactile 可以应用下一项已审 operation；如果不同，就可能存在用户或第三方修改，因此保留资源。该规则适用于 update、detach、uninstall、rollback 与 recovery。

## 用户场景

一个 Codex 项目已有用户安装的 Skill。Pactile 发现并绑定该 external asset，不复制内容。Ledger 保留 user/host owner 和 borrowed control。之后 `pactile uninstall --dry-run` 可以描述将要 detach 的 binding，但不能认领或删除已安装 Skill。

## 应检查什么

- active generation 标识每个 Adapter 使用的 canonical source；
- Projection Plan 表示期望 operation，不等于写入已完成；
- receipt 表示哪些 operation 已 applied、degraded 或需要 review；
- Ownership ledger 解释共享、borrowed、unknown 或 modified target 为何被保留。

继续阅读[架构](architecture.zh-CN.md)、[Kernel、Evidence 与 Trace](kernel-evidence-trace.zh-CN.md)和严格的 [v1 projection 与 ownership 契约](../pactile/contracts-v1.md#projection-and-ownership)。
