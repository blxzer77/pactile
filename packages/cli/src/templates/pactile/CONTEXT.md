# CONTEXT

Project domain glossary — the single source of truth for project-specific terms used in this repository. Read **on demand** when project terms matter (e.g. before planning questions, PRD writing, or check reviews); **never always-inject** — this file stays out of the automatic session prompt budget.

Only project-specific concepts belong here; generic programming concepts already documented under `.pactile/` do not need entries. Each entry: term + one-line definition + `_Avoid_` aliases when a common synonym causes confusion. Language follows `artifact_locale` (en → English only; zh → Chinese terms with English gloss). Seed below is bilingual so either locale can start from the same file; delete entries that do not apply.

## Task Kernel V2 terms

These terms describe the current V2 Task model. They do not rename or reinterpret an existing Task that the unified reader identifies as V1 legacy.

**Task** (_task_):
由 V2 Kernel 记录的一份有界交付物，包含验收标准、交付层级和硬依赖 Task ID。
_Avoid_: ticket, issue, workstream

**Deliverable** (_deliverable_):
Task 承诺产出、Review 时可供检查的具体结果。
_Avoid_: activity, effort

**Acceptance Criterion (AC)** (_acceptance criterion_):
交付物必须满足的可观察条件；Close 时每条 AC 都要映射到一个或多个证据引用。
_Avoid_: vague goal, unchecked checklist item

**Delivery level** (_delivery level_):
Task 声明的交付类别：`local-result`、`pull-request`、`merged-result` 或 `documentation`。Close 证据必须使用同一 level。
_Avoid_: rigor, quality tier

**Hard dependency** (_hard dependency_):
依赖 Task 必须成功 Close 后，被依赖 Task 才能通过 Kernel 门继续推进。
_Avoid_: preference, advisory order

**Run** (_run_):
Task 的一次执行尝试，记录授权、写集、结果和可选的候选快照。一个 Task 可以保留多次 Run。
_Avoid_: Task, overwritten retry

**Candidate snapshot** (_candidate snapshot_):
由完成的 Run 冻结的条目和 fingerprint；Review 与 Close 都指向确切快照。
_Avoid_: current unrecorded working tree

**Review** (_review_):
绑定到某个 Run 候选快照的独立追加式判定。Close 使用该候选的最新 Review，且判定必须通过。
_Avoid_: generic approval, unbound review note

**Close** (_close_):
Kernel 结项转换：依赖、候选绑定 Review 和 AC 证据均满足后，记录与 Task 交付层级匹配的交付证据。
_Avoid_: directory move, commit, publication

**V1 legacy Task** (_legacy Task_):
统一 reader 明确识别出的既有旧版 Task。保留其数据，只使用其版本对应的兼容行为；不能因为 V2 Task 缺少可选文件就把它当成 V1。
_Avoid_: old-style V2 Task

**artifact_locale** (_artifact locale_):
项目产物语言设置（en / zh）。
_Avoid_: locale

## Governance domain seed

Optional starting set for governance vocabulary — delete entries that do not apply:

**点子** (_idea_):
Undecided development direction or improvement, not yet a Task.
_Avoid_: requirement, thought

**不足** (_debt_):
Confirmed but unresolved gap found in review or verification.
_Avoid_: issue, bug (unless it is a tracked defect elsewhere)

**拒绝知识库** (_knowledge base_):
Archive of rejected-concept reasons, used to dedupe prior requests.
_Avoid_: blacklist

## Architecture (deep-module vocabulary)

Seed for codebase-design terms. Keep these seven; do not treat them as generic programming words.

**module** (_module_):
A unit of any size that has an interface and an implementation.
_Avoid_: component, service

**interface** (_interface_):
Every fact a caller needs in order to use the module correctly.
_Avoid_: API, signature

**depth** (_depth_):
Leverage on the interface: how much behavior each unit of interface can drive.
_Avoid_: abstraction level

**seam** (_seam_):
A place where behavior can change without editing the original site.
_Avoid_: boundary

**adapter** (_adapter_):
A concrete thing that satisfies an interface at a seam.
_Avoid_: implementation

**leverage** (_leverage_):
Capability the caller gains from depth.
_Avoid_: reuse

**locality** (_locality_):
Concentration the maintainer gains from depth (change / knowledge / verification in one place).
_Avoid_: cohesion

## Project glossary

Add project-specific terms below (term + one-line definition + `_Avoid_` aliases):

| Term | Definition | Avoid |
| --- | --- | --- |
| _TBD_ | | |

## ADR

Architecture decisions live in `docs/adr/` (lazy-created). Write an ADR only when **all three** conditions hold: hard to reverse · would surprise without context · real tradeoff. See `docs/adr/README.md` for the full boundary.
