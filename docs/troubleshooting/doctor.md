# Doctor-style diagnostics

English | [简体中文](doctor.zh-CN.md)

There is no separate `doctor` executable in the current CLI. Use the following
read-only checks as the supported diagnostic path and report their output
instead of inventing a health result.

```bash
pactile capability-smoke --json
pactile update --dry-run
```

Interpret the result by layer:

| Result                          | Meaning                                               | Next action                                                     |
| ------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| JSON capability `ready`         | The selected Provider passed its declared probe.      | Check assurance and freshness before using it.                  |
| `pending` or readiness unknown  | No current probe proves availability.                 | Authorize/install the dependency, then re-run the check.        |
| `failed`/`degraded`             | The capability or projection is bounded to a failure. | Follow its user action; keep canonical state and retry locally. |
| Update preview reports conflict | Ownership or current bytes are not safe to replace.   | Preserve the preimage and resolve ownership explicitly.         |
