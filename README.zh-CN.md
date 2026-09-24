# Pactile

<p>
  <a href="https://github.com/blxzer77/pactile/actions/workflows/ci.yml">
    <img src="https://github.com/blxzer77/pactile/actions/workflows/ci.yml/badge.svg" alt="CI">
  </a>
  <a href="https://www.npmjs.com/package/@blxzer/pactile">
    <img src="https://img.shields.io/npm/v/@blxzer/pactile?label=npm" alt="npm version">
  </a>
</p>

[English](README.md) | 简体中文

Pactile 把受契约约束的能力积木，按需拼成 Codex 可用、且有证据可追溯的工作空间。

它为 AI 编程项目建立一份指令、任务、所有权与生命周期真相，并向 Codex 投影所需的项目内容。

## 五分钟上手

前置条件：Node.js 18.17 或更高版本。Pactile 的任务、上下文和会话命令使用 Node.js，不要求 Python。

```bash
npm install -g @blxzer/pactile
pactile --version

mkdir my-pactile-project
cd my-pactile-project
pactile init --codex -y
pactile capability-smoke --json
```

`init` 先在 `.pactile/` 建立 canonical 状态，再协调 Codex Adapter。最后一个命令报告实际能力就绪度；Provider 降级会明确展示，不会冒充宿主原生能力。

初始化后，直接让 Agent 正常工作即可。遇到需要持久化的工作，Agent 会使用生成的 workflow 和 task 工具；用户不需要记忆额外的提示词语言。

## 项目里会出现什么

```text
my-pactile-project/
  .pactile/        canonical workflow、任务、Tiles、运行状态与 Evidence
  .agents/         为 Codex 投影的 Skills
  .codex/          原生支持就绪时才生成的可选 Codex 项目投影
  AGENTS.md        共享托管指令，同时保留用户内容
```

Pactile 只拥有 ownership ledger 中记录的托管内容。既有宿主原生 Skills、MCP 配置、插件和用户文件仍属于外部或 borrowed 资产，除非经过审阅的计划明确另行处理。

旧版本生成的 Cursor 文件不会被当前安装路径刷新。可先用 `pactile detach cursor --dry-run` 审阅旧安装的清理计划。

## 心智模型

| 概念           | 负责什么                                                  | 不负责什么                                        |
| -------------- | --------------------------------------------------------- | ------------------------------------------------- |
| **Tile**       | 声明一个小能力的输入、策略上限、Evidence 要求与停止条件。 | 不是提示词堆、宿主脚本或中央工作流。              |
| **Kernel**     | 根据 canonical 状态校验生命周期转换和持久化契约。         | 不替模型规划，也不写宿主投影。                    |
| **Trace**      | 按顺序记录可观察的组合事件与 Evidence 引用。              | 不保存私有推理或凭据。                            |
| **Projection** | 把一个 canonical generation 转换成宿主特定文件与绑定。    | 可重建，不是第二份真相。                          |
| **Ownership**  | 记录每个投影或借用资源由谁拥有、还有谁在声明使用。        | claimant 不会因此获得删除用户或第三方资产的权限。 |

先看[核心概念](docs/concepts/index.zh-CN.md)，再按需阅读 [Tiles](docs/concepts/tiles.zh-CN.md)、[Kernel、Evidence 与 Trace](docs/concepts/kernel-evidence-trace.zh-CN.md)、[Projection 与 Ownership](docs/concepts/projection-and-ownership.zh-CN.md)。

## 宿主与能力

| 宿主  | 项目集成面                                          | Pactile 行为                                          |
| ----- | --------------------------------------------------- | ----------------------------------------------------- |
| Codex | 受管 `AGENTS.md`、`.agents/skills/` 与可选项目配置 | 从 canonical 状态协调生成；原生绑定不可用时报告 degraded。 |

Pactile 将能力来源（`native`、`provider`、`heuristic`、`unsupported`）与 assurance 分开报告。可选 Provider 可以提升能力，但没有 Evidence 和通过时效探测的结果绝不会被标记为 verified。

详细边界见[宿主](docs/hosts/index.zh-CN.md)与[能力](docs/capabilities/index.zh-CN.md)。

## 生命周期与安全

- `pactile update --dry-run` 在应用前预览官方文件与投影变化。
- `pactile detach codex` 移除当前 Adapter 的声明并保留 borrowed 资源；`pactile detach cursor` 仅用于审阅并清理旧安装。
- `pactile uninstall --dry-run` 预览分离全部 Adapter，同时保留 canonical `.pactile/` 状态。
- `pactile rollback <generation> --dry-run` 在切换前验证 sealed generation。
- `pactile purge --dry-run` 只生成目标指纹；破坏性清理需要带同一指纹的第二次显式确认。

迁移输入保持只读。modified、foreign、unknown 或 borrowed 资源会安全保留并进入审阅。详见[生命周期](docs/lifecycle/index.zh-CN.md)与[故障排查](docs/troubleshooting/index.zh-CN.md)。

## 包

| 包                     | 状态                      | 用途                                      |
| ---------------------- | ------------------------- | ----------------------------------------- |
| `@blxzer/pactile`      | Canonical                 | CLI、Adapters、模板、生命周期与项目集成。 |
| `@blxzer/pactile-core` | Canonical                 | 严格的宿主无关契约与领域原语。            |
| 旧 CLI bridge          | 仅在 0.5.x 兼容窗口内保留 | 委托给 canonical CLI，并输出迁移提示。    |
| 旧 Core bridge         | 仅在 0.5.x 兼容窗口内保留 | 重新导出 canonical Core 契约。            |

新文档和自动化只能使用 canonical 包名与可执行名。历史发布事实保持在 changelog 中，不做追溯性改写。

## 文档导航

| 主题                              | 入口                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| 概念与架构                        | [docs/concepts/index.zh-CN.md](docs/concepts/index.zh-CN.md)                             |
| 宿主 Adapter                      | [docs/hosts/index.zh-CN.md](docs/hosts/index.zh-CN.md)                                   |
| Skills、MCP、检索、Provider、隐私 | [docs/capabilities/index.zh-CN.md](docs/capabilities/index.zh-CN.md)                     |
| 安装、更新、迁移、退出、恢复      | [docs/lifecycle/index.zh-CN.md](docs/lifecycle/index.zh-CN.md)                           |
| 故障排查                          | [docs/troubleshooting/index.zh-CN.md](docs/troubleshooting/index.zh-CN.md)               |
| CLI 参考                          | [packages/cli/README.zh-CN.md](packages/cli/README.zh-CN.md)                             |
| 最小示例                          | [examples/minimal-agent-app/README.zh-CN.md](examples/minimal-agent-app/README.zh-CN.md) |
| 贡献与安全                        | [docs/governance/index.zh-CN.md](docs/governance/index.zh-CN.md)                         |

## 开发 Pactile

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
```

完整 Core 与 CLI 测试套件是最终发布门。日常改动还应运行最接近的 package 与 conformance 测试。贡献流程、安全报告与兼容策略见[治理](docs/governance/index.zh-CN.md)。

## 范围边界

Pactile 是本地项目工具。它不承诺云端编排、插件市场、自动安装宿主原生资产，也不取得凭据或 OAuth 状态的所有权。可选 Middleware Provider 仍需独立安装并显式探测。

项目沿革、版权与许可证通知保留在 [COPYRIGHT](COPYRIGHT) 和 [LICENSE](LICENSE) 中。

## 许可证

Pactile 采用 GNU Affero General Public License v3.0-only
（`AGPL-3.0-only`）发布。完整许可证正文见 [LICENSE](LICENSE)；Pactile
项目归属和上游归属见 [COPYRIGHT](COPYRIGHT)。
