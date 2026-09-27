# Known limitations

English | [简体中文](known-limitations.zh-CN.md)

These are explicit boundaries, not hidden failures:

- Codex desktop task coordination requires the current desktop task to call
  native App tools; the Node CLI only prepares and records requests. The Pi
  RPC bridge requires an independently installed and configured `pi`
  executable; it does not install models or provider credentials.
- Optional MCP and retrieval Providers are not installed or authorized by
  Pactile. Missing readiness is a valid `unsupported` or `degraded` result.
- A Provider result is a candidate until source, Git, tests, or a bounded
  receipt corroborates it.
- Detach and uninstall preserve canonical state; only an explicitly confirmed
  purge removes the canonical target set.
- The current CLI has no `doctor` command; use the diagnostic checks in the
  [doctor-style page](doctor.md).
- Full Core and CLI tests are a release-preflight gate, not a claim that every
  local change has run the whole suite.
