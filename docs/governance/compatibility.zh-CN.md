# 兼容性与迁移策略

[English](compatibility.md) | 简体中文

0.5.x 兼容窗口已成为历史。当前文档、命令、package、bin 与生成状态使用 Pactile 名称。legacy 输入只有在迁移路径显式且可审阅、并且只写 canonical `.pactile/` 状态时才可读取。

| 表面                      | 当前规则                                                         | 退出条件                                   |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| Legacy 项目输入           | 显式只读 import；保留源。                                        | 验证 migration receipt 且不再有 claimant。 |
| 旧可执行别名              | 单一 Pactile 包内带警告的别名。                                   | 仅通过明确的发布决议移除。                 |
| 历史兼容包                | 不进入 v0.6.0 构建或发布图。                                      | 保留已发布的历史。                         |
| Managed marker 或 block   | 只有 ownership evidence 支持时识别；只输出一个 canonical block。 | 所有活跃项目使用 canonical marker。        |
| 历史 release/tag/manifest | 不可变事实。                                                     | 永不把历史改写成当前说明。                 |

不要承诺未记录的宿主 parity 或 Provider 可用性。[原生 adoption 模型](../capabilities/native-adoption.zh-CN.md)与[升级指南](../lifecycle/upgrade-and-migrate.zh-CN.md)定义用户可见边界。
