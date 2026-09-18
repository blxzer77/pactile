# Install and initialize

English | [简体中文](install.zh-CN.md)

Create a project directory, install the canonical CLI, and choose the host
projection. `init` writes canonical `.pactile/` state and only the selected
host surfaces.

```bash
npm install -g @blxzer/pactile
mkdir my-pactile-project
cd my-pactile-project
pactile init --cursor --codex -y
pactile capability-smoke --json
```

Use `--cursor`, `--codex`, or both. `-y` accepts safe defaults; `--skip-existing`
preserves existing files and `--force` is for an explicitly reviewed overwrite.
Optional capabilities are selected with repeatable `--capability <id>` and do
not install their external Providers silently.

## Fresh, legacy, and mixed projects

| Project observation                                    | Action                                                              | Canonical effect                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| No `.pactile/` and no conflicting host files           | Run `init`.                                                         | Create a new generation and selected projections.             |
| A legacy runtime directory exists                      | Follow the reviewed [explicit import reference](../pactile/compatibility-inputs.md#explicit-import). | Import facts into `.pactile/`; never write the legacy source. |
| Both canonical and legacy or modified host files exist | Stop and inspect the plan.                                          | Preserve ambiguous bytes; resolve ownership before applying.  |

After initialization inspect `.pactile/runtime/install-state.json`, the
ownership ledger, and receipts. A successful init does not mean every optional
Provider is ready; use the JSON readiness output and its user action.
