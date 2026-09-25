# Minimal Pactile project

English | [简体中文](README.zh-CN.md)

This example checks the compiled CLI and initializes a disposable Codex project under `_demo-workspace/` next to the scripts. It never initializes the Pactile source checkout itself.

## Prerequisites

- Node.js 20 or newer
- Either a global `@blxzer/pactile` installation or a built checkout of this repository

## Run it

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
cd examples/minimal-agent-app
./demo.sh
```

On Windows PowerShell:

```powershell
pnpm install --frozen-lockfile
pnpm build
Set-Location examples/minimal-agent-app
./demo.ps1
```

Both scripts require Node.js 20 or newer and initialize the Codex integration. They prefer the repository's compiled `packages/cli/dist/bin/pactile.js`; if it is unavailable, they call the global `pactile` executable. Each run replaces the disposable `_demo-workspace/` directory. Set `PACTILE_DEMO_WORKSPACE` to use a different disposable path.

## Expected contract

The demo will:

1. Create a clean `_demo-workspace/`.
2. Check the CLI version and confirm `pactile init --help` advertises `--codex`.
3. Run `pactile init --codex --yes --skip-readiness --user pactile-demo`.
4. Print the canonical and Codex projection roots.

The resulting shape includes:

```text
_demo-workspace/
  .pactile/
  .agents/
  AGENTS.md
```

Codex uses the canonical `.pactile/` state and shared `.agents/` projection; the
CLI does not create a native `.codex/` tree during baseline initialization.

Capability output may honestly be `degraded` when an optional provider is not installed or ready. That does not invalidate canonical initialization; read the reported user action instead of treating provider absence as native support.

## What to inspect

- `.pactile/runtime/install-state.json` identifies the active generation and adapter status.
- `.pactile/runtime/ownership-ledger.json` records projected resources and claimants.
- `.pactile/runtime/receipts/` keeps durable lifecycle Evidence.
- `.agents/skills/` contains the shared skills projected for Codex; `.codex/` is optional and only appears when native Codex project support is ready.
- `.agents/skills/` and the managed `AGENTS.md` block may be shared by both adapters.

The demo scripts are part of the Batch 4 dogfood contract. Their commands must stay identical to this page and the root quick start.

Continue with [Core concepts](../../docs/concepts/index.md), [Hosts](../../docs/hosts/index.md), or [Lifecycle](../../docs/lifecycle/index.md).
