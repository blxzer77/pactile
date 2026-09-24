# Agent responsibilities

The main Codex task owns planning, integration, verification, and final acceptance. Pactile does not install Codex subagent role files or dispatch Codex subagents.

Independent Codex desktop tasks use App native tools with `pactile codex prepare|receipt|status` request and receipt records. The Node CLI cannot invoke those native tools itself. Record objective, task identity, and evidence; do not treat a message as acceptance.

Use `.pactile/spec/` for project rules and `AGENTS.md` for concise managed entry instructions. Do not create agent files in a legacy host directory.
