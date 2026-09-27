# 有界工作区请求

PACTILE-32 提供版本化、宿主无关的请求与结果契约，用于发现工作区文件、读取文件、字面搜索，以及显式授权的命令。内置 Node Adapter 无需 Python、FastCtx、`rg` 或其他搜索 Provider 即可使用。

## 请求格式

将请求写入工作区内的 JSON 文件，再把路径传给 CLI。请求文件必须解析到工作区内，且大小不能超过 256 KiB：

```json
{
  "schemaVersion": 1,
  "requestId": "inspect-readme-01",
  "operation": "search",
  "query": "capability",
  "directory": "packages/cli/src",
  "caseSensitive": false,
  "limits": {
    "timeoutMs": 30000,
    "maxOutputBytes": 131072,
    "maxFilesScanned": 1000,
    "maxResults": 100,
    "maxFileBytes": 262144,
    "maxBytesRead": 2097152
  }
}
```

`operation` 支持 `discover`、`read`、`search` 和 `run`。文件系统路径必须相对于工作区，并使用 POSIX 分隔符。discover 和 search 可以省略 `directory`，或将其设为 `null` 表示工作区根目录。两者都支持从零开始的可选 `offset`（默认 `0`）。search 按行进行字面匹配，不依赖 Smart Search 或宿主工具。discover 会跳过 `.git`、`node_modules`、符号链接和运行时 receipt 目录；经 CLI 调用时也会排除请求 JSON 自身。Windows ADS（含冒号的路径）与保留设备名会被拒绝。

每个请求必须提供全部六个 limit。校验器将 `timeoutMs` 限制在 120 秒内，`maxOutputBytes` 限制在 2 KiB 到 1 MiB，`maxFilesScanned` 不超过 10,000，`maxResults` 不超过 1,000，`maxFileBytes` 不超过 1 MiB，`maxBytesRead` 不超过 32 MiB。`maxOutputBytes` 限制完整的紧凑 JSON 结果，包含 envelope 和 receipt 摘要。CLI 输出单行紧凑 JSON，末尾换行也计入同一字节上限。

## 结果和部分结果

每个有效请求都会返回 `schemaVersion`、`requestId`、`operation`、`outcome`、`partial`、`nextPage`、`data`、`error` 和 `receipt`。调用方应根据 `outcome` 与 `error.code` 分支，不应依赖 Adapter 品牌名或人类可读消息。

| Outcome        | 含义                                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `complete`     | 操作在限制内完成。                                                                                                                                                            |
| `empty`        | 操作完成，没有找到内容或匹配项。                                                                                                                                              |
| `partial`      | 字节、文件、结果数或输出限制截断了收集；如果有界数据能装入预算，`data` 会包含这部分结果。结果分页也会标为 partial，并通过非空 `nextPage` 表示还有下一页，此时可以没有 error。 |
| `out_of_scope` | 调用方策略拒绝了操作，或路径解析到了工作区之外。                                                                                                                              |
| `timed_out`    | 请求超过时限。                                                                                                                                                                |
| `cancelled`    | 调用方取消了请求。                                                                                                                                                            |
| `failed`       | 操作失败，或获准执行的命令返回非零状态。                                                                                                                                      |

稳定错误码包括 `OUT_OF_SCOPE`、`NOT_FOUND`、`PERMISSION_DENIED`、`TIMEOUT`、`CANCELLED`、`OUTPUT_LIMIT`、`SCAN_LIMIT`、`FILE_TOO_LARGE`、`EXECUTION_FAILED`、`ADAPTER_UNAVAILABLE`、`REQUEST_ID_REUSED`、`REQUEST_CLAIM_RETAINED`、`REQUEST_CLAIM_LIMIT` 和 `RECEIPT_UNAVAILABLE`。空结果不属于错误。`REQUEST_CLAIM_RETAINED` 表示 claim 创建后无法验证，操作没有运行，未完成 claim 会被保留；`REQUEST_CLAIM_LIMIT` 表示回执目录已观察到 32 个空 claim，操作没有运行。discover/search 在当前扫描内达到 `maxResults` 且发现更多结果时，`nextPage` 会返回下一页 offset。使用新的 `requestId`、相同操作与筛选条件，并将该值作为 `offset` 重复请求。`nextPage: null` 表示没有可续的结果页；若扫描或读取预算先耗尽，应提高相应预算后重新提交。路径顺序稳定，但每页都会重新读取工作区，因此两次请求间的工作区变化可能改变 offset 对应的结果。部分扫描不能证明未返回的文件或匹配项不存在。

`timeoutMs` 从回执预检和 claim 开始前计时；若在操作开始前到期，操作不会运行。`RECEIPT_UNAVAILABLE` 表示操作可能已运行，但审计回执未能持久化，响应中的 `receipt` 为 `null`。收到该结果后不要自动重试 `run`；先检查工作区和 claim，再决定如何恢复。

## 命令与取消

```sh
pactile capability request.json
pactile capability check.json --allow-command git
```

除非调用方显式将可执行程序 ID 加入 allowlist，否则命令请求会被拒绝。Adapter 使用 `shell: false` 直接启动程序，解析到工作区之外的绝对可执行路径，并从子进程 `PATH` 中移除相对路径和工作区内路径。工作目录必须位于工作区内，参数字节数、运行时间和捕获输出均有限制。超时、取消或输出溢出会在返回前终止整个进程树。授权会授予可执行程序当前操作系统用户的进程权限；它不是操作系统沙箱。只允许调用方信任的程序和参数。CLI 请求可用 Ctrl+C 取消；程序化 Adapter 调用方可以传入 `AbortSignal`。

CLI 对 `complete`、`empty` 和 `partial` 返回退出码 `0`；对 `out_of_scope`、`timed_out`、`cancelled` 和操作失败返回 `1`；请求文件或请求契约无效时返回 `2`。

## 回执

成功取得 claim 的首次请求会写入 JSON 回执：`.pactile/runtime/receipts/capabilities/<requestId>.json`。响应中的 `receipt` 提供契约版本、请求与结果指纹、Adapter ID、outcome、错误码、返回条目数、operation data 字节数、时间戳、耗时和相对回执路径。回执不保存请求文本、文件正文、命令参数或操作输出。重复使用 request ID 会以 `REQUEST_ID_REUSED` 拒绝，且不会创建第二份回执；无效请求不会创建回执。

未完成 claim 不会自动删除，因为它创建后路径可能发生变化。收到 `REQUEST_CLAIM_RETAINED` 时，操作尚未运行，可以使用新的 `requestId` 安全重试。若要复用旧 ID 或解除 `REQUEST_CLAIM_LIMIT`，请检查回执目录中的对应文件；仅在确认回执目录仍解析到工作区内、该文件是普通空文件且没有请求正在运行后，才手动删除。预检观察到 32 个这样的空文件时会拒绝新 claim；清理已确认过期的 claim 后再重试。
