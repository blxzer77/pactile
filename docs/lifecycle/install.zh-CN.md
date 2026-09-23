# 安装与初始化

[English](install.md) | 简体中文

创建项目目录，安装 canonical CLI，再选择宿主投影。`init` 写入 canonical `.pactile/` 状态和被选中的宿主表面。

```bash
npm install -g @blxzer/pactile
mkdir my-pactile-project
cd my-pactile-project
pactile init --codex -y
pactile capability-smoke --json
```

使用 `--codex` 选择当前宿主。`-y` 接受安全默认值；`--skip-existing` 保留已有文件，`--force` 只用于已审阅的覆盖。可选能力可重复传入 `--capability <id>`，不会静默安装外部 Provider。

## 新项目、legacy 与 mixed 项目

| 项目观察                                         | 动作                                      | canonical 影响                              |
| ------------------------------------------------ | ----------------------------------------- | ------------------------------------------- |
| 没有 `.pactile/` 且宿主文件无冲突                | 运行 `init`。                             | 创建 generation 与选定投影。                |
| 存在 legacy runtime 目录                         | 按已审阅的[显式导入参考](../pactile/compatibility-inputs.zh-CN.md#显式导入)执行。 | 将事实导入 `.pactile/`；永不写 legacy 源。  |
| canonical 与 legacy 或 modified 宿主文件同时存在 | 停止并检查 plan。                         | 保留不明确的字节，解决 ownership 后再应用。 |

初始化后检查 `.pactile/runtime/install-state.json`、ownership ledger 与 receipt。init 成功不代表每个可选 Provider 已 ready；应读取 JSON readiness 与 user action。
