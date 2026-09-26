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

<a id="p36-held-task-reconciliation"></a>
## Held Task reconciliation after P36 import

P36 imports legacy Task records through the project `update` command. Inspect the
plan first, then apply the update. In an interactive terminal, confirm
`pactile update` after review. The `--skip-all` example below is for a confirmed
non-interactive update that should preserve every locally modified managed file:

```bash
pactile update --dry-run --json
pactile update --skip-all --json
pactile task list
```

`pactile task list` shows unresolved imported items as `needs definition` or
`needs dependency coordination` and marks them `not runnable`. Add a missing
definition or map dependencies only for those held Tasks. Use `--check` to
inspect the reconciliation plan for one Task before applying it:

```bash
pactile legacy-task reconcile .pactile/tasks/09-26-v050-migration-sample \
  --idempotency-key p36-migration-definition-2026-09-26 \
  --activation-at 2026-09-26T12:00:00.000Z \
  --deliverable "An explicitly defined migrated Task" \
  --delivery-level local-result \
  --accept "AC-1=The original Task source remains available" \
  --accept "AC-2=The V2 Task begins without inferred lifecycle history" \
  --check
```

The `AC-1=` and `AC-2=` prefixes in these examples are literal parts of the
`--accept` description values, not submitted criterion IDs; reconciliation
generates its own V2 criterion IDs.

Fill the definition from the source record and project evidence. A
`needs-coordination` Task also requires an explicit
`--resolve-dependency "<legacy-reference>=<existing-task-id>"` for every pending
reference. Pass the same mappings to the check and approved execution. After
reviewing the plan, use the same arguments and idempotency key, replacing the
final `--check` with `--approved`:

```bash
pactile legacy-task reconcile .pactile/tasks/09-26-v050-migration-sample \
  --idempotency-key p36-migration-definition-2026-09-26 \
  --activation-at 2026-09-26T12:00:00.000Z \
  --deliverable "An explicitly defined migrated Task" \
  --delivery-level local-result \
  --accept "AC-1=The original Task source remains available" \
  --accept "AC-2=The V2 Task begins without inferred lifecycle history" \
  --approved
pactile task artifacts 09-26-v050-migration-sample --agent
```

`--check` returns a dry run and does not write or activate the Task. `--approved`
activates only this held Task. Reconciliation uses a new migration generation,
preserves the original `task.json` and authored documentation byte-for-byte, and
does not infer V2 Run, Review, or Close history. An activated Task accepts only
a retry with the same idempotency key and request; a different request cannot
redefine it. If source files change after import, reconciliation is rejected;
inspect `pactile task list` and the source state before deciding whether to
retry. For the structured Task artifact read pattern, see the
[Chinese structured Task artifacts guide](../capabilities/structured-task-artifacts.zh-CN.md).

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

The unpublished `0.5.1-beta.0` pool preset is part of the `0.6.0-beta.1`
migration manifest, also shipped with stable `0.6.0`. It runs for both direct
`0.5.0` to stable upgrades and beta upgrades, without repeating during
beta-to-stable upgrades. Only three old skeleton paths are candidates for
hash-checked deletion: `.pactile/pool/README.md`, `.pactile/pool/plan.md`, and
`.pactile/pool/items/.gitkeep`. User-written pool items are never targeted.
There is no separate `0.5.1-beta.0` upgrade step.

Before a release, maintainers run the sealed-tarball
[`release-conformance.ts`](../../packages/cli/scripts/release-conformance.ts)
check. It measures CLI cold start, a subsequent CLI invocation, Pi cold and
warm RPC startup, parallel batch wall time, and total smoke time in a PATH
without Python. The Codex receipt and Pi responses in this smoke are simulated;
record actual desktop-host and provider outcomes separately.
