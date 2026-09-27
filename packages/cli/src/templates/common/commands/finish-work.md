# Finish Work

Wrap up the current session: archive the selected task (and any other completed-but-unarchived tasks the user wants to clean up) and record the session journal. Product-code commits are **not** done here — those belong to Close / Finalize (`vcs-integration`) **before** you invoke this command.

Before archive, confirm `verify.md` includes a **Durable learning decision** (`update-spec` | `no-update` | `unsure`, or a grep-friendly `Durable learning decision:` / `no durable learning` line) and gate-compatible evidence per `.pactile/spec/guides/durable-learning-decision-guide.md`. Run `pactile task archive <task> --check` when unsure.

Human lifecycle names: Open / Define / Approve / Execute / Verify / Integrate? / Close. This command is the Close wrap-up hatch, not Execute. On Close, `UpdateGoal` complete or cancel plus one sentence; Goal failure does not block Close. Do not ask the user to type `python`.

## Evidence pack reference (optional — graceful skip)

When the selected task already has `{TASK}/research/retrieval-pack-latest.json`:

1. Read the JSON; note top `contextPack.selected` items (`title`, `source`, `reference`, `score`) and `collection` counts.
2. Ensure `verify.md` includes an `## Evidence pack reference` section citing those ranked sources or documenting explicit gaps.
3. If the section is missing, add it before proceeding to archive.

If the file does not exist: **skip silently** — no error, no user prompt. Pack absence is normal when the task did not use research/smart-search.

Pack format: `version`, `source` (`retrieval-pack-orchestrator`), `contextPack.selected[]`, `scoredEvidence`, `collection`. Smart Search manifests that feed scoring live under `{TASK}/research/smart-search/<run-id>/`.

When research evidence has already been collected, generate or refresh the file with `pactile context --mode retrieval-pack --input <collected-evidence.json> --output {TASK}/research/retrieval-pack-latest.json --json`. Each input item needs `path` and `provider`; the Node quality layer scores, arbitrates, and budgets the collected items. It does not search, and its pack is never AC or Close evidence.

## Step 1: Survey current state

```bash
pactile context --mode record
```

This prints:

- **My active tasks** — review whether any besides the selected one are actually done (code merged, AC met) and should be archived this round.
- **Git status** — quick visual on what's dirty.
- **Recent commits** — you'll need their hashes in Step 4 for `--commit`.

If `--mode record` surfaces other completed tasks not tied to the current selection, surface them to the user with a one-shot confirmation: "These N tasks look done — archive them too in this round? [y/N]". Default is no; the selected task is always archived in Step 3 when one exists.

## Step 2: Sanity check — classify dirty paths

Run:

```bash
git status --porcelain
```

Filter out paths under `.pactile/workspace/` and `.pactile/tasks/` — those are managed by `pactile session add` and `pactile task archive` auto-commits and will appear dirty as part of this skill's own work.

For each remaining dirty path, decide whether it belongs to **the selected task** or to **other parallel work** (e.g., another terminal window editing the same repo). Heuristics:

- Paths referenced in the selected task's `prd.md` / `implement.jsonl` / `check.jsonl` → selected task
- Paths in code areas matching the selected task's stated scope, or that you remember editing this session → selected task
- Paths in unrelated areas you have no recollection of touching this session → other parallel work

Then route:

- **Any remaining path looks like selected-task work** — bail out with:
  > "Working tree has uncommitted code changes from this task: `<list>`. Return to Close / Finalize and commit them before running `{{CMD_REF:finish-work}}`."

  Do NOT run `git commit` here. Do NOT prompt the user to commit. The user goes back to Close / Finalize and the AI drives the batched commit there.
- **All remaining paths look unrelated** (other parallel-window work) — report them once and continue to Step 3:
  > "FYI, dirty files outside this task's scope — leaving them for the other window: `<list>`."
- **Genuinely unsure** — ask the user once: "Are `<list>` this task's work I forgot to commit, or another window's? (commit / ignore)" — then route per their answer.

## Step 3: Archive task(s)

```bash
pactile task archive <task-name>
```

At minimum: the selected task (if any). Plus any extra tasks the user confirmed in Step 1. Each archive produces a `chore(task): archive ...` commit via the script's auto-commit.

If there is no selected task and the user did not confirm any cleanup archives, skip this step.

## Step 4: Record session journal

```bash
pactile session add \
  --title "Session Title" \
  --commit "hash1,hash2" \
  --summary "Brief summary"
```

Use the work-commit hashes produced in Close / Finalize (visible in Step 1's `Recent commits` list, or via `git log --oneline`) for `--commit`. Do not include the archive commit hashes from Step 3. This produces a `chore: record journal` commit.

Final git log order: `<work commits from Close / Finalize>` → `chore(task): archive ...` (one or more) → `chore: record journal`.
