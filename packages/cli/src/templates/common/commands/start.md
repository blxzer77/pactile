# Framework Start

Enter or refresh the Pactile Framework Context. This is a dashboard entry surface; it must not select, resume, or start a task by itself.

This entry is available as a Codex Skill. It does not dispatch another task.

---

## Step 1: Framework state
Identity, git status, selected task, Kernel / Task Dashboard, journal location.

```bash
pactile context
```

If this output includes a line beginning `Pactile update available:`, copy the full line verbatim when summarizing session context. Do not shorten operational command hints.

If a compiled session pack is already in context, use it. Do **not** implement the Session compiler. Do **not** treat `pactile context --mode phase` Phase Index as runtime SSOT.

## Step 2: Guideline indexes
Discover packages + spec layers, then read each relevant index file.

```bash
pactile context --mode packages
cat .pactile/spec/guides/index.md
cat .pactile/spec/<package>/<layer>/index.md   # for each relevant layer
```

Index files list the specific guideline docs to read when you actually start coding. Human overview: `.pactile/workflow.md` (read on demand; not runtime SSOT).

## Step 3: Decide next action
From Step 1 you know whether a task is selected. Route by Kernel human phase (Open / Define / Approve / Execute / Verify / Integrate? / Close), not by Phase Index step ids.

- If `Selected task: none` → show the Task Dashboard; do **not** load `pactile-continue`. For read-only Q&A, stay no-task (Ask if the user is already there).
- If a task **is** selected and you need the next lifecycle step → use `pactile-continue` instead of repeating Steps 1–2 here.

If `Selected task: none`, ask the user to choose: select a task, create a task, inspect details, or continue without a task.

If a task is selected, check Kernel / Dashboard:

- **Open / Define** → stay in definition until AC exists; prefer Plan for Define when useful
- **Approve** → Execution gate (`pactile task start-execution <task> --check`); `--check` is not approval
- **Execute** → implement under contract
- **Verify / Close** → evidence then wrap-up (`pactile-finish-work`)
- **No selected task** → use dashboard routing. Do not auto-select an existing task

Official `/goal` / CreateGoal is not a Pactile Task.

---

## Skill routing (quick reference)

Internal names below are workflow routing, not a host command palette.

| User intent | Route |
|---|---|
| Resume **selected** in-progress task | `pactile-continue` |
| New feature / unclear requirements | Define / brainstorm discipline (on-demand) |
| Small request, no task yet | no-task read-only or Open Proposal |
| About to write code | Execute (after Execute gate) |
| Done coding / quality check | Verify |
| Session wrap-up after Close / Finalize commit | `pactile-finish-work` |
| Stuck / fixed same bug multiple times | Debug → `verify.md`; break-loop when looped |
| Learned something worth capturing | learning disposition in `verify.md` |

Full human overview in `.pactile/workflow.md`. Codex worker boundary: `.pactile/framework/codex-worker-dispatch.md`.
