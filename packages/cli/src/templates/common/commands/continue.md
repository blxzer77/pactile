# Continue Selected Task

Resume work **only** when this live session already has a `selected_task`. If no task is selected, show the Task Dashboard and ask for an explicit route. Do not auto-resume a previous or unique task.

This Skill does not implement the Session compiler and does not treat `workflow.md` or `get_context.py --mode phase` as runtime SSOT. Run the available CLI yourself. Do not open with a “loaded” probe. No selected task → answer directly.

---

## Step 1: Load Kernel / Dashboard

```bash
{{PYTHON_CMD}} ./.pactile/scripts/get_context.py
```

Confirms: selected task, Kernel projection (Open / Define / Approve / Execute / Verify / Integrate? / Close), Task Dashboard, git state, recent commits.

If a **compiled session pack** is already in context (SessionStart injected it), use that pack. If `./.pactile/scripts/compile_session_pack.py` exists, you MAY call it to refresh the pack. Do **not** implement or patch the compiler.

Do **not** treat `{{PYTHON_CMD}} ./.pactile/scripts/get_context.py --mode phase` (Phase Index) as runtime SSOT. That extractor is a human overview of `workflow.md`, not Kernel truth.

If the output says `Selected task: none`, stop. Show the dashboard and ask the user to choose one route:

- select a task with `{{PYTHON_CMD}} ./.pactile/scripts/task.py select <task>`
- create a task (Open Proposal first; no create without consent)
- inspect details
- continue without a task for read-only Q&A (Ask if the user is already there; otherwise Agent read-only)

## Step 2: Search Session Memory

**Skip this step** if Step 1 reported `Selected task: none`.

When a task is selected, search past session memory so resume work can reuse journal context instead of re-asking the user:

```bash
{{PYTHON_CMD}} ./.pactile/scripts/search_memory.py --query "<task topic or title>" --json
```

Use the selected task's title or topic as the query. From the JSON results, summarize **1–3** most relevant hits for the user (title, summary, and next steps when present). Carry that context into the rest of the continue flow.

## Step 3: Route by Kernel phase

When a task is selected, route by Kernel / Dashboard human phase and persisted `required_controls.rigor` / `topology.kind`. `status` is a projection, not the sole truth. This command does not itself approve Execute.

- **Open** → Intake / Open Proposal only; no product code
- **Define** → Full: `SwitchMode(plan)` immediately; if the switch fails, one sentence (what happened, where `prd.md` landed) and keep writing artifacts. Lite may stay in Agent. Full follows `required_controls`, not mere file presence. Unlanded Plan is not Execute.
- **Approve** → run `task.py start-execution <task> --check`, report PASS, ask for explicit Execute approval, then `task.py start-execution <task> --approved`. `--check` is not approval
- **Execute** → implement under the approved contract. No product-code edits until this gate. Independent Codex tasks require explicit objective, write set, and evidence; the Pactile message bridge is not active yet
- **Verify** → map every AC to evidence in `verify.md`; Debug when runtime-stuck
- **Integrate?** (parent-child / already integrating) → Parent `integrate-child` path (`merge_limit: 1`), serial, not ordinary Child closeout. `parent_id` alone does **not** make a Child a Parent
- **Close** → wrap-up via `{{CMD_REF:finish-work}}` when the user is ready; `UpdateGoal` complete or cancel (failure does not block)

Return-to-Define when scope, AC, execution contract, verification strategy, or capability assumptions change.

Official `/goal` / CreateGoal is **not** a Pactile Task. Do not restore `pactile-goal`.

---

## Reference

Human overview: `.pactile/workflow.md` (not runtime SSOT). Codex worker boundary: `.pactile/framework/codex-worker-dispatch.md` (on demand).
