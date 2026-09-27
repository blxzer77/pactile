# Code Graph and MCP Setup

Pactile does not recommend a specific code-graph or AST tool. Which one is worth running depends on your language mix, the license you can accept, the index size you are willing to carry, and whether the tool writes into files Pactile also manages. Those trade-offs belong to the project, not to this skill.

Use whatever code graph, AST, or language tooling you already have, and register it through your agent host's own MCP mechanism. If you have nothing installed, direct source reads plus exact search are enough to bootstrap specs — the workflow does not require a graph.

## What to check before adopting a tool

- **License.** Several popular code-graph tools are source-available rather than open source. Check the actual terms before making one a recommendation for a commercial codebase.
- **Index cost.** Graph indexes can be large and can add resident context across a long session. Prefer a tool you can afford to keep indexed over one you will disable after the first pass.
- **Side effects on shared files.** Some tools write `AGENTS.md` / `CLAUDE.md` or register host hooks on their own. That can collide with the Pactile managed block. Reconcile deliberately instead of letting two writers fight over one file.
- **Overlap.** If you already run something that resolves symbols and call chains, a second graph tool usually adds cost without adding evidence.

## Using it during spec bootstrap

Register the server in your host's MCP configuration, verify from the agent host that it is actually visible, then run one simple query before starting the spec-writing pass. A tool that is configured but not loaded is worse than no tool: it invites claims that were never checked.

Whatever you use, confirm a result against the current source before writing it into a spec. Graph and AST output is orientation, not proof.
