# Pactile v1 contracts

Pactile v1 defines the host-neutral JSON boundary shared by Runtime, Tiles,
Kernel, Middleware, Adapters, migration, and exit operations. The contracts in
`packages/cli/src/core/pactile/` contain data validation only: they do not read or
write files, select Providers, compile Tiles, reconcile projections, or perform
migrations.

## Authority and ownership

The v1 authority model is:

1. `.pactile/` is the only writable canonical runtime root.
2. The two roots in the [compatibility input contract](compatibility-inputs.md#contract-inputs)
   may be declared only as `read-only` legacy sources.
3. `.agents/skills/`, `.cursor/`, optional `.codex/`, and managed instruction
   blocks are rebuildable projections, not a second source of truth. Codex
   project leaves are emitted only when the host reports native support.
4. An Adapter emits a `ProjectionPlanV1`; it does not write canonical state or
   host files. A later Reconciler is the sole projection writer.
5. The model selects, orders, and composes Tiles. Kernel validates composition
   boundaries; it is not a central planner.
6. A Tile requests an intent, minimum assurance, and policy ceiling. Middleware
   resolves a Provider. MCP is one possible Provider integration, never a Tile.
7. Existing native Skills, Plugins, and MCP installations remain owned by their
   user, host, or third party. Pactile may borrow and bind them without copying
   their content, credentials, OAuth state, or deletion rights.

## Parsing and fingerprints

Every top-level v1 record has `schemaVersion: 1` and a public parser:

```ts
import {
  parseTileManifestV1,
  type PactileContractParseResultV1,
  type TileManifestV1,
} from "@blxzer/pactile/core";

const result: PactileContractParseResultV1<TileManifestV1> =
  parseTileManifestV1(input);

if (!result.success) {
  for (const issue of result.issues) {
    console.error(issue.code, issue.path, issue.message);
  }
} else {
  console.log(result.data, result.fingerprint);
}
```

Parsers never throw for an invalid contract. Failure is
`{ success: false, issues }`; every issue has a code, JSON-style path, and
message. Success is `{ success: true, data, fingerprint }`.

V1 is deliberately strict:

- unknown schema versions, unknown fields, legacy spellings, invalid enums,
  and non-JSON values fail;
- fields are not silently defaulted—empty arrays and nullable values must be
  explicit;
- a future producer that needs new fields must publish a new schema version or
  down-project to v1;
- parsers return newly constructed canonical records and do not retain unknown
  input fields.

`fingerprintPactileContractV1` computes
`sha256:<lowercase hexadecimal digest>` over UTF-8 canonical JSON. Object keys
are sorted recursively, array order is retained, no insignificant whitespace is
emitted, and only finite plain JSON values are accepted. Every schema object's
`fingerprint(value)` method and every successful parse use this same rule.

`canonicalizePactileJsonV1` and `fingerprintPactileContractV1` assume their
caller is fingerprinting a validated JSON value; unlike contract parsers, they
throw `TypeError` for non-JSON or cyclic input.

## Runtime contracts

### `CanonicalPathsV1`

`DEFAULT_CANONICAL_PATHS_V1` freezes the initial layout:

| Field                                         | V1 value or rule                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `canonicalRoot`                               | Exactly `.pactile`                                                          |
| `writePolicy`                                 | Exactly `canonical-only`                                                    |
| `installStatePath`                            | `.pactile/runtime/install-state.json`                                       |
| `generationsPath`                             | `.pactile/runtime/generations`                                              |
| `tilesPath`                                   | `.pactile/tiles`                                                            |
| `tasksPath` / `archivePath` / `workspacePath` | Children of `.pactile/`                                                     |
| `ownershipLedgerPath`                         | `.pactile/runtime/ownership-ledger.json`                                    |
| `migrationJournalsPath` / `receiptsPath`      | Children of `.pactile/runtime/`                                             |
| `legacySources`                               | Exactly one entry for each of the two [compatibility roots](compatibility-inputs.md#contract-inputs), both with `access: read-only` |

Every writable path must be a normalized project-relative POSIX path inside
`.pactile`, and canonical paths must be unique. A legacy source cannot express a
write target.

### `InstallStateV1`

Install state identifies the active runtime version and generation, overall
status (`active`, `degraded`, or `inactive`), installed Adapters, last migration
journal, and creation/update timestamps. Adapter ids are unique. A reconciled
Adapter records its projection fingerprint and timestamp as a pair. Overall
`active` cannot hide a degraded Adapter, and `inactive` cannot contain an active
Adapter.

## Tile contract

`TileManifestV1` is a thin composition boundary, not a workflow language. It
contains only:

- stable `identity.id` and semantic `identity.version`;
- a model/explicit/both trigger and one or more of the four intents;
- logical input/output ids;
- dependency and conflict ids;
- filesystem/process/credential permissions;
- network/privacy/telemetry egress and allowed destination ids;
- a cost ceiling;
- an optional bounded fallback policy;
- stop conditions and an attempt limit;
- minimum assurance and required Evidence kinds.

Dependencies and conflicts are unique, disjoint, and cannot name the Tile
itself. Network-forbidden Tiles cannot declare remote privacy, remote telemetry,
or destinations. Evidence-backed and verified Tiles require at least one
required Evidence kind.

An enabled fallback must provide both a policy and minimum assurance. Its
permissions, destination allowlist, egress, credentials, telemetry, and cost
must remain within the Tile's primary ceiling, and its assurance must still meet
the Tile minimum. Disabled fallback uses explicit null policy and assurance.

There are no `steps`, planner, DAG, tool name, Cursor path, Codex path, prompt,
or arbitrary extension fields in this schema.

## Intent, assurance, and Provider contracts

The only public retrieval intents are:

```text
exact | semantic | structural | external
```

Assurance is an ordered quality level:

```text
best-effort < evidence-backed < verified
```

Provider origin is a separate, unordered fact:

```text
native | provider | heuristic | unsupported
```

Origin never grants assurance. In particular, `native` and `provider` do not
mean `verified`.

### `ProviderManifestV1`

A manifest declares a logical id/version, supported origin, intents,
capabilities, maximum assurance, policy ceiling, Evidence kinds, and probe
policy. It has no tool-name or MCP-server-name field. A provider claiming
evidence-backed capability must declare Evidence kinds. One claiming verified
capability must also declare a freshness-bounded probe.

### `ResolvedProviderV1`

A resolution records the requested intent, minimum assurance, origin, logical
provider identity, actual assurance, readiness, requested/effective policy,
Evidence references, freshness, probe result/time, and optional fallback
source.

A supported resolution is valid only when both conditions hold:

1. actual assurance meets the minimum; and
2. effective permissions, destination allowlist, egress, credentials,
   telemetry, and cost remain within the requested policy ceiling.

`evidence-backed` requires Evidence references. `verified` additionally
requires `fresh`, a `passed` probe, and `probedAt`. An `unsupported` resolution
has no provider id/version, assurance, effective policy, Evidence, or probe
claim and reports `unavailable` readiness.

## Native capability adoption

### `InstallHintV1`

An install hint is non-executable guidance: mechanism (`host-native`,
`package-manager`, or `manual`), symbolic localization label, optional logical
reference, and whether authentication is expected. Labels use the bounded
logical-id grammar rather than user-authored prose. References use only
`docs://`, `host-native://`, or `package-manager://` plus a bounded logical
payload; URL user-info, query strings, fragments, percent encoding, and inline
content are invalid. Payload segments also reject credential-bearing terms such
as `token`, `secret`, and `password`. Producers MUST emit only non-secret
registry handles; the grammar is a structural guard, not a content-classification
oracle. A missing external asset must include a hint. The contract has no field
for a credential value.

### `ExternalAssetRefV1`

An external asset reference records:

- logical id and kind (`skill`, `mcp`, `plugin`, `executable`, or `service`);
- source (`host-native`, `user-installed`, `pactile-bundled`, or explicit
  `project-vendored`);
- project/user/host scope;
- user/host/Pactile/third-party owner;
- source-scoped logical locator;
- optional content fingerprint, readiness, and install hint.

The locator scheme must equal the asset source (`host-native://`,
`user-installed://`, `pactile-bundled://`, or `project-vendored://`) and its
payload uses the same bounded logical-reference grammar. It is not a network
URL and rejects URL credentials, query parameters, fragments, inline content,
and credential-bearing terms. Producers MUST resolve non-secret registry
handles out of band and MUST NOT copy credential or asset content into a
locator. V1 intentionally has no asset-content, secret, credential, token, or
OAuth field.

### `CapabilityBindingV1`

Binding modes are `native`, `adopted`, and `composed`. Control is independently
`borrowed` or `pactile-owned`.

- native and adopted bindings are always borrowed and use
  `deleteBoundary: preserve`;
- any borrowed binding is non-owning and cannot gain deletion authority;
- Pactile-owned assets are introduced only as composed bundled or explicitly
  vendored assets and use `remove-when-unclaimed`;
- an MCP asset must bind through a logical `providerId`; other
  Provider-backed assets may also carry one.

Detach removes the binding, not the borrowed installation.

## Projection and ownership

### `ProjectionPlanV1`

An Adapter plan identifies the Adapter and canonical generation/fingerprint,
then emits stable operations. File operations (`ensure`, `merge`, `remove`)
carry a project-relative target; external assets use non-writing `bind` or
`detach` operations. Adapter targets may not enter `.pactile/`.

Borrowed resources can only be bound or detached. No projection or ownership
entry may target canonical `.pactile/` or either of the two read-only roots in
the [compatibility input contract](compatibility-inputs.md#contract-inputs).
`ensure` and `merge` require a content reference and desired
fingerprint. Merge is limited to JSON, TOML, or managed blocks. Removal carries
no desired content and requires an observed current fingerprint so a future
Reconciler can guard the delete.

The plan describes intent only. It grants no direct filesystem authority.

### `OwnershipLedgerV1`

Each projected resource records:

- stable host-neutral resource id, target, and format;
- origin: `created`, `adopted`, or `unknown`;
- control and external/Pactile/unknown owner;
- zero or more unique runtime/Adapter/Tile claimants;
- `preimage`, `generated`, and observed `current` snapshots;
- conflict classification and proposed disposition.

A snapshot is `absent`, `present`, or `unknown`. Present snapshots require a
fingerprint and may reference retained content; absent/unknown snapshots cannot
claim content.

The ledger is one-to-one: a resource id identifies exactly one physical target,
and a physical target has exactly one resource id. Target identity is NFC
normalized and case-folded for portable Cursor/Codex behavior, while the
original target spelling remains in the record. A Projection Plan likewise
cannot schedule two resource ids against one physical target.

The safety rules are:

- active claimants prevent restore or removal;
- multiple Adapters may claim one shared resource;
- borrowed resources may only be preserved or reviewed;
- unknown ownership is preserved for manual review;
- modified current content is preserved or reviewed;
- generated removal requires zero claimants and `current == generated`;
- adopted preimage restoration requires zero claimants, a non-null retained
  preimage `contentRef`, and unmodified generated content.

These are the data prerequisites for three-way update, detach, uninstall, and
recovery. The Reconciler algorithm is not implemented in Batch 0.

## Migration lifecycle

### `MigrationPlanV1`

A plan separates a fresh/canonical/legacy source from the `.pactile` target and
orders actions through:

```text
detect -> backup -> stage -> validate -> commit -> reconcile -> doctor
```

Legacy sources are read-only. The plan names one reversible
`activate-generation` action as `canonicalCommitPointActionId`. Projection
reconcile cannot precede it. `preservation.bytePreservedRefs` and
`transformedRefs` are disjoint so closed history/Evidence can be copied byte for
byte while active state is schema-migrated. Recovery always retains a backup
reference and `preserveNewerData: true`.

### `MigrationJournalV1`

The journal retains the plan fingerprint, explicit canonical commit state,
recovery state, independent Adapter reconcile records, and contiguous append
events. A committed journal retains backup, stage, validation, and canonical
commit events. The canonical commit action id must match its event.

Adapter reconciliation may start only after canonical commit. Each Adapter has
its own `pending`, `in-progress`, `succeeded`, or `failed` status, attempt count,
time, and error, so a failed Codex projection can be retried without undoing a
successful canonical commit or Cursor projection. An `in-progress` Adapter is
paired with overall `reconciling` state and a latest `adapter-reconcile-started`
event. Every attempt is a strict `adapter-reconcile-started` followed by exactly
one matching `adapter-reconcile-succeeded` or `adapter-reconcile-failed` event
for the same action. A later terminal event without a new unmatched start is
invalid. Attempt counters equal started-event counts, and `lastAttemptAt`
matches the latest Adapter event; neither field can manufacture a retry claim.
`completed` means every Adapter succeeded; `degraded` identifies at least one
failed Adapter.

## Composition Trace

`CompositionTraceEventV1` is one append-only observable event. Events cover Tile
discovery, eligibility, selection, ordering, invocation, completion, failure,
skip/fallback, Provider resolution, and Evidence recording.

Each event has stable trace/event ids, a sequence, timestamp, previous-event
fingerprint after sequence 1, a typed outcome, optional task/Tile/intent or
Provider-resolution reference, and artifact/Evidence references. Provider
resolution links the separately validated resolution fingerprint; its origin
and assurance remain separate.

The schema deliberately has no free-form metadata, prompt, rationale,
scratchpad, hidden reasoning, or chain-of-thought field. Private model reasoning
must never be encoded into Trace. Observable errors use only a symbolic
`PACTILE_<CODE>` value. Artifact and Evidence links use bounded
`artifact://<logical-ref>` and `evidence://<logical-ref>` grammars; arbitrary
URLs, prose, URL credentials, queries, fragments, and inline output are invalid.
Credential-bearing terms are rejected, and producers MUST use non-secret
registry handles rather than copying artifact, Evidence, or credential content
into the reference.

## Defaults and compatibility

- `DEFAULT_CANONICAL_PATHS_V1` is the only supplied record default.
- Enum constants expose the complete v1 value sets.
- Other records have no implicit defaults. Producers must state null, empty,
  unsupported, degraded, and borrowed conditions honestly.
- Array order participates in fingerprints. Producers that model a set should
  emit a stable order before persistence.
- V1 readers reject v2 rather than guessing. A future compatibility layer may
  explicitly down-project a newer record.
- Historical legacy-root data, old manifests, and Evidence are migration
  inputs, not silently normalized v1 writes.

## Explicit non-goals and prohibitions

Batch 0 does not implement Runtime I/O, a Tile compiler, Provider resolver,
Reconciler, migration executor, rollback, uninstall, purge, or an Adapter.

V1 contracts prohibit:

- writing a legacy root;
- Adapter writes to canonical `.pactile` state;
- fallback beyond authorization, privacy, destination, credential, telemetry,
  cost, or minimum-assurance bounds;
- treating Provider origin as assurance;
- deleting borrowed or unknown resources;
- a single Adapter deleting a still-shared resource;
- split resource ids claiming the same physical target;
- copying external Skill/MCP content or secrets into capability bindings;
- central planner/step DSL fields in Tiles;
- prompts, prose errors, arbitrary URLs, or private chain-of-thought in
  Composition Trace.
