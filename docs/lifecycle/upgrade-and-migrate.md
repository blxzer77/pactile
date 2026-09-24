# Upgrade and migration

English | [简体中文](upgrade-and-migrate.zh-CN.md)

Separate a CLI upgrade from a project migration. Upgrade changes the global
tool; update reconciles one project; import reads an explicitly named legacy
source. Use a preview before every write.

| Intent                        | Command                                            | Write boundary                                                   |
| ----------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| Inspect project changes       | `pactile update --dry-run`                         | Read-only.                                                       |
| Apply reviewed project update | `pactile update`                                   | Canonical `.pactile/` and safe managed projections.              |
| Preview legacy migration      | `pactile migrate --dry-run`                        | Always read-only for this command.                               |
| Explicit legacy import        | See the [explicit import reference](../pactile/compatibility-inputs.md#explicit-import). | Reads the legacy tree; writes only canonical state after review. |
| Upgrade the global CLI        | `pactile upgrade --dry-run` then `pactile upgrade` | Package-manager scope, not project data.                         |

During the 0.5.x compatibility window, old inputs may be dual-read when a
receipt and ownership plan permit it. New output uses Pactile names and
`.pactile/`. Modified or foreign files are not silently migrated. If a preview
shows a checksum, manifest, or ownership conflict, preserve the preimage,
record the evidence, and resolve it before `--force`.

`pactile rollout --project <path> --dry-run --json` can aggregate previews for
explicitly listed projects; it must not be used as an implicit global scan.

## Existing installations moving to the Node entry (v0.6.0)

Run these commands from each installed project's root after installing the
v0.6.0 CLI:

```bash
pactile update --dry-run --json
pactile update --skip-all --json
pactile task list
```

The preview's `plan.files` lists added and refreshed Node-era templates,
`safeDeleted` candidates, `legacyPythonPreserved` files with local edits, and
`legacyPythonUnprocessed` files that are unclaimed or skipped. It also lists
`legacyPythonHashClaimsReleased` so retained scripts no longer appear owned by
Pactile. The apply report lists actual deletions. Inspect its backup path and
lifecycle/Adapter status;
resolve a degraded or interrupted result before relying on the new entry.
`--skip-all` keeps locally modified managed files; review each skipped file
before choosing a later overwrite. A retained `.pactile/scripts/*.py` file is
never included in the active Node generation. The update does not run Python,
and user tasks, specs, middleware, and foreign files remain outside the
replacement set.
