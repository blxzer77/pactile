# 结构化任务事实与渐进读取

PRD、Design、Implement、Review 和 Verify 的生命周期事实由同一份结构化事实封套投影。阶段视图只保存事实 ID；人类与 Agent 的事实视图都从 Kernel 派生。用户撰写的阶段 Markdown 保持独立原文，投影只列稳定文档 ID、存在状态、内容指纹、来源和 locator，不把叙述复制成第二份权威。P35 的其他流程接线和 P36 的旧文档迁移由各自切片完成。本页补充结构化工件的读取方式；Task、Run、Review 与 Close 的门槛见[Task system](../concepts/task-system.zh-CN.md)。

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

人类 Markdown 为有事实或文档引用的阶段列出事实 ID 和文档状态，然后在单独的 Facts 区域完整展示每条事实一次。Agent 投影是紧凑索引：阶段只列事实 ID 与文档 ID，事实索引只出现一次，并带摘要、状态、来源、provenance 和 locator。文档索引不包含正文，也不在 Kernel 外持久化。PRD 的 Scope/范围/Risk/风险与 Design 的 Decision/决策/Rationale/理由/Risk/风险章节会在现有文档中生成细粒度标题 locator 和章节内容指纹；索引保留标题、来源与 ref，不复制作者叙述。核心 PRD/Design 文档保留现有短 ID，例如 `section:prd:scope` 和 `section:design:decision`；过渡文档 ID 加入文档命名空间，例如 `section:prd:legacy-task-map:scope`。同一文档中重复的标题 locator 追加出现序号，例如 `heading:decision:2`。正文变化时指纹变化。

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

## 轻量 Task：一个依赖和一条验收标准

修复超时默认值是轻任务的例子：它依赖已完成的 `config-timeout-contract`，只有一条验收标准，并需要一条简短设计决策。

```bash
pactile task create "Preserve the configured timeout fallback" --slug timeout-fallback \
  --description "Keep the configured timeout when an override is absent." \
  --deliverable "A reviewed local fix" --delivery-level local-result \
  --depends-on config-timeout-contract \
  --accept "AC-1=Missing override keeps the configured timeout"
pactile task artifacts timeout-fallback --agent --stage prd
```

PRD 中的验收项和硬依赖分别成为 `requirement` 与 `constraint` facts。这个例子在 `design.md` 写下真实取舍：`## Decision` 下说明“只有显式覆盖值才替换项目超时设置”；`## Rationale` 下说明“缺少覆盖值时继续使用已批准的默认值”。文档索引给出 `section:design:decision` 的来源、路径和 fingerprint；Agent 展开该段时读取作者原文，不会把它改写为另一个 Kernel fact。复制索引中的 fingerprint 后，可用 `pactile task artifacts timeout-fallback --agent --stage design --section "section:design:decision@<current-section-fingerprint>"` 只展开这项取舍。不需要设计时就不创建 `design.md`。索引只显示缺失文档的 `absent` 状态，不会生成空的 Design、Implement、Review 或 Verify 模板。此例假设硬依赖已经 Close；依赖未满足时 Run 会被阻断。

执行前取得明确批准。Run 结果、独立 Review 与逐项验收证据随后进入 Kernel：

```bash
pactile task run-start timeout-fallback \
  --actor implementer \
  --input-summary "Preserve the configured timeout when no override is supplied" \
  --input-ref prd.md --input-ref design.md \
  --approved-by requester --authorization-scope "the declared timeout fix" \
  --authorization-evidence evidence/timeout-approval.md
pactile task run-result timeout-fallback <run-id> --outcome completed \
  --actor implementer \
  --summary "The fallback preserves the configured timeout" \
  --candidate src/config/timeout.ts=<64-lowercase-hex-fingerprint> \
  --evidence tests/timeout-fallback.txt
pactile task artifacts timeout-fallback --agent --stage implement
pactile task artifacts timeout-fallback --agent --stage implement --fact <candidate-fact-id>
pactile task review timeout-fallback --run <run-id> \
  --candidate-id <snapshot-id> --candidate-fingerprint <64-lowercase-hex-fingerprint> \
  --reviewer independent-reviewer --actor independent-reviewer --decision pass \
  --evidence review/timeout-fallback.md \
  --criterion AC-1=tests/timeout-fallback.txt
pactile task close timeout-fallback --run <run-id> --review <review-id> \
  --candidate-id <snapshot-id> --candidate-fingerprint <64-lowercase-hex-fingerprint> \
  --candidate-observed-by closer --candidate-observation-source declared \
  --candidate-observation-ref evidence/current-candidate.json \
  --delivery-level local-result --delivery-ref src/config/timeout.ts \
  --delivery-summary "Reviewed timeout fallback is present"
```

`<run-id>` 来自 Run 输出；候选 fact 通过 `--fact` 展开后，其 Kernel 值提供 snapshot ID 和完整 fingerprint。命令示例中的 fingerprint 是 64 个小写十六进制字符，不含 `sha256:` 前缀。Review 的 `--criterion` 对每条验收标准各传一次。引用只是调用方记录的 locator：Pactile 不会打开这些文件，也不会认证 reviewer 或 approver。人类复查可分别运行 `pactile task artifacts timeout-fallback --stage prd` 与 `--stage verify`；PRD/Verify 会指向同一个 requirement ID，Review 和 Evidence 则各自只出现一次。

## 重型 Task：多依赖、多验收项与跨文档证据

实现旧 Task 文档按需读取是重任务的例子：Task 依赖已完成的 Kernel reader 与 P36 import work，定义三条验收标准，并在 PRD/Design 记录范围、风险、设计决策和理由：

```bash
pactile task create "Read legacy Task documents on demand" --slug legacy-doc-read \
  --description "Expose imported Task facts and authored documents through stable locators." \
  --deliverable "A reviewed, read-only artifact reader" --delivery-level local-result \
  --depends-on task-kernel-reader --depends-on p36-task-import \
  --accept "AC-1=Imported Task Kernel facts resolve through the active reader" \
  --accept "AC-2=Selected Markdown is returned only for a current content fingerprint" \
  --accept "AC-3=The original task.json and authored documents remain unchanged"
pactile task artifacts legacy-doc-read --agent
```

该 Task 的作者文档可以直接写清边界和取舍；这些段落保持为作者原文，不复制到 facts：

~~~md
# PRD

## Scope
Read imported Task Kernel facts and explicitly selected Markdown sections.

## Risk
A stale content fingerprint could return a previous version of authored text.

# Design

## Decision
Resolve lifecycle facts through the active Kernel reader; keep stage Markdown read-only.

## Rationale
The Kernel owns lifecycle state, while document fingerprints pin the requested prose.

## Risk
An inserted same-kind heading can change later occurrence-based section IDs.
~~~

作者只建立实际需要的 `prd.md`、`design.md`、`implement.md`；Review 与 Verify 有内容时再写入。先读完整 Agent 索引，再按需取 Run 或文档正文，然后记录多文件候选与逐项证据：

```bash
pactile task run-start legacy-doc-read \
  --actor implementer \
  --input-summary "Implement the three approved acceptance criteria" \
  --input-ref prd.md --input-ref design.md --input-ref implement.md \
  --approved-by requester --authorization-scope "read-only Task artifact indexing" \
  --authorization-evidence evidence/legacy-doc-read-approval.md
pactile task run-result legacy-doc-read <run-id> --outcome completed \
  --actor implementer \
  --summary "Selected facts and current document sections are readable" \
  --candidate packages/cli/src/pactile/artifacts=<source-tree-64-hex-fingerprint> \
  --candidate docs/capabilities/structured-task-artifacts.zh-CN.md=<docs-64-hex-fingerprint> \
  --evidence evidence/artifact-reader-tests.txt \
  --evidence evidence/p36-overlay-read.txt
pactile task artifacts legacy-doc-read --agent --stage implement
pactile task artifacts legacy-doc-read --agent --stage implement --fact <candidate-fact-id>
pactile task review legacy-doc-read --run <run-id> \
  --candidate-id <snapshot-id> --candidate-fingerprint <64-lowercase-hex-fingerprint> \
  --reviewer independent-reviewer --actor independent-reviewer --decision pass \
  --evidence review/legacy-doc-read-review.md \
  --criterion AC-1=evidence/p36-overlay-read.txt \
  --criterion AC-2=evidence/stale-fingerprint-rejected.txt \
  --criterion AC-3=evidence/source-preservation-check.txt
pactile task close legacy-doc-read --run <run-id> --review <review-id> \
  --candidate-id <snapshot-id> --candidate-fingerprint <64-lowercase-hex-fingerprint> \
  --candidate-observed-by closer --candidate-observation-source declared \
  --candidate-observation-ref evidence/legacy-doc-read-candidate.json \
  --delivery-level local-result \
  --delivery-ref packages/cli/src/pactile/artifacts \
  --delivery-summary "Reviewed artifact reader and evidence are present"
pactile task artifacts legacy-doc-read --agent
```

读索引后，`context:task`、依赖约束、每条验收标准、Run、Review、候选和 Evidence 都有独立 ID、来源、provenance 与 Kernel locator；跨阶段只引用同一 fact ID，不复制事实。PASS Review 后，整体 Review finding 可为 `accepted`，但各验收事实仍为 `active`；Kernel 只有 Close 才把它们记为 `verified`。Close 前候选 freshness 是 `unknown`；Close 记录的 caller-supplied observation 与 snapshot 匹配后，当前候选为 `fresh`，较早候选为 `stale`。这表示调用方观察与 Kernel 记录匹配，不表示 Pactile 重算了 Git 或磁盘字节。

## 跨文档章节 ID 与指纹

`document:prd`、`document:design` 等文档 ID 对应逻辑来源，内容变化时 ID 不变；文档 fingerprint 覆盖文档路径与内容（Review 文档覆盖 `review.md` 和 `review/` 中读取到的 Markdown）。章节索引另外给出章节 ID、所属路径、heading selector 和章节 fingerprint。PRD 的首个 Scope/Risk ID 分别是 `section:prd:scope`、`section:prd:risk`；Design 的 Decision/Rationale/Risk 使用 `section:design:decision` 等 ID。Stage 命名空间使 PRD 与 Design 中同名标题也不会冲突。

从完整索引复制 ID 和当前 section fingerprint，再只读该段内容：

```bash
pactile task artifacts legacy-doc-read --agent
pactile task artifacts legacy-doc-read --agent --stage design \
  --section "section:design:decision@<current-section-fingerprint>"
```

传入 `--stage` 时必须选择该章节所在阶段；跨阶段引用先读完整索引，再用章节 ID 展开。指纹过期时命令拒绝返回旧正文，提示重新读取索引。正文变化会改变 section fingerprint；添加或重排同类章节也可能改变后续章节的序号 ID，因此每次决策都应以刚读取的索引为准，不应把 ID 当作永久 URL。

P36 导入的旧 Task 还可能有 `task-map.md` 和 `handoff.md`。它们保留为只读过渡文档；同一阶段有多份文档时，索引为它们分别命名，例如 `section:prd:legacy-task-map:scope`，不会与 `prd.md` 的 `section:prd:scope` 混淆。只有源文件存在时才出现该 locator。先用 `pactile task artifacts <task> --agent --stage prd` 查看文档 ID、路径与 fingerprint，再对选定 ID 使用 `--document` 或 `--section`。

## 旧 Task 的读取路径

`pactile task artifacts` 是只读入口：它不会迁移旧 `task.json`、改写阶段 Markdown 或触发 import。尚未导入的 0.5.x Task 仍走旧读取路径。P36 导入后的 held Task 状态检查、定义补全、依赖协调与 reconciliation 命令见[升级指南中的 P36 held Task 步骤](../lifecycle/upgrade-and-migrate.zh-CN.md#p36-held-task-reconciliation)。导入后，Kernel reader 从当前 migration generation/overlay 读取 V2 状态；原始 `task.json` 与阶段作者文档仍保持源内容，artifact reader 只生成索引，不创建 `artifacts.json` 副本。详见[Task system](../concepts/task-system.zh-CN.md)。
