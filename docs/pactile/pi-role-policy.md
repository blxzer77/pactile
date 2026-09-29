# Pi 职责授权与隔离

Pactile 保留 Pi 已配置的工具、MCP、Skill、扩展、模型及推理设置。权限控制落在具体动作、目标和 Task 的批准范围；提示词同时解释职责。实现分为合同、路径、动作策略、原生扩展、启动、可选 Docker 后端、临时协议接入和回执，桥接层只负责接入生命周期。

## 使用

```text
pactile pi run <task> --role implement --run-id <run-id> --prompt-file <file>
pactile pi run <task> --role check --prompt-file <file> --sandbox docker --sandbox-image <prepared-image>
pactile pi cancel <task>
```

也可用 `PACTILE_PI_SANDBOX=docker` 和 `PACTILE_PI_DOCKER_IMAGE` 选择已经准备好的镜像。未请求 Docker 时使用原生动作策略；请求后缺引擎、镜像、扩展或有效合同即阻断。Pactile 不自动安装或启动系统后端，不自动拉取镜像。Node 20+ 仍为唯一必须运行时；Pi 和 Docker 都是可选宿主能力。Pi 0.87.1 本身需要 Node >=22.19。

## 保证边界

| 面 | 原生动作策略 | Docker 整进程隔离 |
| --- | --- | --- |
| 默认资源加载 | 保留，握手记录实际工具/Skill 命令 | 保留已配置资源，只读映射；记录实际加载 |
| 源码写入 | 拦截内置工具与可信动作接入，只允许 Implement 批准写集 | 内置工具继续校验，挂载同时限制整个进程及内部子进程 |
| Research / Check | 候选及既有证据只读，独立 scratch 可写 | 候选、Task、合同及 Git 元数据只读，scratch 可写 |
| Shell / MCP 脚本 / 委派 | 无系统隔离时拒绝具体调用 | 在同一隔离边界内执行；不增加批准范围 |
| 扩展直接运行代码 | 扩展属于可信配置；不声称 OS 保证 | 容器限制文件系统及直接网络；扩展无法增加挂载或使用 Docker socket |
| MCP | Adapter 3.0 最终审批接入校验原始动作/参数 | 官方 SDK 临时接入再次校验；绕过原生事件也不能扩大远端动作 |
| 凭据 | 直接文件读取拒绝；聚合查询加入排除 | 已知凭据路径/本地控制目录遮蔽，模型及 MCP 凭据保留宿主内存 |

目录查询有文件数预算；符号链接、歧义路径和目录替换不能扩大权限。公开 `.env.example` 等模板可读。权限不等同于内容分类器：源码里任意嵌入的秘密无法自动保证发现。服务名、工具名和 `readOnlyHint` 不是远端动作授权；未知动作会单独拒绝。安全查询可用，不通过禁用全部 MCP 来实现只读。

默认资源的目录也遮蔽已知凭据文件和链接，公开 Skill/扩展内容继续可读。宿主 Windows 的额外命令和原生依赖不会自动进入 Linux 镜像；验证所需可选工具应由可信镜像提供，或使用宿主的已授权 MCP 接入。临时验证使用声明 scratch/TMPDIR，不向只读项目安装依赖。

Docker 的推理接入目前覆盖已配置 HTTP provider 的 `/chat/completions`、`/responses`、`/messages`。OAuth 刷新、其他推理协议、任意网络下载和未映射远端动作不能假定可用。HTTP 协议沿用 Pi provider，MCP 沿用官方 SDK；这是一份 Run 的隔离通道，用户网络代理继续由 Node 启动环境或外部网络层配置，Pactile 不解析或安装个人代理。

已有 API key、环境引用及凭据命令由宿主侧 Pi 配置解析器解析；worker 只收到占位值。当前适配已安装 Pi 0.87 的解析器，缺失或不兼容时阻断需要它的引用，不自行执行第二套凭据脚本，也不把解析结果写入合同、配置副本或回执。配置读取、JSON 解析及 header 校验失败仅返回通用原因，不回显解析片段或 header 原值。

同一推理地址的不同 provider 由非凭据选择标记区分，避免把 Child 请求错误地计入另一个配置的凭据。当前 Docker 接入使用 models.json 中明确配置 baseUrl 的 HTTP provider，支持 provider 级自定义 headers；per-model headers 暂未适配，启动时明确拒绝，不能把其中的凭据直接复制给 worker。

## 候选与退出

Review 校验 Kernel 已登记 workspace 的实际 Git/目录身份和精确候选，支持有效登记的外部 worktree；不要求目录名称是 `.pactile/worktrees`。替换工作树、改变源文件、错误 Run、陈旧候选和进行中 Run 都拒绝。手工工作树不会被冒认成 P38 管理的工作树。

每次启动产生新的权限指纹，绑定批准、Task/Run、workspace、写集、源合同和候选。原生暖进程只有权限及权威相同时才可续用。Docker 每次使用新会话，跨容器 resume 暂未开放。策略扩展握手先于模型任务；收据区分原生扩展、RPC fixture 和实际 Docker 事实。

宿主动作守卫复核目录身份与 Core 的稳定 Git HEAD/分支基线，检测同路径替换及换分支；源码字节的完整候选检查继续由 Kernel 在派发与关门时执行。容器内路径身份与宿主不同，容器依赖已核对的挂载和宿主协议守卫，不能把 Linux inode 冒认成宿主身份。

Windows 下桌面进程退出不能证明 Docker worker 已结束。因此正常结束、取消和故障都观察具体容器停止；未确认时保留锁和派发租约，不写入有效 Review。陈旧启动锁里的容器标识与合同标签须一致，`pi cancel` 只停止本 Task 记录的 Pactile 容器。只清理自己创建的容器、relay volume 和临时控制目录，不触碰其他 Docker 工作负载。

Review 收据还记录实际容器退出码与结束时间；容器异常退出不能形成通过结论。Implement 对尚不存在的批准文件可能先创建空的挂载占位文件；失败时该文件属于未通过验收的本地候选，不能据此宣称已完成交付。

Docker RPC 关闭 stdin 后，最多等待 30 秒让默认扩展完成清理；提前正常退出会立即继续。超时仍强制终止并观察实际退出码，不能把强制清理当作通过证据。这个等待不改变模型完整结束、候选、权限或必需验证的门槛。

隔离 relay 用固定故障类别区分合同/目标拒绝（403）与已授权推理的上游传输失败（502），上游返回的错误状态保留但正文脱敏。`x-pactile-role-relay-failure` 只提供固定类别；不返回原始异常、密钥或地址。已开始的流中断时关闭连接，避免混入错误文本。推理和 MCP 的授权边界保持原合同，失败或不完整的模型回答不能形成通过结论。

## 探查错误与审核失败

Check 保留真实工具错误总数。只允许有限可辨认的探查错误提供恢复证明：读取缺失/偏移越界的来源、缺少探查命令（含 `which` / `command -v` 查询无结果）、将临时文件写到只读 `/tmp`、只读目录/来源探查失败及普通搜索/Git ignore 查询无匹配。命令中的测试工具名称不等于运行了测试；实际验证命令、断言与 `grep -q` / `git check-ignore -q` 检查失败仍阻断，后续探查不能掩盖复合命令中的验证失败。未知错误、扩展/provider 失败、调用记录不完整、候选或授权失效也阻断；不会因为模型声称已恢复而扩大权限或跳过验收。

失败 Shell 查询用 `shell-quote` 词法解析和 Node `parseArgs` 识别，既不执行命令也不展开宿主环境。整段命令必须属于有限的静态探查语法；包管理器选项后的验证、任意位置的 quiet 断言都不能被末尾查询掩盖。包装器、环境赋值、命令替换、动态展开、多行脚本、可执行的 find/sed 操作或未受信任的可执行路径不能明确归类时，保持硬阻断。建议把探查和验证放在独立工具调用中；这不会裁掉 Pi 的工具，只限制失败后可采纳的恢复证明。

独立 Review 的 `toolRecoveries` 为每个探查错误列出 `failedToolCallId`、之后成功的 `recoveredByToolCallId` 和 `rationale`。宿主把调用顺序、工具名、输入/结果指纹和实际结果写入已有事件证据，重新读取并绑定停止回执。无恢复证明、指向更早/失败调用、重复豁免或解释为空都拒绝。解释和事件一起进入 Kernel Review 证据，Close 继续检查完整性。旧错误记录没有这些证明时保持拒绝；原失败记录不改写。

Check 的工具结果附带 `Pactile tool evidence`，保留完整原生调用 ID（包含 provider 的 `call_id|function_call_id`），同时提供由该 ID 指纹生成的短 `reviewToolRef`，避免模型抄错长标识。恢复字段可使用精确短引用或完整 ID；宿主只解析到唯一已记录调用，审核产物规范回完整 ID。短引用碰撞、拼写错误及歧义均拒绝，不截断、不做前缀或模糊匹配。原结果和错误状态保留。错误分类只表示是否可提交恢复证据，审核员仍须解释该调用为何属于探查，以及后续证据如何恢复；宿主再校验真实事件和硬门。

## 外部能力与证据

- Pi 原生扩展接入：[官方扩展文档](https://pi.dev/docs/latest/extensions)。输入在授权后冻结，防止后续 handler 修改目标。
- Pi 整进程隔离目标：[Pi 0.87.1 容器文档](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/containerization.md)。
- MCP 协议：[官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。使用 1.31.0，运行时兼容 Pactile 的 Node 20 底线；Unix socket HTTP 客户端使用 undici 6.29.0。
- Windows SRT 0.0.77 Alpha 源码使用共享 SID/ACL 聚合，本项据此推断可能跨 Run 影响，未作 Windows 系统实测。本版未提供 SRT 后端，不能声称已验证。[固定源码](https://github.com/anthropics/sandbox-runtime/tree/v0.0.77)。

维护用真实验收入口在 `packages/cli/scripts/fixtures/pi-role-policy-probe.ts`。专用镜像、真实 Pi 进程/OS 操作、MCP fixture、模拟 RPC、真实模型输出和独立 Review 分别标明证据等级。Docker 可用或合同握手成功都不自动计为验收通过。
