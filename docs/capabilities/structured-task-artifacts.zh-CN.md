# 结构化任务事实与渐进读取

PRD、Design、Implement、Review 和 Verify 使用同一份结构化事实封套。阶段视图只保存事实 ID；人类与 Agent 看到的内容都从封套生成。P35 的流程接线和 P36 的旧文档迁移由各自切片完成。

## 封套

`TaskArtifactEnvelopeV1` 包含 `schemaVersion`、`taskId`、`facts` 和稀疏的 `stageRefs`。一条事实只在 `facts` 出现一次。`stageRefs` 的键是实际用到的阶段，值是稳定事实 ID；没有事实的阶段省略，不能放空数组。

轻任务可以只有一条事实，并让 PRD 与 Verify 引用同一个 ID：

```json
{
  "schemaVersion": 1,
  "taskId": "small-fix",
  "facts": [
    {
      "id": "fact:acceptance-1",
      "kind": "requirement",
      "status": "accepted",
      "title": "Preserve the selected behavior",
      "summary": "The fix keeps the existing public behavior.",
      "source": { "kind": "user", "ref": "user://request/scope" },
      "provenance": {
        "recordedAt": "2026-09-25T04:00:00.000Z",
        "actor": "requester",
        "method": "direct"
      },
      "ref": { "path": "prd.md", "selector": "acceptance#behavior" }
    }
  ],
  "stageRefs": {
    "prd": ["fact:acceptance-1"],
    "verify": ["fact:acceptance-1"]
  }
}
```

每条事实包含稳定的 `id`、`kind`、`status`、短 `title`/`summary`、`source`、`provenance` 与 `ref`：

- `id` 是小写逻辑 ID，例如 `fact:acceptance-1`。内容或状态改变时保留身份；事实被替换时将旧项标记为 `superseded`，并创建新 ID。
- `status` 表示事实本身的状态：`active`、`accepted`、`blocked`、`rejected`、`superseded` 或 `verified`。它与候选的新鲜度是两回事。
- `source.kind` 与安全的不透明 `source.ref` 标明事实从哪里来。引用只带定位句柄，不嵌入凭据、长段原文或推理。
- `provenance` 记录 `recordedAt`、`actor` 和 `method`。`derived` 事实必须通过 `basedOn` 指向至少一个已有事实 ID。
- `ref.path` 是任务目录内的 POSIX 相对路径，`ref.selector` 是稳定标题、块 ID 或 JSON pointer。它用于按需读取更完整的上下文；短摘要不取代被引用的证据。
- `candidate` 事实必须带 `candidateFreshness`。`fresh`/`stale` 必须同时有检查时间和证据引用；`unknown` 不得伪装成已检查。其他事实不出现此字段。

校验器拒绝重复 ID、悬空阶段/派生引用、未被任何阶段引用的事实、路径穿越、source scheme 与 source kind 不匹配，以及没有证据支撑的新鲜度声明。

## 投影和读取顺序

人类 Markdown 为每个非空阶段列出事实 ID，然后在单独的 Facts 区域完整展示每条事实一次。Agent 投影是紧凑索引：阶段仍只列 ID，事实索引只出现一次，并带摘要、状态、来源、provenance 和 locator。

Agent 先读取索引，根据当前决策选定事实 ID，再读取对应的 `ref.path#ref.selector`。投影不自动展开所有被引用正文。轻量任务只记录实际适用的事实和阶段，不需要填满 PRD/Design/Implement/Review/Verify 五份空模板。

当前切片提供封套校验与两种纯投影，不读写任务目录，不改变任务生命周期，也不迁移旧 Markdown。后续接线应让阶段文档成为这些事实的投影或引用，不能再把同一事实维护成第二份权威文本。
