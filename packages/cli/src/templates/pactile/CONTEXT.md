# CONTEXT

Project domain glossary — the single source of truth for project-specific terms used in this repository. Read **on demand** when project terms matter (e.g. before planning questions, PRD writing, or check reviews); **never always-inject** — this file stays out of the automatic session prompt budget.

Only project-specific concepts belong here; generic programming concepts already documented under `.pactile/` do not need entries. Each entry: term + one-line definition + `_Avoid_` aliases when a common synonym causes confusion. Language follows `artifact_locale` (en → English only; zh → Chinese terms with English gloss). Seed below is bilingual so either locale can start from the same file; delete entries that do not apply.

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

## Framework domain seed (optional)

Optional starting set — delete entries that do not apply to this project:

**Task** (_task_):
PACTILE task, directory under `.pactile/tasks/`, lifecycle planning / in_progress / completed.
_Avoid_: ticket, issue

**PRD** (_product requirements document_):
Task requirements artifact: Goal / User Stories / Requirements / Acceptance Criteria / Implementation Decisions.
_Avoid_: spec sheet

**Gate** (_gate_):
Mandatory checkpoint at planning / execution / archive boundaries.
_Avoid_: —

**Evidence** (_evidence_):
Verification evidence in `verify.md` (command output, paths, acceptance).
_Avoid_: report

**Contract** (_contract_):
Execution contract in `implement.md` (execution_mode / verification_profile / quality_gates).
_Avoid_: plan

**Child** (_child_):
Independently verifiable deliverable under a Parent task tree.
_Avoid_: sub-ticket

**artifact_locale** (_artifact locale_):
Project artifact language setting (en / zh).
_Avoid_: locale

**Task Ladder** (_task ladder_):
Triage ladder: No Task / Micro-Grill / Lite / Full / Parent.
_Avoid_: —

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
