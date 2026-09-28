# Reuse before building

English | [简体中文](reuse-first.zh-CN.md)

Pactile's Define, Execute and Verify Skills direct agents to the installed
`.pactile/framework/reuse-first-guide.md`. Fresh init and update use the same
framework template registry and Skill projection ownership checks. Modified
host Skills are preserved for explicit conflict resolution; installation alone
does not prove that a preserved Skill has adopted new instructions.

Before selecting an implementation, inspect project/environment capabilities and
actively research mature external alternatives through permitted search. Compare
fit, maintenance, license, runtime/platform, dependency burden, integration and
long-term ownership cost. Reuse a suitable option with a small adapter; local
implementation is valid when its concrete advantages justify the ownership.

Record the choice, evidence and unknowns in Task `design.md` under
Decision/Rationale/Risk. The existing structured artifact index makes these
authored sections discoverable and reads them by current fingerprint. No new
runtime decision store, search engine or dependency is needed.

## Efficient boundaries

- Reuse prior research when constraints and evidence remain applicable; refresh
  changed facts rather than rerunning a survey for a small repair.
- Honor explicit from-scratch instructions and record their rationale and risks.
- Search unavailable or prohibited: state the boundary, distinguish local evidence
  from unverified external claims, and continue only within existing authority.
- Research sufficiency depends on the decision, not a search quota.
- Review checks behavior and rationale, not library or search-call counts.

The guide grants no network, installation or data-egress permission. Baseline
Tile policies and project privacy rules still apply. Use the host/project's
authorized capabilities; Pactile requires no particular provider, model or proxy.
Instructions are behavioral guidance, not an OS sandbox or a guarantee of model
compliance. Existing approval, independent Review and Kernel Close gates remain.

The compact record follows the decision-and-rationale approach described by
[MADR](https://adr.github.io/madr/), without requiring its package or copying its
template. For npm alternatives, [official package metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)
can inform license and compatibility checks; metadata alone does not establish
maintenance or suitability.
