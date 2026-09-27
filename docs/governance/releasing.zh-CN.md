# Pactile 发布

[English](releasing.md) | 简体中文

v0.6.0 只有一个公开 npm 包：`@blxzer/pactile`。tarball 同时包含 CLI 与 Core
契约。已发布的 0.5.x 独立 Core 和旧名称桥接包保留为 npm 历史；新流程不再构建或发布它们。

## 分支与 PR

`feat/*`、`fix/*`、`chore/*` PR 只进入 `develop`。分支 Push 和 PR 只触发
CI 验证。beta 版本在 `develop` 准备，经明确授权后打
`pactile-vX.Y.Z-beta.N` tag。tag 必须指向当前 `develop` 的精确 HEAD；发布
工作流验证单包 tarball 后发到 npm `beta`。

本地预检运行 `pnpm --filter @blxzer/pactile run release:check`。
`pnpm --filter @blxzer/pactile run release:beta` 和
`pnpm --filter @blxzer/pactile run release:promote` 只生成候选计划，不会打 tag 或发包。
经单独明确授权后，beta tag 必须指向 `develop` 的精确 HEAD。发布 PR 合入后，
正式版 `pactile-vX.Y.Z` tag 必须指向 `main` 的精确 HEAD。稳定版晋级需另行批准并
通过 Publish workflow 手动执行。

beta 验收后，只修改包版本到 `X.Y.Z` 以及发布文档/changelog，再开
`develop` → `main` 发布 PR。PR 正文须包含以下字段：

```text
Beta tag: pactile-v0.6.0-beta.<accepted-N>
Beta validation: https://github.com/blxzer77/pactile/actions/runs/<成功的发布运行 ID>
Beta acceptance: <beta 实际安装和行为验收结果>
Post-beta changes: packages/cli/package.json, packages/cli/CHANGELOG.md
```

PR 检查会核对 beta tag、对应提交成功的 Publish 运行、当前 `develop` HEAD、
正式包版本及 beta 之后的全部变更。beta 后若改了产品代码、依赖、锁文件或
工作流，必须重新发布并验收 beta。仅文档与版本字段可在 beta 后变化，且应
逐项列在 `Post-beta changes`；完全没有变化时填 `none`。

发布 PR 合入后，经单独明确授权，在当前 `main` 精确 HEAD 打正式版
`pactile-vX.Y.Z` tag，唯一包先发到 `candidate`。之后单独确认并手动运行
Publish 的 promotion，将核对过的 candidate 提升到 `latest`。实际远端晋级
及发布验收由 v0.6.0 最终发布门槛负责。

## 本地预检

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm release:check
pnpm --filter @blxzer/pactile check:pack-files
pnpm --filter @blxzer/pactile check:release-pack
pnpm docs:smoke
pnpm --filter @blxzer/pactile exec tsx scripts/check-pactile-brand-surface.ts --release
node packages/cli/.tmp/p31-script-build/release-conformance.js
```

一致性检查使用 npm 默认生命周期脚本安装封装包。PATH 中的 Node 来自仅含
Node 可执行文件（Windows 为 `node.exe`）的私有目录（另含操作系统支持目录），npm 通过绝对路径调用
`npm-cli.js`；安装前会检查 PATH 中没有 Python 或 Pi 可执行文件，
覆盖全新 init、V2 Task 创建/启动/读回、两个相互独立 V2 Task 的同波次调度与模拟 Pi
派发、update 预览/应用后再次创建/启动/调度/模拟 Pi 派发 V2 Task，以及 legacy Codex
bridge 的 prepare/receipt 流程。它不覆盖 Task 归档，也不覆盖独立的 legacy
`runParallelBatch` 路径。耗时输出是本机基线，不是延迟承诺。
本机离线预演可在 `pnpm install --offline` 后设置
`PACTILE_CONFORMANCE_OFFLINE=1`；该模式解开封装包，并链接本地锁定的依赖。
CI/默认模式会执行全新 npm 安装。真实桌面宿主及模型 Provider 验收应分开记录。

tag 工作流在封装 tarball 前重复质量门槛。准备 Job 只有只读权限且没有发布凭据；
独立的发布 Job 获取 GitHub OIDC 权限，通过 npm Trusted Publisher 发布已经
封装的产物。npm Trusted Publisher 需绑定 `blxzer77/pactile`，工作流文件名只填
`publish.yml`，并允许直接执行 `npm publish`。manifest SHA-256 收据保存在 artifact 目录
之外。来源、包图、tarball、收据或 npm 回读失败都会阻断发布或晋级。

计划、dry run、CI 通过或本地合入都不自动授权 Push、合入 `main`、打 tag、
发包或晋级。历史 changelog、tag、迁移清单和署名保持原样。
