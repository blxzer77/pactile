# Pactile Brainstorm

## Non-Negotiable Interview Contract

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time.

## Non-Negotiable Evidence Rule

If a question can be answered by exploring the codebase, explore the codebase instead.

This is mandatory. Before asking the user a question, first check whether the answer is already available in code, tests, configs, docs, existing specs, or task history.

Do not ask the user to confirm facts that the repository can answer. Ask only for product intent, preference, scope, risk tolerance, or decisions that remain ambiguous after inspection.

Read root `CONTEXT.md` (if present) before asking questions, and use its glossary terms.

## Thinking Principles

These two principles shape *how* you grill, not just *what* you ask. Apply them throughout Phase A and B.

### First Principles

Reason from irreducible facts and user value, not from analogy to existing solutions or "how it's always been done".

- When you encounter a requirement phrased as "we need X like Y has", separate the **root need** (the user value behind X) from the **inherited assumption** (Y's specific shape).
- For every "because that's the convention" justification, ask: what problem did that convention solve, and does that problem actually exist here?
- Trace each requirement back to a user-facing outcome. If no outcome survives, the requirement is inherited, not fundamental — flag it as a candidate for Out of Scope.

### Occam's Razor

Among competing designs that satisfy the acceptance criteria, prefer the one with the fewest additional assumptions.

- Default recommendation = the **minimal sufficient** design. Complexity must be justified by evidence (a contract, an edge case, a verified constraint), not added speculatively "for later".
- Actively strip scope that exists only to satisfy an assumption you cannot verify from repo evidence.
- When two paths are equally sufficient, the simpler one wins; the burden of proof is on the more complex path.

---

Use this skill during Phase 1 planning to turn the user's request into clear requirements and planning artifacts.

**Agent-capable platforms:** Do **not** use legacy Claude-only grill subagents as a hard gate. Complete **PRD Grill** (below) and **`pactile-micro-grill`** for blocking open questions before treating planning as ready for `design.md` / `implement.md` / `start-execution --check`.

## Preconditions

Use this skill only after task-creation consent has been given and the user is ready to enter Pactile planning.

If no task exists yet, create one:

```bash
TASK_DIR=$(pactile task create "<short task title>" --slug <slug>)
```

Use a concise title from the user's request. Use a slug without a date prefix. `pactile task create` adds the `MM-DD-` directory prefix automatically.

`pactile task create` creates the default `prd.md`. Update that file with the current understanding before asking follow-up questions.

## Two-phase planning overview

| Phase | Name | User questions |
| --- | --- | --- |
| **A** | Discovery Before Questions + PRD draft | None until repo evidence is exhausted |
| **B** | PRD Grill pass + Micro-grill unresolved | Only blocking business / risk / preference |

External facts during Discovery or Research: load `smart-search-cli`; on CLI/doctor failure use an available web tool and persist its exact source under `{TASK}/research/`.

---

## Phase A — Discovery Before Questions

Run **before** any user interview questions.

Inspect and record in `prd.md` (sections: **Confirmed facts**, initial **Out of scope**, draft **Goal**):

1. **Code & tests** — relevant modules, fixtures, configs, error paths.
2. **Specs** — `.pactile/spec/` indexes and layer guides for touched packages.
3. **History** — archived tasks, active task research, developer journal when useful.
4. **Platform** — Codex project instructions and `.agents/skills/`; see `.pactile/framework/codex-worker-dispatch.md` for the current worker boundary.
5. **Parent/Child** — if multiple independent deliverables, note child split early in `prd.md`.

Use retrieval per `.pactile/framework/retrieval-daily-guide.md` (rg for literals, codegraph for structure, fast-context for semantic sweep).

Dispatch **`pactile-research`** (writable Agent) when a topic needs a dedicated `{TASK}/research/<topic>.md` file; do **not** use a subagent for PRD Grill itself.

## Phase A — PRD draft

After Discovery, flesh out `prd.md`:

- goal and user value
- confirmed facts (not restated as unverified requirements)
- requirements
- draft acceptance criteria
- out of scope
- open questions (tag **blocking** vs **nice-to-have**)

For complex tasks, start `design.md` / `implement.md` skeletons only when boundaries are already clear from Discovery; otherwise wait until Phase B.

## Phase B — PRD Grill pass

Treat `prd.md` (+ existing `design.md` fragments) as the **only document surface**. Run this checklist; fix the PRD in place (no new subagent):

| # | Check |
| --- | --- |
| 1 | **Goal & user value** — single clear statement |
| 2 | **Confirmed facts vs assumptions** — repo facts not listed as assumptions |
| 3 | **Testable acceptance criteria** |
| 4 | **Out of scope** explicit |
| 5 | **Dependencies & sequencing** |
| 6 | **Parent/Child & deliverables** when applicable |
| 7 | **Research & external facts** — smart-search or documented fallback |
| 8 | **Execution gate & artifacts** — `design.md` / `implement.md` / `verify.md` expectations |
| 9 | **Durable Learning** — Phase 3.3 will need `update-spec` \| `no-update` \| `unsure` |
| 10 | **Platform** — Codex project entry; PRD Grill stays in the current task |
| 11 | **Risk & rollback** for complex tasks |
| 12 | **Open questions** — only **blocking** strategic/preference items remain |
| 13 | **Root vs inherited assumptions** — every requirement traces to a user-facing root need; inherited assumptions (convention, analogy, "we've always done it") are flagged or removed (First Principles) |
| 14 | **Minimal sufficient design** — no scope, layer, or mechanism exists to satisfy an unverified assumption; the simplest design that meets acceptance wins (Occam's Razor) |

## Phase B — Micro-grill unresolved

For each **blocking** open question after the checklist, embed the **`pactile-micro-grill` contract**:

- exactly **one** question per message
- **Simplified Chinese** for user-facing text
- recommended answer + trade-off
- **update `prd.md` after every answer** before the next question

Stop micro-grill when no blocking open questions remain.

Do not ask process questions ("should I search?"). Do not re-ask facts Discovery already confirmed.

## Frontier rounds (question pacing)

PRD Grill questions advance in **frontier rounds**:

- **frontier** = all "prerequisite-decided" questions: their prerequisite decisions are resolved, so they can be asked now without guessing unheard answers.
- Each round lists the current frontier at once, each question numbered (❓Q1/Q2/Q3…) with a recommended answer.
- **≤3 questions per round**; split into more rounds beyond that to avoid information overload.
- **Facts are the agent's job**: when a frontier question needs environment facts, dispatch a sub-agent to check; while exploration is pending it counts as an unresolved prerequisite that only blocks its downstream questions — ask the rest of the frontier anyway.
- **Decisions are the user's job**: every decision waits for the user's answer; do not answer for them.
- A user answer reshapes the design tree and the frontier extrapolates into the next round; **an empty frontier = the design tree is exhausted** — summarize the consensus and confirm before treating planning as done.

> **Override note:** this section overrides the "Ask the questions one at a time" line in the Non-Negotiable Interview Contract — Phase B (PRD Grill) pacing follows these frontier rounds rather than one-question-at-a-time; `pactile-micro-grill` still defaults to one question at a time.

## Question Rules (Phase B only)

Each question must include:

- the decision needed
- why the answer matters
- your recommended answer
- the trade-off if the user chooses differently

Your recommended answer defaults to Occam's Razor: the **minimal sufficient** option that still satisfies the acceptance criteria. Only recommend a more complex option when you can cite evidence (a contract, a verified edge case, a repo constraint) that the simpler option violates.

## Artifact Rules

`prd.md` records requirements and acceptance:

- goal and user value
- confirmed facts
- requirements
- acceptance criteria
- out of scope
- open questions that still block planning

`design.md` records technical design for complex tasks:

- architecture and boundaries
- data flow and contracts
- compatibility and migration notes
- important trade-offs
- operational or rollback considerations

`implement.md` records execution planning for complex tasks:

- ordered implementation checklist
- validation commands
- risky files or rollback points
- **Development Strategy Contract** (`execution_mode`, `isolation`, …): choose the execution and isolation strategy from the actual scope, then record the approved YAML block in `implement.md`.
- follow-up checks before `pactile task start-execution --check`

Lightweight tasks may have only `prd.md`. Complex tasks must have `prd.md`, `design.md`, and `implement.md` before `pactile task start-execution --check`.

`implement.md` is not a replacement for `implement.jsonl`. Use JSONL files only for manifest-style spec and research references when the task needs them.

## Completion criteria — PRD Grill done

Planning is ready for execution gate when **all** hold:

- PRD Grill checklist (14 items) satisfied or explicitly N/A with rationale in `prd.md`
- **No blocking** open questions in `prd.md`
- Acceptance criteria are testable; out of scope is explicit
- Complex tasks: `design.md` and `implement.md` present
- User reviewed artifacts or explicitly approved proceeding

Then proceed to Phase 1.2 Research (if needed), Phase 1.4 `pactile task start-execution --check`, and implementation only after user approval.

Do not start implementation until the user approves or asks for implementation.

## Legacy planning flow (summary)

The former single "Planning Flow" is now Phase A + B above. Steps 4–6 map to Phase B micro-grill and artifact updates.
