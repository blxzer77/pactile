# Change Local Task Lifecycle

Task lifecycle includes creation, selection, execution start, context configuration, archive, parent/child tasks, and lifecycle hooks. Project customization targets are `.pactile/tasks/` and `.pactile/config.yaml`; runtime behavior lives in the Pactile Node CLI.

## Read These Files First

1. `.pactile/workflow.md`
2. `.pactile/config.yaml`
3. `pactile task dashboard` and `pactile task selected --source`
4. The selected task's `.pactile/tasks/<task>/task.json`

## Common Needs And Edit Points

| Need | Edit point |
| --- | --- |
| Automatically sync an external system after task creation | `hooks.after_create` in `.pactile/config.yaml`. |
| Automatically update status after execution start | `hooks.after_start` in `.pactile/config.yaml`. |
| Clean external resources after archive | `hooks.after_archive` in `.pactile/config.yaml`. |
| Change default task fields | Pactile CLI Node implementation (product change). |
| Change task parsing/search | Pactile CLI Node implementation (product change). |
| Change selected task behavior | Pactile CLI Node implementation and platform session bridge. |

## lifecycle hooks

`.pactile/config.yaml` supports:

```yaml
hooks:
  after_create:
    - "node .pactile/hooks/my-sync.mjs create"
  after_start:
    - "node .pactile/hooks/my-sync.mjs start"
  after_archive:
    - "node .pactile/hooks/my-sync.mjs archive"
```

Hook commands receive the `TASK_JSON_PATH` environment variable, pointing to the task's `task.json`. Hook failures should usually warn, but not block the main task operation.

## Change Task Fields

If the user wants to add project-local fields, prefer putting them under `meta` in `task.json` to avoid breaking existing scripts' assumptions about standard fields.

Example:

```json
"meta": {
  "linearIssue": "ENG-123",
  "risk": "high"
}
```

If standard fields really need to change, update the Pactile CLI implementation and its contract tests.

## Change Selected Task

Selected task is session-level state stored in `.pactile/.runtime/sessions/`. Check `pactile task selected --source` and the platform session bridge when selection is lost. Do not fall back to a global `.current-task` model.

### `pactile task create` Does Not Select

`pactile task create` writes the task directory and planning artifacts only. The behavior:

- The task's `status=planning` is written.
- No selected-task pointer is written, even when session identity exists.
- The user or AI selects the task later with `pactile task select <dir>` when they explicitly choose to enter it.

This keeps new sessions and bare task creation at `Selected task: none` until a live-session choice is made.

If you add a new creation path to the Pactile product, verify that it does not auto-select or auto-start the created task.

## Modification Steps

1. Confirm the selected task with `pactile task selected --source`.
2. Read the selected task's `task.json` and confirm status and fields.
3. For configuration needs, edit `.pactile/config.yaml` first.
4. For runtime behavior needs, change the Pactile product source and verify the Node CLI.
5. If the AI flow changed, synchronize `.pactile/workflow.md`.

## Do Not

- Do not directly edit `.pactile/.runtime/sessions/` to "fix" business state.
- Do not hard-code project-private fields into scripts; prefer `meta`.
- Do not default to asking the user to fork Pactile CLI.
