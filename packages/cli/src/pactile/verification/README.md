# Verification choice

`createVerificationPlan` is a pure, deterministic selector. The caller supplies
semantic impact (`changedSurfaces`, scope, and explicit risk signals) and a
trusted inventory of available checks. It picks a low-cost set of independent
public-behavior checks that covers those goals, records every omitted check and
why it was omitted, and always retains checks marked as required by project or
policy CI.

The inventory is deliberately explicit. A test is not considered relevant just
because its file path resembles a changed source file. A suite must declare the
public surfaces and risk signals it checks. Implementation-mirroring tests are
reported as skipped and never count as behavior evidence. A missing independent
check leaves an uncovered goal in the plan instead of silently passing.

Routine single-area changes do not receive an automatic full-suite check. If a
routine change has no focused independent check, the plan reports missing
behavior evidence instead of silently falling back to the full suite. A full
suite becomes eligible only for a cross-module or repository-wide scope, or
when an explicit risk signal makes broader verification appropriate. Among
eligible checks, the selector chooses those that add coverage for a declared
goal and provide the best remaining value for their cost. Cross-module,
migration, release, permission-boundary, data-egress, and repository-wide
signals create explicit coverage goals that can select matching checks.

This module only proposes a plan. It does not run commands, record results,
bind evidence to a candidate fingerprint, establish candidate freshness, or
authorize task Close. Recompute from the current impact and check inventory at
each caller decision; P35/P38 observer and freshness seams must bind the later
execution receipt to the frozen candidate before a Close gate can consume it.
