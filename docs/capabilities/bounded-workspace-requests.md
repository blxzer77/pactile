# Bounded workspace requests

PACTILE-32 provides a versioned, host-neutral request and result contract for
workspace file discovery, reading, literal search, and explicitly authorized
commands. The built-in Node adapter is available without Python, FastCtx,
`rg`, or another search provider.

## Request shape

Write one JSON request inside the workspace and pass its path to the CLI. The
request file must resolve inside the workspace and is limited to 256 KiB:

```json
{
  "schemaVersion": 1,
  "requestId": "inspect-readme-01",
  "operation": "search",
  "query": "capability",
  "directory": "packages/cli/src",
  "caseSensitive": false,
  "limits": {
    "timeoutMs": 30000,
    "maxOutputBytes": 131072,
    "maxFilesScanned": 1000,
    "maxResults": 100,
    "maxFileBytes": 262144,
    "maxBytesRead": 2097152
  }
}
```

Supported `operation` values are `discover`, `read`, `search`, and `run`.
Filesystem paths are workspace-relative POSIX paths. Discover and search may
omit `directory` or set it to `null` for the workspace root. Search uses
literal line matching and does not depend on Smart Search or any host tool.
Discover and search accept an optional zero-based `offset` (default `0`).
Discovery skips `.git`, `node_modules`, symbolic links, the runtime receipt
directory, and—when called through the CLI—the request JSON file itself.
Windows alternate data streams (colon paths) and reserved device names are
rejected.

Every request must include all six limits. The validator caps `timeoutMs` at
120 seconds, `maxOutputBytes` at 1 MiB, `maxFilesScanned` at 10,000,
`maxResults` at 1,000, `maxFileBytes` at 1 MiB, and `maxBytesRead` at 32 MiB.
`maxOutputBytes` must be at least 2 KiB and caps the complete compact JSON
result, including its envelope and receipt summary. CLI output is one compact
JSON line; its trailing newline also fits within the same byte limit.

## Outcomes and partial results

Every valid request returns `schemaVersion`, `requestId`, `operation`,
`outcome`, `partial`, `nextPage`, `data`, `error`, and `receipt`. Callers should branch on
`outcome` and `error.code`, not adapter branding or human-readable messages.

| Outcome        | Meaning                                                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `complete`     | The operation finished within its limits.                                                                                                                                              |
| `empty`        | The operation finished and found no content or matches.                                                                                                                                |
| `partial`      | A byte, file, result, or output limit stopped collection; `data` contains the bounded portion when it fits. A result page can also be partial with a non-null `nextPage` and no error. |
| `out_of_scope` | The caller policy denied the operation or a path resolved outside the workspace.                                                                                                       |
| `timed_out`    | The request deadline expired.                                                                                                                                                          |
| `cancelled`    | The caller cancelled the request.                                                                                                                                                      |
| `failed`       | The operation failed or an allowlisted command returned a non-zero status.                                                                                                             |

Stable error codes include `OUT_OF_SCOPE`, `NOT_FOUND`, `PERMISSION_DENIED`,
`TIMEOUT`, `CANCELLED`, `OUTPUT_LIMIT`, `SCAN_LIMIT`, `FILE_TOO_LARGE`,
`EXECUTION_FAILED`, `ADAPTER_UNAVAILABLE`, `REQUEST_ID_REUSED`,
`REQUEST_CLAIM_RETAINED`, and `REQUEST_CLAIM_LIMIT`. Empty results are not
errors. `REQUEST_CLAIM_RETAINED` means the request claim could not be verified
after it was created; the operation did not run and the incomplete claim was
retained. `REQUEST_CLAIM_LIMIT` means the receipt store already has 32 empty
claims, so the operation did not run. A `partial` scan does not prove that
omitted files or matches are absent. Discover and search return `nextPage` as the offset for the
next page when the current result page reached `maxResults` and the scan found
another result. Repeat the same operation and filters with a new `requestId`
and `offset` set to that value. `nextPage: null` means no page continuation is
available; if a scan/read budget stopped work, raise that budget and submit a
new request. Discover and search use stable path order. The workspace is
re-read for each page, so changes between page requests can shift offsets.

## Commands and cancellation

```sh
pactile capability request.json
pactile capability check.json --allow-command git
```

Command requests are denied unless the caller explicitly allowlists the
executable id. The adapter launches the executable directly with `shell: false`,
requires a workspace-relative working directory, and caps its argument bytes,
runtime, and captured output. It resolves an absolute executable outside the
workspace and removes relative or workspace-local entries from the child's
`PATH`. Timeout, cancellation, and output overflow terminate the process tree
before the result returns. The flag grants that executable the current OS
user's process permissions; it is not an operating-system sandbox. Only
allowlist commands and arguments that the caller trusts. Use Ctrl+C to cancel
the CLI request; programmatic adapter callers can pass an `AbortSignal`.

The CLI exits `0` for `complete`, `empty`, and `partial` results, `1` for
`out_of_scope`, `timed_out`, `cancelled`, and operation failures, and `2` when
the request file or request contract is invalid.

## Receipts

Successfully claimed first-use requests write a JSON receipt under
`.pactile/runtime/receipts/capabilities/<requestId>.json`. The response's
`receipt` identifies its schema version, request and result fingerprints,
adapter id, outcome, error code, returned entry count, operation data byte
count, timestamps, duration, and relative receipt path. Receipts do not store
request text, file contents, command arguments, or operation output. Reusing a
request id is rejected with `REQUEST_ID_REUSED` and does not create a second
receipt; invalid requests do not create receipts.

An incomplete claim is never removed automatically because its path may have
changed after creation. For `REQUEST_CLAIM_RETAINED`, retrying with a new
`requestId` is safe because the operation did not run. To reuse the old id or
clear `REQUEST_CLAIM_LIMIT`, inspect the exact claim file under the receipt
directory. Remove it manually only after confirming that the receipt directory
still resolves inside the workspace, the entry is a regular empty file, and no
request is active. The adapter refuses a new claim whenever its preflight sees
32 such empty files; resolve stale claims before retrying.
