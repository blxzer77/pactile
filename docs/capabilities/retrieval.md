# Retrieval and assurance

English | [简体中文](retrieval.zh-CN.md)

Retrieval is a routing policy, not a promise that every host has the same
search tool. Pactile uses four intents and reports the minimum assurance that
the active host and Provider facts actually support.

| Intent       | First route                            | Optional route            | Required proof                                         |
| ------------ | -------------------------------------- | ------------------------- | ------------------------------------------------------ |
| `exact`      | `rg`, path and literal search          | None required             | Read the current file and range.                       |
| `structural` | Explicit codegraph or equivalent       | Host structural adapter   | Confirm returned symbol/range in source.               |
| `semantic`   | Project-authorized semantic Provider   | Host-native semantic tool | Check binding, freshness, and policy; then exact-read. |
| `external`   | Explicit Provider such as smart-search | Approved web fallback     | Preserve source URL, timestamp, and relevance.         |

Run the capability check before claiming optional readiness:

```bash
pactile capability-smoke --json
```

Host identity or a user-global route file never selects a Provider. If a
Provider is absent, stale, unauthorized, or beyond the privacy policy, label
the result `heuristic`, `degraded`, or `unsupported` and continue with exact
search where safe. Candidate retrieval is not final Evidence until a current
source, Git diff, test, or bounded receipt corroborates it.

## Privacy boundary

External intent may send only the user-approved query and permitted context to
the selected Provider. Never send credentials, private logs, hidden reasoning,
or an entire repository by default. See [Providers](providers.md) and
[privacy and permissions](privacy-and-permissions.md).

## Optional Jev planning advice

The asynchronous `pactile context --mode session --json` path may ask Jev
whether to add semantic or structural routes when the V2 Session has a fact
gap and no caller-specified intents. It always keeps `exact`. Jev cannot add
`external`, authorize a Provider, or change Kernel policy. The current request
contains only a locally generated summary of the V2 phase and fact-gap state;
it never sends the user-controlled Task title, deliverable, or source snippets.
The bounded Task text is checked locally for known credentials, assignments,
JSON fields, cookie/session/authorization fields, URL user-info, and sensitive
markers. A match falls back before HTTP. This is intentionally conservative for
structured text; arbitrary unmarked secret values cannot be identified
reliably, so raw Task text stays local in all cases.

Project configuration can explicitly allow or deny this planning egress:

```yaml
jev:
  egress: deny
```

When `jev.egress` is omitted, a valid or absent `.pactile/config.yaml` defaults
to allowing this bounded advice if `PACTILE_JEV_API_KEY` is configured.
`PACTILE_JEV_ENABLED=false` disables it. `egress: allow` records the default
explicitly; `egress: deny` blocks the request. Unknown values, ambiguous Jev
entries, or config read and parse uncertainty fail closed to the deterministic
exact plan. The key stays in the process environment and is never written to
the Session receipt.

This project switch governs Jev retrieval planning. Tile-selection Session
advice continues to use its existing Task Run grant until that path adopts the
shared project policy.
