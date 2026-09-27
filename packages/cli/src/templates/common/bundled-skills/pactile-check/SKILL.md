---
name: pactile-check
description: "Comprehensive quality verification on two axes — Standards (spec compliance, lint, type-check, tests, code smells, cross-layer data flow) and Spec (prd fidelity, scope, learning/spec-sync). Use when code is written and needs quality verification, before committing changes, or to catch context drift during long sessions."
---

# Code Quality Check

Comprehensive quality verification for recently written code. Combines spec compliance, cross-layer safety, and pre-commit checks.

---

## Step 1: Identify What Changed

```bash
git diff --name-only HEAD
git status
```

## Step 2: Read Task Artifacts and Applicable Specs

Read the selected task artifacts in order:

- `prd.md`
- `design.md` if present
- `implement.md` if present

```bash
pactile context --mode packages
```

For each changed package/layer, read the spec index and follow its **Quality Check** section:

```bash
cat .pactile/spec/<package>/<layer>/index.md
```

Read the specific guideline files referenced — the index is a pointer, not the goal.

## Step 3: Run Project Checks

Run the project's lint, type-check, and test commands. Fix any failures before proceeding.

## Step 4: Review Against Checklist (dual-axis)

Report **Standards and Spec in two separate sections** — never merge them into a single severity ranking. Standards findings first, then Spec findings; the same issue may be cross-referenced on both sides, but one axis must not mask the other. Do NOT output a "combined top risks" list mixing spec violations with requirement deviations.

### Dual-axis dispatch (Full+ only)

- **Lite / no task context**: single pass — the main agent runs Standards then Spec sequentially (no parallel split).
- **Full+ and sub-agents available**: may dispatch two read-only review sub-agents in parallel (a Standards-agent and a Spec-agent). They **only report findings, never modify code**; the main agent consolidates and fixes per Step 6.
- **Sub-agents unavailable**: degrade to single pass — do not block the check.

### Standards (did we write it right)

#### Code Quality

- [ ] Linter passes?
- [ ] Type checker passes (if applicable)?
- [ ] Tests pass?
- [ ] No debug logging left in?
- [ ] No suppressed warnings or type-safety bypasses?

#### Test Coverage (verification strength — not TDD)

Follow `.pactile/framework/verification-strength-guide.md` for **graded** validation depth by closeout profile. pactile does **not** mandate red-green TDD or per-function unit tests.

- [ ] **Lite:** focused validation on touched behavior recorded in `verify.md` (`Validation:` line + result)
- [ ] **Full:** above + `Check evidence:` + `Reviewed change-set:` when contract requires code-review gate
- [ ] New function / bug fix → add or update tests **when the project's norms and task scope require it** — not as automatic TDD ceremony
- [ ] `pactile task validate <task>` passing JSONL schema **≠** task acceptance; substantive `verify.md` signals still required

#### Fowler 12 Smells

Scan the change surface against `references/fowler-12-smells.md` (12 named smells, one-line criterion + don't-report boundary each). Report when hit, `N/A` when not — do not pad the report with misses.

#### False-positive calibration (AI cross-review)

Before prioritizing any CRITICAL/WARNING finding, read `.pactile/spec/guides/index.md` → **"When Verifying AI Cross-Review Results"**: verify each finding against the actual code; budget ~35% false-positive rate for AI reviews; typical patterns: trust boundary confusion, ignoring design comments, variable misreading.

### Spec (did we build the right thing)

#### prd / design / implement fidelity

- [ ] Against `prd.md` Goal / Requirements / Acceptance Criteria: is the implementation faithful, and does it stay **within scope** (no over-scope)?
- [ ] Are `design.md` / `implement.md` boundaries violated (if present)?

#### Durable Learning (Phase 3.3)

- [ ] `verify.md` contains exactly one token: `Learning decision: update-spec` | `no-update` | `unsure`
- [ ] If `update-spec` or `unsure`: `research/learning-proposal.md` exists (or documented `N/A` with reason) and matches the decision
- [ ] If `no-update`: includes `no durable learning` (or guide-equivalent) plus brief rationale
- [ ] If `update-spec`: spec was written only after confirmation; `Spec update evidence:` points at `.pactile/spec/...`
- [ ] No silent edits to `.pactile/spec/` without confirmation

#### Spec Sync

- [ ] Does `.pactile/spec/` need updates? (route through semi-automatic flow: proposal → confirm → `pactile-update-spec`)

> "If I fixed a bug or discovered something non-obvious, should I document it so future me won't hit the same issue?" → If YES, update the relevant spec doc.

#### Retrieval evidence (when task used research / smart-search / optional pack)

- [ ] **`verify.md` lists unresolved retrieval gaps** — external facts still unverified, missing `research/` or `research/smart-search/` evidence, or claims without source/Git/test corroboration
- [ ] If `{TASK}/research/retrieval-pack-latest.json` exists, top `contextPack.selected` items are cited or gaps are explicitly noted in `verify.md`

**Evidence pack (graceful):** Path `{TASK}/research/retrieval-pack-latest.json`. If absent, skip — no error.

When present, Read the pack and ensure `verify.md` has `## Evidence pack reference` citing `contextPack.selected` (`title`, `source`, `reference`, `score`) or explicit gaps. Empty `selected` with existing `research/` → note stale pack or scoring failure in `verify.md`.

#### Terminology / ADR consistency (one line)

- [ ] Read root `CONTEXT.md`: do terms in the change mix `_Avoid_` aliases? If an irreversible decision was introduced, should there be an ADR? (Prompt only — do not force creating a file.)

### Report format

```markdown
## Standards findings
- [sev] ...

## Spec findings
- [sev] ...

## Summary
- Standards: N issues (not ranked against Spec)
- Spec: M issues
```

## Step 5: Cross-Layer Dimensions (if applicable)

Skip this step if your change is confined to a single layer.

### A. Data Flow (changes touch 3+ layers)

- [ ] Read flow traces correctly: Storage → Service → API → UI
- [ ] Write flow traces correctly: UI → API → Service → Storage
- [ ] Types/schemas correctly passed between layers?
- [ ] Errors properly propagated to caller?

### B. Code Reuse (modifying constants, creating utilities)

- [ ] Searched for existing similar code before creating new?
  ```bash
  grep -r "pattern" src/
  ```
- [ ] If 2+ places define same value → extracted to shared constant?
- [ ] After batch modification, all occurrences updated?

### C. Import/Dependency (creating new files)

- [ ] Correct import paths (relative vs absolute)?
- [ ] No circular dependencies?

### D. Same-Layer Consistency

- [ ] Other places using the same concept are consistent?

---

## Step 6: Report and Fix

Report violations found (Standards and Spec sections per Step 4 format) and fix them directly. Parallel review sub-agents **do not fix** — the main agent owns all fixes. Re-run project checks after fixes.
