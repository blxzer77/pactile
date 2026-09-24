# Skills as capability projections

English | [简体中文](skills.zh-CN.md)

A Skill is a reusable capability surface, not a second workflow. Pactile may
project a Tile into `.agents/skills/`, while Codex supplies the host
binding that discovers it. The canonical Tile definition and task policy stay
under `.pactile/`.

## Modes and evidence

| Observation                                  | Mode                                       | Evidence to record                             | User action                                                         |
| -------------------------------------------- | ------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------- |
| A host already exposes a compatible Skill.   | `native`/`adopted`                         | Host path, preimage, owner, and claimant.      | Bind it without rewriting the native bytes.                         |
| Pactile composes a Skill from a Tile.        | `provider`-independent managed projection  | Generation, manifest, and ownership receipt.   | Review the plan, then reconcile.                                    |
| A Skill is present but its semantics differ. | `degraded`/`unsupported`                   | Conflict details and current-byte fingerprint. | Rename, explicitly reuse, or skip; do not overwrite.                |
| A Skill is absent.                           | `unsupported` until installed or projected | Detection result and install hint.             | Install the external dependency yourself, or select a Pactile Tile. |

Shared identity is `resource kind + stable logical id` within a workspace. Two
hosts can claim one generated Skill. Detaching one host removes its claimant;
it never deletes a borrowed Skill, and it deletes a generated Skill only after
the last claimant leaves and the bytes are still a safe managed match.

## Inspect and update

```bash
pactile capability-smoke --json
pactile update --dry-run
```

Read the ownership ledger and projection receipt before accepting an update.
User-authored files and foreign resources remain outside Pactile's deletion
boundary. See [native adoption](native-adoption.md) for the complete state
machine.
