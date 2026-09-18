# `@blxzer/pactile`

[English](README.md) | 简体中文

Pactile CLI 为 Cursor、Codex 或双宿主建立并维护可追溯证据的能力工作空间。Canonical 状态位于 `.pactile/`；宿主文件是可重建投影，并受显式 ownership 约束。

## 安装

```bash
npm install -g @blxzer/pactile
pactile --version
```

需要 Node.js 18.17 或更高版本。生成的 Python 脚本与宿主 hooks 需要 Python 3.9 或更高版本。Smart Search 等 Middleware Provider 是可选、独立探测的能力；Pactile 不会静默安装宿主原生资产，也不会复制凭据。

## 第一个项目

```bash
mkdir my-pactile-project
cd my-pactile-project
pactile init --cursor --codex -y
pactile capability-smoke --json
```

选择 `--cursor`、`--codex`，或同时使用两者。生成投影前会检查既有用户文件和原生资产。兼容的外部资产可以 borrowed 方式 adopt；冲突或 malformed 宿主文件保持原样，并返回恢复动作。

## 命令参考

| 命令                                                 | 契约                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `pactile init --cursor [--codex]`                    | 创建 canonical 状态并协调所选 Adapter。                        |
| `pactile capability-smoke [--json] [--write-status]` | 探测所选能力，并可写入 readiness。                             |
| `pactile update --dry-run`                           | 预览官方文件、迁移与投影变化。                                 |
| `pactile update`                                     | 应用一次确认过的事务，再独立协调各 Adapter。                   |
| `pactile migrate`                                    | 生成可选迁移预览；实际写入仍由 `update` 完成。                 |
| `pactile rollout`                                    | 对显式项目路径运行 `update` 并汇总证据。                       |
| `pactile upgrade`                                    | 升级全局安装的 canonical CLI 包。                              |
| `pactile detach cursor`                              | 移除一个 Adapter 的绑定与 claimant；保留共享和 borrowed 资源。 |
| `pactile detach codex`                               | 对 Codex 应用相同的单 Adapter 契约。                           |
| `pactile uninstall --dry-run`                        | 预览分离全部 Adapter，同时保留 `.pactile/`。                   |
| `pactile rollback <generation> --dry-run`            | 验证并预览 sealed generation 切换。                            |
| `pactile purge --dry-run`                            | 生成 inactive canonical root 的精确目标指纹，不删除。          |
| `pactile workflow`                                   | 列出或选择 canonical workflow 模板。                           |
| `pactile validate-rules`                             | 验证受支持的 Cursor rule 投影。                                |
| `pactile kernel --json`                              | 运行生成项目脚本使用的机器 JSON 生命周期边界。                 |

用 `pactile <command> --help` 查看当前参数。`detach` 使用位置参数指定 Adapter。`purge` 固定为两步：破坏性执行必须同时提供 `--yes` 和 preview 返回的精确指纹。

## 影响 ownership 的 init 参数

- [显式旧树导入](../../docs/pactile/compatibility-inputs.zh-CN.md#显式导入)声明一个既有旧树作为只读迁移源；它永远不会变成写入目标。
- `--capability <id>` 启用可选项目能力；可重复使用或传入 `all`。
- `--with-optional <name>` 把包内可选 Skill 安装到项目 Skill 目录；不会安装宿主原生插件或服务。
- `--skip-readiness` 将 framework readiness 记录为 unverified，而不是虚构 Provider 结果。
- `--force` 与 `--skip-existing` 控制文件冲突，但不会转移用户资产所有权。

## 更新、恢复与退出

对不确定的操作先做 preview：

```bash
pactile update --dry-run --json
pactile detach cursor --dry-run
pactile uninstall --dry-run
pactile rollback <generation> --dry-run
pactile purge --dry-run
```

Canonical generation 在宿主协调前提交。如果一个 Adapter 失败，canonical 状态和已成功的 sibling Adapter 保持有效；失败 Adapter 保留可重试 receipt。更新与退出决策会查询 ownership ledger，因此 modified、foreign、unknown、shared 与 borrowed 资源都会安全保留。

详细说明见[生命周期](../../docs/lifecycle/index.zh-CN.md)、[恢复](../../docs/troubleshooting/recovery.zh-CN.md)和 [Projection 与 Ownership](../../docs/concepts/projection-and-ownership.zh-CN.md)。

## 包关系

| 包                     | 角色                                                |
| ---------------------- | --------------------------------------------------- |
| `@blxzer/pactile`      | Canonical CLI、Adapters、模板、生命周期与项目集成。 |
| `@blxzer/pactile-core` | Canonical 严格契约与宿主无关原语。                  |
| 旧 CLI bridge          | 0.5.x 临时兼容包，委托给本 CLI。                    |
| 旧 Core bridge         | 0.5.x 临时兼容包，重新导出 canonical Core。         |

打包后的内部依赖必须是精确发布版本，不能残留 workspace protocol。发布 CLI 暴露 `pactile`；兼容 executable 不是推荐入口。

## 程序化导出

```js
import { VERSION, listPactilePlatforms } from "@blxzer/pactile";

console.log(VERSION, listPactilePlatforms());
```

根导出提供受支持的库接口。`./cli` 是 package bridge 使用的 executable 入口，`./compat` 仅供这一临时 bridge，`./package.json` 供工具读取。宿主无关契约应从 `@blxzer/pactile-core` 及其已记录的 subpath 导入。

## 安全边界

Pactile 存储逻辑 Provider 引用与 Evidence 链接，不保存 secret value、OAuth 状态、模型私有推理或复制的外部资产正文。Adapter 不能写 canonical `.pactile/` 状态；只有 Reconciler 能写投影。Borrowed 资产始终使用 `preserve` 删除策略。

## 更多文档

- [仓库概览](../../README.zh-CN.md)
- [五分钟示例](../../examples/minimal-agent-app/README.zh-CN.md)
- [核心概念](../../docs/concepts/index.zh-CN.md)
- [宿主](../../docs/hosts/index.zh-CN.md)
- [能力与 Provider](../../docs/capabilities/index.zh-CN.md)
- [生命周期](../../docs/lifecycle/index.zh-CN.md)
- [故障排查](../../docs/troubleshooting/index.zh-CN.md)

公开 package README 刻意不包含 release 或 registry 写操作说明。

## 许可证

Pactile 采用 GNU Affero General Public License v3.0-only
（`AGPL-3.0-only`）发布。完整许可证正文随 package 一并提供于
[`LICENSE`](LICENSE)；项目归属和上游归属记录在仓库的
[`COPYRIGHT`](https://github.com/blxzer77/pactile/blob/main/COPYRIGHT)。
