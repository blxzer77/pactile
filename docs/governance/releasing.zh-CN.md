# 发布

[English](releasing.md) | 简体中文

只有候选经过审查且发布负责人显式授权后才开始 release。Batch 4 RC candidate 不是已发布 release。

## 候选 preflight

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm release:check
pnpm --filter @blxzer/pactile check:pack-files
pnpm --filter @blxzer/pactile check:release-pack
pnpm mirror-check
node packages/cli/scripts/check-pactile-brand-surface.js --release
pnpm --filter @blxzer/pactile exec vitest run test/docs/documentation-parity.test.ts
pnpm docs:smoke
node packages/cli/scripts/release-conformance.js
```

在获批 release 前立即运行一次完整 Core 与 CLI suite。将 commit、package version、tarball manifest、conformance matrix、文档 gate 与全量结果一起记录。

## 发布边界

四包顺序是 core → CLI → legacy core bridge → legacy CLI bridge。每个 tarball 先 sealed 并检查，再进入下一个 package。发布需要精确 release tag、已验证 provenance、临时 registry credential 与发布后可见性检查。dry-run、plan 或 RC artifact 都不表示可以打 tag、publish、合入 release 分支或创建 GitHub Release。

历史 changelog 条目、tag、manifest 与署名保持不变。
