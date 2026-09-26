# 结构化任务事实与渐进读取

PRD、Design、Implement、Review 和 Verify 的生命周期事实由同一份结构化事实封套投影。阶段视图只保存事实 ID；人类与 Agent 的事实视图都从 Kernel 派生。用户撰写的阶段 Markdown 保持独立原文，投影只列稳定文档 ID、存在状态、内容指纹、来源和 locator，不把叙述复制成第二份权威。P35 的其他流程接线和 P36 的旧文档迁移由各自切片完成。

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
      "ref": {
        "uri": "artifact://tasks/small-fix/kernel",
        "selector": "/definition/acceptanceCriteria/0"
      }
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
- `ref.uri` 是逻辑定位符，`ref.selector` 是 JSON pointer；二者共同定位事实。Kernel 事实使用 `artifact://tasks/<safe-task-id>/kernel`，selector 指向当前 `readTaskKernel` 返回的快照，不指向 TaskDir 下的 `kernel.json`。导入任务由 Kernel reader 解析迁移 generation/overlay，旧 V1 文件不会被误当成 V2 来源。完整 URI 形式为 `<ref.uri>#<ref.selector>`。
- `candidate` 事实必须带 `candidateFreshness`。`fresh`/`stale` 必须同时有检查时间和证据引用；`unknown` 不得伪装成已检查。其他事实不出现此字段。

校验器拒绝重复 ID、悬空阶段/派生引用、未被任何阶段引用的事实、路径穿越、source scheme 与 source kind 不匹配，以及没有证据支撑的新鲜度声明。

## 投影和读取顺序

人类 Markdown 为有事实或文档引用的阶段列出事实 ID 和文档状态，然后在单独的 Facts 区域完整展示每条事实一次。Agent 投影是紧凑索引：阶段只列事实 ID 与文档 ID，事实索引只出现一次，并带摘要、状态、来源、provenance 和 locator。文档索引不包含正文，也不在 Kernel 外持久化。PRD 的 Scope/范围/Risk/风险与 Design 的 Decision/决策/Rationale/理由/Risk/风险章节会在现有文档中生成细粒度标题 locator 和章节内容指纹；索引保留标题、来源与 ref，不复制作者叙述。章节 ID 在同一标题类别中稳定，正文变化时指纹变化。

Agent 先读取索引，根据当前决策选定事实 ID、逻辑事实 URI、文档 ID 或章节 ID，再按需读取 locator。文档 ID 在内容修改后保持稳定；sha256 内容指纹随文件内容变化。显式展开整份文档时使用 `--document <document-id>@<contentFingerprint>`，缺失文档可用 `@absent` 确认仍缺失。展开单个已索引章节时使用 `--section <section-id>@<contentFingerprint>`。CLI 会把调用方带回的指纹与当前内容比较，旧指纹会被拒绝并要求重新读取索引。文档正文不会从仅包含稳定 ID 的请求中展开。缺少的 `prd.md`、`design.md`、`implement.md`、`review.md`/`review/` 和 `verify.md` 会显示为 `absent`，不会因此生成空模板。旧任务的 `task-map.md` 和 `handoff.md` 只在文件存在时作为过渡文档引用加入索引，不覆盖或复制正文。

## Task Kernel V2 读取与投影

`pactile task artifacts <task>` 每次通过统一的 Task Kernel reader 派生事实封套，并只读扫描现存阶段 Markdown 的位置、章节和指纹，然后输出人类可读 Markdown。对普通任务，reader 使用本地 V2 Kernel；对 P36 已导入任务，reader 使用当前 migration generation/overlay。`--agent` 输出紧凑 JSON 索引；`--stage prd|design|implement|review|verify` 限定视图；`--fact <id>` 或 `--fact <ref.uri>#<ref.selector>` 按需展开所选 Kernel 事实；`--document` 读取用户撰写的全文，`--section` 只读取当前指纹对应的 PRD/Design 章节。Session Pack 的 Kernel Definition 也使用同一事实 URI，不再指向可能是旧 V1 或不存在的 TaskDir `kernel.json`。

映射保留 Kernel 的不可变 Run、Review、Close 记录和 Task 定义作为数据源，不写 `artifacts.json` 副本：

- PRD 包含任务定义、验收标准和硬依赖。
- Implement 包含 Run 与候选快照；运行结果证据同时可从 Verify 阶段定位。
- Review 包含独立评审的整体决策与证据。Verify 会在存在该 criterion 的验收证据时复用 PRD 的同一验收事实 ID，并同时列出对应证据 locator。整体 Review verdict 不作为单项 criterion 的决定；criteria 在 Kernel Close 前保持 `active`，Close 才按记录状态变为 `verified`。
- Design 的决策、理由和风险来自作者已有的 Markdown 标题；reader 暴露稳定章节 ID、来源、ref 和内容指纹，不生成 Kernel 状态或替作者摘要。PRD 的 Scope/Risk 使用同样方式。没有文档或对应标题时不产生章节项。
- 候选快照在关闭观察前保持 `unknown`；关闭记录的观察与选中的快照一致时标为 `fresh`，其他历史快照标为 `stale`。这仅表示 Kernel 中记录的调用方观察，不重算 Git 或文件内容。

创建新的 Kernel V2 Task 时，CLI 只在文件不存在时用 exclusive create 新建最小 `prd.md`：列出稳定事实 ID、Kernel 来源和 locator，并留出人类叙述区。后续流程只更新 Kernel；不会重写此 Markdown，也不会生成空的 Design、Implement、Review 或 Verify 模板。现存文档按只读文件路径和内容指纹索引；读取索引与选读正文都不修改文档。Markdown 内的自由叙述仍由作者维护，Kernel 继续是生命周期状态与证据 ID 的唯一权威。

这个 reader 不迁移旧 `task.json` 或改写旧阶段文档；旧文档转换与 V2 Kernel 导入归 P36。它通过 Kernel reader 支持已经导入的 V2 migration overlay，并为旧 `task-map.md` / `handoff.md` 保留只读过渡 locator。P35 的其他生命周期入口以及 P33 Session Pack 的其余接线仍属于各自切片。本候选只交付事实读取和 locator 基础，不代表整个 PACTILE-42 已完成。
