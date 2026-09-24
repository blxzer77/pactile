# Host integrations

English | [简体中文](index.zh-CN.md)

Pactile keeps one canonical project state and projects it into Codex. Host
pages describe the observable support contract; they do not imply that a
host-native tool or provider is installed.

## Choose a path

| Need | Start here | Result |
| --- | --- | --- |
| New project | [Codex](codex.md) | `.pactile/`, managed `AGENTS.md`, and `.agents/skills/`; optional native bindings depend on readiness. |
| Old Cursor installation | [Lifecycle safety](../lifecycle/index.md) | Preview legacy cleanup with `pactile detach cursor --dry-run`. |

Every host follows the same sequence:

```text
detect -> install or adopt -> bind -> reconcile -> report readiness
```

Detection is read-only. If a native dependency is missing, Pactile reports an
installation hint; it does not install a host tool or copy credentials. A
successful canonical install can therefore coexist with a `degraded` optional
capability.

## Common first run

```bash
npm install -g @blxzer/pactile
pactile init --codex -y
pactile capability-smoke --json
```

Read the JSON readiness and user action
before treating a capability as available. Continue with [capability
origins and providers](../capabilities/index.md) or [lifecycle safety](../lifecycle/index.md).
