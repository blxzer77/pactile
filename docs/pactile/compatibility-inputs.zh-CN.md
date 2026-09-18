# 兼容输入（0.5.x）

[English](compatibility-inputs.md) | 简体中文

本参考列明支持的旧输入，不是另一套产品安装指南。新项目、写入、包和托管投影使用
Pactile 名称。[兼容策略](../governance/compatibility.zh-CN.md)规定归属与退出边界。

## 契约输入

v1 `CanonicalPathsV1.legacySources` 契约恰好包含一个 `.cstl` 和一个 `.trellis`
条目，两者均为 `access: read-only`。它们不能成为 canonical 写入目标，也不能成为
投影或 ownership ledger 的目标。历史源字节、manifests 和证据保持不变；导入需要
显式审阅，只写 canonical `.pactile/` 状态。

## 显式导入

审阅可读的 `.cstl` 源后，仅在没有 `.pactile` 的 checkout 中，或恢复可恢复的导入
journal 时，使用 `pactile init --import-cstl -y`。该选项不授予源目录写入权限。
`.trellis` 是只读契约输入，不构成隐式导入或归属授权。

## 桥接与退役链接

`cstl` 可执行入口是带警告的别名。`@blxzer/cursor-trellis` 和
`@blxzer/cursor-trellis-core` 是指向 canonical 包的薄桥接，不是第二套实现。
它们的 bin 归属和精确依赖边仍属于 release conformance。

旧文档 URL 仅保留短兼容跳转。退役的 Cursor++ 操作只属于
[历史页面](../history/cursor-plus-plus.zh-CN.md)，不是当前安装步骤。
归档演示资源是历史证据，不是当前产品图像。

## 退出条件

- 可执行入口与包桥接不早于 0.6.0 重新评估。
- 只有存在已验证 receipts 且无剩余归属 claimants 时才能退出迁移 reader；
  v1 契约变化需要独立的版本迁移。
- 旧 URL 跳转在 0.5.x 兼容窗口结束且链接审计完成后才能退出。
- 历史资源和法定归属信息保持不变。
- 兼容回归用例随其覆盖的行为退出；canonical 输出与品牌负向检查必须保留。
