# Pactile 最小项目

[English](README.md) | 简体中文

这个示例执行与仓库首页相同的五分钟路径，但始终在脚本旁创建一次性的 `_demo-workspace/`。它不会在 Pactile 源码 checkout 内执行初始化。

## 前置条件

- Node.js 20 或更高版本
- Python 3.9 或更高版本，用于生成的脚本与 hooks
- 全局安装 `@blxzer/pactile`，或已经构建当前仓库

## 运行

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm build
cd examples/minimal-agent-app
./demo.sh
```

Windows PowerShell：

```powershell
pnpm install --frozen-lockfile
pnpm build
Set-Location examples/minimal-agent-app
./demo.ps1
```

脚本优先使用当前仓库构建后的 `packages/cli/dist/bin/pactile.js`；找不到时再使用全局 `pactile` executable。

## 预期契约

Demo 会：

1. 创建干净的 `_demo-workspace/`。
2. 运行 `pactile init --cursor --codex -y`。
3. 运行 `pactile capability-smoke --json`。
4. 输出 canonical root 与宿主 projection root。

结果包含：

```text
_demo-workspace/
  .pactile/
  .agents/
  .cursor/
  AGENTS.md
```

Codex 使用 canonical `.pactile/` 状态与共享的 `.agents/` projection；CLI 的 baseline 初始化不会创建原生 `.codex/` 目录。

未安装或未就绪的可选 Provider 可能让 capability 输出真实显示为 `degraded`。这不等于 canonical 初始化失败；应阅读报告中的用户动作，而不是把 Provider 缺席伪装成 native support。

## 可以检查什么

- `.pactile/runtime/install-state.json` 标识 active generation 与 Adapter 状态。
- `.pactile/runtime/ownership-ledger.json` 记录投影资源与 claimant。
- `.pactile/runtime/receipts/` 保留持久生命周期 Evidence。
- `.cursor/` 是生成的宿主投影；`.codex/` 为可选目录，仅在原生 Codex 项目支持就绪时出现。
- `.agents/skills/` 与受管 `AGENTS.md` block 可以由两个 Adapter 共享。

Demo 脚本属于 Batch 4 dogfood 契约。它们的命令必须与本页及根 README 的五分钟路径保持一致。

下一步可读[核心概念](../../docs/concepts/index.zh-CN.md)、[宿主](../../docs/hosts/index.zh-CN.md)或[生命周期](../../docs/lifecycle/index.zh-CN.md)。
