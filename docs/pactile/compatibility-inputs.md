# Compatibility inputs (0.5.x)

English | [简体中文](compatibility-inputs.zh-CN.md)

This reference names supported legacy inputs; it is not an alternative product
installation guide. New projects, writes, packages, and managed projections use
Pactile names. The [compatibility policy](../governance/compatibility.md) defines
the ownership and retirement boundaries.

## Contract inputs

The v1 `CanonicalPathsV1.legacySources` contract contains exactly one `.cstl`
entry and one `.trellis` entry. Both have `access: read-only`. These roots may
never be canonical write targets or projection/ownership-ledger targets.
Historical source bytes, manifests, and evidence remain unchanged; import
requires explicit review and writes only canonical `.pactile/` state.

## Explicit import

After reviewing a readable `.cstl` source, use `pactile init --import-cstl -y`
only from a checkout without `.pactile`, or to resume a recoverable import
journal. The option does not grant permission to write the source. A `.trellis`
root is a read-only contract input, not an implicit import or ownership grant.

## Alias and retired links

The `cstl` executable remains a warning alias within the single Pactile
package. Previously published compatibility packages are historical npm
releases; they are not built, shipped, or validated in the current release
graph.

Old documentation URLs remain short compatibility pointers. Retired Cursor++
procedures belong only to the [history page](../history/cursor-plus-plus.md);
they are not current installation steps. Archived demo resources are historical
evidence, not current product artwork.

## Exit conditions

- Keep the `cstl` warning alias explicit until its own removal decision.
- Retired compatibility packages stay outside the v0.6.0 release graph.
- Retire migration readers only after verified receipts and no remaining
  ownership claimants; a v1 contract change needs its own version transition.
- Retire old URL pointers after the 0.5.x compatibility window and a link audit.
- Keep historical resources and legally required attribution unchanged.
- Remove compatibility regression cases only with the behavior they cover;
  canonical-output and negative brand guards must remain.
