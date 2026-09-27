# Local architecture

`.pactile/` holds canonical workflow, tasks, and runtime state. `AGENTS.md` and `.agents/skills/` are the current projected Codex entry surfaces. The ownership ledger records generated claims and protects user-owned content.

Task artifacts contain requirements and evidence. Project rules belong in `.pactile/spec/`. A host integration is ready only after observed readiness and projection checks, not merely because a directory exists.

The Codex cross-session bridge connects independent desktop tasks to Pactile Task lifecycle through Node request and receipt records. The App host invokes its native tools; this bridge is separate from project-file projection.
